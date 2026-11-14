import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { ApiError } from "../http.js"

/*
 * Sealing for what the server keeps encrypted at rest (contract 3.2 step 10, 3.13, E5): platform tokens, reply
 * references and the short-lived job body. AES-256-GCM under VECTOR_EVERYWHERE_DATA_KEY.
 *
 * A sealed value is `ves1.<key id>.<iv>.<ciphertext and tag>`, all base64url. The key id is derived from the key, so
 * a value sealed under another key is told apart from a tampered one, and a later rotation needs only a second key in
 * the ring. Every value is bound to a context (normally its store key), passed as associated data, so a sealed token
 * copied into another record does not open there.
 */

export const SEAL_VERSION = "ves1"
/** A data key is exactly 32 bytes (AES-256). */
export const DATA_KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_ID_CHARS = 12
/** The largest value sealed or opened: far above a job body (about 40,000 characters) or a token. */
const MAX_PLAINTEXT_BYTES = 1024 * 1024
const MAX_SEALED_CHARS = Math.ceil(((MAX_PLAINTEXT_BYTES + TAG_BYTES) * 4) / 3) + 64
const SEALED = /^ves1\.([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,})$/
const CONTEXT = /^[\x21-\x7e]{1,512}$/

export type DataKey = { readonly id: string; readonly key: Buffer }

/** The id of a data key: a short hash of it, never the key itself. */
export function dataKeyId(raw: Uint8Array) {
  return createHash("sha256")
    .update("vector-everywhere-data-key-id\0")
    .update(raw)
    .digest("base64url")
    .slice(0, KEY_ID_CHARS)
}

/** A data key from its 32 raw bytes. */
export function dataKey(raw: Uint8Array): DataKey {
  if (raw.length !== DATA_KEY_BYTES) throw new RangeError("A data key is 32 bytes.")
  const key = Buffer.from(raw)
  return Object.freeze({ id: dataKeyId(key), key })
}

function associated(keyId: string, context: string) {
  return Buffer.from(`vector-everywhere-seal-v1\0${keyId}\0${context}`, "utf8")
}

function checkContext(context: string) {
  // A context is a store key or a fixed name: printable ASCII with no spaces, so two contexts never read alike.
  if (typeof context !== "string" || !CONTEXT.test(context)) throw new RangeError("A seal context is a store key.")
}

function off() {
  return new ApiError(503, "EVERYWHERE_OFF", "Vector everywhere is not available right now.")
}

/** Seals `plaintext` under the ring's first key, bound to `context`. */
export function seal(keys: readonly DataKey[], plaintext: string, context: string): string {
  checkContext(context)
  const key = keys[0]
  if (!key) throw off()
  const bytes = Buffer.from(plaintext, "utf8")
  if (bytes.length > MAX_PLAINTEXT_BYTES) throw new RangeError("The value is too large to seal.")
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key.key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(associated(key.id, context))
  const body = Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()])
  return `${SEAL_VERSION}.${key.id}.${iv.toString("base64url")}.${body.toString("base64url")}`
}

export type Opened =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: "malformed" | "unknown-key" | "tampered" }

/** base64url that decodes and encodes back to the same text, so no two spellings open as one value. */
function strictBase64url(text: string): Buffer | undefined {
  const bytes = Buffer.from(text, "base64url")
  return bytes.toString("base64url") === text ? bytes : undefined
}

const UTF8 = new TextDecoder("utf-8", { fatal: true })

/**
 * Opens a sealed value bound to `context`. Anything changed (key id, iv, ciphertext, tag or context) fails as
 * `tampered`; a value sealed under a key the ring does not hold fails as `unknown-key`. Nothing about the value is
 * ever reported.
 */
export function open(keys: readonly DataKey[], sealed: unknown, context: string): Opened {
  checkContext(context)
  if (typeof sealed !== "string" || sealed.length > MAX_SEALED_CHARS) return { ok: false, reason: "malformed" }
  const match = SEALED.exec(sealed)
  if (!match) return { ok: false, reason: "malformed" }
  const [, keyId = "", ivText = "", bodyText = ""] = match
  const iv = strictBase64url(ivText)
  const body = strictBase64url(bodyText)
  if (!iv || iv.length !== IV_BYTES || !body || body.length < TAG_BYTES) return { ok: false, reason: "malformed" }
  const key = keys.find((candidate) => candidate.id === keyId)
  if (!key) return { ok: false, reason: "unknown-key" }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.key, iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(associated(key.id, context))
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES))
    const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()])
    return { ok: true, value: UTF8.decode(plain) }
  } catch {
    return { ok: false, reason: "tampered" }
  }
}

/** Seals a JSON value. */
export function sealJson(keys: readonly DataKey[], value: unknown, context: string): string {
  const text = JSON.stringify(value)
  if (typeof text !== "string") throw new TypeError("Only JSON values can be sealed.")
  return seal(keys, text, context)
}

/** Opens a sealed JSON value and passes it through `decode`, which answers undefined for a shape it refuses. */
export function openJson<T>(
  keys: readonly DataKey[],
  sealed: unknown,
  context: string,
  decode: (value: unknown) => T | undefined,
): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: "malformed" | "unknown-key" | "tampered" } {
  const opened = open(keys, sealed, context)
  if (!opened.ok) return opened
  let parsed: unknown
  try {
    parsed = JSON.parse(opened.value)
  } catch {
    return { ok: false, reason: "malformed" }
  }
  const value = decode(parsed)
  return value === undefined ? { ok: false, reason: "malformed" } : { ok: true, value }
}
