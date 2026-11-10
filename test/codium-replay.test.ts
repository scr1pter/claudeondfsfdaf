import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test"
import { RedisClient } from "bun"
import { codiumKey } from "../api/_lib/codium-keys"
import { PRIORITY_LEAD_MS, readSnapshot } from "../api/_lib/codium-snapshot"
import type { ApiRequest, ApiResponse } from "../api/_lib/http"
import {
  keyExpiresAt,
  protectModelPlanKey,
  readModelPlanAccount,
  reconcileModelPlanAccount,
} from "../api/_lib/model-plan-account"
import { listStripeEvents, MODEL_PLAN_STRIPE_VERSION, MODEL_PLAN_WEBHOOK_EVENTS } from "../api/_lib/model-plan-stripe"
import replayCron, {
  REPLAY_LOOKBACK_S,
  REPLAY_OVERLAP_S,
  replayCursorKey,
  replayStripeEvents,
} from "../api/model-plans/replay"
import sweepCron, { dailySweepKey, runDailySweep, runRiskSweep, sweepIndexKey } from "../api/model-plans/sweep"
import { eventDoneKey, eventSubject, handleModelPlanEvent } from "../api/model-plans/webhook"
import {
  codiumFakes,
  codiumTestEnvironment,
  loadStripeFixture,
  type CodiumFakes,
  type StripeFixture,
} from "../packages/web/test/fixture/codium-fakes"

// WP A08: replay and sweeps (contract §4.5, §4.19, §5 A08). Replay lists the webhook's 20 event types from its cursor
// less 5 minutes, reads each object again at the pinned API version and skips events already done; the hourly sweep
// catches open disputes, renewals, past-due accounts and duplicate subscriptions; the daily sweep audits key limits,
// reconciles stale accounts and queues provisioners again. Stripe, OpenRouter, the store and the owner's email are the
// in-memory fakes of packages/web/test/fixture/codium-fakes.ts; nothing here reaches a real service. The store commands
// the sweeps and replay send (WITHSCORES ranges, MGET, the cursor's RAISE) also run against a real Valkey when
// VECTOR_TEST_REDIS_URL is set (the CI lane).

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const SEEDED = "fixture_key_seeded"
const ACCOUNT_PREFIX = "vector:codium:test:account:"
const OWNER_EMAIL = {
  RESEND_API_KEY: "re_codium_fixture",
  VECTOR_PURCHASE_EMAIL_FROM: "Vector <alerts@example.test>",
  CODIUM_OWNER_EMAIL: "owner@example.test",
}

let restore = () => {}
beforeEach(() => {
  restore = codiumTestEnvironment()
})
afterEach(() => {
  restore()
  setSystemTime()
})

/** Sets the environment again with `overrides` on top of the fixtures' (owner email, cron secret, …). */
function environment(overrides: Record<string, string | undefined>) {
  restore()
  restore = codiumTestEnvironment(overrides)
}

/** The fakes holding a fixture's Stripe objects, its account record, and the key Codium made for its period, if any. */
function seed(fixture: StripeFixture) {
  const fakes = codiumFakes({ now: fixture.now * 1000 })
  fakes.stripe.load(fixture.objects)
  const record: Record<string, unknown> = { ...fixture.account }
  if (fixture.key) {
    const { subscription, start, end } = fixture.key
    const owner = fixture.objects.subscriptions?.find((value) => value.id === subscription)
    const credits = Number((owner?.metadata as Record<string, string>).vector_model_credits_usd)
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
    }
  }
  fakes.store.set(codiumKey("account", fixture.accountId), JSON.stringify(record))
  return fakes
}

/** A Stripe event as the events list returns it, about `object`, created at `created` (seconds). */
function stripeEvent(id: string, type: string, object: Record<string, unknown>, created: number, apiVersion?: string) {
  return {
    id,
    object: "event",
    type,
    created,
    livemode: false,
    api_version: apiVersion ?? MODEL_PLAN_STRIPE_VERSION,
    data: { object },
  }
}

const objectOf = (fixture: StripeFixture, collection: keyof StripeFixture["objects"], id: string) => {
  const found = fixture.objects[collection]?.find((value) => value.id === id)
  if (!found) throw new Error(`${id} is not in the fixture`)
  return found
}

const outboxIds = (fakes: CodiumFakes) => fakes.store.command(["ZRANGE", codiumKey("outbox"), 0, -1]) as string[]
const cursorOf = (fakes: CodiumFakes) => Number(fakes.store.get(replayCursorKey()))
const writes = (fakes: CodiumFakes) => fakes.stripe.calls.filter((call) => call.method !== "GET")
const quiet = () => spyOn(console, "warn").mockImplementation(() => {})

// ── listStripeEvents ───────────────────────────────────────────────────────────────────────────────────────────

