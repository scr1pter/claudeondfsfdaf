import { expect } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Result } from "effect"
import { TestClock } from "effect/testing"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EventV2 } from "@vectordevai/core/event"
import { Computer } from "@vectordevai/schema/computer"
import { SessionV1 } from "@vectordevai/schema/session-v1"
import { SessionStatusEvent } from "@vectordevai/schema/session-status-event"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ComputerSession } from "@/computer/session"
import { ComputerLog } from "@/computer/log"
import { ComputerTransport } from "@/computer/transport"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(EventV2.node))
class PublishOrigin extends Context.Service<PublishOrigin, string>()("test/ComputerPublishOrigin") {}
const input: ComputerSession.Input = {
  rootSessionID: SessionID.make("ses_computer_root"),
  sessionID: SessionID.make("ses_computer_root"),
  directory: "/computer-fixture",
}
const frame = (id: string): Computer.Frame => ({
  id,
  scope: "display",
  display: "main",
  bounds: { x: 0, y: 0, w: 1920, h: 1080 },
  scale: 1,
  image: { w: 1440, h: 810 },
  at: 1,
  hash: "0123456789abcdef",
})
const desktopState = (lease: number, phase: Computer.ComputerPhase = "working"): Computer.ComputerState => ({
  phase,
  backend: "local-macos",
  mode: "foreground",
  holder: { sessionID: input.rootSessionID, directory: input.directory, title: "Task", startedAt: 0, actions: 0 },
  apps: [],
  queue: [],
  escStops: phase === "working",
  stopChord: "Control+Option+Escape",
  lease,
  reduceMotion: false,
})

function fixture<A, E, R>(
  body: (
    service: ComputerSession.Interface,
    calls: Computer.BridgeRequest[],
    audit: ComputerLog.Input[],
  ) => Effect.Effect<A, E, R>,
  heartbeat?: (lease: number) => Effect.Effect<Computer.ComputerState, ComputerTransport.ComputerError>,
  append?: ComputerLog.Interface["append"],
  cleanup?: (command: "cancel" | "release") => Effect.Effect<void, ComputerTransport.ComputerError>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const calls: Computer.BridgeRequest[] = []
      const audit: ComputerLog.Input[] = []
      const transport = ComputerTransport.Service.of({
        request: <Q extends Computer.BridgeRequest>(request: Q) =>
          Effect.gen(function* () {
            calls.push(request)
            if (request.command === "heartbeat") {
              const state = heartbeat ? yield* heartbeat(request.lease) : desktopState(request.lease)
              return { state } as ComputerTransport.Response<Q["command"]>
            }
            if (request.command !== "cancel" && request.command !== "release")
              throw new Error("Unexpected session cleanup command")
            if (cleanup) yield* cleanup(request.command)
            return { ok: true } as ComputerTransport.Response<Q["command"]>
          }),
      })
      const context = yield* Layer.build(
        ComputerSession.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ComputerTransport.Service, transport),
              Layer.mock(ComputerLog.Service, {
                append: (input) =>
                  append
                    ? append(input)
                    : Effect.sync(() => {
                        audit.push(input)
                      }),
              }),
            ),
          ),
        ),
      )
      return yield* body(Context.get(context, ComputerSession.Service), calls, audit)
    }),
  )
}

function turn(id: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      sessionID: input.rootSessionID,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    },
    parts: [],
  }
}

function computerResult(user: SessionV1.WithParts, code?: string): SessionV1.WithParts {
  const messageID = MessageID.make(`${user.info.id}_assistant`)
  return {
    info: {
      id: messageID,
      parentID: user.info.id,
      sessionID: input.rootSessionID,
      role: "assistant",
      time: { created: 2 },
      agent: "build",
      mode: "build",
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("test"),
      path: { cwd: input.directory, root: input.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: PartID.make("prt_computer_completion"),
        sessionID: input.rootSessionID,
        messageID,
        type: "tool",
        tool: "computer",
        callID: "computer_completion",
        state: {
          status: "completed",
          input: { action: "read_ui" },
          output: code ? "This app is unavailable." : "The approved app contains a table.",
          title: "Computer result",
          metadata: code ? { code } : {},
          time: { start: 2, end: 3 },
        },
      },
    ],
  }
}

it.effect("lease observation never queues behind computer work and remains held during idle cleanup", () =>
  Effect.gen(function* () {
    const releasing = yield* Deferred.make<void>()
    const released = yield* Deferred.make<void>()
    return yield* fixture(
      (sessions, calls) =>
        Effect.gen(function* () {
          const events = yield* EventV2.Service
          const user = turn("msg_before")
          expect(yield* sessions.held(input.rootSessionID)).toBe(false)
          expect(yield* sessions.completedThisTurn(input.rootSessionID, [user])).toBe(false)
          expect(calls).toHaveLength(0)
          const entered = yield* Deferred.make<void>()
          const active = yield* sessions
            .serialized(input, (state) =>
              Effect.gen(function* () {
                state.lease = 81
                yield* Deferred.succeed(entered, undefined)
                return yield* Effect.never
              }),
            )
            .pipe(Effect.result, Effect.forkChild)
          yield* Deferred.await(entered)
          expect(yield* sessions.held(input.rootSessionID)).toBe(true)
          yield* sessions.markCompleted(input.rootSessionID, user.info.id)
          const closing = yield* events
            .publish(SessionStatusEvent.Status, {
              sessionID: input.rootSessionID,
              status: { type: "idle" },
            })
            .pipe(Effect.forkChild)
          yield* Deferred.await(releasing)
          expect(yield* sessions.held(input.rootSessionID)).toBe(true)
          expect(yield* sessions.completedThisTurn(input.rootSessionID, [user])).toBe(false)
          expect(calls.map((call) => call.command)).toEqual(["cancel", "release"])
          yield* Deferred.succeed(released, undefined)
          yield* Fiber.join(closing)
          expect(Result.isFailure(yield* Fiber.join(active))).toBe(true)
          expect(yield* sessions.held(input.rootSessionID)).toBe(false)
        }),
      undefined,
      undefined,
      (command) =>
        command === "release"
          ? Deferred.succeed(releasing, undefined).pipe(Effect.andThen(Deferred.await(released)))
          : Effect.void,
    )
  }),
)

