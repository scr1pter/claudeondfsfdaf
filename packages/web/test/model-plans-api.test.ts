import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { createHash } from "node:crypto"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { createServer, IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mintCliToken } from "../../../api/_lib/cli-token"
import {
  cancelModelPlanAccount,
  holdPool,
  keyExpiresAt,
  modelPlanCheckout,
  modelPlanCredential,
  modelPlanPortal,
  modelPlanStatus,
  paidModelPlan,
  readModelPlanAccount,
  reconcileModelPlanAccount,
  snapshotPoolCredential,
} from "../../../api/_lib/model-plan-account"
import {
  handleModelPlanChange,
  handleModelPlanCheckout,
  handleModelPlanPortal,
  handleModelTopupRemoved,
} from "../../../api/_lib/model-plan-billing"
import { handleModelPlanChat } from "../../../api/_lib/model-plan-chat"
import { ADMISSION_SCRIPTS, admitModelPlan, settleModelPlan } from "../../../api/_lib/model-plan-admit"
import { readSnapshot } from "../../../api/_lib/codium-snapshot"
import { drainOutbox, enqueueAction } from "../../../api/_lib/codium-provision"
import { createRunVerifierRegistry, type ModelPlanCaller } from "../../../api/_lib/model-plan-caller"
import type { AfterSettleContext, GatewayHook } from "../../../api/_lib/model-plan-gateway-hooks"
import { ApiError } from "../../../api/_lib/http"
import { readModelSpendDay, readModelSpendLedger } from "../../../api/_lib/codium-spend-ledger"
import { verifiedGatewayModel, type ModelPlanCatalogOptions } from "../../../api/_lib/model-plan-catalog-policy"
import { CODIUM_MODELS } from "../../../api/_lib/codium-catalog"
import {
  modelPlanAttempts,
  modelPlanReservation,
  nominalModelPlanRequestCredits,
  type ModelPlanModel,
} from "../../../api/_lib/model-plan-config"
import { handleModelPlanModels } from "../../../api/_lib/model-plan-models"
import { handleModelPlanStatus, modelPlanBalance } from "../../../api/_lib/model-plan-status"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { publicEntitlements } from "../../../packages/schema/src/codium-entitlements"

// External HTTP boundaries are local fixtures; leases and rate-limit Lua run
// against a real, isolated Redis/Valkey database, just as in free-models-api.
const temporary = await mkdtemp(join(tmpdir(), "vector-model-plans-"))
const socket = join(temporary, "db.sock")
const database = process.env.VECTOR_TEST_REDIS_URL ? new RedisClient(process.env.VECTOR_TEST_REDIS_URL) : undefined
const processHandle = database
  ? undefined
  : Bun.spawn(
      [
        process.env.VECTOR_TEST_VALKEY_SERVER ?? "valkey-server",
        "--port",
        "0",
        "--unixsocket",
        socket,
        "--unixsocketperm",
        "700",
        "--save",
        "",
        "--appendonly",
        "no",
        "--dir",
        temporary,
      ],
      { stdout: "ignore", stderr: "pipe" },
    )

async function redis(command: readonly (string | number)[]): Promise<unknown> {
  if (database) return database.send(String(command[0]), command.slice(1).map(String))
  const child = Bun.spawn(
    [process.env.VECTOR_TEST_VALKEY_CLI ?? "valkey-cli", "-s", socket, "--json", ...command.map(String)],
    { stdout: "pipe", stderr: "pipe" },
  )
  const output = await new Response(child.stdout).text()
  if (await child.exited) throw new Error(`Fixture Redis command failed: ${await new Response(child.stderr).text()}`)
  return JSON.parse(output)
}

const user = { id: "11111111-1111-4111-8111-111111111111", email: "fixture@example.test" }
// Stripe test mode keeps every Codium key in the test namespace.
const accountKey = `vector:codium:test:account:${user.id}`
const heldKey = "vector:codium:test:held:hash_fixture1"
const model = {
  id: "fixture/paid-model",
  name: "Fixture model",
  contextLength: 8192,
  maxOutputTokens: 2048,
  inputPrice: 1,
  outputPrice: 2,
}
const environment = [
  "NODE_ENV",
  "VERCEL_ENV",
  "CODIUM_STRIPE_MODE",
  "CODIUM_TEST_CREDIT_CAP_USD",
  "CODIUM_3DS_MIN_USD",
  "VECTOR_ADMIN_EMAILS",
  "MODEL_PLANS_MIN_CLIENT",
  "MODEL_PLAN_GLOBAL_INFLIGHT",
  "MODEL_PLAN_PRIORITY_RESERVE",
  "MODEL_PLANS_ENABLED",
  "MODEL_PLAN_MODELS_JSON",
  "MODEL_PLAN_KEY_ENCRYPTION_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_MODEL_PLAN_WEBHOOK_SECRET",
  "STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID",
  "STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "OPENROUTER_MANAGEMENT_KEY",
  "VECTOR_CLI_TOKEN_SECRET",
  "VECTOR_ABUSE_SECRET",
  "VECTOR_PUBLIC_URL",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  ...[10, 50, 100, 200].flatMap((price) => [`MODEL_PLAN_${price}_CREDITS_USD`, `STRIPE_MODEL_PLAN_${price}_PRICE_ID`]),
]
const previousEnvironment = new Map(environment.map((key) => [key, process.env[key]]))

function subscription(start = Math.floor(Date.now() / 1000) - 3600, end = start + 7200, price = 10) {
  return {
    id: "sub_fixture",
    status: "active",
    cancel_at_period_end: false,
    metadata: { vector_account_id: user.id },
    items: {
      data: [
        {
          quantity: 1,
          current_period_start: start,
          current_period_end: end,
          price: {
            id: `price_fixture${price}`,
            active: true,
            currency: "usd",
            unit_amount: price * 100,
            recurring: { interval: "month", interval_count: 1 },
          },
        },
      ],
    },
    latest_invoice: {
      id: "in_fixture",
      paid: true,
      status: "paid",
      amount_paid: price * 100,
      charge: {
        paid: true,
        refunded: false,
        disputed: false,
        amount_refunded: 0,
        payment_method_details: { card: { three_d_secure: { result: "authenticated" } } },
      },
      lines: { data: [{ price: { id: `price_fixture${price}` }, period: { start, end }, proration: false }] },
    },
  }
}

const state = {
  origin: "",
  unavailable: false,
  loseCheckoutResponse: false,
  failClosingWrite: false,
  failCheckoutExpiry: false,
  failSubscriptionCancellation: false,
  checkoutListMode: "normal",
  priceMismatch: false,
  upstreamStatus: 200,
  streamMode: "normal",
  charge: 0,
  keyReadDelay: 0,
  chatDelay: 0,
  gatewayModels: undefined as readonly ModelPlanModel[] | undefined,
  gatewayFetcher: undefined as typeof fetch | undefined,
  runVerifiers: undefined as ReturnType<typeof createRunVerifierRegistry> | undefined,
  hostedLive: undefined as ((session: string) => Promise<boolean>) | undefined,
  hooks: undefined as readonly GatewayHook[] | undefined,
  upstreamStatuses: [] as number[],
  admitGate: undefined as Promise<void> | undefined,
  admitReached: () => {},
  failSettles: 0,
  failSettlesFrom: 0,
  throwTransport: false,
  dispatches: 0,
  subscriptions: [] as (ReturnType<typeof subscription> & { schedule?: string })[],
}
const calls: { path: string; method: string; headers: Headers; body: Record<string, unknown> }[] = []
const commands: (string | number)[][] = []
const sessions = new Map<
  string,
  { id: string; customer: string; url: string; expires_at: number; status: string; metadata: Record<string, unknown> }
>()
const idempotency = new Map<string, Record<string, unknown>>()
const keys = new Map<string, { secret: string; data: Record<string, unknown> }>()
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/redis") {
      if (state.unavailable) return new Response(null, { status: 503 })
      expect(request.headers.get("authorization")).toBe("Bearer fixture-kv-token")
      const command: unknown = await request.json()
      if (!Array.isArray(command) || command.some((part) => typeof part !== "string" && typeof part !== "number"))
        throw new Error("Invalid Redis command")
      commands.push(command)
      // A test can hold an admission EVAL after its credential read, to land it after another write.
      if (state.admitGate && command[0] === "EVAL" && command[1] === ADMISSION_SCRIPTS.ADMIT) {
        state.admitReached()
        await state.admitGate
      }
      // A settlement whose answer is lost (the store's reply never arrives), for requests admitted from a given time.
      if (
        state.failSettles > 0 &&
        command[0] === "EVAL" &&
        command[1] === ADMISSION_SCRIPTS.SETTLE &&
        JSON.parse(String(command[3 + Number(command[2])])).admittedAt >= state.failSettlesFrom
      ) {
        state.failSettles--
        return new Response(null, { status: 503 })
      }
      if (
        state.failClosingWrite &&
        command[0] === "SET" &&
        command[1] === accountKey &&
        String(command[2]).includes('"closing":true')
      )
        return new Response(null, { status: 503 })
      return Response.json({ result: await redis(command) })
    }
    const body =
      request.method === "GET"
        ? {}
        : request.headers.get("content-type")?.includes("json")
          ? ((await request.json()) as Record<string, unknown>)
          : Object.fromEntries(new URLSearchParams(await request.text()))
    calls.push({ path: url.pathname, method: request.method, headers: new Headers(request.headers), body })
    // The website's browser session, as Supabase answers for it.
    if (url.pathname === "/auth/v1/user") {
      if (request.headers.get("authorization") !== "Bearer browser-session") return new Response(null, { status: 401 })
      return Response.json({ ...user, email_confirmed_at: "2026-01-01T00:00:00Z" })
    }
    if (url.pathname.startsWith("/v1/")) {
      expect(request.headers.get("authorization")).toBe("Bearer sk_test_fixture")
      if (url.pathname === "/v1/customers") return Response.json({ id: "cus_fixture" })
      if (url.pathname === "/v1/subscriptions") return Response.json({ data: state.subscriptions, has_more: false })
      if (url.pathname.startsWith("/v1/subscriptions/") && request.method === "DELETE") {
        if (state.failSubscriptionCancellation) return new Response(null, { status: 503 })
        const subscription = state.subscriptions.find((item) => item.id === url.pathname.split("/").at(-1))
        if (!subscription) return Response.json({ error: "Unknown subscription" }, { status: 404 })
        subscription.status = "canceled"
        return Response.json(subscription)
      }
      if (url.pathname.startsWith("/v1/prices/")) {
        const amount = Number(url.pathname.match(/(\d+)$/)?.[1])
        return Response.json({
          active: true,
          currency: "usd",
          unit_amount: (state.priceMismatch ? amount + 1 : amount) * 100,
          recurring: { interval: "month", interval_count: 1 },
        })
      }
      if (url.pathname === "/v1/invoices" && request.method === "GET")
        return Response.json({ data: [], has_more: false })
      if (url.pathname === "/v1/checkout/sessions") {
        if (request.method === "GET") {
          expect(url.searchParams.get("customer")).toBe("cus_fixture")
          expect(url.searchParams.get("status")).toBe("open")
          if (state.checkoutListMode === "invalid") return Response.json({ data: null, has_more: false })
          return Response.json({
            data: [...sessions.values()].filter(
              (session) => session.customer === url.searchParams.get("customer") && session.status === "open",
            ),
            has_more: state.checkoutListMode === "more",
          })
        }
        const token = request.headers.get("idempotency-key")
        if (!token) throw new Error("Checkout has no idempotency key")
        if (idempotency.has(token)) return Response.json(idempotency.get(token))
        const session = {
          id: `cs_fixture${sessions.size + 1}`,
          customer: String(body.customer),
          url: `https://checkout.stripe.com/c/pay/cs_fixture${sessions.size + 1}`,
          expires_at: Number(body.expires_at),
          status: "open",
          metadata: Object.fromEntries(
            Object.entries(body)
              .filter(([key]) => key.startsWith("metadata["))
              .map(([key, value]) => [key.slice(9, -1), value]),
          ),
        }
        sessions.set(session.id, session)
        idempotency.set(token, session)
        if (state.loseCheckoutResponse) {
          state.loseCheckoutResponse = false
          return Response.json({ error: "fixture response lost" }, { status: 503 })
        }
        return Response.json(session)
      }
      if (url.pathname.startsWith("/v1/checkout/sessions/")) {
        const session = sessions.get(url.pathname.split("/")[4]!)
        if (!session) return Response.json({ error: "Unknown session" }, { status: 404 })
        if (url.pathname.endsWith("/expire")) {
          if (state.failCheckoutExpiry) return new Response(null, { status: 503 })
          session.status = "expired"
        }
        return Response.json(session)
      }
      if (url.pathname === "/v1/billing_portal/sessions")
        return Response.json({ url: "https://billing.stripe.com/p/session/fixture" })
    }
    if (url.pathname.startsWith("/api/v1/keys")) {
      expect(request.headers.get("authorization")).toBe("Bearer fixture-management-key")
      if (request.method === "POST") {
        const hash = `hash_fixture${keys.size + 1}`
        const key = {
          secret: `fixture-paid-secret-${keys.size + 1}`,
          data: { ...body, hash, disabled: false, usage: 0 },
        }
        keys.set(hash, key)
        return Response.json({ key: key.secret, data: key.data })
      }
      const key = keys.get(url.pathname.split("/").at(-1)!)
      if (!key) return Response.json({ error: "Unknown key" }, { status: 404 })
      if (request.method === "PATCH") Object.assign(key.data, body)
      if (request.method === "GET" && state.keyReadDelay) await Bun.sleep(state.keyReadDelay)
      return Response.json({ data: key.data })
    }
    if (url.pathname === "/api/v1/chat/completions") {
      expect(request.headers.get("authorization")).toBe(`Bearer ${keys.values().next().value?.secret}`)
      const status = state.upstreamStatuses.shift() ?? state.upstreamStatus
      if (status !== 200) return Response.json({ error: { message: "PRIVATE fixture-paid-secret-1" } }, { status })
      // The provider bills a request, and the key's usage grows, only once it finishes.
      if (state.chatDelay) await Bun.sleep(state.chatDelay)
      const charged = keys.values().next().value
      if (charged && state.charge) charged.data.usage = Number(charged.data.usage ?? 0) + state.charge
      const mode = state.streamMode
      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()
            // OpenRouter names the provider that served the request, as it does on every chunk.
            controller.enqueue(
              encoder.encode(
                'data: {"id":"gen-fixture","provider":"PRIVATE-PROVIDER","system_fingerprint":"fp_private","choices":[{"delta":{"content":"fixture"},"native_finish_reason":"PRIVATE-REASON"}]}\r',
              ),
            )
            controller.enqueue(encoder.encode("\n\r\n"))
            if (mode === "error")
              controller.enqueue(
                encoder.encode('data: {"error":{"code":402,"message":"PRIVATE fixture-paid-secret-1"}}\n\n'),
              )
            if (mode === "invalid") controller.enqueue(encoder.encode("data: not-json\n\n"))
            if (state.charge)
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ provider: "PRIVATE-PROVIDER", choices: [], usage: { prompt_tokens: 200, completion_tokens: 6, total_tokens: 206, cost: state.charge, is_byok: false, cost_details: { upstream_inference_cost: state.charge } } })}\n\n`,
                ),
              )
            if (mode !== "truncated") controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`)
  },
})
const fetcher: typeof fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname === "/api/v1/chat/completions") {
      state.dispatches++
      if (state.throwTransport) throw new Error("Fixture transport lost after dispatch")
    }
    if (url.origin === "https://api.stripe.com" || url.origin === "https://openrouter.ai")
      return fetch(new URL(url.pathname + url.search, upstream.url), init)
    if (url.origin === upstream.url.origin) return fetch(input, init)
    throw new Error(`Unexpected network destination ${url.origin}`)
  },
  { preconnect: fetch.preconnect },
)
// The invented fixture models have no captured native window, so tests inject an explicit synthetic reservation.
const fixtureReservation = (selected: ModelPlanModel, plan: Parameters<typeof modelPlanReservation>[1]) => {
  const attemptMicro = Math.ceil(nominalModelPlanRequestCredits(selected, plan) * 1_000_000 - 1e-6)
  const attempts = modelPlanAttempts(plan)
  return { attemptMicro, attempts, requiredMicro: attemptMicro * attempts }
}
// Only this local upstream implements the invented fixture model. Planned catalogs must be explicitly supplied by a
// test; ordinary active-model requests retain the production qualification guard. Chat, /models and status read the
// same served catalog, as in production.
const catalogOptions = (): ModelPlanCatalogOptions => ({
  models: state.gatewayModels,
  runVerifiers: state.runVerifiers,
  qualify: (selected) =>
    state.gatewayModels
      ? state.gatewayModels.some((model) => model.id === selected.id)
      : selected.id === model.id || verifiedGatewayModel(selected),
  reservation: (selected, plan) =>
    !state.gatewayModels && selected.id !== model.id
      ? modelPlanReservation(selected, plan)
      : fixtureReservation(selected, plan),
})
const server = createServer((request, response) => {
  // /chat is the gateway as the other tests call it; the /api/model-plans paths are what Vector itself requests.
  if (request.url === "/api/model-plans/models")
    return void handleModelPlanModels(request, response, fetcher, catalogOptions())
  if (request.url === "/api/model-plans/status")
    return void handleModelPlanStatus(request, response, fetcher, catalogOptions())
  if (request.url === "/api/model-plans/change") return void handleModelPlanChange(request, response, fetcher)
  if (request.url === "/api/model-plans/checkout") return void handleModelPlanCheckout(request, response, fetcher)
  if (request.url === "/api/model-plans/topup") return void handleModelTopupRemoved(request, response)
  if (request.url === "/api/model-plans/portal") return void handleModelPlanPortal(request, response, fetcher)
  void handleModelPlanChat(request, response, state.gatewayFetcher ?? fetcher, {
    ...catalogOptions(),
    assertHostedSessionLive: state.hostedLive,
    // Scoped service hooks for one test; production registrations are never replaced.
    hooks: state.hooks,
  })
})

