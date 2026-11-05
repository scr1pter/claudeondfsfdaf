import { GlobalBus } from "@/bus/global"
import { BackgroundJob } from "@/background/job"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceStore } from "@/project/instance-store"
import { SessionStatus } from "@/session/status"
import { Clock, Effect, Option, RcMap } from "effect"
import { LocationServiceMap } from "@vectordevai/core/location-service-map"
import { Event } from "./event"

export const emitGlobalDisposed = Effect.sync(() =>
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.Disposed.type,
      properties: {},
    },
  }),
)

export const disposeAllInstancesAndEmitGlobalDisposed = Effect.fn("Server.disposeAllInstancesAndEmitGlobalDisposed")(
  function* (options?: { swallowErrors?: boolean }) {
    const store = yield* InstanceStore.Service
    yield* Effect.gen(function* () {
      const locations = yield* Effect.serviceOption(LocationServiceMap.Service)
      if (Option.isSome(locations)) {
        const keys = yield* RcMap.keys(locations.value.rcMap)
        yield* Effect.forEach(keys, (ref) => locations.value.invalidate(ref))
      }
      yield* options?.swallowErrors
        ? disposeIdleInstances(store).pipe(
            Effect.catchCause((cause) => Effect.logWarning("global disposal failed", { cause })),
          )
        : disposeIdleInstances(store)
      yield* emitGlobalDisposed
    }).pipe(Effect.uninterruptible)
  },
)

// A global reload follows a settings change, such as a provider key, and disposing an instance stops the subagents and
// turns running in it. An instance with work still running keeps its services until that work ends, and reloads then.
// Background commands are not such work: the reload stops them.
const disposeIdleInstances = Effect.fnUntraced(function* (store: InstanceStore.Interface) {
  const background = yield* Effect.serviceOption(BackgroundJob.Service)
  const statuses = yield* Effect.serviceOption(SessionStatus.Service)
  if (Option.isNone(background) || Option.isNone(statuses)) return yield* store.disposeAll()
  const busy = (ctx: InstanceContext) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      // A background subagent that finished moments ago is still sending its report, which starts its parent's turn.
      // A running background command does not hold the reload off: a dev server has no end, and the settings this
      // reload brings, a lowered spend ceiling among them, would never apply. Disposal stops its process tree and the
      // agent is told (5.H); one that just exited still gets its note out first.
      const working = (job: BackgroundJob.Info) =>
        (job.status === "running" && job.type !== "shell") ||
        (job.metadata?.background === true && (job.completed_at ?? 0) > now - REPORT_IN_FLIGHT_MS)
      if ((yield* background.value.list()).some(working)) return true
      // A session waiting to retry a failed provider call is waiting on settings like the ones this reload brings.
      return [...(yield* statuses.value.list()).values()].some((status) => status.type !== "retry")
    }).pipe(Effect.provideService(InstanceRef, ctx))
  yield* Effect.forEach(
    yield* store.loaded(),
    Effect.fnUntraced(function* (ctx) {
      if (!(yield* busy(ctx))) return yield* store.dispose(ctx)
      yield* deferDispose(store, ctx, busy)
    }),
    { discard: true },
  )
})

// How long a finished background subagent's report takes to reach its parent session: the batching window for reports
// that finish together, then admitting the report as a prompt, which marks the session busy.
const REPORT_IN_FLIGHT_MS = 3_000

// Directories whose reload waits on their running work, so a second reload does not wait twice.
const deferred = new Set<string>()

function deferDispose(
  store: InstanceStore.Interface,
  ctx: InstanceContext,
  busy: (ctx: InstanceContext) => Effect.Effect<boolean>,
) {
  if (deferred.has(ctx.directory)) return Effect.void
  deferred.add(ctx.directory)
  const idle: Effect.Effect<void> = busy(ctx).pipe(
    Effect.flatMap((live) => (live ? Effect.sleep("1 second").pipe(Effect.andThen(idle)) : Effect.void)),
  )
  return Effect.logInfo("reloading instance once its running work ends", { directory: ctx.directory }).pipe(
    Effect.andThen(Effect.suspend(() => idle)),
    // Disposing by directory reloads whatever instance is there by then, which publishes server.instance.disposed so
    // clients refetch it.
    Effect.andThen(store.disposeDirectory(ctx.directory)),
    Effect.ensuring(Effect.sync(() => deferred.delete(ctx.directory))),
    Effect.ignore,
    Effect.forkDetach,
    Effect.asVoid,
  )
}

export * as GlobalLifecycle from "./global-lifecycle"
