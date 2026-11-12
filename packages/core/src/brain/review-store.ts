export * as ReviewStore from "./review-store"

import { and, eq, inArray, like, or, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { BrainDatabase } from "./database"
import { ReviewWitness } from "./review-witness"
import {
  BrainEventTable,
  BrainReviewMemoryScopeStateTable,
  BrainReviewMemoryStateTable,
  BrainReviewMemoryTable,
  BrainReviewMemorySourceTable,
  BrainTombstoneTable,
} from "./sql"

type Database = BrainDatabase.Database
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
export type Handle = Database | Transaction
// These witnesses remain under the REAL ProjectID, so older repository/all-memory erasers remove them too.
export const MARKER = "vector:review-memory-marker:v1"
export const SCOPE_MARKER = `${MARKER}:scope:`
export const FOREVER = 253402300799000
export const GLOBAL = ""
export const scopeValue = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9:_-]{1,256}$/.test(value)
const counter = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER
const invalid = () => Effect.die(new Error("Review memory generation or physical scope is invalid"))
const markerHash = (scope?: string) => (scope === undefined ? MARKER : `${SCOPE_MARKER}${scope}`)
const scoped = (repository: string, scope: string) =>
  and(
    eq(BrainReviewMemoryScopeStateTable.repository_id, repository),
    eq(BrainReviewMemoryScopeStateTable.scope_id, scope),
  )

export const marked = (tx: Handle, repository: string, scope?: string) =>
  tx
    .select({ hash: BrainTombstoneTable.norm_hash, until: sql<unknown>`${BrainTombstoneTable.until}` })
    .from(BrainTombstoneTable)
    .where(and(eq(BrainTombstoneTable.repository_id, repository), eq(BrainTombstoneTable.norm_hash, markerHash(scope))))
    .get()

