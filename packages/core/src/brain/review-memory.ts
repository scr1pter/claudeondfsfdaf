export * as ReviewMemory from "./review-memory"

import { createHash, randomUUID } from "node:crypto"
import { and, desc, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import type { Brain } from "./brain"
import { BrainDatabase } from "./database"
import { BrainPrivate } from "./private"
import { ReviewStore } from "./review-store"
import { BrainScan } from "./scan"
import { BrainReviewMemoryTable } from "./sql"
import { Token } from "../util/token"
import { Wildcard } from "../util/wildcard"

// VS-11: an opt-in repository review namespace. No generic/personal memory reader, learner, file or template is used.
// This service stores/retrieves real SQLite rows. Its ports do NOT authenticate a person from caller JSON. Before
// activation the Engine must supply actual owner approval/current repository authority and source-lifecycle fencing;
// defaults refuse. Authenticate/display/approve before invoking the callback; do not hold Session/SQL locks while
// waiting for the human. The callback revalidates current authority, then source() holds its lifecycle section only
// around the short commit. No caller JSON can replace those ports.
export const LIMIT = Object.freeze({
  records: 200,
  body: 1_000,
  reason: 500,
  paths: 16,
  citations: 8,
  quote: 500,
  context: 10,
  tokens: 400,
})
export type Kind = "preference" | "outcome" | "check"
export type Citation = { path: string; line: number; head: string; quote: string }
export type Source = { parentID: string; reviewID: string; head: string }
export type Draft = {
  kind: Kind
  text: string
  paths: readonly string[]
  citations: readonly Citation[]
  reason: string
  visibility: "private" | "repository"
}
export type Entry = Draft & {
  id: string
  status: "proposed" | "active"
  origin: "owner" | "review"
  source?: Source
  approvedBy?: string
  approvedAt?: number
  createdAt: number
  updatedAt: number
}
// A server-derived namespace identifier, not authority: both trusted ports must independently bind it to the current physical repository.
export type Place = Brain.Place & { readonly scope: string }
export type State = { enabled: boolean; generation: number }
export type Failure =
  | "invalid"
  | "authority-unavailable"
  | "source-unavailable"
  | "denied"
  | "disabled"
  | "stale"
  | "limit"
  | "not-found"
export type Result<A> = { ok: true; value: A } | { ok: false; reason: Failure }
const fail = (reason: Failure): Result<never> => ({ ok: false, reason })
const success = <A>(value: A): Result<A> => ({ ok: true, value })
export type OwnerRequest = {
  repository: string
  scope: string
  operation: "inspect" | "configure" | "record" | "approve" | "forget" | "erase" | "erase-review"
  digest: string
  payload: unknown // exact bounded snapshot to display/approve; not raw model/session context
}
export interface Authority {
  readonly owner: <A>(
    request: OwnerRequest,
    use: (principal: string) => Effect.Effect<Result<A>>,
  ) => Effect.Effect<Result<A>>
  readonly source: <A>(
    request: Source & { repository: string; scope: string },
    use: () => Effect.Effect<Result<A>>,
  ) => Effect.Effect<Result<A>>
}
export const unavailable: Authority = Object.freeze({
  owner: () => Effect.succeed(fail("authority-unavailable")),
  source: () => Effect.succeed(fail("source-unavailable")),
})
export interface Interface {
  readonly inspect: (
    place: Place,
    options?: { offset?: number; limit?: number },
  ) => Effect.Effect<Result<State & { entries: Entry[] }>>
  readonly configure: (place: Place, input: { expected: number; enabled: boolean }) => Effect.Effect<Result<State>>
  readonly record: (place: Place, input: Draft & { expected: number }) => Effect.Effect<Result<Entry>>
  readonly propose: (place: Place, input: Draft & { expected: number; source: Source }) => Effect.Effect<Result<Entry>>
  readonly approve: (place: Place, input: { expected: number; id: string }) => Effect.Effect<Result<Entry>>
  readonly forget: (place: Place, input: { expected: number; id: string }) => Effect.Effect<Result<State>>
  readonly erase: (place: Place, input: { expected: number }) => Effect.Effect<Result<State>>
  readonly eraseReview: (place: Place, input: { expected: number; source: Source }) => Effect.Effect<Result<State>>
  readonly context: (
    place: Place,
    input: { source: Source; files: readonly string[] },
  ) => Effect.Effect<Result<State & { entries: Pick<Entry, "id" | "kind" | "text" | "reason" | "citations">[] }>>
  readonly current: (place: Place, input: { source: Source; generation: number }) => Effect.Effect<Result<boolean>>
}
export class Service extends Context.Service<Service, Interface>()("@vector/ReviewMemory") {}
export const layerWith = (authority: Authority) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const database = yield* BrainDatabase.Service
      return make(database.db, authority)
    }),
  )
