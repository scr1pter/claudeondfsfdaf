import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ForbiddenError } from "@vectordevai/protocol/errors"
import { RequestOwner } from "@vectordevai/server/request-owner"
import { ReviewOwner } from "@/review/owner"
import { InstanceHttpApi } from "../api"
import { ReviewApiError } from "../groups/review"

export const reviewHandlers = HttpApiBuilder.group(InstanceHttpApi, "review", (handlers) =>
  Effect.gen(function* () {
    const reviews = yield* ReviewOwner.Service
    const owner = Effect.gen(function* () {
      // Owner credentials forwarding a guest remain a guest, including for GET.
      if (!(yield* RequestOwner.owner))
        return yield* new ForbiddenError({
          message: "Local VectorScope reviews require the authenticated server owner.",
        })
    })
    const mapped = <A, R>(effect: Effect.Effect<A, { code: ReviewApiError["code"]; message: string }, R>) =>
      effect.pipe(Effect.mapError((error) => new ReviewApiError({ code: error.code, message: error.message })))
    return handlers
      .handle("target", ({ params }) =>
        Effect.gen(function* () {
          yield* owner
          return yield* mapped(reviews.target(params.sessionID))
        }),
      )
      .handle("start", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* owner
          return yield* mapped(reviews.start(params.sessionID, payload))
        }),
      )
      .handle("list", ({ params, query }) =>
        Effect.gen(function* () {
          yield* owner
          return yield* mapped(
            reviews.list(params.sessionID, {
              ...(query.cursor ? { cursor: query.cursor } : {}),
              ...(query.limit === undefined ? {} : { limit: query.limit }),
            }),
          )
        }),
      )
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          yield* owner
          return yield* mapped(reviews.get(params.sessionID, params.runID))
        }),
      )
      .handle("stop", ({ params }) =>
        Effect.gen(function* () {
          yield* owner
          return yield* mapped(reviews.stop(params.sessionID, params.runID))
        }),
      )
  }),
)
