import { createPublicKey, sign, verify, type KeyObject } from "node:crypto"
import {
  ACCOUNT_ID_PATTERN,
  JOB_ID_PATTERN,
  OFFER_AUDIENCE,
  OFFER_PREFIX,
  TIMING,
  decodeOfferClaims,
  offerParts,
  randomId,
  type OfferClaims,
} from "../../../packages/schema/src/everywhere.js"
import type { OfferKey } from "./config.js"
import { useOnce } from "./dedupe.js"
import { KEEP_MS, everywhereKeys } from "./keys.js"
import type { Store } from "./store.js"

/*
 * Job offers (contract 3.3, E9). An offer tells the sponsor's computers that a job is waiting and carries nothing but
 * the job id: `vef1.<base64url JSON claims>.<base64url Ed25519 signature>`, the signature over
 * `vector-everywhere-offer-v1.` followed by the payload, made with VECTOR_EVERYWHERE_OFFER_SIGNING_KEY. The relay passes
 * the string unchanged and cannot forge one; the computer then pulls the job over HTTPS with its own desktop token.
 *
 * The desktop verifies offers against public keys pinned in its own everywhere-offer.ts (VE-07, VE-21). `verifyOffer`
 * here is the same check for the server side and the tests: a known `kid`, a valid signature, the right audience and
 * account, at most 30 seconds of life, not expired, and a `jti` not used before.
 */

export type SignedOffer = { readonly offer: string; readonly claims: OfferClaims }

/** Signs an offer for `jid` to `account`'s computers, valid for 30 seconds from `now`. */
export function signOffer(
  key: OfferKey,
  input: { readonly account: string; readonly jid: string; readonly now: number },
) {
  if (!ACCOUNT_ID_PATTERN.test(input.account)) throw new RangeError("An offer needs an account id.")
  if (!JOB_ID_PATTERN.test(input.jid)) throw new RangeError("An offer needs a job id.")
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw new RangeError("An offer needs a time in ms.")
  // The key order is fixed, so the payload is the same text wherever it is made.
  const claims: OfferClaims = {
    v: 1,
    kid: key.kid,
    aud: OFFER_AUDIENCE,
    sub: input.account.toLowerCase(),
    jid: input.jid,
    iat: input.now,
    exp: input.now + TIMING.offerTtlMs,
    jti: randomId(),
  }
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")
  const signature = sign(null, Buffer.from(`vector-everywhere-offer-v1.${payload}`, "utf8"), key.key)
  const offer = `${OFFER_PREFIX}${payload}.${signature.toString("base64url")}`
  if (!offerParts(offer)) throw new RangeError("The offer is malformed.")
  return { offer, claims } satisfies SignedOffer
}

/** The public half of the signing key, as the raw 32 bytes in base64url, for the desktop's pinned `OFFER_KEYS`. */
export function offerPublicKey(key: OfferKey): { readonly kid: string; readonly publicKey: string } {
  const der = createPublicKey(key.key).export({ format: "der", type: "spki" })
  // An Ed25519 SPKI is a fixed 12-byte header followed by the 32-byte key.
  return { kid: key.kid, publicKey: der.subarray(der.length - 32).toString("base64url") }
}

/** A pinned public key from its raw 32 bytes in base64url. */
export function offerVerifyKey(publicKey: string): KeyObject {
  const raw = Buffer.from(publicKey, "base64url")
  if (raw.length !== 32 || raw.toString("base64url") !== publicKey) throw new RangeError("An Ed25519 key is 32 bytes.")
  const header = Buffer.from("302a300506032b6570032100", "hex")
  return createPublicKey({ key: Buffer.concat([header, raw]), format: "der", type: "spki" })
}

export type OfferRefusal =
  | "malformed"
  | "unknown-key"
  | "bad-signature"
  | "wrong-account"
  | "expired"
  | "not-yet-valid"
  | "replayed"

export type OfferVerdict =
  | { readonly ok: true; readonly claims: OfferClaims }
  | { readonly ok: false; readonly reason: OfferRefusal }

export type OfferCheck = {
  /** Pinned public keys by `kid`. */
  readonly keys: ReadonlyMap<string, KeyObject>
  /** The account this verifier acts for: an offer for any other account is refused. */
  readonly account: string
  readonly now: number
  /** Uses a `jti` once: true the first time, false when it was seen before. Called only for an otherwise valid offer. */
  readonly useJti: (jti: string) => Promise<boolean>
}

/**
 * Checks an offer. The signature is checked before the claims are read, so nothing in a forged payload is trusted;
 * the `jti` is used up only once everything else passed, so a refused offer cannot burn a real one's id.
 */
export async function verifyOffer(offer: unknown, check: OfferCheck): Promise<OfferVerdict> {
  const parts = offerParts(offer)
  if (!parts) return { ok: false, reason: "malformed" }
  const raw = Buffer.from(parts.payload, "base64url")
  if (raw.toString("base64url") !== parts.payload) return { ok: false, reason: "malformed" }
  // Only the key id is read before the signature is checked, to pick the key; nothing else in it is trusted yet.
  let header: unknown
  try {
    header = JSON.parse(raw.toString("utf8"))
  } catch {
    return { ok: false, reason: "malformed" }
  }
  const kid = typeof header === "object" && header !== null ? (header as { kid?: unknown }).kid : undefined
  const key = typeof kid === "string" ? check.keys.get(kid) : undefined
  if (!key) return { ok: false, reason: "unknown-key" }
  const signature = Buffer.from(parts.signature, "base64url")
  let valid = false
  try {
    valid =
      signature.length === 64 &&
      signature.toString("base64url") === parts.signature &&
      verify(null, Buffer.from(parts.signed, "utf8"), key, signature)
  } catch {
    valid = false
  }
  if (!valid) return { ok: false, reason: "bad-signature" }
  const decoded = decodeOfferClaims(header)
  if (!decoded.ok) return { ok: false, reason: "malformed" }
  const claims = decoded.value
  if (claims.sub.toLowerCase() !== check.account.toLowerCase()) return { ok: false, reason: "wrong-account" }
  if (check.now >= claims.exp) return { ok: false, reason: "expired" }
  // An offer dated well ahead of this clock was not made for now; a little skew is allowed.
  if (claims.iat - check.now > TIMING.offerTtlMs) return { ok: false, reason: "not-yet-valid" }
  if (!(await check.useJti(claims.jti))) return { ok: false, reason: "replayed" }
  return { ok: true, claims }
}

/** The server's `jti` memory: `offer:<jti>`, kept for an hour (3.13). */
export function offerJtiStore(store: Store): (jti: string) => Promise<boolean> {
  return (jti) => useOnce(store, everywhereKeys.offer(jti), KEEP_MS.offer)
}

/** The configured signing key's public half, keyed by its `kid`, for verifying the server's own offers. */
export function ownOfferKeys(key: OfferKey | undefined): ReadonlyMap<string, KeyObject> {
  return key ? new Map([[key.kid, createPublicKey(key.key)]]) : new Map()
}
