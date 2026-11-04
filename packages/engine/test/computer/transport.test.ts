import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Computer } from "@vectordevai/schema/computer"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { ComputerTransport } from "@/computer/transport"
import { testEffect } from "../lib/effect"

const envelope = { v: Computer.PROTOCOL, rootSessionID: "root", sessionID: "session", directory: "/fixture" } as const
const key: Computer.Step = { kind: "key", combo: ["ArrowDown"], repeat: 1, holdMs: 10_000 }
const act = { ...envelope, command: "act", lease: 1, steps: [key], settleMs: 0 } as const
const state: Computer.ComputerState = {
  phase: "working",
  backend: "local-macos",
  mode: "foreground",
  apps: [],
  queue: [],
  escStops: true,
  stopChord: "Control+Escape",
  lease: 1,
  reduceMotion: false,
}
const acted = { done: 1, state }

function fixture(handler: (input: Computer.BridgeRequest) => Effect.Effect<unknown>) {
  const calls: { input: Computer.BridgeRequest; signal: AbortSignal; request: HttpClientRequest.HttpClientRequest }[] =
    []
  const http = HttpClient.make((request, _url, signal) =>
    Effect.suspend(() => {
      if (request.body._tag !== "Uint8Array") throw new Error("Expected a JSON request")
      const input = Schema.decodeUnknownSync(Schema.fromJsonString(Computer.BridgeRequest))(
        new TextDecoder().decode(request.body.body),
      )
      calls.push({ input, signal, request })
      return handler(input).pipe(Effect.map((body) => HttpClientResponse.fromWeb(request, Response.json(body))))
    }),
  )
  return {
    calls,
    it: testEffect(ComputerTransport.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)))),
  }
}

function environment<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  values: { url?: string; token?: string } = {
    url: "http://127.0.0.1:45100",
    token: "transport-clock-fixture",
  },
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = { url: process.env.VECTOR_COMPUTER_BRIDGE_URL, token: process.env.VECTOR_COMPUTER_BRIDGE_TOKEN }
      if (values.url === undefined) delete process.env.VECTOR_COMPUTER_BRIDGE_URL
      else process.env.VECTOR_COMPUTER_BRIDGE_URL = values.url
      if (values.token === undefined) delete process.env.VECTOR_COMPUTER_BRIDGE_TOKEN
      else process.env.VECTOR_COMPUTER_BRIDGE_TOKEN = values.token
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous.url === undefined) delete process.env.VECTOR_COMPUTER_BRIDGE_URL
        else process.env.VECTOR_COMPUTER_BRIDGE_URL = previous.url
        if (previous.token === undefined) delete process.env.VECTOR_COMPUTER_BRIDGE_TOKEN
        else process.env.VECTOR_COMPUTER_BRIDGE_TOKEN = previous.token
      }),
  )
}

function error<A>(exit: Exit.Exit<A, ComputerTransport.ComputerError>) {
  if (Exit.isSuccess(exit)) throw new Error("Expected a computer error")
  return Option.getOrThrow(Cause.findErrorOption(exit.cause))
}

test("act deadline sums requested waits, input budgets, settle, capture and slack (INV-R4)", () => {
  expect(ComputerTransport.actDeadline([{ kind: "wait", ms: 30_000 }, { kind: "wait", ms: 20_000 }, key], 500)).toBe(
    95_500,
  )
})

const batch = fixture(() => Effect.as(Effect.sleep(300_000), acted))
batch.it.effect("a ten-step batch remains live beyond a five-minute HTTP default", () =>
  environment(
    Effect.gen(function* () {
      const transport = yield* ComputerTransport.Service
      const steps = [...Array.from({ length: 9 }, (): Computer.Step => ({ kind: "wait", ms: 30_000 })), key]
      const finished = { value: false }
      const fiber = yield* transport.request({ ...act, steps, settleMs: 500 }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            finished.value = true
          }),
        ),
        Effect.forkChild,
      )
      yield* TestClock.adjust(299_999)
      expect(finished.value).toBe(false)
      expect(batch.calls).toHaveLength(1)
      expect(batch.calls[0].signal.aborted).toBe(false)
      yield* TestClock.adjust(1)
      expect(yield* Fiber.join(fiber)).toEqual(acted)
      expect(batch.calls.map((call) => call.input.command)).toEqual(["act"])
    }),
  ),
)

