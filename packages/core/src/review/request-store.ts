import { and, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { Cause, Context, Effect, Layer, Option, Schema } from "effect"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { SessionID } from "@vectordevai/schema/session-id"
import { Database } from "../database/database"
import { BackgroundJobStore } from "../background-job-store"
import { makeGlobalNode } from "../effect/app-node"
import { SessionTable } from "../session/sql"
import { PINNED_SESSION_PREFIX } from "./prompt"
import { ReviewRequestTable, ReviewSessionFenceTable, type Phase } from "./request.sql"

export class Refused extends Schema.TaggedErrorClass<Refused>()("ReviewRequestStore.Refused", {
  code: Schema.Literals(["invalid", "conflict", "unavailable", "corrupt", "busy"]),
  message: Schema.String,
}) {}

export interface Row {
  parentID: SessionID
  request: ReviewRun.Start
  ownerNonce: string
  runID?: SessionID
  owner?: BackgroundJobStore.Owner
  phase: Phase
}
type Identity = { parentID: SessionID; requestID: string; ownerNonce: string; runID: SessionID }
export interface Interface {
  readonly reserve: (input: {
    parentID: SessionID
    request: ReviewRun.Start
    ownerNonce: string
    owner: BackgroundJobStore.Owner
  }) => Effect.Effect<{ claimed: boolean; row: Row }, Refused>
  /** Only the INSERT winner may attach its fresh session, exactly once, before model work. */
  readonly attach: (input: {
    parentID: SessionID
    requestID: string
    ownerNonce: string
    runID: SessionID
  }) => Effect.Effect<boolean>
  readonly ready: (input: Identity) => Effect.Effect<boolean>
  readonly begin: (input: Identity) => Effect.Effect<boolean>
  readonly finish: (input: Pick<Identity, "parentID" | "requestID" | "ownerNonce">) => Effect.Effect<void>
  readonly beginDelete: (input: {
    sessionID: SessionID
    ownerNonce: string
    owner: BackgroundJobStore.Owner
    localNonces: ReadonlySet<string>
    insideReview: boolean
  }) => Effect.Effect<string[], Refused>
  readonly endDelete: (sessionID: SessionID, ownerNonce: string) => Effect.Effect<void>
  /** Read-only metadata: missing sessions or a persistent closing fence are never live source authority. */
  readonly sourceSnapshot: (
    parentID: SessionID,
    runID: SessionID,
  ) => Effect.Effect<
    | {
        request: ReviewRun.Start
        phase: "running" | "settled"
      }
    | undefined,
    Refused
  >
  /** Deletion metadata is available only to the exact holder of the durable closing fence. */
  readonly closingSnapshot: (
    sessionID: SessionID,
    ownerNonce: string,
  ) => Effect.Effect<
    | {
        repository: (typeof SessionTable.$inferSelect)["project_id"]
        directory: string
      }
    | undefined,
    Refused
  >
}
export class Service extends Context.Service<Service, Interface>()("@vector/ReviewRequestStore") {}

const key = (parentID: SessionID, requestID: string) =>
  and(eq(ReviewRequestTable.parent_session_id, parentID), eq(ReviewRequestTable.request_id, requestID))
const canonical = (request: ReviewRun.Start) =>
  JSON.stringify({
    requestID: request.requestID,
    target: { kind: request.target.kind, head: request.target.head },
    ...(request.maxCost === undefined ? {} : { maxCost: request.maxCost }),
  })
type Transaction = Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]
const ownerSchema = Schema.Struct({
  runtime: Schema.String,
  pid: Schema.Int,
  boot: Schema.Finite,
  machine: Schema.String,
})
const phaseSchema = Schema.Literals(["reserved", "attached", "running", "settled"])
const open = (tx: Transaction, parentID: SessionID, runID?: SessionID) =>
  Effect.gen(function* () {
    const parent = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, parentID)).get().pipe(Effect.orDie)
    if (!parent || parent.parent_id || parent.internal || parent.revert || parent.time_archived !== null) return false
    const closed = yield* tx
      .select({ id: ReviewSessionFenceTable.session_id })
      .from(ReviewSessionFenceTable)
      .where(inArray(ReviewSessionFenceTable.session_id, runID ? [parentID, runID] : [parentID]))
      .get()
      .pipe(Effect.orDie)
    if (closed) return false
    if (!runID) return true
    const run = yield* tx
      .select({ parentID: SessionTable.parent_id, marker: SessionTable.internal })
      .from(SessionTable)
      .where(eq(SessionTable.id, runID))
      .get()
      .pipe(Effect.orDie)
    return run?.parentID === parentID && run.marker === `${PINNED_SESSION_PREFIX}run`
  })

