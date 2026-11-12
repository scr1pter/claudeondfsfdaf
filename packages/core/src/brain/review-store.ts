export * as ReviewStore from "./review-store"

import { and, eq, inArray, or, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { BrainDatabase } from "./database"
import { BrainEventTable, BrainReviewMemoryStateTable, BrainReviewMemoryTable, BrainTombstoneTable } from "./sql"

type Database = BrainDatabase.Database
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
export type Handle = Database | Transaction
// Not a normalized entry hash; older builds cannot accidentally learn or expire this content-free marker.
export const MARKER = "vector:review-memory-marker:v1"
export const FOREVER = 253402300799000
// Reserved in this review-only table; valid repository identities are nonempty. It contains no personal data.
export const GLOBAL = ""

export const state = Effect.fnUntraced(function* (tx: Handle, repository: string) {
  const rows = yield* tx
    .select({
      repository: BrainReviewMemoryStateTable.repository_id,
      // Raw SQL expressions preserve malformed persisted values instead of boolean/number decoder coercion.
      enabled: sql<unknown>`${BrainReviewMemoryStateTable.enabled}`,
      generation: sql<unknown>`${BrainReviewMemoryStateTable.generation}`,
    })
    .from(BrainReviewMemoryStateTable)
    .where(inArray(BrainReviewMemoryStateTable.repository_id, [repository, GLOBAL]))
    .all()
  if (rows.some((row) => !counter(row.generation) || (row.enabled !== 0 && row.enabled !== 1))) return
  const global = rows.find((row) => row.repository === GLOBAL)
  if (global?.enabled === 1) return
  if (!global) {
    // Missing the global component is only an initial empty database, never a default zero for existing state.
    const existing = yield* tx
      .select({ repository: BrainReviewMemoryStateTable.repository_id })
      .from(BrainReviewMemoryStateTable)
      .limit(1)
    if (existing.length) return
  }
  const local = rows.find((row) => row.repository === repository && row.repository !== GLOBAL)
  const marker = repository === GLOBAL ? undefined : yield* marked(tx, repository)
  if (marker && marker.until !== FOREVER) return
  if (repository !== GLOBAL && !local) {
    const content = yield* tx
      .select({ id: BrainReviewMemoryTable.id })
      .from(BrainReviewMemoryTable)
      .where(eq(BrainReviewMemoryTable.repository_id, repository))
      .limit(1)
    if (content.length || marker) return
  }
  // Narrow EACH component independently before adding: a negative/fractional value cannot cancel another.
  const localGeneration = local?.generation ?? 0
  const globalGeneration = global?.generation ?? 0
  if (!counter(localGeneration) || !counter(globalGeneration)) return
  const generation = localGeneration + globalGeneration
  if (!counter(generation)) return
  return { enabled: local?.enabled === 1, generation }
})

function counter(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0 && input < Number.MAX_SAFE_INTEGER
}

const requireState = Effect.fnUntraced(function* (tx: Handle, repository: string) {
  const current = yield* state(tx, repository)
  if (!current) return yield* Effect.die(new Error("Review memory generation components are invalid"))
  return current
})

const initializeGlobal = (tx: Handle) =>
  tx
    .insert(BrainReviewMemoryStateTable)
    .values({ repository_id: GLOBAL, enabled: false, generation: 0 })
    .onConflictDoNothing()
    .run()

export const advance = Effect.fnUntraced(function* (tx: Handle, repository: string, enabled?: boolean) {
  const current = yield* requireState(tx, repository)
  if (!counter(current.generation + 1)) return yield* Effect.die(new Error("Review memory generation is exhausted"))
  if (repository !== GLOBAL) yield* initializeGlobal(tx)
  yield* tx
    .insert(BrainReviewMemoryStateTable)
    .values({ repository_id: repository, enabled: enabled ?? false, generation: 1 })
    .onConflictDoUpdate({
      target: BrainReviewMemoryStateTable.repository_id,
      set: {
        generation: sql`${BrainReviewMemoryStateTable.generation} + 1`,
        ...(enabled === undefined ? {} : { enabled }),
      },
    })
    .run()
})

// Existing posting/cache snapshots observe the REAL repository, not an invented prefixed repository ID.
export const revoke = (tx: Handle, repository: string) =>
  tx
    .insert(BrainEventTable)
    .values({
      entry_id: "",
      repository_id: repository,
      at: Date.now(),
      action: "forgotten",
      actor: "user",
    })
    .run()

const mark = (tx: Handle, repository: string) =>
  tx
    .insert(BrainTombstoneTable)
    .values({ repository_id: repository, norm_hash: MARKER, until: FOREVER })
    .onConflictDoNothing()
    .run()

export const marked = (tx: Handle, repository: string) =>
  tx
    .select({ hash: BrainTombstoneTable.norm_hash, until: sql<unknown>`${BrainTombstoneTable.until}` })
    .from(BrainTombstoneTable)
    .where(and(eq(BrainTombstoneTable.repository_id, repository), eq(BrainTombstoneTable.norm_hash, MARKER)))
    .get()

/** Owner inspection establishes a content-free older-build erase witness BEFORE a first enable can be approved. */
export const register = Effect.fnUntraced(function* (tx: Handle, repository: string) {
  yield* requireState(tx, repository)
  if (yield* marked(tx, repository)) return
  const previous = yield* tx
    .select({ repository: BrainReviewMemoryStateTable.repository_id })
    .from(BrainReviewMemoryStateTable)
    .where(eq(BrainReviewMemoryStateTable.repository_id, repository))
    .get()
  if (previous) {
    // A new inspection cannot restore an older erased witness under the same approval generation.
    yield* advance(tx, repository, false)
    yield* revoke(tx, repository)
  } else {
    yield* initializeGlobal(tx)
    yield* tx
      .insert(BrainReviewMemoryStateTable)
      .values({ repository_id: repository, enabled: false, generation: 0 })
      .onConflictDoNothing()
      .run()
  }
  yield* mark(tx, repository)
})

/** Inside EVERY access transaction: finish a known older build's repository/all-memory erase before reading/writing. */
export const reconcile = Effect.fnUntraced(function* (tx: Handle, repository: string) {
  const current = yield* requireState(tx, repository)
  const marker = yield* tx
    .select({ hash: BrainTombstoneTable.norm_hash })
    .from(BrainTombstoneTable)
    .where(and(eq(BrainTombstoneTable.repository_id, repository), eq(BrainTombstoneTable.norm_hash, MARKER)))
    .get()
  if (marker) return 0
  const removed = yield* tx
    .delete(BrainReviewMemoryTable)
    .where(eq(BrainReviewMemoryTable.repository_id, repository))
    .returning({ id: BrainReviewMemoryTable.id })
    .all()
  if (!removed.length && !current.enabled) return 0
  yield* advance(tx, repository, false)
  yield* revoke(tx, repository)
  return removed.length
})

/** Erase records and every inline citation/raw excerpt, retain only disabled content-free generation metadata. */
export const eraseScope = Effect.fnUntraced(function* (tx: Handle, repositories: readonly string[] | undefined) {
  const rows = yield* tx
    .select({ id: BrainReviewMemoryTable.id, repository: BrainReviewMemoryTable.repository_id })
    .from(BrainReviewMemoryTable)
    .where(repositories ? inArray(BrainReviewMemoryTable.repository_id, [...repositories]) : undefined)
    .all()
  const states = yield* tx
    .select({ repository: BrainReviewMemoryStateTable.repository_id })
    .from(BrainReviewMemoryStateTable)
    .where(repositories ? inArray(BrainReviewMemoryStateTable.repository_id, [...repositories]) : undefined)
    .all()
  const markers = yield* tx
    .select({ repository: BrainTombstoneTable.repository_id })
    .from(BrainTombstoneTable)
    .where(
      and(
        eq(BrainTombstoneTable.norm_hash, MARKER),
        repositories ? inArray(BrainTombstoneTable.repository_id, [...repositories]) : undefined,
      ),
    )
    .all()
  const affected = [
    ...new Set([
      ...(repositories ?? []),
      ...rows.map((row) => row.repository),
      ...states.map((row) => row.repository),
      ...markers.map((row) => row.repository),
    ]),
  ].filter((repository) => repository !== GLOBAL)
  yield* requireState(tx, GLOBAL)
  for (const repository of affected) yield* requireState(tx, repository)
  yield* tx
    .delete(BrainReviewMemoryTable)
    .where(repositories ? inArray(BrainReviewMemoryTable.repository_id, [...repositories]) : undefined)
    .run()
  for (const repository of affected) {
    yield* advance(tx, repository, false)
    if (rows.some((row) => row.repository === repository) || states.some((row) => row.repository === repository))
      yield* revoke(tx, repository)
  }
  // Also fences a first-use approval for a repository that has not yet persisted any review state.
  if (repositories === undefined) yield* advance(tx, GLOBAL, false)
  yield* tx
    .delete(BrainTombstoneTable)
    .where(
      and(
        eq(BrainTombstoneTable.norm_hash, MARKER),
        repositories ? inArray(BrainTombstoneTable.repository_id, [...repositories]) : undefined,
      ),
    )
    .run()
  return rows.length
})

/** Review-derived owner approvals go too: accepting a proposal must not detach it from its deletion provenance. */
export const eraseSession = Effect.fnUntraced(function* (tx: Handle, repository: string, sessionID: string) {
  yield* requireState(tx, repository)
  const removed = yield* tx
    .delete(BrainReviewMemoryTable)
    .where(
      and(
        eq(BrainReviewMemoryTable.repository_id, repository),
        or(
          eq(BrainReviewMemoryTable.parent_session_id, sessionID),
          eq(BrainReviewMemoryTable.review_session_id, sessionID),
        ),
      ),
    )
    .returning({ id: BrainReviewMemoryTable.id })
    .all()
  // Fence a suspended writer even if its first proposal had not yet committed.
  const current = yield* tx
    .select({ repository: BrainReviewMemoryStateTable.repository_id })
    .from(BrainReviewMemoryStateTable)
    .where(eq(BrainReviewMemoryStateTable.repository_id, repository))
    .get()
  if (current || removed.length) {
    yield* advance(tx, repository)
    yield* revoke(tx, repository)
  }
  return removed.length
})
