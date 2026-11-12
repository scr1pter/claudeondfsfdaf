export * as ReviewMemoryErasure from "./memory-erasure"

import { eq, or } from "drizzle-orm"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import { BrainPaths } from "@vectordevai/core/brain/paths"
import { ReviewStore } from "@vectordevai/core/brain/review-store"
import { BrainReviewMemoryTable } from "@vectordevai/core/brain/sql"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Project } from "@vectordevai/core/project"
import { ReviewRequestStore } from "@vectordevai/core/review/request-store"
import { SessionID } from "@vectordevai/schema/session-id"

export interface Interface {
  /** Only ReviewLifecycle.deleting calls this, after durable closing and before session removal. */
  readonly remove: (sessionID: SessionID, ownerNonce: string) => Effect.Effect<void, ReviewRequestStore.Refused>
}
export class Service extends Context.Service<Service, Interface>()("@vector/ReviewMemoryErasure") {}

export function make(requests: ReviewRequestStore.Interface, brain: BrainDatabase.Database): Interface {
  return {
    remove: (sessionID, ownerNonce) =>
      Effect.gen(function* () {
        if (!Schema.is(SessionID)(sessionID))
          return yield* new ReviewRequestStore.Refused({
            code: "invalid",
            message: "Invalid review deletion identity.",
          })
        const session = yield* requests.closingSnapshot(sessionID, ownerNonce)
        if (!session)
          return yield* new ReviewRequestStore.Refused({
            code: "unavailable",
            message: "The review deletion source is unavailable.",
          })
        const repository =
          session.repository === Project.ID.global ? BrainPaths.folderKey(session.directory) : session.repository
        yield* brain
          .transaction((tx) =>
            Effect.gen(function* () {
              // A removed/retargeted non-Git folder may no longer resolve to its old
              // key. Find retained provenance by the trusted session ID as well.
              const rows = yield* tx
                .selectDistinct({ repository: BrainReviewMemoryTable.repository_id })
                .from(BrainReviewMemoryTable)
                .where(
                  or(
                    eq(BrainReviewMemoryTable.parent_session_id, sessionID),
                    eq(BrainReviewMemoryTable.review_session_id, sessionID),
                  ),
                )
                .limit(201)
                .all()
              if (rows.length > 200)
                return yield* new ReviewRequestStore.Refused({
                  code: "unavailable",
                  message: "The review deletion namespace is unavailable.",
                })
              const repositories = new Set([repository, ...rows.map((row) => row.repository)])
              for (const selected of repositories) yield* ReviewStore.eraseSession(tx, selected, sessionID)
            }),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.fail(
                    new ReviewRequestStore.Refused({
                      code: "unavailable",
                      message: "Review memory could not be erased. The conversation was not removed.",
                    }),
                  ),
            ),
          )
      }),
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const requests = yield* ReviewRequestStore.Service
    const brain = yield* BrainDatabase.Service
    return make(requests, brain.db)
  }),
)
export const node = LayerNode.make({ service: Service, layer, deps: [ReviewRequestStore.node, BrainDatabase.node] })
