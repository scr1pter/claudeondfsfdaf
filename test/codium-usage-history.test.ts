import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { codiumKey } from "../api/_lib/codium-keys"
import { debitsKey, holdMember } from "../api/_lib/codium-pool"
import {
  FORECAST_MIN_POINTS,
  FORECAST_WINDOW_DAYS,
  HISTORY_MAX_DAYS,
  forecastDate,
  historyDays,
  readUsageHistory,
  usageHistory,
  type UsageDay,
} from "../api/_lib/codium-usage-history"
import { modelPlanBalance } from "../api/_lib/model-plan-status"
import type { ModelPlanStatusRead } from "../api/_lib/model-plan-account"
import { buildSnapshot } from "../api/_lib/codium-snapshot"
import { spendScripts, type SpendValue } from "../packages/web/test/fixture/codium-spend-emulation"

// WP A32: usage history from the pool's day buckets and the forecast. The store is a real Valkey when
// VECTOR_TEST_REDIS_URL is set (the CI lane), so HISTORY's Lua runs for real there; otherwise it is the in-memory
// emulation of the same script (codium-spend-emulation.ts), and these cases are the check that the two agree. Whether
// run tokens settle into the same buckets is checked on real Lua in packages/web/test/model-plans-api.test.ts.

const DAY = 86_400_000
const KV = "https://kv.usage-history.invalid"
const ACCOUNT = "33333333-3333-4333-8333-333333333333"
const POOL = "hash_history1"
const start = Date.UTC(2026, 9, 1, 15, 0) // the period starts part-way through Oct 1 (UTC)
const end = Date.UTC(2026, 9, 31, 15, 0)

// ── The store ──────────────────────────────────────────────────────────────────────────────────────────────────────

const database = process.env.VECTOR_TEST_REDIS_URL ? new RedisClient(process.env.VECTOR_TEST_REDIS_URL) : undefined
const memory = new Map<string, SpendValue>()
const scripts = new Map(
  spendScripts({
    read: (key) => memory.get(key),
    setString: (key, value) => void memory.set(key, { kind: "string", value }),
    hash: (key) => {
      const value = memory.get(key)
      if (value?.kind === "hash") return value.value
      const created = new Map<string, string>()
      memory.set(key, { kind: "hash", value: created })
      return created
    },
    zset: (key) => {
      const value = memory.get(key)
      if (value?.kind === "zset") return value.value
      const created = new Map<string, number>()
      memory.set(key, { kind: "zset", value: created })
      return created
    },
    prune: (key) => {
      const value = memory.get(key)
      if (value && value.kind !== "string" && value.value.size === 0) memory.delete(key)
    },
    pttl: (key) => (memory.has(key) ? -1 : -2),
    expireAt: () => {},
  }),
)

async function redis(command: readonly (string | number)[]): Promise<unknown> {
  if (database) return database.send(String(command[0]), command.slice(1).map(String))
  const [name, ...args] = command.map(String)
  if (name === "FLUSHDB") return void memory.clear()
  if (name === "SET") return void memory.set(args[0]!, { kind: "string", value: args[1]! })
  if (name === "HSET") {
    const value = memory.get(args[0]!)
    const fields = value?.kind === "hash" ? value.value : new Map<string, string>()
    for (let index = 1; index < args.length; index += 2) fields.set(args[index]!, args[index + 1]!)
    memory.set(args[0]!, { kind: "hash", value: fields })
    return 1
  }
  if (name === "EVAL") {
    const [script, count, ...rest] = args
    const run = scripts.get(script!)
    if (!run) throw new Error(`Unexpected script ${script!.slice(0, 60)}`)
    return run(rest.slice(0, Number(count)), rest.slice(Number(count)))
  }
  throw new Error(`Unexpected store command ${name}`)
}

const state = { fail: false }
const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  if (url.origin !== KV) throw new Error(`Unexpected request to ${url}`)
  if (state.fail) return new Response(null, { status: 503 })
  return Response.json({ result: await redis(JSON.parse(String(init?.body)) as (string | number)[]) })
}) as typeof fetch

