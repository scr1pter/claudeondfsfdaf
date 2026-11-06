import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { checkCodiumFunding } from "../api/_lib/codium-funding"
import { rampOwedCents, rampOwedKey, rampVersion, writeRampOwed } from "../api/_lib/codium-ramp"
import { codiumKey } from "../api/_lib/codium-keys"
import { createActionRegistry, drainOutbox } from "../api/_lib/codium-provision"
import { authenticatedCharge, checkoutRiskFields } from "../api/_lib/codium-risk"
import { readSnapshot } from "../api/_lib/codium-snapshot"
import { readDebits } from "../api/_lib/codium-pool"
import {
  holdPool,
  modelPlanCredential,
  readModelPlanAccount,
  reconcileModelPlanAccount,
} from "../api/_lib/model-plan-account"
import {
  codiumFakes,
  codiumTestEnvironment,
  FIXTURE_CREDITS,
  loadStripeFixture,
  type CodiumFakes,
} from "../packages/web/test/fixture/codium-fakes"

const fixture = loadStripeFixture("active-paid")
const id = fixture.accountId
const customer = String(fixture.account.customer)
const now = fixture.now * 1000
const HOUR = 3_600_000
let restore = () => {}
beforeEach(() => {
  restore = codiumTestEnvironment({ CODIUM_EFW_REFUND: "true", CODIUM_RADAR_BLOCKLIST_ID: undefined })
})
afterEach(() => restore())

function seed() {
  const fakes = codiumFakes({ now })
  fakes.stripe.load(fixture.objects)
  fakes.store.set(codiumKey("account", id), JSON.stringify(fixture.account))
  return fakes
}

/** A complete separately paid month, with the payment's actual 3DS outcome explicit. */
function month(
  fakes: CodiumFakes,
  amount: 10 | 50 | 100 | 200,
  options: { subscription?: string; start?: number; secure?: string; supersedes?: string } = {},
) {
  const sub = options.subscription ?? "sub_active"
  const invoiceID = sub === "sub_active" ? "in_active" : `in_${sub}`
  const chargeID = sub === "sub_active" ? "ch_active" : `ch_${sub.replaceAll("_", "")}`
  const subscription = structuredClone(fixture.objects.subscriptions![0]!)
  const invoice = structuredClone(fixture.objects.invoices![0]!)
  const charge = structuredClone(fixture.objects.charges![0]!)
  const start = options.start ?? fixture.now - 60
  const end = start + 30 * 86400
  const price = {
    id: `price_codium${amount}`,
    active: true,
    currency: "usd",
    unit_amount: amount * 100,
    recurring: { interval: "month", interval_count: 1 },
  }
  Object.assign(subscription, {
    id: sub,
    status: "active",
    current_period_start: start,
    current_period_end: end,
    latest_invoice: invoiceID,
    metadata: {
      vector_account_id: id,
      vector_plan: `vector-${amount}`,
      vector_model_credits_usd: FIXTURE_CREDITS[amount],
      ...(options.supersedes ? { vector_supersedes: options.supersedes } : {}),
    },
    items: { data: [{ id: `si_${sub}`, price, quantity: 1 }] },
  })
  Object.assign(invoice, {
    id: invoiceID,
    subscription: sub,
    charge: chargeID,
    amount_paid: amount * 100,
    amount_due: amount * 100,
    lines: { data: [{ price, proration: false, period: { start, end } }] },
    status_transitions: { paid_at: start },
  })
  Object.assign(charge, {
    id: chargeID,
    invoice: invoiceID,
    amount: amount * 100,
    payment_method_details: {
      card: { fingerprint: "card_fixture", three_d_secure: { result: options.secure ?? "attempt_acknowledged" } },
    },
  })
  fakes.stripe.load({ subscriptions: [subscription], invoices: [invoice], charges: [charge] })
  return { sub, invoice: invoiceID, charge: chargeID, start, end }
}

