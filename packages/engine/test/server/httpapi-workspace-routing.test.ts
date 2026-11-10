import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Queue, Ref, Schema, Stream } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import Http from "node:http"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { registerAdapter } from "../../src/control-plane/adapters"
import { WorkspaceV2 } from "@vectordevai/core/workspace"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { PtyTicket } from "@vectordevai/core/pty/ticket"
import { FreeModelGuests, GUEST_REQUEST_HEADER } from "@vectordevai/core/free-model-guests"
import { SessionAudience } from "@vectordevai/core/session/audience"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
import { WorkspaceTable } from "@vectordevai/core/control-plane/workspace.sql"
import { Database } from "@vectordevai/core/database/database"
import { Project } from "../../src/project/project"
import { Session } from "../../src/session/session"
import { SessionID } from "../../src/session/schema"
import { RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
import { WorkspacePaths } from "../../src/server/routes/instance/httpapi/groups/workspace"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRouteContext,
  workspaceRoutingLayer,
} from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { HEADER as FenceHeader } from "../../src/server/shared/fence"
import { resetDatabase } from "../fixture/db"
import { workspaceLayerWithRuntimeFlags } from "../fixture/workspace"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await resetDatabase()
      }),
    )
  }),
)

const workspaceLayer = workspaceLayerWithRuntimeFlags({ experimentalWorkspaces: true })

const it = testEffect(
  Layer.mergeAll(
    testStateLayer,
    NodeHttpServer.layerTest,
    NodeServices.layer,
    workspaceLayer,
    LayerNode.compile(PtyTicket.node),
    LayerNode.compile(FreeModelGuests.node),
    LayerNode.compile(SessionAudience.node),
    Socket.layerWebSocketConstructorGlobal,
  ),
)

type ProxiedRequest = {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

type TestHandler<E, R> = (
  request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>

const workspaceRoutingTestLayer = workspaceRoutingLayer.pipe(
  Layer.provide([Socket.layerWebSocketConstructorGlobal, FetchHttpClient.layer]),
)

const serverUrl = HttpServer.HttpServer.use((server) => Effect.succeed(HttpServer.formatAddress(server.address)))

const requestURL = (request: { readonly url: string }) => new URL(request.url, "http://localhost")

const listenAdditionalServer = <E, R>(handler: TestHandler<E, R>) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(NodeHttpServer.layer(Http.createServer, { host: "127.0.0.1", port: 0 }))
    const server = Context.get(context, HttpServer.HttpServer)
    yield* server.serve(HttpServerRequest.HttpServerRequest.use(handler))
    return HttpServer.formatAddress(server.address)
  })

const localAdapter = (directory: string): WorkspaceAdapter => ({
  name: "Local Test",
  description: "Create a local test workspace",
  configure: (info) => ({ ...info, name: "local-test", directory }),
  create: async () => {
    await mkdir(directory, { recursive: true })
  },
  async remove() {},
  target: () => ({ type: "local" as const, directory }),
})

const remoteAdapter = (directory: string, url: string, headers?: HeadersInit): WorkspaceAdapter => ({
  name: "Remote Test",
  description: "Create a remote test workspace",
  configure: (info) => ({ ...info, name: "remote-test", directory }),
  create: async () => {
    await mkdir(directory, { recursive: true })
  },
  async remove() {},
  target: () => ({ type: "remote" as const, url, headers }),
})

const eventStreamResponse = () =>
  HttpServerResponse.text('data: {"payload":{"type":"server.connected","properties":{}}}\n\n', {
    contentType: "text/event-stream",
  })

const syncResponse = (request: HttpServerRequest.HttpServerRequest) => {
  const url = requestURL(request)
  if (url.pathname === "/base/global/event") return Effect.succeed(eventStreamResponse())
  if (url.pathname === "/base/sync/history") return HttpServerResponse.json([])
  return undefined
}

const createWorkspace = (input: { projectID: Project.Info["id"]; type: string; adapter: WorkspaceAdapter }) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      registerAdapter(input.projectID, input.type, input.adapter)
      const workspace = yield* Workspace.Service
      return yield* workspace.create({
        type: input.type,
        branch: null,
        extra: null,
        projectID: input.projectID,
      })
    }),
    (info) => Workspace.use.remove(info.id).pipe(Effect.ignore),
  )

