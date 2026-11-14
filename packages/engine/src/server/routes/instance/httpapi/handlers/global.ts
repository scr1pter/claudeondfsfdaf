import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@vectordevai/core/event"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@vectordevai/core/installation/version"
import { Redaction } from "@vectordevai/core/redaction"
import { Effect, Queue, Schema } from "effect"
import { omit } from "remeda"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { type Principal, RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
import { GlobalUpgradeInput } from "../groups/global"
import { configLocked } from "./config"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { RequestOwner } from "@vectordevai/server/request-owner"
import { SessionAudienceHttp } from "@vectordevai/server/session-audience"

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function parseBody(body: string) {
  try {
    return JSON.parse(body || "{}") as unknown
  } catch {
    return undefined
  }
}

export function globalEventResponse(principal: Principal) {
  return Effect.gen(function* () {
    yield* Effect.logInfo("global event connected")
    const request = yield* HttpServerRequest.HttpServerRequest
    const replication = RequestOwner.replication(request)
    // The owner's own control plane relays this stream into its app: it is screened like a guest's, except that
    // unscoped events (terminals, toasts) still pass the same checks.
    const relay = principal.kind === "owner" && (yield* RequestOwner.owner) && replication
    const owner = (yield* RequestOwner.owner) && !replication
    const audience = yield* SessionAudience.Service
    // An invited guest needs this stream to load the app, but only for the workspace it was invited to: the owner's
    // other projects must not reach it.
    const visible = (event: GlobalBusEvent) => {
      if (principal.kind === "owner") return true
      if (principal.kind !== "guest" || event.directory === undefined) return false
      if (![...principal.workspaceDirectories.values()].includes(event.directory)) return false
      return event.workspace === undefined || principal.workspaceIDs.has(event.workspace)
    }
    const events = Stream.callback<GlobalBusEvent>((queue) => {
      const handler = (event: GlobalBusEvent) => {
        if (visible(event)) Queue.offerUnsafe(queue, event)
      }
      return Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", handler)),
        () => Effect.sync(() => GlobalBus.off("event", handler)),
      )
    })
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
    )

    return HttpServerResponse.stream(
      Stream.make({ payload: { id: EventV2.ID.create(), type: "server.connected", properties: {} } }).pipe(
        Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.filterEffect((event) =>
          SessionAudienceHttp.envelope(event, owner, replication, relay).pipe(
            Effect.provideService(SessionAudience.Service, audience),
            Effect.map(
              (allowed) =>
                allowed &&
                (event.payload.type === "server.connected" ||
                  event.payload.type === "server.heartbeat" ||
                  visible(event)),
            ),
          ),
        ),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("global event disconnected")),
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

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const bridge = yield* EffectBridge.make()

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return yield* globalEventResponse(yield* RequestPrincipal)
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      const global = { ...Redaction.redactConfig(yield* config.getGlobal()), locked: Config.lockedKeys() }
      // Vector Local's block is the owner's: their model servers' addresses, identities and the services they allowed.
      // A guest loads the app from this route but cannot change it, so it gets the rest.
      if (!(yield* RequestOwner.owner)) return omit(global, ["local"])
      return global
    })

    // The global config as GET returns it after the save: every global file merged, not only the one the update
    // wrote, so a client can keep the response as its copy (the app's Settings switches do).
    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const locked = Config.lockedIn(ctx.payload, "global")
      if (locked.length > 0) return yield* configLocked(locked)
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      // An update that wrote nothing keeps the cached config, which may predate an edit made outside Vector.
      if (!result.changed) yield* config.invalidate()
      return yield* configGet()
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return {
          status: 400,
          body: { success: false as const, error: "Unknown installation method" },
        }
      }
      const target = ctx.payload.target || (yield* installation.latest(method))
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.map((result) =>
          result.status === "scheduled"
            ? {
                status: 202,
                body: {
                  success: false as const,
                  error: `Verified update is scheduled after this Vector process exits. Completion status: ${result.statusFile}`,
                },
              }
            : { status: 200, body: { success: true as const, version: target } },
        ),
        Effect.catch((err) =>
          Effect.succeed({
            status: 500,
            body: {
              success: false as const,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        ),
      )
      if (!result.body.success) return result
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return result
    })

    const upgradeRaw = Effect.fn("GlobalHttpApi.upgradeRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = parseBody(body)
      if (json === undefined) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const payload = yield* Schema.decodeUnknownEffect(GlobalUpgradeInput)(json).pipe(
        Effect.map((payload) => ({ valid: true as const, payload })),
        Effect.catch(() => Effect.succeed({ valid: false as const })),
      )
      if (!payload.valid) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const result = yield* upgrade({ payload: payload.payload })
      return HttpServerResponse.jsonUnsafe(result.body, { status: result.status })
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handleRaw("upgrade", upgradeRaw)
  }),
)
