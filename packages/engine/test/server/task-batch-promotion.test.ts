import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { BackgroundJob } from "@vectordevai/core/background-job"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import type { Task } from "@vectordevai/schema/task"
import { Agent } from "@/agent/agent"
import { ComputerAvailability } from "@/computer/availability"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Project } from "@/project/project"
import { Question } from "@/question"
import { ToolRegistry } from "@/tool/registry"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { Worktree } from "@/worktree"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { TaskManager } from "@/task/manager"
import { TaskIsolation } from "@/task/isolation"
import { TaskLimits } from "@/task/limits"
import { TaskNotify } from "@/task/notify"
import { TaskSignals } from "@/task/signals"
import { DesktopTasks } from "@/task/desktop"
import { SessionFork } from "@/session/fork"
import { Provider } from "@/provider/provider"
import { MessageID, type SessionID } from "@/session/schema"
import { ExperimentalApi } from "@/server/routes/instance/httpapi/groups/experimental"
import { experimentalHandlers } from "@/server/routes/instance/httpapi/handlers/experimental"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Move to background (5.D.2) over HTTP: POST …/tasks/background and the older POST …/background both reach
// TaskManager.promote, which moves a root session's running foreground subagents, batch entries included.

afterEach(disposeAllInstances)

const jobs = Layer.effect(BackgroundJob.Service, BackgroundJob.make)
const stored = LayerNode.compile(LayerNode.group([Session.node, Database.node, SessionAudience.node]))
const flags = RuntimeFlags.layer({ backgroundSubagents: true })
// The real TaskManager over this file's job registry; what promoting does not read is stubbed.
const manager = (
  TaskManager.node.implementation as Layer.Layer<
    TaskManager.Service,
    never,
    | Session.Service
    | BackgroundJob.Service
    | SessionStatus.Service
    | Permission.Service
    | Question.Service
    | Database.Service
    | SpendGuard.Service
    | DesktopTasks.Service
    | TaskLimits.Service
    | Config.Service
    | FreeModelGuests.Service
    | BackgroundJobStore.Service
    | TaskNotify.Service
    | TaskSignals.Service
    | RuntimeFlags.Service
    | SessionFork.Service
    | Provider.Service
    | Agent.Service
    | TaskIsolation.Service
    | SessionAudience.Service
  >
).pipe(
  Layer.provide([
    // None of these helpers is isolated.
    Layer.mock(TaskIsolation.Service)({ find: () => Effect.succeed(undefined) }),
    Layer.mock(SessionFork.Service)({}),
    Layer.mock(Provider.Service)({}),
    Layer.mock(Agent.Service)({}),
    jobs,
    flags,
    stored,
    Layer.mock(SessionStatus.Service)({ get: () => Effect.succeed({ type: "busy" as const }) }),
    Layer.mock(Permission.Service)({ list: () => Effect.succeed([]) }),
    Layer.mock(Question.Service)({ list: () => Effect.succeed([]) }),
    Layer.mock(SpendGuard.Service)({ scopes: () => Effect.succeed([]) }),
    Layer.mock(DesktopTasks.Service)({}),
    Layer.mock(TaskLimits.Service)({}),
    Layer.mock(Config.Service)({}),
    Layer.mock(FreeModelGuests.Service)({}),
    Layer.mock(BackgroundJobStore.Service)({}),
    Layer.mock(TaskNotify.Service)({}),
    Layer.mock(TaskSignals.Service)({}),
  ]),
)
const api = HttpApi.make("vector-instance").addHttpApi(ExperimentalApi)
const it = testEffect(
  HttpRouter.serve(
    HttpApiBuilder.layer(api).pipe(
      Layer.provide(experimentalHandlers),
      Layer.provide([
        schemaErrorLayer,
        Layer.succeed(
          Authorization,
          Authorization.of((effect) => effect),
        ),
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
        flags,
        manager,
        stored,
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
      ]),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(jobs), Layer.provideMerge(stored)),
)

const model = { providerID: ProviderV2.ID.make("local-test"), modelID: ModelV2.ID.make("fixture") }

// A two-entry foreground batch under `parentID`, as the task tool starts one: each entry a running, promotable job.
const batch = Effect.fn("TaskBatchPromotionTest.batch")(function* (parentID: SessionID) {
  const sessions = yield* Session.Service
  const background = yield* BackgroundJob.Service
  const parentMessageID = MessageID.ascending()
  return yield* Effect.forEach([0, 1], (batchIndex) =>
    Effect.gen(function* () {
      const child = yield* sessions.create({
        parentID,
        metadata: {
          [SubagentLifecycle.METADATA_KEY]: {
            kind: "subagent",
            custom: false,
            agent: "general",
            title: `Entry ${batchIndex}`,
            parentSessionID: parentID,
            parentMessageID,
            batchID: `${parentID}:call_batch`,
            batchIndex,
            model,
            background: false,
            status: "running",
            startedAt: Date.now(),
            runtimeID: SubagentLifecycle.RUNTIME_ID,
            attempt: 1,
          },
        },
      })
      yield* background.start({
        id: child.id,
        type: "task",
        title: `Entry ${batchIndex}`,
        metadata: { parentSessionId: parentID, sessionId: child.id, batchIndex },
        run: Effect.never,
      })
      return child.id
    }),
  )
})

const post = (path: string, body?: unknown) => {
  const request = HttpClientRequest.post(path)
  return HttpClient.execute(body === undefined ? request : HttpClientRequest.bodyJsonUnsafe(request, body))
}
const moved = (sessionID: string, body?: unknown) =>
  post(`/experimental/session/${sessionID}/tasks/background`, body).pipe(
    Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
    Effect.flatMap((response) => response.json),
    Effect.map((value) => (value as Task.PromoteResult).tasks.map((task) => task.id).toSorted()),
  )
const legacy = (sessionID: string) => post(`/experimental/session/${sessionID}/background`)

it.instance("the task background route moves every entry of a running batch, or the ones it names", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const root = yield* sessions.create({ title: "Batch owner" })
    const [first, second] = yield* batch(root.id)
    expect(yield* moved(root.id, { taskIDs: [second] })).toEqual([second])
    expect((yield* background.get(first))?.metadata?.background).not.toBe(true)
    // The SDK sends no body when no task is named.
    expect(yield* moved(root.id)).toEqual([first])
    for (const id of [first, second]) {
      expect((yield* background.get(id))?.metadata?.background).toBe(true)
      expect(SubagentLifecycle.read(yield* sessions.get(id))?.status).toBe("running")
    }
    // Nothing is left in the foreground.
    expect(yield* moved(root.id, {})).toEqual([])
  }),
)

