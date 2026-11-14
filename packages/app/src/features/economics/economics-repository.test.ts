import { beforeEach, describe, expect, test } from "bun:test"
import {
  clearOutcomes,
  isTerminalWorkspace,
  listOutcomes,
  outcomesFromWorkspaceRecord,
  recordOutcome,
  recordSessionOutcome,
  recordWorkspaceOutcome,
} from "./economics-repository"
import type { ModelOutcome } from "./economics-types"
import { measureUsage } from "./token-usage"
import { measureSessionEconomics, outcomeFromSession } from "./session-outcomes"
import { recommendModel } from "./economics-recommender"

// Minimal in-memory Storage fake, mirroring utils/persist.test.ts's approach —
// the desktop electron-store IPC (window.api.storeGet/Set) isn't present in
// this test environment, so recordOutcome/listOutcomes exercise the
// localStorage fallback path.
class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  failRead = false
  failWrite = false
  onRead?: () => void
  get length() {
    return this.values.size
  }
  clear() {
    this.values.clear()
    this.failRead = false
    this.failWrite = false
    this.onRead = undefined
  }
  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }
  getItem(key: string) {
    if (this.failRead) throw new Error("storage read failed")
    this.onRead?.()
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    if (this.failWrite) throw new Error("storage write failed")
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}

const storage = new MemoryStorage()

beforeEach(() => {
  storage.clear()
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true })
})

function makeOutcome(partial: Partial<ModelOutcome> & Pick<ModelOutcome, "id" | "projectId">): ModelOutcome {
  return {
    provider: "anthropic",
    model: "claude-sonnet-5",
    category: "general",
    createdAt: Date.now(),
    hadChecks: false,
    latencyMs: 100,
    latencyKind: "assistant-reply-sum",
    changedFiles: 1,
    ...partial,
  }
}

