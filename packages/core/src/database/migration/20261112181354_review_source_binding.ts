import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261112181354_review_source_binding",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`review_request\` ADD \`source_binding\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
