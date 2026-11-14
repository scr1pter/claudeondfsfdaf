import { Effect } from "effect"
import type { DatabaseMigration } from "../../database/migration"

// Optional quantitative annotations leave existing free-form notes unchanged.
export default {
  id: "20261212000000_research_claims",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE `research_note` ADD `measurement` text;")
    })
  },
} satisfies DatabaseMigration.Migration
