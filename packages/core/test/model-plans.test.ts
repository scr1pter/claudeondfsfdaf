import { afterAll, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { LLM, LLMError } from "@vectordevai/llm"
import { LLMClient, RequestExecutor } from "@vectordevai/llm/route"
import { FreeModels } from "../src/free-models"
import { ModelPlans } from "../src/model-plans"
import { ModelPlanStatus } from "../src/model-plan-status"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { codiumError, modelPlanRoute } from "../src/session/runner/model-plan-route"
import { SessionRunnerModel } from "../src/session/runner/model"
import { InstallationVersion } from "../src/installation/version"
import { codiumCatalogV2, codiumGateway, codiumModel } from "./fixture/codium-gateway"
import { it } from "./lib/effect"

const token = "vct_synthetic-private-account.token"
const gateway = codiumGateway(token)
afterAll(() => gateway.stop())

const active = { enabled: true, models: [codiumModel] }
const off = { enabled: false, models: [] }
const info = ModelV2.Info.make({
  ...ModelV2.Info.empty(ProviderV2.ID.make(ModelPlans.PROVIDER_ID), ModelV2.ID.make(codiumModel.id)),
  api: {
    id: ModelV2.ID.make("different/model"),
    type: "aisdk",
    package: "@ai-sdk/openai-compatible",
    url: "https://attacker.invalid",
  },
  limit: { context: 32_000, output: 4096 },
})
const service = (catalog: ModelPlans.Catalog = active) =>
  ModelPlans.Service.of({ catalog: () => Effect.succeed(catalog), request: gateway.forward })
const credentials = (value: string | undefined = token) =>
  FreeModels.CredentialsService.of({ get: () => Effect.succeed(value) })

// Runs one V2 provider turn through the native Codium route against the local gateway.
const stream = (route: ReturnType<typeof modelPlanRoute>) =>
  Effect.runPromise(
    LLMClient.stream(
      LLM.request({
        model: route,
        prompt: "read src/a.ts",
        tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
      }),
    ).pipe(
      Stream.runCollect,
      Effect.result,
      Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))),
      Effect.provideService(
        FetchHttpClient.Fetch,
        Object.assign((input: RequestInfo | URL, init?: RequestInit) => gateway.forward(String(input), init), {
          preconnect: fetch.preconnect,
        }),
      ),
    ),
  )

test("plan catalogs require account authentication, coalesce requests and isolate account caches", async () => {
  const calls: RequestInit[] = []
  const client = ModelPlans.createClient({
    request: async (url, init) => {
      expect(url).toBe(ModelPlans.CATALOG_URL)
      expect(init.redirect).toBe("error")
      calls.push(init)
      return Response.json(new Headers(init.headers).get("authorization") === "Bearer account-a" ? active : off)
    },
  })
  expect(await client.catalog(undefined)).toEqual(off)
  expect(calls).toEqual([])
  expect(await Promise.all([client.catalog("account-a"), client.catalog("account-a")])).toEqual([active, active])
  expect(calls).toHaveLength(1)
  expect(await client.catalog("account-b")).toEqual(off)
  expect(await client.catalog("account-a")).toEqual(active)
  expect(calls).toHaveLength(2)
})

test("a refresh keeps the last catalog through slow, failed and garbled answers, and closes on a refused token", async () => {
  const clock = { now: 0 }
  const replies: (() => Promise<Response>)[] = [
    async () => Response.json(active),
    // vectordev.ai answers correctly, but after the listing deadline.
    async () => Bun.sleep(30).then(() => Response.json(active)),
    async () => Promise.reject(new Error("offline")),
    async () => new Response("unavailable", { status: 503 }),
    async () => Response.json({ enabled: true, models: [{ ...codiumModel, maxOutputTokens: -1 }] }),
    async () => new Response("revoked", { status: 403 }),
    async () => Response.json(active),
    async () => Response.json(off),
  ]
  const client = ModelPlans.createClient({ timeout: 10, now: () => clock.now, request: () => replies.shift()!() })
  expect(await client.catalog("account")).toEqual(active)
  clock.now = 61_000
  // A slow refresh answers with the catalog the account already had, and its answer lands for the next caller.
  expect(await client.catalog("account")).toEqual(active)
  await Bun.sleep(40)
  // Offline, a 503 and a garbled list each keep the last catalog.
  expect(await client.catalog("account", { force: true })).toEqual(active)
  expect(await client.catalog("account", { force: true })).toEqual(active)
  expect(await client.catalog("account", { force: true })).toEqual(active)
  expect(await client.catalog("account", { force: true })).toEqual(off)
  expect(await client.catalog("account", { force: true })).toEqual(active)
  expect(await client.catalog("account", { force: true })).toEqual(off)
  expect(replies).toEqual([])
})

test("a chat request waits for the first catalog, and a slow refresh later never fails the turn", async () => {
  const clock = { now: 0 }
  const sent: string[] = []
  const client = ModelPlans.createClient({
    timeout: 5,
    now: () => clock.now,
    request: async () => Bun.sleep(30).then(() => Response.json(active)),
  })
  const turn = () =>
    ModelPlans.createFetch({
      modelID: codiumModel.id,
      credential: async () => "account",
      catalog: (value) => client.catalog(value, { wait: true }),
      request: async (url) => {
        sent.push(url)
        return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
      },
    })("https://vectordev.ai/api/model-plans/chat", {
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    })
  expect((await turn()).status).toBe(200)
  clock.now = 61_000
  expect((await turn()).status).toBe(200)
  expect(sent).toEqual([ModelPlans.CHAT_URL, ModelPlans.CHAT_URL])
})

test("a fresh engine lists the account's last catalog while vectordev.ai is slow, and only for that account", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "codium-catalog-")), "codium-models.json")
  const account = "vct_cached-account.token"
  await ModelPlans.createClient({ file, request: async () => Response.json(active) }).catalog(account, { force: true })
  // The file names the account by digest; the token itself is never written.
  expect(await Bun.file(file).text()).not.toContain(account)
  // Next launch: vectordev.ai answers after the listing deadline.
  const slow = () => Bun.sleep(50).then(() => Response.json(active))
  const restarted = ModelPlans.createClient({ file, timeout: 5, request: slow })
  expect(await restarted.catalog(account)).toEqual(active)
  expect(await restarted.catalog("vct_another-account.token")).toEqual(off)
  // A refused token replaces what was saved.
  await ModelPlans.createClient({ file, request: async () => new Response("revoked", { status: 403 }) }).catalog(
    account,
    { force: true },
  )
  expect(await ModelPlans.createClient({ file, timeout: 5, request: slow }).catalog(account)).toEqual(off)
})

test("catalog caches are bounded and disabled mode makes no requests", async () => {
  const calls: string[] = []
  const client = ModelPlans.createClient({
    request: async (_url, init) => {
      calls.push(new Headers(init.headers).get("authorization")!)
      return Response.json(active)
    },
  })
  await Promise.all(Array.from({ length: 33 }, (_, index) => client.catalog(`account-${index}`)))
  await client.catalog("account-0")
  expect(calls).toHaveLength(34)
  expect(
    await ModelPlans.createClient({
      disabled: () => true,
      request: async () => {
        throw new Error("Disabled catalogs must not request the network")
      },
    }).catalog("account"),
  ).toEqual(off)
})

