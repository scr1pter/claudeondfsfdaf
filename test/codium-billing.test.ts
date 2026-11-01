import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test"
import { RedisClient } from "bun"
import { ENTITLEMENTS, type EntitlementSnapshot } from "../packages/schema/src/codium-entitlements"
import type { PlanId } from "../packages/schema/src/codium-plan"
import {
  cheapestPlanWith,
  includes,
  meterAdd,
  readEntitlement,
  reconcileOnDemand,
  requireEntitlement,
} from "../api/_lib/codium-entitlements"
import { codiumKey } from "../api/_lib/codium-keys"
import {
  buildSnapshot,
  isStale,
  meterKey,
  onEntitlementChange,
  readSnapshot,
  runMeterAdd,
  NONE_SNAPSHOT_KEEP_MS,
  SNAPSHOT_SCRIPTS,
  transitionCause,
  writeSnapshot,
  type SnapshotFacts,
} from "../api/_lib/codium-snapshot"
import { ApiError, handleApiError, type ApiResponse } from "../api/_lib/http"
import {
  cancelModelPlanAccount,
  governingStanding,
  holdPool,
  keyExpiresAt,
  modelPlanCheckout,
  modelPlanCredential,
  protectModelPlanKey,
  readModelPlanAccount,
  reconcileModelPlanAccount,
  riskState,
  subscriptionStanding,
} from "../api/_lib/model-plan-account"
import { reconcileModelPlanEvent } from "../api/model-plans/webhook"
import {
  codiumFakes,
  codiumTestEnvironment,
  FIXTURE_CREDITS,
  loadStripeFixture,
  stripeFixtureNames,
  type CodiumFakes,
  type StripeFixture,
} from "../packages/web/test/fixture/codium-fakes"

// WP A05: the entitlement snapshot and reconcile (contract §4.3, §4.4). Every row of §4.4's "Stripe → state" table has
// a fixture of Stripe objects at the pinned API version (packages/web/test/fixtures/stripe); reconcile must turn each
// into its state, converge the OpenRouter key, and write one versioned snapshot that services read without calling
// Stripe (M4). Stripe, OpenRouter and the store are fakes (packages/web/test/fixture/codium-fakes.ts); the snapshot's
// Lua also runs against a real Valkey when VECTOR_TEST_REDIS_URL is set (the CI lane).

let restore = () => {}
beforeEach(() => {
  restore = codiumTestEnvironment()
})
afterEach(() => {
  restore()
  setSystemTime()
})

const HOUR = 3_600_000
const DAY = 24 * HOUR
const ROWS = [
  "none",
  "active",
  "renewing",
  "renewing-past-grace",
  "action-required",
  "past-due",
  "unpaid",
  "canceled",
  "full-refund",
  "partial-refund",
  "open-dispute",
  "dispute-won",
  "dispute-lost",
  "early-fraud-warning",
  "blocked",
  "deletion",
]
const SEEDED = "fixture_key_seeded"

const accountKey = (id: string) => `vector:codium:test:account:${id}`
const snapshotKey = (id: string) => `vector:codium:test:ent:${id}`

/** The fakes holding a fixture's Stripe objects, its account record, and the key Codium made earlier, if any. */
function seed(fixture: StripeFixture) {
  const fakes = codiumFakes({ now: fixture.now * 1000 })
  fakes.stripe.load(fixture.objects)
  const record: Record<string, unknown> = { ...fixture.account }
  if (fixture.key) {
    const { subscription, start, end } = fixture.key
    const owner = fixture.objects.subscriptions?.find((value) => value.id === subscription)
    const credits = Number((owner?.metadata as Record<string, string>).vector_model_credits_usd)
    // As provisioning makes it since WP A07: expiring at the period's end plus the renewal grace (M11).
    fakes.openRouter.seed(SEEDED, {
      name: `Vector test ${fixture.accountId} ${subscription} ${start}`,
      limit: credits,
      usage: 0.25,
      expires_at: keyExpiresAt(end),
    })
    record.key = {
      hash: SEEDED,
      encrypted: protectModelPlanKey("seeded-secret", `${fixture.accountId}:${subscription}:${start}`),
      subscription,
      start,
      end,
      credits,
      creditsMicro: credits * 1_000_000,
      limitMicro: credits * 1_000_000,
      // Provisioned fresh since A17: its pool has a trusted ledger genesis.
      spendGenesis: fakes.store.seedSpendGenesis({ account: fixture.accountId, pool: SEEDED, subscription, start, end }),
    }
  }
  fakes.store.set(accountKey(fixture.accountId), JSON.stringify(record))
  return fakes
}

const created = (fakes: CodiumFakes) =>
  fakes.openRouter.calls.filter((call) => call.method === "POST" && call.path === "keys")

async function storedAccount(fakes: CodiumFakes, id: string) {
  return readModelPlanAccount(id, fakes.fetcher)
}

// ── The §4.4 mapping, one fixture per row ──────────────────────────────────────────────────────────────────────

