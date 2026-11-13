import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ForbiddenError } from "@vectordevai/protocol/errors"
import { RequestOwner } from "@vectordevai/server/request-owner"
import { ReviewMemoryOwner } from "@/review/memory-owner"
import { InstanceHttpApi } from "../api"
import { ReviewMemoryApiError } from "../groups/review-memory"

export const reviewMemoryHandlers = HttpApiBuilder.group(InstanceHttpApi, "review-memory", (handlers) =>
  Effect.gen(function* () {
    const memory = yield* ReviewMemoryOwner.Service
    const owner = Effect.gen(function* () {
      if (!(yield* RequestOwner.owner))
        return yield* new ForbiddenError({ message: "Review memory requires the authenticated server owner." })
    })
    const mapped = <A>(effect: Effect.Effect<A, ReviewMemoryOwner.Error>) =>
      effect.pipe(Effect.mapError((error) => new ReviewMemoryApiError({ code: error.code, message: error.message })))
    return handlers
      .handle("inspect", ({ query }) =>
        Effect.gen(function* () {
          yield* owner
          return yield* mapped(
            memory.inspect({
              ...(query.offset === undefined ? {} : { offset: query.offset }),
              ...(query.limit === undefined ? {} : { limit: query.limit }),
            }),
          )
        }),
      )
      .handle("prepare", ({ payload }) =>
        Effect.gen(function* () {
          yield* owner
          return yield* mapped(memory.prepare(payload))
        }),
      )
      .handle("confirm", ({ payload }) =>
        Effect.gen(function* () {
          yield* owner
          return yield* mapped(memory.confirm(payload))
        }),
      )
      .handle("discard", ({ params }) =>
        Effect.gen(function* () {
          yield* owner
          yield* mapped(memory.discard(params.previewId))
          return true
        }),
      )
  }),
)
