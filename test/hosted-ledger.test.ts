import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { ENTITLEMENTS, type EntitlementSnapshot } from "../packages/schema/src/codium-entitlements"
import { Hosted } from "../packages/schema/src/hosted"
import { codiumKey } from "../api/_lib/codium-keys"
import { MODEL_HOLD_MS, parseHoldMember, POOL_SCRIPTS, readDebits } from "../api/_lib/codium-pool"
import { readSnapshot } from "../api/_lib/codium-snapshot"
import {
  HOSTED_ENTITLEMENT_SCRIPTS,
  hostedAccess,
  hostedCaps,
  hostedDiskPolicy,
  hostedMinutesKey,
  hoursUsedShare,
  readHostedMinutes,
  requireHostedStart,
} from "../api/_lib/hosted-entitlement"
import {
  HOSTED_LEDGER_SCRIPTS,
  chargeNightly,
  chargeRetention,
  closeBlock,
  drainHostedSettles,
  eraseAccountHostedLedger,
  hostedAccount,
  hostedLapseKey,
  hostedRunningKey,
  hostedSettleDueKey,
  hostedSettleKey,
  openBlock,
  periodCharges,
  readLine,
  runningBlocks,
  settlePending,
  trueUpCharge,
} from "../api/_lib/hosted-ledger"
import {
  BLOCK_HOLD_TTL_MS,
  HOSTED_RATES,
  MARKUP_PERCENT,
  blockHoldMicro,
  chargeMinuteMicro,
  computeCostMicro,
  costMinuteMicro,
  egressCharge,
  egressGbCostMicro,
  hostedRatesProblems,
  minutesCharge,
  storageCharge,
  trueUpMicro,
  wholeMinutes,
  withMarkup,
  worstCaseHourMicro,
} from "../api/_lib/hosted-rates"
import {
  applyPoolDebits,
  holdPool,
  keyExpiresAt,
  modelPlanStatus,
  protectModelPlanKey,
  readModelPlanAccount,
  reconcileModelPlanAccount,
} from "../api/_lib/model-plan-account"
import { modelPlanBalance } from "../api/_lib/model-plan-status"
import { modelPlanStripe } from "../api/_lib/model-plan-stripe"
import {
  codiumFakes,
  codiumTestEnvironment,
  FIXTURE_CREDITS,
  loadStripeFixture,
  type CodiumFakes,
} from "../packages/web/test/fixture/codium-fakes"
import {
  HOSTED_SALT,
  ledgerBackend,
  hostedFetcher,
  registerHostedScripts,
  SERVICE_ROLE,
  SUPABASE_ORIGIN,
  type LedgerBackend,
} from "./hosted-fixture"

// WP A51, invariant M8: a cloud computer's time is held before it runs and charged into the pool at no less than the
// provider's worst-case cost. Stripe, OpenRouter and the store are the Codium fakes; the ledger lines are the in-memory
// `vector_hosted`, or the real SQL on Postgres when VECTOR_TEST_POSTGRES_URL is set (CI). The ledger's Lua runs for real
// on Valkey in the last block when VECTOR_TEST_REDIS_URL is set (CI).

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const fixture = loadStripeFixture("renewing-draft-invoice") // a Max plan
const id = fixture.accountId
const SEEDED = "hash_hosted1"
const P1 = { start: 1788220800, end: 1790812800 }
const P2 = { start: 1790812800, end: 1793404800 }
const E1 = `sub_renewing:${P1.start * 1000}`

let ledger: LedgerBackend
let restore = () => {}
beforeAll(async () => {
  ledger = await ledgerBackend()
})
afterAll(async () => {
  await ledger.close()
})
beforeEach(async () => {
  restore = codiumTestEnvironment({
    SUPABASE_URL: SUPABASE_ORIGIN,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
    VECTOR_HOSTED_ACCOUNT_SALT: HOSTED_SALT,
    VECTOR_HOSTED_ALLOW_ACCOUNTS: id,
    VECTOR_HOSTED_EGRESS_MICRO_USD_PER_GB: undefined,
    CODIUM_LISTED_PERKS: undefined,
  })
  await ledger.reset()
})
afterEach(() => restore())

type World = {
  fakes: CodiumFakes
  fetcher: typeof fetch
  options: { fetcher: typeof fetch; clock: () => number }
  /** Make the ledger's store unreachable (or reachable again). */
  ledgerDown(down: boolean): void
}

/**
 * A Max plan in its first period with a key Codium already made (`usage` spent on it), reconciled once as the webhook
 * would. The account paid for Max a month before, so neither the trust ramp nor the pool ramp applies.
 */
async function world(
  at = P1.end * 1000 - 6 * HOUR,
  options: { usage?: number; plan?: "vector-100" | "vector-10" } = {},
) {
  const fakes = codiumFakes({ now: at })
  const objects = structuredClone(fixture.objects)
  const subscription = objects.subscriptions![0]!
  Object.assign(subscription, {
    current_period_start: P1.start,
    current_period_end: P1.end,
    latest_invoice: "in_renewingP1",
  })
  objects.invoices = objects.invoices!.filter((invoice) => invoice.id !== "in_renewal")
  if (options.plan === "vector-10") {
    const item = (subscription.items as { data: Record<string, any>[] }).data[0]!
    item.price = { ...item.price, id: "price_codium10", unit_amount: 1000, unit_amount_decimal: "1000" }
    subscription.metadata = {
      ...(subscription.metadata as object),
      vector_plan: "vector-10",
      vector_model_credits_usd: "4",
    }
    for (const invoice of objects.invoices) {
      invoice.amount_paid = 1000
      for (const line of (invoice.lines as { data: Record<string, any>[] }).data)
        line.price = { ...line.price, id: "price_codium10" }
    }
  }
  fakes.stripe.load(objects)
  registerHostedScripts(fakes)
  const credits = options.plan === "vector-10" ? 4 : 48
  fakes.openRouter.seed(SEEDED, {
    name: `Vector test ${id} sub_renewing ${P1.start}`,
    limit: credits,
    usage: options.usage ?? 0,
    expires_at: keyExpiresAt(P1.end),
  })
  fakes.store.set(
    codiumKey("account", id),
    JSON.stringify({
      ...fixture.account,
      firstPaidAt: P1.start * 1000,
      firstHighPaidAt: P1.start * 1000,
      paidThrough: P1.end * 1000,
      highValueVerified: true,
      key: {
        hash: SEEDED,
        encrypted: protectModelPlanKey("seeded-secret", `${id}:sub_renewing:${P1.start}`),
        subscription: "sub_renewing",
        start: P1.start,
        end: P1.end,
        credits,
        creditsMicro: credits * 1_000_000,
        limitMicro: credits * 1_000_000,
        spendGenesis: fakes.store.seedSpendGenesis({
          account: id,
          pool: SEEDED,
          subscription: "sub_renewing",
          start: P1.start,
          end: P1.end,
        }),
      },
    }),
  )
  let down = false
  const reach = hostedFetcher(fakes, ledger)
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (down && new URL(input instanceof Request ? input.url : String(input)).origin === SUPABASE_ORIGIN)
      return new Response("unavailable", { status: 503 })
    return reach(input, init)
  }) as typeof fetch
  const snapshot = await reconcileModelPlanAccount(id, fetcher, at)
  expect(snapshot).toMatchObject({ state: "active", plan: options.plan ?? "vector-100", meterEpoch: E1 })
  return {
    fakes,
    fetcher,
    options: { fetcher, clock: () => fakes.clock.now },
    ledgerDown: (value: boolean) => {
      down = value
    },
  } satisfies World
}

