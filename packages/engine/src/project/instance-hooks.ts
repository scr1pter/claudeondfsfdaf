import { makeGlobalNode } from "@vectordevai/core/effect/app-node"
import { Context, Effect, Layer, Scope } from "effect"

/*
 * Work that runs whenever an instance boots, registered by the services that own it (for example task recovery). A
 * hook runs with the booting instance's context, alongside the other bootstrap work, and a failing hook is logged
 * without failing the boot.
 */

export interface Interface {
  /** Runs `hook` at every instance boot while the caller's scope is open. A later hook of the same name replaces it. */
  readonly register: (name: string, hook: Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>
  /** Runs every registered hook for the current instance, together. */
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@vector/InstanceHooks") {}

const layer = Layer.sync(Service, () => {
  const hooks = new Map<string, Effect.Effect<void>>()
  return Service.of({
    register: (name, hook) =>
      Effect.acquireRelease(
        Effect.sync(() => void hooks.set(name, hook)),
        () =>
          Effect.sync(() => {
            if (hooks.get(name) === hook) hooks.delete(name)
          }),
      ),
    init: () =>
      Effect.forEach(
        [...hooks],
        ([name, hook]) =>
          hook.pipe(
            Effect.catchCause((cause) => Effect.logWarning("instance hook failed", { name, cause })),
            Effect.withSpan(`InstanceHooks.${name}`),
          ),
        { concurrency: "unbounded", discard: true },
      ),
  })
})

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

export * as InstanceHooks from "./instance-hooks"
