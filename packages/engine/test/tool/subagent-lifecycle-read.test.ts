import { describe, expect, test } from "bun:test"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"

// Multi-agent contract 4.6: every field the build adds to the record is optional and checked on its own, so a
// malformed one is dropped without dropping the record or throwing.

const base = {
  kind: "subagent",
  agent: "general",
  custom: false,
  title: "Fix the parser",
  parentSessionID: "ses_parent",
  parentMessageID: "msg_launch",
  model: { providerID: "anthropic", modelID: "claude-sonnet" },
  background: true,
  status: "running",
  startedAt: 1_700_000_000_000,
}

const fields = {
  conversationID: "ses_root",
  rootSessionID: "ses_root",
  requestID: "msg_request",
  effort: "low",
  modelSource: "call",
  fork: { point: "msg_point", callID: "call_1", from: "ses_parent", warm: true },
  structured: {
    schema: { type: "object", properties: { ok: { type: "boolean" } } },
    schemaHash: "abc",
    attempts: 1,
    valid: true,
  },
  delegatedScope: {
    id: "delegated:ses_root:msg_request",
    budget: { usd: 25 },
    spentUsd: 3.1,
    steps: 12,
    unpricedSteps: 0,
    stopped: { reason: "cap" as const, message: "Subagent spend ceiling reached." },
  },
  owner: { pid: 4242, boot: 1_700_000_000 },
  interruption: { at: 5, cause: "shutdown", reportedAt: 6, resumedAt: 7, dismissedAt: 8 },
  waiting: { kind: "permission", requestID: "per_1", since: 9, expiresAt: 10, notedAt: 11, summary: "edit src/a.ts" },
  stop: { by: "user", at: 12 },
  reports: { at: [13, 14], wakes: 1 },
  slotReason: "Waiting for a free subagent slot",
  isolation: { mode: "worktree", state: "changed", branch: "vector/task-1", files: 2, additions: 4, deletions: 1 },
  workflow: { role: "run", title: "Audit", revision: 3, quiet: true, progress: { stages: [] } },
}

const read = (record: object) => SubagentLifecycle.read({ metadata: { subagent: record } })

describe("SubagentLifecycle.read", () => {
  test("a record from 1.99.111 still reads, with none of the new fields", () => {
    const record = read(base)
    expect(record?.title).toBe("Fix the parser")
    for (const key of Object.keys(fields)) expect(record?.[key as keyof typeof record]).toBeUndefined()
  })

  test("each new field parses", () => {
    const record = read({ ...base, ...fields })
    for (const [key, value] of Object.entries(fields))
      expect(record?.[key as keyof typeof record]).toEqual(value as never)
  })

  test("saved delegated scopes retain Codium counts without changing legacy scopes", () => {
    const saved = SubagentLifecycle.scopeFields([{ ...fields.delegatedScope, kind: "delegated", codiumSteps: 50 }])
    expect(saved.budgetScopes).toEqual([])
    expect(read({ ...base, ...saved })?.delegatedScope).toEqual({ ...fields.delegatedScope, codiumSteps: 50 })
    expect(read({ ...base, delegatedScope: fields.delegatedScope })?.delegatedScope).toEqual(fields.delegatedScope)
  })

  test("a workflow agent's record parses", () => {
    const workflow = {
      role: "agent",
      runID: "ses_run",
      stage: "scan",
      phase: "map",
      item: "src/a.ts",
      key: "scan:0",
      round: 2,
      verifier: false,
      final: true,
      verified: true,
      output: "structured",
    }
    expect(read({ ...base, workflow })?.workflow).toEqual(workflow as never)
  })

  test("malformed values drop without throwing and leave the rest of the record", () => {
    const malformed = {
      conversationID: 1,
      rootSessionID: null,
      requestID: { id: "msg" },
      effort: "maximum",
      modelSource: "guess",
      fork: { callID: "call_1" },
      structured: { schema: "not an object", schemaHash: "abc", attempts: 1 },
      delegatedScope: { id: "delegated:x", budget: { usd: 0 }, spentUsd: 1, steps: 1, unpricedSteps: 0 },
      owner: { pid: 1.5, boot: 1 },
      interruption: { cause: "shutdown" },
      waiting: { kind: "review", requestID: "per_1", since: 1 },
      stop: { by: "robot", at: 1 },
      reports: { at: ["yesterday"], wakes: 1 },
      slotReason: 42,
      isolation: { mode: "worktree" },
      workflow: { role: "run", title: "Audit" },
    }
    let record: ReturnType<typeof read>
    expect(() => (record = read({ ...base, ...malformed }))).not.toThrow()
    expect(record!.title).toBe(base.title)
    expect(record!.status).toBe("running")
    for (const key of Object.keys(malformed)) expect(record![key as keyof typeof record]).toBeUndefined()
  })

  test("non-finite numbers are malformed", () => {
    const record = read({
      ...base,
      delegatedScope: { ...fields.delegatedScope, spentUsd: Number.NaN },
      stop: { by: "user", at: Infinity },
    })
    expect(record?.delegatedScope).toBeUndefined()
    expect(record?.stop).toBeUndefined()
  })

  test("a structured schema over 16 KiB is dropped", () => {
    const schema = { type: "object", description: "x".repeat(16 * 1024) }
    expect(read({ ...base, structured: { schema, schemaHash: "abc", attempts: 0 } })?.structured).toBeUndefined()
  })

  test("only the last 12 report times are kept", () => {
    const at = Array.from({ length: 20 }, (_, index) => index)
    expect(read({ ...base, reports: { at, wakes: 2 } })?.reports).toEqual({ at: at.slice(-12), wakes: 2 })
  })

  test("an interruption cause a newer version added reads as unknown", () => {
    expect(read({ ...base, interruption: { at: 1, cause: "power-loss" } })?.interruption).toEqual({
      at: 1,
      cause: "unknown",
    })
  })

  test("budgetScopes with an unknown kind is ignored and does not erase delegatedScope", () => {
    const record = read({
      ...base,
      budgetScopes: [
        { kind: "run", id: "ses_root", budget: { usd: 10 }, spentUsd: 1, steps: 1, unpricedSteps: 0 },
        {
          kind: "delegated",
          id: "delegated:ses_root:msg",
          budget: { usd: 25 },
          spentUsd: 1,
          steps: 1,
          unpricedSteps: 0,
        },
      ],
      delegatedScope: fields.delegatedScope,
    })
    expect(record?.budgetScopes).toBeUndefined()
    expect(record?.delegatedScope).toEqual(fields.delegatedScope as never)
  })

  test("an isolation state a newer version added still reads", () => {
    expect(read({ ...base, isolation: { mode: "copy", state: "archived" } })?.isolation).toEqual({
      mode: "copy",
      state: "archived",
    })
  })

  test("a stored isolation directory does not survive, since guests can read the record (I19)", () => {
    const isolation = { ...fields.isolation, directory: "/Users/owner/.vector/worktrees/task-1" }
    expect(read({ ...base, isolation })?.isolation).toEqual(fields.isolation)
  })
})
