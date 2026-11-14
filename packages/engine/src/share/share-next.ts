import { Database } from "@vectordevai/core/database/database"
import { publicShareWarning, PublicShareRemovalError } from "@vectordevai/schema/public-share"
import { sql } from "drizzle-orm"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import { Effect, Layer, Context } from "effect"
import type { SessionID } from "@/session/schema"
import { PublicSessionShare } from "@vectordevai/core/public-session-share"
import { PublicSession } from "@vectordevai/schema/public-session"
import { PublicSessionShareTable } from "@vectordevai/core/share/public.sql"
import { eq } from "drizzle-orm"

// Re-enabling requires a Vector-owned service and explicit user consent.
export const VECTOR_SESSION_SHARING = true

export function disabledReason(_share?: string) {
  return "Session sharing is disabled in your Vector settings. Set share to manual to enable it."
}

export function enabled(share?: string) {
  return share !== "disabled"
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly create: (
    sessionID: SessionID,
    publish: PublicSession.Publish,
  ) => Effect.Effect<PublicSession.Info, PublicSession.Error>
  readonly publicLinks: (sessionID: SessionID) => Effect.Effect<string[]>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void, PublicShareRemovalError | PublicSession.Error>
  readonly removeTree: (sessionID: SessionID) => Effect.Effect<void, PublicSession.Error>
}

export class Service extends Context.Service<Service, Interface>()("@vector/ShareNext") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const sharing = yield* PublicSessionShare.Service
    const publicLinks = Effect.fn("ShareNext.publicLinks")(function* (sessionID: SessionID) {
      // Include descendants and links whose old Unshare cleared only session.share_url.
      const rows = yield* database.db
        .all<{ url: string }>(
          sql`
      WITH RECURSIVE descendants(id) AS (
        SELECT ${sessionID}
        UNION
        SELECT session.id FROM session JOIN descendants ON session.parent_id = descendants.id
      )
      SELECT share_url AS url FROM session WHERE id IN (SELECT id FROM descendants) AND share_url IS NOT NULL
      UNION
      SELECT url FROM session_share WHERE session_id IN (SELECT id FROM descendants)
    `,
        )
        .pipe(Effect.orDie)
      return rows.map((row) => row.url).filter(Boolean)
    })
    return Service.of({
      init: () => Effect.void,
      create: (sessionID, publish) =>
        sharing.publish({ sessionID, ...publish, includeScreenshots: publish.includeScreenshots === true }),
      removeTree: sharing.removeTree,
      publicLinks,
      remove: Effect.fn("ShareNext.remove")(function* (sessionID) {
        const owned = yield* database.db
          .select()
          .from(PublicSessionShareTable)
          .where(eq(PublicSessionShareTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (owned) return yield* sharing.unshare(sessionID)
        const links = yield* publicLinks(sessionID)
        if (links.length) return yield* publicShareWarning(links)
      }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node, PublicSessionShare.node] })

export * as ShareNext from "./share-next"
