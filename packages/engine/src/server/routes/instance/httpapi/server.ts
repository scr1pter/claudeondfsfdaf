import { registerRuntimeCleanup } from "@/effect/runtime-cleanup"
import { PublicSessionShare } from "@vectordevai/core/public-session-share"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { AppProcess } from "@vectordevai/core/process"
import { Config as EffectConfig, Context, Effect, Layer } from "effect"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { HttpClient, HttpMiddleware, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { FSUtil } from "@vectordevai/core/fs-util"
import * as Observability from "@vectordevai/core/observability"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { BackgroundJob } from "@/background/job"
import { TaskManager } from "@/task/manager"
import { WorkflowOwner } from "@/orchestration/owner"
import { TaskNotify } from "@/task/notify"
import { TaskLimits } from "@/task/limits"
import { TaskRecovery } from "@/task/recovery"
import { TaskAttention } from "@/task/attention"
import { TaskSignals } from "@/task/signals"
import { DesktopTasks } from "@/task/desktop"
import { Command } from "@/command"
import { ComputerAvailability } from "@/computer/availability"
import { ComputerPrune } from "@/computer/prune"
import { ComputerProtection } from "@/computer/protection"
import { Config } from "@/config/config"
import { Workspace } from "@/control-plane/workspace"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { Git } from "@/git"
import { Installation } from "@/installation"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { PluginPtyEnvironment } from "@/plugin/pty-environment"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { ProviderAuth } from "@/provider/auth"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { SessionCompaction } from "@/session/compaction"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionDistill } from "@/session/distill"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { SessionShare } from "@/share/session"
import { ShareNext } from "@/share/share-next"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Worktree } from "@/worktree"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MoveSession } from "@vectordevai/core/control-plane/move-session"
import { Database } from "@vectordevai/core/database/database"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { EventV2 } from "@vectordevai/core/event"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainEmbed } from "@vectordevai/core/brain/embed"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { BrainWorkflow } from "@vectordevai/core/brain/workflow"
import { LearnedSkill } from "@/skill/learned"
import { ResearchStore } from "@vectordevai/core/research/store"
import { LocalProbe } from "@vectordevai/core/local-mode/probe"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { Npm } from "@vectordevai/core/npm"
import { PermissionSaved } from "@vectordevai/core/permission/saved"
import { ProjectV2 } from "@vectordevai/core/project"
import { ProjectCopy } from "@vectordevai/core/project/copy"
import { PtyTicket } from "@vectordevai/core/pty/ticket"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { SessionV2 } from "@vectordevai/core/session"
import { SessionExecution } from "@vectordevai/core/session/execution"
import * as SessionExecutionLocal from "@vectordevai/core/session/execution/local"
import { lazy } from "@/util/lazy"
import { CorsConfig, isAllowedCorsOrigin, type CorsOptions } from "@vectordevai/server/cors"
import { serveUIEffect } from "@/server/shared/ui"
import { ServerAuth } from "@/server/auth"
import { InstanceHttpApi, RootHttpApi } from "./api"
import { Api } from "@vectordevai/server/api"
import { PublicApi } from "./public"
import {
  authorizationLayer,
  authorizationRouterMiddleware,
  ptyConnectAuthorizationLayer,
  serverAuthorizationLayer,
} from "./middleware/authorization"
import { EventApi } from "./groups/event"
import { PtyConnectApi } from "./groups/pty"
import { eventHandlers } from "./handlers/event"
import { configHandlers } from "./handlers/config"
import { computerHandlers } from "./handlers/computer"
import { controlHandlers } from "./handlers/control"
import { controlPlaneHandlers } from "./handlers/control-plane"
import { experimentalHandlers } from "./handlers/experimental"
import { teamsHandlers } from "./handlers/teams"
import { Teams } from "@vectordevai/core/teams"
import { VectorTeams } from "@/teams"
import { fileHandlers } from "./handlers/file"
import { globalHandlers } from "./handlers/global"
import { instanceHandlers } from "./handlers/instance"
import { localHandlers } from "./handlers/local"
import { mcpHandlers } from "./handlers/mcp"
import { memoryHandlers } from "./handlers/memory"
import { permissionHandlers } from "./handlers/permission"
import { projectHandlers } from "./handlers/project"
import { projectCopyHandlers } from "./handlers/project-copy"
import { providerHandlers } from "./handlers/provider"
import { FreeModels } from "@vectordevai/core/free-models"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { ptyConnectHandlers, ptyHandlers } from "./handlers/pty"
import { questionHandlers } from "./handlers/question"
import { sessionHandlers } from "./handlers/session"
import { syncHandlers } from "./handlers/sync"
import { tuiHandlers } from "./handlers/tui"
import { handlers } from "@vectordevai/server/handlers"
import { buildLocationServiceMap, LocationServiceMap } from "@vectordevai/core/location-services"
import { layer as locationLayer } from "@vectordevai/server/location"
import { sessionLocationLayer } from "@vectordevai/server/middleware/session-location"
import { PtyEnvironment } from "@vectordevai/server/pty-environment"
import { schemaErrorLayer as v2SchemaErrorLayer } from "@vectordevai/server/middleware/schema-error"
import { workspaceHandlers } from "./handlers/workspace"
import { instanceContextLayer } from "./middleware/instance-context"
import { workspaceRoutingLayer } from "./middleware/workspace-routing"
import { disposeMiddleware } from "./lifecycle"
import { memoMap } from "@vectordevai/core/effect/memo-map"
import { compressionLayer } from "./middleware/compression"
import { corsVaryFix } from "./middleware/cors-vary"
import { errorLayer } from "./middleware/error"
import { fenceLayer } from "./middleware/fence"
import { hostGuardLayer } from "./middleware/host"
import { schemaErrorLayer } from "./middleware/schema-error"
import { requestGuardLayer } from "@vectordevai/server/middleware/request-guard"

