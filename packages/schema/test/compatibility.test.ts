import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { FileSystem } from "../src/filesystem"
import { Task } from "../src/task"
import { TaskBridge } from "../src/task-bridge"

describe("schema compatibility", () => {
  test("moved class schemas remain constructible", () => {
    const input = new FileSystem.FindInput({ query: "src" })
    expect(input).toBeInstanceOf(FileSystem.FindInput)
    expect(input.query).toBe("src")
  })
})

// A task as a 1.99.111 engine or desktop sends it: none of the multi-agent fields.
const legacy = {
  id: "ses_child",
  sessionID: "ses_child",
  parentSessionID: "ses_parent",
  source: "subagent",
  title: "Read the parser",
  agent: "explore",
  status: "running",
  startedAt: 1_700_000_000_000,
  elapsedMs: 1200,
  ownedPaths: ["src/parser.ts"],
  dependsOn: [],
  resultAvailable: false,
  attempt: 1,
  budgetScopes: [{ kind: "run", id: "ses_parent", budget: { usd: 10 }, spentUsd: 0.5, steps: 3, unpricedSteps: 0 }],
  controls: { inspect: true, message: true, stop: true },
}

// The same task with every field the multi-agent build adds.
const full = {
  ...legacy,
  controls: { inspect: true, message: true, stop: true, resume: false, background: true, merge: false, discard: false },
  model: { providerID: "anthropic", modelID: "claude-haiku", variant: "low" },
  effort: "low",
  background: true,
  fork: true,
  queuedReason: "Waiting for a free subagent slot",
  interrupted: { at: 1, cause: "shutdown", reported: true, resumedAt: 2, dismissedAt: 3 },
  waiting: { kind: "permission", since: 4, requestID: "per_1", expiresAt: 5, summary: "edit src/a.ts" },
  result: { format: "json", valid: true, attempts: 2 },
  isolation: {
    mode: "worktree",
    state: "changed",
    branch: "vector/task-1",
    directory: "/data/task-worktree/p/ses_child",
    files: 3,
    additions: 10,
    deletions: 2,
    merged: ["a.ts"],
    skipped: ["b.ts"],
    conflicts: ["c.ts"],
    error: "none",
  },
  workflow: {
    role: "run",
    runID: "ses_run",
    title: "Audit",
    stage: "scan",
    phase: "map",
    item: "src",
    round: 1,
    verified: true,
    stages: [
      { id: "scan", title: "Scan", phase: "map", total: 4, done: 1, failed: 0, skipped: 0, running: 2, waiting: 1 },
    ],
    agents: { launched: 3, max: 100, running: 2 },
    tokens: { used: 1000, max: 50_000 },
    stop: { reason: "limit", message: "Stopped at the run's step ceiling." },
  },
  inbox: { unread: 2 },
}

const limits = {
  running: 5,
  queued: 2,
  maxRunning: 8,
  launched: 12,
  maxPerRequest: 32,
  spend: { spentUsd: 3.1, limitUsd: 25, unknownSteps: 0, warned: false, stopped: false },
}
const shell = {
  id: "shl_1",
  title: "dev server",
  command: "bun dev",
  status: "running",
  startedAt: 6,
  outputPath: "/tmp/shell-shl_1.log",
  outputBytes: 120,
}

describe("Task schemas decode payloads from 1.99.111 and with every new field", () => {
  test("Task.Info", () => {
    const decode = Schema.decodeUnknownSync(Task.Info)
    expect(decode(legacy)).toEqual(legacy as never)
    expect(decode(full)).toEqual(full as never)
  })

  test("Task.ListResult", () => {
    const decode = Schema.decodeUnknownSync(Task.ListResult)
    expect(decode({ tasks: [legacy], truncated: false })).toEqual({ tasks: [legacy], truncated: false } as never)
    const next = { tasks: [legacy, full], truncated: true, limits, shells: [shell] }
    expect(decode(next)).toEqual(next as never)
  })

  test("Task.InspectResult", () => {
    const decode = Schema.decodeUnknownSync(Task.InspectResult)
    const old = {
      task: legacy,
      steps: [{ tool: "read", status: "completed", text: "read a.ts" }],
      output: "",
      truncated: false,
    }
    expect(decode(old)).toEqual(old as never)
    const next = {
      ...old,
      task: full,
      messages: [
        { id: "msg_1", direction: "to_task", sender: "user", text: "also check b.ts", createdAt: 7, deliveredAt: 8 },
      ],
      structured: { json: '{\n  "ok": true\n}', valid: true, truncated: false },
    }
    expect(decode(next)).toEqual(next as never)
  })

  test("nested enums are strings, so values a newer version adds still decode", () => {
    const future = {
      ...full,
      interrupted: { at: 1, cause: "power-loss" },
      waiting: { kind: "review", since: 4 },
      isolation: { mode: "sandbox", state: "archived" },
      workflow: { role: "supervisor", runID: "ses_run" },
      result: { format: "yaml" },
    }
    expect(Schema.decodeUnknownSync(Task.Info)(future)).toEqual(future as never)
    expect(Schema.decodeUnknownSync(TaskBridge.RegisterInput)({ tasks: [future] }).tasks[0]).toEqual(future as never)
  })

  test("budget scope kinds are unchanged, so a 1.99.111 reader keeps every scope", () => {
    expect(() => Schema.decodeUnknownSync(Task.BudgetScope)({ ...legacy.budgetScopes[0], kind: "delegated" })).toThrow()
  })

  test("a new Task.Info encodes without the fields it leaves out", () => {
    expect(Schema.encodeSync(Task.Info)({ ...legacy, model: undefined } as never)).toEqual(legacy as never)
  })
})
