import { createHash } from "node:crypto"
import path from "node:path"
import { Clock, Context, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { ComputerCredential } from "@vectordevai/core/computer/credential"
import { makeGlobalNode } from "@vectordevai/core/effect/app-node"
import { filesystem } from "@vectordevai/core/effect/app-node-platform"
import { KeyedMutex } from "@vectordevai/core/effect/keyed-mutex"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import { EventV2 } from "@vectordevai/core/event"
import { Global } from "@vectordevai/core/global"
import { Computer } from "@vectordevai/schema/computer"
import { optional } from "@vectordevai/schema/schema"
import type { SessionID } from "@vectordevai/schema/session-id"
import { SessionV1 } from "@vectordevai/schema/session-v1"

export const MAX_TARGET = 256
export const DECISIONS = [
  "attempted",
  "executed",
  "not_executed",
  "unconfirmed",
  "refusal",
  "ask",
  "answer",
  "pending",
  "take_over",
  "handoff",
  "resume",
  "stop",
  "release",
] as const

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Label = Schema.String.check(Schema.isMaxLength(MAX_TARGET))
export interface Record extends Schema.Schema.Type<typeof Record> {}
export const Record = Schema.Struct({
  t: NonNegativeInt,
  call: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  step: optional(Schema.Struct({ index: NonNegativeInt, action: Computer.ToolAction })),
  app: optional(Computer.AppKey),
  /** An artifact launch is a separate identity and never masquerades as app access. */
  program: optional(Computer.ProgramKey),
  target: optional(Label),
  decision: Schema.Literals(DECISIONS),
  permission: optional(Schema.Literals(["computer_app", "computer_sensitive", "handoff", "check_in"])),
  answer: optional(
    Schema.Literals([
      "once",
      "always",
      "reject",
      "continue",
      "keep_going",
      "stop",
      "dismissed",
      "unconfirmed",
      "resumed",
      "declined",
    ]),
  ),
  code: optional(Computer.ComputerErrorCode),
  text: optional(
    Schema.Struct({
      length: NonNegativeInt,
      hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{12}$/)),
    }),
  ),
})

/** Raw text is transient input to the privacy projection, never a stored record field. */
export type Input = Omit<Record, "t" | "text"> & {
  readonly rootSessionID: SessionID
  readonly text?: string
}

export class Error extends Schema.TaggedErrorClass<Error>()("ComputerLogError", {
  code: Schema.Literal("failed"),
  message: Schema.String,
}) {}

export interface Interface {
  readonly append: (input: Input) => Effect.Effect<void, Error>
  readonly remove: (rootSessionID: SessionID) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@vector/ComputerLog") {}
export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const global = yield* Global.Service
    const events = yield* EventV2.Service
    const locks = KeyedMutex.makeUnsafe<SessionID>()
    const deleted = new Set<SessionID>()
    const directory = path.join(global.data, "computer", "log")

    const append = Effect.fn("ComputerLog.append")(function* (input: Input) {
      if (!safeID(input.rootSessionID)) return yield* failure()
      const t = yield* Clock.currentTimeMillis
      // Only the projected row reaches the file write; unknown fields and complete input objects are excluded.
      const record = yield* Effect.try({ try: () => project(input, t), catch: failure })
      return yield* locks.withLock(input.rootSessionID)(
        Effect.gen(function* () {
          if (deleted.has(input.rootSessionID)) return yield* failure()
          const base = yield* fs.realPath(global.data)
          for (const name of ["computer", path.join("computer", "log")]) {
            const child = path.join(global.data, name)
            yield* fs.makeDirectory(child, { mode: 0o700 }).pipe(
              Effect.catchIf(
                (error) => error.reason._tag === "AlreadyExists",
                () => Effect.void,
              ),
            )
            if (path.relative(path.join(base, name), yield* fs.realPath(child)) !== "") return yield* failure()
            if ((yield* fs.stat(child)).type !== "Directory") return yield* failure()
            yield* fs.chmod(child, 0o700)
          }
          const file = path.join(directory, `${input.rootSessionID}.jsonl`)
          const exists = yield* fs.exists(file)
          if (exists) {
            if (
              path.relative(
                path.join(base, "computer", "log", `${input.rootSessionID}.jsonl`),
                yield* fs.realPath(file),
              ) !== ""
            )
              return yield* failure()
            const info = yield* fs.stat(file)
            if (info.type !== "File" || (Option.isSome(info.nlink) && info.nlink.value !== 1)) return yield* failure()
            yield* fs.chmod(file, 0o600)
          }
          yield* fs.writeFileString(file, `${JSON.stringify(record)}\n`, { flag: exists ? "a" : "ax", mode: 0o600 })
        }).pipe(
          // Native writes may finish after fiber interruption; retain the mutex until the mutation settles.
          Effect.uninterruptible,
          Effect.mapError(failure),
        ),
      )
    })

