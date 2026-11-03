import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { handleFoundingMembership } from "../api/account/founding"
import { handleFoundersPage } from "../api/founders"
import { codiumKey } from "../api/_lib/codium-keys"
import {
  assignFoundingNumber,
  eraseFounding,
  FOUNDING,
  foundersBadge,
  foundersPage,
  foundersSlug,
  foundingCredits,
  foundingToken,
  foundingWindow,
  readFoundingMember,
  releaseFoundingSlot,
  reserveFoundingSlot,
  setFoundersListing,
  syncFoundersListing,
  validFoundersName,
  validFoundingToken,
} from "../api/_lib/codium-founding"
import { listedPerks } from "../api/_lib/codium-perks"
import { configuredProvisioners } from "../api/_lib/codium-provision"
import { founding as foundingProvisioner, PROVISIONERS } from "../api/_lib/codium-provisioners"
import { buildSnapshot } from "../api/_lib/codium-snapshot"
import type { ApiRequest, ApiResponse } from "../api/_lib/http"
import {
  cancelModelPlanAccount,
  modelPlanChange,
  modelPlanCheckout,
  modelPlanStatus,
  paidModelPlan,
  readModelPlanAccount,
  reconcileModelPlanAccount,
} from "../api/_lib/model-plan-account"
import {
  codiumBillingConfigProblems,
  modelPlanForPrice,
  modelPlanLegacyPrices,
  subscriptionPlanCredits,
} from "../api/_lib/model-plan-config"
import { modelPlanBalance } from "../api/_lib/model-plan-status"
import { handleModelPlanEvent, reconcileModelPlanEvent } from "../api/model-plans/webhook"
import {
  codiumFakes,
  codiumTestEnvironment,
  FIXTURE_CREDITS,
  loadStripeFixture,
  type CodiumFakes,
} from "../packages/web/test/fixture/codium-fakes"

// WP A31: founding members. The window (limit or days after sales opened), the slot a checkout reserves, the one script
// that assigns a number (M13), the +10% boost on Plus and Pro only, the price lock through legacy prices, the end on
// subscription deletion, the opt-in founders page and the `founding` provisioner. Stripe, OpenRouter and the store are
// fakes (packages/web/test/fixture/codium-fakes.ts); the scripts also run on a real Valkey when VECTOR_TEST_REDIS_URL is
// set (the CI lane).

const SUPABASE = "https://supabase.founding-fixture.invalid"
let restore = () => {}
beforeEach(() => {
  restore = codiumTestEnvironment({
    STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID: "bpc_fixture",
    VECTOR_ADMIN_EMAILS: "subscriber@example.invalid",
    CODIUM_LISTED_PERKS: undefined,
    CODIUM_FOUNDING_LIMIT: undefined,
    CODIUM_FOUNDING_DAYS: undefined,
    MODEL_PLANS_SALES_OPENED_AT: undefined,
    STRIPE_MODEL_PLAN_LEGACY_PRICES_10: undefined,
    STRIPE_MODEL_PLAN_LEGACY_PRICES_50: undefined,
    SUPABASE_URL: SUPABASE,
    SUPABASE_PUBLISHABLE_KEY: "fixture-publishable",
    SUPABASE_ANON_KEY: undefined,
  })
})
afterEach(() => restore())

const DAY = 86_400_000
const fixture = loadStripeFixture("active-paid")
const id = fixture.accountId
const user = { id, email: "subscriber@example.invalid" }
const now = fixture.now * 1000
const token = foundingToken("fixture-checkout")
const memberKey = (account: string) => codiumKey("founding", "member", account)

function seed() {
  const fakes = codiumFakes({ now })
  fakes.stripe.load(fixture.objects)
  fakes.store.set(codiumKey("account", id), JSON.stringify(fixture.account))
  return fakes
}

/** The fixture's paid Plus month, sold as a founding subscription. */
function seedFounding() {
  const fakes = seed()
  Object.assign(fakes.stripe.subscription("sub_active")!.metadata as Record<string, string>, {
    vector_founding: token,
  })
  return fakes
}

/** A customer with no subscription yet, for checkout. */
function seedCustomer() {
  const fakes = codiumFakes({ now })
  fakes.stripe.load({ customers: fixture.objects.customers })
  fakes.store.set(codiumKey("account", id), JSON.stringify(fixture.account))
  fakes.store.set(
    codiumKey("funding"),
    JSON.stringify({ status: "open", checkedAt: now, since: now, balance: 1_000_000, owed: 0, required: 0, keys: 0 }),
  )
  return fakes
}