describe("listStripeEvents (paged)", () => {
  test("pages newest first through the 20 types and the window, at the pinned version, and says when it stopped short", async () => {
    const fakes = codiumFakes()
    fakes.stripe.load({
      events: [
        stripeEvent("evt_a", "invoice.paid", { id: "in_a" }, 1_000),
        stripeEvent("evt_b", "charge.refunded", { id: "ch_b" }, 1_010),
        stripeEvent("evt_c", "customer.subscription.updated", { id: "sub_c" }, 1_020),
        stripeEvent("evt_d", "charge.dispute.created", { id: "dp_d" }, 1_030),
        stripeEvent("evt_e", "invoice.created", { id: "in_e" }, 1_040),
        // Not one of the 20 types, and outside the window: never listed.
        stripeEvent("evt_other", "payment_intent.succeeded", { id: "pi_x" }, 1_025),
        stripeEvent("evt_early", "invoice.paid", { id: "in_early" }, 999),
        stripeEvent("evt_late", "invoice.paid", { id: "in_late" }, 1_041),
      ],
    })
    const listed = await listStripeEvents(
      { types: MODEL_PLAN_WEBHOOK_EVENTS, since: 1_000, until: 1_040, pageSize: 2 },
      fakes.fetcher,
    )
    expect(listed.complete).toBe(true)
    expect(listed.events.map((event) => event.id)).toEqual(["evt_e", "evt_d", "evt_c", "evt_b", "evt_a"])
    expect(fakes.stripe.calls.map((call) => call.query.get("starting_after"))).toEqual([null, "evt_d", "evt_b"])
    for (const call of fakes.stripe.calls) {
      expect(call).toMatchObject({ method: "GET", path: "events", stripeVersion: MODEL_PLAN_STRIPE_VERSION })
      expect(call.query.getAll("types[]")).toEqual([...MODEL_PLAN_WEBHOOK_EVENTS])
      expect(call.query.get("created[gte]")).toBe("1000")
      expect(call.query.get("created[lte]")).toBe("1040")
      expect(call.query.get("limit")).toBe("2")
    }

    const short = await listStripeEvents(
      { types: MODEL_PLAN_WEBHOOK_EVENTS, since: 1_000, until: 1_040, pageSize: 2, maxPages: 2 },
      fakes.fetcher,
    )
    expect(short).toMatchObject({ complete: false })
    expect(short.events.map((event) => event.id)).toEqual(["evt_e", "evt_d", "evt_c", "evt_b"])

    for (const options of [
      { types: [...MODEL_PLAN_WEBHOOK_EVENTS, "invoice.voided"], since: 1, until: 2 },
      { types: [], since: 1, until: 2 },
      { types: ["invoice.paid"], since: 3, until: 2 },
    ])
      await expect(listStripeEvents(options, fakes.fetcher)).rejects.toMatchObject({ code: "BILLING_EVENTS_INVALID" })
  })
})

