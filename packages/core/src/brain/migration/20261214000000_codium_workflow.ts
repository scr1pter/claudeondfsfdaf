import { Effect } from "effect"
import type { DatabaseMigration } from "../../database/migration"

export default {
  id: "20261214000000_codium_workflow",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE `brain_workflow_run` ADD `codium_units` real;")
    })
  },
} satisfies DatabaseMigration.Migration
