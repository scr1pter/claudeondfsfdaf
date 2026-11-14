import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

/*
 * Constant-time helpers for signed requests (contract 3.2 step 2): HMAC-SHA256 over raw bytes, comparisons that take
 * the same time whatever the inputs, and timestamp windows. The platform formats (Slack's `v0=` over
 * `v0:<timestamp>:<body>`, Linear's hex HMAC of the body) are built from these in each platform's verify.ts.
 *
 * Signatures are always computed over the raw body bytes, never over a decoded or re-serialised body.
 */

export type Bytes = string | Uint8Array

/** No signing secret shorter than this is ever used: an empty or short secret would let anyone sign. */
export const MIN_SECRET_CHARS = 16

/** A key that lives only in this process, so comparing two values leaks neither their bytes nor their lengths. */
const COMPARE_KEY = randomBytes(32)

export function hmacSha256(secret: Bytes, ...parts: readonly Bytes[]): Buffer {
  const mac = createHmac("sha256", secret)
  for (const part of parts) mac.update(part)
  return mac.digest()
}

export function hmacSha256Hex(secret: Bytes, ...parts: readonly Bytes[]): string {
  return hmacSha256(secret, ...parts).toString("hex")
}

export function sha256Hex(...parts: readonly Bytes[]): string {
  const hash = createHash("sha256")
  for (const part of parts) hash.update(part)
  return hash.digest("hex")
}

/**
 * Whether two values are equal, in time that depends on neither. Both sides are first keyed-hashed to 32 bytes, so
 * values of different lengths are compared in the same time as equal ones.
 */
export function constantTimeEqual(left: Bytes, right: Bytes): boolean {
  const a = createHmac("sha256", COMPARE_KEY).update(left).digest()
  const b = createHmac("sha256", COMPARE_KEY).update(right).digest()
  return timingSafeEqual(a, b)
}

/** Whether a secret is long enough to sign with. */
export function secretUsable(secret: unknown): secret is string {
  return typeof secret === "string" && secret.length >= MIN_SECRET_CHARS && !/[\s\x00-\x1f\x7f]/.test(secret)
}

const HEX_SHA256 = /^[0-9a-f]{64}$/

/**
 * Whether `signature` is the lowercase hex HMAC-SHA256 of `message` under `secret`, after an optional fixed prefix
 * (Slack's `v0=`). A missing, malformed or wrong-length signature, or a secret too short to sign with, is never valid.
 */
export function hexSignatureValid(input: {
  readonly secret: string | undefined
  readonly message: Bytes | readonly Bytes[]
  readonly signature: string | null | undefined
  readonly prefix?: string
}): boolean {
  if (!secretUsable(input.secret)) return false
  if (typeof input.signature !== "string") return false
  const prefix = input.prefix ?? ""
  if (!input.signature.startsWith(prefix)) return false
  const hex = input.signature.slice(prefix.length)
  if (!HEX_SHA256.test(hex)) return false
  const parts = typeof input.message === "string" || input.message instanceof Uint8Array ? [input.message] : input.message
  return constantTimeEqual(hmacSha256Hex(input.secret, ...(parts as readonly Bytes[])), hex)
}

/**
 * Whether a platform timestamp is within `windowMs` of `now`, in either direction. `unit` says whether the platform
 * sends seconds (Slack) or milliseconds (Linear). Only plain decimal digits or a safe integer are read.
 */
export function timestampFresh(value: unknown, unit: "s" | "ms", now: number, windowMs: number): boolean {
  let parsed: number
  if (typeof value === "number") parsed = value
  else if (typeof value === "string" && /^[0-9]{1,16}$/.test(value)) parsed = Number(value)
  else return false
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return false
  const ms = unit === "s" ? parsed * 1000 : parsed
  if (!Number.isSafeInteger(ms)) return false
  return Math.abs(now - ms) <= windowMs
}

/** Whether an `authorization` header is exactly `Bearer <secret>` (the sweep's CRON_SECRET check). */
export function bearerMatches(header: string | null | undefined, secret: string | undefined): boolean {
  if (!secretUsable(secret) || typeof header !== "string") return false
  return constantTimeEqual(header, `Bearer ${secret}`)
}