test("a hung catalog cannot stall model selection, and its late answer serves the next caller", async () => {
  const pending = Promise.withResolvers<Response>()
  const client = ModelPlans.createClient({ timeout: 5, request: () => pending.promise })
  expect(await client.catalog("account")).toEqual(off)
  pending.resolve(Response.json(active))
  await Bun.sleep(5)
  expect(await client.catalog("account")).toEqual(active)
})

// What vectordev.ai lists for the account after an upgrade: one model more than before it.
const upgraded = { enabled: true, models: [codiumModel, { ...codiumModel, id: "vendor/upgraded", name: "Upgraded" }] }

// Each catalog request waits until the test answers it.
const held = () => {
  const answers: PromiseWithResolvers<Response>[] = []
  const request = () => {
    const answer = Promise.withResolvers<Response>()
    answers.push(answer)
    return answer.promise
  }
  return { answers, request }
}

test("a forced read starts after what changed the plan: an older read never replaces it, and plain reads wait on it", async () => {
  const clock = { now: 0 }
  const gatewayReads = held()
  const client = ModelPlans.createClient({ timeout: 1_000, now: () => clock.now, request: gatewayReads.request })
  // A read starts its request once the account's saved catalog has been looked for.
  const started = () => Bun.sleep(1)
  const first = client.catalog("account")
  await started()
  gatewayReads.answers[0].resolve(Response.json(active))
  expect(await first).toEqual(active)
  // The kept minute lapses and a plain read starts a refresh, which vectordev.ai has not answered when the purchase
  // lands; the forced read after it does not join that refresh but starts its own.
  clock.now = 61_000
  const older = client.catalog("account")
  await started()
  const forced = client.catalog("account", { force: true })
  await started()
  expect(gatewayReads.answers).toHaveLength(3)
  // The refresh from before the purchase answers first: it is not kept, so a plain read still waits on the forced one.
  gatewayReads.answers[1].resolve(Response.json(active))
  await started()
  const waiting = client.catalog("account")
  await started()
  expect(gatewayReads.answers).toHaveLength(3)
  gatewayReads.answers[2].resolve(Response.json(upgraded))
  expect(await Promise.all([older, forced, waiting])).toEqual([upgraded, upgraded, upgraded])
  // The forced answer is the kept one now, for a minute, with no other request.
  expect(await client.catalog("account")).toEqual(upgraded)
  expect(gatewayReads.answers).toHaveLength(3)

  // Within a fresh minute too, a forced read asks again, and a plain read meanwhile no longer gets the kept catalog.
  const again = client.catalog("account", { force: true })
  await started()
  const meanwhile = client.catalog("account")
  await started()
  expect(gatewayReads.answers).toHaveLength(4)
  gatewayReads.answers[3].resolve(Response.json(off))
  expect(await Promise.all([again, meanwhile])).toEqual([off, off])
})

it.effect("writing the account credential reads its catalog now, waiting at most CREDENTIAL_READ for it", () =>
  Effect.gen(function* () {
    const gatewayReads = held()
    const client = ModelPlans.createClient({ timeout: 5, request: gatewayReads.request })
    const written = (value: string | undefined) =>
      ModelPlans.credentialWritten(value).pipe(
        Effect.provideService(ModelPlans.Service, {
          catalog: (account, options) => Effect.promise(() => client.catalog(account, options)),
          request: gateway.forward,
        }),
      )
    const settle = Effect.promise(() => Bun.sleep(1))
    // Signed out, there is no account to read.
    yield* written(undefined)
    expect(gatewayReads.answers).toEqual([])

    // vectordev.ai answers in time: the write returns once the account's catalog is in place.
    const prompt = yield* written("account").pipe(Effect.forkChild)
    yield* settle
    expect(gatewayReads.answers).toHaveLength(1)
    expect(prompt.pollUnsafe()).toBeUndefined()
    gatewayReads.answers[0].resolve(Response.json(active))
    yield* Fiber.join(prompt)
    expect(yield* Effect.promise(() => client.catalog("account"))).toEqual(active)
    expect(gatewayReads.answers).toHaveLength(1)

    // vectordev.ai is slow: the write stops waiting at the bound, and the answer still lands for the next read.
    const slow = yield* written("account").pipe(Effect.forkChild)
    yield* settle
    expect(gatewayReads.answers).toHaveLength(2)
    yield* TestClock.adjust(ModelPlans.CREDENTIAL_READ)
    yield* Fiber.join(slow)
    gatewayReads.answers[1].resolve(Response.json(upgraded))
    yield* settle
    expect(yield* Effect.promise(() => client.catalog("account"))).toEqual(upgraded)
    expect(gatewayReads.answers).toHaveLength(2)
  }),
)

test("the catalog reads the signed-in account's models from the gateway as a current client", async () => {
  const client = ModelPlans.createClient({ request: gateway.forward })
  const before = gateway.seen.length
  expect(await client.catalog(token)).toEqual(codiumCatalogV2)
  // The client says which release it is and that it decodes the v2 catalog (§4.9); neither grants anything.
  expect(gateway.seen.slice(before)).toMatchObject([
    { path: "/api/model-plans/models", client: InstallationVersion, catalog: "2", purpose: null },
  ])
  expect(await client.catalog("vct_someone-else.token")).toEqual(off)
  gateway.state.mode = "disabled"
  expect(await client.catalog(token, { force: true })).toEqual(off)
  gateway.state.mode = "ok"
})

test("legacy SDK transport fixes destination and credentials while enforcing the catalog model and token ceiling", async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const accounts = ["first-account", "second-account"]
  const request = ModelPlans.createFetch({
    modelID: codiumModel.id,
    credential: async () => accounts.shift(),
    catalog: async () => active,
    request: async (url, init) => {
      calls.push({ url, init })
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    },
  })
  for (const account of ["first-account", "second-account"]) {
    await request("https://attacker.invalid/chat", {
      headers: { Authorization: "injected", "x-private": "secret" },
      body: JSON.stringify({
        model: "different/expensive",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 100_000,
        models: ["fallback"],
        provider: { max_price: 100 },
        plugins: [{ id: "web" }],
        apiKey: "injected",
      }),
    })
    const call = calls.at(-1)!
    expect(call.url).toBe(ModelPlans.CHAT_URL)
    expect(call.init.redirect).toBe("error")
    expect(new Headers(call.init.headers).get("authorization")).toBe(`Bearer ${account}`)
    expect(new Headers(call.init.headers).get("x-private")).toBeNull()
    expect(new Headers(call.init.headers).get("x-vector-client")).toBe(InstallationVersion)
    expect(new Headers(call.init.headers).get("x-vector-catalog")).toBe("2")
    // No purpose given: the request is a chat turn.
    expect(new Headers(call.init.headers).get("x-vector-purpose")).toBe("chat")
    expect(JSON.parse(String(call.init.body))).toEqual({
      model: codiumModel.id,
      messages: [{ role: "user", content: "hello" }],
      max_tokens: codiumModel.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
    })
  }
})