/** A separately paid upgrade month, as subscription-mode Checkout creates it (codium-plan-change.test.ts). */
function paidUpgrade(
  fakes: CodiumFakes,
  amount: 50 | 100 | 200,
  subscriptionID: string,
  supersedes: string,
  founding: string | undefined = token,
) {
  const invoice = structuredClone(fixture.objects.invoices![0]!)
  const charge = structuredClone(fixture.objects.charges![0]!)
  const subscription = structuredClone(fakes.stripe.subscription("sub_active")!)
  const start = fixture.now
  const end = start + 30 * 86400
  const price = {
    id: `price_codium${amount}`,
    active: true,
    currency: "usd",
    unit_amount: amount * 100,
    recurring: { interval: "month", interval_count: 1 },
  }
  Object.assign(subscription, {
    id: subscriptionID,
    status: "active",
    cancel_at_period_end: false,
    current_period_start: start,
    current_period_end: end,
    latest_invoice: `in_${subscriptionID}`,
    schedule: null,
    metadata: {
      vector_account_id: id,
      vector_plan: `vector-${amount}`,
      vector_model_credits_usd: FIXTURE_CREDITS[amount],
      vector_supersedes: supersedes,
      ...(founding ? { vector_founding: founding } : {}),
    },
    items: { data: [{ id: `si_${subscriptionID}`, price, quantity: 1 }] },
  })
  Object.assign(invoice, {
    id: `in_${subscriptionID}`,
    subscription: subscriptionID,
    charge: `ch_${subscriptionID}`,
    amount_paid: amount * 100,
    lines: { data: [{ price, proration: false, period: { start, end } }] },
  })
  Object.assign(charge, {
    id: `ch_${subscriptionID}`,
    invoice: `in_${subscriptionID}`,
    amount: amount * 100,
    payment_method_details: { card: { three_d_secure: { result: "authenticated" } } },
  })
  fakes.stripe.load({ subscriptions: [subscription], invoices: [invoice], charges: [charge] })
}

async function key(fakes: CodiumFakes) {
  return (await readModelPlanAccount(id, fakes.fetcher))!.key!
}

/** A fetch that reaches the fakes, plus a website session that Supabase vouches for. */
function withSession(fakes: CodiumFakes) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin === SUPABASE) {
      const authorization = new Headers(init?.headers).get("authorization")
      if (authorization !== "Bearer browser-session") return new Response(null, { status: 401 })
      return Response.json({ id, email: user.email, email_confirmed_at: "2026-01-01T00:00:00Z" })
    }
    return fakes.fetcher(input, init)
  }) as typeof fetch
}

async function call(
  handler: (request: ApiRequest, response: ApiResponse, fetcher: typeof fetch) => Promise<void>,
  fetcher: typeof fetch,
  input: { method?: string; url?: string; headers?: Record<string, string>; body?: unknown } = {},
) {
  const headers: Record<string, string> = {}
  let body = ""
  const request = {
    method: input.method ?? "GET",
    url: input.url ?? "/",
    headers: { ...(input.body === undefined ? {} : { "content-type": "application/json" }), ...input.headers },
    socket: { remoteAddress: "203.0.113.9" },
    ...(input.body === undefined ? {} : { body: input.body }),
  } as unknown as ApiRequest
  const response = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value
    },
    end(value?: string) {
      body = String(value ?? "")
    },
  } as unknown as ApiResponse
  await handler(request, response, fetcher)
  return { status: response.statusCode, headers, body }
}

// ── M13 and the number ─────────────────────────────────────────────────────────────────────────────────────────────

describe("founding numbers (M13)", () => {
  test("parallel and replayed assignments give one number and count once", async () => {
    const fakes = codiumFakes({ now })
    const results = await Promise.all(
      Array.from({ length: 5 }, () => assignFoundingNumber("acct-a", token, "sub_a", fakes.fetcher, now)),
    )
    expect(new Set(results.map((member) => member.number))).toEqual(new Set([1]))
    expect(fakes.store.get(codiumKey("founding", "count"))).toBe("1")
    const second = await assignFoundingNumber("acct-b", foundingToken("b"), "sub_b", fakes.fetcher, now)
    expect(second.number).toBe(2)
    // A replay, even naming another token or subscription, changes nothing.
    expect(await assignFoundingNumber("acct-a", foundingToken("other"), "sub_x", fakes.fetcher, now)).toMatchObject({
      number: 1,
      token,
      subscription: "sub_a",
    })
    expect(fakes.store.get(codiumKey("founding", "count"))).toBe("2")
  })

  test("the first paid reconcile assigns the number, and two parallel invoice.paid webhooks count it once", async () => {
    const fakes = seedFounding()
    const paid = {
      id: "evt_paid",
      type: "invoice.paid",
      data: { object: { id: "in_active", customer: fixture.account.customer, charge: "ch_active" } },
    }
    await Promise.all([
      reconcileModelPlanEvent(paid, fakes.fetcher, { now }),
      reconcileModelPlanEvent({ ...paid, id: "evt_paid_again" }, fakes.fetcher, { now }),
    ])
    const snapshot = await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(snapshot.founding).toEqual({ number: 1, boost: true })
    expect(fakes.store.get(codiumKey("founding", "count"))).toBe("1")
    expect(await readFoundingMember(id, fakes.fetcher)).toMatchObject({ number: 1, token, subscription: "sub_active" })
    // The slot the checkout held is consumed by the assignment.
    expect(fakes.store.zset(codiumKey("founding", "reserved")).has(token)).toBe(false)
  })

  test("accounts whose subscriptions carry no founding token make no founding store call", async () => {
    const fakes = seed()
    const snapshot = await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(snapshot.founding).toBeUndefined()
    expect(fakes.store.commands.some((command) => command.some((part) => part.includes(":founding:")))).toBe(false)
  })
})

