import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import path from "node:path"
import { checkCodiumFunding } from "../api/_lib/codium-funding"
import { codiumKey, codiumKeyIn, codiumKeyMode, openRouterKeyName, owedKeyName } from "../api/_lib/codium-keys"
import { recordCodiumCharge } from "../api/_lib/codium-ledger"
import { codiumKeyLimitUsd, codiumLimitProblems, renewalGraceMinutes, trustRampDays } from "../api/_lib/codium-limits"
import { RAMP_SCRIPTS } from "../api/_lib/codium-ramp"
import { POOL_SCRIPTS } from "../api/_lib/codium-pool"
import { MODEL_SPEND_SCRIPTS } from "../api/_lib/codium-spend-ledger"
import { SNAPSHOT_SCRIPTS } from "../api/_lib/codium-snapshot"
import {
  cancelModelPlanAccount,
  modelPlanCheckout,
  modelPlanCredential,
  modelPlanStatus,
  openRouterManagement,
} from "../api/_lib/model-plan-account"
import {
  codiumBillingConfig,
  codiumBillingConfigProblems,
  MODEL_PLANS_MIN_CLIENT_DEFAULT,
  modelPlanRequireMarkedTokens,
  requireCodiumCheckoutUser,
  requireModelPlans,
} from "../api/_lib/model-plan-config"
import {
  modelPlanStripe,
  requireCodiumLivemode,
  requireStripeMode,
  stripeMode,
  stripeModeProblems,
  verifyModelPlanWebhook,
} from "../api/_lib/model-plan-stripe"

// Stripe test mode and live mode never share a record, a key or a card (contract M10 and WP A02). Stripe, OpenRouter
// and the store are in-memory fakes behind the injected fetcher; nothing here reaches a real service.

const admin = { id: "55555555-5555-4555-8555-555555555555", email: "admin@example.test" }
const buyer = { id: "66666666-6666-4666-8666-666666666666", email: "buyer@example.test" }
const KV = "https://kv.mode-fixture.invalid"
const PRICES = [10, 50, 100, 200] as const
// Made-up credits that keep the public multiples exactly: 22/4 = 5.5, 48/4 = 12, 100/4 = 25.
const CREDITS = { 10: "4", 50: "22", 100: "48", 200: "100" } as const

const environment = [
  "MODEL_PLANS_ENABLED",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "STRIPE_SECRET_KEY",
  "CODIUM_STRIPE_MODE",
  "VERCEL_ENV",
  "STRIPE_MODEL_PLAN_WEBHOOK_SECRET",
  "STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID",
  "STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID",
  "OPENROUTER_MANAGEMENT_KEY",
  "MODEL_PLAN_KEY_ENCRYPTION_SECRET",
  "MODEL_PLAN_MODELS_JSON",
  "MODEL_CREDIT_MARKUP_PERCENT",
  "VECTOR_ADMIN_EMAILS",
  "VECTOR_PUBLIC_URL",
  "CODIUM_TEST_CREDIT_CAP_USD",
  "MODEL_PLANS_MIN_CLIENT",
  "MODEL_PLAN_REQUIRE_MARKED_TOKENS",
  "CODIUM_TRUST_RAMP_DAYS",
  "CODIUM_RENEWAL_GRACE_MINUTES",
  "CODIUM_FUNDING_MARGIN_PERCENT",
  "CODIUM_FUNDING_MARGIN_USD",
  "RESEND_API_KEY",
  "VECTOR_PURCHASE_EMAIL_FROM",
  "CODIUM_OWNER_EMAIL",
  "VECTOR_BUG_REPORT_TO",
  ...PRICES.flatMap((price) => [`MODEL_PLAN_${price}_CREDITS_USD`, `STRIPE_MODEL_PLAN_${price}_PRICE_ID`]),
]
const original = new Map(environment.map((name) => [name, process.env[name]]))

