import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"
import {
  CODIUM_FUNDING_MAX_AGE_MS,
  checkCodiumFunding,
  readCodiumFunding,
  readCodiumFundingHistory,
  requireCodiumSales,
  reserveCodiumSale,
} from "../api/_lib/codium-funding"
import { codiumKey, openRouterKeyName } from "../api/_lib/codium-keys"
import { rampVersionKey, writeRampOwed } from "../api/_lib/codium-ramp"
import { handleCodiumFunding } from "../api/model-plans/funding"
import { codiumFakes, codiumTestEnvironment, type CodiumFakes } from "../packages/web/test/fixture/codium-fakes"

const NOW = Date.UTC(2026, 9, 28, 12)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const ACCOUNT = "44444444-4444-4444-8444-444444444444"
let restore = () => {}

beforeEach(() => {
  restore = codiumTestEnvironment({
    CODIUM_FUNDING_MARGIN_PERCENT: "0",
    CODIUM_FUNDING_MARGIN_USD: "0",
    CODIUM_OPENROUTER_TOPUP_THRESHOLD_USD: undefined,
    CODIUM_SPEND_SPIKE_USD_PER_HOUR: undefined,
    RESEND_API_KEY: "fixture-mail-key",
    VECTOR_PURCHASE_EMAIL_FROM: "Vector <support@example.test>",
    CODIUM_OWNER_EMAIL: "owner@example.test",
    CRON_SECRET: "fixture-cron-key",
  })
})
afterEach(() => restore())

const check = (fakes: CodiumFakes) => checkCodiumFunding(fakes.fetcher, fakes.clock.now)

describe("funding snapshot time bounds", () => {
  test("a future-dated open reading is refreshed before it can reserve an unfunded sale", async () => {
    const fakes = codiumFakes({ now: NOW })
    await checkCodiumFunding(fakes.fetcher, NOW + HOUR)
    fakes.openRouter.credits.total_credits = 0
    const before = fakes.openRouter.calls.length
    await expect(
      requireCodiumSales(fakes.fetcher, NOW).then((reading) =>
        reserveCodiumSale(reading, { id: "clock-rollback", credits: 10, closes: NOW + HOUR }, fakes.fetcher, NOW),
      ),
    ).rejects.toMatchObject({ code: "CODIUM_SALES_PAUSED" })
    expect(fakes.openRouter.calls.length).toBeGreaterThan(before)
    expect(await readCodiumFunding(fakes.fetcher)).toMatchObject({ status: "paused", checkedAt: NOW, balance: 0 })
    expect(fakes.store.command(["HSCAN", codiumKey("funding", "reserved"), "0"])).toEqual(["0", []])
    expect(fakes.stripe.calls).toEqual([])
  })

  test("a future-dated reading returned by a busy checker still cannot admit a sale", async () => {
    const fakes = codiumFakes({ now: NOW })
    await checkCodiumFunding(fakes.fetcher, NOW + HOUR)
    fakes.store.set(codiumKey("funding", "lock"), "another-checker")
    const before = fakes.openRouter.calls.length
    await expect(requireCodiumSales(fakes.fetcher, NOW)).rejects.toMatchObject({ code: "CODIUM_SALES_PAUSED" })
    expect(fakes.openRouter.calls).toHaveLength(before)
    expect(fakes.store.command(["HSCAN", codiumKey("funding", "reserved"), "0"])).toEqual(["0", []])
  })

  for (const age of [0, CODIUM_FUNDING_MAX_AGE_MS - 1])
    test(`a current funded reading aged ${age}ms remains usable while another checker holds the lock`, async () => {
      const fakes = codiumFakes({ now: NOW })
      await checkCodiumFunding(fakes.fetcher, NOW - age)
      fakes.store.set(codiumKey("funding", "lock"), "another-checker")
      const before = fakes.openRouter.calls.length
      expect(await requireCodiumSales(fakes.fetcher, NOW)).toEqual({ balance: 100000, owed: 0 })
      expect(fakes.openRouter.calls).toHaveLength(before)
    })
})

