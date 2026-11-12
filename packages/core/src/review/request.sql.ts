import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { ReviewRun } from "@vectordevai/schema/review-run"
import { SessionTable } from "../session/sql"
import type { SessionSchema } from "../session/schema"
import type { BackgroundJobStore } from "../background-job-store"

export type Phase = "reserved" | "attached" | "running" | "settled"

// An immutable retry reservation, independent of a process's live job registry.
// Only its first INSERT may authorize creation of a fresh hidden run. A crash
// before its one-time run attachment leaves a tombstone, never a paid retry
// license. A hidden session created before attachment remains unpaid.
export const ReviewRequestTable = sqliteTable(
  "review_request",
  {
    parent_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    request_id: text().notNull(),
    owner_nonce: text().notNull(),
    owner: text({ mode: "json" }).$type<BackgroundJobStore.Owner>(),
    // Existing reservations never acquire new execution authority on upgrade.
    phase: text().$type<Phase>().notNull().default("settled"),
    run_id: text().$type<SessionSchema.ID>(),
    request: text({ mode: "json" }).$type<ReviewRun.Start>().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.parent_session_id, table.request_id] }),
    uniqueIndex("review_request_run_id_unique").on(table.run_id),
  ],
)

// Closing survives releasing the short filesystem lock while cancellation and
// finalizers drain. A deleted session erases only its own fence by foreign key.
export const ReviewSessionFenceTable = sqliteTable("review_session_fence", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  owner_nonce: text().notNull(),
  owner: text({ mode: "json" }).$type<BackgroundJobStore.Owner>().notNull(),
  time_created: integer().notNull(),
})
