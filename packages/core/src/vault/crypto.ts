export * as VaultCrypto from "./crypto"

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto"
import { VaultError } from "./error"

// Brain Vault's keys. One random 32-byte vault key, kept on the person's computer (and wrapped under the recovery code
// in the store), gives four keys by HKDF-SHA-256: chunk and manifest keys for AES-256-GCM, the id key for object ids
// (an HMAC of the plaintext, so equal chunks dedupe between versions while the store cannot test a guess at the
// content), and the chunker's key, so where content-defined chunks are cut depends on a secret too. Node's crypto only.

export const KEY_BYTES = 32
const NONCE = 12
const TAG = 16

export type Keys = {
  readonly chunk: Buffer
  readonly manifest: Buffer
  readonly id: Buffer
  readonly chunker: Buffer
}

const SALT = Buffer.from("vector-vault-v1")

function hkdf(key: Uint8Array, info: string) {
  return Buffer.from(hkdfSync("sha256", key, SALT, Buffer.from(info), KEY_BYTES))
}

/** The keys a vault key gives. */
export function derive(vaultKey: Uint8Array): Keys {
  if (vaultKey.byteLength !== KEY_BYTES) throw new VaultError("damaged", "That vault key is not a vault key.")
  return {
    chunk: hkdf(vaultKey, "vector-vault-v1 chunk"),
    manifest: hkdf(vaultKey, "vector-vault-v1 manifest"),
    id: hkdf(vaultKey, "vector-vault-v1 object-id"),
    chunker: hkdf(vaultKey, "vector-vault-v1 chunker"),
  }
}

/** A new vault key. */
export function vaultKey() {
  return randomBytes(KEY_BYTES)
}

/** A new vault id: 16 random bytes as hex. */
export function vaultId() {
  return randomBytes(16).toString("hex")
}

/** A new version id at `now`: `v`, 13 digits of milliseconds, then 8 random hex digits. */
export function versionId(now: number) {
  return `v${String(Math.trunc(now)).padStart(13, "0")}-${randomBytes(4).toString("hex")}`
}

/** An object's id: HMAC-SHA-256 of its plaintext under the id key, as hex. */
export function objectId(keys: Keys, plaintext: Uint8Array) {
  return createHmac("sha256", keys.id).update(plaintext).digest("hex")
}

/** Whether `plaintext` is the object `id` names, compared in constant time. */
export function matches(keys: Keys, id: string, plaintext: Uint8Array) {
  const want = Buffer.from(id, "hex")
  const got = createHmac("sha256", keys.id).update(plaintext).digest()
  return want.byteLength === got.byteLength && timingSafeEqual(want, got)
}

/** AES-256-GCM with a random nonce: nonce ‖ ciphertext ‖ tag. */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array) {
  const nonce = randomBytes(NONCE)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()])
}

/** Opens what `seal` made, or throws `damaged` when the key, the associated data or a byte differs. */
export function open(key: Uint8Array, sealed: Uint8Array, aad: Uint8Array, what = "A backup piece") {
  if (sealed.byteLength < NONCE + TAG) throw new VaultError("damaged", `${what} is damaged.`)
  const bytes = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength)
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, NONCE))
  decipher.setAAD(aad)
  decipher.setAuthTag(bytes.subarray(bytes.byteLength - TAG))
  try {
    return Buffer.concat([decipher.update(bytes.subarray(NONCE, bytes.byteLength - TAG)), decipher.final()])
  } catch {
    throw new VaultError("damaged", `${what} is damaged or belongs to another vault.`)
  }
}

/** Bytes `seal` adds to a plaintext. */
export const OVERHEAD = NONCE + TAG

/**
 * The chunker's gear table: 256 32-bit values from the chunker key, so where chunks are cut is the same for every
 * version of one vault (and dedupes) but tells the store nothing about the content's structure.
 */
export function gear(keys: Keys) {
  const table = new Uint32Array(256)
  for (let block = 0; block < 32; block++) {
    const digest = createHmac("sha256", keys.chunker).update(`gear ${block}`).digest()
    for (let i = 0; i < 8; i++) table[block * 8 + i] = digest.readUInt32BE(i * 4)
  }
  return table
}

/** A gear table for tests and tools that chunk without a vault key. */
export function plainGear(label: string) {
  return gear(derive(createHash("sha256").update(label).digest()))
}

export function toBase64Url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url")
}

export function fromBase64Url(text: string) {
  return Buffer.from(text, "base64url")
}
