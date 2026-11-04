import { describe, expect, test } from "bun:test"
import type { Task } from "@vectordevai/schema/task"
import {
  backgroundStopRequests,
  helpersLeftMessage,
  interruptedTaskIDs,
  interruptedToast,
  limitsLine,
  liveHelpers,
  orderedTasks,
  stageLines,
  stoppedHelpersMessage,
  taskCategory,
  taskDescription,
  taskProgress,
  taskTitle,
} from "../src/routes/session/task-presentation"

const task: Task.Info = {
  id: "child",
  parentSessionID: "parent",
  source: "subagent",
  title: "Check permissions",
  status: "waiting_on_user",
  startedAt: 1,
  elapsedMs: 2_500,
  attempt: 1,
  ownedPaths: ["src/auth"],
  dependsOn: ["explore"],
  resultAvailable: true,
  resultRef: "session:child",
  controls: { inspect: true, message: true, stop: true },
}

test("task summaries name pending attention and preserve unknown usage", () => {
  expect(taskDescription(task)).toBe("Needs you · 3s · usage unavailable · 1 dependency")
  expect(taskDescription(task)).not.toContain("$0")
  expect(taskDescription({ ...task, status: "running", connection: "disconnected" })).toContain(
    "Disconnected (last known: running)",
  )
})

test("external reported cost never implies a known token count", () => {
  expect(taskDescription({ ...task, source: "external", measuredCost: 0.125, costKind: "priced" })).toContain(
    "$0.1250 reported · tokens unavailable",
  )
  expect(taskDescription({ ...task, source: "external", costKind: "plan" })).toContain("covered by plan")
})

test("bounded inspection includes ownership, dependencies, partial output and the result reference", () => {
  const text = taskProgress({
    task,
    steps: [{ tool: "read", text: "src/auth/permissions.ts", status: "completed" }],
    output: "Found an unchecked owner",
    truncated: true,
  })
  expect(text).toContain("Owns: src/auth")
  expect(text).toContain("Depends on: explore")
  expect(text).toContain("read (completed): src/auth/permissions.ts")
  expect(text).toContain("Found an unchecked owner")
  expect(text).toContain("Result reference: session:child")
})