test("signed-out, disabled and retired selections answer like the gateway without sending a request", async () => {
  const requests: string[] = []
  const attempt = async (credential: string | undefined, catalog: ModelPlans.Catalog) => {
    const response = await ModelPlans.createFetch({
      modelID: codiumModel.id,
      credential: async () => credential,
      catalog: async () => catalog,
      request: async (url) => {
        requests.push(url)
        return new Response()
      },
    })("https://vectordev.ai/api/model-plans/chat", { body: JSON.stringify({ messages: [{ role: "user" }] }) })
    return { status: response.status, ...ModelPlans.gatewayFailure(response.status, await response.text()) }
  }
  expect(await attempt(undefined, active)).toMatchObject({
    status: 401,
    kind: "sign-in",
    message: "Sign in to Vector to use Vector Codium.",
  })
  // Codium switched off is final: a client error, which the AI SDK's own retries (408, 409, 429, 5xx) never repeat.
  expect(await attempt(token, off)).toMatchObject({
    status: 400,
    code: "CODIUM_UNAVAILABLE",
    kind: "unavailable",
    retry: false,
    message: "Vector Codium is not available right now. Choose another model.",
  })
  expect(await attempt(token, { enabled: true, models: [{ ...codiumModel, id: "vendor/other" }] })).toMatchObject({
    status: 400,
    kind: "unavailable",
    message: "This model is no longer included in Vector Codium. Choose another model.",
  })
  expect(requests).toEqual([])
})

test("native plan transport ignores project and request routing overlays and denies unavailable models", async () => {
  const catalogs = [active, off]
  const route = modelPlanRoute(
    info,
    ModelPlans.Service.of({ catalog: () => Effect.succeed(catalogs.shift()!), request: gateway.forward }),
    credentials("current-account"),
  )
  const request = LLM.request({
    model: route,
    prompt: "hello",
    http: {
      headers: { Authorization: "injected", "x-private": "secret" },
      query: { key: "secret" },
      body: { model: "different/model", provider: { max_price: 100 }, apiKey: "private" },
    },
  })
  const prepared = await Effect.runPromise(
    route.route.prepareTransport({ model: route.id, messages: [{ role: "user", content: "hello" }] }, request),
  )
  expect(prepared.request.url).toBe(ModelPlans.CHAT_URL)
  expect(prepared.request.headers.authorization).toBe("Bearer current-account")
  expect(prepared.request.headers["x-private"]).toBeUndefined()
  await expect(
    Effect.runPromise(
      route.route.prepareTransport({ model: route.id, messages: [{ role: "user", content: "hello" }] }, request),
    ),
  ).rejects.toMatchObject({
    reason: {
      _tag: "InvalidRequest",
      message: "Vector Codium is not available right now. Choose another model.",
      providerMetadata: { codium: { action: "unavailable", code: "CODIUM_UNAVAILABLE" } },
    },
  })
})

test("a native Codium turn streams text and a tool call and leaves its credits out of dollar costs", async () => {
  // The Codium catalog lists no dollar price, as the vector-plan plugin builds it.
  const route = SessionRunnerModel.withPricing(modelPlanRoute(info, service(), credentials()), [])
  const before = gateway.seen.length
  const result = await stream(route)
  if (result._tag !== "Success") throw result.failure
  const events = [...result.success]
  expect(
    events
      .filter((event) => event.type === "text-delta")
      .map((event) => event.text)
      .join(""),
  ).toBe("Reading the file.")
  expect(events.find((event) => event.type === "tool-call")).toMatchObject({
    name: "read",
    input: { path: "src/a.ts" },
  })
  const finish = events.find((event) => event.type === "step-finish")
  if (finish?.type !== "step-finish") throw new Error("Expected a step finish")
  expect(finish.reason).toBe("tool-calls")
  const tokens = { input: 1000, output: 50, reasoning: 0, cache: { read: 0, write: 0 } }
  // The step spent credits, not dollars Vector could add up, so its cost is unknown and it is recorded unpriced.
  expect(finish.usage).toMatchObject({ inputTokens: 1000, outputTokens: 50 })
  expect(SessionRunnerModel.calculateCost(route, tokens, finish.usage?.providerMetadata)).toBeUndefined()
  // The run guard counts it the same way: an unpriced step, never $0 and never a priced one.
  expect(
    SessionRunnerModel.spendStep(
      route,
      { tokens, providerMetadata: finish.usage?.providerMetadata },
      { continues: true, patched: false },
    ),
  ).toMatchObject({ costUsd: undefined, costKind: "unknown" })
  const sent = gateway.seen.slice(before)
  expect(sent.map((item) => item.path)).toEqual(["/api/model-plans/chat"])
  expect(sent[0].authorization).toBe(`Bearer ${token}`)
  expect(sent[0].body).toMatchObject({ model: codiumModel.id, stream: true, stream_options: { include_usage: true } })
})

test("out of credits, plans disabled and an over-long context fail the turn at once without retrying", async () => {
  for (const [mode, tag, message, action, code] of [
    [
      "credits",
      "QuotaExceeded",
      `Your monthly Codium credits cannot cover this model's largest request right now. Wait for running requests to finish, choose a model that uses fewer credits, or add a top-up. Monthly credits renew each billing period. See plans at ${ModelPlans.PURCHASE_URL}`,
      "credits",
      "MODEL_PLAN_EXHAUSTED",
    ],
    [
      "disabled",
      "InvalidRequest",
      "Vector Codium is not available right now. Choose another model.",
      "unavailable",
      "MODEL_PLANS_DISABLED",
    ],
    [
      "context",
      "InvalidRequest",
      "This conversation is too long for the Codium model. Compact it before continuing.",
      undefined,
      undefined,
    ],
  ] as const) {
    gateway.state.mode = mode
    const before = gateway.seen.length
    const result = await stream(modelPlanRoute(info, service(), credentials()))
    if (result._tag !== "Failure") throw new Error(`Expected ${mode} to fail`)
    const failure = result.failure
    if (!(failure instanceof LLMError)) throw failure
    expect(failure.reason._tag).toBe(tag)
    expect(failure.reason).toMatchObject({ message })
    expect(failure.reason.retryable).toBe(false)
    if (mode === "context") expect(failure.reason).toMatchObject({ classification: "context-overflow" })
    // The V2 session records the action, so a client can offer Buy credits next to the message.
    expect(codiumError(failure)).toEqual(action && { type: "codium", action, message, code })
    // Exactly one request: never retried, and never sent anywhere else.
    expect(gateway.seen.slice(before).map((item) => item.path)).toEqual(["/api/model-plans/chat"])
    expect(JSON.stringify(failure)).not.toContain(token)
  }
  gateway.state.mode = "ok"
})

test("short model capacity is retried as temporary and never asks for a purchase", async () => {
  gateway.state.mode = "capacity"
  const before = gateway.seen.length
  const result = await stream(modelPlanRoute(info, service(), credentials()))
  gateway.state.mode = "ok"
  if (result._tag !== "Failure") throw new Error("Expected capacity to fail after its retries")
  const failure = result.failure
  if (!(failure instanceof LLMError)) throw failure
  expect(failure.reason).toMatchObject({
    _tag: "RateLimit",
    message:
      "Vector Codium could not run this request: model capacity may be short for a moment. Vector will try again shortly.",
  })
  expect(failure.reason.message).not.toContain("See plans")
  expect(codiumError(failure)).toBeUndefined()
  // The first answer and the executor's two retries, all to the gateway.
  expect(gateway.seen.slice(before).map((item) => item.path)).toEqual(Array(3).fill("/api/model-plans/chat"))
})

test("plan requests reject invalid response limits and excessive UTF-8 context", () => {
  expect(() => ModelPlans.serializeRequest({ messages: [{}], max_tokens: -1 }, codiumModel)).toThrow("response length")
  expect(() =>
    ModelPlans.serializeRequest({ messages: [{ role: "user", content: "é".repeat(2_250_000) }] }, codiumModel),
  ).toThrow("Context too large")
})

