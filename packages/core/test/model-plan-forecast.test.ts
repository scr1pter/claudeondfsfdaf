import { expect, test } from "bun:test"
import { ModelPlanStatus } from "../src/model-plan-status"

// WP A32: the forecast line `vector codium` prints, and the day shares the usage strip shows. The server decides the
// forecast date (api/_lib/codium-usage-history.ts) and hides it early in the month, under 5% used and when the month
// lasts; clients only word it.

const renewsAt = Date.UTC(2026, 10, 30, 15)
const answer = (plan: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ModelPlanStatus.fromRemote(
    {
      enabled: true,
      access: true,
      plan: { id: "vector-50", name: "Pro", left: 0.4, renewsAt, cancelAtPeriodEnd: false, ...plan },
      purchased: { bought: false },
      empty: false,
      low: false,
    },
    {
      plan: { id: "vector-50", name: "Pro", left: 0.4, renewsAt, cancelAtPeriodEnd: false, ...plan },
      ...extra,
    },
  )

test("vector codium prints the forecast line after today's share, worded as the app words it", () => {
  const status = answer({
    state: "active",
    today: { used: 0.42, resetsAt: Date.UTC(2026, 10, 15), reached: false },
    forecastDate: "2026-11-22",
  })
  expect(status.plan?.forecastDate).toBe("2026-11-22")
  expect(ModelPlanStatus.describe(status)).toEqual([
    `Plan: Pro, 40% left this month, renews ${ModelPlanStatus.formatDate(renewsAt)}`,
    "Today: 42% of today's limit used",
    "At this pace, this month's usage may run out around Nov 22.",
    `Change plan: ${ModelPlanStatus.MANAGE_URL}`,
  ])
})

test("the forecast is a UTC date, the same day in every time zone", () => {
  // Midnight UTC is still the previous evening west of Greenwich; the line must not move back a day there.
  expect(ModelPlanStatus.forecastText("2026-12-01")).toBe("At this pace, this month's usage may run out around Dec 1.")
  expect(ModelPlanStatus.forecastText("2026-12-01", "en-GB")).toBe(
    "At this pace, this month's usage may run out around 1 Dec.",
  )
})

test("no forecast date, or one that is not a date, prints no line", () => {
  expect(ModelPlanStatus.describe(answer()).some((line) => line.startsWith("At this pace"))).toBe(false)
  expect(ModelPlanStatus.forecastText(undefined)).toBeUndefined()
  expect(ModelPlanStatus.forecastText("2026-13-45")).toBeUndefined()
  expect(ModelPlanStatus.forecastText("soon")).toBeUndefined()
  // The lenient decoder drops a malformed date rather than failing the status.
  const malformed = answer({ forecastDate: "next week" })
  expect(malformed.plan).not.toHaveProperty("forecastDate")
  expect(malformed.error).toBeUndefined()
})

test("history decodes as the server sends it, and each day reads as a whole percent or <1%", () => {
  const status = answer(
    {},
    {
      history: [
        { day: "2026-11-01", used: 0 },
        { day: "2026-11-02", used: 0.04 },
        { day: "not a day", used: 0.1 },
        { day: "2026-11-03", used: 7 },
      ],
    },
  )
  // Malformed entries are dropped one by one (§4.11's lenient pass).
  expect(status.history).toEqual([
    { day: "2026-11-01", used: 0 },
    { day: "2026-11-02", used: 0.04 },
  ])
  expect(ModelPlanStatus.formatDayShare(0)).toBe("<1%")
  expect(ModelPlanStatus.formatDayShare(0.004)).toBe("<1%")
  expect(ModelPlanStatus.formatDayShare(0.01)).toBe("1%")
  expect(ModelPlanStatus.formatDayShare(0.25)).toBe("25%")
  // The CLI's lines carry no amount: only the plan's shares, dates and links.
  expect(ModelPlanStatus.describe(status).join(" ")).not.toMatch(/\$|usd|credit|token/i)
})