const debits = (w: World, pool = SEEDED) => readDebits(id, pool, w.fetcher)
const held = (w: World, pool = SEEDED) => [...w.fakes.store.zset(codiumKey("held", pool)).keys()]
const limit = (w: World, pool = SEEDED) => w.fakes.openRouter.keys.get(pool)!.limit as number
const minutes = (w: World, epoch = E1) =>
  readHostedMinutes({ account: id, meterEpoch: epoch }, w.fetcher, w.fakes.clock.now)
const rows = async () => (await ledger.rows()).filter((row) => row.account === hostedAccount(id))

/** The renewal of P1, paid an hour after it was due: a new key and meter epoch for P2. */
async function renew(w: World) {
  const subscription = w.fakes.stripe.subscription("sub_renewing")!
  Object.assign(subscription, {
    current_period_start: P2.start,
    current_period_end: P2.end,
    latest_invoice: "in_renewal",
  })
  w.fakes.stripe.load({
    invoices: [structuredClone(fixture.objects.invoices!.find((invoice) => invoice.id === "in_renewal")!)],
  })
  w.fakes.clock.now = P1.end * 1000 + MINUTE
  expect((await reconcileModelPlanAccount(id, w.fetcher, w.fakes.clock.now)).state).toBe("renewing")
  for (const action of ["finalize", "pay"])
    await modelPlanStripe(
      `invoices/in_renewal/${action}`,
      { method: "POST", idempotency: `hosted-${action}` },
      w.fetcher,
    )
  w.fakes.clock.now = P1.end * 1000 + 2 * MINUTE
  const snapshot = await reconcileModelPlanAccount(id, w.fetcher, w.fakes.clock.now)
  expect(snapshot).toMatchObject({ state: "active", periodStart: P2.start * 1000 })
  return snapshot
}

/** A paid upgrade to Ultra, as subscription-mode Checkout makes it: a full new month that supersedes Max. */
async function upgrade(w: World) {
  const start = Math.floor(w.fakes.clock.now / 1000)
  const end = start + 30 * 86_400
  const price = {
    id: "price_codium200",
    active: true,
    currency: "usd",
    unit_amount: 20_000,
    recurring: { interval: "month", interval_count: 1 },
  }
  const source = w.fakes.stripe.subscription("sub_renewing")!
  const invoice = structuredClone(fixture.objects.invoices!.find((value) => value.id === "in_renewingP1")!)
  const charge = structuredClone(fixture.objects.charges![0]!)
  w.fakes.stripe.load({
    subscriptions: [
      {
        ...structuredClone(source),
        id: "sub_upgrade",
        status: "active",
        current_period_start: start,
        current_period_end: end,
        latest_invoice: "in_upgrade",
        schedule: null,
        metadata: {
          vector_account_id: id,
          vector_plan: "vector-200",
          vector_model_credits_usd: FIXTURE_CREDITS[200],
          vector_supersedes: "sub_renewing",
        },
        items: { data: [{ id: "si_upgrade", price, quantity: 1 }] },
      },
    ],
    invoices: [
      {
        ...invoice,
        id: "in_upgrade",
        subscription: "sub_upgrade",
        charge: "ch_upgrade",
        amount_paid: 20_000,
        lines: { data: [{ price, proration: false, period: { start, end } }] },
      },
    ],
    charges: [
      {
        ...charge,
        id: "ch_upgrade",
        invoice: "in_upgrade",
        amount: 20_000,
        payment_method_details: { card: { three_d_secure: { result: "authenticated" } } },
      },
    ],
  })
  const snapshot = await reconcileModelPlanAccount(id, w.fetcher, w.fakes.clock.now)
  expect(snapshot).toMatchObject({ state: "active", plan: "vector-200", meterEpoch: `sub_upgrade:${start * 1000}` })
  return snapshot
}

// ── Rates ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("hosted rates (iad1)", () => {
  test("the worst case and the charge per hour are the contract's, and every charge covers its cost plus 10%", () => {
    expect(worstCaseHourMicro("standard")).toBe(340_800)
    expect(worstCaseHourMicro("large")).toBe(681_600)
    expect(HOSTED_RATES).toEqual({
      standard: { costHourMicro: 340_800, chargeHourMicro: 375_000 },
      large: { costHourMicro: 681_600, chargeHourMicro: 750_000 },
    })
    for (const size of Hosted.SIZES) {
      expect(HOSTED_RATES[size].chargeHourMicro).toBeGreaterThanOrEqual(withMarkup(HOSTED_RATES[size].costHourMicro))
      expect(chargeMinuteMicro(size)).toBeGreaterThanOrEqual(withMarkup(costMinuteMicro(size)))
      for (const count of [0, 1, 7, 15, 20, 721]) {
        const { chargedMicro, costMicro } = minutesCharge(size, count)
        expect(chargedMicro).toBeGreaterThanOrEqual(costMicro)
      }
    }
    expect([chargeMinuteMicro("standard"), costMinuteMicro("standard")]).toEqual([6_250, 5_680])
    expect([chargeMinuteMicro("large"), costMinuteMicro("large")]).toEqual([12_500, 11_360])
    // A block holds 20 minutes: its own 15 and the 5 a session may run to wrap up.
    expect([blockHoldMicro("standard"), blockHoldMicro("large")]).toEqual([125_000, 250_000])
    expect(BLOCK_HOLD_TTL_MS).toBe(30 * MINUTE)
    expect(MARKUP_PERCENT).toBe(10)
  })

  test("time is rounded up to the minute, storage and egress are charged above cost, and egress is configurable", () => {
    expect([0, 1, 59_999, 60_000, 60_001, 450_000].map(wholeMinutes)).toEqual([0, 1, 1, 1, 2, 8])
    expect(storageCharge(3)).toEqual({ chargedMicro: 9_432, costMicro: 8_574 })
    expect(egressCharge(2)).toEqual({ chargedMicro: 330_000, costMicro: 300_000 })
    expect(egressGbCostMicro({ VECTOR_HOSTED_EGRESS_MICRO_USD_PER_GB: "90000" })).toBe(90_000)
    expect(egressCharge(1, { VECTOR_HOSTED_EGRESS_MICRO_USD_PER_GB: "0" })).toEqual({ chargedMicro: 0, costMicro: 0 })
    expect(hostedRatesProblems({})).toEqual([])
    for (const bad of ["0.15", "-1", "lots", "99999999999"])
      expect(hostedRatesProblems({ VECTOR_HOSTED_EGRESS_MICRO_USD_PER_GB: bad })).toEqual([
        "VECTOR_HOSTED_EGRESS_MICRO_USD_PER_GB is invalid",
      ])
  })

  test("a true-up only lowers a charge, to cost plus the markup, and never below the actual cost", () => {
    expect(trueUpMicro(50_000, 20_000)).toBe(22_000)
    expect(trueUpMicro(50_000, 49_000)).toBe(50_000)
    // Never raised, even when the actual cost came out higher than what was charged.
    expect(trueUpMicro(50_000, 60_000)).toBe(50_000)
    for (const [charged, cost] of [
      [93_750, 1],
      [93_750, 85_200],
      [6_250, 5_679.2],
    ] as const) {
      const trued = trueUpMicro(charged, cost)
      expect(trued).toBeLessThanOrEqual(charged)
      expect(trued).toBeGreaterThanOrEqual(Math.ceil(cost))
    }
    // Busy CPU per vCPU, memory for the whole time: a quarter of the CPU busy for 15 minutes on a standard computer.
    expect(computeCostMicro({ size: "standard", activeCpuMs: 2 * 15 * MINUTE * 0.25, wallMs: 15 * MINUTE })).toBe(
      37_200,
    )
    expect(() => computeCostMicro({ size: "standard", activeCpuMs: 3 * MINUTE, wallMs: MINUTE })).toThrow()
  })
})

