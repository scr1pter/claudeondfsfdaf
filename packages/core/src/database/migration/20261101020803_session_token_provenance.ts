import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261101020803_session_token_provenance",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`tokens_own_only\` integer DEFAULT false NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`subagent_tokens_own_only\` integer DEFAULT false NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
