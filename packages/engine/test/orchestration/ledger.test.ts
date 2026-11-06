import { describe, expect, test } from "bun:test"
import { Effect, Layer, Result } from "effect"
import { EventV2 } from "@vectordevai/core/event"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { SessionID } from "@vectordevai/schema/session-id"
import { WorkflowLedger } from "@/orchestration/ledger"
import { testEffect } from "../lib/effect"

const layer = LayerNode.compile(LayerNode.group([SpendGuard.node, EventV2.node]))
const it = testEffect(layer)
const root = SessionID.make("ses_workflow_ledger_root")
const run = SessionID.make("ses_workflow_ledger_run")
const child = SessionID.make("ses_workflow_ledger_child")
const sibling = SessionID.make("ses_workflow_ledger_sibling")
const zero = (): WorkflowLedger.Usage => ({ spentUsd: 0, steps: 0, unpricedSteps: 0, codiumSteps: 0 })
const step = (input: Partial<SpendGuard.Step> = {}): SpendGuard.Step => ({
  costKind: "priced",
  costUsd: 0,
  contextTokens: 100,
  cachedTokens: 0,
  continues: false,
  tools: [],
  patched: false,
  ...input,
})
const start = Effect.fnUntraced(function* (
  guard: SpendGuard.Interface,
  options: {
    readonly rootUsd?: number
    readonly runUsd?: number
    readonly delegatedUsd?: number
    readonly noRoot?: boolean
  } = {},
) {
  if (!options.noRoot) yield* guard.begin(root, { usd: options.rootUsd ?? 100, steps: 1000 })
  yield* guard.link(run, root, {
    renew: true,
    budget: { usd: options.runUsd ?? 50, steps: 500 },
    delegated: { id: "workflow-request", budget: { usd: options.delegatedUsd ?? 75, steps: 750 } },
  })
})

