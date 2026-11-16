import { expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLM } from "@vectordevai/llm"
import { LLMClient, RequestExecutor } from "@vectordevai/llm/route"
import { FreeModels } from "../src/free-models"
import { freeModelRoute } from "../src/session/runner/free-model-route"
import { SessionRunnerModel } from "../src/session/runner/model"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { FREE_MODEL_FALLBACKS } from "@vectordevai/schema/free-model"

const catalog = { enabled: true, updatedAt: 1, models: [...FREE_MODEL_FALLBACKS.slice(0, 2)] }
// No invited guest has worked in the sessions these routes serve.
const ownerSession = Effect.succeed(false)
const client = FreeModels.Service.of({
  catalog: () => Effect.succeed(catalog),
  forKey: () => Effect.succeed(catalog.models),
  trainingConsent: () => Effect.succeed(false),
  setTrainingConsent: (accepted) => Effect.succeed(accepted),
  changes: Stream.empty,
})
const info = ModelV2.Info.make({
  ...ModelV2.Info.empty(ProviderV2.ID.vector, ModelV2.ID.make(catalog.models[0].id)),
  freeModel: { source: "shared" },
  limit: { context: 32000, output: 8000 },
  api: {
    type: "aisdk",
    id: ModelV2.ID.make(catalog.models[0].id),
    package: "@ai-sdk/openai-compatible",
    url: "https://attacker.invalid",
  },
  request: { headers: { Authorization: "injected" }, body: { apiKey: "injected", provider: { max_price: 10 } } },
})
// The same model, listed by the user's own OpenRouter account.
const owned = ModelV2.Info.make({
  ...info,
  providerID: ProviderV2.ID.openrouter,
  freeModel: { source: "openrouter" },
})

test("native free route fixes destination and body after all caller overlays, reads current own credential", async () => {
  const keys = ["first-owned-key", "second-owned-key"]
  const credentials = FreeModels.CredentialsService.of({
    get: (provider) => Effect.succeed(provider === "openrouter" ? keys.shift() : "vct_shared"),
  })
  const model = freeModelRoute(owned, client, credentials, ownerSession)
  for (const key of ["first-owned-key", "second-owned-key"]) {
    const request = LLM.request({
      model,
      prompt: "hello",
      http: {
        headers: { Authorization: "attacker", "x-leak": "private" },
        query: { api_key: "private" },
        body: { user: "injected", web_search_options: {} },
      },
    })
    const prepared = await Effect.runPromise(
      model.route.prepareTransport({ model: model.id, messages: [{ role: "user", content: "hello" }] }, request),
    )
    expect(prepared.request.url).toBe(FreeModels.OPENROUTER_CHAT_URL)
    expect(prepared.request.headers.authorization).toBe(`Bearer ${key}`)
    expect(prepared.request.headers["x-leak"]).toBeUndefined()
    expect(prepared.request.body._tag).toBe("Uint8Array")
    if (prepared.request.body._tag !== "Uint8Array") throw new Error("Expected JSON bytes")
    const body = JSON.parse(new TextDecoder().decode(prepared.request.body.body))
    expect(body.provider.max_price).toEqual({ prompt: 0, completion: 0, request: 0, image: 0 })
    expect(body.provider.data_collection).toBe("deny")
    expect(body.provider).not.toHaveProperty("zdr")
    expect(body.models).toEqual(catalog.models.map((item) => item.id))
    expect(body).not.toHaveProperty("web_search_options")
    expect(body).not.toHaveProperty("apiKey")
    expect(body).not.toHaveProperty("user")
  }
})

test("a shared selection stays on Vector's endpoint and token while an OpenRouter key is stored", async () => {
  const model = freeModelRoute(
    info,
    client,
    FreeModels.CredentialsService.of({
      get: (provider) => Effect.succeed(provider === "openrouter" ? "own-synthetic" : "vct_shared"),
    }),
    ownerSession,
  )
  const prepared = await Effect.runPromise(
    model.route.prepareTransport(
      { model: model.id, messages: [{ role: "user", content: "hello" }] },
      LLM.request({ model, prompt: "hello" }),
    ),
  )
  expect(prepared.request.url).toBe(FreeModels.SHARED_CHAT_URL)
  expect(prepared.request.headers.authorization).toBe("Bearer vct_shared")
})

