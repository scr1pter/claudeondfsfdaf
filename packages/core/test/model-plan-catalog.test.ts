import { expect } from "bun:test"
import { DateTime, Deferred, Effect, Exit, Stream } from "effect"
import { Catalog } from "../src/catalog"
import { FreeModels } from "../src/free-models"
import { FreeModelGuests } from "../src/free-model-guests"
import { ModelPlans } from "../src/model-plans"
import { PluginV2 } from "../src/plugin"
import { PluginHost } from "../src/plugin/host"
// Load order matters here: importing VectorPlugin first reaches the provider plugin list before it is initialized.
import { VectorPlanPlugin } from "../src/plugin/provider/vector-plan"
import { VectorPlugin } from "../src/plugin/provider/vector"
import { ProjectV2 } from "../src/project"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionRunnerModel } from "../src/session/runner/model"
import { FREE_MODEL_FALLBACKS } from "@vectordevai/schema/free-model"
import { codiumCatalogV2, codiumModel } from "./fixture/codium-gateway"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)
// No invited guest has worked in these sessions.
const noGuests = FreeModelGuests.Service.of({ mark: () => Effect.void, marked: () => Effect.succeed(false) })

for (const enabled of [true, false])
  it.effect(`managed catalog replaces configuration overrides when enabled=${enabled}`, () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const plugins = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugins)
      yield* host.catalog.transform(
        Effect.fn(function* (draft) {
          draft.provider.update(ModelPlans.PROVIDER_ID, (provider) => {
            provider.name = "injected"
            provider.request.body.apiKey = "project-secret"
          })
          draft.model.update(ModelPlans.PROVIDER_ID, "vendor/expensive", () => {})
        }),
      )
      yield* VectorPlanPlugin.effect(host).pipe(
        Effect.provideService(ModelPlans.Service, {
          catalog: (token) => {
            expect(token).toBe("private-account-token")
            return Effect.succeed({ enabled, models: enabled ? [codiumModel] : [] })
          },
          request: () => Promise.reject(new Error("Listing must not call the chat gateway")),
        }),
        Effect.provideService(FreeModels.CredentialsService, { get: () => Effect.succeed("private-account-token") }),
      )
      const listed = (yield* catalog.model.available()).filter((model) => model.providerID === ModelPlans.PROVIDER_ID)
      expect(listed).toHaveLength(enabled ? 1 : 0)
      if (!enabled) return
      expect(String(listed[0].id)).toBe(codiumModel.id)
      expect(listed[0].name).toBe(codiumModel.name)
      // Codium spends credits: no dollar price, so its steps are recorded unpriced.
      expect(listed[0].cost).toEqual([])
      expect(listed[0].api.url).toBe(ModelPlans.API_URL)
      expect(JSON.stringify(listed)).not.toContain("private-account-token")
      expect(JSON.stringify(listed)).not.toContain("project-secret")
    }),
  )

// Signed in to Vector with no keys: the shared free models and Codium are both listed.
const credentials = FreeModels.CredentialsService.of({
  get: (provider) => Effect.succeed(provider === "vector" ? "vct_signed-in.token" : undefined),
})
// A current client's catalog: Codium Auto, a model the plan has not unlocked and a manual-only lane beside the model.
const plans = ModelPlans.Service.of({
  catalog: () =>
    Effect.succeed({
      ...codiumCatalogV2,
      models: [
        ...codiumCatalogV2.models,
        { ...codiumModel, id: "vendor/locked", locked: { plan: "vector-100", name: "Max" } },
        { ...codiumModel, id: "vendor/long", manualOnly: true as const },
      ],
    }),
  request: () => Promise.reject(new Error("Choosing a model must not call the chat gateway")),
})
const session = SessionV2.Info.make({
  id: SessionV2.ID.make("ses_codium_default"),
  projectID: ProjectV2.ID.global,
  title: "default",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: { directory: AbsolutePath.make("/synthetic-project") },
})