// V1 rows are retained as repository/global erase epochs. Their legacy enabled bit never enables a physical scope.
const components = Effect.fnUntraced(function* (tx: Handle, repository: string) {
  const rows = yield* tx
    .select({
      repository: BrainReviewMemoryStateTable.repository_id,
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
    const existing = yield* tx.select().from(BrainReviewMemoryStateTable).limit(1)
    const namespaces = yield* tx.select().from(BrainReviewMemoryScopeStateTable).limit(1)
    const content = yield* tx.select({ id: BrainReviewMemoryTable.id }).from(BrainReviewMemoryTable).limit(1)
    const sources = yield* tx.select().from(BrainReviewMemorySourceTable).limit(1)
    if (existing.length || namespaces.length || content.length || sources.length) return
  }
  const invalidGlobalScope = yield* tx
    .select()
    .from(BrainReviewMemoryScopeStateTable)
    .where(eq(BrainReviewMemoryScopeStateTable.repository_id, GLOBAL))
    .limit(1)
  const invalidGlobalContent = yield* tx
    .select({ id: BrainReviewMemoryTable.id })
    .from(BrainReviewMemoryTable)
    .where(eq(BrainReviewMemoryTable.repository_id, GLOBAL))
    .limit(1)
  const invalidGlobalSources = yield* tx
    .select()
    .from(BrainReviewMemorySourceTable)
    .where(eq(BrainReviewMemorySourceTable.repository_id, GLOBAL))
    .limit(1)
  if (invalidGlobalScope.length || invalidGlobalContent.length || invalidGlobalSources.length) return
  const local = rows.find((row) => row.repository === repository && row.repository !== GLOBAL)
  const marker = repository === GLOBAL ? undefined : yield* marked(tx, repository)
  if (marker && marker.until !== FOREVER) return
  if (repository !== GLOBAL && !local) {
    const content = yield* tx
      .select({ id: BrainReviewMemoryTable.id })
      .from(BrainReviewMemoryTable)
      .where(eq(BrainReviewMemoryTable.repository_id, repository))
      .limit(1)
    const namespaces = yield* tx
      .select()
      .from(BrainReviewMemoryScopeStateTable)
      .where(eq(BrainReviewMemoryScopeStateTable.repository_id, repository))
      .limit(1)
    const sources = yield* tx
      .select()
      .from(BrainReviewMemorySourceTable)
      .where(eq(BrainReviewMemorySourceTable.repository_id, repository))
      .limit(1)
    if (content.length || namespaces.length || marker || sources.length) return
  }
  const localGeneration = local?.generation ?? 0
  const globalGeneration = global?.generation ?? 0
  if (!counter(localGeneration) || !counter(globalGeneration) || !counter(localGeneration + globalGeneration)) return
  return { generation: localGeneration + globalGeneration, local, global }
})

export const state = Effect.fnUntraced(function* (tx: Handle, repository: string, scope: string) {
  if (!repository || !scopeValue(scope)) return
  const base = yield* components(tx, repository)
  if (!base) return
  const local = yield* tx
    .select({
      enabled: sql<unknown>`${BrainReviewMemoryScopeStateTable.enabled}`,
      generation: sql<unknown>`${BrainReviewMemoryScopeStateTable.generation}`,
    })
    .from(BrainReviewMemoryScopeStateTable)
    .where(scoped(repository, scope))
    .get()
  if (local && (!counter(local.generation) || (local.enabled !== 0 && local.enabled !== 1))) return
  const marker = yield* marked(tx, repository, scope)
  if (marker && marker.until !== FOREVER) return
  if (!local) {
    const content = yield* tx
      .select({ id: BrainReviewMemoryTable.id })
      .from(BrainReviewMemoryTable)
      .where(and(eq(BrainReviewMemoryTable.repository_id, repository), eq(BrainReviewMemoryTable.scope_id, scope)))
      .limit(1)
    const sources = yield* tx
      .select()
      .from(BrainReviewMemorySourceTable)
      .where(
        and(
          eq(BrainReviewMemorySourceTable.repository_id, repository),
          eq(BrainReviewMemorySourceTable.scope_id, scope),
        ),
      )
      .limit(1)
    if (marker || content.length || sources.length) return
  }
  const localGeneration = local?.generation ?? 0
  if (!counter(localGeneration)) return
  const generation = base.generation + localGeneration
  if (!counter(generation)) return
  return { enabled: local?.enabled === 1, generation }
})
const requireState = Effect.fnUntraced(function* (tx: Handle, repository: string, scope: string) {
  const current = yield* state(tx, repository, scope)
  return current ?? (yield* invalid())
})

// Erasure preflights ALL affected namespaces before the first delete, including an empty namespace's pending writer.
const requireRepository = Effect.fnUntraced(function* (tx: Handle, repository: string, increments = 0) {
  const base = yield* components(tx, repository)
  if (!base || !counter(base.generation + increments)) return yield* invalid()
  const namespaces = yield* tx
    .select({ scope: BrainReviewMemoryScopeStateTable.scope_id })
    .from(BrainReviewMemoryScopeStateTable)
    .where(eq(BrainReviewMemoryScopeStateTable.repository_id, repository))
    .all()
  const rows = yield* tx
    .select({ scope: BrainReviewMemoryTable.scope_id })
    .from(BrainReviewMemoryTable)
    .where(eq(BrainReviewMemoryTable.repository_id, repository))
    .all()
  const sources = yield* tx
    .select({ scope: BrainReviewMemorySourceTable.scope_id })
    .from(BrainReviewMemorySourceTable)
    .where(eq(BrainReviewMemorySourceTable.repository_id, repository))
    .all()
  const markers = yield* tx
    .select({ hash: BrainTombstoneTable.norm_hash })
    .from(BrainTombstoneTable)
    .where(
      and(eq(BrainTombstoneTable.repository_id, repository), like(BrainTombstoneTable.norm_hash, `${SCOPE_MARKER}%`)),
    )
    .all()
  const scopes = new Set(namespaces.map((row) => row.scope))
  if (
    rows.some((row) => row.scope !== null && (!scopeValue(row.scope) || !scopes.has(row.scope))) ||
    sources.some((row) => !scopeValue(row.scope) || !scopes.has(row.scope)) ||
    markers.some((row) => !scopes.has(row.hash.slice(SCOPE_MARKER.length)))
  )
    return yield* invalid()
  for (const scope of scopes) {
    const current = yield* requireState(tx, repository, scope)
    if (!counter(current.generation + increments)) return yield* invalid()
  }
  return { base, scopes }
})
const initialize = Effect.fnUntraced(function* (tx: Handle, repository: string) {
  yield* tx
    .insert(BrainReviewMemoryStateTable)
    .values({ repository_id: GLOBAL, enabled: false, generation: 0 })
    .onConflictDoNothing()
    .run()
  yield* tx
    .insert(BrainReviewMemoryStateTable)
    .values({ repository_id: repository, enabled: false, generation: 0 })
    .onConflictDoNothing()
    .run()
})
export const advance = Effect.fnUntraced(function* (tx: Handle, repository: string, scope: string, enabled?: boolean) {
  const current = yield* requireState(tx, repository, scope)
  if (!counter(current.generation + 1)) return yield* invalid()
  yield* initialize(tx, repository)
  yield* tx
    .insert(BrainReviewMemoryScopeStateTable)
    .values({ repository_id: repository, scope_id: scope, enabled: enabled ?? false, generation: 1 })
    .onConflictDoUpdate({
      target: [BrainReviewMemoryScopeStateTable.repository_id, BrainReviewMemoryScopeStateTable.scope_id],
      set: {
        generation: sql`${BrainReviewMemoryScopeStateTable.generation} + 1`,
        ...(enabled === undefined ? {} : { enabled }),
      },
    })
    .run()
})
const advanceEpoch = Effect.fnUntraced(function* (tx: Handle, repository: string) {
  const current = yield* components(tx, repository)
  if (!current || !counter(current.generation + 1)) return yield* invalid()
  if (repository !== GLOBAL) yield* initialize(tx, repository)
  yield* tx
    .insert(BrainReviewMemoryStateTable)
    .values({ repository_id: repository, enabled: false, generation: 1 })
    .onConflictDoUpdate({
      target: BrainReviewMemoryStateTable.repository_id,
      set: { enabled: false, generation: sql`${BrainReviewMemoryStateTable.generation} + 1` },
    })
    .run()
})

// Existing posting/cache snapshots continue to observe the REAL repository.
export const revoke = (tx: Handle, repository: string) =>
  tx
    .insert(BrainEventTable)
    .values({ entry_id: "", repository_id: repository, at: Date.now(), action: "forgotten", actor: "user" })
    .run()
const mark = (tx: Handle, repository: string, scope?: string) =>
  tx
    .insert(BrainTombstoneTable)
    .values({ repository_id: repository, norm_hash: markerHash(scope), until: FOREVER })
    .onConflictDoNothing()
    .run()

export const register = Effect.fnUntraced(function* (tx: Handle, repository: string, scope: string) {
  yield* requireRepository(tx, repository, 2)
  yield* requireState(tx, repository, scope)
  const base = yield* components(tx, repository)
  if (!base) return yield* invalid()
  if (!(yield* marked(tx, repository))) {
    if (base.local) {
      yield* advanceEpoch(tx, repository)
      yield* revoke(tx, repository)
    } else yield* initialize(tx, repository)
    yield* mark(tx, repository)
  }
  if (yield* marked(tx, repository, scope)) return
  const previous = yield* tx.select().from(BrainReviewMemoryScopeStateTable).where(scoped(repository, scope)).get()
  if (previous) {
    yield* advance(tx, repository, scope, false)
    yield* revoke(tx, repository)
  } else
    yield* tx
      .insert(BrainReviewMemoryScopeStateTable)
      .values({ repository_id: repository, scope_id: scope, enabled: false, generation: 0 })
      .run()
  yield* mark(tx, repository, scope)
})

/** Missing old-build real-repository witness retires EVERY physical scope and legacy unbound row. */
export const reconcile = Effect.fnUntraced(function* (tx: Handle, repository: string, scope: string) {
  const current = yield* requireRepository(tx, repository, 2)
  yield* requireState(tx, repository, scope)
  if (!(yield* marked(tx, repository))) {
    const content = yield* tx
      .select({ id: BrainReviewMemoryTable.id })
      .from(BrainReviewMemoryTable)
      .where(eq(BrainReviewMemoryTable.repository_id, repository))
      .limit(1)
    const enabled = yield* tx
      .select()
      .from(BrainReviewMemoryScopeStateTable)
      .where(
        and(
          eq(BrainReviewMemoryScopeStateTable.repository_id, repository),
          eq(BrainReviewMemoryScopeStateTable.enabled, true),
        ),
      )
      .limit(1)
    const sources = yield* tx
      .select({ id: BrainReviewMemorySourceTable.review_session_id })
      .from(BrainReviewMemorySourceTable)
      .where(
        and(
          eq(BrainReviewMemorySourceTable.repository_id, repository),
          eq(BrainReviewMemorySourceTable.state, "active"),
        ),
      )
      .limit(1)
    if (!content.length && !enabled.length && !sources.length && current.base.local?.enabled !== 1) return 0
    yield* ReviewWitness.erase(tx, { repositories: [repository] })
    const removed = yield* tx
      .delete(BrainReviewMemoryTable)
      .where(eq(BrainReviewMemoryTable.repository_id, repository))
      .returning({ id: BrainReviewMemoryTable.id })
      .all()
    for (const selected of current.scopes) yield* advance(tx, repository, selected, false)
    yield* advanceEpoch(tx, repository)
    yield* tx
      .delete(BrainTombstoneTable)
      .where(
        and(eq(BrainTombstoneTable.repository_id, repository), like(BrainTombstoneTable.norm_hash, `${SCOPE_MARKER}%`)),
      )
      .run()
    yield* revoke(tx, repository)
    return removed.length
  }
  if (yield* marked(tx, repository, scope)) {
    const source = yield* ReviewWitness.reconcile(tx, repository, scope)
    if (source.changed) {
      yield* advance(tx, repository, scope)
      yield* revoke(tx, repository)
    }
    return source.removed
  }
  const status = yield* requireState(tx, repository, scope)
  const sources = yield* ReviewWitness.erase(tx, { repositories: [repository], scope })
  const removed = yield* tx
    .delete(BrainReviewMemoryTable)
    .where(and(eq(BrainReviewMemoryTable.repository_id, repository), eq(BrainReviewMemoryTable.scope_id, scope)))
    .returning({ id: BrainReviewMemoryTable.id })
    .all()
  if (removed.length || status.enabled || sources) {
    yield* advance(tx, repository, scope, false)
    yield* revoke(tx, repository)
  }
  return removed.length
})

/** Fresh Main INSERT winners only; readers/configuration must never call this registration port. */
export const registerSource = (db: Database, input: ReviewWitness.Proof) =>
  db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const proof = ReviewWitness.proof(input)
          if (!proof) return false
          // Capture this BEFORE reconciliation can purge an unwitnessed legacy
          // row. Purging it must not turn the same old source into a fresh one.
          const existing = yield* tx
            .select({ id: BrainReviewMemoryTable.id })
            .from(BrainReviewMemoryTable)
            .where(
              and(
                eq(BrainReviewMemoryTable.repository_id, proof.repository),
                eq(BrainReviewMemoryTable.scope_id, proof.scope),
                eq(BrainReviewMemoryTable.review_session_id, proof.reviewID),
              ),
            )
            .limit(1)
          yield* reconcile(tx, proof.repository, proof.scope)
          const current = yield* state(tx, proof.repository, proof.scope)
          if (
            existing.length ||
            !current?.enabled ||
            !(yield* marked(tx, proof.repository)) ||
            !(yield* marked(tx, proof.repository, proof.scope))
          )
            return false
          return yield* ReviewWitness.register(tx, proof)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)

