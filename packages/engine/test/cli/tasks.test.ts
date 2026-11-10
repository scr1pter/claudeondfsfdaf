import { afterEach, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import yargs from "yargs"
import { createVectorClient } from "@vectordevai/sdk/v2"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import type { Task } from "@vectordevai/schema/task"
import {
  confirmAtTerminal,
  executeTaskCommand,
  formatLimits,
  formatShells,
  formatTaskResult,
  formatTasks,
  TasksCommand,
  tasksForOutput,
} from "@/cli/cmd/tasks"

test("task CLI uses the owning server and preserves control payloads", async () => {
  const requests: Request[] = []
  const client = createVectorClient({
    baseUrl: "http://fixture.invalid",
    directory: "/fixture/workspace",
    throwOnError: true,
    fetch: async (request) => {
      requests.push(request)
      return Response.json({ tasks: [], truncated: false })
    },
  })
  await executeTaskCommand(client, { action: "list", session: "parent", descendants: true })
  await executeTaskCommand(client, { action: "inspect", session: "parent", taskID: "child" })
  await executeTaskCommand(client, {
    action: "message",
    session: "parent",
    taskID: "child",
    text: "Keep the existing API",
    delivery: "queue",
  })
  await executeTaskCommand(client, {
    action: "stop",
    session: "parent",
    task: ["child", "child", "other"],
    reason: "Requirements changed",
  })
  await executeTaskCommand(client, { action: "wait", session: "parent", taskID: "child", mode: "all", timeout: 100 })
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ["GET", "/experimental/session/parent/tasks"],
    ["GET", "/experimental/session/parent/tasks/child"],
    ["POST", "/experimental/session/parent/tasks/child/message"],
    ["POST", "/experimental/session/parent/tasks/stop"],
    ["POST", "/experimental/session/parent/tasks/wait"],
  ])
  expect(new URL(requests[0].url).searchParams.get("descendants")).toBe("true")
  expect(await requests[2].json()).toEqual({ text: "Keep the existing API", delivery: "queue" })
  expect(await requests[3].json()).toEqual({ taskIDs: ["child", "other"], reason: "Requirements changed" })
  expect(await requests[4].json()).toEqual({ taskIDs: ["child"], mode: "all", timeout: 100 })
})

test("invalid task selections do not send requests", async () => {
  const client = createVectorClient({
    baseUrl: "http://fixture.invalid",
    fetch: async () => {
      throw new Error("unexpected request")
    },
  })
  await expect(executeTaskCommand(client, { action: "stop", session: "parent" })).rejects.toThrow("requires task IDs")
  await expect(
    executeTaskCommand(client, { action: "stop", session: "parent", all: true, taskID: "child" }),
  ).rejects.toThrow("Choose --all")
  await expect(
    executeTaskCommand(client, { action: "message", session: "parent", taskID: "child", text: "  " }),
  ).rejects.toThrow("non-empty text")
  await expect(
    executeTaskCommand(client, { action: "wait", session: "parent", taskID: "child", timeout: Infinity }),
  ).rejects.toThrow("timeout must be")
})