/** A server configured for one mode: test is a preview with a test key, live is production with a restricted key. */
function configure(mode: "test" | "live") {
  environment.forEach((name) => delete process.env[name])
  Object.assign(process.env, {
    MODEL_PLANS_ENABLED: "true",
    KV_REST_API_URL: KV,
    KV_REST_API_TOKEN: "fixture-kv-token",
    STRIPE_MODEL_PLAN_WEBHOOK_SECRET: "whsec_mode_fixture",
    STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID: "bpc_mode_fixture",
    OPENROUTER_MANAGEMENT_KEY: "fixture-management-key",
    MODEL_PLAN_KEY_ENCRYPTION_SECRET: "ef".repeat(32),
    VECTOR_ADMIN_EMAILS: ` ${admin.email.toUpperCase()} , someone@example.test`,
    ...(mode === "test"
      ? { STRIPE_SECRET_KEY: "sk_test_mode_fixture", CODIUM_STRIPE_MODE: "test", VERCEL_ENV: "preview" }
      : { STRIPE_SECRET_KEY: "rk_live_mode_fixture", CODIUM_STRIPE_MODE: "live", VERCEL_ENV: "production" }),
  })
  for (const price of PRICES) {
    process.env[`MODEL_PLAN_${price}_CREDITS_USD`] = CREDITS[price]
    process.env[`STRIPE_MODEL_PLAN_${price}_PRICE_ID`] = `price_mode${price}`
  }
}

type Call = { method: string; path: string; headers: Headers; body: string }
const world = {
  store: new Map<string, string>(),
  hashes: new Map<string, Map<string, string>>(),
  commands: [] as string[][],
  stripe: [] as Call[],
  openRouter: [] as Call[],
  subscriptions: [] as Record<string, unknown>[],
  sessions: new Map<string, Record<string, unknown>>(),
  keys: new Map<string, Record<string, unknown>>(),
  charges: new Map<string, Record<string, unknown>>(),
}

beforeEach(() => {
  world.store.clear()
  world.hashes.clear()
  world.commands.length = 0
  world.stripe.length = 0
  world.openRouter.length = 0
  world.subscriptions = []
  world.sessions.clear()
  world.keys.clear()
  world.charges.clear()
  configure("test")
})
afterEach(() =>
  original.forEach((value, name) => {
    delete process.env[name]
    if (value !== undefined) process.env[name] = value
  }),
)

const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const call: Call = {
    method: init?.method ?? "GET",
    path: url.pathname,
    headers: new Headers(init?.headers),
    body: init?.body === undefined || init.body === null ? "" : String(init.body),
  }
  if (url.origin === KV) return Response.json({ result: store(JSON.parse(call.body) as unknown[]) })
  if (url.origin === "https://api.stripe.com") {
    world.stripe.push(call)
    return stripe(call, url)
  }
  if (url.origin === "https://openrouter.ai") {
    world.openRouter.push(call)
    return openRouter(call, url)
  }
  throw new Error(`Unexpected request to ${url.origin}`)
}) as typeof fetch

/** The store commands Codium sends, enough of them to run its scripts: each script is recognised by what it does. */
function store(input: unknown[]) {
  const command = input.map(String)
  world.commands.push(command)
  const [name, ...args] = command
  const hash = (key: string) => world.hashes.get(key) ?? world.hashes.set(key, new Map()).get(key)!
  if (name === "GET") return world.store.get(args[0]!) ?? null
  if (name === "SET") {
    if (args.includes("NX") && world.store.has(args[0]!)) return null
    world.store.set(args[0]!, args[1]!)
    return "OK"
  }
  if (name === "HSET") {
    hash(args[0]!).set(args[1]!, args[2]!)
    return 1
  }
  if (name === "HSCAN") return ["0", [...hash(args[0]!)].flat()]
  if (name === "ZREM") return 1
  if (name === "EVAL") {
    const [script, , key, token] = args as [string, string, string, string]
    if (script === RAMP_SCRIPTS.WRITE) {
      const version = args[3]!
      const account = args[4]!
      const previous = Number(hash(key).get(account) ?? 0)
      const value = args[6] === "raise" ? Math.max(previous, Number(args[5])) : Number(args[5])
      if (value) hash(key).set(account, String(value))
      else hash(key).delete(account)
      if (value !== previous) world.store.set(version, String(Number(world.store.get(version) ?? 0) + 1))
      return value
    }
    if (script === RAMP_SCRIPTS.READ) return [world.store.get(args[3]!) ?? "0", [...hash(key)].flat()]
    // The pool's scripts (codium-pool.ts): every hold fits, and no key here has debits (test/codium-pool.test.ts runs
    // them for real).
    // A fresh key's ledger genesis (codium-spend-ledger.ts; its Lua runs for real in model-plan-admit.test.ts and
    // codium-pool.test.ts): the account's marker turns ready. These pools hold nothing and have no debits.
    if (script === MODEL_SPEND_SCRIPTS.GENESIS) {
      world.store.set(key, world.store.get(key)!.replace('"state":"pending"', '"state":"ready"'))
      hash(args[3]!).set("genesis", args[5]!)
      return 1
    }
    if (script === MODEL_SPEND_SCRIPTS.READ) return [0, 0, 0, 0, 0, 0]
    // Status's read of today's spend (A18): nothing spent.
    if (script === MODEL_SPEND_SCRIPTS.DAY) return 0
    if (script === POOL_SCRIPTS.DEBIT) return 1
    if (script === POOL_SCRIPTS.DEBITS) return [...hash(key)].flat()
    if (script === POOL_SCRIPTS.APPLY) return 0
    // Reconcile's snapshot write (WP A05; test/codium-billing.test.ts covers it): the snapshot is all these tests see.
    if (script === SNAPSHOT_SCRIPTS.WRITE) {
      world.store.set(key, args[2 + Number(args[1])]!)
      return 1
    }
    if (script.includes("PTTL")) return world.store.get(key) === token ? 60_000 : -1
    if (script.includes("redis.call('DEL'")) {
      if (world.store.get(key) === token) world.store.delete(key)
      return 1
    }
    // The funding reservation scripts.
    if (script.includes("return reserved")) return 0
    if (script.includes("HSET")) return 1
  }
  throw new Error(`Unexpected store command ${name}`)
}

