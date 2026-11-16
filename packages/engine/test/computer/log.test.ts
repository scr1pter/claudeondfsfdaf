import { expect } from "bun:test"
import { createHash } from "node:crypto"
import { symlink } from "node:fs/promises"
import path from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import { Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Result, Schema } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { filesystem } from "@vectordevai/core/effect/app-node-platform"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EventV2 } from "@vectordevai/core/event"
import { Global } from "@vectordevai/core/global"
import { ComputerProgram } from "@vectordevai/core/computer/program"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { ComputerLog } from "@/computer/log"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { testEffect } from "../lib/effect"

const global = Layer.effect(
  Global.Service,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const data = yield* fs.makeTempDirectoryScoped({ prefix: "vector-computer-log-" }).pipe(Effect.orDie)
    return Global.Service.of(Global.make({ data }))
  }),
).pipe(Layer.provide(NodeFileSystem.layer))

const it = testEffect(
  LayerNode.compile(LayerNode.group([ComputerLog.node, Global.node, EventV2.node, filesystem]), [
    [Global.node, global],
  ]),
)

// This graph deliberately does not list ComputerLog.node: session deletion must initialize cleanup itself.
const sessions = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      Global.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      filesystem,
    ]),
    [
      [Global.node, global],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [InstanceBootstrap.node, Layer.mock(InstanceBootstrap.Service, { run: Effect.void })],
    ],
  ),
)

const record = (rootSessionID: SessionID, extra: Partial<ComputerLog.Input> = {}): ComputerLog.Input => ({
  rootSessionID,
  call: "call_log",
  step: { index: 0, action: "type" },
  app: "app:macos:com.example.notes",
  decision: "executed",
  ...extra,
})

const read = Effect.fn("test.readComputerLog")(function* (rootSessionID: SessionID) {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Global.Service
  const file = path.join(paths.data, "computer", "log", `${rootSessionID}.jsonl`)
  const raw = yield* fs.readFileString(file)
  const rows = raw
    .trimEnd()
    .split("\n")
    .map((line) =>
      Schema.decodeUnknownSync(ComputerLog.Record)(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(line)),
    )
  return { file, raw, rows }
})

const gatedWrite = Effect.fn("test.gatedComputerLogWrite")(function* (rootSessionID: SessionID) {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Global.Service
  const file = path.join(paths.data, "computer", "log", `${rootSessionID}.jsonl`)
  const entered = yield* Deferred.make<void>()
  const proceed = yield* Deferred.make<void>()
  const context = yield* Layer.build(
    ComputerLog.layer.pipe(
      Layer.provide(
        Layer.succeed(FileSystem.FileSystem, {
          ...fs,
          writeFileString: (target, text, options) =>
            target === file
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(proceed)),
                  Effect.andThen(fs.writeFileString(target, text, options)),
                )
              : fs.writeFileString(target, text, options),
        }),
      ),
      // The outer test already built this layer; use a new instance so the gated filesystem is captured.
      Layer.fresh,
    ),
  )
  return { log: Context.get(context, ComputerLog.Service), file, entered, proceed }
})

it.live("typed text is logged only as length and hash", () =>
  Effect.gen(function* () {
    const log = yield* ComputerLog.Service
    const rootSessionID = SessionID.make("ses_log_text")
    const text = "A private note with emoji 🌳 and a second line\nDo not retain me"
    const image = "data:image/png;base64,PRIVATE_SCREEN_BYTES"
    const input = {
      ...record(rootSessionID, { text }),
      image,
      screenshot: image,
      intent: text,
      reason: text,
      error: { message: text },
      request: { text, image },
    }
    yield* log.append(input)
    const saved = yield* read(rootSessionID)
    expect(saved.rows).toHaveLength(1)
    expect(saved.rows[0]).toMatchObject({
      call: "call_log",
      step: { index: 0, action: "type" },
      decision: "executed",
      text: { length: text.length, hash: createHash("sha256").update(text).digest("hex").slice(0, 12) },
    })
    expect(saved.rows[0].t).toBeGreaterThan(0)
    expect(saved.raw).not.toContain(text)
    expect(saved.raw).not.toContain("PRIVATE_SCREEN_BYTES")
    for (const key of ["rootSessionID", "image", "screenshot", "intent", "reason", "error", "request"])
      expect(saved.rows[0]).not.toHaveProperty(key)
  }),
)

