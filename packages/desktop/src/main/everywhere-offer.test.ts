import { installFetchGuard } from "../../../web/test/lib/everywhere-fetch-guard"
import { expect, test } from "bun:test"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import { signOffer, offerPublicKey } from "../../../../api/_lib/everywhere/offer"
import { createJobId } from "@vectordevai/schema/everywhere"
import { createOfferVerifier } from "./everywhere-offer"

installFetchGuard()

test("only a pinned signed offer for this account consumes its single-use id", async () => {
  const pair = generateKeyPairSync("ed25519")
  const key = { kid: "test-signing-key", key: pair.privateKey }
  const account = randomUUID()
  const now = Date.now()
  const offer = signOffer(key, { account, jid: createJobId(now), now }).offer
  const publicKey = offerPublicKey(key)
  const used = new Set<string>()
  const verify = createOfferVerifier({ account, keys: { [key.kid]: publicKey.publicKey }, now: () => now,
    useOnce: async (id) => { if (used.has(id)) return false; used.add(id); return true } })
  expect(await verify(`${offer.slice(0, -1)}!`)).toBeUndefined()
  expect(used.size).toBe(0)
  expect((await verify(offer))?.sub).toBe(account)
  expect(await verify(offer)).toBeUndefined()
  expect(used.size).toBe(1)
})

test("unconfigured, expired and cross-account offers cannot consume replay state", async () => {
  const key = { kid: "test-signing-key", key: generateKeyPairSync("ed25519").privateKey }
  const account = randomUUID()
  const now = Date.now()
  const offer = signOffer(key, { account, jid: createJobId(now), now }).offer
  let consumed = 0
  const useOnce = async () => { consumed++; return true }
  expect(await createOfferVerifier({ account, now: () => now, useOnce })(offer)).toBeUndefined()
  const keys = { [key.kid]: offerPublicKey(key).publicKey }
  expect(await createOfferVerifier({ account: randomUUID(), keys, now: () => now, useOnce })(offer)).toBeUndefined()
  expect(await createOfferVerifier({ account, keys, now: () => now + 30_000, useOnce })(offer)).toBeUndefined()
  expect(consumed).toBe(0)
})
