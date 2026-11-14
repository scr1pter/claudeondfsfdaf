import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261112110316_review_request",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`review_request\` (
          \`parent_session_id\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`owner_nonce\` text NOT NULL,
          \`run_id\` text,
          \`request\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`review_request_pk\` PRIMARY KEY(\`parent_session_id\`, \`request_id\`),
          CONSTRAINT \`fk_review_request_parent_session_id_session_id_fk\` FOREIGN KEY (\`parent_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`review_request_run_id_unique\` ON \`review_request\` (\`run_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
