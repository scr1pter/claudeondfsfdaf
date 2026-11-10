import { afterAll, afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { APICallError } from "ai"
import { Effect, Layer, Schema, Stream } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Global } from "@vectordevai/core/global"
import { FreeModels } from "@vectordevai/core/free-models"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { Usage } from "@vectordevai/llm"
import { Provider } from "@/provider/provider"
import { ProviderError } from "@/provider/error"
import { Session } from "@/session/session"
import { SessionRetry } from "@/session/retry"
import { usable } from "@/session/overflow"
import { CODIUM_MODELS } from "../../../../api/_lib/codium-catalog"
import { codiumCatalogV2, codiumGateway, codiumModel } from "../../../core/test/fixture/codium-gateway"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(disposeAllInstances)

const token = "vct_synthetic-private-account.token"
const gateway = codiumGateway(token)
afterAll(() => gateway.stop())
const entitlement = { enabled: true }
// A current client's catalog: Codium Auto naming the model, plus a model this plan has not unlocked and a manual-only
// lane. All are listed with what their listing says; nothing automatic picks Auto, the locked or the manual-only one.
const v2Catalog: ModelPlans.Catalog = {
  ...codiumCatalogV2,
  models: [
    ...codiumCatalogV2.models,
    { ...codiumModel, id: "vendor/locked", locked: { plan: "vector-100", name: "Max" } },
    { ...codiumModel, id: "vendor/long", manualOnly: true },
  ],
}
const planCatalog = { current: v2Catalog }
const account = { token: token as string | undefined }
const it = testEffect(
  LayerNode.compile(Provider.node, [
    [
      FreeModels.node,
      Layer.succeed(FreeModels.Service, {
        catalog: () => Effect.succeed({ enabled: false, updatedAt: 0, models: [] }),
        forKey: () => Effect.succeed([]),
        trainingConsent: () => Effect.succeed(false),
        setTrainingConsent: (accepted) => Effect.succeed(accepted),
        changes: Stream.empty,
      }),
    ],
    [
      FreeModels.credentialsNode,
      Layer.succeed(FreeModels.CredentialsService, {
        get: (provider) => Effect.succeed(provider === "vector" ? account.token : undefined),
      }),
    ],
    [
      ModelPlans.node,
      Layer.succeed(ModelPlans.Service, {
        catalog: (value) =>
          Effect.succeed(entitlement.enabled && value === token ? planCatalog.current : { enabled: false, models: [] }),
        request: gateway.forward,
      }),
    ],
  ]),
)
const id = ProviderV2.ID.make(ModelPlans.PROVIDER_ID)

// The real catalog client, answering only when the test releases it, as a slow first read after signing in does.
const slowCatalog = { answer: Promise.withResolvers<void>() }
const slowClient = ModelPlans.createClient({
  timeout: 20,
  request: () => slowCatalog.answer.promise.then(() => Response.json({ enabled: true, models: [codiumModel] })),
})
const slow = testEffect(
  LayerNode.compile(Provider.node, [
    [
      FreeModels.node,
      Layer.succeed(FreeModels.Service, {
        catalog: () => Effect.succeed({ enabled: false, updatedAt: 0, models: [] }),
        forKey: () => Effect.succeed([]),
        trainingConsent: () => Effect.succeed(false),
        setTrainingConsent: (accepted) => Effect.succeed(accepted),
        changes: Stream.empty,
      }),
    ],
    [
      FreeModels.credentialsNode,
      Layer.succeed(FreeModels.CredentialsService, {
        get: (provider) => Effect.succeed(provider === "vector" ? token : undefined),
      }),
    ],
    [
      ModelPlans.node,
      Layer.succeed(ModelPlans.Service, {
        catalog: (value, options) => Effect.promise(() => slowClient.catalog(value, options)),
        request: gateway.forward,
      }),
    ],
  ]),
)

