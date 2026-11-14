import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028021005_background_job",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`background_job\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`title\` text,
          \`parent_session_id\` text NOT NULL,
          \`session_id\` text,
          \`directory\` text NOT NULL,
          \`status\` text NOT NULL,
          \`background\` integer DEFAULT false NOT NULL,
          \`attempt\` integer,
          \`owner_runtime\` text NOT NULL,
          \`owner_pid\` integer NOT NULL,
          \`owner_boot\` integer NOT NULL,
          \`owner_machine\` text NOT NULL,
          \`error\` text,
          \`started_at\` integer NOT NULL,
          \`completed_at\` integer,
          \`reported_at\` integer,
          \`metadata\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_background_job_parent_session_id_session_id_fk\` FOREIGN KEY (\`parent_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`background_job_status_directory_idx\` ON \`background_job\` (\`status\`,\`directory\`);`,
      )
      yield* tx.run(`CREATE INDEX \`background_job_parent_idx\` ON \`background_job\` (\`parent_session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