const timeout = fixture((input) => (input.command === "cancel" ? Effect.succeed({ ok: true }) : Effect.never))
timeout.it.effect("an act timeout disconnects the request and sends one authenticated cancel", () =>
  environment(
    Effect.gen(function* () {
      const transport = yield* ComputerTransport.Service
      const fiber = yield* transport.request(act).pipe(Effect.exit, Effect.forkChild)
      yield* TestClock.adjust(ComputerTransport.actDeadline(act.steps, act.settleMs))
      expect(error(yield* Fiber.join(fiber)).code).toBe("timeout")
      expect(timeout.calls.map((call) => call.input.command)).toEqual(["act", "cancel"])
      expect(timeout.calls[0].signal.aborted).toBe(true)
      expect(timeout.calls[1].input).toEqual({ ...envelope, command: "cancel", lease: 1 })
      expect(timeout.calls[1].request.headers.authorization).toBe("Bearer transport-clock-fixture")
      expect(timeout.calls[1].request.headers[Computer.BRIDGE.protocolHeader.toLowerCase()]).toBe("1")
    }),
  ),
)

const aborted = fixture((input) => (input.command === "cancel" ? Effect.succeed({ ok: true }) : Effect.never))
aborted.it.effect("ctx.abort cancels an in-flight act without waiting for its deadline", () =>
  environment(
    Effect.gen(function* () {
      const transport = yield* ComputerTransport.Service
      const controller = new AbortController()
      const fiber = yield* transport.request(act, { signal: controller.signal }).pipe(Effect.exit, Effect.forkChild)
      yield* TestClock.adjust(0)
      expect(aborted.calls).toHaveLength(1)
      controller.abort()
      expect(error(yield* Fiber.join(fiber)).code).toBe("stopped")
      expect(aborted.calls.map((call) => call.input.command)).toEqual(["act", "cancel"])
      expect(aborted.calls[0].signal.aborted).toBe(true)
    }),
  ),
)

const interrupted = fixture((input) => (input.command === "cancel" ? Effect.succeed({ ok: true }) : Effect.never))
interrupted.it.effect("interrupting the parent fiber still sends cancel before it ends", () =>
  environment(
    Effect.gen(function* () {
      const transport = yield* ComputerTransport.Service
      const fiber = yield* transport.request(act).pipe(Effect.forkChild)
      yield* TestClock.adjust(0)
      expect(interrupted.calls).toHaveLength(1)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(interrupted.calls.map((call) => call.input.command)).toEqual(["act", "cancel"])
      expect(interrupted.calls[0].signal.aborted).toBe(true)
    }),
  ),
)

const hungCancel = fixture(() => Effect.never)
hungCancel.it.effect("a stalled cancel has a five-second cleanup limit and never recurses", () =>
  environment(
    Effect.gen(function* () {
      const transport = yield* ComputerTransport.Service
      const fiber = yield* transport.request(act).pipe(Effect.exit, Effect.forkChild)
      yield* TestClock.adjust(ComputerTransport.actDeadline(act.steps, act.settleMs))
      expect(hungCancel.calls.map((call) => call.input.command)).toEqual(["act", "cancel"])
      yield* TestClock.adjust(5_000)
      expect(error(yield* Fiber.join(fiber)).code).toBe("timeout")
      expect(hungCancel.calls).toHaveLength(2)
      expect(hungCancel.calls[1].signal.aborted).toBe(true)
    }),
  ),
)

