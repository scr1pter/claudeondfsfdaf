import { describe, expect, test } from "bun:test"
import { createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from "node:crypto"
import { openAlert } from "../../../app/src/phone/alerts"
import {
  ALERT_AAD,
  Channel,
  checkCode,
  computerAccept,
  computerProof,
  concat,
  credentialHash,
  deviceBytes,
  ENVELOPE,
  framed,
  fromBase64url,
  generateIdentity,
  openPair,
  openPairDone,
  pairDoneKey,
  pairingLink,
  pairingTranscript,
  passkeyChallenge,
  phoneFinish,
  phoneInit,
  phoneProof,
  randomDeviceId,
  readPairingLink,
  RemoteCryptoError,
  sealAlert,
  sealPair,
  sealPairDone,
  toBase64url,
} from "./remote-crypto"

const ORIGIN = "https://remote.vectordev.ai"

async function devices() {
  const computer = { id: randomDeviceId(), ...(await generateIdentity()) }
  const phone = { id: randomDeviceId(), ...(await generateIdentity()) }
  const peers = { computer: computer.id, computerKey: computer.publicKey, phone: phone.id, phoneKey: phone.publicKey }
  return { computer, phone, peers }
}

async function connect() {
  const { computer, phone, peers } = await devices()
  const init = await phoneInit({ phonePrivate: phone.privateKey, peers })
  const accepted = await computerAccept({ computerPrivate: computer.privateKey, peers, envelope: init.envelope })
  const phoneChannel = await phoneFinish(init.pending, accepted.envelope)
  return { computer, phone, peers, init, accepted, computerChannel: accepted.channel, phoneChannel }
}

async function refused(promise: Promise<unknown>) {
  try {
    await promise
    return "opened"
  } catch (error) {
    if (error instanceof RemoteCryptoError) return error.code
    throw error
  }
}

describe("pairing", () => {
  test("puts the offer in the link's fragment and reads it back only from the phone origin", async () => {
    const { computer } = await devices()
    const offer = {
      v: 1 as const,
      computer: computer.id,
      key: toBase64url(computer.publicKey),
      secret: toBase64url(crypto.getRandomValues(new Uint8Array(32))),
      exp: 1_800_000_000,
      name: "Studio Mac",
    }
    const link = pairingLink(ORIGIN, offer)
    expect(link.startsWith(`${ORIGIN}/phone/pair#`)).toBe(true)
    // The secret is only after the #, which a browser never sends to a server.
    expect(new URL(link).pathname).toBe("/phone/pair")
    expect(new URL(link).search).toBe("")
    expect(readPairingLink(ORIGIN, link)).toEqual(offer)
    expect(readPairingLink("https://remote.vectordev.ai.evil.example", link)).toBeUndefined()
    expect(readPairingLink(ORIGIN, `${ORIGIN}/phone/pair#bm90LWpzb24`)).toBeUndefined()
    expect(readPairingLink(ORIGIN, pairingLink(ORIGIN, { ...offer, secret: "c2hvcnQ" }))).toBeUndefined()
  })

  test("both devices compute the same transcript, proofs and check code, and only from the same inputs", async () => {
    const { computer, phone } = await devices()
    const secret = crypto.getRandomValues(new Uint8Array(32))
    const input = {
      computer: computer.id,
      computerKey: computer.publicKey,
      phone: phone.id,
      phoneKey: phone.publicKey,
      exp: 1_800_000_000,
    }
    const transcript = await pairingTranscript(input)
    const registration = { clientDataJSON: new Uint8Array([1, 2]), attestationObject: new Uint8Array([3]) }
    const hash = await credentialHash(registration)
    const code = await checkCode(secret, transcript, hash)
    expect(code).toMatch(/^\d{6}$/)
    expect(await checkCode(secret, await pairingTranscript(input), await credentialHash(registration))).toBe(code)
    const other = await generateIdentity()
    const swapped = await pairingTranscript({ ...input, phoneKey: other.publicKey })
    expect(toBase64url(swapped)).not.toBe(toBase64url(transcript))
    expect(await checkCode(crypto.getRandomValues(new Uint8Array(32)), transcript, hash)).not.toBe(code)
    expect(toBase64url(await phoneProof(secret, transcript, hash))).not.toBe(
      toBase64url(await computerProof(secret, transcript, hash)),
    )
    expect((await passkeyChallenge(secret, transcript)).byteLength).toBe(32)
  })

  test("pins the wire format, so the phone app's implementation can be checked against it", async () => {
    const computer = toBase64url(new Uint8Array(16).fill(1))
    const phone = toBase64url(new Uint8Array(16).fill(2))
    const transcript = await pairingTranscript({
      computer,
      computerKey: new Uint8Array(32).fill(3),
      phone,
      phoneKey: new Uint8Array(32).fill(4),
      exp: 1_800_000_000,
    })
    // The documented recipe, with node:crypto: SHA-256 over length-prefixed parts.
    const prefixed = (parts: Uint8Array[]) =>
      Buffer.concat(parts.flatMap((part) => [Buffer.from([part.byteLength >> 8, part.byteLength & 0xff]), part]))
    const exp = Buffer.alloc(8)
    exp.writeBigUInt64BE(1_800_000_000n)
    const manual = createHash("sha256")
      .update(
        prefixed([
          Buffer.from("vector-remote-pair-v1"),
          Buffer.alloc(16, 1),
          Buffer.alloc(32, 3),
          Buffer.alloc(16, 2),
          Buffer.alloc(32, 4),
          exp,
        ]),
      )
      .digest()
    expect(Buffer.from(transcript).equals(manual)).toBe(true)
    const secret = new Uint8Array(32).fill(5)
    const hash = new Uint8Array(32).fill(6)
    const okm = Buffer.from(
      hkdfSync("sha256", secret, transcript, Buffer.concat([Buffer.from("vector-remote-check-v1"), hash]), 5),
    )
    const digits = String(okm.reduce((sum, byte) => sum * 256 + byte, 0) % 1_000_000).padStart(6, "0")
    expect(await checkCode(secret, transcript, hash)).toBe(digits)
  })

  test("seals pairing messages under the QR's secret, bound to both devices", async () => {
    const { computer, phone } = await devices()
    const secret = crypto.getRandomValues(new Uint8Array(32))
    const sealed = await sealPair(secret, phone.id, computer.id, { t: "pair-request", name: "Phone" })
    expect(sealed[0]).toBe(ENVELOPE.PAIR)
    expect(new TextDecoder().decode(sealed)).not.toContain("pair-request")
    expect(await openPair(secret, phone.id, computer.id, sealed)).toEqual({ t: "pair-request", name: "Phone" })
    expect(await refused(openPair(crypto.getRandomValues(new Uint8Array(32)), phone.id, computer.id, sealed))).toBe(
      "seal",
    )
    // Reflected back to the phone, or sent on to another computer, it does not open.
    expect(await refused(openPair(secret, computer.id, phone.id, sealed))).toBe("seal")
    expect(await refused(openPair(secret, phone.id, randomDeviceId(), sealed))).toBe("seal")
  })

  test("PAIR_DONE opens only for the phone whose static key is in the transcript", async () => {
    const { computer, phone } = await devices()
    const transcript = crypto.getRandomValues(new Uint8Array(32))
    const sent = await sealPairDone(
      await pairDoneKey(computer.privateKey, phone.publicKey, transcript),
      computer.id,
      phone.id,
      {
        t: "pair-done",
      },
    )
    expect(
      await openPairDone(
        await pairDoneKey(phone.privateKey, computer.publicKey, transcript),
        computer.id,
        phone.id,
        sent,
      ),
    ).toEqual({ t: "pair-done" })
    const stranger = await generateIdentity()
    expect(
      await refused(
        openPairDone(
          await pairDoneKey(stranger.privateKey, computer.publicKey, transcript),
          computer.id,
          phone.id,
          sent,
        ),
      ),
    ).toBe("seal")
  })
})

describe("connections", () => {
  test("a paired phone and its computer open one channel and talk both ways", async () => {
    const { computerChannel, phoneChannel } = await connect()
    expect(toBase64url(computerChannel.id)).toBe(toBase64url(phoneChannel.id))
    expect(await computerChannel.open(await phoneChannel.seal({ t: "req", id: 1 }))).toEqual({ t: "req", id: 1 })
    expect(await phoneChannel.open(await computerChannel.seal({ t: "res", id: 1 }))).toEqual({ t: "res", id: 1 })
    const frame = await computerChannel.seal({ secret: "hunter2" })
    expect(new TextDecoder().decode(frame)).not.toContain("hunter2")
  })

  test("refuses replayed, reordered, reflected and altered frames, and allows gaps", async () => {
    const { computerChannel, phoneChannel } = await connect()
    // The computer's own frame sent back to it is sealed for the other direction.
    expect(await refused(computerChannel.open(await computerChannel.seal({ n: 0 })))).toBe("seal")
    const first = await phoneChannel.seal({ n: 1 })
    const second = await phoneChannel.seal({ n: 2 })
    const third = await phoneChannel.seal({ n: 3 })
    expect(await computerChannel.open(second)).toEqual({ n: 2 })
    expect(await refused(computerChannel.open(first))).toBe("replay")
    expect(await refused(computerChannel.open(second))).toBe("replay")
    expect(await computerChannel.open(third)).toEqual({ n: 3 })
    // A frame the relay dropped leaves a gap, which is allowed.
    await phoneChannel.seal({ n: 4 })
    expect(await computerChannel.open(await phoneChannel.seal({ n: 5 }))).toEqual({ n: 5 })
    const altered = await phoneChannel.seal({ n: 6 })
    altered[altered.byteLength - 1]! ^= 1
    expect(await refused(computerChannel.open(altered))).toBe("seal")
    // A sequence number changed by the relay changes the nonce and the additional data.
    const renumbered = await phoneChannel.seal({ n: 7 })
    renumbered[1 + 8 + 7]! += 5
    expect(await refused(computerChannel.open(renumbered))).toBe("seal")
  })

  test("frames of one connection do not open in another", async () => {
    const one = await connect()
    const init = await phoneInit({ phonePrivate: one.phone.privateKey, peers: one.peers })
    const accepted = await computerAccept({
      computerPrivate: one.computer.privateKey,
      peers: one.peers,
      envelope: init.envelope,
    })
    expect(toBase64url(accepted.channel.id)).not.toBe(toBase64url(one.computerChannel.id))
    expect(await refused(accepted.channel.open(await one.phoneChannel.seal({ n: 1 })))).toBe("seal")
  })

  test("only a paired phone gets an answer, and only the paired computer's answer opens", async () => {
    const { computer, phone, peers } = await devices()
    const stranger = await generateIdentity()
    // A phone holding a different static key cannot make the INIT's HMAC.
    const forged = await phoneInit({ phonePrivate: stranger.privateKey, peers })
    expect(
      await refused(computerAccept({ computerPrivate: computer.privateKey, peers, envelope: forged.envelope })),
    ).toBe("proof")
    // A computer that is not the one in the QR (another key) cannot answer one.
    const init = await phoneInit({ phonePrivate: phone.privateKey, peers })
    const impostor = await generateIdentity()
    expect(
      await refused(computerAccept({ computerPrivate: impostor.privateKey, peers, envelope: init.envelope })),
    ).toBe("proof")
    const accepted = await computerAccept({ computerPrivate: computer.privateKey, peers, envelope: init.envelope })
    const tampered = new Uint8Array(accepted.envelope)
    tampered[tampered.byteLength - 1]! ^= 1
    expect(await refused(phoneFinish(init.pending, tampered))).toBe("proof")
    // A low-order key never becomes a shared secret.
    const zero = concat(new Uint8Array([ENVELOPE.INIT]), new Uint8Array(32), new Uint8Array(48))
    expect(await refused(computerAccept({ computerPrivate: computer.privateKey, peers, envelope: zero }))).toBe("key")
  })

  test("follows the documented key schedule (checked with node:crypto)", async () => {
    const { computer, phone, peers, init, accepted, computerChannel } = await connect()
    const pk = (raw: Uint8Array) =>
      createPublicKey({ key: { kty: "OKP", crv: "X25519", x: toBase64url(raw) }, format: "jwk" })
    const sk = (pkcs8: Uint8Array) => createPrivateKey({ key: Buffer.from(pkcs8), format: "der", type: "pkcs8" })
    const phoneEphemeral = init.envelope.subarray(1, 33)
    const phoneNonce = init.envelope.subarray(33, 49)
    const computerEphemeral = accepted.envelope.subarray(1, 33)
    const computerNonce = accepted.envelope.subarray(33, 49)
    const prefixed = (parts: Uint8Array[]) =>
      Buffer.concat(parts.flatMap((part) => [Buffer.from([part.byteLength >> 8, part.byteLength & 0xff]), part]))
    const salt = createHash("sha256")
      .update(
        prefixed([
          Buffer.from("vector-remote-channel-v1"),
          deviceBytes(peers.computer),
          deviceBytes(peers.phone),
          peers.computerKey,
          peers.phoneKey,
        ]),
      )
      .digest()
    const transcript = createHash("sha256")
      .update(Buffer.concat([salt, phoneEphemeral, phoneNonce, computerEphemeral, computerNonce]))
      .digest()
    const phoneStatic = sk(phone.privateKey)
    const ephemeral = init.pending.ephemeral
    const ee = diffieHellman({ privateKey: sk(ephemeral.privateKey), publicKey: pk(computerEphemeral) })
    const es = diffieHellman({ privateKey: sk(ephemeral.privateKey), publicKey: pk(computer.publicKey) })
    const se = diffieHellman({ privateKey: phoneStatic, publicKey: pk(computerEphemeral) })
    const ss = diffieHellman({ privateKey: phoneStatic, publicKey: pk(computer.publicKey) })
    const okm = Buffer.from(
      hkdfSync("sha256", Buffer.concat([ee, es, se, ss]), transcript, Buffer.from("vector-remote-channel-v1 keys"), 96),
    )
    const frame = await computerChannel.seal({ hello: "phone" })
    expect(frame[0]).toBe(ENVELOPE.DATA)
    expect(Buffer.from(frame.subarray(1, 9)).equals(transcript.subarray(0, 8))).toBe(true)
    const seq = frame.subarray(9, 17)
    expect(Buffer.from(seq).readBigUInt64BE()).toBe(1n)
    const sealed = frame.subarray(17)
    const decipher = createDecipheriv(
      "aes-256-gcm",
      okm.subarray(32, 64),
      Buffer.concat([Buffer.from([0, 0, 0, 2]), seq]),
    )
    decipher.setAAD(
      Buffer.concat([Buffer.from("vector-remote-data-v1"), Buffer.from([ENVELOPE.DATA]), frame.subarray(1, 9), seq]),
    )
    decipher.setAuthTag(sealed.subarray(sealed.byteLength - 16))
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.byteLength - 16)), decipher.final()])
    expect(JSON.parse(plain.toString())).toEqual({ hello: "phone" })
  })

  test("refuses a message too large for one relay frame", async () => {
    const { computerChannel } = await connect()
    expect(await refused(computerChannel.seal({ text: "x".repeat(70_000) }))).toBe("malformed")
    const near = await computerChannel.seal({ text: "x".repeat(59_000) })
    // The relay's frame limit is 64 KiB including its own 17-byte header.
    expect(near.byteLength + 17).toBeLessThanOrEqual(64 * 1024)
  })

  test("Channel numbers frames from 1", async () => {
    const { computerChannel } = await connect()
    expect(computerChannel).toBeInstanceOf(Channel)
    await computerChannel.seal({})
    expect(computerChannel.count).toBe(1)
  })
})

