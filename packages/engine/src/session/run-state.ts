import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { disposing } from "@/effect/instance-registry"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { TaskPlace } from "@/task/place"
import { TaskJobs } from "@/task/jobs"
import { InstanceRef } from "@/effect/instance-ref"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { Effect, Latch, Layer, Scope, Context, Option } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<SessionV1.WithParts>
  readonly startRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@vector/SessionRunState") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<SessionV1.WithParts>>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
          }),
        )
        return { runners, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<SessionV1.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          data.runners.delete(sessionID)
          yield* status.set(sessionID, { type: "idle" })
        }),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
      })
      data.runners.set(sessionID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy) yield* busyError(sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      // The runner stops first. Sweeping the subagents first left the parent's loop live while they unwound, so a
      // foreground task call could return its "stopped" result and the parent take another step, or launch another
      // task, after Stop. Interrupting the runner cancels the foreground task calls it is waiting on and aborts the
      // signal a launch still in progress checks; the sweep then stops the session's own job and the foreground work
      // left under it.
      if (existing) yield* existing.cancel
      else yield* settleIdle(sessionID)
      yield* cancelAttachedJobs(background, sessionID)
    })

    // With no runner nothing is running, yet a subagent's record can still say it is: the engine stopped mid-run (a
    // crash, or an update restarting it), and no job in this process will ever settle the record, so its card stays
    // live on every client. Stop settles it as cancelled. A job this process still knows owns the record and settles
    // it itself, possibly a moment from now; writing here as well could put an older status back over the one it
    // writes.
    const settleIdle = Effect.fnUntraced(function* (sessionID: SessionID) {
      yield* status.set(sessionID, { type: "idle" })
      // While Vector goes away, TaskRecovery owns the record (D.3).
      if (disposing(yield* InstanceState.directory)) return
      const info = yield* sessions.get(sessionID).pipe(Effect.option)
      if (
        yield* Option.isSome(info)
          ? TaskJobs.atLauncher(info.value)(background.get(sessionID))
          : background.get(sessionID)
      )
        return
      const record = Option.isSome(info) ? SubagentLifecycle.read(info.value) : undefined
      if (record?.status !== "queued" && record?.status !== "running") return
      yield* SubagentLifecycle.settle(sessions, sessionID, { status: "cancelled" })
      // The user stopped it, so the agent resumes it only after the user writes again (D.3).
      yield* SubagentLifecycle.update(sessions, sessionID, { stop: { by: "user", at: Date.now() } }, record.attempt)
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt)).ensureRunning(work)
    })

    const startRunning = Effect.fn("SessionRunState.startRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      const current = yield* runner(sessionID, onInterrupt)
      return yield* current
        .startRunning(work)
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ready?: Latch.Latch,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt))
        .startShell(work, ready)
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    const within = <A, E, R>(id: SessionID, effect: Effect.Effect<A, E, R>) =>
      sessions.get(id).pipe(
        Effect.option,
        Effect.andThen(() => TaskPlace.within(id)(effect)),
      )

    return Service.of({
      assertNotBusy: (id) => within(id, assertNotBusy(id)),
      cancel: (id) => within(id, cancel(id)),
      ensureRunning: (id, interrupted, work) => within(id, ensureRunning(id, interrupted, work)),
      startRunning: (id, interrupted, work) => within(id, startRunning(id, interrupted, work)),
      startShell: (id, interrupted, work, ready) => within(id, startShell(id, interrupted, work, ready)),
    })
  }),
)

const cancelAttachedJobs = Effect.fn("SessionRunState.cancelAttachedJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const entries = yield* TaskJobs.all(background)
  const jobs = entries.map((entry) => entry.info)
  // Stopping a session stops its own job and the foreground work it was waiting on. A background subagent was handed
  // off and keeps running, with everything under it: it is stopped on its own, or with the session when that is
  // deleted. A subagent that already finished can still have work of its own running, so the
  // walk follows finished jobs to their descendants and cancels only what is still running.
  const family = new Set<string>([sessionID])
  const linked = (job: BackgroundJob.Info) =>
    family.has(job.id) ||
    (typeof job.metadata?.sessionId === "string" && family.has(job.metadata.sessionId)) ||
    (job.metadata?.background !== true &&
      typeof job.metadata?.parentSessionId === "string" &&
      family.has(job.metadata.parentSessionId))
  const grow = (): void => {
    const before = family.size
    jobs.filter(linked).forEach((job) => {
      family.add(job.id)
      if (typeof job.metadata?.sessionId === "string") family.add(job.metadata.sessionId)
    })
    if (family.size > before) grow()
  }
  grow()
  yield* Effect.forEach(
    entries.filter(({ info }) => info.status === "running" && linked(info)),
    ({ info, place }) =>
      place ? background.cancel(info.id).pipe(Effect.provideService(InstanceRef, place)) : background.cancel(info.id),
    { concurrency: "unbounded", discard: true },
  )
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [BackgroundJob.node, SessionStatus.node, Session.node],
})

export * as SessionRunState from "./run-state"