// ── The window and checkout ────────────────────────────────────────────────────────────────────────────────────────

describe("the founding window", () => {
  test("closes at the limit of founders plus held slots, and reopens when a slot goes back", async () => {
    process.env.CODIUM_FOUNDING_LIMIT = "2"
    const fakes = codiumFakes({ now })
    expect(await foundingWindow(fakes.fetcher, now)).toEqual({ open: true, counted: 0, reserved: 0 })
    const slot = foundingToken("slot-1")
    expect(await reserveFoundingSlot(slot, now + DAY, "acct-1", fakes.fetcher, now)).toBe(true)
    // Holding it again is idempotent and never takes a second slot.
    expect(await reserveFoundingSlot(slot, now + 2 * DAY, "acct-1", fakes.fetcher, now)).toBe(true)
    await assignFoundingNumber("acct-0", foundingToken("paid"), "sub_0", fakes.fetcher, now)
    expect((await foundingWindow(fakes.fetcher, now)).open).toBe(false)
    expect(await reserveFoundingSlot(foundingToken("slot-2"), now + DAY, "acct-2", fakes.fetcher, now)).toBe(false)
    await releaseFoundingSlot(slot, fakes.fetcher)
    expect(await foundingWindow(fakes.fetcher, now)).toMatchObject({ open: true, counted: 1, reserved: 0 })
    // An expired slot no longer counts.
    expect(await reserveFoundingSlot(slot, now + 1000, "acct-1", fakes.fetcher, now)).toBe(true)
    expect((await foundingWindow(fakes.fetcher, now + 2000)).open).toBe(true)
    expect(await reserveFoundingSlot(foundingToken("slot-3"), now + DAY, "acct-3", fakes.fetcher, now + 2000)).toBe(
      true,
    )
  })

  test("closes CODIUM_FOUNDING_DAYS after sales opened, overridable, and invalid settings close it", async () => {
    const fakes = codiumFakes({ now })
    // Before the first paid month the window has not started.
    expect((await foundingWindow(fakes.fetcher, now)).open).toBe(true)
    fakes.store.set(codiumKey("sales-opened-at"), String(now - 90 * DAY))
    expect(await foundingWindow(fakes.fetcher, now - 1)).toMatchObject({ open: true, closesAt: now })
    expect((await foundingWindow(fakes.fetcher, now)).open).toBe(false)
    expect(await reserveFoundingSlot(foundingToken("late"), now + DAY, "acct-late", fakes.fetcher, now)).toBe(false)
    process.env.CODIUM_FOUNDING_DAYS = "120"
    expect((await foundingWindow(fakes.fetcher, now)).open).toBe(true)
    process.env.MODEL_PLANS_SALES_OPENED_AT = new Date(now - 121 * DAY).toISOString()
    expect((await foundingWindow(fakes.fetcher, now)).open).toBe(false)
    process.env.MODEL_PLANS_SALES_OPENED_AT = String(now - DAY)
    expect((await foundingWindow(fakes.fetcher, now)).open).toBe(true)
    process.env.CODIUM_FOUNDING_LIMIT = "many"
    expect(await foundingWindow(fakes.fetcher, now)).toEqual({ open: false })
    expect(codiumBillingConfigProblems()).toContain("CODIUM_FOUNDING_LIMIT is out of range")
    process.env.CODIUM_FOUNDING_LIMIT = "0"
    expect((await foundingWindow(fakes.fetcher, now)).open).toBe(false)
  })

  test("founding is listed only while it is offered and its window is open", async () => {
    const fakes = codiumFakes({ now })
    expect((await listedPerks(fakes.fetcher)).has("founding")).toBe(false)
    process.env.CODIUM_LISTED_PERKS = "founding"
    expect(await listedPerks(fakes.fetcher)).toEqual(new Set(["founding"]))
    process.env.CODIUM_FOUNDING_LIMIT = "0"
    expect(await listedPerks(fakes.fetcher)).toEqual(new Set())
  })

  test("checkout holds a slot and marks the session and its subscription; expiry and replacement give it back", async () => {
    process.env.CODIUM_LISTED_PERKS = "founding"
    const fakes = seedCustomer()
    expect(await modelPlanCheckout(user, "vector-10", fakes.fetcher, now)).toEqual({
      url: "https://checkout.stripe.com/c/fixture",
    })
    const first = fakes.stripe.calls.find((entry) => entry.method === "POST" && entry.path === "checkout/sessions")!
    const marked = first.form!.get("subscription_data[metadata][vector_founding]")!
    expect(validFoundingToken(marked)).toBe(true)
    expect(first.form!.get("metadata[vector_founding]")).toBe(marked)
    // The base credits are what was sold; the boost is derived from the token, never sent as an amount.
    expect(first.form!.get("subscription_data[metadata][vector_model_credits_usd]")).toBe(FIXTURE_CREDITS[10])
    expect([...fakes.store.zset(codiumKey("founding", "reserved")).keys()]).toEqual([marked])
    // The sale is reserved against funding with the boost (4 credits → 4.40).
    expect([...fakes.store.hash(codiumKey("funding", "reserved")).values()][0]).toEndWith(":440")
    expect((await readModelPlanAccount(id, fakes.fetcher))!.checkout!.founding).toBe(marked)

    // A different plan replaces the open checkout: its slot goes back before the new one is held.
    await modelPlanCheckout(user, "vector-50", fakes.fetcher, now)
    const sessions = fakes.stripe.calls.filter((entry) => entry.method === "POST" && entry.path === "checkout/sessions")
    expect(sessions).toHaveLength(2)
    const replacement = sessions[1]!.form!.get("subscription_data[metadata][vector_founding]")!
    expect(replacement).not.toBe(marked)
    expect([...fakes.store.zset(codiumKey("founding", "reserved")).keys()]).toEqual([replacement])

    // checkout.session.expired, read again from Stripe, releases the slot.
    const session = [...fakes.stripe.objects.checkout_sessions.values()].at(-1)!
    session.status = "expired"
    await handleModelPlanEvent(
      {
        id: "evt_expired",
        type: "checkout.session.expired",
        data: { object: { id: session.id, customer: fixture.account.customer } },
      },
      { fetcher: fakes.fetcher, now },
    )
    expect(fakes.store.zset(codiumKey("founding", "reserved")).size).toBe(0)
  })

  test("a closed window sells no founding membership, and a former founder never gets a second slot", async () => {
    process.env.CODIUM_LISTED_PERKS = "founding"
    process.env.CODIUM_FOUNDING_LIMIT = "0"
    const fakes = seedCustomer()
    await modelPlanCheckout(user, "vector-10", fakes.fetcher, now)
    const checkout = fakes.stripe.calls.find((entry) => entry.method === "POST" && entry.path === "checkout/sessions")!
    expect(checkout.form!.has("subscription_data[metadata][vector_founding]")).toBe(false)
    expect([...fakes.store.hash(codiumKey("funding", "reserved")).values()][0]).toEndWith(":400")

    // An ended membership keeps its record, so the slot script refuses that account even with the window open.
    delete process.env.CODIUM_FOUNDING_LIMIT
    await assignFoundingNumber(id, token, "sub_old", fakes.fetcher, now)
    fakes.store.hash(memberKey(id)).set("ended", String(now))
    expect(await reserveFoundingSlot(foundingToken("again"), now + DAY, id, fakes.fetcher, now)).toBe(false)
  })
})