beforeAll(async () => {
  if (!database)
    for (let count = 0; count < 300 && !(await stat(socket).catch(() => undefined)); count++) await Bun.sleep(10)
  expect(await redis(["PING"])).toBe("PONG")
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture server address")
  state.origin = `http://127.0.0.1:${address.port}`
})
beforeEach(async () => {
  await redis(["FLUSHDB"])
  // Vector's OpenRouter balance covers what is owed; codium-payments.test.ts exercises the funding check itself.
  await redis([
    "SET",
    "vector:codium:test:funding",
    JSON.stringify({
      status: "open",
      checkedAt: Date.now(),
      since: Date.now(),
      balance: 100_000_000,
      owed: 0,
      required: 0,
      keys: 0,
    }),
  ])
  Object.assign(process.env, {
    NODE_ENV: "development",
    MODEL_PLANS_ENABLED: "true",
    MODEL_PLAN_MODELS_JSON: JSON.stringify([model]),
    MODEL_PLAN_KEY_ENCRYPTION_SECRET: "ab".repeat(32),
    STRIPE_SECRET_KEY: "sk_test_fixture",
    CODIUM_STRIPE_MODE: "test",
    // Test mode caps each key at CODIUM_TEST_CREDIT_CAP_USD; these tests use the fixture plans' full credits.
    CODIUM_TEST_CREDIT_CAP_USD: "200",
    // Test checkout is open only to admins.
    VECTOR_ADMIN_EMAILS: user.email,
    STRIPE_MODEL_PLAN_WEBHOOK_SECRET: "whsec_fixture",
    STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID: "bpc_fixture",
    OPENROUTER_MANAGEMENT_KEY: "fixture-management-key",
    VECTOR_CLI_TOKEN_SECRET: "fixture-token-secret".repeat(3),
    VECTOR_ABUSE_SECRET: "fixture-abuse-secret".repeat(3),
    VECTOR_PUBLIC_URL: "https://vectordev.ai",
    KV_REST_API_URL: new URL("/redis", upstream.url).href,
    KV_REST_API_TOKEN: "fixture-kv-token",
    SUPABASE_URL: upstream.url.origin,
    SUPABASE_PUBLISHABLE_KEY: "fixture-publishable",
  })
  delete process.env.CODIUM_3DS_MIN_USD
  delete process.env.VERCEL_ENV
  delete process.env.MODEL_PLANS_MIN_CLIENT
  delete process.env.MODEL_PLAN_GLOBAL_INFLIGHT
  delete process.env.MODEL_PLAN_PRIORITY_RESERVE
  delete process.env.STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID
  delete process.env.UPSTASH_REDIS_REST_URL
  delete process.env.UPSTASH_REDIS_REST_TOKEN
  // Fixture allowances that keep the public usage multiples (5.5x, 12x and 25x Plus), as Codium's configuration requires.
  for (const [price, credits] of [
    [10, "5"],
    [50, "27.5"],
    [100, "60"],
    [200, "125"],
  ] as const) {
    process.env[`MODEL_PLAN_${price}_CREDITS_USD`] = credits
    process.env[`STRIPE_MODEL_PLAN_${price}_PRICE_ID`] = `price_fixture${price}`
  }
  Object.assign(state, {
    unavailable: false,
    loseCheckoutResponse: false,
    failClosingWrite: false,
    failCheckoutExpiry: false,
    failSubscriptionCancellation: false,
    checkoutListMode: "normal",
    priceMismatch: false,
    upstreamStatus: 200,
    streamMode: "normal",
    charge: 0,
    keyReadDelay: 0,
    chatDelay: 0,
    gatewayModels: undefined,
    gatewayFetcher: undefined,
    runVerifiers: undefined,
    hostedLive: undefined,
    hooks: undefined,
    upstreamStatuses: [],
    admitGate: undefined,
    admitReached: () => {},
    failSettles: 0,
    failSettlesFrom: 0,
    throwTransport: false,
    dispatches: 0,
    subscriptions: [],
  })
  calls.length = 0
  commands.length = 0
  sessions.clear()
  idempotency.clear()
  keys.clear()
})
afterAll(async () => {
  server.closeAllConnections()
  server.close()
  upstream.stop(true)
  database?.close()
  if (processHandle) {
    processHandle.kill()
    await processHandle.exited
  }
  await rm(temporary, { recursive: true, force: true })
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) {
      delete process.env[key]
      continue
    }
    process.env[key] = value
  }
})

async function paid() {
  state.subscriptions = [subscription()]
  await redis(["SET", accountKey, JSON.stringify({ customer: "cus_fixture" })])
  return state.subscriptions[0]!
}
async function chat(
  body: unknown = { model: model.id, messages: [{ role: "user", content: "fixture prompt" }] },
  token = mintCliToken(user, Date.now(), "desktop").token,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${state.origin}/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-vector-client": "1.99.113",
      "x-vector-catalog": "2",
      ...headers,
    },
    body: JSON.stringify(body),
  })
  return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers })
}
const mutations = () => calls.filter((call) => call.path.startsWith("/api/v1/keys") && call.method !== "GET")
/** Drops the account's 30-second status answer, as its lapse would. */
const forgetStatus = () => redis(["DEL", `vector:codium:test:status:${user.id}`])
const chats = () => calls.filter((call) => call.path === "/api/v1/chat/completions")

