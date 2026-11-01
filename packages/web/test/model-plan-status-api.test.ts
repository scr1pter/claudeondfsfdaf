import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mintCliToken } from "../../../api/_lib/cli-token"
import { codiumKey } from "../../../api/_lib/codium-keys"
import { SWITCH_CACHE_MS } from "../../../api/_lib/codium-switches"
import { buildSnapshot, statusCacheKey } from "../../../api/_lib/codium-snapshot"
import {
  holdPool,
  keyExpiresAt,
  protectModelPlanKey,
  readModelPlanAccount,
  reconcileModelPlanAccount,
} from "../../../api/_lib/model-plan-account"
import {
  createStatusMeterRegistry,
  forecastDate,
  handleModelPlanStatus,
  METER_TIMEOUT_MS,
  STATUS_CACHE_MS,
  type ModelPlanStatusOptions,
} from "../../../api/_lib/model-plan-status"
import { codiumBillingConfigProblems, type ModelPlanModel } from "../../../api/_lib/model-plan-config"
import { publicEntitlements } from "../../../packages/schema/src/codium-entitlements"
import type { CodiumPlan } from "../../../packages/schema/src/codium-plan"
import configHandler from "../../../api/model-plans/config"
import { readModelPlanStatus } from "../src/lib/model-plans"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { ModelPlanStatus1_99_111 } from "../../core/test/fixture/model-plan-status-1.99.111"
import { ModelPlanStatus1_99_112 } from "../../core/test/fixture/model-plan-status-1.99.112"
import { codiumFakes, codiumTestEnvironment, loadStripeFixture, type StripeFixture } from "./fixture/codium-fakes"

// The status Vector's screens read (§4.11): shares of the month, public caps and timestamps only (P1), from the
// entitlement snapshot rather than Stripe (M4), cached 30 s per snapshot version. Stripe, OpenRouter and the store are
// the in-memory fakes of fixture/codium-fakes.ts; nothing here reaches a real service.
const SECRET = "fixture-cli-token-secret-that-is-long-enough"
const MINUTE = 60_000
const DAY = 86_400_000
const SEEDED = "fixture_key_seeded"
// The served catalog these cases inject (production serves nothing until a route is accepted): every active model,
// with a fixed one-attempt reservation of 0.1 USD of allowance.
const served: ModelPlanStatusOptions = {
  qualify: () => true,
  reservation: (_model: ModelPlanModel, plan?: CodiumPlan.PlanId) => {
    const attempts = plan === "vector-100" || plan === "vector-200" ? 2 : 1
    return { attemptMicro: 100_000, attempts, requiredMicro: 100_000 * attempts }
  },
}

const current: { fetcher: typeof fetch; options: ModelPlanStatusOptions } = { fetcher: fetch, options: {} }
const server = createServer(
  (request, response) => void handleModelPlanStatus(request, response, current.fetcher, current.options),
)
const origin = { url: "" }
let restore = () => {}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
beforeEach(() => {
  restore = codiumTestEnvironment({
    VECTOR_CLI_TOKEN_SECRET: SECRET,
    SUPABASE_URL: "https://auth.fixture.invalid",
    SUPABASE_PUBLISHABLE_KEY: "fixture-publishable",
  })
  current.options = served
})
afterEach(() => {
  restore()
  setSystemTime()
})
afterAll(() => server.close())

// H7: the status decoders Vector 1.99.111 and 1.99.112 shipped, run over this handler's real answers.
const released = async (token: string) => {
  const send = (_url: string, init: RequestInit) => fetch(`${origin.url}/api/model-plans/status`, init)
  return Promise.all(
    [ModelPlanStatus1_99_111, ModelPlanStatus1_99_112].map((decoder) => decoder.fetchStatus(token, send)),
  )
}

