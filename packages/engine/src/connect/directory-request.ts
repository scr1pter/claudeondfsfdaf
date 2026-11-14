export * as ConnectDirectoryRequest from "./directory-request"

import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Global } from "@vectordevai/core/global"
import { EffectFlock } from "@vectordevai/core/util/effect-flock"
import { Connect } from "@vectordevai/schema/connect"
import { NonNegativeInt } from "@vectordevai/schema/schema"
import { SessionID } from "@/session/schema"
import { ConnectDirectory } from "./directory"

export const MAX_KEYS = 4_096
export const MAX_TOTAL_KEYS = 65_536
export const MAX_RECORD_BYTES = 4 * 1024
export const MAX_INDEX_BYTES = 1024 * 1024
export const MAX_TOTAL_INDEX_BYTES = 16 * 1024 * 1024

const Key = Connect.DirectoryRequestKey.check(Schema.isPattern(/^[0-9a-f-]+$/))
const Digest = Schema.String.check(Schema.isLengthBetween(64, 64), Schema.isPattern(/^[0-9a-f]+$/))
const Reservation = Schema.Struct({
  version: Schema.Literal(1),
  key: Key,
  scopeDigest: Digest,
  inputDigest: Digest,
  nonce: Key,
  createdAt: NonNegativeInt,
})
const Binding = Schema.Struct({
  ...Reservation.fields,
  anchorID: SessionID.check(Schema.isMaxLength(128)),
  runID: Connect.RunID.check(Schema.isPattern(/^cr_[A-Za-z0-9_-]+$/)),
})
const keyIndex = (maximum: number) =>
  Schema.Struct({
    version: Schema.Literal(1),
    entries: Schema.Array(Schema.Struct({ key: Key, digest: Digest })).check(
      Schema.isMaxLength(maximum),
      Schema.makeFilter((entries) => new Set(entries.map((entry) => entry.key)).size === entries.length),
    ),
  })
const Index = keyIndex(MAX_KEYS)
const GlobalIndex = keyIndex(MAX_TOTAL_KEYS)

export interface Scope {
  readonly projectID: string
  readonly directory: string
}
interface FrozenScope extends Scope {
  readonly canonical: string
  readonly identity: string
}
export interface Proof {
  readonly key: string
  readonly scopeDigest: string
  readonly inputDigest: string
}
export type Bound = typeof Binding.Type
export type Token = object
interface Claim {
  readonly scope: FrozenScope
  readonly input: Connect.DirectoryReviewInput
  readonly proof: Proof
  readonly record: typeof Reservation.Type
}
export type Start =
  | { readonly kind: "reserved"; readonly token: Token; readonly claim: Claim }
  | { readonly kind: "bound"; readonly binding: Bound; readonly proof: Proof }

export class Error extends Schema.TaggedErrorClass<Error>()("ConnectDirectoryRequest.Error", {
  code: Schema.Literals(["pending", "mismatch", "unavailable"]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly reserve: (scope: Scope, input: Connect.DirectoryReviewInput) => Effect.Effect<Start, Error>
  /** Called only inside the hub's genuine durable-job/queued-receipt gate, before execution is released. */
  readonly bind: (
    token: Token,
    value: { readonly anchorID: SessionID; readonly runID: Connect.RunID },
  ) => Effect.Effect<void, Error>
}
export class Service extends Context.Service<Service, Interface>()("@vector/ConnectDirectoryRequest") {}

const unavailable = () =>
  new Error({ code: "unavailable", message: "The directory request ledger is unavailable. No new review was started." })
const mismatch = () =>
  new Error({
    code: "mismatch",
    message: "This request key already belongs to a different directory identity or review input.",
  })
const pending = () =>
  new Error({
    code: "pending",
    message: "This request remains reserved without a confirmed run. Reconcile it before starting a new review.",
  })
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
export const prefix = (scope: { readonly projectID: string; readonly canonical: string }) => [
  "connect-directory-requests",
  "scopes",
  hash(scope.projectID),
  hash(scope.canonical),
]
const missing = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
const ordered = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(ordered)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, ordered(item)]),
    )
  return value
}

