import { beforeEach, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { PHONE_ALERT_CONTENT } from "@/components/settings-v2/notifications-model"
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

test("what Settings and the phone say an alert holds is what alertTitle sends", async () => {
  // A new session is named after the first line of its first message until a better name is made, and every alert
  // title from this computer carries the session's name, so the copy may not promise that what was typed stays out.
  const typed = "Fix the login redirect in auth.ts"
  expect(alertTitle("Finished", typed)).toBe(`Finished: ${typed}`)
  expect(alertTitle("Needs you", typed)).toContain(typed)
  expect(PHONE_ALERT_CONTENT).toContain("session's name")
  const sources = await Promise.all(
    ["../components/settings-v2/notifications.tsx", "../phone/routes/notifications.tsx"].map((file) =>
      readFile(path.resolve(import.meta.dir, file), "utf8"),
    ),
  )
  for (const text of [PHONE_ALERT_CONTENT, ...sources].map((item) => item.replace(/\s+/g, " ")))
    expect(text).not.toMatch(/never (include )?your (code|prompts?)|(code|prompts?) never (show|leave)/i)
  expect(sources[0]).toContain("PHONE_ALERT_CONTENT")
})
