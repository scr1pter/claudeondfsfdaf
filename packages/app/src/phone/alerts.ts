import { fromBase64url } from "./auth"
import { phonePath } from "./config"
import { PHONE_ROUTES, type PhoneRoute } from "./status"

// What a phone alert says (WP A38), read by the service worker from the push message A37's server sends (P7):
//
// - `{v:1, kind:"title", title, tag?}`: an alert the server wrote. A title of at most 120 characters on one line and
//   a lower-case category tag, nothing else.
// - `{v:1, kind:"e2e", c, k?}`: an alert the desktop encrypted end to end; the server only relayed `c`. The format both
//   sides use (A41's remote-notify.ts encrypts it): `c` is base64url of a 12-byte nonce followed by the AES-256-GCM
//   ciphertext and its 16-byte tag, sealed with the additional data `vector-alert-v1`, under the 32-byte alert key
//   this phone stored when it paired (alert-keys.ts), named by `k` ("default" when absent). The plaintext is JSON
//   `{v:1, title, route?}` with the same title rules.
//
// Anything else, or an alert this phone cannot open, still shows a notification without content: a page that
// receives a push and shows nothing loses its push permission on iOS and in Chrome.

export const ALERT_AAD = "vector-alert-v1"
export const DEFAULT_ALERT_KEY = "default"
const TITLE_MAX = 120

export type TitlePayload = { v: 1; kind: "title"; title: string; tag?: string }
export type EncryptedPayload = { v: 1; kind: "e2e"; c: string; k?: string }
export type PushPayload = TitlePayload | EncryptedPayload

export type PhoneAlert = { title: string; body?: string; tag: string; route?: PhoneRoute }

/** What shows when an alert cannot be read on this phone. */
export const UNREADABLE_ALERT: PhoneAlert = { title: "Vector", body: "Open Vector to see this alert.", tag: "vector" }

export function decodePushPayload(text: string | null | undefined): PushPayload | undefined {
  if (!text || text.length > 4_000) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const payload = value as Record<string, unknown>
  if (payload.v !== 1) return undefined
  if (payload.kind === "title") {
    const title = cleanTitle(payload.title)
    if (!title) return undefined
    if (payload.tag !== undefined && !isTag(payload.tag)) return undefined
    return { v: 1, kind: "title", title, ...(payload.tag ? { tag: payload.tag as string } : {}) }
  }
  if (payload.kind === "e2e") {
    if (typeof payload.c !== "string" || payload.c.length > 3_072) return undefined
    if (payload.k !== undefined && (typeof payload.k !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(payload.k)))
      return undefined
    return { v: 1, kind: "e2e", c: payload.c, ...(payload.k ? { k: payload.k as string } : {}) }
  }
  return undefined
}

/**
 * The alert a payload carries. A server alert is shown as its title; a desktop alert is opened with the alert key it
 * names, and shown as `UNREADABLE_ALERT` when that key is not on this phone or the ciphertext does not open.
 */
export async function openAlert(
  payload: PushPayload | undefined,
  readKey: (id: string) => Promise<CryptoKey | undefined>,
): Promise<PhoneAlert> {
  if (!payload) return UNREADABLE_ALERT
  if (payload.kind === "title") {
    const route = routeForTag(payload.tag)
    return { title: payload.title, tag: payload.tag ?? "vector", ...(route ? { route } : {}) }
  }
  const sealed = fromBase64url(payload.c)
  if (!sealed || sealed.length < 29) return UNREADABLE_ALERT
  const key = await readKey(payload.k ?? DEFAULT_ALERT_KEY).catch(() => undefined)
  if (!key) return UNREADABLE_ALERT
  const plain = await crypto.subtle
    .decrypt(
      { name: "AES-GCM", iv: sealed.slice(0, 12), additionalData: new TextEncoder().encode(ALERT_AAD), tagLength: 128 },
      key,
      sealed.slice(12),
    )
    .catch(() => undefined)
  if (!plain) return UNREADABLE_ALERT
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(plain))
  } catch {
    return UNREADABLE_ALERT
  }
  const alert = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const title = alert.v === 1 ? cleanTitle(alert.title) : undefined
  if (!title) return UNREADABLE_ALERT
  const route =
    typeof alert.route === "string" && (PHONE_ROUTES as readonly string[]).includes(alert.route)
      ? (alert.route as PhoneRoute)
      : undefined
  return { title, tag: route ?? "desktop", ...(route ? { route } : {}) }
}

/** The arguments for `showNotification`: the title, and where a tap opens. */
export function notificationFor(alert: PhoneAlert) {
  return {
    title: alert.title,
    options: {
      tag: alert.tag,
      icon: "/phone/icons/icon-192.png",
      badge: "/phone/icons/icon-192.png",
      data: { url: phonePath(alert.route) },
      ...(alert.body ? { body: alert.body } : {}),
    },
  }
}

/** Where a server alert's category opens in the phone app. */
export function routeForTag(tag: string | undefined): PhoneRoute | undefined {
  switch (tag) {
    case "on-call":
    case "release-guard":
    case "ship-desk":
      return "ops"
    case "computer":
    case "overnight":
      return "computer"
    case "approval":
      return "approvals"
    case "session":
      return "sessions"
    default:
      return undefined
  }
}

/** A notification's tap target, kept inside the phone app. */
export function clickTarget(data: unknown) {
  const url = data && typeof data === "object" ? (data as Record<string, unknown>).url : undefined
  return typeof url === "string" && /^\/phone\/[a-z-]*$/.test(url) ? url : phonePath()
}

function cleanTitle(value: unknown) {
  if (typeof value !== "string") return undefined
  const title = value.trim()
  return title && title.length <= TITLE_MAX && !/[\u0000-\u001f\u007f]/.test(title) ? title : undefined
}

function isTag(value: unknown) {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value)
}
