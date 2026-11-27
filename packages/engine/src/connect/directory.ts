export * as ConnectDirectory from "./directory"

import { createHash, randomUUID } from "node:crypto"
import { constants, statSync } from "node:fs"
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { Global } from "@vectordevai/core/global"
import { Connect } from "@vectordevai/schema/connect"
import { SessionID } from "@/session/schema"
import { FileLock } from "@/tool/file-lock"

/** Hidden execution and consent parent. It is never the public requester's conversation. */
export const INTERNAL = "vectorscope.directory"

interface Scope {
  readonly sessionID: SessionID
  readonly directory: string
  readonly projectID: string
}
interface Binding extends Scope {
  readonly canonical: string
  readonly identity: string
}

export const MAX_BYTES = 1024 * 1024
export const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  anchor: SessionID.check(Schema.isMaxLength(128)),
  projectID: Schema.String.check(Schema.isLengthBetween(1, 200)),
  directory: Schema.String.check(Schema.isLengthBetween(1, 4_096)),
  canonical: Schema.String.check(Schema.isLengthBetween(1, 4_096)),
  identity: Schema.String.check(Schema.isLengthBetween(1, 200)),
  run: Connect.Run,
})

const WritePhase = Schema.Literals([
  "authority",
  "size",
  "retired-before-write",
  "mkdir",
  "write",
  "retired-before-rename",
  "rename",
])
const FileErrorCode = Schema.Literals([
  "EACCES",
  "EBUSY",
  "EEXIST",
  "EIO",
  "EISDIR",
  "EMFILE",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "ENOTEMPTY",
  "EPERM",
  "EROFS",
])

export class Error extends Schema.TaggedErrorClass<Error>()("ConnectDirectory.Error", {
  message: Schema.String,
  phase: Schema.optional(WritePhase),
  code: Schema.optional(FileErrorCode),
}) {}

// A client-editable session name or metadata is not permission to use a hidden parent. Only the owner service lends
// this process-local capability, which the hub also checks against the live session and current instance.
const bindings = new WeakMap<object, Binding>()
const runs = new WeakMap<object, string>()
const writers = new WeakMap<object, { tail: Promise<void>; terminal: boolean }>()
export type Token = object

const snapshot = (directory: string) => {
  const info = statSync(directory, { bigint: true })
  if (!info.isDirectory() || info.ino === 0n)
    throw new Error({ message: "The selected workspace has no verifiable directory identity." })
  return { canonical: FileLock.key(directory), identity: `${info.dev}:${info.ino}` }
}

export const capture = Effect.fn("ConnectDirectory.capture")(function* (directory: string) {
  return yield* Effect.try({
    try: () => snapshot(directory),
    catch: () => new Error({ message: "The selected directory identity could not be verified." }),
  })
})

export const issue = Effect.fn("ConnectDirectory.issue")(function* (
  input: Scope,
  expected?: { readonly canonical: string; readonly identity: string },
) {
  const identity = yield* capture(input.directory)
  if (expected && (identity.canonical !== expected.canonical || identity.identity !== expected.identity))
    return yield* new Error({ message: "The selected directory was replaced before the review started." })
  const token = Object.freeze({})
  bindings.set(token, Object.freeze({ ...input, ...identity }))
  writers.set(token, { tail: Promise.resolve(), terminal: false })
  return token
})

export function current(binding: Binding) {
  try {
    const value = snapshot(binding.directory)
    return value.canonical === binding.canonical && value.identity === binding.identity
  } catch {
    return false
  }
}

export function read(token: Token): Binding | undefined {
  return bindings.get(token)
}

