import { expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Result, Scope } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { InstanceState } from "@/effect/instance-state"
import { registerDisposer } from "@/effect/instance-registry"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

// The store, cache, bootstrap scheduling and registry disposal are genuine. This
// reference only lets each fixture pause its own bootstrap at an observable gate.
const Bootstrap = Context.Reference<Effect.Effect<void>>("test/InstanceStore/Bootstrap", {
  defaultValue: () => Effect.void,
})
const storeLayer = AppNodeBuilder.build(LayerNode.group([InstanceStore.node, CrossSpawnSpawner.node]), [
  [
    InstanceStore.bootstrapNode,
    Layer.succeed(InstanceBootstrap.Service, { run: Effect.flatMap(Bootstrap, (run) => run) }),
  ],
])
const it = testEffect(storeLayer)
const selection = Effect.gen(function* () {
  const directory = yield* tmpdirScoped()
  const home = yield* InstanceState.context
  return { directory, worktree: directory, project: home.project }
})
function fresh(store: InstanceStore.Interface) {
  if (!store.withFresh) throw new Error("Missing real exclusive instance port")
  return store.withFresh
}
const disposer = (directory: string, action: Effect.Effect<void>) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      registerDisposer((current) => (current === directory ? Effect.runPromise(action) : Promise.resolve())),
    ),
    (off) => Effect.sync(off),
  )
const isolated = Effect.gen(function* () {
  const lifetime = yield* Scope.make()
  const services = yield* Layer.build(Layer.fresh(storeLayer)).pipe(Effect.provideService(Scope.Scope, lifetime))
  const close = Scope.close(lifetime, Exit.void)
  yield* Effect.addFinalizer(() => close.pipe(Effect.ignoreCause))
  return { store: Context.get(services, InstanceStore.Service), close }
})

it.instance(
  "a waiting loaded snapshot hides retired leases and cannot authorize disposing a later shared instance",
  () =>
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      const slow = yield* selection
      const target = yield* selection
      const leased = yield* selection
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const leasedEntered = yield* Deferred.make<void>()
      const releaseLease = yield* Deferred.make<void>()
      let disposed = 0
      yield* disposer(
        target.directory,
        Effect.sync(() => {
          disposed++
        }),
      )
      const boot = Effect.gen(function* () {
        const current = yield* InstanceState.context
        if (current.directory !== slow.directory) return
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
      })
      yield* Effect.gen(function* () {
        const pending = yield* store
          .load(slow)
          .pipe(Effect.provideService(Bootstrap, boot), Effect.forkChild({ startImmediately: true }))
        yield* awaitWithTimeout(Deferred.await(entered), "Slow bootstrap did not enter")
        const owner = yield* fresh(store)(leased, (context) =>
          Deferred.succeed(leasedEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseLease)),
            Effect.as(context),
          ),
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* awaitWithTimeout(Deferred.await(leasedEntered), "Exclusive snapshot fixture did not enter")
        const listing = yield* store.loaded().pipe(Effect.forkChild({ startImmediately: true }))
        const shared = yield* store.load(target)
        yield* Deferred.succeed(releaseLease, undefined)
        const retired = yield* Fiber.join(owner)
        if (Option.isNone(retired)) throw new Error("Exclusive snapshot fixture was not admitted")
        yield* Deferred.succeed(release, undefined)
        const snapshot = yield* Fiber.join(listing)
        expect(snapshot.some((ctx) => ctx === shared)).toBe(false)
        expect(snapshot.some((ctx) => ctx === retired.value)).toBe(false)
        expect(Option.isNone(yield* fresh(store)(target, () => Effect.die("Occupied callback ran")))).toBe(true)
        expect(yield* store.load(target)).toBe(shared)
        expect(disposed).toBe(0)
        yield* store.dispose(shared)
        expect(disposed).toBe(1)
        yield* store.dispose(yield* Fiber.join(pending))
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.ensuring(Deferred.succeed(releaseLease, undefined)),
      )
    }),
)

