import { randomUUID } from "node:crypto"
import path from "node:path"
import { Context, Effect, Layer, Result } from "effect"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ReviewRequestStore } from "@vectordevai/core/review/request-store"
import { EffectFlock } from "@vectordevai/core/util/effect-flock"
import { SessionID } from "@vectordevai/schema/session-id"
import { FileLock } from "@/tool/file-lock"

// An engine worker/finalizer cannot synchronously delete an active review and
// then wait for its own (or another mutually waiting worker's) cancellation.
export const Current = Context.Reference<string | undefined>("@vector/ReviewLifecycle.Current", {
  defaultValue: () => undefined,
})

interface Candidate {
  database: string
  cancel: () => Effect.Effect<void>
}
const candidates = new Map<string, Candidate>()
const databaseKey = () => (Database.path() === ":memory:" ? `memory:${process.pid}` : FileLock.key(Database.path()))

/** Internal process registration only; no nonce or callback is accepted from HTTP. */
export function register(ownerNonce: string, cancel: () => Effect.Effect<void>) {
  const candidate = { database: databaseKey(), cancel }
  candidates.set(ownerNonce, candidate)
  return () => {
    if (candidates.get(ownerNonce) === candidate) candidates.delete(ownerNonce)
  }
}

export interface Interface {
  readonly within: (
    parentID: SessionID,
    runID?: SessionID,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | ReviewRequestStore.Refused, R>
  readonly deleting: <A, E, R>(
    sessionID: SessionID,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ReviewRequestStore.Refused, R>
}
export class Service extends Context.Service<Service, Interface>()("@vector/ReviewLifecycle") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const flock = yield* EffectFlock.Service
    const requests = yield* ReviewRequestStore.Service
    const lock = <A, E, R>(sessionID: SessionID, effect: Effect.Effect<A, E, R>) => {
      const database = databaseKey()
      const directory =
        Database.path() === ":memory:" ? undefined : path.join(path.dirname(database), ".vector-review-locks")
      return flock
        .withLock(
          `review-session:${database}:${sessionID}`,
          directory,
        )(effect.pipe(Effect.result))
        .pipe(
          Effect.mapError(
            () =>
              new ReviewRequestStore.Refused({
                code: "unavailable",
                message: "The conversation's review lifecycle is busy.",
              }),
          ),
          Effect.flatMap((result) =>
            Result.isSuccess(result) ? Effect.succeed(result.success) : Effect.fail(result.failure),
          ),
        )
    }
    const within: Interface["within"] = (parentID, runID) => (effect) =>
      lock(parentID, runID && runID !== parentID ? lock(runID, effect) : effect)
    const deleting: Interface["deleting"] = (sessionID, effect) =>
      Effect.gen(function* () {
        const ownerNonce = randomUUID()
        const owner = BackgroundJobStore.open()
        return yield* Effect.gen(function* () {
          const insideReview = (yield* Current) !== undefined
          const selected = yield* lock(
            sessionID,
            Effect.suspend(() =>
              requests.beginDelete({
                sessionID,
                ownerNonce,
                owner,
                localNonces: new Set(
                  [...candidates].filter(([, value]) => value.database === databaseKey()).map(([nonce]) => nonce),
                ),
                insideReview,
              }),
            ),
          )
          // Closing is durable now. Release the filesystem lock before any cancel,
          // finalizer or recursive delete can run; admission observes that fence.
          return yield* Effect.gen(function* () {
            for (const nonce of selected) {
              const candidate = candidates.get(nonce)
              if (candidate?.database === databaseKey()) yield* candidate.cancel()
            }
            return yield* effect
          }).pipe(Effect.ensuring(requests.endDelete(sessionID, ownerNonce)))
        }).pipe(Effect.ensuring(Effect.sync(() => BackgroundJobStore.close(owner))))
      })
    return Service.of({ within, deleting })
  }),
)
export const node = LayerNode.make({ service: Service, layer, deps: [EffectFlock.node, ReviewRequestStore.node] })
export * as ReviewLifecycle from "./lifecycle"
