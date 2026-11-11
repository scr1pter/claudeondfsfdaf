import { describe, expect, test } from "bun:test"
import { createHmac, randomBytes } from "node:crypto"
import {
  MIN_SECRET_CHARS,
  bearerMatches,
  constantTimeEqual,
  hexSignatureValid,
  hmacSha256,
  hmacSha256Hex,
  secretUsable,
  sha256Hex,
  timestampFresh,
} from "../../../api/_lib/everywhere/signature"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"

installFetchGuard()

/*
 * VE-03: constant-time HMAC helpers. The platform formats here (Slack's `v0=` over `v0:<timestamp>:<body>`, Linear's
 * hex HMAC of the body) are only built to exercise the helpers; VE-11 and VE-12 own the platform verifiers. Secrets
 * are generated in the test.
 */

const secret = () => randomBytes(16).toString("hex")

describe("HMAC", () => {
  test("hmacSha256 matches Node's HMAC over the concatenated parts, bytes and text alike", () => {
    const key = secret()
    const body = new TextEncoder().encode('{"text":"héllo"}')
    const expected = createHmac("sha256", key).update("v0:1731300000:").update(body).digest()
    expect(hmacSha256(key, "v0:1731300000:", body).equals(expected)).toBe(true)
    expect(hmacSha256Hex(key, "v0:", "1731300000:", body)).toBe(expected.toString("hex"))
  })

  test("sha256Hex hashes its parts in order", () => {
    expect(sha256Hex("ab", "c")).toBe(sha256Hex("abc"))
    expect(sha256Hex("abc")).toMatch(/^[0-9a-f]{64}$/)
  })

  test("constantTimeEqual compares any two values, of any lengths", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true)
    expect(constantTimeEqual("abc", "abd")).toBe(false)
    expect(constantTimeEqual("abc", "abcd")).toBe(false)
    expect(constantTimeEqual("", "")).toBe(true)
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
  })
})

describe("hex signatures", () => {
  test("a Slack-style v0 signature over the raw body checks out", () => {
    const signingSecret = secret()
    const body = Buffer.from('{"type":"event_callback","event_id":"Ev0123"}')
    const timestamp = "1731300000"
    const signature = `v0=${hmacSha256Hex(signingSecret, `v0:${timestamp}:`, body)}`
    expect(hexSignatureValid({ secret: signingSecret, message: [`v0:${timestamp}:`, body], signature, prefix: "v0=" })).toBe(true)
  })

  test("a Linear-style hex signature of the body checks out", () => {
    const webhookSecret = `lin_wh_${secret()}`
    const body = Buffer.from('{"type":"AgentSessionEvent","action":"created"}')
    const signature = hmacSha256Hex(webhookSecret, body)
    expect(hexSignatureValid({ secret: webhookSecret, message: body, signature })).toBe(true)
  })

  test("a wrong secret, a changed body or a changed timestamp fails", () => {
    const signingSecret = secret()
    const body = Buffer.from('{"a":1}')
    const signature = `v0=${hmacSha256Hex(signingSecret, "v0:1731300000:", body)}`
    expect(hexSignatureValid({ secret: secret(), message: ["v0:1731300000:", body], signature, prefix: "v0=" })).toBe(false)
    expect(hexSignatureValid({ secret: signingSecret, message: ["v0:1731300000:", Buffer.from('{"a":2}')], signature, prefix: "v0=" })).toBe(false)
    expect(hexSignatureValid({ secret: signingSecret, message: ["v0:1731300001:", body], signature, prefix: "v0=" })).toBe(false)
  })

  test("a missing, prefixless, uppercase, short or padded signature fails", () => {
    const key = secret()
    const hex = hmacSha256Hex(key, "body")
    for (const signature of [undefined, null, "", hex, `V0=${hex}`, `v0=${hex.toUpperCase()}`, `v0=${hex.slice(1)}`, `v0=${hex}0`, `v0= ${hex}`, `v0=${hex}\n`])
      expect(hexSignatureValid({ secret: key, message: "body", signature, prefix: "v0=" })).toBe(false)
    expect(hexSignatureValid({ secret: key, message: "body", signature: `v0=${hex}`, prefix: "v0=" })).toBe(true)
  })

  test("a missing, empty or short secret never validates, even with a matching signature", () => {
    for (const weak of ["", "a", "x".repeat(MIN_SECRET_CHARS - 1)]) {
      const signature = hmacSha256Hex(weak, "body")
      expect(hexSignatureValid({ secret: weak, message: "body", signature })).toBe(false)
    }
    expect(hexSignatureValid({ secret: undefined, message: "body", signature: hmacSha256Hex("", "body") })).toBe(false)
  })

  test("secretUsable wants at least 16 printable characters with no spaces", () => {
    expect(secretUsable("x".repeat(MIN_SECRET_CHARS))).toBe(true)
    expect(secretUsable("x".repeat(MIN_SECRET_CHARS - 1))).toBe(false)
    expect(secretUsable(`${"x".repeat(10)} ${"y".repeat(10)}`)).toBe(false)
    expect(secretUsable(undefined)).toBe(false)
    expect(secretUsable(12345678901234567)).toBe(false)
  })
})

describe("timestamps", () => {
  const now = Date.UTC(2026, 10, 11, 12, 0, 0)

  test("Slack seconds within 300 s pass; a replay after 5 minutes fails", () => {
    const seconds = Math.floor(now / 1000)
    expect(timestampFresh(String(seconds), "s", now, 300_000)).toBe(true)
    expect(timestampFresh(String(seconds - 300), "s", now, 300_000)).toBe(true)
    expect(timestampFresh(String(seconds - 301), "s", now, 300_000)).toBe(false)
    expect(timestampFresh(String(seconds + 301), "s", now, 300_000)).toBe(false)
  })

  test("Linear milliseconds within 60 s pass; a webhook at 61 s fails", () => {
    expect(timestampFresh(now - 60_000, "ms", now, 60_000)).toBe(true)
    expect(timestampFresh(now - 61_000, "ms", now, 60_000)).toBe(false)
    expect(timestampFresh(String(now + 61_000), "ms", now, 60_000)).toBe(false)
  })

  test("only plain digits or a safe integer are read", () => {
    for (const value of ["", "abc", "1e9", "-5", " 1731300000", "1731300000.5", "0x10", null, undefined, {}, 1.5, -1, 0, Number.MAX_SAFE_INTEGER])
      expect(timestampFresh(value, "s", now, 300_000)).toBe(false)
  })
})

describe("bearer secrets", () => {
  test("only the exact Bearer header passes", () => {
    const cron = secret()
    expect(bearerMatches(`Bearer ${cron}`, cron)).toBe(true)
    for (const header of [undefined, null, "", cron, `bearer ${cron}`, `Bearer ${cron} `, `Bearer  ${cron}`, `Bearer ${cron.slice(1)}`])
      expect(bearerMatches(header, cron)).toBe(false)
  })

  test("a missing or short secret matches nothing", () => {
    expect(bearerMatches("Bearer ", "")).toBe(false)
    expect(bearerMatches("Bearer undefined", undefined)).toBe(false)
    expect(bearerMatches("Bearer short", "short")).toBe(false)
  })
})
