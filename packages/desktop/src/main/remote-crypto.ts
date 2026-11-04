// Vector Remote's end-to-end encryption (WP A41, contract S6). The relay (packages/relay) sees only the bytes this
// module seals; it carries them inside its frames (`[kind][16-byte device][ciphertext]`, relay protocol.ts) and never
// holds a key. Everything here is WebCrypto, with no Node or Electron import, so the phone app (A42) can run the same
// code in a browser and both sides are tested against each other.
//
// Identity. Each computer and each phone has a static X25519 key pair, made once and kept on the device (the desktop
// seals its private key with the OS credential store, remote-pairing.ts). The computer's public key reaches the phone
// only through the QR code; the phone's reaches the computer only inside a pairing message sealed with the QR's secret.
// Neither is taken from the relay's peer list.
//
// Pairing (QR, transcript HMAC, 6-digit check code):
//   1. The computer shows a QR of `<phone origin>/phone/pair#<offer>`: its device id, its static public key, a fresh
//      32-byte pairing secret and an expiry. The fragment never reaches a server.
//   2. The phone makes its static key pair and a passkey whose challenge is `passkeyChallenge(secret, transcript)`, and
//      sends a PAIR message sealed under `pairingKey(secret)`: its device id, public key, name, the passkey's
//      registration and `phoneProof`, an HMAC of the transcript under the secret.
//   3. The computer checks the seal, the proof and the passkey (packages/core/src/webauthn/verify.ts), and both sides
//      show `checkCode(...)`. The person confirms on the computer that the phone shows the same six digits, so a QR
//      photographed by someone else cannot pair a stranger's phone unnoticed.
//   4. The computer answers PAIR_DONE, sealed under a key from the two static keys (`pairDoneKey`), carrying its alert
//      key; it proves the computer holds its static key and reaches only the phone that holds its own.
//
// Each connection (X25519 + HKDF-SHA256 + AES-256-GCM, sequence numbers): the phone sends INIT with an ephemeral key
// and an HMAC that only a paired phone can make (static-static and ephemeral-static Diffie-Hellman); the computer
// answers ACCEPT with its own ephemeral key. Both derive one AES-256-GCM key per direction from all four
// Diffie-Hellman results and the transcript, so a recorded connection stays sealed even if a static key leaks later.
// DATA frames carry the channel id and a sequence number that must go up: a replayed, reordered or reflected frame
// does not open. Frames the relay drops (a rate limit) leave gaps, which are allowed.
//
// Desktop alerts (A38's `alerts.ts` opens them): `sealAlert` is AES-256-GCM under the computer's 32-byte alert key with
// the additional data `vector-alert-v1`, as base64url of the 12-byte nonce, the ciphertext and its tag.

export const ENVELOPE = { PAIR: 0x10, PAIR_DONE: 0x11, INIT: 0x20, ACCEPT: 0x21, DATA: 0x30 } as const
export const ALERT_AAD = "vector-alert-v1"
/** The most plaintext one DATA frame carries: the relay's 64 KiB frame less its header and this envelope's. */
export const MAX_PLAINTEXT = 60_000
const DIRECTION = { phoneToComputer: 1, computerToPhone: 2 } as const
const DEVICE_BYTES = 16
const KEY_BYTES = 32
const NONCE_BYTES = 16
const TAG_BYTES = 32
const CHANNEL_BYTES = 8
const SEQ_BYTES = 8

const subtle = () => globalThis.crypto.subtle
const utf8 = (text: string) => new TextEncoder().encode(text)

export class RemoteCryptoError extends Error {
  constructor(
    readonly code: "malformed" | "seal" | "proof" | "replay" | "expired" | "key",
    message: string,
  ) {
    super(message)
    this.name = "RemoteCryptoError"
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Encodings

export function toBase64url(bytes: Uint8Array) {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1)
    throw new RemoteCryptoError("malformed", "That is not base64url.")
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

/** Each part with its length first (two bytes, big-endian), so no two different lists encode the same. */
export function framed(...parts: Uint8Array[]) {
  return concat(
    ...parts.flatMap((part) => {
      if (part.byteLength > 0xffff) throw new RemoteCryptoError("malformed", "A transcript part is too long.")
      return [new Uint8Array([part.byteLength >> 8, part.byteLength & 0xff]), part]
    }),
  )
}

function u64(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RemoteCryptoError("malformed", "That number is not valid.")
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value))
  return bytes
}