// ── Plan rules ─────────────────────────────────────────────────────────────────────────────────────────────────────

function snapshotOf(
  state: EntitlementSnapshot["state"],
  plan: "vector-50" | "vector-100" | "vector-200",
  extra: Partial<EntitlementSnapshot> = {},
) {
  const now = Date.now()
  return {
    v: 1,
    version: 1,
    livemode: false,
    account: id,
    state,
    plan,
    subscription: "sub_x",
    periodStart: now - DAY,
    periodEnd: now + DAY,
    meterEpoch: `sub_x:${now - DAY}`,
    cancelAtPeriodEnd: false,
    ramp: { hostedUntil: 0, browserFrom: 0 },
    caps: structuredClone(ENTITLEMENTS[plan]),
    updatedAt: now,
    checkedAt: now,
    source: "webhook",
    ...extra,
  } as EntitlementSnapshot
}

describe("the cloud computer row of §4.4", () => {
  test("each plan state and service switch says what may run", () => {
    const now = Date.now()
    expect(hostedAccess(snapshotOf("active", "vector-100"))).toBe("start")
    expect(hostedAccess(snapshotOf("active", "vector-100"), "no-new")).toBe("continue")
    expect(hostedAccess(snapshotOf("active", "vector-100"), "stop")).toBe("stop")
    expect(hostedAccess(snapshotOf("active", "vector-100", { periodEnd: now - 1 }), "on", now)).toBe("continue")
    expect(hostedAccess(snapshotOf("renewing", "vector-100", { periodEnd: now - MINUTE }), "on", now)).toBe("continue")
    expect(hostedAccess(snapshotOf("renewing", "vector-100", { periodEnd: now - 3 * HOUR }), "on", now)).toBe("wrap")
    expect(hostedAccess(snapshotOf("paused", "vector-100"))).toBe("wrap")
    expect(hostedAccess(snapshotOf("ended", "vector-200"))).toBe("stop")
    expect(hostedAccess(snapshotOf("frozen", "vector-200"))).toBe("stop")
    expect(hostedAccess(snapshotOf("active", "vector-50"))).toBe("stop")
    expect(hostedAccess(undefined)).toBe("stop")
    expect(Hosted.WRAP_MS).toBe(5 * MINUTE)
  })

  test("disks: the plan's days while live, 14 days after an end, held during a dispute, 30 days after losing one", () => {
    expect(hostedDiskPolicy(snapshotOf("active", "vector-100"))).toEqual({ keep: "plan", days: 7 })
    expect(hostedDiskPolicy(snapshotOf("paused", "vector-200"))).toEqual({ keep: "plan", days: 30 })
    expect(hostedDiskPolicy(snapshotOf("ended", "vector-100", { reason: "canceled" }))).toEqual({
      keep: "ended",
      days: 14,
    })
    expect(hostedDiskPolicy(snapshotOf("frozen", "vector-100", { reason: "disputed" }))).toEqual({
      keep: "dispute",
      days: undefined,
    })
    expect(hostedDiskPolicy(snapshotOf("ended", "vector-100", { reason: "disputed" }))).toEqual({
      keep: "lost-dispute",
      days: 30,
    })
    expect(hostedDiskPolicy(snapshotOf("ended", "vector-100", { reason: "closing" }))).toEqual({
      keep: "none",
      days: 0,
    })
  })

  test("the trust ramp applies until it ends, recomputed at read time", () => {
    const now = Date.now()
    const ramped = snapshotOf("active", "vector-200", { ramp: { hostedUntil: now + DAY, browserFrom: now + HOUR } })
    expect(hostedCaps(ramped, now)).toEqual({
      computers: 1,
      hours: 15,
      jobMin: 120,
      diskDays: 30,
      sizes: ["standard", "large"],
    })
    expect(hostedCaps(ramped, now + 2 * DAY)).toEqual(ENTITLEMENTS["vector-200"].hosted)
    expect(hostedCaps(snapshotOf("active", "vector-50"), now)).toBeNull()
    expect(Hosted.hoursUsedShare(30, 20)).toBe(0.03)
    expect(Hosted.hoursUsedShare(1200, 20)).toBe(1)
    expect(Hosted.hoursUsedShare(5000, 20)).toBe(1)
    expect(Hosted.hoursUsedShare(10, 0)).toBe(1)
  })

  test("starting is checked on the server from the snapshot, with the service's own codes", async () => {
    const w = await world()
    const start = await requireHostedStart(id, { size: "standard", jobMinutes: 240 }, w.options)
    expect(start).toMatchObject({ size: "standard", jobMinutes: 240, browser: true, minutesLeft: 1200 })
    await expect(requireHostedStart(id, { size: "large", jobMinutes: 60 }, w.options)).rejects.toMatchObject({
      statusCode: 403,
      code: "HOSTED_NOT_INCLUDED",
      detail: { perk: "computer", limit: "size", plan: "vector-200" },
    })
    await expect(requireHostedStart(id, { size: "standard", jobMinutes: 241 }, w.options)).rejects.toMatchObject({
      code: "HOSTED_NOT_INCLUDED",
      detail: { limit: "job-length", plan: "vector-200" },
    })
    await expect(requireHostedStart(id, { size: "standard", jobMinutes: 0 }, w.options)).rejects.toMatchObject({
      statusCode: 400,
    })
    // The owner's switch, and an account that is neither on the owner's list nor offered a listed computer.
    w.fakes.store.set(codiumKey("switch", "hosted"), JSON.stringify({ value: "no-new", changedAt: 1, generation: "g" }))
    // Switches are cached for 30 seconds.
    w.fakes.clock.advance(31_000)
    await expect(requireHostedStart(id, { size: "standard", jobMinutes: 60 }, w.options)).rejects.toMatchObject({
      statusCode: 503,
      code: "HOSTED_UNAVAILABLE",
    })
    restore()
    restore = codiumTestEnvironment({
      SUPABASE_URL: SUPABASE_ORIGIN,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
      VECTOR_HOSTED_ACCOUNT_SALT: HOSTED_SALT,
      VECTOR_HOSTED_ALLOW_ACCOUNTS: undefined,
    })
    const v = await world()
    await expect(requireHostedStart(id, { size: "standard", jobMinutes: 60 }, v.options)).rejects.toMatchObject({
      code: "HOSTED_UNAVAILABLE",
    })
    await expect(openBlock(id, { session: "s1", size: "standard" }, v.options)).rejects.toMatchObject({
      code: "HOSTED_UNAVAILABLE",
    })
    expect(held(v)).toEqual([])
  })

  test("a plan without a cloud computer, or one that is paused, is refused", async () => {
    const plus = await world(undefined, { plan: "vector-10" })
    await expect(requireHostedStart(id, { size: "standard", jobMinutes: 60 }, plus.options)).rejects.toMatchObject({
      statusCode: 403,
      code: "HOSTED_NOT_INCLUDED",
      detail: { perk: "computer", plan: "vector-100" },
    })
    await expect(openBlock(id, { session: "s1", size: "standard" }, plus.options)).rejects.toMatchObject({
      code: "HOSTED_NOT_INCLUDED",
    })
    const w = await world()
    Object.assign(w.fakes.stripe.subscription("sub_renewing")!, { status: "past_due" })
    expect((await reconcileModelPlanAccount(id, w.fetcher, w.fakes.clock.now)).state).toBe("paused")
    await expect(requireHostedStart(id, { size: "standard", jobMinutes: 60 }, w.options)).rejects.toMatchObject({
      statusCode: 402,
      code: "HOSTED_PAUSED",
      detail: { reason: "payment_failed" },
    })
    await expect(openBlock(id, { session: "s1", size: "standard" }, w.options)).rejects.toMatchObject({
      code: "HOSTED_PAUSED",
    })
  })
})