const createRemoteWorkspace = (input: {
  dir: string
  projectID: Project.Info["id"]
  type: string
  url: string
  headers?: HeadersInit
}) =>
  // Workspace.create starts the remote sync loop. The test upstream exposes
  // /global/event and /sync/history so middleware proxying sees the remote
  // workspace as active, just like production would.
  createWorkspace({
    projectID: input.projectID,
    type: input.type,
    adapter: remoteAdapter(path.join(input.dir, `.${input.type}`), input.url, input.headers),
  })

const createLocalWorkspace = (input: { projectID: Project.Info["id"]; type: string; directory: string }) =>
  createWorkspace({
    projectID: input.projectID,
    type: input.type,
    adapter: localAdapter(input.directory),
  })

const insertRemoteWorkspaceWithoutSync = (input: {
  dir: string
  projectID: Project.Info["id"]
  type: string
  url: string
}) =>
  Effect.gen(function* () {
    const id = WorkspaceV2.ID.ascending()
    registerAdapter(input.projectID, input.type, remoteAdapter(path.join(input.dir, `.${input.type}`), input.url))
    const { db } = yield* Database.Service
    yield* db
      .insert(WorkspaceTable)
      .values({ id, type: input.type, project_id: input.projectID })
      .run()
      .pipe(Effect.orDie)
    return id
  })

const startRemoteWorkspaceHttpServer = <E, R>(
  handler: (request: ProxiedRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  listenAdditionalServer((request) =>
    Effect.gen(function* () {
      // Remote workspaces run a sync loop against their target server. These
      // bootstrap routes make Workspace.isSyncing(...) true for proxy tests;
      // everything else is the request being proxied by the middleware.
      const sync = syncResponse(request)
      if (sync) return yield* sync
      return yield* handler({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: yield* request.text,
      })
    }),
  )

const listenRemoteWebSocket = () =>
  listenAdditionalServer((request) => {
    const sync = syncResponse(request)
    if (sync) return sync
    if (requestURL(request).pathname !== "/base/probe") return Effect.succeed(HttpServerResponse.empty({ status: 404 }))
    return echoWebSocket(request)
  })

const echoWebSocket = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const socket = yield* Effect.orDie(request.upgrade)
    const write = yield* socket.writer
    yield* socket
      .runRaw((message) => write(`echo:${String(message)}`), {
        onOpen: write(`protocol:${request.headers["sec-websocket-protocol"] ?? "none"}`).pipe(
          Effect.catch(() => Effect.void),
        ),
      })
      .pipe(Effect.catch(() => Effect.void))
    return HttpServerResponse.empty()
  })

const ProbeResult = Schema.Struct({
  directory: Schema.String,
  workspaceID: Schema.optional(Schema.String),
})

const ProbeApi = HttpApi.make("workspace-routing-probe").add(
  HttpApiGroup.make("probe")
    .add(
      HttpApiEndpoint.get("get", "/probe", { query: WorkspaceRoutingQuery, success: ProbeResult }),
      HttpApiEndpoint.get("api", "/api/probe", { query: WorkspaceRoutingQuery, success: ProbeResult }),
      HttpApiEndpoint.patch("patch", "/probe", { query: WorkspaceRoutingQuery, success: Schema.Boolean }),
      HttpApiEndpoint.get("session", "/session", { query: WorkspaceRoutingQuery, success: ProbeResult }),
      HttpApiEndpoint.get("workspace", WorkspacePaths.list, {
        query: WorkspaceRoutingQuery,
        success: ProbeResult,
      }),
    )
    .middleware(WorkspaceRoutingMiddleware),
)

const routeContextResponse = Effect.gen(function* () {
  const route = yield* WorkspaceRouteContext
  return { directory: route.directory, workspaceID: route.workspaceID }
})

const probeHandlers = HttpApiBuilder.group(ProbeApi, "probe", (handlers) =>
  handlers
    .handle("get", () => routeContextResponse)
    .handle("api", () => routeContextResponse)
    .handle("patch", () => Effect.succeed(false))
    .handle("session", () => routeContextResponse)
    .handle("workspace", () => routeContextResponse),
)

const serveProbe = HttpApiBuilder.layer(ProbeApi).pipe(
  Layer.provide(probeHandlers),
  Layer.provide(workspaceRoutingTestLayer),
  Layer.provide(Layer.mock(Session.Service)({})),
  HttpRouter.serve,
  Layer.build,
)