export function retire(token: Token) {
  bindings.delete(token)
  runs.delete(token)
  writers.delete(token)
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex")

export function prefix(input: { readonly projectID: string; readonly directory: string; readonly canonical?: string }) {
  return ["connect-directory", hash(input.projectID), hash(input.canonical ?? FileLock.key(input.directory))]
}

const folder = (input: { readonly projectID: string; readonly directory: string }) =>
  path.join(Global.Path.data, "storage", ...prefix(input))
const basename = (value: string) => Schema.is(Connect.RunID)(value) && /^[A-Za-z0-9_-]+$/.test(value)
const missing = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"

// A bounded receipt read: null when there is no file, undefined for a non-file, an oversized file or bad JSON.
const bounded = (target: string) =>
  Effect.tryPromise(async () => {
    const leaf = await lstat(target).catch((cause: unknown) => (missing(cause) ? null : Promise.reject(cause)))
    if (leaf === null) return null
    if (!leaf.isFile()) return undefined
    const file = await open(target, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = await file.stat()
      if (!info.isFile()) return undefined
      const size = info.size
      if (size > MAX_BYTES) return undefined
      const buffer = Buffer.alloc(size + 1)
      const result = await file.read(buffer, 0, buffer.length, 0)
      if (result.bytesRead > size) return undefined
      const text = buffer.subarray(0, result.bytesRead).toString("utf8")
      return { value: JSON.parse(text) as unknown, digest: hash(text), bytes: result.bytesRead }
    } finally {
      await file.close()
    }
  }).pipe(Effect.orElseSucceed(() => undefined))

/** Bounded reads in the existing Storage namespace; the general Storage reader has no byte limit. */
export const load = Effect.fn("ConnectDirectory.load")(function* (
  input: { readonly projectID: string; readonly directory: string },
  runID: string,
) {
  if (!basename(runID)) return undefined
  const raw = yield* bounded(path.join(folder(input), `${runID}.json`))
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Receipt)(raw?.value))
  if (
    !decoded ||
    !raw ||
    decoded.projectID !== input.projectID ||
    FileLock.key(decoded.directory) !== FileLock.key(input.directory) ||
    decoded.run.id !== runID ||
    decoded.run.request.id !== runID ||
    decoded.run.request.requester.kind !== "user" ||
    decoded.run.request.requester.sessionID !== undefined ||
    decoded.run.request.action !== "review" ||
    decoded.run.request.to !== "vectorscope" ||
    FileLock.key(decoded.run.request.directory) !== FileLock.key(input.directory) ||
    !current({ sessionID: decoded.anchor, ...decoded })
  )
    return undefined
  return { ...decoded, digest: raw.digest }
})

/**
 * What a directory run's receipt says, for the request ledger's retention. The receipt is found by the two hashes
 * `prefix` names its folder by, so a directory that was deleted or replaced can still be settled. `gone`: the folder
 * exists but the receipt does not. The hub writes the receipt before the request key binds, and only `prune` removes
 * one, after it is done. `bytes` is what was read, so a caller can bound its reads.
 */
export interface Settled {
  readonly kind: "done" | "open" | "gone" | "unknown"
  readonly ended?: number
  readonly bytes: number
}

export const settled = Effect.fn("ConnectDirectory.settled")(function* (
  place: { readonly project: string; readonly directory: string },
  run: { readonly runID: string; readonly anchorID: string },
) {
  const unknown: Settled = { kind: "unknown", bytes: 0 }
  if (!/^[0-9a-f]{64}$/.test(place.project) || !/^[0-9a-f]{64}$/.test(place.directory) || !basename(run.runID))
    return unknown
  const directory = path.join(Global.Path.data, "storage", "connect-directory", place.project, place.directory)
  const raw = yield* bounded(path.join(directory, `${run.runID}.json`))
  if (raw === null) {
    // Without the folder there is no evidence the receipt ever existed here: another data root, or a tampered tree.
    const present = yield* Effect.tryPromise(() => lstat(directory)).pipe(
      Effect.map((info) => info.isDirectory()),
      Effect.orElseSucceed(() => false),
    )
    return present ? ({ kind: "gone", bytes: 0 } satisfies Settled) : unknown
  }
  if (!raw) return unknown
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Receipt)(raw.value))
  if (
    !decoded ||
    decoded.run.id !== run.runID ||
    decoded.run.request.id !== run.runID ||
    decoded.anchor !== run.anchorID ||
    hash(decoded.projectID) !== place.project ||
    hash(decoded.canonical) !== place.directory
  )
    return { kind: "unknown", bytes: raw.bytes } satisfies Settled
  if (decoded.run.status !== "done") return { kind: "open", bytes: raw.bytes } satisfies Settled
  return {
    kind: "done",
    ...(decoded.run.time.ended !== undefined ? { ended: decoded.run.time.ended } : {}),
    bytes: raw.bytes,
  } satisfies Settled
})