// ── Blocks (M8) ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("M8: blocks are held before they run and charged at no less than cost", () => {
  test("a block holds 20 minutes before it starts, then settles its minutes, rounded up, at the charged rate", async () => {
    const w = await world()
    const started = w.fakes.clock.now
    const block = await openBlock(id, { session: "s1", size: "standard" }, w.options)
    expect(block).toEqual({
      session: "s1",
      block: 0,
      ref: "hb-s1-0",
      size: "standard",
      startedAt: started,
      endsAt: started + 15 * MINUTE,
      stopBy: started + 20 * MINUTE,
    })
    const holds = held(w).map(parseHoldMember)
    expect(holds).toEqual([{ ticket: expect.any(String), purpose: "hosted", run: undefined, micro: 125_000 }])
    expect(await minutes(w)).toEqual({ used: 0, reserved: 15 })
    expect((await runningBlocks(id, w.fetcher)).map((entry) => entry.ref)).toEqual(["hb-s1-0"])

    w.fakes.clock.advance(7 * MINUTE + 30_000)
    expect(await closeBlock(id, { session: "s1", block: 0 }, w.options)).toBe(true)
    // Eight minutes (7.5 rounded up) at the standard rate, applied to the key's limit; the hold is given back.
    expect((await debits(w)).map((debit) => [debit.ref, debit.micro, debit.applied])).toEqual([
      ["hb-s1-0", 50_000, true],
    ])
    expect(held(w)).toEqual([])
    expect(limit(w)).toBe(47.95)
    expect(await minutes(w)).toEqual({ used: 8, reserved: 0 })
    expect(await runningBlocks(id, w.fetcher)).toEqual([])
    const [line] = await rows()
    expect(line).toMatchObject({
      ref: "hb-s1-0",
      kind: "block",
      size: "standard",
      units: 8,
      chargedMicro: 50_000,
      costMicro: 45_440,
      truedMicro: null,
      periodStart: P1.start * 1000,
      periodEnd: P1.end * 1000,
      occurredAt: started,
    })
    expect(line!.chargedMicro).toBeGreaterThanOrEqual(line!.costMicro)
    expect(await hoursUsedShare((await readSnapshot(id, w.fetcher))!, w.fetcher, w.fakes.clock.now)).toBe(0.01)
  })

  test("no block starts without its hold: a pool that cannot cover one opens nothing", async () => {
    const w = await world(undefined, { usage: 47.9 })
    await expect(openBlock(id, { session: "s1", size: "standard" }, w.options)).rejects.toMatchObject({
      statusCode: 402,
      code: "MODEL_PLAN_EXHAUSTED",
    })
    expect(held(w)).toEqual([])
    expect(await runningBlocks(id, w.fetcher)).toEqual([])
    expect(await minutes(w)).toEqual({ used: 0, reserved: 0 })
    expect(await rows()).toEqual([])
  })

  test("M3: hosted spend lowers status's share left and refuses a model hold", async () => {
    const w = await world(undefined, { usage: 11.75 })
    const share = async () => {
      const balance = modelPlanBalance(await modelPlanStatus(id, w.fetcher, w.fakes.clock.now))
      return "plan" in balance ? balance.plan : undefined
    }
    expect(await share()).toMatchObject({ left: 0.76 })
    await openBlock(id, { session: "s1", size: "standard" }, w.options)
    w.fakes.clock.advance(15 * MINUTE)
    await closeBlock(id, { session: "s1", block: 0 }, w.options)
    expect(await share()).toMatchObject({ left: 0.75 })

    const tight = await world(undefined, { usage: 47.8 })
    await openBlock(id, { session: "s1", size: "standard" }, tight.options)
    await expect(holdPool(id, 0.1, MODEL_HOLD_MS, "chat", tight.options)).rejects.toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
    })
  })

  test("renewing a block holds the next one first, then settles the last at the minutes it ran", async () => {
    const w = await world()
    const first = await openBlock(id, { session: "s1", size: "standard" }, w.options)
    w.fakes.clock.advance(15 * MINUTE)
    const next = await openBlock(id, { session: "s1", size: "standard", renew: first.block }, w.options)
    expect(next).toMatchObject({ block: 1, ref: "hb-s1-1", startedAt: first.startedAt + 15 * MINUTE })
    expect((await debits(w)).map((debit) => [debit.ref, debit.micro])).toEqual([["hb-s1-0", 93_750]])
    expect(held(w).map((member) => parseHoldMember(member)!.micro)).toEqual([125_000])
    expect(await minutes(w)).toEqual({ used: 15, reserved: 15 })
    // Renewing a block the session is no longer on is refused, and its hold given back.
    await expect(openBlock(id, { session: "s1", size: "standard", renew: 0 }, w.options)).rejects.toMatchObject({
      statusCode: 409,
      code: "HOSTED_SESSION_MOVED",
    })
    expect(held(w)).toHaveLength(1)
  })

  test("minutes a computer ran past its hold are charged as an overrun; nothing it ran goes uncharged", async () => {
    const w = await world()
    await openBlock(id, { session: "s1", size: "standard" }, w.options)
    w.fakes.clock.advance(26 * MINUTE)
    await closeBlock(id, { session: "s1", block: 0 }, w.options)
    expect((await debits(w)).map((debit) => [debit.ref, debit.micro, debit.applied]).sort()).toEqual([
      ["hb-s1-0", 125_000, true],
      ["hb-s1-0-over", 37_500, true],
    ])
    expect(limit(w)).toBe(47.84)
    expect((await rows()).map((row) => [row.ref, row.kind, row.units, row.chargedMicro, row.costMicro]).sort()).toEqual(
      [
        ["hb-s1-0", "block", 20, 125_000, 113_600],
        ["hb-s1-0-over", "overrun", 6, 37_500, 34_080],
      ],
    )
    expect(await minutes(w)).toEqual({ used: 26, reserved: 0 })
  })

  test("a block nothing closed is charged its whole hold once the hold lapses", async () => {
    const w = await world()
    await openBlock(id, { session: "s1", size: "standard" }, w.options)
    expect([...w.fakes.store.zset(hostedLapseKey()).keys()]).toEqual([id])
    w.fakes.clock.advance(31 * MINUTE)
    expect(await drainHostedSettles(w.options)).toEqual({ settled: 1, retried: 0 })
    expect((await debits(w)).map((debit) => [debit.ref, debit.micro])).toEqual([["hb-s1-0", 125_000]])
    expect(await runningBlocks(id, w.fetcher)).toEqual([])
    expect([...w.fakes.store.zset(hostedLapseKey()).keys()]).toEqual([])
    expect(await minutes(w)).toEqual({ used: 20, reserved: 0 })
  })

  test("settling is idempotent: a settle that failed half way charges once when it is retried", async () => {
    const w = await world()
    await openBlock(id, { session: "s1", size: "standard" }, w.options)
    w.fakes.clock.advance(5 * MINUTE)
    // The ledger is unreachable after the pool took the charge: the block stays queued, marked charged.
    w.ledgerDown(true)
    expect(await closeBlock(id, { session: "s1", block: 0 }, w.options)).toBe(true)
    const queued = w.fakes.store.hash(hostedSettleKey(id))
    expect(JSON.parse(queued.get("hb-s1-0")!)).toMatchObject({ charged: { pool: SEEDED, epoch: E1 } })
    expect([...w.fakes.store.zset(hostedSettleDueKey()).keys()]).toEqual([id])
    await expect(settlePending(id, w.options)).rejects.toMatchObject({ code: "HOSTED_UNAVAILABLE" })
    expect(await drainHostedSettles(w.options)).toEqual({ settled: 0, retried: 1 })
    w.ledgerDown(false)
    w.fakes.clock.advance(2 * MINUTE)
    expect(await drainHostedSettles(w.options)).toEqual({ settled: 1, retried: 0 })
    expect(await settlePending(id, w.options)).toBe(0)
    expect((await debits(w)).map((debit) => [debit.ref, debit.micro])).toEqual([["hb-s1-0", 31_250]])
    expect(limit(w)).toBe(47.97)
    expect(await minutes(w)).toEqual({ used: 5, reserved: 0 })
    expect((await rows()).map((row) => [row.ref, row.chargedMicro])).toEqual([["hb-s1-0", 31_250]])
    expect(w.fakes.store.keys()).not.toContain(hostedSettleKey(id))
  })

  test("a plan's computers at once and its hours are caps no parallel request passes", async () => {
    const w = await world()
    await openBlock(id, { session: "s1", size: "standard" }, w.options)
    // Max has one computer: a second session is refused, and gives its hold back.
    await expect(openBlock(id, { session: "s2", size: "standard" }, w.options)).rejects.toMatchObject({
      statusCode: 429,
      code: "HOSTED_BUSY",
    })
    await expect(openBlock(id, { session: "s1", size: "standard" }, w.options)).rejects.toMatchObject({
      code: "HOSTED_SESSION_RUNNING",
    })
    expect(held(w)).toHaveLength(1)
    await closeBlock(id, { session: "s1", block: 0 }, w.options)

    // Ten minutes of the 20 hours are left: the next block gets ten, and nothing after that.
    w.fakes.store.hash(hostedMinutesKey(id, E1)).set("used", String(20 * 60 - 10))
    const short = await openBlock(id, { session: "s2", size: "standard" }, w.options)
    expect(short.endsAt - short.startedAt).toBe(10 * MINUTE)
    w.fakes.clock.advance(10 * MINUTE)
    await expect(openBlock(id, { session: "s2", size: "standard", renew: 0 }, w.options)).rejects.toMatchObject({
      statusCode: 402,
      code: "HOSTED_HOURS_USED",
    })
    expect(held(w)).toHaveLength(1)
    await expect(requireHostedStart(id, { size: "standard", jobMinutes: 30 }, w.options)).rejects.toMatchObject({
      code: "HOSTED_HOURS_USED",
    })
  })

  test("the daily share is checked before a block is held", async () => {
    const w = await world()
    const day = new Date(w.fakes.clock.now).toISOString().slice(0, 10)
    // Max may spend 40% of the month a day: 19.2 of the fixture's 48.
    w.fakes.store.hash(codiumKey("day", SEEDED, day)).set("total", String(19_100_000))
    await expect(openBlock(id, { session: "s1", size: "standard" }, w.options)).rejects.toMatchObject({
      statusCode: 429,
      code: "MODEL_PLAN_DAILY_LIMIT",
    })
    expect(held(w)).toEqual([])
    w.fakes.store.hash(codiumKey("day", SEEDED, day)).set("total", String(19_000_000))
    await openBlock(id, { session: "s1", size: "standard" }, w.options)
    expect(held(w)).toHaveLength(1)
  })
})

