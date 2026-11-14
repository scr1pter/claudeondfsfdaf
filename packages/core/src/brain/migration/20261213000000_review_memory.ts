import { Effect } from "effect"
import type { DatabaseMigration } from "../../database/migration"

// A dedicated, initially empty review namespace. No existing personal/repository entry is promoted or copied.
export default {
  id: "20261213000000_review_memory",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TABLE brain_review_memory (
        id text PRIMARY KEY NOT NULL,
        repository_id text NOT NULL,
        kind text NOT NULL,
        status text NOT NULL,
        visibility text NOT NULL,
        body text NOT NULL,
        paths text NOT NULL,
        citations text NOT NULL,
        reason text NOT NULL,
        parent_session_id text,
        review_session_id text,
        source_head text,
        origin text NOT NULL,
        approved_by text,
        approved_at integer,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )`)
      yield* tx.run("CREATE INDEX brain_review_memory_repository_idx ON brain_review_memory (repository_id, status)")
      yield* tx.run(
        "CREATE INDEX brain_review_memory_parent_idx ON brain_review_memory (repository_id, parent_session_id)",
      )
      yield* tx.run(
        "CREATE INDEX brain_review_memory_session_idx ON brain_review_memory (repository_id, review_session_id)",
      )
      yield* tx.run(`CREATE TABLE brain_review_memory_state (
        repository_id text PRIMARY KEY NOT NULL,
        enabled integer DEFAULT 0 NOT NULL,
        generation integer DEFAULT 0 NOT NULL
      )`)
    })
  },
} satisfies DatabaseMigration.Migration