const read = async (token: string) => {
  const response = await fetch(`${origin.url}/api/model-plans/status`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return { status: response.status, headers: response.headers, body: await response.json() }
}

/**
 * A fixture's Stripe objects (first changed by `prepare`), its account record and, when it has one, the key Codium made
 * for its period (usage `usage`), on fakes whose clock and the system time both stand at the fixture's moment. Then one
 * reconcile writes the snapshot, as the webhook would, and the calls it made are forgotten.
 */
async function seed(
  name: string,
  options: { usage?: number; at?: number; prepare?: (fixture: StripeFixture) => void } = {},
) {
  const fixture = loadStripeFixture(name)
  options.prepare?.(fixture)
  const now = options.at ?? fixture.now * 1000
  setSystemTime(new Date(now))
  const fakes = codiumFakes({ now })
  fakes.stripe.load(fixture.objects)
  const id = fixture.accountId
  const record: Record<string, unknown> = { ...fixture.account }
  if (fixture.key) {
    const { subscription, start, end } = fixture.key
    const owner = fixture.objects.subscriptions?.find((value) => value.id === subscription)
    const credits = Number((owner?.metadata as Record<string, string>).vector_model_credits_usd)
    Object.assign(record, {
      firstPaidAt: start * 1000,
      firstHighPaidAt: start * 1000,
      paidThrough: end * 1000,
      highValueVerified: true,
    })
    fakes.openRouter.seed(SEEDED, {
      name: `Vector test ${id} ${subscription} ${start}`,
      limit: credits,
      usage: options.usage ?? 0,
      expires_at: keyExpiresAt(end),
    })
    record.key = {
      hash: SEEDED,
      encrypted: protectModelPlanKey("seeded-secret", `${id}:${subscription}:${start}`),
      subscription,
      start,
      end,
      credits,
      creditsMicro: credits * 1_000_000,
      limitMicro: credits * 1_000_000,
      spendGenesis: fakes.store.seedSpendGenesis({ account: id, pool: SEEDED, subscription, start, end }),
    }
  }
  fakes.store.set(codiumKey("account", id), JSON.stringify(record))
  fakes.store.set(
    codiumKey("funding"),
    JSON.stringify({
      status: "open",
      checkedAt: now,
      since: now,
      balance: 1e6,
      owed: 0,
      reserved: 0,
      required: 0,
      keys: 0,
    }),
  )
  await reconcileModelPlanAccount(id, fakes.fetcher, now)
  fakes.stripe.calls.length = 0
  fakes.openRouter.calls.length = 0
  current.fetcher = fakes.fetcher
  const pool = (await readModelPlanAccount(id, fakes.fetcher))?.key?.hash
  return { fixture, fakes, id, pool, token: mintCliToken({ id, email: "fixture@example.test" }, now, "desktop").token }
}

/**
 * P1: no amount in the answer. Every number is a share in 0..1, a timestamp, or one of the plan's public caps (the
 * `entitlements` block, which must be exactly `publicEntitlements` for its plan and the listed perks).
 */
function noAmounts(body: Record<string, unknown>, plan?: CodiumPlan.PlanId) {
  expect(JSON.stringify(body)).not.toMatch(/\$|usd|credit|cents/i)
  const { entitlements, ...rest } = body
  expect(entitlements).toEqual(plan ? publicEntitlements(plan, new Set()) : undefined)
  const walk = (value: unknown, key: string) => {
    if (typeof value === "number") {
      if (["renewsAt", "resetsAt", "until", "at"].includes(key)) expect(value).toBeGreaterThan(1_700_000_000_000)
      else expect(value >= 0 && value <= 1).toBe(true)
    } else if (Array.isArray(value)) value.forEach((item) => walk(item, key))
    else if (value && typeof value === "object") Object.entries(value).forEach(([name, item]) => walk(item, name))
  }
  walk(rest, "")
}

describe("an account without Codium", () => {
  // No Codium record: one store read, no snapshot, no reconcile, no Stripe.
  const state = { revoked: false, calls: [] as string[] }
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    state.calls.push(url)
    if (url === process.env.KV_REST_API_URL) {
      const command = JSON.parse(String(init?.body)) as string[]
      if (command[0] !== "GET") throw new Error(`Unexpected store command ${command[0]}`)
      return Response.json({ result: command[1] === "vector:cli-revoked:" + user.id && state.revoked ? "1" : null })
    }
    if (url === `${process.env.SUPABASE_URL}/auth/v1/user`) {
      if (new Headers(init?.headers).get("authorization") !== "Bearer browser-session")
        return new Response(null, { status: 401 })
      return Response.json({ ...user, email_confirmed_at: "2026-01-01T00:00:00Z" })
    }
    throw new Error(`Unexpected request to ${url}`)
  }) as typeof fetch
  const user = { id: "11111111-1111-4111-8111-111111111111", email: "fixture@example.test" }
  beforeEach(() => {
    current.fetcher = fetcher
    state.revoked = false
    state.calls = []
  })

  test("a Vector account token reads Codium status, including whether Codium is on sale", async () => {
    const answer = await read(mintCliToken(user).token)
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({
      enabled: true,
      active: false,
      access: false,
      listed: [],
      purchased: { bought: false },
      empty: true,
      low: false,
    })
    // Verified locally and checked against revocation; Supabase is not involved.
    expect(state.calls.every((url) => url === process.env.KV_REST_API_URL)).toBe(true)
  })

  test("revoked, forged and browser-session tokens each take the right path", async () => {
    state.revoked = true
    expect((await read(mintCliToken(user).token)).status).toBe(401)
    state.revoked = false
    expect((await read(`${mintCliToken(user).token}x`)).status).toBe(401)
    const browser = await read("browser-session")
    expect(browser.status).toBe(200)
    expect(browser.body).toMatchObject({ enabled: true, access: false })
    expect((await read("not-a-session")).status).toBe(401)
  })

  test("status reports Codium as off while sales are disabled, and keeps its shape without Stripe", async () => {
    process.env.MODEL_PLANS_ENABLED = "false"
    expect((await read(mintCliToken(user).token)).body).toMatchObject({ enabled: false, access: false })
    process.env.MODEL_PLANS_ENABLED = "true"
    delete process.env.STRIPE_SECRET_KEY
    expect((await read(mintCliToken(user).token)).body).toEqual({
      enabled: true,
      active: false,
      access: false,
      listed: [],
      purchased: { bought: false },
      empty: true,
      low: false,
    })
  })
})

