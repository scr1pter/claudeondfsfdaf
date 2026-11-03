import { afterEach, beforeEach, expect, test } from "bun:test"
import { createVectorClient, type WorkflowRunDetail } from "@vectordevai/sdk/v2"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import { backgroundTracker } from "@/cli/cmd/run/background-wait"
import { runWorkflow } from "@/cli/cmd/run/workflow"
import { validateWorkflowRunOptions } from "@/cli/cmd/run"

const marker = process.env[ChildEnvironment.AGENT_MARKER]
beforeEach(() => {
  delete process.env[ChildEnvironment.AGENT_MARKER]
})
afterEach(() => {
  if (marker === undefined) delete process.env[ChildEnvironment.AGENT_MARKER]
  else process.env[ChildEnvironment.AGENT_MARKER] = marker
})

const plan = {
  title: "Review",
  stages: [
    {
      id: "review",
      title: "Review",
      phase: "",
      agent: "general",
      items: 1,
      serial: false,
      writes: "read only",
      asks: [],
    },
  ],
  maxAgents: 3,
  concurrency: 2,
  steps: 10,
  perAgentSteps: 5,
  minutes: 1,
}
const note = (quiet = true) => ({
  type: "message.part.updated",
  properties: {
    part: {
      type: "text",
      id: "part_note",
      sessionID: "parent",
      messageID: "msg_2",
      text: "automated report",
      metadata: { taskNotification: { taskID: "run", state: "completed", quiet } },
      time: { start: 2, end: 2 },
    },
  },
})
const updated = { type: "session.updated", properties: { info: { id: "run", parentID: "parent" } } }
const idle = { type: "session.status", properties: { sessionID: "parent", status: { type: "idle" } } }

for (const order of ["note-first", "status-first"] as const) {
  test(`quiet workflow finishes without another model turn when ${order}`, async () => {
    const setup = fixture({ events: order === "note-first" ? [note(), updated] : [updated, note()] })
    const result = await runWorkflow(
      setup.client,
      { sessionID: "parent", source: { name: "review", inputs: { topic: "changes" } } },
      setup.output,
    )
    expect(result).toEqual({ runID: "run", exitCode: 0 })
    expect(setup.stdout).toEqual(["Verified workflow report\n"])
    expect(setup.stderr.join("")).toContain("3 agents · 2 concurrent")
    expect(setup.stderr.join("")).toContain("Auto resolves for each child")
    expect(setup.stderr.join("")).toContain("run: completed")
    const actions = setup.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)
    expect(actions.slice(0, 4)).toEqual([
      "GET /experimental/capabilities",
      "POST /experimental/workflow/validate",
      "GET /event",
      "POST /experimental/session/parent/workflow",
    ])
    expect(await setup.requests[3].json()).toEqual({ name: "review", inputs: { topic: "changes" }, quiet: true })
    expect(actions).not.toContain("POST /session/parent/prompt")
    expect(actions).not.toContain("POST /experimental/session/parent/tasks/stop")
  })
}

for (const status of ["failed", "stopped"] as const) {
  test(`workflow ${status} produces a failing exit status and retains its partial report`, async () => {
    const setup = fixture({ status, events: [updated, note()] })
    const result = await runWorkflow(setup.client, { sessionID: "parent", source: { name: "review" } }, setup.output)
    expect(result.exitCode).toBe(1)
    expect(setup.stdout).toEqual(["Verified workflow report\n"])
  })
}

test("a stopped workflow retains its partial report without requiring a completion note", async () => {
  const setup = fixture({ status: "stopped", events: [updated] })
  const result = await runWorkflow(setup.client, { sessionID: "parent", source: { name: "review" } }, setup.output)
  expect(result.exitCode).toBe(1)
  expect(setup.stdout).toEqual(["Verified workflow report\n"])
  expect(setup.requests.some((request) => new URL(request.url).pathname.endsWith("/stop"))).toBe(false)
})

test("an authoritative quiet update settles a suppressed summary without another model turn", async () => {
  const setup = fixture({ events: [updated, note(false), note(true), idle] })
  const result = await runWorkflow(
    setup.client,
    { sessionID: "parent", source: { name: "review" }, summarize: true },
    setup.output,
  )
  expect(result.exitCode).toBe(0)
  expect(setup.stdout).toEqual(["Verified workflow report\n"])
  expect(setup.requests.some((request) => new URL(request.url).pathname.endsWith("/stop"))).toBe(false)
})

