import { Effect } from "effect"
import type { DatabaseMigration } from "../../database/migration"

// Keep existing ProjectIDs and erase epochs. Unbound legacy content remains NULL and cannot authorize a clone.
export default {
  id: "20261214000000_review_memory_scope",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE brain_review_memory ADD COLUMN scope_id text")
      yield* tx.run(
        "CREATE INDEX brain_review_memory_scope_idx ON brain_review_memory (repository_id, scope_id, status)",
      )
      yield* tx.run(`CREATE TABLE brain_review_memory_scope_state (
        repository_id text NOT NULL,
        scope_id text NOT NULL,
        enabled integer DEFAULT 0 NOT NULL,
        generation integer DEFAULT 0 NOT NULL,
        PRIMARY KEY (repository_id, scope_id)
      )`)
    })
  },
} satisfies DatabaseMigration.Migration
