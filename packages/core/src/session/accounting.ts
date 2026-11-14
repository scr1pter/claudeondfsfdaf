export * as SessionAccounting from "./accounting"

import { and, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import type { SessionSchema } from "./schema"
import { SessionTable } from "./sql"

type DB = Database.Interface["db"]

/** Only trusted creation calls this, from Created's local, non-replayed transaction commit callback. */
export function initializeEmpty(db: DB, sessionID: SessionSchema.ID, seq: number) {
  if (seq !== 0) return Effect.void
  // Created's projector must have won a new insertion in this same transaction. The event and sequence rows have
  // not been inserted yet. A generic Created, replay, import or caller-supplied marker never invokes this callback.
  return db
    .update(SessionTable)
    .set({ tokens_own_only: true, subagent_tokens_own_only: true })
    .where(
      and(
        eq(SessionTable.id, sessionID),
        sql`${SessionTable.cost} = 0 AND ${SessionTable.unpriced_steps} = 0 AND ${SessionTable.codium_steps} = 0`,
        sql`${SessionTable.subagent_cost} = 0 AND ${SessionTable.subagent_unpriced_steps} = 0 AND ${SessionTable.subagent_codium_steps} = 0`,
        sql`${SessionTable.tokens_input} = 0 AND ${SessionTable.tokens_output} = 0 AND ${SessionTable.tokens_reasoning} = 0 AND ${SessionTable.tokens_cache_read} = 0 AND ${SessionTable.tokens_cache_write} = 0`,
        sql`${SessionTable.subagent_tokens_input} = 0 AND ${SessionTable.subagent_tokens_output} = 0 AND ${SessionTable.subagent_tokens_reasoning} = 0 AND ${SessionTable.subagent_tokens_cache_read} = 0 AND ${SessionTable.subagent_tokens_cache_write} = 0`,
        sql`NOT EXISTS (SELECT 1 FROM message WHERE session_id = ${sessionID})`,
        sql`NOT EXISTS (SELECT 1 FROM part WHERE session_id = ${sessionID})`,
        sql`NOT EXISTS (SELECT 1 FROM session_message WHERE session_id = ${sessionID})`,
        sql`NOT EXISTS (SELECT 1 FROM session_input WHERE session_id = ${sessionID})`,
        sql`NOT EXISTS (SELECT 1 FROM session child WHERE child.parent_id = ${sessionID})`,
        sql`NOT EXISTS (SELECT 1 FROM event WHERE aggregate_id = ${sessionID})`,
        sql`NOT EXISTS (SELECT 1 FROM event_sequence WHERE aggregate_id = ${sessionID})`,
      ),
    )
    .run()
    .pipe(Effect.orDie, Effect.asVoid)
}

/** Copying or importing history cannot inherit proof from the source, even when that history has no usage. */
export function invalidate(db: DB, sessionID: SessionSchema.ID) {
  return Effect.gen(function* () {
    yield* db
      .update(SessionTable)
      .set({
        tokens_own_only: false,
        subagent_tokens_own_only: false,
        time_updated: sql`${SessionTable.time_updated} + 1`,
      })
      .where(
        and(
          eq(SessionTable.id, sessionID),
          sql`(${SessionTable.tokens_own_only} OR ${SessionTable.subagent_tokens_own_only})`,
        ),
      )
      .run()
      .pipe(Effect.orDie)
    yield* invalidateAncestors(db, sessionID)
  })
}

/** Proof only falls: a safe later contribution or a revert cannot certify an unknown earlier aggregate. */
export function contribute(db: DB, sessionID: SessionSchema.ID, knownOwnOnly: boolean) {
  return Effect.gen(function* () {
    if (!knownOwnOnly)
      yield* db
        .update(SessionTable)
        .set({ tokens_own_only: false, time_updated: sql`${SessionTable.time_updated} + 1` })
        .where(and(eq(SessionTable.id, sessionID), eq(SessionTable.tokens_own_only, true)))
        .run()
        .pipe(Effect.orDie)
    const row = yield* db
      .select({ own: SessionTable.tokens_own_only, delegated: SessionTable.subagent_tokens_own_only })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    // An unknown child invalidates inherited totals even when this particular delta is zero.
    if (!row?.own || !row.delegated) yield* invalidateAncestors(db, sessionID)
  })
}

function invalidateAncestors(db: DB, sessionID: SessionSchema.ID) {
  return db
    .update(SessionTable)
    .set({ subagent_tokens_own_only: false, time_updated: sql`${SessionTable.time_updated} + 1` })
    .where(
      and(
        eq(SessionTable.subagent_tokens_own_only, true),
        sql`${SessionTable.id} IN (WITH RECURSIVE ancestor(id) AS (SELECT parent_id FROM session WHERE id = ${sessionID} UNION SELECT session.parent_id FROM session JOIN ancestor ON session.id = ancestor.id) SELECT id FROM ancestor WHERE id IS NOT NULL AND id != ${sessionID})`,
      ),
    )
    .run()
    .pipe(Effect.orDie, Effect.asVoid)
}