test("native shared route uses Vector token only on fixed Vector endpoint and refuses paid plugins", async () => {
  const model = freeModelRoute(
    info,
    client,
    FreeModels.CredentialsService.of({
      get: (provider) => Effect.succeed(provider === "vector" ? "vct_shared" : undefined),
    }),
    ownerSession,
  )
  const request = LLM.request({ model, prompt: "hello" })
  const body = { model: model.id, messages: [{ role: "user", content: "hello" }] }
  const prepared = await Effect.runPromise(model.route.prepareTransport(body, request))
  expect(prepared.request.url).toBe(FreeModels.SHARED_CHAT_URL)
  expect(prepared.request.headers.authorization).toBe("Bearer vct_shared")
  await expect(
    Effect.runPromise(
      model.route.prepareTransport(
        body,
        LLM.request({ model, prompt: "hello", http: { body: { plugins: [{ id: "web" }] } } }),
      ),
    ),
  ).rejects.toThrow("Paid plugins")
})

test("native free-model requests reject redirects before forwarding conversation data", async () => {
  const redirected: string[] = []
  const destination = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      redirected.push(await request.text())
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    },
  })
  const origin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.redirect(destination.url, 307),
  })
  try {
    const model = freeModelRoute(
      info,
      client,
      FreeModels.CredentialsService.of({
        get: (provider) => Effect.succeed(provider === "vector" ? "vct_synthetic" : undefined),
      }),
      ownerSession,
    )
    const result = await Effect.runPromise(
      LLMClient.stream(LLM.request({ model, prompt: "private conversation fixture" })).pipe(
        Stream.runCollect,
        Effect.result,
        Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))),
        Effect.provideService(
          FetchHttpClient.Fetch,
          Object.assign(
            (input: RequestInfo | URL, init?: RequestInit) => {
              expect(String(input)).toBe(FreeModels.SHARED_CHAT_URL)
              return fetch(origin.url, init)
            },
            { preconnect: fetch.preconnect },
          ),
        ),
      ),
    )
    expect(redirected).toEqual([])
    expect(result._tag).toBe("Failure")
  } finally {
    await origin.stop(true)
    await destination.stop(true)
  }
})

test("native shared requests reject oversized UTF-8 context before contacting the inference endpoint", async () => {
  const requests: string[] = []
  const model = freeModelRoute(
    info,
    client,
    FreeModels.CredentialsService.of({
      get: (provider) => Effect.succeed(provider === "vector" ? "vct_synthetic" : undefined),
    }),
    ownerSession,
  )
  const result = await Effect.runPromise(
    LLMClient.stream(LLM.request({ model, prompt: "é".repeat(2_250_000) })).pipe(
      Stream.runCollect,
      Effect.result,
      Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))),
      Effect.provideService(
        FetchHttpClient.Fetch,
        Object.assign(
          async (input: RequestInfo | URL) => {
            requests.push(String(input))
            throw new Error("Oversized shared requests must not reach the network")
          },
          { preconnect: fetch.preconnect },
        ),
      ),
    ),
  )
  expect(requests).toEqual([])
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      reason: {
        _tag: "InvalidRequest",
        message:
          "Context too large for free models provided by Vector. Compact this conversation, or use a model from a provider you've connected with your own key.",
      },
    },
  })
})

test("an OpenRouter selection on the user's own key is not subject to the Vector body limit", async () => {
  const requests: string[] = []
  const model = freeModelRoute(
    owned,
    client,
    FreeModels.CredentialsService.of({
      get: (provider) => Effect.succeed(provider === "openrouter" ? "own-synthetic" : "vct_synthetic"),
    }),
    ownerSession,
  )
  const result = await Effect.runPromise(
    LLMClient.stream(LLM.request({ model, prompt: "é".repeat(2_250_000) })).pipe(
      Stream.runCollect,
      Effect.result,
      Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))),
      Effect.provideService(
        FetchHttpClient.Fetch,
        Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            requests.push(String(input))
            const request = new Request(input, init)
            expect((await request.arrayBuffer()).byteLength).toBeGreaterThan(4_500_000)
            expect(request.headers.get("authorization")).toBe("Bearer own-synthetic")
            return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
          },
          { preconnect: fetch.preconnect },
        ),
      ),
    ),
  )
  expect(requests).toEqual([FreeModels.OPENROUTER_CHAT_URL])
  expect(result._tag).toBe("Success")
})