function readU64(bytes: Uint8Array) {
  const value = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RemoteCryptoError("malformed", "That number is too large.")
  return Number(value)
}

export function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.byteLength !== b.byteLength || a.byteLength === 0) return false
  let difference = 0
  for (let index = 0; index < a.byteLength; index++) difference |= a[index]! ^ b[index]!
  return difference === 0
}

/** A relay device id (16 random bytes, unpadded base64url) as its bytes. */
export function deviceBytes(id: string) {
  const bytes = fromBase64url(id)
  if (bytes.byteLength !== DEVICE_BYTES || toBase64url(bytes) !== id)
    throw new RemoteCryptoError("malformed", "That device id is not valid.")
  return bytes
}

export function randomDeviceId() {
  return toBase64url(random(DEVICE_BYTES))
}

export function random(size: number) {
  return globalThis.crypto.getRandomValues(new Uint8Array(size))
}

// ---------------------------------------------------------------------------------------------------------------------
// Primitives

export type Identity = { privateKey: Uint8Array; publicKey: Uint8Array }

/** A new static X25519 key pair: the private key as PKCS#8, the public key as its 32 raw bytes. */
export async function generateIdentity(): Promise<Identity> {
  const pair = (await subtle().generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair
  return {
    privateKey: new Uint8Array(await subtle().exportKey("pkcs8", pair.privateKey)),
    publicKey: new Uint8Array(await subtle().exportKey("raw", pair.publicKey)),
  }
}

async function privateKey(pkcs8: Uint8Array) {
  try {
    return await subtle().importKey("pkcs8", new Uint8Array(pkcs8), { name: "X25519" }, false, ["deriveBits"])
  } catch {
    throw new RemoteCryptoError("key", "The private key is not an X25519 key.")
  }
}

async function publicKey(raw: Uint8Array) {
  if (raw.byteLength !== KEY_BYTES) throw new RemoteCryptoError("key", "A public key is 32 bytes.")
  try {
    return await subtle().importKey("raw", new Uint8Array(raw), { name: "X25519" }, true, [])
  } catch {
    throw new RemoteCryptoError("key", "That public key is not an X25519 key.")
  }
}

async function dh(own: CryptoKey, other: Uint8Array) {
  const peer = await publicKey(other)
  // A low-order public key gives an all-zero secret (some runtimes refuse it themselves); refuse it rather than derive
  // keys anyone could compute.
  const shared = await subtle()
    .deriveBits({ name: "X25519", public: peer }, own, 256)
    .then((bits) => new Uint8Array(bits))
    .catch(() => new Uint8Array(KEY_BYTES))
  if (shared.every((byte) => byte === 0)) throw new RemoteCryptoError("key", "That public key is not usable.")
  return shared
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await subtle().importKey("raw", new Uint8Array(ikm), "HKDF", false, ["deriveBits"])
  return new Uint8Array(
    await subtle().deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(salt), info: new Uint8Array(info) },
      key,
      bytes * 8,
    ),
  )
}

async function hmac(key: Uint8Array, data: Uint8Array) {
  const imported = await subtle().importKey("raw", new Uint8Array(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  return new Uint8Array(await subtle().sign("HMAC", imported, new Uint8Array(data)))
}

async function sha256(data: Uint8Array) {
  return new Uint8Array(await subtle().digest("SHA-256", new Uint8Array(data)))
}

async function aesKey(raw: Uint8Array, usages: KeyUsage[] = ["encrypt", "decrypt"]) {
  if (raw.byteLength !== KEY_BYTES) throw new RemoteCryptoError("key", "An AES-256 key is 32 bytes.")
  return subtle().importKey("raw", new Uint8Array(raw), { name: "AES-GCM" }, false, usages)
}

async function seal(key: CryptoKey, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array) {
  return new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv: new Uint8Array(nonce), additionalData: new Uint8Array(aad), tagLength: 128 },
      key,
      new Uint8Array(plaintext),
    ),
  )
}

