import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261112120658_review_deletion_fence",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`review_session_fence\` (
          \`session_id\` text PRIMARY KEY,
          \`owner_nonce\` text NOT NULL,
          \`owner\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_review_session_fence_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`review_request\` ADD \`owner\` text;`)
      yield* tx.run(`ALTER TABLE \`review_request\` ADD \`phase\` text DEFAULT 'settled' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
