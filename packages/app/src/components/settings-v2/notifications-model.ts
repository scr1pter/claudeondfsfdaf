import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import type { PhoneAlertEvent, QuietHours } from "@/context/settings"

// Settings → Notifications (WP A38): desktop notifications, and phone alerts for an account whose Codium plan includes
// them while vectordev.ai lists them (H1). The server decides every subscription and send from the plan itself (S1);
// this only decides what Settings shows. A41's sender applies the choices with `phoneAlertAllowed`.

export const PHONE_APP_ADDRESS = "remote.vectordev.ai"

/**
 * What a phone alert from this computer holds, as Settings says it. `alertTitle` (context/phone-alerts.ts) builds each
 * title from the session's name, and a new session's name is the first line of its first message until a better one
 * is made, so this never promises that alerts leave out what was typed. remote-notify.ts seals every alert under the
 * computer's alert key, which only paired phones hold.
 */
export const PHONE_ALERT_CONTENT =
  "Alerts show a short title, such as the session's name, sealed so only your paired phones can read it."

export const PHONE_ALERT_EVENTS: readonly { event: PhoneAlertEvent; title: string; description: string }[] = [
  { event: "finished", title: "An agent finished", description: "When a task you started on this computer finishes." },
  { event: "needsYou", title: "An agent needs you", description: "When an agent waits for an answer or a permission." },
  { event: "runGuard", title: "Run Guard", description: "When Run Guard warns that a run is close to its limit." },
  { event: "usage", title: "Codium usage", description: "When 80% of this month's Codium usage is used." },
]

/** Every half hour of the day, for the quiet-hours pickers. */
export const QUIET_TIMES: readonly string[] = Array.from(
  { length: 48 },
  (_, index) => `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`,
)

export const DEFAULT_QUIET_HOURS: QuietHours = { start: "22:00", end: "07:00" }

/** Whether Settings shows phone alerts: the account's plan includes them and vectordev.ai lists them. */
export function phoneAlertsOffered(status: ModelPlanStatus.Status | undefined) {
  return Boolean(
    status?.signedIn &&
      !status.error &&
      status.listed?.includes("alerts") &&
      typeof status.entitlements?.rank === "number",
  )
}

function minutes(time: string) {
  const [hours, mins] = time.split(":").map(Number)
  return hours * 60 + mins
}

/** Whether `date` (local time) falls inside quiet hours; a range whose end is before its start runs past midnight. */
export function isQuietTime(quiet: QuietHours | null, date: Date) {
  if (!quiet) return false
  const now = date.getHours() * 60 + date.getMinutes()
  const start = minutes(quiet.start)
  const end = minutes(quiet.end)
  if (start === end) return false
  return start < end ? now >= start && now < end : now >= start || now < end
}

/** Whether a computer sends a phone alert for this event now: the event is on and it is not quiet hours. */
export function phoneAlertAllowed(
  choices: { event: (name: PhoneAlertEvent) => boolean; quietHours: () => QuietHours | null },
  event: PhoneAlertEvent,
  date: Date,
) {
  return choices.event(event) && !isQuietTime(choices.quietHours(), date)
}

/** "22:00" as this computer shows times. */
export function timeLabel(time: string, locale?: string) {
  const [hours, mins] = time.split(":").map(Number)
  return new Date(2000, 0, 1, hours, mins).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
}