it.instance(
  "Codium publishes the account's models without credentials and replaces project overrides",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const listed = (yield* provider.list())[id]
      expect(listed.name).toBe("Vector Codium")
      // Every entry, in the catalog's order, each with what a picker shows of it and never its hidden weight.
      expect(Object.keys(listed.models)).toEqual([codiumModel.id, ModelPlans.AUTO_ID, "vendor/locked", "vendor/long"])
      expect(Object.fromEntries(Object.entries(listed.models).map(([key, model]) => [key, model.codium]))).toEqual({
        [codiumModel.id]: { lab: "deepseek", role: "default" },
        [ModelPlans.AUTO_ID]: {
          lab: "deepseek",
          auto: { floor: codiumModel.id, default: codiumModel.id, ceiling: codiumModel.id },
        },
        "vendor/locked": { locked: { plan: "vector-100", name: "Max" } },
        "vendor/long": { manualOnly: true },
      })
      // Listing them makes none of them a default.
      expect(Provider.defaultModelIDs({ [id]: listed })).toEqual({ [id]: codiumModel.id })
      expect(JSON.stringify(listed)).not.toContain(token)
      expect(listed.options).toEqual({})
      const selected = yield* provider.getModel(id, ModelV2.ID.make(codiumModel.id))
      expect(selected.api.url).toBe(ModelPlans.API_URL)
      expect(selected.freeModel).toBeUndefined()
      // Codium spends credits: no dollar price, so its steps are recorded unpriced and left out of dollar totals.
      expect(selected.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 }, unpriced: true })
      expect((yield* provider.getLanguage(selected)).provider).toContain(ModelPlans.PROVIDER_ID)
      entitlement.enabled = false
      expect((yield* provider.list())[id]).toBeUndefined()
      const missing = yield* provider.getModel(id, ModelV2.ID.make(codiumModel.id)).pipe(Effect.flip)
      expect(missing).toMatchObject({ codium: "unavailable" })
      expect(missing.message).toContain("Vector Codium is not available right now")
      entitlement.enabled = true
      account.token = undefined
      const signedOut = yield* provider.getModel(id, ModelV2.ID.make(codiumModel.id)).pipe(Effect.flip)
      expect(signedOut).toMatchObject({ codium: "sign-in" })
      expect(signedOut.message).toContain("Sign in to Vector to use Vector Codium")
      account.token = token
      expect((yield* provider.getModel(id, ModelV2.ID.make(codiumModel.id))).api.url).toBe(ModelPlans.API_URL)
    }),
  {
    trusted: true,
    config: {
      model: `${ModelPlans.PROVIDER_ID}/${codiumModel.id}`,
      provider: {
        [ModelPlans.PROVIDER_ID]: {
          name: "injected",
          npm: "@ai-sdk/openai",
          options: { baseURL: "https://attacker.invalid", apiKey: "injected" },
          models: { "vendor/expensive": { cost: { input: 100, output: 100 } } },
        },
      },
    },
  },
)

slow.instance("a first Codium catalog read slower than the listing deadline lists Codium on the next read", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    // The app's first read of the provider list does not wait for vectordev.ai.
    expect((yield* provider.list())[id]).toBeUndefined()
    slowCatalog.answer.resolve()
    yield* Effect.promise(() => slowClient.catalog(token, { wait: true }))
    // The app reads the list again when a model picker opens, and Codium is there.
    expect(Object.keys((yield* provider.list())[id]?.models ?? {})).toEqual([codiumModel.id])
  }),
)

test("Codium's own default is the model its catalog gives the default role, else the first it lists", () => {
  // The launch lineup in the order vectordev.ai lists it: DeepSeek V4.1 Flash is the recommended default.
  const launch = ["deepseek/deepseek-v4.1-flash", "xiaomi/mimo-v2.6-flash", "anthropic/claude-haiku-5.5"].map(
    (model) => ({ ...codiumModel, id: model, name: model }),
  )
  expect(Provider.defaultModelIDs({ [id]: Provider.fromModelPlans(launch) })).toEqual({
    [id]: "deepseek/deepseek-v4.1-flash",
  })
  // The pickers keep this order, so the provider list sent to them must keep it too.
  expect(Object.keys(Provider.toClientInfo(Provider.fromModelPlans(launch)).models)).toEqual(
    launch.map((model) => model.id),
  )
  // A current catalog names its default by role; Codium Auto, locked and manual-only entries are never the default.
  const roles = Provider.defaultModelIDs({
    [id]: {
      models: {
        "vector/codium-auto": {
          id: "vector/codium-auto",
          codium: { auto: { floor: "a", default: "b", ceiling: "c" } },
        },
        "vendor/locked": { id: "vendor/locked", codium: { locked: { plan: "vector-100", name: "Max" } } },
        "vendor/long": { id: "vendor/long", codium: { manualOnly: true } },
        "vendor/floor": { id: "vendor/floor", codium: { role: "floor" } },
        "vendor/default": { id: "vendor/default", codium: { role: "default" } },
      },
    },
  })
  expect(roles).toEqual({ [id]: "vendor/default" })
  // The provider list carries what a picker shows of each entry, never its hidden weight.
  const listed = Provider.fromModelPlans([{ ...codiumModel, lab: "deepseek", weight: 1, role: "default" }])
  expect(listed.models[codiumModel.id]?.codium).toEqual({ lab: "deepseek", role: "default" })
})