// ── Replay ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("replay (contract §4.5, WP A08)", () => {
  test("a missed event is handled once; the overlap and a lost done marker apply nothing twice", async () => {
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    const id = fixture.accountId
    const run = fixture.now * 1000 + 9 * MINUTE
    // The previous run ten minutes ago left the cursor there; the notification for this payment never arrived.
    fakes.store.set(replayCursorKey(), String(Math.floor(run / 1000) - 600))
    const created = Math.floor(run / 1000) - 120
    fakes.stripe.load({
      events: [stripeEvent("evt_missed", "invoice.paid", objectOf(fixture, "invoices", "in_active"), created)],
    })

    expect(await replayStripeEvents({ fetcher: fakes.fetcher, now: run })).toEqual({
      listed: 1,
      skipped: 0,
      handled: 1,
      failed: 0,
      left: 0,
      complete: true,
    })
    const snapshot = await readSnapshot(id, fakes.fetcher)
    expect(snapshot).toMatchObject({ state: "active", plan: "vector-10", source: "replay" })
    expect([...fakes.openRouter.keys.values()]).toEqual([expect.objectContaining({ disabled: false, limit: 4 })])
    expect(fakes.store.get(eventDoneKey("evt_missed"))).toBeDefined()
    expect(cursorOf(fakes)).toBe(Math.floor(run / 1000))
    // The object was read again at the pinned version before routing.
    expect(fakes.stripe.calls).toContainEqual(
      expect.objectContaining({ path: "invoices/in_active", stripeVersion: MODEL_PLAN_STRIPE_VERSION }),
    )

    // Ten minutes later the event is still in the window's 5-minute overlap, and its marker skips it.
    const after = {
      stripe: fakes.stripe.calls.length,
      openRouter: fakes.openRouter.calls.length,
      outbox: outboxIds(fakes),
    }
    const next = run + 10 * MINUTE
    expect(await replayStripeEvents({ fetcher: fakes.fetcher, now: next })).toMatchObject({
      listed: 1,
      skipped: 1,
      handled: 0,
    })
    expect(fakes.stripe.calls.slice(after.stripe).map((call) => call.path)).toEqual(["events"])
    expect(fakes.openRouter.calls.length).toBe(after.openRouter)
    expect(cursorOf(fakes)).toBe(Math.floor(next / 1000))

    // Even with the marker lost, handling it again changes nothing: same snapshot version, one key, no new work.
    fakes.store.command(["DEL", eventDoneKey("evt_missed")])
    fakes.store.set(replayCursorKey(), String(created - 60))
    expect(await replayStripeEvents({ fetcher: fakes.fetcher, now: next })).toMatchObject({ handled: 1 })
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ version: snapshot!.version, state: "active" })
    expect(fakes.openRouter.keys.size).toBe(1)
    expect(outboxIds(fakes)).toEqual(after.outbox)
    expect(writes(fakes)).toEqual([])
  })

  test("events the webhook already handled are skipped without reading anything but the list", async () => {
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    const now = fixture.now * 1000
    const delivered = stripeEvent(
      "evt_delivered",
      "invoice.paid",
      objectOf(fixture, "invoices", "in_active"),
      fixture.now - 60,
    )
    expect(await handleModelPlanEvent(delivered, { fetcher: fakes.fetcher, now })).toEqual({
      outcome: "done",
      account: fixture.accountId,
    })
    fakes.stripe.load({ events: [delivered] })
    fakes.store.set(replayCursorKey(), String(fixture.now - 600))
    const before = fakes.stripe.calls.length
    const version = (await readSnapshot(fixture.accountId, fakes.fetcher))!.version
    expect(await replayStripeEvents({ fetcher: fakes.fetcher, now: now + MINUTE })).toMatchObject({
      listed: 1,
      skipped: 1,
      handled: 0,
    })
    expect(fakes.stripe.calls.slice(before).map((call) => call.path)).toEqual(["events"])
    expect((await readSnapshot(fixture.accountId, fakes.fetcher))!.version).toBe(version)
  })

  test("an event rendered at a newer API version is routed from its object read again at the pinned version", async () => {
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    // A later API version that names the payer as an account rather than a customer: the event's own copy of the
    // subscription carries no customer this code can route on.
    const newer = stripeEvent(
      "evt_newer",
      "customer.subscription.updated",
      {
        id: "sub_active",
        object: "subscription",
        customer: null,
        customer_account: "acct_1CodiumFixture",
        status: "active",
      },
      fixture.now - 60,
      "2025-09-30.clover",
    )
    expect(await eventSubject(newer, fakes.fetcher)).toBeUndefined()
    expect(fakes.stripe.calls).toEqual([])

    fakes.stripe.load({ events: [newer] })
    fakes.store.set(replayCursorKey(), String(fixture.now - 600))
    expect(await replayStripeEvents({ fetcher: fakes.fetcher, now: fixture.now * 1000 })).toMatchObject({ handled: 1 })
    expect(fakes.stripe.calls).toContainEqual(
      expect.objectContaining({
        method: "GET",
        path: "subscriptions/sub_active",
        stripeVersion: MODEL_PLAN_STRIPE_VERSION,
      }),
    )
    expect(await readSnapshot(fixture.accountId, fakes.fetcher)).toMatchObject({ state: "active", source: "replay" })
  })

  // Done: replay covers any single lost webhook within 10 minutes. One case per family of the 20 events.
  const LOST: { fixture: string; type: string; collection: keyof StripeFixture["objects"]; object: string }[] = [
    { fixture: "active-paid", type: "invoice.paid", collection: "invoices", object: "in_active" },
    { fixture: "paused-past-due", type: "invoice.payment_failed", collection: "invoices", object: "in_failed" },
    {
      fixture: "ended-canceled",
      type: "customer.subscription.deleted",
      collection: "subscriptions",
      object: "sub_canceled",
    },
    { fixture: "ended-refunded", type: "charge.refunded", collection: "charges", object: "ch_refunded" },
    {
      fixture: "frozen-dispute-previous-charge",
      type: "charge.dispute.created",
      collection: "disputes",
      object: "dp_previous",
    },
    {
      fixture: "frozen-early-fraud-warning",
      type: "radar.early_fraud_warning.created",
      collection: "early_fraud_warnings",
      object: "issfr_Fixture01",
    },
    { fixture: "renewing-draft-invoice", type: "invoice.created", collection: "invoices", object: "in_renewal" },
  ]
  for (const lost of LOST)
    test(`a lost ${lost.type} is handled by the next run within 10 minutes (${lost.fixture})`, async () => {
      const fixture = loadStripeFixture(lost.fixture)
      const fakes = seed(fixture)
      const now = fixture.now * 1000
      // The previous run was ten minutes ago; the event came 9 minutes ago and its notification was lost.
      fakes.store.set(replayCursorKey(), String(fixture.now - 600))
      fakes.stripe.load({
        events: [
          stripeEvent("evt_lost", lost.type, objectOf(fixture, lost.collection, lost.object), fixture.now - 540),
        ],
      })
      expect(await replayStripeEvents({ fetcher: fakes.fetcher, now })).toMatchObject({ handled: 1, failed: 0 })
      expect(fakes.store.get(eventDoneKey("evt_lost"))).toBeDefined()
      if (lost.type === "invoice.created") {
        expect(outboxIds(fakes)).toEqual([`finalize-renewal:${lost.object}`])
        return
      }
      const snapshot = await readSnapshot(fixture.accountId, fakes.fetcher)
      expect(snapshot).toMatchObject({ state: fixture.expect.state, source: "replay" })
      expect(snapshot?.reason).toBe(fixture.expect.reason as never)
    })

  test("a failing event queues a reconcile, holds the cursor, is retried, and the owner hears once it is an hour old", async () => {
    environment(OWNER_EMAIL)
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    const id = fixture.accountId
    const now = fixture.now * 1000 + 2 * HOUR
    const failing = stripeEvent(
      "evt_failing",
      "invoice.paid",
      objectOf(fixture, "invoices", "in_active"),
      fixture.now - 60,
    )
    // A later event about a customer that is not a Codium account's: handled (and left alone) whatever happens before it.
    const later = stripeEvent(
      "evt_later",
      "customer.subscription.updated",
      { id: "sub_other", object: "subscription", customer: "cus_other" },
      fixture.now + 30,
    )
    fakes.stripe.load({
      events: [failing, later],
      customers: [{ id: "cus_other", object: "customer", metadata: {} }],
      subscriptions: [{ id: "sub_other", object: "subscription", customer: "cus_other", status: "active" }],
    })
    fakes.store.set(replayCursorKey(), String(fixture.now - 120))
    fakes.openRouter.fail = () => Response.json({ error: "outage" }, { status: 503 })
    const warn = quiet()
    try {
      expect(await replayStripeEvents({ fetcher: fakes.fetcher, now })).toMatchObject({ handled: 1, failed: 1 })
      // A durable reconcile for the account, in the priority lane; the failing event is not marked done.
      expect(outboxIds(fakes)).toEqual([`reconcile:${id}`])
      expect(Number(fakes.store.command(["ZSCORE", codiumKey("outbox"), `reconcile:${id}`]))).toBeLessThan(
        now - PRIORITY_LEAD_MS + 1,
      )
      expect(fakes.store.get(eventDoneKey("evt_failing"))).toBeUndefined()
      expect(fakes.store.get(eventDoneKey("evt_later"))).toBeDefined()
      // The cursor moves only up to the first event not handled.
      expect(cursorOf(fakes)).toBe(failing.created)
      expect(fakes.mail.sent.map((mail) => mail.subject)).toEqual(["Vector Codium: a Stripe event keeps failing"])
      expect(fakes.mail.sent[0]!.text).toContain("evt_failing")
      expect(fakes.mail.sent[0]!.text).not.toContain("$")

      // Ten minutes later it fails again: no second email for the same event.
      expect(await replayStripeEvents({ fetcher: fakes.fetcher, now: now + 10 * MINUTE })).toMatchObject({
        skipped: 1,
        failed: 1,
      })
      expect(fakes.mail.sent).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }

    // OpenRouter is back: it is handled, and the cursor reaches the end of the window.
    fakes.openRouter.fail = undefined
    const back = now + 20 * MINUTE
    expect(await replayStripeEvents({ fetcher: fakes.fetcher, now: back })).toMatchObject({
      handled: 1,
      skipped: 1,
      failed: 0,
    })
    expect(fakes.store.get(eventDoneKey("evt_failing"))).toBeDefined()
    expect(cursorOf(fakes)).toBe(Math.floor(back / 1000))
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ state: "active" })
  })

  test("the time budget stops a run early and keeps the cursor at the first event left", async () => {
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    const now = fixture.now * 1000
    fakes.stripe.load({
      events: [
        stripeEvent("evt_one", "invoice.paid", objectOf(fixture, "invoices", "in_active"), fixture.now - 200),
        stripeEvent(
          "evt_two",
          "customer.subscription.updated",
          objectOf(fixture, "subscriptions", "sub_active"),
          fixture.now - 100,
        ),
      ],
    })
    fakes.store.set(replayCursorKey(), String(fixture.now - 400))
    expect(await replayStripeEvents({ fetcher: fakes.fetcher, now, budgetMs: 0 })).toMatchObject({
      listed: 2,
      handled: 0,
      left: 2,
    })
    expect(cursorOf(fakes)).toBe(fixture.now - 200)
    expect(await readSnapshot(fixture.accountId, fakes.fetcher)).toBeUndefined()
  })

  test("the window starts at the cursor less 5 minutes, never more than 3 days back, and the cursor never moves back", async () => {
    const fakes = codiumFakes()
    const now = 1_800_000_000_000
    const until = now / 1000
    const window = async () => {
      fakes.stripe.calls.length = 0
      await replayStripeEvents({ fetcher: fakes.fetcher, now })
      return Number(fakes.stripe.calls[0]!.query.get("created[gte]"))
    }
    // No cursor yet: three days back.
    expect(await window()).toBe(until - REPLAY_LOOKBACK_S)
    expect(cursorOf(fakes)).toBe(until)
    fakes.store.set(replayCursorKey(), String(until - 600))
    expect(await window()).toBe(until - 600 - REPLAY_OVERLAP_S)
    fakes.store.set(replayCursorKey(), String(until - 10 * 86_400))
    expect(await window()).toBe(until - REPLAY_LOOKBACK_S)
    // A cursor ahead of this run's clock stays where it is.
    fakes.store.set(replayCursorKey(), String(until + 3_600))
    await window()
    expect(cursorOf(fakes)).toBe(until + 3_600)
  })

  test("an owner's replay from an earlier time handles older events and leaves the cursor alone", async () => {
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    const now = fixture.now * 1000 + 5 * HOUR
    fakes.store.set(replayCursorKey(), String(fixture.now + 4 * 3_600))
    fakes.stripe.load({
      events: [stripeEvent("evt_old", "invoice.paid", objectOf(fixture, "invoices", "in_active"), fixture.now - 60)],
    })
    // The cron's window does not reach it.
    expect(await replayStripeEvents({ fetcher: fakes.fetcher, now })).toMatchObject({ listed: 0 })
    expect(await replayStripeEvents({ fetcher: fakes.fetcher, now, since: fixture.now - 3_600 })).toMatchObject({
      listed: 1,
      handled: 1,
    })
    expect(cursorOf(fakes)).toBe(Math.floor(now / 1000))
    // From 40 days back, it starts where Stripe's events start (30 days).
    fakes.stripe.calls.length = 0
    await replayStripeEvents({ fetcher: fakes.fetcher, now, since: fixture.now - 40 * 86_400 })
    expect(Number(fakes.stripe.calls[0]!.query.get("created[gte]"))).toBe(Math.floor(now / 1000) - 30 * 86_400)
    fakes.store.set(replayCursorKey(), String(fixture.now))
    await replayStripeEvents({ fetcher: fakes.fetcher, now, since: fixture.now - 3_600 })
    expect(cursorOf(fakes)).toBe(fixture.now)
    await expect(replayStripeEvents({ fetcher: fakes.fetcher, now, since: -1 })).rejects.toMatchObject({
      code: "REPLAY_SINCE_INVALID",
    })
  })

  test("a window holding more than one run reads keeps the cursor and tells the owner", async () => {
    environment(OWNER_EMAIL)
    const fakes = codiumFakes()
    const now = 1_800_000_000_000
    const until = now / 1000
    fakes.store.set(replayCursorKey(), String(until - 600))
    // Events about no Codium customer: each is handled (ignored) and marked done.
    fakes.stripe.load({
      events: [1, 2, 3].map((n) =>
        stripeEvent(
          `evt_flood_${n}`,
          "customer.subscription.updated",
          { id: `sub_flood_${n}`, customer: "cus_other" },
          until - 60 * n,
        ),
      ),
    })
    fakes.stripe.load({ customers: [{ id: "cus_other", object: "customer", metadata: {} }] })
    fakes.stripe.load({
      subscriptions: [1, 2, 3].map((n) => ({ id: `sub_flood_${n}`, object: "subscription", customer: "cus_other" })),
    })
    const warn = quiet()
    try {
      expect(await replayStripeEvents({ fetcher: fakes.fetcher, now, pageSize: 1, maxPages: 2 })).toMatchObject({
        listed: 2,
        handled: 2,
        complete: false,
      })
    } finally {
      warn.mockRestore()
    }
    expect(cursorOf(fakes)).toBe(until - 600)
    expect(fakes.mail.sent.map((mail) => mail.subject)).toEqual([
      "Vector Codium: replay could not read every Stripe event",
    ])
  })
})

