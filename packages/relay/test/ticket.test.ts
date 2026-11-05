import { describe, expect, test } from "bun:test"
import { base64url, utf8 } from "../src/bytes"
import { RELAY_LIMITS } from "../src/limits"
import {
  accountHandle,
  decodeClaims,
  importTicketKeys,
  signTicket,
  verifyTicket,
  type TicketClaims,
} from "../src/ticket"
import { ACCOUNT, ACCOUNT_KEY, EPOCH, NOW, deviceId, ticketKeys, token } from "./fakes"

// WP A39: the relay admits a connection only with an Ed25519 ticket from the API, for the relay's audience, at most
// five minutes long and not yet expired. The ticket names the account, the device, its role and the plan's caps.

const iat = Math.floor(NOW / 1000)

function claims(overrides: Partial<TicketClaims> = {}): TicketClaims {
  return {
    v: 1,
    aud: "vector-relay",
    sub: ACCOUNT,
    role: "phone",
    dev: deviceId(),
    name: "Pixel",
    computers: 3,
    rank: 2,
    epoch: EPOCH,
    periodEnd: NOW + 86_400_000,
    iat,
    exp: iat + 300,
    jti: token(),
    ...overrides,
  }
}

/** Signs any payload, valid or not, as the API's key would. */
async function signRaw(payload: unknown, key: CryptoKey) {
  const body = base64url(utf8(JSON.stringify(payload)))
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, utf8(`vector-relay-ticket-v1.${body}`)))
  return `vt1.${body}.${base64url(signature)}`
}

