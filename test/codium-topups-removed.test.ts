import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mintCliToken } from "../api/_lib/cli-token"
import { checkCodiumFunding } from "../api/_lib/codium-funding"
import { codiumLedger, codiumLedgerSummary, recordCodiumCharge } from "../api/_lib/codium-ledger"
import { POOL_SCRIPTS } from "../api/_lib/codium-pool"
import { MODEL_SPEND_SCRIPTS } from "../api/_lib/codium-spend-ledger"
import { RAMP_SCRIPTS } from "../api/_lib/codium-ramp"
import { SNAPSHOT_SCRIPTS } from "../api/_lib/codium-snapshot"
import {
  cancelModelPlanAccount,
  modelPlanCredential,
  readModelPlanAccount,
  reconcileModelPlanAccount,
} from "../api/_lib/model-plan-account"
import { publicModelPlans } from "../api/_lib/model-plan-config"
import { handleModelPlanStatus } from "../api/_lib/model-plan-status"
import topupRoute from "../api/model-plans/topup"
import { reconcileModelPlanEvent } from "../api/model-plans/webhook"

// Codium sells monthly plans only (contract WP A04, v3 item S). The old top-up route answers 410, status still sends
// `purchased: {bought: false}` for older clients, and an account record written while top-ups existed still decodes but
// buys nothing. Stripe, OpenRouter and the store are in-memory fakes behind the injected fetcher; nothing here reaches
// a real service.

const user = { id: "77777777-7777-4777-8777-777777777777", email: "buyer@example.test" }
const KV = "https://kv.topups-fixture.invalid"
const PRICES = [10, 50, 100, 200] as const
// Made-up credits that keep the public multiples: 22/4 = 5.5, 48/4 = 12, 100/4 = 25.
const CREDITS = { 10: "4", 50: "22", 100: "48", 200: "100" } as const
const ACCOUNT = `vector:codium:test:account:${user.id}`
const WALLET = "hash_wallet_legacy"

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
  "OPENROUTER_MANAGEMENT_KEY",
  "MODEL_PLAN_KEY_ENCRYPTION_SECRET",
  "MODEL_PLAN_MODELS_JSON",
  "MODEL_CREDIT_MARKUP_PERCENT",
  "VECTOR_ADMIN_EMAILS",
  "VECTOR_CLI_TOKEN_SECRET",
  "CODIUM_TEST_CREDIT_CAP_USD",
  "CODIUM_FUNDING_MARGIN_PERCENT",
  "CODIUM_FUNDING_MARGIN_USD",
  "RESEND_API_KEY",
  ...PRICES.flatMap((price) => [
    `MODEL_PLAN_${price}_CREDITS_USD`,
    `STRIPE_MODEL_PLAN_${price}_PRICE_ID`,
    // Removed with top-ups; set below only to show that nothing reads them any more.
    `MODEL_TOPUP_${price}_CREDITS_USD`,
    `STRIPE_MODEL_TOPUP_${price}_PRICE_ID`,
  ]),
]
const original = new Map(environment.map((name) => [name, process.env[name]]))

type Call = { method: string; path: string; search: string; body: string }
const world = {
  store: new Map<string, string>(),
  hashes: new Map<string, Map<string, string>>(),
  stripe: [] as Call[],
  openRouter: [] as Call[],
  subscriptions: [] as ReturnType<typeof paidSubscription>[],
  disputes: [] as Record<string, unknown>[],
  keys: new Map<string, Record<string, unknown>>(),
  charges: new Map<string, Record<string, unknown>>(),
}