test("unpriced steps cannot be presented as a complete zero-dollar bill", () => {
  expect(
    taskDescription({
      ...task,
      usage: {
        tokensOwnOnly: true,
        cost: 0,
        total: 100,
        toolUses: 1,
        steps: 1,
        unpricedSteps: 1,
        tokens: { input: 80, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    }),
  ).toContain("cost partly unknown")
})
test("Codium task summaries retain mixed own figures and mask legacy totals", () => {
  expect(taskDescription({ ...task, costKind: "codium", measuredCost: 0 })).toContain(" · Codium")
  expect(taskDescription({ ...task, billing: "codium", costKind: "unknown", measuredCost: 0.12 })).toContain(
    "$0.1200 reported + unpriced + Codium",
  )
  const usage = {
    cost: 0.12,
    total: 987654,
    toolUses: 1,
    steps: 2,
    unpricedSteps: 1,
    tokens: { input: 987654, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  expect(taskDescription({ ...task, costKind: "codium", usage })).not.toContain("987")
  expect(taskDescription({ ...task, billing: "codium", costKind: "unknown", usage })).toContain(
    "$0.1200 + unpriced + Codium",
  )
  expect(taskDescription({ ...task, billing: "codium", costKind: "unknown", usage: { ...usage, cost: 0 } })).toContain(
    "cost unknown + Codium",
  )
  expect(
    taskDescription({
      ...task,
      costKind: "codium",
      usage: { ...usage, tokensOwnOnly: true, total: 125, codiumSteps: 1 },
    }),
  ).toContain("125 tokens + Codium · $0.1200 + Codium")
})

test("unknown historical task tokens stay unavailable even when Codium evidence is gone", () => {
  const usage = {
    cost: 0.12,
    total: 987654,
    toolUses: 0,
    steps: 1,
    tokens: { input: 987654, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  for (const codiumSteps of [0, 1]) {
    const text = taskDescription({ ...task, usage: { ...usage, codiumSteps } })
    expect(text).not.toContain("987")
    expect(text).toContain("$0.1200")
  }
})

// 5.I.5: the new board fields, as `/tasks` prints them.
const now = 10 * 60_000

test("task summaries show model and effort, fork, queue reason, worktree, waiting, JSON results and workflows", () => {
  const line = taskDescription(
    {
      ...task,
      status: "queued",
      queuedReason: "Waiting for a free subagent slot",
      model: { providerID: "openai", modelID: "gpt-5" },
      effort: "high",
      fork: true,
      isolation: { mode: "worktree", state: "changed", branch: "vector/task-1", files: 3, additions: 12, deletions: 4 },
      result: { format: "json", valid: true },
      inbox: { unread: 2 },
    },
    now,
  )
  expect(line).toContain("gpt-5 · high effort · fork")
  expect(line).toContain("Waiting for a free subagent slot")
  expect(line).toContain("worktree vector/task-1 · changed · 3 files (+12 -4)")
  expect(line).toContain("JSON valid")
  expect(line).toContain("2 unread messages")
  expect(taskDescription({ ...task, effort: "default", result: { format: "json", valid: false } }, now)).not.toContain(
    "effort",
  )
  expect(taskDescription({ ...task, result: { format: "json", valid: false } }, now)).toContain(
    "JSON failed its schema",
  )
  expect(
    taskDescription(
      { ...task, waiting: { kind: "permission", since: now - 3 * 60_000, summary: "edit src/a.ts" } },
      now,
    ),
  ).toStartWith("Needs your permission · 3m")
  expect(taskDescription({ ...task, waiting: { kind: "question", since: now } }, now)).toStartWith(
    "Needs your answer · <1m",
  )
  const interrupted = { ...task, status: "stopped" as const, interrupted: { at: 1, cause: "shutdown" } }
  expect(taskDescription(interrupted, now)).toStartWith("Interrupted by a restart")
  expect(
    taskDescription({ ...interrupted, interrupted: { ...interrupted.interrupted, resumedAt: 2 } }, now),
  ).toStartWith("stopped")
  const run = {
    ...task,
    status: "running" as const,
    title: "workflow",
    workflow: { role: "run", runID: "run", title: "Audit", agents: { launched: 3, max: 12, running: 2 } },
  }
  expect(taskTitle(run)).toBe("Audit")
  expect(taskDescription(run, now)).toContain("3 of 12 agents · 2 running")
})

test("inspection shows messages with sender labels and the structured result as text", () => {
  const text = taskProgress(
    {
      task: { ...task, status: "completed" },
      steps: [],
      output: "done",
      truncated: false,
      messages: [
        { id: "m1", direction: "to_task", sender: "user", text: "Check the edge case", createdAt: 1 },
        { id: "m2", direction: "to_parent", sender: "task", text: "Found it", createdAt: 2 },
      ],
      structured: { json: '{\n  "ok": true\n}', valid: true, truncated: false },
    },
    now,
  )
  expect(text).toContain("Messages:\n  You: Check the edge case\n  This subagent: Found it")
  expect(text).toContain('Structured result (valid):\n{\n  "ok": true\n}')
})

test("model-written strings are sanitized before they reach the terminal", () => {
  const hostile = "evil\u001b]52;c;cGF5bG9hZA==\u0007title‮"
  const listed = {
    ...task,
    title: hostile,
    currentStep: hostile,
    isolation: { mode: "worktree", state: "changed", branch: hostile },
  }
  for (const text of [taskTitle(listed), taskDescription(listed, now)]) {
    expect(text).not.toContain("\u001b")
    expect(text).not.toContain("\u0007")
    expect(text).not.toContain("‮")
  }
  const progress = taskProgress(
    {
      task: listed,
      steps: [{ tool: hostile, text: hostile }],
      output: `line one\n${hostile}`,
      truncated: false,
      messages: [{ id: "m", direction: "to_parent", sender: "task", text: hostile, createdAt: 1 }],
      structured: { json: `{"a":"${hostile}"}`, valid: false, truncated: true },
    },
    now,
  )
  expect(progress).not.toContain("\u001b")
  expect(progress).not.toContain("\u0007")
  expect(progress).toContain("line one\n")
  expect(progress).toContain("Structured result (did not match its schema, bounded)")
  expect(taskCategory({ ...task, workflow: { role: "run", runID: "r", title: hostile } })).not.toContain("\u001b")
})

test("the limits line says unknown spend as unknown and never as $0", () => {
  const limits = { running: 5, queued: 2, maxRunning: 8, launched: 12, maxPerRequest: 32 }
  expect(limitsLine(limits)).toBe("5 of 8 running · 2 waiting · 12 of 32 started this request")
  expect(
    limitsLine({ ...limits, spend: { spentUsd: 3.1, limitUsd: 25, unknownSteps: 0, warned: false, stopped: false } }),
  ).toBe("5 of 8 running · 2 waiting · 12 of 32 started this request · $3.10 of $25.00 subagent spend")
  expect(
    limitsLine({
      ...limits,
      queued: 0,
      spend: { spentUsd: 0, limitUsd: 25, unknownSteps: 1, warned: false, stopped: false },
    }),
  ).toBe("5 of 8 running · 12 of 32 started this request · unknown of $25.00 subagent spend")
  expect(limitsLine({ ...limits, spend: { spentUsd: 2, unknownSteps: 3, warned: true, stopped: true } })).toContain(
    "$2.00 + unknown subagent spend (ceiling reached)",
  )
})

test("tasks a restart interrupted come first, and each workflow run leads its own agents", () => {
  const sub = (id: string, extra: Partial<Task.Info> = {}): Task.Info => ({
    ...task,
    id,
    sessionID: id,
    status: "running",
    controls: { inspect: true, message: true, stop: true },
    ...extra,
  })
  const tasks = [
    sub("plain"),
    sub("agent", { groupID: "workflow:run", workflow: { role: "agent", runID: "run", stage: "review" } }),
    sub("run", { workflow: { role: "run", runID: "run", title: "Audit" } }),
    sub("lost", {
      status: "stopped",
      interrupted: { at: 1, cause: "shutdown" },
      controls: { inspect: true, message: false, stop: false, resume: true },
    }),
  ]
  expect(orderedTasks(tasks).map((item) => [item.task.id, item.category])).toEqual([
    ["lost", "Interrupted by a restart"],
    ["plain", "Subagents"],
    ["run", "Workflow Audit"],
    ["agent", "Workflow Audit"],
  ])
  expect(interruptedTaskIDs(tasks)).toEqual(["lost"])
  expect(interruptedTaskIDs([{ ...tasks[3]!, controls: { ...tasks[3]!.controls, resume: false } }])).toEqual([])
  expect(
    stageLines({
      role: "run",
      runID: "run",
      stages: [
        { id: "s", title: "Review", phase: "main", total: 10, done: 3, failed: 1, skipped: 0, running: 2, waiting: 0 },
      ],
    }),
  ).toEqual(["Review  ████░░░░░░ 4 of 10 · 2 running · 1 failed"])
})

describe("backgroundStopRequests", () => {
  const sub = (id: string, extra: Partial<Task.Info> = {}): Task.Info => ({
    ...task,
    id,
    sessionID: id,
    status: "running",
    background: true,
    controls: { inspect: true, message: true, stop: true },
    ...extra,
  })

  test("stops only live background subagents, at most 200 IDs per request", () => {
    const many = Array.from({ length: 450 }, (_, index) => sub(`ses_${index}`))
    const requests = backgroundStopRequests({ sessionID: "parent", tasks: many, reason: "stop" })
    expect(requests.map((request) => request.taskIDs.length)).toEqual([200, 200, 50])
    expect(requests.every((request) => request.sessionID === "parent" && request.reason === "stop")).toBe(true)
    expect(requests.flatMap((request) => request.taskIDs)).toEqual(many.map((item) => item.id))
  })

  test("skips foreground work, desktop workspaces, finished tasks, workflow agents and unstoppable rows", () => {
    const requests = backgroundStopRequests({
      sessionID: "parent",
      tasks: [
        sub("bg"),
        sub("queued", { status: "queued" }),
        sub("fg", { background: false }),
        sub("workspace:one", { background: true }),
        sub("swarm:two"),
        sub("team", { source: "team" }),
        sub("done", { status: "completed" }),
        sub("agent", { workflow: { role: "agent", runID: "run" } }),
        sub("locked", { controls: { inspect: true, message: false, stop: false } }),
      ],
    })
    expect(requests).toEqual([{ sessionID: "parent", taskIDs: ["bg", "queued"] }])
  })

  test("an engine without Task.Info.background counts only sessions the transcript launched in the background", () => {
    const requests = backgroundStopRequests({
      sessionID: "parent",
      tasks: [sub("known", { background: undefined }), sub("unknown", { background: undefined })],
      background: new Set(["known"]),
    })
    expect(requests).toEqual([{ sessionID: "parent", taskIDs: ["known"] }])
    expect(backgroundStopRequests({ sessionID: "parent", tasks: [] })).toEqual([])
  })

  test("live helpers count background subagents and running commands, not foreground work or desktop tasks", () => {
    expect(
      liveHelpers({
        tasks: [
          sub("bg"),
          sub("legacy", { background: undefined }),
          sub("fg", { background: false }),
          sub("workspace:x"),
        ],
        shells: [{ status: "running" }, { status: "completed" }],
      }),
    ).toBe(3)
  })
})

test("toasts name how to stop helpers and say nothing resumes on its own", () => {
  expect(helpersLeftMessage(2, "ctrl+x k")).toBe("Stopped the main turn. 2 helpers still running · ctrl+x k stops them")
  expect(helpersLeftMessage(1, "")).toBe("Stopped the main turn. 1 helper still running · /stop-all stops them")
  expect(interruptedToast(2)).toBe(
    "2 subagents stopped when Vector restarted. Nothing resumes on its own · /tasks to resume",
  )
  expect(stoppedHelpersMessage({ stopped: 3, shells: 1, excluded: 1, failed: 0 })).toBe(
    "Stopped the main turn, 3 helpers and 1 background command. Partial work is kept. Agent workspaces keep running; stop them from the Agent Dashboard.",
  )
  expect(stoppedHelpersMessage({ stopped: 0, shells: 0, excluded: 0, failed: 1 })).toBe(
    "Stopped the main turn. Partial work is kept. 1 stop request failed.",
  )
})
