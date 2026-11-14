import { sealAlert, fromBase64url } from "./remote-crypto"

// Encrypted phone alerts from this computer (WP A41, P7). The app decides which events reach the phones (Settings →
// Notifications: the event switches and quiet hours, `phoneAlertAllowed`), and this seals each alert under the
// computer's alert key, which only phones paired with it hold (remote-pairing.ts sends it in PAIR_DONE). vectordev.ai
// relays the ciphertext to the account's phones (`POST /api/notify/send`, A37) and never sees the title. A phone that
// does not hold the key shows "Open Vector to see this alert".
//
// Sent only while a phone is paired. Every app window runs the same notification rules, so the same alert asked for
// twice within a minute is sent once; at most 50 an hour leave this computer (the server allows 60).

export const NOTIFY_URL = "https://vectordev.ai/api/notify/send"
export const PHONE_ALERT_EVENTS = ["finished", "needsYou", "runGuard", "usage"] as const
export type PhoneAlertEvent = (typeof PHONE_ALERT_EVENTS)[number]
export type PhoneAlert = { event: PhoneAlertEvent; title: string; route?: "sessions" | "approvals" }
export type NotifyResult = {
  sent: boolean
  reason?: "invalid" | "not-paired" | "signed-out" | "duplicate" | "limited" | "failed"
}

const ROUTES = new Set(["sessions", "approvals"])
const TITLE_MAX = 120
const DEDUPE_MS = 60_000
const HOURLY = 50

/** A title the phone shows: one line, at most 120 characters, cut with an ellipsis. */
export function alertTitle(value: unknown) {
  if (typeof value !== "string") return undefined
  const line = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!line) return undefined
  return line.length <= TITLE_MAX ? line : `${line.slice(0, TITLE_MAX - 1).trimEnd()}…`
}

export function readPhoneAlert(value: unknown): PhoneAlert | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (!PHONE_ALERT_EVENTS.includes(input.event as PhoneAlertEvent)) return undefined
  const title = alertTitle(input.title)
  if (!title) return undefined
  if (input.route !== undefined && !ROUTES.has(input.route as string)) return undefined
  return {
    event: input.event as PhoneAlertEvent,
    title,
    ...(input.route ? { route: input.route as PhoneAlert["route"] } : {}),
  }
}

export function createRemoteNotify(deps: {
  /** The desktop sign-in, or undefined while signed out. */
  token: () => Promise<string | undefined>
  /** The alert key and its id while at least one phone is paired; undefined otherwise. */
  alertKey: () => { key: string; id: string } | undefined
  /** Sends the request, labelled for Vector Local (`phone-alerts`). */
  fetch: (url: string, init: RequestInit) => Promise<Response>
  now?: () => number
  log?: (message: string, meta?: Record<string, unknown>) => void
}) {
  const now = deps.now ?? Date.now
  const recent = new Map<string, number>()
  const sent: number[] = []

  return {
    async send(input: unknown): Promise<NotifyResult> {
      const alert = readPhoneAlert(input)
      if (!alert) return { sent: false, reason: "invalid" }
      const key = deps.alertKey()
      if (!key) return { sent: false, reason: "not-paired" }
      const at = now()
      for (const [entry, time] of recent) if (at - time >= DEDUPE_MS) recent.delete(entry)
      const fingerprint = `${alert.event}\n${alert.title}`
      if (recent.has(fingerprint)) return { sent: false, reason: "duplicate" }
      while (sent.length && at - sent[0]! >= 3_600_000) sent.shift()
      if (sent.length >= HOURLY) return { sent: false, reason: "limited" }
      const token = await deps.token().catch(() => undefined)
      if (!token) return { sent: false, reason: "signed-out" }
      recent.set(fingerprint, at)
      sent.push(at)
      const ciphertext = await sealAlert(fromBase64url(key.key), {
        title: alert.title,
        ...(alert.route ? { route: alert.route } : {}),
      })
      const response = await deps
        .fetch(NOTIFY_URL, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ ciphertext, key: key.id, urgency: alert.event === "needsYou" ? "high" : "normal" }),
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        })
        .catch(() => undefined)
      if (!response?.ok) {
        deps.log?.("phone alert not sent", { status: response?.status ?? 0, event: alert.event })
        return { sent: false, reason: "failed" }
      }
      return { sent: true }
    },
  }
}

export type RemoteNotify = ReturnType<typeof createRemoteNotify>