beforeEach(() => {
  world.store.clear()
  world.hashes.clear()
  world.stripe.length = 0
  world.openRouter.length = 0
  world.subscriptions = []
  world.disputes = []
  world.keys.clear()
  world.charges.clear()
  environment.forEach((name) => delete process.env[name])
  Object.assign(process.env, {
    MODEL_PLANS_ENABLED: "true",
    KV_REST_API_URL: KV,
    KV_REST_API_TOKEN: "fixture-kv-token",
    STRIPE_SECRET_KEY: "sk_test_topups_fixture",
    CODIUM_STRIPE_MODE: "test",
    VERCEL_ENV: "preview",
    STRIPE_MODEL_PLAN_WEBHOOK_SECRET: "whsec_topups_fixture",
    STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID: "bpc_topups_fixture",
    OPENROUTER_MANAGEMENT_KEY: "fixture-management-key",
    MODEL_PLAN_KEY_ENCRYPTION_SECRET: "ab".repeat(32),
    VECTOR_ADMIN_EMAILS: user.email,
    VECTOR_CLI_TOKEN_SECRET: "fixture-cli-token-secret-that-is-long-enough",
    // These tests follow the plans' full credits; test mode would otherwise cap every key at $0.50.
    CODIUM_TEST_CREDIT_CAP_USD: "200",
  })
  for (const price of PRICES) {
    process.env[`MODEL_PLAN_${price}_CREDITS_USD`] = CREDITS[price]
    process.env[`STRIPE_MODEL_PLAN_${price}_PRICE_ID`] = `price_topups${price}`
    process.env[`MODEL_TOPUP_${price}_CREDITS_USD`] = String(price - 1)
    process.env[`STRIPE_MODEL_TOPUP_${price}_PRICE_ID`] = `price_pack${price}`
  }
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
    search: url.search,
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

/** Enough of the store for leases, the pool's scripts (recognised by identity), funding and the ledger. */
function store(input: unknown[]) {
  const [name, ...args] = input.map(String)
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
  // Status's catalog read (A18): no model is switched off.
  if (name === "SMEMBERS") return []
  if (name === "ZREM") return 1
  if (name === "EVAL") {
    const [script, , key, token] = args as [string, string, string, string]
    // A fresh key's ledger genesis (codium-spend-ledger.ts; its Lua runs for real in model-plan-admit.test.ts and
    // codium-pool.test.ts): the account's marker turns ready. These pools hold nothing and have no debits.
    if (script === MODEL_SPEND_SCRIPTS.GENESIS) {
      world.store.set(key, world.store.get(key)!.replace('"state":"pending"', '"state":"ready"'))
      hash(args[3]!).set("genesis", args[5]!)
      return 1
    }
    if (script === MODEL_SPEND_SCRIPTS.READ) return [0, 0, 0, 0, 0, 0]
    if (script === MODEL_SPEND_SCRIPTS.DAY) return 0
    if (script === POOL_SCRIPTS.DEBIT) return 1
    if (script === POOL_SCRIPTS.DEBITS) return [...hash(key)].flat()
    if (script === POOL_SCRIPTS.APPLY) return 0
    if (script === RAMP_SCRIPTS.WRITE) {
      const previous = Number(hash(key).get(args[4]!) ?? 0)
      const value = args[6] === "raise" ? Math.max(previous, Number(args[5])) : Number(args[5])
      if (value === 0) hash(key).delete(args[4]!)
      if (value !== 0) hash(key).set(args[4]!, String(value))
      if (value !== previous) world.store.set(args[3]!, String(Number(world.store.get(args[3]!) ?? 0) + 1))
      return value
    }
    if (script === RAMP_SCRIPTS.READ) return [world.store.get(args[3]!) ?? "0", [...hash(key)].flat()]
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
    if (script.includes("return reserved")) return 0
    if (script.includes("HSET")) return 1
  }
  throw new Error(`Unexpected store command ${name}`)
}

function period() {
  const start = Math.floor(Date.now() / 1000) - 3600
  return { start, end: start + 30 * 86_400 }
}

function paidSubscription(customer = "cus_legacy", price = 10) {
  const { start, end } = period()
  return {
    id: "sub_topups",
    customer,
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
            id: `price_topups${price}`,
            currency: "usd",
            unit_amount: price * 100,
            recurring: { interval: "month", interval_count: 1 },
          },
        },
      ],
    },
    latest_invoice: {
      id: "in_topups",
      paid: true,
      status: "paid",
      amount_paid: price * 100,
      charge: { id: "ch_month", paid: true, refunded: false, disputed: false, amount_refunded: 0 },
      lines: { data: [{ price: { id: `price_topups${price}` }, period: { start, end }, proration: false }] },
    },
  }
}

