export * as WebAuthn from "./verify"

// WebAuthn checks that run on the relying party's side (WP A41: Vector Remote verifies a phone's passkey on the
// desktop, never on a server; contract §0, S6). Pure WebCrypto, so it runs the same under Node, Electron's main process,
// Bun and a browser.
//
// Two ceremonies:
//
// - `verifyRegistration` reads what `navigator.credentials.create()` returned while pairing: the client data
//   (type "webauthn.create", the expected challenge, the exact expected origin) and the attestation object's
//   authenticator data (the relying party id's hash, user presence and verification, the attested credential and its
//   COSE public key). The attestation statement itself is not checked: Vector asks for `attestation: "none"`, and trust
//   in the key comes from the pairing transcript the challenge is bound to, not from the authenticator's maker.
// - `verifyAssertion` reads what `navigator.credentials.get()` returned for one approval: the client data (type
//   "webauthn.get", the challenge, the exact origin, never cross-origin), the authenticator data (relying party id,
//   presence, verification, a signature counter that never goes back) and the signature over
//   `authenticatorData || SHA-256(clientDataJSON)` with the stored key.
//
// The origin is compared as an exact string with the one expected (for Remote, VECTOR_PHONE_APP_ORIGIN): no prefix,
// suffix, scheme or port is accepted in its place. Supported keys: ES256 (-7, P-256), EdDSA (-8, Ed25519) and RS256
// (-257). Every failure throws `WebAuthnError` with a code; nothing is logged.

/** COSE algorithm identifiers this verifier accepts. */
export const ES256 = -7
export const EDDSA = -8
export const RS256 = -257
export type Algorithm = typeof ES256 | typeof EDDSA | typeof RS256

export type PublicKeyJwk =
  | { kty: "EC"; crv: "P-256"; x: string; y: string }
  | { kty: "OKP"; crv: "Ed25519"; x: string }
  | { kty: "RSA"; n: string; e: string }

/** A registered credential, as the relying party stores it. Every field is JSON. */
export type Credential = {
  /** The credential id, base64url. */
  id: string
  algorithm: Algorithm
  publicKey: PublicKeyJwk
  /** The last signature counter seen; 0 for authenticators that do not count (most passkeys). */
  signCount: number
}

export type Expected = {
  /** The challenge the relying party issued for this ceremony. */
  challenge: Uint8Array
  /** The exact origin the ceremony must have run on, such as "https://remote.vectordev.ai". */
  origin: string
  /** The relying party id, the origin's host name unless the page chose a registrable suffix. */
  rpId: string
  /** Whether the authenticator must have verified the user (PIN or biometrics). Default true. */
  requireUserVerification?: boolean
}

export type Code =
  | "malformed"
  | "type"
  | "challenge"
  | "origin"
  | "cross-origin"
  | "rp-id"
  | "user-presence"
  | "user-verification"
  | "credential"
  | "algorithm"
  | "signature"
  | "counter"

export class WebAuthnError extends Error {
  constructor(
    readonly code: Code,
    message: string,
  ) {
    super(message)
    this.name = "WebAuthnError"
  }
}

const LIMITS = {
  clientData: 4_096,
  attestation: 16_384,
  authenticatorData: 4_096,
  signature: 1_024,
  credentialId: 1_023,
}
const FLAG = { UP: 0x01, UV: 0x04, AT: 0x40, ED: 0x80 } as const

/**
 * Checks a new credential from `navigator.credentials.create()` and returns what to store. `response` holds the raw
 * bytes of `clientDataJSON` and `attestationObject`.
 */
export async function verifyRegistration(
  response: { clientDataJSON: Uint8Array; attestationObject: Uint8Array },
  expected: Expected,
): Promise<Credential & { userVerified: boolean }> {
  if (response.attestationObject.byteLength > LIMITS.attestation) fail("malformed", "The attestation is too large.")
  checkClientData(response.clientDataJSON, "webauthn.create", expected)
  const attestation = decodeCbor(response.attestationObject)
  if (attestation.end !== response.attestationObject.byteLength) fail("malformed", "The attestation has extra bytes.")
  const object = attestation.value
  if (
    !(object instanceof Map) ||
    typeof object.get("fmt") !== "string" ||
    !(object.get("authData") instanceof Uint8Array)
  )
    fail("malformed", "The attestation is not an attestation object.")
  const authData = object.get("authData") as Uint8Array
  const parsed = await readAuthenticatorData(authData, expected)
  if (!(parsed.flags & FLAG.AT) || !parsed.attested) fail("credential", "The authenticator sent no credential.")
  return {
    id: base64url(parsed.attested.id),
    algorithm: parsed.attested.algorithm,
    publicKey: parsed.attested.publicKey,
    signCount: parsed.signCount,
    userVerified: Boolean(parsed.flags & FLAG.UV),
  }
}

