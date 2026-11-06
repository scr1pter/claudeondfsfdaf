import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test"
import { createHmac } from "node:crypto"
import { Readable } from "node:stream"
import { requireEntitlement } from "../api/_lib/codium-entitlements"
import { codiumKey } from "../api/_lib/codium-keys"
import { drainOutbox, OUTBOX_SCRIPTS, registerAction } from "../api/_lib/codium-provision"
import { finalizeRenewal, RENEWAL_REFUSALS } from "../api/_lib/codium-renewal"
import { PRIORITY_LEAD_MS, readSnapshot } from "../api/_lib/codium-snapshot"
import { readSwitch, switchKey } from "../api/_lib/codium-switches"
import type { ApiRequest, ApiResponse } from "../api/_lib/http"
import {
  holdPool,
  keyExpiresAt,
  modelPlanCredential,
  modelPlanStatus,
  protectModelPlanKey,
  readModelPlanAccount,
  reconcileModelPlanAccount,
} from "../api/_lib/model-plan-account"
import { MODEL_PLAN_WEBHOOK_EVENTS, modelPlanStripe } from "../api/_lib/model-plan-stripe"
import "../api/model-plans/outbox"
import webhook, {
  EVENT_DONE_KEEP_MS,
  eventDoneKey,
  handleModelPlanEvent,
  reconcileModelPlanEvent,
  routedEvent,
} from "../api/model-plans/webhook"
import {
  codiumFakes,
  codiumTestEnvironment,
  loadStripeFixture,
  type CodiumFakes,
  type StripeFixture,
} from "../packages/web/test/fixture/codium-fakes"

// WP A07: the webhook's order and event list (contract §4.5), renewals (§4.4 "Renewal") and the invariants they own:
// M5 (access ends when payment ends, within one notification), M7 (no renewal charge Vector should not take) and M11 (a
// renewal never locks out someone who pays). Stripe, OpenRouter, the store and the owner's email are the in-memory fakes
// of packages/web/test/fixture/codium-fakes.ts; nothing here reaches a real service.

const SECRET = "whsec_codium_renewal_fixture"
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const GRACE = 120 * MINUTE
const SEEDED = "fixture_key_seeded"
const OWNER_EMAIL = {
  RESEND_API_KEY: "re_codium_fixture",
  VECTOR_PURCHASE_EMAIL_FROM: "Vector <alerts@example.test>",
  CODIUM_OWNER_EMAIL: "owner@example.test",
}

let restore = () => {}
beforeEach(() => {
  restore = codiumTestEnvironment({ STRIPE_MODEL_PLAN_WEBHOOK_SECRET: SECRET })
})
afterEach(() => {
  restore()
  setSystemTime()
})

/** The fakes holding a fixture's Stripe objects, its account record, and the key Codium made for its period, if any. */
function seed(fixture: StripeFixture, options: { now?: number } = {}) {
  const fakes = codiumFakes({ now: options.now ?? fixture.now * 1000 })
  fakes.stripe.load(fixture.objects)
  const record: Record<string, unknown> = { ...fixture.account }
  if (fixture.key) {
    const { subscription, start, end } = fixture.key
    const owner = fixture.objects.subscriptions?.find((value) => value.id === subscription)
    const credits = Number((owner?.metadata as Record<string, string>).vector_model_credits_usd)
    // These fixtures begin with an already provisioned high-tier month, so its first-payment cohort predates
    // the renewal under test. First-payment pool ramps are covered separately in codium-risk.test.ts.
    record.firstPaidAt = start * 1000
    record.firstHighPaidAt = start * 1000
    record.paidThrough = end * 1000
    record.highValueVerified = true
    // As provisioning makes it since WP A07: expiring at the period's end plus the renewal grace.
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
      spendGenesis: fakes.store.seedSpendGenesis({
        account: fixture.accountId,
        pool: SEEDED,
        subscription,
        start,
        end,
      }),
    }
  }
  fakes.store.set(codiumKey("account", fixture.accountId), JSON.stringify(record))
  return fakes
}

/** A funding reading taken at `at`: the OpenRouter balance and what is owed, in cents. */
function funding(fakes: CodiumFakes, at: number, balance = 1_000_000, owed = 0) {
  fakes.store.set(
    codiumKey("funding"),
    JSON.stringify({
      status: "open",
      checkedAt: at,
      since: at,
      balance,
      owed,
      reserved: 0,
      required: 0,
      keys: 0,
    }),
  )
}

const event = (type: string, object: Record<string, unknown>, id = `evt_${type.replaceAll(".", "_")}`) => ({
  id,
  type,
  livemode: false,
  data: { object },
})

const writes = (fakes: CodiumFakes) => fakes.stripe.calls.filter((call) => call.method !== "GET")
const outboxIds = (fakes: CodiumFakes) => fakes.store.command(["ZRANGE", codiumKey("outbox"), 0, -1]) as string[]
const outboxRecord = (fakes: CodiumFakes, id: string) =>
  JSON.parse(fakes.store.get(codiumKey("outbox", "item", id)) ?? "null") as Record<string, unknown> | null

function sign(raw: string, secret = SECRET, at = Math.floor(Date.now() / 1000)) {
  return `t=${at},v1=${createHmac("sha256", secret).update(`${at}.`).update(raw).digest("hex")}`
}

/** POSTs a raw notification to the route, as Stripe does, and answers its status and body. */
async function post(raw: string, signature: string, fetcher: typeof fetch) {
  const request = Object.assign(Readable.from([Buffer.from(raw)]), {
    method: "POST",
    headers: { "stripe-signature": signature },
  }) as unknown as ApiRequest
  let body = ""
  const response = {
    statusCode: 200,
    setHeader: () => {},
    end: (value?: string) => {
      body = String(value ?? "")
    },
  } as unknown as ApiResponse
  await webhook(request, response, fetcher)
  return { status: response.statusCode, body: JSON.parse(body) as Record<string, unknown> }
}

// ── The event list and the route ───────────────────────────────────────────────────────────────────────────────

