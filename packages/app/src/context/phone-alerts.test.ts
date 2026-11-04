import { beforeEach, describe, expect, test } from "bun:test"
import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import type { Platform } from "./platform"
import { alertTitle, resetPhoneAlerts, sendPhoneAlert, type PhoneAlert } from "./phone-alerts"

const listed = {
  signedIn: true,
  enabled: true,
  access: true,
  listed: ["alerts"],
  entitlements: { rank: 1 },
  purchased: { bought: false },
  empty: false,
  low: false,
} as unknown as ModelPlanStatus.Status

function platform(status: ModelPlanStatus.Status | undefined, sends = true) {
  const sent: PhoneAlert[] = []
  const reads = { count: 0 }
  const value = {
    platform: "desktop",
    vectorAccount: {
      codium: async () => {
        reads.count += 1
        if (!status) throw new Error("offline")
        return status
      },
    },
    ...(sends ? { phoneAlerts: { send: async (alert: PhoneAlert) => void sent.push(alert) } } : {}),
  } as unknown as Platform
  return { value, sent, reads }
}

const choices = (
  events: Partial<Record<string, boolean>> = {},
  quiet: { start: string; end: string } | null = null,
) => ({
  event: (name: string) => events[name] ?? true,
  quietHours: () => quiet,
})
const noon = new Date(2026, 10, 4, 12, 0)
const finished: PhoneAlert = { event: "finished", title: "Finished: Fix the login", route: "sessions" }

beforeEach(() => resetPhoneAlerts())

describe("sendPhoneAlert", () => {
  test("sends when the computer can, the event is on, it is not quiet hours and the plan includes alerts", async () => {
    const { value, sent } = platform(listed)
    expect(await sendPhoneAlert(value, choices(), finished, noon)).toBe(true)
    expect(sent).toEqual([finished])
  })

  test("sends nothing for an event that is off, in quiet hours, or where the computer cannot send", async () => {
    const one = platform(listed)
    expect(await sendPhoneAlert(one.value, choices({ finished: false }), finished, noon)).toBe(false)
    expect(await sendPhoneAlert(one.value, choices({}, { start: "11:00", end: "13:00" }), finished, noon)).toBe(false)
    expect(one.sent).toEqual([])
    const web = platform(listed, false)
    expect(await sendPhoneAlert(web.value, choices(), finished, noon)).toBe(false)
  })

  test("sends nothing while vectordev.ai does not list phone alerts for the plan (H1), or the plan cannot be read", async () => {
    const unlisted = platform({ ...listed, listed: [] } as unknown as ModelPlanStatus.Status)
    expect(await sendPhoneAlert(unlisted.value, choices(), finished, noon)).toBe(false)
    expect(unlisted.sent).toEqual([])
    resetPhoneAlerts()
    const offline = platform(undefined)
    expect(await sendPhoneAlert(offline.value, choices(), finished, noon)).toBe(false)
  })

  test("reads the plan at most every five minutes", async () => {
    const { value, reads } = platform(listed)
    await sendPhoneAlert(value, choices(), finished, noon)
    await sendPhoneAlert(value, choices(), finished, new Date(noon.getTime() + 60_000))
    expect(reads.count).toBe(1)
    await sendPhoneAlert(value, choices(), finished, new Date(noon.getTime() + 6 * 60_000))
    expect(reads.count).toBe(2)
  })

  test("keeps titles to one short line", () => {
    expect(alertTitle("Finished", "  Fix\nthe   login ")).toBe("Finished: Fix the login")
    expect(alertTitle("Needs you", undefined)).toBe("Needs you")
    expect(alertTitle("Finished", "x".repeat(300)).length).toBe(120)
  })
})