/** The store keys a command names: the first argument, or an EVAL's KEYS. */
function keysOf(command: readonly string[]) {
  const [name, ...args] = command
  return name === "EVAL" ? args.slice(2, 2 + Number(args[1])) : args.slice(0, 1)
}

function period() {
  const start = Math.floor(Date.now() / 1000) - 3600
  return { start, end: start + 30 * 86_400 }
}

function paidSubscription(user: { id: string }, price = 10) {
  const { start, end } = period()
  return {
    id: "sub_mode",
    customer: "cus_mode",
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
            id: `price_mode${price}`,
            active: true,
            currency: "usd",
            unit_amount: price * 100,
            recurring: { interval: "month", interval_count: 1 },
          },
        },
      ],
    },
    latest_invoice: {
      id: "in_mode",
      paid: true,
      status: "paid",
      amount_paid: price * 100,
      charge: {
        id: "ch_mode",
        paid: true,
        refunded: false,
        disputed: false,
        amount_refunded: 0,
        payment_method_details: { card: { three_d_secure: { result: "authenticated" } } },
      },
      lines: { data: [{ price: { id: `price_mode${price}` }, period: { start, end }, proration: false }] },
    },
  }
}

function stripe(call: Call, url: URL) {
  const route = call.path.replace(/^\/v1\//, "")
  if (call.method === "POST" && route === "customers") return Response.json({ id: "cus_mode" })
  if (call.method === "GET" && route === "invoices") return Response.json({ data: [], has_more: false })
  if (call.method === "GET" && route === "subscriptions")
    return Response.json({ data: world.subscriptions, has_more: false })
  if (call.method === "DELETE" && route.startsWith("subscriptions/")) {
    const subscription = world.subscriptions.find((value) => value.id === route.split("/")[1])
    if (subscription) subscription.status = "canceled"
    return Response.json(subscription ?? {})
  }
  if (call.method === "GET" && route.startsWith("prices/")) {
    const amount = Number(/(\d+)$/.exec(route)?.[1])
    return Response.json({
      id: route.slice("prices/".length),
      active: true,
      currency: "usd",
      unit_amount: amount * 100,
      recurring: { interval: "month", interval_count: 1 },
    })
  }
  if (route === "checkout/sessions" && call.method === "POST") {
    const id = `cs_mode${world.sessions.size + 1}`
    const body = new URLSearchParams(call.body)
    const session = {
      id,
      customer: body.get("customer"),
      status: "open",
      url: `https://checkout.stripe.com/c/pay/${id}`,
      expires_at: Number(body.get("expires_at")),
      metadata: {},
    }
    world.sessions.set(id, session)
    return Response.json(session)
  }
  if (route === "checkout/sessions")
    return Response.json({
      data: [...world.sessions.values()].filter((session) => session.status === "open"),
      has_more: false,
    })
  const session = /^checkout\/sessions\/([^/]+)(\/expire)?$/.exec(route)
  if (session) {
    const value = world.sessions.get(session[1]!)
    if (value && session[2]) value.status = "expired"
    return Response.json(value ?? {}, { status: value ? 200 : 404 })
  }
  if (call.method === "GET" && route.startsWith("charges/"))
    return Response.json(world.charges.get(route.slice("charges/".length)) ?? {})
  if (route === "billing_portal/sessions") return Response.json({ url: "https://billing.stripe.com/p/session/mode" })
  throw new Error(`Unexpected Stripe request ${call.method} ${route}${url.search}`)
}

function openRouter(call: Call, url: URL) {
  if (call.path === "/api/v1/credits") return Response.json({ data: { total_credits: 1000, total_usage: 0 } })
  if (call.path === "/api/v1/keys" && call.method === "GET")
    return Response.json({ data: url.searchParams.get("offset") === "0" ? [...world.keys.values()] : [] })
  if (call.path === "/api/v1/keys" && call.method === "POST") {
    const hash = `hash_mode${world.keys.size + 1}`
    const data = { ...(JSON.parse(call.body) as Record<string, unknown>), hash, usage: 0, disabled: false }
    world.keys.set(hash, data)
    return Response.json({ key: `fixture-openrouter-secret-${world.keys.size}`, data })
  }
  const key = world.keys.get(call.path.split("/").at(-1)!)
  if (!key) return Response.json({ error: "Unknown key" }, { status: 404 })
  if (call.method === "PATCH") Object.assign(key, JSON.parse(call.body))
  return Response.json({ data: key })
}

/** A paid month's charge as the ledger reads it, invoice and subscription expanded. */
function charge(user: { id: string }, price = 10) {
  const { start, end } = period()
  world.charges.set("ch_mode", {
    id: "ch_mode",
    customer: "cus_mode",
    paid: true,
    disputed: false,
    currency: "usd",
    amount: price * 100,
    amount_refunded: 0,
    created: start,
    balance_transaction: { currency: "usd", fee: 59, net: price * 100 - 59 },
    payment_intent: null,
    invoice: {
      subscription: { id: "sub_mode", metadata: { vector_account_id: user.id } },
      lines: { data: [{ price: { id: `price_mode${price}` }, period: { start, end } }] },
    },
  })
}

/** Sells, serves, reports, records and closes one month, touching every kind of Codium key there is so far. */
async function lifecycle(user: { id: string; email: string }) {
  await checkCodiumFunding(fetcher)
  expect((await modelPlanCheckout(user, "vector-10", fetcher)).url).toStartWith("https://checkout.stripe.com/")
  world.subscriptions = [paidSubscription(user)]
  await modelPlanCredential(user.id, fetcher, Date.now(), 0.01)
  const status = await modelPlanStatus(user.id, fetcher)
  charge(user)
  expect(await recordCodiumCharge(user.id, "ch_mode", fetcher)).toMatchObject({ charge: "ch_mode", credits: 400 })
  await cancelModelPlanAccount(user.id, fetcher)
  return status
}

/**
 * The period start of the month `lifecycle` sold, as its key's name records it. Reading `period()` again instead would
 * move on a second whenever the lifecycle crosses one.
 */
const soldStart = () =>
  (world.subscriptions[0] as ReturnType<typeof paidSubscription>).items.data[0]!.current_period_start

const kinds = (user: { id: string }) => [
  `account:${user.id}`,
  `lease:${user.id}`,
  "held:hash_mode1",
  "model-spend:hash_mode1",
  "funding",
  "funding:lock",
  "funding:reserved",
  "ledger",
]

describe("the Stripe mode guard", () => {
  test("a live key runs only in production with CODIUM_STRIPE_MODE=live; every other mix is refused", () => {
    const cases: [key: string | undefined, mode: string | undefined, vercel: string | undefined, runs: string][] = [
      ["sk_test_mode_fixture", undefined, undefined, "test"],
      ["sk_test_mode_fixture", "test", "production", "test"],
      ["rk_test_mode_fixture", "test", "preview", "test"],
      ["rk_live_mode_fixture", "live", "production", "live"],
      ["sk_live_mode_fixture", "live", "production", "live"],
      // A live key in a preview, on a laptop or in CI.
      ["rk_live_mode_fixture", "live", "preview", "refused"],
      ["rk_live_mode_fixture", "live", undefined, "refused"],
      ["rk_live_mode_fixture", "live", "development", "refused"],
      // The mode is said out loud for live, and must agree with the key.
      ["rk_live_mode_fixture", undefined, "production", "refused"],
      ["rk_live_mode_fixture", "test", "production", "refused"],
      ["sk_test_mode_fixture", "live", "production", "refused"],
      ["sk_test_mode_fixture", "staging", undefined, "refused"],
      // Only secret and restricted keys.
      ["pk_live_mode_fixture", "live", "production", "refused"],
      ["sk_mode_fixture", undefined, undefined, "refused"],
    ]
    for (const [key, mode, vercel, runs] of cases) {
      environment.forEach((name) => delete process.env[name])
      Object.assign(process.env, {
        ...(key ? { STRIPE_SECRET_KEY: key } : {}),
        ...(mode ? { CODIUM_STRIPE_MODE: mode } : {}),
        ...(vercel ? { VERCEL_ENV: vercel } : {}),
      })
      const outcome = (() => {
        try {
          return requireStripeMode()
        } catch {
          return "refused"
        }
      })()
      expect({ key, mode, vercel, outcome }).toEqual({ key, mode, vercel, outcome: runs })
      expect(stripeModeProblems().length > 0).toBe(runs === "refused")
    }
  })

  test("the store namespace follows CODIUM_STRIPE_MODE, then the key, and is test when nothing says live", () => {
    const namespace = (values: Record<string, string>) => {
      environment.forEach((name) => delete process.env[name])
      Object.assign(process.env, values)
      return stripeMode()
    }
    expect(namespace({})).toBe("test")
    expect(namespace({ STRIPE_SECRET_KEY: "rk_live_mode_fixture" })).toBe("live")
    expect(namespace({ STRIPE_SECRET_KEY: "rk_live_mode_fixture", CODIUM_STRIPE_MODE: "test" })).toBe("test")
    // Without its key, a live server still reads the live namespace, so account deletion still finds the live record.
    expect(namespace({ CODIUM_STRIPE_MODE: "live" })).toBe("live")
    expect(namespace({ STRIPE_SECRET_KEY: "sk_test_mode_fixture", CODIUM_STRIPE_MODE: "bogus" })).toBe("test")
    expect(() => requireStripeMode()).toThrow()
  })

  test("a live key in a preview is refused before any Stripe request, checkout included", async () => {
    configure("live")
    process.env.VERCEL_ENV = "preview"
    const body = new URLSearchParams({ email: buyer.email })
    await expect(
      modelPlanStripe("customers", { method: "POST", idempotency: "vector-mode-fixture", body }, fetcher),
    ).rejects.toMatchObject({ statusCode: 503, code: "MODEL_PLANS_CONFIGURATION" })
    await expect(modelPlanStripe("subscriptions", {}, fetcher)).rejects.toMatchObject({
      code: "MODEL_PLANS_CONFIGURATION",
    })
    await expect(modelPlanCheckout(buyer, "vector-10", fetcher)).rejects.toMatchObject({
      code: "MODEL_PLANS_CONFIGURATION",
    })
    expect(() => requireModelPlans()).toThrow("temporarily unavailable")
    expect(codiumBillingConfigProblems()).toContain("a live STRIPE_SECRET_KEY runs only with VERCEL_ENV=production")
    expect(world.stripe).toEqual([])
    expect(world.commands).toEqual([])
  })

  test("a snapshot or notification from the other mode is refused", () => {
    // EntitlementSnapshot carries `livemode`; the gateway reads snapshots through this check (WP A05).
    const snapshot = { v: 1, version: 1, account: buyer.id, state: "active", plan: "vector-10" }
    configure("live")
    expect(() => requireCodiumLivemode({ ...snapshot, livemode: false })).toThrow()
    expect(() => requireCodiumLivemode(snapshot)).toThrow()
    expect(() => requireCodiumLivemode({ ...snapshot, livemode: true })).not.toThrow()
    configure("test")
    expect(() => requireCodiumLivemode({ ...snapshot, livemode: true })).toThrow()
    expect(() => requireCodiumLivemode({ ...snapshot, livemode: false })).not.toThrow()

    const signed = (livemode: boolean) => {
      const raw = Buffer.from(JSON.stringify({ id: "evt_mode", type: "invoice.paid", livemode, data: { object: {} } }))
      const timestamp = Math.floor(Date.now() / 1000)
      const digest = createHmac("sha256", "whsec_mode_fixture").update(`${timestamp}.`).update(raw).digest("hex")
      return () => verifyModelPlanWebhook(raw, `t=${timestamp},v1=${digest}`)
    }
    expect(signed(false)()).toMatchObject({ livemode: false })
    expect(signed(true)).toThrow("other Stripe mode")
    configure("live")
    expect(signed(true)()).toMatchObject({ livemode: true })
    expect(signed(false)).toThrow("other Stripe mode")
  })

  test("every Stripe POST and every OpenRouter key create names an idempotency key", async () => {
    const body = new URLSearchParams({ email: buyer.email })
    await expect(modelPlanStripe("customers", { method: "POST", body }, fetcher)).rejects.toMatchObject({
      code: "BILLING_IDEMPOTENCY_REQUIRED",
    })
    await expect(
      modelPlanStripe("customers", { method: "POST", body, idempotency: "has a space" }, fetcher),
    ).rejects.toMatchObject({ code: "BILLING_IDEMPOTENCY_REQUIRED" })
    await expect(openRouterManagement("", { name: "fixture" }, fetcher, "POST")).rejects.toMatchObject({
      code: "MODEL_PLAN_IDEMPOTENCY_REQUIRED",
    })
    expect(world.stripe).toEqual([])
    expect(world.openRouter).toEqual([])
    // Reads, deletes and updates name none.
    await modelPlanStripe("subscriptions", {}, fetcher)
    await modelPlanStripe("subscriptions/sub_mode", { method: "DELETE" }, fetcher)
    expect(world.stripe.map((call) => call.headers.has("idempotency-key"))).toEqual([false, false])
  })
})

describe("test mode", () => {
  test("keeps every Codium key under the test prefix, names keys as tests and caps their limits", async () => {
    const status = await lifecycle(admin)
    const keys = world.commands.flatMap(keysOf)
    expect(keys.filter((key) => !key.startsWith("vector:codium:test:"))).toEqual([])
    for (const kind of kinds(admin)) expect(keys).toContain(`vector:codium:test:${kind}`)

    const created = world.openRouter.filter((call) => call.method === "POST")
    expect(created).toHaveLength(1)
    expect(JSON.parse(created[0]!.body)).toMatchObject({
      name: `Vector test ${admin.id} sub_mode ${soldStart()}`,
      limit: 0.5,
    })
    // Status shares are of what the capped key can spend.
    expect(status).toMatchObject({ active: true, credits: 0.5 })
    const posts = [...world.stripe, ...world.openRouter].filter((call) => call.method === "POST")
    expect(posts.length).toBeGreaterThanOrEqual(4)
    expect(posts.filter((call) => !call.headers.get("idempotency-key"))).toEqual([])
  })

  test("the cap is CODIUM_TEST_CREDIT_CAP_USD, never above the plan's credits, and checked", () => {
    expect(codiumKeyLimitUsd(4)).toBe(0.5)
    process.env.CODIUM_TEST_CREDIT_CAP_USD = "2.25"
    expect(codiumKeyLimitUsd(4)).toBe(2.25)
    process.env.CODIUM_TEST_CREDIT_CAP_USD = "200"
    expect(codiumKeyLimitUsd(4)).toBe(4)
    expect(codiumKeyLimitUsd(4, "live")).toBe(4)
    for (const value of ["0", "-1", "abc", "250", "0.125"]) {
      process.env.CODIUM_TEST_CREDIT_CAP_USD = value
      expect(() => codiumKeyLimitUsd(4)).toThrow()
      expect(codiumBillingConfigProblems()).toContain("CODIUM_TEST_CREDIT_CAP_USD is out of range")
      // Live mode never reads it.
      expect(codiumKeyLimitUsd(4, "live")).toBe(4)
      expect(codiumLimitProblems("live")).toEqual([])
    }
  })

  test("checkout is open only to VECTOR_ADMIN_EMAILS, before any store or Stripe call", async () => {
    await expect(modelPlanCheckout(buyer, "vector-10", fetcher)).rejects.toMatchObject({
      statusCode: 403,
      code: "CODIUM_TEST_CHECKOUT",
    })
    expect(world.commands).toEqual([])
    expect(world.stripe).toEqual([])
    // The allowlist ignores case and spaces; an empty one lets nobody in.
    expect(() => requireCodiumCheckoutUser({ email: "Admin@Example.Test" })).not.toThrow()
    process.env.VECTOR_ADMIN_EMAILS = ""
    expect(() => requireCodiumCheckoutUser(admin)).toThrow("only to Vector admins")
    delete process.env.VECTOR_ADMIN_EMAILS
    expect(() => requireCodiumCheckoutUser(admin)).toThrow("only to Vector admins")
    // Live checkout is open to every signed-in account.
    configure("live")
    expect(() => requireCodiumCheckoutUser(buyer)).not.toThrow()
  })

  test("the live funding check never counts a test key as owed; the test check counts both", async () => {
    const { start } = period()
    world.keys.set("live1", {
      hash: "live1",
      name: `Vector ${buyer.id} sub_live ${start}`,
      limit: 4,
      usage: 1,
      disabled: false,
      expires_at: null,
    })
    world.keys.set("test1", {
      hash: "test1",
      name: openRouterKeyName([admin.id, "sub_test", start], "test"),
      limit: 0.5,
      usage: 0,
      disabled: false,
      expires_at: null,
    })
    configure("live")
    expect(await checkCodiumFunding(fetcher)).toMatchObject({ status: "open", owed: 300, keys: 1 })
    configure("test")
    expect(await checkCodiumFunding(fetcher)).toMatchObject({ status: "open", owed: 350, keys: 2 })
    // Each mode keeps its own reading.
    expect(world.store.has("vector:codium:live:funding")).toBe(true)
    expect(world.store.has("vector:codium:test:funding")).toBe(true)
  })
})

describe("live mode", () => {
  test("keeps every Codium key under the live prefix with the plan's full credits", async () => {
    configure("live")
    await lifecycle(buyer)
    const keys = world.commands.flatMap(keysOf)
    expect(keys.filter((key) => !key.startsWith("vector:codium:live:"))).toEqual([])
    for (const kind of kinds(buyer)) expect(keys).toContain(`vector:codium:live:${kind}`)
    const created = world.openRouter.filter((call) => call.method === "POST")
    expect(JSON.parse(created[0]!.body)).toMatchObject({
      name: `Vector ${buyer.id} sub_mode ${soldStart()}`,
      limit: 4,
    })
    expect(created[0]!.headers.get("idempotency-key")).toStartWith("vector-codium-pool-v1-live-")
  })
})

describe("codiumKey", () => {
  test("prefixes the mode and refuses parts that could make two records share a key", () => {
    expect(codiumKey("account", buyer.id)).toBe(`vector:codium:test:account:${buyer.id}`)
    expect(codiumKeyIn("live", "meter", buyer.id, "sub_1:1700000000", "hosted")).toBe(
      `vector:codium:live:meter:${buyer.id}:sub_1:1700000000:hosted`,
    )
    expect(codiumKeyMode("vector:codium:live:account:x")).toBe("live")
    expect(codiumKeyMode("vector:model-plans:account:x")).toBeUndefined()
    expect(() => codiumKey()).toThrow()
    expect(() => codiumKey("account", "")).toThrow()
    expect(() => codiumKey("account", "a b")).toThrow()
    expect(() => codiumKey("account", "a\nb")).toThrow()
  })

  test("OpenRouter key names say test in test mode, and only live names count as live debts", () => {
    const live = openRouterKeyName([buyer.id, "sub_1", 1], "live")
    const test = openRouterKeyName([buyer.id, "sub_1", 1], "test")
    expect(live).toBe(`Vector ${buyer.id} sub_1 1`)
    expect(test).toBe(`Vector test ${buyer.id} sub_1 1`)
    expect(owedKeyName(live, "live")).toBe(true)
    expect(owedKeyName(test, "live")).toBe(false)
    expect(owedKeyName(`Codium ${buyer.id} purchased credits`, "live")).toBe(true)
    expect(owedKeyName(test, "test")).toBe(true)
    expect(owedKeyName(live, "test")).toBe(true)
    expect(owedKeyName("Owner laptop", "test")).toBe(false)
  })

  test("no Codium store key is spelled out anywhere but codium-keys.ts", async () => {
    const root = path.join(import.meta.dir, "..")
    // Any file: the old spellings. A Codium file: any literal store key at all, since it builds keys with codiumKey().
    const old = /["'`]vector:(?:model-plans|codium)(?=[:"'`$])/
    const literal = /["'`]vector:/
    expect(old.test("const key = `vector:model-plans:account:${id}`")).toBe(true)
    expect(old.test('const key = "vector:codium:funding"')).toBe(true)
    expect(literal.test("`vector:model-plans:held:${pool}`")).toBe(true)
    const files = Array.from(new Bun.Glob("api/**/*.ts").scanSync({ cwd: root })).filter(
      (file) => !file.endsWith(".test.ts") && file !== "api/_lib/codium-keys.ts",
    )
    expect(files.length).toBeGreaterThan(20)
    const offenders: string[] = []
    for (const file of files) {
      const codium = /^api\/(?:_lib\/(?:model-plan-|codium-)|model-plans\/)/.test(file)
      const lines = (await Bun.file(path.join(root, file)).text()).split("\n")
      lines.forEach((line, index) => {
        if (old.test(line) || (codium && literal.test(line))) offenders.push(`${file}:${index + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

describe("codiumBillingConfig", () => {
  test("passes credits at the public multiples and reports the mode, the minimum client and the token rule", () => {
    expect(codiumBillingConfigProblems()).toEqual([])
    expect(codiumBillingConfig()).toMatchObject({
      mode: "test",
      minClient: MODEL_PLANS_MIN_CLIENT_DEFAULT,
      requireMarkedTokens: true,
      testCreditCapUsd: 0.5,
    })
    expect(codiumBillingConfig().plans.map((plan) => plan.credits)).toEqual([4, 22, 48, 100])
    expect(requireModelPlans()).toMatchObject({ mode: "test" })
    configure("live")
    expect(codiumBillingConfig()).toMatchObject({ mode: "live", testCreditCapUsd: null })
  })

  test("refuses credits whose ratios drift more than 0.05 from the public usage multiples", () => {
    // Half of each price, as an old fixture had it: 5x, 10x and 20x Plus instead of 5.5x, 12x and 25x.
    for (const price of PRICES) process.env[`MODEL_PLAN_${price}_CREDITS_USD`] = String(price / 2)
    expect(codiumBillingConfigProblems()).toEqual([
      "MODEL_PLAN_50_CREDITS_USD is not 5.5x the Plus credits",
      "MODEL_PLAN_100_CREDITS_USD is not 12x the Plus credits",
      "MODEL_PLAN_200_CREDITS_USD is not 25x the Plus credits",
    ])
    expect(() => requireModelPlans()).toThrow("temporarily unavailable")
    configure("test")
    process.env.MODEL_PLAN_50_CREDITS_USD = "22.1"
    expect(codiumBillingConfigProblems()).toEqual([])
    process.env.MODEL_PLAN_50_CREDITS_USD = "22.3"
    expect(codiumBillingConfigProblems()).toEqual(["MODEL_PLAN_50_CREDITS_USD is not 5.5x the Plus credits"])
    // A markup alone scales every plan by its price, so it can never meet the multiples.
    configure("test")
    for (const price of PRICES) delete process.env[`MODEL_PLAN_${price}_CREDITS_USD`]
    process.env.MODEL_CREDIT_MARKUP_PERCENT = "100"
    expect(codiumBillingConfigProblems().length).toBeGreaterThan(0)
  })

  test("the minimum client is the env value or the compiled default, and a bad one turns Codium off", () => {
    process.env.MODEL_PLANS_MIN_CLIENT = "1.99.120"
    expect(codiumBillingConfig().minClient).toBe("1.99.120")
    for (const value of ["latest", "1.99", "v1.99.113", "1.99.113-beta"]) {
      process.env.MODEL_PLANS_MIN_CLIENT = value
      expect(codiumBillingConfigProblems()).toEqual(["MODEL_PLANS_MIN_CLIENT is not a version like 1.99.113"])
      expect(() => requireModelPlans()).toThrow("temporarily unavailable")
    }
  })

  test("marked tokens are required unless MODEL_PLAN_REQUIRE_MARKED_TOKENS is false", () => {
    expect(modelPlanRequireMarkedTokens()).toBe(true)
    for (const [value, required] of [
      ["false", false],
      [" FALSE ", false],
      ["true", true],
      ["no", true],
      ["0", true],
    ] as const) {
      process.env.MODEL_PLAN_REQUIRE_MARKED_TOKENS = value
      expect(modelPlanRequireMarkedTokens()).toBe(required)
    }
  })

  test("names each problem by env name only, never by value", () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_mode_fixture_value"
    delete process.env.OPENROUTER_MANAGEMENT_KEY
    process.env.CODIUM_RENEWAL_GRACE_MINUTES = "720"
    process.env.CODIUM_TRUST_RAMP_DAYS = "seven"
    const problems = codiumBillingConfigProblems()
    expect(problems).toEqual(
      expect.arrayContaining([
        "CODIUM_STRIPE_MODE does not match the mode of STRIPE_SECRET_KEY",
        "a live STRIPE_SECRET_KEY runs only with VERCEL_ENV=production",
        "OPENROUTER_MANAGEMENT_KEY is not set",
        "CODIUM_TRUST_RAMP_DAYS is out of range",
        "CODIUM_RENEWAL_GRACE_MINUTES is out of range",
      ]),
    )
    expect(JSON.stringify(problems)).not.toContain("fixture_value")
    expect(() => renewalGraceMinutes()).toThrow()
    configure("test")
    expect(trustRampDays()).toBe(7)
    expect(renewalGraceMinutes()).toBe(120)
    process.env.CODIUM_RENEWAL_GRACE_MINUTES = "360"
    expect(renewalGraceMinutes()).toBe(360)
  })
})
