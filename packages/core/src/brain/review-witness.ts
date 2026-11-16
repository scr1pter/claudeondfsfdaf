export * as ReviewWitness from "./review-witness"

import { createHash } from "node:crypto"
import { and, eq, inArray, or, sql } from "drizzle-orm"
import { Context, Effect, Option, Schema } from "effect"
import { ReviewSourceBinding } from "../review/source-binding"
import type { ReviewStore } from "./review-store"
import { BrainEntryTable, BrainEvidenceTable, BrainReviewMemorySourceTable, BrainReviewMemoryTable } from "./sql"

export const LIMIT = 1_000
export const STATUS = "vector-review-source-metadata-v1"
export const PREFIX = "vector-review-witness:v1:"
// Old forgetting copies the polarity into a tombstone. Its 64 `only:` items
// cannot equal an accepted old agent memory (<=300 chars; at most60 `only`s).
export const BODY = Array.from({ length: 64 }, () => "only").join(" ")
export type Proof = {
  repository: string
  scope: string
  parentID: string
  reviewID: string
  head: string
  witnesses: ReviewSourceBinding.Witnesses
}
// Engine-only proof scoped to one authenticated source callback. No public
// payload, owner toggle or lazy reader can supply registration authority.
export const Current = Context.Reference<Proof | undefined>("@vector/ReviewSourceWitness", {
  defaultValue: () => undefined,
})
type Handle = ReviewStore.Handle
type SourceRow = typeof BrainReviewMemorySourceTable.$inferSelect
type Marker = {
  entry: typeof BrainEntryTable.$inferSelect
  status: unknown
  pinned: unknown
  tier0: unknown
  private: unknown
  stale: unknown
}
type Evidence = typeof BrainEvidenceTable.$inferSelect
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9:_-]{1,256}$/.test(value)
const invalid = () => Effect.die(new Error("Review source witness metadata is invalid"))
const scopeWhere = (repository: string, scope: string) =>
  and(eq(BrainReviewMemorySourceTable.repository_id, repository), eq(BrainReviewMemorySourceTable.scope_id, scope))
const key = (input: Proof) =>
  and(scopeWhere(input.repository, input.scope), eq(BrainReviewMemorySourceTable.review_session_id, input.reviewID))
const uri = (input: Proof, role: "parent" | "review") =>
  `${PREFIX}${input.scope}:${input.witnesses.parent}:${input.witnesses.review}:${role}`
const signature = (input: Proof, role: "parent" | "review") =>
  createHash("sha256")
    .update(
      JSON.stringify([
        PREFIX,
        input.repository,
        input.scope,
        input.parentID,
        input.reviewID,
        input.head,
        input.witnesses,
        role,
      ]),
    )
    .digest("hex")
const hash = (id: string) => `${PREFIX}${id}`

/** Private source proof from a verified saved Main reservation, never model/HTTP JSON. */
export function proof(input: unknown): Proof | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  const row = Object.getOwnPropertyDescriptors(input)
  if (
    Object.keys(row).length !== 6 ||
    ["repository", "scope", "parentID", "reviewID", "head", "witnesses"].some(
      (name) => !row[name] || !("value" in row[name]),
    )
  )
    return
  const value: Record<string, unknown> = Object.fromEntries(
    Object.entries(row).map(([name, descriptor]) => [name, descriptor.value]),
  )
  const pair = Schema.decodeUnknownOption(ReviewSourceBinding.Witnesses)(value.witnesses)
  if (
    !identifier(value.repository) ||
    !identifier(value.scope) ||
    !identifier(value.parentID) ||
    !identifier(value.reviewID) ||
    value.parentID === value.reviewID ||
    typeof value.head !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.head) ||
    Option.isNone(pair) ||
    pair.value.parent === pair.value.review
  )
    return
  return Object.freeze({
    repository: value.repository,
    scope: value.scope,
    parentID: value.parentID,
    reviewID: value.reviewID,
    head: value.head,
    witnesses: Object.freeze({ version: 1, parent: pair.value.parent, review: pair.value.review }),
  })
}
const fromRow = (row: SourceRow) =>
  proof({
    repository: row.repository_id,
    scope: row.scope_id,
    parentID: row.parent_session_id,
    reviewID: row.review_session_id,
    head: row.source_head,
    witnesses: { version: 1, parent: row.parent_marker_id, review: row.review_marker_id },
  })