const original = { url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN }
beforeEach(async () => {
  process.env.KV_REST_API_URL = KV
  process.env.KV_REST_API_TOKEN = "fixture-token"
  state.fail = false
  await redis(["FLUSHDB"])
})
afterEach(() => {
  for (const [name, value] of [
    ["KV_REST_API_URL", original.url],
    ["KV_REST_API_TOKEN", original.token],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})
afterAll(() => database?.close())

// A settled day as SETTLE leaves it (total and brain, settled micro), and a pool debit as recordDebit writes it.
const settledDay = (day: string, total: number, brain = 0) =>
  redis(["HSET", codiumKey("day", POOL, day), "total", String(total), "brain", String(brain)])
const debit = (ref: string, micro: number, at: number, applied: boolean) =>
  redis([
    "HSET",
    debitsKey(ACCOUNT, POOL),
    ref,
    JSON.stringify({
      micro,
      applied,
      hold: holdMember(`debit-${ref}`, "hosted", undefined, micro),
      purpose: "hosted",
      at,
    }),
  ])
const read = (now: number) => readUsageHistory({ account: ACCOUNT, pool: POOL, periodStart: start, now }, fetcher)

// ── History ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the period's UTC dates", () => {
  test("run from the period's first date through today, whatever the hour", () => {
    expect(historyDays(start, start)).toEqual(["2026-10-01"])
    expect(historyDays(start, Date.UTC(2026, 9, 3, 0, 0))).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"])
    // The last moment of a 30-day period starting at 15:00 is on its 31st date.
    expect(historyDays(start, end - 1)).toHaveLength(31)
    expect(historyDays(start, end - 1).at(-1)).toBe("2026-10-31")
  })

  test("never before the period, and never more than a period and its grace can span", () => {
    expect(historyDays(start, start - 1)).toEqual([])
    const long = historyDays(start, start + 60 * DAY)
    expect(long).toHaveLength(HISTORY_MAX_DAYS)
    expect(long.at(-1)).toBe(new Date(start + 60 * DAY).toISOString().slice(0, 10))
  })
})

describe("history from the day buckets", () => {
  test("every date's settled total plus the debits recorded on it, in one store call", async () => {
    await settledDay("2026-10-01", 120_000)
    await settledDay("2026-10-03", 2_500_000, 400_000)
    // Debits count on the UTC date they were recorded, applied or still pending; one before the period's first date
    // (a pool cannot have one, but it must not land on Oct 1) is left out.
    await debit("hosted-1", 300_000, Date.UTC(2026, 9, 3, 23, 59), true)
    await debit("hosted-2", 50_000, Date.UTC(2026, 9, 4, 0, 0), false)
    await debit("hosted-0", 999_000, Date.UTC(2026, 8, 30, 12, 0), true)
    const calls: unknown[] = []
    const counting = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.body)
      return fetcher(input, init)
    }) as typeof fetch
    const now = Date.UTC(2026, 9, 4, 9, 0)
    expect(await readUsageHistory({ account: ACCOUNT, pool: POOL, periodStart: start, now }, counting)).toEqual([
      { day: "2026-10-01", micro: 120_000 },
      { day: "2026-10-02", micro: 0 },
      { day: "2026-10-03", micro: 2_800_000 },
      { day: "2026-10-04", micro: 50_000 },
    ])
    expect(calls).toHaveLength(1)
  })

  test("another pool's buckets and debits are not this period's", async () => {
    await redis(["HSET", codiumKey("day", "hash_other", "2026-10-02"), "total", "900000"])
    await redis([
      "HSET",
      debitsKey(ACCOUNT, "hash_other"),
      "x",
      JSON.stringify({
        micro: 5,
        applied: true,
        hold: holdMember("t", "hosted", undefined, 5),
        purpose: "hosted",
        at: start,
      }),
    ])
    expect((await read(Date.UTC(2026, 9, 2, 9))).map((day) => day.micro)).toEqual([0, 0])
  })

  test("anything its writers never leave, or an unreachable store, gives no history rather than a wrong one", async () => {
    await redis(["SET", codiumKey("day", POOL, "2026-10-02"), "not a hash"])
    expect(await read(Date.UTC(2026, 9, 3))).toBeUndefined()
    await redis(["FLUSHDB"])
    await settledDay("2026-10-02", 1)
    await redis(["HSET", codiumKey("day", POOL, "2026-10-02"), "total", "1.5"])
    expect(await read(Date.UTC(2026, 9, 3))).toBeUndefined()
    await redis(["FLUSHDB"])
    await redis(["HSET", debitsKey(ACCOUNT, POOL), "bad", JSON.stringify({ micro: -1, at: start })])
    expect(await read(Date.UTC(2026, 9, 3))).toBeUndefined()
    await redis(["FLUSHDB"])
    state.fail = true
    expect(await read(Date.UTC(2026, 9, 3))).toBeUndefined()
  })

  test("status sends each date as a whole-percent share of the month; a share that rounds to 0 stays listed", () => {
    const days: UsageDay[] = [
      { day: "2026-10-01", micro: 0 },
      { day: "2026-10-02", micro: 4_000 }, // 0.1% of 4 USD: "<1%"
      { day: "2026-10-03", micro: 1_000_000 },
      { day: "2026-10-04", micro: 9_000_000 }, // more than the month (a carry ended, say): capped at 1
    ]
    expect(usageHistory(days, 4_000_000)).toEqual([
      { day: "2026-10-01", used: 0 },
      { day: "2026-10-02", used: 0 },
      { day: "2026-10-03", used: 0.25 },
      { day: "2026-10-04", used: 1 },
    ])
    expect(usageHistory(days, 0)).toEqual([])
  })
})

