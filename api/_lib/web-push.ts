import { createCipheriv, createECDH, createHash, hkdfSync, randomBytes } from "node:crypto"
import { importJWK, SignJWT } from "jose"
import type { EntitlementSnapshot } from "../../packages/schema/src/codium-entitlements.js"
import { readEntitlement, requireUsableSnapshot } from "./codium-entitlements.js"
import { codiumKey, codiumKeyIn } from "./codium-keys.js"
import { readSwitch } from "./codium-switches.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"
import { safeFetch, SafeFetchError, type SafeFetchOptions } from "./safe-fetch.js"

/*
 * Phone alerts over Web Push (WP A37). A phone's browser gives Vector a push subscription (an endpoint at its maker's
 * push service and two keys); Vector stores up to ten per account and sends each alert to every one of them.
 *
 * - Messages are encrypted for each subscription as RFC 8291 says (aes128gcm, RFC 8188), with `node:crypto`, and
 *   signed with the server's VAPID key (RFC 8292) through `jose`, so only the phone can read a message and the push
 *   service knows which server sent it.
 * - What a message holds (P7): an alert the server writes carries a title only, never a prompt, code, output or
 *   usage figure; an alert the desktop writes reaches the server already encrypted end to end, and the server only
 *   relays that ciphertext.
 * - A plan gate (§4.4 "Phone alerts"): an account sends and subscribes while its plan is active or renewing. The
 *   runtime `push` switch stops both. Nothing a client says grants either (S1).
 * - Push services answer 404 or 410 for a subscription that is gone; it is deleted then.
 * - Endpoints must belong to a known push service, and every request goes through safeFetch (S8).
 *
 * Settings: VECTOR_VAPID_PUBLIC_KEY (65-byte uncompressed P-256 point, base64url), VECTOR_VAPID_PRIVATE_KEY (its
 * 32-byte scalar, base64url), VECTOR_VAPID_SUBJECT (`mailto:` or `https:` contact for the push services).
 */

export const PUSH_LIMITS = Object.freeze({
  /** Subscriptions kept per account (§4.6 `notify:subs:<id>`); a new one past this replaces the oldest. */
  subscriptions: 10,
  /** The desktop's end-to-end ciphertext, as base64url text: at most 3 KB. */
  ciphertextChars: 3072,
  /** The shortest ciphertext accepted: a 12-byte nonce and a 16-byte tag around at least one byte. */
  ciphertextMinBytes: 29,
  /** Desktop sends an hour, per account. */
  sendsPerHour: 60,
  /** A server alert's title. */
  titleChars: 120,
  endpointChars: 1024,
})

/** How long a push service keeps a message for a phone that is offline (seconds). */
const PUSH_TTL_SECONDS = 12 * 60 * 60
/** A VAPID token's life. RFC 8292 allows at most 24 hours; push services refuse longer ones. */
const VAPID_TTL_SECONDS = 12 * 60 * 60
/** Subscriptions expire when the phone neither registers again nor receives an alert for this long. */
const SUBSCRIPTIONS_KEEP_MS = 400 * 86_400_000
const RECORD_SIZE = 4096
/** The largest plaintext one aes128gcm record of a push message holds: 4096 − 86-byte header − tag − delimiter. */
export const PUSH_PLAINTEXT_MAX = RECORD_SIZE - 86 - 16 - 1

// Push services of the browsers people use: Google (Chrome, Android, most Chromium browsers), Mozilla, Apple (Safari
// and Home Screen apps on iOS) and Microsoft (Edge on Windows).
const PUSH_HOSTS = new Set(["fcm.googleapis.com", "android.googleapis.com", "web.push.apple.com"])
const PUSH_HOST_SUFFIXES = [".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com"]

export type VapidConfiguration = {
  publicKey: string
  subject: string
  jwk: { kty: "EC"; crv: "P-256"; x: string; y: string; d: string }
}