it.effect("a completed computer result survives Stop and resets only at idle or a new user turn", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const user = turn("msg_completed_turn")
      const history = [user, computerResult(user)]
      const state = yield* sessions.serialized(input, (state) =>
        Effect.sync(() => {
          state.lease = 83
          return state
        }),
      )
      expect(yield* sessions.completedThisTurn(input.rootSessionID, [user])).toBe(false)
      yield* sessions.markCompleted(input.rootSessionID, user.info.id)
      expect(yield* sessions.completedThisTurn(input.rootSessionID, [user])).toBe(true)
      yield* sessions.stop(state)
      yield* sessions.release(input.rootSessionID)
      expect(yield* sessions.held(input.rootSessionID)).toBe(false)
      expect(yield* sessions.completedThisTurn(input.rootSessionID, history)).toBe(true)
      yield* events.publish(SessionStatusEvent.Status, { sessionID: input.rootSessionID, status: { type: "idle" } })
      expect(yield* sessions.completedThisTurn(input.rootSessionID, history)).toBe(false)
      yield* sessions.markCompleted(input.rootSessionID, user.info.id)
      expect(yield* sessions.completedThisTurn(input.rootSessionID, history)).toBe(false)
      yield* events.publish(SessionStatusEvent.Status, { sessionID: input.rootSessionID, status: { type: "busy" } })
      expect(yield* sessions.completedThisTurn(input.rootSessionID, history)).toBe(false)
      const next = turn("msg_next_turn")
      expect(yield* sessions.completedThisTurn(input.rootSessionID, [...history, next])).toBe(false)
      yield* sessions.markCompleted(input.rootSessionID, next.info.id)
      expect(yield* sessions.completedThisTurn(input.rootSessionID, [...history, next])).toBe(true)
      const steered = turn("msg_steered_turn")
      expect(yield* sessions.completedThisTurn(input.rootSessionID, [...history, next, steered])).toBe(false)
      expect(calls.map((call) => call.command)).toEqual(["cancel", "release"])
    }),
  ),
)

it.effect("an unconfirmed release keeps the lease observed through the desktop engine-silence window", () =>
  fixture(
    (sessions, calls) =>
      Effect.gen(function* () {
        yield* sessions.serialized(input, (state) =>
          Effect.sync(() => {
            state.lease = 85
          }),
        )
        yield* sessions.release(input.rootSessionID)
        expect(calls.map((call) => call.command)).toEqual(["cancel", "release", "cancel", "release"])
        expect(yield* sessions.held(input.rootSessionID)).toBe(true)
        yield* TestClock.adjust(Computer.LIMITS.engineSilenceMs - 1)
        expect(yield* sessions.held(input.rootSessionID)).toBe(true)
        yield* TestClock.adjust(1)
        expect(yield* sessions.held(input.rootSessionID)).toBe(false)
      }),
    undefined,
    undefined,
    () => new ComputerTransport.ComputerError({ code: "unavailable", message: "Desktop disconnected" }),
  ),
)

it.effect("stored completed observations and refusals restore the current root turn without acquiring a lease", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      for (const code of [undefined, "denied"]) {
        const user = turn(`msg_history_${code ?? "observed"}`)
        expect(yield* sessions.completedThisTurn(input.rootSessionID, [user, computerResult(user, code)])).toBe(true)
        expect(yield* sessions.held(input.rootSessionID)).toBe(false)
      }
      const current = turn("msg_history_new")
      const completed = computerResult(current)
      const part = completed.parts[0]
      if (part.type !== "tool") throw new Error("Expected tool fixture")
      for (const state of [
        { status: "running", input: {}, time: { start: 2 } },
        { status: "error", input: {}, error: "Interrupted", time: { start: 2, end: 3 } },
      ] as const) {
        expect(
          yield* sessions.completedThisTurn(input.rootSessionID, [
            current,
            {
              ...completed,
              parts: [{ ...part, state }],
            },
          ]),
        ).toBe(false)
      }
      expect(
        yield* sessions.completedThisTurn(input.rootSessionID, [
          current,
          {
            ...completed,
            parts: [{ ...part, tool: "read" }],
          },
        ]),
      ).toBe(false)
      const other = SessionID.make("ses_other_completion")
      expect(yield* sessions.completedThisTurn(other, [current, completed])).toBe(false)
      yield* sessions.retire(input.rootSessionID)
      yield* sessions.markCompleted(input.rootSessionID, current.info.id)
      expect(yield* sessions.completedThisTurn(input.rootSessionID, [current, completed])).toBe(false)
      expect(calls).toHaveLength(0)
    }),
  ),
)