/**
 * Checks one assertion from `navigator.credentials.get()` against a stored credential and returns the counter to store
 * next. `response.id` is the credential id the browser reported (base64url); it must be the stored one.
 */
export async function verifyAssertion(
  response: { id: string; clientDataJSON: Uint8Array; authenticatorData: Uint8Array; signature: Uint8Array },
  credential: Credential,
  expected: Expected,
): Promise<{ signCount: number; userVerified: boolean }> {
  if (response.id !== credential.id) fail("credential", "That passkey is not the one this phone paired with.")
  if (response.authenticatorData.byteLength > LIMITS.authenticatorData)
    fail("malformed", "The authenticator data is too large.")
  if (response.signature.byteLength === 0 || response.signature.byteLength > LIMITS.signature)
    fail("malformed", "The signature is not valid.")
  checkClientData(response.clientDataJSON, "webauthn.get", expected)
  const parsed = await readAuthenticatorData(response.authenticatorData, expected)
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", copy(response.clientDataJSON)))
  const signed = concat(response.authenticatorData, hash)
  const key = await importPublicKey(credential.algorithm, credential.publicKey)
  const ok = await verifySignature(credential.algorithm, key, response.signature, signed)
  if (!ok) fail("signature", "The passkey's signature does not match.")
  // A counter that does not go up means a cloned authenticator; both zero means the authenticator does not count.
  if ((parsed.signCount !== 0 || credential.signCount !== 0) && parsed.signCount <= credential.signCount)
    fail("counter", "The passkey's counter went back, so this approval is refused.")
  return { signCount: parsed.signCount, userVerified: Boolean(parsed.flags & FLAG.UV) }
}

/** The relying party id for an https origin (or http on localhost, for development): its host name. */
export function rpIdFor(origin: string): string {
  const url = new URL(origin)
  if (url.origin !== origin) throw new WebAuthnError("origin", "That is not an origin.")
  return url.hostname
}

function checkClientData(bytes: Uint8Array, type: "webauthn.create" | "webauthn.get", expected: Expected) {
  if (bytes.byteLength === 0 || bytes.byteLength > LIMITS.clientData) fail("malformed", "The client data is not valid.")
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    fail("malformed", "The client data is not JSON.")
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("malformed", "The client data is not an object.")
  const data = value as Record<string, unknown>
  if (data.type !== type) fail("type", `The client data is not for ${type}.`)
  if (typeof data.challenge !== "string" || !equalBytes(fromBase64url(data.challenge), expected.challenge))
    fail("challenge", "The challenge does not match.")
  if (typeof data.origin !== "string" || data.origin !== expected.origin)
    fail("origin", "The passkey was used on a different site.")
  if (data.crossOrigin === true || data.topOrigin !== undefined)
    fail("cross-origin", "The passkey was used inside another site's frame.")
}

async function readAuthenticatorData(bytes: Uint8Array, expected: Expected) {
  if (bytes.byteLength < 37) fail("malformed", "The authenticator data is too short.")
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected.rpId)))
  if (!equalBytes(bytes.subarray(0, 32), rpHash)) fail("rp-id", "The passkey belongs to a different site.")
  const flags = bytes[32]!
  if (!(flags & FLAG.UP)) fail("user-presence", "The authenticator did not confirm the user was present.")
  if ((expected.requireUserVerification ?? true) && !(flags & FLAG.UV))
    fail("user-verification", "The authenticator did not verify the user.")
  const signCount = new DataView(bytes.buffer, bytes.byteOffset + 33, 4).getUint32(0)
  let offset = 37
  let attested: { id: Uint8Array; algorithm: Algorithm; publicKey: PublicKeyJwk } | undefined
  if (flags & FLAG.AT) {
    if (bytes.byteLength < offset + 18) fail("malformed", "The attested credential is cut short.")
    offset += 16 // AAGUID
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!
    offset += 2
    if (length === 0 || length > LIMITS.credentialId || bytes.byteLength < offset + length)
      fail("malformed", "The credential id is not valid.")
    const id = bytes.slice(offset, offset + length)
    offset += length
    const cose = decodeCbor(bytes, offset)
    offset = cose.end
    attested = { id, ...(await coseKey(cose.value)) }
  }
  if (flags & FLAG.ED) offset = decodeCbor(bytes, offset).end
  if (offset !== bytes.byteLength) fail("malformed", "The authenticator data has extra bytes.")
  return { flags, signCount, attested }
}

