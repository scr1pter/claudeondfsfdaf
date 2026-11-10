import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { checkoutConsentFields, CODIUM_TERMS_DATE } from "../api/_lib/codium-consent"
import { holdMember, POOL_SCRIPTS, readDebits, readPoolLedger } from "../api/_lib/codium-pool"
import { codiumKey } from "../api/_lib/codium-keys"
import { carryMicro, releaseDowngrade } from "../api/_lib/codium-plan-change"
import { MODEL_SPEND_SCRIPTS } from "../api/_lib/codium-spend-ledger"
import { drainOutbox, enqueueAction } from "../api/_lib/codium-provision"
import {
  holdPool,
  modelPlanChange,
  modelPlanPortal,
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

let restore = () => {}
beforeEach(() => {
  restore = codiumTestEnvironment({
    STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID: "bpc_fixture",
    VECTOR_ADMIN_EMAILS: "subscriber@example.invalid",
  })
})
afterEach(() => restore())
const fixture = loadStripeFixture("active-paid")
const id = fixture.accountId
const user = { id, email: "subscriber@example.invalid" }
const now = fixture.now * 1000
const accountKey = codiumKey("account", id)

function seed() {
  const fakes = codiumFakes({ now })
  fakes.stripe.load(fixture.objects)
  fakes.store.set(accountKey, JSON.stringify(fixture.account))
  return fakes
}

/** A separately paid full month, as subscription-mode Checkout creates for an upgrade. */
function paidUpgrade(
  fakes: CodiumFakes,
  amount: 50 | 100 | 200 = 50,
  subscriptionID = "sub_upgrade",
  supersedes = "sub_active",
) {
  const source = fakes.stripe.subscription("sub_active")!
  const invoice = structuredClone(fixture.objects.invoices![0]!)
  const charge = structuredClone(fixture.objects.charges![0]!)
  const subscription = structuredClone(source)
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
    },
    items: { data: [{ id: "si_upgrade", price, quantity: 1 }] },
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

async function active(fakes: CodiumFakes) {
  await reconcileModelPlanAccount(id, fakes.fetcher, now)
  return (await readModelPlanAccount(id, fakes.fetcher))!.key!
}

/** An open model reservation on `key`'s pool, as ADMIT records it, with its live member while before `deadline`. */
function reserve(fakes: CodiumFakes, key: { hash: string; end: number }, micro: number, deadline: number) {
  const ticket = crypto.randomUUID()
  const member = holdMember(ticket, "chat", undefined, micro)
  const record = {
    account: id,
    pool: key.hash,
    ticket,
    member,
    purpose: "chat",
    micro: String(micro),
    day: new Date(deadline).toISOString().slice(0, 10),
    epoch: "fixture",
    version: "1",
    deadline: String(deadline),
    admittedAt: String(deadline - 660_000),
    periodEnd: String(key.end * 1000),
    runUntil: String(deadline),
    state: "open",
  }
  fakes.store.hash(codiumKey("model-reservations", key.hash)).set(ticket, JSON.stringify(record))
  const ledger = fakes.store.hash(codiumKey("model-spend", key.hash))
  ledger.set("reserved", String(Number(ledger.get("reserved")) + micro))
  ledger.set("openCount", String(Number(ledger.get("openCount")) + 1))
  if (deadline > fakes.clock.now) fakes.store.zset(codiumKey("held", key.hash)).set(member, deadline)
}

function funded(fakes: CodiumFakes) {
  fakes.store.set(
    codiumKey("funding"),
    JSON.stringify({ status: "open", checkedAt: now, since: now, balance: 1_000_000, owed: 0, required: 0, keys: 0 }),
  )
  // Funding's atomic reservation script must be exercised by its own tests; here check what /change reserves.
  const script =
    "local reserved = 0 local entries = redis.call('HGETALL', KEYS[1]) for i = 1, #entries, 2 do local lapses, cents = string.match(entries[i + 1], '^(%d+):(%d+)$') if not lapses or tonumber(lapses) <= tonumber(ARGV[1]) or entries[i] == ARGV[3] then redis.call('HDEL', KEYS[1], entries[i]) elseif entries[i] ~= ARGV[2] then reserved = reserved + tonumber(cents) end end if tonumber(ARGV[6]) < math.ceil((tonumber(ARGV[7]) + reserved + tonumber(ARGV[4])) * (100 + tonumber(ARGV[8])) / 100) + tonumber(ARGV[9]) then return 0 end redis.call('HSET', KEYS[1], ARGV[2], ARGV[5] .. ':' .. ARGV[4]) return 1"
  fakes.store.scripts.set(script, ([key], args) => {
    fakes.store.hash(key!).set(args[1]!, `${args[4]}:${args[3]}`)
    return 1
  })
}

describe("Codium plan change", () => {
  test("carry subtracts spend and reservations, clamps exhausted periods, and refuses unreadable amounts", () => {
    expect(carryMicro(4_000_000, 250_000, 1_000_000)).toBe(2_750_000)
    expect(carryMicro(10, 20)).toBe(0)
    expect(() => carryMicro(10, NaN)).toThrow()
  })

  test("paid upgrade carries once, starts new meters, cancels once, and clears collectible invoices", async () => {
    const fakes = seed()
    const old = await active(fakes)
    fakes.openRouter.keys.get(old.hash)!.usage = 0.25
    fakes.store.zset(codiumKey("held", old.hash)).set("ticket:chat:-:1000000", now + 600_000)
    fakes.stripe.load({
      invoices: [
        { id: "in_oldopen", customer: fixture.account.customer, subscription: "sub_active", status: "open" },
        { id: "in_olddraft", customer: fixture.account.customer, subscription: "sub_active", status: "draft" },
      ],
    })
    paidUpgrade(fakes)
    const snapshot = await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const account = (await readModelPlanAccount(id, fakes.fetcher))!
    expect(account.key!.carry).toMatchObject({
      micro: 2_750_000,
      fromSubscription: "sub_active",
      fromCharge: "ch_active",
    })
    expect(fakes.openRouter.keys.get(old.hash)!.disabled).toBe(true)
    expect(fakes.openRouter.keys.get(account.key!.hash)!.limit).toBe(24.75)
    expect(snapshot.meterEpoch).toBe(`sub_upgrade:${fixture.now * 1000}`)
    expect(fakes.stripe.subscription("sub_active")!.status).toBe("canceled")
    expect(fakes.stripe.objects.invoices.get("in_oldopen")!.status).toBe("void")
    expect(fakes.stripe.objects.invoices.has("in_olddraft")).toBe(false)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry!.micro).toBe(2_750_000)
    expect(
      fakes.stripe.calls.filter((call) => call.method === "DELETE" && call.path === "subscriptions/sub_active"),
    ).toHaveLength(1)
    expect(fakes.openRouter.calls.filter((call) => call.method === "POST")).toHaveLength(2)
  })

  test("delayed true-up raises only, ignores the replaced key, and removes carry when its source is reversed", async () => {
    const fakes = seed()
    const old = await active(fakes)
    fakes.openRouter.keys.get(old.hash)!.usage = 0.25
    fakes.store.zset(codiumKey("held", old.hash)).set("ticket:chat:-:1000000", now + 600_000)
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const key = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    fakes.clock.advance(12 * 60_000)
    fakes.openRouter.keys.get(old.hash)!.usage = 0.5
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry!.micro).toBe(3_500_000)
    expect(fakes.openRouter.keys.get(key.hash)!.limit).toBe(25.5)
    Object.assign(fakes.stripe.charge("ch_active")!, { refunded: true, amount_refunded: 1000 })
    await reconcileModelPlanAccount(id, fakes.fetcher, fakes.clock.now)
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry!.micro).toBe(0)
    expect(fakes.openRouter.keys.get(key.hash)!.limit).toBe(22)
  })

  test("late hosted debits on a replaced key stay spent after true-up", async () => {
    const fakes = seed()
    const old = await active(fakes)
    const hold = await holdPool(id, 1, 60_000, "hosted", { fetcher: fakes.fetcher, clock: () => fakes.clock.now })
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry!.micro).toBe(3_000_000)
    // The settle lands on the hold's own (replaced) pool: its identity never moves to the successor.
    expect(await hold.settle(1, "hosted:late")).toEqual({ recorded: true, applied: true })
    expect(await readPoolLedger(id, old.hash, fakes.clock.now, fakes.fetcher)).toMatchObject({
      appliedMicro: 1_000_000,
    })
    fakes.clock.advance(12 * 60_000)
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    const key = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    expect(key.carry!.micro).toBe(3_000_000)
    expect(await readDebits(id, key.hash, fakes.fetcher)).toEqual([])
  })

  test("a source charge settled above its hold after an upgrade is charged once, to the successor pool", async () => {
    const fakes = seed()
    const old = await active(fakes)
    const hold = await holdPool(id, 1, 60_000, "hosted", { fetcher: fakes.fetcher, clock: () => fakes.clock.now })
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const replaced = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    expect(replaced.carry!.micro).toBe(3_000_000)
    // The producer charged 1.5 against a 1.0 hold. The carry already granted the 0.5 it did not hold.
    expect(await hold.settle(1.5, "hosted:over")).toEqual({ recorded: true, applied: true })
    fakes.clock.advance(12 * 60_000)
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    const key = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    // Carry never goes down (M6); the 0.5 is a debit on the successor, so the source's 4.0 is granted exactly once.
    expect(key.carry!.micro).toBe(3_000_000)
    const debits = await readDebits(id, key.hash, fakes.fetcher)
    expect(debits.map((debit) => [debit.micro, debit.applied])).toEqual([[500_000, true]])
    const source = await readPoolLedger(id, old.hash, fakes.clock.now, fakes.fetcher)
    expect(key.carry!.micro - 500_000 + source.appliedMicro).toBeLessThanOrEqual(4_000_000)
    expect(fakes.openRouter.keys.get(key.hash)!.limit).toBe(24.5)
    // A second pass (the ramp's true-up, or a retry) charges nothing again.
    await enqueueAction(
      "carry-trueup",
      `${id}:${key.hash}:again`,
      { account: id, hash: key.hash },
      fakes.clock.now,
      fakes.fetcher,
      fakes.clock.now,
    )
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    expect((await readDebits(id, key.hash, fakes.fetcher)).map((debit) => debit.micro)).toEqual([500_000])
  })

  test("repeated upgrades retain payment ancestry, and a source refund cannot be hidden by another upgrade", async () => {
    const fakes = seed()
    const old = await active(fakes)
    fakes.openRouter.keys.get(old.hash)!.usage = 0.25
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    paidUpgrade(fakes, 100, "sub_second", "sub_upgrade")
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const current = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    expect(current.carry!.micro).toBe(25_750_000)
    expect(current.carry!.origins).toEqual([
      { charge: "ch_sub_upgrade", micro: 22_000_000 },
      { charge: "ch_active", micro: 3_750_000 },
    ])
    Object.assign(fakes.stripe.charge("ch_active")!, { refunded: true, amount_refunded: 1000 })
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry!.micro).toBe(22_000_000)
    fakes.clock.advance(12 * 60_000)
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry!.micro).toBe(22_000_000)
    expect(fakes.openRouter.keys.get(current.hash)!.limit).toBe(70)
  })

  test("a second upgrade before the first true-up never grants the first source's held spend again", async () => {
    // [what the first pool's 1.0 hold does before the second upgrade, the carry that upgrade's true-up may grant]
    const cases = [
      ["spent", 24_750_000],
      ["released", 25_750_000],
      ["still held", 24_750_000],
    ] as const
    for (const [outcome, final] of cases) {
      const fakes = seed()
      const first = await active(fakes)
      fakes.openRouter.keys.get(first.hash)!.usage = 0.25
      // A live 1.0 hold on the first pool at the first upgrade: not carried, the true-up would return what it left.
      const hold = await holdPool(id, 1, 600_000, "hosted", { fetcher: fakes.fetcher, clock: () => fakes.clock.now })
      paidUpgrade(fakes)
      await reconcileModelPlanAccount(id, fakes.fetcher, now)
      const middle = (await readModelPlanAccount(id, fakes.fetcher))!.key!
      expect(middle.carry).toMatchObject({ micro: 2_750_000, fullMicro: 3_750_000 })
      // Then a second upgrade lands within the true-up delay, so the middle key's own true-up never runs.
      if (outcome === "spent") expect(await hold.settle(1, "hosted:spent")).toEqual({ recorded: true, applied: true })
      if (outcome === "released") await hold.release()
      paidUpgrade(fakes, 100, "sub_second", "sub_upgrade")
      await reconcileModelPlanAccount(id, fakes.fetcher, now)
      const last = (await readModelPlanAccount(id, fakes.fetcher))!.key!
      // The middle pool spent nothing and shows 22 + 2.75. A hold still live now counts as spent: it can never be
      // returned by the middle key's true-up, so returning it later would rest on a value nobody re-checks.
      expect(last.carry!.micro).toBe(24_750_000)
      expect(last.carry!.fromLimitMicro).toBe(final)
      if (outcome === "still held") await hold.release()
      fakes.clock.advance(12 * 60_000)
      await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
      const trued = (await readModelPlanAccount(id, fakes.fetcher))!.key!
      // Spent: the first pool had 4.0 − 0.25 − 1.0 = 2.75 left. Released before the upgrade: 3.75, granted once.
      expect(trued.carry!.micro).toBe(final)
      expect(fakes.openRouter.keys.get(trued.hash)!.limit).toBe(48 + final / 1_000_000)
      // The next upgrade from here starts from the settled value, not the first key's upper bound.
      expect(trued.carry).toMatchObject({ fullMicro: final, trued: true })
    }
  })

  test("true-up cannot resurrect an older allowance consumed before an intermediate source was refunded", async () => {
    const fakes = seed()
    await active(fakes)
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const middle = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    fakes.openRouter.keys.get(middle.hash)!.usage = 10
    paidUpgrade(fakes, 100, "sub_second", "sub_upgrade")
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry!.origins).toEqual([
      { charge: "ch_sub_upgrade", micro: 16_000_000 },
    ])
    Object.assign(fakes.stripe.charge("ch_sub_upgrade")!, { refunded: true, amount_refunded: 5000 })
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    fakes.clock.advance(12 * 60_000)
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry!.micro).toBe(0)
  })

  test("a source reversal after interrupted key creation is removed before the replacement can serve", async () => {
    const fakes = seed()
    await active(fakes)
    paidUpgrade(fakes)
    fakes.openRouter.fail = (call) =>
      call.method === "POST" ? new Response("unavailable", { status: 503 }) : undefined
    await expect(reconcileModelPlanAccount(id, fakes.fetcher, now)).rejects.toMatchObject({
      code: "MODEL_PLAN_UPSTREAM",
    })
    Object.assign(fakes.stripe.charge("ch_active")!, { refunded: true, amount_refunded: 1000 })
    fakes.openRouter.fail = undefined
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const key = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    expect(key.carry!.micro).toBe(0)
    expect(fakes.openRouter.keys.get(key.hash)!.limit).toBe(22)
    const attempts = fakes.openRouter.calls.filter(
      (call) => call.method === "POST" && call.json?.name !== fakes.openRouter.keys.get("fake_key_1")?.name,
    )
    expect(attempts.map((call) => call.json!.limit)).toEqual([26, 26])
  })

  test("a source refund discovered by the true-up itself lowers the stored and provider limits", async () => {
    const fakes = seed()
    await active(fakes)
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    Object.assign(fakes.stripe.charge("ch_active")!, { refunded: true, amount_refunded: 1000 })
    fakes.clock.advance(12 * 60_000)
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    const key = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    expect(key.carry!.micro).toBe(0)
    expect(key.limitMicro).toBe(22_000_000)
    expect(fakes.openRouter.keys.get(key.hash)!.limit).toBe(22)
  })

  test("a hold during a replacement waits for its lease and never spends a carry before it is validated", async () => {
    const fakes = seed()
    await active(fakes)
    paidUpgrade(fakes)
    let resume = () => {}
    let entered = () => {}
    let attempted = () => {}
    let waiting = false
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    const paused = new Promise<void>((resolve) => {
      entered = resolve
    })
    const lease = new Promise<void>((resolve) => {
      attempted = resolve
    })
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.includes("charges/ch_active") && !waiting && JSON.parse(fakes.store.get(accountKey)!).key?.provisioning) {
        waiting = true
        entered()
        await gate
      }
      if (waiting && typeof init?.body === "string") {
        const body = JSON.parse(init.body)
        if (Array.isArray(body) && body[0] === "SET" && body[1] === codiumKey("lease", id) && body.includes("NX"))
          attempted()
      }
      return fakes.fetcher(input, init)
    }
    const reconcile = reconcileModelPlanAccount(id, fetcher, now)
    await paused
    Object.assign(fakes.stripe.charge("ch_active")!, { refunded: true, amount_refunded: 1000 })
    // The production hold path (chat's credential and fence too): the replacement's key is still provisioning with an
    // unvalidated carry, so the hold gets no credential and its one on-demand reconcile waits for the lease.
    const clock = () => fakes.clock.now
    const admission = holdPool(id, 25, 60_000, "hosted", { fetcher, clock }).then(
      () => "admitted",
      (error: { code?: string }) => error.code,
    )
    try {
      expect(await Promise.race([lease.then(() => "lease"), admission])).toBe("lease")
    } finally {
      resume()
    }
    await reconcile
    expect(await admission).toBe("MODEL_PLAN_RENEWING")
    // Read again, the validated carry is gone with its refunded source: 25 is more than the new pool holds.
    await expect(holdPool(id, 25, 60_000, "hosted", { fetcher: fakes.fetcher, clock })).rejects.toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
    })
    const replaced = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    expect(replaced.carry?.micro ?? 0).toBe(0)
    expect(await readPoolLedger(id, replaced.hash, fakes.clock.now, fakes.fetcher)).toMatchObject({ heldMicro: 0 })
  })

  test("a hold delayed past an upgrade's barrier never lands on the source after its balances were read", async () => {
    const fakes = seed()
    const old = await active(fakes)
    paidUpgrade(fakes)
    let parked = () => {}
    let release = () => {}
    const reached = new Promise<void>((resolve) => (parked = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    // The hold prices itself against the record as it is just before the replacement's first write or observation,
    // while the source key is still on; its HOLD is delayed until the instant after the source ledger was read.
    const delayed: typeof fetch = async (input, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      if (Array.isArray(body) && body[0] === "EVAL" && body[1] === POOL_SCRIPTS.HOLD) {
        parked()
        await gate
      }
      return fakes.fetcher(input, init)
    }
    let hold: Promise<unknown> | undefined
    let landed = false
    const reconciling: typeof fetch = async (input, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      const barrier =
        Array.isArray(body) && body[0] === "SET" && body[1] === accountKey && String(body[2]).includes('"transition"')
      // Whichever comes first: the barrier, or the replacement's first look at the source (its subscription).
      if (!hold && (barrier || String(input).includes("/subscriptions/sub_active?"))) {
        hold = holdPool(id, 1, 60_000, "hosted", { fetcher: delayed, clock: () => fakes.clock.now }).catch(
          (error: unknown) => error,
        )
        await Promise.race([reached, hold])
      }
      const response = await fakes.fetcher(input, init)
      const sourceRead =
        Array.isArray(body) &&
        body[0] === "EVAL" &&
        body[1] === MODEL_SPEND_SCRIPTS.READ &&
        body[3] === codiumKey("model-spend", old.hash)
      if (sourceRead && !landed) {
        landed = true
        release()
        await hold
      }
      return response
    }
    await reconcileModelPlanAccount(id, reconciling, now)
    expect(landed).toBe(true)
    const key = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    // Nothing was held when the source was read, so the whole 4.0 carries.
    expect(key.carry!.micro).toBe(4_000_000)
    expect(await hold).toMatchObject({ statusCode: 503, code: "MODEL_PLAN_RENEWING" })
    const source = await readPoolLedger(id, old.hash, fakes.clock.now, fakes.fetcher)
    expect(source).toMatchObject({ heldMicro: 0, appliedMicro: 0, pendingMicro: 0 })
    // The carry plus everything the source can still spend stays within its 4.0.
    expect(key.carry!.micro + source.heldMicro + source.appliedMicro + source.committedMicro).toBeLessThanOrEqual(
      4_000_000,
    )
  })

  test("a hold gets one on-demand repair for a key that is not ready, and a final answer for its plan state", async () => {
    const fakes = seed()
    const key = await active(fakes)
    // The key is off at the provider until reconcile repairs it: one on-demand reconcile, then the hold is placed.
    fakes.openRouter.keys.get(key.hash)!.disabled = true
    const hold = await holdPool(id, 1, 60_000, "hosted", { fetcher: fakes.fetcher, clock: () => fakes.clock.now })
    expect(hold.micro).toBe(1_000_000)
    expect(fakes.openRouter.keys.get(key.hash)!.disabled).toBe(false)
    await hold.release()
    // That minute's reconcile is spent: the next unready key is a retryable answer, not a second Stripe read.
    fakes.openRouter.keys.get(key.hash)!.disabled = true
    const reads = fakes.stripe.calls.length
    await expect(
      holdPool(id, 1, 60_000, "hosted", { fetcher: fakes.fetcher, clock: () => fakes.clock.now }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "MODEL_PLAN_RENEWING",
      retryAfterSeconds: 1,
    })
    expect(fakes.stripe.calls).toHaveLength(reads)
    // A failed payment is final for a producer exactly as for chat: 402 with its action, never an endless retry.
    fakes.stripe.subscription("sub_active")!.status = "past_due"
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    await expect(
      holdPool(id, 1, 60_000, "hosted", { fetcher: fakes.fetcher, clock: () => fakes.clock.now }),
    ).rejects.toMatchObject({
      statusCode: 402,
      code: "MODEL_PLAN_PAYMENT_REQUIRED",
      detail: { reason: "payment_failed", action: "update-card" },
    })
    expect(await readPoolLedger(id, key.hash, fakes.clock.now, fakes.fetcher)).toMatchObject({ heldMicro: 0 })
  })

  test("a replacement interrupted after its barrier resumes with one carry, and nothing lands on the source meanwhile", async () => {
    const fakes = seed()
    const old = await active(fakes)
    paidUpgrade(fakes)
    // The source subscription cannot be read: the barrier is saved, nothing was observed or switched off yet.
    fakes.stripe.fail = (call) =>
      call.method === "GET" && call.path === "subscriptions/sub_active"
        ? new Response("{}", { status: 503 })
        : undefined
    await expect(reconcileModelPlanAccount(id, fakes.fetcher, now)).rejects.toBeDefined()
    const interrupted = (await readModelPlanAccount(id, fakes.fetcher))!
    expect(interrupted.transition).toMatchObject({ subscription: "sub_upgrade" })
    expect(interrupted.upgrade).toBeUndefined()
    expect(interrupted.key!.hash).toBe(old.hash)
    // A hold is refused: its one on-demand reconcile resumes the replacement, which still cannot read the source.
    await expect(
      holdPool(id, 1, 60_000, "hosted", { fetcher: fakes.fetcher, clock: () => fakes.clock.now }),
    ).rejects.toMatchObject({
      code: "BILLING_UPSTREAM",
    })
    expect(await readPoolLedger(id, old.hash, fakes.clock.now, fakes.fetcher)).toMatchObject({ heldMicro: 0 })
    fakes.stripe.fail = undefined
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const key = (await readModelPlanAccount(id, fakes.fetcher))!
    expect(key.transition).toBeUndefined()
    expect(key.key!.hash).not.toBe(old.hash)
    expect(key.key!.carry!.micro).toBe(4_000_000)
    expect(await readPoolLedger(id, old.hash, fakes.clock.now, fakes.fetcher)).toMatchObject({ heldMicro: 0 })
  })

  test("a replacement whose target stops governing is abandoned: the source serves again and nothing carries", async () => {
    const fakes = seed()
    const old = await active(fakes)
    paidUpgrade(fakes)
    // Key creation fails after the barrier, the upgrade intent and the disabled source.
    fakes.openRouter.fail = (call) =>
      call.method === "POST" ? new Response("unavailable", { status: 503 }) : undefined
    await expect(reconcileModelPlanAccount(id, fakes.fetcher, now)).rejects.toMatchObject({
      code: "MODEL_PLAN_UPSTREAM",
    })
    const stuck = (await readModelPlanAccount(id, fakes.fetcher))!
    expect(stuck.transition).toMatchObject({ subscription: "sub_upgrade" })
    expect(stuck.upgrade).toBeDefined()
    expect(fakes.openRouter.keys.get(old.hash)!.disabled).toBe(true)
    // A hold is refused: its one on-demand reconcile resumes the replacement, whose key creation still fails.
    await expect(
      holdPool(id, 1, 60_000, "hosted", { fetcher: fakes.fetcher, clock: () => fakes.clock.now }),
    ).rejects.toMatchObject({
      code: "MODEL_PLAN_UPSTREAM",
    })
    expect(await readPoolLedger(id, old.hash, fakes.clock.now, fakes.fetcher)).toMatchObject({ heldMicro: 0 })
    // The target stops superseding the source before it ever got a key. A refunded or cancelled target still
    // supersedes (governingStanding), so the only such case is a target Stripe reports as never having started.
    fakes.openRouter.fail = undefined
    Object.assign(fakes.stripe.subscription("sub_upgrade")!, { status: "incomplete_expired" })
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const resumed = (await readModelPlanAccount(id, fakes.fetcher))!
    expect(resumed.transition).toBeUndefined()
    expect(resumed.upgrade).toBeUndefined()
    expect(resumed.keyCreation).toBeUndefined()
    expect(resumed.key!.hash).toBe(old.hash)
    expect(resumed.key!.carry).toBeUndefined()
    expect(fakes.openRouter.keys.get(old.hash)!.disabled).toBe(false)
    expect(
      (await holdPool(id, 1, 60_000, "hosted", { fetcher: fakes.fetcher, clock: () => fakes.clock.now })).micro,
    ).toBe(1_000_000)
  })

  test("a key made for an abandoned replacement is the one its period gets if it governs again, never a second", async () => {
    const fakes = seed()
    const old = await active(fakes)
    paidUpgrade(fakes)
    // OpenRouter makes the replacement's key, but its answer never arrives.
    let lose = true
    const lossy: typeof fetch = async (input, init) => {
      const answer = await fakes.fetcher(input, init)
      if (!lose || init?.method !== "POST" || !String(input).startsWith("https://openrouter.ai/api/v1/keys"))
        return answer
      lose = false
      return new Response("lost", { status: 503 })
    }
    await expect(reconcileModelPlanAccount(id, lossy, now)).rejects.toMatchObject({ code: "MODEL_PLAN_UPSTREAM" })
    const made = [...fakes.openRouter.keys.keys()].filter((hash) => hash !== old.hash)
    expect(made).toHaveLength(1)
    // The target stops governing before its key was published: the replacement is abandoned and the source serves.
    Object.assign(fakes.stripe.subscription("sub_upgrade")!, { status: "incomplete_expired" })
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const abandoned = (await readModelPlanAccount(id, fakes.fetcher))!
    expect(abandoned.key!.hash).toBe(old.hash)
    expect(abandoned.keyCreation).toBeUndefined()
    expect(abandoned.abandonedCreations).toMatchObject([{ subscription: "sub_upgrade" }])
    // The listing flaps back and the target governs again. Its creation reuses the abandoned nonce, so OpenRouter
    // answers the key it already made: one funded key for that period, never a second one counted as owed.
    Object.assign(fakes.stripe.subscription("sub_upgrade")!, { status: "active" })
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const replaced = (await readModelPlanAccount(id, fakes.fetcher))!
    expect(replaced.key!.hash).toBe(made[0])
    expect([...fakes.openRouter.keys.keys()].filter((hash) => hash !== old.hash)).toEqual(made)
    expect(replaced.abandonedCreations).toBeUndefined()
    expect(replaced.key!.carry!.micro).toBe(4_000_000)
  })

  test("carry and true-up use the committed floor and abandoned reservations, once, and wait only for live ones", async () => {
    const fakes = seed()
    const old = await active(fakes)
    // Provider usage lags at 0.25 while 1.0 of model charges were settled durably; 0.5 was reserved by a request whose
    // outcome is unknown (past its deadline) and 0.25 by one still running.
    fakes.openRouter.keys.get(old.hash)!.usage = 0.25
    const ledger = fakes.store.hash(codiumKey("model-spend", old.hash))
    ledger.set("committed", "1000000")
    ledger.set("compacted", "1000000")
    reserve(fakes, old, 500_000, now - 1)
    reserve(fakes, old, 250_000, now + 600_000)
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const key = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    expect(key.carry!.micro).toBe(4_000_000 - 1_000_000 - 500_000 - 250_000)
    // At the true-up the running request is still live: it waits instead of releasing its money.
    fakes.clock.advance(5 * 60_000)
    await enqueueAction(
      "carry-trueup",
      `${id}:${key.hash}:early`,
      { account: id, hash: key.hash },
      fakes.clock.now,
      fakes.fetcher,
      fakes.clock.now,
    )
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry!.micro).toBe(2_250_000)
    // Past every deadline both reservations are abandoned: counted as consumed with the floor, never summed with a
    // provider usage that already shows the same charges.
    fakes.clock.advance(12 * 60_000)
    fakes.openRouter.keys.get(old.hash)!.usage = 1.4
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    const trued = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    expect(trued.carry!.micro).toBe(4_000_000 - Math.max(1_400_000, 1_000_000 + 750_000))
    expect(await readDebits(id, trued.hash, fakes.fetcher)).toEqual([])
  })

  test("combined base and carry respect the test-mode key cap", async () => {
    process.env.CODIUM_TEST_CREDIT_CAP_USD = "0.50"
    const fakes = seed()
    await active(fakes)
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const key = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    expect(fakes.openRouter.keys.get(key.hash)!.limit).toBe(0.5)
    fakes.clock.advance(12 * 60_000)
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    expect(fakes.openRouter.keys.get(key.hash)!.limit).toBe(0.5)
  })

  test("key creation retry keeps the original carry and never creates a second funded replacement", async () => {
    const fakes = seed()
    const old = await active(fakes)
    fakes.openRouter.keys.get(old.hash)!.usage = 0.25
    paidUpgrade(fakes)
    let failed = false
    fakes.openRouter.fail = (call) => {
      if (call.method === "POST" && !failed) {
        failed = true
        return new Response("unavailable", { status: 503 })
      }
    }
    await expect(reconcileModelPlanAccount(id, fakes.fetcher, now)).rejects.toMatchObject({
      code: "MODEL_PLAN_UPSTREAM",
    })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.upgrade!.micro).toBe(3_750_000)
    fakes.openRouter.fail = undefined
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry!.micro).toBe(3_750_000)
    expect(fakes.openRouter.keys.size).toBe(2)
  })

  test("an unpaid or reversed source contributes no carry", async () => {
    const fakes = seed()
    await active(fakes)
    Object.assign(fakes.stripe.charge("ch_active")!, { refunded: true, amount_refunded: 1000 })
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry).toBeUndefined()
  })

  test("upgrade refuses paused, scheduled and risk-blocked accounts before opening checkout", async () => {
    for (const situation of ["past_due", "scheduled", "blocked"]) {
      const fakes = seed()
      await active(fakes)
      if (situation === "past_due") fakes.stripe.subscription("sub_active")!.status = "past_due"
      if (situation === "scheduled") {
        fakes.stripe.subscription("sub_active")!.schedule = "sub_schedforeign"
        fakes.stripe.load({
          subscription_schedules: [
            {
              id: "sub_schedforeign",
              customer: fixture.account.customer,
              subscription: "sub_active",
              status: "active",
              phases: [],
            },
          ],
        })
      }
      if (situation === "blocked")
        fakes.store.set(
          accountKey,
          JSON.stringify({
            ...(await readModelPlanAccount(id, fakes.fetcher)),
            risk: { blocked: true, reason: "owner", openDisputes: {}, efw: [] },
          }),
        )
      await expect(modelPlanChange(user, "vector-50", fakes.fetcher, now)).rejects.toMatchObject({
        code: "MODEL_PLAN_CHANGE_UNAVAILABLE",
      })
      expect(fakes.stripe.calls.some((call) => call.method === "POST" && call.path === "checkout/sessions")).toBe(false)
    }
  })

  test("upgrade reserves its sale, binds supersedes on the server, collects consent and preserves old-client returns", async () => {
    const fakes = seed()
    await active(fakes)
    funded(fakes)
    expect(await modelPlanChange(user, "vector-50", fakes.fetcher, now)).toEqual({
      url: "https://checkout.stripe.com/c/fixture",
    })
    const checkout = fakes.stripe.calls.find((call) => call.method === "POST" && call.path === "checkout/sessions")!
    expect(checkout.form!.get("subscription_data[metadata][vector_supersedes]")).toBe("sub_active")
    expect(checkout.form!.get("success_url")).toBe("https://vectordev.ai/account?model_plan=success&change=upgrade")
    expect(checkout.form!.get("consent_collection[terms_of_service]")).toBe("required")
    expect(fakes.store.hash(codiumKey("funding", "reserved")).size).toBe(1)
    await modelPlanChange(user, "vector-50", fakes.fetcher, now)
    expect(
      fakes.stripe.calls.filter((call) => call.method === "POST" && call.path === "checkout/sessions"),
    ).toHaveLength(1)
  })

  test("downgrade bills the current price until renewal, then releases to the lower price; cancellation releases first", async () => {
    const fakes = seed()
    await active(fakes)
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(await modelPlanChange(user, "vector-10", fakes.fetcher, now)).toMatchObject({
      scheduled: { plan: "vector-10" },
    })
    const schedule = fakes.stripe.calls.find(
      (call) => call.method === "POST" && call.path.startsWith("subscription_schedules/"),
    )!
    expect(schedule.form!.get("end_behavior")).toBe("release")
    expect(schedule.form!.get("phases[0][items][0][price]")).toBe("price_codium50")
    expect(schedule.form!.get("phases[1][items][0][price]")).toBe("price_codium10")
    const snapshot = await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(snapshot.scheduled?.plan).toBe("vector-10")
    await modelPlanPortal(id, fakes.fetcher, { flow: "cancel", now })
    const release = fakes.stripe.calls.findIndex((call) => call.path.endsWith("/release"))
    const portal = fakes.stripe.calls.findIndex((call) => call.path === "billing_portal/sessions")
    expect(release).toBeGreaterThan(-1)
    expect(portal).toBeGreaterThan(release)
    expect(fakes.stripe.subscription("sub_upgrade")!.schedule).toBeNull()
  })

  test("item-level Stripe periods drive both schedule creation and its entitlement snapshot", async () => {
    const fakes = seed()
    await active(fakes)
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const subscription = fakes.stripe.subscription("sub_upgrade")!
    const item = (subscription.items as { data: Record<string, unknown>[] }).data[0]!
    item.current_period_start = subscription.current_period_start
    item.current_period_end = subscription.current_period_end
    delete subscription.current_period_start
    delete subscription.current_period_end
    await modelPlanChange(user, "vector-10", fakes.fetcher, now)
    const snapshot = await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(snapshot.scheduled).toEqual({ plan: "vector-10", at: Number(item.current_period_end) * 1000 })
  })

  test("DELETE releases a scheduled downgrade without sales funding, and foreign schedules fail closed", async () => {
    const fakes = seed()
    await active(fakes)
    fakes.stripe.subscription("sub_active")!.schedule = "sub_sched1"
    fakes.stripe.load({
      subscription_schedules: [
        {
          id: "sub_sched1",
          customer: fixture.account.customer,
          subscription: "sub_active",
          status: "active",
          phases: [],
        },
      ],
    })
    expect(await modelPlanChange(user, undefined, fakes.fetcher, now)).toEqual({ scheduled: false })
    fakes.stripe.subscription("sub_active")!.schedule = "sub_foreign"
    fakes.stripe.load({
      subscription_schedules: [
        { id: "sub_foreign", customer: "cus_elsewhere", subscription: "sub_elsewhere", status: "active" },
      ],
    })
    await expect(releaseDowngrade(fakes.stripe.subscription("sub_active")!, fakes.fetcher)).rejects.toMatchObject({
      code: "MODEL_PLAN_CHANGE_UNAVAILABLE",
    })
  })

  test("an interrupted downgrade followed by portal cancellation can be scheduled again", async () => {
    const fakes = seed()
    await active(fakes)
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    fakes.stripe.fail = (call) =>
      call.method === "POST" && /^subscription_schedules\/[^/]+$/.test(call.path)
        ? new Response("unavailable", { status: 503 })
        : undefined
    await expect(modelPlanChange(user, "vector-10", fakes.fetcher, now)).rejects.toMatchObject({
      code: "BILLING_UPSTREAM",
    })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.downgrade).toBeDefined()
    fakes.stripe.fail = undefined
    await modelPlanPortal(id, fakes.fetcher, { flow: "cancel", now })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.downgrade).toBeUndefined()
    expect(await modelPlanChange(user, "vector-10", fakes.fetcher, now)).toMatchObject({
      scheduled: { plan: "vector-10" },
    })
    expect(fakes.stripe.objects.subscription_schedules.size).toBe(2)
  })

  test("consent comes from the completed checkout and confirmation is sent once, without trusting return URLs", async () => {
    const fakes = seed()
    await active(fakes)
    fakes.store.set(
      accountKey,
      JSON.stringify({
        ...(await readModelPlanAccount(id, fakes.fetcher)),
        checkout: {
          id: "cs_paid",
          plan: "vector-10",
          url: "https://checkout.stripe.com/c/fixture",
          expires: now + 3600_000,
        },
      }),
    )
    fakes.stripe.load({
      checkout_sessions: [
        {
          id: "cs_paid",
          customer: fixture.account.customer,
          status: "complete",
          payment_status: "paid",
          consent: { terms_of_service: "accepted" },
          metadata: { vector_terms_date: CODIUM_TERMS_DATE },
        },
      ],
    })
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect((await readModelPlanAccount(id, fakes.fetcher))!.consent).toMatchObject({
      session: "cs_paid",
      terms_of_service: "accepted",
      terms_date: CODIUM_TERMS_DATE,
    })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.consent!.confirmationSent).toBeUndefined()
    process.env.RESEND_API_KEY = "fixture-email-key"
    process.env.VECTOR_PURCHASE_EMAIL_FROM = "Vector <receipts@example.invalid>"
    fakes.stripe.objects.customers.get(String(fixture.account.customer))!.email = user.email
    await drainOutbox({ now, fetcher: fakes.fetcher })
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    await drainOutbox({ now, fetcher: fakes.fetcher })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.consent!.confirmationSent).toBe(true)
    expect(fakes.mail.sent).toHaveLength(1)
  })

  test("legacy portal plan-change flow always returns the account link and ignores the obsolete change configuration", async () => {
    const fakes = seed()
    process.env.STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID = "bpc_unsafe"
    await expect(modelPlanPortal(id, fakes.fetcher, { flow: "change" })).rejects.toMatchObject({
      statusCode: 409,
      message: "Change plans on vectordev.ai/account.",
    })
    await modelPlanPortal(id, fakes.fetcher)
    expect(fakes.stripe.calls.find((call) => call.path === "billing_portal/sessions")!.form!.get("configuration")).toBe(
      "bpc_fixture",
    )
    delete process.env.STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID
  })

  test("consent quotes the actual monthly price, dates it, and enables tax only behind its switch", () => {
    expect(checkoutConsentFields({ id: "vector-100", price: 100 })).toMatchObject({
      "metadata[vector_terms_date]": CODIUM_TERMS_DATE,
    })
    expect(
      checkoutConsentFields({ id: "vector-100", price: 100 })["custom_text[terms_of_service_acceptance][message]"],
    ).toContain("Renews monthly at $100")
    expect(
      checkoutConsentFields({ id: "vector-100", price: 100 })["custom_text[terms_of_service_acceptance][message]"],
    ).toContain("not part of this purchase")
    expect(checkoutConsentFields({ id: "vector-10", price: 10 })).not.toHaveProperty("automatic_tax[enabled]")
    process.env.CODIUM_STRIPE_AUTOMATIC_TAX = "true"
    expect(checkoutConsentFields({ id: "vector-10", price: 10 })["automatic_tax[enabled]"]).toBe("true")
    delete process.env.CODIUM_STRIPE_AUTOMATIC_TAX
  })
})
