import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, randomUUID, sign } from "node:crypto"
import { ENV_NAMES, readConfig, type OfferKey } from "../../../api/_lib/everywhere/config"
import { KEEP_MS, everywhereKeys } from "../../../api/_lib/everywhere/keys"
import {
  offerJtiStore,
  offerPublicKey,
  offerVerifyKey,
  ownOfferKeys,
  signOffer,
  verifyOffer,
  type OfferCheck,
} from "../../../api/_lib/everywhere/offer"
import { OFFER_PATTERN, TIMING, createJobId, randomId } from "../../../packages/schema/src/everywhere"
import { everywhereEnv } from "./lib/everywhere-account"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeClock, FakeStore, useKv, testEverywhereStore } from "./lib/everywhere-store"

installFetchGuard()

/*
 * VE-05 and E9: offers cannot be forged. An offer is Ed25519-signed by vectordev.ai, names one account and one job,
 * lives at most 30 seconds and is used once. Every key pair here is generated inside the test.
 */

function offerKey(kid = "test-offer-key"): OfferKey {
  return { kid, key: generateKeyPairSync("ed25519").privateKey }
}

const KEY = offerKey()
const ACCOUNT = randomUUID()
const NOW = new FakeClock().now

function decodePayload(offer: string) {
  const payload = OFFER_PATTERN.exec(offer)![1]!
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>
}

function check(extra: Partial<OfferCheck> = {}): OfferCheck {
  const used = new Set<string>()
  return {
    keys: ownOfferKeys(KEY),
    account: ACCOUNT,
    now: NOW,
    useJti: async (jti) => {
      if (used.has(jti)) return false
      used.add(jti)
      return true
    },
    ...extra,
  }
}

/** Signs any claims with `key`, for offers the server would never make. */
function forge(claims: Record<string, unknown>, key = KEY) {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")
  const signature = sign(null, Buffer.from(`vector-everywhere-offer-v1.${payload}`), key.key).toString("base64url")
  return `vef1.${payload}.${signature}`
}

describe("signing", () => {
  test("an offer is vef1.<payload>.<signature> and carries only the job id, the account and its 30-second life", () => {
    const jid = createJobId(NOW)
    const { offer, claims } = signOffer(KEY, { account: ACCOUNT, jid, now: NOW })
    expect(offer).toMatch(OFFER_PATTERN)
    const payload = decodePayload(offer)
    expect(Object.keys(payload)).toEqual(["v", "kid", "aud", "sub", "jid", "iat", "exp", "jti"])
    expect(payload).toEqual({ ...claims })
    expect(claims.aud).toBe("vector-everywhere-offer")
    expect(claims.sub).toBe(ACCOUNT)
    expect(claims.jid).toBe(jid)
    expect(claims.exp - claims.iat).toBe(TIMING.offerTtlMs)
  })

  test("every offer has its own jti", () => {
    const jid = createJobId(NOW)
    const first = signOffer(KEY, { account: ACCOUNT, jid, now: NOW })
    const second = signOffer(KEY, { account: ACCOUNT, jid, now: NOW })
    expect(first.claims.jti).not.toBe(second.claims.jti)
  })

  test("only a job id and an account id can be signed", () => {
    expect(() => signOffer(KEY, { account: "someone", jid: createJobId(NOW), now: NOW })).toThrow()
    expect(() => signOffer(KEY, { account: ACCOUNT, jid: "vej_short", now: NOW })).toThrow()
  })

  test("the configured PEM key signs offers that its public half verifies", async () => {
    const pair = generateKeyPairSync("ed25519")
    const pem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    const config = readConfig({
      ...everywhereEnv(),
      [ENV_NAMES.offerSigningKey]: pem.replace(/\n/g, "\\n"),
      [ENV_NAMES.offerKeyId]: "owner-2026",
    })
    expect(config.offer?.kid).toBe("owner-2026")
    const { offer } = signOffer(config.offer!, { account: ACCOUNT, jid: createJobId(NOW), now: NOW })
    const verdict = await verifyOffer(offer, check({ keys: ownOfferKeys(config.offer) }))
    expect(verdict.ok).toBe(true)
    expect(ownOfferKeys(undefined).size).toBe(0)
  })

  test("the public key the owner pins on the desktop verifies the server's offers", async () => {
    const pinned = offerPublicKey(KEY)
    expect(pinned.kid).toBe(KEY.kid)
    expect(Buffer.from(pinned.publicKey, "base64url")).toHaveLength(32)
    const { offer } = signOffer(KEY, { account: ACCOUNT, jid: createJobId(NOW), now: NOW })
    const verdict = await verifyOffer(offer, check({ keys: new Map([[KEY.kid, offerVerifyKey(pinned.publicKey)]]) }))
    expect(verdict.ok).toBe(true)
    expect(() => offerVerifyKey("short")).toThrow()
  })
})