    const remove = Effect.fn("ComputerLog.remove")(function* (rootSessionID: SessionID) {
      // Legacy non-computer sessions may have less restricted IDs; append could never have created their file.
      if (!safeID(rootSessionID)) return
      // Mark before the lock: queued and late tool finalizers cannot recreate a deleted session's record.
      deleted.add(rootSessionID)
      yield* locks.withLock(rootSessionID)(
        Effect.gen(function* () {
          if (!(yield* fs.exists(directory))) return
          const base = yield* fs.realPath(global.data)
          if (path.relative(path.join(base, "computer", "log"), yield* fs.realPath(directory)) !== "")
            return yield* failure()
          yield* fs.remove(path.join(directory, `${rootSessionID}.jsonl`), { force: true })
        }).pipe(Effect.uninterruptible, Effect.mapError(failure)),
      )
    })

    const unsubscribe = yield* events.listen((event) => {
      if (event.type !== SessionV1.Event.Deleted.type) return Effect.void
      const data = event.data
      if (typeof data !== "object" || data === null || !("sessionID" in data) || !safeID(data.sessionID))
        return Effect.void
      return remove(data.sessionID as SessionID).pipe(Effect.orDie)
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    return Service.of({ append, remove })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Global.node, EventV2.node, filesystem] })

function safeID(value: unknown): value is string {
  return typeof value === "string" && /^ses[a-zA-Z0-9_-]{0,200}$/.test(value)
}

function failure() {
  // Never preserve an input, filesystem cause or user-supplied string in an error sent to general logs.
  return new Error({ code: "failed", message: "The local computer action record could not be saved or removed." })
}

function project(input: Input, t: number): Record {
  const text = input.text
  const target = input.target === undefined ? undefined : Computer.clean(input.target, MAX_TARGET)
  const safeTarget =
    target &&
    !/data\s*:\s*image\//i.test(target) &&
    !ComputerCredential.secret(target) &&
    !(text && (input.target!.includes(text) || target.includes(Computer.clean(text, Computer.LIMITS.typeTextChars))))
      ? target
      : undefined
  // Provider call IDs are correlation tokens. Non-token IDs are represented by a digest rather than copied as text.
  const call =
    /^[a-zA-Z0-9_.:-]{1,256}$/.test(input.call) &&
    !ComputerCredential.secret(input.call) &&
    !(text && input.call.includes(text))
      ? input.call
      : `sha256:${createHash("sha256").update(input.call).digest("hex").slice(0, 16)}`
  const app =
    input.app &&
    input.app.length <= 1024 &&
    !/data\s*:\s*image\//i.test(input.app) &&
    !ComputerCredential.secret(input.app) &&
    !(text && input.app.includes(text))
      ? input.app
      : undefined
  const record: Record = {
    t,
    call,
    ...(input.step ? { step: { index: input.step.index, action: input.step.action } } : {}),
    ...(app ? { app } : {}),
    ...(input.program ? { program: input.program } : {}),
    ...(safeTarget ? { target: safeTarget } : {}),
    decision: input.decision,
    ...(input.permission ? { permission: input.permission } : {}),
    ...(input.answer ? { answer: input.answer } : {}),
    ...(input.code ? { code: input.code } : {}),
    ...(text === undefined
      ? {}
      : { text: { length: text.length, hash: createHash("sha256").update(text).digest("hex").slice(0, 12) } }),
  }
  if (!Schema.is(Record)(record)) throw failure()
  return record
}

export * as ComputerLog from "./log"