export const layer = layerWith(unavailable)

function make(db: BrainDatabase.Database, authority: Authority): Interface {
  const owner = <A>(
    place: Place,
    operation: OwnerRequest["operation"],
    payload: unknown,
    use: (principal: string) => Effect.Effect<Result<A>>,
  ) => {
    if (!repository(place)) return Effect.succeed(fail("invalid"))
    const snapshot = Object.freeze({ repository: place.repository, scope: place.scope, operation, payload })
    return authority.owner({ ...snapshot, digest: digest(snapshot) }, (principal) =>
      typeof principal === "string" && /^[A-Za-z0-9:_-]{1,256}$/.test(principal)
        ? use(principal)
        : Effect.succeed(fail("denied")),
    )
  }
  const source = <A>(place: Place, input: Source, use: () => Effect.Effect<Result<A>>) => {
    if (!repository(place) || !sourceValue(input)) return Effect.succeed(fail("invalid"))
    return authority.source(Object.freeze({ repository: place.repository, scope: place.scope, ...input }), use)
  }
  // Reconciliation and the read/write share one SQLite transaction on EVERY boundary, including warmed services.
  const within = <A>(place: Place, use: (tx: ReviewStore.Handle, state: State) => Effect.Effect<Result<A>, unknown>) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          if (!(yield* ReviewStore.state(tx, place.repository, place.scope))) return fail("stale")
          yield* ReviewStore.reconcile(tx, place.repository, place.scope)
          const state = yield* ReviewStore.state(tx, place.repository, place.scope)
          if (!state) return fail("stale")
          return yield* use(tx, state)
        }),
      )
      .pipe(Effect.orDie)
  const resultState = (tx: ReviewStore.Handle, place: Place) =>
    ReviewStore.state(tx, place.repository, place.scope).pipe(
      Effect.map((state) => (state ? success(state) : fail("stale"))),
    )

  const inspect: Interface["inspect"] = (place, options = {}) => {
    const offset = options.offset ?? 0
    const limit = options.limit ?? 50
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > LIMIT.records ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      return Effect.succeed(fail("invalid"))
    return owner(place, "inspect", { offset, limit }, () =>
      within(place, (tx) =>
        Effect.gen(function* () {
          yield* ReviewStore.register(tx, place.repository, place.scope)
          const state = yield* ReviewStore.state(tx, place.repository, place.scope)
          if (!state) return fail("stale")
          const rows = yield* tx
            .select()
            .from(BrainReviewMemoryTable)
            .where(
              and(
                eq(BrainReviewMemoryTable.repository_id, place.repository),
                eq(BrainReviewMemoryTable.scope_id, place.scope),
              ),
            )
            .orderBy(desc(BrainReviewMemoryTable.updated_at), BrainReviewMemoryTable.id)
            .limit(limit)
            .offset(offset)
          return success({
            ...state,
            entries: rows.flatMap((row) => {
              const entry = entryValue(row)
              return entry ? [entry] : []
            }),
          })
        }),
      ),
    )
  }
  const configure: Interface["configure"] = (place, input) => {
    if (!keys(input, ["expected", "enabled"]) || !generation(input.expected) || typeof input.enabled !== "boolean")
      return Effect.succeed(fail("invalid"))
    const captured = Object.freeze({ expected: input.expected, enabled: input.enabled })
    return owner(place, "configure", captured, () =>
      within(place, (tx, state) =>
        Effect.gen(function* () {
          if (state.generation !== captured.expected) return fail("stale")
          if (place.held && captured.enabled) return fail("denied")
          // First inspect with authenticated owner authority, then approve this exact generation. A missing old-build
          // erase witness is not restored by a delayed enable approval itself.
          if (
            !(yield* ReviewStore.marked(tx, place.repository)) ||
            !(yield* ReviewStore.marked(tx, place.repository, place.scope))
          )
            return fail("stale")
          yield* ReviewStore.advance(tx, place.repository, place.scope, captured.enabled)
          if (!captured.enabled) yield* ReviewStore.revoke(tx, place.repository)
          return yield* resultState(tx, place)
        }),
      ),
    )
  }
  const save = (place: Place, input: unknown, proposed: boolean) => {
    if (
      !keys(
        input,
        proposed
          ? ["expected", "source", "kind", "text", "paths", "citations", "reason", "visibility"]
          : ["expected", "kind", "text", "paths", "citations", "reason", "visibility"],
      ) ||
      !generation(input.expected)
    )
      return Effect.succeed(fail("invalid"))
    const draft = draftValue(input)
    const provenance = proposed ? sourceValue(input.source) : undefined
    if (
      !draft ||
      (!proposed && draft.kind === "outcome") ||
      (proposed &&
        (!provenance ||
          draft.kind !== "outcome" ||
          !draft.citations.length ||
          draft.paths.some((path) => /[*?]/.test(path)) ||
          draft.citations.some((cite) => cite.head !== provenance.head)))
    )
      return Effect.succeed(fail("invalid"))
    const expected = input.expected
    const captured = Object.freeze({ ...draft, expected, ...(provenance ? { source: provenance } : {}) })
    const write = (principal?: string) =>
      within(place, (tx, state) =>
        Effect.gen(function* () {
          if (state.generation !== expected) return fail("stale")
          if (!state.enabled) return fail("disabled")
          if (place.held) return fail("denied")
          const rows = yield* tx
            .select({ id: BrainReviewMemoryTable.id })
            .from(BrainReviewMemoryTable)
            .where(
              and(
                eq(BrainReviewMemoryTable.repository_id, place.repository),
                eq(BrainReviewMemoryTable.scope_id, place.scope),
              ),
            )
            .limit(LIMIT.records)
          if (rows.length >= LIMIT.records) return fail("limit")
          const now = Date.now()
          const row: typeof BrainReviewMemoryTable.$inferInsert = {
            id: `vr_${randomUUID()}`,
            repository_id: place.repository,
            scope_id: place.scope,
            kind: draft.kind,
            status: proposed ? "proposed" : "active",
            visibility: draft.visibility,
            body: draft.text,
            paths: [...draft.paths],
            citations: [...draft.citations],
            reason: draft.reason,
            parent_session_id: provenance?.parentID,
            review_session_id: provenance?.reviewID,
            source_head: provenance?.head,
            origin: proposed ? "review" : "owner",
            approved_by: principal,
            approved_at: principal ? now : undefined,
            created_at: now,
            updated_at: now,
          }
          const saved = yield* tx.insert(BrainReviewMemoryTable).values(row).returning().get()
          yield* ReviewStore.advance(tx, place.repository, place.scope)
          return success(entryValue(saved)!)
        }),
      )
    return proposed ? source(place, provenance!, () => write()) : owner(place, "record", captured, write)
  }
  const approve: Interface["approve"] = (place, input) => {
    if (!keys(input, ["expected", "id"]) || !generation(input.expected) || !identifier(input.id))
      return Effect.succeed(fail("invalid"))
    const captured = Object.freeze({ expected: input.expected, id: input.id })
    return Effect.gen(function* () {
      // Authenticate read access first. This short transaction ends BEFORE displaying/asking for approval.
      const found = yield* owner(place, "inspect", captured, () =>
        within(place, (tx, state) =>
          Effect.gen(function* () {
            if (state.generation !== captured.expected) return fail("stale")
            const row = yield* tx
              .select()
              .from(BrainReviewMemoryTable)
              .where(
                and(
                  and(
                    eq(BrainReviewMemoryTable.repository_id, place.repository),
                    eq(BrainReviewMemoryTable.scope_id, place.scope),
                  ),
                  eq(BrainReviewMemoryTable.id, captured.id),
                ),
              )
              .get()
            const entry = row ? entryValue(row) : undefined
            return entry?.source && entry.status === "proposed"
              ? success({ entry: Object.freeze(entry), fingerprint: digest(row) })
              : fail("not-found")
          }),
        ),
      )
      if (!found.ok) return found
      const snapshot = found.value.entry
      const provenance = snapshot.source
      if (!provenance) return fail("not-found")
      const preview = Object.freeze({ ...captured, entry: snapshot })
      return yield* owner(place, "approve", preview, (principal) =>
        source(place, provenance, () =>
          within(place, (tx, state) =>
            Effect.gen(function* () {
              if (state.generation !== captured.expected) return fail("stale")
              if (!state.enabled) return fail("disabled")
              if (place.held) return fail("denied")
              const current = yield* tx
                .select()
                .from(BrainReviewMemoryTable)
                .where(
                  and(
                    and(
                      eq(BrainReviewMemoryTable.repository_id, place.repository),
                      eq(BrainReviewMemoryTable.scope_id, place.scope),
                    ),
                    eq(BrainReviewMemoryTable.id, captured.id),
                  ),
                )
                .get()
              if (!current || current.status !== "proposed" || digest(current) !== found.value.fingerprint)
                return fail("stale")
              const rows = yield* tx
                .update(BrainReviewMemoryTable)
                .set({ status: "active", approved_by: principal, approved_at: Date.now(), updated_at: Date.now() })
                .where(
                  and(
                    and(
                      eq(BrainReviewMemoryTable.repository_id, place.repository),
                      eq(BrainReviewMemoryTable.scope_id, place.scope),
                    ),
                    eq(BrainReviewMemoryTable.id, captured.id),
                    eq(BrainReviewMemoryTable.status, "proposed"),
                  ),
                )
                .returning()
                .all()
              if (rows.length !== 1) return fail("stale")
              yield* ReviewStore.advance(tx, place.repository, place.scope)
              return success(entryValue(rows[0])!)
            }),
          ),
        ),
      )
    })
  }
  const forget: Interface["forget"] = (place, input) => {
    if (!keys(input, ["expected", "id"]) || !generation(input.expected) || !identifier(input.id))
      return Effect.succeed(fail("invalid"))
    const captured = Object.freeze({ expected: input.expected, id: input.id })
    return owner(place, "forget", captured, () =>
      within(place, (tx, state) =>
        Effect.gen(function* () {
          if (state.generation !== captured.expected) return fail("stale")
          const removed = yield* tx
            .delete(BrainReviewMemoryTable)
            .where(
              and(
                and(
                  eq(BrainReviewMemoryTable.repository_id, place.repository),
                  eq(BrainReviewMemoryTable.scope_id, place.scope),
                ),
                eq(BrainReviewMemoryTable.id, captured.id),
              ),
            )
            .returning({ id: BrainReviewMemoryTable.id })
            .all()
          if (!removed.length) return fail("not-found")
          yield* ReviewStore.advance(tx, place.repository, place.scope)
          yield* ReviewStore.revoke(tx, place.repository)
          return yield* resultState(tx, place)
        }),
      ),
    )
  }
  const erase: Interface["erase"] = (place, input) => {
    if (!keys(input, ["expected"]) || !generation(input.expected)) return Effect.succeed(fail("invalid"))
    const captured = Object.freeze({ expected: input.expected })
    return owner(place, "erase", captured, () =>
      within(place, (tx, state) =>
        Effect.gen(function* () {
          if (state.generation !== captured.expected) return fail("stale")
          yield* ReviewStore.eraseNamespace(tx, place.repository, place.scope)
          return yield* resultState(tx, place)
        }),
      ),
    )
  }
  const eraseReview: Interface["eraseReview"] = (place, input) => {
    if (!keys(input, ["expected", "source"]) || !generation(input.expected)) return Effect.succeed(fail("invalid"))
    const provenance = sourceValue(input.source)
    if (!provenance) return Effect.succeed(fail("invalid"))
    const captured = Object.freeze({ expected: input.expected, source: provenance })
    return owner(place, "erase-review", captured, () =>
      source(place, provenance, () =>
        within(place, (tx, state) =>
          Effect.gen(function* () {
            if (state.generation !== captured.expected) return fail("stale")
            yield* ReviewStore.eraseSession(tx, place.repository, provenance.reviewID, place.scope)
            return yield* resultState(tx, place)
          }),
        ),
      ),
    )
  }
  const context: Interface["context"] = (place, input) => {
    if (
      !keys(input, ["source", "files"]) ||
      !Array.isArray(input.files) ||
      input.files.length > 40 ||
      [...input.files].some((file) => !pathValue(file, false))
    )
      return Effect.succeed(fail("invalid"))
    const provenance = sourceValue(input.source)
    if (!provenance) return Effect.succeed(fail("invalid"))
    const files: readonly string[] = [...input.files]
    return source(place, provenance, () =>
      within(place, (tx, state) =>
        Effect.gen(function* () {
          const entries: Pick<Entry, "id" | "kind" | "text" | "reason" | "citations">[] = []
          if (!state.enabled || place.held || !files.length) return success({ ...state, entries })
          const rows = yield* tx
            .select()
            .from(BrainReviewMemoryTable)
            .where(
              and(
                and(
                  eq(BrainReviewMemoryTable.repository_id, place.repository),
                  eq(BrainReviewMemoryTable.scope_id, place.scope),
                ),
                eq(BrainReviewMemoryTable.status, "active"),
                eq(BrainReviewMemoryTable.visibility, "repository"),
              ),
            )
            .orderBy(desc(BrainReviewMemoryTable.updated_at), BrainReviewMemoryTable.id)
            .limit(LIMIT.records)
          for (const row of rows) {
            if (entries.length >= LIMIT.context) break
            const entry = entryValue(row)
            if (
              !entry ||
              !entry.approvedBy ||
              !entry.approvedAt ||
              !entry.paths.some((path) => files.some((file) => Wildcard.match(file, path)))
            )
              continue
            const shown = [entry.text, entry.reason, ...entry.citations.map((cite) => cite.quote)].join("\n")
            if (!BrainPrivate.screened({ kind: "decision", text: shown })) continue
            const item = {
              id: entry.id,
              kind: entry.kind,
              text: entry.text,
              reason: entry.reason,
              citations: entry.citations,
            }
            if (Token.estimate(JSON.stringify([...entries, item])) > LIMIT.tokens) continue
            entries.push(item)
          }
          return success({ ...state, entries })
        }),
      ),
    )
  }
  const current: Interface["current"] = (place, input) => {
    if (!keys(input, ["source", "generation"]) || !generation(input.generation)) return Effect.succeed(fail("invalid"))
    const provenance = sourceValue(input.source)
    if (!provenance) return Effect.succeed(fail("invalid"))
    const expected = input.generation
    return source(place, provenance, () =>
      within(place, (_tx, state) =>
        Effect.succeed(success(state.enabled && !place.held && state.generation === expected)),
      ),
    )
  }
  return {
    inspect: (place, input) => inspect(placeValue(place), input),
    configure: (place, input) => configure(placeValue(place), input),
    record: (place, input) => save(placeValue(place), input, false),
    propose: (place, input) => save(placeValue(place), input, true),
    approve: (place, input) => approve(placeValue(place), input),
    forget: (place, input) => forget(placeValue(place), input),
    erase: (place, input) => erase(placeValue(place), input),
    eraseReview: (place, input) => eraseReview(placeValue(place), input),
    context: (place, input) => context(placeValue(place), input),
    current: (place, input) => current(placeValue(place), input),
  }
}