it.live("program execution records a distinct artifact key without retaining its native token or path", () =>
  Effect.gen(function* () {
    const log = yield* ComputerLog.Service
    const rootSessionID = SessionID.make("ses_log_program")
    const descriptor = {
      platform: "macos" as const,
      path: "/private/workspace/run.script",
      name: "Run script",
      binding: "1".repeat(64),
    }
    const program = ComputerProgram.key(descriptor)
    yield* log.append({
      ...record(rootSessionID),
      app: undefined,
      program,
      step: { index: 1, action: "open_app" },
      permission: "computer_sensitive",
      decision: "ask",
      nativeToken: "private_native_token",
      path: descriptor.path,
    } as ComputerLog.Input)
    const saved = yield* read(rootSessionID)
    expect(saved.rows[0]).toMatchObject({
      program,
      step: { index: 1, action: "open_app" },
      permission: "computer_sensitive",
      decision: "ask",
    })
    expect(saved.rows[0]).not.toHaveProperty("app")
    expect(saved.raw).not.toContain(descriptor.path)
    expect(saved.raw).not.toContain("private_native_token")
    expect(saved.rows[0]).not.toHaveProperty("nativeToken")
  }),
)

it.live("every decision kind is written in order with its bounded context", () =>
  Effect.gen(function* () {
    const log = yield* ComputerLog.Service
    const rootSessionID = SessionID.make("ses_log_decisions")
    for (const [index, decision] of ComputerLog.DECISIONS.entries())
      yield* log.append(
        record(rootSessionID, {
          call: `call_${index}`,
          step: { index, action: "click" },
          target: "Continue",
          decision,
          permission: "computer_sensitive",
          answer: "once",
          code: "blocked",
        }),
      )
    const saved = yield* read(rootSessionID)
    expect(saved.rows.map((row) => row.decision)).toEqual([...ComputerLog.DECISIONS])
    expect(saved.rows.map((row) => row.step?.index)).toEqual(ComputerLog.DECISIONS.map((_, index) => index))
    expect(saved.rows.every((row) => row.target === "Continue" && row.permission === "computer_sensitive")).toBe(true)
    expect(saved.rows.every((row) => row.answer === "once" && row.code === "blocked")).toBe(true)
  }),
)

it.live("screen labels are cleaned and bounded without retaining typed text or image data", () =>
  Effect.gen(function* () {
    const log = yield* ComputerLog.Service
    const rootSessionID = SessionID.make("ses_log_labels")
    yield* log.append(record(rootSessionID, { target: `Line\n\u0000${"ordinary label ".repeat(200)}` }))
    yield* log.append(record(rootSessionID, { target: "Field: private typed phrase", text: "private typed phrase" }))
    yield* log.append(record(rootSessionID, { target: "data:image/jpeg;base64,PRIVATE_SCREEN_BYTES" }))
    const saved = yield* read(rootSessionID)
    expect(saved.rows[0].target?.length).toBeLessThanOrEqual(ComputerLog.MAX_TARGET)
    expect(saved.rows[0].target).not.toMatch(/[\r\n\u0000]/)
    expect(saved.rows[1].target ?? "").not.toContain("private typed phrase")
    expect(saved.raw).not.toContain("private typed phrase")
    expect(saved.raw).not.toContain("PRIVATE_SCREEN_BYTES")
  }),
)

it.live("typed content echoed through call, app and target fields is not retained", () =>
  Effect.gen(function* () {
    const log = yield* ComputerLog.Service
    const rootSessionID = SessionID.make("ses_log_echoes")
    const text = "private_phrase"
    yield* log.append(
      record(rootSessionID, {
        call: `call_${text}`,
        app: `app:macos:com.example.${text}`,
        target: `Field ${text}`,
        text,
      }),
    )
    const saved = yield* read(rootSessionID)
    expect(saved.raw).not.toContain(text)
    expect(saved.rows[0].call).toMatch(/^sha256:[a-f0-9]{16}$/)
    expect(saved.rows[0].app).toBeUndefined()
    expect(saved.rows[0].target).toBeUndefined()
    expect(saved.rows[0].text?.length).toBe(text.length)
  }),
)