// Bun's SQLite adapter can throw during statement preparation before its typed
// query error exists. Use this only around bounded database reads, never an
// owner/source callback or request validation, and retain cancellation.
const metadataRead = <A, E, R>(query: Effect.Effect<A, E, R>, message: string) =>
  query.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(new Refused({ code: "unavailable", message })),
    ),
  )

export function make(db: Database.Interface["db"]): Interface {
  const closingSnapshot: Interface["closingSnapshot"] = (sessionID, ownerNonce) => {
    if (!Schema.is(SessionID)(sessionID) || !/^[0-9a-f-]{36}$/i.test(ownerNonce))
      return Effect.fail(new Refused({ code: "invalid", message: "Invalid review deletion identity." }))
    return metadataRead(
      db
        .select({ repository: SessionTable.project_id, directory: SessionTable.directory })
        .from(SessionTable)
        .innerJoin(ReviewSessionFenceTable, eq(ReviewSessionFenceTable.session_id, SessionTable.id))
        .where(and(eq(SessionTable.id, sessionID), eq(ReviewSessionFenceTable.owner_nonce, ownerNonce)))
        .get(),
      "The review deletion source is unavailable.",
    )
  }
  const sourceSnapshot: Interface["sourceSnapshot"] = (parentID, runID) => {
    if (!Schema.is(SessionID)(parentID) || !Schema.is(SessionID)(runID) || parentID === runID)
      return Effect.fail(new Refused({ code: "invalid", message: "Invalid review source identity." }))
    // The caller must hold ReviewLifecycle.within(parent, run) for its entire
    // source callback. This read observes a deletion which released that lock
    // after durably closing, without starting or resuming any work.
    return metadataRead(
      db.transaction((tx) =>
        Effect.gen(function* () {
          if (!(yield* open(tx, parentID, runID))) return undefined
          const rows = yield* tx
            .select({
              id: ReviewRequestTable.request_id,
              request: ReviewRequestTable.request,
              phase: ReviewRequestTable.phase,
            })
            .from(ReviewRequestTable)
            .where(and(eq(ReviewRequestTable.parent_session_id, parentID), eq(ReviewRequestTable.run_id, runID)))
            .limit(2)
            .all()
          if (rows.length !== 1) return undefined
          return rows[0]!
        }),
      ),
      "The retained review source is unavailable.",
    ).pipe(
      Effect.flatMap((row) => {
        if (!row) return Effect.succeed(undefined)
        const request = Schema.decodeUnknownOption(ReviewRun.Start, { onExcessProperty: "error" })(row.request)
        if (Option.isNone(request) || request.value.requestID !== row.id)
          return Effect.fail(new Refused({ code: "corrupt", message: "The retained review source is invalid." }))
        if (row.phase !== "running" && row.phase !== "settled") return Effect.succeed(undefined)
        return Effect.succeed({ request: request.value, phase: row.phase })
      }),
    )
  }
  const reserve: Interface["reserve"] = Effect.fn("ReviewRequestStore.reserve")(function* (input) {
    const decoded = Schema.decodeUnknownOption(ReviewRun.Start)(input.request)
    if (
      Option.isNone(decoded) ||
      !/^[0-9a-f-]{36}$/i.test(input.ownerNonce) ||
      Option.isNone(Schema.decodeUnknownOption(ownerSchema)(input.owner))
    )
      return yield* new Refused({ code: "invalid", message: "Invalid local review reservation." })
    const request = decoded.value
    // BEGIN IMMEDIATE serializes the first read across SQLite connections and
    // processes. The composite key remains the final atomic admission arbiter.
    return yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            if (!(yield* open(tx, input.parentID)))
              return yield* new Refused({
                code: "unavailable",
                message: "The review conversation is closing or unavailable.",
              })
            const previous = yield* tx
              .select()
              .from(ReviewRequestTable)
              .where(key(input.parentID, request.requestID))
              .get()
              .pipe(Effect.orDie)
            if (!previous) {
              const total = yield* tx
                .select({ count: sql<number>`count(*)` })
                .from(ReviewRequestTable)
                .where(eq(ReviewRequestTable.parent_session_id, input.parentID))
                .get()
                .pipe(Effect.orDie)
              if ((total?.count ?? 0) >= 1000)
                return yield* new Refused({
                  code: "unavailable",
                  message: "This conversation has too many local review requests.",
                })
            }
            const inserted = previous
              ? undefined
              : yield* tx
                  .insert(ReviewRequestTable)
                  .values({
                    parent_session_id: input.parentID,
                    request_id: request.requestID,
                    owner_nonce: input.ownerNonce,
                    owner: input.owner,
                    phase: "reserved",
                    request,
                    time_created: Date.now(),
                  })
                  .onConflictDoNothing()
                  .returning()
                  .get()
                  .pipe(Effect.orDie)
            const saved =
              previous ??
              inserted ??
              (yield* tx
                .select()
                .from(ReviewRequestTable)
                .where(key(input.parentID, request.requestID))
                .get()
                .pipe(Effect.orDie))
            const stored = saved ? Schema.decodeUnknownOption(ReviewRun.Start)(saved.request) : Option.none()
            if (
              !saved ||
              Option.isNone(stored) ||
              saved.request_id !== stored.value.requestID ||
              Option.isNone(Schema.decodeUnknownOption(phaseSchema)(saved.phase)) ||
              (saved.phase !== "settled" && Option.isNone(Schema.decodeUnknownOption(ownerSchema)(saved.owner)))
            )
              return yield* new Refused({ code: "corrupt", message: "The saved local review reservation is invalid." })
            if (canonical(stored.value) !== canonical(request))
              return yield* new Refused({
                code: "conflict",
                message: "That retry key belongs to a different review request.",
              })
            return {
              claimed: inserted !== undefined,
              row: {
                parentID: input.parentID,
                request: stored.value,
                ownerNonce: saved.owner_nonce,
                ...(saved.owner ? { owner: saved.owner } : {}),
                phase: saved.phase,
                ...(saved.run_id ? { runID: saved.run_id } : {}),
              },
            }
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.catchTag("SqlError", Effect.die))
  })
  const attach: Interface["attach"] = Effect.fn("ReviewRequestStore.attach")(function* (input) {
    return yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            if (!(yield* open(tx, input.parentID, input.runID))) return false
            const result = yield* tx
              .update(ReviewRequestTable)
              .set({ run_id: input.runID, phase: "attached" })
              .where(
                and(
                  key(input.parentID, input.requestID),
                  eq(ReviewRequestTable.owner_nonce, input.ownerNonce),
                  isNull(ReviewRequestTable.run_id),
                  eq(ReviewRequestTable.phase, "reserved"),
                ),
              )
              .returning({ runID: ReviewRequestTable.run_id })
              .get()
              .pipe(Effect.orDie)
            return result?.runID === input.runID
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)
  })
  const ready: Interface["ready"] = Effect.fn("ReviewRequestStore.ready")(function* (input) {
    return yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            if (!(yield* open(tx, input.parentID, input.runID))) return false
            return (
              (yield* tx
                .select({ nonce: ReviewRequestTable.owner_nonce })
                .from(ReviewRequestTable)
                .where(
                  and(
                    key(input.parentID, input.requestID),
                    eq(ReviewRequestTable.owner_nonce, input.ownerNonce),
                    eq(ReviewRequestTable.run_id, input.runID),
                    eq(ReviewRequestTable.phase, "attached"),
                  ),
                )
                .get()
                .pipe(Effect.orDie)) !== undefined
            )
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)
  })
  const begin: Interface["begin"] = Effect.fn("ReviewRequestStore.begin")(function* (input) {
    return yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            if (!(yield* open(tx, input.parentID, input.runID))) return false
            return (
              (yield* tx
                .update(ReviewRequestTable)
                .set({ phase: "running" })
                .where(
                  and(
                    key(input.parentID, input.requestID),
                    eq(ReviewRequestTable.owner_nonce, input.ownerNonce),
                    eq(ReviewRequestTable.run_id, input.runID),
                    eq(ReviewRequestTable.phase, "attached"),
                  ),
                )
                .returning({ id: ReviewRequestTable.run_id })
                .get()
                .pipe(Effect.orDie)) !== undefined
            )
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)
  })
  const finish: Interface["finish"] = (input) =>
    db
      .update(ReviewRequestTable)
      .set({ phase: "settled" })
      .where(and(key(input.parentID, input.requestID), eq(ReviewRequestTable.owner_nonce, input.ownerNonce)))
      .run()
      .pipe(Effect.orDie, Effect.asVoid)
  const beginDelete: Interface["beginDelete"] = Effect.fn("ReviewRequestStore.beginDelete")(function* (input) {
    return yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const ancestors: SessionID[] = []
            let current: SessionID | null = input.sessionID
            while (current) {
              if (ancestors.length >= 200 || ancestors.includes(current))
                return yield* new Refused({
                  code: "busy",
                  message: "The conversation's review lineage is unavailable.",
                })
              ancestors.push(current)
              const row: { parent: (typeof SessionTable.$inferSelect)["parent_id"] } | undefined = yield* tx
                .select({ parent: SessionTable.parent_id })
                .from(SessionTable)
                .where(eq(SessionTable.id, current))
                .get()
                .pipe(Effect.orDie)
              if (!row && current === input.sessionID)
                return yield* new Refused({ code: "busy", message: "The conversation is unavailable." })
              current = row?.parent ?? null
            }
            const rows = yield* tx
              .select()
              .from(ReviewRequestTable)
              .where(
                or(
                  eq(ReviewRequestTable.parent_session_id, input.sessionID),
                  inArray(ReviewRequestTable.run_id, ancestors),
                ),
              )
              .all()
              .pipe(Effect.orDie)
            const active = rows.filter((row) => row.phase !== "settled")
            if (input.insideReview && active.length)
              return yield* new Refused({
                code: "busy",
                message: "An active review cannot delete a review conversation from its own finalizer.",
              })
            for (const row of active) {
              if (!row.owner || Option.isNone(Schema.decodeUnknownOption(ownerSchema)(row.owner)))
                return yield* new Refused({ code: "busy", message: "The review's execution owner is unknown." })
              if (!input.localNonces.has(row.owner_nonce) && BackgroundJobStore.alive(row.owner) !== "dead")
                return yield* new Refused({
                  code: "busy",
                  message: "Stop this review on its owning engine before deleting the conversation.",
                })
            }
            const previous = yield* tx
              .select()
              .from(ReviewSessionFenceTable)
              .where(eq(ReviewSessionFenceTable.session_id, input.sessionID))
              .get()
              .pipe(Effect.orDie)
            if (
              previous &&
              (Option.isNone(Schema.decodeUnknownOption(ownerSchema)(previous.owner)) ||
                BackgroundJobStore.alive(previous.owner) !== "dead")
            )
              return yield* new Refused({ code: "busy", message: "The conversation is already closing." })
            if (previous)
              yield* tx
                .delete(ReviewSessionFenceTable)
                .where(eq(ReviewSessionFenceTable.session_id, input.sessionID))
                .run()
                .pipe(Effect.orDie)
            yield* tx
              .insert(ReviewSessionFenceTable)
              .values({
                session_id: input.sessionID,
                owner_nonce: input.ownerNonce,
                owner: input.owner,
                time_created: Date.now(),
              })
              .run()
              .pipe(Effect.orDie)
            return active.filter((row) => input.localNonces.has(row.owner_nonce)).map((row) => row.owner_nonce)
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.catchTag("SqlError", Effect.die))
  })
  const endDelete: Interface["endDelete"] = (sessionID, ownerNonce) =>
    db
      .delete(ReviewSessionFenceTable)
      .where(
        and(eq(ReviewSessionFenceTable.session_id, sessionID), eq(ReviewSessionFenceTable.owner_nonce, ownerNonce)),
      )
      .run()
      .pipe(Effect.orDie, Effect.asVoid)
  return { reserve, attach, ready, begin, finish, beginDelete, endDelete, sourceSnapshot, closingSnapshot }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of(make((yield* Database.Service).db))
  }),
)
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
export * as ReviewRequestStore from "./request-store"