test("summarize waits for a real finished parent answer and omits the launch acknowledgement", async () => {
  const text = (messageID: string, id: string, value: string) => ({
    type: "message.part.updated",
    properties: { part: { type: "text", sessionID: "parent", messageID, id, text: value, time: { start: 1, end: 2 } } },
  })
  const setup = fixture({
    events: [
      text("msg_1", "part_ack", "Started workflow Review"),
      idle,
      updated,
      note(false),
      text("msg_other_user", "part_user", "Unrelated human request"),
      text("msg_other_reply", "part_other", "Unrelated assistant reply"),
      {
        type: "message.updated",
        properties: {
          sessionID: "parent",
          info: {
            id: "msg_other_reply",
            parentID: "msg_other_user",
            role: "assistant",
            time: { created: 2, completed: 3 },
            error: { name: "UnknownError", data: { message: "Unrelated failure" } },
          },
        },
      },
      { type: "session.status", properties: { sessionID: "parent", status: { type: "busy" } } },
      text("msg_3", "part_summary", "Summary: all checks passed"),
      {
        type: "message.updated",
        properties: {
          sessionID: "parent",
          info: { id: "msg_3", parentID: "msg_2", role: "assistant", time: { created: 3, completed: 4 } },
        },
      },
      idle,
    ],
  })
  const result = await runWorkflow(
    setup.client,
    { sessionID: "parent", source: { name: "review" }, summarize: true },
    setup.output,
  )
  expect(result.exitCode).toBe(0)
  expect(setup.stdout).toEqual(["Verified workflow report\n", "Summary: all checks passed\n"])
  expect(await setup.requests[3].json()).toMatchObject({ quiet: false })
})

for (const owned of [false, true]) {
  test(`a completed parent answer before its note ${owned ? "settles its own summary" : "cannot settle another turn's summary"}`, async () => {
    const setup = fixture({
      events: [
        updated,
        {
          type: "message.updated",
          properties: {
            sessionID: "parent",
            info: {
              id: "msg_3",
              parentID: owned ? "msg_2" : "msg_other",
              role: "assistant",
              time: { created: 3, completed: 4 },
            },
          },
        },
        note(false),
        idle,
      ],
    })
    const result = runWorkflow(
      setup.client,
      { sessionID: "parent", source: { name: "review" }, summarize: true },
      setup.output,
    )
    if (owned) expect((await result).exitCode).toBe(0)
    else {
      await expect(result).rejects.toThrow("stream ended")
      expect(setup.stdout).toEqual([])
    }
  })
}

test("invalid preview never subscribes or starts a workflow", async () => {
  const setup = fixture({ invalid: true, events: [] })
  await expect(
    runWorkflow(setup.client, { sessionID: "parent", source: { spec: "{}" } }, setup.output),
  ).rejects.toThrow("missing stages")
  expect(setup.requests.map((request) => new URL(request.url).pathname)).toEqual([
    "/experimental/capabilities",
    "/experimental/workflow/validate",
  ])
  expect(setup.stdout).toEqual([])
})

test("marked agents are refused before any workflow or account transport", async () => {
  process.env[ChildEnvironment.AGENT_MARKER] = "ses_child"
  const setup = fixture({ events: [] })
  await expect(
    runWorkflow(setup.client, { sessionID: "parent", source: { name: "review" } }, setup.output),
  ).rejects.toThrow("Vector's agents cannot")
  expect(setup.requests).toEqual([])
})

test("updates while the run's record says it is running are inspected at most every few seconds", async () => {
  const working = {
    type: "session.updated",
    properties: { info: { id: "run", parentID: "parent", metadata: { subagent: { status: "running" } } } },
  }
  const settled = {
    type: "session.updated",
    properties: { info: { id: "run", parentID: "parent", metadata: { subagent: { status: "completed" } } } },
  }
  const setup = fixture({ events: [working, working, working, working, working, settled, note()] })
  const result = await runWorkflow(setup.client, { sessionID: "parent", source: { name: "review" } }, setup.output)
  expect(result.exitCode).toBe(0)
  // The start's own inspection, one for the settled update and the final report: none for the five running updates.
  expect(
    setup.requests.filter((request) => new URL(request.url).pathname === "/experimental/session/parent/workflow/run"),
  ).toHaveLength(3)
})