it.effect("a root keeps task state until idle, preserving conversation denials for the next task", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const deniedAt = MessageID.make("msg_denied")
      const state = yield* sessions.serialized(input, (state) =>
        Effect.sync(() => {
          state.lease = 7
          state.grants.set("macos:com.example.App", "interact")
          state.denied.add("macos:com.example.Denied")
          state.denyMentions.set("macos:com.example.Denied", deniedAt)
          state.actions = 10
          state.activeMs = 1000
          state.screenshots = 2
          state.failedMessageID = deniedAt
          for (let index = 0; index < 6; index++) ComputerSession.remember(state, frame(String(index)))
          return state
        }),
      )
      expect(state.frames.map((frame) => frame.id)).toEqual(["2", "3", "4", "5"])
      expect(yield* sessions.serialized(input, Effect.succeed)).toBe(state)
      yield* events.publish(SessionStatusEvent.Status, { sessionID: input.sessionID, status: { type: "busy" } })
      expect(calls).toHaveLength(0)
      yield* events.publish(SessionStatusEvent.Status, { sessionID: input.sessionID, status: { type: "idle" } })
      expect(calls.map((call) => call.command)).toEqual(["cancel", "release"])
      expect(calls).toMatchObject([{ lease: 7 }, { lease: 7 }])
      expect(state.signal.aborted).toBe(true)
      expect(state.lease).toBeUndefined()
      expect(state.frames).toHaveLength(0)
      expect(state.grants.size).toBe(0)
      expect(state.actions).toBe(0)
      expect(state.activeMs).toBe(0)
      expect(state.screenshots).toBe(0)
      expect(state.failedMessageID).toBeUndefined()
      const next = yield* sessions.serialized(input, Effect.succeed)
      expect(next).not.toBe(state)
      expect([...next.denied]).toEqual(["macos:com.example.Denied"])
      expect(next.denyMentions.get("macos:com.example.Denied")).toBe(deniedAt)
      expect(next.grants.size).toBe(0)
      expect(next.frames).toHaveLength(0)
      yield* sessions.release(input.rootSessionID)
    }),
  ),
)

it.effect("the deprecated idle event cannot end a successor task", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      yield* sessions.serialized(input, (state) =>
        Effect.sync(() => {
          state.lease = 1
        }),
      )
      yield* events.publish(SessionStatusEvent.Status, { sessionID: input.sessionID, status: { type: "idle" } })
      const next = yield* sessions.serialized(input, (state) =>
        Effect.sync(() => {
          state.lease = 2
          return state
        }),
      )
      yield* events.publish(SessionStatusEvent.Idle, { sessionID: input.sessionID })
      expect(next.signal.aborted).toBe(false)
      expect(next.lease).toBe(2)
      expect(calls.map((call) => call.command)).toEqual(["cancel", "release"])
      yield* sessions.release(input.rootSessionID)
    }),
  ),
)

it.effect("same-root callbacks run in FIFO order while another root can proceed", () =>
  fixture((sessions) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const order: number[] = []
      const first = yield* sessions
        .serialized(input, () =>
          Effect.gen(function* () {
            order.push(1)
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const second = yield* sessions
        .serialized(input, () =>
          Effect.sync(() => {
            order.push(2)
          }),
        )
        .pipe(Effect.forkChild)
      const third = yield* sessions
        .serialized(input, () =>
          Effect.sync(() => {
            order.push(3)
          }),
        )
        .pipe(Effect.forkChild)
      yield* TestClock.adjust(0)
      expect(order).toEqual([1])
      const other = SessionID.make("ses_other_root")
      yield* sessions.serialized({ ...input, rootSessionID: other, sessionID: other }, () =>
        Effect.sync(() => {
          order.push(9)
        }),
      )
      yield* Deferred.succeed(release, undefined)
      // Arriving immediately after release must not barge ahead of the two reserved queue positions.
      const fourth = yield* sessions
        .serialized(input, () =>
          Effect.sync(() => {
            order.push(4)
          }),
        )
        .pipe(Effect.forkChild)
      yield* Effect.all([Fiber.join(first), Fiber.join(second), Fiber.join(third), Fiber.join(fourth)])
      expect(order).toEqual([1, 9, 2, 3, 4])
      yield* sessions.release(input.rootSessionID)
      yield* sessions.release(other)
    }),
  ),
)

it.effect("idle interrupts an unanswered callback and fails queued calls from that generation", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const entered = yield* Deferred.make<ComputerSession.State>()
      const first = yield* sessions
        .serialized(input, (state) =>
          Effect.gen(function* () {
            state.lease = 11
            state.grants.set("app", "interact")
            ComputerSession.remember(state, frame("old"))
            yield* Deferred.succeed(entered, state)
            return yield* Effect.never
          }),
        )
        .pipe(Effect.result, Effect.forkChild)
      const state = yield* Deferred.await(entered)
      let queuedRan = false
      const queued = yield* sessions
        .serialized(input, () =>
          Effect.sync(() => {
            queuedRan = true
          }),
        )
        .pipe(Effect.result, Effect.forkChild)
      yield* TestClock.adjust(0)
      yield* events.publish(SessionStatusEvent.Status, { sessionID: input.sessionID, status: { type: "idle" } })
      expect(Result.isFailure(yield* Fiber.join(first))).toBe(true)
      expect(Result.isFailure(yield* Fiber.join(queued))).toBe(true)
      expect(queuedRan).toBe(false)
      expect(state.frames).toHaveLength(0)
      expect(state.grants.size).toBe(0)
      expect(calls).toMatchObject([
        { command: "cancel", lease: 11 },
        { command: "release", lease: 11 },
      ])
      expect(ComputerSession.remember(state, frame("late"))).toBe(false)
      const next = yield* sessions.serialized(input, Effect.succeed)
      expect(next.signal.aborted).toBe(false)
      expect(next.frames).toHaveLength(0)
      expect(next.lease).toBeUndefined()
      yield* sessions.release(input.rootSessionID)
    }),
  ),
)

