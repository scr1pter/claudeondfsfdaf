import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Scope } from "effect"
import { makeGlobalNode } from "@vectordevai/core/effect/app-node"
import { EventV2 } from "@vectordevai/core/event"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import { Computer } from "@vectordevai/schema/computer"
import { SessionV1 } from "@vectordevai/schema/session-v1"
import { SessionStatusEvent } from "@vectordevai/schema/session-status-event"
import type { MessageID, SessionID } from "@/session/schema"
import { ComputerLog } from "./log"
import { ComputerTransport } from "./transport"

export type Input = {
  rootSessionID: SessionID
  sessionID: SessionID
  directory: string
  /** Owns the whole attended task, including time between individual computer calls. */
  signal?: AbortSignal
  /** Cancels this invocation only; its listener ends when the serialized call returns. */
  callSignal?: AbortSignal
}

/** One task generation. Action state belongs to the FIFO; the heartbeat also updates its control clock. */
export type State = {
  lease?: number
  frames: Computer.Frame[]
  /** Observed identities in the latest full frame, including desktop Always grants absent from the local cache. */
  visible: Computer.AppIdentity[]
  grants: Map<string, Computer.AskLevel>
  /** Conversation lifetime, shared by successive task generations. */
  denied: Set<string>
  denyMentions: Map<string, MessageID>
  actions: number
  activeMs: number
  activeSince?: number
  waiting: number
  desktopWaiting: boolean
  desktopPhase?: Computer.ComputerPhase
  nextActions?: number
  nextActiveMs?: number
  screenshots: number
  failedMessageID?: MessageID
  lastScreenText?: string
  lastInspect?: Computer.InspectResult
  readonly signal: AbortSignal
}