test("the run guard counts a free-route step as free, whatever the model's ID says", () => {
  const credentials = FreeModels.CredentialsService.of({ get: () => Effect.succeed("vct_shared") })
  // A configured free ID need not end in :free; the route itself is what refuses anything not priced at zero.
  const model = SessionRunnerModel.withFreeRoute(
    freeModelRoute(
      ModelV2.Info.make({ ...info, id: ModelV2.ID.make("example/coder"), freeModel: { source: "openrouter" } }),
      client,
      credentials,
      ownerSession,
    ),
  )
  const tokens = { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }
  expect(SessionRunnerModel.isFree(model)).toBe(true)
  expect(SessionRunnerModel.spendStep(model, { tokens }, { continues: true, patched: false })).toMatchObject({
    costUsd: 0,
    costKind: "free",
  })
})

test("native route sends nothing to a may-train model before acceptance, then allows data collection and says so", async () => {
  const laguna = {
    id: "poolside/laguna-s-2.1:free",
    name: "Poolside: Laguna S 2.1",
    contextLength: 262144,
    maxOutputTokens: 32768,
    providers: [{ id: "poolside/fp4", name: "Poolside", retention: "", dataPolicy: "may-train" as const }],
  }
  const consent = { value: false }
  const shared = FreeModels.Service.of({
    ...client,
    catalog: () => Effect.succeed({ enabled: true, updatedAt: 1, models: [laguna, ...catalog.models] }),
    trainingConsent: () => Effect.sync(() => consent.value),
  })
  const model = freeModelRoute(
    ModelV2.Info.make({
      ...info,
      id: ModelV2.ID.make(laguna.id),
      api: { ...info.api, id: ModelV2.ID.make(laguna.id) },
    }),
    shared,
    FreeModels.CredentialsService.of({
      get: (provider) => Effect.succeed(provider === "vector" ? "vct_shared" : undefined),
    }),
    ownerSession,
  )
  const body = { model: model.id, messages: [{ role: "user", content: "hello" }] }
  const request = LLM.request({ model, prompt: "hello" })
  await expect(Effect.runPromise(model.route.prepareTransport(body, request))).rejects.toThrow(
    "Vector itself never trains on your prompts",
  )
  consent.value = true
  const prepared = await Effect.runPromise(model.route.prepareTransport(body, request))
  expect(prepared.request.headers["x-vector-free-model-disclosure"]).toBe("may-train-v1")
  expect(prepared.request.headers["x-vector-free-model-training-consent"]).toBe("accepted")
  if (prepared.request.body._tag !== "Uint8Array") throw new Error("Expected JSON bytes")
  expect(JSON.parse(new TextDecoder().decode(prepared.request.body.body)).provider.data_collection).toBe("allow")
})

test("run credentials cannot authorize explicit free selections or configured aliases", async () => {
  for (const provider of ["vector", "openrouter"] as const) {
    await expect(
      FreeModels.resolveRoute({
        provider,
        modelID: catalog.models[0].id,
        catalog: async () => catalog,
        forKey: async () => [],
        credential: async (name) => (name === "vector" ? "vrt_e30.c2ln" : undefined),
        trainingConsent: async () => false,
        guest: async () => false,
      }),
    ).rejects.toThrow("cannot authorize shared free models")
  }
  const alias = ModelV2.Info.make({ ...info, providerID: ProviderV2.ID.make("configured-alias") })
  const model = freeModelRoute(
    alias,
    client,
    FreeModels.CredentialsService.of({ get: () => Effect.succeed("vrt_e30.c2ln") }),
    ownerSession,
  )
  let sent = 0
  const result = await Effect.runPromise(
    LLMClient.stream(LLM.request({ model, prompt: "private fixture" })).pipe(
      Stream.runCollect,
      Effect.result,
      Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))),
      Effect.provideService(
        FetchHttpClient.Fetch,
        Object.assign(
          async () => {
            sent++
            throw new Error("A run token must never reach free inference")
          },
          { preconnect: fetch.preconnect },
        ),
      ),
    ),
  )
  expect(result._tag).toBe("Failure")
  expect(sent).toBe(0)
})
