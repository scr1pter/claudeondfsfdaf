import { describe, expect, test } from "bun:test"
import {
  computerAccept,
  generateDeviceIdentity,
  generateIdentity,
  pairDoneKey,
  pairingTranscript,
  phoneFinish,
  phoneInit,
  randomDeviceId,
  RemoteCryptoError,
  sealPairDone,
  openPairDone,
  x25519Supported,
} from "../../src/remote/crypto"

// WP A42: Vector Remote's encryption moved from the desktop into core so the phone app runs the same file. The phone
// keeps its static key as a non-extractable CryptoKey; everything a phone does with it must work exactly as with the
// desktop's PKCS#8 bytes, and nothing can read the key back. (The desktop's own cases stay in
// packages/desktop/src/main/remote-crypto.test.ts, which imports this module through its old name.)

describe("a phone's non-extractable static key", () => {
  test("opens a channel with a desktop whose key is PKCS#8 bytes, both ways", async () => {
    expect(await x25519Supported()).toBe(true)
    const computer = { id: randomDeviceId(), ...(await generateIdentity()) }
    const phone = { id: randomDeviceId(), ...(await generateDeviceIdentity()) }
    expect(phone.privateKey.extractable).toBe(false)
    expect(phone.publicKey.byteLength).toBe(32)
    await expect(crypto.subtle.exportKey("pkcs8", phone.privateKey)).rejects.toThrow()
    const peers = { computer: computer.id, computerKey: computer.publicKey, phone: phone.id, phoneKey: phone.publicKey }
    const init = await phoneInit({ phonePrivate: phone.privateKey, peers })
    const accepted = await computerAccept({ computerPrivate: computer.privateKey, peers, envelope: init.envelope })
    const channel = await phoneFinish(init.pending, accepted.envelope)
    expect(await accepted.channel.open(await channel.seal({ t: "hello" }))).toEqual({ t: "hello" })
    expect(await channel.open(await accepted.channel.seal({ t: "res", id: 1 }))).toEqual({ t: "res", id: 1 })
  })

  test("opens the computer's pairing answer, which only the paired phone can", async () => {
    const computer = { id: randomDeviceId(), ...(await generateIdentity()) }
    const phone = { id: randomDeviceId(), ...(await generateDeviceIdentity()) }
    const other = await generateDeviceIdentity()
    const transcript = await pairingTranscript({
      computer: computer.id,
      computerKey: computer.publicKey,
      phone: phone.id,
      phoneKey: phone.publicKey,
      exp: 2_000_000_000,
    })
    const sealed = await sealPairDone(
      await pairDoneKey(computer.privateKey, phone.publicKey, transcript),
      computer.id,
      phone.id,
      { t: "pair-done", alertKeyId: "a".repeat(22) },
    )
    const mine = await pairDoneKey(phone.privateKey, computer.publicKey, transcript)
    expect(await openPairDone(mine, computer.id, phone.id, sealed)).toEqual({ t: "pair-done", alertKeyId: "a".repeat(22) })
    const theirs = await pairDoneKey(other.privateKey, computer.publicKey, transcript)
    await expect(openPairDone(theirs, computer.id, phone.id, sealed)).rejects.toBeInstanceOf(RemoteCryptoError)
  })

  test("a key that is not a private X25519 key that derives bits is refused", async () => {
    const computer = { id: randomDeviceId(), ...(await generateIdentity()) }
    const peers = { computer: computer.id, computerKey: computer.publicKey, phone: randomDeviceId(), phoneKey: computer.publicKey }
    const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])) as CryptoKeyPair
    const x25519 = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair
    for (const key of [ecdh.privateKey, x25519.publicKey]) {
      const error = await phoneInit({ phonePrivate: key, peers }).catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(RemoteCryptoError)
      expect((error as RemoteCryptoError).code).toBe("key")
    }
  })
})
