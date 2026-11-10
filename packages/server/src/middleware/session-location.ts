import { Database } from "@vectordevai/core/database/database"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { RequestOwner } from "../request-owner"
import { LocationServiceMap } from "@vectordevai/core/location-services"
import { Location } from "@vectordevai/core/location"
import { AbsolutePath } from "@vectordevai/core/schema"
import { SessionV2 } from "@vectordevai/core/session"
import { SessionTable } from "@vectordevai/core/session/sql"
import { WorkspaceV2 } from "@vectordevai/core/workspace"
import { eq } from "drizzle-orm"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { ForbiddenError, InvalidRequestError, SessionNotFoundError } from "@vectordevai/protocol/errors"
import {
  allowsSession,
  guestWorkspaceDirectory,
  RequestPrincipal,
} from "@vectordevai/protocol/middleware/authorization"
import type { LocationServices } from "../location"

export class SessionLocationMiddleware extends HttpApiMiddleware.Service<
  SessionLocationMiddleware,
  { provides: LocationServices }
>()("@vector/HttpApiSessionLocation", {
  error: [InvalidRequestError, SessionNotFoundError, ForbiddenError],
}) {}

const decodeSessionID = Schema.decodeUnknownEffect(SessionV2.ID)

export const sessionLocationLayer = Layer.effect(
  SessionLocationMiddleware,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const locations = yield* LocationServiceMap.Service
    const guests = yield* FreeModelGuests.Service
    const audience = yield* SessionAudience.Service

    return SessionLocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const route = yield* HttpRouter.RouteContext
        const sessionID = yield* decodeSessionID(route.params.sessionID).pipe(
          Effect.mapError(
            () =>
              new InvalidRequestError({
                message: "Invalid session ID",
                field: "sessionID",
              }),
          ),
        )
        const row = yield* db
          .select({ directory: SessionTable.directory, workspaceID: SessionTable.workspace_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!row)
          return yield* new SessionNotFoundError({
            sessionID,
            message: `Session not found: ${sessionID}`,
          })
        const principal = yield* RequestPrincipal
        const owner = yield* RequestOwner.owner
        const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)
        const counts = Option.isSome(request) && RequestOwner.counts(request.value, route.route.path)
        if (
          !owner &&
          ((!counts && (yield* audience.isPrivate(sessionID))) || (yield* audience.isPrivateDirectory(row.directory)))
        )
          return yield* new ForbiddenError({ message: "This session's raw content is available only to the owner." })
        const sessionAllowed = allowsSession(principal, sessionID)
        const guestDirectory = guestWorkspaceDirectory(principal, row.workspaceID ?? undefined)
        if (!sessionAllowed && guestDirectory !== row.directory)
          return yield* new ForbiddenError({ message: "Guest credential is not scoped to this session" })
        // Whatever a guest changes in a session, a prompt, a model switch, an answer, keeps that session's free-model
        // requests off models that may train (FreeModelGuests). It is recorded before the handler runs.
        // Read optionally so the routes keep needing no request service of their own (embedded callers pass one
        // argument). A request whose method cannot be read counts as a change.
        const method = Option.isSome(request) ? request.value.method : undefined
        if (!owner && method !== "GET" && method !== "HEAD") {
          yield* audience
            .markGuest(sessionID)
            .pipe(Effect.mapError((cause) => new ForbiddenError({ message: cause.message })))
          yield* guests.mark(sessionID)
        }

        return yield* effect.pipe(
          Effect.provide(
            locations.get(
              Location.Ref.make({
                directory: AbsolutePath.make(
                  sessionAllowed || principal.kind === "owner" ? row.directory : guestDirectory!,
                ),
                workspaceID: row.workspaceID ? WorkspaceV2.ID.make(row.workspaceID) : undefined,
              }),
            ),
          ),
        )
      }),
    )
  }),
)