for (const shared of [true, false])
  it.effect(`a new V2 session never picks Codium by itself when shared free models are ${shared ? "on" : "off"}`, () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const host = yield* PluginHost.make(yield* PluginV2.Service)
      const freeModels = FreeModels.Service.of({
        catalog: () =>
          Effect.succeed({ enabled: shared, updatedAt: 0, models: shared ? [FREE_MODEL_FALLBACKS[0]] : [] }),
        forKey: () => Effect.succeed([]),
        trainingConsent: () => Effect.succeed(false),
        setTrainingConsent: (accepted) => Effect.succeed(accepted),
        changes: Stream.empty,
      })
      yield* VectorPlugin.effect(host).pipe(
        Effect.provideService(FreeModels.Service, freeModels),
        Effect.provideService(FreeModels.CredentialsService, credentials),
      )
      yield* VectorPlanPlugin.effect(host).pipe(
        Effect.provideService(ModelPlans.Service, plans),
        Effect.provideService(FreeModels.CredentialsService, credentials),
      )
      // Every entry is listed, Auto, the locked model and the manual-only lane included, each with what a picker shows
      // of it from the catalog; the default below still never picks Codium.
      const listed = (yield* catalog.model.available()).filter(
        (model) => String(model.providerID) === ModelPlans.PROVIDER_ID,
      )
      expect(Object.fromEntries(listed.map((model) => [String(model.id), model.codium]))).toEqual({
        [codiumModel.id]: { lab: "deepseek", role: "default" },
        [ModelPlans.AUTO_ID]: {
          lab: "deepseek",
          auto: { floor: codiumModel.id, default: codiumModel.id, ceiling: codiumModel.id },
        },
        "vendor/locked": { locked: { plan: "vector-100", name: "Max" } },
        "vendor/long": { manualOnly: true },
      })
      const resolved = yield* Effect.gen(function* () {
        const resolver = yield* SessionRunnerModel.Service
        return yield* resolver.resolve(session)
      }).pipe(
        Effect.provide(SessionRunnerModel.locationLayer),
        Effect.provideService(FreeModelGuests.Service, noGuests),
        Effect.provideService(ModelPlans.Service, plans),
        Effect.provideService(FreeModels.Service, freeModels),
        Effect.provideService(FreeModels.CredentialsService, credentials),
        Effect.exit,
      )
      if (!shared) {
        // Codium alone is not chosen for the person: the session asks for a model instead of spending credits.
        expect(yield* catalog.model.default()).toBeUndefined()
        expect(Exit.isFailure(resolved)).toBe(true)
        return
      }
      expect(String((yield* catalog.model.default())?.providerID)).toBe("vector")
      if (!Exit.isSuccess(resolved)) throw new Error("Expected the shared free model to be resolved")
      expect(String(resolved.value.provider)).toBe("vector")
      expect(String(resolved.value.id)).toBe(FREE_MODEL_FALLBACKS[0].id)
    }),
  )

it.effect("a first catalog read slower than the listing deadline lists Codium as soon as vectordev.ai answers", () =>
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const host = yield* PluginHost.make(yield* PluginV2.Service)
    const reloaded = yield* Deferred.make<void>()
    const answer = Promise.withResolvers<Response>()
    const client = ModelPlans.createClient({ timeout: 5, request: () => answer.promise })
    yield* VectorPlanPlugin.effect({
      ...host,
      catalog: {
        ...host.catalog,
        reload: () => host.catalog.reload().pipe(Effect.andThen(Deferred.succeed(reloaded, undefined))),
      },
    }).pipe(
      Effect.provideService(ModelPlans.Service, {
        catalog: (token, options) => Effect.promise(() => client.catalog(token, options)),
        request: () => Promise.reject(new Error("Listing must not call the chat gateway")),
      }),
      Effect.provideService(FreeModels.CredentialsService, credentials),
    )
    const codium = () =>
      catalog.model
        .available()
        .pipe(Effect.map((models) => models.filter((model) => String(model.providerID) === ModelPlans.PROVIDER_ID)))
    // The listing gave up on its deadline while vectordev.ai was still answering.
    expect(yield* codium()).toEqual([])
    answer.resolve(Response.json({ enabled: true, models: [codiumModel] }))
    yield* Deferred.await(reloaded)
    expect((yield* codium()).map((model) => String(model.id))).toEqual([codiumModel.id])
  }),
)