test("a reconnected event stream recovers the missed note and finishes without stopping the run", async () => {
  // The first stream ends before the run settles; the resubscription carries no replay, so the run and the parent's
  // quiet note are read back after reconnecting.
  const setup = fixture({
    events: [],
    reconnect: [],
    messages: [
      {
        info: { id: "msg_2", sessionID: "parent", role: "user", time: { created: 2 }, agent: "build" },
        parts: [note().properties.part],
      },
    ],
  })
  const result = await runWorkflow(setup.client, { sessionID: "parent", source: { name: "review" } }, setup.output)
  expect(result.exitCode).toBe(0)
  expect(setup.requests.filter((request) => new URL(request.url).pathname === "/event")).toHaveLength(2)
  expect(setup.requests.some((request) => new URL(request.url).pathname.endsWith("/tasks/stop"))).toBe(false)
  expect(setup.stdout).toEqual(["Verified workflow report\n"])
})

test("an event disconnection that cannot reconnect stops the unfinished run and never reports success", async () => {
  const setup = fixture({ events: [] })
  await expect(
    runWorkflow(setup.client, { sessionID: "parent", source: { name: "review" } }, setup.output),
  ).rejects.toThrow("stream ended")
  const stop = setup.requests.find((request) => new URL(request.url).pathname.endsWith("/tasks/stop"))
  expect(stop).toBeDefined()
  expect(await stop!.json()).toMatchObject({ taskIDs: ["run"] })
  expect(setup.stdout).toEqual([])
})

test("workflow child permissions retain the ordinary non-interactive approval policy", async () => {
  const setup = fixture({
    events: [
      {
        type: "permission.asked",
        properties: {
          id: "ask_child",
          sessionID: "child",
          permission: "edit",
          patterns: ["src/app.ts"],
          always: ["*"],
        },
      },
      {
        type: "permission.asked",
        properties: {
          id: "ask_other",
          sessionID: "other",
          permission: "edit",
          patterns: ["src/app.ts"],
          always: ["*"],
        },
      },
      updated,
      note(),
    ],
  })
  await runWorkflow(setup.client, { sessionID: "parent", source: { name: "review" }, auto: false }, setup.output)
  const replies = setup.requests.filter((request) => new URL(request.url).pathname.startsWith("/permission/"))
  expect(replies).toHaveLength(1)
  expect(await replies[0].json()).toEqual({ reply: "reject" })
  expect(setup.stderr.join("")).toContain("Permission edit was rejected")
})

test("workflow options reject silently ignored prompt selections and budgets", () => {
  validateWorkflowRunOptions({
    workflow: "review",
    input: ["topic=fix"],
    summarize: true,
    format: "default",
    mini: false,
  })
  for (const option of ["command", "model", "agent", "variant", "size", "judge", "max-cost", "max-steps"])
    expect(() => validateWorkflowRunOptions({ workflow: "review", [option]: "value" })).toThrow("prompt-only")
  expect(() => validateWorkflowRunOptions({ workflow: "review" }, "unrelated prompt")).toThrow("without a prompt")
  expect(() => validateWorkflowRunOptions({ workflow: "review", format: "json" })).toThrow("show --json")
  expect(() => validateWorkflowRunOptions({ input: ["topic=x"] })).toThrow("require --workflow")
  expect(() => validateWorkflowRunOptions({ summarize: true })).toThrow("require --workflow")
})

test("parent permissions belong to a summary only after its note and assistant are identified", async () => {
  const permission = (id: string) => ({
    type: "permission.asked",
    properties: { id, sessionID: "parent", permission: "edit", patterns: ["src/app.ts"], always: ["*"] },
  })
  const setup = fixture({
    events: [
      permission("ask_before_note"),
      updated,
      note(false),
      permission("ask_before_assistant"),
      {
        type: "message.updated",
        properties: {
          sessionID: "parent",
          info: { id: "msg_3", parentID: "msg_2", role: "assistant", time: { created: 3 } },
        },
      },
      permission("ask_summary"),
      {
        type: "message.updated",
        properties: {
          sessionID: "parent",
          info: { id: "msg_3", parentID: "msg_2", role: "assistant", time: { created: 3, completed: 4 } },
        },
      },
      idle,
    ],
  })
  const result = await runWorkflow(
    setup.client,
    { sessionID: "parent", source: { name: "review" }, summarize: true, auto: true },
    setup.output,
  )
  expect(result.exitCode).toBe(0)
  const replies = setup.requests.filter((request) => new URL(request.url).pathname.startsWith("/permission/"))
  expect(replies.map((request) => new URL(request.url).pathname)).toEqual(["/permission/ask_summary/reply"])
  expect(await replies[0].json()).toEqual({ reply: "once" })
})