describe("the webhook (contract §4.5)", () => {
  test("subscribes exactly the contract's 20 events and routes their families only", async () => {
    expect([...MODEL_PLAN_WEBHOOK_EVENTS]).toEqual([
      "checkout.session.completed",
      "checkout.session.expired",
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "invoice.created",
      "invoice.paid",
      "invoice.payment_failed",
      "invoice.payment_action_required",
      "invoice.finalization_failed",
      "charge.refunded",
      "charge.refund.updated",
      "charge.dispute.created",
      "charge.dispute.updated",
      "charge.dispute.closed",
      "charge.dispute.funds_reinstated",
      "radar.early_fraud_warning.created",
      "radar.early_fraud_warning.updated",
      "subscription_schedule.released",
      "subscription_schedule.canceled",
    ])
    for (const type of MODEL_PLAN_WEBHOOK_EVENTS) expect(routedEvent(type)).toBe(true)
    for (const type of [
      "payment_intent.succeeded",
      "customer.created",
      "radar.value_list.created",
      "invoiceitem.created",
    ])
      expect(routedEvent(type)).toBe(false)

    // A type outside them is acknowledged without asking Stripe anything.
    const fakes = codiumFakes()
    const outcome = await handleModelPlanEvent(
      event("payment_intent.succeeded", { id: "pi_other", customer: "cus_x" }),
      {
        fetcher: fakes.fetcher,
      },
    )
    expect(outcome).toEqual({ outcome: "ignored" })
    expect(fakes.stripe.calls).toEqual([])
  })

  test("a bad signature is refused with 400 before anything is read; a good one is handled and marked done", async () => {
    const fixture = loadStripeFixture("none-no-subscription")
    const fakes = seed(fixture)
    // The route reads the clock itself: Stripe's notification arrives at the fixture's moment.
    setSystemTime(new Date(fixture.now * 1000))
    const id = fixture.accountId
    const customer = String(fixture.account.customer)
    const raw = JSON.stringify(event("customer.subscription.updated", { id: "sub_x", customer }, "evt_signed"))

    for (const signature of [sign(raw, "whsec_someone_else"), "t=1,v1=00", "", sign(raw, SECRET, 1)]) {
      const refused = await post(raw, signature, fakes.fetcher)
      expect(refused).toEqual({
        status: 400,
        body: { error: { code: "WEBHOOK_SIGNATURE", message: "Invalid billing notification signature." } },
      })
    }
    expect(fakes.store.commands).toEqual([])
    expect(fakes.stripe.calls).toEqual([])

    expect(await post(raw, sign(raw), fakes.fetcher)).toEqual({ status: 200, body: { received: true } })
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ state: "none", source: "webhook" })
    const marker = eventDoneKey("evt_signed")
    expect(marker).toBe("vector:codium:test:stripe:event:evt_signed")
    expect(fakes.store.get(marker)).toBeDefined()
    expect(fakes.store.pttl(marker)).toBe(EVENT_DONE_KEEP_MS)
  })

  test("invoice.created queues finalize-renewal and answers 200, even with the store down", async () => {
    const fixture = loadStripeFixture("renewing-draft-invoice")
    const fakes = seed(fixture)
    // The route reads the clock itself: Stripe's notification arrives at the fixture's moment.
    setSystemTime(new Date(fixture.now * 1000))
    const invoice = fixture.objects.invoices!.find((value) => value.id === "in_renewal")!
    const raw = JSON.stringify(event("invoice.created", invoice, "evt_renewal_created"))

    expect(await post(raw, sign(raw), fakes.fetcher)).toEqual({ status: 200, body: { received: true } })
    expect(outboxIds(fakes)).toEqual(["finalize-renewal:in_renewal"])
    expect(outboxRecord(fakes, "finalize-renewal:in_renewal")).toMatchObject({
      kind: "finalize-renewal",
      key: "in_renewal",
      payload: { customer: fixture.account.customer },
    })
    expect(fakes.store.get(eventDoneKey("evt_renewal_created"))).toBeDefined()
    // The webhook itself asks Stripe nothing for a renewal: the action reads the invoice again.
    expect(fakes.stripe.calls).toEqual([])

    const down = seed(fixture)
    down.store.down = true
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(await post(raw, sign(raw), down.fetcher)).toEqual({ status: 200, body: { received: true } })
    } finally {
      warn.mockRestore()
    }
    expect(down.stripe.calls).toEqual([])
  })

  test("a reconcile that fails after acceptance is queued durably, answered 200, and runs from the outbox", async () => {
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    const id = fixture.accountId
    const now = fixture.now * 1000
    const invoice = fixture.objects.invoices!.at(-1)!
    // The route reads the clock itself: Stripe's notification arrives at the fixture's moment.
    setSystemTime(new Date(now))
    fakes.openRouter.fail = () => Response.json({ error: "outage" }, { status: 503 })
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const raw = JSON.stringify(event("invoice.paid", invoice, "evt_paid_failing"))
      // The route answers 200 because the work is stored; Stripe does not need to send it again.
      expect(await post(raw, sign(raw), fakes.fetcher)).toEqual({ status: 200, body: { received: true } })
    } finally {
      warn.mockRestore()
    }
    expect(outboxIds(fakes)).toEqual([`reconcile:${id}`])
    // In the priority lane.
    expect(Number(fakes.store.command(["ZSCORE", codiumKey("outbox"), `reconcile:${id}`]))).toBeLessThan(
      Date.now() - PRIORITY_LEAD_MS + 1,
    )
    // Not marked done: replay (WP A08) handles the event again too.
    expect(fakes.store.get(eventDoneKey("evt_paid_failing"))).toBeUndefined()
    expect(await readSnapshot(id, fakes.fetcher)).toBeUndefined()

    // OpenRouter is back: the queued reconcile runs from the outbox and grants the month.
    fakes.openRouter.fail = undefined
    expect(await drainOutbox({ fetcher: fakes.fetcher, now })).toMatchObject({ retried: 0, dead: 0 })
    expect(outboxIds(fakes)).toEqual([])
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ state: "active", source: "outbox" })
    expect([...fakes.openRouter.keys.values()]).toEqual([expect.objectContaining({ disabled: false, limit: 4 })])

    // The replayed event changes nothing more, and is marked done this time.
    expect(
      await handleModelPlanEvent(event("invoice.paid", invoice, "evt_paid_failing"), { fetcher: fakes.fetcher, now }),
    ).toEqual({
      outcome: "done",
      account: id,
    })
    expect(fakes.openRouter.keys.size).toBe(1)
    expect(fakes.store.get(eventDoneKey("evt_paid_failing"))).toBeDefined()
  })

  test("a reconcile slower than the budget is queued and answered in time", async () => {
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    const id = fixture.accountId
    let open = () => {}
    const gate = new Promise<void>((resolve) => (open = resolve))
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).startsWith("https://openrouter.ai/")) await gate
      return fakes.fetcher(input, init)
    }) as typeof fetch
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const started = Date.now()
    try {
      const outcome = await handleModelPlanEvent(event("invoice.paid", fixture.objects.invoices!.at(-1)!), {
        fetcher: slow,
        now: fixture.now * 1000,
        budgetMs: 50,
      })
      expect(outcome).toEqual({ outcome: "queued", account: id })
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(outboxIds(fakes)).toEqual([`reconcile:${id}`])
    } finally {
      open()
      // Let the reconcile that kept running finish and give its lease back.
      for (let tries = 0; tries < 100 && fakes.store.get(codiumKey("lease", id)) !== undefined; tries++)
        await Bun.sleep(10)
      warn.mockRestore()
    }
    expect(fakes.store.get(codiumKey("lease", id))).toBeUndefined()
  })

  test("when the reconcile cannot be queued either, or the account cannot be found, the answer is 500", async () => {
    const fixture = loadStripeFixture("active-paid")
    const invoice = fixture.objects.invoices!.at(-1)!
    const raw = JSON.stringify(event("invoice.paid", invoice, "evt_paid_lost"))
    // The route reads the clock itself: Stripe's notification arrives at the fixture's moment.
    setSystemTime(new Date(fixture.now * 1000))
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      // Reconcile fails, and so does the store's ENQUEUE.
      const fakes = seed(fixture)
      fakes.openRouter.fail = () => Response.json({ error: "outage" }, { status: 503 })
      const failing = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(init?.body ?? "").includes(JSON.stringify(OUTBOX_SCRIPTS.ENQUEUE).slice(1, 40)))
          return new Response("unavailable", { status: 503 })
        return fakes.fetcher(input, init)
      }) as typeof fetch
      expect(await post(raw, sign(raw), failing)).toEqual({
        status: 500,
        body: {
          error: {
            code: "WEBHOOK_RETRY",
            message: "The billing notification could not be handled now. Stripe will send it again.",
          },
        },
      })
      expect(outboxIds(fakes)).toEqual([])

      // Stripe cannot be read, so the account the notification is about is unknown: nothing can be queued for it.
      const blind = seed(fixture)
      blind.stripe.fail = () => Response.json({ error: { message: "outage" } }, { status: 500 })
      expect((await post(raw, sign(raw), blind.fetcher)).status).toBe(500)
      expect(blind.store.get(eventDoneKey("evt_paid_lost"))).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })

  test("routes on the object's id and customer: a dispute, refund or warning without its charge is read again", async () => {
    const disputed = loadStripeFixture("frozen-dispute-open")
    const fakes = seed(disputed)
    const now = disputed.now * 1000
    expect(
      await handleModelPlanEvent(event("charge.dispute.created", { id: "dp_open", object: "dispute" }), {
        fetcher: fakes.fetcher,
        now,
      }),
    ).toEqual({ outcome: "done", account: disputed.accountId })
    expect(fakes.stripe.calls.map((call) => call.path)).toContain("disputes/dp_open")
    expect(await readSnapshot(disputed.accountId, fakes.fetcher)).toMatchObject({ state: "frozen", reason: "disputed" })

    const warned = loadStripeFixture("frozen-early-fraud-warning")
    const efw = seed(warned)
    expect(
      await handleModelPlanEvent(event("radar.early_fraud_warning.created", { id: "issfr_Fixture01" }), {
        fetcher: efw.fetcher,
        now: warned.now * 1000,
      }),
    ).toEqual({ outcome: "done", account: warned.accountId })
    expect(await readSnapshot(warned.accountId, efw.fetcher)).toMatchObject({
      state: "frozen",
      reason: "early_fraud_warning",
    })

    const refunded = loadStripeFixture("ended-refunded")
    const refund = seed(refunded)
    refund.stripe.load({
      refunds: [{ id: "re_fixture", object: "refund", charge: "ch_refunded", status: "succeeded" }],
    })
    expect(
      await handleModelPlanEvent(event("charge.refund.updated", { id: "re_fixture", object: "refund" }), {
        fetcher: refund.fetcher,
        now: refunded.now * 1000,
      }),
    ).toEqual({ outcome: "done", account: refunded.accountId })
    expect(refund.stripe.calls.map((call) => call.path)).toContain("refunds/re_fixture")
    expect(await readSnapshot(refunded.accountId, refund.fetcher)).toMatchObject({ state: "ended", reason: "refunded" })

    // A customer that is not a Codium account's is left alone and marked done.
    const stranger = codiumFakes()
    stranger.stripe.load({ customers: [{ id: "cus_stranger", metadata: {} }] })
    expect(
      await handleModelPlanEvent(event("customer.subscription.updated", { id: "sub_z", customer: "cus_stranger" }), {
        fetcher: stranger.fetcher,
      }),
    ).toEqual({ outcome: "ignored" })
  })
})