describe("economics-repository", () => {
  test("external-agent outcomes cannot enter rankings or exports, including retired stored labels", async () => {
    const projectId = "/repo/external-exclusion"
    const vector = makeOutcome({ id: "vector", projectId, runtime: "vector" })
    await recordOutcome(vector)
    const key = storage.key(0)!
    const own = [
      makeOutcome({ id: "chat", projectId, runtime: "claude-code" }),
      makeOutcome({ id: "retired", projectId, runtime: "vector", excludedFromLearning: true }),
      makeOutcome({ id: "legacy", projectId, provider: "Cursor Agent" }),
      makeOutcome({ id: "old-terminal", projectId, provider: "Antigravity CLI" }),
    ]
    // Stored rows from an older build must also be ignored before any consumer can read them.
    storage.setItem(key, JSON.stringify([vector, ...own]))
    expect(await listOutcomes(projectId)).toEqual([vector])
    for (const outcome of own) await recordOutcome(outcome)
    expect(JSON.parse(storage.getItem(key)!)).toEqual([vector])
    await recordWorkspaceOutcome(own[0]!, { workspaceRevision: 1 })
    await recordSessionOutcome({ sessionID: "external", projectId, updatedAt: 1, outcome: own[1] })
    expect(await listOutcomes(projectId)).toEqual([vector])
  })

  test("external workspaces cannot be converted into model-learning samples", () => {
    const record = {
      id: "external",
      runtime: "codex",
      provider: "Codex",
      model: "Runtime default",
      sourcePath: "/repo/external-exclusion",
      createdAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:01Z",
      changedFilesCount: 1,
    }
    expect(outcomesFromWorkspaceRecord(record, "general")).toBeUndefined()
    expect(
      outcomesFromWorkspaceRecord({ ...record, runtime: "vector", excludedFromLearning: true }, "general"),
    ).toBeUndefined()
    expect(outcomesFromWorkspaceRecord({ ...record, runtime: "vector" }, "general")).toBeDefined()
  })

  test("ordinary and parallel history share complete reply timing through storage and recommendation", async () => {
    const projectId = "/repo/reply-time"
    const messages = (modelID: string, completed?: number) => [
      {
        role: "assistant",
        providerID: "p",
        modelID,
        variant: "low",
        tokens: { input: 100 },
        cost: 0.1,
        error: { name: "APIError" },
        time: { created: 1, completed },
      },
      {
        role: "assistant",
        providerID: "p",
        modelID,
        variant: "low",
        tokens: { input: 100 },
        cost: 0.1,
        finish: "stop",
        time: { created: 1000, completed: modelID === "ordinary" ? 1001 : 1010 },
      },
    ]
    const saveOrdinary = async (sessionID: string, updatedAt: number, completed?: number) => {
      await recordSessionOutcome({
        sessionID,
        projectId,
        updatedAt,
        outcome: outcomeFromSession({
          sessionID,
          projectId,
          messages: messages("ordinary", completed).map((info) => ({ info })),
          parts: {},
          spend: { cost: 0.2 },
        }),
      })
    }
    for (const id of ["one", "two", "three"]) {
      await saveOrdinary(id, 100)
      const evidence = await measureSessionEconomics({
        session: async () => ({ cost: 0.2, time: { updated: 100 } }),
        messages: async () => messages("parallel", 11),
      })
      await recordOutcome(
        outcomesFromWorkspaceRecord(
          {
            id: `workspace:${id}`,
            provider: "p",
            model: "parallel",
            sourcePath: projectId,
            createdAt: "2026-01-01T00:00:00Z",
            lastActivityAt: "2026-02-01T00:00:00Z",
            changedFilesCount: 1,
            status: "complete",
          },
          "general",
          evidence.measured,
          evidence.spend,
          evidence.timing,
        )!,
        evidence.updatedAt,
      )
    }
    const partial = await listOutcomes(projectId)
    expect(partial).toHaveLength(6)
    expect(partial.find((row) => row.id === "session:one")).toMatchObject({
      execution: "completed",
      costUsd: 0.2,
      usage: { input: 200 },
    })
    expect(partial.find((row) => row.id === "session:one")?.latencyMs).toBeUndefined()
    expect(partial.find((row) => row.id === "workspace:one")).toMatchObject({
      latencyMs: 20,
      latencyKind: "assistant-reply-sum",
    })
    expect(recommendModel(partial, "general")).toBeUndefined()

    for (const id of ["one", "two", "three"]) await saveOrdinary(id, 200, 2)
    await saveOrdinary("one", 100)
    const complete = await listOutcomes(projectId)
    expect(complete).toHaveLength(6)
    expect(complete.find((row) => row.id === "session:one")).toMatchObject({
      latencyMs: 2,
      latencyKind: "assistant-reply-sum",
      costUsd: 0.2,
      usage: { input: 200 },
    })
    expect(recommendModel(complete, "general")).toMatchObject({
      model: "ordinary",
      sampleSize: 3,
      medianLatencyMs: 2,
      timedSamples: 3,
      unknownLatencySamples: 0,
    })
  })

  test("parallel evidence rejects history collected across a revision or spend change", async () => {
    for (const change of [
      { time: { updated: 2 } },
      { cost: 0.2 },
      { unpricedSteps: 1 },
      { subagentCost: 0.2 },
      { subagentUnpricedSteps: 1 },
    ]) {
      const order: string[] = []
      const evidence = await measureSessionEconomics({
        session: async () => {
          order.push("session")
          return { cost: 0.1, time: { updated: 1 }, ...(order.length === 3 ? change : {}) }
        },
        messages: async () => {
          order.push("messages")
          return [{ role: "assistant", time: { created: 1, completed: 2 } }]
        },
      }).catch(() => undefined)
      expect(order).toEqual(["session", "messages", "session"])
      expect(evidence).toBeUndefined()
      const outcome = outcomesFromWorkspaceRecord(
        {
          id: "raced",
          sourcePath: "/repo/raced",
          provider: "p",
          model: "m",
          createdAt: "2026-01-01T00:00:00Z",
          lastActivityAt: "2026-01-01T00:01:00Z",
          changedFilesCount: 0,
          status: "complete",
        },
        "general",
        evidence?.measured,
        evidence?.spend,
        evidence?.timing,
      )!
      expect(outcome.latencyMs).toBeUndefined()
      expect(outcome.latencyKind).toBeUndefined()
      expect(outcome.costUsd).toBeUndefined()
      expect(outcome.variant).toBeUndefined()
    }
  })

  test("missing metadata or history cannot certify parallel reply timing", async () => {
    await expect(
      measureSessionEconomics({
        session: async () => undefined,
        messages: async () => [],
      }),
    ).rejects.toThrow("Session metadata is unavailable")
    await expect(
      measureSessionEconomics({
        session: async () => ({ time: { updated: 1 } }),
        messages: async () => undefined,
      }),
    ).rejects.toThrow("Session history is unavailable")
  })

  test("cross-model attempts replace stale actionable evidence and retain cumulative history", async () => {
    const projectId = "/repo/mixed-attempts"
    const message = (modelID: string, measured = true) => ({
      info: {
        role: "assistant",
        providerID: "p",
        modelID,
        variant: "low",
        tokens: measured ? { input: 100 } : undefined,
        cost: measured ? 0.1 : 0,
        finish: "stop",
        time: { created: 1, completed: 2 },
        ...(measured ? {} : { error: { name: "APIError" } }),
      },
    })
    const save = async (sessionID: string, messages: ReturnType<typeof message>[], updatedAt: number) => {
      const outcome = outcomeFromSession({
        sessionID,
        projectId,
        messages,
        parts: {},
        spend: { cost: messages.reduce((sum, entry) => sum + entry.info.cost, 0) },
      })
      await recordSessionOutcome({ sessionID, projectId, updatedAt, outcome })
    }
    for (const sessionID of ["one", "two", "three"]) await save(sessionID, [message("A")], 10)
    expect(recommendModel(await listOutcomes(projectId), "general")?.model).toBe("A")
    await save("three", [message("A"), message("B", false)], 20)
    await save("three", [message("A")], 10)
    const rows = await listOutcomes(projectId)
    expect(rows).toHaveLength(3)
    const mixed = rows.find((row) => row.id === "session:three")
    expect(mixed).toMatchObject({ mixedModels: true, execution: "failed", latencyMs: 2, usage: { input: 100 } })
    expect(mixed?.model).toBeUndefined()
    // The failed attempt reported nothing, so the known spend is kept but never ranked as what the run cost.
    expect(mixed).toMatchObject({ costUsd: 0.1, costPriced: false })
    expect(recommendModel(rows, "general")).toBeUndefined()

    await save("earlier-failure", [message("A", false), message("B")], 20)
    const recovered = (await listOutcomes(projectId)).find((row) => row.id === "session:earlier-failure")
    expect(recovered).toMatchObject({ mixedModels: true, execution: "completed", latencyMs: 2, usage: { input: 100 } })
    expect(recovered?.model).toBeUndefined()
    expect(recovered).toMatchObject({ costUsd: 0.1, costPriced: false })
    expect(recommendModel(await listOutcomes(projectId), "general")).toBeUndefined()
  })

  test("a cumulative preset switch replaces one sample, retaining spend without pooling effort evidence", async () => {
    const projectId = "/repo/variant-history"
    const message = (variant: string | undefined, cost: number) => ({
      info: {
        role: "assistant",
        providerID: "p",
        modelID: "m",
        variant,
        cost,
        tokens: { input: 100 },
        time: { created: 1, completed: 2 },
        finish: "stop",
      },
    })
    const save = async (sessionID: string, messages: ReturnType<typeof message>[], updatedAt: number) => {
      const outcome = outcomeFromSession({
        sessionID,
        projectId,
        messages,
        parts: {},
        spend: { cost: messages.reduce((sum, entry) => sum + entry.info.cost, 0) },
      })
      await recordSessionOutcome({ sessionID, projectId, updatedAt, outcome })
    }
    for (const session of ["a", "b", "c"]) await save(session, [message("low", 0.1)], 10)
    expect(recommendModel(await listOutcomes(projectId), "general")).toMatchObject({ variant: "low", sampleSize: 3 })
    await save("c", [message("low", 0.1), message("max", 0.3)], 20)
    const mixed = await listOutcomes(projectId)
    expect(mixed).toHaveLength(3)
    expect(mixed.find((row) => row.id === "session:c")).toMatchObject({ variant: { kind: "mixed" }, costUsd: 0.4 })
    expect(recommendModel(mixed, "general")).toBeUndefined()
    await save("c", [message("low", 0.1)], 10)
    expect((await listOutcomes(projectId)).find((row) => row.id === "session:c")?.variant).toEqual({ kind: "mixed" })
    await save("legacy", [message(undefined, 1)], 10)
    expect((await listOutcomes(projectId)).find((row) => row.id === "session:legacy")?.variant).toBeUndefined()
    expect(recommendModel(await listOutcomes(projectId), "general")).toBeUndefined()
  })

  test("paid session failures stay recorded and successful recovery restores eligibility without duplicate samples", async () => {
    const projectId = "/repo/execution-recovery"
    const message = (id: string, cost: number, failed = false) => ({
      info: {
        id,
        role: "assistant",
        providerID: "p",
        modelID: "m",
        variant: "low",
        cost,
        tokens: { input: 100, output: 10 },
        time: { created: 1, completed: 2 },
        finish: "stop",
        ...(failed ? { error: { name: "APIError" } } : {}),
      },
    })
    const save = async (sessionID: string, messages: ReturnType<typeof message>[], updatedAt: number) => {
      const outcome = outcomeFromSession({
        sessionID,
        projectId,
        messages,
        parts: {},
        spend: { cost: messages.reduce((sum, message) => sum + message.info.cost, 0) },
      })
      expect(outcome).toBeDefined()
      await recordSessionOutcome({ sessionID, projectId, updatedAt, outcome })
    }
    await save("first", [message("first", 1)], 10)
    await save("second", [message("second", 1)], 10)
    await save("recovering", [message("failed", 0.1, true)], 10)
    const failed = await listOutcomes(projectId)
    expect(failed).toHaveLength(3)
    expect(failed.find((outcome) => outcome.id === "session:recovering")).toMatchObject({
      execution: "failed",
      costUsd: 0.1,
      hadChecks: false,
    })
    expect(recommendModel(failed, "general")).toBeUndefined()
    await save("recovering", [message("failed", 0.1, true), message("recovered", 0.2)], 20)
    const recovered = await listOutcomes(projectId)
    expect(recovered).toHaveLength(3)
    expect(recovered.find((outcome) => outcome.id === "session:recovering")?.costUsd).toBeCloseTo(0.3)
    expect(recommendModel(recovered, "general")).toMatchObject({ model: "m", completedSamples: 3, sampleSize: 3 })
    await save(
      "recovering",
      [message("failed", 0.1, true), message("recovered", 0.2), message("late-failure", 0.05, true)],
      30,
    )
    // Neither stale nor same-revision successful evidence can hide the later failure.
    await save("recovering", [message("recovered", 0.2)], 20)
    await save("recovering", [message("recovered", 0.2)], 30)
    const later = await listOutcomes(projectId)
    expect(later).toHaveLength(3)
    expect(later.find((outcome) => outcome.id === "session:recovering")?.costUsd).toBeCloseTo(0.35)
    expect(recommendModel(later, "general")).toBeUndefined()
  })

  test("records and lists outcomes for a project", async () => {
    await recordOutcome(makeOutcome({ id: "o1", projectId: "/repo/a", model: "claude-sonnet-5" }))
    const outcomes = await listOutcomes("/repo/a")
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]?.model).toBe("claude-sonnet-5")
  })

  test("outcomes recorded at the same time are all kept", async () => {
    await Promise.all(["w1", "w2", "w3"].map((id) => recordOutcome(makeOutcome({ id, projectId: "/repo/concurrent" }))))
    expect((await listOutcomes("/repo/concurrent")).map((outcome) => outcome.id).sort()).toEqual(["w1", "w2", "w3"])
  })

  test("keeps separate projects isolated", async () => {
    await recordOutcome(makeOutcome({ id: "a1", projectId: "/repo/a" }))
    await recordOutcome(makeOutcome({ id: "b1", projectId: "/repo/b" }))
    expect(await listOutcomes("/repo/a")).toHaveLength(1)
    expect(await listOutcomes("/repo/b")).toHaveLength(1)
    expect((await listOutcomes("/repo/a"))[0]?.id).toBe("a1")
  })

  test("clearing a project forgets its outcomes, one session's or all of them, and leaves other projects", async () => {
    await recordSessionOutcome({
      sessionID: "kept",
      projectId: "/repo/clear",
      updatedAt: 10,
      outcome: makeOutcome({ id: "session:kept", projectId: "/repo/clear" }),
    })
    await recordSessionOutcome({
      sessionID: "erased",
      projectId: "/repo/clear",
      updatedAt: 10,
      outcome: makeOutcome({ id: "session:erased", projectId: "/repo/clear" }),
    })
    await recordWorkspaceOutcome(makeOutcome({ id: "workspace", projectId: "/repo/clear" }), {
      workspaceRevision: 1,
      sessionID: "erased",
    })
    await recordOutcome(makeOutcome({ id: "other", projectId: "/repo/other" }))
    await clearOutcomes("/repo/clear", { sessionID: "erased" })
    expect((await listOutcomes("/repo/clear")).map((outcome) => outcome.id)).toEqual(["session:kept"])
    await clearOutcomes("/repo/clear")
    expect(await listOutcomes("/repo/clear")).toEqual([])
    expect((await listOutcomes("/repo/other")).map((outcome) => outcome.id)).toEqual(["other"])
  })

  test("later session turns replace one cumulative sample without duplicating it", async () => {
    const outcome = makeOutcome({ id: "session:continued", projectId: "/repo/session-update", costUsd: 0.1 })
    await recordSessionOutcome({ sessionID: "continued", projectId: outcome.projectId, updatedAt: 10, outcome })
    await recordSessionOutcome({
      sessionID: "continued",
      projectId: outcome.projectId,
      updatedAt: 20,
      outcome: { ...outcome, costUsd: 0.4, latencyMs: 350 },
    })
    expect(await listOutcomes(outcome.projectId)).toMatchObject([{ costUsd: 0.4, latencyMs: 350 }])
    expect(await listOutcomes(outcome.projectId)).toHaveLength(1)
  })

  test("stale and repeated snapshots cannot regress a session sample", async () => {
    const outcome = makeOutcome({ id: "session:ordered", projectId: "/repo/session-order", costUsd: 0.4 })
    await Promise.all([
      recordSessionOutcome({ sessionID: "ordered", projectId: outcome.projectId, updatedAt: 20, outcome }),
      recordSessionOutcome({
        sessionID: "ordered",
        projectId: outcome.projectId,
        updatedAt: 10,
        outcome: { ...outcome, costUsd: 0.1 },
      }),
      recordSessionOutcome({
        sessionID: "ordered",
        projectId: outcome.projectId,
        updatedAt: 20,
        outcome: { ...outcome, costUsd: 0.2 },
      }),
    ])
    expect(await listOutcomes(outcome.projectId)).toMatchObject([{ costUsd: 0.4 }])
    expect(await listOutcomes(outcome.projectId)).toHaveLength(1)
  })

  test("descendant spend replaces one unchanged parent transcript sample and unknown cost rejects stale conflicts", async () => {
    const outcome = makeOutcome({
      id: "session:family",
      projectId: "/repo/family-spend",
      costUsd: 0.1,
      costPriced: true,
      usage: { input: 100, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    })
    await recordSessionOutcome({ sessionID: "family", projectId: outcome.projectId, updatedAt: 100, outcome })
    await recordSessionOutcome({
      sessionID: "family",
      projectId: outcome.projectId,
      updatedAt: 101,
      outcome: { ...outcome, costUsd: 0.4 },
    })
    expect(await listOutcomes(outcome.projectId)).toMatchObject([
      { model: outcome.model, usage: outcome.usage, latencyMs: outcome.latencyMs, costUsd: 0.4 },
    ])
    await recordSessionOutcome({
      sessionID: "family",
      projectId: outcome.projectId,
      updatedAt: 102,
      outcome: { ...outcome, costUsd: undefined, costPriced: undefined },
    })
    for (const updatedAt of [101, 102])
      await recordSessionOutcome({ sessionID: "family", projectId: outcome.projectId, updatedAt, outcome })
    const recorded = await listOutcomes(outcome.projectId)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.costUsd).toBeUndefined()
    expect(recorded[0]?.costPriced).toBeUndefined()
    expect(recorded[0]?.usage).toEqual(outcome.usage)
    expect(recorded[0]?.latencyMs).toBe(outcome.latencyMs)
  })

  test("mixed-model evidence removes the earlier sample and rejects a stale resurrection", async () => {
    const outcome = makeOutcome({ id: "session:mixed", projectId: "/repo/session-mixed" })
    await recordSessionOutcome({ sessionID: "mixed", projectId: outcome.projectId, updatedAt: 10, outcome })
    await recordSessionOutcome({ sessionID: "mixed", projectId: outcome.projectId, updatedAt: 20 })
    await recordSessionOutcome({ sessionID: "mixed", projectId: outcome.projectId, updatedAt: 15, outcome })
    expect(await listOutcomes(outcome.projectId)).toEqual([])
  })

  test("workspace outcomes retain append-only idempotence", async () => {
    const outcome = makeOutcome({ id: "workspace", projectId: "/repo/workspace-dedupe", costUsd: 0.1 })
    await recordOutcome(outcome)
    await recordOutcome({ ...outcome, costUsd: 0.4 })
    expect(await listOutcomes(outcome.projectId)).toMatchObject([{ costUsd: 0.1 }])
    expect(await listOutcomes(outcome.projectId)).toHaveLength(1)
  })

  test("newer workspace spend replaces a sample after late title usage, older snapshots do not", async () => {
    const outcome = makeOutcome({ id: "workspace-late", projectId: "/repo/workspace-late", costUsd: 0.1 })
    await recordOutcome(outcome, 10)
    await recordOutcome({ ...outcome, costUsd: 0.15 }, 12)
    await recordOutcome({ ...outcome, costUsd: 0.11 }, 11)
    expect(await listOutcomes(outcome.projectId)).toMatchObject([{ costUsd: 0.15 }])
    expect(await listOutcomes(outcome.projectId)).toHaveLength(1)
  })

  test("a failed write can retry the same session revision", async () => {
    const outcome = makeOutcome({ id: "session:write-retry", projectId: "/repo/write-retry", costUsd: 0.1 })
    await recordSessionOutcome({ sessionID: "write-retry", projectId: outcome.projectId, updatedAt: 10, outcome })
    const update = {
      sessionID: "write-retry",
      projectId: outcome.projectId,
      updatedAt: 20,
      outcome: { ...outcome, costUsd: 0.4 },
    }
    storage.failWrite = true
    await expect(recordSessionOutcome(update)).rejects.toThrow("storage write failed")
    storage.failWrite = false
    expect(await listOutcomes(outcome.projectId)).toMatchObject([{ costUsd: 0.1 }])
    await recordSessionOutcome(update)
    expect(await listOutcomes(outcome.projectId)).toMatchObject([{ costUsd: 0.4 }])
  })

  test("a failed removal does not commit its mixed-model tombstone", async () => {
    const outcome = makeOutcome({ id: "session:delete-retry", projectId: "/repo/delete-retry" })
    await recordSessionOutcome({ sessionID: "delete-retry", projectId: outcome.projectId, updatedAt: 10, outcome })
    const remove = { sessionID: "delete-retry", projectId: outcome.projectId, updatedAt: 20 }
    storage.failWrite = true
    await expect(recordSessionOutcome(remove)).rejects.toThrow("storage write failed")
    storage.failWrite = false
    expect(await listOutcomes(outcome.projectId)).toHaveLength(1)
    await recordSessionOutcome(remove)
    expect(await listOutcomes(outcome.projectId)).toEqual([])
  })

  test("a failed read never overwrites another sample with an incomplete list", async () => {
    const existing = makeOutcome({ id: "workspace", projectId: "/repo/read-retry" })
    await recordOutcome(existing)
    const update = {
      sessionID: "read-retry",
      projectId: existing.projectId,
      updatedAt: 20,
      outcome: { ...existing, id: "session:read-retry" },
    }
    storage.failRead = true
    await expect(recordSessionOutcome(update)).rejects.toThrow("storage read failed")
    storage.failRead = false
    await recordSessionOutcome(update)
    expect((await listOutcomes(existing.projectId)).map((outcome) => outcome.id)).toEqual([
      "workspace",
      "session:read-retry",
    ])
  })

  test("caps stored outcomes at 500 per project, keeping the most recent", async () => {
    for (let i = 0; i < 510; i++) {
      await recordOutcome(makeOutcome({ id: `o${i}`, projectId: "/repo/c" }))
    }
    const outcomes = await listOutcomes("/repo/c")
    expect(outcomes).toHaveLength(500)
    expect(outcomes[0]?.id).toBe("o10")
    expect(outcomes[outcomes.length - 1]?.id).toBe("o509")
  })

  test("maps a completed workspace record into an outcome", () => {
    const result = outcomesFromWorkspaceRecord(
      {
        id: "ws-1",
        provider: "anthropic",
        model: "claude-sonnet-5",
        sourcePath: "/repo/a",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: "2026-01-01T00:05:00.000Z",
        changedFilesCount: 4,
        validationReport: { hadChecks: true, passed: true },
        status: "complete",
      },
      "backend",
    )
    expect(result?.latencyMs).toBeUndefined()
    expect(result?.latencyKind).toBeUndefined()
    expect(result?.hadChecks).toBe(true)
    expect(result?.checksPassed).toBe(true)
    expect(result?.execution).toBe("completed")
    expect(result?.category).toBe("backend")
    expect(result?.projectId).toBe("/repo/a")
    expect(result?.provider).toBe("anthropic")
    expect(result?.model).toBe("claude-sonnet-5")
    expect(result?.costUsd).toBeUndefined()
    expect(result?.costPriced).toBeUndefined()
  })

  test("workspace age, including unparsable timestamps, is never reply-time evidence", () => {
    const result = outcomesFromWorkspaceRecord(
      {
        id: "ws-2",
        provider: "anthropic",
        model: "claude-sonnet-5",
        sourcePath: "/repo/a",
        createdAt: "not-a-date",
        lastActivityAt: "also-not-a-date",
        changedFilesCount: 0,
      },
      "general",
    )
    expect(result?.latencyMs).toBeUndefined()
    expect(result?.hadChecks).toBe(false)
    expect(result?.checksPassed).toBeUndefined()
  })
})

