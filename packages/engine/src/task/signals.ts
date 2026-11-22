import { Context, Deferred, Effect, Layer, Scope } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"

/*
 * Signals about running subagents that a wait should end for (D.4): today, a child that starts waiting on the user.
 * Task IDs are session IDs, unique across instances, so one registry serves them all.
 */

export type Kind = "attention"

export interface Interface {
  /** Ends every wait that selected `taskID`. */
  readonly publish: (taskID: string, kind: Kind) => Effect.Effect<void>
  /**
   * Listens on `taskIDs` until the scope closes. The effect it returns waits for the next signal on any of them sent
   * after the listening began, and returns the IDs signalled.
   */
  readonly listen: (taskIDs: readonly string[]) => Effect.Effect<Effect.Effect<string[]>, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@vector/TaskSignals") {}

type Waiter = { ids: ReadonlySet<string>; hit: Set<string>; done: Deferred.Deferred<void> }

const layer = Layer.sync(Service, () => {
  const waiters = new Set<Waiter>()
  return Service.of({
    publish: (taskID) =>
      Effect.sync(() => {
        // Only the waits already registered: a waiter resumed here may start a new wait at once, which this signal
        // predates.
        for (const waiter of [...waiters]) {
          if (!waiter.ids.has(taskID)) continue
          waiter.hit.add(taskID)
          Deferred.doneUnsafe(waiter.done, Effect.void)
        }
      }),
    listen: (taskIDs) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const waiter: Waiter = { ids: new Set(taskIDs), hit: new Set(), done: Deferred.makeUnsafe<void>() }
          waiters.add(waiter)
          return waiter
        }),
        (waiter) => Effect.sync(() => waiters.delete(waiter)),
      ).pipe(Effect.map((waiter) => Deferred.await(waiter.done).pipe(Effect.map(() => [...waiter.hit])))),
  })
})

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as TaskSignals from "./signals"