describe("a plan's status, from the snapshot", () => {
  test("a fresh snapshot answers without Stripe (M4), in shares, caps and timestamps only (P1)", async () => {
    const { fakes, fixture, token } = await seed("active-paid")
    const answer = await read(token)
    expect(answer.status).toBe(200)
    const now = fixture.now * 1000
    expect(answer.body).toEqual({
      enabled: true,
      active: true,
      customer: true,
      access: true,
      plan: {
        id: "vector-10",
        name: "Plus",
        left: 1,
        renewsAt: fixture.expect.periodEnd * 1000,
        cancelAtPeriodEnd: false,
        state: "active",
        today: { used: 0, resetsAt: now - (now % DAY) + DAY, reached: false },
      },
      listed: [],
      entitlements: publicEntitlements("vector-10", new Set()),
      purchased: { bought: false },
      empty: false,
      low: false,
    })
    expect(fakes.stripe.calls).toEqual([])
    // One read of the period's key; nothing changes on OpenRouter.
    expect(fakes.openRouter.calls.map((call) => call.method)).toEqual(["GET"])
    noAmounts(answer.body, "vector-10")
    // The decoders in this repository read it: the core client and the website.
    const decoded = await ModelPlanStatus.fetchStatus(token, (_url, init) =>
      fetch(`${origin.url}/api/model-plans/status`, init),
    )
    expect(decoded).toMatchObject({ signedIn: true, access: true, plan: { id: "vector-10", left: 1 }, empty: false })
    expect(decoded.error).toBeUndefined()
    expect(readModelPlanStatus(answer.body)).toMatchObject({ active: true, plan: { name: "Plus", left: 1 } })
  })

  test("a paused plan: active, no access, its notice and action, no figures and no provider read", async () => {
    const { fakes, fixture, token } = await seed("paused-past-due", { usage: 1 })
    const answer = await read(token)
    expect(answer.body).toEqual({
      enabled: true,
      active: true,
      customer: true,
      access: false,
      plan: {
        id: "vector-50",
        name: "Pro",
        renewsAt: fixture.expect.periodEnd * 1000,
        cancelAtPeriodEnd: false,
        state: "paused",
        reason: "payment_failed",
        action: "update-card",
      },
      listed: [],
      entitlements: publicEntitlements("vector-50", new Set()),
      purchased: { bought: false },
      empty: false,
      low: false,
    })
    expect(fakes.openRouter.calls).toEqual([])
    expect(fakes.stripe.calls).toEqual([])
    noAmounts(answer.body, "vector-50")
    expect(readModelPlanStatus(answer.body)).toMatchObject({ active: true, access: false })
    expect(
      (await ModelPlanStatus.fetchStatus(token, (_url, init) => fetch(`${origin.url}/api/model-plans/status`, init)))
        .error,
    ).toBeUndefined()
    for (const status of await released(token)) {
      expect(status.error).toBeUndefined()
      expect(status).toMatchObject({ signedIn: true, access: false, plan: { id: "vector-50" } })
    }
  })

  test("a frozen plan has the paused shape with its reason and no action; an ended one has no plan", async () => {
    const frozen = await seed("frozen-dispute-open")
    expect((await read(frozen.token)).body).toMatchObject({
      active: true,
      access: false,
      plan: { id: "vector-50", state: "frozen", reason: "disputed" },
      empty: false,
      low: false,
    })
    expect((await read(frozen.token)).body.plan.action).toBeUndefined()
    expect((await read(frozen.token)).body.plan.left).toBeUndefined()
    for (const status of await released(frozen.token)) expect(status.error).toBeUndefined()

    const ended = await seed("ended-canceled")
    expect((await read(ended.token)).body).toEqual({
      enabled: true,
      active: false,
      customer: true,
      access: false,
      listed: [],
      purchased: { bought: false },
      empty: true,
      low: false,
    })
    for (const status of await released(ended.token)) {
      expect(status.error).toBeUndefined()
      expect(status.plan).toBeUndefined()
    }
  })

  test("a renewing plan serves its previous month until the grace ends, then shows the payment it waits for", async () => {
    const { fixture, fakes, token, id } = await seed("renewing-draft-invoice", { usage: 12 })
    const end = fixture.expect.periodEnd * 1000
    const within = (await read(token)).body
    expect(within).toMatchObject({
      active: true,
      access: true,
      plan: { id: "vector-100", name: "Max", state: "renewing", left: 0.75, renewsAt: end },
      velocity: "coming",
      empty: false,
      low: false,
    })
    noAmounts(within, "vector-100")
    // Past the grace without payment: the read rules reconcile a renewing snapshot a minute old, and it is paused.
    const late = end + 121 * MINUTE
    setSystemTime(new Date(late))
    fakes.clock.now = late
    expect((await read(token)).body).toMatchObject({
      active: true,
      access: false,
      plan: { state: "paused", reason: "payment_pending", action: "update-card" },
    })
    expect(fakes.store.get(codiumKey("account", id))).toBeDefined()
  })

  test("today's share counts what ADMIT counts (settled day, live holds); Ultra has no daily limit", async () => {
    const { fixture, fakes, token, id } = await seed("renewing-draft-invoice")
    const now = fixture.now * 1000
    const day = new Date(now).toISOString().slice(0, 10)
    // Max: 40% of the month a day. The settled day bucket holds 10 of the 19.2 allowed.
    fakes.store.hash(codiumKey("day", SEEDED, day)).set("total", "10000000")
    expect((await read(token)).body.plan.today).toEqual({
      used: 0.52,
      resetsAt: now - (now % DAY) + DAY,
      reached: false,
    })
    // A live pool hold has no admission day, so ADMIT counts it today; with it, not even the cheapest request fits.
    const hold = await holdPool(id, 9.1, 60 * MINUTE, "hosted", { fetcher: fakes.fetcher, clock: () => now })
    // The answer above is cached for 30 s; its lifetime runs on the store's clock.
    fakes.clock.advance(STATUS_CACHE_MS)
    expect((await read(token)).body.plan.today).toMatchObject({ used: 0.99, reached: true })
    await hold.release()

    const ultra = await seed("active-dispute-warning-closed")
    const body = (await read(ultra.token)).body
    expect(body.plan).toMatchObject({ id: "vector-200", state: "active" })
    expect(body.plan.today).toBeUndefined()
    expect(body).toMatchObject({ velocity: "coming", labs: "coming" })
    noAmounts(body, "vector-200")
  })

  test("the forecast shows the run-out date at the month's average pace, and stays hidden early", async () => {
    // An hour in, half the month used: too early to say.
    const early = await seed("active-paid")
    const hash = early.pool!
    early.fakes.openRouter.keys.get(hash)!.usage = 2
    early.fakes.store.remove(statusCacheKey(early.id))
    expect((await read(early.token)).body.plan.forecastDate).toBeUndefined()
    // Ten days in, half used: the month runs out on day 20, before it ends.
    const start = early.fixture.expect.periodStart * 1000
    const later = await seed("active-paid", { at: start + 10 * DAY })
    later.fakes.openRouter.keys.get(later.pool!)!.usage = 2
    const body = (await read(later.token)).body
    expect(body.plan).toMatchObject({ left: 0.5, forecastDate: new Date(start + 20 * DAY).toISOString().slice(0, 10) })
    noAmounts(body, "vector-10")
  })

  test("a missing snapshot that another request is still reconciling answers 503 RENEWING, never a guess", async () => {
    const fixture = loadStripeFixture("active-paid")
    setSystemTime(new Date(fixture.now * 1000))
    const fakes = codiumFakes({ now: fixture.now * 1000 })
    fakes.store.set(codiumKey("account", fixture.accountId), JSON.stringify(fixture.account))
    // Another request holds this minute's reconcile and has not written the snapshot.
    fakes.store.set(codiumKey("reconcile", fixture.accountId), String(fixture.now * 1000))
    current.fetcher = fakes.fetcher
    const answer = await read(mintCliToken({ id: fixture.accountId, email: "fixture@example.test" }).token)
    expect(answer.status).toBe(503)
    expect(answer.body).toMatchObject({ error: { code: "MODEL_PLAN_RENEWING" } })
    expect(answer.headers.get("retry-after")).toBe("1")
    expect(fakes.stripe.calls).toEqual([])
    expect(fakes.store.get(statusCacheKey(fixture.accountId))).toBeUndefined()
  })

  test("the owner's codium switch off: Codium is unavailable and nothing can start, as at chat; the plan still shows", async () => {
    const { fakes, fixture, token } = await seed("active-paid")
    const now = fixture.now * 1000
    // The switch takes effect within its 30-second cache (seeding's reconcile read it on).
    fakes.store.set(codiumKey("switch", "codium"), "off")
    setSystemTime(new Date(now + SWITCH_CACHE_MS))
    expect((await read(token)).body).toMatchObject({
      enabled: false,
      active: true,
      access: false,
      plan: { id: "vector-10", state: "active", left: 1 },
    })
    const decoded = await ModelPlanStatus.fetchStatus(token, (_url, init) =>
      fetch(`${origin.url}/api/model-plans/status`, init),
    )
    expect(ModelPlanStatus.notice(decoded)).toEqual({
      kind: "unavailable",
      text: "Vector Codium is not available right now.",
    })
    for (const status of await released(token)) {
      expect(status.error).toBeUndefined()
      expect(status.enabled).toBe(false)
    }
    // The switch is read beside the 30-second answer, not kept in it: back on, the same kept answer has access again.
    fakes.store.set(codiumKey("switch", "codium"), "on")
    setSystemTime(new Date(now + 2 * SWITCH_CACHE_MS))
    expect((await read(token)).body).toMatchObject({ enabled: true, access: true, plan: { left: 1 } })
  })
})