test("quiet and already-answered notes remain settled across either lifecycle arrival order", () => {
  for (const quiet of [false, true])
    for (const first of ["note", "status"] as const) {
      const tracker = backgroundTracker()
      tracker.status("child", "running", 1)
      if (first === "status") tracker.status("child", "completed", 1)
      tracker.note("child", "msg_2", quiet, 1)
      if (!quiet) tracker.answer("msg_3")
      tracker.status("child", "completed", 1)
      expect(tracker.settled()).toBe(true)
      tracker.status("child", "completed", 1)
      expect(tracker.settled()).toBe(true)
      tracker.status("child", "running", 2)
      tracker.status("child", "completed", 2)
      expect(tracker.settled()).toBe(false)
      tracker.note("child", "msg_4", quiet, 2)
      if (!quiet) tracker.answer("msg_5")
      expect(tracker.settled()).toBe(true)
    }
})

test("old attempts cannot settle or reopen a newer attempt", () => {
  const tracker = backgroundTracker()
  tracker.status("child", "running", 1)
  tracker.status("child", "running", 2)
  tracker.status("child", "completed", 1)
  tracker.note("child", "msg_9", true, 1)
  tracker.note("child", "msg_9", true)
  expect(tracker.running.has("child")).toBe(true)
  expect(tracker.settled()).toBe(false)
  tracker.note("child", "msg_3", true, 2)
  tracker.status("child", "completed", 2)
  expect(tracker.settled()).toBe(true)
  tracker.status("child", "running", 2)
  expect(tracker.settled()).toBe(true)
})

test("new-attempt notes can precede their lifecycle updates; unversioned notes cannot settle a resumed attempt", () => {
  const tracker = backgroundTracker()
  tracker.status("child", "running", 1)
  tracker.note("child", "msg_4", true, 2)
  tracker.status("child", "completed", 2)
  expect(tracker.settled()).toBe(true)
  const resumed = backgroundTracker()
  resumed.status("child", "completed", 2)
  resumed.note("child", "msg_9", true)
  expect(resumed.settled()).toBe(false)
  resumed.note("child", "msg_4", true, 2)
  expect(resumed.settled()).toBe(true)
})

for (const stall of [
  "/experimental/session/parent/workflow",
  "/experimental/session/parent/workflow/run",
  "/session/child",
  "/permission/ask_child/reply",
]) {
  test(`stalled HTTP operation is bounded: ${stall}`, async () => {
    const setup = fixture({
      stall,
      events: [
        {
          type: "permission.asked",
          properties: {
            id: "ask_child",
            sessionID: "child",
            permission: "edit",
            patterns: ["src/app.ts"],
            always: ["*"],
          },
        },
      ],
    })
    await expect(
      runWorkflow(setup.client, { sessionID: "parent", source: { name: "review" }, timeout: 500 }, setup.output),
    ).rejects.toThrow("timed out")
    expect(setup.requests.some((request) => new URL(request.url).pathname === stall)).toBe(true)
    expect(setup.stdout).toEqual([])
    if (stall === "/experimental/session/parent/workflow") expect(setup.stderr.join("")).toContain("may have started")
  })
}

test("a disconnected pending summary is fenced even before its assistant replaces the launch acknowledgement", async () => {
  const setup = fixture({
    events: [updated, note(false)],
    messages: [
      { info: { id: "msg_1", role: "assistant", parentID: "msg_0", time: { created: 1, completed: 1 } }, parts: [] },
      { info: { id: "msg_2", role: "user" }, parts: [note(false).properties.part] },
    ],
  })
  await expect(
    runWorkflow(setup.client, { sessionID: "parent", source: { name: "review" }, summarize: true }, setup.output),
  ).rejects.toThrow("stream ended")
  const stop = setup.requests.find((request) => new URL(request.url).pathname === "/experimental/session/parent/stop")
  expect(stop).toBeDefined()
  expect(await stop!.json()).toMatchObject({ helpers: false })
})