async function open(key: CryptoKey, nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array) {
  try {
    return new Uint8Array(
      await subtle().decrypt(
        { name: "AES-GCM", iv: new Uint8Array(nonce), additionalData: new Uint8Array(aad), tagLength: 128 },
        key,
        new Uint8Array(ciphertext),
      ),
    )
  } catch {
    throw new RemoteCryptoError("seal", "The message does not open.")
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Pairing

export type PairingOffer = {
  v: 1
  /** The computer's relay device id. */
  computer: string
  /** The computer's static X25519 public key, base64url. */
  key: string
  /** The pairing secret, 32 random bytes, base64url. */
  secret: string
  /** When the offer expires, in seconds since the epoch. */
  exp: number
  /** The computer's name, shown on the phone. */
  name?: string
}

/** The QR's link: the phone app's pairing page with the offer in the fragment, which no server receives. */
export function pairingLink(origin: string, offer: PairingOffer) {
  return `${origin}/phone/pair#${toBase64url(utf8(JSON.stringify(offer)))}`
}

/** The offer in a pairing link from `origin`, or undefined when it is not one. */
export function readPairingLink(origin: string, link: string): PairingOffer | undefined {
  const prefix = `${origin}/phone/pair#`
  if (!link.startsWith(prefix)) return undefined
  try {
    const value = JSON.parse(new TextDecoder().decode(fromBase64url(link.slice(prefix.length)))) as Record<
      string,
      unknown
    >
    if (value.v !== 1 || typeof value.computer !== "string" || typeof value.key !== "string") return undefined
    if (typeof value.secret !== "string" || typeof value.exp !== "number") return undefined
    deviceBytes(value.computer)
    if (fromBase64url(value.key).byteLength !== KEY_BYTES || fromBase64url(value.secret).byteLength !== KEY_BYTES)
      return undefined
    if (value.name !== undefined && (typeof value.name !== "string" || value.name.length > 64)) return undefined
    return value as PairingOffer
  } catch {
    return undefined
  }
}

export type PairingTranscript = {
  computer: string
  computerKey: Uint8Array
  phone: string
  phoneKey: Uint8Array
  exp: number
}

/** The pairing transcript's hash: both devices, both static keys and the offer's expiry. */
export async function pairingTranscript(input: PairingTranscript) {
  return sha256(
    framed(
      utf8("vector-remote-pair-v1"),
      deviceBytes(input.computer),
      input.computerKey,
      deviceBytes(input.phone),
      input.phoneKey,
      u64(input.exp),
    ),
  )
}

/** The challenge the phone's passkey registration signs, binding the passkey to this pairing. */
export function passkeyChallenge(secret: Uint8Array, transcript: Uint8Array) {
  return hmac(secret, concat(utf8("vector-remote-passkey-v1"), transcript))
}

/** The registration's bytes as one hash, so the proofs and the check code cover the passkey too. */
export function credentialHash(registration: { clientDataJSON: Uint8Array; attestationObject: Uint8Array }) {
  return sha256(framed(registration.clientDataJSON, registration.attestationObject))
}

export function phoneProof(secret: Uint8Array, transcript: Uint8Array, credential: Uint8Array) {
  return hmac(secret, concat(utf8("vector-remote-pair-phone-v1"), transcript, credential))
}

export function computerProof(secret: Uint8Array, transcript: Uint8Array, credential: Uint8Array) {
  return hmac(secret, concat(utf8("vector-remote-pair-computer-v1"), transcript, credential))
}

/** The six digits both screens show; they match only when both devices saw the same transcript and passkey. */
export async function checkCode(secret: Uint8Array, transcript: Uint8Array, credential: Uint8Array) {
  const bytes = await hkdf(secret, transcript, concat(utf8("vector-remote-check-v1"), credential), 5)
  const value = bytes.reduce((sum, byte) => sum * 256 + byte, 0) % 1_000_000
  return String(value).padStart(6, "0")
}

async function pairingKey(secret: Uint8Array) {
  if (secret.byteLength !== KEY_BYTES) throw new RemoteCryptoError("key", "The pairing secret is 32 bytes.")
  return aesKey(await hkdf(secret, new Uint8Array(0), utf8("vector-remote-pair-v1 key"), KEY_BYTES))
}

/** The key PAIR_DONE is sealed under: only the two devices whose static keys are in the transcript can make it. */
export async function pairDoneKey(own: Uint8Array, other: Uint8Array, transcript: Uint8Array) {
  const shared = await dh(await privateKey(own), other)
  return aesKey(await hkdf(shared, transcript, utf8("vector-remote-pair-done-v1"), KEY_BYTES))
}

function envelopeAad(type: number, from: string, to: string) {
  return concat(utf8("vector-remote-v1"), new Uint8Array([type]), deviceBytes(from), deviceBytes(to))
}

/** A PAIR message from `from` to `to`, sealed under the pairing secret. */
export async function sealPair(secret: Uint8Array, from: string, to: string, message: unknown) {
  const nonce = random(12)
  const sealed = await seal(await pairingKey(secret), nonce, envelopeAad(ENVELOPE.PAIR, from, to), json(message))
  return concat(new Uint8Array([ENVELOPE.PAIR]), nonce, sealed)
}

export async function openPair(secret: Uint8Array, from: string, to: string, envelope: Uint8Array) {
  if (envelope[0] !== ENVELOPE.PAIR || envelope.byteLength < 1 + 12 + 16)
    throw new RemoteCryptoError("malformed", "That is not a pairing message.")
  const plain = await open(
    await pairingKey(secret),
    envelope.subarray(1, 13),
    envelopeAad(ENVELOPE.PAIR, from, to),
    envelope.subarray(13),
  )
  return parse(plain)
}

/** PAIR_DONE from the computer, sealed under `pairDoneKey`. */
export async function sealPairDone(key: CryptoKey, from: string, to: string, message: unknown) {
  const nonce = random(12)
  const sealed = await seal(key, nonce, envelopeAad(ENVELOPE.PAIR_DONE, from, to), json(message))
  return concat(new Uint8Array([ENVELOPE.PAIR_DONE]), nonce, sealed)
}

export async function openPairDone(key: CryptoKey, from: string, to: string, envelope: Uint8Array) {
  if (envelope[0] !== ENVELOPE.PAIR_DONE || envelope.byteLength < 1 + 12 + 16)
    throw new RemoteCryptoError("malformed", "That is not a pairing answer.")
  return parse(
    await open(key, envelope.subarray(1, 13), envelopeAad(ENVELOPE.PAIR_DONE, from, to), envelope.subarray(13)),
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Connections

export type ChannelPeers = {
  computer: string
  computerKey: Uint8Array
  phone: string
  phoneKey: Uint8Array
}

function channelSalt(peers: ChannelPeers) {
  return sha256(
    framed(
      utf8("vector-remote-channel-v1"),
      deviceBytes(peers.computer),
      deviceBytes(peers.phone),
      peers.computerKey,
      peers.phoneKey,
    ),
  )
}

async function initKey(es: Uint8Array, ss: Uint8Array, peers: ChannelPeers) {
  return hkdf(concat(es, ss), await channelSalt(peers), utf8("vector-remote-channel-v1 init"), KEY_BYTES)
}

/** The phone's INIT: a fresh ephemeral key and nonce, and an HMAC only a paired phone can make. */
export async function phoneInit(input: { phonePrivate: Uint8Array; peers: ChannelPeers }) {
  const ephemeral = await generateIdentity()
  const nonce = random(NONCE_BYTES)
  const own = await privateKey(ephemeral.privateKey)
  const es = await dh(own, input.peers.computerKey)
  const ss = await dh(await privateKey(input.phonePrivate), input.peers.computerKey)
  const tag = await hmac(await initKey(es, ss, input.peers), concat(ephemeral.publicKey, nonce))
  return {
    envelope: concat(new Uint8Array([ENVELOPE.INIT]), ephemeral.publicKey, nonce, tag),
    pending: { ephemeral, nonce, peers: input.peers, phonePrivate: input.phonePrivate },
  }
}

/**
 * The computer's answer to an INIT from a paired phone: checks its HMAC, and returns the ACCEPT envelope and the open
 * channel. An INIT that does not check throws `proof`, and the computer sends nothing back.
 */
export async function computerAccept(input: {
  computerPrivate: Uint8Array
  peers: ChannelPeers
  envelope: Uint8Array
}) {
  const { envelope, peers } = input
  if (envelope[0] !== ENVELOPE.INIT || envelope.byteLength !== 1 + KEY_BYTES + NONCE_BYTES + TAG_BYTES)
    throw new RemoteCryptoError("malformed", "That is not a connection request.")
  const phoneEphemeral = envelope.slice(1, 1 + KEY_BYTES)
  const phoneNonce = envelope.slice(1 + KEY_BYTES, 1 + KEY_BYTES + NONCE_BYTES)
  const tag = envelope.slice(1 + KEY_BYTES + NONCE_BYTES)
  const own = await privateKey(input.computerPrivate)
  const es = await dh(own, phoneEphemeral)
  const ss = await dh(own, peers.phoneKey)
  const expected = await hmac(await initKey(es, ss, peers), concat(phoneEphemeral, phoneNonce))
  if (!equalBytes(tag, expected)) throw new RemoteCryptoError("proof", "That phone is not paired with this computer.")
  const ephemeral = await generateIdentity()
  const nonce = random(NONCE_BYTES)
  const ephemeralKey = await privateKey(ephemeral.privateKey)
  const ee = await dh(ephemeralKey, phoneEphemeral)
  const se = await dh(ephemeralKey, peers.phoneKey)
  const keys = await channelKeys({
    ee,
    es,
    se,
    ss,
    peers,
    phoneEphemeral,
    phoneNonce,
    computerEphemeral: ephemeral.publicKey,
    computerNonce: nonce,
  })
  const confirm = await hmac(keys.confirm, concat(utf8("accept"), keys.transcript))
  return {
    envelope: concat(new Uint8Array([ENVELOPE.ACCEPT]), ephemeral.publicKey, nonce, confirm),
    channel: new Channel("computer", keys),
  }
}

/** The phone's side once ACCEPT arrives: checks the computer's confirmation and opens the channel. */
export async function phoneFinish(pending: Awaited<ReturnType<typeof phoneInit>>["pending"], envelope: Uint8Array) {
  if (envelope[0] !== ENVELOPE.ACCEPT || envelope.byteLength !== 1 + KEY_BYTES + NONCE_BYTES + TAG_BYTES)
    throw new RemoteCryptoError("malformed", "That is not a connection answer.")
  const computerEphemeral = envelope.slice(1, 1 + KEY_BYTES)
  const computerNonce = envelope.slice(1 + KEY_BYTES, 1 + KEY_BYTES + NONCE_BYTES)
  const tag = envelope.slice(1 + KEY_BYTES + NONCE_BYTES)
  const own = await privateKey(pending.ephemeral.privateKey)
  const staticKey = await privateKey(pending.phonePrivate)
  const ee = await dh(own, computerEphemeral)
  const es = await dh(own, pending.peers.computerKey)
  const se = await dh(staticKey, computerEphemeral)
  const ss = await dh(staticKey, pending.peers.computerKey)
  const keys = await channelKeys({
    ee,
    es,
    se,
    ss,
    peers: pending.peers,
    phoneEphemeral: pending.ephemeral.publicKey,
    phoneNonce: pending.nonce,
    computerEphemeral,
    computerNonce,
  })
  if (!equalBytes(tag, await hmac(keys.confirm, concat(utf8("accept"), keys.transcript))))
    throw new RemoteCryptoError("proof", "That computer is not the one this phone paired with.")
  return new Channel("phone", keys)
}

async function channelKeys(input: {
  ee: Uint8Array
  es: Uint8Array
  se: Uint8Array
  ss: Uint8Array
  peers: ChannelPeers
  phoneEphemeral: Uint8Array
  phoneNonce: Uint8Array
  computerEphemeral: Uint8Array
  computerNonce: Uint8Array
}) {
  const transcript = await sha256(
    concat(
      await channelSalt(input.peers),
      input.phoneEphemeral,
      input.phoneNonce,
      input.computerEphemeral,
      input.computerNonce,
    ),
  )
  const okm = await hkdf(
    concat(input.ee, input.es, input.se, input.ss),
    transcript,
    utf8("vector-remote-channel-v1 keys"),
    KEY_BYTES * 3,
  )
  return {
    transcript,
    id: transcript.slice(0, CHANNEL_BYTES),
    phoneToComputer: okm.slice(0, KEY_BYTES),
    computerToPhone: okm.slice(KEY_BYTES, KEY_BYTES * 2),
    confirm: okm.slice(KEY_BYTES * 2),
  }
}

/**
 * One open connection between a computer and a phone. `seal` numbers each frame it sends from 1; `open` takes only
 * frames of this channel, in this direction, whose number is above every number it took before.
 */
export class Channel {
  private sent = 0
  private received = 0
  private keys: Promise<{ send: CryptoKey; receive: CryptoKey }>
  readonly id: Uint8Array
  readonly openedAt = Date.now()

  constructor(
    readonly side: "computer" | "phone",
    keys: { id: Uint8Array; phoneToComputer: Uint8Array; computerToPhone: Uint8Array },
  ) {
    this.id = keys.id
    const send = side === "computer" ? keys.computerToPhone : keys.phoneToComputer
    const receive = side === "computer" ? keys.phoneToComputer : keys.computerToPhone
    this.keys = Promise.all([aesKey(send, ["encrypt"]), aesKey(receive, ["decrypt"])]).then(([send, receive]) => ({
      send,
      receive,
    }))
  }

  /** How many frames this side sent. */
  get count() {
    return this.sent
  }

  async seal(message: unknown) {
    const plaintext = json(message)
    if (plaintext.byteLength > MAX_PLAINTEXT) throw new RemoteCryptoError("malformed", "That message is too large.")
    this.sent += 1
    const seq = u64(this.sent)
    const direction = this.side === "computer" ? DIRECTION.computerToPhone : DIRECTION.phoneToComputer
    const sealed = await seal((await this.keys).send, nonce(direction, seq), dataAad(this.id, seq), plaintext)
    return concat(new Uint8Array([ENVELOPE.DATA]), this.id, seq, sealed)
  }

  async open(envelope: Uint8Array) {
    if (envelope[0] !== ENVELOPE.DATA || envelope.byteLength < 1 + CHANNEL_BYTES + SEQ_BYTES + 16)
      throw new RemoteCryptoError("malformed", "That is not a data frame.")
    const id = envelope.subarray(1, 1 + CHANNEL_BYTES)
    if (!equalBytes(id, this.id)) throw new RemoteCryptoError("seal", "That frame belongs to another connection.")
    const seq = envelope.slice(1 + CHANNEL_BYTES, 1 + CHANNEL_BYTES + SEQ_BYTES)
    const number = readU64(seq)
    if (number <= this.received) throw new RemoteCryptoError("replay", "That frame was already received.")
    const direction = this.side === "computer" ? DIRECTION.phoneToComputer : DIRECTION.computerToPhone
    const plain = await open(
      (await this.keys).receive,
      nonce(direction, seq),
      dataAad(this.id, seq),
      envelope.subarray(1 + CHANNEL_BYTES + SEQ_BYTES),
    )
    this.received = number
    return parse(plain)
  }
}

function nonce(direction: number, seq: Uint8Array) {
  return concat(new Uint8Array([0, 0, 0, direction]), seq)
}

function dataAad(id: Uint8Array, seq: Uint8Array) {
  return concat(utf8("vector-remote-data-v1"), new Uint8Array([ENVELOPE.DATA]), id, seq)
}

// ---------------------------------------------------------------------------------------------------------------------
// Alerts

/** A desktop alert for the phones, sealed under the computer's alert key (A38's `alerts.ts` format). */
export async function sealAlert(alertKey: Uint8Array, alert: { title: string; route?: string }) {
  const nonce = random(12)
  const key = await aesKey(alertKey, ["encrypt"])
  const body = json({ v: 1, title: alert.title, ...(alert.route ? { route: alert.route } : {}) })
  return toBase64url(concat(nonce, await seal(key, nonce, utf8(ALERT_AAD), body)))
}

// ---------------------------------------------------------------------------------------------------------------------

function json(value: unknown) {
  return utf8(JSON.stringify(value))
}

function parse(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw new RemoteCryptoError("malformed", "The message is not JSON.")
  }
}