it.instance("the older session background route moves a batch's entries too", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const root = yield* sessions.create({ title: "Batch owner" })
    const entries = yield* batch(root.id)
    const response = yield* legacy(root.id)
    expect(response.status).toBe(200)
    expect(yield* response.json).toBe(true)
    for (const id of entries) expect((yield* background.get(id))?.metadata?.background).toBe(true)
    expect(yield* (yield* legacy(root.id)).json).toBe(false)
  }),
)

it.instance("a subagent's own batch stays in the foreground", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const root = yield* sessions.create({ title: "Batch owner" })
    const [lead] = yield* batch(root.id)
    const entries = yield* batch(lead)
    expect(yield* moved(lead)).toEqual([])
    expect(yield* (yield* legacy(lead)).json).toBe(false)
    for (const id of entries) expect((yield* background.get(id))?.metadata?.background).not.toBe(true)
  }),
)

it.instance("refuses a malformed request and answers a missing session", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const root = yield* sessions.create({ title: "Batch owner" })
    expect((yield* post(`/experimental/session/${root.id}/tasks/background`, { taskIDs: [] })).status).toBe(400)
    expect((yield* post(`/experimental/session/${root.id}/tasks/background`, { taskIDs: "all" })).status).toBe(400)
    const missing = yield* post("/experimental/session/ses_task_batch_missing/tasks/background", {})
    expect(missing.status).toBe(400)
    expect(yield* missing.json).toMatchObject({ code: "not_found" })
    const old = yield* legacy("ses_task_batch_missing")
    expect(old.status).toBe(200)
    expect(yield* old.json).toBe(false)
  }),
)

it.live("capabilities report the task background route", () =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.get("/experimental/capabilities").pipe(HttpClient.execute)
    expect(response.status).toBe(200)
    expect(yield* response.json).toMatchObject({ taskPromote: true })
  }),
)