it.effect("abort during a queued acquire cancels only that root without inventing a lease", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const controller = new AbortController()
      const entered = yield* Deferred.make<void>()
      const fiber = yield* sessions
        .serialized({ ...input, signal: controller.signal }, () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            return yield* Effect.never
          }),
        )
        .pipe(Effect.result, Effect.forkChild)
      yield* Deferred.await(entered)
      controller.abort()
      expect(Result.isFailure(yield* Fiber.join(fiber))).toBe(true)
      expect(calls).toEqual([{ v: Computer.PROTOCOL, ...input, command: "cancel" }])
    }),
  ),
)

it.effect("fiber interruption ends its root task and releases a known lease", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<ComputerSession.State>()
      const fiber = yield* sessions
        .serialized(input, (state) =>
          Effect.gen(function* () {
            state.lease = 13
            yield* Deferred.succeed(entered, state)
            return yield* Effect.never
          }),
        )
        .pipe(Effect.forkChild)
      const state = yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)
      yield* TestClock.adjust(0)
      expect(state.signal.aborted).toBe(true)
      expect(calls).toMatchObject([
        { command: "cancel", lease: 13 },
        { command: "release", lease: 13 },
      ])
    }),
  ),
)

it.effect("release captures a lease assigned while an in-flight callback unwinds", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<ComputerSession.State>()
      const response = yield* Deferred.make<void>()
      const fiber = yield* sessions
        .serialized(input, (state) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, state)
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                yield* Deferred.await(response)
                state.lease = 21
                expect(ComputerSession.remember(state, frame("late"))).toBe(false)
              }),
            )
          }),
        )
        .pipe(Effect.result, Effect.forkChild)
      const state = yield* Deferred.await(entered)
      const release = yield* sessions.release(input.rootSessionID).pipe(Effect.forkChild)
      yield* TestClock.adjust(0)
      expect(state.signal.aborted).toBe(true)
      yield* Deferred.succeed(response, undefined)
      yield* Fiber.join(release)
      expect(Result.isFailure(yield* Fiber.join(fiber))).toBe(true)
      expect(calls).toMatchObject([
        { command: "cancel", lease: 21 },
        { command: "release", lease: 21 },
      ])
      expect(state.lease).toBeUndefined()
    }),
  ),
)

it.effect("abort between completed computer calls releases the task without another call", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const controller = new AbortController()
      const state = yield* sessions.serialized({ ...input, signal: controller.signal }, (state) =>
        Effect.sync(() => {
          state.lease = 23
          state.grants.set("app", "interact")
          return state
        }),
      )
      controller.abort()
      yield* TestClock.adjust(0)
      expect(state.signal.aborted).toBe(true)
      expect(state.grants.size).toBe(0)
      expect(state.lease).toBeUndefined()
      expect(calls).toMatchObject([
        { command: "cancel", lease: 23 },
        { command: "release", lease: 23 },
      ])
    }),
  ),
)

it.effect("completed invocation aborts preserve the task frame until its real run ends", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const run = new AbortController()
      const first = new AbortController()
      const state = yield* sessions.serialized({ ...input, signal: run.signal, callSignal: first.signal }, (state) =>
        Effect.sync(() => {
          state.lease = 24
          state.grants.set("app", "interact")
          ComputerSession.remember(state, frame("frame-between-requests"))
          return state
        }),
      )
      first.abort()
      yield* TestClock.adjust(0)
      expect(state.signal.aborted).toBe(false)
      expect(calls).toHaveLength(0)
      const second = new AbortController()
      const next = yield* sessions.serialized(
        { ...input, signal: run.signal, callSignal: second.signal },
        Effect.succeed,
      )
      expect(next).toBe(state)
      expect(next.lease).toBe(24)
      expect(next.frames.map((value) => value.id)).toEqual(["frame-between-requests"])
      expect(next.grants.get("app")).toBe("interact")
      second.abort()
      yield* TestClock.adjust(0)
      expect(state.signal.aborted).toBe(false)
      expect(calls).toHaveLength(0)
      run.abort()
      yield* TestClock.adjust(0)
      expect(state.signal.aborted).toBe(true)
      expect(state.frames).toHaveLength(0)
      expect(state.grants.size).toBe(0)
      expect(calls).toMatchObject([
        { command: "cancel", lease: 24 },
        { command: "release", lease: 24 },
      ])
    }),
  ),
)

