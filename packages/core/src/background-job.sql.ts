import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import * as DatabasePath from "./database/path"
import { Timestamps } from "./database/schema.sql"
import { SessionTable } from "./session/sql"
import type { BackgroundJob } from "./background-job"

// One row per durable background job (a subagent run, a background command), so a restart can tell its parent which
// work it interrupted. Written by BackgroundJobStore; builds before 1.99.113 never read it.
export const BackgroundJobTable = sqliteTable(
  "background_job",
  {
    id: text().primaryKey(),
    // task, shell, …
    type: text().notNull(),
    title: text(),
    parent_session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    session_id: text(),
    directory: DatabasePath.directoryColumn().notNull(),
    status: text().$type<BackgroundJob.Status>().notNull(),
    background: integer({ mode: "boolean" }).notNull().default(false),
    attempt: integer(),
    // The instance lease that ran it (`${process}:${instance}`), its process, that process's boot and machine.
    owner_runtime: text().notNull(),
    owner_pid: integer().notNull(),
    owner_boot: integer().notNull(),
    owner_machine: text().notNull(),
    error: text(),
    started_at: integer().notNull(),
    completed_at: integer(),
    // When a restart reported it to its parent. Set once, by whichever engine claims the row first.
    reported_at: integer(),
    // At most 4 KiB, never a brief or command output.
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    ...Timestamps,
  },
  (table) => [
    index("background_job_status_directory_idx").on(table.status, table.directory),
    index("background_job_parent_idx").on(table.parent_session_id),
  ],
)
