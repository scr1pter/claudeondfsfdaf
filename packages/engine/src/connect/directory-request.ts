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
/** How long a settled key keeps replaying, from its tombstone or from the end of the run it bound. */
export const RETENTION_MS = 30 * 24 * 60 * 60_000
/** A full directory or ledger may prune a settled key before its retention ends, never inside this window. */
export const REPLAY_MS = 24 * 60 * 60_000
/** The most keys one admission prunes and the most entries each of its two scans inspects; the journal's bound. */
export const PRUNE_LIMIT = 64
/** The most other directories one admission inspects while it prunes. */
export const FOLDER_LIMIT = 8
/** The receipt bytes one admission reads while it prunes before it stops scanning. */
export const RECEIPT_BUDGET = 8 * 1024 * 1024

/** The ledger's caps and retention, fixed per layer so they cannot change between calls on one disk. */
export interface Limits {
  readonly maxKeys: number
  readonly maxTotalKeys: number
  readonly retentionMs: number
  readonly replayMs: number
  readonly pruneLimit: number
}
export const LIMITS: Limits = {
  maxKeys: MAX_KEYS,
  maxTotalKeys: MAX_TOTAL_KEYS,
  retentionMs: RETENTION_MS,
  replayMs: REPLAY_MS,
  pruneLimit: PRUNE_LIMIT,
}