// ── M5 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("M5: access ends when payment ends, within one notification", () => {
  const cases: [string, string, (fixture: StripeFixture) => Record<string, unknown>][] = [
    [
      "paused-past-due",
      "invoice.payment_failed",
      (f) => f.objects.invoices!.find((value) => value.id === "in_failed")!,
    ],
    ["ended-unpaid", "customer.subscription.updated", (f) => f.objects.subscriptions![0]!],
    ["ended-refunded", "charge.refunded", (f) => f.objects.charges![0]!],
    ["frozen-dispute-open", "charge.dispute.created", (f) => f.objects.disputes![0]!],
    ["ended-dispute-lost", "charge.dispute.closed", (f) => f.objects.disputes![0]!],
    ["frozen-early-fraud-warning", "radar.early_fraud_warning.created", (f) => f.objects.early_fraud_warnings![0]!],
  ]
  for (const [name, type, object] of cases)
    test(`${type} (${name}) switches the key off`, async () => {
      const fixture = loadStripeFixture(name)
      const fakes = seed(fixture)
      expect(fakes.openRouter.keys.get(SEEDED)?.disabled).toBe(false)
      const outcome = await handleModelPlanEvent(event(type, object(fixture)), {
        fetcher: fakes.fetcher,
        now: fixture.now * 1000,
      })
      expect(outcome).toEqual({ outcome: "done", account: fixture.accountId })
      expect(fakes.openRouter.keys.get(SEEDED)?.disabled).toBe(true)
      expect(await readSnapshot(fixture.accountId, fakes.fetcher)).toMatchObject({
        state: fixture.expect.state,
        reason: fixture.expect.reason,
      })
      // Reconcile never switches it back on: a later invoice.paid (an EFW followed by invoice.paid among them) finds
      // the account still held or ended.
      const paid = fixture.objects.invoices!.find((value) => value.status === "paid")!
      expect(
        await handleModelPlanEvent(event("invoice.paid", paid, "evt_paid_later"), {
          fetcher: fakes.fetcher,
          now: fixture.now * 1000 + MINUTE,
        }),
      ).toEqual({ outcome: "done", account: fixture.accountId })
      expect(fakes.openRouter.keys.get(SEEDED)?.disabled).toBe(true)
      expect([...fakes.openRouter.keys.values()].filter((key) => !key.disabled)).toEqual([])
      expect(await readSnapshot(fixture.accountId, fakes.fetcher)).toMatchObject({
        state: fixture.expect.state,
        reason: fixture.expect.reason,
      })
    })
})

