export * as VaultRecovery from "./recovery"

import { createHash, randomBytes, scrypt as scryptCallback } from "node:crypto"
import { Option, Schema } from "effect"
import { Vault } from "@vectordevai/schema/vault"
import { VaultCrypto } from "./crypto"
import { VaultError } from "./error"

// The recovery code: 26 random Crockford base32 symbols (130 bits) and 2 checksum symbols, shown once when the vault
// is created and never stored. scrypt (N = 2^17, r = 8, p = 1) turns it into the key that wraps the vault key, and the
// wrapped key is what the store keeps for another computer. A typo is caught by the checksum before scrypt runs; a
// code that is well formed but not this vault's fails the box's tag, and nothing is restored either way.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const BODY = 26
const CHECK = 2
export const COST = 2 ** 17
const MAXMEM = 256 * 1024 * 1024

function checksum(body: string) {
  const digest = createHash("sha256").update(`vector-vault-recovery-v1:${body}`).digest()
  const bits = (digest[0]! << 2) | (digest[1]! >> 6)
  return ALPHABET[(bits >> 5) & 31]! + ALPHABET[bits & 31]!
}

/** A new recovery code, as the person writes it down: seven groups of four. */
export function generate() {
  const body = [...randomBytes(BODY)].map((byte) => ALPHABET[byte & 31]).join("")
  return format(body + checksum(body))
}

function format(symbols: string) {
  return symbols.match(/.{1,4}/g)!.join("-")
}

/**
 * The code's 26 symbols, read the way a person may type them back: any case, with or without spaces and dashes, and
 * O, I and L read as 0, 1 and 1. Throws `typo` when a symbol is not base32 or the checksum does not match.
 */
export function parse(input: string) {
  const symbols = input
    .toUpperCase()
    .replace(/[\s_-]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
  if (symbols.length !== BODY + CHECK || [...symbols].some((symbol) => !ALPHABET.includes(symbol)))
    throw new VaultError("typo", `A recovery code has ${BODY + CHECK} letters and digits. Check it and try again.`)
  const body = symbols.slice(0, BODY)
  if (checksum(body) !== symbols.slice(BODY))
    throw new VaultError("typo", "That recovery code has a typo. Check each group and try again.")
  return body
}

/** Whether `input` reads as a recovery code (its checksum matches). */
export function valid(input: string) {
  try {
    parse(input)
    return true
  } catch {
    return false
  }
}

function derive(body: string, salt: Uint8Array, N: number) {
  return new Promise<Buffer>((resolve, reject) =>
    scryptCallback(body, salt, VaultCrypto.KEY_BYTES, { N, r: 8, p: 1, maxmem: MAXMEM }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  )
}

const aad = (vault: string) => Buffer.from(`vector-vault-key-v1:${vault}`)

/**
 * The vault key wrapped under `code`. `cost` is scrypt's N, 2^17 unless a test asks for less; a reader accepts any N
 * the WrappedKey schema allows.
 */
export async function wrap(input: {
  readonly vaultKey: Uint8Array
  readonly vault: string
  readonly code: string
  readonly now?: number
  readonly cost?: number
}): Promise<Vault.WrappedKey> {
  const body = parse(input.code)
  const salt = randomBytes(16)
  const N = input.cost ?? COST
  const box = VaultCrypto.seal(await derive(body, salt, N), input.vaultKey, aad(input.vault))
  const wrapped: Vault.WrappedKey = {
    format: "vector-vault-key",
    version: 1,
    vault: input.vault,
    kdf: { name: "scrypt", N, r: 8, p: 1, salt: VaultCrypto.toBase64Url(salt) },
    nonce: VaultCrypto.toBase64Url(box.subarray(0, 12)),
    ciphertext: VaultCrypto.toBase64Url(box.subarray(12)),
    createdAt: Math.trunc(input.now ?? Date.now()),
  }
  return Schema.decodeUnknownSync(Vault.WrappedKey)(wrapped)
}

/** Reads a wrapped key a store answered, or throws `damaged`. */
export function decodeWrapped(input: unknown): Vault.WrappedKey {
  const decoded = Schema.decodeUnknownOption(Vault.WrappedKey)(input)
  if (Option.isNone(decoded)) throw new VaultError("damaged", "The vault's key record is damaged.")
  return decoded.value
}

/** The vault key `code` opens, or throws `typo` or `wrong-code`. */
export async function unwrap(input: { readonly wrapped: unknown; readonly code: string }) {
  const wrapped = decodeWrapped(input.wrapped)
  const body = parse(input.code)
  const key = await derive(body, VaultCrypto.fromBase64Url(wrapped.kdf.salt), wrapped.kdf.N)
  const box = Buffer.concat([VaultCrypto.fromBase64Url(wrapped.nonce), VaultCrypto.fromBase64Url(wrapped.ciphertext)])
  // A tag that fails reads as the wrong code: a store that changed the record cannot be told apart, and either way
  // nothing opens.
  let vaultKey: Buffer
  try {
    vaultKey = VaultCrypto.open(key, box, aad(wrapped.vault), "The vault's key")
  } catch {
    throw new VaultError("wrong-code", "That recovery code does not open this vault. Check it and try again.")
  }
  if (vaultKey.byteLength !== VaultCrypto.KEY_BYTES) throw new VaultError("damaged", "The vault's key record is damaged.")
  return { vault: wrapped.vault, vaultKey }
}
