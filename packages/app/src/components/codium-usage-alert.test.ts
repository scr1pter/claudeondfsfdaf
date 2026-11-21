import { beforeEach, describe, expect, test } from "bun:test"
import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { resetPhoneAlerts, sendPhoneAlert, type PhoneAlert } from "@/context/phone-alerts"
import type { Platform } from "@/context/platform"
import type { QuietHours } from "@/context/settings"
import type { VectorAccountPlatform } from "@/vector-account"
import { sendUsageAlert } from "./codium-usage-alert"
import { usageShare } from "./settings-v2/codium-usage-model"

type Plan = NonNullable<ModelPlanStatus.Status["plan"]>

const PHONE_TITLE = "You've used 80% of this month's Codium usage"
const DESKTOP_TITLE = "Vector Codium usage"
const DESKTOP_TEXT = "You've used at least 80% of this month's Codium usage. Check your plan in Settings → Usage."

// The account's plan as the phone sender reads it (H1): phone alerts are listed, so a send reaches the phone fake.
const listed: ModelPlanStatus.Status = {
  signedIn: true,
  enabled: true,
  access: true,
  listed: ["alerts"],
  entitlements: { rank: 3 },
  purchased: { bought: false },
  empty: false,
  low: false,
}

function status(left: number | undefined, plan: Partial<Plan> = {}, extra: Partial<ModelPlanStatus.Status> = {}) {
  const read: ModelPlanStatus.Status = {
    signedIn: true,
    enabled: true,
    access: true,
    purchased: { bought: false },
    empty: false,
    low: false,
    plan: { id: "vector-50", name: "Pro", renewsAt: 1_800_000_000_000, cancelAtPeriodEnd: false, ...plan },
    ...extra,
  }
  if (left !== undefined && read.plan) read.plan.left = left
  return read
}

// Phone alerts are sent as at noon on this computer's clock, so quiet hours are deterministic.
const noon = new Date(2026, 10, 15, 12, 0)
const lunch: QuietHours = { start: "11:00", end: "13:00" }

const both = { desktop: true, phone: true }
const desktopOnly = { desktop: true, phone: false }
const off = { desktop: false, phone: false }

/**
 * One app window: its alert state, a desktop `notify` that rejects (never throws) while `fails` says so, and the real
 * `sendPhoneAlert` over a fake phone sender, so `phone` holds what `platform.phoneAlerts.send` was handed. `quiet` is
 * the quiet hours `sendPhoneAlert` reads at each send.
 */
function app(fails: boolean[] = []) {
  const phone: PhoneAlert[] = []
  const desktop: {
    title: string
    description?: string
    href?: string
    options?: { force?: boolean }
    delivered: boolean
  }[] = []
  const sent = { periods: new Set<string>(), phone: new Set<string>() }
  const choices = { quiet: null as QuietHours | null }
  const platform = {
    notify: async (title: string, description?: string, href?: string, options?: { force?: boolean }) => {
      const failed = fails.shift() ?? false
      desktop.push({ title, description, href, options, delivered: !failed })
      if (failed) throw new Error("The notification was not shown")
    },
    phoneAlerts: { send: async (alert: PhoneAlert) => void phone.push(alert) },
    vectorAccount: { codium: async () => listed },
  } satisfies Pick<Platform, "notify" | "phoneAlerts"> & { vectorAccount: Pick<VectorAccountPlatform, "codium"> }
  return {
    phone,
    desktop,
    choices,
    async read(
      next: ModelPlanStatus.Status | undefined,
      switches = both,
      // null: no signed-in account identity was read yet.
      account: string | null = "account-a",
    ) {
      await sendUsageAlert({
        status: next,
        identity: account ?? undefined,
        desktop: switches.desktop,
        phone: switches.phone,
        sent,
        platform,
        // `sendPhoneAlert` takes the whole `Platform`; the fake above is checked against the parts it reads.
        sendPhone: (alert) =>
          sendPhoneAlert(
            platform as Platform,
            { event: () => switches.phone, quietHours: () => choices.quiet },
            alert,
            noon,
          ),
      })
      // Lets a rejected notification's handler and the phone sender's plan read settle before the next status read,
      // whether or not the check hands back the notification's promise.
      await Bun.sleep(0)
    },
  }
}

beforeEach(() => resetPhoneAlerts())

