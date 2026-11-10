import { ServerAuth } from "../auth"
import { ForbiddenError, UnauthorizedError } from "@vectordevai/protocol/errors"
import { Authorization, RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
export { Authorization } from "@vectordevai/protocol/middleware/authorization"
import { PtyID } from "@vectordevai/core/pty/schema"
import { RequestOwner } from "../request-owner"
import { Effect, Encoding, Layer, Option, Redacted, Schema } from "effect"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { SessionAudienceHttp } from "../session-audience"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

function emptyCredential() {
  return { username: "", password: Redacted.make("") }
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return { username: header.slice(0, separator), password: Redacted.make(header.slice(separator + 1)) }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

function unauthorized(credentials: ServerAuth.DecodedCredentials, config: ServerAuth.Info) {
  return Effect.gen(function* () {
    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
    )
    return yield* new UnauthorizedError({ message: ServerAuth.unauthorizedMessage(credentials, config) })
  })
}

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const audience = Option.getOrUndefined(yield* Effect.serviceOption(SessionAudience.Service))
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (url.searchParams.has("auth_token")) return yield* unauthorized(emptyCredential(), config)
        // Browsers cannot set headers on WebSocket upgrades, so a ticketed PTY connect skips
        // credential checks here; the connect handler consumes and validates the ticket.
        const route = yield* HttpRouter.RouteContext
        const ticket = url.searchParams.get("ticket")
        const ptyID = Schema.decodeUnknownOption(PtyID)(route.params.ptyID)
        const connection =
          request.method === "GET" && route.route.path === "/api/pty/:ptyID/connect" && ticket && ptyID._tag === "Some"
            ? { ptyID: ptyID.value, ticket }
            : undefined
        if (connection)
          return yield* effect.pipe(
            Effect.provideService(RequestPrincipal, {
              kind: "pty-ticket",
              username: config.username,
              ...connection,
            }),
          )
        if (!ServerAuth.required(config) && (yield* ServerAuth.refusedRequest(false, RequestOwner.forwarded(request))))
          return yield* new ForbiddenError({ message: "This operation requires the server owner" })
        if (!ServerAuth.required(config))
          return yield* SessionAudienceHttp.protectResponse(effect, !RequestOwner.forwarded(request), audience).pipe(
            Effect.provideService(RequestPrincipal, ServerAuth.ownerPrincipal(config)),
          )
        const credential = yield* credentialFromRequest(request)
        const identity = ServerAuth.identity(credential, config)
        if (!identity) return yield* unauthorized(credential, config)
        if (yield* ServerAuth.refusedRequest(identity === "guest", RequestOwner.forwarded(request)))
          return yield* new ForbiddenError({ message: "This operation requires the server owner" })
        return yield* SessionAudienceHttp.protectResponse(
          effect,
          identity === "owner" && !RequestOwner.forwarded(request),
          audience,
        ).pipe(Effect.provideService(RequestPrincipal, ServerAuth.principal(identity, config)))
      }),
    )
  }),
)