function placeValue(place: Place): Place {
  // No ambient file source survives this boundary, and a caller cannot retarget a suspended owner/source callback.
  return Object.freeze({
    repository: typeof place?.repository === "string" ? place.repository : "",
    scope: typeof place?.scope === "string" ? place.scope : "",
    held: place?.held !== false,
    root: "",
    sources: Object.freeze([]),
  })
}

function draftValue(input: Record<string, unknown>): Draft | undefined {
  if (
    (input.kind !== "preference" && input.kind !== "outcome" && input.kind !== "check") ||
    !safeText(input.text, LIMIT.body) ||
    !safeText(input.reason, LIMIT.reason) ||
    (input.visibility !== "private" && input.visibility !== "repository") ||
    !Array.isArray(input.paths) ||
    !input.paths.length ||
    input.paths.length > LIMIT.paths ||
    [...input.paths].some((path) => !pathValue(path, true)) ||
    new Set(input.paths).size !== input.paths.length ||
    !Array.isArray(input.citations) ||
    input.citations.length > LIMIT.citations
  )
    return
  const citations = input.citations.flatMap((cite) =>
    keys(cite, ["path", "line", "head", "quote"]) &&
    pathValue(cite.path, false) &&
    typeof cite.line === "number" &&
    Number.isSafeInteger(cite.line) &&
    cite.line > 0 &&
    cite.line <= 10_000_000 &&
    commit(cite.head) &&
    safeText(cite.quote, LIMIT.quote)
      ? [Object.freeze({ path: cite.path, line: cite.line, head: cite.head, quote: cite.quote })]
      : [],
  )
  if (citations.length !== input.citations.length) return
  return Object.freeze({
    kind: input.kind,
    text: input.text,
    reason: input.reason,
    visibility: input.visibility,
    paths: Object.freeze([...input.paths]),
    citations: Object.freeze(citations),
  })
}
function entryValue(row: typeof BrainReviewMemoryTable.$inferSelect): Entry | undefined {
  const draft = draftValue({
    kind: row.kind,
    text: row.body,
    reason: row.reason,
    visibility: row.visibility,
    paths: row.paths,
    citations: row.citations,
  })
  const source =
    row.parent_session_id && row.review_session_id && row.source_head
      ? sourceValue({ parentID: row.parent_session_id, reviewID: row.review_session_id, head: row.source_head })
      : undefined
  if (
    !draft ||
    !identifier(row.id) ||
    (row.status !== "proposed" && row.status !== "active") ||
    (row.origin !== "owner" && row.origin !== "review") ||
    (row.origin === "review" && !source) ||
    (row.status === "active" && (!row.approved_by || !row.approved_at)) ||
    !Number.isSafeInteger(row.created_at) ||
    !Number.isSafeInteger(row.updated_at)
  )
    return
  return {
    ...draft,
    id: row.id,
    status: row.status,
    origin: row.origin,
    ...(source ? { source } : {}),
    ...(row.approved_by ? { approvedBy: row.approved_by } : {}),
    ...(row.approved_at ? { approvedAt: row.approved_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
function sourceValue(input: unknown): Source | undefined {
  if (
    !keys(input, ["parentID", "reviewID", "head"]) ||
    !identifier(input.parentID) ||
    !identifier(input.reviewID) ||
    input.parentID === input.reviewID ||
    !commit(input.head)
  )
    return
  return Object.freeze({ parentID: input.parentID, reviewID: input.reviewID, head: input.head })
}
function repository(place: Place) {
  return !!place && identifier(place.repository) && place.repository !== "" && ReviewStore.scopeValue(place.scope)
}
function identifier(input: unknown): input is string {
  return typeof input === "string" && /^[A-Za-z0-9:_-]{1,256}$/.test(input)
}
function commit(input: unknown): input is string {
  return typeof input === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input)
}
function generation(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0 && input < Number.MAX_SAFE_INTEGER
}
function pathValue(input: unknown, glob: boolean): input is string {
  return (
    typeof input === "string" &&
    input.length > 0 &&
    input.length <= 512 &&
    (glob ? /^[A-Za-z0-9_./*?-]+$/ : /^[A-Za-z0-9_./-]+$/).test(input) &&
    input.split("/").every((part) => !!part && part !== "." && part !== ".." && part.toLowerCase() !== ".git")
  )
}
function safeText(input: unknown, max: number): input is string {
  return (
    typeof input === "string" &&
    input.trim().length > 0 &&
    input.length <= max &&
    input.isWellFormed() &&
    !input.includes("\0") &&
    BrainScan.stripHidden(input) === input &&
    !BrainScan.credential(input) &&
    !BrainScan.redact(input, {}).redacted
  )
}
function keys(input: unknown, names: readonly string[]): input is Record<string, unknown> {
  return (
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.getPrototypeOf(input) === Object.prototype &&
    Reflect.ownKeys(input).length === names.length &&
    names.every(
      (name) =>
        Object.getOwnPropertyDescriptor(input, name)?.enumerable &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(input, name)!, "value"),
    )
  )
}
function digest(input: unknown) {
  return `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`
}
