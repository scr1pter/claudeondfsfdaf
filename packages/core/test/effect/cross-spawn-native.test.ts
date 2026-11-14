import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Sink, Stream } from "effect"
import { TestClock } from "effect/testing"
import { ChildProcess } from "effect/unstable/process"
import { PassThrough } from "node:stream"
import { OwnedProcess } from "../../src/owned-process"
import { CrossSpawnSpawner } from "../../src/cross-spawn-spawner"
import { it } from "../lib/effect"

const fixture = Effect.gen(function* () {
  const closed = yield* Deferred.make<void>()
  const sent = yield* Deferred.make<void>()
  const drained = yield* Deferred.make<void>()
  const killed = yield* Deferred.make<void>()
  const events: string[] = []
  const state = { exited: false }
  const hooks: { send?: (signal: NodeJS.Signals) => Effect.Effect<void, Error> } = {}
  const finish = Effect.gen(function* () {
    state.exited = true
    events.push("close")
    yield* Deferred.succeed(closed, undefined)
  })
  const owner = CrossSpawnSpawner.nativeOwner({
    completed: Deferred.isDone(closed),
    closed: Effect.asVoid(Deferred.await(closed)),
    exited: () => state.exited,
    send: (signal) =>
      Effect.gen(function* () {
        events.push(`send:${signal}`)
        yield* Deferred.succeed(sent, undefined)
        if (signal === "SIGKILL") yield* Deferred.succeed(killed, undefined)
        yield* hooks.send?.(signal) ?? Effect.void
      }),
    drain: Effect.gen(function* () {
      events.push("drain")
      yield* Deferred.succeed(drained, undefined)
    }),
    dispose: Effect.sync(() => {
      events.push("dispose")
    }),
    error: (message) => new Error(message),
  })
  return { owner, state, hooks, events, finish, closed, sent, drained, killed }
})

test("whole-pipeline native validation accepts standard streams and rejects every later-stage extra FD", () => {
  const first = ChildProcess.make("head", [], { stdin: Stream.empty })
  const valid = ChildProcess.pipeTo(
    first,
    ChildProcess.make("tail", [], { stderr: Sink.map(Sink.drain, () => new Uint8Array()) }),
    { from: "all" },
  )
  expect(() => CrossSpawnSpawner.assertNativePipeline(valid)).not.toThrow()
  for (const extra of ["fd3", "fd1000"] as const) {
    const tail = ChildProcess.make("tail", [], { additionalFds: { [extra]: { type: "input", stream: Stream.empty } } })
    const invalid = ChildProcess.pipeTo(ChildProcess.pipeTo(first, ChildProcess.make("middle")), tail)
    let admitted = 0
    expect(() => {
      CrossSpawnSpawner.assertNativePipeline(invalid)
      admitted++
    }).toThrow()
    expect(admitted).toBe(0)
  }
})

test("native validation rejects fd pipe sources/destinations and unsupported resolved stdio/stop policies", () => {
  const first = ChildProcess.make("head")
  const last = ChildProcess.make("tail")
  for (const options of [{ from: "fd3" as const }, { to: "fd3" as const }])
    expect(() => CrossSpawnSpawner.assertNativePipeline(ChildProcess.pipeTo(first, last, options))).toThrow()
  for (const options of [
    { stdin: "overlapped" as const },
    { stdout: "overlapped" as const },
    { stderr: { stream: "overlapped" as const } },
    { killSignal: "SIGUSR1" as const },
    { forceKillAfter: Infinity },
    { forceKillAfter: -1 },
  ])
    expect(() => CrossSpawnSpawner.assertNativePipeline(ChildProcess.make("payload", [], options))).toThrow()
})

it.effect("native scoped cleanup waits for owned close before disposal and never sends a process-group signal", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const closing = yield* f.owner.cleanup().pipe(Effect.forkChild)
    yield* Deferred.await(f.sent)
    expect(f.events).toEqual(["drain", "send:SIGTERM"])
    yield* f.finish
    yield* Fiber.join(closing)
    expect(f.events).toEqual(["drain", "send:SIGTERM", "close", "dispose"])
  }),
)

it.effect("acquisition interruption does not complete before the owned close proof and captured disposal", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const entered = yield* Deferred.make<void>()
    const acquire = Effect.callback<void>(() => {
      Deferred.doneUnsafe(entered, Exit.succeed(undefined))
      return f.owner.cleanup().pipe(Effect.orDie)
    })
    const acquiring = yield* acquire.pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const interrupted = yield* Fiber.interrupt(acquiring).pipe(Effect.forkChild)
    yield* Deferred.await(f.sent)
    expect(f.events).toEqual(["drain", "send:SIGTERM"])
    yield* f.finish
    yield* Fiber.join(interrupted)
    expect(f.events.at(-1)).toBe("dispose")
  }),
)

it.effect("native cleanup never signals a completed owner, and exited-but-unclosed commands only drain/join", () =>
  Effect.gen(function* () {
    const completed = yield* fixture
    yield* completed.finish
    yield* completed.owner.cleanup()
    expect(completed.events).toEqual(["close", "dispose"])
    const exited = yield* fixture
    exited.state.exited = true
    const cleanup = yield* exited.owner.cleanup().pipe(Effect.forkChild)
    yield* Deferred.await(exited.drained)
    expect(exited.events).toEqual(["drain"])
    yield* exited.finish
    yield* Fiber.join(cleanup)
    expect(exited.events).toEqual(["drain", "close", "dispose"])
  }),
)