describe("Stripe → state (contract §4.4), from fixtures", () => {
  test("every row of the mapping table has a fixture, each at the pinned API version", () => {
    const rows = new Set(stripeFixtureNames().map((name) => loadStripeFixture(name).row))
    for (const row of ROWS) expect(rows).toContain(row)
    expect([...rows].filter((row) => !ROWS.includes(row))).toEqual(["governing"])
  })

  for (const name of stripeFixtureNames())
    test(name, async () => {
      const fixture = loadStripeFixture(name)
      const expected = fixture.expect
      const fakes = seed(fixture)
      const warn = spyOn(console, "warn").mockImplementation(() => {})
      let snapshot: EntitlementSnapshot
      let warnings: unknown[][]
      try {
        snapshot = await reconcileModelPlanAccount(fixture.accountId, fakes.fetcher, fixture.now * 1000, {
          source: "replay",
          ...(fixture.hint ? { hint: fixture.hint } : {}),
        })
      } finally {
        warnings = [...warn.mock.calls]
        warn.mockRestore()
      }
      expect(snapshot).toMatchObject({
        v: 1,
        version: 1,
        livemode: false,
        account: fixture.accountId,
        state: expected.state,
        plan: expected.plan,
        periodStart: expected.periodStart * 1000,
        periodEnd: expected.periodEnd * 1000,
        checkedAt: fixture.now * 1000,
        source: "replay",
      })
      expect(snapshot.reason).toBe(expected.reason as never)
      expect(snapshot.subscription).toBe(expected.subscription as never)
      expect(snapshot.meterEpoch).toBe(
        expected.subscription ? `${expected.subscription}:${expected.periodStart * 1000}` : "none",
      )
      if (expected.cancelAtPeriodEnd !== undefined) expect(snapshot.cancelAtPeriodEnd).toBe(expected.cancelAtPeriodEnd)
      expect(snapshot.caps.rank).toBe(expected.plan ? ENTITLEMENTS[expected.plan as PlanId].rank : 1)
      if (!expected.plan) expect(snapshot.caps.inFlight).toBe(0)
      // What reconcile answered is what every service will read.
      expect(JSON.parse(fakes.store.get(snapshotKey(fixture.accountId))!)).toEqual(snapshot)

      // The key: made for the paid period, kept for a renewal, switched off for everything else.
      const seeded = fakes.openRouter.keys.get(SEEDED)
      if (expected.key === "created") {
        expect(created(fakes)).toHaveLength(1)
        const made = [...fakes.openRouter.keys.values()].find((value) => value.hash !== SEEDED)
        expect(made).toMatchObject({
          disabled: false,
          limit: expected.keyLimit ?? Number(FIXTURE_CREDITS[rankPrice(expected.plan)]),
        })
        if (seeded) expect(seeded.disabled).toBe(true)
      } else {
        expect(created(fakes)).toEqual([])
        if (expected.key === "none") expect(fakes.openRouter.keys.size).toBe(0)
        else expect(seeded?.disabled).toBe(expected.key === "disabled")
      }

      // Paid upgrades cancel the old subscription; A10 holds also stop collection or cancel a lost dispute.
      const writes = fakes.stripe.calls.filter((call) => call.method !== "GET")
      const cancellation =
        name === "governing-supersedes" ? "sub_before" : name === "ended-dispute-lost" ? "sub_lost" : undefined
      const paused =
        name === "frozen-dispute-open"
          ? "sub_disputed"
          : name === "frozen-dispute-previous-charge"
            ? "sub_steady"
            : undefined
      if (cancellation) expect(writes).toMatchObject([{ method: "DELETE", path: `subscriptions/${cancellation}` }])
      else if (paused) {
        expect(writes).toHaveLength(1)
        expect(writes[0]).toMatchObject({ method: "POST", path: `subscriptions/${paused}` })
        expect(writes[0]!.form!.get("pause_collection[behavior]")).toBe("void")
      } else expect(writes).toEqual([])
      if (expected.stripeCalls !== undefined) expect(fakes.stripe.calls).toHaveLength(expected.stripeCalls)

      const account = await storedAccount(fakes, fixture.accountId)
      if (expected.risk) {
        const risk = account?.risk
        if (expected.risk.blocked !== undefined) expect(risk?.blocked).toBe(expected.risk.blocked)
        if (expected.risk.reason !== undefined) expect(risk?.reason).toBe(expected.risk.reason)
        if (expected.risk.openDisputes)
          expect(Object.keys(risk?.openDisputes ?? {})).toEqual(expected.risk.openDisputes)
        if (expected.risk.efw) expect(risk?.efw).toEqual(expected.risk.efw)
      }
      if (expected.duplicates)
        expect(warnings.flatMap((call) => (call[1] as { duplicates?: string[] })?.duplicates ?? [])).toEqual(
          expected.duplicates,
        )
    })

  test("replaying a notification changes nothing: same version, no new key, no account write, only checkedAt moves", async () => {
    for (const name of ["active-paid", "governing-supersedes", "frozen-dispute-open"]) {
      const fixture = loadStripeFixture(name)
      const fakes = seed(fixture)
      const options = fixture.hint ? { hint: fixture.hint } : {}
      const first = await reconcileModelPlanAccount(fixture.accountId, fakes.fetcher, fixture.now * 1000, options)
      const later = fixture.now * 1000 + 5 * 60_000
      const commands = fakes.store.commands.length
      const second = await reconcileModelPlanAccount(fixture.accountId, fakes.fetcher, later, options)
      expect(second).toEqual({ ...first, checkedAt: later })
      expect(created(fakes)).toHaveLength(fixture.expect.key === "created" ? 1 : 0)
      const rewrites = fakes.store.commands
        .slice(commands)
        .filter((command) => command[0] === "SET" && command[1] === accountKey(fixture.accountId))
      expect(rewrites).toEqual([])
    }
  })

  test("an account with no record is `none` without asking Stripe, and its snapshot lapses after a week", async () => {
    const fakes = codiumFakes()
    const snapshot = await reconcileModelPlanAccount("no-record-account", fakes.fetcher, fakes.clock.now)
    expect(snapshot).toMatchObject({ state: "none", plan: null, meterEpoch: "none", version: 1 })
    expect(fakes.stripe.calls).toEqual([])
    expect(fakes.store.expires.get(snapshotKey("no-record-account"))).toBe(fakes.clock.now + NONE_SNAPSHOT_KEEP_MS)
    // A paid snapshot is kept until the next one replaces it.
    const fixture = loadStripeFixture("active-paid")
    const paid = seed(fixture)
    await reconcileModelPlanAccount(fixture.accountId, paid.fetcher, fixture.now * 1000)
    expect(paid.store.expires.has(snapshotKey(fixture.accountId))).toBe(false)
  })

  test("account deletion writes ended/closing before the cleanup, so every service stops at once", async () => {
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    const id = fixture.accountId
    const paid = await reconcileModelPlanAccount(id, fakes.fetcher, fixture.now * 1000)
    // Deletion reads the clock itself: it comes an hour into the fixture's paid month.
    const deleted = fakes.clock.advance(HOUR)
    setSystemTime(new Date(deleted))
    await cancelModelPlanAccount(id, fakes.fetcher)
    const closing = await readSnapshot(id, fakes.fetcher)
    expect(closing).toMatchObject({
      state: "ended",
      reason: "closing",
      plan: "vector-10",
      subscription: paid.subscription,
      version: 2,
      checkedAt: deleted,
    })
    expect([...fakes.openRouter.keys.values()].every((key) => key.disabled === true)).toBe(true)
    expect(fakes.stripe.subscription(paid.subscription!)?.status).toBe("canceled")
    await expect(requireEntitlement(id, "codium", fakes.fetcher, deleted)).rejects.toMatchObject({
      statusCode: 409,
      code: "MODEL_PLAN_ACCOUNT_CLOSING",
    })
    // A later reconcile keeps it closed and asks Stripe nothing.
    const calls = fakes.stripe.calls.length
    expect(await reconcileModelPlanAccount(id, fakes.fetcher, fakes.clock.advance(HOUR))).toMatchObject({
      state: "ended",
      reason: "closing",
    })
    expect(fakes.stripe.calls).toHaveLength(calls)
  })
})

// ── Disputes, fraud warnings and M5 ────────────────────────────────────────────────────────────────────────────

/** A dispute notification as Stripe sends it: the dispute object, which names its charge but not its customer. */
const disputeEvent = (type: string, dispute: Record<string, unknown>) => ({
  id: `evt_${type}_${String(dispute.id)}_${String(dispute.status)}`,
  type,
  livemode: false,
  data: { object: dispute },
})