test("gateway answers map by code to their kind, the stored action and whether they are retried", () => {
  const body = (code: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ error: { code, message: "Server message.", ...extra } })
  const table: [number, string, ModelPlanStatus.Kind, ModelPlanStatus.Action | undefined, boolean][] = [
    [429, "RATE_LIMITED", "busy", undefined, true],
    [429, "MODEL_PLAN_BUSY", "busy", undefined, true],
    [503, "MODEL_PLAN_RENEWING", "busy", undefined, true],
    [429, "MODEL_PLAN_CONCURRENCY", "wait", undefined, true],
    [402, "MODEL_PLAN_CAPACITY", "capacity", undefined, true],
    [401, "CODIUM_SIGN_IN_REQUIRED", "sign-in", "sign-in", false],
    [401, "MODEL_PLAN_RUN_EXPIRED", "run", "unavailable", false],
    [429, "MODEL_PLAN_RUN_LIMIT", "run", "unavailable", false],
    [429, "MODEL_PLAN_BRAIN_SHARE", "run", "unavailable", false],
    [429, "MODEL_PLAN_DAILY_LIMIT", "daily", "unavailable", false],
    [402, "MODEL_PLAN_REQUIRED", "credits", "credits", false],
    [402, "MODEL_PLAN_PAYMENT_REQUIRED", "credits", "credits", false],
    [402, "MODEL_PLAN_EXHAUSTED", "credits", "credits", false],
    [403, "MODEL_PLAN_UPGRADE_REQUIRED", "upgrade", "credits", false],
    [403, "CODIUM_PERK_REQUIRED", "upgrade", "credits", false],
    [403, "MODEL_PLAN_BLOCKED", "contact", "unavailable", false],
    [409, "MODEL_PLAN_EXISTS", "plan", "credits", false],
    [409, "MODEL_PLAN_CHANGE_UNAVAILABLE", "plan", "credits", false],
    [409, "HOSTED_SESSION_PAUSED", "wait", "unavailable", false],
    [426, "CODIUM_UPDATE_REQUIRED", "update", "unavailable", false],
    [503, "MODEL_PLANS_DISABLED", "unavailable", "unavailable", false],
    [503, "CODIUM_SALES_PAUSED", "unavailable", "unavailable", false],
    [503, "MODEL_PLANS_CONFIGURATION", "unavailable", "unavailable", false],
    [503, "MODEL_PLAN_POOL_UNAVAILABLE", "unavailable", "unavailable", false],
    [503, "MODEL_PLAN_MODEL_UNAVAILABLE", "unavailable", "unavailable", false],
    [409, "MODEL_PLAN_ACCOUNT_CLOSING", "unavailable", "unavailable", false],
    [400, "MODEL_PLAN_MODEL", "unavailable", "unavailable", false],
    [400, "MODEL_PLAN_ADDONS", "unavailable", "unavailable", false],
    [400, "CODIUM_ESTIMATE_KIND", "unavailable", "unavailable", false],
  ]
  for (const [status, code, kind, action, retry] of table) {
    const answer = ModelPlans.gatewayFailure(status, body(code))
    expect({ code, kind: answer?.kind, action: answer?.action, retry: answer?.retry }).toEqual({
      code,
      kind,
      action,
      retry,
    })
    // The code decides, so an answer that reaches the client under another status reads the same.
    expect(ModelPlans.gatewayFailure(400, body(code))?.kind).toBe(kind)
    expect(ModelPlanStatus.failureKind(code)).toBe(kind)
  }
  // A daily, run or Brain limit never offers a purchase: Codium sells no top-ups.
  for (const code of ["MODEL_PLAN_DAILY_LIMIT", "MODEL_PLAN_RUN_LIMIT", "MODEL_PLAN_BRAIN_SHARE"])
    expect(ModelPlans.gatewayFailure(429, body(code))?.message).not.toContain("See plans")
  expect(ModelPlans.gatewayFailure(402, body("MODEL_PLAN_EXHAUSTED"))?.message).toBe(
    `Server message. See plans at ${ModelPlans.PURCHASE_URL}`,
  )
  expect(ModelPlans.gatewayFailure(402, body("MODEL_PLAN_PAYMENT_REQUIRED", { action: "update-card" }))?.message).toBe(
    `Server message. Update your card at ${ModelPlanStatus.MANAGE_URL}`,
  )
  expect(ModelPlans.gatewayFailure(503, body("MODEL_PLAN_POOL_UNAVAILABLE"))?.message).toBe(
    "Vector Codium could not verify your usage right now. Choose another model.",
  )
  // Removed and internal codes are not classified; neither is a transient gateway failure, so the usual 5xx retry
  // still applies to it.
  for (const code of ["MODEL_TOPUP_EXHAUSTED", "MODEL_PLAN_CANCELLED", "SOMETHING_NEW", "MODEL_PLAN_UPSTREAM"])
    expect(ModelPlans.gatewayFailure(503, body(code))).toBeUndefined()
  for (const code of ["MODEL_PLAN_STREAM", "MODEL_PLAN_UNAVAILABLE", "MODEL_PLAN_KEY_INVALID"])
    expect(ModelPlans.gatewayFailure(503, body(code))).toBeUndefined()
  expect(ModelPlans.gatewayFailure(402, "not json")).toBeUndefined()
  expect(ModelPlans.gatewayFailure(401, body("CLI_TOKEN_INVALID"))).toMatchObject({ kind: "sign-in", retry: false })
  // An answer given after the gateway sent the request to the provider is committed in full, so it is final whatever
  // its code, including the busy and capacity codes that are retried when refused before dispatch.
  for (const [status, code] of [
    [429, "MODEL_PLAN_BUSY"],
    [402, "MODEL_PLAN_CAPACITY"],
    [503, "MODEL_PLAN_UPSTREAM"],
    [503, "MODEL_PLAN_UNAVAILABLE"],
  ] as const)
    expect(ModelPlans.gatewayFailure(status, body(code, { dispatched: true }))).toEqual({
      code,
      kind: "unavailable",
      action: "unavailable",
      message:
        "The model provider could not finish this request. It counts toward your Codium usage, so Vector did not send it again. Try again shortly. Choose another model.",
      retry: false,
    })
  expect(ModelPlans.contextFailure(body("MODEL_PLAN_CONTEXT"))).toBe(true)
})