describe("the 30-second cache", () => {
  test("a second read within 30 s is the cached answer; a reconcile that changes the plan clears it at once", async () => {
    const { fixture, fakes, token, id, pool } = await seed("active-paid")
    expect((await read(token)).body.plan.left).toBe(1)
    fakes.openRouter.keys.get(pool!)!.usage = 1
    // Spend shows up to 30 s late (§4.11): no provider read either.
    fakes.openRouter.calls.length = 0
    expect((await read(token)).body.plan.left).toBe(1)
    expect(fakes.openRouter.calls).toEqual([])
    fakes.clock.advance(STATUS_CACHE_MS)
    expect((await read(token)).body.plan.left).toBe(0.75)
    // Cancelling at period end changes the snapshot: the next read says so, without waiting for the cache.
    fakes.stripe.subscription(fixture.expect.subscription!)!.cancel_at_period_end = true
    await reconcileModelPlanAccount(id, fakes.fetcher, fixture.now * 1000)
    expect((await read(token)).body.plan.cancelAtPeriodEnd).toBe(true)
  })

  test("an answer computed before a reconcile and stored after it is never served for the new snapshot", async () => {
    const { fixture, fakes, token, id } = await seed("active-paid")
    // The status read stops just before it stores its answer; a reconcile then writes a new snapshot and clears the
    // cache, and only after that does the old answer land.
    const reached = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    current.fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const command = String(input).startsWith(process.env.KV_REST_API_URL!) ? JSON.parse(String(init?.body)) : []
      if (command[0] === "SET" && command[1] === statusCacheKey(id)) {
        reached.resolve()
        await gate.promise
      }
      return fakes.fetcher(input, init)
    }) as typeof fetch
    const before = read(token)
    await reached.promise
    fakes.stripe.subscription(fixture.expect.subscription!)!.cancel_at_period_end = true
    await reconcileModelPlanAccount(id, fakes.fetcher, fixture.now * 1000)
    gate.resolve()
    expect((await before).body.plan.cancelAtPeriodEnd).toBe(false)
    expect(JSON.parse(fakes.store.get(statusCacheKey(id))!).body.plan.cancelAtPeriodEnd).toBe(false)
    // The late answer is for the previous snapshot version: the next read computes the new one.
    expect((await read(token)).body.plan.cancelAtPeriodEnd).toBe(true)
  })

  test("an answer is never kept past the next UTC midnight or the pool ramp's end, whichever comes first", async () => {
    // Ten seconds before a UTC midnight inside the period (the fixture's periods start at one): the answer read then
    // lives ten seconds, so the first read at midnight shows the new day, not yesterday's `today` with a past reset.
    const start = loadStripeFixture("active-paid").expect.periodStart * 1000
    const midnight = start + 2 * DAY
    const { fakes, token, id } = await seed("active-paid", { at: midnight - 10_000 })
    expect((await read(token)).body.plan.today).toMatchObject({ resetsAt: midnight })
    expect(fakes.store.pttl(statusCacheKey(id))).toBe(10_000)
    setSystemTime(new Date(midnight))
    fakes.clock.now = midnight
    expect((await read(token)).body.plan.today).toMatchObject({ resetsAt: midnight + DAY })

    // A Max whose first payment was not 3-D Secure authenticated holds 30% of its month for 72 hours (A10), ending at
    // 01:00 UTC. Read ten seconds before that, the answer lives ten seconds, so the ramp notice goes when the ramp does.
    const ramped = await seed("governing-highest-rank", {
      prepare: (fixture) =>
        Object.assign(fixture.objects.charges!.find((value) => value.id === "ch_twoMax")!, {
          payment_method_details: { card: { three_d_secure: { result: "attempt_acknowledged" } } },
        }),
    })
    const until = (await readModelPlanAccount(ramped.id, ramped.fakes.fetcher))!.poolRamp!.until
    expect(until % DAY).not.toBe(0)
    setSystemTime(new Date(until - 10_000))
    ramped.fakes.clock.now = until - 10_000
    expect((await read(ramped.token)).body.plan.ramp).toEqual({ until })
    expect(ramped.fakes.store.pttl(statusCacheKey(ramped.id))).toBe(10_000)
    setSystemTime(new Date(until))
    ramped.fakes.clock.now = until
    expect((await read(ramped.token)).body.plan.ramp).toBeUndefined()
  })
})

