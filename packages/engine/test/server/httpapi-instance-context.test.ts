import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { registerAdapter } from "../../src/control-plane/adapters"
import { WorkspaceV2 } from "@vectordevai/core/workspace"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { PtyTicket } from "@vectordevai/core/pty/ticket"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { SessionAudience } from "@vectordevai/core/session/audience"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceRef, WorkspaceRef } from "../../src/effect/instance-ref"
import { Project } from "../../src/project/project"
import { Session } from "../../src/session/session"
import { disposeMiddleware, markInstanceForDisposal } from "../../src/server/routes/instance/httpapi/lifecycle"
import {
  InstanceContextMiddleware,
  instanceContextLayer,
} from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  workspaceRoutingLayer,
} from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { withFixedWorkspaceID } from "../fixture/flag"
import { workspaceLayerWithRuntimeFlags } from "../fixture/workspace"
import { waitGlobalBusEvent } from "./global-bus"
import { testEffect } from "../lib/effect"

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await disposeAllInstances()
        await resetDatabase()
      }),
    )
  }),
)

const workspaceLayer = workspaceLayerWithRuntimeFlags({ experimentalWorkspaces: true, experimentalConnect: false })

const it = testEffect(
  Layer.mergeAll(
    testStateLayer,
    NodeHttpServer.layerTest,
    NodeServices.layer,
    workspaceLayer,
    LayerNode.compile(PtyTicket.node),
    LayerNode.compile(FreeModelGuests.node),
    LayerNode.compile(SessionAudience.node),
  ),
)

const instanceContextTestLayer = Layer.mergeAll(
  instanceContextLayer,
  workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
)

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

const createLocalWorkspace = (input: { projectID: Project.Info["id"]; type: string; directory: string }) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      registerAdapter(input.projectID, input.type, localAdapter(input.directory))
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

const probeInstanceContext = Effect.gen(function* () {
  const instance = yield* InstanceRef
  const workspaceID = yield* WorkspaceRef
  return {
    directory: instance?.directory,
    worktree: instance?.worktree,
    projectID: instance?.project.id,
    workspaceID,
  }
})

const ProbeResult = Schema.Struct({
  directory: Schema.optional(Schema.String),
  worktree: Schema.optional(Schema.String),
  projectID: Schema.optional(Schema.String),
  workspaceID: Schema.optional(Schema.String),
})