test("the SDK transport passes only a known purpose and turns final answers into client errors the SDK never retries", async () => {
  const purposes: (string | null)[] = []
  const answers: Response[] = []
  const transport = ModelPlans.createFetch({
    modelID: codiumModel.id,
    credential: async () => token,
    catalog: async () => active,
    request: async (_url, init) => {
      purposes.push(new Headers(init.headers).get("x-vector-purpose"))
      return answers.shift()!
    },
  })
  const send = (purpose?: string) =>
    transport("https://vectordev.ai/api/model-plans/chat", {
      headers: purpose ? { "X-Vector-Purpose": purpose } : {},
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    })
  const answer = (status: number, code: string, headers: Record<string, string> = {}) =>
    Response.json({ error: { code, message: "Server message." } }, { status, headers })
  for (const [status, code] of [
    [429, "MODEL_PLAN_DAILY_LIMIT"],
    [429, "MODEL_PLAN_RUN_LIMIT"],
    [503, "MODEL_PLAN_POOL_UNAVAILABLE"],
    [503, "MODEL_PLANS_CONFIGURATION"],
    [409, "MODEL_PLAN_ACCOUNT_CLOSING"],
  ] as const) {
    answers.push(answer(status, code))
    const response = await send("title")
    expect(response.status).toBe(400)
    expect(ModelPlans.gatewayFailure(response.status, await response.text())).toMatchObject({ code, retry: false })
  }
  // Temporary answers keep their status and retry-after, so the SDK and the session wait and try again.
  answers.push(answer(503, "MODEL_PLAN_RENEWING", { "retry-after": "30" }))
  const renewing = await send("brain")
  expect(renewing.status).toBe(503)
  expect(renewing.headers.get("retry-after")).toBe("30")
  answers.push(answer(429, "MODEL_PLAN_CONCURRENCY", { "retry-after-ms": "2000" }))
  expect((await send("judge")).status).toBe(429)
  // A transient gateway failure is not a Codium answer and keeps its 503.
  answers.push(answer(503, "MODEL_PLAN_UPSTREAM"))
  expect((await send("cloud-agents")).status).toBe(503)
  // The same failures after dispatch are committed in full, so the SDK must not resend them.
  for (const [status, code] of [
    [503, "MODEL_PLAN_UPSTREAM"],
    [429, "MODEL_PLAN_BUSY"],
  ] as const) {
    answers.push(Response.json({ error: { code, message: "Server message.", dispatched: true } }, { status }))
    const response = await send("title")
    expect(response.status).toBe(400)
    expect(ModelPlans.gatewayFailure(response.status, await response.text())).toMatchObject({ code, retry: false })
  }
  answers.push(new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }))
  expect((await send()).status).toBe(200)
  // Desktop and CLI callers cannot claim a run token's service purpose; unknown values read as chat.
  expect(purposes).toEqual([
    "title",
    "title",
    "title",
    "title",
    "title",
    "brain",
    "judge",
    "chat",
    "title",
    "title",
    "chat",
  ])
})

test("current clients decode the v2 catalog leniently and keep Codium Auto only when its models are usable", async () => {
  const decode = (body: unknown) =>
    ModelPlans.createClient({ request: async () => Response.json(body) }).catalog(token, { force: true })
  const deep = { id: "deepseek/flash", name: "DeepSeek", contextLength: 1_000_000, maxOutputTokens: 8192 }
  const luna = { id: "vendor/luna", name: "Luna", contextLength: 256_000, maxOutputTokens: 8192 }
  const sol = { id: "vendor/sol", name: "Sol", contextLength: 128_000, maxOutputTokens: 8192 }
  const auto = {
    id: ModelPlans.AUTO_ID,
    name: "Codium Auto",
    contextLength: 128_000,
    maxOutputTokens: 8192,
    auto: { floor: luna.id, default: deep.id, ceiling: sol.id },
  }
  const decoded = await decode({
    enabled: true,
    plan: null,
    limits: { inFlight: 2 },
    models: [
      { ...deep, lab: "deepseek", weight: 1, role: "default" },
      auto,
      { ...luna, lab: "a-new-lab", role: "a-new-role", weight: -1, manualOnly: "yes" },
      { ...sol, locked: { plan: "vector-50", name: "Pro" }, preview: { until: "soon" } },
    ],
    judges: { [deep.id]: luna.id, [luna.id]: "vendor/unlisted" },
    review: { triage: deep.id, confirm: "vendor/unlisted" },
  })
  // An unknown lab or role and malformed extras drop only those fields; plan null means Plus's locks and limits.
  expect(decoded.models.find((model) => model.id === luna.id)).toEqual(luna)
  expect(decoded).toMatchObject({ plan: null, limits: { inFlight: 2 }, judges: { [deep.id]: luna.id } })
  expect(decoded.review).toEqual({ triage: deep.id })
  // Auto's ceiling is locked, so Auto is left out rather than offered with a model the plan cannot use.
  expect(decoded.models.map((model) => model.id)).toEqual([deep.id, luna.id, sol.id])
  expect(decoded.models.find((model) => model.id === sol.id)?.locked).toEqual({ plan: "vector-50", name: "Pro" })
  const unlocked = await decode({ enabled: true, models: [deep, auto, luna, { ...sol, manualOnly: true }] })
  expect(unlocked.models.map((model) => model.id)).toEqual([deep.id, luna.id, sol.id])
  const offered = await decode({ enabled: true, models: [deep, auto, luna, sol] })
  expect(offered.models.find((model) => model.id === ModelPlans.AUTO_ID)?.auto).toEqual(auto.auto)
  // Only Auto carries roles; any other entry's map is dropped.
  const extra = await decode({ enabled: true, models: [{ ...deep, auto: auto.auto }] })
  expect(extra.models[0]).toEqual(deep)
  // What a picker is given of each entry: lab, role, locks and Auto's models, never the hidden weight.
  expect(ModelPlans.listing(decoded.models[0]!)).toEqual({ lab: "deepseek", role: "default" })
  expect(ModelPlans.listing(decoded.models.find((model) => model.id === sol.id)!)).toEqual({
    locked: { plan: "vector-50", name: "Pro" },
  })
  expect(ModelPlans.listing(offered.models.find((model) => model.id === ModelPlans.AUTO_ID)!)).toEqual({
    auto: auto.auto,
  })
  // The four fields older releases decode stay strict: one malformed entry still rejects the answer.
  expect(await decode({ enabled: true, models: [{ ...deep, contextLength: "big" }] })).toEqual(off)
})

test("Codium Auto itself is never sent to the gateway", async () => {
  const requests: string[] = []
  const response = await ModelPlans.createFetch({
    modelID: ModelPlans.AUTO_ID,
    credential: async () => token,
    catalog: async () => codiumCatalogV2,
    request: async (url) => {
      requests.push(url)
      return new Response()
    },
  })("https://vectordev.ai/api/model-plans/chat", { body: JSON.stringify({ messages: [{ role: "user" }] }) })
  expect(ModelPlans.gatewayFailure(response.status, await response.text())).toMatchObject({
    code: "CODIUM_AUTO",
    action: "unavailable",
    retry: false,
  })
  expect(requests).toEqual([])
})

test("a native Codium turn on Codium Auto goes to Auto's default model, and Auto is refused without one", async () => {
  const auto = ModelV2.Info.make({ ...info, id: ModelV2.ID.make(ModelPlans.AUTO_ID) })
  const before = gateway.seen.length
  await stream(modelPlanRoute(auto, service(codiumCatalogV2), credentials()))
  expect(gateway.seen.slice(before)).toMatchObject([{ path: "/api/model-plans/chat", body: { model: codiumModel.id } }])
  // An older gateway's catalog lists no Auto: nothing is sent and the turn says Auto could not pick a model.
  const start = gateway.seen.length
  const result = await stream(modelPlanRoute(auto, service(), credentials()))
  if (result._tag !== "Failure" || !(result.failure instanceof LLMError)) throw new Error("Expected Auto to fail")
  expect(codiumError(result.failure)).toMatchObject({ type: "codium", action: "unavailable", code: "CODIUM_AUTO" })
  expect(gateway.seen.length).toBe(start)
})

