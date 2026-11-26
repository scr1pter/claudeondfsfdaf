import { createHash } from "node:crypto"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ForbiddenError } from "@vectordevai/protocol/errors"
import { RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
import { RequestOwner } from "@vectordevai/server/request-owner"
import { ReviewFixOwner } from "@/review/fix-owner"
import { ReviewOwner } from "@/review/owner"
import { InstanceHttpApi } from "../api"
import { ReviewApiError } from "../groups/review"

export const reviewHandlers = HttpApiBuilder.group(InstanceHttpApi, "review", (handlers) =>
  Effect.gen(function* () {
    const reviews = yield* ReviewOwner.Service
    const fixes = yield* ReviewFixOwner.Service
    const owner = Effect.gen(function* () {
      // Owner credentials forwarding a guest remain a guest, including for GET.
      if (!(yield* RequestOwner.owner))
        return yield* new ForbiddenError({
          message: "Local VectorScope reviews require the authenticated server owner.",
        })
    })
    // A fix approval's actor is the authenticated owner principal, never a request field (memory-authority.ts's form).
    const actor = Effect.gen(function* () {
      yield* owner
      const context = yield* Effect.context<never>()
      const principal = yield* RequestPrincipal
      // The principal the authorization middleware set, never the reference's default.
      if (!context.mapUnsafe.has(RequestPrincipal.key) || principal.kind !== "owner")
        return yield* new ForbiddenError({ message: "Local VectorScope fixes require the authenticated server owner." })
      return `http-owner:${createHash("sha256").update(principal.username).digest("hex")}`
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
      .handle("fixList", ({ params }) =>
        Effect.gen(function* () {
          yield* owner
          return yield* mapped(fixes.list(params.sessionID))
        }),
      )
      .handle("fixPrepare", ({ params, payload }) =>
        Effect.gen(function* () {
          const principal = yield* actor
          return yield* mapped(fixes.prepare(params.sessionID, principal, payload))
        }),
      )
      .handle("fixPreview", ({ params, payload }) =>
        Effect.gen(function* () {
          const principal = yield* actor
          return yield* mapped(fixes.preview(params.sessionID, principal, params.fixID, payload))
        }),
      )
      .handle("fixExecute", ({ params, payload }) =>
        Effect.gen(function* () {
          const principal = yield* actor
          return yield* mapped(fixes.execute(params.sessionID, principal, params.fixID, payload))
        }),
      )
      .handle("fixCancel", ({ params }) =>
        Effect.gen(function* () {
          yield* owner
          return yield* mapped(fixes.cancel(params.sessionID, params.fixID))
        }),
      )
  }),
)