describe("a dispute on any Codium charge freezes the account (M5)", () => {
  // These scenarios run on their fixtures' clocks, so a wall clock past every fixture's period must change nothing.
  beforeEach(() => setSystemTime(new Date(Date.UTC(2031, 0, 1))))

  test("a dispute on last month's charge freezes through the webhook, survives the next payment and lifts once won", async () => {
    const fixture = loadStripeFixture("frozen-dispute-previous-charge")
    const dispute = fixture.objects.disputes![0]!
    // The month is paid and nothing is disputed yet.
    const fakes = seed({ ...fixture, objects: { ...fixture.objects, disputes: [] } })
    const charge = fakes.stripe.charge(String(dispute.charge))!
    charge.disputed = false
    const id = fixture.accountId
    const now = fixture.now * 1000
    expect(await reconcileModelPlanAccount(id, fakes.fetcher, now)).toMatchObject({ state: "active" })
    expect(fakes.openRouter.keys.get(SEEDED)?.disabled).toBe(false)

    // The bank disputes last month's charge. The notification names that charge only.
    charge.disputed = true
    fakes.stripe.load({ disputes: [dispute] })
    await reconcileModelPlanEvent(disputeEvent("charge.dispute.created", dispute), fakes.fetcher, {
      now: fakes.clock.advance(HOUR),
    })
    const frozen = await readSnapshot(id, fakes.fetcher)
    expect(frozen).toMatchObject({ state: "frozen", reason: "disputed", version: 2 })
    expect(frozen?.revokedBefore).toBeNumber()
    expect(fakes.openRouter.keys.get(SEEDED)?.disabled).toBe(true)
    expect((await storedAccount(fakes, id))?.risk?.openDisputes).toHaveProperty(String(dispute.charge))

    // This month's invoice.paid arrives again: the latest invoice is paid, but the old dispute still holds the account,
    // and neither reconcile nor a model request switches the key back on.
    const invoice = fakes.stripe.objects.invoices.get(String(fakes.stripe.subscription("sub_steady")!.latest_invoice))!
    await reconcileModelPlanEvent(
      { id: "evt_paid_again", type: "invoice.paid", livemode: false, data: { object: invoice } },
      fakes.fetcher,
      { now: fakes.clock.advance(HOUR) },
    )
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ state: "frozen", reason: "disputed", version: 2 })
    await expect(modelPlanCredential(id, fakes.fetcher, fakes.clock.now, 0.01)).rejects.toMatchObject({
      statusCode: 403,
      code: "MODEL_PLAN_BLOCKED",
      detail: { reason: "disputed" },
    })
    expect(fakes.openRouter.keys.get(SEEDED)?.disabled).toBe(true)
    expect(fakes.openRouter.calls.filter((call) => call.method === "PATCH" && call.json?.disabled === false)).toEqual(
      [],
    )

    // Won: the same notification path lifts it, and the key comes back on.
    dispute.status = "won"
    fakes.stripe.load({ disputes: [dispute] })
    await reconcileModelPlanEvent(disputeEvent("charge.dispute.closed", dispute), fakes.fetcher, {
      now: fakes.clock.advance(HOUR),
    })
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ state: "active", version: 3 })
    expect(fakes.openRouter.keys.get(SEEDED)?.disabled).toBe(false)
    expect((await storedAccount(fakes, id))?.risk?.openDisputes).toEqual({})
  })

  test("an early-fraud warning freezes, and the next invoice.paid does not unfreeze it", async () => {
    const fixture = loadStripeFixture("frozen-early-fraud-warning")
    const fakes = seed(fixture)
    const id = fixture.accountId
    const warning = fixture.objects.early_fraud_warnings![0]!
    await reconcileModelPlanEvent(
      { id: "evt_efw", type: "radar.early_fraud_warning.created", livemode: false, data: { object: warning } },
      fakes.fetcher,
      { now: fakes.clock.advance(HOUR) },
    )
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ state: "frozen", reason: "early_fraud_warning" })
    const invoice = fixture.objects.invoices![0]!
    await reconcileModelPlanEvent(
      { id: "evt_paid", type: "invoice.paid", livemode: false, data: { object: invoice } },
      fakes.fetcher,
      { now: fakes.clock.advance(HOUR) },
    )
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ state: "frozen", reason: "early_fraud_warning" })
    expect(fakes.openRouter.keys.get(SEEDED)?.disabled).toBe(true)
    expect((await storedAccount(fakes, id))?.risk?.efw).toEqual([String(warning.charge)])
  })

  test("a lost dispute blocks for good: a new paid month stays ended", async () => {
    const fixture = loadStripeFixture("ended-dispute-lost")
    const fakes = seed(fixture)
    const id = fixture.accountId
    await reconcileModelPlanAccount(id, fakes.fetcher, fixture.now * 1000, { hint: fixture.hint })
    const charge = fakes.stripe.charge(String(fixture.objects.disputes![0]!.charge))!
    charge.disputed = false
    fakes.stripe.objects.disputes.clear()
    expect(await reconcileModelPlanAccount(id, fakes.fetcher, fixture.now * 1000 + HOUR)).toMatchObject({
      state: "ended",
      reason: "disputed",
    })
    expect(created(fakes)).toEqual([])
    // A model request gets the answer every service gives an ended plan (contract §4.4, §4.10): 402 REQUIRED with the
    // reason, not the 403 of a freeze.
    const ended = { statusCode: 402, code: "MODEL_PLAN_REQUIRED", detail: { reason: "disputed" } }
    await expect(modelPlanCredential(id, fakes.fetcher, fixture.now * 1000 + HOUR, 0.01)).rejects.toMatchObject(ended)
    await expect(requireEntitlement(id, "codium", fakes.fetcher, fixture.now * 1000 + HOUR)).rejects.toMatchObject(
      ended,
    )
  })

  test("a dispute while OpenRouter is down still writes the frozen snapshot, and the retry switches the key off", async () => {
    const fixture = loadStripeFixture("frozen-dispute-open")
    const fakes = seed(fixture)
    const id = fixture.accountId
    const now = fixture.now * 1000
    fakes.openRouter.fail = (call) =>
      call.method === "PATCH" ? Response.json({ error: "fixture outage" }, { status: 503 }) : undefined
    await expect(reconcileModelPlanAccount(id, fakes.fetcher, now, { hint: fixture.hint! })).rejects.toMatchObject({
      code: "MODEL_PLAN_UPSTREAM",
    })
    // The snapshot that stops every service, and the outbox items that revoke what was issued, went first.
    const frozen = await readSnapshot(id, fakes.fetcher)
    expect(frozen).toMatchObject({ state: "frozen", reason: "disputed", version: 1 })
    expect(frozen?.revokedBefore).toBe(now)
    expect(fakes.store.command(["ZRANGE", codiumKey("outbox"), 0, -1])).toContain(`github-runs:${id}:1`)
    await expect(requireEntitlement(id, "codium", fakes.fetcher, now)).rejects.toMatchObject({
      statusCode: 403,
      code: "MODEL_PLAN_BLOCKED",
    })
    expect(fakes.openRouter.keys.get(SEEDED)?.disabled).toBe(false)

    // OpenRouter is back: the reconcile the webhook queued switches the key off and leaves the snapshot as it was.
    fakes.openRouter.fail = undefined
    expect(
      await reconcileModelPlanAccount(id, fakes.fetcher, now + 60_000, { source: "outbox", hint: fixture.hint! }),
    ).toMatchObject({ state: "frozen", version: 1, revokedBefore: now })
    expect(fakes.openRouter.keys.get(SEEDED)?.disabled).toBe(true)
  })

  test("the risk record's order: deletion, a lost dispute, an open dispute, a warning, any other block", () => {
    const risk = (value: Record<string, unknown>) => ({
      risk: { blocked: false, openDisputes: {}, efw: [] as string[], ...value },
    })
    expect(riskState({})).toBeUndefined()
    expect(riskState(risk({}))).toBeUndefined()
    expect(riskState({ closing: true, ...risk({ blocked: true, reason: "owner" }) })).toEqual({
      state: "ended",
      reason: "closing",
    })
    expect(
      riskState(risk({ blocked: true, reason: "disputed", openDisputes: { ch_1: { status: "x", at: 1 } } })),
    ).toEqual({ state: "ended", reason: "disputed" })
    expect(riskState(risk({ blocked: true, reason: "owner", openDisputes: { ch_1: { status: "x", at: 1 } } }))).toEqual(
      {
        state: "frozen",
        reason: "disputed",
      },
    )
    expect(riskState(risk({ efw: ["ch_2"] }))).toEqual({ state: "frozen", reason: "early_fraud_warning" })
    expect(riskState(risk({ blocked: true, reason: "early_fraud_warning" }))).toEqual({
      state: "ended",
      reason: "early_fraud_warning",
    })
    expect(riskState(risk({ blocked: true, reason: "something new" }))).toEqual({ state: "frozen", reason: "owner" })
  })
})