describe("meters", () => {
  test("a meter shows only while its perk is listed, keeps its declared fields, and malformed ones drop", async () => {
    const registry = createStatusMeterRegistry()
    registry.register("github-agents", "cloudAgents", async () => ({ used: 0.333, exhausted: true }))
    registry.register("computer", "hosted", async () => ({ used: 1.2 }))
    registry.register("vault", "vault", async () => ({ usedBytes: 1.5, quotaBytes: 10 }))
    registry.register("remote", "remote", async () => {
      throw new Error("remote unavailable")
    })
    registry.register("ship-desk", "shipDesk", async () => ({ used: 0.5 }))
    expect(() => registry.register("github-agents", "cloudAgents", async () => undefined)).toThrow()
    const snapshot = buildSnapshot(
      {
        account: "33333333-3333-4333-8333-333333333333",
        state: "active",
        plan: "vector-100",
        subscription: "sub_meters",
        periodStart: Date.now() - DAY,
        periodEnd: Date.now() + 29 * DAY,
        cancelAtPeriodEnd: false,
        source: "webhook",
      },
      undefined,
      Date.now(),
    )
    expect(await registry.read(snapshot, [], fetch)).toBeUndefined()
    expect(await registry.read(snapshot, ["github-agents", "computer", "vault", "remote"], fetch)).toEqual({
      cloudAgents: { used: 0.33, exhausted: true },
    })
    expect(await registry.read(snapshot, ["ship-desk"], fetch)).toEqual({ shipDesk: { used: 0.5 } })

    // Through the route: no perk is listed before A27, so no meter shows.
    const { token } = await seed("active-paid")
    current.options = { ...served, meters: registry }
    const body = (await read(token)).body
    expect(body.listed).toEqual([])
    expect(body.meters).toBeUndefined()
  })

  test("a reader that throws before its promise, or never answers, drops only its own meter, on time", async () => {
    const registry = createStatusMeterRegistry()
    const aborted: boolean[] = []
    registry.register("github-agents", "cloudAgents", () => {
      throw new Error("cloud agents are not configured")
    })
    registry.register("computer", "hosted", (_snapshot, _fetcher, signal) => {
      signal.addEventListener("abort", () => aborted.push(true))
      return new Promise(() => {})
    })
    registry.register("ship-desk", "shipDesk", async () => ({ used: 0.5 }))
    const snapshot = buildSnapshot(
      {
        account: "33333333-3333-4333-8333-333333333333",
        state: "active",
        plan: "vector-100",
        subscription: "sub_meters",
        periodStart: Date.now() - DAY,
        periodEnd: Date.now() + 29 * DAY,
        cancelAtPeriodEnd: false,
        source: "webhook",
      },
      undefined,
      Date.now(),
    )
    const started = performance.now()
    expect(await registry.read(snapshot, ["github-agents", "computer", "ship-desk"], fetch)).toEqual({
      shipDesk: { used: 0.5 },
    })
    const elapsed = performance.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(METER_TIMEOUT_MS - 50)
    expect(elapsed).toBeLessThan(METER_TIMEOUT_MS + 2_000)
    // The slow reader is told its time is up, so it can stop its own requests.
    expect(aborted).toEqual([true])
  })
})

