import { Workspace } from "@/control-plane/workspace"
import * as InstanceState from "@/effect/instance-state"
import { Session } from "@/session/session"
import { Database } from "@vectordevai/core/database/database"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { EventV2 } from "@vectordevai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventTable } from "@vectordevai/core/event/sql"
import { asc } from "drizzle-orm"
import { and } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { lte } from "drizzle-orm"
import { not } from "drizzle-orm"
import { or } from "drizzle-orm"
import { Effect, Scope } from "effect"
import { RequestOwner } from "@vectordevai/server/request-owner"
import { SessionAudienceHttp } from "@vectordevai/server/session-audience"
import { ForbiddenError } from "@vectordevai/protocol/errors"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { HistoryPayload, ReplayPayload, SessionPayload } from "../groups/sync"

export const syncHandlers = HttpApiBuilder.group(InstanceHttpApi, "sync", (handlers) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace.Service
    const session = yield* Session.Service
    const scope = yield* Scope.Scope
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service
    const guests = yield* FreeModelGuests.Service
    const audience = yield* SessionAudience.Service

    const start = Effect.fn("SyncHttpApi.start")(function* () {
      yield* workspace
        .startWorkspaceSyncing((yield* InstanceState.context).project.id)
        .pipe(Effect.ignore, Effect.forkIn(scope))
      return true
    })

    const replay = Effect.fn("SyncHttpApi.replay")(function* (ctx: { payload: typeof ReplayPayload.Type }) {
      const owner = yield* RequestOwner.owner
      yield* SessionAudienceHttp.assertDirectory(ctx.payload.directory, owner)
      const payload: EventV2.SerializedEvent[] = ctx.payload.events.map((event) => ({
        id: event.id,
        aggregateID: event.aggregateID,
        seq: event.seq,
        type: event.type,
        data: { ...event.data },
      }))
      const source = payload[0].aggregateID
      if (owner) {
        // Imports may only tighten privacy. Install all relation and isolation hints before publishing any aggregate.
        for (const event of payload) {
          if (!/^session\.created(?:\.\d+)?$/.test(event.type)) continue
          const info = event.data.info
          if (typeof event.data.sessionID !== "string" || !info || typeof info !== "object") continue
          const parentID = "parentID" in info && typeof info.parentID === "string" ? info.parentID : undefined
          yield* audience
            .register({ sessionID: event.data.sessionID, parentID })
            .pipe(Effect.mapError((cause) => new ForbiddenError({ message: cause.message })))
        }
        for (const event of payload) {
          if (!/^session\.(?:created|updated)(?:\.\d+)?$/.test(event.type)) continue
          const info = event.data.info
          const metadata = info && typeof info === "object" && "metadata" in info ? info.metadata : undefined
          const subagent =
            metadata && typeof metadata === "object" && "subagent" in metadata ? metadata.subagent : undefined
          if (
            typeof event.data.sessionID !== "string" ||
            !subagent ||
            typeof subagent !== "object" ||
            !("isolation" in subagent)
          )
            continue
          yield* audience
            .fenceIsolation({ sessionID: event.data.sessionID, actor: "owner" })
            .pipe(Effect.mapError((cause) => new ForbiddenError({ message: cause.message })))
        }
      }
      if (!owner) {
        // Validate the complete replay before the first projector or event listener can observe any of it.
        for (const event of payload)
          if (
            !(yield* SessionAudienceHttp.session(event.aggregateID, false)) ||
            !(yield* SessionAudienceHttp.envelope(event, false))
          )
            return yield* new ForbiddenError({
              message: "This replay contains raw content unavailable to this requester.",
            })
        for (const id of new Set(payload.map((event) => event.aggregateID))) yield* SessionAudienceHttp.admit(id, false)
      }
      yield* Effect.logInfo("sync replay requested", {
        sessionID: source,
        events: payload.length,
        first: payload[0]?.seq,
        last: payload.at(-1)?.seq,
        directory: ctx.payload.directory,
      })
      const ownerID = yield* InstanceState.workspaceID
      yield* events.replayAll(payload, { ownerID, strictOwner: true })
      yield* Effect.logInfo("sync replay complete", {
        sessionID: source,
        events: payload.length,
        first: payload[0]?.seq,
        last: payload.at(-1)?.seq,
      })
      return { sessionID: source }
    })

    const steal = Effect.fn("SyncHttpApi.steal")(function* (ctx: { payload: typeof SessionPayload.Type }) {
      const owner = yield* RequestOwner.owner
      yield* SessionAudienceHttp.assertSession(ctx.payload.sessionID, owner)
      yield* SessionAudienceHttp.admit(ctx.payload.sessionID, owner)
      const workspaceID = yield* InstanceState.workspaceID
      if (!workspaceID) return yield* new HttpApiError.BadRequest({})
      // Only an engine before WP28 steals with the forwarded-guest marker (a WP28 sender refuses to move a conversation
      // with guest input), to say a guest worked in the session there. `admit` has already recorded that guest input
      // here; the mark also reaches an older engine sharing this data folder (FreeModelGuests), so the session stays off
      // may-train free models after the move.
      if (!owner) yield* guests.mark(ctx.payload.sessionID)

      yield* session.setWorkspace({ sessionID: ctx.payload.sessionID, workspaceID })

      yield* Effect.logInfo("sync session stolen", { sessionID: ctx.payload.sessionID, workspaceID })

      return { sessionID: ctx.payload.sessionID }
    })

    const history = Effect.fn("SyncHttpApi.history")(function* (ctx: { payload: typeof HistoryPayload.Type }) {
      const exclude = Object.entries(ctx.payload)
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(
          exclude.length > 0
            ? not(or(...exclude.map(([id, seq]) => and(eq(EventTable.aggregate_id, id), lte(EventTable.seq, seq))))!)
            : undefined,
        )
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      const owner = yield* RequestOwner.owner
      const request = yield* HttpServerRequest.HttpServerRequest
      const visible = (events: typeof rows) =>
        Effect.filter(events, (event) =>
          SessionAudienceHttp.envelope({ ...event, aggregateID: event.aggregate_id }, owner),
        )
      if (!RequestOwner.replication(request)) return yield* visible(rows)
      // Replication between engines omits each private or guest-input conversation, and each one whose events would
      // fail the final response check (an ordinary conversation whose tool output shows a private task folder, for
      // example), so one restricted conversation never blocks history for the rest of the workspace; its events never
      // reach the requester's cursor. A session warp names the conversation it moves, and is refused when that one is
      // restricted or left out.
      const restricted = (id: string) =>
        Effect.gen(function* () {
          return (yield* audience.isPrivate(id)) || (yield* audience.hasGuestInput(id))
        })
      const omitted = new Set(
        (yield* Effect.filter(
          Map.groupBy(rows, (event) => event.aggregate_id),
          ([id, events]) =>
            Effect.gen(function* () {
              if (yield* restricted(id)) return true
              return !(yield* SessionAudienceHttp.response(
                HttpServerResponse.jsonUnsafe(events),
                false,
                audience,
                true,
              ))
            }),
        )).map(([id]) => id),
      )
      const transfer = RequestOwner.transfer(request)
      if (transfer && (omitted.has(transfer) || (yield* restricted(transfer))))
        return yield* new ForbiddenError({
          message: "Private or guest-input session history cannot be replicated between engines yet.",
        })
      return yield* visible(rows.filter((event) => !omitted.has(event.aggregate_id)))
    })

    return handlers.handle("start", start).handle("replay", replay).handle("steal", steal).handle("history", history)
  }),
)