// ── Checkout for a held account ────────────────────────────────────────────────────────────────────────────────

describe("an account its risk record holds cannot buy Codium again", () => {
  test("checkout refuses a blocked, disputed or warned account before any customer, reservation or session", async () => {
    const buyer = "buyer@example.test"
    for (const risk of [
      { blocked: true, reason: "disputed", at: 1, openDisputes: {}, efw: [] },
      { blocked: true, reason: "early_fraud_warning", at: 1, openDisputes: {}, efw: [] },
      { blocked: true, reason: "owner", at: 1, openDisputes: {}, efw: [] },
      { blocked: false, openDisputes: { ch_open: { status: "needs_response", at: 1 } }, efw: [] },
      { blocked: false, openDisputes: {}, efw: ["ch_warned"] },
    ]) {
      restore()
      restore = codiumTestEnvironment({ VECTOR_ADMIN_EMAILS: buyer })
      // Its old subscription was cancelled, so nothing else would stop a new one.
      const fixture = loadStripeFixture("ended-canceled")
      const fakes = seed(fixture)
      const at = fixture.now * 1000
      fakes.store.set(
        codiumKey("funding"),
        JSON.stringify({
          status: "open",
          checkedAt: at,
          since: at,
          balance: 1_000_000,
          owed: 0,
          reserved: 0,
          required: 0,
          keys: 0,
        }),
      )
      fakes.store.set(accountKey(fixture.accountId), JSON.stringify({ ...fixture.account, risk }))
      await expect(
        modelPlanCheckout({ id: fixture.accountId, email: buyer }, "vector-10", fakes.fetcher, at),
      ).rejects.toMatchObject({ statusCode: 403, code: "MODEL_PLAN_BLOCKED" })
      expect(fakes.stripe.calls).toEqual([])
      expect(fakes.store.get(codiumKey("funding", "reserved"))).toBeUndefined()
      expect(JSON.parse(fakes.store.get(accountKey(fixture.accountId))!)).not.toHaveProperty("checkout")
    }
  })
})

// ── The governing subscription ─────────────────────────────────────────────────────────────────────────────────

describe("the governing subscription", () => {
  test("a paid plan governs over a better plan that is past due, and an unpaid upgrade supersedes nothing", () => {
    const now = (loadStripeFixture("paused-past-due").now + 60) * 1000
    const pastDue = loadStripeFixture("paused-past-due")
    const paid = loadStripeFixture("active-paid")
    const expand = (fixture: StripeFixture, index = 0) => {
      const fakes = codiumFakes()
      fakes.stripe.load(fixture.objects)
      const subscription = structuredClone(fixture.objects.subscriptions![index]!)
      const invoice = structuredClone(fakes.stripe.objects.invoices.get(String(subscription.latest_invoice))!)
      invoice.charge = fakes.stripe.objects.charges.get(String(invoice.charge)) ?? null
      invoice.payment_intent = fakes.stripe.objects.payment_intents.get(String(invoice.payment_intent)) ?? null
      return { ...subscription, latest_invoice: invoice }
    }
    const id = pastDue.accountId
    const failing = subscriptionStanding(expand(pastDue), id, now)!
    const plus = subscriptionStanding(expand(paid), id, now)!
    expect(failing).toMatchObject({ state: "paused", plan: "vector-50" })
    expect(plus).toMatchObject({ state: "active", plan: "vector-10" })
    expect(governingStanding([failing, plus])).toEqual({ governing: plus, duplicates: [failing.id] })
    // An upgrade still incomplete names what it would supersede, but has not superseded it.
    const pending = { ...plus, id: "sub_pending_upgrade", plan: "vector-200" as const, state: "none" as const }
    expect(governingStanding([{ ...pending, supersedes: plus.id }, plus]).governing).toBe(plus)
    // Another account's subscription is not this account's plan at all.
    expect(subscriptionStanding(expand(paid), "someone-else", now)).toBeUndefined()
  })
})

// ── Payment history ────────────────────────────────────────────────────────────────────────────────────────────

/** A paid month on `plan` for `start`..`end` (seconds), built from the active-paid fixture's objects. */
function paidMonth(
  fakes: CodiumFakes,
  options: { subscription: string; plan: 10 | 50 | 100 | 200; start: number; end: number; paidAt: number },
) {
  const template = loadStripeFixture("active-paid").objects
  const suffix = `${options.subscription.slice(4)}${options.start}`
  const price = {
    ...structuredClone(
      (template.subscriptions![0]!.items as { data: { price: Record<string, unknown> }[] }).data[0]!.price,
    ),
    id: `price_codium${options.plan}`,
    unit_amount: options.plan * 100,
    unit_amount_decimal: String(options.plan * 100),
  }
  const subscription = structuredClone(template.subscriptions![0]!) as Record<string, any>
  Object.assign(subscription, {
    id: options.subscription,
    current_period_start: options.start,
    current_period_end: options.end,
    latest_invoice: `in_${suffix}`,
  })
  subscription.items.data[0].price = price
  subscription.metadata = {
    ...subscription.metadata,
    vector_plan: `vector-${options.plan}`,
    vector_model_credits_usd: FIXTURE_CREDITS[options.plan],
  }
  const invoice = structuredClone(template.invoices![0]!) as Record<string, any>
  Object.assign(invoice, {
    id: `in_${suffix}`,
    subscription: options.subscription,
    amount_due: options.plan * 100,
    amount_paid: options.plan * 100,
    charge: `ch_${suffix}`,
    payment_intent: `pi_${suffix}`,
    status_transitions: { ...invoice.status_transitions, paid_at: options.paidAt },
  })
  invoice.lines.data[0] = { ...invoice.lines.data[0], price, period: { start: options.start, end: options.end } }
  const charge = { ...structuredClone(template.charges![0]!), id: `ch_${suffix}`, amount: options.plan * 100 }
  const intent = { ...structuredClone(template.payment_intents![0]!), id: `pi_${suffix}` }
  fakes.stripe.objects.subscriptions.clear()
  fakes.stripe.load({
    subscriptions: [subscription],
    invoices: [invoice],
    charges: [charge],
    payment_intents: [intent],
  })
}

