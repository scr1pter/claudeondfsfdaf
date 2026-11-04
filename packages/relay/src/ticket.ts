// Relay tickets (WP A39). The API (A40, api/_lib/remote-ticket.ts) mints one per connection for a signed-in computer or
// phone whose plan includes Remote; the relay checks it with WebCrypto Ed25519 and needs nothing else to admit the
// connection. Pure web platform code, so the API can import it as `@vectordevai/relay/ticket` to sign.
//
//   ticket    = "vt1." payload "." signature
//   payload   = base64url (unpadded) of the UTF-8 JSON claims below
//   signature = base64url of Ed25519 over the ASCII bytes "vector-relay-ticket-v1." payload
//
// Every character is a WebSocket subprotocol token character, so the ticket travels in `Sec-WebSocket-Protocol` and
// never in a URL. Claims (all required unless marked):
//
//   v            1
//   aud          "vector-relay"
//   sub          the account id (1-128 printable ASCII characters). The relay keeps only HMAC(ACCOUNT_KEY, sub).
//   role         "computer" | "phone"
//   dev          the device id: 16 random bytes the device made, base64url (22 characters)
//   name?        the name shown in Settings, 1-64 characters with no control characters
//   key?         the device's public key for pairing, base64url, 32-128 characters (the relay stores and lists it)
//   computers    the plan's paired-computer count (ENTITLEMENTS remote.computers), 0-5
//   viewerHours  the plan's viewer-hours this period (REMOTE_LIMITS.viewerHours), 1-1000
//   epoch        a hash of the snapshot's meterEpoch, 16-64 base64url characters; the relay's time meters are per epoch
//   periodEnd    the period's end, milliseconds; meters of the epoch are kept 40 days past it
//   iat, exp     seconds; exp after iat, at most 300 s apart, and iat no more than 60 s ahead of the relay's clock
//   jti          16-64 base64url characters, new for every ticket; the relay accepts each one once
//
// The API signs with VECTOR_REMOTE_TICKET_SIGNING_KEY (the Ed25519 private key, base64url PKCS#8); the Worker holds the
// matching raw public key, base64url (43 characters), in TICKET_PUBLIC_KEYS, comma-separated so a new key can be added
// before the old one is retired.

import { base64url, fromBase64url, fromUtf8, hex, utf8 } from "./bytes"
import { RELAY_LIMITS } from "./limits"
import { isDeviceId, type DeviceRole } from "./protocol"

export const TICKET_PREFIX = "vt1"
export const TICKET_AUDIENCE = "vector-relay"
const SIGNING_CONTEXT = "vector-relay-ticket-v1."
const ACCOUNT_CONTEXT = "vector-relay-account-v1\n"
const MAX_TICKET_LENGTH = 4096
const MAX_KEYS = 4

export type TicketClaims = {
  v: 1
  aud: typeof TICKET_AUDIENCE
  sub: string
  role: DeviceRole
  dev: string
  name?: string
  key?: string
  computers: number
  viewerHours: number
  epoch: string
  periodEnd: number
  iat: number
  exp: number
  jti: string
}

export type TicketFailure = "malformed" | "signature" | "claims" | "expired" | "not-yet-valid" | "lifetime"
export type TicketCheck = { ok: true; claims: TicketClaims } | { ok: false; reason: TicketFailure }

const ACCOUNT = /^[\x21-\x7e]{1,128}$/
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/
const PUBLIC_KEY = /^[A-Za-z0-9_-]{32,128}$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/** Checks the claims' shape and ranges (not the times). */
export function decodeClaims(value: unknown): TicketClaims | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const claims = value as Record<string, unknown>
  const integer = (input: unknown, min: number, max: number) =>
    typeof input === "number" && Number.isSafeInteger(input) && input >= min && input <= max
  if (claims.v !== 1 || claims.aud !== TICKET_AUDIENCE) return undefined
  if (typeof claims.sub !== "string" || !ACCOUNT.test(claims.sub)) return undefined
  if (claims.role !== "computer" && claims.role !== "phone") return undefined
  if (!isDeviceId(claims.dev)) return undefined
  if (
    claims.name !== undefined &&
    (typeof claims.name !== "string" || !claims.name.length || claims.name.length > 64 || CONTROL.test(claims.name))
  )
    return undefined
  if (claims.key !== undefined && (typeof claims.key !== "string" || !PUBLIC_KEY.test(claims.key))) return undefined
  if (!integer(claims.computers, 0, RELAY_LIMITS.maxComputers)) return undefined
  if (!integer(claims.viewerHours, 1, RELAY_LIMITS.maxViewerHours)) return undefined
  if (typeof claims.epoch !== "string" || !TOKEN.test(claims.epoch)) return undefined
  if (!integer(claims.periodEnd, 1, Number.MAX_SAFE_INTEGER)) return undefined
  if (!integer(claims.iat, 1, 1e11) || !integer(claims.exp, 1, 1e11)) return undefined
  if (typeof claims.jti !== "string" || !TOKEN.test(claims.jti)) return undefined
  return {
    v: 1,
    aud: TICKET_AUDIENCE,
    sub: claims.sub,
    role: claims.role,
    dev: claims.dev,
    ...(claims.name !== undefined ? { name: claims.name as string } : {}),
    ...(claims.key !== undefined ? { key: claims.key as string } : {}),
    computers: claims.computers as number,
    viewerHours: claims.viewerHours as number,
    epoch: claims.epoch,
    periodEnd: claims.periodEnd as number,
    iat: claims.iat as number,
    exp: claims.exp as number,
    jti: claims.jti,
  }
}