it.live("concurrent appends remain complete JSONL records", () =>
  Effect.gen(function* () {
    const log = yield* ComputerLog.Service
    const rootSessionID = SessionID.make("ses_log_concurrent")
    yield* Effect.all(
      Array.from({ length: 40 }, (_, index) =>
        log.append(
          record(rootSessionID, {
            call: `call_${index}`,
            step: { index, action: "click" },
            target: "Save",
          }),
        ),
      ),
      { concurrency: "unbounded" },
    )
    const saved = yield* read(rootSessionID)
    expect(saved.rows).toHaveLength(40)
    expect(new Set(saved.rows.map((row) => row.call)).size).toBe(40)
    expect(saved.raw.endsWith("\n")).toBe(true)
  }),
)

it.live("removing a log prevents late appends from recreating it", () =>
  Effect.gen(function* () {
    const log = yield* ComputerLog.Service
    const fs = yield* FileSystem.FileSystem
    const rootSessionID = SessionID.make("ses_log_removed")
    yield* log.append(record(rootSessionID))
    const saved = yield* read(rootSessionID)
    yield* log.remove(rootSessionID)
    yield* log.remove(rootSessionID)
    expect(yield* fs.exists(saved.file)).toBe(false)
    const late = yield* log.append(record(rootSessionID, { call: "call_late" })).pipe(Effect.result)
    expect(Result.isFailure(late)).toBe(true)
    expect(yield* fs.exists(saved.file)).toBe(false)
  }),
)

it.live("deletion drains an in-flight append and prevents queued writes from recreating the log", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const rootSessionID = SessionID.make("ses_log_delete_race")
    const { log, file, entered, proceed } = yield* gatedWrite(rootSessionID)
    const first = yield* log.append(record(rootSessionID)).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    // Starting immediately runs remove through its tombstone mutation up to the held mutex.
    const deletion = yield* log.remove(rootSessionID).pipe(Effect.forkChild({ startImmediately: true }))
    const late = yield* log.append(record(rootSessionID, { call: "call_late" })).pipe(Effect.result, Effect.forkChild)
    yield* Deferred.succeed(proceed, undefined)
    yield* Fiber.join(first)
    yield* Fiber.join(deletion)
    expect(Result.isFailure(yield* Fiber.join(late))).toBe(true)
    expect(yield* fs.exists(file)).toBe(false)
  }),
)

it.live("interruption retains the append lock until its write settles before deletion", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const rootSessionID = SessionID.make("ses_log_interrupted_write")
    const { log, file, entered, proceed } = yield* gatedWrite(rootSessionID)
    const first = yield* log.append(record(rootSessionID)).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const interruption = yield* Fiber.interrupt(first).pipe(Effect.forkChild({ startImmediately: true }))
    const deletion = yield* log.remove(rootSessionID).pipe(Effect.forkChild({ startImmediately: true }))
    // These immediate snapshots are taken after interruption and deletion reached the active write.
    const interruptedEarly = first.pollUnsafe()
    const deletedEarly = deletion.pollUnsafe()
    yield* Deferred.succeed(proceed, undefined)
    yield* Fiber.join(interruption)
    yield* Fiber.join(deletion)
    expect(interruptedEarly).toBeUndefined()
    expect(deletedEarly).toBeUndefined()
    expect(first.pollUnsafe()?._tag).toBe("Failure")
    expect(yield* fs.exists(file)).toBe(false)
    expect(Result.isFailure(yield* log.append(record(rootSessionID)).pipe(Effect.result))).toBe(true)
  }),
)

it.live("invalid session IDs cannot write outside the action-log directory", () =>
  Effect.gen(function* () {
    const log = yield* ComputerLog.Service
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Global.Service
    for (const value of ["ses_x/../../../outside", "ses_x\\..\\..\\..\\outside", "ses_/tmp/outside", "ses_bad\u0000id"])
      expect(Result.isFailure(yield* log.append(record(SessionID.make(value))).pipe(Effect.result))).toBe(true)
    expect(yield* fs.readDirectory(paths.data)).toEqual([])
  }),
)

