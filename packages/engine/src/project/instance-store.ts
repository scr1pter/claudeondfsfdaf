import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { makeGlobalNode, Node } from "@vectordevai/core/effect/app-node"
import { GlobalBus } from "@/bus/global"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance as runDisposers } from "@/effect/instance-registry"
import { disposeInstanceConfirmed } from "@/effect/instance-registry"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Scope } from "effect"
import { type InstanceContext } from "./instance-context"
import { InstanceBootstrap } from "./bootstrap-service"
import * as Project from "./project"

export interface LoadInput {
  directory: string
  worktree?: string
  project?: Project.Info
}

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly reload: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void>
  readonly disposeDirectory: (directory: string) => Effect.Effect<void>
  readonly disposeAll: () => Effect.Effect<void>
  /** The instances that are loaded, once any still loading have finished. */
  readonly loaded: () => Effect.Effect<InstanceContext[]>
  /** No existing caller may own this directory. The callback and its cleanup exclusively own the fresh instance. */
  readonly withFresh?: <A, E, R>(
    input: LoadInput,
    use: (context: InstanceContext) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>
  readonly provide: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@vector/InstanceStore") {}

export const use = serviceUse(Service)

interface Entry {
  readonly deferred: Deferred.Deferred<InstanceContext>
}

interface Fresh {
  readonly entry: Entry
  readonly released: Deferred.Deferred<void>
  readonly stop: Deferred.Deferred<Effect.Effect<void>>
  context?: InstanceContext
  phase: "booting" | "using" | "closing" | "failed"
}
const FreshBootstrap = Context.Reference<Fresh | undefined>("~vector/InstanceStore/FreshBootstrap", {
  defaultValue: () => undefined,
})
const FreshOwner = Context.Reference<Fresh | undefined>("~vector/InstanceStore/FreshOwner", {
  defaultValue: () => undefined,
})

const layer: Layer.Layer<Service, never, Project.Service | InstanceBootstrap.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const project = yield* Project.Service
    const bootstrap = yield* InstanceBootstrap.Service
    const scope = yield* Scope.Scope
    const cache = new Map<string, Entry>()
    const fresh = new Map<string, Fresh>()
    const owned = new WeakSet<InstanceContext>()
    const unconfirmed = new Set<string>()
    const failedFresh = new Set<string>()
    const uncachedDisposals = new Map<string, Deferred.Deferred<void>>()
    let draining = false
    let closed = false

    const boot = (input: LoadInput & { directory: string }, owner?: Fresh) =>
      Effect.gen(function* () {
        const ctx: InstanceContext =
          input.project && input.worktree
            ? {
                directory: input.directory,
                worktree: input.worktree,
                project: input.project,
              }
            : yield* project.fromDirectory(input.directory).pipe(
                Effect.map((result) => ({
                  directory: input.directory,
                  worktree: result.sandbox,
                  project: result.project,
                })),
              )
        if (owner) {
          owner.context = ctx
          owned.add(ctx)
        }
        yield* bootstrap.run.pipe(Effect.provideService(InstanceRef, ctx), Effect.provideService(FreshBootstrap, owner))
        return ctx
      }).pipe(Effect.withSpan("InstanceStore.boot"))

    const removeEntry = (directory: string, entry: Entry) =>
      Effect.sync(() => {
        if (cache.get(directory) !== entry) return false
        cache.delete(directory)
        return true
      })

    const completeLoad = (directory: string, entry: Entry, work: Effect.Effect<InstanceContext>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // Scope shutdown interrupts workers before disposing entries. Always publish their exit
          // so disposal and concurrent callers cannot wait forever on an abandoned Deferred.
          const exit = yield* Effect.exit(restore(work))
          if (Exit.isFailure(exit)) {
            // A failed ordinary boot may have registered partial instance state. Legacy callers retain their
            // original failure/retry behavior, but absence from the cache is no longer proof of a fresh directory.
            unconfirmed.add(directory)
            yield* removeEntry(directory, entry)
          }
          yield* Deferred.done(entry.deferred, exit).pipe(Effect.asVoid)
        }),
      )

    const emitDisposed = (input: { directory: string; project?: string }) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: input.directory,
          project: input.project,
          workspace: WorkspaceContext.workspaceID,
          payload: {
            type: "server.instance.disposed",
            properties: {
              directory: input.directory,
            },
          },
        }),
      )

    const disposeContext = Effect.fn("InstanceStore.disposeContext")(function* (ctx: InstanceContext) {
      yield* Effect.logInfo("disposing instance", { directory: ctx.directory })
      yield* Effect.promise(() =>
        runDisposers(ctx.directory, (confirmed) => {
          if (!confirmed) unconfirmed.add(ctx.directory)
        }),
      )
      yield* emitDisposed({ directory: ctx.directory, project: ctx.project.id })
    })

    const disposeEntry = Effect.fnUntraced(function* (directory: string, entry: Entry, ctx: InstanceContext) {
      if (cache.get(directory) !== entry) return false
      yield* disposeContext(ctx)
      if (cache.get(directory) !== entry) return false
      cache.delete(directory)
      return true
    })

    const load = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          while (true) {
            if (closed) return yield* Effect.die(new Error("Instance store is closed"))
            if (failedFresh.has(directory))
              return yield* Effect.die(new Error("Exclusive instance cleanup was not confirmed"))
            const owner = fresh.get(directory)
            if (owner) {
              if (
                owner.context &&
                ((owner.phase === "booting" && (yield* FreshBootstrap) === owner) ||
                  (owner.phase === "using" && (yield* FreshOwner) === owner))
              )
                return owner.context
              yield* restore(Deferred.await(owner.released))
              continue
            }
            const disposing = uncachedDisposals.get(directory)
            if (disposing) {
              yield* restore(Deferred.await(disposing))
              continue
            }
            const existing = cache.get(directory)
            if (existing) {
              const context = yield* restore(Deferred.await(existing.deferred))
              if (fresh.has(directory) || cache.get(directory) !== existing) continue
              return context
            }

            const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext>() }
            cache.set(directory, entry)
            yield* completeLoad(
              directory,
              entry,
              Effect.gen(function* () {
                yield* Effect.logInfo("creating instance", { directory })
                return yield* boot({ ...input, directory })
              }),
            ).pipe(Effect.forkIn(scope, { startImmediately: true }))
            const context = yield* restore(Deferred.await(entry.deferred))
            if (fresh.has(directory) || cache.get(directory) !== entry) continue
            return context
          }
        }),
      ).pipe(Effect.withSpan("InstanceStore.load"))
    }

    const reload = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          while (true) {
            if (closed) return yield* Effect.die(new Error("Instance store is closed"))
            if (failedFresh.has(directory))
              return yield* Effect.die(new Error("Exclusive instance cleanup was not confirmed"))
            const owner = fresh.get(directory)
            if (owner) {
              if ((yield* FreshBootstrap) === owner || (yield* FreshOwner) === owner)
                return yield* Effect.die(new Error("An exclusive instance cannot reload itself"))
              yield* restore(Deferred.await(owner.released))
              continue
            }
            const disposing = uncachedDisposals.get(directory)
            if (disposing) {
              yield* restore(Deferred.await(disposing))
              continue
            }
            const previous = cache.get(directory)
            const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext>() }
            cache.set(directory, entry)
            yield* completeLoad(
              directory,
              entry,
              Effect.gen(function* () {
                yield* Effect.logInfo("reloading instance", { directory })
                if (previous) {
                  yield* Deferred.await(previous.deferred).pipe(Effect.ignore)
                  yield* Effect.promise(() =>
                    runDisposers(directory, (confirmed) => {
                      if (!confirmed) unconfirmed.add(directory)
                    }),
                  )
                  yield* emitDisposed({ directory, project: input.project?.id })
                }
                return yield* boot({ ...input, directory })
              }),
            ).pipe(Effect.forkIn(scope, { startImmediately: true }))
            const context = yield* restore(Deferred.await(entry.deferred))
            if (fresh.has(directory) || cache.get(directory) !== entry) return yield* restore(load(input))
            return context
          }
        }),
      ).pipe(Effect.withSpan("InstanceStore.reload"))
    }

    const dispose: Interface["dispose"] = Effect.fn("InstanceStore.dispose")(function* (ctx): Effect.fn.Return<void> {
      const owner = fresh.get(ctx.directory)
      if (owner) {
        if ((yield* FreshBootstrap) === owner || (yield* FreshOwner) === owner) return
        yield* Deferred.await(owner.released)
        // The lease already disposed its own context. A later context is a different owner's resource.
        return
      }
      if (owned.has(ctx)) return
      const pending = uncachedDisposals.get(ctx.directory)
      if (pending) return yield* Deferred.await(pending)
      const entry = cache.get(ctx.directory)
      if (!entry) {
        const settled = Deferred.makeUnsafe<void>()
        uncachedDisposals.set(ctx.directory, settled)
        return yield* disposeContext(ctx).pipe(
          Effect.ensuring(
            Effect.sync(() => uncachedDisposals.delete(ctx.directory)).pipe(
              Effect.andThen(Deferred.succeed(settled, undefined)),
            ),
          ),
        )
      }

      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (fresh.has(ctx.directory)) return yield* dispose(ctx)
      if (Exit.isFailure(exit)) return yield* removeEntry(ctx.directory, entry).pipe(Effect.asVoid)
      if (exit.value !== ctx) return
      yield* disposeEntry(ctx.directory, entry, ctx).pipe(Effect.asVoid)
    })

    const disposeDirectory: Interface["disposeDirectory"] = Effect.fn("InstanceStore.disposeDirectory")(
      function* (input): Effect.fn.Return<void> {
        const directory = FSUtil.resolve(input)
        while (true) {
          const owner = fresh.get(directory)
          if (!owner) break
          if ((yield* FreshBootstrap) === owner || (yield* FreshOwner) === owner) return
          yield* Deferred.await(owner.released)
        }
        const pending = uncachedDisposals.get(directory)
        if (pending) {
          yield* Deferred.await(pending)
          return yield* disposeDirectory(input)
        }
        const entry = cache.get(directory)
        if (!entry) return
        const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
        if (fresh.has(directory)) return yield* disposeDirectory(input)
        if (Exit.isFailure(exit)) return yield* removeEntry(directory, entry).pipe(Effect.asVoid)
        yield* disposeEntry(directory, entry, exit.value).pipe(Effect.asVoid)
      },
    )

    const disposeAllOnce = Effect.fnUntraced(function* () {
      const caller = yield* FreshOwner
      const booting = yield* FreshBootstrap
      if (caller && [...fresh.values()].includes(caller))
        return yield* Effect.die(new Error("An exclusive callback cannot dispose its own store"))
      if (booting && [...fresh.values()].includes(booting))
        return yield* Effect.die(new Error("An exclusive bootstrap cannot dispose its own store"))
      draining = true
      yield* Effect.gen(function* () {
        for (const owner of [...fresh.values()]) {
          yield* Effect.gen(function* () {
            const stop = yield* Deferred.await(owner.stop)
            yield* stop
            yield* Deferred.await(owner.released)
          }).pipe(
            Effect.catchCause((cause) => Effect.logWarning("exclusive instance disposal failed", { cause })),
          )
        }
        yield* Effect.logInfo("disposing all instances")
        yield* Effect.forEach(
          [...cache.entries()],
          (item) =>
            Effect.gen(function* () {
              const exit = yield* Deferred.await(item[1].deferred).pipe(Effect.exit)
              if (Exit.isFailure(exit)) {
                yield* Effect.logWarning("instance dispose failed", { key: item[0], cause: exit.cause })
                yield* removeEntry(item[0], item[1])
                return
              }
              yield* disposeEntry(item[0], item[1], exit.value)
            }),
          { discard: true },
        )
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            draining = false
          }),
        ),
      )
    })

    const withFresh: NonNullable<Interface["withFresh"]> = (input, use) => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (
            closed ||
            draining ||
            unconfirmed.has(directory) ||
            cache.has(directory) ||
            fresh.has(directory) ||
            uncachedDisposals.has(directory)
          )
            return Option.none()
          const owner: Fresh = {
            entry: { deferred: Deferred.makeUnsafe<InstanceContext>() },
            released: Deferred.makeUnsafe<void>(),
            stop: Deferred.makeUnsafe<Effect.Effect<void>>(),
            phase: "booting",
          }
          // Cache ownership and the lease are published together, before bootstrap can yield.
          cache.set(directory, owner.entry)
          fresh.set(directory, owner)
          const worker = yield* Effect.uninterruptibleMask((restoreWorker) =>
            Effect.gen(function* () {
              const started = yield* restoreWorker(boot({ ...input, directory }, owner)).pipe(Effect.exit)
              yield* Deferred.done(owner.entry.deferred, started)
              owner.phase = "using"
              const result = yield* (
                Exit.isFailure(started)
                  ? Effect.failCause(started.cause)
                  : restoreWorker(
                      Effect.suspend(() => use(started.value)).pipe(Effect.provideService(FreshOwner, owner)),
                    )
              ).pipe(Effect.exit)
              owner.phase = "closing"
              const cleanup = yield* Effect.gen(function* () {
                if (fresh.get(directory) !== owner || cache.get(directory) !== owner.entry)
                  return yield* Effect.die(new Error("Exclusive instance ownership changed before cleanup"))
                if (owner.context) {
                  yield* Effect.promise(() => disposeInstanceConfirmed(directory))
                  yield* emitDisposed({ directory, project: owner.context.project.id })
                }
              }).pipe(Effect.exit)
              if (Exit.isFailure(cleanup)) {
                owner.phase = "failed"
                // Keep this directory quarantined without keeping a dead owner in the global shutdown queue.
                unconfirmed.add(directory)
                failedFresh.add(directory)
                if (cache.get(directory) === owner.entry) cache.delete(directory)
                if (fresh.get(directory) === owner) fresh.delete(directory)
                const refused = Exit.die(new Error("Exclusive instance cleanup was not confirmed"))
                yield* Deferred.done(owner.released, refused)
                return yield* refused
              }
              cache.delete(directory)
              fresh.delete(directory)
              yield* Deferred.succeed(owner.released, undefined)
              return yield* result
            }),
          ).pipe(Effect.interruptible, Effect.forkIn(scope, { startImmediately: true }))
          yield* Deferred.succeed(owner.stop, Fiber.interrupt(worker).pipe(Effect.asVoid))
          // Await the Exit before replaying it: beta.83's join removes its observer while dispatching an
          // interruption, which can skip a concurrent shutdown observer waiting for this same worker.
          return yield* restore(Fiber.await(worker)).pipe(
            Effect.flatMap((exit) => exit),
            Effect.map(Option.some),
            Effect.onInterrupt(() => Fiber.interrupt(worker).pipe(Effect.asVoid)),
          )
        }),
      )
    }

    const loaded = Effect.fn("InstanceStore.loaded")(function* () {
      const booting = yield* FreshBootstrap
      const caller = yield* FreshOwner
      const contexts = yield* Effect.forEach([...cache.entries()], ([directory, entry]) =>
        Effect.gen(function* () {
          const owner = fresh.get(directory)
          if (owner?.entry === entry) {
            return owner.context &&
              ((owner === booting && owner.phase === "booting") || (owner === caller && owner.phase === "using"))
              ? [owner.context]
              : []
          }
          const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
          if (Exit.isFailure(exit) || owned.has(exit.value)) return []
          return [exit.value]
        }),
      )
      return contexts.flat()
    })

    const cachedDisposeAll = yield* Effect.cachedWithTTL(disposeAllOnce(), Duration.zero)
    const disposeAll = Effect.fn("InstanceStore.disposeAll")(function* () {
      return yield* cachedDisposeAll
    })

    const provide = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      load(input).pipe(Effect.flatMap((ctx) => effect.pipe(Effect.provideService(InstanceRef, ctx))))

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true
      }).pipe(Effect.andThen(disposeAll()), Effect.ignore),
    )

    return Service.of({
      load,
      reload,
      dispose,
      disposeDirectory,
      disposeAll,
      loaded,
      withFresh,
      provide,
    })
  }),
)

export const bootstrapNode = LayerNode.unbound(InstanceBootstrap.Service, Node.tags.values.global)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [Project.node, bootstrapNode],
})

export * as InstanceStore from "./instance-store"
