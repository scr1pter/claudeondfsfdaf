export * as ReviewMemoryFence from "./memory-fence"

import { inArray, sql } from "drizzle-orm"
import { Cause, Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { SessionAudienceTable, SessionLineageTable } from "../session/audience.sql"
import { SessionSchema } from "../session/schema"
import { ReviewMemoryFenceTable } from "./memory-fence.sql"

export const LIMIT = Object.freeze({ nodes: 256, edges: 512, depth: 64, identifier: 256 })

export class Refused extends Schema.TaggedErrorClass<Refused>()("ReviewMemoryFence.Refused", {
  message: Schema.String,
}) {}

export interface Interface {
  /** Commit before any memory-bearing history is persisted; this never authorizes execution. */
  readonly mark: (sessionID: SessionSchema.ID) => Effect.Effect<void, Refused>
  /** False only for a complete, known, bounded, valid upward history graph without a fence. */
  readonly requiresLease: (sessionID: SessionSchema.ID) => Effect.Effect<boolean, Refused>
}

type Transaction = Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]
const refused = () => new Refused({ message: "The review memory history boundary is unavailable." })
const identifier = (value: unknown): value is SessionSchema.ID =>
  typeof value === "string" &&
  value.length <= LIMIT.identifier &&
  /^[A-Za-z0-9_-]+$/.test(value) &&
  Schema.is(SessionSchema.ID)(value)

/** No service defaults or metadata grants: the caller supplies its actual private SQLite database. */
export function make(db: Database.Interface["db"]): Interface {
  return Object.freeze({
    mark: (sessionID: SessionSchema.ID) =>
      protect(
        db.transaction((tx) =>
          Effect.gen(function* () {
            yield* history(tx, sessionID)
            // A retained audience/lineage tombstone may restrict a query, but it
            // cannot be mistaken for a fresh live session that will store data.
            const live = yield* tx.all<{ id: unknown }>(sql`SELECT id FROM session WHERE id = ${sessionID} LIMIT 2`)
            if (live.length !== 1 || live[0]?.id !== sessionID) return yield* refused()
            yield* tx
              .insert(ReviewMemoryFenceTable)
              .values({ session_id: sessionID, version: 1 })
              .onConflictDoNothing()
              .run()
            const rows = yield* tx.all<{ session_id: unknown; version: unknown }>(
              sql`SELECT session_id, version FROM review_memory_fence WHERE session_id = ${sessionID} LIMIT 2`,
            )
            const saved = rows[0]
            if (rows.length !== 1 || !saved || saved.session_id !== sessionID || saved.version !== 1)
              return yield* refused()
          }),
        ),
      ),
    requiresLease: (sessionID: SessionSchema.ID) => protect(db.transaction((tx) => history(tx, sessionID))),
  })
}

/** Read only inside the caller's actual transaction, sharing its serialization snapshot. */
export function read(tx: Transaction, sessionID: SessionSchema.ID): Effect.Effect<boolean, Refused> {
  return protect(history(tx, sessionID))
}

function protect<A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, Refused> {
  return effect.pipe(
    Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(refused()))),
  )
}

function history(tx: Transaction, sessionID: SessionSchema.ID) {
  return Effect.gen(function* () {
    if (!identifier(sessionID)) return yield* refused()
    const nodes = new Set<SessionSchema.ID>([sessionID])
    const parents = new Map<SessionSchema.ID, Set<SessionSchema.ID>>()
    const fences = new Set<SessionSchema.ID>()
    let frontier = [sessionID]
    let edges = 0
    for (let depth = 0; frontier.length; depth++) {
      if (depth >= LIMIT.depth) return yield* refused()
      const selected = new Set(frontier)
      const known = yield* tx.all<{ session_id: unknown }>(
        sql`SELECT session_id FROM session_audience WHERE ${inArray(SessionAudienceTable.session_id, frontier)} LIMIT ${frontier.length + 1}`,
      )
      const registered = new Set<SessionSchema.ID>()
      for (const row of known) {
        if (!identifier(row.session_id) || !selected.has(row.session_id) || registered.has(row.session_id))
          return yield* refused()
        registered.add(row.session_id)
      }
      if (registered.size !== frontier.length) return yield* refused()

      const marked = yield* tx.all<{ session_id: unknown; version: unknown }>(
        sql`SELECT session_id, version FROM review_memory_fence WHERE ${inArray(ReviewMemoryFenceTable.session_id, frontier)} LIMIT ${frontier.length + 1}`,
      )
      for (const row of marked) {
        if (
          !identifier(row.session_id) ||
          !selected.has(row.session_id) ||
          fences.has(row.session_id) ||
          row.version !== 1
        )
          return yield* refused()
        fences.add(row.session_id)
      }

      // Raw rows preserve invalid integer flags instead of Drizzle's boolean
      // decoder turning a corrupt value such as 2 into a plausible true.
      const lineage = yield* tx.all<{ session_id: unknown; parent_id: unknown; fork: unknown }>(
        sql`SELECT session_id, parent_id, fork FROM session_lineage WHERE ${inArray(SessionLineageTable.session_id, frontier)} LIMIT ${LIMIT.edges - edges + 1}`,
      )
      if (lineage.length > LIMIT.edges - edges) return yield* refused()
      const next: SessionSchema.ID[] = []
      for (const row of lineage) {
        if (
          !identifier(row.session_id) ||
          !selected.has(row.session_id) ||
          !identifier(row.parent_id) ||
          (row.fork !== 0 && row.fork !== 1)
        )
          return yield* refused()
        const values = parents.get(row.session_id) ?? new Set<SessionSchema.ID>()
        if (values.has(row.parent_id)) return yield* refused()
        values.add(row.parent_id)
        parents.set(row.session_id, values)
        edges++
        if (nodes.has(row.parent_id)) continue
        if (nodes.size >= LIMIT.nodes) return yield* refused()
        nodes.add(row.parent_id)
        next.push(row.parent_id)
      }
      frontier = next
    }

    // Count the whole DAG rather than treating a shared ancestor in a diamond
    // as a cycle. Even a directly fenced node must not hide malformed lineage.
    const incoming = new Map<SessionSchema.ID, number>()
    for (const node of nodes) incoming.set(node, 0)
    for (const values of parents.values())
      for (const parent of values) incoming.set(parent, (incoming.get(parent) ?? 0) + 1)
    const ready = [...nodes].filter((node) => incoming.get(node) === 0)
    const distances = new Map<SessionSchema.ID, number>()
    let visited = 0
    for (const node of ready) {
      visited++
      for (const parent of parents.get(node) ?? []) {
        const distance = (distances.get(node) ?? 0) + 1
        if (distance >= LIMIT.depth) return yield* refused()
        distances.set(parent, Math.max(distances.get(parent) ?? 0, distance))
        const remaining = (incoming.get(parent) ?? 0) - 1
        if (remaining < 0) return yield* refused()
        incoming.set(parent, remaining)
        if (remaining === 0) ready.push(parent)
      }
    }
    if (visited !== nodes.size) return yield* refused()
    return fences.size > 0
  })
}