function warning(fakes: CodiumFakes, charge = "ch_active", actionable = true) {
  const warningID = `issfr_${charge}`
  fakes.stripe.load({ early_fraud_warnings: [{ id: warningID, charge, actionable }] })
  return { kind: "efw" as const, id: warningID, charge }
}
const writes = (fakes: CodiumFakes) => fakes.stripe.calls.filter((call) => call.method !== "GET")
const refunds = (fakes: CodiumFakes) => writes(fakes).filter((call) => call.path === "refunds")

function dispute(fakes: CodiumFakes, status: string, charge = "ch_active") {
  fakes.stripe.charge(charge)!.disputed = true
  fakes.stripe.load({ disputes: [{ id: `dp_${charge}`, charge, status }] })
  return { kind: "dispute" as const, charge }
}

describe("A10 checkout 3-D Secure", () => {
  test("first Max requests 3DS, Plus does not, second paid Max does not; Plus to Max and first Ultra do", async () => {
    const fakes = seed()
    expect(await checkoutRiskFields(id, customer, 10, fakes.fetcher)).toEqual({})
    expect(await checkoutRiskFields(id, customer, 100, fakes.fetcher)).toEqual({
      "payment_method_options[card][request_three_d_secure]": "any",
    })
    month(fakes, 100, { secure: "authenticated" })
    expect(await checkoutRiskFields(id, customer, 100, fakes.fetcher)).toEqual({})
    expect(await checkoutRiskFields(id, customer, 200, fakes.fetcher)).toEqual({
      "payment_method_options[card][request_three_d_secure]": "any",
    })
    fakes.stripe.charge("ch_active")!.refunded = true
    expect(await checkoutRiskFields(id, customer, 100, fakes.fetcher)).toEqual({
      "payment_method_options[card][request_three_d_secure]": "any",
    })
  })

  test("malformed or missing financial fields never grant an exemption", async () => {
    for (const malformed of [undefined, NaN, -1, "10000"]) {
      const fakes = seed()
      month(fakes, 100)
      fakes.stripe.objects.invoices.get("in_active")!.amount_paid = malformed
      expect(await checkoutRiskFields(id, customer, 100, fakes.fetcher)).toEqual({
        "payment_method_options[card][request_three_d_secure]": "any",
      })
    }
    for (const field of ["amount", "amount_refunded"])
      for (const malformed of [undefined, NaN, -1]) {
        const fakes = seed()
        month(fakes, 100)
        fakes.stripe.charge("ch_active")![field] = malformed
        expect(await checkoutRiskFields(id, customer, 100, fakes.fetcher)).toEqual({
          "payment_method_options[card][request_three_d_secure]": "any",
        })
      }
  })

  test("unknown, disputed and unrelated paid invoices never exempt", async () => {
    const fakes = seed()
    month(fakes, 100)
    fakes.stripe.charge("ch_active")!.disputed = true
    expect(await checkoutRiskFields(id, customer, 100, fakes.fetcher)).toEqual({
      "payment_method_options[card][request_three_d_secure]": "any",
    })
    fakes.stripe.charge("ch_active")!.disputed = false
    fakes.stripe.subscription("sub_active")!.metadata = { vector_account_id: "someone-else", vector_plan: "vector-100" }
    expect(await checkoutRiskFields(id, customer, 100, fakes.fetcher)).toEqual({
      "payment_method_options[card][request_three_d_secure]": "any",
    })
  })
})

