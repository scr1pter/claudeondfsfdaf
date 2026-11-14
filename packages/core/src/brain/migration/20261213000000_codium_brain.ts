import { Effect } from "effect"
import type { DatabaseMigration } from "../../database/migration"

// Only the personal state row grants Codium helper consent. Null preserves ask, never an automatic opt-in.
export default {
  id: "20261213000000_codium_brain",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE `brain_state` ADD `codium_helpers` text;")
      yield* tx.run("ALTER TABLE `brain_state` ADD `knowledge_distill` integer;")
    })
  },
} satisfies DatabaseMigration.Migration