const ProbeApi = HttpApi.make("instance-context-probe").add(
  HttpApiGroup.make("probe")
    .add(
      HttpApiEndpoint.get("get", "/probe", { query: WorkspaceRoutingQuery, success: ProbeResult }),
      HttpApiEndpoint.get("session", "/session", { query: WorkspaceRoutingQuery, success: ProbeResult }),
      HttpApiEndpoint.post("dispose", "/dispose-probe", {
        query: WorkspaceRoutingQuery,
        success: Schema.Boolean,
      }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware),
)

const probeHandlers = HttpApiBuilder.group(ProbeApi, "probe", (handlers) =>
  handlers
    .handle("get", () => probeInstanceContext)
    .handle("session", () => probeInstanceContext)
    .handle(
      "dispose",
      Effect.fn("InstanceContextProbe.dispose")(function* () {
        const instance = yield* InstanceRef
        if (!instance) return false
        yield* markInstanceForDisposal(instance)
        return true
      }),
    ),
)

const probeRoutes = HttpApiBuilder.layer(ProbeApi).pipe(
  Layer.provide(probeHandlers),
  Layer.provide(instanceContextTestLayer),
  Layer.provide(Layer.mock(Session.Service)({})),
)

const serveProbe = () => probeRoutes.pipe(HttpRouter.serve, Layer.build)

const waitDisposedEvent = waitGlobalBusEvent({
  message: "timed out waiting for instance disposal",
  predicate: (event) => event.payload.type === "server.instance.disposed",
}).pipe(Effect.map((event) => ({ directory: event.directory, workspace: event.workspace })))

const serveDisposeProbe = () =>
  HttpRouter.serve(probeRoutes, { middleware: disposeMiddleware, disableListenLog: true, disableLogger: true }).pipe(
    Layer.build,
  )

describe("HttpApi instance context middleware", () => {
  it.live("provides instance context from the routed directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      yield* serveProbe()

      const response = yield* HttpClient.get(`/probe?directory=${encodeURIComponent(dir)}`)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({
        directory: dir,
        worktree: dir,
        projectID: project.project.id,
        workspaceID: null,
      })
    }),
  )

  it.live("routes an existing literal-percent directory through the malformed header fallback and query", () =>
    Effect.gen(function* () {
      const dir = path.join(yield* tmpdirScoped({ git: true }), "%E0%A4%A")
      yield* Effect.promise(() => mkdir(dir))
      yield* serveProbe()

      // The header reaches decodeURIComponent's failure branch. URLSearchParams decodes the query once.
      const header = yield* HttpClientRequest.get("/probe").pipe(
        HttpClientRequest.setHeader("x-vector-directory", dir),
        HttpClient.execute,
      )
      const query = yield* HttpClient.get(`/probe?directory=${encodeURIComponent(dir)}`)

      expect(header.status).toBe(200)
      expect(yield* header.json).toMatchObject({ directory: dir })
      expect(query.status).toBe(200)
      expect(yield* query.json).toMatchObject({ directory: dir })
    }),
  )

  it.live("with Connect off, refuses a nonexistent raw directory after malformed header or query decoding", () =>
    Effect.gen(function* () {
      const missing = path.join(yield* tmpdirScoped({ git: true }), "%E0%A4%A")
      expect(
        yield* Effect.promise(() =>
          access(missing).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
      yield* serveProbe()

      const header = yield* HttpClientRequest.get("/probe").pipe(
        HttpClientRequest.setHeader("x-vector-directory", missing),
        HttpClient.execute,
      )
      const query = yield* HttpClient.get(`/probe?directory=${encodeURIComponent(missing)}`)

      expect(header.status).toBe(500)
      expect(query.status).toBe(500)
      expect(
        yield* Effect.promise(() =>
          access(missing).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
  )

  it.live("refuses an existing file before instance bootstrap without changing its literal-percent contents", () =>
    Effect.gen(function* () {
      const file = path.join(yield* tmpdirScoped({ git: true }), "%E0%A4%A")
      yield* Effect.promise(() => writeFile(file, "This is a file, not an instance directory.\n"))
      yield* serveProbe()
      const header = yield* HttpClientRequest.get("/probe").pipe(
        HttpClientRequest.setHeader("x-vector-directory", file),
        HttpClient.execute,
      )
      const query = yield* HttpClient.get(`/probe?directory=${encodeURIComponent(file)}`)
      expect(header.status).toBe(500)
      expect(query.status).toBe(500)
      expect(yield* Effect.promise(() => readFile(file, "utf8"))).toBe("This is a file, not an instance directory.\n")
    }),
  )

  it.live("provides selected workspace id on control-plane routes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      const workspaceDir = path.join(dir, ".workspace-local")
      const workspace = yield* createLocalWorkspace({
        projectID: project.project.id,
        type: "instance-context-workspace-ref",
        directory: workspaceDir,
      })
      yield* serveProbe()

      const response = yield* HttpClientRequest.get(`/session?workspace=${workspace.id}`).pipe(
        HttpClientRequest.setHeader("x-vector-directory", dir),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({
        directory: dir,
        workspaceID: workspace.id,
      })
    }),
  )

  it.live("uses workspace routing output instead of raw directory hints", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      const workspaceDir = path.join(dir, ".workspace-local")
      const workspace = yield* createLocalWorkspace({
        projectID: project.project.id,
        type: "instance-context-routing-output",
        directory: workspaceDir,
      })
      yield* serveProbe()

      const response = yield* HttpClientRequest.get(`/probe?workspace=${workspace.id}`).pipe(
        HttpClientRequest.setHeader("x-vector-directory", path.join(dir, "unavailable-raw-hint")),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({
        directory: workspaceDir,
        workspaceID: workspace.id,
      })
    }),
  )

  it.live("uses configured workspace id instead of routing to the requested workspace", () =>
    Effect.gen(function* () {
      const fixedWorkspaceID = WorkspaceV2.ID.ascending()
      yield* withFixedWorkspaceID(fixedWorkspaceID)

      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      const workspaceDir = path.join(dir, ".workspace-local")
      const workspace = yield* createLocalWorkspace({
        projectID: project.project.id,
        type: "instance-context-fixed-workspace-ref",
        directory: workspaceDir,
      })
      yield* serveProbe()

      const response = yield* HttpClientRequest.get(`/probe?workspace=${workspace.id}`).pipe(
        HttpClientRequest.setHeader("x-vector-directory", dir),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({
        directory: dir,
        workspaceID: fixedWorkspaceID,
      })
    }),
  )

  it.live("falls through to local instead of MissingWorkspace when configured workspace id is set", () =>
    Effect.gen(function* () {
      const fixedWorkspaceID = WorkspaceV2.ID.ascending()
      yield* withFixedWorkspaceID(fixedWorkspaceID)

      const dir = yield* tmpdirScoped({ git: true })
      yield* Project.use.fromDirectory(dir)
      yield* serveProbe()

      // Reference a workspace id that is not registered locally. Without the
      // configured env override, this would short-circuit to a 500
      // MissingWorkspace response. With the env set, planRequest must skip the
      // MissingWorkspace branch and fall through to Local with the configured
      // workspace id.
      const unknownWorkspaceID = WorkspaceV2.ID.ascending()
      const response = yield* HttpClientRequest.get(`/probe?workspace=${unknownWorkspaceID}`).pipe(
        HttpClientRequest.setHeader("x-vector-directory", dir),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({
        directory: dir,
        workspaceID: fixedWorkspaceID,
      })
    }),
  )

  it.live("keeps configured workspace id on control-plane routes without remote routing", () =>
    Effect.gen(function* () {
      const fixedWorkspaceID = WorkspaceV2.ID.ascending()
      yield* withFixedWorkspaceID(fixedWorkspaceID)

      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      const workspaceDir = path.join(dir, ".workspace-local")
      const workspace = yield* createLocalWorkspace({
        projectID: project.project.id,
        type: "instance-context-fixed-workspace-control-plane",
        directory: workspaceDir,
      })
      // /session is matched by isLocalWorkspaceRoute, so shouldStayOnControlPlane
      // is true. Combined with the env override, the route must stay Local with
      // the configured workspace id (not divert to the requested workspace's
      // local directory).
      yield* serveProbe()

      const response = yield* HttpClientRequest.get(`/session?workspace=${workspace.id}`).pipe(
        HttpClientRequest.setHeader("x-vector-directory", dir),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({
        directory: dir,
        workspaceID: fixedWorkspaceID,
      })
    }),
  )

  it.live("preserves selected workspace id on instance disposal events", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      const workspaceDir = path.join(dir, ".workspace-local")
      const workspace = yield* createLocalWorkspace({
        projectID: project.project.id,
        type: "instance-context-dispose-event",
        directory: workspaceDir,
      })
      yield* serveDisposeProbe()
      const disposed = yield* waitDisposedEvent.pipe(Effect.forkScoped({ startImmediately: true }))

      const response = yield* HttpClientRequest.post(`/dispose-probe?workspace=${workspace.id}`).pipe(
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toBe(true)
      expect(yield* Fiber.join(disposed)).toEqual({ directory: workspaceDir, workspace: workspace.id })
    }),
  )
})