it.live("removing a log refuses a linked log directory and leaves the other directory intact", () =>
  Effect.gen(function* () {
    const log = yield* ComputerLog.Service
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Global.Service
    const rootSessionID = SessionID.make("ses_log_link")
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "vector-computer-log-outside-" })
    const file = path.join(outside, `${rootSessionID}.jsonl`)
    yield* fs.writeFileString(file, "leave this local fixture untouched")
    yield* fs.makeDirectory(path.join(paths.data, "computer"))
    // Junctions are directory links on Windows and ordinary directory symlinks on other Node platforms.
    yield* Effect.promise(() => symlink(outside, path.join(paths.data, "computer", "log"), "junction"))
    expect(Result.isFailure(yield* log.remove(rootSessionID).pipe(Effect.result))).toBe(true)
    expect(yield* fs.readFileString(file)).toBe("leave this local fixture untouched")
  }),
)

it.live("storage failures return a typed generic error without request content", () =>
  Effect.gen(function* () {
    const log = yield* ComputerLog.Service
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Global.Service
    yield* fs.makeDirectory(path.join(paths.data, "computer"), { recursive: true })
    yield* fs.writeFileString(path.join(paths.data, "computer", "log"), "not a directory")
    const text = "PRIVATE_TYPED_CONTENT"
    const result = yield* log.append(record(SessionID.make("ses_log_failure"), { text })).pipe(Effect.result)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ComputerLog.Error)
      expect(result.failure.code).toBe("failed")
      expect(result.failure.message).not.toContain(text)
      expect(JSON.stringify(result.failure)).not.toContain(text)
      expect(JSON.stringify(result.failure)).not.toContain(paths.data)
    }
  }),
)

sessions.instance("deleting a session removes an existing log before any computer call in this process", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Global.Service
    const chat = yield* session.create({ title: "Local action record" })
    const directory = path.join(paths.data, "computer", "log")
    const file = path.join(directory, `${chat.id}.jsonl`)
    yield* fs.makeDirectory(directory, { recursive: true })
    yield* fs.writeFileString(
      file,
      `${JSON.stringify({ t: 1, call: "call_previous_process", decision: "executed" })}\n`,
    )
    expect(yield* fs.exists(file)).toBe(true)
    yield* session.remove(chat.id)
    expect(yield* fs.exists(file)).toBe(false)
    expect(Result.isFailure(yield* session.get(chat.id).pipe(Effect.result))).toBe(true)
  }),
)

sessions.instance("the canonical deleted event removes an existing action log", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const events = yield* EventV2Bridge.Service
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Global.Service
    const chat = yield* session.create({ title: "Deleted event" })
    const directory = path.join(paths.data, "computer", "log")
    const file = path.join(directory, `${chat.id}.jsonl`)
    yield* fs.makeDirectory(directory, { recursive: true })
    yield* fs.writeFileString(
      file,
      `${JSON.stringify({ t: 1, call: "call_previous_process", decision: "executed" })}\n`,
    )
    yield* events.publish(Session.Event.Deleted, { sessionID: chat.id, info: chat })
    expect(yield* fs.exists(file)).toBe(false)
  }),
)

sessions.instance("a failed action-log removal prevents deleting the session record", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Global.Service
    const chat = yield* session.create({ title: "Keep until local cleanup succeeds" })
    const file = path.join(paths.data, "computer", "log", `${chat.id}.jsonl`)
    yield* fs.makeDirectory(file, { recursive: true })
    yield* fs.writeFileString(path.join(file, "block-removal"), "fixture")
    expect(Exit.isFailure(yield* session.remove(chat.id).pipe(Effect.exit))).toBe(true)
    expect((yield* session.get(chat.id)).id).toBe(chat.id)
    yield* fs.remove(file, { recursive: true })
    yield* session.remove(chat.id)
    expect(Result.isFailure(yield* session.get(chat.id).pipe(Effect.result))).toBe(true)
  }),
)
