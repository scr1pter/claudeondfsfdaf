import { Database } from "@vectordevai/core/database/database"
import { SessionAccountingOutput } from "@vectordevai/core/session/accounting-output"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@vectordevai/core/event"
import { AbsolutePath } from "@vectordevai/core/schema"
import { ServerEvent } from "@vectordevai/schema/server-event"
import { Deferred, Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { EventApi } from "../groups/event"
import { IncomingMessage } from "node:http"
import { RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { RequestOwner } from "@vectordevai/server/request-owner"
import { SessionAudienceHttp } from "@vectordevai/server/session-audience"

type Presence = EventV2.Data<typeof ServerEvent.ClientJoined>

// Who is connected to each directory's event stream, keyed by directory. Lives
// for the process so a newcomer can be told about peers that arrived earlier.
const rosters = new Map<string, Map<string, Presence>>()

function roster(directory: string) {
  const existing = rosters.get(directory)
  if (existing) return existing
  const created = new Map<string, Presence>()
  rosters.set(directory, created)
  return created
}

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function eventID() {
  return EventV2.ID.create()
}

// Effect's Node server only interrupts a request when the *response* emits
// "close", which Bun's node:http never does for an aborted streaming response.
// The request does emit it, so watch that ourselves; otherwise a departed
// client would keep its presence (and its listener) until the process exits.
function onHangup(request: HttpServerRequest.HttpServerRequest, callback: () => void) {
  const source: unknown = request.source
  if (!(source instanceof IncomingMessage)) return () => {}
  source.once("close", callback)
  return () => {
    source.off("close", callback)
  }
}

function isOwnJoin(event: EventV2.Payload, clientID: string) {
  if (event.type !== ServerEvent.ClientJoined.type) return false
  const data: unknown = event.data
  return typeof data === "object" && data !== null && "clientID" in data && data.clientID === clientID
}

export function eventResponse(events: EventV2.Interface, request: HttpServerRequest.HttpServerRequest, self: Presence) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const instance = yield* InstanceState.context
    const workspaceID = yield* InstanceState.workspaceID
    const owner = yield* RequestOwner.owner
    const audience = yield* SessionAudience.Service
    const hangup = yield* Deferred.make<void>()
    const unwatch = onHangup(request, () => {
      Deferred.doneUnsafe(hangup, Effect.void)
    })
    yield* Effect.addFinalizer(() => Effect.sync(unwatch))
    // Listener registration is eager, so events published after this point cannot
    // be lost while the HTTP body fiber is starting or emitting server.connected.
    const queue = yield* Queue.unbounded<EventV2.Payload>()
    const unsubscribe = yield* events.listen((event) => Effect.sync(() => Queue.offerUnsafe(queue, event)))
    yield* Effect.addFinalizer(() => unsubscribe)

    // Presence is per directory (every workspace of it): snapshot the peers that
    // are already here, announce ourselves to them, and say goodbye on disconnect.
    // The explicit location keeps the finalizer's publish routed even when the
    // request context is gone.
    const location = { directory: AbsolutePath.make(instance.directory) }
    const peers = [...roster(instance.directory).values()]
    roster(instance.directory).set(self.clientID, self)
    yield* events.publish(ServerEvent.ClientJoined, self, { location })
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        roster(instance.directory).delete(self.clientID)
        yield* events.publish(ServerEvent.ClientLeft, { ...self, at: Date.now() }, { location })
      }).pipe(Effect.ignoreCause),
    )

    const stream = Stream.fromQueue(queue).pipe(
      Stream.filter(
        (event) =>
          event.location?.directory === instance.directory &&
          (event.location.workspaceID === undefined || event.location.workspaceID === workspaceID) &&
          // We already know we are here; the roster snapshot below covers everyone else.
          !isOwnJoin(event, self.clientID),
      ),
      Stream.filterEffect((event) =>
        SessionAudienceHttp.envelope(event, owner).pipe(Effect.provideService(SessionAudience.Service, audience)),
      ),
      Stream.mapEffect((event) => SessionAccountingOutput.project(database.db, event)),
      Stream.map((event) => ({ id: event.id, type: event.type, properties: event.data })),
    )
    const disposed = Stream.callback<{ id: string; type: string; properties: unknown }>((queue) => {
      const listener = (event: {
        directory?: string
        payload: { id?: string; type?: string; properties?: unknown }
      }) => {
        if (event.directory !== instance.directory || event.payload.type !== "server.instance.disposed") return
        Queue.offerUnsafe(queue, {
          id: event.payload.id ?? eventID(),
          type: "server.instance.disposed",
          properties: event.payload.properties ?? {},
        })
      }
      return Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", listener)),
        () => Effect.sync(() => GlobalBus.off("event", listener)),
      )
    })
    const output = stream.pipe(
      Stream.merge(disposed, { haltStrategy: "left" }),
      Stream.takeUntil((event) => event.type === "server.instance.disposed"),
      // interruptWhen (not haltWhen): the pending pull on an idle queue must be cut short.
      Stream.interruptWhen(Deferred.await(hangup)),
    )
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ id: eventID(), type: "server.heartbeat", properties: {} })),
    )
    const opening = Stream.fromIterable([
      { id: eventID(), type: "server.connected", properties: {} },
      ...peers.map((peer) => ({ id: eventID(), type: ServerEvent.ClientJoined.type, properties: peer })),
    ])

    yield* Effect.logInfo("event connected")
    return HttpServerResponse.stream(
      opening.pipe(
        Stream.concat(output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.filterEffect((event) =>
          SessionAudienceHttp.envelope(event, owner).pipe(Effect.provideService(SessionAudience.Service, audience)),
        ),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const eventHandlers = HttpApiBuilder.group(EventApi, "event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    return handlers.handleRaw(
      "subscribe",
      Effect.fn("EventHttpApi.subscribe")(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const principal = yield* RequestPrincipal
        return yield* eventResponse(events, request, {
          username: principal.username,
          clientID: `cli_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
          at: Date.now(),
        })
      }),
    )
  }),
)