// ── Periods ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("charges go to the period active when they settle", () => {
  test("late settle: a block that ran across a renewal is charged to the new period, with when it ran", async () => {
    const w = await world(P1.end * 1000 - 10 * MINUTE)
    const block = await openBlock(id, { session: "s1", size: "standard" }, w.options)
    const next = await renew(w)
    const current = (await readModelPlanAccount(id, w.fetcher))!.key!
    expect(current.hash).not.toBe(SEEDED)
    w.fakes.clock.now = P1.end * 1000 + 3 * MINUTE
    await closeBlock(id, { session: "s1", block: 0 }, w.options)
    // Thirteen minutes, charged to P2's key; P1's replaced key keeps nothing and its hold went back.
    expect((await debits(w, current.hash)).map((debit) => [debit.ref, debit.micro, debit.applied])).toEqual([
      ["hb-s1-0", 81_250, true],
    ])
    expect(await debits(w)).toEqual([])
    expect(held(w)).toEqual([])
    expect(limit(w, current.hash)).toBe(47.92)
    expect(await minutes(w, next.meterEpoch)).toEqual({ used: 13, reserved: 0 })
    expect(await minutes(w)).toEqual({ used: 0, reserved: 0 })
    expect(await readLine(id, "hb-s1-0", w.options)).toMatchObject({
      chargedMicro: 81_250,
      periodStart: P2.start * 1000,
      periodEnd: P2.end * 1000,
      occurredAt: block.startedAt,
    })
    expect(await periodCharges(id, P2.start * 1000, w.options)).toEqual({
      chargedMicro: 81_250,
      truedMicro: 81_250,
      minutes: 13,
      lines: 1,
    })
    expect(await periodCharges(id, P1.start * 1000, w.options)).toEqual({
      chargedMicro: 0,
      truedMicro: 0,
      minutes: 0,
      lines: 0,
    })
  })

  test("a session renewed across a renewal moves into the new period: its hours there count each block once", async () => {
    const w = await world(P1.end * 1000 - 10 * MINUTE)
    const first = await openBlock(id, { session: "s1", size: "standard" }, w.options)
    const next = await renew(w)
    const current = (await readModelPlanAccount(id, w.fetcher))!.key!
    w.fakes.clock.now = first.startedAt + 15 * MINUTE
    await openBlock(id, { session: "s1", size: "standard", renew: 0 }, w.options)
    // The first block's 15 minutes count in P2 (where it settled); the second block's 15 are reserved there, once.
    expect(await minutes(w, next.meterEpoch)).toEqual({ used: 15, reserved: 15 })
    expect(await minutes(w)).toEqual({ used: 0, reserved: 0 })
    expect((await debits(w, current.hash)).map((debit) => [debit.ref, debit.micro])).toEqual([["hb-s1-0", 93_750]])
    // The second block's hold is on P2's key.
    expect(held(w)).toEqual([])
    expect(held(w, current.hash).map((member) => parseHoldMember(member)!.micro)).toEqual([125_000])
  })

  test("upgrade: fresh meters at the new plan's hours, and a block running across it counts there", async () => {
    const w = await world()
    const first = await openBlock(id, { session: "s1", size: "standard" }, w.options)
    w.fakes.clock.advance(15 * MINUTE)
    await openBlock(id, { session: "s1", size: "standard", renew: first.block }, w.options)
    expect(await minutes(w)).toEqual({ used: 15, reserved: 15 })
    const ultra = await upgrade(w)
    const successor = (await readModelPlanAccount(id, w.fetcher))!.key!
    expect(await hoursUsedShare(ultra, w.fetcher, w.fakes.clock.now)).toBe(0)
    expect(hostedCaps(ultra, w.fakes.clock.now)).toEqual(ENTITLEMENTS["vector-200"].hosted)
    expect(await minutes(w, ultra.meterEpoch)).toEqual({ used: 0, reserved: 0 })

    w.fakes.clock.advance(5 * MINUTE)
    await closeBlock(id, { session: "s1", block: 1 }, w.options)
    expect(await minutes(w, ultra.meterEpoch)).toEqual({ used: 5, reserved: 0 })
    expect(await minutes(w)).toEqual({ used: 15, reserved: 0 })
    expect((await debits(w, successor.hash)).map((debit) => [debit.ref, debit.micro])).toEqual([["hb-s1-1", 31_250]])
    expect((await debits(w)).map((debit) => debit.ref)).toEqual(["hb-s1-0"])
    // Ultra's own caps from here: three computers, and the large size.
    await openBlock(id, { session: "s2", size: "large" }, w.options)
    await openBlock(id, { session: "s3", size: "standard" }, w.options)
    expect(await minutes(w, ultra.meterEpoch)).toEqual({ used: 5, reserved: 45 })
  })
})

