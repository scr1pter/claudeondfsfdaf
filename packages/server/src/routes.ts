import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { EventV2 } from "@vectordevai/core/event"
import { Credential } from "@vectordevai/core/credential"
import { PermissionSaved } from "@vectordevai/core/permission/saved"
import { PtyTicket } from "@vectordevai/core/pty/ticket"
import { SessionV2 } from "@vectordevai/core/session"
import { SessionExecution } from "@vectordevai/core/session/execution"
import { LocationServiceMap } from "@vectordevai/core/location-service-map"
import { SessionExecutionLocal } from "@vectordevai/core/session/execution/local"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { AppProcess } from "@vectordevai/core/process"
import { FreeModels } from "@vectordevai/core/free-models"
import { ToolOutputStore } from "@vectordevai/core/tool-output-store"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Layer, Option } from "effect"
import { Api } from "./api"
import { ServerAuth } from "./auth"
import { handlers } from "./handlers"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"
import { PtyEnvironment } from "./pty-environment"
import { layer as locationLayer } from "./location"
import { sessionLocationLayer } from "./middleware/session-location"
import { requestGuardLayer } from "./middleware/request-guard"

const applicationServices = LayerNode.group([
  Database.node,
  EventV2.node,
  httpClient,
  ToolOutputStore.cleanupNode,
  SessionV2.node,
  PermissionSaved.node,
  PtyTicket.node,
  Credential.node,
  PtyEnvironment.node,
  LocationServiceMap.node,
  SpendGuard.node,
  FreeModelGuests.node,
  SessionAudience.node,
  AppProcess.node,
  // The session handler reads the shared free-model catalog to keep a guest off models that may train.
  FreeModels.node,
])

export function createRoutes(password?: string, options?: { readonly guardedHostname?: string }) {
  return makeRoutes(
    password
      ? ServerAuth.Config.configLayer({ username: "vector", password: Option.some(password) })
      : ServerAuth.Config.layer,
    options,
  )
}

export function createEmbeddedRoutes() {
  return makeRoutes(ServerAuth.Config.configLayer({ username: "vector", password: Option.none() }))
}

function makeRoutes<AuthError, AuthServices>(
  auth: Layer.Layer<ServerAuth.Config, AuthError, AuthServices>,
  options?: { readonly guardedHostname?: string },
) {
  const serviceLayer = AppNodeBuilder.build(applicationServices, [[SessionExecution.node, SessionExecutionLocal.node]])

  return HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(handlers),
    Layer.provide(sessionLocationLayer),
    Layer.provide(locationLayer),
    Layer.provide(authorizationLayer),
    Layer.provide(schemaErrorLayer),
    Layer.provide(requestGuardLayer(options)),
    Layer.provide(auth),
    Layer.provide(serviceLayer),
  )
}

export const routes = createRoutes()

export const webHandler = () =>
  HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true })
