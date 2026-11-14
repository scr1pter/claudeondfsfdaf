// The internal API's signature (WP A37's scheme, api/_lib/hosted-internal.ts), on WebCrypto, in both directions: the
// API signs its calls to the Worker, and the Worker signs its reports to the API, each with the `ops` service key. The
// API holds the secret as VECTOR_OPS_SHARED_SECRET; the Worker holds the same value as INTERNAL_SECRET.
//
// Three headers: x-vector-internal-timestamp (whole seconds), x-vector-internal-nonce (22-64 base64url characters) and
// x-vector-internal-signature (base64url HMAC-SHA256). The signed string is these lines joined by "\n":
//
//   vector-internal-v1
//   ops
//   <METHOD>
//   <path and query exactly as sent>
//   <timestamp>
//   <nonce>
//   <lower-case hex SHA-256 of the body>
//
// keyed by HMAC-SHA256(secret, "vector-internal-v1/ops"). A timestamp more than 300 s from the Worker's clock is
// refused. Each nonce is accepted once within 600 s; the Durable Object that handles the request remembers it.

import { base64url, equalBytes, fromBase64url, hex, utf8 } from "./bytes"
import { OPS_LIMITS } from "./limits"
import { OPS_CALLBACK_PATH } from "./protocol"
import type { Fetcher } from "./runtime"

export const INTERNAL_SERVICE = "ops"
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
const ACCOUNT_CONTEXT = "vector-ops-account-v1\n"
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

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

/** The three headers for one request: the Worker's reports, and the API's calls in the tests. */
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
 * Checks the timestamp and the signature over the method, path, timestamp, nonce and raw body. The nonce and the signed
 * time are returned for the Durable Object: it records the nonce (checked last, so a forged request cannot use up a
 * real one) and compares the signed time with an erasure.
 */
export async function verifyInternalSignature(
  secret: string,
  request: { method: string; path: string; headers: Headers; body: Uint8Array<ArrayBuffer> },
  now: number,
): Promise<{ ok: true; nonce: string; signedAt: number } | { ok: false }> {
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
  return { ok: true, nonce, signedAt: timestamp * 1000 }
}

/**
 * The name of an account's Durable Object: HMAC-SHA256(ACCOUNT_KEY, context + account) in hex, so object names never
 * carry the account id. Undefined while ACCOUNT_KEY is missing or shorter than 32 characters.
 */
export async function accountHandle(accountKey: string | undefined, account: string): Promise<string | undefined> {
  const secret = accountKey?.trim()
  if (!secret || secret.length < 32) return undefined
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(ACCOUNT_CONTEXT + account))))
}

/**
 * The API's origin from API_ORIGIN: https with no credentials, path, query or fragment. Plain http only to this machine
 * (the CI smoke test's stand-in API); a Worker on Cloudflare cannot reach that anyway.
 */
export function callbackOrigin(setting: string | undefined): string | undefined {
  const value = setting?.trim()
  if (!value) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) return undefined
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
    return undefined
  return url.origin
}

/**
 * Sends one signed report to the API. True only for a 2xx answer; a redirect, an error status, a timeout or a network
 * failure is false, and the caller keeps the events for a later try.
 */
export async function sendReport(
  fetcher: Fetcher,
  input: { origin: string; secret: string; body: string; now: number; timeoutMs?: number },
): Promise<boolean> {
  try {
    const headers = await signInternal(input.secret, {
      method: "POST",
      path: OPS_CALLBACK_PATH,
      body: input.body,
      now: input.now,
    })
    const response = await fetcher(`${input.origin}${OPS_CALLBACK_PATH}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: input.body,
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs ?? OPS_LIMITS.callbackTimeoutMs),
    })
    await discard(response)
    return response.status >= 200 && response.status < 300
  } catch {
    return false
  }
}

/** Lets go of an answer's body without reading it. */
export async function discard(response: Response) {
  try {
    await response.body?.cancel()
  } catch {
    // Already read or closed.
  }
}