/** A bounded regular-file reader. A partial/tampered key is consumed/unavailable, never a new admission. */
const read = <S extends Schema.Codec<unknown, unknown>>(file: string, schema: S, limit: number) =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: async () => {
        const info = await lstat(file).catch((cause: unknown) => (missing(cause) ? undefined : Promise.reject(cause)))
        if (!info) return undefined
        if (!info.isFile()) throw unavailable()
        const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
        try {
          const actual = await handle.stat()
          if (!actual.isFile() || actual.size > limit) throw unavailable()
          const buffer = Buffer.alloc(actual.size + 1)
          let count = 0
          while (count < buffer.length) {
            const result = await handle.read(buffer, count, buffer.length - count, count)
            if (result.bytesRead === 0) break
            count += result.bytesRead
          }
          if (count !== actual.size) throw unavailable()
          const text = buffer.subarray(0, count).toString("utf8")
          return { value: JSON.parse(text) as unknown, digest: hash(text) }
        } finally {
          await handle.close()
        }
      },
      catch: unavailable,
    })
    if (!raw) return undefined
    const value = Schema.decodeUnknownOption(schema)(raw.value)
    if (Option.isNone(value)) return yield* unavailable()
    return { value: value.value, digest: raw.digest }
  })

const names = (folder: string, limit: number) =>
  Effect.tryPromise({
    try: async () => {
      const entries = await readdir(folder, { withFileTypes: true }).catch((cause: unknown) =>
        missing(cause) ? [] : Promise.reject(cause),
      )
      if (
        entries.length > limit ||
        entries.some(
          (entry) => !entry.isFile() || !entry.name.endsWith(".json") || !Schema.is(Key)(entry.name.slice(0, -5)),
        )
      )
        throw unavailable()
      return entries.map((entry) => entry.name.slice(0, -5)).sort()
    },
    catch: unavailable,
  })

const text = (value: unknown, limit: number) => {
  const encoded = JSON.stringify(value)
  if (typeof encoded !== "string" || Buffer.byteLength(encoded) > limit) throw unavailable()
  return encoded
}
const exclusive = (file: string, value: unknown, limit: number) =>
  Effect.tryPromise({
    try: async () => {
      const encoded = text(value, limit)
      const handle = await open(file, "wx", 0o600)
      try {
        await handle.writeFile(encoded)
        await handle.sync()
      } finally {
        await handle.close()
      }
      return hash(encoded)
    },
    catch: unavailable,
  })
