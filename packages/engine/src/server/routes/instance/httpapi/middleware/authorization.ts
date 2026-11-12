import { ServerAuth } from "@/server/auth"
import { Effect, Encoding, Layer, Option, Redacted, Schema } from "effect"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { ForbiddenError, UnauthorizedError } from "@vectordevai/protocol/errors"
import { RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
import { PtyID } from "@vectordevai/core/pty/schema"
import { isPublicUIPath } from "@/server/shared/public-ui"
import { RequestOwner } from "@vectordevai/server/request-owner"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { SessionAudienceHttp } from "@vectordevai/server/session-audience"
export {
  Authorization as ServerAuthorization,
  authorizationLayer as serverAuthorizationLayer,
} from "@vectordevai/server/middleware/authorization"

const UNAUTHORIZED = 401
const FORBIDDEN = 403
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

// Avoid HttpApiSecurity alternatives here: Effect security middleware wraps the
// full handler, so a downstream failure can make the next auth alternative run
// and remap an authorized NotFound into Unauthorized.
export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
  "@vector/ExperimentalHttpApiAuthorization",
  {
    error: [UnauthorizedError, ForbiddenError],
  },
) {}

export class PtyConnectAuthorization extends HttpApiMiddleware.Service<PtyConnectAuthorization>()(
  "@vector/ExperimentalHttpApiPtyConnectAuthorization",
  {
    error: [UnauthorizedError, ForbiddenError],
  },
) {}

function emptyCredential() {
  return {
    username: "",
    password: Redacted.make(""),
  }
}

function validateCredential<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
  audience?: SessionAudience.Interface,
) {
  return Effect.gen(function* () {
    const identity = ServerAuth.identity(credential, config)
    if (!identity) {
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
      )
      return yield* new UnauthorizedError({ message: ServerAuth.unauthorizedMessage(credential, config) })
    }
    if (
      yield* ServerAuth.refusedRequest(
        identity === "guest",
        RequestOwner.forwarded(yield* HttpServerRequest.HttpServerRequest),
      )
    )
      return yield* new ForbiddenError({ message: "This operation requires the server owner" })
    return yield* SessionAudienceHttp.protectResponse(
      effect,
      identity === "owner" && !RequestOwner.forwarded(yield* HttpServerRequest.HttpServerRequest),
      audience,
    ).pipe(Effect.provideService(RequestPrincipal, ServerAuth.principal(identity, config)))
  })
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return {
          username: header.slice(0, separator),
          password: Redacted.make(header.slice(separator + 1)),
        }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  return credentialFromHeaders(request)
}

function credentialFromHeaders(request: HttpServerRequest.HttpServerRequest) {
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

function validateRawCredential<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
  audience?: SessionAudience.Interface,
) {
  return Effect.gen(function* () {
    const identity = ServerAuth.identity(credential, config)
    if (!identity)
      return HttpServerResponse.jsonUnsafe(
        { _tag: "UnauthorizedError", message: ServerAuth.unauthorizedMessage(credential, config) },
        {
          status: UNAUTHORIZED,
          headers: { "www-authenticate": WWW_AUTHENTICATE },
        },
      )
    if (
      yield* ServerAuth.refusedRequest(
        identity === "guest",
        RequestOwner.forwarded(yield* HttpServerRequest.HttpServerRequest),
      )
    )
      return HttpServerResponse.jsonUnsafe(
        { _tag: "ForbiddenError", message: "This operation requires the server owner" },
        { status: FORBIDDEN },
      )
    return yield* SessionAudienceHttp.protectResponse(
      effect,
      identity === "owner" && !RequestOwner.forwarded(yield* HttpServerRequest.HttpServerRequest),
      audience,
    ).pipe(
      Effect.provideService(RequestPrincipal, ServerAuth.principal(identity, config)),
      Effect.catchIf(
        (cause) => cause instanceof ForbiddenError,
        (cause) =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe({ _tag: "ForbiddenError", message: cause.message }, { status: FORBIDDEN }),
          ),
      ),
    )
  })
}

export const authorizationRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const audience = Option.getOrUndefined(yield* Effect.serviceOption(SessionAudience.Service))
    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const route = yield* HttpRouter.RouteContext
        const url = new URL(request.url, "http://localhost")
        // Only the UI catch-all serves the asset the URL parser reads. /doc answers whatever spelling the router
        // matched, and the URL parser reads /doc;/../site.webmanifest as an asset.
        if (route.route.path === "/*" && isPublicUIPath(request.method, url.pathname)) return yield* effect
        if (url.searchParams.has("auth_token"))
          return yield* validateRawCredential(effect, emptyCredential(), config, audience)
        if (!ServerAuth.required(config) && (yield* ServerAuth.refusedRequest(false, RequestOwner.forwarded(request))))
          return HttpServerResponse.jsonUnsafe(
            { _tag: "ForbiddenError", message: "This operation requires the server owner" },
            { status: FORBIDDEN },
          )
        if (!ServerAuth.required(config))
          return yield* SessionAudienceHttp.protectResponse(effect, !RequestOwner.forwarded(request), audience).pipe(
            Effect.provideService(RequestPrincipal, ServerAuth.ownerPrincipal(config)),
            Effect.catchTag("ForbiddenError", (cause) =>
              Effect.succeed(
                HttpServerResponse.jsonUnsafe(
                  { _tag: "ForbiddenError", message: cause.message },
                  { status: FORBIDDEN },
                ),
              ),
            ),
          )
        return yield* credentialFromHeaders(request).pipe(
          Effect.flatMap((credential) => validateRawCredential(effect, credential, config, audience)),
        )
      })
  }),
)

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const audience = Option.getOrUndefined(yield* Effect.serviceOption(SessionAudience.Service))
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (new URL(request.url, "http://localhost").searchParams.has("auth_token"))
          return yield* validateCredential(effect, emptyCredential(), config, audience)
        if (!ServerAuth.required(config) && (yield* ServerAuth.refusedRequest(false, RequestOwner.forwarded(request))))
          return yield* new ForbiddenError({ message: "This operation requires the server owner" })
        if (!ServerAuth.required(config))
          return yield* SessionAudienceHttp.protectResponse(effect, !RequestOwner.forwarded(request), audience).pipe(
            Effect.provideService(RequestPrincipal, ServerAuth.ownerPrincipal(config)),
          )
        return yield* credentialFromRequest(request).pipe(
          Effect.flatMap((credential) => validateCredential(effect, credential, config, audience)),
        )
      }),
    )
  }),
)

export const ptyConnectAuthorizationLayer = Layer.effect(
  PtyConnectAuthorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const audience = Option.getOrUndefined(yield* Effect.serviceOption(SessionAudience.Service))
    return PtyConnectAuthorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (url.searchParams.has("auth_token"))
          return yield* validateCredential(effect, emptyCredential(), config, audience)
        const route = yield* HttpRouter.RouteContext
        const ticket = url.searchParams.get("ticket")
        const ptyID = Schema.decodeUnknownOption(PtyID)(route.params.ptyID)
        const connection =
          request.method === "GET" && route.route.path === "/pty/:ptyID/connect" && ticket && ptyID._tag === "Some"
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
        return yield* credentialFromHeaders(request).pipe(
          Effect.flatMap((credential) => validateCredential(effect, credential, config, audience)),
        )
      }),
    )
  }),
)
