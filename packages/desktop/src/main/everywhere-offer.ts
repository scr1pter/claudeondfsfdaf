import { createPublicKey, verify } from "node:crypto"
import { decodeOfferClaims, offerParts, TIMING } from "@vectordevai/schema/everywhere"

/** Filled only by the reviewed signing-key handoff in VE-21. An empty set accepts no offers. */
export const OFFER_KEYS: Readonly<Record<string, string>> = Object.freeze({})

export function createOfferVerifier(input: {
  readonly account: string
  readonly keys?: Readonly<Record<string, string>>
  readonly now: () => number
  readonly useOnce: (jti: string, expiresAt: number) => Promise<boolean>
}) {
  return async (offer: unknown) => {
    const parts = offerParts(offer)
    if (!parts) return undefined
    let raw: unknown
    try { raw = JSON.parse(Buffer.from(parts.payload, "base64url").toString("utf8")) } catch { return undefined }
    const decoded = decodeOfferClaims(raw)
    if (!decoded.ok) return undefined
    const claims = decoded.value
    const pinned = (input.keys ?? OFFER_KEYS)[claims.kid]
    if (!pinned || !/^[A-Za-z0-9_-]{43}$/.test(pinned)) return undefined
    const bytes = Buffer.from(pinned, "base64url")
    if (bytes.length !== 32 || bytes.toString("base64url") !== pinned) return undefined
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes]), format: "der", type: "spki" })
    if (!verify(null, Buffer.from(parts.signed, "utf8"), key, Buffer.from(parts.signature, "base64url"))) return undefined
    const now = input.now()
    if (claims.sub.toLowerCase() !== input.account.toLowerCase() || claims.exp <= now || claims.iat - now > TIMING.offerTtlMs) return undefined
    if (!await input.useOnce(claims.jti, now + TIMING.offerReplayMs)) return undefined
    return claims
  }
}