/** The VAPID keys when all three settings are present and the private key matches the public one; else undefined. */
export function vapidConfiguration(): VapidConfiguration | undefined {
  const publicKey = process.env.VECTOR_VAPID_PUBLIC_KEY?.trim() ?? ""
  const privateKey = process.env.VECTOR_VAPID_PRIVATE_KEY?.trim() ?? ""
  const subject = process.env.VECTOR_VAPID_SUBJECT?.trim() ?? ""
  if (!publicKey || !privateKey || !subject || subject.length > 256) return undefined
  if (!/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject) && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(subject))
    return undefined
  const point = base64url(publicKey)
  const raw = base64url(privateKey)
  // Some key tools drop a private key's leading zero bytes; the scalar is 32 bytes once padded back.
  const scalar =
    raw && raw.length >= 16 && raw.length <= 32 ? Buffer.concat([Buffer.alloc(32 - raw.length), raw]) : undefined
  if (point?.length !== 65 || point[0] !== 4 || !scalar) return undefined
  try {
    const ecdh = createECDH("prime256v1")
    ecdh.setPrivateKey(scalar)
    if (!ecdh.getPublicKey().equals(point)) return undefined
  } catch {
    return undefined
  }
  return {
    publicKey,
    subject,
    jwk: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33).toString("base64url"),
      d: scalar.toString("base64url"),
    },
  }
}

/** Whether Web Push is configured on this server (the VAPID settings), for the perk listing and the provisioner. */
export function pushConfigured() {
  return vapidConfiguration() !== undefined
}

/** The `Authorization` header for one push endpoint: a VAPID token for the endpoint's origin, and the public key. */
export async function vapidAuthorization(endpoint: string, configuration: VapidConfiguration, now = Date.now()) {
  const token = await new SignJWT({ sub: configuration.subject })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setAudience(new URL(endpoint).origin)
    .setExpirationTime(Math.floor(now / 1000) + VAPID_TTL_SECONDS)
    .sign(await importJWK(configuration.jwk, "ES256"))
  return `vapid t=${token}, k=${configuration.publicKey}`
}

/**
 * Encrypts one push message for a subscription (RFC 8291, aes128gcm content coding from RFC 8188): a new P-256 key
 * pair and a random salt per message, one record of 4096 bytes. `fixed` replaces the random values, only so tests can
 * reproduce RFC 8291's example.
 */
export function encryptPushMessage(
  keys: { p256dh: string; auth: string },
  plaintext: Uint8Array,
  fixed?: { salt: Uint8Array; privateKey: Uint8Array },
) {
  if (plaintext.byteLength > PUSH_PLAINTEXT_MAX)
    throw new ApiError(413, "PUSH_PAYLOAD_TOO_LARGE", "That alert is too large to send.")
  const receiver = base64url(keys.p256dh)
  const secret = base64url(keys.auth)
  if (receiver?.length !== 65 || receiver[0] !== 4 || secret?.length !== 16)
    throw new ApiError(400, "PUSH_SUBSCRIPTION_INVALID", "That push subscription is not valid.")
  const ecdh = createECDH("prime256v1")
  if (fixed) ecdh.setPrivateKey(Buffer.from(fixed.privateKey))
  else ecdh.generateKeys()
  const sender = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(receiver)
  const salt = Buffer.from(fixed?.salt ?? randomBytes(16))
  const ikm = hkdf(shared, secret, Buffer.concat([Buffer.from("WebPush: info\0"), receiver, sender]), 32)
  const key = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16)
  const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12)
  const cipher = createCipheriv("aes-128-gcm", key, nonce)
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final()])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(sender.length, 20)
  return Buffer.concat([header, sender, sealed, cipher.getAuthTag()])
}

function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number) {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, length))
}

function base64url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined
  const bytes = Buffer.from(value, "base64url")
  return bytes.toString("base64url") === value ? bytes : undefined
}

// ── Subscriptions ────────────────────────────────────────────────────────────────────────────────────────────────────

export type PushSubscriptionInput = { endpoint: string; p256dh: string; auth: string; expiresAt?: number }
export type StoredPushSubscription = PushSubscriptionInput & { id: string; createdAt: number }

/** Whether an endpoint belongs to a known push service, on https and port 443. */
export function pushEndpointAllowed(endpoint: string) {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase()
  return (
    url.protocol === "https:" &&
    !url.port &&
    !url.username &&
    !url.password &&
    (PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)))
  )
}

/**
 * A browser's `PushSubscription.toJSON()` (`{endpoint, expirationTime?, keys: {p256dh, auth}}`), checked: a known push
 * service's https endpoint, a valid P-256 public key and a 16-byte secret. Throws 400 otherwise.
 */