it.effect("an invocation aborted while unfinished retires its task and releases its lease", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const run = new AbortController()
      const call = new AbortController()
      const entered = yield* Deferred.make<ComputerSession.State>()
      const worker = yield* sessions
        .serialized({ ...input, signal: run.signal, callSignal: call.signal }, (state) =>
          Effect.gen(function* () {
            state.lease = 25
            yield* Deferred.succeed(entered, state)
            return yield* Effect.never
          }),
        )
        .pipe(Effect.result, Effect.forkChild)
      const state = yield* Deferred.await(entered)
      call.abort()
      expect(Result.isFailure(yield* Fiber.join(worker))).toBe(true)
      expect(run.signal.aborted).toBe(false)
      expect(state.signal.aborted).toBe(true)
      expect(state.lease).toBeUndefined()
      expect(calls).toMatchObject([
        { command: "cancel", lease: 25 },
        { command: "release", lease: 25 },
      ])
    }),
  ),
)

it.effect("a pre-aborted call and a child session cannot start a task", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const controller = new AbortController()
      controller.abort()
      let ran = false
      const callback = () =>
        Effect.sync(() => {
          ran = true
        })
      const aborted = yield* sessions.serialized({ ...input, signal: controller.signal }, callback).pipe(Effect.result)
      const child = yield* sessions
        .serialized({ ...input, sessionID: SessionID.make("ses_child") }, callback)
        .pipe(Effect.result)
      expect(Result.isFailure(aborted)).toBe(true)
      expect(Result.isFailure(child)).toBe(true)
      expect(ran).toBe(false)
      expect(calls).toHaveLength(0)
    }),
  ),
)

it.effect("a root cannot move a live lease into another workspace", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const state = yield* sessions.serialized(input, (state) =>
        Effect.sync(() => {
          state.lease = 25
          return state
        }),
      )
      const result = yield* sessions
        .serialized({ ...input, directory: "/other-workspace" }, () => Effect.die("must not enter"))
        .pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      expect(state.lease).toBe(25)
      expect(state.signal.aborted).toBe(false)
      yield* sessions.release(input.rootSessionID)
      expect(calls).toMatchObject([{ directory: input.directory }, { directory: input.directory }])
    }),
  ),
)

it.effect("closing the service releases task state and its desktop lease", () =>
  Effect.gen(function* () {
    const result = yield* fixture((sessions, calls) =>
      Effect.gen(function* () {
        const state = yield* sessions.serialized(input, (state) =>
          Effect.sync(() => {
            state.lease = 31
            return state
          }),
        )
        return { state, calls }
      }),
    )
    expect(result.state.signal.aborted).toBe(true)
    expect(result.state.lease).toBeUndefined()
    expect(result.calls).toMatchObject([
      { command: "cancel", lease: 31 },
      { command: "release", lease: 31 },
    ])
  }),
)

it.effect("frame invalidation clears screen observations without waiting for FIFO or ending the task", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      yield* sessions.invalidate(SessionID.make("ses_unknown"))
      yield* sessions.serialized(input, (state) =>
        Effect.gen(function* () {
          ComputerSession.remember(state, frame("full"))
          state.lastScreenText = "Screen instructions"
          state.lastInspect = {
            app: {
              platform: "macos",
              bundleId: "com.example.App",
              apple: false,
              system: false,
              verified: true,
              name: "App",
            },
            category: "general",
            pid: 1,
            window: { id: "window", title: "Screen window" },
            clipboard: { agentOwned: true },
          }
          state.lease = 33
          state.visible.push(state.lastInspect.app)
          state.grants.set("app", "interact")
          // The callback still holds the FIFO; processor invalidation must never wait for it.
          yield* sessions.invalidate(input.rootSessionID)
          expect(state.frames).toHaveLength(0)
          expect(state.visible).toHaveLength(0)
          expect(state.lastScreenText).toBeUndefined()
          expect(state.lastInspect).toBeUndefined()
          expect(state.signal.aborted).toBe(false)
          expect(state.lease).toBe(33)
          expect(state.grants.get("app")).toBe("interact")
          expect(calls).toHaveLength(0)
        }),
      )
      yield* sessions.release(input.rootSessionID)
    }),
  ),
)

it.effect("one task heartbeat survives individual calls and keeps its originating publish context", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const published: { origin: string; phase: Computer.ComputerPhase }[] = []
      const publish = (desktop: Computer.ComputerState) =>
        Effect.gen(function* () {
          published.push({ origin: yield* PublishOrigin, phase: desktop.phase })
        })
      const state = yield* sessions.serialized(input, (state) =>
        Effect.gen(function* () {
          state.lease = 41
          yield* sessions.start(state, publish).pipe(Effect.provideService(PublishOrigin, "first workspace"))
          return state
        }),
      )
      yield* sessions.serialized(input, (state) =>
        sessions.start(state, publish).pipe(Effect.provideService(PublishOrigin, "later caller")),
      )
      yield* TestClock.adjust(1999)
      expect(calls).toHaveLength(0)
      yield* TestClock.adjust(1)
      expect(calls.map((call) => call.command)).toEqual(["heartbeat"])
      yield* TestClock.adjust(2000)
      expect(published).toEqual([
        { origin: "first workspace", phase: "working" },
        { origin: "first workspace", phase: "working" },
      ])
      expect(yield* ComputerSession.elapsed(state)).toBe(4000)
      yield* sessions.release(input.rootSessionID)
      yield* TestClock.adjust(4000)
      expect(calls.map((call) => call.command)).toEqual(["heartbeat", "heartbeat", "cancel", "release"])
    }),
  ),
)