describe("A10 early-fraud warnings", () => {
  test("actionable warnings stop access before a refund, retry a failure, and refund/cancel once", async () => {
    const fakes = seed()
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const key = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    const hint = warning(fakes)
    let failed = false
    fakes.stripe.fail = (call) => {
      if (call.method === "GET") return
      expect(JSON.parse(fakes.store.get(codiumKey("ent", id))!).state).toBe("ended")
      expect(fakes.openRouter.keys.get(key.hash)!.disabled).toBe(true)
      if (call.path === "refunds" && !failed) {
        failed = true
        return new Response("unavailable", { status: 503 })
      }
    }
    await expect(reconcileModelPlanAccount(id, fakes.fetcher, now, { hint })).rejects.toMatchObject({
      code: "BILLING_UPSTREAM",
    })
    expect((await readSnapshot(id, fakes.fetcher))!.reason).toBe("early_fraud_warning")
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(fakes.stripe.charge("ch_active")!.refunded).toBe(true)
    expect(fakes.stripe.objects.refunds.size).toBe(1)
    expect(refunds(fakes).at(-1)!.form!.get("reason")).toBe("fraudulent")
    expect(
      writes(fakes).filter((call) => call.method === "DELETE" && call.path === "subscriptions/sub_active"),
    ).toHaveLength(1)
  })

  test("a failed refund retains the current same-card target after subscriptions were canceled", async () => {
    const fakes = seed()
    month(fakes, 10, { subscription: "sub_old", start: fixture.now - 31 * 86400 })
    fakes.stripe.subscription("sub_old")!.status = "canceled"
    month(fakes, 10, { secure: "authenticated" })
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    fakes.stripe.fail = (call) => (call.path === "refunds" ? new Response("unavailable", { status: 503 }) : undefined)
    await expect(
      reconcileModelPlanAccount(id, fakes.fetcher, now, { hint: warning(fakes, "ch_subold") }),
    ).rejects.toMatchObject({ code: "BILLING_UPSTREAM" })
    expect(fakes.stripe.subscription("sub_active")!.status).toBe("canceled")
    fakes.stripe.fail = undefined
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(fakes.stripe.charge("ch_subold")!.refunded).toBe(true)
    expect(fakes.stripe.charge("ch_active")!.refunded).toBe(true)
  })

  test("optional Radar failure happens after cancellation and all mandatory refunds", async () => {
    const fakes = seed()
    month(fakes, 10)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    process.env.CODIUM_RADAR_BLOCKLIST_ID = "rsl_fixture"
    fakes.stripe.fail = (call) =>
      call.path === "radar/value_list_items" ? new Response("unavailable", { status: 503 }) : undefined
    await expect(reconcileModelPlanAccount(id, fakes.fetcher, now, { hint: warning(fakes) })).rejects.toMatchObject({
      code: "BILLING_UPSTREAM",
    })
    expect(fakes.stripe.subscription("sub_active")!.status).toBe("canceled")
    expect(fakes.stripe.charge("ch_active")!.refunded).toBe(true)
  })

  test("non-actionable warnings and the explicit refund-off switch freeze without financial writes", async () => {
    for (const enabled of [true, false]) {
      const fakes = seed()
      await reconcileModelPlanAccount(id, fakes.fetcher, now)
      process.env.CODIUM_EFW_REFUND = enabled ? "true" : "false"
      const snapshot = await reconcileModelPlanAccount(id, fakes.fetcher, now, {
        hint: warning(fakes, "ch_active", !enabled),
      })
      expect(snapshot.state).toBe("frozen")
      expect(refunds(fakes)).toHaveLength(0)
      expect(writes(fakes).filter((call) => call.method === "DELETE")).toHaveLength(0)
    }
  })

  test("an older warned charge also refunds the current charge only on the same known card", async () => {
    for (const same of [true, false]) {
      const fakes = seed()
      month(fakes, 10, { subscription: "sub_old", start: fixture.now - 31 * 86400 })
      fakes.stripe.subscription("sub_old")!.status = "canceled"
      month(fakes, 10, { secure: "authenticated" })
      if (!same) fakes.stripe.charge("ch_active")!.payment_method_details = { card: { fingerprint: "card_other" } }
      await reconcileModelPlanAccount(id, fakes.fetcher, now)
      await reconcileModelPlanAccount(id, fakes.fetcher, now, { hint: warning(fakes, "ch_subold") })
      expect(fakes.stripe.charge("ch_subold")!.refunded).toBe(true)
      expect(fakes.stripe.charge("ch_active")!.refunded).toBe(same)
      expect(refunds(fakes)).toHaveLength(same ? 2 : 1)
    }
  })

  test("an unrelated product's warning cannot freeze or refund a Codium account", async () => {
    const fakes = seed()
    month(fakes, 10, { subscription: "sub_other" })
    fakes.stripe.subscription("sub_other")!.metadata = { other_product: "true" }
    const snapshot = await reconcileModelPlanAccount(id, fakes.fetcher, now, { hint: warning(fakes, "ch_subother") })
    expect(snapshot.state).toBe("active")
    expect(refunds(fakes)).toHaveLength(0)
  })
})