// ── M11 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("M11: a renewal never locks out someone who pays", () => {
  test("a key expires at its period's end plus the grace, set when it is made and kept by reconcile", async () => {
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    await reconcileModelPlanAccount(fixture.accountId, fakes.fetcher, fixture.now * 1000)
    const end = fixture.expect.periodEnd * 1000
    expect([...fakes.openRouter.keys.values()]).toEqual([
      expect.objectContaining({ expires_at: new Date(end + GRACE).toISOString() }),
    ])
    restore()
    restore = codiumTestEnvironment({ CODIUM_RENEWAL_GRACE_MINUTES: "30" })
    expect(keyExpiresAt(fixture.expect.periodEnd)).toBe(new Date(end + 30 * MINUTE).toISOString())
    // A key made before (expiring at the period's end) is moved to the new expiry by the next reconcile.
    await reconcileModelPlanAccount(fixture.accountId, fakes.fetcher, fixture.now * 1000 + MINUTE)
    expect([...fakes.openRouter.keys.values()][0]?.expires_at).toBe(new Date(end + 30 * MINUTE).toISOString())
  })

  test("the old key serves across the renewal hour, then the paid renewal starts a new month on a new key", async () => {
    const fixture = loadStripeFixture("renewing-draft-invoice")
    const id = fixture.accountId
    const end = fixture.expect.periodEnd * 1000
    const fakes = seed(fixture, { now: end })
    funding(fakes, end)
    const invoice = fixture.objects.invoices!.find((value) => value.id === "in_renewal")!

    // Every minute between the period's end and the end of its grace, the production hold path (the entitlement
    // snapshot, its credential and the shared fence ADMIT also applies) holds on the old key's pool, never a 402 or 503.
    for (let minute = 0; minute <= 119; minute += 7) {
      fakes.clock.now = end + minute * MINUTE + 1
      const hold = await holdPool(id, 0.01, MINUTE, "chat", { fetcher: fakes.fetcher, clock: () => fakes.clock.now })
      expect([...fakes.store.zset(codiumKey("held", SEEDED)).keys()]).toEqual([`${hold.ticket}:chat:-:10000`])
      await hold.release()
    }
    expect(await modelPlanStatus(id, fakes.fetcher, end + 30 * MINUTE)).toMatchObject({
      active: true,
      access: true,
      plan: "vector-100",
      periodEnd: end,
    })
    const renewing = await reconcileModelPlanAccount(id, fakes.fetcher, end + 30 * MINUTE)
    expect(renewing).toMatchObject({ state: "renewing", periodEnd: end })
    expect(await requireEntitlement(id, "codium", fakes.fetcher, end + 30 * MINUTE)).toMatchObject({
      state: "renewing",
    })
    expect(fakes.openRouter.keys.get(SEEDED)).toMatchObject({
      disabled: false,
      expires_at: new Date(end + GRACE).toISOString(),
    })

    // invoice.created reaches the webhook; the outbox finalizes and pays the renewal and reconciles at once.
    const paidAt = end + 31 * MINUTE
    fakes.clock.now = paidAt
    funding(fakes, paidAt)
    expect(
      await handleModelPlanEvent(event("invoice.created", invoice), { fetcher: fakes.fetcher, now: paidAt }),
    ).toEqual({ outcome: "renewal-queued" })
    expect(await drainOutbox({ fetcher: fakes.fetcher, now: paidAt })).toMatchObject({ retried: 0, dead: 0 })
    expect(outboxIds(fakes)).toEqual([])
    expect(writes(fakes).map((call) => [call.path, call.idempotencyKey])).toEqual([
      ["invoices/in_renewal/finalize", "vector-finalize-in_renewal"],
      ["invoices/in_renewal/pay", "vector-pay-in_renewal"],
    ])

    // A new key at the new plan month's full credits, with no carry; the old key is off; a new meter epoch.
    const snapshot = await readSnapshot(id, fakes.fetcher)
    const nextStart = Number(fixture.objects.subscriptions![0]!.current_period_start) * 1000
    expect(snapshot).toMatchObject({ state: "active", periodStart: nextStart, meterEpoch: `sub_renewing:${nextStart}` })
    expect(snapshot!.meterEpoch).not.toBe(renewing.meterEpoch)
    expect(fakes.openRouter.keys.get(SEEDED)?.disabled).toBe(true)
    const account = await readModelPlanAccount(id, fakes.fetcher)
    expect(account?.key).toMatchObject({
      subscription: "sub_renewing",
      start: nextStart / 1000,
      limitMicro: 48_000_000,
    })
    expect(account?.key?.carry).toBeUndefined()
    const fresh = fakes.openRouter.keys.get(account!.key!.hash)!
    expect(fresh).toMatchObject({ disabled: false, limit: 48, usage: 0 })
    const credential = await modelPlanCredential(id, fakes.fetcher, paidAt + MINUTE, 0.01)
    expect(credential.key).not.toBe("seeded-secret")

    // invoice.paid arrives afterwards and changes nothing.
    const version = snapshot!.version
    await handleModelPlanEvent(event("invoice.paid", fakes.stripe.objects.invoices.get("in_renewal")!), {
      fetcher: fakes.fetcher,
      now: paidAt + 2 * MINUTE,
    })
    expect((await readSnapshot(id, fakes.fetcher))?.version).toBe(version)
    expect(fakes.openRouter.keys.size).toBe(2)
  })

  test("a renewal Stripe collects on its own schedule: invoice.paid gives a new key, carry 0, a new epoch", async () => {
    const fixture = loadStripeFixture("renewing-draft-invoice")
    const id = fixture.accountId
    const end = fixture.expect.periodEnd * 1000
    const fakes = seed(fixture, { now: end + MINUTE })
    // Carry from an upgrade earlier in the month ends at the renewal.
    const record = JSON.parse(fakes.store.get(codiumKey("account", id))!)
    record.key.carry = { micro: 5_000_000, fromSubscription: "sub_old", fromStart: 1, fromCharge: "ch_old" }
    fakes.stripe.load({
      charges: [
        { id: "ch_old", customer: record.customer, paid: true, refunded: false, disputed: false, amount_refunded: 0 },
      ],
    })
    record.key.limitMicro = 53_000_000
    fakes.store.set(codiumKey("account", id), JSON.stringify(record))
    fakes.openRouter.keys.get(SEEDED)!.limit = 53
    const renewing = await reconcileModelPlanAccount(id, fakes.fetcher, end + MINUTE)
    expect(renewing).toMatchObject({
      state: "renewing",
      meterEpoch: `sub_renewing:${fixture.expect.periodStart * 1000}`,
    })
    expect(fakes.openRouter.keys.get(SEEDED)).toMatchObject({ disabled: false, limit: 53 })

    // An hour later Stripe finalizes the draft and the card pays it, with no help from Vector.
    const paidAt = end + 61 * MINUTE
    fakes.clock.now = paidAt
    for (const action of ["finalize", "pay"])
      await modelPlanStripe(
        `invoices/in_renewal/${action}`,
        { method: "POST", idempotency: `stripe-own-${action}` },
        fakes.fetcher,
      )
    const paid = fakes.stripe.objects.invoices.get("in_renewal")!
    expect(paid).toMatchObject({ status: "paid", charge: "ch_renewal" })
    expect(
      await handleModelPlanEvent(event("invoice.paid", { id: "in_renewal", object: "invoice" }), {
        fetcher: fakes.fetcher,
        now: paidAt,
      }),
    ).toEqual({ outcome: "done", account: id })

    const nextStart = Number(fixture.objects.subscriptions![0]!.current_period_start) * 1000
    const snapshot = await readSnapshot(id, fakes.fetcher)
    expect(snapshot).toMatchObject({ state: "active", periodStart: nextStart, meterEpoch: `sub_renewing:${nextStart}` })
    expect(snapshot!.meterEpoch).not.toBe(renewing.meterEpoch)
    expect(fakes.openRouter.keys.get(SEEDED)?.disabled).toBe(true)
    const account = await readModelPlanAccount(id, fakes.fetcher)
    expect(account?.key).toMatchObject({
      subscription: "sub_renewing",
      start: nextStart / 1000,
      limitMicro: 48_000_000,
    })
    expect(account?.key?.carry).toBeUndefined()
    expect(fakes.openRouter.keys.get(account!.key!.hash)).toMatchObject({
      disabled: false,
      limit: 48,
      usage: 0,
      expires_at: keyExpiresAt(Number(fixture.objects.subscriptions![0]!.current_period_end)),
    })
    // The private ledger has the renewal's charge.
    expect(fakes.stripe.calls.map((call) => call.path)).toContain("invoices/in_renewal")
  })

  test("a renewal still unpaid when the grace runs out stops the old key", async () => {
    const fixture = loadStripeFixture("renewing-draft-invoice")
    const id = fixture.accountId
    const end = fixture.expect.periodEnd * 1000
    const fakes = seed(fixture, { now: end })
    const renewing = await reconcileModelPlanAccount(id, fakes.fetcher, end + MINUTE)
    expect(renewing.state).toBe("renewing")
    // Past the grace, a renewing snapshot that cannot be rechecked yet (another request holds this minute's reconcile)
    // answers 503 RENEWING; the next reconcile finds it paused.
    fakes.store.set(codiumKey("reconcile", id), "held")
    await expect(requireEntitlement(id, "codium", fakes.fetcher, end + GRACE + 1)).rejects.toMatchObject({
      statusCode: 503,
      code: "MODEL_PLAN_RENEWING",
    })
    fakes.store.remove(codiumKey("reconcile", id))
    fakes.clock.now = end + GRACE + MINUTE
    expect(await reconcileModelPlanAccount(id, fakes.fetcher, end + GRACE + MINUTE)).toMatchObject({
      state: "paused",
      reason: "payment_pending",
    })
    expect(fakes.openRouter.keys.get(SEEDED)?.disabled).toBe(true)
    await expect(modelPlanCredential(id, fakes.fetcher, end + GRACE + MINUTE, 0.01)).rejects.toMatchObject({
      statusCode: 402,
      code: "MODEL_PLAN_PAYMENT_REQUIRED",
    })
  })

  test("a month refunded without cancelling stays ended when it renews: its key stays off until a renewal is paid", async () => {
    const fixture = loadStripeFixture("renewing-draft-invoice")
    const id = fixture.accountId
    const start = fixture.expect.periodStart
    const end = fixture.expect.periodEnd
    const fakes = seed(fixture, { now: (start + 86_400) * 1000 })
    // A day into the month the subscription is still on it, paid, when its charge is refunded in full from Stripe's
    // dashboard. The subscription is not cancelled, so Stripe goes on to bill the next month.
    const subscription = fakes.stripe.subscription("sub_renewing")!
    const next = {
      current_period_start: subscription.current_period_start,
      current_period_end: subscription.current_period_end,
      latest_invoice: subscription.latest_invoice,
    }
    Object.assign(subscription, {
      current_period_start: start,
      current_period_end: end,
      latest_invoice: "in_renewingP1",
    })
    expect(await reconcileModelPlanAccount(id, fakes.fetcher, (start + 86_400) * 1000)).toMatchObject({
      state: "active",
    })
    expect(fakes.openRouter.keys.get(SEEDED)?.disabled).toBe(false)
    Object.assign(fakes.stripe.charge("ch_renewingP1")!, { refunded: true, amount_refunded: 10_000 })
    expect(await reconcileModelPlanAccount(id, fakes.fetcher, (start + 2 * 86_400) * 1000)).toMatchObject({
      state: "ended",
      reason: "refunded",
    })
    expect(fakes.openRouter.keys.get(SEEDED)?.disabled).toBe(true)
    expect((await readModelPlanAccount(id, fakes.fetcher))?.key).toMatchObject({ hash: SEEDED, revoked: "refunded" })

    // The period ends and Stripe moves the subscription on, with the renewal still a draft: a renewal of a paid month
    // would keep that month's key serving (M11), but this month was refunded, so nothing comes back on.
    Object.assign(subscription, next)
    for (const at of [end * 1000 + MINUTE, end * 1000 + 30 * MINUTE]) {
      fakes.clock.now = at
      expect(await reconcileModelPlanAccount(id, fakes.fetcher, at)).toMatchObject({
        state: "ended",
        reason: "refunded",
        periodEnd: end * 1000,
      })
      await expect(modelPlanCredential(id, fakes.fetcher, at, 0.01)).rejects.toMatchObject({ statusCode: 402 })
      await expect(requireEntitlement(id, "codium", fakes.fetcher, at)).rejects.toMatchObject({
        statusCode: 402,
        code: "MODEL_PLAN_REQUIRED",
        detail: { reason: "refunded" },
      })
      expect(await modelPlanStatus(id, fakes.fetcher, at)).toMatchObject({ active: false })
    }
    expect(fakes.openRouter.keys.get(SEEDED)?.disabled).toBe(true)
    expect(fakes.openRouter.calls.filter((call) => call.method === "PATCH" && call.json?.disabled === false)).toEqual(
      [],
    )

    // The renewal is paid: the new month starts on a new key, and the refunded month's key stays off.
    const paidAt = end * 1000 + 61 * MINUTE
    fakes.clock.now = paidAt
    for (const action of ["finalize", "pay"])
      await modelPlanStripe(
        `invoices/in_renewal/${action}`,
        { method: "POST", idempotency: `stripe-own-${action}` },
        fakes.fetcher,
      )
    expect(await reconcileModelPlanAccount(id, fakes.fetcher, paidAt)).toMatchObject({
      state: "active",
      periodStart: Number(next.current_period_start) * 1000,
    })
    const account = await readModelPlanAccount(id, fakes.fetcher)
    expect(account?.key?.hash).not.toBe(SEEDED)
    expect(account?.key?.revoked).toBeUndefined()
    expect(fakes.openRouter.keys.get(account!.key!.hash)).toMatchObject({ disabled: false, limit: 48 })
    expect(fakes.openRouter.keys.get(SEEDED)?.disabled).toBe(true)
  })
})

