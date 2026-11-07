import { afterAll, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, Stream } from "effect"
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
import { codiumGateway, codiumModel } from "./fixture/codium-gateway"

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
const service = (catalog = active) =>
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
  // Next launch: vectordev.ai has not answered by the listing deadline. It never answers here, because a late answer
  // from one launch saves its catalog over the file that the later launches below replace and read.
  const slow = () => new Promise<Response>(() => {})
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

test("the catalog reads the signed-in account's models from the gateway", async () => {
  const client = ModelPlans.createClient({ request: gateway.forward })
  expect(await client.catalog(token)).toEqual(active)
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
    return ModelPlans.gatewayFailure(response.status, await response.text())
  }
  expect(await attempt(undefined, active)).toMatchObject({
    kind: "sign-in",
    message: "Sign in to Vector to use Vector Codium.",
  })
  expect(await attempt(token, off)).toMatchObject({
    kind: "unavailable",
    message: "Vector Codium is not available right now. Choose another model.",
  })
  expect(await attempt(token, { enabled: true, models: [{ ...codiumModel, id: "vendor/other" }] })).toMatchObject({
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
  for (const [mode, tag, message, action] of [
    [
      "credits",
      "QuotaExceeded",
      `Your monthly Codium credits cannot cover this model's largest request right now. Wait for running requests to finish, choose a model that uses fewer credits, or add a top-up. Monthly credits renew each billing period. Buy credits at ${ModelPlans.PURCHASE_URL}`,
      "credits",
    ],
    ["disabled", "InvalidRequest", "Vector Codium is not available yet. Choose another model.", "unavailable"],
    [
      "context",
      "InvalidRequest",
      "This conversation is too long for the Codium model. Compact it before continuing.",
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
    expect(codiumError(failure)).toEqual(action && { type: "codium", action, message })
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
      "Vector Codium could not run this request: model capacity may be short for a moment, or your credits may have reached their limit. Vector will try again shortly; if it keeps failing, check your balance.",
  })
  expect(failure.reason.message).not.toContain("Buy credits")
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

test("gateway answers map to the action that fixes them", () => {
  const body = (code: string, message = "Server message.") => JSON.stringify({ error: { code, message } })
  for (const code of [
    "MODEL_PLAN_REQUIRED",
    "MODEL_PLAN_PAYMENT_REQUIRED",
    "MODEL_PLAN_EXHAUSTED",
    "MODEL_TOPUP_EXHAUSTED",
  ])
    expect(ModelPlans.gatewayFailure(402, body(code))).toEqual({
      code,
      kind: "credits",
      message: `Server message. Buy credits at ${ModelPlans.PURCHASE_URL}`,
    })
  // The provider refusing for want of credit: Vector's capacity, or the account key's own limit.
  expect(ModelPlans.gatewayFailure(402, body("MODEL_PLAN_CAPACITY"))).toMatchObject({ kind: "capacity" })
  expect(ModelPlans.gatewayFailure(402, "not json")).toBeUndefined()
  expect(ModelPlans.gatewayFailure(402, body("SOMETHING_NEW"))).toBeUndefined()
  expect(ModelPlans.gatewayFailure(401, body("CLI_TOKEN_INVALID"))).toMatchObject({ kind: "sign-in" })
  expect(ModelPlans.gatewayFailure(503, body("MODEL_PLANS_DISABLED"))).toMatchObject({ kind: "unavailable" })
  expect(ModelPlans.gatewayFailure(503, body("MODEL_PLANS_CONFIGURATION"))).toMatchObject({ kind: "unavailable" })
  expect(ModelPlans.gatewayFailure(409, body("MODEL_PLAN_ACCOUNT_CLOSING"))).toMatchObject({ kind: "unavailable" })
  expect(ModelPlans.gatewayFailure(400, body("MODEL_PLAN_MODEL"))).toMatchObject({ kind: "unavailable" })
  // Busy and upstream failures are left to the normal retry policy.
  expect(ModelPlans.gatewayFailure(429, body("MODEL_PLAN_BUSY"))).toBeUndefined()
  expect(ModelPlans.gatewayFailure(503, body("MODEL_PLAN_UPSTREAM"))).toBeUndefined()
  expect(ModelPlans.contextFailure(body("MODEL_PLAN_CONTEXT"))).toBe(true)
})

test("status reads the plan and the share of each balance left, never an amount, and flags a low balance", async () => {
  const before = gateway.seen.length
  const status = await ModelPlanStatus.fetchStatus(token, gateway.forward)
  expect(gateway.seen.slice(before)).toEqual([
    { path: "/api/model-plans/status", authorization: `Bearer ${token}`, body: undefined },
  ])
  expect(status).toEqual({
    signedIn: true,
    enabled: true,
    access: true,
    customer: true,
    plan: { id: "vector-50", name: "Pro", left: 0.06, renewsAt: 1_790_000_000_000, cancelAtPeriodEnd: false },
    purchased: { bought: true, state: "low" },
    empty: false,
    low: true,
  })
  expect(ModelPlanStatus.describe(status)).toEqual([
    `Plan: Pro, 6% of this month's credits left, renews ${ModelPlanStatus.formatDate(1_790_000_000_000)}`,
    "Purchased credits: running low",
    "You are running low on Codium credits.",
  ])
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
    "Purchased credits: none",
    "You have no Codium credits available. Buy credits to use Codium models.",
  ])
  gateway.state.status = {
    enabled: false,
    active: false,
    access: false,
    purchased: { bought: false },
    empty: true,
    low: false,
  }
  expect(ModelPlanStatus.describe(await ModelPlanStatus.fetchStatus(token, gateway.forward)).at(-1)).toBe(
    "Vector Codium is not available yet.",
  )
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
    error: "Vector could not load your Codium balance. Try again shortly.",
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
    text: `Too few of your monthly Codium credits are left for a reply. They renew on ${renews}; buy credits to keep using Codium models before then.`,
  })
  expect(ModelPlanStatus.describe(status).at(-1)).toBe(ModelPlanStatus.notice(status)?.text)
  expect(
    ModelPlanStatus.notice(ModelPlanStatus.fromRemote({ ...spent, plan: { ...spent.plan, cancelAtPeriodEnd: true } }))
      ?.text,
  ).toBe(
    `Too few Codium credits are left for a reply, and your plan ends on ${renews}. Buy credits to keep using Codium models.`,
  )
  // Purchased credits too low for a reply, with no plan.
  expect(
    ModelPlanStatus.notice(
      ModelPlanStatus.fromRemote({ ...spent, plan: undefined, purchased: { bought: true, state: "low" } }),
    ),
  ).toEqual({
    kind: "empty",
    text: "Too few Codium credits are left for a reply. Buy credits to keep using Codium models.",
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
  // A plan or top-up Vector knows shows its current name; one it does not know keeps the name the site gave it.
  expect(offers).toEqual({
    enabled: true,
    plans: [
      { id: "vector-10", name: "Plus", price: 10, available: true },
      { id: "vector-50", name: "Pro", price: 50, available: true },
    ],
    topups: [
      { id: "codium-topup-10", name: "$10 credit top-up", price: 10, available: true },
      { id: "vector-team", name: "Team", price: 30, available: true },
    ],
  })
  expect(JSON.stringify(offers)).not.toMatch(/multiple|tasks|5\.2|credits/)
  // While Codium is off, an item the server marks available still cannot be bought.
  const off = await ModelPlanStatus.fetchOffers(answer(config(false)))
  expect(off?.enabled).toBe(false)
  expect([...off!.plans, ...off!.topups].every((offer) => !offer.available)).toBe(true)
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
  expect(JSON.stringify(status)).not.toMatch(/credits|remaining|used|wallet|25|1\.5|9\.5/)
  // An answer that is not shares, such as an old server's amounts, is refused rather than shown as a share.
  gateway.state.status = { ...saved, plan: { ...(saved.plan as object), left: 1.5 } }
  expect(await ModelPlanStatus.fetchStatus(token, gateway.forward)).toMatchObject({
    error: "Vector could not load your Codium balance. Try again shortly.",
  })
  gateway.state.status = saved
})

test("purchased credits read as a state, not as a share of every top-up ever bought", () => {
  // A long-time buyer's share of every top-up ever bought would read "under 1% left" right after a fresh purchase.
  const buyer = (purchased: { bought: boolean; state?: "available" | "low" | "used" }) =>
    ModelPlanStatus.fromRemote({ enabled: true, access: true, purchased, empty: false, low: false })
  expect(
    [
      buyer({ bought: true, state: "available" }),
      buyer({ bought: true, state: "low" }),
      buyer({ bought: true, state: "used" }),
      buyer({ bought: true }),
      buyer({ bought: false }),
    ].map((status) => ModelPlanStatus.formatPurchased(status.purchased)),
  ).toEqual(["Available", "Running low", "Used up", "Balance unavailable", "None"])
  expect(ModelPlanStatus.describe(buyer({ bought: true, state: "available" }))).toContain(
    "Purchased credits: available",
  )
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