export interface Interface {
  /** Nonblocking observation of the root's active or draining desktop lease; never creates a task. */
  readonly held: (rootSessionID: SessionID) => Effect.Effect<boolean>
  /** Called after a computer tool result is durably completed, including observation and refusal outputs. */
  readonly markCompleted: (rootSessionID: SessionID, userMessageID: MessageID) => Effect.Effect<void>
  /** Current user-turn completion, with stored root history as the restart fallback. */
  readonly completedThisTurn: (
    rootSessionID: SessionID,
    history: readonly SessionV1.WithParts[],
  ) => Effect.Effect<boolean>
  readonly serialized: <A, E, R>(
    input: Input,
    use: (state: State) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ComputerTransport.ComputerError, R>
  /** Drop remembered coordinates immediately without creating a task or waiting behind its FIFO. */
  readonly invalidate: (rootSessionID: SessionID) => Effect.Effect<void>
  /** Start once after acquire; the task owns this heartbeat across individual tool calls. */
  readonly start: <R>(
    state: State,
    onState: (state: Computer.ComputerState) => Effect.Effect<void, never, R>,
  ) => Effect.Effect<void, ComputerTransport.ComputerError, R>
  readonly report: (
    state: State,
    desktop: Computer.ComputerState,
  ) => Effect.Effect<void, ComputerTransport.ComputerError>
  /** Safe within serialized: signal Stop now; the task watcher drains workers and releases the lease. */
  readonly stop: (state: State) => Effect.Effect<void>
  /** Call outside serialized: it aborts and waits for the current callback to unwind. */
  readonly release: (rootSessionID: SessionID) => Effect.Effect<void>
  /** Retire before deleting a session so queued or concurrent calls cannot acquire a successor lease. */
  readonly retire: (rootSessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@vector/ComputerSession") {}
export const use = serviceUse(Service)

type Task = {
  state: State
  controller: AbortController
  input: Omit<Input, "signal" | "callSignal">
  signals: Set<AbortSignal>
  workers: Set<Fiber.Fiber<unknown, unknown>>
  abort: () => void
  heartbeat?: Fiber.Fiber<void, never>
  publish?: (state: Computer.ComputerState) => Effect.Effect<void>
  publishedAt?: number
  control: { queue: Deferred.Deferred<void>[]; key?: string; waiting: boolean }
  reported: number
  stopCode?: Computer.ComputerErrorCode
  stopPhase?: Computer.ComputerPhase
  closing?: Deferred.Deferred<void>
}
type Root = {
  queue: Deferred.Deferred<void>[]
  denied: Set<string>
  denyMentions: Map<string, MessageID>
  task?: Task
  closing?: Deferred.Deferred<void>
  closingTask?: Task
  unconfirmedUntil?: number
}

/** Zoom images never enter this full-frame ring. A stopped generation cannot install a late frame. */
export function remember(state: State, frame: Computer.Frame) {
  if (state.signal.aborted) return false
  state.frames.push(frame)
  if (state.frames.length > 4) state.frames.splice(0, state.frames.length - 4)
  return true
}

export function invalidate(state: State) {
  state.frames.length = 0
  state.visible.length = 0
  state.lastScreenText = undefined
  state.lastInspect = undefined
}

/** Settle the task clock before observing a threshold or changing a wait state. */
export const elapsed = Effect.fn("ComputerSession.elapsed")(function* (state: State) {
  const now = yield* Clock.currentTimeMillis
  if (state.activeSince !== undefined) {
    if (state.waiting === 0 && !state.desktopWaiting && !state.signal.aborted)
      state.activeMs += Math.max(0, now - state.activeSince)
    state.activeSince = now
  }
  return state.activeMs
})

/** Nested permission and question waits must not subtract the same time twice. */
export function waiting<A, E, R>(state: State, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    elapsed(state).pipe(
      Effect.map(() => {
        state.waiting++
      }),
    ),
    () => effect,
    (_, exit) =>
      elapsed(state).pipe(
        Effect.andThen(
          Effect.sync(() => {
            state.waiting--
            // Answering our ask cannot clear a physical take-over or a handoff reported during it.
            if (Exit.isSuccess(exit) && state.waiting === 0 && state.desktopPhase === "asking")
              state.desktopWaiting = false
          }),
        ),
      ),
  )
}

/** A desktop-confirmed Resume begins a new active interval without charging the paused interval. */
export const resume = Effect.fn("ComputerSession.resume")(function* (state: State) {
  yield* elapsed(state)
  if (state.signal.aborted) return
  state.desktopWaiting = false
  state.desktopPhase = "working"
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const transport = yield* ComputerTransport.Service
    const log = yield* ComputerLog.Service
    const events = yield* EventV2.Service
    const scope = yield* Scope.Scope
    // The desktop lock belongs to a root conversation across directories, not to an InstanceState scope.
    const roots = new Map<SessionID, Root>()
    const retired = new Set<SessionID>()
    const tasks = new WeakMap<State, Task>()
    const completed = new Map<SessionID, MessageID>()
    const closed = new Map<SessionID, MessageID>()
    const idle = new Set<SessionID>()

    const held = Effect.fn("ComputerSession.held")(function* (rootSessionID: SessionID) {
      const root = roots.get(rootSessionID)
      if (root?.task?.state.lease !== undefined || root?.closingTask?.state.lease !== undefined) return true
      if (root?.unconfirmedUntil === undefined) return false
      return (yield* Clock.currentTimeMillis) < root.unconfirmedUntil
    })

    const markCompleted = Effect.fn("ComputerSession.markCompleted")(
      (rootSessionID: SessionID, userMessageID: MessageID) =>
        Effect.sync(() => {
          // A completion draining after idle or deletion belongs to the turn that already ended.
          if (retired.has(rootSessionID) || idle.has(rootSessionID)) return
          completed.set(rootSessionID, userMessageID)
          closed.delete(rootSessionID)
        }),
    )

    const completedThisTurn = Effect.fn("ComputerSession.completedThisTurn")(
      (rootSessionID: SessionID, history: readonly SessionV1.WithParts[]) =>
        Effect.sync(() => {
          if (retired.has(rootSessionID) || idle.has(rootSessionID)) return false
          const user = history.findLast(
            (message) => message.info.sessionID === rootSessionID && message.info.role === "user",
          )
          if (!user) return completed.has(rootSessionID)
          if (completed.get(rootSessionID) === user.info.id) return true
          completed.delete(rootSessionID)
          if (closed.get(rootSessionID) === user.info.id) return false
          const found = history.some(
            (message) =>
              message.info.sessionID === rootSessionID &&
              message.info.role === "assistant" &&
              message.info.parentID === user.info.id &&
              message.parts.some(
                (part) => part.type === "tool" && part.tool === "computer" && part.state.status === "completed",
              ),
          )
          if (found) completed.set(rootSessionID, user.info.id)
          return found
        }),
    )

    const finish = Effect.fn("ComputerSession.finish")(function* (root: Root, task: Task) {
      if (task.closing) return yield* Deferred.await(task.closing)
      if (root.task !== task) return
      const closing = yield* Deferred.make<void>()
      task.closing = closing
      root.closing = closing
      root.closingTask = task
      root.task = undefined
      for (const signal of task.signals) signal.removeEventListener("abort", task.abort)
      task.signals.clear()
      const wasStopped = task.state.signal.aborted
      task.controller.abort()
      const envelope = { v: Computer.PROTOCOL, ...task.input } as const
      const cleanup = (lease?: number) =>
        Effect.gen(function* () {
          yield* transport.request({ ...envelope, command: "cancel", ...(lease === undefined ? {} : { lease }) }).pipe(
            Effect.interruptible,
            Effect.timeout("5 seconds"),
            Effect.catchCause(() => Effect.void),
          )
          if (lease === undefined) return false
          return yield* transport.request({ ...envelope, command: "release", lease }).pipe(
            Effect.interruptible,
            Effect.timeout("5 seconds"),
            Effect.as(true),
            Effect.catchCause(() => Effect.succeed(false)),
          )
        })
      // A journal's native append may be uninterruptible. Release any known held input before joining its worker.
      const immediateLease = task.state.lease
      const released = immediateLease === undefined ? false : yield* cleanup(immediateLease)
      if (task.heartbeat) yield* Fiber.interrupt(task.heartbeat)
      task.state.grants.clear()
      invalidate(task.state)
      yield* Fiber.interruptAll(task.workers)
      // Aborting the generation interrupts an unanswered ask or acquire before waiting for its FIFO holder.
      // Wait for that holder to unwind so a response already received cannot install a lease after cleanup.
      yield* exclusive(
        root,
        Effect.gen(function* () {
          const lease = task.state.lease
          // An acquire can settle with a lease during interruption. Clean that lease after its worker has joined.
          const confirmed = !released || lease !== immediateLease ? yield* cleanup(lease) : true
          // A disconnected release can leave the desktop holding input until its engine-silence watchdog fires.
          // Keep UI shell commands gated through that window without delaying cleanup or ordinary shell commands.
          if (lease !== undefined && !confirmed)
            root.unconfirmedUntil = (yield* Clock.currentTimeMillis) + Computer.LIMITS.engineSilenceMs
          if (confirmed) root.unconfirmedUntil = undefined
          // Input is released first. An unavailable audit disk must never strand the desktop lease.
          // A retired conversation is being deleted; do not append after its deletion barrier.
          if (!retired.has(task.input.rootSessionID))
            yield* Effect.gen(function* () {
              if (wasStopped)
                yield* log.append({
                  rootSessionID: task.input.rootSessionID,
                  call: "control",
                  decision: "stop",
                  code: task.stopCode ?? "stopped",
                  ...(task.stopPhase ? { target: task.stopPhase } : {}),
                })
              yield* log.append({ rootSessionID: task.input.rootSessionID, call: "control", decision: "release" })
            }).pipe(
              Effect.interruptible,
              Effect.timeout("5 seconds"),
              Effect.catchCause(() => Effect.void),
            )
          task.state.lease = undefined
          task.state.grants.clear()
          invalidate(task.state)
          task.state.actions = 0
          task.state.activeMs = 0
          task.state.activeSince = undefined
          task.state.desktopWaiting = true
          task.state.screenshots = 0
          task.state.failedMessageID = undefined
        }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            root.closing = undefined
            root.closingTask = undefined
            Deferred.doneUnsafe(closing, Effect.void)
          }),
        ),
      )
    }, Effect.uninterruptible)

    const release = Effect.fn("ComputerSession.release")(function* (rootSessionID: SessionID) {
      const root = roots.get(rootSessionID)
      if (!root) return
      if (root.task) return yield* finish(root, root.task)
      if (root.closing) yield* Deferred.await(root.closing)
    })

    const retire = Effect.fn("ComputerSession.retire")(function* (rootSessionID: SessionID) {
      retired.add(rootSessionID)
      completed.delete(rootSessionID)
      closed.delete(rootSessionID)
      idle.delete(rootSessionID)
      yield* release(rootSessionID)
    })

    const invalidateRoot = Effect.fn("ComputerSession.invalidate")((rootSessionID: SessionID) =>
      Effect.sync(() => {
        const task = roots.get(rootSessionID)?.task
        if (task) invalidate(task.state)
      }),
    )

    const stop = Effect.fn("ComputerSession.stop")((state: State) =>
      Effect.sync(() => {
        const task = tasks.get(state)
        if (!task) return
        task.stopCode ??= "stopped"
        task.abort()
      }),
    )

    const report = Effect.fn("ComputerSession.report")(function* (state: State, desktop: Computer.ComputerState) {
      const task = tasks.get(state)
      if (!task || state.signal.aborted) return yield* stopped()
      if (desktop.lease !== state.lease || (desktop.holder && desktop.holder.sessionID !== task.input.rootSessionID)) {
        task.stopCode = "changed"
        task.abort()
        return yield* stopped()
      }
      yield* elapsed(state)
      if (state.signal.aborted) return yield* stopped()
      state.desktopPhase = desktop.phase
      state.desktopWaiting = ["asking", "handoff", "paused", "waiting"].includes(desktop.phase)
      const version = ++task.reported
      if (["off", "setup", "ready", "done", "stopped"].includes(desktop.phase)) {
        task.stopPhase = desktop.phase
        task.stopCode ??= "stopped"
        task.abort()
        // Stop is effective before publication or audit. A slow listener cannot delay input cleanup.
        const now = yield* Clock.currentTimeMillis
        if (task.publish && (task.publishedAt === undefined || now - task.publishedAt >= 1000)) {
          task.publishedAt = now
          yield* task.publish(desktop).pipe(
            Effect.interruptible,
            Effect.timeout("1 second"),
            Effect.catchCause(() => Effect.void),
            Effect.forkIn(scope),
          )
        }
        return yield* stopped()
      }
      // Audit transitions independently of the UI publication throttle, including between tool calls.
      yield* exclusive(
        task.control,
        Effect.gen(function* () {
          if (state.signal.aborted || retired.has(task.input.rootSessionID)) return yield* stopped()
          const key = `${desktop.phase}:${desktop.pause ?? ""}`
          if (task.control.key === key) return
          const decision: ComputerLog.Input["decision"] | undefined =
            desktop.phase === "paused" || desktop.phase === "waiting"
              ? "take_over"
              : desktop.phase === "handoff"
                ? "handoff"
                : desktop.phase === "working" && task.control.waiting
                  ? "resume"
                  : undefined
          if (decision)
            yield* log
              .append({
                rootSessionID: task.input.rootSessionID,
                call: "control",
                decision,
                // Both values are closed protocol enums. Never record state labels, details, titles or icons.
                target: desktop.pause ?? desktop.phase,
              })
              .pipe(
                Effect.timeoutOrElse({
                  duration: "5 seconds",
                  orElse: () =>
                    new ComputerTransport.ComputerError({
                      code: "failed",
                      message: "The local action record is unavailable.",
                    }),
                }),
                Effect.mapError(
                  () =>
                    new ComputerTransport.ComputerError({
                      code: "failed",
                      message: "The local action record is unavailable.",
                    }),
                ),
                Effect.onError(() =>
                  Effect.sync(() => {
                    if (!state.signal.aborted) task.stopCode = "failed"
                    task.abort()
                  }),
                ),
              )
          task.control.key = key
          if (decision === "take_over" || decision === "handoff") task.control.waiting = true
          if (decision === "resume") task.control.waiting = false
        }),
      )
      if (state.signal.aborted) return yield* stopped()
      if (task.reported !== version) return
      const now = yield* Clock.currentTimeMillis
      if (state.signal.aborted) return yield* stopped()
      if (task.publish && (task.publishedAt === undefined || now - task.publishedAt >= 1000)) {
        task.publishedAt = now
        yield* task.publish(desktop)
      }
      if (state.signal.aborted) return yield* stopped()
    })

    const start: Interface["start"] = Effect.fn("ComputerSession.start")(function* <R>(
      state: State,
      onState: (state: Computer.ComputerState) => Effect.Effect<void, never, R>,
    ) {
      const task = tasks.get(state)
      if (!task || state.lease === undefined || state.signal.aborted) return yield* stopped()
      if (task.heartbeat) return
      const context = yield* Effect.context<R>()
      task.publish = (desktop) => onState(desktop).pipe(Effect.provide(context))
      state.activeSince = yield* Clock.currentTimeMillis
      const lease = state.lease
      const heartbeat = Effect.gen(function* () {
        yield* Effect.sleep(Computer.LIMITS.heartbeatMs)
        const reply = yield* transport.request(
          { v: Computer.PROTOCOL, ...task.input, command: "heartbeat", lease },
          { signal: state.signal },
        )
        yield* report(state, reply.state)
      }).pipe(
        Effect.forever,
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const error = Cause.findErrorOption(cause)
            if (!Cause.hasInterrupts(cause))
              task.stopCode ??=
                Option.isSome(error) && error.value instanceof ComputerTransport.ComputerError
                  ? error.value.code
                  : "failed"
            task.abort()
          }),
        ),
      )
      task.heartbeat = yield* heartbeat.pipe(Effect.forkIn(scope))
      if (state.signal.aborted) {
        yield* Fiber.interrupt(task.heartbeat)
        return yield* stopped()
      }
    })

    const serialized: Interface["serialized"] = Effect.fn("ComputerSession.serialized")(function* <A, E, R>(
      input: Input,
      run: (state: State) => Effect.Effect<A, E, R>,
    ) {
      if (input.rootSessionID !== input.sessionID)
        return yield* new ComputerTransport.ComputerError({
          code: "unavailable",
          message: "Computer use requires the attended root conversation.",
        })
      if (retired.has(input.rootSessionID)) return yield* stopped()
      if (input.signal?.aborted || input.callSignal?.aborted) return yield* stopped()
      const root: Root =
        roots.get(input.rootSessionID) ??
        ({
          queue: [],
          denied: new Set<string>(),
          denyMentions: new Map<string, MessageID>(),
        } satisfies Root)
      roots.set(input.rootSessionID, root)
      if (root.closing) yield* Deferred.await(root.closing)
      if (retired.has(input.rootSessionID)) return yield* stopped()
      if (input.signal?.aborted || input.callSignal?.aborted) return yield* stopped()
      const fresh = !root.task
      if (!root.task) {
        const controller = new AbortController()
        root.task = {
          controller,
          abort: () => controller.abort(),
          signals: new Set(),
          workers: new Set(),
          control: { queue: [], waiting: false },
          reported: 0,
          input: { rootSessionID: input.rootSessionID, sessionID: input.sessionID, directory: input.directory },
          state: {
            frames: [],
            visible: [],
            grants: new Map(),
            denied: root.denied,
            denyMentions: root.denyMentions,
            actions: 0,
            activeMs: 0,
            waiting: 0,
            desktopWaiting: false,
            screenshots: 0,
            signal: controller.signal,
          },
        }
        tasks.set(root.task.state, root.task)
      }
      const task = root.task
      // A turn may abort while the model is thinking between computer calls. Keep watching until task cleanup.
      if (fresh)
        yield* aborted(task.state.signal).pipe(
          Effect.catch(() => finish(root, task)),
          Effect.forkIn(scope),
        )
      if (task.input.directory !== input.directory)
        return yield* new ComputerTransport.ComputerError({
          code: "failed",
          message: "The computer task belongs to another workspace.",
        })
      // Capture the generation before queueing. A call already queued when the task ends cannot join its successor.
      if (input.signal && !task.signals.has(input.signal)) {
        task.signals.add(input.signal)
        input.signal.addEventListener("abort", task.abort, { once: true })
      }
      if (input.signal?.aborted) task.abort()
      // Provider request controllers also abort on normal stream closure. They can stop unfinished
      // work, but cannot retire a completed call's lease/frame while the next model request starts.
      const callSignal = input.callSignal !== input.signal ? input.callSignal : undefined
      callSignal?.addEventListener("abort", task.abort, { once: true })
      if (callSignal?.aborted) task.abort()
      return yield* Effect.acquireUseRelease(
        exclusive(
          root,
          Effect.suspend(
            (): Effect.Effect<A, E | ComputerTransport.ComputerError, R> =>
              task.state.signal.aborted ? stopped() : run(task.state),
          ),
        ).pipe(
          // acquireUseRelease masks its acquisition; the callback itself must remain interruptible.
          Effect.interruptible,
          Effect.forkChild,
          Effect.tap((worker) =>
            Effect.sync(() => {
              task.workers.add(worker)
            }),
          ),
        ),
        (worker) =>
          Effect.gen(function* () {
            const result = yield* Fiber.await(worker)
            if (task.state.signal.aborted) return yield* stopped()
            return yield* result
          }),
        (worker, exit) =>
          Effect.gen(function* () {
            if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) task.abort()
            yield* Fiber.interrupt(worker)
            task.workers.delete(worker)
            if (task.state.signal.aborted) yield* finish(root, task)
          }),
      ).pipe(Effect.ensuring(Effect.sync(() => callSignal?.removeEventListener("abort", task.abort))))
    })

    const unsubscribe = yield* events.listen((event) => {
      if (event.type === SessionV1.Event.Deleted.type) {
        const data = event.data
        if (typeof data !== "object" || data === null || !("sessionID" in data) || typeof data.sessionID !== "string")
          return Effect.void
        return retire(data.sessionID as SessionID)
      }
      // SessionStatus publishes a deprecated Idle event after Status; consuming both could stop a new task.
      if (event.type !== SessionStatusEvent.Status.type) return Effect.void
      const data = event.data
      if (
        typeof data !== "object" ||
        data === null ||
        !("status" in data) ||
        typeof data.status !== "object" ||
        data.status === null ||
        !("type" in data.status)
      )
        return Effect.void
      if (!("sessionID" in data) || typeof data.sessionID !== "string") return Effect.void
      const sessionID = data.sessionID as SessionID
      if (data.status.type === "busy") {
        idle.delete(sessionID)
        return Effect.void
      }
      if (data.status.type !== "idle") return Effect.void
      idle.add(sessionID)
      const userMessageID = completed.get(sessionID)
      if (userMessageID) closed.set(sessionID, userMessageID)
      completed.delete(sessionID)
      return release(sessionID)
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...roots.values()],
        (root) => (root.task ? finish(root, root.task) : root.closing ? Deferred.await(root.closing) : Effect.void),
        { discard: true },
      ),
    )
    return Service.of({
      held,
      markCompleted,
      completedThisTurn,
      serialized,
      invalidate: invalidateRoot,
      start,
      report,
      stop,
      release,
      retire,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [ComputerTransport.node, ComputerLog.node, EventV2.node],
})

/** Tickets reserve their position until exit, including the interval before an awakened waiter runs. */
function exclusive<A, E, R>(root: Pick<Root, "queue">, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const ticket = Deferred.makeUnsafe<void>()
      root.queue.push(ticket)
      if (root.queue.length === 1) Deferred.doneUnsafe(ticket, Effect.void)
      return ticket
    }),
    (ticket) => Deferred.await(ticket).pipe(Effect.andThen(effect)),
    (ticket) =>
      Effect.sync(() => {
        const index = root.queue.indexOf(ticket)
        if (index < 0) return
        root.queue.splice(index, 1)
        if (index === 0 && root.queue[0]) Deferred.doneUnsafe(root.queue[0], Effect.void)
      }),
  )
}

function stopped() {
  return new ComputerTransport.ComputerError({ code: "stopped", message: "The computer task was stopped." })
}

function aborted(signal: AbortSignal) {
  return Effect.callback<never, ComputerTransport.ComputerError>((resume) => {
    const stop = () => resume(stopped())
    if (signal.aborted) return stop()
    signal.addEventListener("abort", stop, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", stop))
  })
}

export * as ComputerSession from "./session"
