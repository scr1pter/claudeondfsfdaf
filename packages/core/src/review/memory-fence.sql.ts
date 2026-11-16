import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SessionSchema } from "../session/schema"

// Restriction-only tombstones: Session deletion, history erasure and lineage
// cleanup may never make surviving copies ordinary model history again.
// No session FK, expiry, content, repository or execution authority is stored.
export const ReviewMemoryFenceTable = sqliteTable("review_memory_fence", {
  session_id: text().$type<SessionSchema.ID>().primaryKey(),
  version: integer().notNull().default(1),
})
