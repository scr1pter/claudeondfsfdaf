import { describe, expect, test } from "bun:test"
import {
  INTERNAL_NONCE_KEEP_MS as API_NONCE_KEEP_MS,
  INTERNAL_SKEW_MS as API_SKEW_MS,
  signInternal as apiSign,
  verifyInternal as apiVerify,
} from "../api/_lib/hosted-internal"
import { blockedAddress as apiBlockedAddress, blockedHostname as apiBlockedHostname } from "../api/_lib/safe-fetch"
import { utf8 } from "../packages/ops-worker/src/bytes"
import {
  INTERNAL_NONCE_KEEP_MS,
  INTERNAL_SKEW_MS,
  signInternal as opsSign,
  verifyInternalSignature as opsVerify,
} from "../packages/ops-worker/src/internal"
import { OPS_LIMITS } from "../packages/ops-worker/src/limits"
import { parsePlan } from "../packages/ops-worker/src/ops-account"
import { OPS_CALLBACK_PATH } from "../packages/ops-worker/src/protocol"
import {
  blockedAddress as opsBlockedAddress,
  blockedHostname as opsBlockedHostname,
} from "../packages/ops-worker/src/ssrf"
import { ENTITLEMENTS } from "../packages/schema/src/codium-entitlements"

// WP A46: the ops Worker and Vector's server must agree byte for byte. The Worker re-implements A37's internal HMAC on
// WebCrypto for the API's calls and for its own reports back (which the API checks with requireInternalRequest("ops")),
// applies the same S8 address rules as safe-fetch.ts, and accepts every plan ENTITLEMENTS can produce.

const SECRET = "ops-contract-fixture-secret-".padEnd(48, "o")
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)
const PATH = "/internal/v1/plan"

describe("internal HMAC between the API and the ops Worker", () => {
  test("a request the API signs for ops passes the Worker's check", async () => {
    const body = JSON.stringify({ account: "acct_contract", plan: null })
    const headers = apiSign("ops", { method: "POST", path: PATH, body, now: NOW, secret: SECRET })
    expect(
      await opsVerify(SECRET, { method: "POST", path: PATH, headers: new Headers(headers), body: utf8(body) }, NOW),
    ).toEqual({ ok: true, nonce: headers["x-vector-internal-nonce"]!, signedAt: Math.floor(NOW / 1000) * 1000 })
  })

  test("the Worker's report signature is the API's, byte for byte, and the API accepts it", async () => {
    const body = JSON.stringify({ v: 1, account: "acct_contract", events: [] })
    const nonce = "contract-nonce-0123456789"
    const api = apiSign("ops", { method: "POST", path: OPS_CALLBACK_PATH, body, now: NOW, nonce, secret: SECRET })
    const ops = await opsSign(SECRET, { method: "POST", path: OPS_CALLBACK_PATH, body, now: NOW, nonce })
    expect(ops).toEqual(api)
    await apiVerify(
      "ops",
      { method: "POST", path: OPS_CALLBACK_PATH, headers: ops, body },
      { now: NOW, secret: SECRET, nonces: async () => true },
    )
    expect(OPS_CALLBACK_PATH).toBe("/api/ops/worker")
  })

  test("a request signed for another service with the same secret fails at the Worker, and the reverse at the API", async () => {
    const body = "{}"
    for (const service of ["hosted", "relay"] as const) {
      const headers = apiSign(service, { method: "POST", path: PATH, body, now: NOW, secret: SECRET })
      expect(
        await opsVerify(SECRET, { method: "POST", path: PATH, headers: new Headers(headers), body: utf8(body) }, NOW),
      ).toEqual({ ok: false })
    }
    const ops = await opsSign(SECRET, { method: "POST", path: OPS_CALLBACK_PATH, body, now: NOW })
    await expect(
      apiVerify(
        "relay",
        { method: "POST", path: OPS_CALLBACK_PATH, headers: ops, body },
        { now: NOW, secret: SECRET, nonces: async () => true },
      ),
    ).rejects.toMatchObject({ statusCode: 401, code: "INTERNAL_SIGNATURE_INVALID" })
  })

  test("skew and nonce memory match the API's", () => {
    expect(INTERNAL_SKEW_MS).toBe(API_SKEW_MS)
    expect(INTERNAL_NONCE_KEEP_MS).toBe(API_NONCE_KEEP_MS)
  })
})