// ── The sweeps ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Records an applied (or pending) pool debit against the account's key, as the pool's APPLY would leave it. */
function debit(fakes: CodiumFakes, account: string, keyHash: string, ref: string, micro: number, applied: boolean) {
  fakes.store.command([
    "HSET",
    codiumKey("debits", account, keyHash),
    ref,
    JSON.stringify({ micro, applied, hold: `${ref}:hosted:-:${micro}`, purpose: "hosted", at: 0 }),
  ])
}

async function setRecord(fakes: CodiumFakes, account: string, change: (record: Record<string, unknown>) => void) {
  const record = JSON.parse(fakes.store.get(codiumKey("account", account))!) as Record<string, unknown>
  change(record)
  fakes.store.set(codiumKey("account", account), JSON.stringify(record))
}

describe("the daily sweep (WP A08)", () => {
  test("a drifted key limit is set back to expectedLimit, with one owner alert and no amount", async () => {
    environment(OWNER_EMAIL)
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    const id = fixture.accountId
    const now = fixture.now * 1000
    await reconcileModelPlanAccount(id, fakes.fetcher, now, { source: "webhook" })
    const hash = [...fakes.openRouter.keys.keys()][0]!
    // 0.50 of hosted debits already applied: the key's limit is 4 − 0.5 = 3.5, as convergeKey last set it.
    debit(fakes, id, hash, "block-1", 500_000, true)
    await setRecord(fakes, id, (record) => {
      ;(record.key as Record<string, unknown>).limitMicro = 3_500_000
    })
    fakes.openRouter.keys.get(hash)!.limit = 9.99
    fakes.mail.sent.length = 0
    const warn = quiet()
    const sweep = () => runDailySweep({ fetcher: fakes.fetcher, now: now + HOUR })
    try {
      // The snapshot is an hour old: nothing to reconcile, but the key is audited.
      expect(await sweep()).toMatchObject({ repaired: 1, reconciled: 0, skipped: 1, failed: 0, finished: true })
    } finally {
      warn.mockRestore()
    }
    expect(fakes.openRouter.keys.get(hash)).toMatchObject({ limit: 3.5, disabled: false })
    expect(fakes.mail.sent.map((mail) => mail.subject)).toEqual([
      "Vector Codium: an OpenRouter key was changed outside Vector",
    ])
    expect(fakes.mail.sent[0]!.text).toContain(id)
    expect(fakes.mail.sent[0]!.text).toContain("above")
    expect(fakes.mail.sent[0]!.text).not.toMatch(/\$|9\.99|3\.5/)

    // Nothing drifted: no PATCH and no email. Within half a cent is not drift (3.504 for 3.5).
    const patches = () => fakes.openRouter.calls.filter((call) => call.method === "PATCH").length
    const before = patches()
    expect(await sweep()).toMatchObject({ repaired: 0 })
    fakes.openRouter.keys.get(hash)!.limit = 3.504
    expect(await sweep()).toMatchObject({ repaired: 0 })
    // A debit still being applied: the key at what Vector last set is not drift either.
    debit(fakes, id, hash, "block-2", 250_000, false)
    fakes.openRouter.keys.get(hash)!.limit = 3.5
    expect(await sweep()).toMatchObject({ repaired: 0 })
    expect(patches()).toBe(before)
    expect(fakes.mail.sent).toHaveLength(1)

    // A key without a limit is set to the pool's, every debit counted (and the pending one applied).
    fakes.openRouter.keys.get(hash)!.limit = null
    const quietAgain = quiet()
    try {
      expect(await sweep()).toMatchObject({ repaired: 1 })
    } finally {
      quietAgain.mockRestore()
    }
    expect(fakes.openRouter.keys.get(hash)!.limit).toBe(3.25)
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.limitMicro).toBe(3_250_000)
    // The same account's alert is sent once a day at most.
    expect(fakes.mail.sent).toHaveLength(1)
  })

  test("a key switched on while the account is held is switched off at once", async () => {
    const fixture = loadStripeFixture("frozen-dispute-open")
    const fakes = seed(fixture)
    const now = fixture.now * 1000
    await reconcileModelPlanAccount(fixture.accountId, fakes.fetcher, now, { hint: fixture.hint! })
    expect(fakes.openRouter.keys.get(SEEDED)).toMatchObject({ disabled: true })
    fakes.openRouter.keys.get(SEEDED)!.disabled = false
    const warn = quiet()
    try {
      expect(await runDailySweep({ fetcher: fakes.fetcher, now: now + MINUTE })).toMatchObject({ repaired: 1 })
    } finally {
      warn.mockRestore()
    }
    expect(fakes.openRouter.keys.get(SEEDED)).toMatchObject({ disabled: true })
  })

  test("stale snapshots and accounts past their period's end plus the grace are reconciled", async () => {
    // Renewing: three hours after the period ended, the grace has run out and the renewal is still unpaid.
    const renewing = loadStripeFixture("renewing-period-over")
    const fakes = seed(renewing)
    await reconcileModelPlanAccount(renewing.accountId, fakes.fetcher, renewing.now * 1000)
    expect(await readSnapshot(renewing.accountId, fakes.fetcher)).toMatchObject({ state: "renewing" })
    expect(await runDailySweep({ fetcher: fakes.fetcher, now: renewing.now * 1000 + 3 * HOUR })).toMatchObject({
      reconciled: 1,
      finished: true,
    })
    expect(await readSnapshot(renewing.accountId, fakes.fetcher)).toMatchObject({
      state: "paused",
      reason: "payment_pending",
      source: "sweep",
    })

    // Active: rechecked once the snapshot is over six hours old; nothing material changes, so its version holds.
    const active = loadStripeFixture("active-paid")
    const world = seed(active)
    const first = await reconcileModelPlanAccount(active.accountId, world.fetcher, active.now * 1000)
    expect(await runDailySweep({ fetcher: world.fetcher, now: active.now * 1000 + 5 * HOUR })).toMatchObject({
      reconciled: 0,
      skipped: 1,
    })
    const later = active.now * 1000 + 7 * HOUR
    expect(await runDailySweep({ fetcher: world.fetcher, now: later })).toMatchObject({ reconciled: 1 })
    expect(await readSnapshot(active.accountId, world.fetcher)).toMatchObject({
      version: first.version,
      checkedAt: later,
      source: "sweep",
    })
  })

  test("provisioners behind their snapshot are queued again, from the index and from dead letters", async () => {
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    const id = fixture.accountId
    const now = fixture.now * 1000
    const snapshot = await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const item = `github-runs:${id}:${snapshot.version}`
    expect(outboxIds(fakes)).toEqual([item])
    // The item is lost (a store restored from an older copy, say).
    fakes.store.command(["ZREM", codiumKey("outbox"), item])
    fakes.store.command(["DEL", codiumKey("outbox", "item", item)])
    expect(await runDailySweep({ fetcher: fakes.fetcher, now: now + MINUTE })).toMatchObject({ requeued: 1 })
    expect(outboxIds(fakes)).toEqual([item])
    // Already waiting: not queued twice.
    expect(await runDailySweep({ fetcher: fakes.fetcher, now: now + 2 * MINUTE })).toMatchObject({ requeued: 0 })

    // An ended account is no longer in the index; its dead letter names it.
    const ended = loadStripeFixture("ended-canceled")
    const world = seed(ended)
    const last = await reconcileModelPlanAccount(ended.accountId, world.fetcher, ended.now * 1000)
    expect(world.store.command(["ZRANGE", sweepIndexKey(), 0, -1])).toEqual([])
    const dead = `github-runs:${ended.accountId}:${last.version}`
    world.store.command(["ZREM", codiumKey("outbox"), dead])
    world.store.command(["ZADD", codiumKey("outbox", "dead"), ended.now * 1000, dead])
    expect(await runDailySweep({ fetcher: world.fetcher, now: ended.now * 1000 + MINUTE })).toMatchObject({
      requeued: 1,
    })
    expect(outboxIds(world)).toEqual([dead])
    expect(world.store.command(["ZRANGE", codiumKey("outbox", "dead"), 0, -1])).toEqual([])
  })

  test("the walk visits every indexed account exactly once, across pages and ties", async () => {
    const fakes = codiumFakes()
    const now = 1_800_000_000_000
    const score = now + 30 * 86_400_000
    const accounts: string[] = []
    // 150 accounts tied at one period end (more than a page of 100), then 80 more, each a little later. Their records
    // cannot be read, so every reconcile fails and every account stays in the index for the whole walk.
    for (let n = 0; n < 230; n++) {
      const account = `acct-${String(n).padStart(3, "0")}`
      accounts.push(account)
      fakes.store.command(["ZADD", sweepIndexKey(), n < 150 ? score : score + n, account])
      fakes.store.set(codiumKey("account", account), "not json")
    }
    const warn = quiet()
    let result: Awaited<ReturnType<typeof runDailySweep>>
    try {
      result = await runDailySweep({ fetcher: fakes.fetcher, now })
    } finally {
      warn.mockRestore()
    }
    // The audit and the reconcile each failed once per account.
    expect(result).toMatchObject({ reconciled: 0, failed: 460, finished: true })
    const reads = new Map<string, number>()
    for (const command of fakes.store.commands)
      if (command[0] === "GET" && command[1]!.startsWith(ACCOUNT_PREFIX))
        reads.set(command[1]!, (reads.get(command[1]!) ?? 0) + 1)
    expect([...reads.keys()].sort()).toEqual(accounts.map((account) => codiumKey("account", account)))
    expect(new Set(reads.values())).toEqual(new Set([2]))
    expect(fakes.store.get(dailySweepKey())).toBeUndefined()
  })

  test("a walk the budget cuts short is saved, and the hourly sweep finishes it", async () => {
    const fakes = codiumFakes()
    const now = 1_800_000_000_000
    const accounts = Array.from({ length: 10 }, (_, n) => `acct-${n}`)
    accounts.forEach((account, n) => {
      // Periods end in the future, so the hourly sweep's own walk (periods already over) does not visit them.
      fakes.store.command(["ZADD", sweepIndexKey(), now + 86_400_000 + n, account])
      fakes.store.set(codiumKey("account", account), "not json")
    })
    // Every read of an account record takes 300 ms of the budget.
    let clock = Date.now()
    setSystemTime(new Date(clock))
    const reads: string[] = []
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const command = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown[]) : []
      if (command[0] === "GET" && String(command[1]).startsWith(ACCOUNT_PREFIX)) {
        reads.push(String(command[1]))
        clock += 300
        setSystemTime(new Date(clock))
      }
      return fakes.fetcher(input, init)
    }) as typeof fetch
    const warn = quiet()
    try {
      const first = await runDailySweep({ fetcher: slow, now, budgetMs: 1_000 })
      expect(first.finished).toBe(false)
      // The first four accounts (one batch) were visited before the budget ran out.
      expect(new Set(reads).size).toBe(4)
      expect(JSON.parse(fakes.store.get(dailySweepKey())!)).toMatchObject({
        position: { member: "acct-3", score: now + 86_400_000 + 3 },
      })
      const risk = await runRiskSweep({ fetcher: slow, now })
      expect(risk.daily).toMatchObject({ finished: true, failed: 12 })
    } finally {
      warn.mockRestore()
    }
    expect(reads.length).toBe(20)
    expect(new Set(reads).size).toBe(10)
    expect(fakes.store.get(dailySweepKey())).toBeUndefined()
  })

  test("the walk is saved after every batch, so a run killed in the middle of one loses that batch only", async () => {
    const fakes = codiumFakes()
    const now = 1_800_000_000_000
    Array.from({ length: 10 }, (_, n) => `acct-${n}`).forEach((account, n) => {
      fakes.store.command(["ZADD", sweepIndexKey(), now + 86_400_000 + n, account])
      fakes.store.set(codiumKey("account", account), "not json")
    })
    // The sixth account's record never answers, so the run hangs in its batch until the platform would kill it.
    let stuck = false
    const hanging = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const command = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown[]) : []
      if (command[0] === "GET" && command[1] === codiumKey("account", "acct-5")) {
        stuck = true
        return new Promise<Response>(() => {})
      }
      return fakes.fetcher(input, init)
    }) as typeof fetch
    const warn = quiet()
    try {
      void runDailySweep({ fetcher: hanging, now })
      for (let tries = 0; tries < 500 && !stuck; tries++) await new Promise((resolve) => setTimeout(resolve, 1))
      expect(stuck).toBe(true)
      // The other visits of the hanging batch finish meanwhile; none of them moves the saved position.
      for (let tries = 0; tries < 20; tries++) await new Promise((resolve) => setTimeout(resolve, 1))
      expect(JSON.parse(fakes.store.get(dailySweepKey())!)).toEqual({
        startedAt: now,
        position: { member: "acct-3", score: now + 86_400_000 + 3 },
      })
    } finally {
      warn.mockRestore()
    }
  })
})

