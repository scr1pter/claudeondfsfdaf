import { PermissionV1 } from "@vectordevai/core/v1/permission"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ConflictError, PermissionNotFoundError } from "../errors"
import { allowsSessionID } from "./session-access"

export const permissionHandlers = HttpApiBuilder.group(InstanceHttpApi, "permission", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Permission.Service
    const session = yield* Session.Service

    // Replying is owner-only for guests (ServerAuth.isOwnerOnlyRoute). A guest still sees the requests
    // its own sessions are waiting on, but never the owner's.
    const list = Effect.fn("PermissionHttpApi.list")(function* () {
      const principal = yield* RequestPrincipal
      return yield* Effect.filter(yield* svc.list(), (item) => allowsSessionID(session, principal, item.sessionID))
    })

    const reply = Effect.fn("PermissionHttpApi.reply")(function* (ctx: {
      params: { requestID: PermissionV1.ID }
      payload: PermissionV1.ReplyBody
    }) {
      yield* svc
        .reply({
          requestID: ctx.params.requestID,
          ...ctx.payload,
        })
        .pipe(
          Effect.catchTag("Permission.NotFoundError", (error) =>
            Effect.fail(
              new PermissionNotFoundError({
                requestID: String(error.requestID),
                message: `Permission request not found: ${error.requestID}`,
              }),
            ),
          ),
          Effect.catchTag(
            "Permission.ConfirmationRequiredError",
            (error) => new ConflictError({ resource: error.requestID, message: error.message }),
          ),
        )
      return true
    })

    return handlers.handle("list", list).handle("reply", reply)
  }),
)