// ── M7 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("M7: no renewal charge Vector should not take", () => {
  const fixture = () => loadStripeFixture("renewing-draft-invoice")

  /** The renewal fixture a minute after its period ended, funded, with the owner's email on. */
  function renewal(overrides: Record<string, string | undefined> = {}) {
    restore()
    restore = codiumTestEnvironment({ ...OWNER_EMAIL, ...overrides })
    const base = fixture()
    const at = base.expect.periodEnd * 1000 + MINUTE
    const fakes = seed(base, { now: at })
    funding(fakes, at)
    return { fakes, at, id: base.accountId, base }
  }

  test("finalizes and pays once, with the contract's idempotency keys, and queues the reconcile", async () => {
    const { fakes, at, id } = renewal()
    expect(await finalizeRenewal("in_renewal", fakes.fetcher, at)).toEqual({
      outcome: "paid",
      invoice: "in_renewal",
      account: id,
    })
    const [finalize, pay] = writes(fakes)
    expect(finalize).toMatchObject({
      path: "invoices/in_renewal/finalize",
      idempotencyKey: "vector-finalize-in_renewal",
    })
    expect(finalize!.form?.get("auto_advance")).toBe("true")
    expect(pay).toMatchObject({ path: "invoices/in_renewal/pay", idempotencyKey: "vector-pay-in_renewal" })
    expect(outboxIds(fakes)).toEqual([`reconcile:${id}`])
    // Run again (a retried action): the invoice is paid, so nothing is written.
    expect(await finalizeRenewal("in_renewal", fakes.fetcher, at)).toEqual({
      outcome: "skipped",
      invoice: "in_renewal",
      why: "settled",
    })
    expect(writes(fakes)).toHaveLength(2)
    expect(fakes.mail.sent).toEqual([])
  })

  test("a declined card leaves the renewal to Stripe's retries, and the account is paused by the next reconcile", async () => {
    const { fakes, at, id } = renewal()
    fakes.stripe.declines.add("in_renewal")
    expect(await finalizeRenewal("in_renewal", fakes.fetcher, at)).toEqual({
      outcome: "payment-failed",
      invoice: "in_renewal",
      account: id,
    })
    expect(fakes.stripe.objects.invoices.get("in_renewal")).toMatchObject({ status: "open", attempt_count: 1 })
    // Stripe marks the subscription past due after the failed attempt.
    fakes.stripe.subscription("sub_renewing")!.status = "past_due"
    expect(await drainOutbox({ fetcher: fakes.fetcher, now: at })).toMatchObject({ retried: 0, dead: 0 })
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ state: "paused", reason: "payment_failed" })
    expect(fakes.openRouter.keys.get(SEEDED)?.disabled).toBe(true)
  })

  /** Asserts a refusal: no finalize or pay, the owner told once, and collection paused and the draft held when `paused`. */
  async function refused(fakes: CodiumFakes, at: number, reason: string, paused: boolean) {
    const outcome = await finalizeRenewal("in_renewal", fakes.fetcher, at)
    expect(outcome).toMatchObject({ outcome: "refused", reason, paused })
    const paths = writes(fakes).map((call) => call.path)
    expect(paths.filter((path) => path.endsWith("/finalize") || path.endsWith("/pay"))).toEqual([])
    if (paused) {
      const hour = Math.floor(at / HOUR)
      expect(writes(fakes).map((call) => [call.path, call.idempotencyKey])).toEqual([
        ["subscriptions/sub_renewing", `vector-pause-in_renewal-${reason}-${hour}`],
        ["invoices/in_renewal", `vector-hold-in_renewal-${hour}`],
      ])
      expect(fakes.stripe.subscription("sub_renewing")).toMatchObject({
        pause_collection: { behavior: "void" },
        metadata: { vector_paused_for: reason },
      })
      expect(fakes.stripe.objects.invoices.get("in_renewal")).toMatchObject({ status: "draft", auto_advance: false })
    } else expect(writes(fakes)).toEqual([])
    expect(fakes.mail.sent).toHaveLength(1)
    const mail = fakes.mail.sent[0]!
    expect(mail.text).toContain("in_renewal")
    expect(mail.text).not.toMatch(/\$|usd|credit/i)
    expect(mail.text).not.toContain("@")
    // The same refusal again sends nothing new and writes nothing new.
    const before = writes(fakes).length
    expect(await finalizeRenewal("in_renewal", fakes.fetcher, at)).toMatchObject({ outcome: "refused", reason })
    expect(writes(fakes)).toHaveLength(before)
    expect(fakes.mail.sent).toHaveLength(1)
  }

  test("refused while codium is off: by the runtime switch, or MODEL_PLANS_ENABLED", async () => {
    const off = renewal()
    off.fakes.store.set(switchKey("codium"), "off")
    expect(await readSwitch("codium", off.fakes.fetcher)).toBe("off")
    await refused(off.fakes, off.at, "codium-off", true)

    const disabled = renewal({ MODEL_PLANS_ENABLED: "false" })
    await refused(disabled.fakes, disabled.at, "codium-off", true)

    // A switch value that cannot be read fails closed: the action is retried, nothing is charged.
    const unreadable = renewal()
    unreadable.fakes.store.set(switchKey("codium"), "sideways")
    await expect(finalizeRenewal("in_renewal", unreadable.fakes.fetcher, unreadable.at)).rejects.toMatchObject({
      code: "CODIUM_SWITCH_UNAVAILABLE",
    })
    expect(writes(unreadable.fakes)).toEqual([])
  })

  test("refused while the account is frozen by a dispute or a fraud warning", async () => {
    for (const risk of [
      { blocked: false, openDisputes: { ch_renewingP1: { status: "needs_response", at: 1 } }, efw: [] },
      { blocked: false, openDisputes: {}, efw: ["ch_renewingP1"] },
    ]) {
      const { fakes, at, id } = renewal()
      const record = JSON.parse(fakes.store.get(codiumKey("account", id))!)
      fakes.store.set(codiumKey("account", id), JSON.stringify({ ...record, risk }))
      await refused(fakes, at, "frozen", true)
    }
  })

  test("refused while the account is blocked, by a lost dispute or the owner", async () => {
    for (const reason of ["disputed", "owner"]) {
      const { fakes, at, id } = renewal()
      const record = JSON.parse(fakes.store.get(codiumKey("account", id))!)
      fakes.store.set(
        codiumKey("account", id),
        JSON.stringify({ ...record, risk: { blocked: true, reason, at: 1, openDisputes: {}, efw: [] } }),
      )
      await refused(fakes, at, "frozen", true)
    }
  })

  /** A second paid subscription of the account for the period after the renewal's, like the renewal fixture's own. */
  function secondSubscription(fakes: CodiumFakes, id: string, metadata: Record<string, string>, price = 100) {
    const original = fakes.stripe.subscription("sub_renewing")!
    const item = (original.items as { data: Record<string, unknown>[] }).data[0]!
    const start = Number(original.current_period_start)
    const end = Number(original.current_period_end)
    const priceObject = {
      ...(item.price as Record<string, unknown>),
      id: `price_codium${price}`,
      unit_amount: price * 100,
    }
    fakes.stripe.load({
      subscriptions: [
        {
          ...structuredClone(original),
          id: "sub_second",
          created: start,
          metadata: {
            vector_account_id: id,
            vector_plan: `vector-${price}`,
            vector_model_credits_usd: price === 200 ? "100" : "48",
            ...metadata,
          },
          items: {
            object: "list",
            data: [{ ...item, id: "si_second", price: priceObject, subscription: "sub_second" }],
          },
          latest_invoice: "in_second",
        },
      ],
      invoices: [
        {
          id: "in_second",
          object: "invoice",
          amount_due: price * 100,
          amount_paid: price * 100,
          attempt_count: 1,
          billing_reason: "subscription_create",
          charge: "ch_second",
          customer: original.customer,
          lines: {
            object: "list",
            data: [{ price: priceObject, period: { start, end }, proration: false, quantity: 1 }],
          },
          paid: true,
          status: "paid",
          status_transitions: { paid_at: start },
          subscription: "sub_second",
        },
      ],
      charges: [
        {
          id: "ch_second",
          object: "charge",
          amount: price * 100,
          amount_refunded: 0,
          customer: original.customer,
          disputed: false,
          invoice: "in_second",
          paid: true,
          refunded: false,
        },
      ],
    })
  }

  test("refused for a subscription an upgrade superseded", async () => {
    const { fakes, at, id } = renewal()
    secondSubscription(fakes, id, { vector_supersedes: "sub_renewing" }, 200)
    await refused(fakes, at, "superseded", true)
  })

  test("refused for a duplicate subscription that does not govern the account", async () => {
    const { fakes, at, id } = renewal()
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      secondSubscription(fakes, id, {}, 200)
      await refused(fakes, at, "not-governing", true)
    } finally {
      warn.mockRestore()
    }
  })

  test("refused, without a pause, while collection is already paused by someone else", async () => {
    const { fakes, at } = renewal()
    fakes.stripe.subscription("sub_renewing")!.pause_collection = { behavior: "keep_as_draft", resumes_at: null }
    await refused(fakes, at, "collection-paused", false)
  })

  test("refused, without a pause, while the balance does not cover what is owed plus the renewal (M12)", async () => {
    // Owed $9,970 and a $48 renewal against a $10,000 balance.
    const short = renewal()
    funding(short.fakes, short.at, 1_000_000, 997_000)
    await refused(short.fakes, short.at, "unfunded", false)

    // Exactly enough is enough.
    const exact = renewal()
    funding(exact.fakes, exact.at, 1_000_000, 1_000_000 - 4_800)
    expect(await finalizeRenewal("in_renewal", exact.fakes.fetcher, exact.at)).toMatchObject({ outcome: "paid" })

    // No reading from the last 15 minutes, and none can be taken: short, so the early charge is skipped. (The failed
    // funding check sends its own "sales paused" email as well.)
    const stale = renewal()
    funding(stale.fakes, stale.at - 16 * MINUTE)
    stale.fakes.openRouter.fail = () => Response.json({ error: "outage" }, { status: 503 })
    expect(await finalizeRenewal("in_renewal", stale.fakes.fetcher, stale.at)).toMatchObject({
      outcome: "refused",
      reason: "unfunded",
      paused: false,
    })
    expect(writes(stale.fakes)).toEqual([])
    expect(stale.fakes.mail.sent.map((mail) => mail.subject)).toContain(
      "Vector Codium: a renewal was not charged early",
    )
  })

  test("a future-dated funded reading is refreshed before an unfunded renewal can be charged", async () => {
    const { fakes, at } = renewal()
    funding(fakes, at + HOUR)
    fakes.openRouter.credits.total_credits = 0
    expect(await finalizeRenewal("in_renewal", fakes.fetcher, at)).toMatchObject({
      outcome: "refused",
      reason: "unfunded",
      paused: false,
    })
    expect(writes(fakes)).toEqual([])
    expect(fakes.openRouter.calls.some((call) => call.path === "credits")).toBe(true)
  })

  test("a future-dated reading from a busy funding checker cannot authorize a renewal", async () => {
    const { fakes, at } = renewal()
    funding(fakes, at + HOUR)
    fakes.store.set(codiumKey("funding", "lock"), "another-checker")
    expect(await finalizeRenewal("in_renewal", fakes.fetcher, at)).toMatchObject({
      outcome: "refused",
      reason: "unfunded",
      paused: false,
    })
    expect(writes(fakes)).toEqual([])
    expect(fakes.openRouter.calls).toEqual([])
  })

  test("each refusal is one of the contract's, and only the ones Vector must not take pause collection", () => {
    expect([...RENEWAL_REFUSALS]).toEqual([
      "codium-off",
      "frozen",
      "superseded",
      "not-governing",
      "collection-paused",
      "unfunded",
    ])
  })

  test("a first invoice, a settled renewal and another customer's invoice are left alone", async () => {
    const { fakes, at } = renewal()
    expect(await finalizeRenewal("in_renewingP1", fakes.fetcher, at)).toEqual({
      outcome: "skipped",
      invoice: "in_renewingP1",
      why: "not-renewal",
    })
    fakes.stripe.objects.invoices.get("in_renewal")!.status = "void"
    expect(await finalizeRenewal("in_renewal", fakes.fetcher, at)).toMatchObject({ why: "settled" })
    fakes.stripe.objects.invoices.get("in_renewal")!.status = "draft"
    fakes.stripe.objects.customers.get(String(fakes.stripe.subscription("sub_renewing")!.customer))!.metadata = {}
    expect(await finalizeRenewal("in_renewal", fakes.fetcher, at)).toMatchObject({ why: "not-codium" })
    expect(writes(fakes)).toEqual([])
    await expect(finalizeRenewal("not an invoice", fakes.fetcher, at)).rejects.toMatchObject({
      code: "CODIUM_RENEWAL_INVALID",
    })
  })

  test("the outbox cron runs finalize-renewal: its module registers the handler", async () => {
    expect(() => registerAction("finalize-renewal", async () => {})).toThrow()
    // The replay path (reconcileModelPlanEvent) queues the same action as the route.
    const { fakes, at } = renewal()
    const invoice = fixture().objects.invoices!.find((value) => value.id === "in_renewal")!
    await reconcileModelPlanEvent(event("invoice.created", invoice), fakes.fetcher, { now: at })
    expect(outboxIds(fakes)).toEqual(["finalize-renewal:in_renewal"])
  })
})