describe("payment history: firstPaidAt, firstHighPaidAt, memberSince", () => {
  test("Plus starts the history, an upgrade to Ultra starts the high-value one, a later Max month keeps it, Pro ends the run", async () => {
    const fixture = loadStripeFixture("none-no-subscription")
    const fakes = seed(fixture)
    const id = fixture.accountId
    const t0 = fixture.now
    const month = 30 * 86_400
    const step = async (plan: 10 | 50 | 100 | 200, start: number, subscription = "sub_history") => {
      paidMonth(fakes, { subscription, plan, start, end: start + month, paidAt: start + 60 })
      return reconcileModelPlanAccount(id, fakes.fetcher, (start + 120) * 1000)
    }
    const plus = await step(10, t0)
    expect(plus).toMatchObject({ state: "active", plan: "vector-10", firstPaidAt: (t0 + 60) * 1000 })
    expect(plus.firstHighPaidAt).toBeUndefined()
    expect(plus.memberSince).toBeUndefined()
    expect(plus.ramp).toEqual({ hostedUntil: 0, browserFrom: 0 })

    const ultra = await step(200, t0 + 5 * 86_400, "sub_upgrade")
    expect(ultra).toMatchObject({
      plan: "vector-200",
      firstPaidAt: (t0 + 60) * 1000,
      firstHighPaidAt: (t0 + 5 * 86_400 + 60) * 1000,
      memberSince: (t0 + 5 * 86_400) * 1000,
    })
    // The trust ramp runs from that payment: a quarter of the hours, one computer, two-hour jobs, browser a day later.
    expect(ultra.ramp.hostedUntil).toBe(ultra.firstHighPaidAt! + 7 * DAY)
    expect(ultra.ramp.browserFrom).toBe(ultra.firstHighPaidAt! + DAY)
    expect(ultra.caps.hosted).toMatchObject({ hours: 15, computers: 1, jobMin: 120, sizes: ["standard", "large"] })

    const max = await step(100, t0 + 35 * 86_400, "sub_upgrade")
    expect(max).toMatchObject({ firstHighPaidAt: ultra.firstHighPaidAt, memberSince: ultra.memberSince })
    // A week on, the ramp is over.
    expect(max.caps.hosted).toEqual(ENTITLEMENTS["vector-100"].hosted)

    const pro = await step(50, t0 + 65 * 86_400, "sub_upgrade")
    expect(pro.firstHighPaidAt).toBe(ultra.firstHighPaidAt!)
    expect(pro.memberSince).toBeUndefined()

    // More than 14 days without a paid period restarts the high-value history.
    const back = await step(100, t0 + 95 * 86_400 + 15 * 86_400, "sub_return")
    expect(back.firstHighPaidAt).toBe((t0 + 110 * 86_400 + 60) * 1000)
    expect(back.memberSince).toBe((t0 + 110 * 86_400) * 1000)
    expect((await storedAccount(fakes, id))?.paidThrough).toBe((t0 + 110 * 86_400 + month) * 1000)
  })
})

// ── The snapshot write ─────────────────────────────────────────────────────────────────────────────────────────

describe("the snapshot write", () => {
  test("writes the snapshot, its outbox items, the status-cache clear, the index and sales-opened-at in one EVAL", async () => {
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    const id = fixture.accountId
    const now = fixture.now * 1000
    fakes.store.set(codiumKey("status", id), "{}")
    const seen: string[] = []
    const off = onEntitlementChange((change) => {
      seen.push(`${change.cause}:${change.to.version}`)
      return [{ id: `test-provisioner:${id}:${change.to.version}`, payload: { version: change.to.version } }]
    })
    try {
      await reconcileModelPlanAccount(id, fakes.fetcher, now)
      // A recheck that finds nothing new tells no one and queues nothing.
      await reconcileModelPlanAccount(id, fakes.fetcher, now + 60_000)
    } finally {
      off()
    }
    expect(seen).toEqual(["first_payment:1"])
    const writes = fakes.store.commands.filter(
      (command) => command[0] === "EVAL" && command[1] === SNAPSHOT_SCRIPTS.WRITE,
    )
    expect(writes).toHaveLength(2)
    // From WP A06 on, every configured provisioner (here only github-runs) has its own item in the same EVAL.
    expect(writes[0]!.slice(3, 3 + Number(writes[0]![2]))).toEqual([
      codiumKey("ent", id),
      codiumKey("status", id),
      codiumKey("idx", "period-end"),
      codiumKey("sales-opened-at"),
      codiumKey("outbox"),
      codiumKey("outbox", "item", `github-runs:${id}:1`),
      codiumKey("outbox", "item", `test-provisioner:${id}:1`),
    ])
    expect(JSON.parse(fakes.store.get(codiumKey("outbox", "item", `test-provisioner:${id}:1`))!)).toEqual({
      version: 1,
    })
    expect(fakes.store.get(codiumKey("status", id))).toBeUndefined()
    expect(fakes.store.zset(codiumKey("idx", "period-end")).get(id)).toBe(
      loadStripeFixture("active-paid").expect.periodEnd * 1000,
    )
    // sales-opened-at is set by the first paid reconcile only.
    expect(fakes.store.get(codiumKey("sales-opened-at"))).toBe(String(now))
  })

  test("sales-opened-at is never set by an unpaid account and never moved by a later one", async () => {
    const none = seed(loadStripeFixture("none-incomplete"))
    await reconcileModelPlanAccount(loadStripeFixture("none-incomplete").accountId, none.fetcher, none.clock.now)
    expect(none.store.get(codiumKey("sales-opened-at"))).toBeUndefined()
    expect(none.store.zset(codiumKey("idx", "period-end")).size).toBe(0)

    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    fakes.store.set(codiumKey("sales-opened-at"), "1700000000000")
    await reconcileModelPlanAccount(fixture.accountId, fakes.fetcher, fixture.now * 1000)
    expect(fakes.store.get(codiumKey("sales-opened-at"))).toBe("1700000000000")
  })

  test("a renewal is a new version with a new meter epoch; an older version never overwrites a newer one", async () => {
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    const id = fixture.accountId
    const first = await reconcileModelPlanAccount(id, fakes.fetcher, fixture.now * 1000)
    const start = fixture.expect.periodEnd
    paidMonth(fakes, { subscription: "sub_active", plan: 10, start, end: start + 30 * 86_400, paidAt: start + 60 })
    const renewed = await reconcileModelPlanAccount(id, fakes.fetcher, (start + 600) * 1000)
    expect(renewed).toMatchObject({ version: 2, meterEpoch: `sub_active:${start * 1000}`, state: "active" })
    expect(renewed.meterEpoch).not.toBe(first.meterEpoch)
    expect(transitionCause(first, renewed)).toBe("renewal")
    // A write that carries an older version than the one stored is refused by the script, even with a later checkedAt.
    const late = (start + 660) * 1000
    const { written } = await writeSnapshot({ ...first, checkedAt: late }, undefined, fakes.fetcher, late)
    expect(written).toBe(false)
    expect(await readSnapshot(id, fakes.fetcher)).toEqual(renewed)
  })

  test("a snapshot from the other Stripe mode is refused when read, and replaced by the next reconcile", async () => {
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    const id = fixture.accountId
    const live = await reconcileModelPlanAccount(id, fakes.fetcher, fixture.now * 1000)
    fakes.store.set(snapshotKey(id), JSON.stringify({ ...live, livemode: true, version: 7 }))
    await expect(readEntitlement(id, fakes.fetcher, fixture.now * 1000)).rejects.toMatchObject({
      statusCode: 503,
      code: "MODEL_PLANS_CONFIGURATION",
    })
    const rewritten = await reconcileModelPlanAccount(id, fakes.fetcher, fixture.now * 1000 + 1000)
    expect(rewritten).toMatchObject({ livemode: false, version: 8 })
  })

  test("transition causes", () => {
    const facts = (value: Partial<SnapshotFacts>): SnapshotFacts => ({
      account: "a",
      state: "active",
      plan: "vector-10",
      subscription: "sub_1",
      periodStart: 1000,
      periodEnd: 2000,
      cancelAtPeriodEnd: false,
      source: "webhook",
      ...value,
    })
    const at = (value: Partial<SnapshotFacts>) => buildSnapshot(facts(value), undefined, 1500)
    expect(transitionCause(undefined, at({}))).toBe("first_payment")
    expect(transitionCause(at({}), at({ plan: "vector-200", subscription: "sub_2" }))).toBe("upgrade")
    expect(transitionCause(at({ plan: "vector-100" }), at({ plan: "vector-50", periodStart: 2000 }))).toBe("downgrade")
    expect(transitionCause(at({}), at({ cancelAtPeriodEnd: true }))).toBe("cancel_scheduled")
    expect(transitionCause(at({}), at({ state: "paused", reason: "payment_failed" }))).toBe("payment_failed")
    expect(transitionCause(at({ state: "paused", reason: "payment_failed" }), at({}))).toBe("payment_recovered")
    expect(transitionCause(at({ state: "frozen", reason: "disputed" }), at({}))).toBe("dispute_won")
    expect(transitionCause(at({}), at({ state: "frozen", reason: "early_fraud_warning" }))).toBe("early_fraud_warning")
    expect(transitionCause(at({}), at({ state: "ended", reason: "refunded" }))).toBe("refunded")
    expect(transitionCause(at({}), at({ state: "ended", reason: "canceled" }))).toBe("ended")
    expect(transitionCause(at({}), at({ state: "ended", reason: "closing" }))).toBe("closing")
    expect(transitionCause(at({}), at({ state: "renewing" }))).toBe("renewal")
  })
})

