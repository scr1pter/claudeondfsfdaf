export * as ConnectDirectoryRequest from "./directory-request"

import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { Clock, Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Global } from "@vectordevai/core/global"
import { EffectFlock } from "@vectordevai/core/util/effect-flock"
import { Connect } from "@vectordevai/schema/connect"
import { NonNegativeInt, PositiveInt } from "@vectordevai/schema/schema"
import { SessionID } from "@/session/schema"
import { ConnectDirectory } from "./directory"

export const MAX_KEYS = 4_096
export const MAX_TOTAL_KEYS = 65_536
export const MAX_RECORD_BYTES = 4 * 1024
export const MAX_INDEX_BYTES = 1024 * 1024
export const MAX_TOTAL_INDEX_BYTES = 16 * 1024 * 1024
/** How long a reservation or prepared anchor may wait for its writer before an owner retry reconciles it. */
export const GRACE_MS = 10 * 60_000
/** How long the owner's read-only evidence may hold the global lock before the key answers unavailable instead. */
export const INSPECT_MS = 10_000

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
const Anchor = SessionID.check(Schema.isMaxLength(128))
const Binding = Schema.Struct({
  ...Reservation.fields,
  anchorID: Anchor,
  runID: Connect.RunID.check(Schema.isPattern(/^cr_[A-Za-z0-9_-]+$/)),
})
const Writer = Schema.Struct({ pid: PositiveInt.check(Schema.isLessThanOrEqualTo(2 ** 31 - 1)), start: NonNegativeInt })
export type Writer = typeof Writer.Type
/** Written once the anchor exists and before the hub runs, so a reconciling retry knows which anchor to inspect. */
const PreparedRecord = Schema.Struct({
  ...Reservation.fields,
  anchorID: Anchor,
  writer: Writer,
  preparedAt: NonNegativeInt,
})
export const Reason = Schema.Literals(["agent", "anchor", "prepare", "fence", "issue", "run", "bind", "abandoned"])
export type Reason = typeof Reason.Type
/** A terminal tombstone: the key stays consumed, nothing is deleted, and `bind` refuses it. */
const Refused = Schema.Struct({
  ...Reservation.fields,
  reason: Reason,
  anchorID: Schema.optional(Anchor),
  refusedAt: NonNegativeInt,
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
export interface Prepared {
  readonly anchorID: SessionID
  readonly proof: Proof
}
/**
 * What the owner knows about a stale key's prepared anchor. `unknown` (a job whose receipt cannot be trusted, or a
 * live foreign owner) leaves the key unavailable with no write; `stop` runs only after the ledger's locks are released.
 */
export type Evidence =
  | { readonly kind: "released"; readonly runID: Connect.RunID }
  | { readonly kind: "unreleased"; readonly stop?: Effect.Effect<void> }
  | { readonly kind: "unknown" }
export type Inspect = (prepared: Prepared) => Effect.Effect<Evidence>

export class Error extends Schema.TaggedErrorClass<Error>()("ConnectDirectoryRequest.Error", {
  code: Schema.Literals(["pending", "mismatch", "unavailable", "consumed"]),
  message: Schema.String,
}) {}

export interface Interface {
  /** With `inspect`, a stale key no live claim can hold reconciles to `bound` or `consumed` instead of `pending`. */
  readonly reserve: (
    scope: Scope,
    input: Connect.DirectoryReviewInput,
    inspect?: Inspect,
  ) => Effect.Effect<Start, Error>
  /** Records the anchor right after it is created and before the hub runs. */
  readonly prepare: (token: Token, anchorID: SessionID) => Effect.Effect<void, Error>
  /**
   * Called only inside the hub's genuine durable-job/queued-receipt gate, before execution is released. `onBound` runs
   * inside the locked, uninterruptible body right after the binding write, so a caller whose interrupt surfaces only
   * once that body ends still learns the key was bound.
   */
  readonly bind: (
    token: Token,
    value: { readonly anchorID: SessionID; readonly runID: Connect.RunID },
    onBound?: () => void,
  ) => Effect.Effect<void, Error>
  /** A known failure before the binding gate: tombstones the key unless it is already bound or tombstoned. */
  readonly refuse: (
    token: Token,
    input: { readonly reason: Reason; readonly anchorID?: SessionID },
  ) => Effect.Effect<void, Error>
  /** An unknown outcome (interruption): drops the token and writes nothing, so the next retry reconciles at once. */
  readonly release: (token: Token) => Effect.Effect<void>
}
export class Service extends Context.Service<Service, Interface>()("@vector/ConnectDirectoryRequest") {}

/** The reconcile grace, this process's writer identity and the evidence bound, read on every call; tests replace them. */
export interface Settings {
  readonly graceMs: number
  readonly writer: Writer
  /** Defaults to `INSPECT_MS`. */
  readonly inspectMs?: number
}
export const Options = Context.Reference<Settings>("@vector/ConnectDirectoryRequest.Options", {
  defaultValue: () => ({
    graceMs: GRACE_MS,
    writer: { pid: process.pid, start: Math.floor(performance.timeOrigin) },
  }),
})

// Keys (by ledger root and key) this process holds a live token for, and keys it dropped without a binding or a
// tombstone. Process-wide, so every layer instance agrees: a held key is never reconciled, a dropped one at once.
const live = new Set<string>()
const dropped = new Set<string>()

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
    message: "This review start is not confirmed yet. Retry it shortly; a retry never starts a second review.",
  })
