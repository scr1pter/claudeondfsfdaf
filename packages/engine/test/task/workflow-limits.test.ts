import { expect } from "bun:test"
import { Effect, Scope, Exit } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { SessionID } from "@/session/schema"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([TaskLimits.node, SpendGuard.node])))
for (const running of [1, 2, 3])
  for (const background of [false, true])
    it.effect(`zero-slot coordinator keeps accounting with ${running} slots and background=${background}`, () =>
      Effect.gen(function* () {
        const service = yield* TaskLimits.Service
        const limits = { running, perRequest: 1, budget: { usd: 1 } }
        const common = { conversationID: "ses_workflow_limits", requestID: "msg_workflow_limits", limits, count: 1 }
        const scope = yield* Scope.make()
        const admission = yield* Scope.provide(scope)(service.admit({ ...common, origin: "root", coordinator: true }))
        expect(admission).toMatchObject({ active: 0, running: 0, queued: 0, waits: false, prepaid: 0 })
        yield* service.bind(admission, SessionID.make("ses_coordinator"))
        if (background) yield* Scope.close(scope, Exit.succeed(undefined))
        // Foreground keeps the admission scope open until its children finish. It must exert no queue demand.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* service.admit({ ...common, origin: "workflow", parentID: "ses_coordinator" })
            expect(child.waits).toBe(false)
            yield* service.bind(child, SessionID.make("ses_worker"))
            yield* service.run(
              { conversationID: common.conversationID, childID: "ses_worker", origin: "workflow" },
              Effect.gen(function* () {
                const status = yield* service.status(common.conversationID, common.requestID)
                expect(status.running).toBe(1)
                expect(status.launched).toBe(1)
              }),
            )
            yield* service.release(child, SessionID.make("ses_worker"))
          }),
        )
        const refused = yield* Effect.scoped(service.admit({ ...common, origin: "root", coordinator: true })).pipe(
          Effect.flip,
        )
        expect(refused.reason).toBe("per_request")
        const resumed = yield* Effect.scoped(service.admit({ ...common, origin: "resume", coordinator: true }))
        expect(resumed.waits).toBe(false)
        expect(resumed.active).toBe(0)
        if (!background) yield* Scope.close(scope, Exit.succeed(undefined))
        yield* service.release(admission, SessionID.make("ses_coordinator"))
        expect((yield* service.status(common.conversationID, common.requestID)).running).toBe(0)
      }),
    )

it.effect("zero-slot coordinators retain delegated spend refusals across resume", () =>
  Effect.gen(function* () {
    const service = yield* TaskLimits.Service
    const guard = yield* SpendGuard.Service
    const common = {
      conversationID: "ses_workflow_spend",
      requestID: "msg_workflow_spend",
      limits: { running: 1, perRequest: 32, budget: { usd: 1 } },
      count: 1,
      coordinator: true,
    }
    yield* Effect.scoped(service.admit({ ...common, origin: "root" }))
    const child = SessionID.make("ses_spender")
    yield* guard.link(child, SessionID.make(common.conversationID), {
      delegated: { id: TaskLimits.ledger(common.conversationID, common.requestID), budget: common.limits.budget },
    })
    yield* guard.record(child, {
      costUsd: 2,
      costKind: "priced",
      contextTokens: 0,
      cachedTokens: 0,
      continues: false,
      tools: [],
      patched: false,
    })
    for (const origin of ["root", "resume"] as const) {
      const refused = yield* Effect.scoped(service.admit({ ...common, origin })).pipe(Effect.flip)
      expect(refused.reason).toBe("spend")
    }
    expect((yield* service.status(common.conversationID, common.requestID)).running).toBe(0)
    expect((yield* service.status(common.conversationID, common.requestID)).spend).toMatchObject({
      spentUsd: 2,
      stopped: true,
    })
  }),
)