describe("the hourly risk sweep (WP A08)", () => {
  test("a dispute whose notification was lost freezes the account, and its close releases it", async () => {
    const fixture = loadStripeFixture("frozen-dispute-previous-charge")
    const fakes = seed(fixture)
    const id = fixture.accountId
    const now = fixture.now * 1000
    // Without the notification, reconcile cannot know about a dispute on last month's charge.
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ state: "active" })

    const first = await runRiskSweep({ fetcher: fakes.fetcher, now })
    expect(first.disputes).toEqual({ checked: 1, reconciled: 1, failed: 0, complete: true })
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({
      state: "frozen",
      reason: "disputed",
      source: "sweep",
    })
    expect(fakes.openRouter.keys.get(SEEDED)).toMatchObject({ disabled: true })
    // The disputes are listed from 120 days back, with their charges, at the pinned version.
    expect(fakes.stripe.calls).toContainEqual(
      expect.objectContaining({ method: "GET", path: "disputes", stripeVersion: MODEL_PLAN_STRIPE_VERSION }),
    )
    const listing = fakes.stripe.calls.find((call) => call.path === "disputes" && call.query.has("created[gte]"))!
    expect(listing.query.get("created[gte]")).toBe(String(fixture.now - 120 * 86_400))
    expect(listing.query.getAll("expand[]")).toEqual(["data.charge"])

    // The record agrees with Stripe now: nothing to do.
    expect((await runRiskSweep({ fetcher: fakes.fetcher, now: now + HOUR })).disputes).toMatchObject({ reconciled: 0 })

    // The bank closes the inquiry; its notification is lost too. The next sweep releases the account.
    fakes.stripe.objects.disputes.get("dp_previous")!.status = "warning_closed"
    expect((await runRiskSweep({ fetcher: fakes.fetcher, now: now + 2 * HOUR })).disputes).toMatchObject({
      reconciled: 1,
    })
    expect(await readSnapshot(id, fakes.fetcher)).toMatchObject({ state: "active" })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.risk?.openDisputes).toEqual({})
  })

  test("renewing and past-due accounts are reconciled hourly, unless reconciled in the last 15 minutes", async () => {
    const fixture = loadStripeFixture("renewing-period-over")
    const fakes = seed(fixture)
    const now = fixture.now * 1000
    await reconcileModelPlanAccount(fixture.accountId, fakes.fetcher, now)
    expect(await runRiskSweep({ fetcher: fakes.fetcher, now: now + 5 * MINUTE })).toMatchObject({
      reconciled: 0,
      skipped: 1,
    })
    expect(await runRiskSweep({ fetcher: fakes.fetcher, now: now + 3 * HOUR })).toMatchObject({
      reconciled: 1,
      skipped: 0,
      failed: 0,
    })
    expect(await readSnapshot(fixture.accountId, fakes.fetcher)).toMatchObject({
      state: "paused",
      reason: "payment_pending",
      source: "sweep",
    })

    // An account whose period is still running is not the hourly sweep's.
    const active = loadStripeFixture("active-paid")
    const world = seed(active)
    await reconcileModelPlanAccount(active.accountId, world.fetcher, active.now * 1000)
    expect(await runRiskSweep({ fetcher: world.fetcher, now: active.now * 1000 + 3 * HOUR })).toMatchObject({
      reconciled: 0,
      skipped: 0,
    })
  })

  test("more than one live subscription for one customer is reported to the owner by ids, once a week", async () => {
    environment(OWNER_EMAIL)
    const fixture = loadStripeFixture("governing-highest-rank")
    const fakes = seed(fixture)
    const now = fixture.now * 1000
    const warn = quiet()
    try {
      expect((await runRiskSweep({ fetcher: fakes.fetcher, now })).duplicates).toEqual({
        found: 1,
        failed: 0,
        complete: true,
      })
      expect((await runRiskSweep({ fetcher: fakes.fetcher, now: now + HOUR })).duplicates).toMatchObject({ found: 1 })
    } finally {
      warn.mockRestore()
    }
    expect(fakes.mail.sent).toHaveLength(1)
    const mail = fakes.mail.sent[0]!
    expect(mail.subject).toBe("Vector Codium: an account has more than one live subscription")
    expect(mail.text).toContain(fixture.accountId)
    expect(mail.text).toContain("Governing subscription: sub_twoMax")
    expect(mail.text).toContain("Other live subscriptions: sub_twoPlus")
    expect(mail.text).not.toMatch(/\$|@/)
    // Nothing is cancelled or changed in Stripe.
    expect(writes(fakes)).toEqual([])
  })
})