describe("workspace outcome versions", () => {
  test("validation can change without a newer session snapshot", async () => {
    const outcome = makeOutcome({
      id: "workspace-validation",
      projectId: "/repo/workspace-validation",
      hadChecks: true,
      checksPassed: true,
      costUsd: 1,
    })
    expect(await recordWorkspaceOutcome(outcome, { workspaceRevision: 1, sessionID: "s", sessionUpdatedAt: 10 })).toBe(
      "written",
    )
    expect(
      await recordWorkspaceOutcome(
        { ...outcome, checksPassed: false },
        { workspaceRevision: 2, sessionID: "s", sessionUpdatedAt: 10 },
      ),
    ).toBe("written")
    expect(await listOutcomes(outcome.projectId)).toMatchObject([
      {
        checksPassed: false,
        costUsd: 1,
        workspaceVersion: { workspaceRevision: 2, sessionID: "s", sessionUpdatedAt: 10 },
      },
    ])
  })

  test("late spend can change without a newer workspace revision", async () => {
    const outcome = makeOutcome({
      id: "workspace-spend",
      projectId: "/repo/workspace-spend",
      hadChecks: true,
      checksPassed: false,
      costUsd: 1,
    })
    await recordWorkspaceOutcome(outcome, { workspaceRevision: 2, sessionID: "s", sessionUpdatedAt: 10 })
    expect(
      await recordWorkspaceOutcome(
        { ...outcome, costUsd: 2 },
        { workspaceRevision: 2, sessionID: "s", sessionUpdatedAt: 11 },
      ),
    ).toBe("written")
    expect(await listOutcomes(outcome.projectId)).toMatchObject([{ checksPassed: false, costUsd: 2 }])
  })

  test.each([
    { workspaceRevision: 1, sessionID: "s", sessionUpdatedAt: 12 },
    { workspaceRevision: 3, sessionID: "s", sessionUpdatedAt: 10 },
    { workspaceRevision: 3, sessionID: "s" },
  ])("neither freshness axis may regress: %j", async (revision) => {
    const outcome = makeOutcome({
      id: "workspace-ordered",
      projectId: "/repo/workspace-ordered",
      checksPassed: false,
      costUsd: 2,
    })
    await recordWorkspaceOutcome(outcome, { workspaceRevision: 2, sessionID: "s", sessionUpdatedAt: 11 })
    expect(await recordWorkspaceOutcome({ ...outcome, checksPassed: true, costUsd: 1 }, revision)).toBe("stale")
    expect(await listOutcomes(outcome.projectId)).toMatchObject([
      { checksPassed: false, costUsd: 2, workspaceVersion: { workspaceRevision: 2, sessionUpdatedAt: 11 } },
    ])
  })

  test("equal revision pairs are idempotent and cannot overwrite conflicting evidence", async () => {
    const outcome = makeOutcome({ id: "workspace-equal", projectId: "/repo/workspace-equal", costUsd: 1 })
    const revision = { workspaceRevision: 2, sessionID: "s", sessionUpdatedAt: 11 }
    await recordWorkspaceOutcome(outcome, revision)
    expect(await recordWorkspaceOutcome(outcome, revision)).toBe("unchanged")
    expect(await recordWorkspaceOutcome({ ...outcome, costUsd: 0 }, revision)).toBe("unchanged")
    expect(await listOutcomes(outcome.projectId)).toMatchObject([{ costUsd: 1 }])
    expect(await listOutcomes(outcome.projectId)).toHaveLength(1)
  })

  test("failed persistence permits an exact workspace version retry", async () => {
    const outcome = makeOutcome({ id: "workspace-retry", projectId: "/repo/workspace-retry", costUsd: 1 })
    await recordWorkspaceOutcome(outcome, { workspaceRevision: 1, sessionID: "s", sessionUpdatedAt: 10 })
    const revision = { workspaceRevision: 2, sessionID: "s", sessionUpdatedAt: 11 }
    storage.failWrite = true
    await expect(recordWorkspaceOutcome({ ...outcome, costUsd: 2 }, revision)).rejects.toThrow("storage write failed")
    storage.failWrite = false
    expect(await listOutcomes(outcome.projectId)).toMatchObject([
      { costUsd: 1, workspaceVersion: { workspaceRevision: 1 } },
    ])
    expect(await recordWorkspaceOutcome({ ...outcome, costUsd: 2 }, revision)).toBe("written")
    expect(await listOutcomes(outcome.projectId)).toMatchObject([{ costUsd: 2, workspaceVersion: revision }])
  })

  test("a capture invalidated while queued cannot overwrite the preceding snapshot", async () => {
    const outcome = makeOutcome({ id: "workspace-queued", projectId: "/repo/workspace-queued", costUsd: 1 })
    const state = { current: true }
    const first = recordWorkspaceOutcome(outcome, { workspaceRevision: 1, sessionID: "s", sessionUpdatedAt: 10 })
    const queued = recordWorkspaceOutcome(
      { ...outcome, costUsd: 2 },
      { workspaceRevision: 2, sessionID: "s", sessionUpdatedAt: 11 },
      () => state.current,
    )
    state.current = false
    expect(await first).toBe("written")
    expect(await queued).toBe("stale")
    expect(await listOutcomes(outcome.projectId)).toMatchObject([
      { costUsd: 1, workspaceVersion: { workspaceRevision: 1 } },
    ])
  })

  test("a capture invalidated during the storage read stays retryable without writing", async () => {
    const outcome = makeOutcome({ id: "workspace-reading", projectId: "/repo/workspace-reading", costUsd: 1 })
    await recordWorkspaceOutcome(outcome, { workspaceRevision: 1, sessionID: "s", sessionUpdatedAt: 10 })
    const state = { current: true }
    const revision = { workspaceRevision: 2, sessionID: "s", sessionUpdatedAt: 11 }
    storage.onRead = () => {
      state.current = false
    }
    expect(await recordWorkspaceOutcome({ ...outcome, costUsd: 2 }, revision, () => state.current)).toBe("stale")
    storage.onRead = undefined
    expect(await listOutcomes(outcome.projectId)).toMatchObject([
      { costUsd: 1, workspaceVersion: { workspaceRevision: 1 } },
    ])
    state.current = true
    expect(await recordWorkspaceOutcome({ ...outcome, costUsd: 2 }, revision, () => state.current)).toBe("written")
  })

  test("a newer workspace revision admits a new session without comparing unrelated session clocks", async () => {
    const outcome = makeOutcome({ id: "workspace-rerun", projectId: "/repo/workspace-rerun", costUsd: 2 })
    await recordWorkspaceOutcome(outcome, { workspaceRevision: 2, sessionID: "old", sessionUpdatedAt: 100 })
    expect(
      await recordWorkspaceOutcome(
        { ...outcome, costUsd: 1 },
        { workspaceRevision: 2, sessionID: "new", sessionUpdatedAt: 1 },
      ),
    ).toBe("stale")
    expect(
      await recordWorkspaceOutcome(
        { ...outcome, costUsd: 1 },
        { workspaceRevision: 3, sessionID: "new", sessionUpdatedAt: 1 },
      ),
    ).toBe("written")
    expect(
      await recordWorkspaceOutcome(outcome, { workspaceRevision: 2, sessionID: "old", sessionUpdatedAt: 101 }),
    ).toBe("stale")
    expect(await listOutcomes(outcome.projectId)).toMatchObject([
      { costUsd: 1, workspaceVersion: { workspaceRevision: 3, sessionID: "new", sessionUpdatedAt: 1 } },
    ])
  })

  test("legacy writes cannot overwrite versioned workspace evidence", async () => {
    const outcome = makeOutcome({ id: "workspace-versioned", projectId: "/repo/workspace-versioned", costUsd: 1 })
    await recordWorkspaceOutcome(outcome, { workspaceRevision: 1, sessionID: "s", sessionUpdatedAt: 10 })
    await recordOutcome({ ...outcome, costUsd: 0 })
    await recordOutcome({ ...outcome, costUsd: 0 }, 100)
    expect(await listOutcomes(outcome.projectId)).toMatchObject([
      { costUsd: 1, workspaceVersion: { workspaceRevision: 1 } },
    ])
  })

  test("legacy rows start at workspace revision zero without losing their session freshness guard", async () => {
    const outcome = makeOutcome({ id: "workspace-upgrade", projectId: "/repo/workspace-upgrade", costUsd: 1 })
    await recordOutcome(outcome, 10)
    expect(
      await recordWorkspaceOutcome(
        { ...outcome, costUsd: 0 },
        { workspaceRevision: 0, sessionID: "s", sessionUpdatedAt: 10 },
      ),
    ).toBe("unchanged")
    expect(
      await recordWorkspaceOutcome(
        { ...outcome, costUsd: 0 },
        { workspaceRevision: 1, sessionID: "s", sessionUpdatedAt: 9 },
      ),
    ).toBe("stale")
    expect(
      await recordWorkspaceOutcome(
        { ...outcome, costUsd: 2 },
        { workspaceRevision: 1, sessionID: "s", sessionUpdatedAt: 10 },
      ),
    ).toBe("written")
    expect(await listOutcomes(outcome.projectId)).toMatchObject([
      { costUsd: 2, workspaceVersion: { workspaceRevision: 1 } },
    ])
  })

  test("a newer complete snapshot can clear formerly measured fields", async () => {
    const outcome = makeOutcome({
      id: "workspace-unknown",
      projectId: "/repo/workspace-unknown",
      costUsd: 1,
      costPriced: true,
    })
    await recordWorkspaceOutcome(outcome, { workspaceRevision: 1, sessionID: "s", sessionUpdatedAt: 10 })
    await recordWorkspaceOutcome(
      { ...outcome, costUsd: undefined, costPriced: undefined },
      { workspaceRevision: 1, sessionID: "s", sessionUpdatedAt: 11 },
    )
    const recorded = await listOutcomes(outcome.projectId)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.costUsd).toBeUndefined()
    expect(recorded[0]?.costPriced).toBeUndefined()
  })
})