describe("the forecast's hiding rules", () => {
  const start = Date.UTC(2026, 9, 1)
  const month = start + 30 * DAY
  test("hidden for the first 3 days", () => {
    expect(forecastDate({ used: 0.5, periodStart: start, periodEnd: month, now: start + 2.9 * DAY })).toBeUndefined()
    expect(forecastDate({ used: 0.5, periodStart: start, periodEnd: month, now: start + 3 * DAY })).toBe("2026-10-07")
  })
  test("hidden under 5% used", () => {
    // A long period isolates the threshold: at 5% after 3 days, the run-out is day 60.
    const year = start + 365 * DAY
    expect(forecastDate({ used: 0.049, periodStart: start, periodEnd: year, now: start + 3 * DAY })).toBeUndefined()
    expect(forecastDate({ used: 0.05, periodStart: start, periodEnd: year, now: start + 3 * DAY })).toBe("2026-11-30")
  })
  test("hidden when the month lasts to its end, or is already used up", () => {
    expect(forecastDate({ used: 0.5, periodStart: start, periodEnd: month, now: start + 15 * DAY })).toBeUndefined()
    expect(forecastDate({ used: 0.5, periodStart: start, periodEnd: month, now: start + 14 * DAY })).toBe("2026-10-29")
    expect(forecastDate({ used: 1, periodStart: start, periodEnd: month, now: start + 5 * DAY })).toBeUndefined()
  })
})

