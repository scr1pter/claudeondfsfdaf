import { Effect } from "effect"
import type { DatabaseMigration } from "../../database/migration"

// Learned skills: a skill is a brain_entry of kind "skill" under the repository id "skill:<repository>", which needs no
// change to the entry table (its kind has no CHECK). These tables hold its procedure, versions, loads and the listing
// each session chose, and the personal state row keeps how skills are learned and drafted. Older builds share brain.db
// and never read any of it. Written by hand like the brain's other migrations.
export default {
  id: "20261210000000_learned_skills",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`brain_skill\` (
          \`entry_id\` text PRIMARY KEY NOT NULL,
          \`repository_id\` text NOT NULL,
          \`skill_key\` text NOT NULL,
          \`name\` text NOT NULL,
          \`description\` text NOT NULL,
          \`procedure\` text NOT NULL,
          \`checks\` text NOT NULL,
          \`commands\` text NOT NULL,
          \`failure\` text,
          \`version\` integer NOT NULL,
          \`drafter\` text NOT NULL,
          \`session_id\` text,
          \`request_id\` text,
          \`approved_by\` text,
          \`approved_at\` integer,
          \`shared_path\` text,
          \`shared_at\` integer,
          \`live\` integer DEFAULT 0 NOT NULL,
          \`loads\` integer DEFAULT 0 NOT NULL,
          \`passes\` integer DEFAULT 0 NOT NULL,
          \`fails\` integer DEFAULT 0 NOT NULL,
          \`reverts\` integer DEFAULT 0 NOT NULL,
          \`ignored\` integer DEFAULT 0 NOT NULL,
          CONSTRAINT \`fk_brain_skill_entry_id_brain_entry_id_fk\` FOREIGN KEY (\`entry_id\`) REFERENCES \`brain_entry\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run("CREATE INDEX `brain_skill_key_idx` ON `brain_skill` (`repository_id`, `skill_key`);")
      yield* tx.run(
        "CREATE UNIQUE INDEX `brain_skill_live_idx` ON `brain_skill` (`repository_id`, `skill_key`) WHERE `live` = 1;",
      )
      yield* tx.run(`
        CREATE TABLE \`brain_skill_version\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`repository_id\` text NOT NULL,
          \`skill_key\` text NOT NULL,
          \`version\` integer NOT NULL,
          \`entry_id\` text NOT NULL,
          \`session_id\` text,
          \`name\` text NOT NULL,
          \`description\` text NOT NULL,
          \`procedure\` text NOT NULL,
          \`checks\` text NOT NULL,
          \`commands\` text NOT NULL,
          \`failure\` text,
          \`actor\` text NOT NULL,
          \`reason\` text NOT NULL,
          \`created_at\` integer NOT NULL
        );
      `)
      yield* tx.run(
        "CREATE UNIQUE INDEX `brain_skill_version_key_idx` ON `brain_skill_version` (`repository_id`, `skill_key`, `version`);",
      )
      yield* tx.run("CREATE INDEX `brain_skill_version_session_idx` ON `brain_skill_version` (`session_id`);")
      yield* tx.run(`
        CREATE TABLE \`brain_skill_use\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`repository_id\` text NOT NULL,
          \`entry_id\` text NOT NULL,
          \`version\` integer NOT NULL,
          \`session_id\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`at\` integer NOT NULL,
          \`outcome\` text
        );
      `)
      yield* tx.run(
        "CREATE UNIQUE INDEX `brain_skill_use_request_idx` ON `brain_skill_use` (`request_id`, `entry_id`);",
      )
      yield* tx.run("CREATE INDEX `brain_skill_use_session_idx` ON `brain_skill_use` (`session_id`);")
      yield* tx.run(`
        CREATE TABLE \`brain_skill_listing\` (
          \`session_id\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`repository_id\` text NOT NULL,
          \`entry_id\` text NOT NULL,
          \`version\` integer NOT NULL,
          \`name\` text NOT NULL,
          \`description\` text NOT NULL,
          \`private\` integer NOT NULL,
          \`created_at\` integer NOT NULL,
          CONSTRAINT \`brain_skill_listing_pk\` PRIMARY KEY(\`session_id\`, \`position\`)
        );
      `)
      yield* tx.run("ALTER TABLE `brain_state` ADD `skill_learning` text;")
      yield* tx.run("ALTER TABLE `brain_state` ADD `skill_drafter` text;")
    })
  },
} satisfies DatabaseMigration.Migration