// ── Charges outside blocks ─────────────────────────────────────────────────────────────────────────────────────────

describe("storage, egress and retention", () => {
  test("a computer's day of storage and egress is charged once, above cost", async () => {
    const w = await world()
    const day = new Date(w.fakes.clock.now).toISOString().slice(0, 10)
    const input = { computer: "vh-0123456789abcdef-1", day, storageGbDays: 3, egressGb: 2 }
    const lines = await chargeNightly(id, input, w.options)
    expect(lines.map((line) => [line.kind, line.chargedMicro, line.costMicro])).toEqual([
      ["storage", 9_432, 8_574],
      ["egress", 330_000, 300_000],
    ])
    expect(await chargeNightly(id, input, w.options)).toEqual(lines)
    expect((await debits(w)).map((debit) => [debit.micro, debit.applied]).sort()).toEqual([
      [330_000, true],
      [9_432, true],
    ])
    expect(limit(w)).toBe(47.66)
    await expect(chargeNightly(id, { ...input, day: "26-09-2026" }, w.options)).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  test("an ended plan's disk retention is paid once from the final period, and shortened when it cannot cover it", async () => {
    const w = await world()
    Object.assign(w.fakes.stripe.subscription("sub_renewing")!, { status: "canceled", ended_at: P1.end - 3600 })
    expect((await reconcileModelPlanAccount(id, w.fetcher, w.fakes.clock.now)).state).toBe("ended")
    // Storage after the end is paid by retention, not nightly.
    const day = new Date(w.fakes.clock.now).toISOString().slice(0, 10)
    expect(await chargeNightly(id, { computer: "vh-a-1", day, storageGbDays: 10, egressGb: 0 }, w.options)).toEqual([])
    const granted = await chargeRetention(id, { computer: "vh-a-1", gb: 10, days: 14 }, w.options)
    expect(granted).toEqual({ days: 14, until: w.fakes.clock.now + 14 * DAY })
    expect((await debits(w)).map((debit) => [debit.ref, debit.micro])).toEqual([
      [`hr-vh-a-1-sub_renewing-${P1.start}`, storageCharge(140).chargedMicro],
    ])
    expect(await chargeRetention(id, { computer: "vh-a-1", gb: 10, days: 14 }, w.options)).toEqual(granted)

    const tight = await world(undefined, { usage: 47.9 })
    Object.assign(tight.fakes.stripe.subscription("sub_renewing")!, { status: "canceled", ended_at: P1.end - 3600 })
    await reconcileModelPlanAccount(id, tight.fetcher, tight.fakes.clock.now)
    await ledger.reset()
    // About 0.10 left covers three days of 10 GB.
    expect((await chargeRetention(id, { computer: "vh-a-1", gb: 10, days: 14 }, tight.options)).days).toBe(3)
  })
})

// ── True-up ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("true-up", () => {
  test("lowers a charge to cost plus the markup, raises the key's limit, and never raises a charge", async () => {
    const w = await world()
    await openBlock(id, { session: "s1", size: "standard" }, w.options)
    w.fakes.clock.advance(8 * MINUTE)
    await closeBlock(id, { session: "s1", block: 0 }, w.options)
    expect(limit(w)).toBe(47.95)
    expect(await trueUpCharge(id, { ref: "hb-s1-0", actualCostMicro: 20_000 }, w.options)).toEqual({
      lowered: true,
      micro: 22_000,
    })
    expect(
      (await debits(w)).map((debit) => [debit.ref, debit.micro, debit.applied, debit.hold.endsWith(":22000")]),
    ).toEqual([["hb-s1-0", 22_000, true, true]])
    expect(limit(w)).toBe(47.98)
    expect(await readLine(id, "hb-s1-0", w.options)).toMatchObject({ chargedMicro: 50_000, truedMicro: 22_000 })
    // A higher cost later never raises it again; a lower one lowers it, never below that cost.
    expect(await trueUpCharge(id, { ref: "hb-s1-0", actualCostMicro: 30_000 }, w.options)).toMatchObject({
      lowered: false,
      micro: 22_000,
    })
    expect(await trueUpCharge(id, { ref: "hb-s1-0", actualCostMicro: 10_000 }, w.options)).toEqual({
      lowered: true,
      micro: 11_000,
    })
    expect(await trueUpCharge(id, { ref: "hb-unknown-0", actualCostMicro: 1 }, w.options)).toMatchObject({
      lowered: false,
      reason: "unknown",
    })
    expect(await periodCharges(id, P1.start * 1000, w.options)).toEqual({
      chargedMicro: 50_000,
      truedMicro: 11_000,
      minutes: 8,
      lines: 1,
    })
  })

  test("an unapplied debit keeps its own hold at the lowered amount; another period's charge is left alone", async () => {
    const w = await world()
    await openBlock(id, { session: "s1", size: "standard" }, w.options)
    w.fakes.clock.advance(8 * MINUTE)
    // The key cannot be updated: the debit stays unapplied and held.
    const key = w.fakes.openRouter.keys.get(SEEDED)!
    let failing = true
    w.fakes.openRouter.fail = (call) =>
      failing && call.method === "PATCH" ? Response.json({ error: "fixture outage" }, { status: 503 }) : undefined
    await closeBlock(id, { session: "s1", block: 0 }, w.options)
    expect((await debits(w)).map((debit) => [debit.micro, debit.applied])).toEqual([[50_000, false]])
    expect(held(w).map((member) => parseHoldMember(member)!.micro)).toEqual([50_000])
    expect(await trueUpCharge(id, { ref: "hb-s1-0", actualCostMicro: 20_000 }, w.options)).toMatchObject({
      lowered: true,
    })
    expect(held(w).map((member) => parseHoldMember(member)!.micro)).toEqual([22_000])
    failing = false
    await applyPoolDebits(id, SEEDED, w.fetcher)
    expect(key.limit).toBe(47.98)
    expect(held(w)).toEqual([])

    // After a renewal the charge sits on a replaced key: nothing to lower there.
    const v = await world(P1.end * 1000 - 10 * MINUTE)
    await openBlock(id, { session: "s1", size: "standard" }, v.options)
    v.fakes.clock.advance(5 * MINUTE)
    await closeBlock(id, { session: "s1", block: 0 }, v.options)
    await renew(v)
    expect(await trueUpCharge(id, { ref: "hb-s1-0", actualCostMicro: 1_000 }, v.options)).toMatchObject({
      lowered: false,
      reason: "period",
    })
  })
})