export function parsePushSubscription(input: unknown, now = Date.now()): PushSubscriptionInput {
  const invalid = () => new ApiError(400, "PUSH_SUBSCRIPTION_INVALID", "That push subscription is not valid.")
  if (!isRecord(input) || !isRecord(input.keys)) throw invalid()
  const { endpoint, expirationTime } = input
  const { p256dh, auth } = input.keys
  if (typeof endpoint !== "string" || endpoint.length > PUSH_LIMITS.endpointChars) throw invalid()
  if (!pushEndpointAllowed(endpoint))
    throw new ApiError(400, "PUSH_ENDPOINT_NOT_ALLOWED", "Phone alerts work with your browser's own push service.")
  if (typeof p256dh !== "string" || typeof auth !== "string") throw invalid()
  const point = base64url(p256dh)
  if (point?.length !== 65 || point[0] !== 4 || base64url(auth)?.length !== 16) throw invalid()
  try {
    // Refuses a point that is not on the curve, which every later encryption would also refuse.
    const probe = createECDH("prime256v1")
    probe.generateKeys()
    probe.computeSecret(point)
  } catch {
    throw invalid()
  }
  if (expirationTime !== undefined && expirationTime !== null) {
    if (typeof expirationTime !== "number" || !Number.isSafeInteger(expirationTime) || expirationTime <= now)
      throw invalid()
    return { endpoint, p256dh, auth, expiresAt: expirationTime }
  }
  return { endpoint, p256dh, auth }
}

/** `notify:subs:<account>` (§4.6): a hash of subscription id → stored subscription. */
export const pushSubscriptionsKey = (account: string) => codiumKey("notify", "subs", account)
/** A subscription's id: the start of the SHA-256 of its endpoint, so the same browser registering again replaces it. */
export const pushSubscriptionId = (endpoint: string) =>
  createHash("sha256").update(endpoint).digest("base64url").slice(0, 22)

/** Stores a subscription for the account, replacing the oldest past ten. Answers the subscription's id. */
export async function savePushSubscription(
  account: string,
  subscription: PushSubscriptionInput,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const key = pushSubscriptionsKey(account)
  const id = pushSubscriptionId(subscription.endpoint)
  const record: StoredPushSubscription = { ...subscription, id, createdAt: now }
  await persistentStore(["HSET", key, id, JSON.stringify(record)], fetcher)
  const stored = await readSubscriptions(key, fetcher)
  const extra = stored
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(PUSH_LIMITS.subscriptions)
    .filter((entry) => entry.id !== id)
    .map((entry) => entry.id)
  if (extra.length) await persistentStore(["HDEL", key, ...extra], fetcher)
  await persistentStore(["PEXPIRE", key, SUBSCRIPTIONS_KEEP_MS], fetcher)
  return id
}

/** Removes the subscription with this endpoint. Answers whether there was one. */
export async function removePushSubscription(account: string, endpoint: string, fetcher: typeof fetch = fetch) {
  return (
    Number(await persistentStore(["HDEL", pushSubscriptionsKey(account), pushSubscriptionId(endpoint)], fetcher)) > 0
  )
}

/** The account's subscriptions, newest first, at most ten. Malformed entries are left out. */
export async function listPushSubscriptions(account: string, fetcher: typeof fetch = fetch) {
  return (await readSubscriptions(pushSubscriptionsKey(account), fetcher))
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, PUSH_LIMITS.subscriptions)
}

/**
 * Deletes every push subscription of the account, under the live and the test prefix (a production server writes
 * under `test` until a live Stripe key is configured). For account deletion (P5, WP A57) and the `push` provisioner.
 */
export async function eraseAccountPushSubscriptions(account: string, fetcher: typeof fetch = fetch) {
  return Number(
    await persistentStore(
      ["DEL", codiumKeyIn("live", "notify", "subs", account), codiumKeyIn("test", "notify", "subs", account)],
      fetcher,
    ),
  )
}

async function readSubscriptions(key: string, fetcher: typeof fetch) {
  const raw = await persistentStore(["HGETALL", key], fetcher)
  const entries: [string, string][] = Array.isArray(raw)
    ? raw.flatMap((value, index) =>
        index % 2 === 0 ? [[String(value), String(raw[index + 1])] as [string, string]] : [],
      )
    : isRecord(raw)
      ? Object.entries(raw).map(([field, value]) => [field, String(value)] as [string, string])
      : []
  return entries.flatMap(([id, value]) => {
    const record = decodeStored(value)
    return record && record.id === id ? [record] : []
  })
}

