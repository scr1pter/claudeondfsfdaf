import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { phoneAlertAllowed, phoneAlertsOffered } from "@/components/settings-v2/notifications-model"
import { onCodiumChange } from "@/vector-account"
import type { Platform } from "./platform"
import type { PhoneAlertEvent, QuietHours } from "./settings"

// Phone alerts from this computer (WP A41). The app decides which events go (Settings → Notifications: each event's
// switch and quiet hours, `phoneAlertAllowed`), and only while vectordev.ai lists phone alerts for the account's plan
// (H1); the desktop's main process seals each alert so only the paired phones can read it, and vectordev.ai decides
// from the plan whether it is delivered (S1). Titles are short and name no amount.

type Choices = { event: (name: PhoneAlertEvent) => boolean; quietHours: () => QuietHours | null }
export type PhoneAlert = { event: PhoneAlertEvent; title: string; route?: "sessions" | "approvals" }

const OFFER_MS = 5 * 60_000
let offered: { at: number; value: Promise<boolean> } | undefined
onCodiumChange(() => {
  offered = undefined
})

/** Whether the account's plan includes phone alerts and vectordev.ai lists them, read at most every five minutes. */
function alertsOffered(platform: Platform, now: number) {
  const read = platform.vectorAccount?.codium
  if (!read) return Promise.resolve(false)
  if (!offered || now - offered.at > OFFER_MS)
    offered = {
      at: now,
      value: read()
        .then((status: ModelPlanStatus.Status) => phoneAlertsOffered(status))
        .catch(() => false),
    }
  return offered.value
}

/** Sends one phone alert when this computer can, the event is on, it is not quiet hours, and the plan includes it. */
export function sendPhoneAlert(platform: Platform, choices: Choices, alert: PhoneAlert, date = new Date()) {
  const send = platform.phoneAlerts?.send
  if (!send || !phoneAlertAllowed(choices, alert.event, date)) return Promise.resolve(false)
  return alertsOffered(platform, date.getTime())
    .then((ok) => (ok ? send(alert).then(() => true) : false))
    .catch(() => false)
}

/** "Finished: Fix the login", kept to one short line. */
export function alertTitle(prefix: string, name: string | undefined) {
  const clean = (name ?? "").replace(/\s+/g, " ").trim()
  const title = clean ? `${prefix}: ${clean}` : prefix
  return title.length <= 120 ? title : `${title.slice(0, 119).trimEnd()}…`
}

/** Forgets the cached plan read (tests). */
export function resetPhoneAlerts() {
  offered = undefined
}