async function coseKey(value: unknown): Promise<{ algorithm: Algorithm; publicKey: PublicKeyJwk }> {
  if (!(value instanceof Map)) fail("algorithm", "The credential's public key is not a COSE key.")
  const kty = value.get(1)
  const alg = value.get(3)
  if (alg === ES256 && kty === 2 && value.get(-1) === 1) {
    const x = value.get(-2)
    const y = value.get(-3)
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.byteLength !== 32 || y.byteLength !== 32)
      fail("algorithm", "The credential's P-256 key is not valid.")
    const publicKey: PublicKeyJwk = { kty: "EC", crv: "P-256", x: base64url(x), y: base64url(y) }
    await importPublicKey(ES256, publicKey)
    return { algorithm: ES256, publicKey }
  }
  if (alg === EDDSA && kty === 1 && value.get(-1) === 6) {
    const x = value.get(-2)
    if (!(x instanceof Uint8Array) || x.byteLength !== 32)
      fail("algorithm", "The credential's Ed25519 key is not valid.")
    const publicKey: PublicKeyJwk = { kty: "OKP", crv: "Ed25519", x: base64url(x) }
    await importPublicKey(EDDSA, publicKey)
    return { algorithm: EDDSA, publicKey }
  }
  if (alg === RS256 && kty === 3) {
    const n = value.get(-1)
    const e = value.get(-2)
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array) || n.byteLength < 256 || e.byteLength > 8)
      fail("algorithm", "The credential's RSA key is not valid.")
    const publicKey: PublicKeyJwk = { kty: "RSA", n: base64url(n), e: base64url(e) }
    await importPublicKey(RS256, publicKey)
    return { algorithm: RS256, publicKey }
  }
  fail("algorithm", "The credential uses a key type Vector does not accept.")
}

async function importPublicKey(algorithm: Algorithm, jwk: PublicKeyJwk) {
  const params =
    algorithm === ES256
      ? { name: "ECDSA", namedCurve: "P-256" }
      : algorithm === EDDSA
        ? { name: "Ed25519" }
        : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
  const expectedKty = algorithm === ES256 ? "EC" : algorithm === EDDSA ? "OKP" : "RSA"
  if (jwk.kty !== expectedKty) fail("algorithm", "The stored key does not match its algorithm.")
  try {
    return await crypto.subtle.importKey("jwk", { ...jwk, ext: true } as JsonWebKey, params, false, ["verify"])
  } catch {
    fail("algorithm", "The credential's public key cannot be used.")
  }
}

async function verifySignature(algorithm: Algorithm, key: CryptoKey, signature: Uint8Array, data: Uint8Array) {
  try {
    if (algorithm === ES256)
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(signature, 32), copy(data))
    if (algorithm === EDDSA) return await crypto.subtle.verify("Ed25519", key, copy(signature), copy(data))
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, copy(signature), copy(data))
  } catch (error) {
    if (error instanceof WebAuthnError) throw error
    return false
  }
}

/** An ASN.1 DER ECDSA signature (SEQUENCE of two INTEGERs) as the fixed-width r || s WebCrypto verifies. */
export function derToRaw(signature: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  const bad = () => fail("signature", "The passkey's signature is not DER.")
  if (signature[0] !== 0x30) bad()
  let offset = 2
  let length = signature[1]!
  if (length & 0x80) {
    if (length !== 0x81) bad()
    length = signature[2]!
    offset = 3
  }
  if (offset + length !== signature.byteLength) bad()
  const integer = () => {
    if (signature[offset] !== 0x02) bad()
    const size = signature[offset + 1]!
    const start = offset + 2
    if (size === 0 || size > 33 || start + size > signature.byteLength) bad()
    // A positive INTEGER has no leading zero unless the next byte's top bit is set.
    if (size > 1 && signature[start] === 0 && !(signature[start + 1]! & 0x80)) bad()
    if (signature[start]! & 0x80) bad()
    offset = start + size
    return signature.subarray(start, start + size)
  }
  const r = integer()
  const s = integer()
  if (offset !== signature.byteLength) bad()
  const raw = new Uint8Array(size * 2)
  const place = (value: Uint8Array, at: number) => {
    const trimmed = value[0] === 0 ? value.subarray(1) : value
    if (trimmed.byteLength > size) bad()
    raw.set(trimmed, at + size - trimmed.byteLength)
  }
  place(r, 0)
  place(s, size)
  return raw
}

