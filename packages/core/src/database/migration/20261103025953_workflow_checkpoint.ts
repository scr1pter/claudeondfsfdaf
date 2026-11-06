import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261103025953_workflow_checkpoint",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workflow_checkpoint\` (
          \`session_id\` text PRIMARY KEY,
          \`attempt\` integer NOT NULL,
          \`digest\` text NOT NULL,
          \`data\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_workflow_checkpoint_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