/** The owner clears only the selected physical namespace; another clone retains its own content and consent. */
export const eraseNamespace = Effect.fnUntraced(function* (tx: Handle, repository: string, scope: string) {
  yield* requireRepository(tx, repository, 1)
  yield* requireState(tx, repository, scope)
  yield* ReviewWitness.erase(tx, { repositories: [repository], scope, drop: true })
  const removed = yield* tx
    .delete(BrainReviewMemoryTable)
    .where(and(eq(BrainReviewMemoryTable.repository_id, repository), eq(BrainReviewMemoryTable.scope_id, scope)))
    .returning({ id: BrainReviewMemoryTable.id })
    .all()
  yield* advance(tx, repository, scope, false)
  yield* tx
    .delete(BrainTombstoneTable)
    .where(and(eq(BrainTombstoneTable.repository_id, repository), eq(BrainTombstoneTable.norm_hash, markerHash(scope))))
    .run()
  yield* revoke(tx, repository)
  return removed.length
})

/** Real-repository/all-memory erasure covers all scopes AND unbound legacy rows, retaining monotonic epochs. */
export const eraseScope = Effect.fnUntraced(function* (tx: Handle, repositories: readonly string[] | undefined) {
  const rows = yield* tx
    .select({ repository: BrainReviewMemoryTable.repository_id })
    .from(BrainReviewMemoryTable)
    .where(repositories ? inArray(BrainReviewMemoryTable.repository_id, [...repositories]) : undefined)
    .all()
  const states = yield* tx
    .select({ repository: BrainReviewMemoryStateTable.repository_id })
    .from(BrainReviewMemoryStateTable)
    .where(repositories ? inArray(BrainReviewMemoryStateTable.repository_id, [...repositories]) : undefined)
    .all()
  const sources = yield* tx
    .select({ repository: BrainReviewMemorySourceTable.repository_id })
    .from(BrainReviewMemorySourceTable)
    .where(repositories ? inArray(BrainReviewMemorySourceTable.repository_id, [...repositories]) : undefined)
    .all()
  const namespaces = yield* tx
    .select({ repository: BrainReviewMemoryScopeStateTable.repository_id })
    .from(BrainReviewMemoryScopeStateTable)
    .where(repositories ? inArray(BrainReviewMemoryScopeStateTable.repository_id, [...repositories]) : undefined)
    .all()
  const markers = yield* tx
    .select({ repository: BrainTombstoneTable.repository_id })
    .from(BrainTombstoneTable)
    .where(
      and(
        or(eq(BrainTombstoneTable.norm_hash, MARKER), like(BrainTombstoneTable.norm_hash, `${SCOPE_MARKER}%`)),
        repositories ? inArray(BrainTombstoneTable.repository_id, [...repositories]) : undefined,
      ),
    )
    .all()
  const affected = [
    ...new Set([
      ...(repositories ?? []),
      ...rows.map((row) => row.repository),
      ...sources.map((row) => row.repository),
      ...states.map((row) => row.repository),
      ...namespaces.map((row) => row.repository),
      ...markers.map((row) => row.repository),
    ]),
  ].filter((repository) => repository !== GLOBAL)
  if (!(yield* components(tx, GLOBAL))) return yield* invalid()
  const prepared = new Map<string, Set<string>>()
  for (const repository of affected)
    prepared.set(repository, (yield* requireRepository(tx, repository, repositories === undefined ? 3 : 2)).scopes)
  yield* ReviewWitness.erase(tx, { ...(repositories ? { repositories } : {}), drop: true })
  yield* tx
    .delete(BrainReviewMemoryTable)
    .where(repositories ? inArray(BrainReviewMemoryTable.repository_id, [...repositories]) : undefined)
    .run()
  for (const [repository, scopes] of prepared) {
    for (const scope of scopes) yield* advance(tx, repository, scope, false)
    yield* advanceEpoch(tx, repository)
    yield* revoke(tx, repository)
  }
  if (repositories === undefined) yield* advanceEpoch(tx, GLOBAL)
  yield* tx
    .delete(BrainTombstoneTable)
    .where(
      and(
        or(eq(BrainTombstoneTable.norm_hash, MARKER), like(BrainTombstoneTable.norm_hash, `${SCOPE_MARKER}%`)),
        repositories ? inArray(BrainTombstoneTable.repository_id, [...repositories]) : undefined,
      ),
    )
    .run()
  return rows.length
})

