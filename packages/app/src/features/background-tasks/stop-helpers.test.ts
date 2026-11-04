import { describe, expect, test } from "bun:test"
import type { Task } from "@vectordevai/schema/task"
import { NO_CAPABILITIES, type EngineCapabilities } from "./engine-capabilities"
import { HELPERS_REASON, NO_HELPERS, STOP_CHUNK, helperTargets, stopSession, type HelperTargets } from "./stop-helpers"
import type { TaskAgent } from "./subagent-model"

function task(input: Partial<Task.Info> = {}): Task.Info {
  return {
    id: "ses_a",
    sessionID: "ses_a",
    parentSessionID: "ses_root",
    source: "subagent",
    title: "Inspect routing",
    status: "running",
    startedAt: 100,
    elapsedMs: 25,
    ownedPaths: [],
    dependsOn: [],
    resultAvailable: false,
    attempt: 1,
    controls: { inspect: true, message: true, stop: true },
    ...input,
  }
}

function agent(input: Partial<TaskAgent> = {}): TaskAgent {
  return {
    key: input.sessionID ?? "a",
    sessionID: "ses_a",
    agent: "general",
    kind: "subagent",
    custom: false,
    label: "Subagent",
    title: "Inspect routing",
    status: "running",
    background: true,
    ...input,
  }
}

const flags = (input: Partial<EngineCapabilities>): EngineCapabilities => ({ ...NO_CAPABILITIES, ...input })

type Call = { route: string; input: Record<string, unknown> }

function fakeClient(options: { taskStop?: (input: { taskIDs: string[] }) => unknown; abortFails?: string[] } = {}) {
  const calls: Call[] = []
  const client = {
    session: {
      abort: async (input: { sessionID: string }) => {
        calls.push({ route: "session.abort", input })
        if (options.abortFails?.includes(input.sessionID)) throw new Error("abort failed")
        return { data: true }
      },
    },
    experimental: {
      session: {
        stop: async (input: Record<string, unknown>) => {
          calls.push({ route: "experimental.session.stop", input })
          return { data: { aborted: true, tasks: [task(), task({ id: "ses_b" })], shells: 1, excluded: 2, skipped: 0 } }
        },
      },
      task: {
        stop: async (input: { taskIDs: string[] }) => {
          calls.push({ route: "experimental.task.stop", input })
          if (options.taskStop) return options.taskStop(input)
          return { data: { tasks: input.taskIDs.map((id) => task({ id })) } }
        },
      },
    },
  }
  return { calls, client: client as unknown as Parameters<typeof stopSession>[0]["client"] }
}

const targets = (count: number): HelperTargets => {
  const ids = Array.from({ length: count }, (_, index) => `ses_${index}`)
  return { count, taskIDs: ids, sessionIDs: ids, untracked: [] }
}

// What an engine before 1.99.113 answers under a session with more than 200 finished children.
function refusal() {
  const message = "Too many descendants to stop atomically; select a narrower parent session."
  return Promise.reject(new Error(message, { cause: { body: { code: "invalid", message }, status: 400 } }))
}