// ── The crons ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("the replay and sweep crons", () => {
  async function call(
    route: typeof replayCron,
    fetcher: typeof fetch,
    options: { method?: string; authorization?: string; url?: string } = {},
  ) {
    const request = {
      method: options.method ?? "GET",
      url: options.url ?? "/",
      headers: options.authorization ? { authorization: options.authorization } : {},
    } as unknown as ApiRequest
    let body = ""
    const response = {
      statusCode: 200,
      setHeader: () => {},
      end: (value?: string) => {
        body = String(value ?? "")
      },
    } as unknown as ApiResponse
    await route(request, response, fetcher)
    return { status: response.statusCode, body: JSON.parse(body) as Record<string, unknown> }
  }

  test("run every 10 minutes, hourly and daily, on CRON_SECRET only, and answer counts only", async () => {
    const config = await Bun.file(new URL("../vercel.json", import.meta.url)).json()
    expect(config.crons).toContainEqual({ path: "/api/model-plans/replay", schedule: "*/10 * * * *" })
    expect(config.crons).toContainEqual({ path: "/api/model-plans/sweep?scope=risk", schedule: "47 * * * *" })
    expect(config.crons).toContainEqual({ path: "/api/model-plans/sweep", schedule: "23 4 * * *" })

    environment({ CRON_SECRET: "cron-fixture-secret" })
    const fakes = codiumFakes()
    const secret = "Bearer cron-fixture-secret"
    for (const route of [replayCron, sweepCron]) {
      expect((await call(route, fakes.fetcher)).status).toBe(401)
      expect((await call(route, fakes.fetcher, { authorization: "Bearer wrong-secret-value" })).status).toBe(401)
      expect((await call(route, fakes.fetcher, { method: "POST", authorization: secret })).status).toBe(405)
    }
    expect(
      (await call(sweepCron, fakes.fetcher, { authorization: secret, url: "/api/model-plans/sweep?scope=all" })).status,
    ).toBe(400)
    expect(fakes.store.commands).toEqual([])
    expect(fakes.stripe.calls).toEqual([])

    expect(await call(replayCron, fakes.fetcher, { authorization: secret })).toEqual({
      status: 200,
      body: { enabled: true, listed: 0, skipped: 0, handled: 0, failed: 0, left: 0, complete: true },
    })
    const risk = await call(sweepCron, fakes.fetcher, {
      authorization: secret,
      url: "/api/model-plans/sweep?scope=risk",
    })
    expect(risk).toEqual({
      status: 200,
      body: {
        enabled: true,
        scope: "risk",
        reconciled: 0,
        skipped: 0,
        failed: 0,
        disputes: { checked: 0, reconciled: 0, failed: 0, complete: true },
        duplicates: { found: 0, failed: 0, complete: true },
      },
    })
    const daily = await call(sweepCron, fakes.fetcher, { authorization: secret, url: "/api/model-plans/sweep" })
    expect(daily).toEqual({
      status: 200,
      body: {
        enabled: true,
        scope: "daily",
        reconciled: 0,
        skipped: 0,
        failed: 0,
        repaired: 0,
        requeued: 0,
        finished: true,
      },
    })

    // Without a Stripe key nothing is read or written.
    environment({ CRON_SECRET: "cron-fixture-secret", STRIPE_SECRET_KEY: undefined })
    const idle = codiumFakes()
    expect(await call(replayCron, idle.fetcher, { authorization: secret })).toEqual({
      status: 200,
      body: { enabled: false },
    })
    expect(
      await call(sweepCron, idle.fetcher, { authorization: secret, url: "/api/model-plans/sweep?scope=risk" }),
    ).toEqual({ status: 200, body: { enabled: false } })
    expect(idle.store.commands).toEqual([])
    expect(idle.stripe.calls).toEqual([])
  })
})