for (const command of ["awaitControl", "handoff"] as const) {
  const waiting = fixture((input) => (input.command === "cancel" ? Effect.succeed({ ok: true }) : Effect.never))
  waiting.it.effect(`${command} has no overall deadline and ends only when cancelled`, () =>
    environment(
      Effect.gen(function* () {
        const transport = yield* ComputerTransport.Service
        const controller = new AbortController()
        const input =
          command === "awaitControl"
            ? { ...envelope, command, lease: 1, waitId: "pointer-wait" }
            : { ...envelope, command, lease: 1, phase: "start" as const, reason: "sign_in" as const }
        const finished = { value: false }
        const fiber = yield* transport.request(input, { signal: controller.signal }).pipe(
          Effect.exit,
          Effect.tap(() =>
            Effect.sync(() => {
              finished.value = true
            }),
          ),
          Effect.forkChild,
        )
        yield* TestClock.adjust(24 * 60 * 60_000)
        expect(finished.value).toBe(false)
        expect(waiting.calls).toHaveLength(1)
        expect(waiting.calls[0].signal.aborted).toBe(false)
        controller.abort()
        expect(error(yield* Fiber.join(fiber)).code).toBe("stopped")
        expect(waiting.calls.map((call) => call.input.command)).toEqual([command, "cancel"])
      }),
    ),
  )
}

const queued = fixture((input) => (input.command === "cancel" ? Effect.succeed({ ok: true }) : Effect.never))
queued.it.effect("queued acquire ends after ten minutes by disconnecting and cancelling only its queued root", () =>
  environment(
    Effect.gen(function* () {
      const transport = yield* ComputerTransport.Service
      const fiber = yield* transport
        .request({ ...envelope, command: "acquire", title: "Waiting task", wait: true })
        .pipe(Effect.exit, Effect.forkChild)
      yield* TestClock.adjust(10 * 60_000)
      expect(error(yield* Fiber.join(fiber)).code).toBe("timeout")
      expect(queued.calls.map((call) => call.input.command)).toEqual(["acquire", "cancel"])
      expect(queued.calls[0].signal.aborted).toBe(true)
      expect(queued.calls[1].input).toEqual({ ...envelope, command: "cancel" })
    }),
  ),
)

const betweenPolls = fixture((input) =>
  Effect.succeed(input.command === "cancel" ? { ok: true } : { code: "busy", holder: { title: "Current task" } }),
)
betweenPolls.it.effect("aborting between acquire polls still removes the queued root without a holder lease", () =>
  environment(
    Effect.gen(function* () {
      const transport = yield* ComputerTransport.Service
      const controller = new AbortController()
      const fiber = yield* transport
        .request({ ...envelope, command: "acquire", title: "Waiting task", wait: true }, { signal: controller.signal })
        .pipe(Effect.exit, Effect.forkChild)
      yield* TestClock.adjust(0)
      expect(betweenPolls.calls.map((call) => call.input.command)).toEqual(["acquire"])
      controller.abort()
      expect(error(yield* Fiber.join(fiber)).code).toBe("stopped")
      expect(betweenPolls.calls.map((call) => call.input.command)).toEqual(["acquire", "cancel"])
      expect(betweenPolls.calls[1].input).toEqual({ ...envelope, command: "cancel" })
    }),
  ),
)

const refused = fixture(() => Effect.succeed({ ok: false, lease: 7 }))
refused.it.effect("a malformed ok:false response cannot be accepted as a successful lease", () =>
  environment(
    Effect.gen(function* () {
      const transport = yield* ComputerTransport.Service
      const exit = yield* transport.request({ ...envelope, command: "acquire", title: "Task" }).pipe(Effect.exit)
      expect(error(exit).code).toBe("failed")
    }),
  ),
)

