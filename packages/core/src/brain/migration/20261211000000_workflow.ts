import { Effect } from "effect"
import type { DatabaseMigration } from "../../database/migration"

// Workflow insights: one row per request of the build agent, numbers only (size, effort, subagents, model, outcome,
// steps, tokens and cost), and the personal state row's workflow settings. Written by hand like the brain's other
// migrations.
export default {
  id: "20261211000000_workflow",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`brain_workflow_run\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`repository_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`at\` integer NOT NULL,
          \`tier\` text NOT NULL,
          \`effort_tier\` text NOT NULL,
          \`agent\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`effort\` text NOT NULL,
          \`effort_source\` text NOT NULL,
          \`subagents\` integer NOT NULL,
          \`subagent_model\` text,
          \`subagent_models\` text NOT NULL,
          \`judge_rounds\` integer NOT NULL,
          \`outcome\` text NOT NULL,
          \`signal\` text,
          \`cost_usd\` real,
          \`cost_kinds\` text NOT NULL,
          \`steps\` integer NOT NULL,
          \`unpriced_steps\` integer NOT NULL,
          \`tokens_input\` integer NOT NULL,
          \`tokens_output\` integer NOT NULL,
          \`tokens_reasoning\` integer NOT NULL,
          \`tokens_cache_read\` integer NOT NULL,
          \`partial\` integer DEFAULT 0 NOT NULL,
          \`runs\` integer DEFAULT 1 NOT NULL,
          \`stop\` text,
          \`taint\` text,
          \`advice\` text
        );
      `)
      yield* tx.run(
        "CREATE UNIQUE INDEX `brain_workflow_run_request_idx` ON `brain_workflow_run` (`repository_id`, `request_id`);",
      )
      yield* tx.run(
        "CREATE INDEX `brain_workflow_run_tier_idx` ON `brain_workflow_run` (`repository_id`, `effort_tier`, `at`);",
      )
      yield* tx.run("CREATE INDEX `brain_workflow_run_session_idx` ON `brain_workflow_run` (`session_id`);")
      yield* tx.run("ALTER TABLE `brain_state` ADD `workflow_learning` text;")
      yield* tx.run("ALTER TABLE `brain_state` ADD `workflow_explore` integer;")
    })
  },
} satisfies DatabaseMigration.Migration