it.instance("a Codium turn streams text and a tool call through the gateway and records its tokens, not dollars", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const selected = yield* provider.getModel(id, ModelV2.ID.make(codiumModel.id))
    const language = yield* provider.getLanguage(selected)
    const before = gateway.seen.length
    const result = yield* Effect.promise(() =>
      language.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "read src/a.ts" }] }],
        tools: [
          {
            type: "function",
            name: "read",
            description: "Read a file",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
      }),
    )
    const parts = Array.from(
      yield* Stream.runCollect(Stream.fromReadableStream({ evaluate: () => result.stream, onError: (cause) => cause })),
    )
    expect(
      parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join(""),
    ).toBe("Reading the file.")
    const call = parts.find((part) => part.type === "tool-call")
    expect(call).toMatchObject({ toolName: "read", toolCallId: "call_1" })
    if (call?.type !== "tool-call") throw new Error("Expected a tool call")
    expect(JSON.parse(call.input)).toEqual({ path: "src/a.ts" })
    const finish = parts.find((part) => part.type === "finish")
    if (finish?.type !== "finish") throw new Error("Expected a finish part")
    expect(finish.providerMetadata?.codium).toBeUndefined()
    // The credits it spent are a share of the plan, never dollars that could be added up beside the purchase price.
    const usage = Session.getUsage({
      model: selected,
      usage: new Usage({ inputTokens: 1000, outputTokens: 50 }),
      metadata: finish.providerMetadata,
    })
    expect(usage).toMatchObject({ cost: 0, unpriced: true, billing: "codium", tokens: { input: 1000, output: 50 } })
    const sent = gateway.seen.slice(before)
    expect(sent.map((item) => item.path)).toEqual(["/api/model-plans/chat"])
    expect(sent[0].authorization).toBe(`Bearer ${token}`)
    expect(sent[0].body).toMatchObject({ model: codiumModel.id, stream: true, tools: [{ type: "function" }] })
  }),
)

it.instance("an out-of-credits or disabled gateway fails the turn once, with an action and no retry", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const selected = yield* provider.getModel(id, ModelV2.ID.make(codiumModel.id))
    const language = yield* provider.getLanguage(selected)
    for (const [mode, kind, message] of [
      [
        "credits",
        "credits",
        `Your monthly Codium credits cannot cover this model's largest request right now. Wait for running requests to finish, choose a model that uses fewer credits, or add a top-up. Monthly credits renew each billing period. See plans at ${ModelPlans.PURCHASE_URL}`,
      ],
      ["disabled", "unavailable", "Vector Codium is not available right now. Choose another model."],
    ] as const) {
      gateway.state.mode = mode
      const before = gateway.seen.length
      const error = yield* Effect.promise(() =>
        language.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }).then(
          () => undefined,
          (cause: unknown) => cause,
        ),
      )
      if (!APICallError.isInstance(error)) throw error
      const parsed = ProviderError.parseAPICallError({ providerID: id, error })
      expect(parsed).toMatchObject({ type: "api_error", message, isRetryable: false, metadata: { codium: kind } })
      if (parsed.type !== "api_error") throw new Error("Expected an API error")
      const recorded = new SessionV1.APIError({
        message: parsed.message,
        statusCode: parsed.statusCode,
        isRetryable: parsed.isRetryable,
        metadata: parsed.metadata,
      }).toObject()
      // A 503 would normally be retried; a Codium availability answer is final.
      expect(SessionRetry.retryable(recorded, id)).toBeUndefined()
      expect(JSON.stringify(recorded)).not.toContain(token)
      expect(gateway.seen.slice(before).map((item) => item.path)).toEqual(["/api/model-plans/chat"])
    }
    gateway.state.mode = "context"
    const overflow = yield* Effect.promise(() =>
      language.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }).then(
        () => undefined,
        (cause: unknown) => cause,
      ),
    )
    if (!APICallError.isInstance(overflow)) throw overflow
    expect(ProviderError.parseAPICallError({ providerID: id, error: overflow }).type).toBe("context_overflow")
    gateway.state.mode = "ok"
  }),
)