const same = (row: SourceRow, input: Proof) =>
  row.repository_id === input.repository &&
  row.scope_id === input.scope &&
  row.parent_session_id === input.parentID &&
  row.review_session_id === input.reviewID &&
  row.source_head === input.head &&
  row.parent_marker_id === input.witnesses.parent &&
  row.review_marker_id === input.witnesses.review

function intact(marker: Marker | undefined, evidence: readonly Evidence[], input: Proof, role: "parent" | "review") {
  if (!marker || evidence.length !== 1) return false
  const row = marker.entry
  const entry = evidence[0]!
  const id = input.witnesses[role]
  const session = role === "parent" ? input.parentID : input.reviewID
  return (
    row.id === id &&
    row.repository_id === input.repository &&
    row.scope === "repository" &&
    row.kind === "fact" &&
    row.origin === "agent" &&
    marker.status === STATUS &&
    marker.pinned === 0 &&
    marker.tier0 === 0 &&
    marker.private === 0 &&
    marker.stale === 0 &&
    row.body === BODY &&
    row.terms === "{}" &&
    row.norm_hash === hash(id) &&
    row.confidence === 0 &&
    row.uses === 0 &&
    row.helpful === 0 &&
    row.harmful === 0 &&
    row.last_used_at === null &&
    row.created_at === 0 &&
    row.updated_at === 0 &&
    row.superseded_by === null &&
    row.hold_reason === null &&
    row.source_file === uri(input, role) &&
    row.source_line === null &&
    row.origin_session_id === session &&
    row.signature === signature(input, role) &&
    row.facet === null &&
    row.term_key === null &&
    Array.isArray(row.paths) &&
    row.paths.length === 0 &&
    Array.isArray(row.related) &&
    row.related.length === 0 &&
    entry.entry_id === id &&
    entry.type === "message" &&
    entry.session_id === session &&
    entry.created_at === -1 &&
    entry.path === null &&
    entry.quote === null &&
    entry.file_hash === null &&
    entry.command === null
  )
}

const load = Effect.fnUntraced(function* (tx: Handle, inputs: readonly Proof[]) {
  const ids = inputs.flatMap((input) => [input.witnesses.parent, input.witnesses.review])
  const markers = new Map<string, Marker>()
  const evidence = new Map<string, Evidence[]>()
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500)
    for (const row of yield* tx
      .select({
        entry: BrainEntryTable,
        status: sql<unknown>`${BrainEntryTable.status}`,
        // Drizzle's boolean decoder maps2 to false; the private protocol needs
        // exact stored zeros, not decoded truthiness.
        pinned: sql<unknown>`${BrainEntryTable.pinned}`,
        tier0: sql<unknown>`${BrainEntryTable.tier0}`,
        private: sql<unknown>`${BrainEntryTable.private}`,
        stale: sql<unknown>`${BrainEntryTable.stale}`,
      })
      .from(BrainEntryTable)
      .where(inArray(BrainEntryTable.id, batch))
      .all())
      markers.set(row.entry.id, row)
    // Count first: a tampered marker with arbitrarily many evidence rows must
    // refuse without materializing them or truncating to a false sole witness.
    const counts = yield* tx
      .select({ id: BrainEvidenceTable.entry_id, n: sql<number>`count(*)` })
      .from(BrainEvidenceTable)
      .where(inArray(BrainEvidenceTable.entry_id, batch))
      .groupBy(BrainEvidenceTable.entry_id)
      .all()
    const sole = counts.filter((row) => row.n === 1).map((row) => row.id)
    if (sole.length)
      for (const row of yield* tx
        .select()
        .from(BrainEvidenceTable)
        .where(inArray(BrainEvidenceTable.entry_id, sole))
        .limit(sole.length + 1)) {
        const entries = evidence.get(row.entry_id) ?? []
        entries.push(row)
        evidence.set(row.entry_id, entries)
      }
  }
  return (input: Proof) =>
    intact(markers.get(input.witnesses.parent), evidence.get(input.witnesses.parent) ?? [], input, "parent") &&
    intact(markers.get(input.witnesses.review), evidence.get(input.witnesses.review) ?? [], input, "review")
})

