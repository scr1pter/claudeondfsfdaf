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

export class Error extends Schema.TaggedErrorClass<Error>()("ConnectDirectory.Error", {
  message: Schema.String,
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

export function prefix(input: { readonly projectID: string; readonly directory: string; readonly canonical?: string }) {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex")
  return ["connect-directory", hash(input.projectID), hash(input.canonical ?? FileLock.key(input.directory))]
}

const folder = (input: { readonly projectID: string; readonly directory: string }) =>
  path.join(Global.Path.data, "storage", ...prefix(input))
const basename = (value: string) => Schema.is(Connect.RunID)(value) && /^[A-Za-z0-9_-]+$/.test(value)

/** Bounded reads in the existing Storage namespace; the general Storage reader has no byte limit. */
export const load = Effect.fn("ConnectDirectory.load")(function* (
  input: { readonly projectID: string; readonly directory: string },
  runID: string,
) {
  if (!basename(runID)) return undefined
  const raw = yield* Effect.tryPromise(async () => {
    const target = path.join(folder(input), `${runID}.json`)
    if (!(await lstat(target)).isFile()) return undefined
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
      return { value: JSON.parse(text) as unknown, digest: createHash("sha256").update(text).digest("hex") }
    } finally {
      await file.close()
    }
  }).pipe(Effect.orElseSucceed(() => undefined))
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
export const write = Effect.fn("ConnectDirectory.write")(function* (token: Token, run: Connect.Run) {
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
    return yield* new Error({ message: "The directory review receipt has no valid writer authority." })
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
    return yield* new Error({ message: "The directory review result exceeds its receipt limit." })
  yield* Effect.tryPromise({
    try: () => {
      const pending = writer.tail.then(async () => {
        const active = () => read(token) === binding && current(binding) && !(writer.terminal && run.status !== "done")
        if (!active()) throw new Error({ message: "The receipt writer was retired." })
        const directory = folder(binding)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const target = path.join(directory, `${run.id}.json`)
        const temporary = `${target}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, value, { mode: 0o600, flag: "wx" })
          if (!active()) throw new Error({ message: "The receipt writer was retired." })
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
    catch: () => new Error({ message: "The directory review receipt could not be saved." }),
  })
  return createHash("sha256").update(value).digest("hex")
})