it.instance("short Codium capacity is retried like a busy provider, with no purchase prompt", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const language = yield* provider.getLanguage(yield* provider.getModel(id, ModelV2.ID.make(codiumModel.id)))
    gateway.state.mode = "capacity"
    const error = yield* Effect.promise(() =>
      language.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }).then(
        () => undefined,
        (cause: unknown) => cause,
      ),
    )
    gateway.state.mode = "ok"
    if (!APICallError.isInstance(error)) throw error
    const parsed = ProviderError.parseAPICallError({ providerID: id, error })
    expect(parsed).toMatchObject({
      type: "api_error",
      message:
        "Vector Codium could not run this request: model capacity may be short for a moment. Vector will try again shortly.",
      isRetryable: true,
    })
    if (parsed.type !== "api_error") throw new Error("Expected an API error")
    expect(parsed.metadata?.codium).toBeUndefined()
    const recorded = new SessionV1.APIError({
      message: parsed.message,
      statusCode: parsed.statusCode,
      isRetryable: parsed.isRetryable,
      metadata: parsed.metadata,
    }).toObject()
    expect(SessionRetry.retryable(recorded, id)).toEqual({ message: parsed.message })
  }),
)

it.instance("a turn after signing out fails before any request and offers Sign in to Vector", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const language = yield* provider.getLanguage(yield* provider.getModel(id, ModelV2.ID.make(codiumModel.id)))
    const before = gateway.seen.length
    account.token = undefined
    const error = yield* Effect.promise(() =>
      language.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }).then(
        () => undefined,
        (cause: unknown) => cause,
      ),
    )
    account.token = token
    if (!APICallError.isInstance(error)) throw error
    expect(ProviderError.parseAPICallError({ providerID: id, error })).toMatchObject({
      type: "api_error",
      message: "Sign in to Vector to use Vector Codium.",
      isRetryable: false,
      metadata: { codium: "sign-in" },
    })
    expect(gateway.seen.length).toBe(before)
  }),
)

it.instance(
  "Codium is never the automatic default while another provider can run",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      expect((yield* provider.list())[id]).toBeDefined()
      expect(yield* provider.defaultModel()).toEqual({
        providerID: ProviderV2.ID.make("local"),
        modelID: ModelV2.ID.make("coder"),
      })
    }),
  {
    trusted: true,
    config: {
      provider: {
        local: {
          name: "Local",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:9/v1" },
          models: { coder: { name: "Local coder", tool_call: true } },
        },
      },
    },
  },
)

// The recent models the TUI and the app keep, which the engine's default reads.
const recents = path.join(Global.Path.state, "model.json")
it.instance(
  "a recent Codium model the plan no longer includes is never the default; the next recent choice is",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const recent = (...modelIDs: string[]) =>
        Effect.promise(() =>
          Bun.write(recents, JSON.stringify({ recent: modelIDs.map((modelID) => ({ providerID: id, modelID })) })),
        )
      // Chosen on Max, then the plan went down to one that lists it as locked: every turn on it would be refused.
      expect((yield* provider.list())[id]?.models["vendor/locked"]?.codium?.locked).toBeDefined()
      yield* recent("vendor/locked", codiumModel.id)
      expect(yield* provider.defaultModel()).toEqual({ providerID: id, modelID: ModelV2.ID.make(codiumModel.id) })
      // With no other recent choice, the default is the person's own provider, as when nothing was chosen.
      yield* recent("vendor/locked")
      expect(yield* provider.defaultModel()).toEqual({
        providerID: ProviderV2.ID.make("local"),
        modelID: ModelV2.ID.make("coder"),
      })
      // A manual-only lane the person chose by name is still theirs.
      yield* recent("vendor/long")
      expect(yield* provider.defaultModel()).toEqual({ providerID: id, modelID: ModelV2.ID.make("vendor/long") })
    }).pipe(Effect.ensuring(Effect.promise(() => fs.rm(recents, { force: true })))),
  {
    trusted: true,
    config: {
      provider: {
        local: {
          name: "Local",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:9/v1" },
          models: { coder: { name: "Local coder", tool_call: true } },
        },
      },
    },
  },
)

