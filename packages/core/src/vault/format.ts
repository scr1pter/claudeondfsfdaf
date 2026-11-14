export * as VaultFormat from "./format"

import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib"
import { Option, Schema } from "effect"
import { Vault } from "@vectordevai/schema/vault"
import { VaultCrypto } from "./crypto"
import { VaultError } from "./error"

// How a vault object is stored. Every object starts with a 12-byte header the store may read:
//
//   "VVLT" | format (1) | kind (1 chunk, 2 manifest) | minReader (uint16, big-endian) | compression (0 none, 1 brotli) | 0 0 0
//
// then the AES-256-GCM box (nonce ‖ ciphertext ‖ tag) of the compressed plaintext. The associated data is the header,
// the vault id and the object's id (a chunk's HMAC id, or a manifest's version id), so a piece cannot be moved to
// another vault or name, and the header (minReader with it) cannot be changed without failing the tag. A reader refuses
// a format or a minReader above its own before it opens anything, so an old build says "update Vector" instead of
// misreading a newer backup.

const MAGIC = Buffer.from("VVLT")
export const FORMAT = 1
export const HEADER = 12
const KIND = { chunk: 1, manifest: 2 } as const
const COMPRESSION = { none: 0, brotli: 1 } as const
const UPDATE = "This backup was made by a newer version of Vector. Update Vector to restore it."

/** What a stored object takes beyond its compressed plaintext. */
export const OVERHEAD = HEADER + VaultCrypto.OVERHEAD

function header(kind: number, minReader: number, compression: number) {
  const bytes = Buffer.alloc(HEADER)
  MAGIC.copy(bytes, 0)
  bytes[4] = FORMAT
  bytes[5] = kind
  bytes.writeUInt16BE(minReader, 6)
  bytes[8] = compression
  return bytes
}

function aad(head: Uint8Array, vault: string, name: string) {
  return Buffer.concat([head, Buffer.from(`${vault}\u0000${name}`)])
}

/** The header of a stored object, refusing what this reader cannot read. */
function read(bytes: Uint8Array, kind: number) {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.byteLength < OVERHEAD || !view.subarray(0, 4).equals(MAGIC))
    throw new VaultError("damaged", "A backup piece is damaged.")
  if (view[4]! > FORMAT || view.readUInt16BE(6) > Vault.READER) throw new VaultError("update", UPDATE)
  if (view[4] !== FORMAT || view[5] !== kind || view[8]! > COMPRESSION.brotli)
    throw new VaultError("damaged", "A backup piece is damaged.")
  return { head: view.subarray(0, HEADER), box: view.subarray(HEADER), minReader: view.readUInt16BE(6), compression: view[8]! }
}

/** The bytes to store for `plaintext`: brotli when it makes it smaller. */
function pack(plaintext: Uint8Array) {
  const compressed = brotliCompressSync(plaintext, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 5,
      [constants.BROTLI_PARAM_SIZE_HINT]: plaintext.byteLength,
    },
  })
  return compressed.byteLength < plaintext.byteLength
    ? { body: compressed, compression: COMPRESSION.brotli }
    : { body: Buffer.from(plaintext), compression: COMPRESSION.none }
}

function unpack(body: Buffer, compression: number, limit: number) {
  if (compression === COMPRESSION.none) {
    if (body.byteLength > limit) throw new VaultError("damaged", "A backup piece is damaged.")
    return body
  }
  try {
    const plaintext = brotliDecompressSync(body, { maxOutputLength: limit })
    if (plaintext.byteLength > limit) throw new Error("too large")
    return plaintext
  } catch {
    throw new VaultError("damaged", "A backup piece is damaged.")
  }
}

/** A chunk compressed, with the size it will take once sealed, so a backup can declare it before sealing it. */
export type Packed = { readonly body: Buffer; readonly compression: number; readonly size: number }

export function packChunk(plaintext: Uint8Array): Packed {
  if (plaintext.byteLength > Vault.LIMIT.chunk) throw new Error("A chunk is larger than the chunker cuts.")
  const packed = pack(plaintext)
  return { ...packed, size: packed.body.byteLength + OVERHEAD }
}

/** A packed chunk as the store keeps it. `id` is its HMAC id (VaultCrypto.objectId). */
export function sealPacked(keys: VaultCrypto.Keys, vault: string, id: string, packed: Packed) {
  const head = header(KIND.chunk, Vault.MIN_READER, packed.compression)
  return Buffer.concat([head, VaultCrypto.seal(keys.chunk, packed.body, aad(head, vault, id))])
}

export function sealChunk(keys: VaultCrypto.Keys, vault: string, id: string, plaintext: Uint8Array) {
  return sealPacked(keys, vault, id, packChunk(plaintext))
}

/** A stored chunk's plaintext, checked against its id. Throws `damaged` or `update`. */
export function openChunk(keys: VaultCrypto.Keys, vault: string, id: string, bytes: Uint8Array) {
  const { head, box, compression } = read(bytes, KIND.chunk)
  const body = VaultCrypto.open(keys.chunk, box, aad(head, vault, id))
  const plaintext = unpack(body, compression, Vault.LIMIT.chunk)
  if (!VaultCrypto.matches(keys, id, plaintext)) throw new VaultError("damaged", "A backup piece does not match its name.")
  return plaintext
}

/** A manifest as the store keeps it, under its version id. */
export function sealManifest(keys: VaultCrypto.Keys, manifest: Vault.Manifest) {
  const json = Buffer.from(JSON.stringify(Schema.encodeSync(Vault.Manifest)(manifest)))
  if (json.byteLength > Vault.LIMIT.manifest) throw new VaultError("unavailable", "This backup names too many pieces for one version.")
  const packed = pack(json)
  const head = header(KIND.manifest, manifest.minReader, packed.compression)
  return Buffer.concat([head, VaultCrypto.seal(keys.manifest, packed.body, aad(head, manifest.vault, manifest.id))])
}

/** A stored manifest, refused with `update` when it needs a newer reader. Throws `damaged` when it does not open. */
export function openManifest(keys: VaultCrypto.Keys, vault: string, version: string, bytes: Uint8Array) {
  const { head, box, compression, minReader } = read(bytes, KIND.manifest)
  const body = VaultCrypto.open(keys.manifest, box, aad(head, vault, version), "A backup version")
  const text = unpack(body, compression, Vault.LIMIT.manifest).toString("utf8")
  const parsed = (() => {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  })()
  // The manifest's own minReader is checked too, though the header (bound by the tag) already said it.
  const declared = (parsed as { minReader?: unknown } | undefined)?.minReader
  if (typeof declared === "number" && declared > Vault.READER) throw new VaultError("update", UPDATE)
  const decoded = Schema.decodeUnknownOption(Vault.Manifest)(parsed)
  if (Option.isNone(decoded)) throw new VaultError("damaged", "A backup version is damaged.")
  const manifest = decoded.value
  if (manifest.vault !== vault || manifest.id !== version || manifest.minReader !== minReader)
    throw new VaultError("damaged", "A backup version does not match its name.")
  return manifest
}