test("a native Codium turn sends the client headers and fails once on a final answer, retrying only temporary ones", async () => {
  const before = gateway.seen.length
  await stream(modelPlanRoute(info, service(), credentials()))
  expect(gateway.seen.slice(before)).toMatchObject([
    { path: "/api/model-plans/chat", client: InstallationVersion, catalog: "2", purpose: "chat" },
  ])
  for (const [status, code] of [
    [429, "MODEL_PLAN_DAILY_LIMIT"],
    [503, "MODEL_PLAN_POOL_UNAVAILABLE"],
    [401, "MODEL_PLAN_RUN_EXPIRED"],
    [426, "CODIUM_UPDATE_REQUIRED"],
  ] as const) {
    gateway.state.answer = { status, code }
    const start = gateway.seen.length
    const result = await stream(modelPlanRoute(info, service(), credentials()))
    if (result._tag !== "Failure" || !(result.failure instanceof LLMError)) throw new Error(`Expected ${code} to fail`)
    expect(result.failure.reason.retryable).toBe(false)
    expect(result.failure.reason).toMatchObject({ providerMetadata: { codium: { code } } })
    // The stored error keeps the code, so a surface can tell a daily limit from a plan that cannot run.
    expect(codiumError(result.failure)).toMatchObject({ type: "codium", code })
    expect(gateway.seen.length - start).toBe(1)
  }
  for (const code of ["MODEL_PLAN_RENEWING", "MODEL_PLAN_CONCURRENCY"]) {
    gateway.state.answer = {
      status: code === "MODEL_PLAN_RENEWING" ? 503 : 429,
      code,
      headers: { "retry-after-ms": "1" },
    }
    const start = gateway.seen.length
    const result = await stream(modelPlanRoute(info, service(), credentials()))
    if (result._tag !== "Failure" || !(result.failure instanceof LLMError)) throw new Error(`Expected ${code} to fail`)
    expect(result.failure.reason._tag).toBe("RateLimit")
    expect(codiumError(result.failure)).toBeUndefined()
    // The first answer and the executor's two retries.
    expect(gateway.seen.length - start).toBe(3)
  }
  // A transient gateway failure is retried as any provider's 5xx is.
  gateway.state.answer = { status: 503, code: "MODEL_PLAN_UPSTREAM" }
  const start = gateway.seen.length
  await stream(modelPlanRoute(info, service(), credentials()))
  expect(gateway.seen.length - start).toBe(3)
  // After dispatch the same answers are committed in full, so the executor sends each once.
  for (const [status, code] of [
    [503, "MODEL_PLAN_UPSTREAM"],
    [429, "MODEL_PLAN_BUSY"],
    [402, "MODEL_PLAN_CAPACITY"],
  ] as const) {
    gateway.state.answer = { status, code, dispatched: true }
    const first = gateway.seen.length
    const result = await stream(modelPlanRoute(info, service(), credentials()))
    if (result._tag !== "Failure" || !(result.failure instanceof LLMError)) throw new Error(`Expected ${code} to fail`)
    expect(result.failure.reason.retryable).toBe(false)
    expect(codiumError(result.failure)).toMatchObject({ type: "codium", action: "unavailable", code })
    expect(gateway.seen.length - first).toBe(1)
  }
  gateway.state.answer = undefined
})

test("status reads the plan and the share of each balance left, never an amount, and flags a low balance", async () => {
  const before = gateway.seen.length
  const status = await ModelPlanStatus.fetchStatus(token, gateway.forward)
  expect(gateway.seen.slice(before)).toEqual([
    {
      path: "/api/model-plans/status",
      authorization: `Bearer ${token}`,
      client: InstallationVersion,
      catalog: "2",
      purpose: null,
      body: undefined,
    },
  ])
  expect(status).toEqual({
    signedIn: true,
    enabled: true,
    access: true,
    customer: true,
    plan: {
      id: "vector-50",
      name: "Pro",
      left: 0.06,
      renewsAt: 1_790_000_000_000,
      cancelAtPeriodEnd: false,
      state: "active",
      today: { used: 0.42, resetsAt: 1_789_000_000_000, reached: false },
    },
    listed: [],
    purchased: { bought: false },
    empty: false,
    low: true,
  })
  expect(ModelPlanStatus.describe(status)).toEqual([
    `Plan: Pro, 6% left this month, renews ${ModelPlanStatus.formatDate(1_790_000_000_000)}`,
    "Today: 42% of today's limit used",
    "Less than 10% of this month's Codium usage is left.",
    `Change plan: ${ModelPlanStatus.MANAGE_URL}`,
  ])
  // No top-ups: nothing offers to buy more.
  expect(ModelPlanStatus.describe(status).join(" ")).not.toMatch(/buy|credits/i)
  // No balance amount reaches the app or the CLI: with the purchase price it would reveal what a purchase buys.
  expect(JSON.stringify(status)).not.toMatch(/"(credits|remaining)"/)
  expect(JSON.stringify(status)).not.toContain(token)
  // Balances read as whole-percent shares, as on the account page, never amounts.
  expect(ModelPlanStatus.describe(status).join(" ")).not.toMatch(/\b\d+(\.\d+)? credits\b/)
  expect(ModelPlanStatus.formatShare(0)).toBe("0%")
  expect(ModelPlanStatus.formatShare(0.06)).toBe("6%")
  expect(ModelPlanStatus.formatShare(1)).toBe("100%")
})

test("status without credits, signed out, expired or unreachable says what to do", async () => {
  const saved = gateway.state.status
  gateway.state.status = {
    enabled: true,
    active: false,
    access: false,
    customer: true,
    purchased: { bought: false },
    empty: true,
    low: false,
  }
  const empty = await ModelPlanStatus.fetchStatus(token, gateway.forward)
  expect(empty).toMatchObject({
    signedIn: true,
    access: false,
    plan: undefined,
    purchased: { bought: false },
    empty: true,
    low: false,
  })
  expect(ModelPlanStatus.describe(empty)).toEqual([
    "Plan: Free",
    "Choose a Codium plan to use Codium models.",
    `See plans: ${ModelPlanStatus.PURCHASE_URL}`,
  ])
  gateway.state.status = {
    enabled: false,
    active: false,
    access: false,
    purchased: { bought: false },
    empty: true,
    low: false,
  }
  // Codium off is said first, and no plan page is offered while it is.
  expect(ModelPlanStatus.describe(await ModelPlanStatus.fetchStatus(token, gateway.forward))).toEqual([
    "Vector Codium is not available right now.",
    "Plan: Free",
  ])
  gateway.state.status = saved

  const before = gateway.seen.length
  expect(await ModelPlanStatus.fetchStatus(undefined, gateway.forward)).toMatchObject({ signedIn: false })
  expect(gateway.seen.length).toBe(before)
  expect(await ModelPlanStatus.fetchStatus("vct_expired.token", gateway.forward)).toMatchObject({
    signedIn: false,
    error: "Your Vector sign-in expired. Sign in again.",
  })
  expect(await ModelPlanStatus.fetchStatus(token, () => Promise.reject(new Error("offline")))).toMatchObject({
    signedIn: true,
    error: "Vector could not load your Codium usage. Try again shortly.",
  })
})