describe("plans", () => {
  const withOps = Object.entries(ENTITLEMENTS).filter(([, caps]) => caps.ops !== null)

  test("only Max and Ultra have ops, and the Worker's hard maxima are Ultra's caps", () => {
    expect(withOps.map(([id]) => id).sort()).toEqual(["vector-100", "vector-200"])
    const ops = withOps.map(([, caps]) => caps.ops!)
    expect(OPS_LIMITS.maxMonitors).toBe(Math.max(...ops.map((entry) => entry.onCall.urls)))
    expect(OPS_LIMITS.maxDomains).toBe(Math.max(...ops.map((entry) => entry.onCall.domains)))
    expect(OPS_LIMITS.maxReleasePaths).toBe(Math.max(...ops.map((entry) => entry.releaseGuard.paths)))
    expect(OPS_LIMITS.minIntervalSec).toBeLessThanOrEqual(Math.min(...ops.map((entry) => entry.onCall.intervalSec)))
    expect(OPS_LIMITS.maxWatchMin).toBeGreaterThanOrEqual(Math.max(...ops.map((entry) => entry.releaseGuard.watchMin)))
    expect(OPS_LIMITS.maxReleasesPerDay).toBeGreaterThanOrEqual(
      Math.max(...ops.map((entry) => entry.releaseGuard.perDay)),
    )
  })

  test("every plan the API can push from ENTITLEMENTS is accepted as it is", () => {
    for (const [id, caps] of withOps) {
      const ops = caps.ops!
      const plan = {
        version: 3,
        domains: ops.onCall.domains,
        onCall: { urls: ops.onCall.urls, intervalSec: ops.onCall.intervalSec },
        releaseGuard: { ...ops.releaseGuard },
        validUntil: NOW + 32 * 86_400_000,
      }
      expect({ id, plan: parsePlan(plan, NOW) }).toEqual({ id, plan })
    }
  })

  test("the contract's fixed probe rules", () => {
    expect(OPS_LIMITS.probeTimeoutMs).toBe(8_000)
    expect(OPS_LIMITS.probesInFlight).toBe(6)
    expect(OPS_LIMITS.alarmMinAheadMs).toBe(25_000)
    expect(OPS_LIMITS.failuresInARow).toBe(2)
    expect(OPS_LIMITS.releaseSettleMs).toBe(60_000)
    expect(OPS_LIMITS.releaseStepMs).toBe(30_000)
  })
})

describe("S8 address rules", () => {
  test("the Worker refuses exactly the addresses and names safe-fetch.ts refuses", () => {
    const addresses = [
      "8.8.8.8",
      "10.0.0.1",
      "100.64.1.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.5.5",
      "172.32.0.1",
      "192.0.0.170",
      "192.168.0.1",
      "198.18.1.1",
      "203.0.113.5",
      "224.0.0.251",
      "240.0.0.1",
      "168.63.129.16",
      "104.16.132.229",
      "::1",
      "::",
      "fc00::1",
      "fe80::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:8.8.8.8",
      "64:ff9b::1",
      "2001::1",
      "2001:db8::1",
      "2002::1",
      "3fff::1",
      "2606:4700::1111",
      "2a00:1450:4001::200e",
    ]
    for (const address of addresses)
      expect({ address, ops: opsBlockedAddress(address) }).toEqual({ address, ops: apiBlockedAddress(address) })
    for (const name of [
      "localhost",
      "a.localhost",
      "x.local",
      "metadata.google.internal",
      "intranet",
      "vectordev.ai",
      "a.lan",
    ])
      expect({ name, ops: opsBlockedHostname(name) }).toEqual({ name, ops: apiBlockedHostname(name) })
  })
})
