import { hostname } from "node:os"
import { WebAuthn } from "@vectordevai/core/webauthn/verify"
import {
  checkCode,
  computerProof,
  credentialHash,
  deviceBytes,
  equalBytes,
  fromBase64url,
  generateIdentity,
  openPair,
  pairDoneKey,
  pairingLink,
  pairingTranscript,
  passkeyChallenge,
  phoneProof,
  random,
  randomDeviceId,
  RemoteCryptoError,
  sealPair,
  sealPairDone,
  toBase64url,
  ENVELOPE,
} from "./remote-crypto"

// Pairing a phone with this computer (WP A41): the QR offer, the phone's sealed request, the transcript HMACs, the
// passkey registration (checked here, with the origin exactly the phone app's), the 6-digit check code the person
// compares, and the alert key that only the paired phone can open. remote-crypto.ts describes the messages.
//
// The identity this computer pairs with (its relay device id, static key and alert key) and the phones paired with it
// are kept sealed by the OS credential store (remote-runtime.ts). "Disconnect all phones" makes a new identity, so no
// phone paired before can open a connection again.

/** The Remote protocol this desktop speaks, and the oldest phone protocol it still speaks (A38's `negotiate`). */
export const REMOTE_PROTOCOL = 1
export const REMOTE_MIN_PHONE_PROTOCOL = 1
export const PAIRING_TTL_MS = 5 * 60_000
/** Contract §4.2: five phones per account. A computer keeps at most as many. */
export const MAX_PHONES = 5
const MAX_FAILURES = 3

/** The phone app's origin (contract §4.16 VECTOR_PHONE_APP_ORIGIN; A38's PHONE_APP_ADDRESS). */
export const PHONE_APP_ORIGIN = "https://remote.vectordev.ai"

/**
 * The phone app's origin passkeys and pairing links must use. A development build may name a local phone app with
 * VECTOR_PHONE_APP_ORIGIN (https, or http on localhost); a packaged app always uses Vector's own.
 */
export function phoneAppOrigin(packaged: boolean, env: Record<string, string | undefined> = process.env) {
  const override = env.VECTOR_PHONE_APP_ORIGIN?.trim()
  if (packaged || !override) return PHONE_APP_ORIGIN
  try {
    const url = new URL(override)
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)
    if ((url.protocol === "https:" || local) && url.origin === override) return override
  } catch {}
  return PHONE_APP_ORIGIN
}

/** The plain kind of computer the relay lists this one as. Its own name never leaves it unencrypted. */
export function relayName(platform = process.platform) {
  return platform === "darwin" ? "Mac" : platform === "win32" ? "Windows PC" : "Linux computer"
}

/** This computer's name, as its paired phones show it. */
export function computerName(name = hostname(), platform = process.platform) {
  const plain = name
    .replace(/\.(?:local|lan|home)$/i, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
  return (plain || relayName(platform)).slice(0, 64)
}

export type PairedPhone = {
  device: string
  name: string
  /** The phone's static X25519 public key, base64url. */
  key: string
  credential: WebAuthn.Credential
  pairedAt: number
}

export type RemoteIdentity = {
  v: 1
  /** This computer's relay device id. */
  device: string
  /** Its static X25519 key pair: PKCS#8 and raw, base64url. */
  privateKey: string
  publicKey: string
  /** The key desktop alerts are sealed with, and the id the phones store it under. */
  alertKey: string
  alertKeyId: string
  createdAt: number
  phones: PairedPhone[]
}

export async function newIdentity(now = Date.now()): Promise<RemoteIdentity> {
  const keys = await generateIdentity()
  return {
    v: 1,
    device: randomDeviceId(),
    privateKey: toBase64url(keys.privateKey),
    publicKey: toBase64url(keys.publicKey),
    alertKey: toBase64url(random(32)),
    alertKeyId: toBase64url(random(16)),
    createdAt: now,
    phones: [],
  }
}

/** A stored identity, or undefined when it is not one (it is then made again, which unpairs every phone). */
export function decodeIdentity(value: unknown): RemoteIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  try {
    if (input.v !== 1 || typeof input.device !== "string") return undefined
    deviceBytes(input.device)
    for (const field of ["privateKey", "publicKey", "alertKey", "alertKeyId"] as const)
      if (typeof input[field] !== "string") return undefined
    if (fromBase64url(input.publicKey as string).byteLength !== 32) return undefined
    if (fromBase64url(input.alertKey as string).byteLength !== 32) return undefined
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(input.alertKeyId as string)) return undefined
    if (typeof input.createdAt !== "number" || !Array.isArray(input.phones)) return undefined
    const phones = input.phones.flatMap((phone) => {
      const decoded = decodePhone(phone)
      return decoded ? [decoded] : []
    })
    return {
      v: 1,
      device: input.device,
      privateKey: input.privateKey as string,
      publicKey: input.publicKey as string,
      alertKey: input.alertKey as string,
      alertKeyId: input.alertKeyId as string,
      createdAt: input.createdAt,
      phones: phones.slice(0, MAX_PHONES),
    }
  } catch {
    return undefined
  }
}