const atomic = (file: string, value: unknown, limit: number) =>
  Effect.gen(function* () {
    const temporary = `${file}.${randomUUID()}.tmp`
    return yield* exclusive(temporary, value, limit).pipe(
      Effect.tap(() => Effect.tryPromise({ try: () => rename(temporary, file), catch: unavailable })),
      Effect.ensuring(Effect.promise(() => rm(temporary, { force: true }).catch(() => undefined))),
    )
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const flock = yield* EffectFlock.Service
    const root = path.join(global.data, "storage", "connect-directory-requests")
    const pointers = path.join(root, "by-key")
    const globalIndexFile = path.join(root, "index.json")
    const locks = path.join(root, "locks")
    const active = new WeakMap<Token, Claim>()
    const paths = (scope: FrozenScope) => {
      const folder = path.join(global.data, "storage", ...prefix(scope))
      return {
        folder,
        slots: path.join(folder, "keys"),
        bindings: path.join(folder, "bindings"),
        index: path.join(folder, "index.json"),
      }
    }
    const locked = <A, E, R>(body: Effect.Effect<A, E, R>, key: string) =>
      flock
        .withLock(body, key, locks)
        .pipe(Effect.mapError((cause) => (cause instanceof Error ? cause : unavailable())))
    const globalIndex = Effect.fn("ConnectDirectoryRequest.globalIndex")(function* () {
      yield* Effect.tryPromise({ try: () => mkdir(pointers, { recursive: true, mode: 0o700 }), catch: unavailable })
      const files = yield* names(pointers, MAX_TOTAL_KEYS)
      const stored = yield* read(globalIndexFile, GlobalIndex, MAX_TOTAL_INDEX_BYTES)
      if (!stored) {
        if (files.length) return yield* unavailable()
        const scopes = yield* Effect.tryPromise({
          try: () =>
            lstat(path.join(root, "scopes"))
              .then(() => true)
              .catch((cause: unknown) => (missing(cause) ? false : Promise.reject(cause))),
          catch: unavailable,
        })
        if (scopes) return yield* unavailable()
        const empty = { version: 1, entries: [] } as const
        yield* atomic(globalIndexFile, empty, MAX_TOTAL_INDEX_BYTES)
        return empty
      }
      if (JSON.stringify(stored.value.entries.map((entry) => entry.key).sort()) !== JSON.stringify(files))
        return yield* unavailable()
      return stored.value
    })
    const index = Effect.fn("ConnectDirectoryRequest.index")(function* (
      place: ReturnType<typeof paths>,
      initialize: boolean,
    ) {
      yield* Effect.tryPromise({
        try: () =>
          Promise.all([place.slots, place.bindings].map((folder) => mkdir(folder, { recursive: true, mode: 0o700 }))),
        catch: unavailable,
      })
      const slots = yield* names(place.slots, MAX_KEYS)
      const bound = yield* names(place.bindings, MAX_KEYS)
      const stored = yield* read(place.index, Index, MAX_INDEX_BYTES)
      if (!stored) {
        if (!initialize || slots.length || bound.length) return yield* unavailable()
        const empty = { version: 1, entries: [] } as const
        yield* atomic(place.index, empty, MAX_INDEX_BYTES)
        return empty
      }
      const keys = stored.value.entries.map((entry) => entry.key).sort()
      if (JSON.stringify(keys) !== JSON.stringify(slots) || bound.some((key) => !keys.includes(key)))
        return yield* unavailable()
      return stored.value
    })
    const reserve: Interface["reserve"] = (scope, input) =>
      Effect.gen(function* () {
        // Clone before any I/O. The executed input is this owned snapshot, never the caller's later-mutated object.
        const cloned = yield* Effect.try({
          try: () =>
            Schema.decodeUnknownSync(Connect.DirectoryReviewInput)(
              JSON.parse(JSON.stringify(Schema.encodeSync(Connect.DirectoryReviewInput)(input))),
            ),
          catch: unavailable,
        })
        const { requestKey, ...payload } = cloned
        const key = requestKey.toLowerCase()
        const frozenInput = Object.freeze({
          ...cloned,
          requestKey: key,
          ...(cloned.target ? { target: Object.freeze({ ...cloned.target }) } : {}),
          ...(cloned.budget ? { budget: Object.freeze({ ...cloned.budget }) } : {}),
        })
        const identity = yield* ConnectDirectory.capture(scope.directory).pipe(Effect.mapError(unavailable))
        const frozen = Object.freeze({ ...scope, ...identity })
        const scopeDigest = hash(JSON.stringify(ordered({ projectID: scope.projectID, ...identity })))
        const inputDigest = hash(JSON.stringify(ordered({ scopeDigest, input: payload })))
        const fixedProof = Object.freeze({ key, scopeDigest, inputDigest })
        const place = paths(frozen)
        return yield* locked(
          locked(
            Effect.gen(function* () {
              const globalKeys = yield* globalIndex()
              const globalKnown = globalKeys.entries.find((entry) => entry.key === key)
              const pointerFile = path.join(pointers, `${key}.json`)
              const pointer = yield* read(pointerFile, Reservation, MAX_RECORD_BYTES)
              if (
                pointer &&
                (pointer.value.key !== key ||
                  pointer.value.scopeDigest !== fixedProof.scopeDigest ||
                  pointer.value.inputDigest !== inputDigest)
              )
                return yield* mismatch()
              const current = yield* index(place, !pointer)
              const known = current.entries.find((entry) => entry.key === key)
              if (pointer) {
                const slot = yield* read(path.join(place.slots, `${key}.json`), Reservation, MAX_RECORD_BYTES)
                if (
                  !globalKnown ||
                  globalKnown.digest !== pointer.digest ||
                  !known ||
                  !slot ||
                  known.digest !== slot.digest ||
                  slot.digest !== pointer.digest
                )
                  return yield* unavailable()
                const bound = yield* read(path.join(place.bindings, `${key}.json`), Binding, MAX_RECORD_BYTES)
                if (!bound) return yield* pending()
                if (
                  bound.value.key !== key ||
                  bound.value.nonce !== pointer.value.nonce ||
                  bound.value.scopeDigest !== fixedProof.scopeDigest ||
                  bound.value.inputDigest !== inputDigest ||
                  bound.value.createdAt !== pointer.value.createdAt
                )
                  return yield* unavailable()
                return { kind: "bound", binding: bound.value, proof: fixedProof } as const
              }
              if (
                known ||
                globalKnown ||
                globalKeys.entries.length >= MAX_TOTAL_KEYS ||
                current.entries.length >= MAX_KEYS
              )
                return yield* unavailable()
              const record = {
                version: 1,
                ...fixedProof,
                nonce: randomUUID(),
                createdAt: yield* Clock.currentTimeMillis,
              } as const
              const digest = yield* exclusive(pointerFile, record, MAX_RECORD_BYTES)
              yield* atomic(
                globalIndexFile,
                {
                  version: 1,
                  entries: [...globalKeys.entries, { key, digest }].sort((a, b) => a.key.localeCompare(b.key)),
                },
                MAX_TOTAL_INDEX_BYTES,
              )
              yield* exclusive(path.join(place.slots, `${key}.json`), record, MAX_RECORD_BYTES)
              yield* atomic(
                place.index,
                {
                  version: 1,
                  entries: [...current.entries, { key, digest }].sort((a, b) => a.key.localeCompare(b.key)),
                },
                MAX_INDEX_BYTES,
              )
              const token = Object.freeze({})
              const claim = Object.freeze({ scope: frozen, input: frozenInput, proof: fixedProof, record })
              active.set(token, claim)
              return { kind: "reserved", token, claim } as const
            }),
            `directory-request:scope:${hash(frozen.projectID)}:${hash(frozen.canonical)}`,
          ),
          "directory-request:global",
        )
      })
    const bind: Interface["bind"] = (token, value) =>
      Effect.gen(function* () {
        const claim = active.get(token)
        if (!claim || !ConnectDirectory.current({ sessionID: value.anchorID, ...claim.scope }))
          return yield* unavailable()
        const place = paths(claim.scope)
        yield* locked(
          locked(
            Effect.gen(function* () {
              const globalKeys = yield* globalIndex()
              const globalKnown = globalKeys.entries.find((entry) => entry.key === claim.proof.key)
              const pointer = yield* read(path.join(pointers, `${claim.proof.key}.json`), Reservation, MAX_RECORD_BYTES)
              const current = yield* index(place, false)
              const known = current.entries.find((entry) => entry.key === claim.proof.key)
              const slot = yield* read(path.join(place.slots, `${claim.proof.key}.json`), Reservation, MAX_RECORD_BYTES)
              if (
                !pointer ||
                !globalKnown ||
                globalKnown.digest !== pointer.digest ||
                !known ||
                !slot ||
                pointer.digest !== known.digest ||
                slot.digest !== known.digest ||
                pointer.value.nonce !== claim.record.nonce ||
                pointer.value.scopeDigest !== claim.proof.scopeDigest ||
                pointer.value.inputDigest !== claim.proof.inputDigest
              )
                return yield* unavailable()
              const bound = { ...claim.record, ...value }
              if (
                !Schema.is(Binding)(bound) ||
                !ConnectDirectory.current({ sessionID: value.anchorID, ...claim.scope })
              )
                return yield* unavailable()
              yield* exclusive(path.join(place.bindings, `${claim.proof.key}.json`), bound, MAX_RECORD_BYTES)
              active.delete(token)
            }),
            `directory-request:scope:${hash(claim.scope.projectID)}:${hash(claim.scope.canonical)}`,
          ),
          "directory-request:global",
        )
      })
    return Service.of({ reserve, bind })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Global.node, EffectFlock.node] })