describe("A10 disputes", () => {
  test("open disputes pause collection, a win restores it, and a loss cancels once", async () => {
    const fakes = seed()
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const hint = dispute(fakes, "needs_response")
    expect((await reconcileModelPlanAccount(id, fakes.fetcher, now, { hint })).state).toBe("frozen")
    expect(fakes.stripe.subscription("sub_active")!.pause_collection).toMatchObject({ behavior: "void" })
    fakes.stripe.objects.disputes.get("dp_ch_active")!.status = "won"
    expect((await reconcileModelPlanAccount(id, fakes.fetcher, now)).state).toBe("active")
    expect(fakes.stripe.subscription("sub_active")!.pause_collection).toBeNull()
    fakes.stripe.objects.disputes.get("dp_ch_active")!.status = "lost"
    expect((await reconcileModelPlanAccount(id, fakes.fetcher, now, { hint })).state).toBe("ended")
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(fakes.stripe.subscription("sub_active")!.status).toBe("canceled")
    expect(
      writes(fakes).filter((call) => call.method === "DELETE" && call.path === "subscriptions/sub_active"),
    ).toHaveLength(1)
  })

  test("a dispute on an unrelated product never pauses or freezes Codium", async () => {
    const fakes = seed()
    month(fakes, 10, { subscription: "sub_other" })
    fakes.stripe.subscription("sub_other")!.metadata = { other_product: "true" }
    const hint = dispute(fakes, "needs_response", "ch_subother")
    expect((await reconcileModelPlanAccount(id, fakes.fetcher, now, { hint })).state).toBe("active")
    expect(fakes.stripe.subscription("sub_active")!.pause_collection).toBeNull()
  })

  test("an owner changing collection during an open dispute retains their pause after another reconcile and a win", async () => {
    const fakes = seed()
    const hint = dispute(fakes, "needs_response")
    await reconcileModelPlanAccount(id, fakes.fetcher, now, { hint })
    fakes.stripe.subscription("sub_active")!.pause_collection = { behavior: "keep_as_draft" }
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    fakes.stripe.objects.disputes.get("dp_ch_active")!.status = "won"
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(fakes.stripe.subscription("sub_active")!.pause_collection).toEqual({ behavior: "keep_as_draft" })
  })

  test("owner takeover followed by another dispute gets a fresh pause intent", async () => {
    const fakes = seed()
    const hint = dispute(fakes, "needs_response")
    await reconcileModelPlanAccount(id, fakes.fetcher, now, { hint })
    const first = writes(fakes).find((call) => call.form?.has("pause_collection[behavior]"))!.idempotencyKey
    fakes.stripe.subscription("sub_active")!.pause_collection = { behavior: "keep_as_draft" }
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    fakes.stripe.objects.disputes.get("dp_ch_active")!.status = "won"
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    fakes.stripe.subscription("sub_active")!.pause_collection = null
    fakes.stripe.objects.disputes.get("dp_ch_active")!.status = "needs_response"
    await reconcileModelPlanAccount(id, fakes.fetcher, now + 1, { hint })
    const latest = writes(fakes).findLast((call) => call.form?.has("pause_collection[behavior]"))!.idempotencyKey
    expect(latest).not.toBe(first)
    expect(fakes.stripe.subscription("sub_active")!.pause_collection).toMatchObject({ behavior: "void" })
  })

  test("owner pauses and codium-off are never cleared by a dispute win", async () => {
    const fakes = seed()
    fakes.stripe.subscription("sub_active")!.pause_collection = { behavior: "keep_as_draft" }
    const hint = dispute(fakes, "needs_response")
    await reconcileModelPlanAccount(id, fakes.fetcher, now, { hint })
    fakes.stripe.objects.disputes.get("dp_ch_active")!.status = "won"
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(fakes.stripe.subscription("sub_active")!.pause_collection).toEqual({ behavior: "keep_as_draft" })
    fakes.stripe.subscription("sub_active")!.pause_collection = null
    fakes.stripe.objects.disputes.get("dp_ch_active")!.status = "needs_response"
    await reconcileModelPlanAccount(id, fakes.fetcher, now, { hint })
    fakes.stripe.objects.disputes.get("dp_ch_active")!.status = "won"
    fakes.store.set(codiumKey("switch", "codium"), "off")
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(fakes.stripe.subscription("sub_active")!.pause_collection).toMatchObject({ behavior: "void" })
    fakes.store.set(codiumKey("switch", "codium"), "on")
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(fakes.stripe.subscription("sub_active")!.pause_collection).toBeNull()
  })
})

