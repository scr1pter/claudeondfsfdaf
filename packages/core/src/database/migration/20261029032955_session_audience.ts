import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261029032955_session_audience",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_audience\` (
          \`session_id\` text PRIMARY KEY,
          \`owner_only\` integer DEFAULT false NOT NULL,
          \`guest_input\` integer DEFAULT false NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_lineage\` (
          \`session_id\` text NOT NULL,
          \`parent_id\` text NOT NULL,
          \`fork\` integer DEFAULT false NOT NULL,
          CONSTRAINT \`session_lineage_pk\` PRIMARY KEY(\`session_id\`, \`parent_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_private_directory\` (
          \`directory\` text PRIMARY KEY,
          \`session_id\` text NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_lineage_parent_idx\` ON \`session_lineage\` (\`parent_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_private_directory_session_idx\` ON \`session_private_directory\` (\`session_id\`);`,
      )
      // Preserve trusted historical relationships even when an intermediate session is later deleted.
      yield* tx.run(`INSERT OR IGNORE INTO session_audience(session_id) SELECT id FROM session;`)
      yield* tx.run(`INSERT OR IGNORE INTO session_lineage(session_id, parent_id)
        SELECT id, parent_id FROM session WHERE parent_id IS NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