describe("workflow nested budget ledgers", () => {
  it.effect("concurrent members share the group cap and inherit every ancestor exactly once", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* start(guard)
      const ledger = yield* WorkflowLedger.make({
        guard,
        runID: run,
        groups: { review: { budget: { usd: 1, steps: 20 } } },
      })
      const parent = yield* ledger.parent("review")
      expect(parent).toMatch(/^ses_workflow_group_[0-9a-f-]{36}$/)
      expect(yield* ledger.parent("review")).toBe(parent)
      expect(yield* ledger.parent()).toBe(run)
      yield* guard.link(child, parent, { budget: { usd: 10, steps: 10 } })
      yield* guard.link(sibling, parent, { budget: { usd: 10, steps: 10 } })
      yield* Effect.all([guard.record(child, step({ costUsd: 0.7 })), guard.record(sibling, step({ costUsd: 0.7 }))], {
        concurrency: "unbounded",
      })
      const view = yield* ledger.inspect("review")
      expect(view.usage).toEqual({ spentUsd: 1.4, steps: 2, unpricedSteps: 0, codiumSteps: 0 })
      expect(view.groupStop?.reason).toBe("cap")
      expect(view.ancestorStop).toBeUndefined()
      const scopes = yield* guard.scopes(child)
      expect(
        scopes.map((scope) => [scope.kind, scope.id]).filter(([kind, id]) => kind === "child" && id === parent),
      ).toHaveLength(1)
      expect(scopes.find((scope) => scope.kind === "child" && scope.id === parent)?.steps).toBe(2)
      expect(scopes.find((scope) => scope.kind === "child" && scope.id === run)?.spentUsd).toBe(1.4)
      expect((yield* guard.delegated("workflow-request"))?.spentUsd).toBe(1.4)
      expect((yield* guard.snapshot(root))?.spentUsd).toBe(1.4)
      expect((yield* guard.stopped(sibling))?.reason).toBe("cap")
      expect(Result.isFailure(yield* ledger.parent("review").pipe(Effect.result))).toBe(true)
      expect(yield* ledger.parent()).toBe(run)
    }),
  )

  it.effect("group step limits stop siblings without stopping the run", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* start(guard)
      const ledger = yield* WorkflowLedger.make({ guard, runID: run, groups: { group: { budget: { steps: 2 } } } })
      const parent = yield* ledger.parent("group")
      yield* guard.link(child, parent)
      yield* guard.link(sibling, parent)
      yield* guard.record(child, step())
      yield* guard.record(sibling, step())
      expect((yield* ledger.inspect("group")).groupStop?.reason).toBe("steps")
      expect((yield* ledger.inspect()).ancestorStop).toBeUndefined()
      expect(yield* ledger.parent()).toBe(run)
    }),
  )

  it.effect("a stopped run is reported as an ancestor stop and cannot be reset by group creation", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* start(guard, { runUsd: 1 })
      yield* guard.record(run, step({ costUsd: 1 }))
      const ledger = yield* WorkflowLedger.make({ guard, runID: run, groups: { group: { budget: { usd: 20 } } } })
      const view = yield* ledger.inspect("group")
      expect(view.groupStop).toBeUndefined()
      expect(view.ancestorStop).toMatchObject({ id: run, kind: "child", scope: "ancestor", reason: "cap" })
      const refused = yield* ledger.parent("group").pipe(Effect.result)
      expect(Result.isFailure(refused)).toBe(true)
      if (Result.isFailure(refused)) expect(refused.failure.scope).toBe("ancestor")
    }),
  )

  it.effect("a stopped delegated ledger propagates without a live root model run", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* start(guard, { noRoot: true, delegatedUsd: 1 })
      const ledger = yield* WorkflowLedger.make({ guard, runID: run, groups: { group: { budget: { usd: 10 } } } })
      yield* guard.link(child, yield* ledger.parent("group"))
      yield* guard.record(child, step({ costUsd: 1 }))
      const view = yield* ledger.inspect("group")
      expect(view.ancestorStop).toMatchObject({ kind: "delegated", id: "workflow-request", reason: "cap" })
      expect(view.groupStop).toBeUndefined()
      expect((yield* guard.delegated("workflow-request"))?.steps).toBe(1)
      expect((yield* guard.scopes(child)).filter((scope) => scope.kind === "delegated")).toHaveLength(1)
    }),
  )

  it.effect("exhausted carried groups do not prevent unrelated groups or outer nodes", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* start(guard)
      const ledger = yield* WorkflowLedger.make({
        guard,
        runID: run,
        groups: {
          spent: { budget: { usd: 2 }, used: { ...zero(), spentUsd: 2, steps: 1 } },
          steps: { budget: { steps: 2 }, used: { ...zero(), steps: 2 } },
          unknown: { budget: { usd: 5 }, used: { ...zero(), steps: 40, unpricedSteps: 40 } },
          available: { budget: { usd: 5, steps: 5 } },
        },
      })
      for (const [name, reason] of [
        ["spent", "cap"],
        ["steps", "steps"],
        ["unknown", "unpriced"],
      ] as const) {
        const view = yield* ledger.inspect(name)
        expect(view.parentID).toBeUndefined()
        expect(view.groupStop?.reason).toBe(reason)
        expect(Result.isFailure(yield* ledger.parent(name).pipe(Effect.result))).toBe(true)
      }
      expect(yield* ledger.parent()).toBe(run)
      expect(yield* ledger.parent("available")).toMatch(/^ses_workflow_group_/)
    }),
  )

  it.effect("warm resumes use carried usage and new private identities without resetting remaining caps", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* start(guard)
      const first = yield* WorkflowLedger.make({
        guard,
        runID: run,
        groups: { group: { budget: { usd: 5, steps: 4 } } },
      })
      const oldParent = yield* first.parent("group")
      yield* guard.link(child, oldParent)
      yield* guard.record(child, step({ costUsd: 2 }))
      expect(yield* first.parent("group")).toBe(oldParent)
      expect((yield* first.inspect("group")).usage.spentUsd).toBe(2)
      const saved = yield* first.snapshot()
      yield* guard.release(child)
      yield* first.close()
      const second = yield* WorkflowLedger.make({
        guard,
        runID: run,
        groups: { group: { budget: { usd: 5, steps: 4 }, used: saved.group } },
      })
      const parent = yield* second.parent("group")
      expect(parent).not.toBe(oldParent)
      const view = yield* second.inspect("group")
      expect(view.scopes.find((scope) => scope.id === parent)?.budget).toMatchObject({ usd: 3, steps: 3 })
      yield* guard.link(sibling, parent)
      yield* guard.record(sibling, step({ costUsd: 3 }))
      expect((yield* second.inspect("group")).usage).toMatchObject({ spentUsd: 5, steps: 2 })
      expect((yield* second.inspect("group")).groupStop?.reason).toBe("cap")
      expect((yield* guard.snapshot(root))?.spentUsd).toBe(5)
    }),
  )

  it.effect("cold resumes reconstruct remaining caps from the durable snapshot", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* start(guard)
      const first = yield* WorkflowLedger.make({
        guard,
        runID: run,
        groups: { group: { budget: { usd: 5, steps: 3 } } },
      })
      const oldParent = yield* first.parent("group")
      yield* guard.link(child, oldParent)
      yield* guard.record(child, step({ costUsd: 2 }))
      const saved = yield* first.snapshot()
      yield* guard.release(child)
      yield* first.close()
      yield* Effect.gen(function* () {
        const cold = yield* SpendGuard.Service
        yield* start(cold, { noRoot: true })
        const next = yield* WorkflowLedger.make({
          guard: cold,
          runID: run,
          groups: { group: { budget: { usd: 5, steps: 3 }, used: saved.group } },
        })
        const parent = yield* next.parent("group")
        expect(parent).not.toBe(oldParent)
        expect((yield* next.inspect("group")).scopes.find((scope) => scope.id === parent)?.budget).toMatchObject({
          usd: 3,
          steps: 2,
        })
        yield* cold.link(sibling, parent)
        yield* cold.record(sibling, step({ costUsd: 1 }))
        yield* cold.record(sibling, step({ costUsd: 1 }))
        expect((yield* next.inspect("group")).usage).toMatchObject({ spentUsd: 4, steps: 3 })
        expect((yield* next.inspect("group")).groupStop?.reason).toBe("steps")
      }).pipe(Effect.scoped, Effect.provide(Layer.fresh(layer)))
    }),
  )

  it.effect("default unknown-price allowance carries across resume and Codium does not consume it", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* start(guard)
      const used = { spentUsd: 0, steps: 89, unpricedSteps: 39, codiumSteps: 50 }
      const ledger = yield* WorkflowLedger.make({
        guard,
        runID: run,
        groups: { group: { budget: { usd: 5, steps: 100 }, used } },
      })
      const parent = yield* ledger.parent("group")
      expect((yield* ledger.inspect("group")).scopes.find((scope) => scope.id === parent)?.budget.unpricedSteps).toBe(1)
      yield* guard.link(child, parent)
      expect((yield* guard.record(child, step({ costKind: "codium" }))).state).toBe("ok")
      expect((yield* ledger.inspect("group")).usage).toEqual({
        spentUsd: 0,
        steps: 90,
        unpricedSteps: 39,
        codiumSteps: 51,
      })
      expect((yield* ledger.inspect("group")).groupStop).toBeUndefined()
      expect((yield* guard.record(child, step({ costKind: "unknown" }))).reason).toBe("unpriced")
      expect((yield* ledger.inspect("group")).groupStop?.reason).toBe("unpriced")
      expect((yield* ledger.inspect("group")).usage).toEqual({
        spentUsd: 0,
        steps: 91,
        unpricedSteps: 40,
        codiumSteps: 51,
      })
    }),
  )

  test("display rollups separate unknown activity from Codium", () => {
    expect(WorkflowLedger.fromDisplay({ cost: 2, steps: 12, unpricedSteps: 9, codiumSteps: 7 })).toEqual({
      spentUsd: 2,
      steps: 12,
      unpricedSteps: 2,
      codiumSteps: 7,
    })
    expect(WorkflowLedger.fromDisplay({ cost: 0, steps: 7, codiumSteps: 7 })).toEqual({
      spentUsd: 0,
      steps: 7,
      unpricedSteps: 0,
      codiumSteps: 7,
    })
  })

  it.effect("private identities never reuse spec names and closing releases only private bindings", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* start(guard)
      const ledger = yield* WorkflowLedger.make({
        guard,
        runID: run,
        groups: { arbitrary: { budget: { usd: 5 } }, another: { budget: { usd: 5 } } },
      })
      const first = yield* ledger.parent("arbitrary")
      const second = yield* ledger.parent("another")
      expect(first).not.toBe(second)
      expect(first.includes("arbitrary")).toBe(false)
      yield* guard.link(child, first)
      yield* guard.record(child, step({ costUsd: 1 }))
      yield* guard.release(child)
      const saved = yield* ledger.snapshot()
      expect(saved.arbitrary.spentUsd).toBe(1)
      yield* ledger.close()
      yield* ledger.close()
      expect(yield* guard.rootOf(first)).toBe(first)
      expect(yield* guard.rootOf(second)).toBe(second)
      expect(yield* guard.scopes(first)).toEqual([])
      expect(yield* guard.rootOf(run)).toBe(root)
      expect((yield* guard.delegated("workflow-request"))?.spentUsd).toBe(1)
      const closed = yield* ledger.parent("arbitrary").pipe(Effect.result)
      expect(Result.isFailure(closed)).toBe(true)
      if (Result.isFailure(closed)) expect(closed.failure.code).toBe("closed")
    }),
  )

  it.effect("scope cleanup also releases private bindings", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* start(guard)
      const parent = yield* Effect.gen(function* () {
        const ledger = yield* WorkflowLedger.make({ guard, runID: run, groups: { group: { budget: { usd: 5 } } } })
        return yield* ledger.parent("group")
      }).pipe(Effect.scoped)
      expect(yield* guard.rootOf(parent)).toBe(parent)
      expect(yield* guard.scopes(parent)).toEqual([])
    }),
  )

  it.effect("missing run lineage and malformed carried usage fail before child admission", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const missing = yield* WorkflowLedger.make({ guard, runID: run, groups: {} }).pipe(Effect.result)
      expect(Result.isFailure(missing)).toBe(true)
      if (Result.isFailure(missing)) expect(missing.failure.code).toBe("missing_lineage")
      yield* start(guard)
      const invalid = yield* WorkflowLedger.make({
        guard,
        runID: run,
        groups: { bad: { budget: { usd: 5 }, used: { ...zero(), spentUsd: Number.NaN } } },
      }).pipe(Effect.result)
      expect(Result.isFailure(invalid)).toBe(true)
      if (Result.isFailure(invalid)) expect(invalid.failure.code).toBe("invalid_usage")
      const ledger = yield* WorkflowLedger.make({ guard, runID: run, groups: {} })
      const unknown = yield* ledger.parent("from-public-input").pipe(Effect.result)
      expect(Result.isFailure(unknown)).toBe(true)
      if (Result.isFailure(unknown)) expect(unknown.failure.code).toBe("unknown_group")
    }),
  )
})
