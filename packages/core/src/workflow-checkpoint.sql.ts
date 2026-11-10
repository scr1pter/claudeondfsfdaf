import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "./database/schema.sql"
import { SessionTable } from "./session/sql"
import type { SessionSchema } from "./session/schema"

// One row per workflow run: its versioned runtime checkpoint (G.6), at most 16 MiB of JSON. It stays out of the run
// Session's metadata, whose every write is a durable `session.updated` event carrying the whole Session, so a large
// checkpoint is neither copied into the event log nor pushed to every client on each save. Deleted with its Session.
export const WorkflowCheckpointTable = sqliteTable("workflow_checkpoint", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  // The run attempt that wrote it. A stale attempt never overwrites a newer attempt's checkpoint.
  attempt: integer().notNull(),
  // SHA-256 of `data`, so an unchanged checkpoint is not rewritten.
  digest: text().notNull(),
  data: text().notNull(),
  ...Timestamps,
})
