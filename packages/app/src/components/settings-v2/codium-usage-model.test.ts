import { describe, expect, test } from "bun:test"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { codiumUsageRows, createUsageRefresh, usageForecast, usageFreshness, usageShare } from "./codium-usage-model"

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