describe("A11 private funding observations", () => {
  test("retains seven days of bounded history and measures actual usage rather than balance changes", async () => {
    const fakes = codiumFakes({ now: NOW })
    fakes.openRouter.credits = { total_credits: 1000, total_usage: 100 }
    expect(await check(fakes)).toMatchObject({ runwayDays: null, spendPerDay: null, spendPerHour: null })

    fakes.clock.advance(DAY)
    // A credit addition changes the balance, but cannot hide the $10 of model spend since yesterday.
    fakes.openRouter.credits = { total_credits: 2000, total_usage: 110 }
    expect(await check(fakes)).toMatchObject({ balance: 189000, spendPerDay: 1000, runwayDays: 189 })
    const points = await readCodiumFundingHistory(fakes.fetcher, fakes.clock.now)
    expect(points).toHaveLength(2)
    expect(points[0]).toMatchObject({ checkedAt: NOW, balance: 90000, usage: 10000, totalCredits: 100000 })
    expect(points[1]).toMatchObject({ usage: 11000, totalCredits: 200000 })

    fakes.clock.advance(7 * DAY + 1)
    expect(await check(fakes)).toMatchObject({ runwayDays: null, spendPerDay: null })
    expect(await readCodiumFundingHistory(fakes.fetcher, fakes.clock.now)).toHaveLength(1)
    expect(fakes.store.pttl(codiumKey("funding", "history"))).toBe(7 * DAY)
    expect(fakes.stripe.calls).toEqual([])
    expect(fakes.openRouter.calls.every((call) => call.method === "GET")).toBe(true)
  })

  test("coalesces same-bucket readings and does not invent runway from no spend or a short observation", async () => {
    const fakes = codiumFakes({ now: NOW })
    await check(fakes)
    fakes.clock.advance(MINUTE)
    fakes.openRouter.credits.total_usage = 1
    expect(await check(fakes)).toMatchObject({ runwayDays: null, spendPerDay: null })
    expect(await readCodiumFundingHistory(fakes.fetcher, fakes.clock.now)).toHaveLength(1)
    fakes.clock.advance(5 * MINUTE)
    expect(await check(fakes)).toMatchObject({ runwayDays: null, spendPerDay: 0, spendPerHour: 0 })
  })

  test("a downward adjustment to cumulative usage starts a new spend baseline", async () => {
    const fakes = codiumFakes({ now: NOW })
    fakes.openRouter.credits.total_usage = 100
    await check(fakes)
    fakes.clock.advance(10 * MINUTE)
    fakes.openRouter.credits.total_usage = 1
    expect(await check(fakes)).toMatchObject({ runwayDays: null, spendPerDay: null, spendPerHour: null })
    fakes.clock.advance(10 * MINUTE)
    fakes.openRouter.credits.total_usage = 2
    expect(await check(fakes)).toMatchObject({ spendPerDay: 14400, spendPerHour: 600 })
  })

  test("a same-bucket usage adjustment remains a reset after its higher sample is coalesced away", async () => {
    const fakes = codiumFakes({ now: NOW })
    await check(fakes)
    fakes.clock.advance(10 * MINUTE)
    fakes.openRouter.credits.total_usage = 100
    await check(fakes)
    fakes.clock.advance(MINUTE)
    fakes.openRouter.credits.total_usage = 50
    expect(await check(fakes)).toMatchObject({ usageResetAt: NOW + 11 * MINUTE, spendPerDay: null, runwayDays: null })
    fakes.clock.advance(9 * MINUTE)
    fakes.openRouter.credits.total_usage = 51
    expect(await check(fakes)).toMatchObject({ usageResetAt: NOW + 11 * MINUTE, spendPerDay: 16000, spendPerHour: 667 })
  })

  test("malformed history fails closed without replacing missing telemetry with zeroes", async () => {
    const fakes = codiumFakes({ now: NOW })
    await check(fakes)
    fakes.store.set(codiumKey("funding", "history"), JSON.stringify([{ checkedAt: NOW, usage: -1 }]))
    await expect(check(fakes)).rejects.toMatchObject({ code: "CODIUM_FUNDING_HISTORY_UNAVAILABLE" })
    expect(await readCodiumFunding(fakes.fetcher)).toMatchObject({
      status: "paused",
      reason: "unavailable",
      balance: null,
      spendPerDay: null,
      runwayDays: null,
    })
    await expect(requireCodiumSales(fakes.fetcher, fakes.clock.now)).rejects.toMatchObject({
      code: "CODIUM_SALES_PAUSED",
    })
  })
})