const Key = Connect.DirectoryRequestKey.check(Schema.isPattern(/^[0-9a-f-]+$/))
const Digest = Schema.String.check(Schema.isLengthBetween(64, 64), Schema.isPattern(/^[0-9a-f]+$/))
/** The two hashes a scope's folder is named by (`prefix`), so a prune can find a key's folder from its pointer. */
const Folder = Schema.Struct({ project: Digest, directory: Digest })
type Folder = typeof Folder.Type
const Reservation = Schema.Struct({
  version: Schema.Literal(1),
  key: Key,
  scopeDigest: Digest,
  inputDigest: Digest,
  nonce: Key,
  createdAt: NonNegativeInt,
  // Absent on keys written before CN-09: those are pruned only from their own directory.
  folder: Schema.optional(Folder),
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
const distinct = (keys: ReadonlyArray<string>) => new Set(keys).size === keys.length
// `createdAt` (the reservation's) orders and prefilters prune candidates; entries written before CN-09 lack it.
const Entry = Schema.Struct({ key: Key, digest: Digest, createdAt: Schema.optional(NonNegativeInt) })
type Entry = typeof Entry.Type
const entries = (maximum: number) =>
  Schema.Array(Entry).check(
    Schema.isMaxLength(maximum),
    Schema.makeFilter((items) => distinct(items.map((entry) => entry.key))),
  )
/** Where a prune scan stopped: the next one resumes after it and wraps, so entries it cannot prune never starve it. */
const Cursor = Schema.Struct({ createdAt: NonNegativeInt, key: Key })
type Cursor = typeof Cursor.Type
const Mark = Schema.Struct({ key: Key, folder: Folder })
type Mark = typeof Mark.Type
const Index = Schema.Struct({ version: Schema.Literal(1), entries: entries(MAX_KEYS), cursor: Schema.optional(Cursor) })
type IndexValue = typeof Index.Type
const GlobalIndex = Schema.Struct({
  version: Schema.Literal(1),
  entries: entries(MAX_TOTAL_KEYS),
  cursor: Schema.optional(Cursor),
  // The prune journal: keys already gone from `entries` whose scope entry and files may still exist.
  pruning: Schema.optional(
    Schema.Array(Mark).check(
      Schema.isMaxLength(PRUNE_LIMIT),
      Schema.makeFilter((marks) => distinct(marks.map((mark) => mark.key))),
    ),
  ),
  // The admission intent: a key in `entries` whose pointer, slot or scope entry may not be written yet.
  admitting: Schema.optional(Mark),
}).check(
  Schema.makeFilter(
    (value: {
      readonly entries: ReadonlyArray<{ readonly key: string }>
      readonly pruning?: ReadonlyArray<{ readonly key: string }>
      readonly admitting?: { readonly key: string }
    }) => {
      const keys = new Set(value.entries.map((entry) => entry.key))
      return (
        !(value.pruning ?? []).some((mark) => keys.has(mark.key)) &&
        (value.admitting === undefined || keys.has(value.admitting.key))
      )
    },
  ),
)
type GlobalValue = typeof GlobalIndex.Type

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
export type InspectOpen = (binding: Bound, receipt: ConnectDirectory.OpenReceipt) => Effect.Effect<boolean>

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
    inspectOpen?: InspectOpen,
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
const folderOf = (scope: { readonly projectID: string; readonly canonical: string }): Folder => ({
  project: hash(scope.projectID),
  directory: hash(scope.canonical),
})
const folderKey = (folder: Folder) => `${folder.project}/${folder.directory}`
const byKey = (a: { readonly key: string }, b: { readonly key: string }) => a.key.localeCompare(b.key)
type Aged = { readonly createdAt?: number; readonly key: string }
const byAge = (a: Aged, b: Aged) =>
  (a.createdAt ?? 0) - (b.createdAt ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
const within = (value: number, minimum: number, maximum: number) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum
// The byte caps stay constants, so the configured caps may only be smaller.
const valid = (limits: Limits) =>
  within(limits.maxKeys, 1, MAX_KEYS) &&
  within(limits.maxTotalKeys, limits.maxKeys, MAX_TOTAL_KEYS) &&
  within(limits.retentionMs, 0, Number.MAX_SAFE_INTEGER) &&
  within(limits.replayMs, 0, limits.retentionMs) &&
  within(limits.pruneLimit, 1, PRUNE_LIMIT)
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
const scopeDigestOf = ({ projectID, canonical, identity }: Pick<FrozenScope, "projectID" | "canonical" | "identity">) =>
  hash(JSON.stringify(ordered({ projectID, canonical, identity })))

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

const make = (input: Partial<Limits>) =>
  Effect.gen(function* () {
    const limits = { ...LIMITS, ...input }
    if (!valid(limits)) return yield* Effect.die(new RangeError("The directory request ledger limits are invalid."))
    const global = yield* Global.Service
    const flock = yield* EffectFlock.Service
    const root = path.join(global.data, "storage", "connect-directory-requests")
    const pointers = path.join(root, "by-key")
    const globalIndexFile = path.join(root, "index.json")
    const locks = path.join(root, "locks")
    const active = new WeakMap<Token, Claim>()
    const id = (key: string) => `${root}\0${key}`
    const pointerFile = (key: string) => path.join(pointers, `${key}.json`)
    const place = (folder: Folder) => {
      const base = path.join(root, "scopes", folder.project, folder.directory)
      return {
        folder,
        slots: path.join(base, "keys"),
        bindings: path.join(base, "bindings"),
        prepared: path.join(base, "prepared"),
        refused: path.join(base, "refused"),
        index: path.join(base, "index.json"),
      }
    }
    type Place = ReturnType<typeof place>
    const paths = (scope: FrozenScope) => place(folderOf(scope))
    const leaf = (folder: string, key: string) => path.join(folder, `${key}.json`)
    const remove = (files: ReadonlyArray<string>) =>
      Effect.tryPromise({
        try: () => Promise.all(files.map((file) => rm(file, { force: true }))),
        catch: unavailable,
      })
    // Keys a prune (the journal) or an admission (the intent) may have left half-removed or half-written in a folder.
    const tolerated = (ledger: GlobalValue, folder: Folder) =>
      new Set(
        [...(ledger.pruning ?? []), ...(ledger.admitting ? [ledger.admitting] : [])]
          .filter((mark) => folderKey(mark.folder) === folderKey(folder))
          .map((mark) => mark.key),
      )
    const locked = <A, E, R>(body: Effect.Effect<A, E, R>, key: string) =>
      flock
        .withLock(body, key, locks)
        .pipe(Effect.mapError((cause) => (cause instanceof Error ? cause : unavailable())))
    // Global then scope lock, in that order everywhere. The body is uninterruptible: an interrupted caller waits for
    // its O_EXCL write, so no later decision can race a write still in flight after the lock was released. Every
    // holder of a scope lock holds the global lock first, so a prune or sweep under the global lock may write any
    // scope's files.
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
      const files = yield* names(pointers, MAX_TOTAL_KEYS + PRUNE_LIMIT)
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
        const empty: GlobalValue = { version: 1, entries: [] }
        yield* atomic(globalIndexFile, empty, MAX_TOTAL_INDEX_BYTES)
        return empty
      }
      // Every pointer is indexed or journaled, and every entry has its pointer except an admission's own.
      const indexed = new Set(stored.value.entries.map((entry) => entry.key))
      const journal = new Set((stored.value.pruning ?? []).map((mark) => mark.key))
      const present = new Set(files)
      if (
        files.some((key) => !indexed.has(key) && !journal.has(key)) ||
        stored.value.entries.some((entry) => !present.has(entry.key) && entry.key !== stored.value.admitting?.key)
      )
        return yield* unavailable()
      return stored.value
    })
    // `create` starts an empty scope, `open` is an existing one, and `inspect` (a prune reading another directory)
    // writes nothing at all. Every entry has its slot; a slot or record no entry names is unavailable unless a
    // journaled prune or an admission intent explains it.
    const index = Effect.fn("ConnectDirectoryRequest.index")(function* (
      target: Place,
      mode: "create" | "open" | "inspect",
      explained: ReadonlySet<string>,
    ) {
      if (mode !== "inspect")
        yield* Effect.tryPromise({
          try: () =>
            Promise.all(
              [target.slots, target.bindings, target.prepared, target.refused].map((folder) =>
                mkdir(folder, { recursive: true, mode: 0o700 }),
              ),
            ),
          catch: unavailable,
        })
      const bound = MAX_KEYS + PRUNE_LIMIT + 1
      const slots = yield* names(target.slots, bound)
      const extra = [
        ...(yield* names(target.bindings, bound)),
        ...(yield* names(target.prepared, bound)),
        ...(yield* names(target.refused, bound)),
      ]
      const stored = yield* read(target.index, Index, MAX_INDEX_BYTES)
      if (!stored) {
        if (mode !== "create" || slots.length || extra.length) return yield* unavailable()
        const empty: IndexValue = { version: 1, entries: [] }
        yield* atomic(target.index, empty, MAX_INDEX_BYTES)
        return empty
      }
      const indexed = new Set(stored.value.entries.map((entry) => entry.key))
      const slotted = new Set(slots)
      if (
        stored.value.entries.some((entry) => !slotted.has(entry.key)) ||
        [...slots, ...extra].some((key) => !indexed.has(key) && !explained.has(key))
      )
        return yield* unavailable()
      return stored.value
    })
    // A key's binding, tombstone and prepared anchor, each held to the reservation it extends. Corrupt or
    // contradictory records are unavailable, never repaired.
    const records = Effect.fnUntraced(function* (target: Place, reservation: typeof Reservation.Type) {
      const bound = (yield* read(leaf(target.bindings, reservation.key), Binding, MAX_RECORD_BYTES))?.value
      const refused = (yield* read(leaf(target.refused, reservation.key), Refused, MAX_RECORD_BYTES))?.value
      const prepared = (yield* read(leaf(target.prepared, reservation.key), PreparedRecord, MAX_RECORD_BYTES))?.value
      if (
        (bound && refused) ||
        [bound, refused, prepared].some((record) => record !== undefined && !same(record, reservation)) ||
        (prepared && bound && prepared.anchorID !== bound.anchorID) ||
        (prepared && refused?.anchorID !== undefined && prepared.anchorID !== refused.anchorID)
      )
        return yield* unavailable()
      return { bound, refused, prepared }
    })
    // An admission writes its intent into the global index before any of its files and clears it once its scope
    // index names the key; a reservation is returned only after that. So an intent left behind means no caller ever
    // held the key: it rolls forward when the scope index names it, and back otherwise.
    const settleAdmission = Effect.fnUntraced(function* (ledger: GlobalValue, mark: Mark) {
      const target = place(mark.folder)
      const entry = ledger.entries.find((item) => item.key === mark.key)
      const named = (yield* read(target.index, Index, MAX_INDEX_BYTES))?.value.entries.find(
        (item) => item.key === mark.key,
      )
      if (named) return named.digest === entry?.digest ? ledger.entries : yield* unavailable()
      const extended = yield* Effect.tryPromise({
        try: () =>
          Promise.all(
            [target.bindings, target.prepared, target.refused].map((folder) =>
              lstat(leaf(folder, mark.key)).then(
                () => true,
                (cause: unknown) => (missing(cause) ? false : Promise.reject(cause)),
              ),
            ),
          ),
        catch: unavailable,
      })
      if (extended.some(Boolean)) return yield* unavailable()
      yield* remove([leaf(target.slots, mark.key), pointerFile(mark.key)])
      return ledger.entries.filter((item) => item.key !== mark.key)
    })
    // One journaled folder: its scope entries go first, then each key's records and slot, then its pointer, so a
    // crash at any point leaves files only the journal explains.
    const forget = Effect.fnUntraced(function* (folder: Folder, marks: ReadonlyArray<Mark>) {
      if (marks.some((mark) => live.has(id(mark.key)))) return yield* unavailable()
      const target = place(folder)
      const keys = new Set(marks.map((mark) => mark.key))
      const stored = yield* read(target.index, Index, MAX_INDEX_BYTES)
      if (stored?.value.entries.some((entry) => keys.has(entry.key)))
        yield* atomic(
          target.index,
          { ...stored.value, entries: stored.value.entries.filter((entry) => !keys.has(entry.key)) },
          MAX_INDEX_BYTES,
        )
      yield* remove(
        marks.flatMap((mark) =>
          [target.bindings, target.prepared, target.refused, target.slots].map((item) => leaf(item, mark.key)),
        ),
      )
      yield* remove(marks.map((mark) => pointerFile(mark.key)))
      marks.forEach((mark) => dropped.delete(id(mark.key)))
    })
    // Finishes what a crash or a failed write left in the global index. A journaled folder that cannot be finished
    // (unreadable, unwritable, or a contradiction) stays journaled for a later start; it never blocks another
    // directory. An admission intent that cannot settle fails every `reserve`; only tampering or a bad disk leaves one.
    const finish = Effect.fn("ConnectDirectoryRequest.finish")(function* (ledger: GlobalValue) {
      const journal = ledger.pruning ?? []
      if (!ledger.admitting && !journal.length) return ledger
      const kept = ledger.admitting ? yield* settleAdmission(ledger, ledger.admitting) : ledger.entries
      const stuck = (yield* Effect.forEach(Map.groupBy(journal, (mark) => folderKey(mark.folder)).values(), (marks) => {
        const [first] = marks
        if (!first) return Effect.succeed([])
        return forget(first.folder, marks).pipe(
          Effect.as([]),
          Effect.orElseSucceed(() => marks),
        )
      })).flat()
      const next: GlobalValue = {
        version: 1,
        entries: kept,
        ...(ledger.cursor ? { cursor: ledger.cursor } : {}),
        ...(stuck.length ? { pruning: stuck } : {}),
      }
      yield* atomic(globalIndexFile, next, MAX_TOTAL_INDEX_BYTES)
      return next
    })
    // Settled keys a new admission may prune, under both locks. Each scan walks its entries oldest first from just
    // after its cursor and wraps, so keys that can never be pruned are passed over instead of starving the keys
    // behind them. A candidate in doubt (unreadable, foreign, pending, prepared, live, or an unproven open run) is
    // skipped, and nothing is written until the journal names what goes.
    const prune = Effect.fn("ConnectDirectoryRequest.prune")(function* (
      ledger: GlobalValue,
      home: Place,
      current: IndexValue,
      inspectOpen?: InspectOpen,
    ) {
      const now = yield* Clock.currentTimeMillis
      // All optional liveness reads share one window. None may hold the global lock for its own full timeout.
      const inspectUntil = performance.now() + INSPECT_MS
      const room = Math.min(limits.pruneLimit, PRUNE_LIMIT - (ledger.pruning?.length ?? 0))
      // Journaled keys are already going. One whose folder could not be finished is still named by that folder's
      // index with all its files, so a scan would otherwise pick it again and journal it twice.
      const going = new Set((ledger.pruning ?? []).map((mark) => mark.key))
      const chosen = new Map<string, Mark>()
      const seen = new Map<string, { readonly folder: Folder; readonly at: number } | undefined>()
      const folders = new Map<string, IndexValue | undefined>([[folderKey(home.folder), current]])
      const spent = { bytes: 0 }
      const evaluate = (entry: Entry, floor: number) =>
        Effect.gen(function* () {
          if (live.has(id(entry.key))) return undefined
          const pointer = yield* read(pointerFile(entry.key), Reservation, MAX_RECORD_BYTES)
          if (!pointer || pointer.digest !== entry.digest) return undefined
          const createdAt = pointer.value.createdAt
          const local = current.entries.some((item) => item.key === entry.key && item.digest === pointer.digest)
          const folder = pointer.value.folder ?? (local ? home.folder : undefined)
          if (!folder) return undefined
          const name = folderKey(folder)
          if (!folders.has(name)) {
            if (folders.size > FOLDER_LIMIT) return "stop" as const
            folders.set(
              name,
              yield* index(place(folder), "inspect", tolerated(ledger, folder)).pipe(
                Effect.orElseSucceed(() => undefined),
              ),
            )
          }
          const target = place(folder)
          const known = folders.get(name)?.entries.find((item) => item.key === entry.key)
          if (!known || known.digest !== pointer.digest) return undefined
          const slot = yield* read(leaf(target.slots, entry.key), Reservation, MAX_RECORD_BYTES)
          if (!slot || slot.digest !== known.digest) return undefined
          const found = yield* records(target, pointer.value)
          if (found.refused) return { folder, at: Math.max(createdAt, found.refused.refusedAt) }
          const binding = found.bound
          if (!binding) return undefined
          const run = yield* ConnectDirectory.settled(folder, binding)
          spent.bytes += run.bytes
          if (run.kind === "done") return { folder, at: Math.max(createdAt, run.ended ?? createdAt) }
          if (run.kind === "gone") return { folder, at: createdAt }
          // A legacy index may omit its age hint. The pointer still gates the open binding's job lookup.
          if (
            run.kind === "open" &&
            inspectOpen &&
            createdAt <= now - floor &&
            scopeDigestOf(run.receipt) === binding.scopeDigest
          ) {
            const remaining = Math.floor(inspectUntil - performance.now())
            if (remaining <= 0) return undefined
            const dead = yield* Effect.interruptible(Effect.suspend(() => inspectOpen(binding, run.receipt))).pipe(
              Effect.timeoutOrElse({ duration: remaining, orElse: () => Effect.succeed(false) }),
              Effect.catchCause(() => Effect.succeed(false)),
            )
            if (dead) return { folder, at: createdAt }
          }
          return undefined
        }).pipe(Effect.orElseSucceed(() => undefined))
      const walk = Effect.fnUntraced(function* (
        items: ReadonlyArray<Entry>,
        cursor: Cursor | undefined,
        floor: () => number,
        enough: () => boolean,
      ) {
        const sorted = items.toSorted(byAge)
        const start = cursor ? sorted.findIndex((entry) => byAge(entry, cursor) > 0) : 0
        const scan = { cursor, inspected: 0 }
        for (const entry of start > 0 ? [...sorted.slice(start), ...sorted.slice(0, start)] : sorted) {
          if (enough() || scan.inspected >= limits.pruneLimit || spent.bytes >= RECEIPT_BUDGET) break
          if (chosen.has(entry.key) || going.has(entry.key) || (entry.createdAt ?? 0) > now - floor()) continue
          const cached = seen.has(entry.key)
          const result = cached ? seen.get(entry.key) : yield* evaluate(entry, floor())
          if (result === "stop") break
          if (!cached) {
            seen.set(entry.key, result)
            scan.inspected++
          }
          scan.cursor = { createdAt: entry.createdAt ?? 0, key: entry.key }
          if (result && now - result.at >= floor()) chosen.set(entry.key, { key: entry.key, folder: result.folder })
        }
        return scan.cursor
      })
      // A full directory first gives up its own oldest keys past the replay window, then a full ledger takes keys
      // past the replay window from any directory, and the rest of the room goes to keys past their retention.
      const scopeShort = Math.max(0, current.entries.length - limits.maxKeys + 1)
      const scopeCursor =
        scopeShort > 0 && room > 0
          ? yield* walk(
              current.entries,
              current.cursor,
              () => limits.replayMs,
              () => chosen.size >= Math.min(scopeShort, room),
            )
          : current.cursor
      const floor = () =>
        ledger.entries.length - chosen.size >= limits.maxTotalKeys ? limits.replayMs : limits.retentionMs
      const globalCursor =
        room > chosen.size
          ? yield* walk(ledger.entries, ledger.cursor, floor, () => chosen.size >= room)
          : ledger.cursor
      const moved = (before: Cursor | undefined, after: Cursor | undefined) =>
        before?.key !== after?.key || before?.createdAt !== after?.createdAt
      const withScope = (value: IndexValue) => ({ ...value, ...(scopeCursor ? { cursor: scopeCursor } : {}) })
      if (!chosen.size)
        return {
          ledger: { ...ledger, ...(globalCursor ? { cursor: globalCursor } : {}) },
          current: withScope(current),
          dirty: { ledger: moved(ledger.cursor, globalCursor), current: moved(current.cursor, scopeCursor) },
        }
      const journaled: GlobalValue = {
        version: 1,
        entries: ledger.entries.filter((entry) => !chosen.has(entry.key)),
        ...(globalCursor ? { cursor: globalCursor } : {}),
        // The filter only backs up the scans' skip: `GlobalIndex` refuses a journal that names a key twice.
        pruning: [...(ledger.pruning ?? []), ...[...chosen.values()].filter((mark) => !going.has(mark.key))],
      }
      yield* atomic(globalIndexFile, journaled, MAX_TOTAL_INDEX_BYTES)
      const next = yield* finish(journaled)
      return {
        ledger: next,
        current: withScope(yield* index(home, "open", tolerated(next, home.folder))),
        dirty: { ledger: false, current: moved(current.cursor, scopeCursor) },
      }
    })
    // The claim's reservation is still the one on disk: the global pointer, both indexes and the slot agree.
    const held = Effect.fnUntraced(function* (claim: Claim) {
      const target = paths(claim.scope)
      const ledger = yield* globalIndex()
      const globalKnown = ledger.entries.find((entry) => entry.key === claim.proof.key)
      const pointer = yield* read(pointerFile(claim.proof.key), Reservation, MAX_RECORD_BYTES)
      const current = yield* index(target, "open", tolerated(ledger, target.folder))
      const known = current.entries.find((entry) => entry.key === claim.proof.key)
      const slot = yield* read(leaf(target.slots, claim.proof.key), Reservation, MAX_RECORD_BYTES)
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
      return { place: target, ...(yield* records(target, claim.record)) }
    })
    const tombstone = Effect.fnUntraced(function* (
      target: Place,
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
      yield* exclusive(leaf(target.refused, reservation.key), record, MAX_RECORD_BYTES)
      dropped.delete(id(reservation.key))
    })
    const reserve: Interface["reserve"] = (scope, input, inspect, inspectOpen) =>
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
        const scopeDigest = scopeDigestOf(frozen)
        const inputDigest = hash(JSON.stringify(ordered({ scopeDigest, input: payload })))
        const fixedProof = Object.freeze({ key, scopeDigest, inputDigest })
        const target = paths(frozen)
        const options = yield* Options
        const outcome = yield* both(
          frozen,
          Effect.gen(function* () {
            const ledger = yield* finish(yield* globalIndex())
            const globalKnown = ledger.entries.find((entry) => entry.key === key)
            const pointer = yield* read(pointerFile(key), Reservation, MAX_RECORD_BYTES)
            if (
              pointer &&
              (pointer.value.key !== key ||
                pointer.value.scopeDigest !== fixedProof.scopeDigest ||
                pointer.value.inputDigest !== inputDigest)
            )
              return yield* mismatch()
            const current = yield* index(target, pointer ? "open" : "create", tolerated(ledger, target.folder))
            const known = current.entries.find((entry) => entry.key === key)
            if (pointer) {
              const slot = yield* read(leaf(target.slots, key), Reservation, MAX_RECORD_BYTES)
              if (
                !globalKnown ||
                globalKnown.digest !== pointer.digest ||
                !known ||
                !slot ||
                known.digest !== slot.digest ||
                slot.digest !== pointer.digest
              )
                return yield* unavailable()
              const found = yield* records(target, pointer.value)
              if (found.refused) {
                dropped.delete(id(key))
                return { kind: "consumed" } as const
              }
              if (found.bound) return { kind: "bound", binding: found.bound, proof: fixedProof } as const
              if (claimed(id(key), pointer.value, found.prepared, yield* Clock.currentTimeMillis, options))
                return yield* pending()
              if (!found.prepared) {
                yield* tombstone(target, pointer.value, { reason: "abandoned" })
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
                yield* tombstone(target, pointer.value, { reason: "abandoned", anchorID })
                return { kind: "consumed", ...(evidence.stop ? { stop: evidence.stop } : {}) } as const
              }
              const binding = { ...pointer.value, anchorID, runID: evidence.runID }
              if (!Schema.is(Binding)(binding)) return yield* unavailable()
              yield* exclusive(leaf(target.bindings, key), binding, MAX_RECORD_BYTES)
              dropped.delete(id(key))
              return { kind: "bound", binding, proof: fixedProof } as const
            }
            if (known || globalKnown || ledger.pruning?.some((mark) => mark.key === key)) return yield* unavailable()
            // Only an admission grows the ledger, so only an admission prunes it; replays never do.
            const pruned = yield* prune(ledger, target, current, inspectOpen)
            if (
              pruned.ledger.entries.length >= limits.maxTotalKeys ||
              pruned.current.entries.length >= limits.maxKeys
            ) {
              // The refusal is temporary: the scans' cursors move on, so the next admission inspects other keys.
              if (pruned.dirty.ledger) yield* atomic(globalIndexFile, pruned.ledger, MAX_TOTAL_INDEX_BYTES)
              if (pruned.dirty.current) yield* atomic(target.index, pruned.current, MAX_INDEX_BYTES)
              return yield* unavailable()
            }
            const createdAt = yield* Clock.currentTimeMillis
            const record = {
              version: 1,
              ...fixedProof,
              nonce: randomUUID(),
              createdAt,
              folder: target.folder,
            } as const
            const entry = { key, digest: hash(JSON.stringify(record)), createdAt }
            const admitted: GlobalValue = {
              ...pruned.ledger,
              entries: [...pruned.ledger.entries, entry].sort(byKey),
            }
            yield* atomic(
              globalIndexFile,
              { ...admitted, admitting: { key, folder: target.folder } },
              MAX_TOTAL_INDEX_BYTES,
            )
            yield* exclusive(pointerFile(key), record, MAX_RECORD_BYTES)
            yield* exclusive(leaf(target.slots, key), record, MAX_RECORD_BYTES)
            yield* atomic(
              target.index,
              { ...pruned.current, entries: [...pruned.current.entries, entry].sort(byKey) },
              MAX_INDEX_BYTES,
            )
            yield* atomic(globalIndexFile, admitted, MAX_TOTAL_INDEX_BYTES)
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
            yield* exclusive(leaf(found.place.prepared, claim.proof.key), record, MAX_RECORD_BYTES)
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
            yield* exclusive(leaf(found.place.bindings, claim.proof.key), bound, MAX_RECORD_BYTES)
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
  })
const layerWith = (limits: Partial<Limits>) => Layer.effect(Service, make(limits))

export const node = LayerNode.make({
  service: Service,
  layer: layerWith(LIMITS),
  deps: [Global.node, EffectFlock.node],
})
/** The ledger with other caps or retention, for tests; a bad value is a defect when the layer builds. */
export const nodeWith = (limits: Partial<Limits>) =>
  LayerNode.make({ service: Service, layer: layerWith(limits), deps: [Global.node, EffectFlock.node] })
