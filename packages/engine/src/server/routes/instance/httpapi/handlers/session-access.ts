import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { allowsSession, guestWorkspaceDirectory, type Principal } from "@vectordevai/protocol/middleware/authorization"
import { Effect } from "effect"
import { RequestOwner } from "@vectordevai/server/request-owner"
import { SessionAudienceHttp } from "@vectordevai/server/session-audience"

export function allowsSessionLocation(principal: Principal, item: Session.Info) {
  return Effect.gen(function* () {
    // The cheap scope check runs first, so a guest's list never walks the family of a session it cannot see anyway.
    if (!allowsSession(principal, item.id) && guestWorkspaceDirectory(principal, item.workspaceID) !== item.directory)
      return false
    return yield* SessionAudienceHttp.session(item.id, principal.kind === "owner" && (yield* RequestOwner.owner))
  })
}

// Records that belong to a session (its status, pending permissions, open questions) are visible to a
// guest only when the guest may open that session. Instance-wide lists would otherwise show a guest the
// owner's sessions that run in the same directory.
export function allowsSessionID(session: Session.Interface, principal: Principal, sessionID: SessionID) {
  return Effect.gen(function* () {
    if (!(yield* SessionAudienceHttp.session(sessionID, principal.kind === "owner" && (yield* RequestOwner.owner))))
      return false
    if (allowsSession(principal, sessionID)) return true
    return yield* session.get(sessionID).pipe(
      Effect.flatMap((item) => allowsSessionLocation(principal, item)),
      Effect.catch(() => Effect.succeed(false)),
    )
  })
}