describe("subscription checkout with real billing leases", () => {
  test("HTTP checkout and Plus→Max upgrade forward the exact subscription 3DS field", async () => {
    expect(await billing("checkout", { plan: "vector-100" })).toMatchObject({ status: 200 })
    expect(
      calls.findLast((call) => call.path === "/v1/checkout/sessions" && call.method === "POST")!.body,
    ).toMatchObject({
      mode: "subscription",
      "payment_method_options[card][request_three_d_secure]": "any",
      "metadata[vector_3ds_requested]": "true",
    })

    // A paid Plus invoice is below Max's price and cannot exempt the upgrade.
    await paid()
    expect(await billing("change", { plan: "vector-100" })).toMatchObject({ status: 200 })
    expect(
      calls.findLast((call) => call.path === "/v1/checkout/sessions" && call.method === "POST")!.body,
    ).toMatchObject({
      mode: "subscription",
      "payment_method_options[card][request_three_d_secure]": "any",
      "subscription_data[metadata][vector_supersedes]": "sub_fixture",
    })
  })

  test("replaces a pending subscription checkout when its allowance or Stripe price changes", async () => {
    const first = await modelPlanCheckout(user, "vector-10", fetcher)
    process.env.MODEL_PLAN_10_CREDITS_USD = "7"
    const second = await modelPlanCheckout(user, "vector-10", fetcher)
    expect(second.url).not.toBe(first.url)
    expect(sessions.get("cs_fixture1")?.status).toBe("expired")
    expect(sessions.get("cs_fixture2")?.metadata.vector_model_credits_usd).toBe("7")
    process.env.STRIPE_MODEL_PLAN_10_PRICE_ID = "price_repriced10"
    const third = await modelPlanCheckout(user, "vector-10", fetcher)
    expect(third.url).not.toBe(second.url)
    expect(sessions.get("cs_fixture2")?.status).toBe("expired")
    expect(sessions.get("cs_fixture3")?.metadata.vector_price_id).toBe("price_repriced10")
    expect(await modelPlanCheckout(user, "vector-10", fetcher)).toEqual(third)
  })

  test("reuses an open checkout, expires it when switching tiers, and returns a new session", async () => {
    const first = await modelPlanCheckout(user, "vector-10", fetcher)
    expect(await modelPlanCheckout(user, "vector-10", fetcher)).toEqual(first)
    expect(sessions.size).toBe(1)
    const next = await modelPlanCheckout(user, "vector-50", fetcher)
    expect(next.url).not.toBe(first.url)
    expect(sessions.get("cs_fixture1")?.status).toBe("expired")
    expect(sessions.size).toBe(2)
    const expire = calls.findIndex((call) => call.path.endsWith("/cs_fixture1/expire"))
    expect(calls.findLastIndex((call) => call.path === "/v1/checkout/sessions")).toBeGreaterThan(expire)
    expect(await readModelPlanAccount(user.id, fetcher)).toMatchObject({
      customer: "cus_fixture",
      checkout: { id: "cs_fixture2", plan: "vector-50", url: next.url },
    })
    expect(calls.filter((call) => call.path === "/v1/customers")).toHaveLength(1)
    expect(calls.find((call) => call.path === "/v1/checkout/sessions")?.body["payment_method_types[0]"]).toBe("card")
    expect(commands.some((command) => command[0] === "EVAL" && String(command[1]).includes("PTTL"))).toBe(true)
    expect(await redis(["KEYS", "vector:codium:test:lease:*"])).toEqual([])
  })

  test("retries an ambiguous checkout response under the same Stripe idempotency key", async () => {
    state.loseCheckoutResponse = true
    const now = Date.now()
    await expect(modelPlanCheckout(user, "vector-10", fetcher, now)).rejects.toMatchObject({ code: "BILLING_UPSTREAM" })
    const result = await modelPlanCheckout(user, "vector-10", fetcher, now)
    const requests = calls.filter((call) => call.path === "/v1/checkout/sessions")
    expect(requests).toHaveLength(2)
    expect(requests[0]!.headers.get("idempotency-key")).toBe(requests[1]!.headers.get("idempotency-key"))
    expect(requests[0]!.body).toEqual(requests[1]!.body)
    expect(sessions.size).toBe(1)
    expect(result.url).toBe(sessions.get("cs_fixture1")!.url)
  })

  test("blocks duplicate subscriptions and mismatched prices before creating checkout", async () => {
    await paid()
    await expect(modelPlanCheckout(user, "vector-50", fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_EXISTS" })
    state.subscriptions = []
    state.priceMismatch = true
    await expect(modelPlanCheckout(user, "vector-10", fetcher)).rejects.toMatchObject({
      code: "MODEL_PLAN_PRICE_MISMATCH",
    })
    expect(sessions.size).toBe(0)
  })

  test("does not create a second checkout while a completed session awaits subscription visibility", async () => {
    await modelPlanCheckout(user, "vector-10", fetcher)
    sessions.get("cs_fixture1")!.status = "complete"
    await expect(modelPlanCheckout(user, "vector-10", fetcher)).rejects.toMatchObject({
      code: "MODEL_PLAN_EXISTS",
      statusCode: 409,
    })
    await expect(modelPlanCheckout(user, "vector-50", fetcher)).rejects.toMatchObject({
      code: "MODEL_PLAN_EXISTS",
      statusCode: 409,
    })
    expect(sessions.size).toBe(1)
    expect(calls.filter((call) => call.path === "/v1/checkout/sessions")).toHaveLength(1)
    expect(calls.some((call) => call.path.endsWith("/expire"))).toBe(false)
  })

  test("billing management remains reachable when new plan purchases are disabled", async () => {
    await paid()
    process.env.MODEL_PLANS_ENABLED = "false"
    expect(await modelPlanPortal(user.id, fetcher)).toEqual({ url: "https://billing.stripe.com/p/session/fixture" })
    expect(calls.at(-1)?.body).toMatchObject({
      customer: "cus_fixture",
      configuration: "bpc_fixture",
      return_url: "https://vectordev.ai/account",
    })
  })
})

// What the desktop app's main process sends: the Vector account token from its own sign-in and a JSON body, with no
// Origin header.
async function billing(
  path: "checkout" | "topup" | "portal" | "change",
  body: unknown,
  token = mintCliToken(user, Date.now(), "desktop").token,
) {
  const response = await fetch(`${state.origin}/api/model-plans/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, any> }
}

describe("billing from the desktop app's Vector sign-in", () => {
  test("checkout and the billing portal accept the desktop's Vector account token", async () => {
    const checkout = await billing("checkout", { plan: "vector-10" })
    expect(checkout).toEqual({ status: 200, body: { url: sessions.get("cs_fixture1")!.url } })
    expect(checkout.body.url).toStartWith("https://checkout.stripe.com/")
    // The Stripe customer is created for the token's account, with its email.
    expect(calls.find((call) => call.path === "/v1/customers")?.body).toMatchObject({
      email: user.email,
      "metadata[vector_account_id]": user.id,
    })
    await paid()
    expect(await billing("portal", {})).toEqual({
      status: 200,
      body: { url: "https://billing.stripe.com/p/session/fixture" },
    })
    // Verified locally and against revocation: Supabase never sees the desktop's token.
    expect(calls.some((call) => call.path === "/auth/v1/user")).toBe(false)
  })

  test("a token pasted into a terminal, or from a desktop sign-in before 1.99.109, never opens the portal", async () => {
    // Before 1.99.109 the desktop's token carried no mark, the same as the one /auth/cli hands out to paste.
    const pasted = mintCliToken(user).token
    for (const body of [{}, { flow: "change" }, { flow: "cancel" }])
      expect(await billing("portal", body, pasted)).toEqual({
        status: 403,
        body: {
          error: {
            code: "DESKTOP_SIGN_IN_REQUIRED",
            message: "Sign in to Vector again to manage billing in the app.",
          },
        },
      })
    expect(calls.some((call) => call.path === "/v1/billing_portal/sessions")).toBe(false)
    // Buying needs a card typed into Stripe's own page, so a pasted token still opens checkout.
    expect(await billing("checkout", { plan: "vector-10" }, pasted)).toMatchObject({ status: 200 })
    // A forged mark fails the signature.
    const [payload] = pasted.slice(4).split(".")
    const marked = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), client: "desktop" }),
    ).toString("base64url")
    expect(await billing("portal", {}, `vct_${marked}.${pasted.split(".")[1]}`)).toMatchObject({
      status: 401,
      body: { error: { code: "CLI_TOKEN_INVALID" } },
    })
  })

  test("plan changes require a desktop mark or web session and share a persistent ten-an-hour account limit", async () => {
    expect(await billing("change", { plan: "invalid" }, mintCliToken(user).token)).toMatchObject({
      status: 403,
      body: { error: { code: "DESKTOP_SIGN_IN_REQUIRED" } },
    })
    expect(await billing("change", { plan: "invalid" }, "not-a-session")).toMatchObject({ status: 401 })
    expect(await billing("change", { plan: "invalid" }, "browser-session")).toMatchObject({
      status: 400,
      body: { error: { code: "MODEL_PLAN_INVALID" } },
    })
    for (let attempt = 0; attempt < 9; attempt++)
      expect(await billing("change", { plan: "invalid" })).toMatchObject({ status: 400 })
    expect(await billing("change", { plan: "invalid" })).toMatchObject({
      status: 429,
      body: { error: { code: "RATE_LIMITED" } },
    })
    expect(calls.some((call) => call.path === "/v1/checkout/sessions")).toBe(false)
  })

  test("the old top-up route answers 410 to every token and sells nothing", async () => {
    const removed = {
      status: 410,
      body: {
        error: {
          code: "MODEL_TOPUP_REMOVED",
          message: "Vector Codium no longer sells top-ups. Choose or change a monthly plan instead.",
        },
      },
    }
    // What a desktop from before WP A04 sends, then a pasted token, a revoked one, and none at all.
    expect(await billing("topup", { pack: "codium-topup-10" })).toEqual(removed)
    expect(await billing("topup", { pack: "codium-topup-10" }, mintCliToken(user).token)).toEqual(removed)
    await redis(["SET", `vector:cli-revoked:${user.id}`, "1"])
    expect(await billing("topup", { pack: "codium-topup-10" })).toEqual(removed)
    expect(await billing("topup", {}, "")).toEqual(removed)
    expect(sessions.size).toBe(0)
    expect(calls.some((call) => call.path.startsWith("/v1/"))).toBe(false)
  })

  test("a revoked, expired or forged token is refused, and the website's browser session still works", async () => {
    await paid()
    const expired = mintCliToken(user, Date.now() - 91 * 24 * 60 * 60 * 1000).token
    expect(await billing("portal", {}, expired)).toMatchObject({
      status: 401,
      body: { error: { code: "CLI_TOKEN_EXPIRED" } },
    })
    expect((await billing("portal", {}, `${mintCliToken(user).token}x`)).status).toBe(401)
    await redis(["SET", `vector:cli-revoked:${user.id}`, "1"])
    expect(await billing("checkout", { plan: "vector-10" })).toMatchObject({
      status: 401,
      body: { error: { code: "CLI_TOKEN_INVALID" } },
    })
    expect(sessions.size).toBe(0)
    // The website is unchanged: its Supabase session opens the portal.
    expect(await billing("portal", {}, "browser-session")).toMatchObject({ status: 200 })
    expect((await billing("portal", {}, "not-a-session")).status).toBe(401)
  })

  test("while new purchases are off, the token still opens billing management but buys nothing", async () => {
    await paid()
    process.env.MODEL_PLANS_ENABLED = "false"
    expect(await billing("checkout", { plan: "vector-10" })).toMatchObject({
      status: 503,
      body: { error: { code: "MODEL_PLANS_DISABLED" } },
    })
    expect(await billing("portal", {})).toMatchObject({ status: 200 })
    expect(sessions.size).toBe(0)
  })
})

describe("Codium portal compatibility and cancellation", () => {
  const portalSession = () => calls.findLast((call) => call.path === "/v1/billing_portal/sessions")?.body

  test("the portal always uses the no-change configuration, including when sales are paused", async () => {
    await paid()
    process.env.STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID = "bpc_changes"
    await modelPlanPortal(user.id, fetcher)
    expect(portalSession()).toMatchObject({ configuration: "bpc_fixture" })

    process.env.MODEL_PLANS_ENABLED = "false"
    await modelPlanPortal(user.id, fetcher)
    expect(portalSession()).toMatchObject({ configuration: "bpc_fixture" })
    await expect(modelPlanPortal(user.id, fetcher, { flow: "change" })).rejects.toMatchObject({
      statusCode: 409,
      code: "MODEL_PLAN_CHANGE_UNAVAILABLE",
    })

    // Paused sales keep plan changes closed too, though the card, invoices and cancellation stay reachable.
    process.env.MODEL_PLANS_ENABLED = "true"
    await redis([
      "SET",
      "vector:codium:test:funding",
      JSON.stringify({
        status: "paused",
        reason: "short",
        checkedAt: Date.now(),
        since: Date.now(),
        balance: 0,
        owed: 0,
        required: 0,
        keys: 0,
      }),
    ])
    await modelPlanPortal(user.id, fetcher)
    expect(portalSession()).toMatchObject({ configuration: "bpc_fixture" })
    expect(await modelPlanPortal(user.id, fetcher, { flow: "cancel" })).toEqual({
      url: "https://billing.stripe.com/p/session/fixture",
    })

    // Without the second configuration, nothing offers plan changes.
    delete process.env.STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID
    await expect(modelPlanPortal(user.id, fetcher, { flow: "change" })).rejects.toMatchObject({ statusCode: 409 })
  })

  test("payment_method_update opens directly over HTTP without a paid plan or service sales", async () => {
    process.env.MODEL_PLANS_ENABLED = "false"
    delete process.env.OPENROUTER_MANAGEMENT_KEY
    process.env.STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID = "bpc_changes"
    await redis([
      "SET",
      accountKey,
      JSON.stringify({ customer: "cus_fixture", downgrade: { plan: "vector-10", token: "keep-schedule" } }),
    ])
    await redis(["SET", "vector:codium:test:switch:sales", "off"])
    await redis(["SET", "vector:codium:test:switch:codium", "off"])
    for (const pastDue of [false, true]) {
      state.subscriptions = pastDue ? [{ ...subscription(), status: "past_due" }] : []
      expect(
        await billing("portal", { flow: "payment_method_update" }, pastDue ? "browser-session" : undefined),
      ).toEqual({
        status: 200,
        body: { url: "https://billing.stripe.com/p/session/fixture" },
      })
      expect(portalSession()).toMatchObject({
        customer: "cus_fixture",
        configuration: "bpc_fixture",
        "flow_data[type]": "payment_method_update",
        "flow_data[after_completion][type]": "redirect",
        "flow_data[after_completion][redirect][return_url]": "https://vectordev.ai/account?model_plan=updated",
      })
      expect(portalSession()).not.toHaveProperty("flow_data[subscription_cancel][subscription]")
      expect(portalSession()).not.toHaveProperty("flow_data[payment_method_update][subscription]")
    }
    expect(
      calls.some((call) => call.path === "/v1/subscriptions" || call.path.startsWith("/v1/subscription_schedules")),
    ).toBe(false)
    expect(JSON.parse(String(await redis(["GET", accountKey]))).downgrade).toEqual({
      plan: "vector-10",
      token: "keep-schedule",
    })
  })

  test("Vector opens the portal straight at changing or cancelling the paid plan", async () => {
    process.env.STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID = "bpc_changes"
    await redis(["SET", accountKey, JSON.stringify({ customer: "cus_fixture" })])
    await expect(modelPlanPortal(user.id, fetcher, { flow: "change" })).rejects.toMatchObject({
      statusCode: 409,
      code: "MODEL_PLAN_CHANGE_UNAVAILABLE",
      message: "Change plans on vectordev.ai/account.",
    })
    await expect(modelPlanPortal(user.id, fetcher, { flow: "cancel" })).rejects.toMatchObject({
      statusCode: 404,
      code: "MODEL_PLAN_MISSING",
      message: "There is no paid Codium plan to cancel.",
    })
    await paid()
    expect(await billing("portal", { flow: "change" })).toMatchObject({
      status: 409,
      body: { error: { code: "MODEL_PLAN_CHANGE_UNAVAILABLE" } },
    })
    await billing("portal", { flow: "cancel" })
    expect(portalSession()).toMatchObject({
      "flow_data[type]": "subscription_cancel",
      "flow_data[subscription_cancel][subscription]": "sub_fixture",
      "flow_data[after_completion][redirect][return_url]": "https://vectordev.ai/account?model_plan=ending",
    })
    // A smaller plan chosen earlier waits in a schedule for the renewal date; Stripe changes nothing more until then.
    state.subscriptions[0]!.schedule = "sub_sched_fixture"
    const opened = calls.filter((call) => call.path === "/v1/billing_portal/sessions").length
    expect(await billing("portal", { flow: "change" })).toMatchObject({
      status: 409,
      body: { error: { code: "MODEL_PLAN_CHANGE_UNAVAILABLE" } },
    })
    delete state.subscriptions[0]!.schedule
    state.subscriptions[0]!.cancel_at_period_end = true
    expect(await billing("portal", { flow: "cancel" })).toMatchObject({
      status: 409,
      body: { error: { code: "MODEL_PLAN_ENDING" } },
    })
    // A plan that is ending cannot be changed either; the person chooses a plan again once it ends.
    expect(await billing("portal", { flow: "change" })).toMatchObject({
      status: 409,
      body: {
        error: {
          code: "MODEL_PLAN_CHANGE_UNAVAILABLE",
          message: "Change plans on vectordev.ai/account.",
        },
      },
    })
    expect(calls.filter((call) => call.path === "/v1/billing_portal/sessions")).toHaveLength(opened)
    expect(await billing("portal", { flow: "upgrade" })).toMatchObject({
      status: 400,
      body: { error: { code: "BILLING_FLOW_INVALID" } },
    })
  })

  test("a plan changed in the portal grants the new plan's credits, and an unchanged one keeps what it was sold", () => {
    const start = Math.floor(Date.now() / 1000) - 60
    const end = start + 30 * 24 * 60 * 60
    const sold = {
      ...subscription(start, end),
      metadata: { vector_account_id: user.id, vector_plan: "vector-10", vector_model_credits_usd: "4" },
    }
    expect(paidModelPlan(sold, user.id)?.plan).toMatchObject({ id: "vector-10", credits: 4 })
    // An upgrade starts a new month on the bigger plan, invoiced in full; the metadata still names the old plan.
    const upgraded = {
      ...sold,
      items: {
        data: [
          {
            ...sold.items.data[0]!,
            price: { ...sold.items.data[0]!.price, id: "price_fixture100", unit_amount: 10_000 },
          },
        ],
      },
      latest_invoice: {
        ...sold.latest_invoice,
        amount_paid: 10_000,
        lines: { data: [{ price: { id: "price_fixture100" }, period: { start, end }, proration: false }] },
      },
    }
    expect(paidModelPlan(upgraded, user.id)?.plan).toMatchObject({ id: "vector-100", credits: 60 })
    // A prorated charge pays for part of a month, which Codium never grants.
    const prorated = {
      ...upgraded,
      latest_invoice: {
        ...upgraded.latest_invoice,
        amount_paid: 6_000,
        lines: { data: [{ price: { id: "price_fixture100" }, period: { start, end }, proration: true }] },
      },
    }
    expect(paidModelPlan(prorated, user.id)).toBeUndefined()
  })
})

describe("model plan account deletion", () => {
  test("expires pending checkout, revokes paid access, and durably blocks reactivation across cleanup retries", async () => {
    await modelPlanCheckout(user, "vector-10", fetcher)
    state.subscriptions = [subscription()]
    await modelPlanCredential(user.id, fetcher)
    await cancelModelPlanAccount(user.id, fetcher)
    expect(sessions.get("cs_fixture1")?.status).toBe("expired")
    expect(state.subscriptions[0]!.status).toBe("canceled")
    expect(keys.get("hash_fixture1")?.data.disabled).toBe(true)
    expect(await readModelPlanAccount(user.id, fetcher)).toMatchObject({ closing: true })
    await cancelModelPlanAccount(user.id, fetcher)
    expect(calls.filter((call) => call.path.endsWith("/expire"))).toHaveLength(1)
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1)

    // A stale upstream entitlement or key response must not undo local closure.
    state.subscriptions[0]!.status = "active"
    keys.get("hash_fixture1")!.data.disabled = false
    calls.length = 0
    expect(await modelPlanStatus(user.id, fetcher)).toEqual({
      active: false,
      customer: true,
      access: false,
    })
    await expect(modelPlanCheckout(user, "vector-50", fetcher)).rejects.toMatchObject({
      code: "MODEL_PLAN_ACCOUNT_CLOSING",
      statusCode: 409,
    })
    await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({
      code: "MODEL_PLAN_ACCOUNT_CLOSING",
      statusCode: 409,
    })
    expect(calls).toHaveLength(0)
    expect(keys.size).toBe(1)
    expect(sessions.size).toBe(1)
  })

  test("discovers and expires an open checkout whose creation response was lost", async () => {
    state.loseCheckoutResponse = true
    await expect(modelPlanCheckout(user, "vector-10", fetcher)).rejects.toMatchObject({ code: "BILLING_UPSTREAM" })
    expect(await readModelPlanAccount(user.id, fetcher)).not.toHaveProperty("checkout")
    expect(sessions.get("cs_fixture1")?.status).toBe("open")
    await cancelModelPlanAccount(user.id, fetcher)
    expect(sessions.get("cs_fixture1")?.status).toBe("expired")
    expect(await readModelPlanAccount(user.id, fetcher)).toMatchObject({ closing: true })
  })

  test("does not perform external cleanup before closure is durably recorded", async () => {
    await paid()
    await modelPlanCredential(user.id, fetcher)
    calls.length = 0
    state.failClosingWrite = true
    await expect(cancelModelPlanAccount(user.id, fetcher)).rejects.toMatchObject({ statusCode: 503 })
    expect(calls).toHaveLength(0)
    expect(keys.get("hash_fixture1")?.data.disabled).toBe(false)
    expect(state.subscriptions[0]!.status).toBe("active")
    expect(await readModelPlanAccount(user.id, fetcher)).not.toHaveProperty("closing")
    state.failClosingWrite = false
    await cancelModelPlanAccount(user.id, fetcher)
    expect(state.subscriptions[0]!.status).toBe("canceled")
  })

  test("missing billing credentials cannot silently complete cleanup for an existing or unverifiable account", async () => {
    delete process.env.STRIPE_SECRET_KEY
    expect(await cancelModelPlanAccount(user.id, fetcher)).toBeUndefined()
    process.env.STRIPE_SECRET_KEY = "sk_test_fixture"
    await paid()
    await modelPlanCredential(user.id, fetcher)
    delete process.env.STRIPE_SECRET_KEY
    calls.length = 0
    await expect(cancelModelPlanAccount(user.id, fetcher)).rejects.toMatchObject({
      code: "BILLING_UNAVAILABLE",
      statusCode: 503,
    })
    expect(state.subscriptions[0]!.status).toBe("active")
    expect(keys.get("hash_fixture1")?.data.disabled).toBe(false)
    expect(calls).toHaveLength(0)
    delete process.env.KV_REST_API_URL
    await expect(cancelModelPlanAccount(user.id, fetcher)).rejects.toMatchObject({ statusCode: 503 })
  })

  test("checkout expiry failure blocks completed cleanup and can be retried without reopening access", async () => {
    await modelPlanCheckout(user, "vector-10", fetcher)
    state.subscriptions = [subscription()]
    await modelPlanCredential(user.id, fetcher)
    state.failCheckoutExpiry = true
    await expect(cancelModelPlanAccount(user.id, fetcher)).rejects.toMatchObject({ code: "BILLING_UPSTREAM" })
    expect(await readModelPlanAccount(user.id, fetcher)).toMatchObject({ closing: true })
    expect(sessions.get("cs_fixture1")?.status).toBe("open")
    expect(state.subscriptions[0]!.status).toBe("active")
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0)
    expect(keys.get("hash_fixture1")?.data.disabled).toBe(true)
    await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_ACCOUNT_CLOSING" })
    state.failCheckoutExpiry = false
    await cancelModelPlanAccount(user.id, fetcher)
    expect(sessions.get("cs_fixture1")?.status).toBe("expired")
    expect(state.subscriptions[0]!.status).toBe("canceled")
  })

  test("subscription cancellation failure preserves closure and retries the unfinished cancellation", async () => {
    await paid()
    await modelPlanCredential(user.id, fetcher)
    state.failSubscriptionCancellation = true
    await expect(cancelModelPlanAccount(user.id, fetcher)).rejects.toMatchObject({ code: "BILLING_UPSTREAM" })
    expect(await readModelPlanAccount(user.id, fetcher)).toMatchObject({ closing: true })
    expect(keys.get("hash_fixture1")?.data.disabled).toBe(true)
    expect(await modelPlanStatus(user.id, fetcher)).toEqual({
      active: false,
      customer: true,
      access: false,
    })
    state.failSubscriptionCancellation = false
    await cancelModelPlanAccount(user.id, fetcher)
    expect(state.subscriptions[0]!.status).toBe("canceled")
    expect(keys.size).toBe(1)
  })

  test("incomplete or malformed checkout listings cannot be treated as completed cleanup", async () => {
    await paid()
    for (const mode of ["more", "invalid"]) {
      state.checkoutListMode = mode
      await expect(cancelModelPlanAccount(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_CLEANUP" })
      expect(await readModelPlanAccount(user.id, fetcher)).toMatchObject({ closing: true })
      expect(state.subscriptions[0]!.status).toBe("active")
    }
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0)
    state.checkoutListMode = "normal"
    await cancelModelPlanAccount(user.id, fetcher)
    expect(state.subscriptions[0]!.status).toBe("canceled")
  })
})

describe("paid credential lifecycle", () => {
  test("persists only encrypted credentials and reuses the period key with a hard nonresetting cap", async () => {
    const subscription = await paid()
    const credential = (await modelPlanCredential(user.id, fetcher)).key
    expect(credential).toBe("fixture-paid-secret-1")
    expect(String(await redis(["GET", accountKey]))).not.toContain(credential)
    expect(await readModelPlanAccount(user.id, fetcher)).toMatchObject({
      key: { hash: "hash_fixture1", subscription: subscription.id, credits: 5 },
    })
    expect(keys.get("hash_fixture1")?.data).toMatchObject({
      limit: 5,
      limit_reset: null,
      include_byok_in_limit: true,
      expires_at: keyExpiresAt(subscription.items.data[0]!.current_period_end),
    })
    expect((await modelPlanCredential(user.id, fetcher)).key).toBe(credential)
    expect(keys.size).toBe(1)
    expect(mutations()).toHaveLength(1)
  })

  test("parallel paid-key reads do not serialize through a mutation lease", async () => {
    await paid()
    const credential = (await modelPlanCredential(user.id, fetcher)).key
    calls.length = 0
    commands.length = 0
    state.keyReadDelay = 25
    expect(
      await Promise.all(Array.from({ length: 8 }, async () => (await modelPlanCredential(user.id, fetcher)).key)),
    ).toEqual(Array(8).fill(credential))
    expect(mutations()).toHaveLength(0)
    expect(commands.every((command) => command[0] === "GET")).toBe(true)
    expect(calls.filter((call) => call.path === "/api/v1/keys/hash_fixture1")).toHaveLength(8)
  })

  test("same-period restoration re-enables the same key without clearing already charged usage", async () => {
    await paid()
    const credential = (await modelPlanCredential(user.id, fetcher)).key
    Object.assign(keys.get("hash_fixture1")!.data, { disabled: true, usage: 3.5 })
    expect((await modelPlanCredential(user.id, fetcher)).key).toBe(credential)
    expect(keys.size).toBe(1)
    expect(keys.get("hash_fixture1")?.data).toMatchObject({ disabled: false, usage: 3.5, limit: 5, limit_reset: null })
    expect(calls.findLast((call) => call.method === "PATCH")?.body).not.toHaveProperty("usage")
    expect(await modelPlanStatus(user.id, fetcher)).toMatchObject({ active: true, used: 3.5, remaining: 1.5 })
  })

  test("renewal disables the old key before issuing a new period allowance", async () => {
    const current = await paid()
    const first = (await modelPlanCredential(user.id, fetcher)).key
    const start = current.items.data[0]!.current_period_end
    state.subscriptions = [subscription(start, start + 7200)]
    const next = (await modelPlanCredential(user.id, fetcher, (start + 1) * 1000)).key
    expect(next).not.toBe(first)
    expect(keys.size).toBe(2)
    expect(keys.get("hash_fixture1")?.data.disabled).toBe(true)
    expect(mutations().map((call) => [call.method, call.path])).toEqual([
      ["POST", "/api/v1/keys"],
      ["PATCH", "/api/v1/keys/hash_fixture1"],
      ["POST", "/api/v1/keys"],
    ])
    expect(await readModelPlanAccount(user.id, fetcher)).toMatchObject({ key: { start, hash: "hash_fixture2" } })
  })

  test("unpaid, refunded and disputed periods cannot provision or reuse a credential", async () => {
    const current = await paid()
    current.latest_invoice.paid = false
    expect(await modelPlanStatus(user.id, fetcher)).toEqual({
      active: false,
      customer: true,
      access: false,
    })
    await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_PAYMENT_REQUIRED" })
    expect(keys.size).toBe(0)
    current.latest_invoice.paid = true
    await modelPlanCredential(user.id, fetcher)
    current.latest_invoice.charge.refunded = true
    await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_PAYMENT_REQUIRED" })
    expect(keys.get("hash_fixture1")?.data.disabled).toBe(true)
    current.latest_invoice.charge.refunded = false
    current.latest_invoice.charge.disputed = true
    await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_PAYMENT_REQUIRED" })
    expect(keys.size).toBe(1)
  })

  test("exhaustion and unknown usage fail closed instead of creating a fresh allowance", async () => {
    await paid()
    await modelPlanCredential(user.id, fetcher)
    keys.get("hash_fixture1")!.data.usage = 5
    await expect(modelPlanCredential(user.id, fetcher, Date.now(), 0.01)).rejects.toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
      statusCode: 402,
    })
    delete keys.get("hash_fixture1")!.data.usage
    await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_KEY_INVALID" })
    expect(keys.size).toBe(1)
    expect(mutations()).toHaveLength(1)
  })
})

describe("model plan HTTP inference", () => {
  test("a title request debits its account key and the authenticated balance reflects the charge", async () => {
    await paid()
    state.charge = 0.000031
    const response = await chat({
      model: model.id,
      max_tokens: 64,
      messages: [{ role: "user", content: "Generate a concise title" }],
    })
    expect(response.status).toBe(200)
    // The provider's USD charge comes off the credits but never reaches Vector; the tokens do. Nor does the provider
    // that served the request, whose published price would give the charge away.
    const text = await response.text()
    expect(text).toContain('"completion_tokens":6')
    expect(text).toContain('"id":"gen-fixture"')
    for (const leak of ["cost", "is_byok", "PRIVATE-PROVIDER", "fp_private", "PRIVATE-REASON"])
      expect(text).not.toContain(leak)
    expect(await modelPlanStatus(user.id, fetcher)).toMatchObject({ used: 0.000031, remaining: 4.999969 })
    expect(chats()).toHaveLength(1)
    state.charge = 0
  })

  test("requires a current nonrevoked CLI identity and authoritative persistent storage", async () => {
    await paid()
    expect((await chat(undefined, "invalid")).status).toBe(401)
    expect((await chat(undefined, mintCliToken(user, Date.now() - 100 * 86400000).token)).status).toBe(401)
    await redis(["SET", `vector:cli-revoked:${user.id}`, "1"])
    expect((await chat()).status).toBe(401)
    await redis(["DEL", `vector:cli-revoked:${user.id}`])
    expect((await chat(undefined, undefined, { origin: "https://foreign.example" })).status).toBe(403)
    state.unavailable = true
    expect((await chat()).status).toBe(503)
    state.unavailable = false
    delete process.env.KV_REST_API_URL
    expect((await chat()).status).toBe(503)
    expect(chats()).toHaveLength(0)
  })

  test("streams split CRLF frames, forwards only the account key, and pins model/provider limits", async () => {
    await paid()
    const response = await chat({
      model: model.id,
      messages: [{ role: "user", content: "fixture", extra: "strip me" }],
      user: "attacker",
      max_tokens: 100000,
      provider: { allow_fallbacks: true, data_collection: "allow" },
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"content":"fixture"')
    expect(chats()).toHaveLength(1)
    expect(chats()[0]!.headers.get("authorization")).toBe("Bearer fixture-paid-secret-1")
    expect(chats()[0]!.body).toMatchObject({
      model: model.id,
      user: createHash("sha256").update(user.id).digest("hex"),
      max_tokens: 2048,
      stream: true,
      provider: {
        data_collection: "deny",
        zdr: true,
        require_parameters: true,
        max_price: { prompt: 1, completion: 2, request: 0 },
      },
    })
    expect(JSON.stringify(chats()[0]!.body)).not.toContain("strip me")
    expect(JSON.stringify(chats()[0]!.body)).not.toContain("vct_")
    // The provider reported no cost for this answer, so the gateway committed its whole one-attempt reservation
    // (8,192 tokens at $1 and 2,048 at $2 per million): an unknown charge is never counted as free.
    expect(await modelPlanStatus(user.id, fetcher)).toMatchObject({ active: true, used: 0.012288, remaining: 4.987712 })
  })

  test("the thirty-first Plus request reaches the per-minute refusal independently of concurrency", async () => {
    await paid()
    await modelPlanCredential(user.id, fetcher)
    const responses: Response[] = []
    for (let index = 0; index < 34; index++) responses.push(await chat())
    expect(responses.filter((response) => response.status === 200)).toHaveLength(30)
    expect(responses.filter((response) => response.status === 429)).toHaveLength(4)
    expect(chats()).toHaveLength(30)
    const rejected = responses.find((response) => response.status === 429)!
    expect(await rejected.json()).toMatchObject({ error: { code: "RATE_LIMITED" } })
    expect(Number(rejected.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(Number(rejected.headers.get("x-ratelimit-reset")) * 1000).toBeGreaterThan(Date.now())
  })

  test("structured-output schemas count toward the input context and cost bound", async () => {
    await paid()
    const response = await chat({
      model: model.id,
      messages: [{ role: "user", content: "Return an object" }],
      max_tokens: 1,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "fixture",
          schema: { type: "object", description: "x".repeat(model.contextLength * 4) },
        },
      },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "MODEL_PLAN_CONTEXT" } })
    expect(chats()).toHaveLength(0)
    // Refused before admission: nothing reserved (the snapshot read before it may have provisioned the period's key).
    expect(await redis(["ZRANGE", heldKey, 0, -1])).toEqual([])
  })

  test("exhausted paid credits return payment-required without an inference request", async () => {
    await paid()
    await modelPlanCredential(user.id, fetcher)
    keys.get("hash_fixture1")!.data.usage = 5
    const response = await chat()
    expect(response.status).toBe(402)
    expect(await response.json()).toMatchObject({ error: { code: "MODEL_PLAN_EXHAUSTED" } })
    expect(chats()).toHaveLength(0)
  })

  test("every shortfall gets one answer, checked against the model's largest request whatever the request's size", async () => {
    await paid()
    await modelPlanCredential(user.id, fetcher)
    const answer = {
      error: {
        code: "MODEL_PLAN_EXHAUSTED",
        message:
          "This month's Vector Codium usage cannot cover this model's largest request right now. Wait for running requests to finish, or choose a lighter model. Your Codium usage renews each billing period.",
      },
    }
    // The fixture model's largest request, 8,192 context tokens at $1 and 2,048 output tokens at $2 per million,
    // is $0.012288. The request's own size never changes the check, so a client cannot vary max_tokens to read the
    // balance back.
    keys.get("hash_fixture1")!.data.usage = 5 - 0.012
    for (const body of [undefined, { model: model.id, max_tokens: 1, messages: [{ role: "user", content: "A" }] }]) {
      const refused = await chat(body)
      expect(refused.status).toBe(402)
      const text = await refused.json()
      expect(text).toEqual(answer)
      // Vector's client offers See plans with it, as for any shortfall.
      expect(ModelPlans.gatewayFailure(402, JSON.stringify(text))).toMatchObject({ kind: "credits" })
    }
    expect(chats()).toHaveLength(0)
    // The account's status agrees: too few left for any request, not merely running low.
    expect(
      modelPlanBalance(await modelPlanStatus(user.id, fetcher), {
        cheapestMicro: fixtureReservation(model, "vector-10").requiredMicro,
      }),
    ).toMatchObject({ empty: true, low: false })
    // Just enough for the largest request is served, whatever this request asks for.
    keys.get("hash_fixture1")!.data.usage = 5 - 0.0123
    const served = await chat()
    expect(served.status).toBe(200)
    await served.text()
    expect(chats()).toHaveLength(1)
    // Credits that are used up get the same answer.
    keys.get("hash_fixture1")!.data.usage = 5
    expect(await (await chat()).json()).toEqual(answer)
    expect(chats()).toHaveLength(1)
    // The served request settles its hold just after its answer ends, so wait for that before the next test.
    const pool = heldKey
    for (let tries = 0; tries < 100; tries++) {
      const [member] = (await redis(["ZRANGE", pool, 0, -1])) as string[]
      if (member && Number(await redis(["ZSCORE", pool, member])) < Date.now() + 60_000) break
      await Bun.sleep(10)
    }
  })

  test("parallel requests hold their largest cost, so together they cannot spend past the balance", async () => {
    await paid()
    // The account's snapshot and key exist before the burst, so every request is admitted at the same moment.
    await reconcileModelPlanAccount(user.id, fetcher)
    // Each hold is "<ticket>:<purpose>:<runId or ->:<micro-dollars>". A request settles its hold just after its answer ends.
    const held = async (count: number, charge?: string) => {
      const members = async () => (await redis(["ZRANGE", heldKey, 0, -1])) as string[]
      for (let tries = 0; tries < 100; tries++) {
        const current = await members()
        if (current.length === count && current.every((member) => !charge || member.endsWith(`:${charge}`)))
          return current
        await Bun.sleep(10)
      }
      return members()
    }
    // Room for two of the fixture model's largest requests ($0.012288 each), not three.
    keys.get("hash_fixture1")!.data.usage = 5 - 0.03
    state.chatDelay = 100
    state.charge = 0.001
    const responses = await Promise.all(Array.from({ length: 5 }, () => chat()))
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 402, 402, 402])
    expect(chats()).toHaveLength(2)
    // Credits held by running requests get the same answer as any other shortfall.
    const refused = await responses.find((response) => response.status === 402)!.json()
    expect(refused).toEqual({
      error: {
        code: "MODEL_PLAN_EXHAUSTED",
        message:
          "This month's Vector Codium usage cannot cover this model's largest request right now. Wait for running requests to finish, or choose a lighter model. Your Codium usage renews each billing period.",
      },
    })
    // Finished requests keep only what they were charged, for a moment, until the key's usage shows it.
    expect(keys.get("hash_fixture1")!.data.usage).toBeCloseTo(4.972, 9)
    expect(await held(2, "1000")).toHaveLength(2)
    state.chatDelay = 0
    expect((await chat()).status).toBe(200)
    expect(await held(3, "1000")).toHaveLength(3)
    // A request the provider refuses after dispatch keeps its attempt held: a refusal is not proof that nothing was
    // billed (the owner's A17 reservation policy), so it settles as broken at its one-attempt amount.
    keys.get("hash_fixture1")!.data.usage = 4
    state.upstreamStatus = 500
    expect((await chat()).status).toBe(503)
    const after = await held(4)
    expect(after.filter((member) => member.endsWith(":1000"))).toHaveLength(3)
    expect(after.filter((member) => member.endsWith(":12288"))).toHaveLength(1)
    expect(chats()).toHaveLength(4)
  })

  test("an answer that breaks off keeps its largest cost held, since the provider may still bill it", async () => {
    await paid()
    const pool = heldKey
    const members = async () => (await redis(["ZRANGE", pool, 0, -1])) as string[]
    state.charge = 0.001
    state.streamMode = "truncated"
    const broken = await chat()
    expect(await broken.text()).toContain('"code":"MODEL_PLAN_STREAM"')
    state.streamMode = "normal"
    expect((await chat()).status).toBe(200)
    // The finished answer settles to its charge just after it ends.
    for (let tries = 0; tries < 100 && !(await members()).some((member) => member.endsWith(":1000")); tries++)
      await Bun.sleep(10)
    const current = await members()
    expect(current).toHaveLength(2)
    const kept = current.find((member) => !member.endsWith(":1000"))
    if (!kept) throw new Error("Expected the broken answer's hold")
    // Still the model's largest request, held until it lapses 11 minutes after the request started, not 30 seconds.
    // A request without X-Vector-Purpose counts as `task` (§4.9).
    expect(kept.split(":").slice(1)).toEqual(["task", "-", "12288"])
    expect(Number(await redis(["ZSCORE", pool, kept]))).toBeGreaterThan(Date.now() + 600_000)
  })

  test("normalizes upstream capacity and busy failures without leaking credentials or retrying", async () => {
    await paid()
    for (const status of [402, 429, 500]) {
      state.upstreamStatus = status
      const response = await chat()
      expect(response.status).toBe(status === 500 ? 503 : status)
      const body = await response.text()
      expect(body).not.toContain("PRIVATE")
      expect(body).not.toContain("fixture-paid-secret")
      // The request reached the provider and is committed in full, so its answer says so and no client resends it.
      expect(JSON.parse(body).error.dispatched).toBe(true)
    }
    expect(chats()).toHaveLength(3)
  })

  test("late errors and truncated or invalid streams end with a sanitized error and DONE", async () => {
    await paid()
    for (const mode of ["error", "truncated", "invalid"]) {
      state.streamMode = mode
      const response = await chat()
      const body = await response.text()
      expect(response.status).toBe(200)
      expect(body).toContain('"content":"fixture"')
      expect(body).toContain('"code":"MODEL_PLAN_STREAM"')
      expect(body.endsWith("data: [DONE]\n\n")).toBe(true)
      expect(body).not.toContain("PRIVATE")
      expect(body).not.toContain("fixture-paid-secret")
    }
    expect(chats()).toHaveLength(3)
  })
})

describe("Codium credits used from Vector", () => {
  // Vector's own client code, sending what it would send to vectordev.ai to the gateway handlers here instead.
  const forward = (url: string, init: RequestInit) => {
    if (!url.startsWith(`${ModelPlanStatus.SITE}/api/model-plans/`)) throw new Error(`Unexpected destination ${url}`)
    return fetch(`${state.origin}${url.slice(ModelPlanStatus.SITE.length)}`, init)
  }
  // The client sends its own version and catalog headers (A19); in development the gateway accepts "local".
  const turn = (token: string) => {
    const catalog = ModelPlans.createClient({ request: forward })
    return ModelPlans.createFetch({
      modelID: model.id,
      credential: async () => token,
      catalog: (value) => catalog.catalog(value, { wait: true }),
      request: forward,
    })("https://vectordev.ai/api/model-plans/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: "Fix the failing test" }] }),
    })
  }

  test("a signed-in turn is debited from the monthly usage, and running out stops at See plans", async () => {
    await paid()
    const token = mintCliToken(user, Date.now(), "desktop").token
    const catalog = await ModelPlans.createClient({ request: forward }).catalog(token, { force: true })
    // The v2 answer: the plan, its limits and each model's public fields, never a price or an amount.
    expect(catalog).toMatchObject({ enabled: true, limits: { inFlight: expect.any(Number) } })
    expect(catalog).toHaveProperty("plan")
    expect(catalog.models.find((item) => item.id === model.id)).toMatchObject({
      id: model.id,
      name: model.name,
      contextLength: model.contextLength,
      maxOutputTokens: model.maxOutputTokens,
    })
    // A client that does not say which release it is gets nothing listed (§4.12), whatever the account has.
    const unannounced = (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers)
      headers.delete("x-vector-client")
      headers.delete("x-vector-catalog")
      return forward(url, { ...init, headers })
    }
    expect(await ModelPlans.createClient({ request: unannounced }).catalog(token, { force: true })).toEqual({
      enabled: false,
      models: [],
    })

    state.charge = 0.5
    const answer = await turn(token)
    expect(answer.status).toBe(200)
    const usage = (await answer.text())
      .split("\n\n")
      .map((frame) => frame.replace(/^data: /, ""))
      .filter((frame) => frame.startsWith("{"))
      .map((frame) => JSON.parse(frame).usage)
      .find((usage) => usage !== undefined)
    // The account's key was charged; Vector gets the tokens, never the dollars, which beside the share of the plan
    // used would reveal its allowance.
    expect(usage).toEqual({ prompt_tokens: 200, completion_tokens: 6, total_tokens: 206 })
    expect(keys.get("hash_fixture1")!.data.usage).toBe(0.5)
    expect(chats()).toHaveLength(1)
    expect(chats()[0]!.headers.get("authorization")).toBe("Bearer fixture-paid-secret-1")
    expect(JSON.stringify(chats()[0]!.body)).not.toContain(token)
    const status = await ModelPlanStatus.fetchStatus(token, forward)
    expect(status).toMatchObject({ signedIn: true, enabled: true, plan: { name: "Plus", left: 0.9 } })
    expect(ModelPlanStatus.describe(status)[0]).toContain("90% left this month")

    // The monthly usage runs out: the next turn is refused before any model request, with See plans.
    keys.get("hash_fixture1")!.data.usage = 5
    const refused = await turn(token)
    expect(refused.status).toBe(402)
    expect(ModelPlans.gatewayFailure(refused.status, await refused.text())).toMatchObject({
      kind: "credits",
      message: expect.stringContaining(`See plans at ${ModelPlanStatus.PURCHASE_URL}`),
    })
    expect(chats()).toHaveLength(1)
    // Status keeps an answer 30 s (§4.11); this read stands for one after that.
    await forgetStatus()
    const empty = await ModelPlanStatus.fetchStatus(token, forward)
    expect(empty).toMatchObject({ plan: { left: 0 }, empty: true })
    expect(ModelPlanStatus.notice(empty)?.kind).toBe("empty")
    state.charge = 0
  })

  test("a provider refusal after dispatch is committed once, and Vector's transport hands it on as final", async () => {
    await paid()
    await reconcileModelPlanAccount(user.id, fetcher)
    const token = mintCliToken(user, Date.now(), "desktop").token
    const committed = async () =>
      (await readModelSpendLedger(user.id, "hash_fixture1", Date.now(), fetcher)).committedMicro
    // Settlement runs in the gateway's finally, just after the answer is written.
    const settled = async (from: number) => {
      for (let tries = 0; tries < 200 && (await committed()) === from; tries++) await Bun.sleep(10)
      return (await committed()) - from
    }
    // The provider's busy, other refusal and capacity answers, each sent once by the gateway (Plus does not retry).
    for (const [upstream, status] of [
      [429, 400],
      [503, 400],
      [402, 402],
    ] as const) {
      state.upstreamStatus = upstream
      const sent = chats().length
      const before = await committed()
      const answer = await turn(token)
      // A client error the AI SDK and the V2 executor never retry, final for the session's retry loop too.
      expect(answer.status).toBe(status)
      expect(ModelPlans.gatewayFailure(answer.status, await answer.text())).toMatchObject({
        kind: "unavailable",
        action: "unavailable",
        retry: false,
      })
      expect(chats().length - sent).toBe(1)
      // One attempt's whole reservation, committed for the period: the provider may have billed it.
      expect(await settled(before)).toBe(12_288)
    }
    state.upstreamStatus = 200
  })

  test("the status Vector reads carries shares and flags, never an amount of credits", async () => {
    const current = await paid()
    await modelPlanCredential(user.id, fetcher)
    const token = mintCliToken(user).token
    const read = async () =>
      (await forward(ModelPlanStatus.STATUS_URL, { headers: { authorization: `Bearer ${token}` } })).json()
    keys.get("hash_fixture1")!.data.usage = 1.234
    const body = await read()
    expect(body).toEqual({
      enabled: true,
      active: true,
      customer: true,
      access: true,
      plan: {
        id: "vector-10",
        name: "Plus",
        left: 0.75,
        renewsAt: current.items.data[0]!.current_period_end * 1000,
        cancelAtPeriodEnd: false,
        state: "active",
        // Plus may use a quarter of its month a day; nothing was spent today.
        today: { used: 0, resetsAt: expect.any(Number), reached: false },
      },
      listed: [],
      entitlements: publicEntitlements("vector-10", new Set()),
      purchased: { bought: false },
      empty: false,
      low: false,
    })
    expect(body.plan.today.resetsAt % 86_400_000).toBe(0)
    expect(body.plan.today.resetsAt).toBeGreaterThan(Date.now())
    // Neither the allowance (5), what was used nor what is left reaches the app, the CLI or the browser: every number
    // is a share in 0..1, a timestamp, or one of the plan's public caps (P1).
    expect(JSON.stringify(body)).not.toMatch(/credits|remaining|wallet|1\.234|3\.766|"5"|:5[,}]/)
    const { entitlements: _caps, ...shares } = body
    const numbers = JSON.stringify(shares).match(/"(\w+)":(-?[\d.]+)/g) ?? []
    for (const entry of numbers) {
      const [, key, value] = /"(\w+)":(-?[\d.]+)/.exec(entry)!
      if (key === "renewsAt" || key === "resetsAt") expect(Number(value)).toBeGreaterThan(1_700_000_000_000)
      else expect(Number(value) >= 0 && Number(value) <= 1).toBe(true)
    }

    // Running low is a tenth of this month's credits; too few for the catalog's cheapest largest request
    // ($0.012288 for the fixture model) is empty, the point where the gateway refuses every request. Status keeps an
    // answer 30 s (§4.11); each read below stands for one after that.
    keys.get("hash_fixture1")!.data.usage = 4.51
    await forgetStatus()
    expect(await read()).toMatchObject({ plan: { left: 0.1 }, empty: false, low: true })
    keys.get("hash_fixture1")!.data.usage = 5 - 0.013
    await forgetStatus()
    expect(await read()).toMatchObject({ plan: { left: 0 }, empty: false, low: true })
    keys.get("hash_fixture1")!.data.usage = 5 - 0.012
    // Within the 30 s the earlier answer stands.
    expect(await read()).toMatchObject({ plan: { left: 0 }, empty: false, low: true })
    await forgetStatus()
    expect(await read()).toMatchObject({ plan: { left: 0 }, empty: true, low: false })
    // A key whose usage cannot be read leaves the share unknown and raises no flag.
    delete keys.get("hash_fixture1")!.data.usage
    await forgetStatus()
    const unknown = await read()
    expect(unknown).toMatchObject({ empty: false, low: false })
    expect(unknown.plan).not.toHaveProperty("left")
  })

  test("while sales are off Vector lists no Codium and a turn sends nothing", async () => {
    await paid()
    process.env.MODEL_PLANS_ENABLED = "false"
    const token = mintCliToken(user, Date.now(), "desktop").token
    expect(await ModelPlans.createClient({ request: forward }).catalog(token, { force: true })).toEqual({
      enabled: false,
      models: [],
    })
    const refused = await turn(token)
    expect(ModelPlans.gatewayFailure(refused.status, await refused.text())).toMatchObject({ kind: "unavailable" })
    expect(chats()).toHaveLength(0)
    const status = await ModelPlanStatus.fetchStatus(token, forward)
    expect(ModelPlanStatus.notice(status)).toEqual({
      kind: "unavailable",
      text: "Vector Codium is not available right now.",
    })
  })
})

describe("A17 admission and chat", () => {
  const admissions = () => commands.filter((command) => command[0] === "EVAL" && command[1] === ADMISSION_SCRIPTS.ADMIT)
  const stripeCalls = () => calls.filter((call) => call.path.startsWith("/v1/"))
  const keyReads = () => calls.filter((call) => call.path.startsWith("/api/v1/keys") && call.method === "GET")
  const inflight = `vector:codium:test:inflight:${user.id}`
  // A model whose one attempt reserves `inputPrice` × 8,192 + $2 × 2,048 per million, for budget boundaries.
  const priced = (id: string, inputPrice: number, extra: Partial<ModelPlanModel> = {}): ModelPlanModel => ({
    ...model,
    id,
    name: id,
    inputPrice,
    ...extra,
  })
  // The account is paid and reconciled (its snapshot and key exist), and nothing it took to get there is counted.
  async function subscribed(price: 10 | 50 | 100 | 200 = 10) {
    state.subscriptions = [subscription(undefined, undefined, price)]
    await redis(["SET", accountKey, JSON.stringify({ customer: "cus_fixture" })])
    await reconcileModelPlanAccount(user.id, fetcher)
    calls.length = 0
    commands.length = 0
  }
  // P1: a refusal names no amount, price or credit figure.
  const privateFree = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(/\$|usd|credit|cent|\d/i)
  function runs(caller: (token: string) => ModelPlanCaller) {
    const registry = createRunVerifierRegistry()
    registry.register("vrt_", async (token) => caller(token))
    registry.register("vht_", async (token) => caller(token))
    state.runVerifiers = registry
  }
  // A fresh status read: the 30-second answer is dropped first.
  const status = async () => {
    await forgetStatus()
    const response = await fetch(`${state.origin}/api/model-plans/status`, {
      headers: { authorization: `Bearer ${mintCliToken(user).token}` },
    })
    return response.json()
  }
  // A model reservation of `micro` admitted at `at`, as the gateway admits a request before dispatching it.
  const reserve = async (micro: number, at: number) => {
    const snapshot = (await readSnapshot(user.id, fetcher))!
    const funding = (await snapshotPoolCredential(user.id, snapshot, fetcher, at))!
    return admitModelPlan({ snapshot, funding, requiredMicro: micro, purpose: "chat" }, fetcher, at)
  }
  const runCaller = (
    run: string,
    service: "cloud-agents" | "hosted" = "cloud-agents",
    extra: Partial<NonNullable<ModelPlanCaller["run"]>> = {},
  ): ModelPlanCaller => ({
    account: { id: user.id },
    kind: "run",
    purpose: "review",
    run: { id: run, source: "github-comment", deadline: Date.now() + 3_600_000, service, ...extra },
  })

  test("an unqualified real route is unavailable before the snapshot, a credential, a hold or a fetch", async () => {
    const real = CODIUM_MODELS[0]!
    process.env.MODEL_PLAN_MODELS_JSON = JSON.stringify([model, real])
    await paid()
    const response = await chat({ model: real.id, messages: [{ role: "user", content: "fixture" }] })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "MODEL_PLAN_MODEL_UNAVAILABLE" } })
    expect(stripeCalls()).toEqual([])
    expect(calls.filter((call) => call.path.startsWith("/api/v1/"))).toEqual([])
    expect(admissions()).toEqual([])
    expect(await redis(["GET", `vector:codium:test:ent:${user.id}`])).toBeNull()
  })

  test("a disabled model answers 503 before any account read", async () => {
    await paid()
    await redis(["SADD", "vector:codium:test:models-off", model.id])
    // The switch cache is per fetcher; a fresh one reads the set this test wrote.
    state.gatewayFetcher = Object.assign((input: string | URL | Request, init?: RequestInit) => fetcher(input, init), {
      preconnect: fetch.preconnect,
    })
    const response = await chat()
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "MODEL_PLAN_MODEL_UNAVAILABLE" } })
    expect(stripeCalls()).toEqual([])
    expect(admissions()).toEqual([])
    expect(chats()).toEqual([])
  })

  test("a misconfigured gateway limit refuses at the enabled gate, before Stripe, OpenRouter or the store", async () => {
    await subscribed()
    process.env.MODEL_PLAN_PRIORITY_RESERVE = "1.5"
    const response = await chat()
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "MODEL_PLANS_CONFIGURATION" } })
    expect(calls).toEqual([])
    expect(commands).toEqual([])
  })

  test("with a fresh snapshot a request makes one admission EVAL, one key read and no Stripe call (M4)", async () => {
    await subscribed()
    for (let index = 0; index < 5; index++) {
      const response = await chat()
      expect(response.status).toBe(200)
      await response.text()
    }
    expect(admissions()).toHaveLength(5)
    expect(keyReads()).toHaveLength(5)
    expect(stripeCalls()).toEqual([])
    expect(chats()).toHaveLength(5)
    // The provider key is revealed only for the upstream call, never written to the store with the admission.
    expect(JSON.stringify(commands)).not.toContain("fixture-paid-secret")
  })

  test("a locked model answers 403 with no hold, admission or provider call", async () => {
    await subscribed()
    state.gatewayModels = [model, priced("fixture/max-only", 1, { minPlan: "vector-100" })]
    const response = await chat({ model: "fixture/max-only", messages: [{ role: "user", content: "fixture" }] })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: { code: "MODEL_PLAN_UPGRADE_REQUIRED", plan: "vector-100" },
    })
    expect(admissions()).toEqual([])
    expect(keyReads()).toEqual([])
    expect(chats()).toEqual([])
    expect(await redis(["ZRANGE", heldKey, 0, -1])).toEqual([])
  })

  // A Max checkout opened ten minutes ago: a locked model reconciles once before answering, and that answer follows
  // the reconciled snapshot's state exactly as the first snapshot's would.
  async function upgrading(status: string) {
    await subscribed()
    state.gatewayModels = [model, priced("fixture/max-only", 1, { minPlan: "vector-100" })]
    const checkout = { id: "cs_upgrade", plan: "vector-100", url: "https://checkout.stripe.com/c/pay/cs_upgrade" }
    sessions.set(checkout.id, {
      ...checkout,
      customer: "cus_fixture",
      expires_at: Math.floor(Date.now() / 1000) + 1200,
      status: "open",
      metadata: {},
    })
    const account = JSON.parse(String(await redis(["GET", accountKey])))
    await redis([
      "SET",
      accountKey,
      JSON.stringify({ ...account, checkout: { ...checkout, expires: Date.now() + 1_200_000 } }),
    ])
    // The upgrade keeps the subscribed period's start. A start recomputed after the wall-clock second ticks opens a new
    // period, which provisions a second key and fails the fake gateway's first-key check.
    state.subscriptions = [
      { ...subscription(state.subscriptions[0]!.items.data[0]!.current_period_start, undefined, 100), status },
    ]
    calls.length = 0
    commands.length = 0
    return chat({ model: "fixture/max-only", messages: [{ role: "user", content: "fixture" }] })
  }
  const reconcileSlot = `vector:codium:test:reconcile:${user.id}`
  const reconciles = () => commands.filter((command) => command[0] === "SET" && command[1] === reconcileSlot)

  test("a locked model after a recent upgrade checkout reconciles once and serves the upgraded plan", async () => {
    const served = await upgrading("active")
    expect(served.status).toBe(200)
    await served.text()
    expect(reconciles()).toHaveLength(1)
    expect(calls.filter((call) => call.path === "/v1/subscriptions")).toHaveLength(1)
    expect(admissions()).toHaveLength(1)
    expect(chats()).toHaveLength(1)
  })

  test("a recent-checkout reconcile that finds the payment failed answers 402, not a retry", async () => {
    const refused = await upgrading("past_due")
    expect(refused.status).toBe(402)
    expect(refused.headers.get("retry-after")).toBeNull()
    const payload = await refused.json()
    expect(payload).toMatchObject({
      error: { code: "MODEL_PLAN_PAYMENT_REQUIRED", reason: "payment_failed", action: "update-card" },
    })
    privateFree(payload)
    expect(reconciles()).toHaveLength(1)
    expect(admissions()).toEqual([])
    expect(keyReads()).toEqual([])
    expect(chats()).toEqual([])
  })

  test("the thirty-first Plus request in a parallel burst is rate limited, whatever concurrency refuses", async () => {
    await subscribed()
    state.chatDelay = 50
    const responses = await Promise.all(Array.from({ length: 34 }, () => chat()))
    const codes = await Promise.all(
      responses.map(async (response) =>
        response.status === 200 ? (await response.text(), "ok") : (await response.json()).error.code,
      ),
    )
    expect(codes.filter((code) => code === "RATE_LIMITED")).toHaveLength(4)
    expect(codes.every((code) => ["ok", "RATE_LIMITED", "MODEL_PLAN_CONCURRENCY"].includes(code))).toBe(true)
    expect(codes.filter((code) => code === "ok").length).toBeGreaterThan(0)
    // Requests refused before admission never reached it; every admitted one dispatched once.
    expect(admissions()).toHaveLength(30)
    expect(chats()).toHaveLength(codes.filter((code) => code === "ok").length)
  })

  test("a settlement lost twice is queued with its known outcome, and the outbox records it once", async () => {
    await subscribed()
    state.charge = 0.001
    state.failSettles = 2
    state.failSettlesFrom = Date.now()
    const served = await chat()
    expect(served.status).toBe(200)
    await served.text()
    const [admit] = admissions()
    const ticket = JSON.parse(String(admit![3 + Number(admit![2])])).ticket
    const key = `vector:codium:test:outbox:item:model-settle:${ticket}`
    const queued = async () => Number(await redis(["EXISTS", key]))
    for (let tries = 0; tries < 200 && (await queued()) === 0; tries++) await Bun.sleep(10)
    expect(await queued()).toBe(1)
    // Until the retry lands the reservation still counts at its full amount and the slot stays taken: never free.
    expect(await readModelSpendLedger(user.id, "hash_fixture1", Date.now(), fetcher)).toMatchObject({
      reservedMicro: 12_288,
      committedMicro: 0,
    })
    expect(Number(await redis(["ZCARD", inflight]))).toBe(1)
    const record = JSON.parse(String(await redis(["GET", key])))
    expect(record).toMatchObject({
      kind: "model-settle",
      payload: { outcome: { kind: "complete", chargeMicro: 1_000 } },
    })
    await drainOutbox({ now: Date.now(), fetcher })
    expect(await queued()).toBe(0)
    expect(await readModelSpendLedger(user.id, "hash_fixture1", Date.now(), fetcher)).toMatchObject({
      reservedMicro: 0,
      committedMicro: 1_000,
    })
    expect(Number(await redis(["ZCARD", inflight]))).toBe(0)
    // A second delivery of the same retry is recognised as done: nothing is charged twice.
    await enqueueAction("model-settle", record.key, record.payload, undefined, fetcher)
    await drainOutbox({ now: Date.now(), fetcher })
    expect(await queued()).toBe(0)
    expect((await readModelSpendLedger(user.id, "hash_fixture1", Date.now(), fetcher)).committedMicro).toBe(1_000)
  })

  test("service hooks see each admitted request once, after its settlement is recorded or queued", async () => {
    await subscribed()
    const settles = () =>
      commands.filter((command) => command[0] === "EVAL" && command[1] === ADMISSION_SCRIPTS.SETTLE).length
    const seen: { hook: string; admissions: number; settles: number; queued?: number; context?: AfterSettleContext }[] =
      []
    state.hooks = [
      {
        id: "fixture-meter",
        beforeAdmit: async () => {
          seen.push({ hook: "before", admissions: admissions().length, settles: settles() })
        },
        afterSettle: async (_caller, context) => {
          const admit = admissions().at(-1)!
          const ticket = JSON.parse(String(admit[3 + Number(admit[2])])).ticket
          const queued = Number(await redis(["EXISTS", `vector:codium:test:outbox:item:model-settle:${ticket}`]))
          seen.push({ hook: "after", admissions: admissions().length, settles: settles(), queued, context })
        },
      },
    ]
    const after = async (count: number) => {
      for (let tries = 0; tries < 200 && seen.filter((entry) => entry.hook === "after").length < count; tries++)
        await Bun.sleep(10)
      return seen.filter((entry) => entry.hook === "after")
    }
    state.charge = 0.001
    const served = await chat()
    expect(served.status).toBe(200)
    await served.text()
    expect(await after(1)).toHaveLength(1)
    // Hooks run before admission, then once after the settlement landed, with the outcome the gateway knows.
    expect(seen).toMatchObject([
      { hook: "before", admissions: 0, settles: 0 },
      {
        hook: "after",
        admissions: 1,
        settles: 1,
        queued: 0,
        context: { charge: 0.001, streamed: true, model: { id: model.id }, snapshot: { plan: "vector-10" } },
      },
    ])
    expect(seen[1]!.context!.startedAt).toBeLessThanOrEqual(seen[1]!.context!.endedAt)

    // Both settle answers lost: the outcome is queued for the outbox, and the hooks still see the request, once.
    seen.length = 0
    state.failSettles = 2
    state.failSettlesFrom = Date.now()
    const queued = await chat()
    expect(queued.status).toBe(200)
    await queued.text()
    expect(await after(1)).toHaveLength(1)
    await Bun.sleep(50)
    expect(seen).toMatchObject([
      { hook: "before", admissions: 1, settles: 1 },
      { hook: "after", admissions: 2, settles: 3, queued: 1, context: { charge: 0.001, streamed: true } },
    ])

    // A request refused before admission never reaches afterSettle: nothing was admitted or settled.
    seen.length = 0
    state.hooks = [
      ...state.hooks,
      {
        id: "fixture-refusal",
        beforeAdmit: async () => {
          throw new ApiError(403, "MODEL_PLAN_BLOCKED", "Refused by a fixture service.")
        },
      },
    ]
    expect((await chat()).status).toBe(403)
    await Bun.sleep(50)
    expect(seen.map((entry) => entry.hook)).toEqual(["before"])
    expect(admissions()).toHaveLength(2)
  })

  test("concurrency is freed after an upstream error, a transport throw and a client abort", async () => {
    await subscribed()
    // Settlement runs in the gateway's finally, just after the answer is written.
    const freed = async () => {
      for (let tries = 0; tries < 200 && Number(await redis(["ZCARD", inflight])) > 0; tries++) await Bun.sleep(10)
      return Number(await redis(["ZCARD", inflight]))
    }
    state.upstreamStatus = 500
    expect((await chat()).status).toBe(503)
    expect(await freed()).toBe(0)
    state.upstreamStatus = 200
    state.throwTransport = true
    expect((await chat()).status).toBe(503)
    expect(await freed()).toBe(0)
    state.throwTransport = false
    state.chatDelay = 300
    const abort = new AbortController()
    const pending = fetch(`${state.origin}/chat`, {
      method: "POST",
      signal: abort.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mintCliToken(user, Date.now(), "desktop").token}`,
        "x-vector-client": "1.99.113",
        "x-vector-catalog": "2",
      },
      body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: "fixture" }] }),
    }).catch(() => undefined)
    for (let tries = 0; tries < 100 && state.dispatches < 3; tries++) await Bun.sleep(10)
    abort.abort()
    await pending
    expect(await freed()).toBe(0)
    // Plus runs three at once; a fourth waits with a jittered retry-after-ms and is not a credit refusal.
    state.chatDelay = 150
    const responses = await Promise.all(Array.from({ length: 4 }, () => chat()))
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 200, 429])
    const busy = responses.find((response) => response.status === 429)!
    const wait = Number(busy.headers.get("retry-after-ms"))
    expect(wait).toBeGreaterThanOrEqual(1500)
    expect(wait).toBeLessThanOrEqual(4000)
    const body = await busy.json()
    expect(body).toMatchObject({ error: { code: "MODEL_PLAN_CONCURRENCY" } })
    privateFree(body)
  })

  test("a client that stops reading is settled at the request's deadline, never left to the platform's kill", async () => {
    await subscribed()
    // A run whose deadline is two seconds away bounds the request; the provider streams without end.
    runs(() => runCaller("run-stalled", "cloud-agents", { deadline: Date.now() + 2_000 }))
    const frame = new TextEncoder().encode(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "fixture" } }] })}\n\n`,
    )
    const gateway = Object.assign(
      (input: string | URL | Request, init?: RequestInit) =>
        String(input).endsWith("/chat/completions")
          ? Promise.resolve(
              new Response(new ReadableStream({ pull: (controller) => controller.enqueue(frame) }), {
                headers: { "content-type": "text/event-stream" },
              }),
            )
          : fetcher(input, init),
      { preconnect: fetch.preconnect },
    )
    const request = Object.assign(new IncomingMessage(new Socket()), {
      method: "POST",
      url: "/chat",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer vrt_fixture.run-stalled",
        "x-vector-client": "1.99.113",
        "x-vector-catalog": "2",
      },
      body: { model: model.id, messages: [{ role: "user", content: "fixture" }] },
    })
    // An unattached response never drains, as a connection whose client stopped reading but stayed open.
    const handled = handleModelPlanChat(request, new ServerResponse(request), gateway, {
      models: [model],
      qualify: (selected) => selected.id === model.id,
      reservation: fixtureReservation,
      runVerifiers: state.runVerifiers,
    }).then(() => "settled")
    expect(await Promise.race([handled, Bun.sleep(10_000).then(() => "stalled")])).toBe("settled")
    // Settled as broken in the gateway's finally: its one dispatched attempt is committed at the fixed reservation,
    // instead of an open reservation abandoned at its full amount when the platform kills the function.
    expect(await readModelSpendLedger(user.id, "hash_fixture1", Date.now(), fetcher)).toMatchObject({
      reservedMicro: 0,
      committedMicro: 12_288,
    })
    expect(Number(await redis(["ZCARD", inflight]))).toBe(0)
  })

  // Owner, 30 Oct: Sol stays staged until its OpenRouter ZDR endpoint is captured and accepted; Terra and Astra are
  // out. Both use the production catalog and qualification, so an Ultra plan that would include Sol changes nothing.
  test.each(["openai/gpt-6.1-sol", "openai/gpt-6.1-sol:deep", "openai/gpt-6.1-sol:deepest"])(
    "staged %s is unavailable to Ultra before the snapshot, a credential, an admission or a fetch",
    async (id) => {
      await subscribed(200)
      const response = await chat({ model: id, messages: [{ role: "user", content: "fixture" }] })
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ error: { code: "MODEL_PLAN_MODEL_UNAVAILABLE" } })
      expect(stripeCalls()).toEqual([])
      expect(calls.filter((call) => call.path.startsWith("/api/v1/"))).toEqual([])
      expect(admissions()).toEqual([])
      expect(commands.filter((command) => command.some((part) => String(part).includes(":ent:")))).toEqual([])
    },
  )

  test.each(["openai/gpt-6.1-terra", "openai/gpt-6-astra", "openai/gpt-6-astra:long"])(
    "removed %s is not a Codium model: 400 with no snapshot, admission or fetch",
    async (id) => {
      await subscribed(200)
      const response = await chat({ model: id, messages: [{ role: "user", content: "fixture" }] })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: "MODEL_PLAN_MODEL" } })
      expect(stripeCalls()).toEqual([])
      expect(calls.filter((call) => call.path.startsWith("/api/v1/"))).toEqual([])
      expect(admissions()).toEqual([])
      expect(commands.filter((command) => command.some((part) => String(part).includes(":ent:")))).toEqual([])
    },
  )

  test("the global priority reserve keeps the last slots for Max and Ultra", async () => {
    process.env.MODEL_PLAN_GLOBAL_INFLIGHT = "2"
    process.env.MODEL_PLAN_PRIORITY_RESERVE = "0.5"
    await subscribed(10)
    state.chatDelay = 150
    const plus = await Promise.all(Array.from({ length: 2 }, () => chat()))
    expect(plus.map((response) => response.status).sort()).toEqual([200, 429])
    const busy = await plus.find((response) => response.status === 429)!.json()
    expect(busy).toMatchObject({ error: { code: "MODEL_PLAN_BUSY" } })
    // Refused before dispatch: nothing is committed, so the client may retry it.
    expect(busy.error.dispatched).toBeUndefined()
    expect(ModelPlans.gatewayFailure(429, JSON.stringify(busy))).toMatchObject({ retry: true })
    await redis(["FLUSHDB"])
    keys.clear()
    await subscribed(100)
    const max = await Promise.all(Array.from({ length: 3 }, () => chat()))
    expect(max.map((response) => response.status).sort()).toEqual([200, 200, 429])
  })

  test("the daily share refuses with retry-after to UTC midnight and names no amount", async () => {
    await subscribed()
    // Plus: a quarter of 5 a day. Each attempt reserves 0.602112 and is charged 0.6.
    state.gatewayModels = [priced("fixture/heavy", 73)]
    state.charge = 0.6
    const body = { model: "fixture/heavy", messages: [{ role: "user", content: "fixture" }] }
    for (let index = 0; index < 2; index++) expect((await chat(body)).status).toBe(200)
    const refused = await chat(body)
    expect(refused.status).toBe(429)
    const payload = await refused.json()
    expect(payload).toMatchObject({ error: { code: "MODEL_PLAN_DAILY_LIMIT" } })
    privateFree(payload)
    const midnight = Math.ceil((86_400_000 - (Date.now() % 86_400_000)) / 1000)
    expect(Math.abs(Number(refused.headers.get("retry-after")) - midnight)).toBeLessThanOrEqual(2)
    expect(chats()).toHaveLength(2)
  })

  test("status's today counts what ADMIT counts: a live pool hold that leaves no room is reached, one micro less is not", async () => {
    await subscribed()
    // Plus: a quarter of 5 a day is 1.25 allowed; the fixture model reserves 0.012288 an attempt, one attempt on Plus.
    // A live nonmodel hold has no admission day, so both count it today; it leaves room for the request or it does not.
    for (const [usd, reached, answer] of [
      [1.237713, true, 429],
      [1.237712, false, 200],
    ] as const) {
      const hold = await holdPool(user.id, usd, 60_000, "hosted", { fetcher })
      expect((await status()).plan.today).toMatchObject({ used: 0.99, reached })
      const response = await chat()
      expect(response.status).toBe(answer)
      if (answer === 429) expect(await response.json()).toMatchObject({ error: { code: "MODEL_PLAN_DAILY_LIMIT" } })
      else await response.text()
      await hold.release()
    }
  })

  test("status's today leaves running requests out, as empty does; an abandoned reservation counts in full", async () => {
    await subscribed()
    // Plus: a quarter of 5 a day is 1.25 allowed; the fixture model reserves 0.012288 an attempt, one attempt on Plus.
    // A request still running holds 1.24 until it settles, minutes later. ADMIT counts it, so a second request is refused
    // meanwhile, but the day's meter neither jumps by the reservation nor shows the limit reached (both would then
    // stay for the 30 seconds the answer is kept).
    const running = await reserve(1_240_000, Date.now())
    expect((await status()).plan.today).toMatchObject({ used: 0, reached: false })
    const refused = await chat()
    expect(refused.status).toBe(429)
    expect(await refused.json()).toMatchObject({ error: { code: "MODEL_PLAN_DAILY_LIMIT" } })
    await settleModelPlan(running, { kind: "cancel" }, fetcher)
    // Past its deadline a reservation's outcome is unknown, so today counts it in full, as ADMIT does. The day figure
    // status reads, just before and at the deadline: eleven minutes inside one UTC day and the subscribed hour.
    const now = Date.now()
    const at = Math.max(now - 3_000_000, now - (now % 86_400_000) + 1_000)
    const ticket = await reserve(1_240_000, at)
    expect(await readModelSpendDay(user.id, "hash_fixture1", at + 659_999, fetcher)).toBe(0)
    expect(await readModelSpendDay(user.id, "hash_fixture1", at + 660_000, fetcher)).toBe(1_240_000)
    await settleModelPlan(ticket, { kind: "cancel" }, fetcher)
  })

  test("status's empty counts what ADMIT counts: an abandoned reservation that leaves no room is empty", async () => {
    await subscribed()
    // Plus: 5 of allowance, 4.9 used, so 0.1 is left; the fixture model reserves 0.012288, one attempt on Plus.
    keys.get("hash_fixture1")!.data.usage = 4.9
    // A request admitted 661 s ago whose function was killed before its finally settled it: past its deadline its
    // outcome is unknown, and it counts in full for the rest of the period.
    const abandoned = () => Date.now() - 661_000
    for (const [micro, empty, answer] of [
      [87_713, true, 402],
      [87_712, false, 200],
    ] as const) {
      const ticket = await reserve(micro, abandoned())
      expect(await status()).toMatchObject({ plan: { left: 0.02 }, empty, low: !empty })
      const response = await chat()
      expect(response.status).toBe(answer)
      if (answer === 402) expect(await response.json()).toMatchObject({ error: { code: "MODEL_PLAN_EXHAUSTED" } })
      else await response.text()
      await settleModelPlan(ticket, { kind: "cancel" }, fetcher)
    }
    // The served request settles just after its answer ends; wait for that, so only the next reservation is open.
    for (let tries = 0; tries < 100; tries++) {
      if (!(await readModelSpendLedger(user.id, "hash_fixture1", Date.now(), fetcher)).reservedMicro) break
      await Bun.sleep(10)
    }
    // A request still running holds the same amount only until it settles, minutes later: ADMIT waits for it, and the
    // month is not shown as used up meanwhile.
    const running = await reserve(87_713, Date.now())
    expect(await status()).toMatchObject({ plan: { left: 0.02 }, empty: false, low: true })
    await settleModelPlan(running, { kind: "cancel" }, fetcher)
  })

  test("Brain requests share a tenth of the period, and the refusal is not a credit code", async () => {
    await subscribed()
    state.gatewayModels = [priced("fixture/brain", 36)]
    state.charge = 0.29
    const body = { model: "fixture/brain", messages: [{ role: "user", content: "fixture" }] }
    const token = mintCliToken(user, Date.now(), "desktop").token
    expect((await chat(body, token, { "x-vector-purpose": "brain" })).status).toBe(200)
    const refused = await chat(body, token, { "x-vector-purpose": "brain" })
    expect(refused.status).toBe(429)
    const payload = await refused.json()
    expect(payload).toMatchObject({ error: { code: "MODEL_PLAN_BRAIN_SHARE" } })
    expect(ModelPlans.gatewayFailure(429, JSON.stringify(payload))?.kind).not.toBe("credits")
    // Other purposes still have the month.
    expect((await chat(body, token, { "x-vector-purpose": "chat" })).status).toBe(200)
  })

  test("a run's ceiling is atomic under parallel requests", async () => {
    await subscribed()
    // Plus: a run may spend a tenth of 5. Each attempt reserves 0.200704: two fit, a third does not.
    state.gatewayModels = [priced("fixture/run", 24)]
    runs(() => runCaller("run-ceiling"))
    state.chatDelay = 150
    const body = { model: "fixture/run", messages: [{ role: "user", content: "fixture" }] }
    const responses = await Promise.all(Array.from({ length: 3 }, () => chat(body, "vrt_fixture.run-ceiling")))
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 429])
    const payload = await responses.find((response) => response.status === 429)!.json()
    expect(payload).toMatchObject({ error: { code: "MODEL_PLAN_RUN_LIMIT", limit: "ceiling" } })
    privateFree(payload)
    expect(chats()).toHaveLength(2)
  })

  test("run-service guards refuse before any credential, admission or dispatch", async () => {
    await subscribed()
    const computer = {
      model: model.id,
      messages: [{ role: "user", content: "fixture" }],
      tools: [{ type: "function", function: { name: "computer_use", parameters: {} } }],
    }
    // A signed review purpose does not evade the cloud-agents service guard.
    runs(() => runCaller("run-tools"))
    const blocked = await chat(computer, "vrt_fixture.run-tools")
    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toMatchObject({ error: { code: "MODEL_PLAN_BLOCKED" } })
    // A hosted run whose session the user has taken over waits; without a live verifier it is unavailable.
    runs(() => runCaller("run-hosted", "hosted", { sessionId: "session-1" }))
    expect(await (await chat(undefined, "vht_fixture.run-hosted")).json()).toMatchObject({
      error: { code: "HOSTED_UNAVAILABLE" },
    })
    state.hostedLive = async () => false
    const paused = await chat(undefined, "vht_fixture.run-hosted")
    expect(paused.status).toBe(409)
    expect(await paused.json()).toMatchObject({ error: { code: "HOSTED_SESSION_PAUSED" } })
    expect(admissions()).toEqual([])
    expect(keyReads()).toEqual([])
    expect(chats()).toEqual([])
    state.hostedLive = async () => true
    const live = await chat(undefined, "vht_fixture.run-hosted")
    expect(live.status).toBe(200)
    await live.text()
  })

  test("a run bound to a replaced pool must start again, and a new run is admitted", async () => {
    await subscribed()
    // An earlier admission of run-old against the period's previous key bound it there (an upgrade or renewal since).
    await redis(["SET", "vector:codium:test:run-pool:run-old", "hash_replaced"])
    runs((token) => runCaller(token.slice(token.indexOf(".") + 1)))
    const expired = await chat(undefined, "vrt_fixture.run-old")
    expect(expired.status).toBe(401)
    const payload = await expired.json()
    expect(payload).toMatchObject({ error: { code: "MODEL_PLAN_RUN_EXPIRED" } })
    privateFree(payload)
    expect(chats()).toEqual([])
    expect(await redis(["ZRANGE", heldKey, 0, -1])).toEqual([])
    const fresh = await chat(undefined, "vrt_fixture.run-new")
    expect(fresh.status).toBe(200)
    await fresh.text()
    expect(await redis(["GET", "vector:codium:test:run-pool:run-new"])).toBe("hash_fixture1")
  })

  test("an admission delayed past a renewal's key replacement never lands on the old pool", async () => {
    await subscribed()
    const reached = new Promise<void>((resolve) => (state.admitReached = resolve))
    let release = () => {}
    state.admitGate = new Promise<void>((resolve) => (release = resolve))
    const pending = chat()
    await reached
    // The renewal is paid meanwhile: reconcile saves the barrier, switches the old key off and publishes a new one.
    const renewed = Math.floor(Date.now() / 1000) - 60
    state.subscriptions = [subscription(renewed, renewed + 30 * 86_400)]
    await reconcileModelPlanAccount(user.id, fetcher)
    expect((await readModelPlanAccount(user.id, fetcher))?.key).toMatchObject({ hash: "hash_fixture2", start: renewed })
    expect(keys.get("hash_fixture1")!.data.disabled).toBe(true)
    state.admitGate = undefined
    release()
    const refused = await pending
    expect(refused.status).toBe(503)
    expect(refused.headers.get("retry-after")).toBe("1")
    expect(await refused.json()).toMatchObject({ error: { code: "MODEL_PLAN_RENEWING" } })
    expect(chats()).toEqual([])
    // Nothing was reserved on either pool by the refused admission.
    for (const pool of ["hash_fixture1", "hash_fixture2"])
      expect(await readModelSpendLedger(user.id, pool, Date.now(), fetcher)).toMatchObject({
        reservedMicro: 0,
        committedMicro: 0,
      })
  })

  test("a key that is not ready gets one on-demand reconcile, then a retryable answer", async () => {
    await subscribed()
    keys.get("hash_fixture1")!.data.disabled = true
    // Another request already holds this minute's reconcile.
    await redis(["SET", `vector:codium:test:reconcile:${user.id}`, "taken", "PX", 60_000])
    const waiting = await chat()
    expect(waiting.status).toBe(503)
    expect(waiting.headers.get("retry-after")).toBe("1")
    const payload = await waiting.json()
    expect(payload).toMatchObject({ error: { code: "MODEL_PLAN_RENEWING" } })
    privateFree(payload)
    expect(admissions()).toEqual([])
    expect(stripeCalls()).toEqual([])
    await redis(["DEL", `vector:codium:test:reconcile:${user.id}`])
    const repaired = await chat()
    expect(repaired.status).toBe(200)
    await repaired.text()
    expect(keys.get("hash_fixture1")!.data.disabled).toBe(false)
  })

  test("retries: none below Max; one before any byte on Max, charging the uncertain first attempt", async () => {
    await subscribed()
    state.upstreamStatuses = [429]
    expect((await chat()).status).toBe(429)
    expect(state.dispatches).toBe(1)
    await redis(["FLUSHDB"])
    keys.clear()
    await subscribed(100)
    state.dispatches = 0
    state.charge = 0.001
    state.upstreamStatuses = [503]
    const retried = await chat()
    expect(retried.status).toBe(200)
    await retried.text()
    expect(state.dispatches).toBe(2)
    // The first attempt's outcome is unknown, so its whole attempt is committed beside the reported charge.
    expect((await readModelSpendLedger(user.id, "hash_fixture1", Date.now(), fetcher)).committedMicro).toBe(
      12_288 + 1_000,
    )
    state.dispatches = 0
    state.upstreamStatuses = [429, 429]
    expect((await chat()).status).toBe(429)
    expect(state.dispatches).toBe(2)
    // Both attempts stay held at the two-attempt reservation: the provider may have billed either.
    const held = (await redis(["ZRANGE", heldKey, 0, -1])) as string[]
    expect(held.filter((member) => member.endsWith(":24576"))).toHaveLength(1)
  })

  test("a variant sends its upstream id, catalog effort and pinned route, whatever the client asks", async () => {
    await subscribed()
    state.gatewayModels = [
      priced("fixture/variant", 1, {
        upstream: "fixture/upstream-id",
        reasoningEffort: "high",
        providerOnly: ["fixture/fast"],
      }),
    ]
    const response = await chat({
      model: "fixture/variant",
      messages: [{ role: "user", content: "fixture" }],
      reasoning: { effort: "max" },
      provider: { allow_fallbacks: true },
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(chats()[0]!.body).toMatchObject({
      model: "fixture/upstream-id",
      reasoning: { effort: "high" },
      provider: { only: ["fixture/fast"], allow_fallbacks: false, zdr: true, data_collection: "deny" },
    })
  })
})