const consumed = () =>
  new Error({ code: "consumed", message: "This review start did not complete and no review ran. Start a new review." })
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

// Whether a live claim may still hold this key: a token of this process, a young reservation this process did not
// drop, or a young prepared anchor whose writer may still run. The same pid with another start time is an earlier run
// of that pid; the same pid and start is this process, which holds no token for it.
const claimed = (
  key: string,
  reservation: typeof Reservation.Type,
  prepared: typeof PreparedRecord.Type | undefined,
  now: number,
  options: Settings,
) => {
  if (live.has(key)) return true
  if (!prepared) return !dropped.has(key) && now - reservation.createdAt < options.graceMs
  if (now - prepared.preparedAt >= options.graceMs) return false
  if (prepared.writer.pid !== options.writer.pid) return !BackgroundJobStore.exited(prepared.writer.pid)
  return prepared.writer.start === options.writer.start && !dropped.has(key)
}
const same = (record: typeof Reservation.Type, reservation: typeof Reservation.Type) =>
  record.version === reservation.version &&
  record.key === reservation.key &&
  record.nonce === reservation.nonce &&
  record.scopeDigest === reservation.scopeDigest &&
  record.inputDigest === reservation.inputDigest &&
  record.createdAt === reservation.createdAt

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
    const id = (key: string) => `${root}\0${key}`
    const paths = (scope: FrozenScope) => {
      const folder = path.join(global.data, "storage", ...prefix(scope))
      return {
        folder,
        slots: path.join(folder, "keys"),
        bindings: path.join(folder, "bindings"),
        prepared: path.join(folder, "prepared"),
        refused: path.join(folder, "refused"),
        index: path.join(folder, "index.json"),
      }
    }
    const locked = <A, E, R>(body: Effect.Effect<A, E, R>, key: string) =>
      flock
        .withLock(body, key, locks)
        .pipe(Effect.mapError((cause) => (cause instanceof Error ? cause : unavailable())))
    // Global then scope lock, in that order everywhere. The body is uninterruptible: an interrupted caller waits for
    // its O_EXCL write, so no later decision can race a write still in flight after the lock was released.
    const both = <A, E, R>(scope: FrozenScope, body: Effect.Effect<A, E, R>) =>
      locked(
        locked(
          Effect.uninterruptible(body),
          `directory-request:scope:${hash(scope.projectID)}:${hash(scope.canonical)}`,
        ),
        "directory-request:global",
      )
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
          Promise.all(
            [place.slots, place.bindings, place.prepared, place.refused].map((folder) =>
              mkdir(folder, { recursive: true, mode: 0o700 }),
            ),
          ),
        catch: unavailable,
      })
      const slots = yield* names(place.slots, MAX_KEYS)
      const extra = [
        ...(yield* names(place.bindings, MAX_KEYS)),
        ...(yield* names(place.prepared, MAX_KEYS)),
        ...(yield* names(place.refused, MAX_KEYS)),
      ]
      const stored = yield* read(place.index, Index, MAX_INDEX_BYTES)
      if (!stored) {
        if (!initialize || slots.length || extra.length) return yield* unavailable()
        const empty = { version: 1, entries: [] } as const
        yield* atomic(place.index, empty, MAX_INDEX_BYTES)
        return empty
      }
      const keys = stored.value.entries.map((entry) => entry.key).sort()
      const indexed = new Set(keys)
      if (JSON.stringify(keys) !== JSON.stringify(slots) || extra.some((key) => !indexed.has(key)))
        return yield* unavailable()
      return stored.value
    })
    // A key's binding, tombstone and prepared anchor, each held to the reservation it extends. Corrupt or
    // contradictory records are unavailable, never repaired.
    const records = Effect.fnUntraced(function* (
      place: ReturnType<typeof paths>,
      reservation: typeof Reservation.Type,
    ) {
      const file = (folder: string) => path.join(folder, `${reservation.key}.json`)
      const bound = (yield* read(file(place.bindings), Binding, MAX_RECORD_BYTES))?.value
      const refused = (yield* read(file(place.refused), Refused, MAX_RECORD_BYTES))?.value
      const prepared = (yield* read(file(place.prepared), PreparedRecord, MAX_RECORD_BYTES))?.value
      if (
        (bound && refused) ||
        [bound, refused, prepared].some((record) => record !== undefined && !same(record, reservation)) ||
        (prepared && bound && prepared.anchorID !== bound.anchorID) ||
        (prepared && refused?.anchorID !== undefined && prepared.anchorID !== refused.anchorID)
      )
        return yield* unavailable()
      return { bound, refused, prepared }
    })
    // The claim's reservation is still the one on disk: the global pointer, both indexes and the slot agree.
    const held = Effect.fnUntraced(function* (claim: Claim) {
      const place = paths(claim.scope)
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
      return { place, ...(yield* records(place, claim.record)) }
    })
    const tombstone = Effect.fnUntraced(function* (
      place: ReturnType<typeof paths>,
      reservation: typeof Reservation.Type,
      input: { readonly reason: Reason; readonly anchorID?: SessionID },
    ) {
      const record = {
        ...reservation,
        reason: input.reason,
        ...(input.anchorID ? { anchorID: input.anchorID } : {}),
        refusedAt: yield* Clock.currentTimeMillis,
      }
      if (!Schema.is(Refused)(record)) return yield* unavailable()
      yield* exclusive(path.join(place.refused, `${reservation.key}.json`), record, MAX_RECORD_BYTES)
      dropped.delete(id(reservation.key))
    })
    const reserve: Interface["reserve"] = (scope, input, inspect) =>
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
        const options = yield* Options
        const outcome = yield* both(
          frozen,
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
              const found = yield* records(place, pointer.value)
              if (found.refused) {
                dropped.delete(id(key))
                return { kind: "consumed" } as const
              }
              if (found.bound) return { kind: "bound", binding: found.bound, proof: fixedProof } as const
              if (claimed(id(key), pointer.value, found.prepared, yield* Clock.currentTimeMillis, options))
                return yield* pending()
              if (!found.prepared) {
                yield* tombstone(place, pointer.value, { reason: "abandoned" })
                return { kind: "consumed" } as const
              }
              // Only the owner can tell whether the anchor's job was released, so a bare ledger never guesses.
              if (!inspect) return yield* unavailable()
              const anchorID = found.prepared.anchorID
              // The owner's reads run under the process-wide lock, so they are bounded: a stuck read answers unknown
              // (no write) instead of stalling every directory start. They write nothing, so they may be cut short.
              const evidence = yield* Effect.interruptible(inspect({ anchorID, proof: fixedProof })).pipe(
                Effect.timeoutOrElse({
                  duration: options.inspectMs ?? INSPECT_MS,
                  orElse: () => Effect.succeed({ kind: "unknown" } as const),
                }),
              )
              if (evidence.kind === "unknown") return yield* unavailable()
              if (evidence.kind === "unreleased") {
                yield* tombstone(place, pointer.value, { reason: "abandoned", anchorID })
                return { kind: "consumed", ...(evidence.stop ? { stop: evidence.stop } : {}) } as const
              }
              const binding = { ...pointer.value, anchorID, runID: evidence.runID }
              if (!Schema.is(Binding)(binding)) return yield* unavailable()
              yield* exclusive(path.join(place.bindings, `${key}.json`), binding, MAX_RECORD_BYTES)
              dropped.delete(id(key))
              return { kind: "bound", binding, proof: fixedProof } as const
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
            live.add(id(key))
            return { kind: "reserved", token, claim } as const
          }),
        )
        if (outcome.kind !== "consumed") return outcome
        // The tombstone is on disk, so a late bind of the cancelled job is refused under the lock.
        if (outcome.stop) yield* outcome.stop
        return yield* consumed()
      })
    const prepare: Interface["prepare"] = (token, anchorID) =>
      Effect.gen(function* () {
        const claim = active.get(token)
        if (!claim) return yield* unavailable()
        const options = yield* Options
        yield* both(
          claim.scope,
          Effect.gen(function* () {
            const found = yield* held(claim)
            if (found.refused) return yield* consumed()
            if (found.bound || found.prepared) return yield* unavailable()
            const record = {
              ...claim.record,
              anchorID,
              writer: options.writer,
              preparedAt: yield* Clock.currentTimeMillis,
            }
            if (!Schema.is(PreparedRecord)(record)) return yield* unavailable()
            yield* exclusive(path.join(found.place.prepared, `${claim.proof.key}.json`), record, MAX_RECORD_BYTES)
          }),
        )
      })
    const bind: Interface["bind"] = (token, value, onBound) =>
      Effect.gen(function* () {
        const claim = active.get(token)
        if (!claim || !ConnectDirectory.current({ sessionID: value.anchorID, ...claim.scope }))
          return yield* unavailable()
        yield* both(
          claim.scope,
          Effect.gen(function* () {
            const found = yield* held(claim)
            if (found.refused) return yield* consumed()
            if (found.prepared && found.prepared.anchorID !== value.anchorID) return yield* unavailable()
            const bound = { ...claim.record, ...value }
            if (!Schema.is(Binding)(bound) || !ConnectDirectory.current({ sessionID: value.anchorID, ...claim.scope }))
              return yield* unavailable()
            yield* exclusive(path.join(found.place.bindings, `${claim.proof.key}.json`), bound, MAX_RECORD_BYTES)
            active.delete(token)
            live.delete(id(claim.proof.key))
            onBound?.()
          }),
        )
      })
    const drop = (token: Token, claim: Claim, tombstoned: boolean) => {
      active.delete(token)
      live.delete(id(claim.proof.key))
      if (!tombstoned) dropped.add(id(claim.proof.key))
    }
    const refuse: Interface["refuse"] = (token, input) =>
      Effect.gen(function* () {
        const claim = active.get(token)
        if (!claim) return
        yield* both(
          claim.scope,
          Effect.gen(function* () {
            const found = yield* held(claim)
            if (found.bound || found.refused) return
            yield* tombstone(found.place, claim.record, input)
          }),
        ).pipe(Effect.onExit((exit) => Effect.sync(() => drop(token, claim, Exit.isSuccess(exit)))))
      })
    const release: Interface["release"] = (token) =>
      Effect.sync(() => {
        const claim = active.get(token)
        if (claim) drop(token, claim, false)
      })
    return Service.of({ reserve, prepare, bind, refuse, release })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Global.node, EffectFlock.node] })