it.effect("act and heartbeat state reports share the one-second publication throttle", () =>
  fixture((sessions) =>
    Effect.gen(function* () {
      const published: Computer.ComputerState[] = []
      const state = yield* sessions.serialized(input, (state) =>
        Effect.gen(function* () {
          state.lease = 43
          yield* sessions.start(state, (desktop) => Effect.sync(() => void published.push(desktop)))
          return state
        }),
      )
      yield* sessions.report(state, desktopState(43))
      yield* sessions.report(state, desktopState(43, "asking"))
      yield* TestClock.adjust(999)
      yield* sessions.report(state, desktopState(43, "paused"))
      expect(published.map((desktop) => desktop.phase)).toEqual(["working"])
      yield* TestClock.adjust(1)
      yield* sessions.report(state, desktopState(43, "paused"))
      expect(published.map((desktop) => desktop.phase)).toEqual(["working", "paused"])
      yield* TestClock.adjust(1000)
      expect(published.map((desktop) => desktop.phase)).toEqual(["working", "paused", "working"])
      yield* sessions.release(input.rootSessionID)
    }),
  ),
)

it.effect("active time includes thinking between calls and excludes nested waits and desktop pauses", () => {
  const desktop = { phase: "working" as Computer.ComputerPhase }
  return fixture(
    (sessions) =>
      Effect.gen(function* () {
        const state = yield* sessions.serialized(input, (state) =>
          Effect.gen(function* () {
            state.lease = 45
            yield* sessions.start(state, () => Effect.void)
            return state
          }),
        )
        yield* TestClock.adjust(1000)
        expect(yield* ComputerSession.elapsed(state)).toBe(1000)
        yield* ComputerSession.waiting(
          state,
          Effect.gen(function* () {
            yield* TestClock.adjust(2000)
            yield* ComputerSession.waiting(state, TestClock.adjust(3000))
            yield* TestClock.adjust(1000)
          }),
        )
        expect(yield* ComputerSession.elapsed(state)).toBe(1000)
        yield* TestClock.adjust(1000)
        expect(yield* ComputerSession.elapsed(state)).toBe(2000)
        desktop.phase = "paused"
        yield* sessions.report(state, desktopState(45, "paused"))
        yield* TestClock.adjust(5000)
        expect(yield* ComputerSession.elapsed(state)).toBe(2000)
        desktop.phase = "working"
        yield* ComputerSession.resume(state)
        yield* TestClock.adjust(1000)
        expect(yield* ComputerSession.elapsed(state)).toBe(3000)
        yield* sessions.release(input.rootSessionID)
      }),
    (lease) => Effect.succeed(desktopState(lease, desktop.phase)),
  )
})

it.effect("answering an ask cannot clear a take-over pause reported while it was waiting", () => {
  const desktop = { phase: "working" as Computer.ComputerPhase }
  return fixture(
    (sessions) =>
      Effect.gen(function* () {
        const state = yield* sessions.serialized(input, (state) =>
          Effect.gen(function* () {
            state.lease = 47
            yield* sessions.start(state, () => Effect.void)
            return state
          }),
        )
        yield* TestClock.adjust(500)
        yield* ComputerSession.waiting(
          state,
          Effect.gen(function* () {
            desktop.phase = "paused"
            yield* sessions.report(state, desktopState(47, "paused"))
            yield* TestClock.adjust(2500)
          }),
        )
        expect(state.desktopWaiting).toBe(true)
        yield* TestClock.adjust(3000)
        expect(yield* ComputerSession.elapsed(state)).toBe(500)
        desktop.phase = "working"
        yield* ComputerSession.resume(state)
        yield* TestClock.adjust(1000)
        expect(yield* ComputerSession.elapsed(state)).toBe(1500)
        yield* sessions.release(input.rootSessionID)
      }),
    (lease) => Effect.succeed(desktopState(lease, desktop.phase)),
  )
})

it.effect("answering a pending desktop ask counts the resumed action time", () =>
  fixture((sessions) =>
    Effect.gen(function* () {
      const state = yield* sessions.serialized(input, (state) =>
        Effect.gen(function* () {
          state.lease = 48
          yield* sessions.start(state, () => Effect.void)
          return state
        }),
      )
      yield* TestClock.adjust(100)
      yield* sessions.report(state, desktopState(48, "asking"))
      yield* ComputerSession.waiting(state, TestClock.adjust(500))
      expect(state.desktopWaiting).toBe(false)
      yield* TestClock.adjust(400)
      expect(yield* ComputerSession.elapsed(state)).toBe(500)
      yield* sessions.release(input.rootSessionID)
    }),
  ),
)

it.effect("Stop from inside the FIFO aborts the task without waiting for its own worker", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const result = yield* sessions
        .serialized(input, (state) =>
          Effect.gen(function* () {
            state.lease = 49
            yield* sessions.start(state, () => Effect.void)
            yield* sessions.stop(state)
            return "must not finish successfully"
          }),
        )
        .pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      expect(calls.map((call) => call.command)).toEqual(["cancel", "release"])
    }),
  ),
)

it.effect("a heartbeat failure stops the task and releases its known lease", () =>
  fixture(
    (sessions, calls) =>
      Effect.gen(function* () {
        const state = yield* sessions.serialized(input, (state) =>
          Effect.gen(function* () {
            state.lease = 51
            yield* sessions.start(state, () => Effect.void)
            return state
          }),
        )
        yield* TestClock.adjust(2000)
        yield* sessions.release(input.rootSessionID)
        expect(state.signal.aborted).toBe(true)
        expect(state.lease).toBeUndefined()
        expect(calls.map((call) => call.command)).toEqual(["heartbeat", "cancel", "release"])
      }),
    () => Effect.fail(new ComputerTransport.ComputerError({ code: "unavailable", message: "Disconnected" })),
  ),
)