// ── The forecast ───────────────────────────────────────────────────────────────────────────────────────────────────

describe("the forecast", () => {
  const month = { periodStart: start, periodEnd: end }
  const iso = (time: number) => new Date(time).toISOString().slice(0, 10)
  // `total` micro-dollars a month; each listed date spent `micro`.
  const total = 10_000_000
  const spent = (entries: [string, number][]) => entries.map(([day, micro]) => ({ day, micro }))

  test("with 3 or more days of use in the last 7, the straight line over those days sets the pace", () => {
    // 14.5 days in, half the month used, but the last week ran hot: 3 days of 10% each since Oct 9 00:00.
    const now = Date.UTC(2026, 9, 15, 3, 0)
    const days = spent([
      ["2026-10-02", 2_000_000],
      ["2026-10-10", 1_000_000],
      ["2026-10-12", 1_000_000],
      ["2026-10-14", 1_000_000],
    ])
    const from = Date.UTC(2026, 9, 9)
    const pace = 0.3 / (now - from)
    expect(FORECAST_WINDOW_DAYS).toBe(7)
    expect(forecastDate({ used: 0.5, ...month, now, days, totalMicro: total })).toBe(iso(now + 0.5 / pace))
    // The period's average pace would say later.
    const average = forecastDate({ used: 0.5, ...month, now })!
    expect(average > forecastDate({ used: 0.5, ...month, now, days, totalMicro: total })!).toBe(true)
    expect(average).toBe(iso(start + (now - start) / 0.5))
  })

  test("with fewer than 3 days of use in the window, the period average is used", () => {
    const now = Date.UTC(2026, 9, 15, 3, 0)
    const days = spent([
      ["2026-10-02", 3_000_000],
      ["2026-10-12", 1_000_000],
      ["2026-10-14", 1_000_000],
      // Older than the window (Oct 9–15): not a point.
      ["2026-10-08", 1_000_000],
    ])
    expect(FORECAST_MIN_POINTS).toBe(3)
    expect(forecastDate({ used: 0.6, ...month, now, days, totalMicro: total })).toBe(
      forecastDate({ used: 0.6, ...month, now }),
    )
  })

  test("the window never reaches before the period started", () => {
    // Day 4 of the period: the window is the period so far (from Oct 1 15:00), not the 7 dates before today.
    const now = Date.UTC(2026, 9, 5, 15, 0)
    const days = spent([
      ["2026-10-01", 500_000],
      ["2026-10-02", 1_000_000],
      ["2026-10-04", 500_000],
    ])
    // 30% used by the month's figure (the provider's usage can run ahead of what has settled), 20% of it settled in
    // the window: the line runs from the period's start, neither the average nor a window from Sep 29.
    const pace = 0.2 / (now - start)
    const line = forecastDate({ used: 0.3, ...month, now, days, totalMicro: total })
    expect(line).toBe(iso(now + 0.7 / pace))
    expect(line).not.toBe(forecastDate({ used: 0.3, ...month, now }))
    expect(line).not.toBe(iso(now + 0.7 / (0.2 / (now - Date.UTC(2026, 8, 29)))))
  })

  test("hidden in the first 3 days, under 5% used, once used up, and when the month lasts to its end", () => {
    const busy = spent([
      ["2026-10-01", 2_000_000],
      ["2026-10-02", 2_000_000],
      ["2026-10-03", 2_000_000],
      ["2026-10-04", 2_000_000],
    ])
    expect(forecastDate({ used: 0.8, ...month, now: start + 3 * DAY - 1, days: busy, totalMicro: total })).toBe(
      undefined,
    )
    expect(forecastDate({ used: 0.8, ...month, now: start + 3 * DAY, days: busy, totalMicro: total })).toBeDefined()
    const light = spent([
      ["2026-10-08", 100_000],
      ["2026-10-09", 100_000],
      ["2026-10-10", 100_000],
    ])
    const now = Date.UTC(2026, 9, 10, 12)
    expect(forecastDate({ used: 0.049, ...month, now, days: light, totalMicro: total })).toBeUndefined()
    expect(forecastDate({ used: 1, ...month, now, days: busy, totalMicro: total })).toBeUndefined()
    // 3% over the last few days with 95% left runs well past the period's end.
    expect(forecastDate({ used: 0.05, ...month, now, days: light, totalMicro: total })).toBeUndefined()
    // The average path at exactly the period's end stays hidden: half used at half time.
    expect(forecastDate({ used: 0.5, ...month, now: start + 15 * DAY })).toBeUndefined()
  })
})

