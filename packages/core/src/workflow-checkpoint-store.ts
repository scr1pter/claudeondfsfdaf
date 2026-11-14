export * as WorkflowCheckpointStore from "./workflow-checkpoint-store"

import { createHash } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { WorkflowCheckpointTable } from "./workflow-checkpoint.sql"

export type Row = {
  readonly sessionID: string
  readonly attempt: number
  readonly digest: string
  readonly data: string
}

export interface Interface {
  /** The run's latest checkpoint text, or undefined before its first save. */
  readonly read: (sessionID: string) => Effect.Effect<Row | undefined>
  /**
   * Saves the checkpoint text for `attempt`. Returns false when a newer attempt already owns the row. Rewriting the
   * same text is a no-op that still reports success.
   */
  readonly write: (input: { sessionID: string; attempt: number; data: string }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@vector/WorkflowCheckpointStore") {}

export function digest(data: string) {
  return createHash("sha256").update(data).digest("hex")
}

export function make(db: Database.Interface["db"]): Interface {
  const read = Effect.fn("WorkflowCheckpointStore.read")(function* (sessionID: string) {
    const row = yield* db
      .select()
      .from(WorkflowCheckpointTable)
      .where(eq(WorkflowCheckpointTable.session_id, sessionID as never))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    return { sessionID: row.session_id, attempt: row.attempt, digest: row.digest, data: row.data } satisfies Row
  })

  const write = Effect.fn("WorkflowCheckpointStore.write")(function* (input: {
    sessionID: string
    attempt: number
    data: string
  }) {
    const hash = digest(input.data)
    const now = Date.now()
    // One statement: an older attempt cannot replace a newer attempt's row, and an unchanged digest is not rewritten.
    yield* db
      .insert(WorkflowCheckpointTable)
      .values({
        session_id: input.sessionID as never,
        attempt: input.attempt,
        digest: hash,
        data: input.data,
        time_created: now,
        time_updated: now,
      })
      .onConflictDoUpdate({
        target: WorkflowCheckpointTable.session_id,
        set: { attempt: input.attempt, digest: hash, data: input.data, time_updated: now },
        setWhere: sql`${WorkflowCheckpointTable.attempt} < ${input.attempt} or (${WorkflowCheckpointTable.attempt} = ${input.attempt} and ${WorkflowCheckpointTable.digest} <> ${hash})`,
      })
      .run()
      .pipe(Effect.orDie)
    // Confirm ownership from the small columns only; the checkpoint text itself is not read back.
    const stored = yield* db
      .select({ attempt: WorkflowCheckpointTable.attempt, digest: WorkflowCheckpointTable.digest })
      .from(WorkflowCheckpointTable)
      .where(eq(WorkflowCheckpointTable.session_id, input.sessionID as never))
      .get()
      .pipe(Effect.orDie)
    return stored !== undefined && stored.attempt === input.attempt && stored.digest === hash
  })

  return { read, write }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of(make((yield* Database.Service).db))
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