// H7: the configuration decoders Vector 1.99.111 and 1.99.112 shipped (`salesOpen`, `fetchOffers`), run over the real
// /api/model-plans/config answer, so a later change to that answer cannot drop installed apps' plan offers unnoticed.
describe("the public configuration, as released Vector reads it", () => {
  test("Vector 1.99.111 and 1.99.112 read the real configuration with sales open and closed", async () => {
    const config = createServer((request, response) => void configHandler(request as never, response as never))
    await new Promise<void>((resolve) => config.listen(0, "127.0.0.1", resolve))
    const url = `http://127.0.0.1:${(config.address() as AddressInfo).port}/api/model-plans/config`
    const send = (_url: string, init: RequestInit) => fetch(url, init)
    // A configuration ready to sell: the fixture's, with the webhook secret and portal configuration it leaves out.
    const restoreReady = codiumTestEnvironment({
      STRIPE_MODEL_PLAN_WEBHOOK_SECRET: "whsec_fixture",
      STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID: "bpc_fixture",
    })
    try {
      expect(codiumBillingConfigProblems()).toEqual([])
      for (const open of [true, false]) {
        process.env.MODEL_PLANS_ENABLED = String(open)
        const body = (await (await fetch(url)).json()) as {
          enabled: boolean
          plans: { id: string; name: string; price: number; available: boolean }[]
        }
        expect(body.enabled).toBe(open)
        expect(body.plans.length).toBeGreaterThan(0)
        expect(body.plans.some((plan) => plan.available)).toBe(open)
        for (const decoder of [ModelPlanStatus1_99_111, ModelPlanStatus1_99_112]) {
          expect(await decoder.salesOpen(send)).toBe(open)
          expect(await decoder.fetchOffers(send)).toEqual({
            enabled: open,
            plans: body.plans.map((plan) => ({
              id: plan.id,
              name: plan.name,
              price: plan.price,
              available: plan.available,
            })),
            topups: [],
          })
        }
      }
    } finally {
      restoreReady()
      config.close()
    }
  })
})