/**
 * A CBOR decoder for what WebAuthn sends (RFC 8949 major types 0-5 and 7's simple values; tags are skipped): maps
 * become `Map`s with their original keys, byte strings `Uint8Array`s. Indefinite lengths and floats are refused.
 */
export function decodeCbor(bytes: Uint8Array, start = 0, depth = 0): { value: unknown; end: number } {
  if (depth > 16) fail("malformed", "The CBOR nests too deeply.")
  if (start >= bytes.byteLength) fail("malformed", "The CBOR is cut short.")
  const initial = bytes[start]!
  const major = initial >> 5
  const info = initial & 0x1f
  let offset = start + 1
  const argument = (): number => {
    if (info < 24) return info
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0
    if (!size) fail("malformed", "The CBOR uses a form Vector does not read.")
    if (offset + size > bytes.byteLength) fail("malformed", "The CBOR is cut short.")
    let value = 0
    for (let index = 0; index < size; index++) value = value * 256 + bytes[offset + index]!
    if (!Number.isSafeInteger(value)) fail("malformed", "The CBOR holds a number that is too large.")
    offset += size
    return value
  }
  if (major === 0) return { value: argument(), end: offset }
  if (major === 1) return { value: -1 - argument(), end: offset }
  if (major === 2 || major === 3) {
    const length = argument()
    if (offset + length > bytes.byteLength) fail("malformed", "The CBOR is cut short.")
    const slice = bytes.slice(offset, offset + length)
    offset += length
    if (major === 2) return { value: slice, end: offset }
    try {
      return { value: new TextDecoder("utf-8", { fatal: true }).decode(slice), end: offset }
    } catch {
      fail("malformed", "The CBOR holds text that is not UTF-8.")
    }
  }
  if (major === 4) {
    const length = argument()
    if (length > 256) fail("malformed", "The CBOR array is too long.")
    const items: unknown[] = []
    for (let index = 0; index < length; index++) {
      const item = decodeCbor(bytes, offset, depth + 1)
      items.push(item.value)
      offset = item.end
    }
    return { value: items, end: offset }
  }
  if (major === 5) {
    const length = argument()
    if (length > 256) fail("malformed", "The CBOR map is too long.")
    const map = new Map<unknown, unknown>()
    for (let index = 0; index < length; index++) {
      const key = decodeCbor(bytes, offset, depth + 1)
      if (typeof key.value !== "string" && typeof key.value !== "number")
        fail("malformed", "The CBOR map key is not valid.")
      if (map.has(key.value)) fail("malformed", "The CBOR map repeats a key.")
      const item = decodeCbor(bytes, key.end, depth + 1)
      map.set(key.value, item.value)
      offset = item.end
    }
    return { value: map, end: offset }
  }
  if (major === 6) {
    argument()
    return decodeCbor(bytes, offset, depth + 1)
  }
  if (info === 20) return { value: false, end: offset }
  if (info === 21) return { value: true, end: offset }
  if (info === 22) return { value: null, end: offset }
  if (info === 23) return { value: undefined, end: offset }
  fail("malformed", "The CBOR uses a form Vector does not read.")
}

export function base64url(bytes: Uint8Array) {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Strict unpadded base64url; anything else decodes to an empty array, which matches no challenge. */
export function fromBase64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return new Uint8Array(0)
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Constant-time comparison for equal-length byte strings; different lengths are unequal. */
export function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.byteLength !== b.byteLength || a.byteLength === 0) return false
  let difference = 0
  for (let index = 0; index < a.byteLength; index++) difference |= a[index]! ^ b[index]!
  return difference === 0
}

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a)
  out.set(b, a.byteLength)
  return out
}

function copy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes)
}

function fail(code: Code, message: string): never {
  throw new WebAuthnError(code, message)
}