export const context = Context.makeUnsafe<unknown>(new Map())

const cors = (corsOptions?: CorsOptions) =>
  HttpRouter.middleware(
    HttpMiddleware.cors({
      allowedOrigins: (origin) => isAllowedCorsOrigin(origin, corsOptions),
      maxAge: 86_400,
    }),
    { global: true },
  )

// Route tree:
// - rootApiRoutes: typed /global/* and control routes; auth is declared by RootHttpApi.
// - eventApiRoutes: typed SSE route with instance routing context and its existing API contract.
// - ptyConnectApiRoutes: typed WebSocket upgrade route with ticket-aware auth.
// - instanceApiRoutes: remaining typed instance routes.
// - uiRoute: public raw catch-all fallback; app-managed credentials authenticate API requests.
const authOnlyRouterLayer = authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.layer))
const httpApiAuthLayer = authorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer))
const ptyConnectHttpApiAuthLayer = ptyConnectAuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer))
const serverHttpApiAuthLayer = serverAuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer))
const workspaceRoutingLive = workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))
const rootApiRoutes = HttpApiBuilder.layer(RootHttpApi).pipe(
  Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, teamsHandlers]),
  Layer.provide(schemaErrorLayer),
  Layer.provide(httpApiAuthLayer),
)
const eventApiRoutes = HttpApiBuilder.layer(EventApi).pipe(
  Layer.provide(eventHandlers),
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
)
const ptyConnectApiRoutes = HttpApiBuilder.layer(PtyConnectApi).pipe(
  Layer.provide(ptyConnectHandlers),
  Layer.provide([ptyConnectHttpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
)
const instanceApiRoutes = HttpApiBuilder.layer(InstanceHttpApi).pipe(
  Layer.provide([
    computerHandlers,
    configHandlers,
    experimentalHandlers,
    fileHandlers,
    instanceHandlers,
    localHandlers,
    mcpHandlers,
    memoryHandlers,
    projectHandlers,
    projectCopyHandlers,
    ptyHandlers,
    questionHandlers,
    permissionHandlers,
    providerHandlers,
    sessionHandlers,
    syncHandlers,
    tuiHandlers,
    workspaceHandlers,
  ]),
)

const instanceRoutes = instanceApiRoutes.pipe(
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer, schemaErrorLayer]),
)
const serverRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(handlers),
  Layer.provide(PluginPtyEnvironment.layer),
  Layer.provide([serverHttpApiAuthLayer, v2SchemaErrorLayer]),
)

// `OpenApi.fromApi` is non-trivial; defer until /doc is actually hit so
// processes that never serve it (CLI, scripts) don't pay at module load.
// `HttpServerResponse.jsonUnsafe` runs JSON.stringify eagerly, so caching
// the response also caches the serialized body — every /doc request reuses
// the same Uint8Array instead of re-stringifying the spec.
const docResponse = lazy(() => HttpServerResponse.jsonUnsafe(OpenApi.fromApi(PublicApi)))

const docRoute = HttpRouter.use((router) => router.add("GET", "/doc", () => Effect.succeed(docResponse()))).pipe(
  Layer.provide(authOnlyRouterLayer),
)

const uiRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const client = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service
    yield* router.add("GET", "/*", (request) =>
      serveUIEffect(request, { fs, client, disableEmbeddedWebUi: flags.disableEmbeddedWebUi }),
    )
  }),
)

type RouteRequirements =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>
  | HttpRouter.Request<"Requires", unknown>
  | HttpRouter.Request<"GlobalRequires", never>

const app = LayerNode.group([
  Npm.node,
  FSUtil.node,
  Database.node,
  ComputerPrune.node,
  ComputerProtection.node,
  Auth.node,
  Teams.node,
  Config.node,
  Env.node,
  Git.node,
  Ripgrep.node,
  Storage.node,
  Snapshot.node,
  Plugin.node,
  ModelCatalog.node,
  FreeModels.node,
  // The control routes read the Vector account's Codium models when its credential is written.
  FreeModels.credentialsNode,
  ModelPlans.node,
  FreeModelGuests.node,
  SessionAudience.node,
  // The server package's filesystem routes probe Git metadata before a guest read.
  AppProcess.node,
  Brain.node,
  BrainKnowledge.node,
  BrainSkill.node,
  BrainWorkflow.node,
  LearnedSkill.node,
  BrainEmbed.node,
  ResearchStore.node,
  LocalProbe.holdsNode,
  Provider.node,
  ProviderAuth.node,
  Agent.node,
  Skill.node,
  Discovery.node,
  Question.node,
  Permission.node,
  PermissionSaved.node,
  Todo.node,
  Session.node,
  SessionProjector.node,
  SessionStatus.node,
  BackgroundJob.node,
  TaskManager.node,
  WorkflowOwner.node,
  TaskNotify.node,
  TaskLimits.node,
  TaskRecovery.node,
  TaskAttention.node,
  TaskSignals.node,
  DesktopTasks.node,
  RuntimeFlags.node,
  EventV2Bridge.node,
  SessionRunState.node,
  SessionProcessor.node,
  SessionCompaction.node,
  SessionRevert.node,
  SessionSummary.node,
  SessionPrompt.node,
  SessionDistill.node,
  Instruction.node,
  LLM.node,
  LSP.node,
  MCP.node,
  McpAuth.node,
  Command.node,
  Truncate.node,
  ToolRegistry.node,
  ComputerAvailability.node,
  Format.node,
  Project.node,
  Vcs.node,
  Workspace.node,
  Worktree.node,
  Installation.node,
  ShareNext.node,
  SessionShare.node,
  PublicSessionShare.node,
  InstanceStore.node,
  httpClient,
  EventV2.node,
  ProjectV2.node,
  ProjectCopy.node,
  PtyTicket.node,
  SpendGuard.node,
])

export function createRoutes(
  corsOptions?: CorsOptions & { readonly guardedHostname?: string },
): Layer.Layer<never, EffectConfig.ConfigError, RouteRequirements> {
  const locationServiceMapV2 = buildLocationServiceMap([[Teams.node, VectorTeams.node]])

  return Layer.mergeAll(
    rootApiRoutes,
    eventApiRoutes,
    ptyConnectApiRoutes,
    instanceRoutes,
    serverRoutes,
    docRoute,
    uiRoute,
  ).pipe(
    Layer.provide([
      errorLayer,
      compressionLayer,
      corsVaryFix,
      fenceLayer,
      cors(corsOptions),
      requestGuardLayer(corsOptions).pipe(Layer.provide(ServerAuth.Config.layer)),
      ...(corsOptions?.guardedHostname === undefined ? [] : [hostGuardLayer(corsOptions.guardedHostname)]),
      AppNodeBuilderV1.build(MoveSession.node, [[LocationServiceMap.node, locationServiceMapV2]]),
      HttpServer.layerServices,
    ]),
    Layer.provide(Layer.succeed(CorsConfig)(corsOptions)),
    Layer.provideMerge(Observability.layer),

    Layer.provide(sessionLocationLayer),
    Layer.provide(locationLayer),
    Layer.provide(PtyEnvironment.layer),
    Layer.provide(
      AppNodeBuilderV1.build(SessionV2.node, [
        [LocationServiceMap.node, locationServiceMapV2],
        [SessionExecution.node, SessionExecutionLocal.node],
      ]),
    ),
    Layer.provide(locationServiceMapV2),

    Layer.provide(AppNodeBuilderV1.build(app)),
  )
}

export const routes = createRoutes()

export const webHandler = lazy(() => {
  const handler = HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    memoMap,
    middleware: disposeMiddleware,
  })
  registerRuntimeCleanup(() => handler.dispose())
  return handler
})

export * as HttpApiApp from "./server"
