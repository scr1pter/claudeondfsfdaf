import { Database } from "@vectordevai/core/database/database"
import { SessionAccountingOutput } from "@vectordevai/core/session/accounting-output"
import { EventV2 } from "@vectordevai/core/event"
import { VectorEvent } from "@vectordevai/protocol/groups/event"
import { Effect, Schema, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Api } from "../api"
import {
  allowsSession,
  guestWorkspaceDirectory,
  RequestPrincipal,
} from "@vectordevai/protocol/middleware/authorization"

const subscriberCapacity = 256

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(Schema.encodeUnknownSync(VectorEvent)(data)),
  }
}

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const database = yield* Database.Service
    return handlers.handleRaw("event.subscribe", () =>
      Effect.gen(function* () {
        const principal = yield* RequestPrincipal
        const connected = {
          id: EventV2.ID.create(),
          type: "server.connected",
          data: {},
        }
        const output = Stream.unwrap(
          Effect.gen(function* () {
            // Acquiring the bounded stream installs its listener before readiness is observable.
            const live = yield* EventV2.allBounded(events, subscriberCapacity)
            return Stream.make(connected).pipe(
              Stream.concat(
                live.pipe(
                  Stream.filter((event) => {
                    if (allowsSession(principal, event.durable?.aggregateID ?? "")) return true
                    if (principal.kind === "owner") return true
                    const directory = guestWorkspaceDirectory(principal, event.location?.workspaceID)
                    return directory !== undefined && directory === event.location?.directory
                  }),
                  Stream.mapEffect((event) => SessionAccountingOutput.project(database.db, event)),
                ),
              ),
            )
          }),
        ).pipe(Stream.map(eventData), Stream.pipeThroughChannel(Sse.encode()))
        const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
        return HttpServerResponse.stream(
          output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
          {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
    )
  }),
)