const keyCache = new Map<string, Promise<CryptoKey[]>>()

/**
 * The verification keys from TICKET_PUBLIC_KEYS. A malformed entry makes the whole setting unusable (no keys), so a
 * typo turns the relay off instead of silently dropping the key that was meant.
 */
export function importTicketKeys(setting: string | undefined): Promise<CryptoKey[]> {
  const text = setting?.trim() ?? ""
  let cached = keyCache.get(text)
  if (!cached) {
    cached = (async () => {
      const entries = text
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
      if (!entries.length || entries.length > MAX_KEYS) return []
      const raw = entries.map((entry) => fromBase64url(entry))
      if (raw.some((bytes) => bytes?.byteLength !== 32)) return []
      try {
        return await Promise.all(
          raw.map((bytes) => crypto.subtle.importKey("raw", bytes!, { name: "Ed25519" }, false, ["verify"])),
        )
      } catch {
        return []
      }
    })()
    keyCache.set(text, cached)
  }
  return cached
}

/** Checks a ticket's form, signature, claims and times. `now` is milliseconds. */
export async function verifyTicket(ticket: string, keys: readonly CryptoKey[], now: number): Promise<TicketCheck> {
  if (typeof ticket !== "string" || ticket.length > MAX_TICKET_LENGTH) return { ok: false, reason: "malformed" }
  const parts = ticket.split(".")
  if (parts.length !== 3 || parts[0] !== TICKET_PREFIX) return { ok: false, reason: "malformed" }
  const [, payload, signatureText] = parts as [string, string, string]
  const signature = fromBase64url(signatureText)
  const body = fromBase64url(payload)
  if (!signature || signature.byteLength !== 64 || !body?.byteLength) return { ok: false, reason: "malformed" }
  if (!keys.length) return { ok: false, reason: "signature" }
  const signed = utf8(SIGNING_CONTEXT + payload)
  let valid = false
  for (const key of keys) {
    try {
      if (await crypto.subtle.verify("Ed25519", key, signature, signed)) {
        valid = true
        break
      }
    } catch {
      // A key the runtime cannot use verifies nothing.
    }
  }
  if (!valid) return { ok: false, reason: "signature" }
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(body) ?? "")
  } catch {
    return { ok: false, reason: "claims" }
  }
  const claims = decodeClaims(parsed)
  if (!claims) return { ok: false, reason: "claims" }
  if (claims.exp <= claims.iat || claims.exp - claims.iat > RELAY_LIMITS.ticketMaxSeconds)
    return { ok: false, reason: "lifetime" }
  const seconds = now / 1000
  if (claims.iat > seconds + RELAY_LIMITS.ticketSkewSeconds) return { ok: false, reason: "not-yet-valid" }
  if (claims.exp <= seconds) return { ok: false, reason: "expired" }
  return { ok: true, claims }
}

/** Signs claims with an Ed25519 private key (the API's side; also the tests'). The claims are checked first. */
export async function signTicket(claims: TicketClaims, privateKey: CryptoKey): Promise<string> {
  if (!decodeClaims(claims)) throw new Error("These ticket claims are not valid.")
  const payload = base64url(utf8(JSON.stringify(claims)))
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, utf8(SIGNING_CONTEXT + payload)))
  return `${TICKET_PREFIX}.${payload}.${base64url(signature)}`
}

/**
 * The name of an account's Durable Object: hex HMAC-SHA256(ACCOUNT_KEY, "vector-relay-account-v1\n" + account). The
 * relay never stores the account id itself. Undefined when the key is missing or shorter than 32 characters.
 */
export async function accountHandle(accountKey: string | undefined, account: string): Promise<string | undefined> {
  const secret = accountKey?.trim()
  if (!secret || secret.length < 32) return undefined
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(ACCOUNT_CONTEXT + account))))
}