for (const laterHuman of [false, true]) {
  test(`disconnected summary ${laterHuman ? "preserves a later human turn" : "aborts its own still-running parent turn"}`, async () => {
    const setup = fixture({
      events: [
        updated,
        note(false),
        { type: "session.status", properties: { sessionID: "parent", status: { type: "busy" } } },
        {
          type: "message.updated",
          properties: {
            sessionID: "parent",
            info: { id: "msg_3", parentID: "msg_2", role: "assistant", time: { created: 3 } },
          },
        },
      ],
      messages: [
        { info: { id: "msg_2", role: "user" }, parts: [note(false).properties.part] },
        { info: { id: "msg_3", role: "assistant", parentID: "msg_2", time: { created: 3 } }, parts: [] },
        ...(laterHuman
          ? [{ info: { id: "msg_4", role: "user" }, parts: [{ type: "text", text: "My next task" }] }]
          : []),
      ],
    })
    await expect(
      runWorkflow(setup.client, { sessionID: "parent", source: { name: "review" }, summarize: true }, setup.output),
    ).rejects.toThrow("stream ended")
    expect(
      setup.requests.some((request) => new URL(request.url).pathname === "/experimental/session/parent/stop"),
    ).toBe(!laterHuman)
  })
}

function fixture(input: {
  events: readonly unknown[]
  status?: WorkflowRunDetail["task"]["status"]
  invalid?: boolean
  stall?: string
  messages?: readonly unknown[]
  /** Events a resubscription receives after the first stream ends. Absent, every resubscription ends at once. */
  reconnect?: readonly unknown[]
}) {
  const requests: Request[] = []
  const stdout: string[] = []
  const stderr: string[] = []
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let inspected = 0
  let subscriptions = 0
  const encode = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
  const client = createVectorClient({
    baseUrl: "http://fixture.invalid",
    directory: "/workspace/project",
    throwOnError: true,
    fetch: async (request) => {
      requests.push(request.clone())
      const pathname = new URL(request.url).pathname
      // Deliberately ignore AbortSignal to prove the CLI's own deadline also bounds a bad transport.
      if (pathname === input.stall) return new Promise<Response>(() => {})
      if (pathname === "/experimental/capabilities") return Response.json({ workflows: true })
      if (pathname === "/experimental/workflow/validate")
        return Response.json(
          input.invalid
            ? { ok: false, issues: [{ path: "/stages", message: "missing stages" }], warnings: [] }
            : { ok: true, issues: [], warnings: [{ path: "", message: "Auto resolves for each child" }], plan },
        )
      if (pathname === "/event") {
        subscriptions += 1
        if (subscriptions > 1)
          return new Response(
            new ReadableStream<Uint8Array>({
              start(stream) {
                if (!input.reconnect) return stream.close()
                stream.enqueue(encode({ type: "server.connected", properties: {} }))
                input.reconnect.forEach((event) => stream.enqueue(encode(event)))
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              controller = stream
              stream.enqueue(encode({ type: "server.connected", properties: {} }))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      if (pathname === "/experimental/session/parent/workflow" && request.method === "POST") {
        if (!controller) throw new Error("start happened before the event stream was connected")
        input.events.forEach((event) => controller!.enqueue(encode(event)))
        controller.close()
        return Response.json({ runID: "run", title: "Review", plan })
      }
      if (pathname === "/experimental/session/parent/workflow/run") {
        inspected += 1
        return Response.json({
          task: {
            id: "run",
            parentSessionID: "parent",
            source: "subagent",
            title: "Review",
            status: inspected === 1 ? "running" : (input.status ?? "completed"),
            startedAt: 1,
            elapsedMs: 1,
            ownedPaths: [],
            dependsOn: [],
            resultAvailable: inspected > 1,
            attempt: 1,
            controls: { inspect: true, message: false, stop: true },
          },
          nodes: [],
          truncated: false,
          report: "Verified workflow report",
        })
      }
      if (pathname === "/session/child") return Response.json({ id: "child", parentID: "run" })
      if (pathname === "/session/other") return Response.json({ id: "other", parentID: "parent" })
      if (pathname === "/session/parent/message") return Response.json(input.messages ?? [])
      if (pathname === "/session/status") return Response.json({})
      if (pathname === "/experimental/session/parent/stop") return Response.json(true)
      if (pathname.startsWith("/permission/")) return Response.json(true)
      if (pathname.endsWith("/tasks/stop")) return Response.json({ tasks: [] })
      throw new Error(`Unexpected workflow request: ${request.method} ${pathname}`)
    },
  })
  return {
    client,
    requests,
    stdout,
    stderr,
    output: {
      stdout: (text: string) => {
        stdout.push(text)
      },
      stderr: (text: string) => {
        stderr.push(text)
      },
    },
  }
}