// ── Boundaries ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("boundaries", () => {
  test("the ledger SQL is invoker-only, pseudonymous, never deletes, and keeps charges at or above cost", async () => {
    const sql = await Bun.file(new URL("../docs/vector/owner-actions/sql/hosted.sql", import.meta.url)).text()
    expect(sql).toContain("security invoker set search_path = ''")
    expect(sql).toContain("alter table public.vector_hosted_ledger enable row level security;")
    expect(sql).toContain("revoke all on public.vector_hosted_ledger from public, anon, authenticated;")
    expect(sql).toContain("grant select, insert, update on public.vector_hosted_ledger to service_role;")
    expect(sql).toContain("check (charged_micro >= cost_micro)")
    expect(sql).toContain("account text not null check (account ~ '^[a-f0-9]{64}$')")
    const statements = sql.replace(/--.*$/gm, "")
    expect(statements).not.toMatch(/\breferences\b|\bon delete\b|\bdelete from\b|\btruncate\b|grant[^;]*delete/i)
    expect(statements).not.toMatch(/email|user_id|auth\./i)
    // The account in every request is the salted HMAC, never the id.
    expect(hostedAccount(id)).toMatch(/^[a-f0-9]{64}$/)
    expect(hostedAccount(id)).not.toContain(id.replaceAll("-", ""))
  })

  test("the rates are imported by api/ only, and no line or answer carries an account id", async () => {
    const root = new URL("../packages/", import.meta.url).pathname
    const importers: string[] = []
    for await (const file of new Bun.Glob("**/src/**/*.{ts,tsx}").scan({ cwd: root }))
      if (/(?:from|import)\s*\(?\s*["'][^"']*hosted-rates/.test(await Bun.file(root + file).text()))
        importers.push(file)
    expect(importers).toEqual([])
    const schema = await Bun.file(new URL("../packages/schema/src/hosted.ts", import.meta.url)).text()
    // The shared module's code (its comments aside) holds counts, names and shares, never an amount.
    expect(schema.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).not.toMatch(/micro|usd|price|cost|\$/i)

    const w = await world()
    await openBlock(id, { session: "s1", size: "standard" }, w.options)
    w.fakes.clock.advance(MINUTE)
    await closeBlock(id, { session: "s1", block: 0 }, w.options)
    expect(JSON.stringify(await ledger.rows())).not.toContain(id)
  })

  test("account deletion settles what ran, keeps the pseudonymous lines and erases the account's ledger state", async () => {
    const w = await world()
    await openBlock(id, { session: "s1", size: "standard" }, w.options)
    w.fakes.clock.advance(6 * MINUTE)
    await eraseAccountHostedLedger(id, w.options)
    expect((await rows()).map((row) => [row.ref, row.units, row.chargedMicro])).toEqual([["hb-s1-0", 6, 37_500]])
    // WP A53's `hosted` provisioner is configured with the ledger, so reconcile queues an outbox item for it: that is
    // the outbox's record, not the ledger's state.
    expect(
      w.fakes.store.keys().filter((key) => key.includes(":hosted:") && key.includes(id) && !key.includes(":outbox:")),
    ).toEqual([])
    expect([
      ...w.fakes.store.zset(hostedLapseKey()).keys(),
      ...w.fakes.store.zset(hostedSettleDueKey()).keys(),
    ]).toEqual([])
    // Erasing again finds nothing to do.
    await eraseAccountHostedLedger(id, w.options)
  })

  test("the status meter is registered from the status route for the computer perk", async () => {
    const route = await Bun.file(new URL("../api/model-plans/status.ts", import.meta.url)).text()
    expect(route).toContain('import "../_lib/hosted-meter.js"')
    const meter = await Bun.file(new URL("../api/_lib/hosted-meter.ts", import.meta.url)).text()
    expect(meter).toContain('registerStatusMeter("computer", "hosted"')
  })
})

// ── The scripts on Valkey (CI) ─────────────────────────────────────────────────────────────────────────────────────

const valkeyURL = process.env.VECTOR_TEST_REDIS_URL

describe.skipIf(!valkeyURL)("the ledger's scripts on Valkey", () => {
  const client = valkeyURL ? new RedisClient(valkeyURL) : undefined
  const send = async (command: (string | number)[]) =>
    (await client!.send(String(command[0]), command.slice(1).map(String))) ?? null
  beforeEach(async () => {
    await client!.send("FLUSHDB", [])
  })

  test("OPEN, CLOSE, LAPSE, METER, MARK, FINISH, MINUTES and LOWER", async () => {
    const now = Date.now()
    const running = hostedRunningKey(id)
    const meter = hostedMinutesKey(id, E1)
    const settle = hostedSettleKey(id)
    const entry = (session: string, block: number, startedAt: number) => ({
      v: 1,
      session,
      block,
      ref: `hb-${session}-${block}`,
      size: "standard",
      startedAt,
      minutes: 0,
      weight: 1,
      epoch: E1,
      periodEnd: now + DAY,
      pool: SEEDED,
      ticket: "ticket",
      micro: 125_000,
      expiresAt: startedAt + 30 * MINUTE,
    })
    const open = (session: string, prev: number, at: number, extra: Record<string, unknown> = {}) =>
      send([
        "EVAL",
        HOSTED_LEDGER_SCRIPTS.OPEN,
        5,
        running,
        meter,
        settle,
        hostedSettleDueKey(),
        hostedLapseKey(),
        JSON.stringify({
          now: at,
          account: id,
          session,
          prev,
          computers: 1,
          cap: 30,
          want: 15,
          weight: 1,
          holdMs: 20 * MINUTE,
          entry: entry(session, prev + 1, at),
          runningAt: at + DAY,
          minutesAt: at + DAY,
          settleAt: at + DAY,
          ...extra,
        }),
      ])
    expect(await open("s1", -1, now)).toEqual(["ok", 15])
    expect(await open("s2", -1, now)).toEqual(["busy"])
    expect(await open("s1", -1, now)).toEqual(["exists"])
    expect(await send(["ZSCORE", hostedLapseKey(), id])).toBe(String(now + 30 * MINUTE))
    // Renewed ten minutes in: the first block ran 10, so 20 of the 30 are free for the next.
    expect(await open("s1", 0, now + 10 * MINUTE)).toEqual(["ok", 15])
    expect(JSON.parse(String(await send(["HGET", settle, "hb-s1-0"])))).toMatchObject({ endedAt: now + 10 * MINUTE })
    expect(await send(["HGET", meter, "r:hb-s1-0"])).toBe(`10:${now + 30 * MINUTE}`)
    expect(await open("s1", 1, now + 20 * MINUTE)).toEqual(["hours"])
    expect(await open("s1", 0, now + 20 * MINUTE)).toEqual(["moved"])
    expect(await send(["EVAL", HOSTED_ENTITLEMENT_SCRIPTS.MINUTES, 1, meter, now + 11 * MINUTE])).toEqual([0, 25])
    // METER counts once, in the period it settled in.
    for (const expected of [1, 0])
      expect(await send(["EVAL", HOSTED_LEDGER_SCRIPTS.METER, 2, meter, meter, "hb-s1-0", 10, now + DAY, now])).toBe(
        expected,
      )
    expect(await send(["HGET", meter, "used"])).toBe("10")
    expect(await send(["EVAL", HOSTED_LEDGER_SCRIPTS.MARK, 1, settle, "hb-s1-0", '{"marked":true}'])).toBe(1)
    expect(await send(["EVAL", HOSTED_LEDGER_SCRIPTS.MARK, 1, settle, "hb-none-0", "{}"])).toBe(0)
    expect(await send(["EVAL", HOSTED_LEDGER_SCRIPTS.FINISH, 2, settle, hostedSettleDueKey(), "hb-s1-0", id])).toBe(1)
    expect(await send(["ZSCORE", hostedSettleDueKey(), id])).toBeNull()
    // CLOSE only the block the session is on; LAPSE parks a block whose hold lapsed, charged its whole hold.
    const closeArgs = ["s1", 0, now + 25 * MINUTE, now + 25 * MINUTE, id, now + DAY]
    expect(
      await send([
        "EVAL",
        HOSTED_LEDGER_SCRIPTS.CLOSE,
        4,
        running,
        settle,
        hostedSettleDueKey(),
        hostedLapseKey(),
        ...closeArgs,
      ]),
    ).toBe("")
    const lapsedAt = now + 10 * MINUTE + 31 * MINUTE
    expect(
      await send([
        "EVAL",
        HOSTED_LEDGER_SCRIPTS.LAPSE,
        4,
        running,
        settle,
        hostedSettleDueKey(),
        hostedLapseKey(),
        lapsedAt,
        id,
        20 * MINUTE,
        lapsedAt + DAY,
      ]),
    ).toBe(1)
    expect(JSON.parse(String(await send(["HGET", settle, "hb-s1-1"])))).toMatchObject({ endedAt: now + 30 * MINUTE })
    expect(await send(["HLEN", running])).toBe(0)
    expect(await send(["ZSCORE", hostedLapseKey(), id])).toBeNull()
    expect(await send(["ZSCORE", hostedSettleDueKey(), id])).toBe(String(lapsedAt))
    expect(await open("s3", -1, lapsedAt)).toEqual(["ok", 5])
    expect(
      await send([
        "EVAL",
        HOSTED_LEDGER_SCRIPTS.CLOSE,
        4,
        running,
        settle,
        hostedSettleDueKey(),
        hostedLapseKey(),
        "s3",
        0,
        lapsedAt + MINUTE,
        lapsedAt + MINUTE,
        id,
        lapsedAt + DAY,
      ]),
    ).toContain('"ref":"hb-s3-0"')

    // LOWER renames the debit's held member while unapplied, and never raises it.
    const debitsKey = codiumKey("debits", id, SEEDED)
    const heldKey = codiumKey("held", SEEDED)
    const hold = "debit-0000000000000000000000000000000000000000:hosted:-:50000"
    await send([
      "HSET",
      debitsKey,
      "hb-s1-0",
      JSON.stringify({ micro: 50_000, applied: false, hold, purpose: "hosted", at: now }),
    ])
    await send(["ZADD", heldKey, now + DAY, hold])
    const lower = (micro: number) =>
      send([
        "EVAL",
        POOL_SCRIPTS.LOWER,
        3,
        debitsKey,
        heldKey,
        codiumKey("debit-apply"),
        "hb-s1-0",
        String(micro),
        `${id}:${SEEDED}`,
        now,
      ])
    expect(await lower(22_000)).toBe(1)
    expect(await lower(30_000)).toBe(0)
    expect(JSON.parse(String(await send(["HGET", debitsKey, "hb-s1-0"])))).toEqual({
      micro: 22_000,
      applied: false,
      hold: hold.replace(":50000", ":22000"),
      purpose: "hosted",
      at: now,
    })
    expect(await send(["ZSCORE", heldKey, hold.replace(":50000", ":22000")])).toBe(String(now + DAY))
    expect(await send(["ZSCORE", heldKey, hold])).toBeNull()
    expect(
      await send([
        "EVAL",
        POOL_SCRIPTS.LOWER,
        3,
        debitsKey,
        heldKey,
        codiumKey("debit-apply"),
        "hb-none",
        "1",
        "x",
        now,
      ]),
    ).toBe(-2)
  })
})