describe("relay tickets", () => {
  test("a ticket the API signed passes and carries its claims", async () => {
    const keys = await ticketKeys()
    const ticket = await signTicket(claims({ role: "computer", key: "k".repeat(43) }), keys.privateKey)
    expect(ticket).toMatch(/^vt1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/)
    const check = await verifyTicket(ticket, await importTicketKeys(keys.publicText), NOW)
    expect(check.ok).toBe(true)
    if (check.ok)
      expect(check.claims).toMatchObject({ role: "computer", sub: ACCOUNT, computers: 3, key: "k".repeat(43) })
  })

  test("every character is a subprotocol token character, so the ticket fits Sec-WebSocket-Protocol", async () => {
    const keys = await ticketKeys()
    const ticket = await signTicket(claims({ name: "Krishna’s phone, “work” (1)" }), keys.privateKey)
    expect(ticket).toMatch(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/)
  })

  test("signatures from another key, a changed payload or another context fail", async () => {
    const keys = await ticketKeys()
    const other = await ticketKeys()
    const verifying = await importTicketKeys(keys.publicText)
    const ticket = await signTicket(claims(), keys.privateKey)
    expect(await verifyTicket(await signTicket(claims(), other.privateKey), verifying, NOW)).toEqual({
      ok: false,
      reason: "signature",
    })
    const [prefix, payload, signature] = ticket.split(".") as [string, string, string]
    const changed = base64url(utf8(JSON.stringify({ ...claims(), computers: 5 })))
    expect(await verifyTicket(`${prefix}.${changed}.${signature}`, verifying, NOW)).toEqual({
      ok: false,
      reason: "signature",
    })
    // A signature over the bare payload (no context string) is not a ticket signature.
    const bare = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, utf8(payload)))
    expect(await verifyTicket(`vt1.${payload}.${base64url(bare)}`, verifying, NOW)).toEqual({
      ok: false,
      reason: "signature",
    })
    expect(await verifyTicket(ticket, [], NOW)).toEqual({ ok: false, reason: "signature" })
  })

  test("either of two configured keys verifies, so the signing key can rotate", async () => {
    const current = await ticketKeys()
    const next = await ticketKeys()
    const both = await importTicketKeys(`${current.publicText}, ${next.publicText}`)
    expect(both).toHaveLength(2)
    expect((await verifyTicket(await signTicket(claims(), next.privateKey), both, NOW)).ok).toBe(true)
    expect((await verifyTicket(await signTicket(claims(), current.privateKey), both, NOW)).ok).toBe(true)
  })

  test("a malformed key setting gives no keys at all, so a typo turns the relay off", async () => {
    const keys = await ticketKeys()
    expect(await importTicketKeys(undefined)).toEqual([])
    expect(await importTicketKeys("")).toEqual([])
    expect(await importTicketKeys(`${keys.publicText},not-a-key`)).toEqual([])
    expect(await importTicketKeys(base64url(new Uint8Array(31)))).toEqual([])
    expect(await importTicketKeys(Array(5).fill(keys.publicText).join(","))).toEqual([])
  })

  test("audience, version and expiry are checked; a ticket lives at most five minutes", async () => {
    const keys = await ticketKeys()
    const verifying = await importTicketKeys(keys.publicText)
    const check = async (payload: unknown, now = NOW) =>
      verifyTicket(await signRaw(payload, keys.privateKey), verifying, now)
    expect(await check({ ...claims(), aud: "vector-ops" })).toEqual({ ok: false, reason: "claims" })
    expect(await check({ ...claims(), v: 2 })).toEqual({ ok: false, reason: "claims" })
    expect(await check(claims({ exp: iat + RELAY_LIMITS.ticketMaxSeconds + 1 }))).toEqual({
      ok: false,
      reason: "lifetime",
    })
    expect(await check(claims({ exp: iat }))).toEqual({ ok: false, reason: "lifetime" })
    expect((await check(claims({ exp: iat + RELAY_LIMITS.ticketMaxSeconds }))).ok).toBe(true)
    // Expired at exp, not after it.
    expect(await check(claims(), (iat + 300) * 1000)).toEqual({ ok: false, reason: "expired" })
    expect((await check(claims(), (iat + 299) * 1000)).ok).toBe(true)
    // Issued more than a minute ahead of the relay's clock.
    expect(await check(claims({ iat: iat + 61, exp: iat + 300 }))).toEqual({ ok: false, reason: "not-yet-valid" })
    expect((await check(claims({ iat: iat + 60, exp: iat + 300 }))).ok).toBe(true)
  })

  test("claims outside their ranges or shapes are refused", async () => {
    const base = claims()
    const bad: Array<Partial<Record<keyof TicketClaims, unknown>>> = [
      { role: "viewer" },
      { dev: "short" },
      { dev: "A".repeat(21) + "B" },
      { sub: "" },
      { sub: "has space" },
      { sub: "x".repeat(129) },
      { name: "" },
      { name: "x".repeat(65) },
      { name: "line\nbreak" },
      { key: "too-short" },
      { computers: RELAY_LIMITS.maxComputers + 1 },
      { computers: -1 },
      { computers: 1.5 },
      { rank: 0 },
      { rank: 5 },
      { rank: 1.5 },
      { rank: "2" },
      { epoch: "short" },
      { epoch: "has.dots.in.the.epoch.text" },
      { periodEnd: 0 },
      { jti: "short" },
      { iat: "1" },
    ]
    for (const change of bad)
      expect({ change, decoded: decodeClaims({ ...base, ...change }) }).toEqual({ change, decoded: undefined })
    expect(decodeClaims({ ...base, extra: "dropped" })).toEqual(base)
    await expect(signTicket({ ...base, computers: 9 }, (await ticketKeys()).privateKey)).rejects.toThrow()
  })

  test("malformed tickets are refused before any signature work", async () => {
    const keys = await importTicketKeys((await ticketKeys()).publicText)
    for (const ticket of ["", "vt1", "vt1.a", "vt2.abc.def", "vt1..x", `vt1.${"a".repeat(5000)}.b`, "vt1.@@.##"])
      expect(await verifyTicket(ticket, keys, NOW)).toEqual({ ok: false, reason: "malformed" })
  })

  test("the account's object name is an HMAC of the account, never the account itself", async () => {
    const handle = await accountHandle(ACCOUNT_KEY, ACCOUNT)
    expect(handle).toMatch(/^[0-9a-f]{64}$/)
    expect(handle).not.toContain(ACCOUNT)
    expect(await accountHandle(ACCOUNT_KEY, ACCOUNT)).toBe(handle!)
    expect(await accountHandle(ACCOUNT_KEY, `${ACCOUNT}x`)).not.toBe(handle!)
    expect(await accountHandle(`${ACCOUNT_KEY}x`, ACCOUNT)).not.toBe(handle!)
    expect(await accountHandle(undefined, ACCOUNT)).toBeUndefined()
    expect(await accountHandle("short-key", ACCOUNT)).toBeUndefined()
  })
})