for (const mismatch of ["lease", "holder"] as const) {
  it.effect(`a mismatched ${mismatch} state stops the task before it can be published`, () =>
    fixture((sessions) =>
      Effect.gen(function* () {
        const published: Computer.ComputerState[] = []
        const state = yield* sessions.serialized(input, (state) =>
          Effect.gen(function* () {
            state.lease = 53
            yield* sessions.start(state, (desktop) => Effect.sync(() => void published.push(desktop)))
            return state
          }),
        )
        const desktop = desktopState(mismatch === "lease" ? 54 : 53)
        const result = yield* sessions
          .report(
            state,
            mismatch === "holder"
              ? { ...desktop, holder: { ...desktop.holder!, sessionID: "ses_other_holder" } }
              : desktop,
          )
          .pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        expect(published).toHaveLength(0)
        yield* sessions.release(input.rootSessionID)
        expect(state.signal.aborted).toBe(true)
      }),
    ),
  )
}

it.effect("late reports and Resume cannot publish or restart an aborted generation", () =>
  fixture((sessions) =>
    Effect.gen(function* () {
      const published: Computer.ComputerState[] = []
      const state = yield* sessions.serialized(input, (state) =>
        Effect.gen(function* () {
          state.lease = 55
          yield* sessions.start(state, (desktop) => Effect.sync(() => void published.push(desktop)))
          return state
        }),
      )
      yield* sessions.release(input.rootSessionID)
      const result = yield* sessions.report(state, desktopState(55)).pipe(Effect.result)
      yield* ComputerSession.resume(state)
      expect(Result.isFailure(result)).toBe(true)
      expect(published).toHaveLength(0)
      expect(state.desktopWaiting).toBe(true)
      expect(state.activeSince).toBeUndefined()
    }),
  ),
)

it.effect("control transitions are audited independently of publication and without screen labels", () =>
  fixture((sessions, calls, audit) =>
    Effect.gen(function* () {
      const published: Computer.ComputerState[] = []
      const state = yield* sessions.serialized(input, (state) =>
        Effect.gen(function* () {
          state.lease = 61
          yield* sessions.start(state, (desktop) => Effect.sync(() => void published.push(desktop)))
          return state
        }),
      )
      yield* sessions.report(state, desktopState(61))
      const paused = {
        ...desktopState(61, "paused"),
        pause: "input" as const,
        step: "Private window title",
        secureInputHolder: "Private credential application",
      }
      yield* sessions.report(state, paused)
      yield* sessions.report(state, paused)
      yield* sessions.report(state, { ...paused, pause: "button" })
      yield* sessions.report(state, desktopState(61, "handoff"))
      yield* sessions.report(state, desktopState(61))
      expect(published).toHaveLength(1)
      expect(audit.map((entry) => [entry.call, entry.decision, entry.target])).toEqual([
        ["control", "take_over", "input"],
        ["control", "take_over", "button"],
        ["control", "handoff", "handoff"],
        ["control", "resume", "working"],
      ])
      const stopped = yield* sessions.report(state, desktopState(61, "stopped")).pipe(Effect.result)
      expect(Result.isFailure(stopped)).toBe(true)
      yield* sessions.release(input.rootSessionID)
      expect(audit.map((entry) => entry.decision)).toEqual([
        "take_over",
        "take_over",
        "handoff",
        "resume",
        "stop",
        "release",
      ])
      expect(audit.every((entry) => entry.rootSessionID === input.rootSessionID)).toBe(true)
      expect(JSON.stringify(audit)).not.toContain("Private")
      expect(calls.map((call) => call.command)).toEqual(["cancel", "release"])
    }),
  ),
)

it.effect("heartbeats record take-over and resume while no tool call is running", () => {
  const desktop = { phase: "paused" as Computer.ComputerPhase }
  return fixture(
    (sessions, calls, audit) =>
      Effect.gen(function* () {
        yield* sessions.serialized(input, (state) =>
          Effect.gen(function* () {
            state.lease = 63
            yield* sessions.start(state, () => Effect.void)
          }),
        )
        yield* TestClock.adjust(4000)
        expect(calls.map((call) => call.command)).toEqual(["heartbeat", "heartbeat"])
        expect(audit.map((entry) => entry.decision)).toEqual(["take_over"])
        desktop.phase = "handoff"
        yield* TestClock.adjust(2000)
        desktop.phase = "working"
        yield* TestClock.adjust(2000)
        expect(audit.map((entry) => entry.decision)).toEqual(["take_over", "handoff", "resume"])
        yield* sessions.release(input.rootSessionID)
      }),
    (lease) => Effect.succeed(desktopState(lease, desktop.phase)),
  )
})

it.effect("an audit failure during a live transition stops and releases the desktop", () =>
  fixture(
    (sessions, calls) =>
      Effect.gen(function* () {
        const state = yield* sessions.serialized(input, (state) =>
          Effect.sync(() => {
            state.lease = 65
            return state
          }),
        )
        const result = yield* sessions.report(state, desktopState(65, "paused")).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure.message).toBe("The local action record is unavailable.")
        yield* sessions.release(input.rootSessionID)
        expect(state.signal.aborted).toBe(true)
        expect(state.lease).toBeUndefined()
        expect(calls.map((call) => call.command)).toEqual(["cancel", "release"])
      }),
    undefined,
    () => new ComputerLog.Error({ code: "failed", message: "The local action record is unavailable." }),
  ),
)