export const list = (input: { readonly projectID: string; readonly directory: string }, limit: number) =>
  Effect.tryPromise(() => readdir(folder(input))).pipe(
    Effect.orElseSucceed(() => []),
    Effect.map((names) =>
      names
        .filter((name) => name.endsWith(".json") && basename(name.slice(0, -5)))
        .map((name) => name.slice(0, -5))
        .toSorted((a, b) => b.localeCompare(a))
        .slice(0, limit),
    ),
  )

/** Keep bounded terminal history without deleting an active receipt or any session's accounting/lineage. */
export const prune = Effect.fn("ConnectDirectory.prune")(function* (
  input: { readonly projectID: string; readonly directory: string },
  keep: number,
) {
  const ids = yield* list(input, Number.MAX_SAFE_INTEGER)
  let completed = 0
  for (const id of ids) {
    const receipt = yield* load(input, id)
    if (!receipt || receipt.run.status !== "done") continue
    if (++completed <= keep) continue
    yield* Effect.tryPromise(() => rm(path.join(folder(input), `${id}.json`), { force: true })).pipe(
      Effect.orElseSucceed(() => undefined),
    )
  }
})

/** Storage's namespace and reader, with a narrow atomic writer: a half-written result must never become a verdict. */
function* writeReceipt(token: Token, run: Connect.Run) {
  const binding = read(token)
  const writer = writers.get(token)
  if (
    !binding ||
    !current(binding) ||
    !writer ||
    (writer.terminal && run.status !== "done") ||
    !Schema.is(Connect.Run)(run) ||
    !basename(run.id) ||
    run.id !== run.request.id ||
    run.request.requester.kind !== "user" ||
    run.request.requester.sessionID !== undefined ||
    run.request.action !== "review" ||
    run.request.to !== "vectorscope" ||
    FileLock.key(run.request.directory) !== FileLock.key(binding.directory) ||
    (runs.has(token) && runs.get(token) !== run.id)
  )
    return yield* new Error({
      phase: "authority",
      message: "The directory review receipt has no valid writer authority.",
    })
  if (run.status === "done") writer.terminal = true
  runs.set(token, run.id)
  const value = JSON.stringify({
    version: 1,
    anchor: binding.sessionID,
    projectID: binding.projectID,
    directory: binding.directory,
    canonical: binding.canonical,
    identity: binding.identity,
    run,
  })
  if (Buffer.byteLength(value) > MAX_BYTES)
    return yield* new Error({ phase: "size", message: "The directory review result exceeds its receipt limit." })
  let phase: typeof WritePhase.Type = "retired-before-write"
  yield* Effect.tryPromise({
    try: () => {
      const pending = writer.tail.then(async () => {
        const active = () => read(token) === binding && current(binding) && !(writer.terminal && run.status !== "done")
        if (!active()) throw new Error({ message: "The receipt writer was retired." })
        const directory = folder(binding)
        phase = "mkdir"
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const target = path.join(directory, `${run.id}.json`)
        const temporary = `${target}.${randomUUID()}.tmp`
        try {
          phase = "write"
          await writeFile(temporary, value, { mode: 0o600, flag: "wx" })
          phase = "retired-before-rename"
          if (!active()) throw new Error({ message: "The receipt writer was retired." })
          phase = "rename"
          await rename(temporary, target)
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined)
        }
      })
      writer.tail = pending.then(
        () => undefined,
        () => undefined,
      )
      return pending
    },
    catch: (cause) => {
      const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined
      return new Error({
        phase,
        message: "The directory review receipt could not be saved.",
        ...(Schema.is(FileErrorCode)(code) ? { code } : {}),
      })
    },
  })
  return hash(value)
}

export const write = Effect.fn("ConnectDirectory.write")(writeReceipt, (effect, _token, run) =>
  run.status === "done"
    ? effect.pipe(
        Effect.tapError(({ phase, code }) =>
          Effect.logWarning("Could not save directory review receipt", { phase, code }),
        ),
      )
    : effect,
)