// ── Read rules and M4 ──────────────────────────────────────────────────────────────────────────────────────────

describe("read rules and M4: no Stripe call on a hot path", () => {
  test("with a fresh snapshot, reads and entitlement checks make no Stripe or OpenRouter call", async () => {
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    const id = fixture.accountId
    const now = fixture.now * 1000
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    fakes.stripe.calls.length = 0
    fakes.openRouter.calls.length = 0
    const later = now + 5 * HOUR
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        index % 2
          ? readEntitlement(id, fakes.fetcher, later)
          : requireEntitlement(id, "cloudAgents", fakes.fetcher, later),
      ),
    )
    expect(fakes.stripe.calls).toEqual([])
    expect(fakes.openRouter.calls).toEqual([])
  })

  test("a hundred requests at the period's end make one Stripe call, then none for a minute", async () => {
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    const id = fixture.accountId
    await reconcileModelPlanAccount(id, fakes.fetcher, fixture.now * 1000)
    fakes.stripe.calls.length = 0
    const end = fixture.expect.periodEnd * 1000
    fakes.clock.now = end + 10_000
    const answers = await Promise.all(
      Array.from({ length: 100 }, () => readEntitlement(id, fakes.fetcher, end + 10_000)),
    )
    expect(fakes.stripe.calls).toHaveLength(1)
    // Everyone was served: the stale snapshot, or the renewing one the single reconcile wrote.
    expect(new Set(answers.map((value) => value?.state))).toEqual(new Set(["active", "renewing"]))
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ state: "renewing", periodEnd: end })
    // A renewing snapshot is rechecked at most once a minute.
    fakes.clock.now = end + 40_000
    await Promise.all(Array.from({ length: 20 }, () => requireEntitlement(id, "codium", fakes.fetcher, end + 40_000)))
    expect(fakes.stripe.calls).toHaveLength(1)
    fakes.clock.now = end + 75_000
    await Promise.all(Array.from({ length: 20 }, () => readEntitlement(id, fakes.fetcher, end + 75_000)))
    expect(fakes.stripe.calls).toHaveLength(2)
  })

  test("an account without a plan makes at most one Stripe call a minute; one without a record makes none", async () => {
    const fixture = loadStripeFixture("none-no-subscription")
    const fakes = seed(fixture)
    const id = fixture.accountId
    const t = fixture.now * 1000
    for (const offset of [0, 1_000, 30_000, 59_000]) {
      fakes.clock.now = t + offset
      await expect(requireEntitlement(id, "codium", fakes.fetcher, t + offset)).rejects.toMatchObject({
        statusCode: 402,
        code: "MODEL_PLAN_REQUIRED",
      })
    }
    expect(fakes.stripe.calls).toHaveLength(1)
    fakes.clock.now = t + 61_000
    await Promise.all(Array.from({ length: 20 }, () => readEntitlement(id, fakes.fetcher, t + 61_000)))
    expect(fakes.stripe.calls).toHaveLength(2)

    const stranger = "no-record-at-all"
    for (const offset of [0, 61_000, 122_000]) {
      fakes.clock.now = t + offset
      expect(await readEntitlement(stranger, fakes.fetcher, t + offset)).toMatchObject({ state: "none" })
    }
    expect(fakes.stripe.calls).toHaveLength(2)
  })

  test("a stale snapshot is served as it is when Stripe cannot be read; a missing one fails closed", async () => {
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    const id = fixture.accountId
    const first = await reconcileModelPlanAccount(id, fakes.fetcher, fixture.now * 1000)
    fakes.stripe.fail = () => Response.json({ error: { message: "outage" } }, { status: 500 })
    const later = fixture.now * 1000 + 7 * HOUR
    fakes.clock.now = later
    expect(await readEntitlement(id, fakes.fetcher, later)).toEqual(first)
    fakes.store.remove(snapshotKey(id))
    fakes.store.remove(codiumKey("reconcile", id))
    await expect(readEntitlement(id, fakes.fetcher, later)).rejects.toMatchObject({ code: "BILLING_UPSTREAM" })
  })

  test("a first snapshot another request is still writing answers RENEWING to a paying account, never a final 402", async () => {
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    const id = fixture.accountId
    const now = fixture.now * 1000
    // Checkout made the account's record. Another request holds this minute's reconcile and has not written the first
    // snapshot (Stripe, key creation and genesis can take longer than the 2 s a request waits for it).
    fakes.store.set(codiumKey("reconcile", id), String(now))
    await expect(requireEntitlement(id, "codium", fakes.fetcher, now)).rejects.toMatchObject({
      statusCode: 503,
      code: "MODEL_PLAN_RENEWING",
      retryAfterSeconds: 1,
    })
    // A pool producer reads the same snapshot by the same rules, and gets the same retryable answer.
    await expect(holdPool(id, 1, HOUR, "hosted", { fetcher: fakes.fetcher, clock: () => now })).rejects.toMatchObject({
      statusCode: 503,
      code: "MODEL_PLAN_RENEWING",
    })
    expect(fakes.stripe.calls).toEqual([])
    // An account without a Codium record has no plan to wait for: its final answer stands.
    const stranger = "22222222-2222-4222-8222-222222222222"
    fakes.store.set(codiumKey("reconcile", stranger), String(now))
    await expect(requireEntitlement(stranger, "codium", fakes.fetcher, now)).rejects.toMatchObject({
      statusCode: 402,
      code: "MODEL_PLAN_REQUIRED",
    })
    // Once the first snapshot is written, the paying account is served from it.
    fakes.store.remove(codiumKey("reconcile", id))
    expect((await requireEntitlement(id, "codium", fakes.fetcher, now)).state).toBe("active")
  })

  test("reconcileOnDemand runs once a minute per account", async () => {
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    const id = fixture.accountId
    const now = fixture.now * 1000
    expect(await reconcileOnDemand(id, fakes.fetcher, now)).toMatchObject({ state: "active", source: "request" })
    expect(await reconcileOnDemand(id, fakes.fetcher, now + 1_000)).toBeUndefined()
    fakes.clock.now = now + 60_001
    expect(await reconcileOnDemand(id, fakes.fetcher, now + 60_001)).toMatchObject({ state: "active" })
  })

  test("isStale: a minute for none and renewing, six hours otherwise, and an active one past its period", () => {
    const base = buildSnapshot(
      {
        account: "a",
        state: "active",
        plan: "vector-10",
        subscription: "sub_1",
        periodStart: 0,
        periodEnd: 10 * DAY,
        cancelAtPeriodEnd: false,
        source: "webhook",
      },
      undefined,
      DAY,
    )
    expect(isStale(base, DAY + 6 * HOUR)).toBe(false)
    expect(isStale(base, DAY + 6 * HOUR + 1)).toBe(true)
    expect(isStale({ ...base, checkedAt: 10 * DAY - 1 }, 10 * DAY)).toBe(true)
    for (const state of ["none", "renewing"] as const) {
      expect(isStale({ ...base, state }, DAY + 59_999)).toBe(false)
      expect(isStale({ ...base, state }, DAY + 60_000)).toBe(true)
    }
    // Paused, ended and frozen snapshots written by reconcile are trusted past their period, until six hours old.
    for (const state of ["paused", "ended", "frozen"] as const) {
      expect(isStale({ ...base, state, checkedAt: 11 * DAY }, 11 * DAY + HOUR)).toBe(false)
      expect(isStale({ ...base, state, checkedAt: 11 * DAY }, 11 * DAY + 6 * HOUR + 1)).toBe(true)
    }
  })
})