// Only what monthly plans need. A request for a top-up's checkout session or payment intent would throw.
function stripe(call: Call, url: URL) {
  const route = call.path.replace(/^\/v1\//, "")
  if (call.method === "GET" && route === "subscriptions")
    return Response.json({ data: world.subscriptions, has_more: false })
  if (call.method === "DELETE" && route.startsWith("subscriptions/")) {
    const subscription = world.subscriptions.find((value) => value.id === route.split("/")[1])
    if (subscription) subscription.status = "canceled"
    return Response.json(subscription ?? {})
  }
  if (call.method === "GET" && route === "disputes")
    return Response.json({
      data: world.disputes.filter((value) => value.charge === url.searchParams.get("charge")),
      has_more: false,
    })
  if (call.method === "GET" && route.startsWith("customers/"))
    return Response.json({ id: route.split("/")[1], metadata: { vector_account_id: user.id } })
  if (call.method === "GET" && route === "checkout/sessions") return Response.json({ data: [], has_more: false })
  if (call.method === "GET" && route.startsWith("charges/"))
    return Response.json(world.charges.get(route.slice("charges/".length)) ?? {})
  throw new Error(`Unexpected Stripe request ${call.method} ${route}${url.search}`)
}

function openRouter(call: Call, url: URL) {
  if (call.path === "/api/v1/credits") return Response.json({ data: { total_credits: 1000, total_usage: 0 } })
  if (call.path === "/api/v1/keys" && call.method === "GET")
    return Response.json({ data: url.searchParams.get("offset") === "0" ? [...world.keys.values()] : [] })
  if (call.path === "/api/v1/keys" && call.method === "POST") {
    const hash = `hash_topups${world.keys.size + 1}`
    const data = { ...(JSON.parse(call.body) as Record<string, unknown>), hash, usage: 0, disabled: false }
    world.keys.set(hash, data)
    return Response.json({ key: `fixture-openrouter-secret-${hash}`, data })
  }
  const key = world.keys.get(call.path.split("/").at(-1)!)
  if (!key) return Response.json({ error: "Unknown key" }, { status: 404 })
  if (call.method === "PATCH") Object.assign(key, JSON.parse(call.body))
  return Response.json({ data: key })
}

/** An account record as it was saved while top-ups were sold: a pending pack checkout, a purchase and its key. */
function seedLegacyAccount(legacy: Record<string, unknown> = {}) {
  world.store.set(
    ACCOUNT,
    JSON.stringify({
      customer: "cus_legacy",
      topupCheckout: {
        id: "cs_legacy_pack",
        plan: "codium-topup-10",
        url: "https://checkout.stripe.com/c/pay/cs_legacy_pack",
        expires: Date.now() + 3_600_000,
        reservation: "vector-topup-checkout-legacy",
      },
      purchases: [{ checkout: "cs_legacy_pack", payment: "pi_legacy", price: 10, credits: 5 }],
      wallet: { hash: WALLET, encrypted: "never-revealed" },
      ...legacy,
    }),
  )
  world.keys.set(WALLET, {
    hash: WALLET,
    name: `Vector test ${user.id} purchased credits`,
    limit: 5,
    usage: 1,
    disabled: false,
    limit_reset: null,
    include_byok_in_limit: true,
    expires_at: null,
  })
}

/** Whether any call reached the old purchased-credit key or a top-up's Stripe objects. */
function touchedTopups() {
  return [
    ...world.openRouter.filter((call) => call.path.includes(WALLET) || call.body.includes("purchased credits")),
    ...world.stripe.filter((call) => /payment_intents|checkout\/sessions\/|codium-topup/.test(call.path + call.body)),
  ]
}

describe("the old top-up route", () => {
  let server: Server
  let origin = ""
  beforeAll(async () => {
    server = createServer((request, response) => void topupRoute(request, response))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => server.close())

  test("answers JSON 410 MODEL_TOPUP_REMOVED to every caller and method, and calls nothing", async () => {
    const outbound: string[] = []
    const real = globalThis.fetch
    const token = mintCliToken(user, Date.now(), "desktop").token
    const answers = []
    try {
      globalThis.fetch = Object.assign(
        (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input instanceof Request ? input.url : input)
          if (!url.startsWith(origin)) outbound.push(url)
          return real(input, init)
        },
        { preconnect: real.preconnect },
      ) as typeof fetch
      const requests: RequestInit[] = [
        // What Vector 1.99.112 sends: the desktop's token and a pack.
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ pack: "codium-topup-10" }),
        },
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        { method: "GET" },
        { method: "PUT", body: "not json" },
      ]
      for (const request of requests) {
        const response = await fetch(`${origin}/api/model-plans/topup`, request)
        answers.push({
          status: response.status,
          type: response.headers.get("content-type"),
          cache: response.headers.get("cache-control"),
          body: await response.json(),
        })
      }
    } finally {
      globalThis.fetch = real
    }
    for (const answer of answers)
      expect(answer).toEqual({
        status: 410,
        type: "application/json; charset=utf-8",
        cache: "no-store",
        body: {
          error: {
            code: "MODEL_TOPUP_REMOVED",
            message: "Vector Codium no longer sells top-ups. Choose or change a monthly plan instead.",
          },
        },
      })
    expect(outbound).toEqual([])
    expect(world.stripe).toEqual([])
  })
})