// ── In the status body ─────────────────────────────────────────────────────────────────────────────────────────────

describe("status", () => {
  test("carries the history and the 7-day forecast, as shares and a date only (P1)", () => {
    const now = Date.UTC(2026, 9, 15, 3, 0)
    const snapshot = buildSnapshot(
      {
        account: ACCOUNT,
        plan: "vector-50",
        state: "active",
        subscription: "sub_history",
        periodStart: start,
        periodEnd: end,
        cancelAtPeriodEnd: false,
        source: "webhook",
      },
      undefined,
      now,
    )
    const status: ModelPlanStatusRead = {
      active: true,
      customer: true,
      access: true,
      snapshot,
      plan: "vector-50",
      periodStart: start,
      periodEnd: end,
      cancelAtPeriodEnd: false,
      credits: 10,
      used: 5,
      remaining: 5,
      available: 5,
      idleAvailable: 5,
      shareUsed: 0.5,
    }
    const days = historyDays(start, now).map((day) => ({
      day,
      micro: ["2026-10-10", "2026-10-12", "2026-10-14"].includes(day)
        ? 1_000_000
        : day === "2026-10-02"
          ? 2_000_000
          : 0,
    }))
    const body = modelPlanBalance(status, { now, history: days })
    expect(body.history).toHaveLength(15)
    expect(body.history?.[0]).toEqual({ day: "2026-10-01", used: 0 })
    expect(body.history?.find((entry) => entry.day === "2026-10-10")).toEqual({ day: "2026-10-10", used: 0.1 })
    expect(body.plan?.forecastDate).toBe(
      forecastDate({ used: 0.5, periodStart: start, periodEnd: end, now, days, totalMicro: 10_000_000 }),
    )
    // Without a history the forecast falls back to the period average, and no history is sent.
    const without = modelPlanBalance(status, { now })
    expect(without).not.toHaveProperty("history")
    expect(without.plan?.forecastDate).toBe(forecastDate({ used: 0.5, periodStart: start, periodEnd: end, now }))
    expect(body.plan?.forecastDate).not.toBe(without.plan?.forecastDate)
    // No amount: every number is a share in 0..1 or a timestamp; the dates are strings.
    expect(JSON.stringify(body.history)).not.toMatch(/micro|usd|\$/i)
    for (const entry of body.history ?? []) expect(entry.used >= 0 && entry.used <= 1).toBe(true)
  })
})