// ── requireEntitlement ─────────────────────────────────────────────────────────────────────────────────────────

describe("requireEntitlement", () => {
  const account = "6a1d0c4e-5b2f-4e8a-9c3d-7f1e2a3b4c5d"

  async function stored(value: Partial<SnapshotFacts>, now = Date.now()) {
    const fakes = codiumFakes({ now })
    const snapshot = buildSnapshot(
      {
        account,
        state: "active",
        plan: "vector-50",
        subscription: "sub_req",
        periodStart: now - DAY,
        periodEnd: now + 20 * DAY,
        cancelAtPeriodEnd: false,
        source: "webhook",
        ...value,
      },
      undefined,
      now,
    )
    await writeSnapshot(snapshot, undefined, fakes.fetcher, now)
    return {
      fakes,
      snapshot,
      check: (perk: Parameters<typeof requireEntitlement>[1], at = now) =>
        requireEntitlement(account, perk, fakes.fetcher, at),
    }
  }

  test("refuses by state with the contract's codes, and passes active and renewing within grace", async () => {
    expect((await (await stored({})).check("codium")).state).toBe("active")
    await expect((await stored({ state: "none", plan: null })).check("codium")).rejects.toMatchObject({
      statusCode: 402,
      code: "MODEL_PLAN_REQUIRED",
    })
    await expect((await stored({ state: "ended", reason: "canceled" })).check("codium")).rejects.toMatchObject({
      statusCode: 402,
      code: "MODEL_PLAN_REQUIRED",
      detail: { reason: "canceled" },
    })
    await expect((await stored({ state: "ended", reason: "closing" })).check("codium")).rejects.toMatchObject({
      statusCode: 409,
      code: "MODEL_PLAN_ACCOUNT_CLOSING",
    })
    for (const [reason, action] of [
      ["payment_failed", "update-card"],
      ["action_required", "confirm-payment"],
      ["payment_pending", "update-card"],
    ] as const)
      await expect((await stored({ state: "paused", reason })).check("codium")).rejects.toMatchObject({
        statusCode: 402,
        code: "MODEL_PLAN_PAYMENT_REQUIRED",
        detail: { reason, action },
      })
    for (const reason of ["disputed", "early_fraud_warning", "owner"] as const)
      await expect((await stored({ state: "frozen", reason })).check("codium")).rejects.toMatchObject({
        statusCode: 403,
        code: "MODEL_PLAN_BLOCKED",
        detail: { reason },
      })

    // Renewing serves the previous period's caps until its grace (120 minutes) runs out, then asks for a retry.
    const now = Date.now()
    const renewing = await stored({ state: "renewing", periodStart: now - 30 * DAY, periodEnd: now - HOUR }, now)
    expect((await renewing.check("codium")).state).toBe("renewing")
    const late = await stored({ state: "renewing", periodStart: now - 31 * DAY, periodEnd: now - 2 * HOUR - 1 }, now)
    await expect(late.check("codium")).rejects.toMatchObject({
      statusCode: 503,
      code: "MODEL_PLAN_RENEWING",
      retryAfterSeconds: 30,
    })
  })

  test("a perk the plan lacks is 403 CODIUM_PERK_REQUIRED naming the cheapest plan that has it", async () => {
    const pro = await stored({ plan: "vector-50" })
    await expect(pro.check("hosted")).rejects.toMatchObject({
      statusCode: 403,
      code: "CODIUM_PERK_REQUIRED",
      detail: { perk: "hosted", plan: "vector-100" },
    })
    expect((await pro.check("vault")).plan).toBe("vector-50")
    expect((await pro.check("secondOpinion")).plan).toBe("vector-50")
    await expect((await stored({ plan: "vector-10" })).check("vault")).rejects.toMatchObject({
      detail: { perk: "vault", plan: "vector-50" },
    })
    // Velocity and Labs are "Coming" on every plan: nothing to use yet, and no plan to name.
    const ultra = await stored({ plan: "vector-200" })
    expect((await ultra.check("hosted")).plan).toBe("vector-200")
    await expect(ultra.check("velocity")).rejects.toMatchObject({
      code: "CODIUM_PERK_REQUIRED",
      detail: { perk: "velocity" },
    })
    await expect(ultra.check("labs")).rejects.toMatchObject({ detail: { perk: "labs" } })
    expect(cheapestPlanWith("cloudAgents")).toBe("vector-10")
    expect(cheapestPlanWith("vote")).toBe("vector-100")
    expect(cheapestPlanWith("nominate")).toBe("vector-200")
    expect(cheapestPlanWith("velocity")).toBeUndefined()
    expect(includes(ENTITLEMENTS["vector-200"], "dailyShare")).toBe(true)
  })

  test("the error body carries the detail and the retry-after header, never replacing code or message", () => {
    const headers = new Map<string, string>()
    let body = ""
    const response = {
      statusCode: 0,
      setHeader: (name: string, value: string) => headers.set(name, value),
      end: (value: string) => {
        body = value
      },
    } as unknown as ApiResponse
    handleApiError(
      response,
      new ApiError(503, "MODEL_PLAN_RENEWING", "Renewing.", {
        detail: { reason: "x", code: "SPOOFED" },
        retryAfterSeconds: 30,
      }),
    )
    expect(response.statusCode).toBe(503)
    expect(headers.get("retry-after")).toBe("30")
    expect(JSON.parse(body)).toEqual({ error: { reason: "x", code: "MODEL_PLAN_RENEWING", message: "Renewing." } })
  })
})