describe("A10 trust and pool ramps", () => {
  test("first model admission before the webhook applies the risk cohort, including Plus→Max", async () => {
    for (const upgrading of [false, true]) {
      const fakes = seed()
      if (upgrading) {
        await modelPlanCredential(id, fakes.fetcher, now, 0.01)
      }
      month(fakes, 100, upgrading ? { subscription: "sub_max", supersedes: "sub_active" } : {})
      await modelPlanCredential(id, fakes.fetcher, now, 0.01)
      const account = (await readModelPlanAccount(id, fakes.fetcher))!
      expect(account.poolRamp).toBeDefined()
      expect(account.key!.creditsMicro).toBe(14_400_000)
      expect(fakes.openRouter.keys.get(account.key!.hash)!.limit).toBe(upgrading ? 18.4 : 14.4)
    }
  })

  test("an authenticated first high payment grants full credits; other results start a 72-hour pool ramp", async () => {
    for (const secure of ["authenticated", "attempt_acknowledged", "failed"]) {
      const fakes = seed()
      month(fakes, 200, { secure })
      const snapshot = await reconcileModelPlanAccount(id, fakes.fetcher, now)
      const account = (await readModelPlanAccount(id, fakes.fetcher))!
      expect(fakes.openRouter.keys.get(account.key!.hash)!.limit).toBe(secure === "authenticated" ? 100 : 30)
      expect(account.highValueVerified).toBe(secure === "authenticated")
      expect(snapshot.caps.dailyShare).toBe(secure === "authenticated" ? null : 0.4)
      expect(snapshot.ramp.hostedUntil).toBe(snapshot.firstHighPaidAt! + 7 * 24 * HOUR)
      expect(snapshot.ramp.browserFrom).toBe(snapshot.firstHighPaidAt! + 24 * HOUR)
    }
    expect(authenticatedCharge(undefined)).toBe(false)
  })

  test("Max→Ultra and carry true-up cannot bypass the initial ramp, and 72 hours releases only once", async () => {
    const fakes = seed()
    month(fakes, 100)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const original = (await readModelPlanAccount(id, fakes.fetcher))!
    fakes.store.zset(codiumKey("held", original.key!.hash)).set("held:chat:-:1000000", now + 600_000)
    month(fakes, 200, {
      subscription: "sub_ultra",
      start: fixture.now,
      secure: "authenticated",
      supersedes: "sub_active",
    })
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const upgraded = (await readModelPlanAccount(id, fakes.fetcher))!
    expect(upgraded.firstHighPaidAt).toBe(original.firstHighPaidAt)
    expect(upgraded.key!.creditsMicro).toBe(30_000_000)
    expect(upgraded.key!.carry!.micro).toBe(13_400_000)
    expect((await checkCodiumFunding(fakes.fetcher, now)).owed).toBe(14_800)
    fakes.clock.advance(12 * 60_000)
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.creditsMicro).toBe(30_000_000)
    expect((await checkCodiumFunding(fakes.fetcher, fakes.clock.now)).owed).toBe(14_800)
    fakes.clock.now = upgraded.poolRamp!.until
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    const released = (await readModelPlanAccount(id, fakes.fetcher))!
    expect(released.key!.creditsMicro).toBe(100_000_000)
    expect(fakes.openRouter.keys.get(released.key!.hash)!.limit).toBe(148)
    expect((await checkCodiumFunding(fakes.fetcher, fakes.clock.now)).owed).toBe(14_800)
    expect((await readSnapshot(id, fakes.fetcher))!.caps.dailyShare).toBe(0.4)
    const patches = fakes.openRouter.calls.filter((call) => call.method === "PATCH").length
    await drainOutbox({ now: fakes.clock.now + 1000, fetcher: fakes.fetcher })
    expect(fakes.openRouter.calls.filter((call) => call.method === "PATCH")).toHaveLength(patches)
  })

  test("an overspend charged by the ramped true-up is not charged again when the ramp ends", async () => {
    const fakes = seed()
    month(fakes, 100)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const original = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    fakes.openRouter.keys.get(original.hash)!.usage = 10
    const hold = await holdPool(id, 2, 600_000, "hosted", { fetcher: fakes.fetcher, clock: () => fakes.clock.now })
    month(fakes, 200, {
      subscription: "sub_ultra",
      start: fixture.now,
      secure: "authenticated",
      supersedes: "sub_active",
    })
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const upgraded = (await readModelPlanAccount(id, fakes.fetcher))!
    // Visible source limit 14.4 (ramped), full 48; 10 used and 2 held at the upgrade.
    expect(upgraded.key!.carry).toMatchObject({ micro: 2_400_000, fullMicro: 38_000_000 })
    // The producer charges 3 against its 2 hold on the replaced pool: 1 above what the carry left for it.
    expect(await hold.settle(3, "hosted:over")).toEqual({ recorded: true, applied: true })
    fakes.clock.advance(12 * 60_000)
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    const limited = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    // Ramped support is 14.4 − 3 − 10 = 1.4: the 1.0 granted above it is charged once, to the successor pool.
    expect(limited.carry!.micro).toBe(2_400_000)
    expect((await readDebits(id, limited.hash, fakes.fetcher)).map((debit) => debit.micro)).toEqual([1_000_000])
    expect(fakes.openRouter.keys.get(limited.hash)!.limit).toBe(31.4)
    // Everything owed for both months: the full source left 48 − 3 − 10 = 35, plus Ultra's 100.
    expect((await checkCodiumFunding(fakes.fetcher, fakes.clock.now)).owed).toBe(13_500)
    fakes.clock.now = upgraded.poolRamp!.until
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    const released = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    const debits = await readDebits(id, released.hash, fakes.fetcher)
    expect(debits.map((debit) => debit.micro)).toEqual([1_000_000])
    // Full support is 35, granted exactly once: the carry rises over the 1.0 already charged instead of keeping it.
    expect(released.carry!.micro - 1_000_000).toBe(35_000_000)
    expect(fakes.openRouter.keys.get(released.hash)!.limit).toBe(135)
    expect((await checkCodiumFunding(fakes.fetcher, fakes.clock.now)).owed).toBe(13_500)
  })
})

