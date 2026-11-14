import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

// These rows deliberately have no session foreign keys: deleting history must not erase its audience boundary.
export const SessionAudienceTable = sqliteTable("session_audience", {
  session_id: text().primaryKey(),
  owner_only: integer({ mode: "boolean" }).notNull().default(false),
  guest_input: integer({ mode: "boolean" }).notNull().default(false),
})

// `parent_id` is the session's parent, or with `fork` the conversation it was forked from: a fork copies its source's
// history, but its source never shows the fork's later messages.
export const SessionLineageTable = sqliteTable(
  "session_lineage",
  {
    session_id: text().notNull(),
    parent_id: text().notNull(),
    fork: integer({ mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.parent_id] }),
    index("session_lineage_parent_idx").on(table.parent_id),
  ],
)

export const SessionPrivateDirectoryTable = sqliteTable(
  "session_private_directory",
  { directory: text().primaryKey(), session_id: text().notNull() },
  (table) => [index("session_private_directory_session_idx").on(table.session_id)],
)