// ── Meters ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("meterAdd", () => {
  test("adds atomically within the cap, keyed by the period's epoch, kept 40 days past the period", async () => {
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    const snapshot = await reconcileModelPlanAccount(fixture.accountId, fakes.fetcher, fixture.now * 1000)
    const results = await Promise.all(
      Array.from({ length: 10 }, () => meterAdd(snapshot, "cloud-agent-runs", 1, 5, fakes.fetcher)),
    )
    expect(results.filter((value) => value.ok)).toHaveLength(5)
    expect(await meterAdd(snapshot, "cloud-agent-runs", 0, 5, fakes.fetcher)).toEqual({ ok: true, used: 5 })
    const key = meterKey(snapshot, "cloud-agent-runs")
    expect(key).toBe(`vector:codium:test:meter:${fixture.accountId}:${snapshot.meterEpoch}:cloud-agent-runs`)
    expect(fakes.store.expires.get(key)).toBe(snapshot.periodEnd + 40 * DAY)
    // The next period's epoch starts from nothing.
    const next = { ...snapshot, meterEpoch: `${snapshot.subscription}:${snapshot.periodEnd}` }
    expect(await meterAdd(next, "cloud-agent-runs", 2, 5, fakes.fetcher)).toEqual({ ok: true, used: 2 })
    await expect(meterAdd(snapshot, "cloud-agent-runs", 0.5, 5, fakes.fetcher)).rejects.toMatchObject({
      code: "CODIUM_METER_INVALID",
    })
    const none = buildSnapshot(
      {
        account: "x",
        state: "none",
        plan: null,
        periodStart: 0,
        periodEnd: 0,
        cancelAtPeriodEnd: false,
        source: "request",
      },
      undefined,
      Date.now(),
    )
    expect(await meterAdd(none, "cloud-agent-runs", 1, 5, fakes.fetcher)).toEqual({ ok: false, used: 0 })
  })
})

// ── The scripts on a real Valkey (CI) ──────────────────────────────────────────────────────────────────────────

const valkeyURL = process.env.VECTOR_TEST_REDIS_URL

describe.skipIf(!valkeyURL)("the snapshot's Lua on Valkey", () => {
  const client = valkeyURL ? new RedisClient(valkeyURL) : undefined
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body)) as (string | number)[]
    return Response.json({ result: (await client!.send(String(command[0]), command.slice(1).map(String))) ?? null })
  }) as typeof fetch
  beforeEach(async () => {
    await client!.send("FLUSHDB", [])
  })

  test("WRITE: version guard, status clear, index, sales-opened-at NX and outbox items in one step", async () => {
    const now = Date.now()
    const facts: SnapshotFacts = {
      account: "valkey-account",
      state: "active",
      plan: "vector-100",
      subscription: "sub_valkey",
      periodStart: now - DAY,
      periodEnd: now + 29 * DAY,
      cancelAtPeriodEnd: false,
      source: "webhook",
    }
    await client!.send("SET", [codiumKey("status", facts.account), "{}"])
    const off = onEntitlementChange((change) => [{ id: `p:${change.to.version}`, payload: { v: change.to.version } }])
    try {
      const first = buildSnapshot(facts, undefined, now)
      expect((await writeSnapshot(first, undefined, fetcher, now)).written).toBe(true)
      expect(await readSnapshot(facts.account, fetcher)).toEqual(first)
      expect(await client!.send("EXISTS", [codiumKey("status", facts.account)])).toBe(0)
      expect(Number(await client!.send("ZSCORE", [codiumKey("idx", "period-end"), facts.account]))).toBe(
        facts.periodEnd,
      )
      expect(await client!.send("GET", [codiumKey("sales-opened-at")])).toBe(String(now))
      // The configured provisioners' items (WP A06: github-runs) are written with the listener's, at the same score.
      expect(await client!.send("ZRANGE", [codiumKey("outbox"), "0", "-1"])).toEqual([
        "github-runs:valkey-account:1",
        "p:1",
      ])
      expect(await client!.send("GET", [codiumKey("outbox", "item", "p:1")])).toBe('{"v":1}')

      const ended = buildSnapshot({ ...facts, state: "ended", reason: "canceled" }, first, now + 1000)
      expect((await writeSnapshot(ended, first, fetcher, now + 1000)).written).toBe(true)
      expect(await client!.send("GET", [codiumKey("sales-opened-at")])).toBe(String(now))
      expect(await client!.send("ZSCORE", [codiumKey("idx", "period-end"), facts.account])).toBeNull()
      // An older version never overwrites a newer one.
      expect((await writeSnapshot(first, undefined, fetcher, now + 2000)).written).toBe(false)
      expect(await readSnapshot(facts.account, fetcher)).toEqual(ended)
      expect(Number(await client!.send("PTTL", [codiumKey("ent", facts.account)]))).toBe(-1)

      // A `none` snapshot lapses after a week.
      const none = buildSnapshot({ ...facts, account: "valkey-none", state: "none", plan: null }, undefined, now)
      expect((await writeSnapshot(none, undefined, fetcher, now)).written).toBe(true)
      const ttl = Number(await client!.send("PTTL", [codiumKey("ent", "valkey-none")]))
      expect(ttl).toBeGreaterThan(NONE_SNAPSHOT_KEEP_MS - 60_000)
      expect(ttl).toBeLessThanOrEqual(NONE_SNAPSHOT_KEEP_MS)
    } finally {
      off()
    }
  })

  test("METER_ADD: never passes the cap under parallel adds, and expires 40 days after the period", async () => {
    const key = codiumKey("meter", "valkey-account", "sub_valkey:1", "runs")
    const results = await Promise.all(
      Array.from({ length: 12 }, () => runMeterAdd(key, 1, 7, Date.now() + DAY, fetcher)),
    )
    expect(results.filter((value) => value?.ok)).toHaveLength(7)
    expect(await runMeterAdd(key, 0, 7, Date.now() + DAY, fetcher)).toEqual({ ok: true, used: 7 })
    expect(Number(await client!.send("PTTL", [key]))).toBeGreaterThan(DAY - 60_000)
  })
})

function rankPrice(plan: string | null) {
  return ({ "vector-10": 10, "vector-50": 50, "vector-100": 100, "vector-200": 200 } as const)[plan as PlanId]
}