describe("A10 deferred allowance funding", () => {
  test("funding counts the full paid month while the provider key is ramped or frozen", async () => {
    const fakes = seed()
    month(fakes, 200)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const key = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    expect(fakes.openRouter.keys.get(key.hash)!.limit).toBe(30)
    expect(fakes.store.hash(rampOwedKey()).get(id)).toBe("7000")
    expect((await checkCodiumFunding(fakes.fetcher, now)).owed).toBe(10_000)
    const hint = dispute(fakes, "needs_response")
    await reconcileModelPlanAccount(id, fakes.fetcher, now, { hint })
    expect(fakes.openRouter.keys.get(key.hash)!.disabled).toBe(true)
    expect(fakes.store.hash(rampOwedKey()).get(id)).toBe("10000")
    expect((await checkCodiumFunding(fakes.fetcher, now)).owed).toBe(10_000)
  })

  test("failed first key creation remains fully funded after the sale reservation could have expired", async () => {
    const fakes = seed()
    month(fakes, 100)
    fakes.openRouter.fail = (call) =>
      call.method === "POST" ? new Response("unavailable", { status: 503 }) : undefined
    await expect(reconcileModelPlanAccount(id, fakes.fetcher, now)).rejects.toMatchObject({
      code: "MODEL_PLAN_UPSTREAM",
    })
    fakes.clock.advance(3 * HOUR)
    expect((await checkCodiumFunding(fakes.fetcher, fakes.clock.now)).owed).toBe(4800)
    expect(fakes.openRouter.keys.size).toBe(0)
  })

  test("failed early-upgrade key creation keeps the full deferred source month funded", async () => {
    const fakes = seed()
    month(fakes, 100)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const old = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    month(fakes, 200, { subscription: "sub_ultra", supersedes: "sub_active" })
    fakes.openRouter.fail = (call) =>
      call.method === "POST" ? new Response("unavailable", { status: 503 }) : undefined
    await expect(reconcileModelPlanAccount(id, fakes.fetcher, now)).rejects.toMatchObject({
      code: "MODEL_PLAN_UPSTREAM",
    })
    expect(fakes.openRouter.keys.get(old.hash)!.disabled).toBe(true)
    fakes.clock.advance(3 * HOUR)
    expect((await checkCodiumFunding(fakes.fetcher, fakes.clock.now)).owed).toBe(14_800)
  })

  test("a refunded ramped source never releases its deferred carry at 72 hours", async () => {
    const fakes = seed()
    month(fakes, 100)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    month(fakes, 200, { subscription: "sub_ultra", supersedes: "sub_active" })
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const upgraded = (await readModelPlanAccount(id, fakes.fetcher))!
    Object.assign(fakes.stripe.charge("ch_active")!, { refunded: true, amount_refunded: 10_000 })
    fakes.clock.now = upgraded.poolRamp!.until
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    const released = (await readModelPlanAccount(id, fakes.fetcher))!
    expect(released.key!.carry!.micro).toBe(0)
    expect(fakes.openRouter.keys.get(released.key!.hash)!.limit).toBe(100)
    expect((await checkCodiumFunding(fakes.fetcher, fakes.clock.now)).owed).toBe(10_000)
  })

  test("a mixed key/index reading during release fails closed rather than understating what is owed", async () => {
    const fakes = seed()
    month(fakes, 200)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const key = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    let changed = false
    const fetcher: typeof fetch = async (input, init) => {
      const response = await fakes.fetcher(input, init)
      if (String(input).includes("/keys?offset=0") && !changed) {
        changed = true
        fakes.openRouter.keys.get(key.hash)!.limit = 100
        await writeRampOwed(id, 0, fakes.fetcher)
      }
      return response
    }
    await expect(checkCodiumFunding(fetcher, now)).rejects.toMatchObject({ code: "CODIUM_RAMP_UNAVAILABLE" })
    expect((await checkCodiumFunding(fakes.fetcher, now)).owed).toBe(10_000)
  })
})

