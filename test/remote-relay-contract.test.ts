import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto"
import { REMOTE_LIMITS } from "../api/_lib/codium-limits"
import { signOffer } from "../api/_lib/everywhere/offer"
import { signInternal as apiSign, verifyInternal as apiVerify } from "../api/_lib/hosted-internal"
import { relayCall } from "../api/_lib/remote-relay"
import { fromUtf8, utf8 } from "../packages/relay/src/bytes"
import { handleRequest } from "../packages/relay/src/index"
import { signInternal as relaySign, verifyInternalSignature as relayVerify } from "../packages/relay/src/internal"
import { PLAN_RANKS, RELAY_LIMITS, VIEWER_HOURS } from "../packages/relay/src/limits"
import { DEVICE_BYTES, FRAME, decodeFrame } from "../packages/relay/src/protocol"
import { importTicketKeys, verifyTicket, type TicketClaims } from "../packages/relay/src/ticket"
import { Harness, INTERNAL_SECRET } from "../packages/relay/test/fakes"
import { ENTITLEMENTS } from "../packages/schema/src/codium-entitlements"
import { OFFER_PATTERN, createJobId } from "../packages/schema/src/everywhere"

// WP A39: the relay Worker and Vector's server must agree byte for byte. The Worker re-implements A37's internal HMAC on
// WebCrypto and checks tickets the API (A40) will sign with node:crypto; its fixed limits mirror §4.2's REMOTE_LIMITS.

const SECRET = "relay-contract-fixture-secret-".padEnd(48, "r")
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0)
const PATH = "/internal/v1/suspend"

describe("internal HMAC between the API and the relay", () => {
  test("a request the API signs for the relay passes the relay's check", async () => {
    const body = JSON.stringify({ account: "acct_contract", suspended: true, at: NOW })
    const headers = apiSign("relay", { method: "POST", path: PATH, body, now: NOW, secret: SECRET })
    expect(
      await relayVerify(SECRET, { method: "POST", path: PATH, headers: new Headers(headers), body: utf8(body) }, NOW),
    ).toEqual({ ok: true, nonce: headers["x-vector-internal-nonce"]! })
  })

  test("the relay's signature is the API's, byte for byte, for the same inputs", async () => {
    const body = JSON.stringify({ account: "acct_contract" })
    const nonce = "contract-nonce-0123456789"
    const api = apiSign("relay", { method: "POST", path: PATH, body, now: NOW, nonce, secret: SECRET })
    const relay = await relaySign(SECRET, { method: "POST", path: PATH, body, now: NOW, nonce })
    expect(relay).toEqual(api)
    // And the API accepts what the relay signs (the smoke test and any relay-to-API call use it).
    await apiVerify(
      "relay",
      { method: "POST", path: PATH, headers: relay, body },
      { now: NOW, secret: SECRET, nonces: async () => true },
    )
  })

  test("a request signed for another service with the same secret fails at the relay", async () => {
    const body = "{}"
    for (const service of ["hosted", "ops"] as const) {
      const headers = apiSign(service, { method: "POST", path: PATH, body, now: NOW, secret: SECRET })
      expect(
        await relayVerify(SECRET, { method: "POST", path: PATH, headers: new Headers(headers), body: utf8(body) }, NOW),
      ).toEqual({ ok: false })
    }
  })
})

describe("tickets signed with node:crypto", () => {
  test("a ticket signed the way the API's Node runtime signs verifies at the relay", async () => {
    const pair = generateKeyPairSync("ed25519")
    // The deployment settings: the private key as base64url PKCS#8, the public key as base64url raw bytes.
    const privateSetting = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")
    const publicRaw = pair.publicKey.export({ format: "jwk" }).x!
    expect(publicRaw).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const key = createPrivateKey({ key: Buffer.from(privateSetting, "base64url"), format: "der", type: "pkcs8" })
    const iat = Math.floor(NOW / 1000)
    const claims: TicketClaims = {
      v: 1,
      aud: "vector-relay",
      sub: "acct_contract",
      role: "phone",
      dev: Buffer.alloc(16, 7).toString("base64url"),
      computers: ENTITLEMENTS["vector-50"].remote.computers,
      rank: ENTITLEMENTS["vector-50"].rank,
      epoch: "contract_epoch_000001",
      periodEnd: NOW + 86_400_000,
      iat,
      exp: iat + 300,
      jti: "contract_ticket_00001",
    }
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
    const signature = sign(null, Buffer.from(`vector-relay-ticket-v1.${payload}`), key).toString("base64url")
    const check = await verifyTicket(`vt1.${payload}.${signature}`, await importTicketKeys(publicRaw), NOW)
    expect(check).toEqual({ ok: true, claims })
  })
})