// ── The boost, the lock and the end ────────────────────────────────────────────────────────────────────────────────

describe("what a founding member keeps", () => {
  test("+10% on Plus and Pro only, through the subscription's credits", () => {
    expect(foundingCredits(4, "vector-10", token)).toBe(4.4)
    expect(foundingCredits(22, "vector-50", token)).toBe(24.2)
    expect(foundingCredits(48, "vector-100", token)).toBe(48)
    expect(foundingCredits(100, "vector-200", token)).toBe(100)
    expect(foundingCredits(4, "vector-10", undefined)).toBe(4)
    expect(foundingCredits(4, "vector-10", "f_forged")).toBe(4)
    const plus = { id: "vector-10", credits: 4 }
    expect(subscriptionPlanCredits({ vector_plan: "vector-10", vector_founding: token }, plus)).toBe(4.4)
    // A downgrade by schedule keeps the subscription's token: Pro → Plus still boosts on the new plan's credits.
    expect(subscriptionPlanCredits({ vector_plan: "vector-50", vector_founding: token }, plus)).toBe(4.4)
  })

  test("a founding Plus month's key holds the boost, and the status shows the number but not the boost", async () => {
    const fakes = seedFounding()
    const snapshot = await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const current = await key(fakes)
    expect(current.creditsMicro).toBe(4_400_000)
    expect(fakes.openRouter.keys.get(current.hash)!.limit).toBe(4.4)
    const body = modelPlanBalance(await modelPlanStatus(id, fakes.fetcher, now, snapshot), { now })
    expect(body).toMatchObject({ founding: { number: 1 } })
    expect(JSON.stringify(body)).not.toContain("boost")
  })

  test("the boost follows Plus ↔ Pro; an upgrade to Max keeps the number and lock but not the boost", async () => {
    const fakes = seedFounding()
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    fakes.store.set(
      codiumKey("funding"),
      JSON.stringify({ status: "open", checkedAt: now, since: now, balance: 1_000_000, owed: 0, required: 0, keys: 0 }),
    )
    // The server copies the token onto the upgrade checkout, and reserves the boosted sale.
    await modelPlanChange(user, "vector-50", fakes.fetcher, now)
    const upgrade = fakes.stripe.calls.find((entry) => entry.method === "POST" && entry.path === "checkout/sessions")!
    expect(upgrade.form!.get("subscription_data[metadata][vector_founding]")).toBe(token)
    expect(upgrade.form!.get("subscription_data[metadata][vector_supersedes]")).toBe("sub_active")
    expect([...fakes.store.hash(codiumKey("funding", "reserved")).values()][0]).toEndWith(":2420")

    paidUpgrade(fakes, 50, "sub_pro", "sub_active")
    const pro = await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(pro.plan).toBe("vector-50")
    expect(pro.founding).toEqual({ number: 1, boost: true })
    expect((await key(fakes)).fullCreditsMicro).toBe(24_200_000)
    expect(await readFoundingMember(id, fakes.fetcher)).toMatchObject({ number: 1, subscription: "sub_pro" })
    // The superseded subscription was cancelled; its deletion does not end a membership the upgrade carries.
    expect(fakes.stripe.subscription("sub_active")!.status).toBe("canceled")
    expect((await reconcileModelPlanAccount(id, fakes.fetcher, now)).founding).toEqual({ number: 1, boost: true })

    paidUpgrade(fakes, 100, "sub_max", "sub_pro")
    const max = await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(max.plan).toBe("vector-100")
    expect(max.founding).toEqual({ number: 1, boost: false })
    expect((await key(fakes)).fullCreditsMicro).toBe(48_000_000)
    expect(await readFoundingMember(id, fakes.fetcher)).toMatchObject({ subscription: "sub_max" })
    expect(fakes.store.get(codiumKey("founding", "count"))).toBe("1")
  })

  test("a legacy price is accepted at exactly its legacy amount, and nowhere else", () => {
    process.env.STRIPE_MODEL_PLAN_LEGACY_PRICES_10 = "price_legacy10:800"
    expect(modelPlanLegacyPrices()["vector-10"]).toEqual([{ priceID: "price_legacy10", cents: 800 }])
    expect(modelPlanForPrice("price_legacy10")).toMatchObject({ id: "vector-10", cents: 800, legacy: true })
    expect(modelPlanForPrice("price_codium10")).toMatchObject({ id: "vector-10", cents: 1000, legacy: false })
    expect(modelPlanForPrice("price_other")).toBeUndefined()

    const legacy = (amount: number, paid = amount) => {
      const subscription = structuredClone(fixture.objects.subscriptions![0]!) as Record<string, any>
      const invoice = structuredClone(fixture.objects.invoices![0]!) as Record<string, any>
      const charge = structuredClone(fixture.objects.charges![0]!) as Record<string, any>
      const price = { ...subscription.items.data[0].price, id: "price_legacy10", unit_amount: amount }
      subscription.items.data[0].price = price
      subscription.metadata.vector_founding = token
      invoice.lines.data[0].price = price
      Object.assign(invoice, { amount_paid: paid, charge: { ...charge, amount: paid } })
      return { ...subscription, latest_invoice: invoice }
    }
    expect(paidModelPlan(legacy(800), id, now)).toMatchObject({
      plan: { id: "vector-10", credits: 4.4 },
      legacy: true,
      founding: token,
    })
    // The legacy price at the current amount, or paid short, is not that plan.
    expect(paidModelPlan(legacy(1000), id, now)).toBeUndefined()
    expect(paidModelPlan(legacy(800, 700), id, now)).toBeUndefined()
    delete process.env.STRIPE_MODEL_PLAN_LEGACY_PRICES_10
    expect(paidModelPlan(legacy(800), id, now)).toBeUndefined()

    process.env.STRIPE_MODEL_PLAN_LEGACY_PRICES_10 = "price_legacy10=800"
    expect(codiumBillingConfigProblems()).toContain(
      "STRIPE_MODEL_PLAN_LEGACY_PRICES_10 is not a list of price_id:cents",
    )
    process.env.STRIPE_MODEL_PLAN_LEGACY_PRICES_10 = "price_codium50:5000"
    expect(codiumBillingConfigProblems()).toContain(
      "STRIPE_MODEL_PLAN_LEGACY_PRICES_10 repeats a price id that is already configured",
    )
  })

  test("a subscription on its legacy price stays active after the plan's price id moves on", async () => {
    const fakes = seedFounding()
    process.env.STRIPE_MODEL_PLAN_10_PRICE_ID = "price_codium10v2"
    expect((await reconcileModelPlanAccount(id, fakes.fetcher, now)).state).not.toBe("active")
    process.env.STRIPE_MODEL_PLAN_LEGACY_PRICES_10 = "price_codium10:1000"
    const snapshot = await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(snapshot).toMatchObject({ state: "active", plan: "vector-10", founding: { number: 1, boost: true } })
  })

  test("deleting the subscription ends it for good", async () => {
    const fakes = seedFounding()
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    await setFoundersListing(id, { listed: true, name: "Ada" }, false, fakes.fetcher)
    fakes.stripe.subscription("sub_active")!.status = "canceled"
    const ended = await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(ended.state).toBe("ended")
    expect(ended.founding).toBeUndefined()
    expect(await readFoundingMember(id, fakes.fetcher)).toMatchObject({ number: 1, ended: now })
    expect(fakes.store.zset(codiumKey("founding", "listed")).has(id)).toBe(false)
    expect(fakes.store.hash(codiumKey("founding", "names")).has(id)).toBe(false)
    // Nothing brings it back, and the count stays.
    expect((await reconcileModelPlanAccount(id, fakes.fetcher, now)).founding).toBeUndefined()
    expect(await setFoundersListing(id, { listed: true }, false, fakes.fetcher)).toBe(false)
    expect(fakes.store.get(codiumKey("founding", "count"))).toBe("1")
  })

  test("a scheduled cancellation that is resumed keeps it, and so does a failed payment", async () => {
    const fakes = seedFounding()
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const subscription = fakes.stripe.subscription("sub_active")!
    subscription.cancel_at_period_end = true
    expect((await reconcileModelPlanAccount(id, fakes.fetcher, now)).founding).toEqual({ number: 1, boost: true })
    subscription.cancel_at_period_end = false
    expect((await reconcileModelPlanAccount(id, fakes.fetcher, now)).founding).toEqual({ number: 1, boost: true })
    subscription.status = "past_due"
    const paused = await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(paused.state).toBe("paused")
    expect(paused.founding?.number).toBe(1)
    expect((await readFoundingMember(id, fakes.fetcher))!.ended).toBeUndefined()
  })
})