function decodePhone(value: unknown): PairedPhone | undefined {
  if (!value || typeof value !== "object") return undefined
  const phone = value as Record<string, unknown>
  const credential = phone.credential as Record<string, unknown> | undefined
  if (typeof phone.device !== "string" || typeof phone.name !== "string" || typeof phone.key !== "string")
    return undefined
  if (typeof phone.pairedAt !== "number" || !credential || typeof credential !== "object") return undefined
  if (typeof credential.id !== "string" || typeof credential.signCount !== "number") return undefined
  if (![WebAuthn.ES256, WebAuthn.EDDSA, WebAuthn.RS256].includes(credential.algorithm as WebAuthn.Algorithm))
    return undefined
  if (!credential.publicKey || typeof credential.publicKey !== "object") return undefined
  deviceBytes(phone.device)
  if (fromBase64url(phone.key).byteLength !== 32) return undefined
  return {
    device: phone.device,
    name: phone.name.slice(0, 64),
    key: phone.key,
    credential: credential as unknown as WebAuthn.Credential,
    pairedAt: phone.pairedAt,
  }
}

export type PairingStatus =
  | { state: "idle" }
  | { state: "waiting"; link: string; expiresAt: number }
  | { state: "confirm"; code: string; phone: string; expiresAt: number }
  | { state: "paired"; phone: string }
  | { state: "failed"; message: string }

type Candidate = {
  device: string
  name: string
  key: Uint8Array
  transcript: Uint8Array
  credential: WebAuthn.Credential
  code: string
}

