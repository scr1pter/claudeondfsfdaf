import { NodeHttpServer } from "@effect/platform-node"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerRequest } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { BackgroundJob } from "@vectordevai/core/background-job"
import { ProjectV2 } from "@vectordevai/core/project"
import { RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
import type { Task } from "@vectordevai/schema/task"
import { Agent } from "@/agent/agent"
import { ComputerAvailability } from "@/computer/availability"
import { MCP } from "@/mcp"
import { Project } from "@/project/project"
import { ToolRegistry } from "@/tool/registry"
import { Worktree } from "@/worktree"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { TaskManager } from "@/task/manager"
import { DesktopTasks } from "@/task/desktop"
import { SessionID } from "@/session/schema"
import { ExperimentalApi } from "@/server/routes/instance/httpapi/groups/experimental"
import { experimentalHandlers } from "@/server/routes/instance/httpapi/handlers/experimental"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { testEffect } from "../lib/effect"

// POST /experimental/session/:sessionID/stop, "Stop including helpers" (5.D.1): what the route takes, whom it lets
// in, and what it returns. TaskManager.interrupt itself is tested in tool/task-manage.test.ts.

const sessionID = SessionID.make("ses_session_stop")
const stopped: Task.Info = {
  id: "ses_session_stop_child",
  sessionID: "ses_session_stop_child",
  parentSessionID: sessionID,
  source: "subagent",
  title: "Verify a component",
  status: "stopped",
  startedAt: 1,
  completedAt: 2,
  elapsedMs: 1,
  ownedPaths: [],
  dependsOn: [],
  resultAvailable: false,
  reason: "Stopped with the main agent; partial work was kept.",
  attempt: 1,
  controls: { inspect: true, message: false, stop: false },
  isolation: { mode: "worktree", state: "active", directory: "/private/helper-worktree" },
}
const calls: Array<{ sessionID: string; helpers: boolean; reason?: string }> = []

// A request with an `x-test-guest` header runs as a guest in control of the sessions it lists.
const authorization = Authorization.of((effect) =>
  Effect.gen(function* () {
    const claims = (yield* HttpServerRequest.HttpServerRequest).headers["x-test-guest"]
    if (claims === undefined) return yield* effect
    return yield* effect.pipe(
      Effect.provideService(RequestPrincipal, {
        kind: "guest",
        username: "guest",
        workspaceIDs: new Set<string>(),
        workspaceDirectories: new Map<string, string>(),
        sessionIDs: new Set(claims.split(",").filter(Boolean)),
      }),
    )
  }),
)

const api = HttpApi.make("vector-instance").addHttpApi(ExperimentalApi)
const it = testEffect(
  HttpRouter.serve(
    HttpApiBuilder.layer(api).pipe(
      Layer.provide(experimentalHandlers),
      Layer.provide([
        schemaErrorLayer,
        Layer.succeed(Authorization, authorization),
        Layer.succeed(
          InstanceContextMiddleware,
          InstanceContextMiddleware.of((effect) => effect),
        ),
        Layer.succeed(
          WorkspaceRoutingMiddleware,
          WorkspaceRoutingMiddleware.of((effect) =>
            effect.pipe(Effect.provideService(WorkspaceRouteContext, { directory: process.cwd() })),
          ),
        ),
        RuntimeFlags.layer({ backgroundSubagents: true }),
        // Capabilities read the default agent's permissions for the `workflows` flag (WP32).
        Layer.mock(Agent.Service)({
          defaultInfo: () => Effect.succeed({ name: "build", mode: "primary", permission: [], options: {} }),
        }),
        // The capabilities route also reports that this HTTP-only fixture has no desktop bridge.
        Layer.mock(ComputerAvailability.Service)({
          capabilities: () => Effect.succeed({ available: false, reason: "desktop" }),
        }),
        // These unrelated experimental endpoints are never called by this test.
        Layer.mock(MCP.Service)({}),
        Layer.mock(Project.Service)({}),
        Layer.mock(ToolRegistry.Service)({}),
        Layer.mock(Worktree.Service)({}),
        Layer.mock(SessionPrompt.Service)({}),
        Layer.mock(DesktopTasks.Service)({}),
        Layer.mock(TaskManager.Service)({
          interrupt: (input) =>
            Effect.gen(function* () {
              calls.push({ ...input })
              if (input.sessionID !== sessionID)
                return yield* new TaskManager.Error({ code: "not_found", message: "Session was not found." })
              return {
                aborted: true,
                tasks: input.helpers ? [stopped] : [],
                shells: 0,
                excluded: input.helpers ? 1 : 0,
                skipped: 0,
              }
            }),
          // The session background route reaches promote (5.D.2); this file checks only who may call it.
          promote: () => Effect.succeed({ tasks: [] }),
        }),
        Layer.mock(Session.Service)({
          get: () =>
            Effect.succeed({
              id: sessionID,
              slug: "test",
              projectID: ProjectV2.ID.make("project_test"),
              directory: process.cwd(),
              title: "test",
              version: "test",
              time: { created: 1, updated: 1 },
            }),
        }),
      ]),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(Layer.effect(BackgroundJob.Service, BackgroundJob.make)),
    // Handlers read the audience per request. No conversation here is owner-only; the mocked sessions count as known.
    Layer.provide(
      Layer.mock(SessionAudience.Service)({
        knows: () => Effect.succeed(true),
        isPrivate: () => Effect.succeed(false),
      }),
    ),
  ),
)

const stop = (body: unknown, headers: Record<string, string> = {}, id: string = sessionID) =>
  HttpClientRequest.post(`/experimental/session/${id}/stop`).pipe(
    HttpClientRequest.setHeaders(headers),
    HttpClientRequest.bodyJsonUnsafe(body),
    HttpClient.execute,
  )

it.live("stops the main turn and its helpers and returns what the stop reached", () =>
  Effect.gen(function* () {
    calls.length = 0
    const response = yield* stop({ helpers: true, reason: "The user changed direction" })
    expect(response.status).toBe(200)
    // The owner sees a helper's worktree directory, as on the task board.
    expect(yield* response.json).toEqual({ aborted: true, tasks: [stopped], shells: 0, excluded: 1, skipped: 0 })
    expect(calls).toEqual([{ sessionID, helpers: true, reason: "The user changed direction" }])

    const main = yield* stop({ helpers: false })
    expect(main.status).toBe(200)
    expect(yield* main.json).toEqual({ aborted: true, tasks: [], shells: 0, excluded: 0, skipped: 0 })
    expect(calls[1]).toEqual({ sessionID, helpers: false })
  }),
)

it.live("refuses a malformed request before stopping anything", () =>
  Effect.gen(function* () {
    calls.length = 0
    expect((yield* stop({})).status).toBe(400)
    expect((yield* stop({ helpers: "yes" })).status).toBe(400)
    expect((yield* stop({ helpers: true, reason: "x".repeat(1001) })).status).toBe(400)
    expect(calls).toEqual([])
    // A session the manager does not know answers with its task error.
    const missing = yield* stop({ helpers: true }, {}, "ses_session_stop_missing")
    expect(missing.status).toBe(400)
    expect(yield* missing.json).toMatchObject({ code: "not_found" })
  }),
)

it.live("a guest stops or backgrounds only a session it controls", () =>
  Effect.gen(function* () {
    calls.length = 0
    expect((yield* stop({ helpers: true }, { "x-test-guest": "" })).status).toBe(403)
    const background = (claims: string) =>
      HttpClientRequest.post(`/experimental/session/${sessionID}/background`).pipe(
        HttpClientRequest.setHeaders({ "x-test-guest": claims }),
        HttpClient.execute,
      )
    expect((yield* background("")).status).toBe(403)
    expect(calls).toEqual([])

    const controlled = yield* stop({ helpers: true }, { "x-test-guest": sessionID })
    expect(controlled.status).toBe(200)
    // Control lets the guest stop the session, but a controlling guest is still a guest: an isolated helper's
    // directory goes only to the authenticated owner (WP28).
    expect(((yield* controlled.json) as { tasks: Task.Info[] }).tasks).toEqual([
      { ...stopped, isolation: { mode: "worktree", state: "active" } },
    ])
    expect((yield* background(sessionID)).status).toBe(200)
  }),
)

it.live("capabilities report the stop route", () =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.get("/experimental/capabilities").pipe(HttpClient.execute)
    expect(response.status).toBe(200)
    expect(yield* response.json).toMatchObject({ sessionStop: true, vectorscopeSettings: true })
  }),
)
