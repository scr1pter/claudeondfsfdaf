import "./init-projectors"

import { NodeHttpServer } from "@vectordevai/core/effect/platform-node"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { ConfigProvider, Context, Effect, Exit, Layer, Option, Scope } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { OpenApi } from "effect/unstable/httpapi"
import { createServer } from "node:http"
import { connect } from "node:net"
import { HttpApiApp } from "./routes/instance/httpapi/server"
import { disposeMiddleware } from "./routes/instance/httpapi/lifecycle"
import { WebSocketTracker } from "./routes/instance/httpapi/websocket-tracker"
import { PublicApi } from "./routes/instance/httpapi/public"
import type { CorsOptions } from "@vectordevai/server/cors"
import { lazy } from "@/util/lazy"
import { assertSecurityEnvironment } from "@vectordevai/core/flag/security"
import { InstallationLocal } from "@vectordevai/core/installation/version"
import { ServerAuth } from "./auth"
import { assertListenSecurity, guardedHostname, isLoopback } from "./listen-policy"
import { EverywherePreferences } from "@/config/everywhere-preferences"
import type { EverywherePreferenceWire } from "@vectordevai/core/everywhere/preferences"
import { AppRuntime } from "@/effect/app-runtime"
import type { EverywhereSession } from "./everywhere-session"
import type { EverywhereSessionWire } from "@vectordevai/core/everywhere/session-binding"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

export type Listener = {
  hostname: string
  port: number
  url: URL
  stop: (close?: boolean) => Promise<void>
  everywherePreferences?: (request: unknown) => Promise<EverywherePreferenceWire.Result>
  everywhereSession?: (request: unknown) => Promise<EverywhereSessionWire.Result>
}

type ServerApp = {
  fetch(request: Request): Response | Promise<Response>
  request(input: string | URL | Request, init?: RequestInit): Response | Promise<Response>
}

type ListenOptions = CorsOptions & {
  port: number
  hostname: string
  mdns?: boolean
  mdnsDomain?: string
  unsecured?: boolean
  /** Accept the password over plain HTTP on a non-loopback address; see assertListenSecurity. */
  trustedNetwork?: boolean
  /** Set by listen() when requests must name a loopback host; see guardedHostname. */
  guardedHostname?: string
  /** Only the built-in, authenticated Desktop sidecar supplies its per-user state file. */
  everywherePreferencesPath?: string
  attachEverywhereSession?: EverywhereSession.Attach
}
type ListenerState = {
  scope: Scope.Scope
  server: Context.Service.Shape<typeof HttpServer.HttpServer>
  http: ListenerServer
  websockets: WebSocketTracker.Interface
}
type EffectListener = Omit<Listener, "stop" | "everywherePreferences" | "everywhereSession"> & {
  stop: (close?: boolean) => Effect.Effect<void>
}

interface ListenerServer {
  readonly closeAll: Effect.Effect<void>
}

class ListenerServerService extends Context.Service<ListenerServerService, ListenerServer>()(
  "@vector/ListenerServer",
) {}