describe("helperTargets", () => {
  test("counts live background subagents, leaving out foreground work and agent workspaces", () => {
    const helpers = helperTargets([
      agent({ sessionID: "ses_a", task: task({ id: "ses_a" }) }),
      agent({ sessionID: "ses_b", status: "waiting", task: task({ id: "ses_b", sessionID: "ses_b" }) }),
      agent({
        sessionID: "ses_c",
        status: "pending",
        task: task({ id: "ses_c", sessionID: "ses_c", status: "queued" }),
      }),
      // Foreground work stops with the main turn.
      agent({ sessionID: "ses_fg", background: false, task: task({ id: "ses_fg", sessionID: "ses_fg" }) }),
      // Finished.
      agent({ sessionID: "ses_done", status: "done", task: task({ id: "ses_done", sessionID: "ses_done" }) }),
      // Desktop workspaces keep their own Stop, whatever source they report.
      agent({ sessionID: undefined, task: task({ id: "workspace:one", sessionID: undefined }) }),
      agent({ sessionID: undefined, task: task({ id: "swarm:two", sessionID: undefined, source: "swarm" }) }),
      agent({ sessionID: "ses_team", task: task({ id: "ses_team", sessionID: "ses_team", source: "team" }) }),
      // The engine says it cannot be stopped.
      agent({
        sessionID: "ses_locked",
        task: task({
          id: "ses_locked",
          sessionID: "ses_locked",
          controls: { inspect: true, message: true, stop: false },
        }),
      }),
      // The same task seen twice (a resumed run) counts once.
      agent({ key: "again", sessionID: "ses_a", task: task({ id: "ses_a" }) }),
      // A child from before the board: only its session is known.
      agent({ sessionID: "ses_old" }),
    ])
    expect(helpers).toEqual({
      count: 4,
      taskIDs: ["ses_a", "ses_b", "ses_c"],
      sessionIDs: ["ses_a", "ses_b", "ses_c", "ses_old"],
      untracked: ["ses_old"],
    })
  })

  test("no helpers reads as the shared empty value", () => {
    expect(helperTargets([])).toBe(NO_HELPERS)
    expect(helperTargets([agent({ background: false })])).toBe(NO_HELPERS)
  })

  test("a workflow run counts once: its agents the Tasks pane loaded stop with the run", () => {
    const run = agent({
      sessionID: "ses_run",
      task: task({ id: "ses_run", sessionID: "ses_run", workflow: { role: "run", runID: "ses_run" } }),
    })
    const step = agent({
      sessionID: "ses_w1",
      task: task({
        id: "ses_w1",
        sessionID: "ses_w1",
        parentSessionID: "ses_run",
        groupID: "workflow:ses_run",
        workflow: { role: "agent", runID: "ses_run", stage: "scan" },
      }),
    })
    expect(helperTargets([run, step])).toEqual({
      count: 1,
      taskIDs: ["ses_run"],
      sessionIDs: ["ses_run"],
      untracked: [],
    })
  })
})

