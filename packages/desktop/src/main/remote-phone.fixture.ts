import { createSign, generateKeyPairSync } from "node:crypto"
import {
  checkCode,
  computerProof,
  credentialHash,
  equalBytes,
  fromBase64url,
  generateIdentity,
  openPair,
  openPairDone,
  pairDoneKey,
  pairingTranscript,
  passkeyChallenge,
  phoneFinish,
  phoneInit,
  phoneProof,
  randomDeviceId,
  readPairingLink,
  sealPair,
  toBase64url,
  type Channel,
  type PairingOffer,
} from "./remote-crypto"

// Test fixture: a phone app as Remote's tests see it. It holds a software passkey that answers the way a phone's
// platform authenticator does (WebAuthn Level 3: authenticator data, a "none" attestation object in CBOR, client data
// JSON and a DER ECDSA signature), and runs the phone's half of pairing and of each connection with remote-crypto.ts.

const encoder = new TextEncoder()

function cbor(value: unknown): number[] {
  const head = (major: number, length: number) =>
    length < 24
      ? [(major << 5) | length]
      : length < 256
        ? [(major << 5) | 24, length]
        : [(major << 5) | 25, length >> 8, length & 0xff]
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (value instanceof Uint8Array) return [...head(2, value.byteLength), ...value]
  if (typeof value === "string") {
    const bytes = encoder.encode(value)
    return [...head(3, bytes.byteLength), ...bytes]
  }
  if (value instanceof Map)
    return [...head(5, value.size), ...[...value].flatMap(([key, item]) => [...cbor(key), ...cbor(item)])]
  throw new Error("unsupported CBOR value")
}

async function sha(bytes: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))
}

export function softPasskey(input: { origin: string; rpId?: string }) {
  const rpId = input.rpId ?? new URL(input.origin).hostname
  const id = crypto.getRandomValues(new Uint8Array(32))
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const jwk = keys.publicKey.export({ format: "jwk" }) as { x: string; y: string }
  let counter = 0
  const authData = async (flags: number, count: number, attested: boolean, rp = rpId) => {
    const parts = [
      ...(await sha(encoder.encode(rp))),
      flags,
      (count >>> 24) & 0xff,
      (count >> 16) & 0xff,
      (count >> 8) & 0xff,
      count & 0xff,
    ]
    if (attested) {
      const cose = new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromBase64url(jwk.x)],
        [-3, fromBase64url(jwk.y)],
      ])
      parts.push(...new Uint8Array(16), id.byteLength >> 8, id.byteLength & 0xff, ...id, ...cbor(cose))
    }
    return new Uint8Array(parts)
  }
  const clientData = (type: string, challenge: Uint8Array, origin = input.origin) =>
    encoder.encode(JSON.stringify({ type, challenge: toBase64url(challenge), origin, crossOrigin: false }))
  return {
    id: toBase64url(id),
    async create(challenge: Uint8Array) {
      return {
        clientDataJSON: clientData("webauthn.create", challenge),
        attestationObject: new Uint8Array(
          cbor(
            new Map<string, unknown>([
              ["fmt", "none"],
              ["attStmt", new Map()],
              ["authData", await authData(0x45, 0, true)],
            ]),
          ),
        ),
      }
    },
    /** An assertion as the phone sends it: base64url fields. */
    async get(challenge: string, options: { origin?: string; flags?: number; rpId?: string } = {}) {
      counter += 1
      const authenticatorData = await authData(options.flags ?? 0x05, counter, false, options.rpId)
      const clientDataJSON = clientData("webauthn.get", fromBase64url(challenge), options.origin)
      const signer = createSign("sha256")
      signer.update(new Uint8Array([...authenticatorData, ...(await sha(clientDataJSON))]))
      return {
        id: toBase64url(id),
        clientDataJSON: toBase64url(clientDataJSON),
        authenticatorData: toBase64url(authenticatorData),
        signature: toBase64url(new Uint8Array(signer.sign(keys.privateKey))),
      }
    },
  }
}

export async function fakePhone(input: { origin: string; name?: string; passkeyOrigin?: string }) {
  const device = randomDeviceId()
  const identity = await generateIdentity()
  const passkey = softPasskey({ origin: input.passkeyOrigin ?? input.origin, rpId: new URL(input.origin).hostname })
  const state: {
    offer?: PairingOffer
    secret?: Uint8Array
    transcript?: Uint8Array
    hash?: Uint8Array
    pending?: Awaited<ReturnType<typeof phoneInit>>["pending"]
  } = {}
  return {
    device,
    identity,
    passkey,
    /** Reads the QR's link and makes the sealed pairing request. */
    async pairRequest(link: string, options: { proof?: "wrong" } = {}) {
      const offer = readPairingLink(input.origin, link)
      if (!offer) throw new Error("not a pairing link")
      const secret = fromBase64url(offer.secret)
      const transcript = await pairingTranscript({
        computer: offer.computer,
        computerKey: fromBase64url(offer.key),
        phone: device,
        phoneKey: identity.publicKey,
        exp: offer.exp,
      })
      const registration = await passkey.create(await passkeyChallenge(secret, transcript))
      const hash = await credentialHash(registration)
      const proof = options.proof === "wrong" ? new Uint8Array(32) : await phoneProof(secret, transcript, hash)
      Object.assign(state, { offer, secret, transcript, hash })
      return sealPair(secret, device, offer.computer, {
        t: "pair-request",
        v: 1,
        key: toBase64url(identity.publicKey),
        name: input.name ?? "Test phone",
        registration: {
          clientDataJSON: toBase64url(registration.clientDataJSON),
          attestationObject: toBase64url(registration.attestationObject),
        },
        proof: toBase64url(proof),
        hello: { protocol: 1, minPeer: 1 },
      })
    },
    /** The computer's pair-pending: checks its proof and returns the code this phone shows. */
    async readPending(envelope: Uint8Array) {
      const message = (await openPair(state.secret!, state.offer!.computer, device, envelope)) as Record<
        string,
        unknown
      >
      if (message.t !== "pair-pending") return { message }
      const expected = await computerProof(state.secret!, state.transcript!, state.hash!)
      if (!equalBytes(fromBase64url(message.proof as string), expected))
        throw new Error("computer proof does not match")
      return { message, code: await checkCode(state.secret!, state.transcript!, state.hash!) }
    },
    async readDone(envelope: Uint8Array) {
      const key = await pairDoneKey(identity.privateKey, fromBase64url(state.offer!.key), state.transcript!)
      return (await openPairDone(key, state.offer!.computer, device, envelope)) as Record<string, unknown>
    },
    async init(computer: { device: string; key: string }) {
      const started = await phoneInit({
        phonePrivate: identity.privateKey,
        peers: {
          computer: computer.device,
          computerKey: fromBase64url(computer.key),
          phone: device,
          phoneKey: identity.publicKey,
        },
      })
      state.pending = started.pending
      return started.envelope
    },
    async finish(envelope: Uint8Array): Promise<Channel> {
      return phoneFinish(state.pending!, envelope)
    },
  }
}

export type FakePhone = Awaited<ReturnType<typeof fakePhone>>
