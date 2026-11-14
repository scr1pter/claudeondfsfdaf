import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261113015459_review-memory-fence",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`review_memory_fence\` (
          \`session_id\` text PRIMARY KEY,
          \`version\` integer DEFAULT 1 NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