// ── The founders page and the provisioner ──────────────────────────────────────────────────────────────────────────

describe("the founders page", () => {
  test("opt-in only, behind the slug until 30 founders are listed, then public", async () => {
    const fakes = codiumFakes({ now })
    expect(await setFoundersListing("not-a-member", { listed: true }, false, fakes.fetcher)).toBe(false)
    await assignFoundingNumber("acct-1", foundingToken("1"), "sub_1", fakes.fetcher, now)
    await assignFoundingNumber("acct-2", foundingToken("2"), "sub_2", fakes.fetcher, now)
    expect(await setFoundersListing("acct-1", { listed: true, name: "Ada L." }, false, fakes.fetcher)).toBe(true)
    // Not listed: never shown. Listed while frozen: hidden.
    expect(await setFoundersListing("acct-2", { listed: true }, true, fakes.fetcher)).toBe(true)
    const slug = await foundersSlug(fakes.fetcher)
    expect(await foundersSlug(fakes.fetcher)).toBe(slug)
    await expect(foundersPage(undefined, fakes.fetcher)).rejects.toMatchObject({ code: "FOUNDERS_NOT_PUBLIC" })
    await expect(foundersPage("wrong-slug-wrong-slug0", fakes.fetcher)).rejects.toMatchObject({ statusCode: 404 })
    expect(await foundersPage(slug, fakes.fetcher)).toEqual({
      public: false,
      founders: [{ number: 1, name: "Ada L." }],
    })
    expect(await syncFoundersListing("acct-2", false, fakes.fetcher)).toBe(true)
    for (let index = 3; index <= FOUNDING.publicAfter; index++) {
      await assignFoundingNumber(`acct-${index}`, foundingToken(String(index)), `sub_${index}`, fakes.fetcher, now)
      await setFoundersListing(`acct-${index}`, { listed: true }, false, fakes.fetcher)
    }
    const open = await foundersPage(undefined, fakes.fetcher)
    expect(open.public).toBe(true)
    expect(open.founders).toHaveLength(FOUNDING.publicAfter)
    expect(open.founders.slice(0, 2)).toEqual([{ number: 1, name: "Ada L." }, { number: 2 }])
    // Unlisting removes the entry and the name.
    await setFoundersListing("acct-1", { listed: false, name: "Ada L." }, false, fakes.fetcher)
    expect(fakes.store.hash(codiumKey("founding", "names")).has("acct-1")).toBe(false)
    expect((await foundersPage(slug, fakes.fetcher)).founders[0]).toEqual({ number: 2 })
  })

  test("names are short and plain, and badges escape whatever they print", async () => {
    for (const name of ["Ada", "Grace Hopper", "Jean-Luc O'Neil", "李雷", "a".repeat(40)])
      expect(validFoundersName(name)).toBe(true)
    for (const name of ["", " Ada", "Ada ", "a".repeat(41), "<b>", "x@y.z", "https://x", "two  spaces", 12])
      expect(validFoundersName(name)).toBe(false)
    const fakes = codiumFakes({ now })
    await assignFoundingNumber("acct-1", foundingToken("1"), "sub_1", fakes.fetcher, now)
    await expect(
      setFoundersListing("acct-1", { listed: true, name: "<script>" }, false, fakes.fetcher),
    ).rejects.toMatchObject({
      code: "FOUNDERS_NAME_INVALID",
    })
    const badge = foundersBadge({ number: 7, name: '<x> & "y"' })
    expect(badge).toStartWith("<svg")
    expect(badge).toContain("Founding member #7")
    expect(badge).not.toContain("<x>")
    expect(badge).toContain("&#60;x&#62; &#38; &#34;y&#34;")
  })

  test("routes: a founder reads and sets the choice; the page and badge answer only with the slug while private", async () => {
    const fakes = seedFounding()
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const fetcher = withSession(fakes)
    const session = { authorization: "Bearer browser-session" }
    expect((await call(handleFoundingMembership, fetcher)).status).toBe(401)
    const before = await call(handleFoundingMembership, fetcher, { headers: session })
    const view = JSON.parse(before.body)
    expect(view).toMatchObject({ member: true, number: 1, listed: false })
    expect(view.page).toMatch(/^https:\/\/vectordev\.ai\/founders#[A-Za-z0-9_-]{22}$/)
    const slug = String(view.page).split("#")[1]!
    const bad = await call(handleFoundingMembership, fetcher, {
      method: "POST",
      headers: session,
      body: { listed: "yes" },
    })
    expect(bad.status).toBe(400)
    const chosen = await call(handleFoundingMembership, fetcher, {
      method: "POST",
      headers: session,
      body: { listed: true, name: "Ada" },
    })
    expect(JSON.parse(chosen.body)).toMatchObject({ member: true, listed: true, name: "Ada" })

    expect((await call(handleFoundersPage, fetcher)).status).toBe(404)
    const page = await call(handleFoundersPage, fetcher, { headers: { "x-vector-founders": slug } })
    expect(page.status).toBe(200)
    expect(page.headers["cache-control"]).toBe("no-store")
    expect(JSON.parse(page.body)).toEqual({ public: false, founders: [{ number: 1, name: "Ada" }] })
    expect(page.body).not.toContain(id)
    const badge = await call(handleFoundersPage, fetcher, { url: `/api/founders?badge=1&slug=${slug}` })
    expect(badge.status).toBe(200)
    expect(badge.headers["content-type"]).toBe("image/svg+xml; charset=utf-8")
    expect(badge.headers["x-content-type-options"]).toBe("nosniff")
    expect(badge.body).toContain("Founding member #1")
    expect((await call(handleFoundersPage, fetcher, { url: `/api/founders?badge=2&slug=${slug}` })).status).toBe(404)

    // An account that is not a founding member can choose nothing.
    fakes.store.remove(memberKey(id))
    expect(JSON.parse((await call(handleFoundingMembership, fetcher, { headers: session })).body)).toEqual({
      member: false,
    })
    const refused = await call(handleFoundingMembership, fetcher, {
      method: "POST",
      headers: session,
      body: { listed: true },
    })
    expect(refused.status).toBe(404)
  })

  test("the provisioner runs while founding is offered: frozen hides, recovery shows, deletion erases", async () => {
    expect(PROVISIONERS).toContain(foundingProvisioner)
    expect(foundingProvisioner.configured()).toBe(false)
    expect(configuredProvisioners()).not.toContain("founding")
    process.env.CODIUM_LISTED_PERKS = "remote, founding"
    expect(foundingProvisioner.configured()).toBe(true)
    expect(configuredProvisioners()).toContain("founding")

    const fakes = codiumFakes({ now })
    await assignFoundingNumber("acct-1", token, "sub_1", fakes.fetcher, now)
    await setFoundersListing("acct-1", { listed: true, name: "Ada" }, false, fakes.fetcher)
    const facts = {
      account: "acct-1",
      state: "active" as const,
      plan: "vector-10" as const,
      subscription: "sub_1",
      periodStart: now - DAY,
      periodEnd: now + 29 * DAY,
      cancelAtPeriodEnd: false,
      founding: { number: 1, boost: true },
      source: "webhook" as const,
    }
    const active = buildSnapshot(facts, undefined, now)
    const frozen = buildSnapshot({ ...facts, state: "frozen", reason: "disputed" }, active, now)
    const listed = () => fakes.store.zset(codiumKey("founding", "listed")).has("acct-1")
    await foundingProvisioner.apply({ account: "acct-1", from: active, to: frozen, cause: "disputed" }, fakes.fetcher)
    expect(listed()).toBe(false)
    await foundingProvisioner.apply(
      { account: "acct-1", from: frozen, to: active, cause: "dispute_won" },
      fakes.fetcher,
    )
    expect(listed()).toBe(true)
    const closing = buildSnapshot({ ...facts, state: "ended", reason: "closing" }, active, now)
    await foundingProvisioner.apply({ account: "acct-1", from: active, to: closing, cause: "closing" }, fakes.fetcher)
    expect(listed()).toBe(false)
    expect(await readFoundingMember("acct-1", fakes.fetcher)).toBeUndefined()
    expect(fakes.store.hash(codiumKey("founding", "names")).has("acct-1")).toBe(false)
  })

  test("account deletion erases the founding record, the page entry and the name (P5)", async () => {
    const fakes = seedFounding()
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    await setFoundersListing(id, { listed: true, name: "Ada" }, false, fakes.fetcher)
    await cancelModelPlanAccount(id, fakes.fetcher)
    expect(await readFoundingMember(id, fakes.fetcher)).toBeUndefined()
    expect(fakes.store.zset(codiumKey("founding", "listed")).has(id)).toBe(false)
    expect(fakes.store.hash(codiumKey("founding", "names")).has(id)).toBe(false)
    // eraseFounding is idempotent.
    await eraseFounding(id, fakes.fetcher)
  })
})

// ── The scripts on Valkey (CI) ─────────────────────────────────────────────────────────────────────────────────────

const valkeyURL = process.env.VECTOR_TEST_REDIS_URL

describe.skipIf(!valkeyURL)("the founding scripts on Valkey", () => {
  const client = valkeyURL ? new RedisClient(valkeyURL) : undefined
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body)) as (string | number)[]
    return Response.json({ result: (await client!.send(String(command[0]), command.slice(1).map(String))) ?? null })
  }) as typeof fetch
  beforeEach(async () => {
    await client!.send("FLUSHDB", [])
  })

  test("M13: parallel assignments, the window, slots and the end", async () => {
    process.env.CODIUM_FOUNDING_LIMIT = "3"
    const at = Date.now()
    const slot = foundingToken("valkey-slot")
    expect(await reserveFoundingSlot(slot, at + DAY, "valkey-1", fetcher, at)).toBe(true)
    const results = await Promise.all(
      Array.from({ length: 8 }, () => assignFoundingNumber("valkey-1", slot, "sub_v1", fetcher, at)),
    )
    expect(new Set(results.map((member) => member.number))).toEqual(new Set([1]))
    expect(await client!.send("GET", [codiumKey("founding", "count")])).toBe("1")
    expect(await client!.send("ZCARD", [codiumKey("founding", "reserved")])).toBe(0)
    expect(await foundingWindow(fetcher, at)).toMatchObject({ open: true, counted: 1, reserved: 0 })
    expect(await reserveFoundingSlot(foundingToken("v2"), at + DAY, "valkey-2", fetcher, at)).toBe(true)
    expect(await reserveFoundingSlot(foundingToken("v3"), at + DAY, "valkey-3", fetcher, at)).toBe(true)
    expect(await reserveFoundingSlot(foundingToken("v4"), at + DAY, "valkey-4", fetcher, at)).toBe(false)
    expect(await reserveFoundingSlot(foundingToken("v5"), at + DAY, "valkey-1", fetcher, at)).toBe(false)
    await client!.send("SET", [codiumKey("sales-opened-at"), String(at - 90 * DAY)])
    expect((await foundingWindow(fetcher, at)).open).toBe(false)

    expect(await setFoundersListing("valkey-1", { listed: true, name: "Ada" }, false, fetcher)).toBe(true)
    const slugged = await foundersSlug(fetcher)
    expect(await foundersPage(slugged, fetcher)).toEqual({ public: false, founders: [{ number: 1, name: "Ada" }] })
    expect(await syncFoundersListing("valkey-1", true, fetcher)).toBe(false)
    expect((await foundersPage(slugged, fetcher)).founders).toEqual([])
    expect(await syncFoundersListing("valkey-1", false, fetcher)).toBe(true)
    const subscriptions = [{ id: "sub_v1", status: "canceled", token: slot }]
    const { settleFounding } = await import("../api/_lib/codium-founding")
    expect(await settleFounding({ account: "valkey-1", subscriptions, now: at }, fetcher)).toBeUndefined()
    expect(await readFoundingMember("valkey-1", fetcher)).toMatchObject({ number: 1, ended: at })
    expect((await foundersPage(slugged, fetcher)).founders).toEqual([])
    await eraseFounding("valkey-1", fetcher)
    expect(await readFoundingMember("valkey-1", fetcher)).toBeUndefined()
    delete process.env.CODIUM_FOUNDING_LIMIT
  })
})