it.instance("an exclusive bootstrap may resolve only its own live context without recursively awaiting itself", () =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const input = yield* selection
    let bootstraps = 0
    const boot = Effect.gen(function* () {
      const context = yield* InstanceState.context
      bootstraps++
      expect(yield* store.load(input)).toBe(context)
      expect((yield* store.loaded()).includes(context)).toBe(true)
    })
    const result = yield* awaitWithTimeout(
      fresh(store)(input, (context) => Effect.succeed(context)).pipe(Effect.provideService(Bootstrap, boot)),
      "Exclusive bootstrap recursion did not settle",
    )
    expect(Option.isSome(result)).toBe(true)
    expect(bootstraps).toBe(1)
    expect((yield* store.loaded()).some((context) => context.directory === input.directory)).toBe(false)
  }),
)

it.instance("an ordinary bootstrap already pending in this directory is occupied before any exclusive effect", () =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const input = yield* selection
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const boot = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
    yield* Effect.gen(function* () {
      const loading = yield* store
        .load(input)
        .pipe(Effect.provideService(Bootstrap, boot), Effect.forkChild({ startImmediately: true }))
      yield* awaitWithTimeout(Deferred.await(entered), "Ordinary bootstrap did not enter")
      expect(Option.isNone(yield* fresh(store)(input, () => Effect.die("Pending ordinary instance was adopted")))).toBe(
        true,
      )
      yield* Deferred.succeed(release, undefined)
      const context = yield* Fiber.join(loading)
      expect(yield* store.load(input)).toBe(context)
      yield* store.dispose(context)
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
  }),
)

it.instance("callback failure preserves its failure and finishes its own cleanup once before a fresh admission", () =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const input = yield* selection
    let disposed = 0
    yield* disposer(
      input.directory,
      Effect.sync(() => {
        disposed++
      }),
    )
    const failed = yield* fresh(store)(input, () => Effect.fail("expected callback failure")).pipe(Effect.result)
    expect(Result.isFailure(failed)).toBe(true)
    if (Result.isSuccess(failed)) throw new Error("Expected callback failure was lost")
    expect(failed.failure).toBe("expected callback failure")
    expect(disposed).toBe(1)
    expect(Option.isSome(yield* fresh(store)(input, () => Effect.succeed("new")))).toBe(true)
    expect(disposed).toBe(2)
  }),
)

for (const operation of ["load", "reload"] as const) {
  it.instance(`${operation} during exclusive use receives a later instance only after confirmed disposal`, () =>
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      const input = yield* selection
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const cleanup = yield* Deferred.make<void>()
      const clean = yield* Deferred.make<void>()
      const events: string[] = []
      yield* disposer(
        input.directory,
        Effect.gen(function* () {
          events.push("cleanup-enter")
          yield* Deferred.succeed(cleanup, undefined)
          yield* Deferred.await(clean)
          events.push("cleanup-finish")
        }),
      )
      yield* Effect.gen(function* () {
        const owner = yield* fresh(store)(input, (context) =>
          Effect.gen(function* () {
            expect((yield* store.loaded()).includes(context)).toBe(true)
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return context
          }),
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* awaitWithTimeout(Deferred.await(entered), "Exclusive callback did not enter")
        expect((yield* store.loaded()).some((context) => context.directory === input.directory)).toBe(false)
        const borrower = yield* store[operation](input).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              events.push("ordinary-return")
            }),
          ),
          Effect.forkChild({ startImmediately: true }),
        )
        yield* Deferred.succeed(release, undefined)
        yield* awaitWithTimeout(Deferred.await(cleanup), "Actual registry cleanup did not enter")
        expect(events).toEqual(["cleanup-enter"])
        yield* Deferred.succeed(clean, undefined)
        const original = yield* Fiber.join(owner)
        const current = yield* Fiber.join(borrower)
        if (Option.isNone(original)) throw new Error("Fresh instance was not admitted")
        expect(current).not.toBe(original.value)
        expect(events).toEqual(["cleanup-enter", "cleanup-finish", "ordinary-return"])
        // A retained old context must not dispose the subsequent ordinary context.
        yield* store.dispose(original.value)
        expect(yield* store.load(input)).toBe(current)
        yield* store.dispose(current)
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.ensuring(Deferred.succeed(clean, undefined)),
      )
    }),
  )
}