function decodeStored(value: string): StoredPushSubscription | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.id !== "string" ||
    typeof parsed.endpoint !== "string" ||
    typeof parsed.p256dh !== "string" ||
    typeof parsed.auth !== "string" ||
    typeof parsed.createdAt !== "number" ||
    (parsed.expiresAt !== undefined && typeof parsed.expiresAt !== "number") ||
    !pushEndpointAllowed(parsed.endpoint)
  )
    return undefined
  return {
    id: parsed.id,
    endpoint: parsed.endpoint,
    p256dh: parsed.p256dh,
    auth: parsed.auth,
    createdAt: parsed.createdAt,
    ...(typeof parsed.expiresAt === "number" ? { expiresAt: parsed.expiresAt } : {}),
  }
}

// ── Payloads ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** An alert the desktop encrypted end to end: the server relays the ciphertext and cannot read it. */
export type EncryptedAlert = { v: 1; kind: "e2e"; c: string; k?: string }
/** An alert the server writes: a title and an optional category, nothing else (P7). */
export type TitleAlert = { v: 1; kind: "title"; title: string; tag?: string }
export type PushPayload = EncryptedAlert | TitleAlert

/**
 * The body of `POST /api/notify/send`, checked: `ciphertext` (base64url, at most 3 KB of text), an optional `key` (which
 * of the phone's keys opens it) and an optional `urgency`. Any other field, a title or a message among them, is refused,
 * so plaintext never reaches the server through this route.
 */
export function parseEncryptedAlert(input: unknown): { payload: EncryptedAlert; urgency: "normal" | "high" } {
  const refused = () =>
    new ApiError(400, "PUSH_CIPHERTEXT_REQUIRED", "Alerts from the desktop must be encrypted end to end.")
  if (!isRecord(input) || Object.keys(input).some((field) => !["ciphertext", "key", "urgency"].includes(field)))
    throw refused()
  const { ciphertext, key, urgency } = input
  if (typeof ciphertext !== "string") throw refused()
  if (ciphertext.length > PUSH_LIMITS.ciphertextChars)
    throw new ApiError(413, "PUSH_CIPHERTEXT_TOO_LARGE", "That alert is too large to send.")
  if ((base64url(ciphertext)?.length ?? 0) < PUSH_LIMITS.ciphertextMinBytes) throw refused()
  if (key !== undefined && (typeof key !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(key))) throw refused()
  if (urgency !== undefined && urgency !== "normal" && urgency !== "high") throw refused()
  return {
    payload: { v: 1, kind: "e2e", c: ciphertext, ...(key ? { k: key } : {}) },
    urgency: urgency ?? "normal",
  }
}

/** A server alert's payload: the title (plain text, at most 120 characters) and an optional category tag. */
export function titleAlert(input: { title: string; tag?: string }): TitleAlert {
  const title = typeof input.title === "string" ? input.title.trim() : ""
  if (!title || title.length > PUSH_LIMITS.titleChars || /[\u0000-\u001f\u007f]/.test(title))
    throw new ApiError(500, "PUSH_TITLE_INVALID", "This alert's title is not valid.")
  if (input.tag !== undefined && (typeof input.tag !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(input.tag)))
    throw new ApiError(500, "PUSH_TITLE_INVALID", "This alert's tag is not valid.")
  return { v: 1, kind: "title", title, ...(input.tag ? { tag: input.tag } : {}) }
}

// ── Sending ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type PushDelivery = { sent: number; failed: number; removed: number }
export type PushSendOptions = {
  fetcher?: typeof fetch
  now?: number
  urgency?: "normal" | "high"
  /** The push services' network: safeFetch's resolver and connection, replaced in tests. */
  network?: SafeFetchOptions
}

/**
 * The account's snapshot when it may use phone alerts now: active, or renewing within its grace (§4.4). `allowPaused`
 * also lets a paused plan through, for On Call's alerts, which §4.4 keeps going through Stripe's retry window. Throws
 * the snapshot's own refusal otherwise (402, 403 or 503).
 */