describe("the Codium 80% usage alert", () => {
  test("with both switches on, the phone alert goes once while a failing desktop notification is tried again (F28)", async () => {
    const card = app([true, true])
    await card.read(status(0.19))
    await card.read(status(0.18))
    expect(card.phone).toEqual([{ event: "usage", title: PHONE_TITLE }])
    expect(card.desktop.map((call) => call.delivered)).toEqual([false, false])
    await card.read(status(0.17))
    expect(card.phone).toHaveLength(1)
    expect(card.desktop.map((call) => call.delivered)).toEqual([false, false, true])
    await card.read(status(0.16))
    expect(card.phone).toHaveLength(1)
    expect(card.desktop).toHaveLength(3)
  })

  test("a phone alert held back by quiet hours goes at a later read while the desktop notification keeps failing", async () => {
    const card = app([true, true])
    card.choices.quiet = lunch
    await card.read(status(0.19))
    expect(card.phone).toEqual([])
    card.choices.quiet = null
    await card.read(status(0.18))
    expect(card.phone).toEqual([{ event: "usage", title: PHONE_TITLE }])
    await card.read(status(0.17))
    await card.read(status(0.16))
    expect(card.phone).toHaveLength(1)
    expect(card.desktop.map((call) => call.delivered)).toEqual([false, false, true])
    // Once the desktop notification was shown the period is done, so a phone alert held back then is not tried again
    // (A24's shared key, unchanged).
    const shown = app()
    shown.choices.quiet = lunch
    await shown.read(status(0.19))
    shown.choices.quiet = null
    await shown.read(status(0.18))
    expect(shown.phone).toEqual([])
    expect(shown.desktop).toHaveLength(1)
  })

  test("desktop only: a failed notification is tried at the next read, and one that was shown is not repeated", async () => {
    const card = app([true])
    await card.read(status(0.19), desktopOnly)
    await card.read(status(0.18), desktopOnly)
    await card.read(status(0.17), desktopOnly)
    expect(card.desktop.map((call) => call.delivered)).toEqual([false, true])
    expect(card.phone).toEqual([])
  })

  test("with both switches off nothing is sent", async () => {
    const card = app()
    for (const left of [0.19, 0.05, 0]) await card.read(status(left), off)
    expect(card.phone).toEqual([])
    expect(card.desktop).toEqual([])
  })

  test("the titles are unchanged and carry no amount or token figure", async () => {
    const card = app()
    await card.read(status(0.19))
    expect(card.phone).toEqual([{ event: "usage", title: PHONE_TITLE }])
    expect(card.desktop).toEqual([
      { title: DESKTOP_TITLE, description: DESKTOP_TEXT, href: undefined, options: { force: true }, delivered: true },
    ])
    const words = [card.phone[0]!.title, card.desktop[0]!.title, card.desktop[0]!.description!]
    for (const text of words) expect(text).not.toMatch(/\$|\btokens?\b|\bcredits?\b|\busd\b|\bcents?\b|\bdollars?\b/i)
    expect(words.flatMap((text) => text.match(/\d+/g) ?? [])).toEqual(["80", "80"])
  })

  test("above 20% left nothing is sent; the threshold is the share the Usage card shows (H5)", async () => {
    // A raw share between 0.2 and 0.205 is shown as 80% used, so it alerts; one that rounds to 21% left does not.
    expect(usageShare(0.203)?.text).toBe("80% used · 20% left")
    expect(usageShare(0.207)?.text).toBe("79% used · 21% left")
    for (const left of [1, 0.5, 0.21, 0.207]) {
      const card = app()
      await card.read(status(left))
      expect({ left, phone: card.phone.length, desktop: card.desktop.length }).toEqual({ left, phone: 0, desktop: 0 })
    }
    for (const left of [0.2, 0.203, 0.19, 0]) {
      const card = app()
      await card.read(status(left))
      expect({ left, phone: card.phone.length, desktop: card.desktop.length }).toEqual({ left, phone: 1, desktop: 1 })
    }
  })

  test("each account, plan and renewal alerts once, and nothing goes without a signed-in plan read", async () => {
    const card = app()
    await card.read(status(0.19), both, null)
    await card.read(status(0.19, {}, { signedIn: false }))
    await card.read(status(0.19, {}, { error: "Vector could not load your Codium usage. Try again shortly." }))
    await card.read(status(0.19, {}, { plan: undefined }))
    await card.read(status(undefined))
    await card.read(undefined)
    expect(card.phone).toEqual([])
    expect(card.desktop).toEqual([])
    await card.read(status(0.19))
    await card.read(status(0.19, { renewsAt: 1_802_592_000_000 }))
    await card.read(status(0.19, { id: "vector-100", name: "Max" }))
    await card.read(status(0.19), both, "account-b")
    expect(card.phone).toHaveLength(4)
    expect(card.desktop).toHaveLength(4)
    await card.read(status(0.1), both, "account-b")
    await card.read(status(0.05, { id: "vector-100", name: "Max" }))
    expect(card.phone).toHaveLength(4)
    expect(card.desktop).toHaveLength(4)
  })

  test("a period that already alerted on one channel stays silent when the other switch is turned on (A24, unchanged)", async () => {
    const card = app()
    await card.read(status(0.19), desktopOnly)
    expect(card.desktop).toHaveLength(1)
    expect(card.phone).toHaveLength(0)
    await card.read(status(0.18), both)
    expect(card.desktop).toHaveLength(1)
    expect(card.phone).toHaveLength(0)
    const phoneFirst = app()
    await phoneFirst.read(status(0.19), { desktop: false, phone: true })
    await phoneFirst.read(status(0.18), both)
    expect(phoneFirst.phone).toHaveLength(1)
    expect(phoneFirst.desktop).toHaveLength(0)
  })
})
