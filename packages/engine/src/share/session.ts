import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Effect, Layer, Context } from "effect"
import { ShareNext } from "./share-next"
import { PublicSession } from "@vectordevai/schema/public-session"
import { PublicSessionShare } from "@vectordevai/core/public-session-share"
import type { SessionAudience } from "@vectordevai/core/session/audience"
import { Config } from "@/config/config"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { LocalSources } from "@vectordevai/core/local-mode/sources"

const SHARE_SOURCE = LocalSources.get("share")!

export interface Interface {
  readonly create: (input?: Session.CreateInput, actor?: SessionAudience.Actor) => Effect.Effect<Session.Info>
  readonly share: (
    sessionID: SessionID,
    publish: PublicSession.Publish,
  ) => Effect.Effect<PublicSession.Info, PublicSession.Error>
  readonly unshare: (sessionID: SessionID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@vector/SessionShare") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const shareNext = yield* ShareNext.Service
    const publicSharing = yield* PublicSessionShare.Service
    const config = yield* Config.Service

    const share = Effect.fn("SessionShare.share")(function* (sessionID: SessionID, publish: PublicSession.Publish) {
      const result = yield* shareNext.create(sessionID, publish)
      return result
    })

    const unshare = Effect.fn("SessionShare.unshare")(function* (sessionID: SessionID) {
      yield* shareNext.remove(sessionID)
    })

    const create = Effect.fn("SessionShare.create")(function* (
      input?: Session.CreateInput,
      actor?: SessionAudience.Actor,
    ) {
      const result = yield* session.create(input, actor)
      const cfg = yield* config.get()
      // A helper session is Vector's own work, never something to publish on the user's behalf. Vector Local blocks
      // share links unless the user allowed them, so nothing is shared automatically then.
      if (
        !result.internal &&
        cfg.share !== "disabled" &&
        !LocalPolicy.blocks(Egress.policy(), SHARE_SOURCE) &&
        (cfg.share === "auto" || cfg.autoshare || ["1", "true"].includes(process.env.VECTOR_AUTO_SHARE ?? ""))
      )
        yield* publicSharing
          .auto({ sessionID: result.id })
          .pipe(Effect.catch((error) => Effect.logWarning("Automatic session sharing deferred", { code: error.code })))
      return yield* session.get(result.id).pipe(Effect.orDie)
    })

    return Service.of({ create, share, unshare })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Session.node, ShareNext.node, PublicSessionShare.node, Config.node],
})

export * as SessionShare from "./session"