it.effect("cleanup releases input before waiting on a bounded audit write", () =>
  fixture(
    (sessions, calls) =>
      Effect.gen(function* () {
        const state = yield* sessions.serialized(input, (state) =>
          Effect.sync(() => {
            state.lease = 67
            return state
          }),
        )
        const closing = yield* sessions.release(input.rootSessionID).pipe(Effect.forkChild)
        yield* TestClock.adjust(0)
        expect(calls.map((call) => call.command)).toEqual(["cancel", "release"])
        yield* TestClock.adjust(5000)
        yield* Fiber.join(closing)
        expect(state.lease).toBeUndefined()
      }),
    undefined,
    () => Effect.never,
  ),
)

it.effect("retiring a root blocks new calls while cleanup drains and also blocks cold reacquisition", () =>
  fixture((sessions, calls, audit) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<ComputerSession.State>()
      const draining = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const active = yield* sessions
        .serialized(input, (state) =>
          Effect.gen(function* () {
            state.lease = 69
            yield* Deferred.succeed(entered, state)
            return yield* Effect.never.pipe(
              Effect.ensuring(Deferred.succeed(draining, undefined).pipe(Effect.andThen(Deferred.await(finish)))),
            )
          }),
        )
        .pipe(Effect.result, Effect.forkChild)
      const state = yield* Deferred.await(entered)
      const retiring = yield* sessions.retire(input.rootSessionID).pipe(Effect.forkChild)
      yield* Deferred.await(draining)
      const called = { value: false }
      const next = yield* sessions
        .serialized(input, () =>
          Effect.sync(() => {
            called.value = true
          }),
        )
        .pipe(Effect.result)
      expect(Result.isFailure(next)).toBe(true)
      expect(called.value).toBe(false)
      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(retiring)
      expect(Result.isFailure(yield* Fiber.join(active))).toBe(true)
      expect(state.signal.aborted).toBe(true)
      expect(calls.map((call) => call.command)).toEqual(["cancel", "release"])
      expect(audit).toHaveLength(0)
      const cold = SessionID.make("ses_cold_deleted")
      yield* sessions.retire(cold)
      const missing = yield* sessions
        .serialized({ ...input, rootSessionID: cold, sessionID: cold }, () =>
          Effect.sync(() => {
            called.value = true
          }),
        )
        .pipe(Effect.result)
      expect(Result.isFailure(missing)).toBe(true)
      expect(called.value).toBe(false)
      expect(calls).toHaveLength(2)
    }),
  ),
)

it.effect("a known lease releases input before joining an uninterruptible journal worker", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const flushed = yield* Deferred.make<void>()
    const append: ComputerLog.Interface["append"] = (entry) =>
      entry.decision === "executed"
        ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(flushed)), Effect.uninterruptible)
        : Effect.void
    return yield* fixture(
      (sessions, calls) =>
        Effect.gen(function* () {
          const active = yield* sessions
            .serialized(input, (state) =>
              Effect.gen(function* () {
                state.lease = 71
                yield* append({
                  rootSessionID: input.rootSessionID,
                  call: "mouse",
                  decision: "executed",
                  step: { index: 0, action: "mouse_down" },
                })
              }),
            )
            .pipe(Effect.result, Effect.forkChild)
          yield* Deferred.await(entered)
          const closing = yield* sessions.release(input.rootSessionID).pipe(Effect.forkChild)
          yield* TestClock.adjust(0)
          expect(calls.map((call) => call.command)).toEqual(["cancel", "release"])
          yield* Deferred.succeed(flushed, undefined)
          yield* Fiber.join(closing)
          expect(Result.isFailure(yield* Fiber.join(active))).toBe(true)
          expect(calls.map((call) => call.command)).toEqual(["cancel", "release"])
        }),
      undefined,
      append,
    )
  }),
)

it.effect("a terminal report stops before journal I/O and paused journal time is not active time", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const flushed = yield* Deferred.make<void>()
    return yield* fixture(
      (sessions, calls) =>
        Effect.gen(function* () {
          const state = yield* sessions.serialized(input, (state) =>
            Effect.gen(function* () {
              state.lease = 73
              yield* sessions.start(state, () => Effect.void)
              return state
            }),
          )
          yield* TestClock.adjust(100)
          const pause = yield* sessions
            .report(state, { ...desktopState(73, "paused"), pause: "input" })
            .pipe(Effect.result, Effect.forkChild)
          yield* Deferred.await(entered)
          yield* TestClock.adjust(500)
          expect(state.desktopWaiting).toBe(true)
          expect(yield* ComputerSession.elapsed(state)).toBe(100)
          const stopped = yield* sessions.report(state, desktopState(73, "stopped")).pipe(Effect.result)
          expect(Result.isFailure(stopped)).toBe(true)
          expect(state.signal.aborted).toBe(true)
          yield* TestClock.adjust(0)
          expect(calls.map((call) => call.command)).toEqual(["cancel", "release"])
          yield* Deferred.succeed(flushed, undefined)
          expect(Result.isFailure(yield* Fiber.join(pause))).toBe(true)
          yield* sessions.release(input.rootSessionID)
          expect(calls.map((call) => call.command)).toEqual(["cancel", "release"])
        }),
      undefined,
      () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(flushed)), Effect.uninterruptible),
    )
  }),
)
