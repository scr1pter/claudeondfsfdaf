import { Teams } from "@vectordevai/core/teams"
import { buildLocationServiceMap } from "@vectordevai/core/location-services"
import { teamsHandlers } from "../../src/server/routes/instance/httpapi/handlers/teams"
import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Duration, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@vectordevai/core/control-plane/move-session"
import { FreeModels } from "@vectordevai/core/free-models"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

// The credential the handler reads back after the write: an environment token wins over the one written, so the
// recorded read must name what FreeModels.CredentialsService answers, not the request body.
const effective = "vct_effective-account.token"
const plans = { hang: false, reads: [] as { token: string | undefined; force: boolean | undefined }[] }
const saved: string[] = []

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
  Layer.provide(
    Layer.mock(Auth.Service)({
      set: (key) => Effect.sync(() => void saved.push(key)),
      create: (key) => Effect.sync(() => void saved.push(key)),
    }),
  ),
  Layer.provide(
    Layer.mock(FreeModels.CredentialsService)({
      get: (provider) => Effect.succeed(provider === "vector" ? effective : undefined),
    }),
  ),
  Layer.provide(
    Layer.mock(ModelPlans.Service)({
      catalog: (token, options) =>
        Effect.sync(() => void plans.reads.push({ token, force: options?.force })).pipe(
          Effect.andThen(plans.hang ? Effect.never : Effect.succeed({ enabled: false, models: [] })),
        ),
      request: () => Promise.reject(new Error("No Codium gateway in this test")),
    }),
  ),
  Layer.provide(Layer.mock(Teams.Service)({})),
  Layer.provide(buildLocationServiceMap()),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "vector" })),
)
const it = testEffect(apiLayer)

const write = (providerID: string) =>
  HttpClientRequest.put(`/auth/${providerID}`).pipe(
    HttpClientRequest.setBody(HttpBody.jsonUnsafe({ type: "api", key: "vct_written-account.token" })),
    HttpClient.execute,
  )

describe("writing an auth credential", () => {
  it.live("the Vector account's forces a read of its Codium models with the effective credential", () =>
    Effect.gen(function* () {
      plans.hang = false
      plans.reads.length = 0
      saved.length = 0
      const response = yield* write("vector")
      expect(response.status).toBe(200)
      expect(saved).toEqual(["vector"])
      expect(plans.reads).toEqual([{ token: effective, force: true }])

      // Another provider's credential lists no Codium models, so nothing is read.
      const other = yield* write("anthropic")
      expect(other.status).toBe(200)
      expect(saved).toEqual(["vector", "anthropic"])
      expect(plans.reads).toHaveLength(1)
    }),
  )

  it.live("answers once CREDENTIAL_READ has passed when vectordev.ai does not answer", () =>
    Effect.gen(function* () {
      plans.hang = true
      plans.reads.length = 0
      const started = Date.now()
      const response = yield* write("vector")
      const took = Date.now() - started
      expect(response.status).toBe(200)
      expect(plans.reads).toEqual([{ token: effective, force: true }])
      // It waited for the read, but no longer than the bound, however long vectordev.ai takes.
      expect(took).toBeGreaterThanOrEqual(Duration.toMillis(ModelPlans.CREDENTIAL_READ) - 100)
      expect(took).toBeLessThan(Duration.toMillis(ModelPlans.CREDENTIAL_READ) + 3_000)
    }),
  )
})