describe("A11 owner funding alerts", () => {
  test("warns at exactly 1.25 times required, deduplicates, and never pauses a funded sale", async () => {
    const fakes = codiumFakes({ now: NOW })
    // The largest fixture monthly allowance is $100; no margin or customer liability in this fixture.
    fakes.openRouter.credits.total_credits = 125
    expect(await check(fakes)).toMatchObject({ status: "open", required: 10000, lowWater: true, alerts: 1 })
    expect(fakes.mail.sent.map((mail) => mail.subject)).toEqual(["Vector Codium funding is low"])
    fakes.clock.advance(10 * MINUTE)
    expect(await check(fakes)).toMatchObject({ status: "open", lowWater: true, alerts: 0, notified: false })
    expect(await requireCodiumSales(fakes.fetcher, fakes.clock.now)).toMatchObject({ balance: 12500, owed: 0 })
    fakes.clock.advance(DAY)
    expect(await check(fakes)).toMatchObject({ alerts: 1 })
    expect(fakes.mail.sent).toHaveLength(2)
  })

  test("a balance above the low-water boundary stays quiet and a short balance keeps the original pause subject", async () => {
    const fakes = codiumFakes({ now: NOW })
    fakes.openRouter.credits.total_credits = 125.01
    expect(await check(fakes)).toMatchObject({ status: "open", lowWater: false, alerts: 0 })
    fakes.openRouter.credits.total_credits = 90
    expect(await check(fakes)).toMatchObject({ status: "paused", lowWater: false, alerts: 1 })
    expect(fakes.mail.sent[0]?.subject).toBe("Vector Codium sales paused: OpenRouter is short $10.00")
    expect(fakes.stripe.calls).toEqual([])
  })

  test("an absent threshold disables the watchdog rather than assuming a dollar setting", async () => {
    const fakes = codiumFakes({ now: NOW })
    expect((await check(fakes)).topupWatchdog).toBeUndefined()
    expect(await readCodiumFunding(fakes.fetcher)).not.toHaveProperty("topupWatchdog")
  })

  test("the auto top-up watchdog keeps its start inside a bucket and warns after 20 minutes", async () => {
    process.env.CODIUM_OPENROUTER_TOPUP_THRESHOLD_USD = "200"
    const fakes = codiumFakes({ now: NOW })
    fakes.openRouter.credits.total_credits = 150
    expect(await check(fakes)).toMatchObject({ topupWatchdog: { threshold: 20000, since: NOW, overdue: false } })
    fakes.clock.advance(4 * MINUTE)
    expect(await check(fakes)).toMatchObject({ topupWatchdog: { since: NOW, overdue: false } })
    fakes.clock.advance(15 * MINUTE)
    expect(await check(fakes)).toMatchObject({ topupWatchdog: { since: NOW, overdue: false }, alerts: 0 })
    fakes.clock.advance(MINUTE)
    expect(await check(fakes)).toMatchObject({ topupWatchdog: { since: NOW, overdue: true }, alerts: 1 })
    expect(fakes.mail.sent[0]?.subject).toBe("Vector Codium OpenRouter auto top-up has not arrived")
    fakes.clock.advance(10 * MINUTE)
    expect(await check(fakes)).toMatchObject({ alerts: 0 })
    expect(fakes.mail.sent).toHaveLength(1)
  })

  test("a credit addition resets the watchdog even if the new balance is still below its threshold", async () => {
    process.env.CODIUM_OPENROUTER_TOPUP_THRESHOLD_USD = "200"
    const fakes = codiumFakes({ now: NOW })
    fakes.openRouter.credits.total_credits = 150
    await check(fakes)
    fakes.clock.advance(10 * MINUTE)
    fakes.openRouter.credits.total_credits = 175
    expect(await check(fakes)).toMatchObject({ topupWatchdog: { since: NOW + 10 * MINUTE, overdue: false } })
    fakes.clock.advance(10 * MINUTE)
    expect(await check(fakes)).toMatchObject({ topupWatchdog: { since: NOW + 10 * MINUTE, overdue: false }, alerts: 0 })
    fakes.clock.advance(10 * MINUTE)
    expect(await check(fakes)).toMatchObject({ topupWatchdog: { overdue: true }, alerts: 1 })
    fakes.openRouter.credits.total_credits = 300
    const recovered = (await check(fakes)).topupWatchdog
    expect(recovered).toMatchObject({ threshold: 20000, observedCredits: 30000, overdue: false })
    expect(recovered?.since).toBeUndefined()
  })

  test("a temporary provider failure does not restart an already observed top-up wait", async () => {
    process.env.CODIUM_OPENROUTER_TOPUP_THRESHOLD_USD = "200"
    const fakes = codiumFakes({ now: NOW })
    fakes.openRouter.credits.total_credits = 150
    await check(fakes)
    fakes.clock.advance(10 * MINUTE)
    fakes.openRouter.fail = () => new Response("unavailable", { status: 503 })
    await expect(check(fakes)).rejects.toMatchObject({ code: "CODIUM_FUNDING_UNAVAILABLE" })
    fakes.openRouter.fail = undefined
    fakes.clock.advance(10 * MINUTE)
    expect(await check(fakes)).toMatchObject({ topupWatchdog: { since: NOW, overdue: true } })
    expect(fakes.mail.sent.map((mail) => mail.subject)).toContain(
      "Vector Codium OpenRouter auto top-up has not arrived",
    )
  })

  test("the configured hourly spike uses cumulative spend even while an auto top-up increases the balance", async () => {
    process.env.CODIUM_SPEND_SPIKE_USD_PER_HOUR = "60"
    const fakes = codiumFakes({ now: NOW })
    await check(fakes)
    fakes.clock.advance(10 * MINUTE)
    fakes.openRouter.credits = { total_credits: 2000, total_usage: 10 }
    expect(await check(fakes)).toMatchObject({ status: "open", spendPerHour: 6000, spike: true, alerts: 1 })
    expect(fakes.mail.sent[0]?.subject).toBe("Vector Codium OpenRouter spend spike")
    fakes.clock.advance(10 * MINUTE)
    fakes.openRouter.credits.total_usage = 20
    expect(await check(fakes)).toMatchObject({ spendPerHour: 6000, spike: true, alerts: 0 })
  })

  test.each(["NaN", "-1", "0", "0.001", "Infinity"])(
    "invalid configured alert threshold %s closes sales",
    async (raw) => {
      process.env.CODIUM_OPENROUTER_TOPUP_THRESHOLD_USD = raw
      const fakes = codiumFakes({ now: NOW })
      await expect(check(fakes)).rejects.toMatchObject({ code: "CODIUM_FUNDING_CONFIGURATION" })
      expect(await readCodiumFunding(fakes.fetcher)).toMatchObject({ status: "paused", reason: "unavailable" })
    },
  )

  test("failed paused and reopened emails retry while successful alerts stay deduplicated", async () => {
    const fakes = codiumFakes({ now: NOW })
    fakes.openRouter.credits.total_credits = 10
    fakes.mail.fail = true
    expect(await check(fakes)).toMatchObject({ status: "paused", notified: false })
    fakes.mail.fail = false
    expect(await check(fakes)).toMatchObject({ status: "paused", notified: true })
    expect(fakes.mail.sent).toHaveLength(1)
    fakes.clock.advance(10 * MINUTE)
    fakes.openRouter.credits.total_credits = 1000
    fakes.mail.fail = true
    expect(await check(fakes)).toMatchObject({ status: "open", notificationPending: true, notified: false })
    fakes.mail.fail = false
    fakes.clock.advance(10 * MINUTE)
    expect(await check(fakes)).toMatchObject({ status: "open", notificationPending: false, notified: true })
    expect(fakes.mail.sent.map((mail) => mail.subject)).toEqual([
      "Vector Codium sales paused: OpenRouter is short $90.00",
      "Vector Codium sales reopened",
    ])
  })
})