/** Caller owns the short IMMEDIATE Brain transaction and the genuine INSERT-winner/attached Main proof. */
export const register = Effect.fnUntraced(function* (tx: Handle, input: Proof) {
  const captured = proof(input)
  if (!captured) return false
  const old = yield* tx
    .select()
    .from(BrainReviewMemorySourceTable)
    .where(
      or(
        key(captured),
        inArray(BrainReviewMemorySourceTable.parent_marker_id, [captured.witnesses.parent, captured.witnesses.review]),
        inArray(BrainReviewMemorySourceTable.review_marker_id, [captured.witnesses.parent, captured.witnesses.review]),
      ),
    )
    .limit(1)
  const content = yield* tx
    .select({ id: BrainReviewMemoryTable.id })
    .from(BrainReviewMemoryTable)
    .where(
      and(
        eq(BrainReviewMemoryTable.repository_id, captured.repository),
        eq(BrainReviewMemoryTable.scope_id, captured.scope),
        eq(BrainReviewMemoryTable.review_session_id, captured.reviewID),
      ),
    )
    .limit(1)
  const count = yield* tx
    .select({ n: sql<number>`count(*)` })
    .from(BrainReviewMemorySourceTable)
    .where(scopeWhere(captured.repository, captured.scope))
    .get()
  const prefix = `${PREFIX}${captured.scope}:`
  const markers = yield* tx
    .select({ n: sql<number>`count(*)` })
    .from(BrainEntryTable)
    .where(
      and(
        eq(BrainEntryTable.repository_id, captured.repository),
        sql`${BrainEntryTable.status} = ${STATUS}`,
        sql`substr(${BrainEntryTable.source_file}, 1, ${prefix.length}) = ${prefix}`,
      ),
    )
    .get()
  if (old.length || content.length || !count || !markers || count.n >= LIMIT || markers.n > (LIMIT - 1) * 2)
    return false
  yield* tx
    .insert(BrainReviewMemorySourceTable)
    .values({
      repository_id: captured.repository,
      scope_id: captured.scope,
      parent_session_id: captured.parentID,
      review_session_id: captured.reviewID,
      source_head: captured.head,
      parent_marker_id: captured.witnesses.parent,
      review_marker_id: captured.witnesses.review,
      state: "active",
    })
    .run()
  for (const role of ["parent", "review"] as const) {
    const id = captured.witnesses[role]
    const session = role === "parent" ? captured.parentID : captured.reviewID
    // Raw, fixed protocol metadata: generic public Status remains unchanged.
    yield* tx.run(sql`INSERT INTO brain_entry
      (id, scope, repository_id, kind, origin, status, pinned, body, paths, terms, norm_hash, confidence,
       uses, helpful, harmful, created_at, updated_at, stale, related, tier0, source_file, origin_session_id, signature, private)
      VALUES (${id}, 'repository', ${captured.repository}, 'fact', 'agent', ${STATUS}, 0, ${BODY}, '[]', '{}', ${hash(id)}, 0,
       0, 0, 0, 0, 0, 0, '[]', 0, ${uri(captured, role)}, ${session}, ${signature(captured, role)}, 0)`)
    // -1 is strictly below every validated user timestamp AND the since=0 fallback.
    yield* tx
      .insert(BrainEvidenceTable)
      .values({ entry_id: id, type: "message", session_id: session, created_at: -1 })
      .run()
  }
  if (!(yield* load(tx, [captured]))(captured)) return yield* invalid()
  return true
})