describe("HttpApi workspace routing middleware", () => {
  it.live("a guest's request forwarded to a remote workspace says it is a guest's", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      const forwarded: (string | undefined)[] = []
      const remoteUrl = yield* startRemoteWorkspaceHttpServer((request) => {
        forwarded.push(request.headers[GUEST_REQUEST_HEADER])
        return HttpServerResponse.json(true)
      })
      const workspace = yield* createRemoteWorkspace({
        dir,
        projectID: project.project.id,
        type: "remote-guest-marker",
        url: `${remoteUrl}/base`,
        headers: { authorization: "Basic remote-owner-placeholder" },
      })
      // The remote engine authenticates the request as its owner, so only this header tells it a guest sent it, and
      // it keeps that session off free models that may train (FreeModelGuests).
      const api = HttpApi.make("guest-marker-probe").add(
        HttpApiGroup.make("session")
          .add(
            HttpApiEndpoint.post("prompt", "/session/:sessionID/message", {
              params: Schema.Struct({ sessionID: SessionID }),
              query: WorkspaceRoutingQuery,
              success: Schema.Boolean,
            }),
          )
          .middleware(WorkspaceRoutingMiddleware),
      )
      yield* HttpApiBuilder.layer(api).pipe(
        Layer.provide(
          HttpApiBuilder.group(api, "session", (handlers) => handlers.handle("prompt", () => Effect.succeed(false))),
        ),
        Layer.provide(workspaceRoutingTestLayer),
        Layer.provide(
          Layer.mock(Session.Service)({
            get: (id) =>
              Effect.succeed({
                id,
                slug: "fixture",
                title: "Fixture session",
                version: "test",
                projectID: project.project.id,
                directory: workspace.directory!,
                workspaceID: workspace.id,
                time: { created: 1, updated: 1 },
              }),
          }),
        ),
        HttpRouter.provideRequest(
          Layer.succeed(RequestPrincipal, {
            kind: "guest",
            username: "guest",
            workspaceIDs: new Set([workspace.id]),
            workspaceDirectories: new Map([[workspace.id, workspace.directory!]]),
            sessionIDs: new Set(["ses_shared"]),
          }),
        ),
        HttpRouter.serve,
        Layer.build,
      )
      expect((yield* HttpClientRequest.post("/session/ses_shared/message").pipe(HttpClient.execute)).status).toBe(200)
      expect(forwarded).toEqual(["1"])
      // This engine marks the session as well, so the mark holds if the session is warped back here.
      const guests = yield* FreeModelGuests.Service
      expect(yield* guests.marked(SessionID.make("ses_shared"))).toBe(true)
    }),
  )

  it.live("checks task-control ownership before forwarding with remote owner credentials", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      const forwarded: string[] = []
      const remoteUrl = yield* startRemoteWorkspaceHttpServer((request) => {
        forwarded.push(requestURL(request).pathname)
        return HttpServerResponse.json(true)
      })
      const workspace = yield* createRemoteWorkspace({
        dir,
        projectID: project.project.id,
        type: "remote-task-controls",
        url: `${remoteUrl}/base`,
        headers: { authorization: "Basic remote-owner-placeholder" },
      })
      const api = HttpApi.make("task-routing-probe").add(
        HttpApiGroup.make("tasks")
          .add(
            HttpApiEndpoint.get("list", "/experimental/session/:sessionID/tasks", {
              params: Schema.Struct({ sessionID: SessionID }),
              query: WorkspaceRoutingQuery,
              success: Schema.Boolean,
            }),
            HttpApiEndpoint.post("stop", "/experimental/session/:sessionID/tasks/stop", {
              params: Schema.Struct({ sessionID: SessionID }),
              query: WorkspaceRoutingQuery,
              success: Schema.Boolean,
            }),
            HttpApiEndpoint.post("message", "/experimental/session/:sessionID/tasks/:taskID/message", {
              params: Schema.Struct({ sessionID: SessionID, taskID: Schema.String }),
              query: WorkspaceRoutingQuery,
              success: Schema.Boolean,
            }),
            HttpApiEndpoint.post("merge", "/experimental/session/:sessionID/tasks/:taskID/merge", {
              params: Schema.Struct({ sessionID: SessionID, taskID: Schema.String }),
              query: WorkspaceRoutingQuery,
              success: Schema.Boolean,
            }),
            HttpApiEndpoint.post("discard", "/experimental/session/:sessionID/tasks/:taskID/discard", {
              params: Schema.Struct({ sessionID: SessionID, taskID: Schema.String }),
              query: WorkspaceRoutingQuery,
              success: Schema.Boolean,
            }),
            HttpApiEndpoint.post("register", "/experimental/session/:sessionID/tasks/bridge/register", {
              params: Schema.Struct({ sessionID: SessionID }),
              query: WorkspaceRoutingQuery,
              success: Schema.Boolean,
            }),
            HttpApiEndpoint.post("poll", "/experimental/session/:sessionID/tasks/bridge/poll", {
              params: Schema.Struct({ sessionID: SessionID }),
              query: WorkspaceRoutingQuery,
              success: Schema.Boolean,
            }),
            HttpApiEndpoint.post("receipt", "/experimental/session/:sessionID/tasks/bridge/receipt", {
              params: Schema.Struct({ sessionID: SessionID }),
              query: WorkspaceRoutingQuery,
              success: Schema.Boolean,
            }),
          )
          .middleware(WorkspaceRoutingMiddleware),
      )
      yield* HttpApiBuilder.layer(api).pipe(
        Layer.provide(
          HttpApiBuilder.group(api, "tasks", (handlers) =>
            handlers
              .handle("list", () => Effect.succeed(false))
              .handle("stop", () => Effect.succeed(false))
              .handle("message", () => Effect.succeed(false))
              .handle("merge", () => Effect.succeed(false))
              .handle("discard", () => Effect.succeed(false))
              .handle("register", () => Effect.succeed(false))
              .handle("poll", () => Effect.succeed(false))
              .handle("receipt", () => Effect.succeed(false)),
          ),
        ),
        Layer.provide(workspaceRoutingTestLayer),
        Layer.provide(
          Layer.mock(Session.Service)({
            get: (id) =>
              Effect.succeed({
                id,
                slug: "fixture",
                title: "Fixture session",
                version: "test",
                projectID: project.project.id,
                directory: workspace.directory!,
                workspaceID: workspace.id,
                time: { created: 1, updated: 1 },
              }),
          }),
        ),
        HttpRouter.provideRequest(
          Layer.succeed(RequestPrincipal, {
            kind: "guest",
            username: "guest",
            workspaceIDs: new Set([workspace.id]),
            workspaceDirectories: new Map([[workspace.id, workspace.directory!]]),
            sessionIDs: new Set(["ses_claimed"]),
          }),
        ),
        HttpRouter.serve,
        Layer.build,
      )
      const base = "/experimental/session/ses_owner/tasks"
      expect((yield* HttpClient.get(base)).status).toBe(200)
      expect(forwarded).toEqual([`/base${base}`])
      for (const route of [
        `${base}/stop`,
        `${base}/ses_child/message`,
        `${base.toUpperCase()}/stop`,
        `${base}/stop;x`,
      ]) {
        expect((yield* HttpClientRequest.post(route).pipe(HttpClient.execute)).status).toBe(403)
      }
      expect(forwarded).toHaveLength(1)
      expect(
        (yield* HttpClientRequest.post("/experimental/session/ses_claimed/tasks/stop").pipe(HttpClient.execute)).status,
      ).toBe(200)
      expect(
        (yield* HttpClientRequest.post("/experimental/session/ses_claimed/tasks/ses_child/message").pipe(
          HttpClient.execute,
        )).status,
      ).toBe(200)
      expect(forwarded).toHaveLength(3)
      for (const action of ["register", "poll", "receipt"]) {
        expect(
          (yield* HttpClientRequest.post(`/experimental/session/ses_claimed/tasks/bridge/${action}`).pipe(
            HttpClient.execute,
          )).status,
        ).toBe(403)
      }
      // Control of the session does not make a guest the owner: merge and discard are refused before forwarding.
      for (const action of ["merge", "discard"]) {
        const refused = yield* HttpClientRequest.post(
          `/experimental/session/ses_claimed/tasks/ses_child/${action}`,
        ).pipe(HttpClient.execute)
        expect(refused.status).toBe(403)
        expect(yield* refused.text).toContain("Only the server owner can merge or discard")
      }
      expect(forwarded).toHaveLength(3)
    }),
  )

  it.live("proxies remote workspace HTTP requests through the selected workspace target", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      let forwarded: ProxiedRequest | undefined

      // This starts a second HTTP server that stands in for the vector server
      // backing a remote workspace. The client below still calls the local test
      // server; only the middleware should call this server.
      const remoteUrl = yield* startRemoteWorkspaceHttpServer((request) => {
        forwarded = request
        const url = requestURL(request)
        return HttpServerResponse.json(
          {
            proxied: true,
            path: url.pathname,
            keep: url.searchParams.get("keep"),
            workspace: url.searchParams.get("workspace"),
          },
          { status: 201, headers: { "x-remote": "yes" } },
        )
      })
      // The adapter target tells the middleware where to proxy selected remote
      // workspace requests. Appending /probe to this base should produce
      // `${remoteUrl}/base/probe` on the fake remote server above.
      const workspace = yield* createRemoteWorkspace({
        dir,
        projectID: project.project.id,
        type: "remote-http-target",
        url: `${remoteUrl}/base`,
        headers: { "x-target-auth": "secret" },
      })

      // The local /probe handler should not run. Selecting a remote workspace
      // should make the middleware call HttpApiProxy.http instead.
      yield* serveProbe

      const body = '{"title":"Remote workspace request"}'
      const response = yield* HttpClientRequest.patch(`/probe?workspace=${workspace.id}&keep=yes`).pipe(
        HttpClientRequest.setHeaders({
          "x-vector-directory": "/secret/vector/path",
          "x-vector-workspace": "internal-vector",
        }),
        HttpClientRequest.bodyStream(
          Stream.make(new TextEncoder().encode('{"title":"Remote '), new TextEncoder().encode('workspace request"}')),
          { contentType: "application/json" },
        ),
        HttpClient.execute,
        Effect.timeout("2 seconds"),
      )

      expect(response.status).toBe(201)
      expect(response.headers["x-remote"]).toBe("yes")
      expect(yield* response.json).toEqual({ proxied: true, path: "/base/probe", keep: "yes", workspace: null })
      const forwardedURL = forwarded ? requestURL(forwarded) : undefined
      // These assertions are the routing contract: append the original path to
      // the remote base URL, preserve normal query params, and remove workspace.
      expect(forwardedURL?.pathname).toBe("/base/probe")
      expect(forwardedURL?.searchParams.get("keep")).toBe("yes")
      expect(forwardedURL?.searchParams.get("workspace")).toBeNull()
      expect(forwarded?.method).toBe("PATCH")
      expect(forwarded?.body).toBe(body)
      expect(forwarded?.headers["content-type"]).toBe("application/json")
      expect(forwarded?.headers["x-target-auth"]).toBe("secret")
      expect(forwarded?.headers["x-vector-directory"]).toBeUndefined()
      expect(forwarded?.headers["x-vector-workspace"]).toBeUndefined()
      // The owner's own request is not marked as a guest's.
      expect(forwarded?.headers[GUEST_REQUEST_HEADER]).toBeUndefined()
    }),
  )

  it.live("waits for sync fence headers from remote workspace HTTP responses", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      const workspaceID = WorkspaceV2.ID.ascending()
      const type = "remote-http-fence-target"
      const waited = yield* Ref.make<{ workspaceID: WorkspaceV2.ID; state: Record<string, number> } | undefined>(
        undefined,
      )

      const remoteUrl = yield* startRemoteWorkspaceHttpServer(() =>
        HttpServerResponse.json(
          { proxied: true },
          { status: 202, headers: { [FenceHeader]: JSON.stringify({ aggregate: 3 }) } },
        ),
      )
      registerAdapter(project.project.id, type, remoteAdapter(path.join(dir, `.${type}`), `${remoteUrl}/base`))

      const workspace = Workspace.Service.of({
        create: () => Effect.die("unused"),
        sessionWarp: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
        syncList: () => Effect.die("unused"),
        get: (id) =>
          Effect.succeed(
            id === workspaceID
              ? {
                  id: workspaceID,
                  type,
                  branch: null,
                  name: "remote-http-fence-target",
                  directory: null,
                  extra: null,
                  projectID: project.project.id,
                  timeUsed: Date.now(),
                }
              : undefined,
          ),
        remove: () => Effect.die("unused"),
        status: () => Effect.die("unused"),
        isSyncing: () => Effect.succeed(true),
        waitForSync: (id, state) => Ref.set(waited, { workspaceID: id, state }),
        startWorkspaceSyncing: () => Effect.die("unused"),
      })

      yield* HttpApiBuilder.layer(ProbeApi).pipe(
        Layer.provide(probeHandlers),
        Layer.provide(workspaceRoutingTestLayer),
        Layer.provide(Layer.succeed(Workspace.Service, workspace)),
        Layer.provide(Layer.mock(Session.Service)({})),
        HttpRouter.serve,
        Layer.build,
      )

      const response = yield* HttpClientRequest.patch(`/probe?workspace=${workspaceID}`).pipe(HttpClient.execute)

      expect(response.status).toBe(202)
      expect(yield* response.json).toEqual({ proxied: true })
      expect(yield* Ref.get(waited)).toEqual({ workspaceID, state: { aggregate: 3 } })
    }),
  )

  it.live("returns 503 when a remote workspace is not actively syncing", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      const workspaceID = yield* insertRemoteWorkspaceWithoutSync({
        dir,
        projectID: project.project.id,
        type: "remote-not-syncing",
        url: "http://127.0.0.1:1/base",
      })

      yield* serveProbe

      const response = yield* HttpClient.get(`/probe?workspace=${workspaceID}`)

      expect(response.status).toBe(503)
      expect(yield* response.text).toBe(`broken sync connection for workspace: ${workspaceID}`)
    }),
  )

  it.live("proxies remote workspace WebSocket requests through the selected workspace target", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      const remoteUrl = yield* listenRemoteWebSocket()
      const workspace = yield* createRemoteWorkspace({
        dir,
        projectID: project.project.id,
        type: "remote-websocket-target",
        url: `${remoteUrl}/base`,
      })

      // The client connects to the local test server. The middleware should
      // detect the WebSocket upgrade and proxy it to the remote /base/probe.
      yield* serveProbe

      const socket = yield* Socket.makeWebSocket(
        `${(yield* serverUrl).replace(/^http/, "ws")}/probe?workspace=${workspace.id}`,
        {
          closeCodeIsError: () => false,
          protocols: "chat",
        },
      )
      const messages = yield* Queue.unbounded<string>()
      yield* socket.runRaw((message) => Queue.offer(messages, String(message))).pipe(Effect.forkScoped)
      const write = yield* socket.writer

      expect(yield* Queue.take(messages)).toBe("protocol:chat")
      yield* write("hello")
      expect(yield* Queue.take(messages)).toBe("echo:hello")
    }),
  )

  it.live("returns a missing workspace response for unknown workspace ids", () =>
    Effect.gen(function* () {
      const workspaceID = WorkspaceV2.ID.ascending("wrk_missing")
      // If the middleware resolves the workspace first, this handler is never
      // reached and the response should be the middleware error response.
      yield* serveProbe

      const response = yield* HttpClient.get(`/probe?workspace=${workspaceID}`)

      expect(response.status).toBe(500)
      expect(yield* response.text).toBe(`Workspace not found: ${workspaceID}`)
    }),
  )

  it.live("rejects a malformed workspace id without defecting the request", () =>
    Effect.gen(function* () {
      yield* serveProbe

      const response = yield* HttpClient.get("/api/probe?workspace=evt_not_a_workspace")

      expect(response.status).toBe(400)
      expect(yield* response.json).toMatchObject({
        message: "Invalid workspace query parameter",
        field: "workspace",
      })
    }),
  )

  it.live("handles a malformed legacy workspace id without defecting the request", () =>
    Effect.gen(function* () {
      yield* serveProbe

      const response = yield* HttpClient.get("/probe?workspace=ws_legacy")

      expect(response.status).toBe(500)
      expect(yield* response.text).toBe("Workspace not found: ws_legacy")
    }),
  )

  it.live("keeps control-plane routes local even when workspace is selected", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)

      const workspaceDir = path.join(dir, ".workspace-local")
      const workspace = yield* createLocalWorkspace({
        projectID: project.project.id,
        type: "control-plane-target",
        directory: workspaceDir,
      })

      // GET /session is a control-plane route: it lists sessions for the main
      // process and should not be redirected into the selected workspace target.
      yield* serveProbe

      const response = yield* HttpClient.get(`/session?workspace=${workspace.id}`)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ directory: process.cwd(), workspaceID: workspace.id })
    }),
  )

  it.live("keeps workspace control routes local even when workspace is selected", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      const workspaceDir = path.join(dir, ".workspace-local")
      const workspace = yield* createLocalWorkspace({
        projectID: project.project.id,
        type: "workspace-control-plane-target",
        directory: workspaceDir,
      })

      // Workspace CRUD/status routes manage the control plane itself. Selecting
      // a workspace should preserve the selected id for handlers, but must not
      // swap the route context to the workspace target directory.
      yield* serveProbe

      const response = yield* HttpClient.get(`${WorkspacePaths.list}?workspace=${workspace.id}`)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ directory: process.cwd(), workspaceID: workspace.id })
    }),
  )

  it.live("uses directory query/header fallback when no workspace is selected", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const queryDir = path.join(dir, "query-target")
      const headerDir = path.join(dir, "header-target")
      yield* serveProbe

      // Without a selected workspace, the middleware falls back to request
      // directory hints before using the process cwd.
      const queryResponse = yield* HttpClient.get(`/probe?directory=${encodeURIComponent(queryDir)}`)
      expect(queryResponse.status).toBe(200)
      expect(yield* queryResponse.json).toEqual({ directory: queryDir, workspaceID: null })
      for (const header of ["x-vector-directory"]) {
        const encodedDirectory = `${headerDir}/space %20 東京`
        const response = yield* HttpClientRequest.get("/probe").pipe(
          HttpClientRequest.setHeader(header, encodeURIComponent(encodedDirectory)),
          HttpClient.execute,
        )
        expect(response.status).toBe(200)
        expect(yield* response.json).toEqual({ directory: encodedDirectory, workspaceID: null })
      }
      const preferred = yield* HttpClientRequest.get("/probe").pipe(
        HttpClientRequest.setHeaders({ "x-vector-directory": queryDir, "x-unrelated-directory": headerDir }),
        HttpClient.execute,
      )
      expect(preferred.status).toBe(400)
      expect(yield* preferred.json).toMatchObject({ kind: "client_outdated" })
    }),
  )

  it.live("rejects foreign directory headers before reads and writes can fall back to cwd", () =>
    Effect.gen(function* () {
      yield* serveProbe
      for (const method of ["GET", "PATCH"] as const) {
        const response = yield* HttpClientRequest.make(method)("/probe").pipe(
          HttpClientRequest.setHeader("x-previous-directory", "/private/other-project"),
          HttpClient.execute,
        )
        expect(response.status).toBe(400)
        expect(yield* response.json).toMatchObject({
          kind: "client_outdated",
          message:
            "This client uses an older directory-routing protocol. Update Vector before accessing this workspace.",
        })
      }
    }),
  )

  it.live("selects workspaces from Vector headers with query precedence", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      const workspaceDir = path.join(dir, ".workspace-header")
      const workspace = yield* createLocalWorkspace({
        projectID: project.project.id,
        type: "header-target",
        directory: workspaceDir,
      })
      yield* serveProbe
      for (const header of ["x-vector-workspace"]) {
        const response = yield* HttpClientRequest.get("/probe").pipe(
          HttpClientRequest.setHeader(header, workspace.id),
          HttpClient.execute,
        )
        expect(response.status).toBe(200)
        expect(yield* response.json).toEqual({ directory: workspaceDir, workspaceID: workspace.id })
      }
      const preferred = yield* HttpClientRequest.get("/probe").pipe(
        HttpClientRequest.setHeaders({ "x-vector-workspace": workspace.id, "x-unrelated-workspace": "invalid" }),
        HttpClient.execute,
      )
      expect(preferred.status).toBe(200)
      const query = yield* HttpClientRequest.get(`/probe?workspace=${workspace.id}`).pipe(
        HttpClientRequest.setHeaders({ "x-vector-workspace": "invalid", "x-unrelated-workspace": "invalid" }),
        HttpClient.execute,
      )
      expect(query.status).toBe(200)
      const invalid = yield* HttpClientRequest.get("/api/probe").pipe(
        HttpClientRequest.setHeader("x-vector-workspace", "invalid"),
        HttpClient.execute,
      )
      expect(invalid.status).toBe(400)
    }),
  )

  it.live("routes local workspace requests through WorkspaceRouteContext", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)

      const workspaceDir = path.join(dir, ".workspace-local")
      const workspace = yield* createLocalWorkspace({
        projectID: project.project.id,
        type: "local-target",
        directory: workspaceDir,
      })

      yield* serveProbe

      // /probe is not a control-plane route, so selecting a local workspace
      // should swap the route context to the workspace target directory.
      const response = yield* HttpClient.get(`/probe?workspace=${workspace.id}`)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({
        directory: workspaceDir,
        workspaceID: workspace.id,
      })
    }),
  )
})