// ── On Valkey (CI) ─────────────────────────────────────────────────────────────────────────────────────────────

const valkeyURL = process.env.VECTOR_TEST_REDIS_URL

describe.skipIf(!valkeyURL)("the sweep's walk and replay's cursor on Valkey", () => {
  const client = valkeyURL ? new RedisClient(valkeyURL) : undefined
  const sent: string[][] = []
  /** Stripe and OpenRouter stay the fakes; every store command goes to Valkey. */
  const through = (fakes: CodiumFakes) =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (
        new URL(String(input instanceof Request ? input.url : input)).hostname !==
        new URL(process.env.KV_REST_API_URL!).hostname
      )
        return fakes.fetcher(input, init)
      const command = (JSON.parse(String(init?.body)) as (string | number)[]).map(String)
      sent.push(command)
      return Response.json({ result: (await client!.send(command[0]!, command.slice(1))) ?? null })
    }) as typeof fetch
  beforeEach(async () => {
    await client!.send("FLUSHDB", [])
    sent.length = 0
  })

  test("the daily walk visits every account once across pages and ties", async () => {
    const fakes = codiumFakes()
    const fetcher = through(fakes)
    const now = 1_800_000_000_000
    const score = now + 30 * 86_400_000
    for (let n = 0; n < 230; n++) {
      const account = `acct-${String(n).padStart(3, "0")}`
      await client!.send("ZADD", [sweepIndexKey(), String(n < 150 ? score : score + n), account])
      await client!.send("SET", [codiumKey("account", account), "not json"])
    }
    const warn = quiet()
    try {
      expect(await runDailySweep({ fetcher, now })).toMatchObject({ failed: 460, finished: true })
    } finally {
      warn.mockRestore()
    }
    const reads = new Map<string, number>()
    for (const command of sent)
      if (command[0] === "GET" && command[1]!.startsWith(ACCOUNT_PREFIX))
        reads.set(command[1]!, (reads.get(command[1]!) ?? 0) + 1)
    expect(reads.size).toBe(230)
    expect(new Set(reads.values())).toEqual(new Set([2]))
  })

  test("replay skips done events through MGET and only ever raises its cursor", async () => {
    // The key reconcile makes here gets a ledger whose expiry Valkey's own clock reads: 40 days after the fixture's
    // period, 2026-12-10. From then Valkey drops that ledger at once. Nothing here reads it afterwards, reconcile
    // included; an assertion that does needs a period relative to Date.now().
    const fixture = loadStripeFixture("active-paid")
    const fakes = seed(fixture)
    const fetcher = through(fakes)
    await client!.send("SET", [
      codiumKey("account", fixture.accountId),
      fakes.store.get(codiumKey("account", fixture.accountId))!,
    ])
    const now = fixture.now * 1000
    fakes.stripe.load({
      events: [stripeEvent("evt_valkey", "invoice.paid", objectOf(fixture, "invoices", "in_active"), fixture.now - 60)],
    })
    await client!.send("SET", [replayCursorKey(), String(fixture.now - 600)])
    expect(await replayStripeEvents({ fetcher, now })).toMatchObject({ handled: 1 })
    expect(await readSnapshot(fixture.accountId, fetcher)).toMatchObject({ state: "active", source: "replay" })
    expect(await replayStripeEvents({ fetcher, now: now + 10 * MINUTE })).toMatchObject({ skipped: 1, handled: 0 })
    expect(Number(await client!.send("GET", [replayCursorKey()]))).toBe(fixture.now + 600)
    await client!.send("SET", [replayCursorKey(), String(fixture.now + 7_200)])
    await replayStripeEvents({ fetcher, now: now + 20 * MINUTE })
    expect(Number(await client!.send("GET", [replayCursorKey()]))).toBe(fixture.now + 7_200)
  })
})