describe("stopSession fallback chain", () => {
  test("1. uses route 1 when the engine has sessionStop, and nothing else", async () => {
    const { calls, client } = fakeClient()
    const result = await stopSession({
      client,
      sessionID: "ses_root",
      capabilities: flags({ backgroundSubagents: true, sessionStop: true }),
      targets: targets(3),
    })
    expect(calls).toEqual([
      { route: "experimental.session.stop", input: { sessionID: "ses_root", helpers: true, reason: HELPERS_REASON } },
    ])
    expect(result).toEqual({ via: "route", stopped: 2, excluded: 2, failed: 0 })
  })

  test("2. without route 1, aborts the main turn and stops the tasks in chunks of 200", async () => {
    const { calls, client } = fakeClient()
    const helpers = { ...targets(450), sessionIDs: [...targets(450).sessionIDs, "ses_old"], untracked: ["ses_old"] }
    const result = await stopSession({
      client,
      sessionID: "ses_root",
      capabilities: flags({ backgroundSubagents: true }),
      targets: { ...helpers, count: 451 },
    })
    expect(calls[0]).toEqual({ route: "session.abort", input: { sessionID: "ses_root" } })
    const stops = calls.filter((call) => call.route === "experimental.task.stop")
    expect(stops.map((call) => (call.input.taskIDs as string[]).length)).toEqual([STOP_CHUNK, STOP_CHUNK, 50])
    expect(stops.every((call) => call.input.sessionID === "ses_root" && call.input.reason === HELPERS_REASON)).toBe(
      true,
    )
    expect(stops.flatMap((call) => call.input.taskIDs as string[])).toEqual([...helpers.taskIDs])
    // A helper with no task row is stopped by its session.
    expect(calls.at(-1)).toEqual({ route: "session.abort", input: { sessionID: "ses_old" } })
    expect(calls.filter((call) => call.route === "session.abort")).toHaveLength(2)
    expect(result).toEqual({ via: "tasks", stopped: 451, excluded: 0, failed: 0 })
  })

  test("2 → 3. an `invalid` too-many-descendants refusal aborts each live helper session instead", async () => {
    const { calls, client } = fakeClient({ taskStop: refusal })
    const result = await stopSession({
      client,
      sessionID: "ses_root",
      capabilities: flags({ backgroundSubagents: true }),
      targets: targets(3),
    })
    expect(calls).toEqual([
      { route: "session.abort", input: { sessionID: "ses_root" } },
      {
        route: "experimental.task.stop",
        input: { sessionID: "ses_root", taskIDs: ["ses_0", "ses_1", "ses_2"], reason: HELPERS_REASON },
      },
      { route: "session.abort", input: { sessionID: "ses_0" } },
      { route: "session.abort", input: { sessionID: "ses_1" } },
      { route: "session.abort", input: { sessionID: "ses_2" } },
    ])
    // The main turn is aborted once.
    expect(calls.filter((call) => call.input.sessionID === "ses_root" && call.route === "session.abort")).toHaveLength(
      1,
    )
    expect(result).toEqual({ via: "sessions", stopped: 3, excluded: 0, failed: 0 })
  })

  test("any other task.stop error is counted, and the other chunks still go", async () => {
    let call = 0
    const { calls, client } = fakeClient({
      taskStop: (input) => {
        call += 1
        if (call === 1) return Promise.reject(new Error("Task not found", { cause: { body: { code: "not_found" } } }))
        return { data: { tasks: input.taskIDs.map((id) => task({ id })) } }
      },
    })
    const result = await stopSession({
      client,
      sessionID: "ses_root",
      capabilities: flags({ backgroundSubagents: true }),
      targets: targets(250),
    })
    expect(calls.filter((entry) => entry.route === "experimental.task.stop")).toHaveLength(2)
    expect(calls.filter((entry) => entry.route === "session.abort")).toHaveLength(1)
    expect(result).toEqual({ via: "tasks", stopped: 50, excluded: 0, failed: 1 })
  })

  test("3. an engine without the task routes aborts the main turn and each live helper session", async () => {
    const { calls, client } = fakeClient({ abortFails: ["ses_1"] })
    const result = await stopSession({
      client,
      sessionID: "ses_root",
      capabilities: NO_CAPABILITIES,
      targets: targets(2),
    })
    expect(calls).toEqual([
      { route: "session.abort", input: { sessionID: "ses_root" } },
      { route: "session.abort", input: { sessionID: "ses_0" } },
      { route: "session.abort", input: { sessionID: "ses_1" } },
    ])
    expect(result).toEqual({ via: "sessions", stopped: 1, excluded: 0, failed: 1 })
  })

  test("with no helpers it still stops the main turn, and never calls task.stop with nothing", async () => {
    const { calls, client } = fakeClient()
    const result = await stopSession({
      client,
      sessionID: "ses_root",
      capabilities: flags({ backgroundSubagents: true }),
      targets: NO_HELPERS,
    })
    expect(calls).toEqual([{ route: "session.abort", input: { sessionID: "ses_root" } }])
    expect(result).toEqual({ via: "tasks", stopped: 0, excluded: 0, failed: 0 })
  })

  test("route 1 failing throws instead of trying something else", async () => {
    const { client } = fakeClient()
    ;(client.experimental.session as { stop: unknown }).stop = () => Promise.reject(new Error("Forbidden"))
    await expect(
      stopSession({ client, sessionID: "ses_root", capabilities: flags({ sessionStop: true }), targets: targets(1) }),
    ).rejects.toThrow("Forbidden")
  })
})
