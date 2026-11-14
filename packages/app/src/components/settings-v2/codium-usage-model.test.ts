import { describe, expect, test } from "bun:test"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import {
  codiumUsageRows,
  createUsageRefresh,
  HISTORY_STRIP_DAYS,
  renewalCard,
  usageForecast,
  usageFreshness,
  usageHistoryStrip,
  usageShare,
} from "./codium-usage-model"

const status: ModelPlanStatus.Status = {
  signedIn: true,
  enabled: true,
  access: true,
  empty: false,
  low: false,
  purchased: { bought: true, state: "available" },
  plan: { id: "vector-50", name: "Vector Pro", left: 0.6449, renewsAt: 1_800_000_000_000, cancelAtPeriodEnd: false },
}

describe("Codium percentage usage", () => {
  test("rounds one side so every valid pair adds to 100 (H5), with left as the meter value", () => {
    for (const left of [0, 0.005, 0.205, 0.49999, 0.5, 0.6449, 0.995, 1]) {
      const share = usageShare(left)!
      expect(share.left + share.used).toBe(100)
      expect(share.left).toBe(Math.round(left * 100))
      expect(share.text).toBe(`${share.used}% used · ${share.left}% left`)
    }
    for (const invalid of [undefined, NaN, Infinity, -0.1, 1.1]) expect(usageShare(invalid)).toBeUndefined()
  })

  test("older statuses show only month; purchased credits never create a row", () => {
    expect(codiumUsageRows(status)).toEqual([
      { label: "This month", share: { used: 36, left: 64, text: "36% used · 64% left" } },
    ])
    expect(codiumUsageRows(undefined)).toEqual([])
    expect(codiumUsageRows({ ...status, signedIn: false })).toEqual([])
    expect(codiumUsageRows({ ...status, error: "Unavailable" })).toEqual([])
  })

  test("shows daily and listed perk meters only, retaining unavailable listed balances", () => {
    const current: ModelPlanStatus.Status = {
      ...status,
      plan: { ...status.plan!, today: { used: 0.3, resetsAt: 1_800_000_000_000, reached: false } },
      listed: ["github-agents", "computer", "vault", "brain"],
      meters: {
        cloudAgents: { used: 0.4, exhausted: false },
        brain: { used: 0.04, cap: 0.1 },
        vault: { usedBytes: 2e9, quotaBytes: 10e9 },
      },
    }
    expect(codiumUsageRows(current).map((row) => [row.label, row.share?.left])).toEqual([
      ["This month", 64],
      ["Today", 70],
      ["Codium agent time", 60],
      ["Cloud computer hours", undefined],
      ["Vault storage", 80],
      ["Brain helpers", 60],
    ])
    expect(codiumUsageRows({ ...current, listed: [] }).map((row) => row.label)).toEqual(["This month", "Today"])
  })

  test("forecast and freshness are optional and never expose amounts", () => {
    expect(usageForecast(status)).toBeUndefined()
    expect(usageForecast({ ...status, plan: { ...status.plan!, forecastDate: "2026-11-17" } })).toContain("Nov 17")
    expect(usageFreshness(undefined, 0)).toBe("Not updated yet")
    expect(usageFreshness(10_000, 10_001)).toBe("Updated just now")
    expect(usageFreshness(10_000, 250_000)).toBe("Updated 4 min ago")
  })
})