it.instance("caller cancellation joins the callback finalizer and confirmed disposer before lending again", () =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const input = yield* selection
    const entered = yield* Deferred.make<void>()
    const finalizing = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    const events: string[] = []
    yield* disposer(
      input.directory,
      Effect.sync(() => {
        events.push("disposed")
      }),
    )
    yield* Effect.gen(function* () {
      const owner = yield* fresh(store)(input, () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(finalizing, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.tap(() =>
                Effect.sync(() => {
                  events.push("joined")
                }),
              ),
            ),
          ),
        ),
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* awaitWithTimeout(Deferred.await(entered), "Exclusive callback did not enter")
      const cancelling = yield* Fiber.interrupt(owner).pipe(Effect.forkChild({ startImmediately: true }))
      yield* awaitWithTimeout(Deferred.await(finalizing), "Owner finalizer did not run on cancellation")
      expect(Option.isNone(yield* fresh(store)(input, () => Effect.die("Cancelled lease was reused early")))).toBe(true)
      expect(events).toEqual([])
      yield* Deferred.succeed(finish, undefined)
      yield* awaitWithTimeout(Fiber.join(cancelling), "Cancellation did not join its actual disposer")
      expect(events).toEqual(["joined", "disposed"])
      expect(Option.isSome(yield* fresh(store)(input, () => Effect.succeed("new")))).toBe(true)
    }).pipe(Effect.ensuring(Deferred.succeed(finish, undefined)))
  }),
)

it.instance("global disposal cancels and joins an active owner before reloading the directory", () =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const input = yield* selection
    const entered = yield* Deferred.make<void>()
    const events: string[] = []
    yield* disposer(
      input.directory,
      Effect.sync(() => {
        events.push("disposed")
      }),
    )
    const owner = yield* fresh(store)(input, () =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            events.push("joined")
          }),
        ),
      ),
    ).pipe(Effect.forkChild({ startImmediately: true }))
    yield* awaitWithTimeout(Deferred.await(entered), "Exclusive callback did not enter")
    yield* awaitWithTimeout(store.disposeAll(), "Global disposal did not cancel and join its owner")
    expect(Exit.hasInterrupts(yield* Fiber.await(owner))).toBe(true)
    expect(events).toEqual(["joined", "disposed"])
    expect(Option.isSome(yield* fresh(store)(input, () => Effect.succeed("new")))).toBe(true)
  }),
)

it.instance("closing the real store scope interrupts its owner and forbids late bootstrap", () =>
  Effect.gen(function* () {
    const { store, close } = yield* isolated
    const input = yield* selection
    const entered = yield* Deferred.make<void>()
    const events: string[] = []
    yield* disposer(
      input.directory,
      Effect.sync(() => {
        events.push("disposed")
      }),
    )
    const owner = yield* fresh(store)(input, () =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            events.push("joined")
          }),
        ),
      ),
    ).pipe(Effect.forkChild({ startImmediately: true }))
    yield* awaitWithTimeout(Deferred.await(entered), "Exclusive callback did not enter")
    yield* awaitWithTimeout(close, "Store shutdown did not join its actual owner")
    expect(Exit.hasInterrupts(yield* Fiber.await(owner))).toBe(true)
    expect(events).toEqual(["joined", "disposed"])
    expect(Exit.isFailure(yield* store.load(input).pipe(Effect.exit))).toBe(true)
    expect(Option.isNone(yield* fresh(store)(input, () => Effect.die("Closed store admitted a callback")))).toBe(true)
  }),
)

it.instance("a rejecting disposer quarantines its directory without poisoning store shutdown", () =>
  Effect.gen(function* () {
    const { store, close } = yield* isolated
    const input = yield* selection
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    yield* disposer(input.directory, Effect.die(new Error("DISPOSER_PRIVATE_DIAGNOSTIC")))
    const owner = yield* fresh(store)(input, () =>
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Effect.forkChild({ startImmediately: true }))
    yield* awaitWithTimeout(Deferred.await(entered), "Exclusive callback did not enter")
    const waiter = yield* store.load(input).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
    yield* Deferred.succeed(release, undefined)
    const failed = yield* Fiber.await(owner)
    expect(Exit.isFailure(failed)).toBe(true)
    expect(
      Exit.isFailure(yield* awaitWithTimeout(Fiber.join(waiter), "Unconfirmed cleanup did not wake its waiter")),
    ).toBe(true)
    expect(Exit.isFailure(yield* store.load(input).pipe(Effect.exit))).toBe(true)
    expect(Exit.isFailure(yield* store.reload(input).pipe(Effect.exit))).toBe(true)
    expect(Option.isNone(yield* fresh(store)(input, () => Effect.die("Failed lease was reused")))).toBe(true)
    expect((yield* store.loaded()).some((context) => context.directory === input.directory)).toBe(false)
    expect(Exit.isSuccess(yield* close.pipe(Effect.exit))).toBe(true)
  }),
)