export async function requirePushPlan(
  account: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  options: { allowPaused?: boolean } = {},
): Promise<EntitlementSnapshot> {
  const snapshot = await readEntitlement(account, fetcher, now)
  if (options.allowPaused && snapshot?.state === "paused" && snapshot.plan) return snapshot
  return requireUsableSnapshot(snapshot, now)
}

/** Refuses with 503 while push is not configured or the owner switched it off. */
export async function requirePushService(fetcher: typeof fetch = fetch, now = Date.now()) {
  const configuration = vapidConfiguration()
  if (!configuration || (await readSwitch("push", fetcher, { now })) !== "on")
    throw new ApiError(503, "PUSH_UNAVAILABLE", "Phone alerts are temporarily unavailable.")
  return configuration
}

/**
 * Sends one payload to every subscription of the account (at most ten, in parallel), each encrypted for that phone.
 * A 404 or 410 deletes the subscription; any other failure leaves it. It does not check the plan or the switch:
 * callers do (the send route, `sendServerAlert`).
 */
export async function deliverPush(
  account: string,
  payload: PushPayload,
  configuration: VapidConfiguration,
  options: PushSendOptions = {},
): Promise<PushDelivery> {
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? Date.now()
  const body = Buffer.from(JSON.stringify(payload))
  const subscriptions = await listPushSubscriptions(account, fetcher)
  const outcomes = await Promise.all(
    subscriptions.map(async (subscription): Promise<"sent" | "failed" | "gone"> => {
      if (subscription.expiresAt !== undefined && subscription.expiresAt <= now) return "gone"
      try {
        const answer = await safeFetch(
          subscription.endpoint,
          {
            method: "POST",
            headers: {
              authorization: await vapidAuthorization(subscription.endpoint, configuration, now),
              "content-encoding": "aes128gcm",
              "content-type": "application/octet-stream",
              ttl: String(PUSH_TTL_SECONDS),
              urgency: options.urgency ?? "normal",
            },
            body: encryptPushMessage(subscription, body),
          },
          { maxResponseBytes: 8 * 1024, ...options.network },
        )
        if (answer.status === 404 || answer.status === 410) return "gone"
        return answer.ok ? "sent" : "failed"
      } catch (error) {
        if (error instanceof SafeFetchError || error instanceof ApiError) return "failed"
        throw error
      }
    }),
  )
  const gone = subscriptions.filter((_, index) => outcomes[index] === "gone").map((entry) => entry.id)
  const key = pushSubscriptionsKey(account)
  if (gone.length) await persistentStore(["HDEL", key, ...gone], fetcher)
  const sent = outcomes.filter((outcome) => outcome === "sent").length
  if (sent) await persistentStore(["PEXPIRE", key, SUBSCRIPTIONS_KEEP_MS], fetcher)
  return { sent, failed: outcomes.filter((outcome) => outcome === "failed").length, removed: gone.length }
}

/**
 * An alert from Vector's own services (On Call, Ship Desk, usage and the like): a title only (P7). It goes out only
 * while push is configured and on and the plan allows phone alerts; otherwise nothing is sent and the reason is
 * answered, never thrown, so a service's own work is not stopped by an alert it could not send.
 */
export async function sendServerAlert(
  account: string,
  alert: { title: string; tag?: string },
  options: PushSendOptions & { allowPaused?: boolean } = {},
): Promise<PushDelivery | { skipped: "unavailable" | "plan" }> {
  const payload = titleAlert(alert)
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? Date.now()
  let configuration: VapidConfiguration
  try {
    configuration = await requirePushService(fetcher, now)
  } catch {
    return { skipped: "unavailable" }
  }
  try {
    await requirePushPlan(account, fetcher, now, { allowPaused: options.allowPaused })
  } catch (error) {
    if (error instanceof ApiError && error.code === "PERSISTENT_STORE_UNAVAILABLE") throw error
    return { skipped: "plan" }
  }
  return deliverPush(account, payload, configuration, options)
}

/** The phone app's origin (`VECTOR_PHONE_APP_ORIGIN`, https), or undefined when it is not set or not valid. */
export function phoneAppOrigin() {
  const value = process.env.VECTOR_PHONE_APP_ORIGIN?.trim()
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.origin === value.replace(/\/$/, "") ? url.origin : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
