// The engine's side of core's ReviewSessionAdmission port: a review session is held to "zdr" when a review registered it
// so (ReviewRoutes.zdr) or when the user config's review privacy, the server's policy, says "zdr" (as the V1 routes'
// holdReview reads it). The server package's V2 session routes then refuse it before anything is stored or sent.
import { Effect, Layer } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ReviewSessionAdmission } from "@vectordevai/core/review/session-admission"
import { Config } from "@/config/config"
import { ReviewRoutes } from "./route"

const layer = Layer.effect(
  ReviewSessionAdmission.Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    return ReviewSessionAdmission.Service.of({
      zdr: (sessionID) =>
        ReviewRoutes.zdr(sessionID)
          ? Effect.succeed(true)
          : config
              .getGlobal()
              .pipe(Effect.map((global) => ReviewRoutes.serverPolicy(global.review).privacy === "zdr")),
    })
  }),
)

export const node = LayerNode.make({ service: ReviewSessionAdmission.Service, layer, deps: [Config.node] })

export * as ReviewSessionAdmissionLive from "./session-admission"