describe("status still says nothing was bought", () => {
  let server: Server
  let origin = ""
  beforeAll(async () => {
    server = createServer((request, response) => void handleModelPlanStatus(request, response, fetcher))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => server.close())
  const status = async () =>
    (
      await fetch(`${origin}/api/model-plans/status`, {
        headers: { authorization: `Bearer ${mintCliToken(user).token}` },
      })
    ).json()

  test("every answer carries purchased {bought: false}, and old purchases give no access", async () => {
    // No Codium account yet.
    expect(await status()).toEqual({
      enabled: true,
      active: false,
      access: false,
      listed: [],
      purchased: { bought: false },
      empty: true,
      low: false,
    })
    // A record from when top-ups were sold, with a paid pack and its key, and no plan: before WP A04 this answered
    // access with a purchased state; now the pack is ignored.
    seedLegacyAccount()
    expect(await status()).toEqual({
      enabled: true,
      active: false,
      customer: true,
      access: false,
      listed: [],
      purchased: { bought: false },
      empty: true,
      low: false,
    })
    // With a paid month, access is that month alone. Status reads the plan from the snapshot (A18), which a paid
    // invoice's notification reconciles; the read above cached "no plan" for a minute.
    world.subscriptions = [paidSubscription()]
    await reconcileModelPlanAccount(user.id, fetcher)
    const active = await status()
    expect(active).toMatchObject({
      enabled: true,
      active: true,
      customer: true,
      access: true,
      plan: { id: "vector-10", name: "Plus", left: 1 },
      purchased: { bought: false },
      empty: false,
      low: false,
    })
    // Nothing of the old wallet: no purchased state (available, low or used) and no credits.
    expect(active.purchased).toEqual({ bought: false })
    expect(JSON.stringify(active)).not.toMatch(/wallet|credits|"state":"(available|low|used)"/)
    // Without Stripe configured the short answer keeps the field too.
    delete process.env.STRIPE_SECRET_KEY
    expect(await status()).toMatchObject({ active: false, purchased: { bought: false } })
    expect(touchedTopups()).toEqual([])
  })
})

describe("an account record written while top-ups were sold", () => {
  test("still decodes, with or without well-formed top-up fields, and keeps only what monthly plans use", async () => {
    seedLegacyAccount()
    expect(await readModelPlanAccount(user.id, fetcher)).toEqual({ customer: "cus_legacy" })
    seedLegacyAccount({ topupCheckout: null, purchases: "credit packs", wallet: 7 })
    expect(await readModelPlanAccount(user.id, fetcher)).toEqual({ customer: "cus_legacy" })
    // A month's key next to the old fields decodes with it.
    const { start, end } = period()
    seedLegacyAccount({
      key: { hash: "hash_month", encrypted: "x", subscription: "sub_topups", start, end, credits: 4 },
    })
    expect(await readModelPlanAccount(user.id, fetcher)).toMatchObject({
      customer: "cus_legacy",
      key: { hash: "hash_month", subscription: "sub_topups", credits: 4 },
    })
    // A record that is not an account at all still fails closed.
    world.store.set(ACCOUNT, JSON.stringify({ wallet: { hash: WALLET } }))
    await expect(readModelPlanAccount(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_ACCOUNT_INVALID" })
  })

  test("a paid pack never pays for a request; only a paid month does", async () => {
    seedLegacyAccount()
    // No plan: before WP A04 the purchased-credit key served this request.
    await expect(modelPlanCredential(user.id, fetcher, Date.now(), 0.01)).rejects.toMatchObject({
      statusCode: 402,
      code: "MODEL_PLAN_PAYMENT_REQUIRED",
    })
    expect(world.openRouter.filter((call) => call.method !== "GET")).toEqual([])

    const subscription = paidSubscription()
    world.subscriptions = [subscription]
    const credential = await modelPlanCredential(user.id, fetcher, Date.now(), 0.01)
    expect(credential.key).toBe("fixture-openrouter-secret-hash_topups2")
    expect(world.keys.get("hash_topups2")).toMatchObject({
      name: `Vector test ${user.id} sub_topups ${subscription.items.data[0]!.current_period_start}`,
      limit: 4,
    })
    // The next save leaves the old fields out and retains the paid month's trust history.
    const saved = JSON.parse(world.store.get(ACCOUNT)!) as Record<string, unknown>
    expect(Object.keys(saved).sort()).toEqual(["customer", "firstPaidAt", "key", "paidThrough"])
    expect(saved.firstPaidAt).toBe(subscription.items.data[0]!.current_period_start * 1000)
    expect(saved.paidThrough).toBe(subscription.items.data[0]!.current_period_end * 1000)
    // The old key is never read, raised, revealed or switched off, and no new purchased-credit key appears.
    expect(world.keys.get(WALLET)).toMatchObject({ limit: 5, usage: 1, disabled: false })
    expect(touchedTopups()).toEqual([])
  })

  test("reconcile, a completed one-time checkout's notification and deletion leave purchases alone", async () => {
    seedLegacyAccount()
    world.subscriptions = [paidSubscription()]
    await reconcileModelPlanAccount(user.id, fetcher)
    await reconcileModelPlanEvent(
      {
        id: "evt_pack",
        type: "checkout.session.completed",
        data: { object: { id: "cs_legacy_pack", customer: "cus_legacy", mode: "payment", status: "complete" } },
      },
      fetcher,
    )
    // One monthly key, no purchased-credit key, and the pack's checkout is never fetched.
    expect([...world.keys.keys()]).toEqual([WALLET, "hash_topups2"])
    expect(world.openRouter.filter((call) => call.method === "POST")).toHaveLength(1)
    await cancelModelPlanAccount(user.id, fetcher)
    expect(world.keys.get("hash_topups2")).toMatchObject({ disabled: true })
    expect(world.subscriptions[0]!.status).toBe("canceled")
    expect(touchedTopups()).toEqual([])
  })
})

describe("refusals offer nothing to buy", () => {
  test("a used-up month and an account with no plan say so without suggesting credits or top-ups", async () => {
    const none = await modelPlanCredential(user.id, fetcher, Date.now(), 0.01).catch((error: unknown) => error)
    expect(none).toMatchObject({
      statusCode: 402,
      code: "MODEL_PLAN_REQUIRED",
      message: "Choose a Codium plan to use this model.",
    })

    world.store.set(ACCOUNT, JSON.stringify({ customer: "cus_legacy" }))
    world.subscriptions = [paidSubscription()]
    await modelPlanCredential(user.id, fetcher)
    world.keys.get("hash_topups1")!.usage = 4
    const used = await modelPlanCredential(user.id, fetcher, Date.now(), 0.01).catch((error: unknown) => error)
    expect(used).toMatchObject({
      statusCode: 402,
      code: "MODEL_PLAN_EXHAUSTED",
      message:
        "This month's Vector Codium usage cannot cover this model's largest request right now. Wait for running requests to finish, or choose a lighter model. Your Codium usage renews each billing period.",
    })
    for (const error of [none, used]) expect(String((error as Error).message)).not.toMatch(/top-up|add credits|buy/i)
    // P1: no answer names credits or an amount.
    for (const error of [none, used]) expect(String((error as Error).message)).not.toMatch(/credit|\$|usd|cents/i)
  })

  test("a won dispute brings the same month's key back with its usage kept", async () => {
    world.store.set(ACCOUNT, JSON.stringify({ customer: "cus_legacy" }))
    const subscription = paidSubscription()
    world.subscriptions = [subscription]
    const first = await modelPlanCredential(user.id, fetcher)
    world.keys.get("hash_topups1")!.usage = 2
    subscription.latest_invoice.charge.disputed = true
    world.disputes = [{ charge: "ch_month", status: "under_review" }]
    await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_PAYMENT_REQUIRED" })
    expect(world.keys.get("hash_topups1")?.disabled).toBe(true)
    // A won dispute on another charge restores nothing.
    world.disputes = [{ charge: "ch_other", status: "won" }]
    await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_PAYMENT_REQUIRED" })
    world.disputes = [{ charge: "ch_month", status: "won" }]
    expect((await modelPlanCredential(user.id, fetcher)).key).toBe(first.key)
    expect(world.keys.get("hash_topups1")).toMatchObject({ limit: 4, usage: 2, disabled: false })
    expect(world.keys.size).toBe(1)
  })
})

describe("configuration, funding and the books know plans only", () => {
  test("the public configuration has no top-ups, whatever the old variables say", () => {
    const config = publicModelPlans()
    expect(config).not.toHaveProperty("topups")
    expect(config.plans.map((plan) => plan.id)).toEqual(["vector-10", "vector-50", "vector-100", "vector-200"])
  })

  test("funding leaves room for the largest plan, not a pack", async () => {
    // Nothing is owed: required = the largest plan's credits (the fixtures' $100) × 1.1 + $20. A $199 pack would have
    // needed $238.90.
    expect(await checkCodiumFunding(fetcher)).toMatchObject({ status: "open", owed: 0, reserved: 0, required: 13000 })
  })

  test("the ledger records plan payments only, and a line from before still counts as it was recorded", async () => {
    world.store.set(ACCOUNT, JSON.stringify({ customer: "cus_legacy" }))
    const { start, end } = period()
    world.charges.set("ch_pack", {
      id: "ch_pack",
      customer: "cus_legacy",
      paid: true,
      disputed: false,
      currency: "usd",
      amount: 1000,
      amount_refunded: 0,
      created: start,
      balance_transaction: { currency: "usd", fee: 59, net: 941 },
      payment_intent: {
        id: "pi_pack",
        metadata: { vector_product: "codium-topup", vector_account_id: user.id, vector_pack: "codium-topup-10" },
      },
      invoice: null,
    })
    expect(await recordCodiumCharge(user.id, "ch_pack", fetcher)).toBeUndefined()
    world.charges.set("ch_month", {
      id: "ch_month",
      customer: "cus_legacy",
      paid: true,
      disputed: false,
      currency: "usd",
      amount: 1000,
      amount_refunded: 0,
      created: start,
      balance_transaction: { currency: "usd", fee: 59, net: 941 },
      payment_intent: null,
      invoice: {
        subscription: { id: "sub_topups", metadata: { vector_account_id: user.id } },
        lines: { data: [{ price: { id: "price_topups10" }, period: { start, end } }] },
      },
    })
    expect(await recordCodiumCharge(user.id, "ch_month", fetcher)).toMatchObject({
      kind: "subscription",
      product: "vector-10",
      credits: 400,
    })
    // A top-up line written before WP A04, with the field only top-ups had.
    world.hashes.get("vector:codium:test:ledger")!.set(
      "ch_old_pack",
      JSON.stringify({
        charge: "ch_old_pack",
        kind: "topup",
        account: user.id,
        product: "codium-topup-10",
        created: (start - 60) * 1000,
        price: 1000,
        refunded: 0,
        disputed: false,
        stripeFee: 59,
        stripeNet: 941,
        granted: 500,
        credits: 500,
        openRouterFee: 28,
        profit: 413,
        walletUsage: 120,
        updatedAt: (start - 60) * 1000,
      }),
    )
    const entries = await codiumLedger(fetcher)
    expect(entries.map((entry) => [entry.charge, entry.kind])).toEqual([
      ["ch_month", "subscription"],
      ["ch_old_pack", "topup"],
    ])
    expect(entries[1]).not.toHaveProperty("walletUsage")
    const summary = await codiumLedgerSummary(fetcher)
    expect(summary.totals).toMatchObject({ payments: 2, price: 2000, credits: 900 })
    expect(summary.totals).not.toHaveProperty("reversedSpend")
    expect(world.stripe.some((call) => call.path.includes("payment_intents"))).toBe(false)
  })
})