describe("workspace outcome attribution", () => {
  const record = {
    id: "ws-measured",
    provider: "anthropic",
    model: "claude-sonnet-5",
    sourcePath: "/repo/measured",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:01:00.000Z",
    changedFilesCount: 1,
    validationReport: { hadChecks: true, passed: true },
  }
  const message = {
    role: "assistant",
    providerID: record.provider,
    modelID: record.model,
    tokens: { input: 100, output: 20 },
    cost: 0.1,
  }

  test.each(["failed", "stopped"])(
    "paid %s attempts before validation remain in recommendation evidence",
    async (status) => {
      const projectId = `/repo/workspace-${status}-before-checks`
      const records = ["cheap", "reliable"].flatMap((model) =>
        Array.from({ length: model === "cheap" ? 6 : 3 }, (_, index) => ({
          ...record,
          id: `${model}-${index}`,
          sourcePath: projectId,
          model,
          status: model === "cheap" && index >= 3 ? status : "complete",
          validationReport: model === "cheap" && index >= 3 ? undefined : record.validationReport,
        })),
      )
      await Promise.all(
        records.filter(isTerminalWorkspace).map((workspace) => {
          const cost = workspace.status === "complete" ? (workspace.model === "cheap" ? 1 : 2) : 0.1
          const outcome = outcomesFromWorkspaceRecord(
            workspace,
            "backend",
            measureUsage([{ ...message, modelID: workspace.model, variant: "low", cost }]),
            { cost },
          )!
          return recordOutcome(outcome, 1)
        }),
      )

      const outcomes = await listOutcomes(projectId)
      expect(outcomes).toHaveLength(9)
      expect(
        outcomes
          .filter((outcome) => !outcome.hadChecks)
          .map((outcome) => ({
            execution: outcome.execution,
            checksPassed: outcome.checksPassed,
            costUsd: outcome.costUsd,
            costPriced: outcome.costPriced,
          })),
      ).toEqual(
        Array.from({ length: 3 }, () => ({
          execution: status === "stopped" ? "aborted" : "failed",
          checksPassed: undefined,
          costUsd: 0.1,
          costPriced: true,
        })),
      )
      expect(
        recommendModel(
          outcomes.filter((outcome) => outcome.model === "cheap"),
          "backend",
        ),
      ).toMatchObject({
        sampleSize: 6,
        completedSamples: 3,
        pricedSamples: 6,
        checkPassRate: 1,
      })
      // The former validation-only admission gate hides failures and makes cheap look equally reliable.
      expect(
        recommendModel(
          outcomes.filter((outcome) => outcome.hadChecks),
          "backend",
        )?.model,
      ).toBe("cheap")
      expect(recommendModel(outcomes, "backend")?.model).toBe("reliable")
    },
  )

  test("workspace evidence waits until execution is terminal, without requiring checks", () => {
    expect(
      ["complete", "failed", "needs review", "stopped", "merged", "discarded"].every((status) =>
        isTerminalWorkspace({ status }),
      ),
    ).toBe(true)
    expect(
      [undefined, "queued", "planning", "editing", "running commands", "testing"].some((status) =>
        isTerminalWorkspace({ status }),
      ),
    ).toBe(false)
  })

  test("workspace effort comes from observed history, never the requested model or a current default", () => {
    const named = outcomesFromWorkspaceRecord(record, "backend", measureUsage([{ ...message, variant: "xhigh" }]), {
      cost: 0.1,
    })
    expect(named?.variant).toEqual({ kind: "named", name: "xhigh" })
    const mixed = outcomesFromWorkspaceRecord(
      record,
      "backend",
      measureUsage([
        { ...message, variant: "xhigh" },
        { ...message, variant: "max" },
      ]),
      { cost: 0.2 },
    )
    expect(mixed?.variant).toEqual({ kind: "mixed" })
    expect(mixed?.costUsd).toBe(0.2)
    expect(outcomesFromWorkspaceRecord(record, "backend")?.variant).toBeUndefined()
    expect(
      outcomesFromWorkspaceRecord(record, "backend", measureUsage([message]), { cost: 0.1 })?.variant,
    ).toBeUndefined()
  })

  test("mixed-model usage cannot become a sample for the requested model", () => {
    const measured = measureUsage([message, { ...message, modelID: "another-model" }])
    const outcome = outcomesFromWorkspaceRecord(record, "backend", measured, { cost: 0.2 })
    expect(outcome?.model).toBeUndefined()
    expect(outcome).toMatchObject({ mixedModels: true, usage: { input: 200 }, costUsd: 0.2 })
  })

  test.each([
    { providerID: "other-provider", modelID: record.model },
    { providerID: record.provider, modelID: "other-model" },
    { providerID: undefined, modelID: undefined },
  ])("measured attribution must match the requested model: %j", (attribution) => {
    const measured = measureUsage([{ ...message, ...attribution }])
    const outcome = outcomesFromWorkspaceRecord(record, "backend", measured, { cost: 0.1 })
    expect(outcome?.model).toBeUndefined()
    expect(outcome?.provider).toBeUndefined()
    expect(outcome?.variant).toBeUndefined()
    expect(outcome).toMatchObject({ usage: { input: 100 }, costUsd: 0.1 })
  })

  test("includes the session's delegated cost in the full task cost", () => {
    const outcome = outcomesFromWorkspaceRecord(record, "backend", measureUsage([message]), {
      cost: 0.1,
      subagentCost: 0.5,
    })
    expect(outcome?.costUsd).toBeCloseTo(0.6)
    expect(outcome?.costPriced).toBe(true)
    expect(outcome?.usage).toMatchObject({ input: 100, output: 20 })
  })

  test("authoritative session totals preserve measured parent cost", () => {
    const outcome = outcomesFromWorkspaceRecord(record, "backend", measureUsage([message]), { cost: 0.1 })
    expect(outcome?.costUsd).toBe(0.1)
    expect(outcome?.costPriced).toBe(true)
  })

  test("unavailable rollups and unpriced delegated work keep task cost unknown", () => {
    const measured = measureUsage([message])
    for (const subagents of [undefined, { subagentCost: 0.5, subagentUnpricedSteps: 1 }]) {
      const outcome = outcomesFromWorkspaceRecord(record, "backend", measured, subagents)
      expect(outcome?.costUsd).toBeUndefined()
      expect(outcome?.costPriced).toBeUndefined()
      expect(outcome?.usage).toMatchObject({ input: 100, output: 20 })
    }
  })

  test("title spend is included without inflating main-model tokens", () => {
    const outcome = outcomesFromWorkspaceRecord(record, "backend", measureUsage([message]), { cost: 0.13 })
    expect(outcome?.costUsd).toBe(0.13)
    expect(outcome?.model).toBe(record.model)
    expect(outcome?.usage?.input).toBe(100)
    expect(
      outcomesFromWorkspaceRecord(record, "backend", measureUsage([message]), { cost: 0.13, unpricedSteps: 1 })
        ?.costUsd,
    ).toBeUndefined()
    expect(outcomesFromWorkspaceRecord(record, "backend", measureUsage([message]), {})?.costUsd).toBeUndefined()
    expect(
      outcomesFromWorkspaceRecord(record, "backend", measureUsage([message]), { cost: 0 })?.costUsd,
    ).toBeUndefined()
  })

  test("a priced delegate cannot hide missing parent pricing", () => {
    const outcome = outcomesFromWorkspaceRecord(record, "backend", measureUsage([{ ...message, cost: undefined }]), {
      subagentCost: 0.5,
    })
    expect(outcome?.costUsd).toBeUndefined()
    expect(outcome?.costPriced).toBeUndefined()
  })
})
