import {
  PUSH_SUBSCRIPTION_ID_LENGTH,
  pushSubscriptionFingerprintInput,
  type PushSubscriptionCheck,
  type PushSubscriptionIdentity,
} from "@vectordevai/schema/push-subscription"
import { createResource, onCleanup, onMount } from "solid-js"
import { phoneApi, PhoneApiError } from "./api"
import { base64url, fromBase64url, type PhoneSession } from "./auth"
import { PHONE_PUSH_CHANGED, PHONE_SW_SCOPE } from "./config"

// Turning phone alerts on and off (WP A38), against A37's `/api/notify/subscribe`. The browser makes a push
// subscription for the server's VAPID key; the server stores it for the signed-in account only while the plan allows
// phone alerts (S1), and deletes it when asked whatever the plan. Alerts carry titles only, or arrive encrypted end
// to end from the desktop (P7); the service worker (sw.ts) shows them.

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type SubscriptionLike = {
  endpoint: string
  expirationTime?: number | null
  options?: { applicationServerKey?: ArrayBuffer | null }
  toJSON(): PushSubscriptionJSON
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

export type AlertsState = "on" | "off" | "denied" | "unknown"

/** The foreground routes recheck after browser changes and on return, including browsers without the worker event. */
export function useAlertsState(session: () => PhoneSession, enabled: () => boolean) {
  const deps: PushDeps = {
    fetcher: (input, init) => fetch(input, init),
    pushManager: async () => {
      const registration = await navigator.serviceWorker?.getRegistration(PHONE_SW_SCOPE).catch(() => undefined)
      return registration?.pushManager as unknown as PushManagerLike | undefined
    },
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
  }
  const [state, { refetch }] = createResource(
    () => enabled() && session(),
    (current) => alertsState(deps, current),
  )
  onMount(() => {
    const worker = navigator.serviceWorker
    const refresh = () => {
      if (enabled()) void refetch()
    }
    const visible = () => {
      if (document.visibilityState === "visible") refresh()
    }
    const changed = (event: MessageEvent) => {
      if (event.data === PHONE_PUSH_CHANGED && event.source && event.source === worker?.controller) refresh()
    }
    worker?.addEventListener("message", changed)
    worker?.addEventListener("controllerchange", refresh)
    document.addEventListener("visibilitychange", visible)
    onCleanup(() => {
      worker?.removeEventListener("message", changed)
      worker?.removeEventListener("controllerchange", refresh)
      document.removeEventListener("visibilitychange", visible)
    })
  })
  return { deps, state, refetch }
}

/** Whether the signed-in account has the browser's current subscription registered. */
export async function alertsState(deps: PushDeps, session: PhoneSession): Promise<AlertsState> {
  const permission = deps.permission()
  if (permission === "denied") return "denied"
  if (permission !== "granted") return "off"
  try {
    const manager = await deps.pushManager()
    const subscription = await manager?.getSubscription()
    if (!manager || !subscription || expired(subscription)) return "off"
    const identity = subscriptionIdentity(subscription)
    if (!identity) return "unknown"
    const snapshot = pushSubscriptionFingerprintInput(identity)
    const check = await subscriptionCheck(identity.endpoint, snapshot)
    const answer = await phoneApi("/api/notify/subscribe", session, { method: "POST", body: { check } }, deps.fetcher)
    const current = await manager.getSubscription()
    const permission = deps.permission()
    if (permission === "denied") return "denied"
    if (permission !== "granted" || !current || expired(current)) return "off"
    const latest = subscriptionIdentity(current)
    if (!latest || pushSubscriptionFingerprintInput(latest) !== snapshot) return "off"
    return answer.subscribed === true ? "on" : answer.subscribed === false ? "off" : "unknown"
  } catch {
    return deps.permission() === "denied" ? "denied" : "unknown"
  }
}

function subscriptionIdentity(subscription: SubscriptionLike): PushSubscriptionIdentity | undefined {
  const { endpoint } = subscription
  const { keys } = subscription.toJSON()
  if (!endpoint || !keys?.p256dh || !keys.auth) return undefined
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth }
}

async function subscriptionCheck(endpoint: string, snapshot: string): Promise<PushSubscriptionCheck> {
  const encoder = new TextEncoder()
  const [endpointHash, fingerprint] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(endpoint)),
    crypto.subtle.digest("SHA-256", encoder.encode(snapshot)),
  ])
  return {
    id: base64url(new Uint8Array(endpointHash)).slice(0, PUSH_SUBSCRIPTION_ID_LENGTH),
    fingerprint: Array.from(new Uint8Array(fingerprint), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  }
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
  // Expired subscriptions and subscriptions for an older server key need a replacement.
  if (existing && (expired(existing) || !sameKey(existing.options?.applicationServerKey, key))) {
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

function expired(subscription: SubscriptionLike) {
  return typeof subscription.expirationTime === "number" && subscription.expirationTime <= Date.now()
}