it.effect("native default and caller-long deadlines escalate only the owned shim at three seconds", () =>
  Effect.gen(function* () {
    for (const options of [undefined, { forceKillAfter: "1 hour" as const }]) {
      const f = yield* fixture
      f.hooks.send = (signal) => (signal === "SIGKILL" ? f.finish : Effect.void)
      const closing = yield* f.owner.cleanup(options).pipe(Effect.forkChild)
      yield* Deferred.await(f.sent)
      yield* TestClock.adjust("2999 millis")
      expect(f.events).toEqual(["drain", "send:SIGTERM"])
      yield* TestClock.adjust("1 millis")
      yield* Fiber.join(closing)
      expect(f.events).toEqual(["drain", "send:SIGTERM", "send:SIGKILL", "close", "dispose"])
    }
  }),
)

it.effect(
  "an unproved native close fails within the final join bound and does not pretend captures were disposed",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const closing = yield* f.owner.cleanup({ forceKillAfter: 0 }).pipe(Effect.exit, Effect.forkChild)
      yield* Deferred.await(f.sent)
      yield* TestClock.adjust(0)
      yield* Deferred.await(f.killed)
      yield* TestClock.adjust("2 seconds")
      const result = yield* Fiber.join(closing)
      expect(Exit.isFailure(result)).toBe(true)
      expect(f.events).toEqual(["drain", "send:SIGTERM", "send:SIGKILL"])
      expect(yield* Deferred.isDone(f.closed)).toBe(false)
    }),
)

it.effect("concurrent native stop/finalizer requests share the same owned close and dispose once", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const first = yield* f.owner.cleanup().pipe(Effect.forkChild)
    yield* Deferred.await(f.sent)
    const second = yield* f.owner.cleanup().pipe(Effect.forkChild)
    yield* f.finish
    yield* Fiber.join(first)
    yield* Fiber.join(second)
    expect(f.events).toEqual(["drain", "send:SIGTERM", "close", "dispose"])
  }),
)

it.effect("native signaling failure has no group/raw fallback and cannot manufacture cleanup success", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    f.hooks.send = () => Effect.fail(new Error("owned child signal failed"))
    const result = yield* f.owner.cleanup().pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    expect(f.events).toEqual(["drain", "send:SIGTERM"])
  }),
)

it.effect("a signal/exit race joins the already-exited owner and never escalates against a reused PID", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    f.hooks.send = () => {
      f.state.exited = true
      return Effect.fail(new Error("process already exited"))
    }
    const closing = yield* f.owner.cleanup().pipe(Effect.forkChild)
    yield* Deferred.await(f.sent)
    yield* f.finish
    yield* Fiber.join(closing)
    expect(f.events).toEqual(["drain", "send:SIGTERM", "close", "dispose"])
  }),
)

it.effect("native unsupported stop signals fail before draining or signaling", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const result = yield* f.owner.stop({ killSignal: "SIGUSR1" }).pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    expect(f.events).toEqual([])
  }),
)

it.live("actual capture taps retain buffered bytes while native teardown drains abandoned raw pipes", () =>
  Effect.gen(function* () {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const captures = CrossSpawnSpawner.captureOutput({ stdout, stderr })
    const closed = Promise.withResolvers<void>()
    let ended = 0
    let done = false
    const complete = () => {
      if (++ended !== 2) return
      done = true
      closed.resolve()
    }
    stdout.once("end", complete)
    stderr.once("end", complete)
    const expectedOut = Buffer.concat([Buffer.from("held-stdout"), Buffer.alloc(131_072, 0x78)])
    const expectedErr = Buffer.concat([Buffer.from("held-stderr"), Buffer.alloc(65_536, 0x79)])
    stdout.write(expectedOut)
    stderr.write(expectedErr)
    const owner = CrossSpawnSpawner.nativeOwner({
      completed: Effect.sync(() => done),
      closed: Effect.promise(() => closed.promise),
      exited: () => done,
      send: () =>
        Effect.sync(() => {
          stdout.end()
          stderr.end()
        }),
      drain: Effect.sync(captures.drain),
      dispose: Effect.sync(captures.dispose),
      error: (message) => new Error(message),
    })
    yield* owner.stop()
    expect(captures.stdout?.destroyed).toBe(false)
    const out: unknown = captures.stdout?.read()
    const err: unknown = captures.stderr?.read()
    if (!Buffer.isBuffer(out) || !Buffer.isBuffer(err)) throw new Error("Missing retained capture bytes")
    expect(out.equals(expectedOut)).toBe(true)
    expect(err.equals(expectedErr)).toBe(true)
    yield* owner.cleanup()
    expect(captures.stdout?.destroyed).toBe(true)
    expect(captures.stderr?.destroyed).toBe(true)
  }),
)

// POSIX-only command ownership cannot be manufactured on Windows. This policy test never starts a payload.
test.skipIf(process.platform === "win32")("native pipelines refuse owned commands in every stage before launch", () => {
  const owned = OwnedProcess.command(ChildProcess.make("must-not-run", [], { detached: true }))
  for (const command of [owned, ChildProcess.pipeTo(ChildProcess.make("head"), owned)])
    expect(() => CrossSpawnSpawner.assertNativePipeline(command)).toThrow("refused")
})