it.instance("global disposal continues through an exclusive cleanup failure to every other owner", () =>
  Effect.gen(function* () {
    const { store, close } = yield* isolated
    const bad = yield* selection
    const good = yield* selection
    const entered = yield* Deferred.make<void>()
    const ready = yield* Deferred.make<void>()
    let cleaned = false
    yield* disposer(bad.directory, Effect.die(new Error("PRIVATE_DISPOSER_REJECTION")))
    yield* disposer(good.directory, Effect.sync(() => { cleaned = true }))
    const first = yield* fresh(store)(bad, () =>
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    ).pipe(Effect.forkChild({ startImmediately: true }))
    yield* awaitWithTimeout(Deferred.await(entered), "First owner did not enter")
    const second = yield* fresh(store)(good, () =>
      Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)),
    ).pipe(Effect.forkChild({ startImmediately: true }))
    yield* awaitWithTimeout(Deferred.await(ready), "Second owner did not enter")
    yield* awaitWithTimeout(store.disposeAll(), "A failed owner blocked another owner's disposal")
    expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true)
    expect(Exit.hasInterrupts(yield* Fiber.await(second))).toBe(true)
    expect(cleaned).toBe(true)
    expect(Option.isNone(yield* fresh(store)(bad, () => Effect.die("Failed directory was lent")))).toBe(true)
    expect(Option.isSome(yield* fresh(store)(good, () => Effect.succeed("fresh")))).toBe(true)
    yield* close
  }),
)

it.instance("legacy ordinary disposal keeps its result while a rejected disposer quarantines fresh admission", () =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const input = yield* selection
    const context = yield* store.load(input)
    let called = 0
    yield* disposer(
      input.directory,
      Effect.sync(() => {
        called++
      }).pipe(Effect.andThen(Effect.die(new Error("PRIVATE_DISPOSER_REJECTION")))),
    )
    expect(Exit.isSuccess(yield* store.dispose(context).pipe(Effect.exit))).toBe(true)
    expect(called).toBe(1)
    expect((yield* store.loaded()).some((current) => current === context)).toBe(false)
    expect(Option.isNone(yield* fresh(store)(input, () => Effect.die("Unconfirmed ordinary cleanup was reused")))).toBe(
      true,
    )
    // Preserve the legacy external load contract; it does not attest exclusive freshness.
    const ordinary = yield* store.load(input)
    expect(ordinary).not.toBe(context)
    yield* store.dispose(ordinary)
  }),
)

it.instance("failed ordinary bootstrap cannot make its partial resources look like a fresh directory", () =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const input = yield* selection
    let initialized = false
    let disposed = 0
    yield* disposer(
      input.directory,
      Effect.sync(() => {
        disposed++
      }),
    )
    const boot = Effect.sync(() => {
      initialized = true
    }).pipe(Effect.andThen(Effect.die(new Error("PARTIAL_BOOT_FAILURE"))))
    expect(Exit.isFailure(yield* store.load(input).pipe(Effect.provideService(Bootstrap, boot), Effect.exit))).toBe(
      true,
    )
    expect(initialized).toBe(true)
    expect(disposed).toBe(0)
    expect((yield* store.loaded()).some((context) => context.directory === input.directory)).toBe(false)
    expect(Option.isNone(yield* fresh(store)(input, () => Effect.die("Partial failed bootstrap was reused")))).toBe(
      true,
    )
    const ordinary = yield* store.load(input)
    yield* store.dispose(ordinary)
    expect(disposed).toBe(1)
  }),
)
