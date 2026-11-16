import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { PublicSessionShare } from "@vectordevai/core/public-session-share"
import { PtyTicket } from "@vectordevai/core/pty/ticket"
import { Database } from "@vectordevai/core/database/database"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { ConnectHub } from "@/connect/hub"
import { ConnectOwner } from "@/connect/owner"
import { Workspace } from "@/control-plane/workspace"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { ServerAuth } from "@/server/auth"
import { SessionCompaction } from "@/session/compaction"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { SessionShare } from "@/share/session"
import { ShareNext } from "@/share/share-next"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { connectHandlers } from "@/server/routes/instance/httpapi/handlers/connect"
import { permissionHandlers } from "@/server/routes/instance/httpapi/handlers/permission"
import { sessionHandlers } from "@/server/routes/instance/httpapi/handlers/session"
import { Authorization, authorizationLayer } from "@/server/routes/instance/httpapi/middleware/authorization"
import {
  InstanceContextMiddleware,
  instanceContextLayer,
} from "@/server/routes/instance/httpapi/middleware/instance-context"
import { errorLayer } from "@/server/routes/instance/httpapi/middleware/error"
import { SchemaErrorMiddleware, schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
import {
  WorkspaceRoutingMiddleware,
  workspaceRoutingLayer,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { connectConsentMember } from "../fixture/connect-consent-member"

export const graph = AppNodeBuilderV1.build(
  LayerNode.group([
    ConnectOwner.node,
    Config.node,
    Database.node,
    SessionAudience.node,
    ShareNext.node,
    httpClient,
    Session.node,
    SessionShare.node,
    PublicSessionShare.node,
    SessionPrompt.node,
    SessionRevert.node,
    SessionCompaction.node,
    SessionRunState.node,
    Agent.node,
    Permission.node,
    SessionStatus.node,
    Todo.node,
    SessionSummary.node,
    EventV2Bridge.node,
    Provider.node,
    FreeModelGuests.node,
    InstanceStore.node,
    Workspace.node,
    PtyTicket.node,
  ]),
  [[ConnectHub.node, ConnectHub.nodeWith([connectConsentMember])]],
)

// Only the member is synthetic. These are the actual registered groups, handlers, middleware and owner state
// machine; the production assembly is exercised separately against its honest platform/model refusals.
const connect = InstanceHttpApi.groups.connect
const permission = InstanceHttpApi.groups.permission
const session = InstanceHttpApi.groups.session
if (connect.identifier !== "connect" || permission.identifier !== "permission" || session.identifier !== "session")
  throw new Error("The production Connect fixture groups are not registered")
// Seeding through the same handler lifetime avoids creating rows in a different scoped Database layer.
const seed = HttpApiGroup.make("fixture-seed")
  .add(HttpApiEndpoint.post("create", "/fixture/session", { payload: Schema.Struct({}), success: Session.Info }))
  .middleware(InstanceContextMiddleware)
  .middleware(WorkspaceRoutingMiddleware)
  .middleware(Authorization)
const api = HttpApi.make("vector-instance")
  .add(connect)
  .add(permission)
  .add(session)
  .add(seed)
  .middleware(SchemaErrorMiddleware)
const seedHandlers = HttpApiBuilder.group(api, "fixture-seed", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return handlers.handle("create", () => sessions.create({ title: "Connected review fixture" }))
  }),
)
export const routes = HttpApiBuilder.layer(api).pipe(
  Layer.provide([connectHandlers, permissionHandlers, sessionHandlers, seedHandlers]),
  Layer.provide([authorizationLayer, instanceContextLayer, workspaceRoutingLayer, schemaErrorLayer, errorLayer]),
  Layer.provide(ServerAuth.Config.layer),
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provide(HttpServer.layerServices),
  HttpRouter.provideRequest(graph),
  Layer.provide(graph),
)

export const consentHttpApiLayer = HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
