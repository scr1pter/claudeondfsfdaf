import { describe, expect, test } from "bun:test"
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto"
import { REMOTE_LIMITS } from "../api/_lib/codium-limits"
import { signInternal as apiSign, verifyInternal as apiVerify } from "../api/_lib/hosted-internal"
import { utf8 } from "../packages/relay/src/bytes"
import { signInternal as relaySign, verifyInternalSignature as relayVerify } from "../packages/relay/src/internal"
import { RELAY_LIMITS } from "../packages/relay/src/limits"
import { importTicketKeys, verifyTicket, type TicketClaims } from "../packages/relay/src/ticket"
import { ENTITLEMENTS } from "../packages/schema/src/codium-entitlements"

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
      viewerHours: REMOTE_LIMITS.viewerHours["vector-50"],
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

  test("every plan's computers and viewer-hours fit what a ticket may carry", () => {
    const computers = Object.values(ENTITLEMENTS).map((caps) => caps.remote.computers)
    expect(Math.max(...computers)).toBe(RELAY_LIMITS.maxComputers)
    expect(Math.min(...computers)).toBeGreaterThanOrEqual(1)
    for (const hours of Object.values(REMOTE_LIMITS.viewerHours)) {
      expect(Number.isInteger(hours)).toBe(true)
      expect(hours).toBeLessThanOrEqual(RELAY_LIMITS.maxViewerHours)
    }
  })
})