it.instance(
  "Codium alone is still not chosen automatically; the person is asked to pick a Codium model",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      expect(Object.keys(yield* provider.list())).toEqual([id])
      const error = yield* provider.defaultModel().pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "ProviderNoProvidersError", codium: true })
      expect(error.message).toContain("Vector never chooses it for you")
    }),
  { trusted: true, config: { enabled_providers: [ModelPlans.PROVIDER_ID] } },
)

it.instance("a Codium title stays on Codium, says it is a title and records its tokens, not dollars", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const selected = yield* provider.getSmallModel(id, ModelV2.ID.make(codiumModel.id))
    if (!selected) throw new Error("Missing Codium title model")
    expect(selected.providerID).toBe(id)
    expect(selected.id).toBe(ModelV2.ID.make(codiumModel.id))
    const language = yield* provider.getLanguage(selected)
    gateway.state.mode = "text"
    const before = gateway.seen.length
    const response = yield* Effect.promise(() =>
      language.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Generate a concise session title" }] }],
        headers: { "X-Vector-Purpose": "title" },
      }),
    )
    const parts = Array.from(
      yield* Stream.runCollect(
        Stream.fromReadableStream({ evaluate: () => response.stream, onError: (cause) => cause }),
      ),
    )
    gateway.state.mode = "ok"
    const finish = parts.find((part) => part.type === "finish")
    if (finish?.type !== "finish") throw new Error("Missing title usage")
    expect(
      Session.getUsage({
        model: selected,
        usage: new Usage({ inputTokens: 200, outputTokens: 6 }),
        metadata: finish.providerMetadata,
      }),
    ).toMatchObject({ cost: 0, unpriced: true, billing: "codium", tokens: { input: 200, output: 6 } })
    expect(gateway.seen.slice(before)).toMatchObject([
      { path: "/api/model-plans/chat", purpose: "title", catalog: "2" },
    ])
  }),
)

it.instance(
  "a small model set to Codium Auto gives helpers Auto's floor, then its default, never Auto itself",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const floor = { ...codiumModel, id: "vendor/floor" }
      const roles = { floor: floor.id, default: codiumModel.id, ceiling: codiumModel.id }
      const autoEntry = { ...codiumModel, id: ModelPlans.AUTO_ID, auto: roles }
      // A conversation on another provider: its helpers follow small_model, which names Codium Auto.
      const small = () =>
        provider
          .getSmallModel(ProviderV2.ID.make("local"), ModelV2.ID.make("coder"))
          .pipe(Effect.map((model) => model && `${model.providerID}/${model.id}`))
      planCatalog.current = { enabled: true, models: [codiumModel, autoEntry, floor] }
      expect(yield* small()).toBe(`${id}/${floor.id}`)
      planCatalog.current = { enabled: true, models: [codiumModel, autoEntry, { ...floor, manualOnly: true }] }
      expect(yield* small()).toBe(`${id}/${codiumModel.id}`)
      // Neither is usable, or the catalog names no Auto: no helper model, so the helper is skipped.
      planCatalog.current = {
        enabled: true,
        models: [
          { ...codiumModel, locked: { plan: "vector-100", name: "Max" } },
          autoEntry,
          { ...floor, locked: { plan: "vector-100", name: "Max" } },
        ],
      }
      expect(yield* small()).toBeUndefined()
      planCatalog.current = { enabled: true, models: [codiumModel] }
      expect(yield* small()).toBeUndefined()
      // Signed out, Codium lists nothing.
      planCatalog.current = { enabled: true, models: [codiumModel, autoEntry, floor] }
      account.token = undefined
      expect(yield* small()).toBeUndefined()
      account.token = token
      planCatalog.current = v2Catalog
    }),
  {
    trusted: true,
    config: {
      small_model: `${ModelPlans.PROVIDER_ID}/${ModelPlans.AUTO_ID}`,
      provider: {
        local: {
          name: "Local",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:9/v1" },
          models: { coder: { name: "Local coder", tool_call: true } },
        },
      },
    },
  },
)