test("a subscriber whose monthly credits are spent is told so, even though the plan still grants access", () => {
  // The server's answer for a subscriber with too few monthly credits left for a reply.
  const spent = {
    enabled: true,
    access: true,
    plan: { id: "vector-10", name: "Plus", left: 0, renewsAt: 1_790_000_000_000, cancelAtPeriodEnd: false },
    purchased: { bought: false },
    empty: true,
    low: false,
  }
  const status = ModelPlanStatus.fromRemote(spent)
  expect(status).toMatchObject({ access: true, plan: { left: 0 }, empty: true, low: false })
  const renews = ModelPlanStatus.formatDate(1_790_000_000_000)
  expect(ModelPlanStatus.notice(status)).toEqual({
    kind: "empty",
    text: `This month's Codium usage is used up. It renews on ${renews}; change your plan to keep using Codium models before then.`,
  })
  expect(ModelPlanStatus.describe(status).at(-2)).toBe(ModelPlanStatus.notice(status)?.text)
  expect(
    ModelPlanStatus.notice(ModelPlanStatus.fromRemote({ ...spent, plan: { ...spent.plan, cancelAtPeriodEnd: true } }))
      ?.text,
  ).toBe(
    `This month's Codium usage is used up, and your plan ends on ${renews}. See plans to keep using Codium models.`,
  )
  // Purchased credits too low for a reply, with no plan.
  expect(
    ModelPlanStatus.notice(
      ModelPlanStatus.fromRemote({ ...spent, plan: undefined, purchased: { bought: true, state: "low" } }),
    ),
  ).toEqual({
    kind: "empty",
    text: "Too little Codium usage is left for a reply. See plans to continue.",
  })
  expect(ModelPlanStatus.fromRemote({ ...spent, purchased: { bought: false, state: "available" } }).purchased).toEqual({
    bought: false,
  })
})

test("someone signed out learns whether Codium is on sale from the public configuration", async () => {
  const seen: { url: string; authorization: string | null }[] = []
  const answer =
    (body: unknown, status = 200) =>
    async (url: string, init: RequestInit) => {
      seen.push({ url, authorization: new Headers(init.headers).get("authorization") })
      return Response.json(body, { status })
    }
  expect(await ModelPlanStatus.salesOpen(answer({ enabled: false, plans: [] }))).toBe(false)
  expect(await ModelPlanStatus.salesOpen(answer({ enabled: true, plans: [] }))).toBe(true)
  // It cannot tell: neither the purchase link nor "not available yet".
  expect(await ModelPlanStatus.salesOpen(answer({ error: "unavailable" }, 503))).toBeUndefined()
  expect(await ModelPlanStatus.salesOpen(answer({ plans: [] }))).toBeUndefined()
  expect(await ModelPlanStatus.salesOpen(() => Promise.reject(new Error("offline")))).toBeUndefined()
  // The public configuration needs no sign-in, and none is sent.
  expect(seen.every((item) => item.url === "https://vectordev.ai/api/model-plans/config" && !item.authorization)).toBe(
    true,
  )
})

test("the offers Vector shows carry names and prices only, and nothing is available while sales are off", async () => {
  const seen: { url: string; authorization: string | null }[] = []
  const answer =
    (body: unknown, status = 200) =>
    async (url: string, init: RequestInit) => {
      seen.push({ url, authorization: new Headers(init.headers).get("authorization") })
      return Response.json(body, { status })
    }
  // What /api/model-plans/config answers, with each purchase's multiple and typical tasks beside its price. This one
  // still answers names from before the plans were renamed, as a site that has not redeployed would.
  const config = (enabled: boolean) => ({
    product: "Vector Codium",
    enabled,
    plans: [10, 50].map((price, index) => ({
      id: `vector-${price}`,
      name: `Retired plan ${price}`,
      price,
      available: enabled,
      ...(index ? { multiple: 5.2 } : {}),
      tasks: [[50, 500]],
    })),
    topups: [
      { id: "codium-topup-10", name: "Retired top-up 10", price: 10, available: true, tasks: [] },
      { id: "vector-team", name: "Team", price: 30, available: true },
    ],
  })
  const offers = await ModelPlanStatus.fetchOffers(answer(config(true)))
  // A plan Vector knows shows its current name, whatever name the site gave it.
  // Codium sells monthly plans only: an old site's top-ups are not read, so nothing can offer one.
  expect(offers).toEqual({
    enabled: true,
    plans: [
      { id: "vector-10", name: "Plus", price: 10, available: true },
      { id: "vector-50", name: "Pro", price: 50, available: true },
    ],
  })
  expect(JSON.stringify(offers)).not.toMatch(/multiple|tasks|5\.2|credits|topup|Team/)
  // While Codium is off, an item the server marks available still cannot be bought.
  const off = await ModelPlanStatus.fetchOffers(answer(config(false)))
  expect(off?.enabled).toBe(false)
  expect(off!.plans.every((offer) => !offer.available)).toBe(true)
  expect(await ModelPlanStatus.fetchOffers(answer({ error: "unavailable" }, 503))).toBeUndefined()
  expect(await ModelPlanStatus.fetchOffers(answer({ enabled: true }))).toBeUndefined()
  expect(await ModelPlanStatus.fetchOffers(() => Promise.reject(new Error("offline")))).toBeUndefined()
  expect(seen.every((item) => item.url === "https://vectordev.ai/api/model-plans/config" && !item.authorization)).toBe(
    true,
  )
})

test("a plan shows its current name whatever name the site answers, and Free when there is none", () => {
  const remote = { enabled: true, access: true, purchased: { bought: false }, empty: false, low: false }
  const plan = (id: string) =>
    ModelPlanStatus.fromRemote({
      ...remote,
      plan: { id, name: "Retired plan name", renewsAt: 1_790_000_000_000, cancelAtPeriodEnd: false },
    }).plan?.name
  expect(["vector-10", "vector-50", "vector-100", "vector-200"].map(plan)).toEqual(["Plus", "Pro", "Max", "Ultra"])
  expect(plan("vector-team")).toBe("Retired plan name")
  expect(ModelPlanStatus.describe(ModelPlanStatus.fromRemote({ ...remote, plan: undefined }))[0]).toBe("Plan: Free")
})

test("status says when vectordev.ai keeps a billing account, so invoices stay reachable without a plan", () => {
  const remote = { enabled: true, access: false, purchased: { bought: false }, empty: true, low: false }
  expect(ModelPlanStatus.fromRemote({ ...remote, customer: true }).customer).toBe(true)
  expect(ModelPlanStatus.fromRemote(remote)).not.toHaveProperty("customer")
})

test("status keeps no amount, even from a server that still sends one", async () => {
  const saved = gateway.state.status
  gateway.state.status = { ...saved, credits: 25, remaining: 1.5, wallet: { credits: 10, used: 9.5, remaining: 0.5 } }
  const status = await ModelPlanStatus.fetchStatus(token, gateway.forward)
  // Only shares remain (today's `used` is a share of the daily limit); none of the amounts or their keys.
  expect(JSON.stringify(status)).not.toMatch(/credits|remaining|wallet|25|1\.5|9\.5/)
  // An answer that is not shares, such as an old server's amounts, is refused rather than shown as a share.
  gateway.state.status = { ...saved, plan: { ...(saved.plan as object), left: 1.5 } }
  expect(await ModelPlanStatus.fetchStatus(token, gateway.forward)).toMatchObject({
    error: "Vector could not load your Codium usage. Try again shortly.",
  })
  gateway.state.status = saved
})

test("purchased credits are decoded for old answers but never shown", () => {
  const buyer = (purchased: { bought: boolean; state?: "available" | "low" | "used" }) =>
    ModelPlanStatus.fromRemote({ enabled: true, access: true, purchased, empty: false, low: false })
  // Codium sells no top-ups any more, so the text surfaces leave purchased credits out.
  expect(ModelPlanStatus.describe(buyer({ bought: true, state: "available" })).join(" ")).not.toMatch(/purchased/i)
  // A state is kept only for credits that were bought.
  expect(buyer({ bought: false, state: "available" }).purchased).toEqual({ bought: false })
})

