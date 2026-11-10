import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261031070337_session_codium_steps",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`codium_steps\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`subagent_codium_steps\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