describe("limits", () => {
  test("the relay's fixed limits are §4.2's REMOTE_LIMITS", () => {
    expect(RELAY_LIMITS.phones).toBe(REMOTE_LIMITS.phones)
    expect(RELAY_LIMITS.awakeFactor).toBe(REMOTE_LIMITS.awakeFactor)
    expect(RELAY_LIMITS.viewerIdleMs).toBe(REMOTE_LIMITS.viewerIdleMinutes * 60_000)
    expect(RELAY_LIMITS.frameBytes).toBe(REMOTE_LIMITS.frameBytes)
    expect(RELAY_LIMITS.framesPerSecond).toBe(REMOTE_LIMITS.framesPerSecond)
  })

  test("every plan's computers and rank fit what a ticket may carry", () => {
    const computers = Object.values(ENTITLEMENTS).map((caps) => caps.remote.computers)
    expect(Math.max(...computers)).toBe(RELAY_LIMITS.maxComputers)
    expect(Math.min(...computers)).toBeGreaterThanOrEqual(1)
    expect(
      Object.values(ENTITLEMENTS)
        .map((caps) => caps.rank)
        .sort(),
    ).toEqual([...PLAN_RANKS])
  })

  test("the relay's viewer-hours by rank are §4.2's REMOTE_LIMITS.viewerHours by plan", () => {
    // Server-only (§4.2), so tickets carry the public rank and both servers hold the table.
    const plans = Object.keys(REMOTE_LIMITS.viewerHours) as Array<keyof typeof REMOTE_LIMITS.viewerHours>
    expect(plans.sort()).toEqual(Object.keys(ENTITLEMENTS).sort())
    for (const plan of plans)
      expect({ plan, hours: VIEWER_HOURS[ENTITLEMENTS[plan].rank] }).toEqual({
        plan,
        hours: REMOTE_LIMITS.viewerHours[plan],
      })
    expect(Object.keys(VIEWER_HOURS).map(Number).sort()).toEqual([...PLAN_RANKS])
  })
})

describe("job offers between the API and the relay (R-C1, EV-09)", () => {
  const saved = {
    VECTOR_REMOTE_RELAY_URL: process.env.VECTOR_REMOTE_RELAY_URL,
    VECTOR_HOSTED_INTERNAL_SECRET: process.env.VECTOR_HOSTED_INTERNAL_SECRET,
  }
  beforeEach(() => {
    process.env.VECTOR_REMOTE_RELAY_URL = "wss://relay.contract.invalid"
    process.env.VECTOR_HOSTED_INTERNAL_SECRET = INTERNAL_SECRET
  })
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name]
        continue
      }
      process.env[name] = value
    }
  })

  /** The API's signed calls go straight into the relay Worker's own request handler: no network. */
  const through = (h: Harness) =>
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => handleRequest(new Request(input, init), h.env, h.runtime),
      { preconnect: fetch.preconnect },
    )

  test("relayCall('job-offer') with a signOffer offer reaches the account's computer through the Worker, byte for byte", async () => {
    const h = await Harness.create()
    const account = randomUUID()
    const computer = await h.computer({ sub: account })
    const key = { kid: "contract-offer-key", key: generateKeyPairSync("ed25519").privateKey }
    const offer = signOffer(key, { account, jid: createJobId(h.clock.now), now: h.clock.now }).offer
    expect(await relayCall("job-offer", { account, offer }, through(h), h.clock.now)).toEqual({ delivered: 1 })
    const frames = computer.socket.frames()
    expect(frames).toHaveLength(1)
    const decoded = decodeFrame(frames[0]!)
    expect(decoded?.kind).toBe(FRAME.JOB_OFFER)
    expect(decoded?.device).toEqual(new Uint8Array(DEVICE_BYTES))
    expect(decoded ? fromUtf8(decoded.ciphertext) : undefined).toBe(offer)
  })

  test("the longest offer OFFER_PATTERN allows passes the relay's form and size checks", async () => {
    const h = await Harness.create()
    const account = randomUUID()
    const computer = await h.computer({ sub: account })
    const offer = `vef1.${"A".repeat(2_048)}.${"B".repeat(86)}`
    expect(OFFER_PATTERN.test(offer)).toBe(true)
    expect(await relayCall("job-offer", { account, offer }, through(h), h.clock.now)).toEqual({ delivered: 1 })
    expect(computer.socket.frames()).toHaveLength(1)
  })
})