// WP A32: the 31-day strip and the renewal card. Status's history starts on the period's first UTC date and lists
// every date through today as a whole-percent share of the month.
describe("Codium usage history", () => {
  const period = (days: number, used: (index: number) => number) =>
    Array.from({ length: days }, (_, index) => ({
      day: new Date(Date.UTC(2026, 9, 20 + index)).toISOString().slice(0, 10),
      used: used(index),
    }))
  const now = Date.UTC(2026, 9, 25, 12)

  test("the strip ends on the newest date, marks dates before the period, and reads <1% for shares that round to 0", () => {
    const history = period(6, (index) => [0, 0, 0.04, 0.2, 0, 0.1][index]!)
    const strip = usageHistoryStrip({ ...status, history }, now)!
    expect(strip.days).toHaveLength(HISTORY_STRIP_DAYS)
    expect(strip.days.at(-1)).toMatchObject({ day: "2026-10-25", today: true, period: true, height: 50 })
    expect(strip.days.at(-6)).toMatchObject({ day: "2026-10-20", period: true, height: 0 })
    expect(strip.days.at(-7)).toMatchObject({ day: "2026-10-19", period: false, height: 0 })
    expect(strip.days.at(-7)!.label).toContain("before this period")
    expect(strip.days.at(-6)!.label).toContain("<1% of this month")
    expect(strip.days.at(-4)!.label).toContain("4% of this month")
    expect(strip.days.at(-3)).toMatchObject({ height: 100 })
    expect(strip.days.filter((day) => day.today)).toHaveLength(1)
    // Shares, dates and whole percents only: no amount, token or price.
    expect(JSON.stringify(strip)).not.toMatch(/\$|usd|credit|token|cents/i)
  })

  test("a full period shows its last 31 dates", () => {
    const history = period(32, () => 0.03)
    const strip = usageHistoryStrip({ ...status, history }, now)!
    expect(strip.days).toHaveLength(31)
    expect(strip.days.every((day) => day.period && day.height === 100)).toBe(true)
    expect(strip.days[0]!.day).toBe(history[1]!.day)
  })

  test("no strip without a plan, a history or a good read", () => {
    expect(usageHistoryStrip(status, now)).toBeUndefined()
    expect(usageHistoryStrip({ ...status, history: [] }, now)).toBeUndefined()
    const history = period(3, () => 0.1)
    expect(usageHistoryStrip({ ...status, history, plan: undefined }, now)).toBeUndefined()
    expect(usageHistoryStrip({ ...status, history, error: "Unavailable" }, now)).toBeUndefined()
    expect(usageHistoryStrip(undefined, now)).toBeUndefined()
  })

  test("the renewal card counts this computer's Codium work since the period started, in counts only", () => {
    const history = period(6, () => 0.05)
    const summary = {
      days: [
        { date: "2026-10-18", codium: 40 }, // before the period: not counted
        { date: "2026-10-20", codium: 12 },
        { date: "2026-10-21" },
        { date: "2026-10-23", codium: 1_200 },
      ],
    }
    const card = renewalCard({ ...status, history }, summary)!
    expect(card).toEqual({
      title: "Before your plan renews",
      rows: [
        { label: "Codium responses", value: (1_212).toLocaleString() },
        { label: "Days with Codium work", value: "2" },
      ],
      note: expect.stringContaining("Counted on this computer since"),
    })
    expect(card.note).toContain("Oct 20")
    expect(
      renewalCard({ ...status, history, plan: { ...status.plan!, cancelAtPeriodEnd: true } }, summary)?.title,
    ).toBe("Before your plan ends")
    // Counts only: no share, token, price or amount reaches the card.
    expect(JSON.stringify(card)).not.toMatch(/%|\$|usd|credit|token|cents/i)
  })

  test("no renewal card without a plan and history, or from a server that cannot attribute Codium by day", () => {
    const history = period(3, () => 0.1)
    const summary = { days: [{ date: "2026-10-21", codium: 3 }] }
    expect(renewalCard(status, summary)).toBeUndefined()
    expect(renewalCard({ ...status, history }, undefined)).toBeUndefined()
    expect(renewalCard({ ...status, history }, { ...summary, legacyCodium: true })).toBeUndefined()
    expect(renewalCard({ ...status, history, plan: undefined }, summary)).toBeUndefined()
  })
})

test("open usage refresh throttles focus, delays turn settlement once, and cancels on close", () => {
  const state = { now: 0, reads: 0, cancelled: 0, pending: undefined as (() => void) | undefined }
  const updates = createUsageRefresh(() => state.reads++, {
    now: () => state.now,
    schedule: (callback, ms) => {
      expect(ms).toBe(15_000)
      expect(state.pending).toBeUndefined()
      state.pending = callback
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    cancel: () => {
      state.cancelled++
      state.pending = undefined
    },
  })
  updates.read()
  state.now = 59_999
  updates.focus()
  expect(state.reads).toBe(0)
  state.now = 60_000
  updates.focus()
  updates.focus()
  expect(state.reads).toBe(1)
  updates.turn()
  updates.turn()
  expect(state.reads).toBe(1)
  const pending = state.pending!
  state.pending = undefined
  pending()
  expect(state.reads).toBe(2)
  updates.turn()
  updates.dispose()
  expect(state.cancelled).toBe(1)
  expect(state.pending).toBeUndefined()
  state.now = 200_000
  updates.focus()
  updates.turn()
  expect(state.reads).toBe(2)
})