test("the app recognises a failed Codium turn from the engine's error and from a V2 assistant error", () => {
  expect(
    ModelPlanStatus.failureAction({ name: "APIError", data: { message: "x", metadata: { codium: "credits" } } }),
  ).toBe("credits")
  expect(ModelPlanStatus.failureAction({ type: "codium", action: "sign-in", message: "x" })).toBe("sign-in")
  expect(ModelPlanStatus.failureAction({ name: "APIError", data: { message: "x", metadata: { url: "u" } } })).toBe(
    undefined,
  )
  expect(ModelPlanStatus.failureAction({ name: "UnknownError", data: { metadata: { codium: "credits" } } })).toBe(
    undefined,
  )
  expect(ModelPlanStatus.failureAction({ type: "codium", action: "capacity", message: "x" })).toBeUndefined()
})

test("the app reads a failed turn's code and splits off the step the engine's message ends with", () => {
  expect(
    ModelPlanStatus.failureCode({
      name: "APIError",
      data: { message: "x", metadata: { codium: "credits", kind: "credits", code: "MODEL_PLAN_EXHAUSTED" } },
    }),
  ).toBe("MODEL_PLAN_EXHAUSTED")
  expect(ModelPlanStatus.failureCode({ type: "codium", action: "credits", code: "MODEL_PLAN_REQUIRED" })).toBe(
    "MODEL_PLAN_REQUIRED",
  )
  expect(ModelPlanStatus.failureCode({ name: "APIError", data: { metadata: { codium: "credits" } } })).toBeUndefined()
  expect(ModelPlanStatus.failureCode("MODEL_PLAN_EXHAUSTED")).toBeUndefined()

  const body = (code: string, action?: string) =>
    JSON.stringify({ error: { code, message: "Server message.", ...(action ? { action } : {}) } })
  const parts = (status: number, code: string, action?: string) =>
    ModelPlanStatus.failureParts(ModelPlanStatus.gatewayFailure(status, body(code, action))!.message)
  // Every sentence the engine ends a final answer with comes back as its kind and payment step, and only the server's
  // own message is left.
  expect(parts(402, "MODEL_PLAN_REQUIRED")).toEqual({ text: "Server message.", kind: "credits" })
  expect(parts(402, "MODEL_PLAN_EXHAUSTED")).toEqual({ text: "Server message.", kind: "credits" })
  expect(parts(402, "MODEL_PLAN_PAYMENT_REQUIRED", "update-card")).toEqual({
    text: "Server message.",
    kind: "credits",
    payment: "update-card",
  })
  expect(parts(402, "MODEL_PLAN_PAYMENT_REQUIRED", "confirm-payment")).toEqual({
    text: "Server message.",
    kind: "credits",
    payment: "confirm-payment",
  })
  expect(parts(403, "MODEL_PLAN_UPGRADE_REQUIRED")).toEqual({ text: "Server message.", kind: "upgrade" })
  expect(parts(409, "MODEL_PLAN_EXISTS")).toEqual({ text: "Server message.", kind: "plan" })
  // A daily, run or Brain limit, or a sign-in, ends with no purchase step, so nothing is split off.
  for (const code of ["MODEL_PLAN_DAILY_LIMIT", "MODEL_PLAN_RUN_LIMIT", "MODEL_PLAN_BRAIN_SHARE"])
    expect(parts(429, code)).toEqual({ text: "Server message." })
  expect(parts(401, "CODIUM_SIGN_IN_REQUIRED").kind).toBeUndefined()
  // Turns stored before Codium stopped selling top-ups end "Buy credits at"; the link is a credit step too.
  expect(ModelPlanStatus.failureParts(`Out of credits. Buy credits at ${ModelPlanStatus.PURCHASE_URL}`)).toEqual({
    text: "Out of credits.",
    kind: "credits",
  })
  // Only an ending counts: a URL inside the text is the server's.
  const inside = `See plans at ${ModelPlanStatus.PURCHASE_URL} first.`
  expect(ModelPlanStatus.failureParts(inside)).toEqual({ text: inside })
})

test("a Codium entry the plan does not include is badged, and only usable entries are ever picked automatically", () => {
  const locked = { plan: "vector-50", name: "Pro" }
  expect(ModelPlanStatus.listingBadge({ locked })).toEqual({
    label: "Codium · Pro",
    title: "Included in Pro and above",
  })
  expect(
    ModelPlanStatus.listingBadge({ locked: { plan: "vector-200", name: "Ultra", previewUntil: 1_900_000_000_000 } }),
  ).toEqual({ label: "Preview · Ultra", title: "Only in Ultra during its preview" })
  expect(ModelPlanStatus.listingBadge({ preview: { until: 1_900_000_000_000 } })?.label).toBe("Preview")
  for (const plain of [undefined, {}, { manualOnly: true }, { auto: { floor: "a", default: "b", ceiling: "c" } }])
    expect(ModelPlanStatus.listingBadge(plain)).toBeUndefined()
  // No badge names credits, a price or an amount.
  expect(JSON.stringify(ModelPlanStatus.listingBadge({ locked }))).not.toMatch(/credit|\$|\d/)

  const entry = (codium?: ModelPlanStatus.Listing, id = "vendor/model") => ({ id, codium })
  expect(ModelPlanStatus.automatic(entry())).toBe(true)
  expect(ModelPlanStatus.automatic(entry({ lab: "deepseek", role: "default" }))).toBe(true)
  expect(ModelPlanStatus.automatic(entry({ locked }))).toBe(false)
  expect(ModelPlanStatus.automatic(entry({ manualOnly: true }))).toBe(false)
  expect(ModelPlanStatus.automatic(entry({ auto: { floor: "a", default: "b", ceiling: "c" } }))).toBe(false)
  // Auto by its id alone, as an older listing without metadata names it.
  expect(ModelPlanStatus.automatic(entry(undefined, ModelPlanStatus.AUTO_ID))).toBe(false)
  expect(ModelPlanStatus.isAuto(entry(undefined, ModelPlanStatus.AUTO_ID))).toBe(true)
  expect(ModelPlanStatus.isLocked(entry({ locked }))).toBe(true)
  expect(ModelPlanStatus.isLocked(entry({ manualOnly: true }))).toBe(false)
})

test("a session continues on the model its last message selected, else on the one it ran with its variant", () => {
  const ran = { providerID: "vector-plan", modelID: "vendor/default", variant: "high" }
  expect(ModelPlanStatus.sessionModel({ model: ran })).toEqual(ran)
  // Codium Auto picks again for the next message, so neither the model it picked nor that model's variant is kept.
  expect(
    ModelPlanStatus.sessionModel({
      model: ran,
      selected: { providerID: "vector-plan", modelID: ModelPlanStatus.AUTO_ID },
    }),
  ).toEqual({ providerID: "vector-plan", modelID: ModelPlanStatus.AUTO_ID })
  expect(ModelPlanStatus.sessionModel({})).toBeUndefined()
})

test("automatic choices try connected providers, then shared free models, and never Codium", () => {
  const provider = (id: string, source?: "shared" | "openrouter") => ({
    id,
    models: { coder: source ? { freeModel: { source } } : {} },
  })
  const codium = provider(ModelPlanStatus.PROVIDER_ID)
  const shared = provider("vector", "shared")
  const keyed = provider("anthropic")
  expect(ModelPlanStatus.automaticProviders([codium, shared, keyed])).toEqual([keyed])
  expect(ModelPlanStatus.automaticProviders([codium, shared])).toEqual([shared])
  // Codium alone is still not chosen for the person; they pick one of its models themselves.
  expect(ModelPlanStatus.automaticProviders([codium])).toEqual([])
  expect(ModelPlanStatus.automaticProviders([])).toEqual([])
})