it.instance(
  "a small model naming a Codium model the plan no longer includes gives no helper model, so the caller falls back",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const small = () =>
        provider
          .getSmallModel(ProviderV2.ID.make("local"), ModelV2.ID.make("coder"))
          .pipe(Effect.map((model) => model && `${model.providerID}/${model.id}`))
      // Listed with its lock (vendor/locked needs Max): every helper call to it would be refused.
      planCatalog.current = v2Catalog
      expect((yield* provider.list())[id]?.models["vendor/locked"]?.codium?.locked).toBeDefined()
      expect(yield* small()).toBeUndefined()
      // The plan includes it again: it is the helper model once more.
      planCatalog.current = {
        ...v2Catalog,
        models: v2Catalog.models.map((model) =>
          model.id === "vendor/locked" ? { ...model, locked: undefined } : model,
        ),
      }
      expect(yield* small()).toBe(`${id}/vendor/locked`)
      planCatalog.current = v2Catalog
    }),
  {
    trusted: true,
    config: {
      small_model: `${ModelPlans.PROVIDER_ID}/vendor/locked`,
      provider: {
        local: {
          name: "Local",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:9/v1" },
          models: { coder: { name: "Local coder", tool_call: true } },
        },
      },
    },
  },
)

it.instance("Codium helpers use Auto's floor, then its default, and none when neither is usable", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const floor = { ...codiumModel, id: "vendor/floor" }
    const auto = (roles: { floor: string; default: string; ceiling: string }) => ({
      ...codiumModel,
      id: ModelPlans.AUTO_ID,
      auto: roles,
    })
    const roles = { floor: floor.id, default: codiumModel.id, ceiling: codiumModel.id }
    const small = () =>
      provider.getSmallModel(id, ModelV2.ID.make(codiumModel.id)).pipe(Effect.map((model) => model?.id))
    planCatalog.current = { enabled: true, models: [codiumModel, auto(roles), floor] }
    yield* provider.list()
    expect(yield* small()).toBe(ModelV2.ID.make(floor.id))
    planCatalog.current = { enabled: true, models: [codiumModel, auto(roles), { ...floor, manualOnly: true }] }
    yield* provider.list()
    expect(yield* small()).toBe(ModelV2.ID.make(codiumModel.id))
    // Neither the floor nor the default is usable: no helper model, not the conversation's own or a locked one.
    planCatalog.current = {
      enabled: true,
      models: [
        { ...codiumModel, locked: { plan: "vector-100", name: "Max" } },
        auto(roles),
        { ...floor, locked: { plan: "vector-100", name: "Max" } },
        { ...codiumModel, id: "vendor/ceiling" },
      ],
    }
    yield* provider.list()
    expect(yield* small()).toBeUndefined()
    // An older gateway's catalog names no Auto, so there is no helper model either.
    planCatalog.current = { enabled: true, models: [codiumModel] }
    yield* provider.list()
    expect(yield* small()).toBeUndefined()
    planCatalog.current = v2Catalog
  }),
)

test("Vector compacts each reviewed Codium conversation once a step reaches the window less a full reply", () => {
  // The gateway's context checks are sized against this threshold; see packages/web/test/model-plan-context.test.ts.
  const cfg = Schema.decodeUnknownSync(ConfigV1.Info)({}) as ConfigV1.Info
  const provider = Provider.fromModelPlans(CODIUM_MODELS)
  expect(CODIUM_MODELS.map((model) => usable({ cfg, model: provider.models[model.id] }))).toEqual(
    CODIUM_MODELS.map((model) => model.contextLength - model.maxOutputTokens),
  )
})
