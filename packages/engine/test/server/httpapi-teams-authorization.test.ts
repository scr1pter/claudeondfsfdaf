import { NodeHttpServer } from "@effect/platform-node"
import { MoveSession } from "@vectordevai/core/control-plane/move-session"
import { buildLocationServiceMap } from "@vectordevai/core/location-services"
import { Teams } from "@vectordevai/core/teams"
import { ID } from "@vectordevai/schema/teams"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { FreeModels } from "@vectordevai/core/free-models"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { InstanceStore } from "../../src/project/instance-store"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { teamsHandlers } from "../../src/server/routes/instance/httpapi/handlers/teams"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

const accountID = "10000000-0000-4000-8000-000000000001"
const orgID = ID.make("20000000-0000-4000-8000-000000000002")
const status: Teams.TeamsStatus = {
  enabled: true,
  account: { id: accountID, email: "owner@example.com" },
  orgs: [{ id: orgID, name: "Owner organization", role: "owner" }],
  active: { id: orgID, name: "Owner organization", revision: 1, config: {} },
}

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, teamsHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(FreeModels.CredentialsService)({})),
  Layer.provide(
    Layer.mock(ModelPlans.Service)({ request: () => Promise.reject(new Error("No Codium gateway in this test")) }),
  ),
  Layer.provide(
    Layer.mock(Teams.Service)({
      current: () => Effect.succeed(status),
      refresh: () => Effect.succeed(status),
      select: () => Effect.succeed(status),
    }),
  ),
  Layer.provide(buildLocationServiceMap()),
  Layer.provide(Layer.mock(Config.Service)({ invalidate: () => Effect.void })),
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(Layer.mock(InstanceStore.Service)({ disposeAll: () => Effect.void })),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    ServerAuth.Config.configLayer({
      password: Option.some("owner-secret"),
      username: "vector",
      guestPassword: Option.some("guest-secret"),
      guestUsername: "guest",
      guestWorkspaceIDs: ["wrk_allowed"],
      guestSessionIDs: ["ses_allowed"],
    }),
  ),
)

const it = testEffect(apiLayer)
const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""
const get = (path: string, username: string, password: string) =>
  HttpClientRequest.get(path).pipe(
    HttpClientRequest.setHeader("authorization", basic(username, password)),
    HttpClient.execute,
  )
const switchOrg = (username: string, password: string) =>
  HttpClientRequest.post("/experimental/console/switch").pipe(
    HttpClientRequest.setHeader("authorization", basic(username, password)),
    HttpClientRequest.setBody(HttpBody.jsonUnsafe({ accountID, orgID })),
    HttpClient.execute,
  )

describe("Teams HttpApi authorization", () => {
  it.live("returns 403 for workspace and session guests on every Teams endpoint", () =>
    Effect.gen(function* () {
      const [current, orgs, switched] = yield* Effect.all(
        [
          get("/experimental/console", "guest", "guest-secret"),
          get("/experimental/console/orgs", "guest", "guest-secret"),
          switchOrg("guest", "guest-secret"),
        ],
        { concurrency: "unbounded" },
      )

      expect([current.status, orgs.status, switched.status]).toEqual([403, 403, 403])
    }),
  )

  it.live("retains owner access to current, list, and switch operations", () =>
    Effect.gen(function* () {
      const current = yield* get("/experimental/console", "vector", "owner-secret")
      expect(current.status).toBe(200)
      expect(yield* current.json).toEqual({
        consoleManagedProviders: [],
        activeOrgName: "Owner organization",
        switchableOrgCount: 1,
      })

      const orgs = yield* get("/experimental/console/orgs", "vector", "owner-secret")
      expect(orgs.status).toBe(200)
      expect(yield* orgs.json).toEqual({
        enabled: true,
        orgs: [
          {
            accountID,
            accountEmail: "owner@example.com",
            accountUrl: "https://vectordev.ai",
            orgID,
            orgName: "Owner organization",
            active: true,
          },
        ],
      })

      const switched = yield* switchOrg("vector", "owner-secret")
      expect(switched.status).toBe(200)
      expect(yield* switched.json).toBe(true)
    }),
  )
})
