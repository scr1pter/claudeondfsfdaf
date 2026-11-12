export * as SessionAccountingOutput from "./accounting-output"

import { Effect } from "effect"
import { eq } from "drizzle-orm"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { SessionV1 } from "../v1/session"
import { SessionTable } from "./sql"

/** Serialized events carry no accounting authority. Public snapshots take proof from the committed local row. */
export const project = Effect.fn("SessionAccountingOutput.project")(function* <E extends EventV2.Payload>(
  db: Database.Interface["db"],
  event: E,
) {
  if (event.type !== SessionV1.Event.Created.type && event.type !== SessionV1.Event.Updated.type) return event
  const data = event.data as EventV2.Data<typeof SessionV1.Event.Created>
  const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, data.sessionID)).get().pipe(Effect.orDie)
  return {
    ...event,
    data: {
      ...data,
      info: {
        ...data.info,
        ...(row
          ? {
              cost: row.cost,
              unpricedSteps: row.unpriced_steps,
              codiumSteps: row.codium_steps,
              subagentCost: row.subagent_cost,
              subagentUnpricedSteps: row.subagent_unpriced_steps,
              subagentCodiumSteps: row.subagent_codium_steps,
              tokens: {
                input: row.tokens_input,
                output: row.tokens_output,
                reasoning: row.tokens_reasoning,
                cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
              },
              subagentTokens: {
                input: row.subagent_tokens_input,
                output: row.subagent_tokens_output,
                reasoning: row.subagent_tokens_reasoning,
                cache: { read: row.subagent_tokens_cache_read, write: row.subagent_tokens_cache_write },
              },
            }
          : {}),
        tokensOwnOnly: row?.tokens_own_only === true,
        subagentTokensOwnOnly: row?.subagent_tokens_own_only === true,
      },
    },
  } as E
})

/** A remote UI snapshot is serialized input; only its replayed local row can carry local proof. */
export function untrusted<E extends { type?: string; properties?: unknown }>(event: E): E {
  if (event.type !== SessionV1.Event.Created.type && event.type !== SessionV1.Event.Updated.type) return event
  if (!event.properties || typeof event.properties !== "object" || !("info" in event.properties)) return event
  const info = event.properties.info
  if (!info || typeof info !== "object") return event
  return {
    ...event,
    properties: { ...event.properties, info: { ...info, tokensOwnOnly: false, subagentTokensOwnOnly: false } },
  }
}
