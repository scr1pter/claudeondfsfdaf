// The internal API's signature (WP A37's scheme, api/_lib/hosted-internal.ts), on WebCrypto. The API signs with
// VECTOR_HOSTED_INTERNAL_SECRET for the service "relay"; the Worker holds the same secret as INTERNAL_SECRET.
//
// Three headers: x-vector-internal-timestamp (whole seconds), x-vector-internal-nonce (22-64 base64url characters) and
// x-vector-internal-signature (base64url HMAC-SHA256). The signed string is these lines joined by "\n":
//
//   vector-internal-v1
//   relay
//   <METHOD>
//   <path and query exactly as sent>
//   <timestamp>
//   <nonce>
//   <lower-case hex SHA-256 of the body>
//
// keyed by HMAC-SHA256(secret, "vector-internal-v1/relay"). A timestamp more than 300 s from the relay's clock is
// refused. Each nonce is accepted once within 600 s; the Durable Object that handles the request remembers it.

import { base64url, equalBytes, fromBase64url, hex, utf8 } from "./bytes"

export const INTERNAL_SERVICE = "relay"
export const INTERNAL_SKEW_MS = 300_000
export const INTERNAL_NONCE_KEEP_MS = 2 * INTERNAL_SKEW_MS
export const INTERNAL_HEADERS = Object.freeze({
  timestamp: "x-vector-internal-timestamp",
  nonce: "x-vector-internal-nonce",
  signature: "x-vector-internal-signature",
})
const VERSION = "vector-internal-v1"
const NONCE = /^[A-Za-z0-9_-]{22,64}$/
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/

/** The configured secret, or undefined when it is missing or shorter than 32 characters (as on the API side). */
export function internalSecret(setting: string | undefined) {
  const value = setting?.trim()
  return value && value.length >= 32 ? value : undefined
}

export async function sha256Hex(body: Uint8Array<ArrayBuffer>) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", body)))
}

/** The string a signature covers. */
export function internalCanonical(input: {
  service: string
  method: string
  path: string
  timestamp: number
  nonce: string
  bodyHash: string
}) {
  return [
    VERSION,
    input.service,
    input.method.toUpperCase(),
    input.path,
    String(input.timestamp),
    input.nonce,
    input.bodyHash,
  ].join("\n")
}

async function signature(secret: string, service: string, canonical: string) {
  const root = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", root, utf8(`${VERSION}/${service}`)))
  const key = await crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(canonical)))
}

/** The three headers for one request (the API's side; also the tests' and the smoke test's). */
export async function signInternal(
  secret: string,
  input: {
    method: string
    path: string
    body?: Uint8Array<ArrayBuffer> | string
    now: number
    nonce?: string
    service?: string
  },
): Promise<Record<string, string>> {
  const body = typeof input.body === "string" ? utf8(input.body) : (input.body ?? new Uint8Array(0))
  const timestamp = Math.floor(input.now / 1000)
  const nonce = input.nonce ?? base64url(crypto.getRandomValues(new Uint8Array(16)))
  const canonical = internalCanonical({
    service: input.service ?? INTERNAL_SERVICE,
    method: input.method,
    path: input.path,
    timestamp,
    nonce,
    bodyHash: await sha256Hex(body),
  })
  return {
    [INTERNAL_HEADERS.timestamp]: String(timestamp),
    [INTERNAL_HEADERS.nonce]: nonce,
    [INTERNAL_HEADERS.signature]: base64url(await signature(secret, input.service ?? INTERNAL_SERVICE, canonical)),
  }
}

/**
 * Checks the timestamp and the signature over the method, path, timestamp, nonce and raw body. The nonce is returned
 * for the Durable Object to record; it is checked last, so a forged request cannot use up a real nonce.
 */
export async function verifyInternalSignature(
  secret: string,
  request: { method: string; path: string; headers: Headers; body: Uint8Array<ArrayBuffer> },
  now: number,
): Promise<{ ok: true; nonce: string } | { ok: false }> {
  const timestampText = request.headers.get(INTERNAL_HEADERS.timestamp)?.trim() ?? ""
  const nonce = request.headers.get(INTERNAL_HEADERS.nonce)?.trim() ?? ""
  const provided = request.headers.get(INTERNAL_HEADERS.signature)?.trim() ?? ""
  if (!/^\d{1,12}$/.test(timestampText) || !NONCE.test(nonce) || !SIGNATURE.test(provided)) return { ok: false }
  const timestamp = Number(timestampText)
  if (Math.abs(now - timestamp * 1000) > INTERNAL_SKEW_MS) return { ok: false }
  if (!request.path.startsWith("/")) return { ok: false }
  const expected = await signature(
    secret,
    INTERNAL_SERVICE,
    internalCanonical({
      service: INTERNAL_SERVICE,
      method: request.method,
      path: request.path,
      timestamp,
      nonce,
      bodyHash: await sha256Hex(request.body),
    }),
  )
  const given = fromBase64url(provided)
  if (!given || !equalBytes(expected, given)) return { ok: false }
  return { ok: true, nonce }
}