export function createRemotePairing(deps: {
  /** The phone app's origin, exactly (VECTOR_PHONE_APP_ORIGIN). */
  origin: string
  identity: () => RemoteIdentity | undefined
  /** Stores a newly paired phone; it replaces one with the same device id. */
  addPhone: (phone: PairedPhone) => Promise<void>
  send: (phone: string, envelope: Uint8Array) => Promise<void>
  computerName: () => string
  changed?: () => void
  now?: () => number
}) {
  const now = deps.now ?? Date.now
  const rpId = WebAuthn.rpIdFor(deps.origin)
  let session:
    | { secret: Uint8Array; exp: number; link: string; candidate?: Candidate; failures: number; identity: string }
    | undefined
  let result: PairingStatus = { state: "idle" }

  const finish = (next: PairingStatus) => {
    session?.secret.fill(0)
    session = undefined
    result = next
    deps.changed?.()
  }

  const live = () => {
    if (session && session.exp * 1_000 <= now())
      finish({ state: "failed", message: "The pairing code expired. Start again." })
    // A new identity ("Disconnect all phones") ends any pairing begun under the old one.
    if (session && deps.identity()?.device !== session.identity) finish({ state: "idle" })
    return session
  }

  const refuse = async (to: string, reason: string) => {
    const current = session
    const identity = deps.identity()
    if (!current || !identity) return
    await deps
      .send(to, await sealPair(current.secret, identity.device, to, { t: "pair-refused", reason }))
      .catch(() => {})
  }

  return {
    rpId,
    status(): PairingStatus {
      live()
      if (!session) return result
      if (session.candidate)
        return {
          state: "confirm",
          code: session.candidate.code,
          phone: session.candidate.name,
          expiresAt: session.exp * 1_000,
        }
      return { state: "waiting", link: session.link, expiresAt: session.exp * 1_000 }
    },
    /** A new pairing offer, replacing any open one. */
    start() {
      const identity = deps.identity()
      if (!identity) throw new Error("Remote is not set up on this computer.")
      if (identity.phones.length >= MAX_PHONES)
        throw new Error(`This computer already has ${MAX_PHONES} phones. Remove one before pairing another.`)
      session?.secret.fill(0)
      const secret = random(32)
      const exp = Math.floor((now() + PAIRING_TTL_MS) / 1_000)
      const name = deps.computerName().slice(0, 64)
      const link = pairingLink(deps.origin, {
        v: 1,
        computer: identity.device,
        key: identity.publicKey,
        secret: toBase64url(secret),
        exp,
        ...(name ? { name } : {}),
      })
      session = { secret, exp, link, failures: 0, identity: identity.device }
      result = { state: "idle" }
      deps.changed?.()
      return { link, expiresAt: exp * 1_000 }
    },
    cancel() {
      finish({ state: "idle" })
    },
    /** Whether a frame from `from` is a pairing message for the open offer; it is handled here when it is. */
    async receive(from: string, envelope: Uint8Array): Promise<boolean> {
      if (envelope[0] !== ENVELOPE.PAIR) return false
      const current = live()
      const identity = deps.identity()
      if (!current || !identity) return true
      const message = await openPair(current.secret, from, identity.device, envelope).catch(() => undefined)
      if (!message || typeof message !== "object") {
        current.failures += 1
        if (current.failures >= MAX_FAILURES) finish({ state: "failed", message: "Pairing failed. Start again." })
        return true
      }
      const request = message as Record<string, unknown>
      if (request.t !== "pair-request") return true
      // A second phone answering the same QR means someone else saw it: stop, and pair again with a new code.
      if (current.candidate && current.candidate.device !== from) {
        await refuse(from, "in-use")
        finish({ state: "failed", message: "Two phones used the same pairing code, so pairing stopped. Start again." })
        return true
      }
      const candidate = await readRequest(request, {
        from,
        identity,
        secret: current.secret,
        exp: current.exp,
        origin: deps.origin,
        rpId,
      }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
      if (candidate instanceof Error) {
        current.failures += 1
        await refuse(from, "invalid")
        if (current.failures >= MAX_FAILURES) finish({ state: "failed", message: "Pairing failed. Start again." })
        return true
      }
      current.candidate = candidate.candidate
      await deps.send(
        from,
        await sealPair(current.secret, identity.device, from, {
          t: "pair-pending",
          proof: toBase64url(candidate.proof),
        }),
      )
      deps.changed?.()
      return true
    },
    /** The person saw the same six digits on both screens: the phone is paired. */
    async confirm(code?: string) {
      const current = live()
      const identity = deps.identity()
      const candidate = current?.candidate
      if (!current || !identity || !candidate) throw new Error("There is no phone waiting to pair.")
      if (code !== undefined && code !== candidate.code) throw new Error("Those digits do not match.")
      const phone: PairedPhone = {
        device: candidate.device,
        name: candidate.name,
        key: toBase64url(candidate.key),
        credential: candidate.credential,
        pairedAt: now(),
      }
      await deps.addPhone(phone)
      const key = await pairDoneKey(fromBase64url(identity.privateKey), candidate.key, candidate.transcript)
      const name = deps.computerName().slice(0, 64)
      await deps
        .send(
          candidate.device,
          await sealPairDone(key, identity.device, candidate.device, {
            t: "pair-done",
            alertKey: identity.alertKey,
            alertKeyId: identity.alertKeyId,
            hello: { protocol: REMOTE_PROTOCOL, minPeer: REMOTE_MIN_PHONE_PROTOCOL },
            ...(name ? { name } : {}),
          }),
        )
        .catch(() => {})
      finish({ state: "paired", phone: phone.name })
      return phone
    },
  }
}

export type RemotePairing = ReturnType<typeof createRemotePairing>

async function readRequest(
  request: Record<string, unknown>,
  context: {
    from: string
    identity: RemoteIdentity
    secret: Uint8Array
    exp: number
    origin: string
    rpId: string
  },
) {
  const registration = request.registration as Record<string, unknown> | undefined
  if (request.v !== 1 || typeof request.key !== "string" || typeof request.proof !== "string") throw invalid()
  if (
    typeof request.name !== "string" ||
    !request.name.trim() ||
    request.name.length > 64 ||
    /[\u0000-\u001f\u007f]/.test(request.name)
  )
    throw invalid()
  if (
    !registration ||
    typeof registration.clientDataJSON !== "string" ||
    typeof registration.attestationObject !== "string"
  )
    throw invalid()
  const hello = request.hello as Record<string, unknown> | undefined
  if (hello && typeof hello.protocol === "number" && hello.protocol < REMOTE_MIN_PHONE_PROTOCOL)
    throw new Error("Update the Vector phone app, then pair again.")
  const phoneKey = fromBase64url(request.key)
  if (phoneKey.byteLength !== 32) throw invalid()
  const transcript = await pairingTranscript({
    computer: context.identity.device,
    computerKey: fromBase64url(context.identity.publicKey),
    phone: context.from,
    phoneKey,
    exp: context.exp,
  })
  const response = {
    clientDataJSON: fromBase64url(registration.clientDataJSON),
    attestationObject: fromBase64url(registration.attestationObject),
  }
  const hash = await credentialHash(response)
  if (!equalBytes(fromBase64url(request.proof), await phoneProof(context.secret, transcript, hash)))
    throw new RemoteCryptoError("proof", "The pairing proof does not match.")
  const credential = await WebAuthn.verifyRegistration(response, {
    challenge: await passkeyChallenge(context.secret, transcript),
    origin: context.origin,
    rpId: context.rpId,
    requireUserVerification: true,
  })
  return {
    candidate: {
      device: context.from,
      name: request.name.trim(),
      key: phoneKey,
      transcript,
      credential: {
        id: credential.id,
        algorithm: credential.algorithm,
        publicKey: credential.publicKey,
        signCount: credential.signCount,
      },
      code: await checkCode(context.secret, transcript, hash),
    },
    proof: await computerProof(context.secret, transcript, hash),
  }
}

function invalid() {
  return new RemoteCryptoError("malformed", "That pairing request is not valid.")
}