export const Default = lazy(() => {
  const handler = HttpApiApp.webHandler().handler
  const app: ServerApp = {
    fetch: (request: Request) => handler(request, HttpApiApp.context),
    request(input, init) {
      return app.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
  return { app }
})

export async function openapi() {
  return OpenApi.fromApi(PublicApi)
}

export let url: URL | undefined

export async function listen(opts: ListenOptions): Promise<Listener> {
  assertSecurityEnvironment()
  const auth = await Effect.runPromise(
    ServerAuth.Config.pipe(
      Effect.provide(ServerAuth.Config.layer),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
    ),
  )
  assertListenSecurity(opts, auth)
  const preferencesPath =
    isLoopback(opts.hostname) && Option.getOrElse(auth.password, () => "") !== ""
      ? opts.everywherePreferencesPath
      : undefined
  let createEverywhereSession: EverywhereSession.Handler | undefined
  const listener = await Effect.runPromise(
    listenEffect({
      ...opts,
      guardedHostname: guardedHostname(opts, auth),
      everywherePreferencesPath: preferencesPath,
      attachEverywhereSession: preferencesPath
        ? (handler) => {
            createEverywhereSession = handler
          }
        : undefined,
      // A passwordless listener trusts only its own origin among local pages. Running from source keeps every local
      // page trusted, so the app's dev server on another port can still reach a `bun dev serve` backend.
      loopbackOrigins: opts.loopbackOrigins ?? InstallationLocal,
    }),
  )
  const preferences = preferencesPath ? EverywherePreferences.access(preferencesPath) : undefined
  return {
    hostname: listener.hostname,
    port: listener.port,
    url: listener.url,
    stop: (close?: boolean) => {
      createEverywhereSession = undefined
      return Effect.runPromiseExit(listener.stop(close)).then(() => undefined)
    },
    everywherePreferences: preferences
      ? (request) => AppRuntime.runPromise(preferences(request)).catch(() => ({ version: 1, kind: "unavailable" }))
      : undefined,
    everywhereSession: preferencesPath
      ? async (request) =>
          createEverywhereSession
            ? Effect.runPromise(createEverywhereSession(request))
            : { version: 1, kind: "unavailable" }
      : undefined,
  }
}

const listenEffect: (opts: ListenOptions) => Effect.Effect<EffectListener, unknown> = Effect.fn("Server.listen")(
  function* (opts: ListenOptions) {
    const state = yield* startWithPortFallback(opts)
    const address = yield* tcpAddress(state)
    const listenerUrl = makeURL(opts.hostname, address.port)
    const unpublishMdns = yield* setupMdns(opts, address.port, state.scope)
    url = listenerUrl

    return {
      hostname: opts.hostname,
      port: address.port,
      url: listenerUrl,
      stop: yield* makeStop(state, unpublishMdns, listenerUrl),
    }
  },
)

function listenerLayer(opts: ListenOptions, port: number) {
  return HttpRouter.serve(HttpApiApp.createRoutes(opts, opts.everywherePreferencesPath, opts.attachEverywhereSession), {
    middleware: disposeMiddleware,
    disableLogger: true,
    disableListenLog: true,
  }).pipe(
    Layer.provideMerge(AppNodeBuilder.build(WebSocketTracker.node)),
    Layer.provideMerge(serverLayer({ port, hostname: opts.hostname })),
    // Install a fresh `ConfigProvider` per listener so `Config.string(...)`
    // reads reflect the current `process.env`. Effect's default
    // `ConfigProvider` snapshots `process.env` on first read and caches the
    // result on a module-singleton Reference; without overriding it here,
    // every later `Server.listen()` keeps observing that initial snapshot.
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
  )
}

function startWithPortFallback(opts: ListenOptions) {
  if (opts.port !== 0) return startUnsharedListener(opts, opts.port)
  // Match the legacy listener port-resolution behavior: explicit `0` prefers
  // 4096 first, then any free port.
  return startUnsharedListener(opts, 4096).pipe(Effect.catch(() => startListener(opts, 0)))
}

// macOS lets a wildcard bind share a port another process holds on loopback, and a loopback bind share one held on
// the wildcard. Local clients then reach whichever socket is more specific, so a password server on 0.0.0.0:4096
// would leave localhost:4096 answered by another, possibly passwordless, server. A port that already answers local
// connections is taken.
function startUnsharedListener(opts: ListenOptions, port: number) {
  return Effect.gen(function* () {
    const hosts = ["0.0.0.0", "::", "", "localhost"].includes(opts.hostname) ? ["127.0.0.1", "::1"] : [opts.hostname]
    const answering = yield* Effect.forEach(hosts, (host) => answers(host, port), { concurrency: "unbounded" })
    if (answering.some(Boolean))
      return yield* Effect.fail(new Error(`Port ${port} is already in use: another server answers on ${opts.hostname}`))
    return yield* startListener(opts, port)
  })
}

function answers(host: string, port: number) {
  return Effect.callback<boolean>((resume) => {
    const socket = connect({ host, port })
    const settle = (value: boolean) => {
      socket.destroy()
      resume(Effect.succeed(value))
    }
    socket.setTimeout(500, () => settle(false))
    socket.once("connect", () => settle(true))
    socket.once("error", () => settle(false))
  })
}

function startListener(opts: ListenOptions, port: number) {
  const scope = Scope.makeUnsafe()
  return Layer.buildWithMemoMap(listenerLayer(opts, port), Layer.makeMemoMapUnsafe(), scope).pipe(
    Effect.provide(HttpApiApp.context),
    Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
    Effect.map(
      (ctx): ListenerState => ({
        scope,
        server: Context.get(ctx, HttpServer.HttpServer),
        http: Context.get(ctx, ListenerServerService),
        websockets: Context.get(ctx, WebSocketTracker.Service),
      }),
    ),
  )
}

function tcpAddress(state: ListenerState) {
  return Effect.gen(function* () {
    if (state.server.address._tag === "TcpAddress") return state.server.address
    yield* Scope.close(state.scope, Exit.void).pipe(Effect.ignore)
    return yield* Effect.die(new Error(`Unexpected HttpServer address tag: ${state.server.address._tag}`))
  })
}

function makeURL(hostname: string, port: number) {
  const result = new URL("http://localhost")
  result.hostname = hostname
  result.port = String(port)
  return result
}

function setupMdns(opts: ListenOptions, port: number, scope: Scope.Scope) {
  return Effect.gen(function* () {
    const publish =
      opts.mdns && port && opts.hostname !== "127.0.0.1" && opts.hostname !== "localhost" && opts.hostname !== "::1"
    if (publish) {
      // Bonjour and its DNS packet codecs load only for a listener that is actually published.
      const { MDNS } = yield* Effect.promise(() => import("./mdns"))
      const unpublish = yield* Effect.cached(Effect.sync(() => MDNS.unpublish()))
      yield* Effect.sync(() => MDNS.publish(port, opts.mdnsDomain))
      yield* Scope.addFinalizer(scope, unpublish)
      return unpublish
    }
    if (opts.mdns) {
      yield* Effect.logWarning("mDNS enabled but hostname is loopback; skipping mDNS publish")
    }
    return Effect.void
  })
}

function makeStop(state: ListenerState, unpublishMdns: Effect.Effect<void>, listenerUrl: URL) {
  return Effect.gen(function* () {
    const forceCloseOnce = yield* Effect.cached(forceClose(state).pipe(Effect.ignore))
    const closeScopeOnce = yield* Effect.cached(
      Scope.close(state.scope, Exit.void).pipe(
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            if (url === listenerUrl) url = undefined
          }),
        ),
      ),
    )

    return (close?: boolean) =>
      Effect.gen(function* () {
        yield* unpublishMdns
        if (close) yield* forceCloseOnce
        yield* closeScopeOnce
      })
  })
}

function forceClose(state: ListenerState) {
  return Effect.all([state.http.closeAll, state.websockets.closeAll], { concurrency: "unbounded", discard: true })
}

function serverLayer(opts: { port: number; hostname: string }) {
  const server = createServer()
  const serverRef = { closeStarted: false, forceStop: false }
  const close = server.close.bind(server)
  // Keep shutdown owned by NodeHttpServer, but honor listener.stop(true) by
  // force-closing active HTTP sockets when its finalizer calls server.close().
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Node's overloads don't preserve a monkey-patched method assignment.
  server.close = ((callback?: Parameters<typeof server.close>[0]) => {
    serverRef.closeStarted = true
    const result = close(callback)
    if (serverRef.forceStop) server.closeAllConnections()
    return result
  }) as typeof server.close

  return Layer.mergeAll(
    NodeHttpServer.layer(() => server, { port: opts.port, host: opts.hostname, gracefulShutdownTimeout: "1 second" }),
    Layer.succeed(ListenerServerService)(
      ListenerServerService.of({
        closeAll: Effect.sync(() => {
          serverRef.forceStop = true
          if (serverRef.closeStarted) server.closeAllConnections()
        }),
      }),
    ),
  )
}

export * as Server from "./server"