const remote = fixture(() => Effect.succeed({ ok: true }))
remote.it.effect("the reserved remote backend cannot send a request or a bridge token", () =>
  environment(
    Effect.gen(function* () {
      const transport = yield* ComputerTransport.Service
      const exit = yield* transport.request(act, { backend: "remote" }).pipe(Effect.exit)
      expect(error(exit)).toMatchObject({
        code: "unavailable",
        message: "Remote computer use is not available in this build.",
      })
      expect(remote.calls).toHaveLength(0)
    }),
  ),
)

const localCleanup = fixture(() =>
  Effect.sync(() => {
    // The decision is recorded before the HTTP client receives the cleanup request.
    expect(Egress.events().at(-1)).toMatchObject({ source: "computer-bridge", method: "POST", decision: "allow" })
    return { ok: true }
  }),
)
localCleanup.it.effect(
  "Local None still permits labelled loopback cancel and release without logging their secrets",
  () =>
    environment(
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = Egress.policy()
          const events: ReturnType<typeof Egress.events> = []
          const unsubscribe = Egress.subscribe((event) => {
            if (event.source === "computer-bridge") events.push(event)
          })
          Egress.configure(LocalPolicy.resolve({ global: { enabled: true, web: "none" } }))
          return { previous, events, unsubscribe }
        }),
        ({ events }) =>
          Effect.gen(function* () {
            const transport = yield* ComputerTransport.Service
            yield* transport.request({ ...envelope, command: "cancel", lease: 1 })
            yield* transport.request({ ...envelope, command: "release", lease: 1 })
            expect(localCleanup.calls.map((call) => call.input.command)).toEqual(["cancel", "release"])
            expect(events).toHaveLength(2)
            for (const event of events) {
              expect(event).toMatchObject({
                source: "computer-bridge",
                purpose: "integration",
                class: "this-computer",
                origin: "http://127.0.0.1:45100",
                method: "POST",
                tool: "computer",
                decision: "allow",
              })
              expect(event.bytes_out).toBeGreaterThan(0)
            }
            expect(JSON.stringify(events)).not.toContain("transport-clock-fixture")
            expect(JSON.stringify(events)).not.toContain("/fixture")
            expect(JSON.stringify(events)).not.toContain("/computer/command")
          }),
        ({ previous, unsubscribe }) =>
          Effect.sync(() => {
            unsubscribe()
            Egress.configure(previous)
          }),
      ),
    ),
)

for (const [name, values] of [
  ["missing pair", {}],
  ["missing token", { url: "http://127.0.0.1:45100" }],
  ["missing URL", { token: "transport-origin-fixture" }],
  ["non-loopback origin", { url: "http://example.com:45100", token: "transport-origin-fixture" }],
  ["TLS origin", { url: "https://127.0.0.1:45100", token: "transport-origin-fixture" }],
  ["credential origin", { url: "http://user:password@127.0.0.1:45100", token: "transport-origin-fixture" }],
  ["path origin", { url: "http://127.0.0.1:45100/path", token: "transport-origin-fixture" }],
  ["query origin", { url: "http://127.0.0.1:45100?redirect=elsewhere", token: "transport-origin-fixture" }],
  ["fragment origin", { url: "http://127.0.0.1:45100#fragment", token: "transport-origin-fixture" }],
  ["missing port", { url: "http://127.0.0.1", token: "transport-origin-fixture" }],
  ["invalid URL", { url: "not a URL", token: "transport-origin-fixture" }],
] satisfies readonly [string, { url?: string; token?: string }][]) {
  const origin = fixture(() => Effect.succeed({ ok: true }))
  origin.it.effect(`${name} is unavailable before any HTTP request or token can be sent`, () =>
    environment(
      Effect.gen(function* () {
        const transport = yield* ComputerTransport.Service
        const exit = yield* transport.request(act).pipe(Effect.exit)
        expect(error(exit).code).toBe("unavailable")
        expect(error(exit).message).not.toContain("transport-origin-fixture")
        expect(error(exit).message).not.toContain(values.url ?? "Bearer")
        expect(origin.calls).toHaveLength(0)
      }),
      values,
    ),
  )
}