/** Trusted session deletion covers provenance in every scope; an owner-local erase can name just its scope. */
export const eraseSession = Effect.fnUntraced(function* (
  tx: Handle,
  repository: string,
  sessionID: string,
  scope?: string,
) {
  yield* requireRepository(tx, repository, 1)
  if (scope !== undefined) yield* requireState(tx, repository, scope)
  const sources = yield* ReviewWitness.erase(tx, {
    repositories: [repository],
    ...(scope === undefined ? {} : { scope }),
    sessionID,
  })
  const removed = yield* tx
    .delete(BrainReviewMemoryTable)
    .where(
      and(
        eq(BrainReviewMemoryTable.repository_id, repository),
        scope === undefined ? undefined : eq(BrainReviewMemoryTable.scope_id, scope),
        or(
          eq(BrainReviewMemoryTable.parent_session_id, sessionID),
          eq(BrainReviewMemoryTable.review_session_id, sessionID),
        ),
      ),
    )
    .returning({ id: BrainReviewMemoryTable.id })
    .all()
  const current = yield* components(tx, repository)
  if (current?.local || removed.length || sources) {
    if (scope === undefined) yield* advanceEpoch(tx, repository)
    else yield* advance(tx, repository, scope)
    yield* revoke(tx, repository)
  }
  return removed.length
})
