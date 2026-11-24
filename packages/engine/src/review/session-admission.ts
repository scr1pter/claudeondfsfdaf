// The V2 session routes consult the active review policy, the server policy, and the session's durable review hold.
import { and, eq, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { SCOPE } from "@vectordevai/core/review/prompt"
import { ReviewSessionAdmission } from "@vectordevai/core/review/session-admission"
import { MessageTable, PartTable, SessionTable } from "@vectordevai/core/session/sql"
import { Config } from "@/config/config"
import { SessionID } from "@/session/schema"
import { ReviewRoutes } from "./route"

export const storedZdr = Effect.fn("ReviewSessionAdmission.storedZdr")(function* (
  database: Database.Interface,
  sessionID: SessionID,
) {
  const durablyMarked = yield* database.db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(
      and(
        eq(SessionTable.id, sessionID),
        sql`json_type(${SessionTable.metadata}, ${ReviewSessionAdmission.ZDR_METADATA_PATH}) = 'true'`,
      ),
    )
    .get()
  if (durablyMarked) return true

  // Older desktop reviews recorded their raise-only policy on the V1 user prompt instead of the session.
  const legacyPrompt = yield* database.db
    .select({ id: PartTable.id })
    .from(PartTable)
    .innerJoin(MessageTable, eq(PartTable.message_id, MessageTable.id))
    .where(
      and(
        eq(PartTable.session_id, sessionID),
        eq(MessageTable.session_id, sessionID),
        sql`json_extract(${MessageTable.data}, '$.role') = 'user'`,
        sql`json_extract(${PartTable.data}, '$.type') = 'text'`,
        sql`json_extract(${PartTable.data}, ${`$.metadata."${SCOPE}".privacy`}) = 'zdr'`,
      ),
    )
    .get()
  return legacyPrompt !== undefined
})

const layer = Layer.effect(
  ReviewSessionAdmission.Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const database = yield* Database.Service
    return ReviewSessionAdmission.Service.of({
      zdr: Effect.fn("ReviewSessionAdmission.zdr")(function* (sessionID) {
        if (ReviewRoutes.zdr(sessionID)) return true
        const global = yield* config.getGlobal()
        if (ReviewRoutes.serverPolicy(global.review).privacy === "zdr") return true
        return yield* storedZdr(database, SessionID.make(sessionID)).pipe(Effect.orElseSucceed(() => true))
      }),
    })
  }),
)

export const node = LayerNode.make({ service: ReviewSessionAdmission.Service, layer, deps: [Config.node, Database.node] })

export * as ReviewSessionAdmissionLive from "./session-admission"