test("task CLI never renders missing usage as zero spend", () => {
  expect(formatTasks([])).toBe("No subagent tasks.")
  const task: Task.Info = {
    id: "child",
    parentSessionID: "parent",
    source: "subagent",
    title: "Work",
    status: "running",
    startedAt: 1,
    elapsedMs: 1,
    ownedPaths: [],
    dependsOn: [],
    resultAvailable: false,
    attempt: 1,
    controls: { inspect: true, message: true, stop: true },
  }
  const usage = {
    cost: 0.12,
    total: 987654,
    steps: 2,
    toolUses: 0,
    unpricedSteps: 1,
    tokens: { input: 987654, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const legacy = { ...task, billing: "codium" as const, costKind: "unknown" as const, usage }
  for (const result of [
    { tasks: [legacy], truncated: false },
    { task: legacy, steps: [], truncated: false },
    { tasks: [legacy], timedOut: false },
  ]) {
    const printed = JSON.stringify(tasksForOutput(result))
    expect(printed).not.toContain("987654")
    expect(printed).toContain('"cost":0.12')
    expect(printed).toContain('"costKind":"unknown"')
  }
  const modern = {
    ...legacy,
    usage: { ...usage, tokensOwnOnly: true, codiumSteps: 1, total: 123, tokens: { ...usage.tokens, input: 123 } },
  }
  expect(tasksForOutput({ tasks: [modern, task], truncated: false })).toEqual({
    tasks: [modern, task],
    truncated: false,
  })
  for (const codiumSteps of [0, 1]) {
    const ambiguous = { ...task, usage: { ...usage, codiumSteps } }
    expect(JSON.stringify(tasksForOutput({ task: ambiguous }))).not.toContain("987654")
    expect(formatTasks([ambiguous])).not.toContain("987,654")
    expect(formatTasks([ambiguous])).toContain("$0.1200")
  }
  expect(legacy.usage.total).toBe(987654)
  expect(formatTasks([task])).toContain("usage unavailable")
  expect(formatTasks([{ ...task, billing: "codium", costKind: "codium" }])).toContain("Codium")
  const mixed = formatTasks([{ ...task, billing: "codium", costKind: "unknown", measuredCost: 0.12 }])
  expect(mixed).toContain("$0.1200 reported + unpriced + Codium")
  expect(mixed).not.toContain("tokens")
  expect(formatTasks([{ ...task, connection: "disconnected" }])).toContain("disconnected (last known: running)")
  expect(formatTasks([{ ...task, source: "external", measuredCost: 0.125, costKind: "priced" }])).toContain(
    "$0.1250 reported · tokens unavailable",
  )
  expect(formatTasks([{ ...task, source: "external", costKind: "plan" }])).toContain(
    "covered by plan · tokens unavailable",
  )
})

// WP34 (5.I.6): the new actions, their capability gate, and the new lines.

const marker = process.env[ChildEnvironment.AGENT_MARKER]
afterEach(() => {
  if (marker === undefined) delete process.env[ChildEnvironment.AGENT_MARKER]
  else process.env[ChildEnvironment.AGENT_MARKER] = marker
})

const ALL_FLAGS = {
  backgroundSubagents: true,
  sessionStop: true,
  taskPromote: true,
  taskResume: true,
  taskIsolation: true,
  backgroundShells: true,
  workflows: true,
}

function info(input: Partial<Task.Info> & { id: string }): Task.Info {
  return {
    parentSessionID: "parent",
    source: "subagent",
    title: "Work",
    status: "running",
    startedAt: 1,
    elapsedMs: 1000,
    ownedPaths: [],
    dependsOn: [],
    resultAvailable: false,
    attempt: 1,
    controls: { inspect: true, message: true, stop: true },
    ...input,
  }
}

function server(
  requests: Request[],
  input: { capabilities?: () => Response; tasks?: Task.Info[]; shells?: Task.Shell[] } = {},
) {
  return createVectorClient({
    baseUrl: "http://fixture.invalid",
    directory: "/fixture/workspace",
    throwOnError: true,
    fetch: async (request) => {
      requests.push(request)
      const url = new URL(request.url)
      const path = url.pathname
      if (path === "/experimental/capabilities") return input.capabilities?.() ?? Response.json(ALL_FLAGS)
      if (path.endsWith("/stop") && path.includes("/tasks/"))
        return Response.json({
          tasks: ((await request.clone().json()).taskIDs ?? []).map((id: string) => info({ id })),
        })
      if (path.endsWith("/session/parent/stop"))
        return Response.json({ aborted: true, tasks: [info({ id: "ses_a" })], shells: 1, excluded: 1, skipped: 0 })
      if (path.endsWith("/tasks/resume"))
        return Response.json({ tasks: (await request.clone().json()).taskIDs.map((id: string) => info({ id })) })
      if (path.endsWith("/tasks/background")) return Response.json({ tasks: [info({ id: "ses_a", background: true })] })
      if (path.endsWith("/changes"))
        return Response.json({
          task: info({ id: "ses_a", status: "completed" }),
          files: [{ path: "src/a.ts", status: "modified", additions: 2, deletions: 1, binary: false }],
          truncated: false,
          mergeable: "clean",
        })
      if (path.endsWith("/merge"))
        return Response.json({ task: info({ id: "ses_a" }), merged: ["src/a.ts"], remaining: [], conflicts: [] })
      if (path.endsWith("/discard")) return Response.json({ task: info({ id: "ses_a" }), saved: "/saved/patch" })
      if (path.endsWith("/workflow")) return Response.json({ runs: [] })
      if (path.includes("/workflow/")) return Response.json({ task: info({ id: "run" }), nodes: [], truncated: false })
      if (path.endsWith("/tasks"))
        return Response.json({
          tasks: input.tasks ?? [],
          truncated: false,
          ...(input.shells ? { shells: input.shells } : {}),
        })
      return Response.json({}, { status: 404 })
    },
  })
}

function operations(requests: Request[]) {
  return requests
    .filter((request) => new URL(request.url).pathname !== "/experimental/capabilities")
    .map((request) => {
      const url = new URL(request.url)
      return [request.method, url.pathname, url.search.replace(/[?&]directory=[^&]*/, "")]
    })
}

const yes = { confirm: async () => true }

test("every new action sends its method, path and payload after its capability check", async () => {
  const requests: Request[] = []
  const interrupted = [
    info({
      id: "ses_i1",
      status: "stopped",
      interrupted: { at: 1, cause: "crash" },
      controls: { inspect: true, message: false, stop: false, resume: true },
    }),
    info({
      id: "ses_resumed",
      status: "running",
      interrupted: { at: 1, cause: "crash", resumedAt: 2 },
      controls: { inspect: true, message: true, stop: true, resume: true },
    }),
    info({
      id: "ses_dismissed",
      status: "stopped",
      interrupted: { at: 1, cause: "shutdown", dismissedAt: 2 },
      controls: { inspect: true, message: false, stop: false, resume: true },
    }),
    info({
      id: "ses_unstarted",
      status: "stopped",
      interrupted: { at: 1, cause: "crash" },
      controls: { inspect: true, message: false, stop: false, resume: false },
    }),
  ]
  const client = server(requests, { tasks: interrupted })
  await executeTaskCommand(client, { action: "interrupt", session: "parent" })
  await executeTaskCommand(client, { action: "interrupt", session: "parent", helpers: true, reason: "Done for today" })
  await executeTaskCommand(client, {
    action: "resume",
    session: "parent",
    taskID: "ses_a",
    task: ["ses_b"],
    text: "Carry on",
  })
  await executeTaskCommand(client, { action: "resume", session: "parent", interrupted: true })
  await executeTaskCommand(client, { action: "promote", session: "parent" })
  await executeTaskCommand(client, { action: "promote", session: "parent", task: ["ses_a"] })
  await executeTaskCommand(client, { action: "changes", session: "parent", taskID: "ses_a", diff: true })
  await executeTaskCommand(client, { action: "merge", session: "parent", taskID: "ses_a", file: ["src/a.ts"] }, yes)
  await executeTaskCommand(client, {
    action: "discard",
    session: "parent",
    taskID: "ses_a",
    yes: true,
    reason: "Wrong approach",
  })
  await executeTaskCommand(client, { action: "workflow", session: "parent" })
  await executeTaskCommand(client, { action: "workflow", session: "parent", taskID: "run" })
  await executeTaskCommand(client, { action: "list", session: "parent", active: true, shells: true })
  expect(operations(requests)).toEqual([
    ["POST", "/experimental/session/parent/stop", ""],
    ["POST", "/experimental/session/parent/stop", ""],
    ["POST", "/experimental/session/parent/tasks/resume", ""],
    ["GET", "/experimental/session/parent/tasks", ""],
    ["POST", "/experimental/session/parent/tasks/resume", ""],
    ["POST", "/experimental/session/parent/tasks/background", ""],
    ["POST", "/experimental/session/parent/tasks/background", ""],
    ["GET", "/experimental/session/parent/tasks/ses_a/changes", "?diff=true"],
    ["POST", "/experimental/session/parent/tasks/ses_a/merge", ""],
    ["POST", "/experimental/session/parent/tasks/ses_a/discard", ""],
    ["GET", "/experimental/session/parent/workflow", ""],
    ["GET", "/experimental/session/parent/workflow/run", ""],
    ["GET", "/experimental/session/parent/tasks", "?descendants=false&active=true&shells=true"],
  ])
  const bodies = requests.filter((request) => request.method === "POST")
  expect(await bodies[0].json()).toEqual({ helpers: false })
  expect(await bodies[1].json()).toEqual({ helpers: true, reason: "Done for today" })
  expect(await bodies[2].json()).toEqual({ taskIDs: ["ses_a", "ses_b"], text: "Carry on" })
  // Only the interrupted helper that is neither resumed, dismissed nor unresumable is sent.
  expect(await bodies[3].json()).toEqual({ taskIDs: ["ses_i1"] })
  expect(await bodies[4].text()).toBe("")
  expect(await bodies[5].json()).toEqual({ taskIDs: ["ses_a"] })
  expect(await bodies[6].json()).toEqual({ files: ["src/a.ts"] })
  expect(await bodies[7].json()).toEqual({ reason: "Wrong approach" })
  // Each new action, and list --shells, asks the capabilities first (12 calls above); a plain list does not.
  expect(requests.filter((request) => new URL(request.url).pathname === "/experimental/capabilities")).toHaveLength(12)
})

test("list --active also filters an older engine's answer locally", async () => {
  const requests: Request[] = []
  const client = server(requests, {
    tasks: [
      info({ id: "ses_run" }),
      info({ id: "ses_done", status: "completed" }),
      info({ id: "ses_q", status: "queued" }),
    ],
  })
  const result = await executeTaskCommand(client, { action: "list", session: "parent", active: true })
  expect("tasks" in result && result.tasks.map((task) => task.id)).toEqual(["ses_run", "ses_q"])
  expect(operations(requests)).toEqual([
    ["GET", "/experimental/session/parent/tasks", "?descendants=false&active=true"],
  ])
})

test("missing flags and HTML capabilities print the update instruction before any operation", async () => {
  const cases: Array<[Parameters<typeof executeTaskCommand>[1], string]> = [
    [{ action: "interrupt", session: "parent", helpers: true }, "cannot stop including helpers"],
    [{ action: "resume", session: "parent", taskID: "ses_a" }, "cannot resume subagents"],
    [{ action: "promote", session: "parent" }, "cannot move subagents to the background"],
    [{ action: "changes", session: "parent", taskID: "ses_a" }, "cannot review a subagent's changes"],
    [{ action: "merge", session: "parent", taskID: "ses_a", yes: true }, "cannot merge a subagent's changes"],
    [{ action: "discard", session: "parent", taskID: "ses_a", yes: true }, "cannot discard a subagent's changes"],
    [{ action: "workflow", session: "parent" }, "cannot list workflow runs"],
    [{ action: "list", session: "parent", shells: true }, "cannot list background commands"],
  ]
  for (const capabilities of [
    () => Response.json({ backgroundSubagents: true }),
    () => new Response("<html>old server</html>", { headers: { "content-type": "text/html" } }),
    () => new Response("<html>old server</html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
    () => Response.json({}, { status: 404 }),
  ])
    for (const [args, action] of cases) {
      const requests: Request[] = []
      await expect(executeTaskCommand(server(requests, { capabilities }), args, yes)).rejects.toThrow(
        `This server's engine predates 1.99.113 and ${action}; update it.`,
      )
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual(["/experimental/capabilities"])
    }
  const requests: Request[] = []
  await expect(
    executeTaskCommand(
      server(requests, { capabilities: () => Response.json({ message: "private" }, { status: 403 }) }),
      { action: "promote", session: "parent" },
    ),
  ).rejects.toThrow("HTTP 403")
})

test("stop --background stops only running background subagents, and refuses an engine that cannot tell", async () => {
  const requests: Request[] = []
  const tasks = [
    info({ id: "ses_bg", background: true }),
    info({ id: "ses_fg", background: false }),
    info({ id: "ses_done", status: "completed", background: true }),
    info({ id: "ses_stopping", background: true, controls: { inspect: true, message: false, stop: false } }),
    info({ id: "desk", source: "team" }),
  ]
  const client = server(requests, { tasks })
  const result = await executeTaskCommand(client, {
    action: "stop",
    session: "parent",
    background: true,
    reason: "Enough",
  })
  expect(operations(requests)).toEqual([
    ["GET", "/experimental/session/parent/tasks", "?active=true"],
    ["POST", "/experimental/session/parent/tasks/stop", ""],
  ])
  expect(await requests[1].json()).toEqual({ taskIDs: ["ses_bg"], reason: "Enough" })
  expect(await formatTaskResult({ action: "stop", background: true }, result)).toStartWith(
    "Stopped 1 background subagent.",
  )

  const many: Request[] = []
  await executeTaskCommand(
    server(many, { tasks: Array.from({ length: 201 }, (_, index) => info({ id: `ses_${index}`, background: true })) }),
    { action: "stop", session: "parent", background: true },
  )
  expect(
    (await Promise.all(many.slice(1).map((request) => request.json()))).map((body) => body.taskIDs.length),
  ).toEqual([200, 1])

  const old: Request[] = []
  await expect(
    executeTaskCommand(server(old, { tasks: [info({ id: "ses_legacy" })] }), {
      action: "stop",
      session: "parent",
      background: true,
    }),
  ).rejects.toThrow("This server's engine predates 1.99.113 and cannot stop only its background subagents; update it.")
  expect(operations(old)).toEqual([["GET", "/experimental/session/parent/tasks", "?active=true"]])
  const none: Request[] = []
  const empty = await executeTaskCommand(server(none, { tasks: [info({ id: "desk", source: "swarm" })] }), {
    action: "stop",
    session: "parent",
    background: true,
  })
  expect(await formatTaskResult({ action: "stop", background: true }, empty)).toBe(
    "No background subagents are running.",
  )
  await expect(
    executeTaskCommand(server([]), { action: "stop", session: "parent", background: true, all: true }),
  ).rejects.toThrow("Choose --background, --all or specific task IDs")
})

test("merge and discard refuse under the agent marker before any request, and need a confirmation", async () => {
  process.env[ChildEnvironment.AGENT_MARKER] = "ses_outer"
  for (const action of ["merge", "discard"]) {
    const requests: Request[] = []
    await expect(
      executeTaskCommand(server(requests), { action, session: "parent", taskID: "ses_a", yes: true }, yes),
    ).rejects.toThrow("Vector's agents cannot")
    expect(requests).toHaveLength(0)
  }
  // Read and stop actions stay open to an agent.
  const open: Request[] = []
  await executeTaskCommand(server(open), { action: "stop", session: "parent", taskID: "ses_a" })
  expect(operations(open)).toEqual([["POST", "/experimental/session/parent/tasks/stop", ""]])
  delete process.env[ChildEnvironment.AGENT_MARKER]

  const asked: string[] = []
  const declined: Request[] = []
  await expect(
    executeTaskCommand(
      server(declined),
      { action: "merge", session: "parent", taskID: "ses_a" },
      {
        confirm: async (question) => {
          asked.push(question)
          return false
        },
      },
    ),
  ).rejects.toThrow("Nothing was merged")
  await expect(
    executeTaskCommand(
      server(declined),
      { action: "discard", session: "parent", taskID: "ses_a" },
      {
        confirm: async () => false,
      },
    ),
  ).rejects.toThrow("Nothing was discarded")
  expect(asked).toEqual(["Merge the changes of ses_a into this checkout?"])
  expect(operations(declined)).toEqual([])
})

test("the terminal confirmation takes y as yes, and Ctrl+C or a closed input as no rather than never answering", async () => {
  const ask = async (answer: (input: PassThrough) => void) => {
    const input = Object.assign(new PassThrough(), { isTTY: true })
    const output = Object.assign(new PassThrough(), { isTTY: true })
    output.resume()
    const asked = confirmAtTerminal("Merge the changes of ses_a into this checkout?", { input, output })
    setTimeout(() => answer(input), 5)
    return asked
  }
  expect(await ask((input) => input.write("y\r"))).toBe(true)
  expect(await ask((input) => input.write("n\r"))).toBe(false)
  expect(await ask((input) => input.write("\x03"))).toBe(false)
  expect(await ask((input) => input.end())).toBe(false)
  // Without a terminal nothing is asked.
  expect(await confirmAtTerminal("Merge?", { input: new PassThrough(), output: new PassThrough() })).toBe(false)
})

test("invalid new selections send no request", async () => {
  const requests: Request[] = []
  const client = server(requests)
  await expect(executeTaskCommand(client, { action: "resume", session: "parent" })).rejects.toThrow("--interrupted")
  await expect(
    executeTaskCommand(client, { action: "resume", session: "parent", taskID: "ses_a", interrupted: true }),
  ).rejects.toThrow("Choose --interrupted or specific task IDs")
  await expect(
    executeTaskCommand(client, { action: "resume", session: "parent", taskID: "ses_a", text: "  " }),
  ).rejects.toThrow("1 to 4096")
  await expect(executeTaskCommand(client, { action: "changes", session: "parent" })).rejects.toThrow(
    "exactly one task ID",
  )
  await expect(executeTaskCommand(client, { action: "list", session: "parent", helpers: true })).rejects.toThrow(
    "--helpers is only used with interrupt",
  )
  await expect(
    executeTaskCommand(client, { action: "stop", session: "parent", taskID: "ses_a", file: ["a"] }),
  ).rejects.toThrow("--file is only used with merge")
  await expect(executeTaskCommand(client, { action: "interrupt", session: "parent", taskID: "ses_a" })).rejects.toThrow(
    "takes no task IDs",
  )
  await expect(executeTaskCommand(client, { action: "bogus", session: "parent" })).rejects.toThrow(
    "Unknown task action",
  )
  expect(requests).toHaveLength(0)
})

test("task arguments carry resume IDs and --text through yargs", async () => {
  const seen: unknown[] = []
  await yargs([])
    .exitProcess(false)
    .command({
      ...TasksCommand,
      handler: (args) => {
        seen.push({ action: args.action, taskID: args.taskID, task: args.task, text: args.text })
      },
    })
    .parseAsync([
      "tasks",
      "resume",
      "ses_a",
      "--task",
      "ses_b",
      "--task",
      "ses_c",
      "--text",
      "Carry on",
      "--attach",
      "http://localhost:4096",
      "--session",
      "parent",
    ])
  expect(seen).toEqual([{ action: "resume", taskID: "ses_a", task: ["ses_b", "ses_c"], text: "Carry on" }])
})

test("model-written strings reach the terminal only through sanitizeTerminalText", async () => {
  const hostile = "Fix\x1b]52;c;cm0gLXJmIH4=\x07 it\x1b[2J‮"
  const printed = [
    formatTasks([
      info({
        id: "ses_a",
        title: hostile,
        currentStep: hostile,
        reason: hostile,
        queuedReason: hostile,
        status: "queued",
        isolation: { mode: "worktree", state: "changed", branch: hostile, conflicts: [hostile], error: hostile },
        waiting: { kind: "permission", since: 0, summary: hostile },
        model: { providerID: hostile, modelID: "m" },
      }),
    ]),
    await formatTaskResult(
      { action: "changes" },
      {
        task: info({ id: "ses_a", title: hostile }),
        files: [{ path: hostile, status: "added", additions: 1, deletions: 0, binary: false }],
        patch: `+${hostile}\n-\told`,
        truncated: false,
        mergeable: "conflict",
        detail: hostile,
      },
    ),
    await formatTaskResult(
      { action: "merge" },
      { task: info({ id: "ses_a" }), merged: [hostile], remaining: [hostile], conflicts: [hostile] },
    ),
    formatShells(
      [
        {
          id: "shl_1",
          title: hostile,
          command: hostile,
          status: "running",
          startedAt: 0,
          outputBytes: 10,
          outputPath: hostile,
        },
      ],
      1000,
    ),
  ].join("\n")
  expect(printed).toContain("Fix it")
  expect(printed).not.toContain("\x1b")
  expect(printed).not.toContain("\x07")
  expect(printed).not.toContain("]52")
  expect(printed).not.toContain("‮")
  // Tabs in a patch keep their place as spaces.
  expect(printed).toContain("-  old")
})

test("formatTasks prints the limits line, model and effort, fork, worktree, interruption, waiting and the result", () => {
  const now = 10 * 60_000
  const limits: Task.Limits = {
    running: 5,
    queued: 2,
    maxRunning: 8,
    launched: 12,
    maxPerRequest: 32,
    spend: { spentUsd: 3.1, limitUsd: 25, unknownSteps: 0, warned: false, stopped: false },
  }
  expect(formatLimits(limits)).toBe(
    "5 of 8 running · 2 waiting · 12 of 32 started this request · $3.10 of $25.00 subagent spend",
  )
  expect(formatLimits({ ...limits, queued: 0, spend: undefined })).toBe(
    "5 of 8 running · 12 of 32 started this request",
  )
  // Unknown spend is said as unknown, never as $0 (I9).
  expect(formatLimits({ ...limits, spend: { ...limits.spend!, spentUsd: 0, unknownSteps: 2 } })).toContain(
    "unknown of $25.00 subagent spend",
  )
  expect(formatLimits({ ...limits, spend: { ...limits.spend!, unknownSteps: 1, stopped: true } })).toContain(
    "$3.10 + unknown of $25.00 subagent spend (ceiling reached)",
  )
  expect(formatTasks([], { limits })).toBe(`${formatLimits(limits)}\nNo subagent tasks.`)
  const lines = formatTasks(
    [
      info({
        id: "ses_a",
        model: { providerID: "openai", modelID: "gpt-5" },
        effort: "high",
        fork: true,
        isolation: {
          mode: "worktree",
          state: "changed",
          branch: "vector/task-a",
          files: 3,
          additions: 12,
          deletions: 4,
        },
        result: { format: "json", valid: true, attempts: 2 },
      }),
      info({ id: "ses_b", status: "stopped", interrupted: { at: 1, cause: "crash" } }),
      info({ id: "ses_c", status: "stopped", interrupted: { at: 1, cause: "crash", resumedAt: 2 } }),
      info({ id: "ses_d", status: "waiting_on_user", waiting: { kind: "permission", since: now - 3 * 60_000 } }),
      info({
        id: "ses_e",
        status: "waiting_on_user",
        waiting: { kind: "question", since: now, summary: "Which branch?" },
      }),
      info({ id: "ses_f", status: "queued", queuedReason: "Waiting for a free subagent slot" }),
      info({ id: "ses_g", result: { format: "json", valid: false } }),
    ],
    { limits, now },
  ).split("\n")
  expect(lines[0]).toBe(formatLimits(limits))
  expect(lines).toContain("  openai/gpt-5 · high effort · fork")
  expect(lines).toContain("  Worktree: vector/task-a · changed · 3 files changed (+12 -4)")
  expect(lines).toContain("  Result: JSON, valid after 2 attempts")
  expect(lines).toContain("  Interrupted when Vector stopped (crash); nothing resumes on its own")
  expect(lines.filter((line) => line.includes("Interrupted"))).toHaveLength(1)
  expect(lines).toContain("  Needs your permission · 3m")
  expect(lines).toContain("  Needs your answer · <1m: Which branch?")
  expect(lines).toContain("  Waiting for a free subagent slot")
  expect(lines).toContain("  Result: JSON, did not match its schema")
})

test("new results print what happened", async () => {
  const stop = {
    aborted: true,
    tasks: [info({ id: "ses_a" })],
    shells: 2,
    excluded: 1,
    skipped: 1,
  }
  const all = await formatTaskResult({ action: "interrupt", helpers: true }, stop)
  expect(all).toContain("Stopped the main turn.\nStopped 1 helper.\nStopped 2 background commands.")
  expect(all).toContain("1 agent workspace keep running; stop them from the Agent Dashboard.")
  expect(all).toContain("1 desktop task could not be reached.")
  expect(await formatTaskResult({ action: "interrupt" }, { ...stop, aborted: false, tasks: [], shells: 0 })).toBe(
    "The main turn was not running.\nHelpers keep running; vector tasks interrupt --helpers stops them too.",
  )
  expect(await formatTaskResult({ action: "resume", interrupted: true }, { tasks: [] })).toBe(
    "No interrupted subagents to resume.",
  )
  expect(await formatTaskResult({ action: "resume" }, { tasks: [info({ id: "ses_a" })] })).toStartWith(
    "Resumed 1 subagent.",
  )
  expect(await formatTaskResult({ action: "promote" }, { tasks: [] })).toBe("No foreground subagents to move.")
  expect(await formatTaskResult({ action: "discard" }, { task: info({ id: "ses_a" }), saved: "/kept" })).toBe(
    "Discarded the changes of ses_a.\nA recovery copy is at /kept.",
  )
  const listed = await formatTaskResult(
    { action: "list", shells: true },
    {
      tasks: [],
      truncated: false,
      shells: [
        { id: "shl_1", title: "dev", command: "bun dev", status: "running", startedAt: Date.now(), outputBytes: 2048 },
      ],
    },
  )
  expect(listed).toContain("shl_1  running  bun dev")
  expect(listed).toContain("2.0 KB of output")
})