describe("verifying", () => {
  test("a fresh offer for this account is accepted once", async () => {
    const jid = createJobId(NOW)
    const { offer } = signOffer(KEY, { account: ACCOUNT, jid, now: NOW })
    const verifier = check({ now: NOW + 1_000 })
    const first = await verifyOffer(offer, verifier)
    expect(first).toEqual({ ok: true, claims: expect.objectContaining({ jid, sub: ACCOUNT }) })
    expect(await verifyOffer(offer, verifier)).toEqual({ ok: false, reason: "replayed" })
  })

  test("an offer older than 30 seconds is refused", async () => {
    const { offer } = signOffer(KEY, { account: ACCOUNT, jid: createJobId(NOW), now: NOW })
    expect((await verifyOffer(offer, check({ now: NOW + 29_999 }))).ok).toBe(true)
    expect(await verifyOffer(offer, check({ now: NOW + 30_000 }))).toEqual({ ok: false, reason: "expired" })
    expect(await verifyOffer(offer, check({ now: NOW + 31_000 }))).toEqual({ ok: false, reason: "expired" })
  })

  test("an offer dated far ahead of the clock is refused", async () => {
    const { offer } = signOffer(KEY, { account: ACCOUNT, jid: createJobId(NOW), now: NOW + 5 * 60_000 })
    expect(await verifyOffer(offer, check())).toEqual({ ok: false, reason: "not-yet-valid" })
  })

  test("an offer for another account is refused", async () => {
    const { offer } = signOffer(KEY, { account: randomUUID(), jid: createJobId(NOW), now: NOW })
    expect(await verifyOffer(offer, check())).toEqual({ ok: false, reason: "wrong-account" })
  })

  test("an offer with an unknown kid is refused", async () => {
    const other = offerKey("rotated-away")
    const { offer } = signOffer(other, { account: ACCOUNT, jid: createJobId(NOW), now: NOW })
    expect(await verifyOffer(offer, check())).toEqual({ ok: false, reason: "unknown-key" })
  })

  test("a forged offer signed with another key under the pinned kid is refused", async () => {
    const forger = offerKey(KEY.kid)
    const { offer } = signOffer(forger, { account: ACCOUNT, jid: createJobId(NOW), now: NOW })
    expect(await verifyOffer(offer, check())).toEqual({ ok: false, reason: "bad-signature" })
  })

  test("changing the payload or the signature breaks the offer", async () => {
    const { offer, claims } = signOffer(KEY, { account: ACCOUNT, jid: createJobId(NOW), now: NOW })
    const [, , signature] = offer.split(".")
    const changed = Buffer.from(JSON.stringify({ ...claims, jid: createJobId(NOW) })).toString("base64url")
    expect(await verifyOffer(`vef1.${changed}.${signature}`, check())).toEqual({ ok: false, reason: "bad-signature" })
    const flipped = offer.slice(0, -2) + (offer.endsWith("AA") ? "BA" : "AA")
    expect((await verifyOffer(flipped, check())).ok).toBe(false)
  })

  test("a correctly signed offer that lives longer than 30 seconds is refused", async () => {
    const claims = {
      v: 1,
      kid: KEY.kid,
      aud: "vector-everywhere-offer",
      sub: ACCOUNT,
      jid: createJobId(NOW),
      iat: NOW,
      exp: NOW + 31_000,
      jti: randomId(),
    }
    expect(await verifyOffer(forge(claims), check({ now: NOW + 1_000 }))).toEqual({ ok: false, reason: "malformed" })
    expect(await verifyOffer(forge({ ...claims, exp: NOW + 30_000, aud: "other" }), check())).toEqual({
      ok: false,
      reason: "malformed",
    })
    expect(await verifyOffer(forge({ ...claims, exp: NOW + 30_000, extra: "text" }), check())).toEqual({
      ok: false,
      reason: "malformed",
    })
  })

  test("strings that are not offers are refused as malformed", async () => {
    for (const value of [
      undefined,
      42,
      "",
      "vef1.",
      "vef2.abc.def",
      "vef1.a.b",
      `vef1.${"A".repeat(10)}=.${"A".repeat(86)}`,
    ])
      expect(await verifyOffer(value, check())).toEqual({ ok: false, reason: "malformed" })
  })

  test("a refused offer never uses up a jti", async () => {
    const seen: string[] = []
    const verifier = check({
      useJti: async (jti) => {
        seen.push(jti)
        return true
      },
    })
    const forger = offerKey(KEY.kid)
    await verifyOffer(signOffer(forger, { account: ACCOUNT, jid: createJobId(NOW), now: NOW }).offer, verifier)
    await verifyOffer(signOffer(KEY, { account: randomUUID(), jid: createJobId(NOW), now: NOW }).offer, verifier)
    await verifyOffer(signOffer(KEY, { account: ACCOUNT, jid: createJobId(NOW), now: NOW - 60_000 }).offer, verifier)
    expect(seen).toEqual([])
  })
})

describe("the server's jti memory", () => {
  test("offer:<jti> is used once and kept for an hour", async () => {
    const restore = useKv()
    try {
      const fake = new FakeStore()
      const store = testEverywhereStore(fake.fetch)
      const useJti = offerJtiStore(store)
      const jti = randomId()
      expect(await useJti(jti)).toBe(true)
      expect(await useJti(jti)).toBe(false)
      expect(fake.pttl(everywhereKeys.offer(jti))).toBe(KEEP_MS.offer)
      const { offer } = signOffer(KEY, { account: ACCOUNT, jid: createJobId(NOW), now: NOW })
      const verifier = check({ useJti })
      expect((await verifyOffer(offer, verifier)).ok).toBe(true)
      expect(await verifyOffer(offer, verifier)).toEqual({ ok: false, reason: "replayed" })
    } finally {
      restore()
    }
  })
})
