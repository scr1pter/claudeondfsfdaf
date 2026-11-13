import { Effect } from "effect"
import type { DatabaseMigration } from "../../database/migration"

// Content-free source registrations only; legacy review text is never adopted.
export default {
  id: "20261215000000_review_memory_source",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TABLE brain_review_memory_source (
        repository_id text NOT NULL,
        scope_id text NOT NULL,
        review_session_id text NOT NULL,
        parent_session_id text NOT NULL,
        source_head text NOT NULL,
        parent_marker_id text NOT NULL,
        review_marker_id text NOT NULL,
        state text NOT NULL,
        PRIMARY KEY (repository_id, scope_id, review_session_id)
      )`)
      yield* tx.run(
        "CREATE UNIQUE INDEX brain_review_memory_source_parent_marker_idx ON brain_review_memory_source (parent_marker_id)",
      )
      yield* tx.run(
        "CREATE UNIQUE INDEX brain_review_memory_source_review_marker_idx ON brain_review_memory_source (review_marker_id)",
      )
      yield* tx.run(
        "CREATE INDEX brain_review_memory_source_parent_idx ON brain_review_memory_source (repository_id, parent_session_id)",
      )
      yield* tx.run(
        "CREATE INDEX brain_review_memory_source_review_idx ON brain_review_memory_source (repository_id, review_session_id)",
      )
    })
  },
} satisfies DatabaseMigration.Migration