/** Reconcile all producers, not just the current review. Returns one batch change for the caller's epoch bump. */
export const reconcile = Effect.fnUntraced(function* (tx: Handle, repository: string, scope: string) {
  const rows = yield* tx
    .select()
    .from(BrainReviewMemorySourceTable)
    .where(scopeWhere(repository, scope))
    .limit(LIMIT + 1)
  const content = yield* tx
    .select()
    .from(BrainReviewMemoryTable)
    .where(
      and(
        eq(BrainReviewMemoryTable.repository_id, repository),
        eq(BrainReviewMemoryTable.scope_id, scope),
        eq(BrainReviewMemoryTable.origin, "review"),
      ),
    )
    .limit(201)
  if (rows.length > LIMIT || content.length > 200) return yield* invalid()
  const sources = rows.flatMap((row) => {
    const value = fromRow(row)
    return value && (row.state === "active" || row.state === "retired") ? [{ row, value }] : []
  })
  if (sources.length !== rows.length) return yield* invalid()
  const healthy = yield* load(
    tx,
    sources.filter((source) => source.row.state === "active").map((source) => source.value),
  )
  const valid = new Map(
    sources
      .filter((source) => source.row.state === "active" && healthy(source.value))
      .map((source) => [source.value.reviewID, source.value]),
  )
  const retired = sources.filter((source) => source.row.state === "active" && !valid.has(source.value.reviewID))
  const removed = content.filter((row) => {
    const source = row.review_session_id ? valid.get(row.review_session_id) : undefined
    return !source || row.parent_session_id !== source.parentID || row.source_head !== source.head
  })
  for (const source of retired)
    yield* tx.update(BrainReviewMemorySourceTable).set({ state: "retired" }).where(key(source.value)).run()
  if (removed.length)
    yield* tx
      .delete(BrainReviewMemoryTable)
      .where(
        inArray(
          BrainReviewMemoryTable.id,
          removed.map((row) => row.id),
        ),
      )
      .run()
  return { changed: retired.length > 0 || removed.length > 0, removed: removed.length }
})

/** Must follow reconciliation in the same Brain transaction; zero content rows never bypass this check. */
export const current = Effect.fnUntraced(function* (tx: Handle, input: Proof) {
  const captured = proof(input)
  if (!captured) return false
  const row = yield* tx.select().from(BrainReviewMemorySourceTable).where(key(captured)).get()
  return !!row && row.state === "active" && same(row, captured) && (yield* load(tx, [captured]))(captured)
})

/** Explicit erasure only. Never called by generic retention or used to repair a missing marker. */
export const erase = Effect.fnUntraced(function* (
  tx: Handle,
  input: {
    repositories?: readonly string[]
    scope?: string
    sessionID?: string
    reviewID?: string
    drop?: boolean
  },
) {
  const where = and(
    input.repositories ? inArray(BrainReviewMemorySourceTable.repository_id, [...input.repositories]) : undefined,
    input.scope === undefined ? undefined : eq(BrainReviewMemorySourceTable.scope_id, input.scope),
    input.reviewID === undefined ? undefined : eq(BrainReviewMemorySourceTable.review_session_id, input.reviewID),
    input.sessionID === undefined
      ? undefined
      : or(
          eq(BrainReviewMemorySourceTable.parent_session_id, input.sessionID),
          eq(BrainReviewMemorySourceTable.review_session_id, input.sessionID),
        ),
  )
  const rows = yield* tx.select().from(BrainReviewMemorySourceTable).where(where).all()
  const sources = rows.flatMap((row) => {
    const value = fromRow(row)
    return value ? [value] : []
  })
  if (sources.length !== rows.length || rows.some((row) => row.state !== "active" && row.state !== "retired"))
    return yield* invalid()
  for (const source of sources)
    yield* tx
      .delete(BrainEntryTable)
      .where(
        and(
          eq(BrainEntryTable.repository_id, source.repository),
          inArray(BrainEntryTable.id, [source.witnesses.parent, source.witnesses.review]),
          sql`${BrainEntryTable.status} = ${STATUS}`,
          inArray(BrainEntryTable.source_file, [uri(source, "parent"), uri(source, "review")]),
        ),
      )
      .run()
  if (input.drop) yield* tx.delete(BrainReviewMemorySourceTable).where(where).run()
  if (!input.drop) yield* tx.update(BrainReviewMemorySourceTable).set({ state: "retired" }).where(where).run()
  return input.drop ? rows.length : rows.filter((row) => row.state === "active").length
})
