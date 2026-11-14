import { phoneApi, PhoneApiError } from "./api"
import { fromBase64url, type PhoneSession } from "./auth"

// Turning phone alerts on and off (WP A38), against A37's `/api/notify/subscribe`. The browser makes a push
// subscription for the server's VAPID key; the server stores it for the signed-in account only while the plan allows
// phone alerts (S1), and deletes it when asked whatever the plan. Alerts carry titles only, or arrive encrypted end
// to end from the desktop (P7); the service worker (sw.ts) shows them.

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type SubscriptionLike = {
  endpoint: string
  options?: { applicationServerKey?: ArrayBuffer | null }
  toJSON(): unknown
  unsubscribe(): Promise<boolean>
}
export type PushManagerLike = {
  getSubscription(): Promise<SubscriptionLike | null>
  subscribe(options: { userVisibleOnly: true; applicationServerKey: Uint8Array }): Promise<SubscriptionLike>
}
export type PushDeps = {
  fetcher: Fetch
  pushManager: () => Promise<PushManagerLike | undefined>
  permission: () => "default" | "denied" | "granted"
  requestPermission: () => Promise<"default" | "denied" | "granted">
}

export type AlertsState = "on" | "off" | "denied"

/** Whether this phone receives alerts now. */
export async function alertsState(deps: PushDeps): Promise<AlertsState> {
  const permission = deps.permission()
  if (permission === "denied") return "denied"
  const subscription = await (await deps.pushManager())?.getSubscription().catch(() => null)
  return permission === "granted" && subscription ? "on" : "off"
}

/** Asks for notifications (call from a tap: iOS refuses otherwise), subscribes and registers the phone. */
export async function turnOnAlerts(session: PhoneSession, deps: PushDeps) {
  const permission = deps.permission() === "granted" ? "granted" : await deps.requestPermission()
  if (permission !== "granted")
    throw new PhoneApiError(0, "NOTIFICATIONS_DENIED", "Notifications for Vector are off in this phone's settings.")
  const answer = await phoneApi("/api/notify/subscribe", undefined, {}, deps.fetcher)
  const key = typeof answer.publicKey === "string" ? fromBase64url(answer.publicKey) : undefined
  if (key?.length !== 65) throw new PhoneApiError(503, "PUSH_UNAVAILABLE", "Phone alerts are temporarily unavailable.")
  const manager = await deps.pushManager()
  if (!manager) throw new PhoneApiError(0, "PUSH_UNSUPPORTED", "This browser cannot receive alerts.")
  let existing = await manager.getSubscription().catch(() => null)
  // A subscription made for an older server key would never deliver; replace it.
  if (existing && !sameKey(existing.options?.applicationServerKey, key)) {
    await existing.unsubscribe().catch(() => false)
    existing = null
  }
  const subscription = existing ?? (await manager.subscribe({ userVisibleOnly: true, applicationServerKey: key }))
  try {
    await phoneApi(
      "/api/notify/subscribe",
      session,
      { method: "POST", body: { subscription: subscription.toJSON() } },
      deps.fetcher,
    )
  } catch (cause) {
    if (!existing) await subscription.unsubscribe().catch(() => false)
    throw cause
  }
}

/** Stops alerts on this phone: the browser's subscription first, so nothing more arrives, then the server's copy. */
export async function turnOffAlerts(session: PhoneSession, deps: PushDeps) {
  const subscription = await (await deps.pushManager())?.getSubscription().catch(() => null)
  if (!subscription) return
  const endpoint = subscription.endpoint
  await subscription.unsubscribe().catch(() => false)
  // The push service also answers 410 for it from now on, which deletes it on the next send.
  await phoneApi("/api/notify/subscribe", session, { method: "DELETE", body: { endpoint } }, deps.fetcher).catch(
    () => undefined,
  )
}

/** Plain words for a failure to turn alerts on. */
export function alertsErrorText(error: unknown) {
  if (!(error instanceof PhoneApiError)) return "Alerts could not be turned on. Try again."
  if (error.status === 401) return "Your sign-in expired. Sign in again."
  if (error.status === 402 || (error.status === 403 && error.code !== "ORIGIN_NOT_ALLOWED"))
    return "Phone alerts come with an active Vector Codium plan."
  if (error.status === 429) return "Too many tries. Wait a little and try again."
  if (error.code === "PUSH_UNAVAILABLE" || error.status === 503) return "Phone alerts are temporarily unavailable."
  return error.message
}

function sameKey(current: ArrayBuffer | null | undefined, key: Uint8Array) {
  if (!current) return true
  const bytes = new Uint8Array(current)
  return bytes.length === key.length && bytes.every((byte, index) => byte === key[index])
}