describe("A11 preserves the funded paid obligation", () => {
  test("history and warnings retain deferred A10 liability plus provider limits and sale reservations", async () => {
    const fakes = codiumFakes({ now: NOW })
    fakes.openRouter.seed("owed", {
      name: openRouterKeyName([ACCOUNT, "sub_funding", 1]),
      limit: 10,
      usage: 3,
      expires_at: null,
    })
    await writeRampOwed(ACCOUNT, 2_000_000, fakes.fetcher)
    expect(await check(fakes)).toMatchObject({ owed: 900, reserved: 0, required: 10900 })
    const reading = await requireCodiumSales(fakes.fetcher, fakes.clock.now)
    await reserveCodiumSale(reading, { id: "fixture-checkout", credits: 10, closes: NOW + HOUR }, fakes.fetcher, NOW)
    expect(await check(fakes)).toMatchObject({ owed: 900, reserved: 1000, required: 11900 })
    expect((await readCodiumFundingHistory(fakes.fetcher, NOW)).at(-1)).toMatchObject({ owed: 900, reserved: 1000 })
    expect(fakes.stripe.calls).toEqual([])
  })

  test("a liability-version change during key listing still fails closed before publishing a funded reading", async () => {
    const fakes = codiumFakes({ now: NOW })
    fakes.openRouter.fail = (call) => {
      if (call.path === "keys") fakes.store.set(rampVersionKey(), "1")
      return undefined
    }
    await expect(check(fakes)).rejects.toMatchObject({ code: "CODIUM_RAMP_UNAVAILABLE" })
    expect(await readCodiumFunding(fakes.fetcher)).toMatchObject({ status: "paused", owed: null, required: null })
    expect(await readCodiumFundingHistory(fakes.fetcher, NOW)).toEqual([])
  })
})

test("the authenticated funding cron exposes outcome counts and no private amounts or history", async () => {
  const fakes = codiumFakes({ now: NOW })
  const request = new IncomingMessage(new Socket())
  request.method = "GET"
  request.headers = { authorization: "Bearer fixture-cron-key" }
  const response = new ServerResponse(request)
  const output: string[] = []
  response.end = (body?: unknown) => {
    output.push(String(body))
    return response
  }
  await handleCodiumFunding(request, response, fakes.fetcher, NOW)
  expect(response.statusCode).toBe(200)
  expect(response.getHeader("cache-control")).toBe("no-store")
  expect(JSON.parse(output.join(""))).toEqual({ enabled: true, status: "open", ran: true, notified: false, alerts: 0 })
  for (const field of ["balance", "owed", "reserved", "required", "usage", "totalCredits", "runwayDays", "spendPerDay"])
    expect(output.join("")).not.toContain(field)
})
