import { expect, test } from "bun:test"
import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { restoredSettings, validQuietHours } from "@/context/settings"
import {
  isQuietTime,
  phoneAlertAllowed,
  phoneAlertsOffered,
  PHONE_ALERT_EVENTS,
  QUIET_TIMES,
} from "./notifications-model"

// Settings → Notifications (WP A38): phone alerts show only for an account whose plan includes them while they are
// listed (H1); the chosen events and quiet hours decide what a computer sends.

const status = (fields: Partial<ModelPlanStatus.Status>): ModelPlanStatus.Status => ({
  signedIn: true,
  enabled: true,
  access: true,
  purchased: { bought: false },
  empty: false,
  low: false,
  ...fields,
})

test("phone alerts show only when listed and the plan includes them", () => {
  expect(phoneAlertsOffered(undefined)).toBe(false)
  expect(phoneAlertsOffered(status({ listed: [], entitlements: { rank: 1 } }))).toBe(false)
  expect(phoneAlertsOffered(status({ listed: ["alerts"] }))).toBe(false)
  expect(phoneAlertsOffered(status({ listed: ["alerts"], entitlements: { rank: 1 } }))).toBe(true)
  expect(phoneAlertsOffered(status({ listed: ["alerts"], entitlements: { rank: 1 }, error: "x" }))).toBe(false)
  expect(phoneAlertsOffered(status({ signedIn: false, listed: ["alerts"], entitlements: { rank: 1 } }))).toBe(false)
})

test("quiet hours, including a range past midnight", () => {
  const at = (hours: number, minutes = 0) => new Date(2026, 10, 3, hours, minutes)
  const night = { start: "22:00", end: "07:00" }
  expect(isQuietTime(night, at(23))).toBe(true)
  expect(isQuietTime(night, at(3))).toBe(true)
  expect(isQuietTime(night, at(7))).toBe(false)
  expect(isQuietTime(night, at(12))).toBe(false)
  expect(isQuietTime(night, at(22))).toBe(true)
  const lunch = { start: "12:00", end: "13:30" }
  expect(isQuietTime(lunch, at(12, 45))).toBe(true)
  expect(isQuietTime(lunch, at(13, 30))).toBe(false)
  expect(isQuietTime(null, at(3))).toBe(false)
})

test("an alert goes only for a chosen event outside quiet hours", () => {
  const choices = (events: Record<string, boolean>, quiet: { start: string; end: string } | null) => ({
    event: (name: string) => events[name] ?? false,
    quietHours: () => quiet,
  })
  const noon = new Date(2026, 10, 3, 12)
  const midnight = new Date(2026, 10, 3, 0, 15)
  expect(phoneAlertAllowed(choices({ finished: true }, null), "finished", noon)).toBe(true)
  expect(phoneAlertAllowed(choices({ finished: false }, null), "finished", noon)).toBe(false)
  expect(phoneAlertAllowed(choices({ needsYou: true }, { start: "22:00", end: "07:00" }), "needsYou", midnight)).toBe(
    false,
  )
})

test("saved quiet hours are checked, and the defaults keep usage alerts off", () => {
  expect(validQuietHours({ start: "22:00", end: "07:00" })).toEqual({ start: "22:00", end: "07:00" })
  for (const value of [
    undefined,
    null,
    {},
    { start: "25:00", end: "07:00" },
    { start: "7:00", end: "08:00" },
    { start: "08:00", end: "08:00" },
  ])
    expect(validQuietHours(value)).toBeNull()
  const defaults = restoredSettings({} as Parameters<typeof restoredSettings>[0])
  expect(defaults.notifications.events).toEqual({ finished: true, needsYou: true, runGuard: true, usage: false })
  expect(defaults.notifications.quietHours).toBeNull()
  expect(PHONE_ALERT_EVENTS.map((item) => item.event)).toEqual(["finished", "needsYou", "runGuard", "usage"])
  expect(QUIET_TIMES).toHaveLength(48)
  expect(QUIET_TIMES[0]).toBe("00:00")
  expect(QUIET_TIMES[47]).toBe("23:30")
})