const valkeyURL = process.env.VECTOR_TEST_REDIS_URL

describe.skipIf(!valkeyURL)("A10 ramp liability Lua on Valkey", () => {
  const client = valkeyURL ? new RedisClient(valkeyURL) : undefined
  const fetcher = (async (_input, init) => {
    const command = JSON.parse(String(init?.body)).map(String) as string[]
    return Response.json({ result: await client!.send(command[0]!, command.slice(1)) })
  }) as typeof fetch
  beforeEach(async () => {
    await client!.send("FLUSHDB", [])
  })
  test("raise is monotonic, set transfers liability after provisioning, and version detects a mixed reading", async () => {
    const start = await rampVersion(fetcher)
    await writeRampOwed(id, 70_000_000, fetcher, "raise")
    const raised = await rampVersion(fetcher)
    expect(raised).not.toBe(start)
    await writeRampOwed(id, 1_000_000, fetcher, "raise")
    expect(await rampVersion(fetcher)).toBe(raised)
    expect(await rampOwedCents(raised, fetcher)).toBe(7000)
    await writeRampOwed(id, 0, fetcher)
    await expect(rampOwedCents(raised, fetcher)).rejects.toMatchObject({ code: "CODIUM_RAMP_UNAVAILABLE" })
    expect(await rampOwedCents(await rampVersion(fetcher), fetcher)).toBe(0)
  })
})