describe("alerts", () => {
  test("the phone app opens a sealed alert with the key from pairing", async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32))
    const ciphertext = await sealAlert(raw, { title: "An agent finished: Fix the login", route: "sessions" })
    expect(ciphertext).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(ciphertext.length).toBeLessThanOrEqual(3_072)
    expect(fromBase64url(ciphertext).byteLength).toBeGreaterThanOrEqual(29)
    const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"])
    const alert = await openAlert({ v: 1, kind: "e2e", c: ciphertext, k: "abc" }, async (id) =>
      id === "abc" ? key : undefined,
    )
    expect(alert).toEqual({ title: "An agent finished: Fix the login", tag: "sessions", route: "sessions" })
    const wrong = await crypto.subtle.importKey(
      "raw",
      crypto.getRandomValues(new Uint8Array(32)),
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    )
    expect((await openAlert({ v: 1, kind: "e2e", c: ciphertext, k: "abc" }, async () => wrong)).body).toBeDefined()
    expect(ALERT_AAD).toBe("vector-alert-v1")
  })

  test("uses framed parts so different lists never hash the same", () => {
    expect(toBase64url(framed(new Uint8Array([1]), new Uint8Array([2, 3])))).not.toBe(
      toBase64url(framed(new Uint8Array([1, 2]), new Uint8Array([3]))),
    )
  })

  test("uses no Node, Bun or Electron module, so the phone app can run the same code", async () => {
    const source = await Bun.file(new URL("./remote-crypto.ts", import.meta.url)).text()
    expect(source).not.toMatch(/from "(?:node:|bun|electron)/)
    expect(source).not.toMatch(/\bBuffer\b|\bBun\./)
  })
})
