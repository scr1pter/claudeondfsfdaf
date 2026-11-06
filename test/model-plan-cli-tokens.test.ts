import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { createHash, createHmac, randomBytes } from "node:crypto"
import { Readable } from "node:stream"
import {
  mintCliToken,
  mintDeletionGrant,
  verifyCliToken,
  verifyCliTokenClaims,
  verifyDeletionGrant,
  verifyDesktopToken,
} from "../api/_lib/cli-token"
import { mintDesktopCode, consumeDesktopCode } from "../api/_lib/desktop-account"
import { requireUnrevokedCliToken, revokeCliToken } from "../api/_lib/revocation"
import { handleCliExchange } from "../api/account/cli-exchange"
import { handleCliToken } from "../api/account/cli-token"
import type { ApiRequest, ApiResponse } from "../api/_lib/http"

const now = Date.UTC(2026, 9, 29, 12)
const user = { id: "11111111-1111-4111-8111-111111111111", email: "cli@example.test" }
const other = { id: "22222222-2222-4222-8222-222222222222", email: "other@example.test" }
const kv = "https://kv.cli-fixture.test"
const auth = "https://auth.cli-fixture.test"
const signingSecret = "synthetic-cli-signing-secret".repeat(2)
const settings = {
  KV_REST_API_URL: kv,
  KV_REST_API_TOKEN: "synthetic-kv",
  VECTOR_CLI_TOKEN_SECRET: signingSecret,
  VECTOR_ABUSE_SECRET: "synthetic-cli-abuse-secret".repeat(2),
  VECTOR_PUBLIC_URL: "https://vectordev.ai",
  SUPABASE_URL: auth,
  SUPABASE_PUBLISHABLE_KEY: "synthetic-public",
}
const previous = Object.fromEntries(Object.keys(settings).map((name) => [name, process.env[name]]))
beforeEach(() => Object.assign(process.env, settings))
afterEach(() => {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function fixture() {
  const records = new Map<string, string>()
  const commands: (string | number)[][] = []
  const state = { unavailable: false }
  const fetcher: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.origin === auth && url.pathname === "/auth/v1/user")
        return new Headers(init?.headers).get("authorization") === "Bearer fixture-session"
          ? Response.json({ ...user, email_confirmed_at: "2026-01-01T00:00:00Z" })
          : new Response(null, { status: 401 })
      if (url.origin !== kv) throw new Error("Unexpected non-fixture provider request.")
      if (state.unavailable) return new Response(null, { status: 503 })
      const command = JSON.parse(String(init?.body)) as (string | number)[]
      commands.push(command)
      const key = String(command[1])
      if (command[0] === "GET") return Response.json({ result: records.get(key) ?? null })
      if (command[0] === "SET") {
        if (command.includes("NX") && records.has(key)) return Response.json({ result: null })
        records.set(key, String(command[2]))
        return Response.json({ result: "OK" })
      }
      if (command[0] !== "EVAL") throw new Error("Unexpected fixture store command.")
      if (String(command[1]).includes("'INCR'")) return Response.json({ result: [1, 300] })
      const codeKey = String(command[3])
      const raw = records.get(codeKey)
      if (!raw) return Response.json({ result: null })
      const saved = JSON.parse(raw)
      if (
        saved.state !== command[4] ||
        saved.challenge !== command[5] ||
        saved.expiresAt <= Number(command[6]) ||
        (saved.purpose !== undefined && saved.purpose !== "cli" && saved.purpose !== "delete")
      )
        return Response.json({ result: null })
      records.delete(codeKey)
      return Response.json({ result: raw })
    },
    { preconnect: () => {} },
  )
  return { records, commands, state, fetcher }
}

function binding() {
  const verifier = randomBytes(32).toString("base64url")
  return {
    verifier,
    state: randomBytes(32).toString("base64url"),
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  }
}

async function call(
  handler: typeof handleCliExchange,
  fakes: ReturnType<typeof fixture>,
  body: unknown,
  authorization = "Bearer fixture-session",
) {
  const request = Object.assign(Readable.from([]), {
    method: "POST",
    headers: { authorization, "content-type": "application/json", origin: "https://vectordev.ai" },
    body,
  }) as ApiRequest
  const result = { status: 200, body: {} as Record<string, unknown> }
  const response = {
    statusCode: 200,
    setHeader() {
      return this
    },
    end(value?: string) {
      result.status = this.statusCode
      result.body = value ? JSON.parse(value) : {}
      return this
    },
  } as unknown as ApiResponse
  await handler(request, response, fakes.fetcher, now)
  return result
}

function signedClaims(overrides: Record<string, unknown>) {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, sub: user.id, email: user.email, exp: now + 60_000, ...overrides }),
  ).toString("base64url")
  return `vct_${payload}.${createHmac("sha256", signingSecret).update(`vector-cli-v1.${payload}`).digest("base64url")}`
}

describe("A16 signed CLI credentials", () => {
  test("CLI mints have fresh IDs while user projections and desktop-only billing stay compatible", () => {
    const first = mintCliToken(user, now, "cli")
    const second = mintCliToken(user, now, "cli")
    expect(verifyCliTokenClaims(first.token, now)).toMatchObject({ ...user, client: "cli", expiresAt: first.expiresAt })
    expect(verifyCliTokenClaims(first.token, now).jti).not.toBe(verifyCliTokenClaims(second.token, now).jti)
    expect(verifyCliToken(first.token, now)).toEqual(user)
    expect(() => verifyDesktopToken(first.token, now)).toThrow(
      expect.objectContaining({ code: "DESKTOP_SIGN_IN_REQUIRED" }),
    )
    expect(verifyDesktopToken(mintCliToken(user, now, "desktop").token, now)).toEqual(user)
    expect(verifyCliTokenClaims(mintCliToken(user, now).token, now)).toEqual({ ...user, expiresAt: first.expiresAt })
  })

  test("the shared parser rejects additional segments and keeps deletion grants in their own domain", () => {
    const token = mintCliToken(user, now, "cli").token
    const grant = mintDeletionGrant(user, now).grant
    for (const suffix of [".", ".ignored", "..", ".ignored.more"]) {
      expect(() => verifyCliToken(token + suffix, now)).toThrow()
      expect(() => verifyDeletionGrant(grant + suffix, now)).toThrow()
    }
    expect(() => verifyCliToken(grant, now)).toThrow()
    expect(() => verifyDeletionGrant(token, now)).toThrow()
    expect(() => verifyCliTokenClaims(token, now + 90 * 86_400_000)).toThrow(
      expect.objectContaining({ code: "CLI_TOKEN_EXPIRED" }),
    )
  })

  test.each([
    { client: "cli" },
    { client: "CLI" },
    { client: null },
    { client: "cli", jti: "invalid" },
    { client: "cli", jti: "a".repeat(22) },
    { jti: 1 },
    { exp: null },
    { exp: 0.5 },
    { exp: -1 },
  ])("refuses malformed signed claims %j", (claims) => {
    expect(() => verifyCliTokenClaims(signedClaims(claims), now)).toThrow(
      expect.objectContaining({ code: "CLI_TOKEN_INVALID" }),
    )
  })
})

describe("A16 authoritative saved PKCE purpose", () => {
  test("saved cli, desktop and delete purposes cannot be upgraded or changed in the exchange body", async () => {
    for (const purpose of [undefined, "cli", "delete"] as const) {
      const fakes = fixture()
      const input = binding()
      const minted = await mintDesktopCode(user, { ...input, ...(purpose ? { purpose } : {}) }, fakes.fetcher, now)
      const raw = [...fakes.records.values()][0]!
      expect(JSON.parse(raw).purpose).toBe(purpose)
      const result = await call(handleCliExchange, fakes, {
        ...input,
        code: minted.code,
        purpose: purpose === "cli" ? "delete" : "cli",
        client: "cli",
      })
      expect(result.status).toBe(200)
      if (purpose === "delete") {
        expect(result.body.token).toBeUndefined()
        expect(verifyDeletionGrant(String(result.body.grant), now)).toMatchObject(user)
        continue
      }
      expect(result.body.grant).toBeUndefined()
      const claims = verifyCliTokenClaims(String(result.body.token), now)
      expect(claims.client).toBe(purpose === "cli" ? "cli" : "desktop")
      expect(Boolean(claims.jti)).toBe(purpose === "cli")
    }
  })

  test("an invalid saved purpose fails instead of silently minting a desktop credential", async () => {
    for (const purpose of ["desktop", "sign-in", "CLI", "", false, null, {}]) {
      const fakes = fixture()
      const input = binding()
      const minted = await mintDesktopCode(user, { ...input, purpose: "cli" }, fakes.fetcher, now)
      const [key, raw] = [...fakes.records.entries()][0]!
      fakes.records.set(key, JSON.stringify({ ...JSON.parse(raw), purpose }))
      expect(await call(handleCliExchange, fakes, { ...input, code: minted.code })).toMatchObject({
        status: 400,
        body: { error: { code: "DESKTOP_CODE_INVALID" } },
      })
    }
  })

  test("invalid mint purposes, wrong PKCE and concurrent replay never mint an extra marked token", async () => {
    const fakes = fixture()
    const input = binding()
    for (const purpose of ["desktop", "sign-in", "CLI", null])
      await expect(mintDesktopCode(user, { ...input, purpose }, fakes.fetcher, now)).rejects.toThrow()
    const minted = await mintDesktopCode(user, { ...input, purpose: "cli" }, fakes.fetcher, now)
    expect(
      (await call(handleCliExchange, fakes, { ...input, code: minted.code, verifier: binding().verifier })).status,
    ).toBe(400)
    const results = await Promise.all([
      call(handleCliExchange, fakes, { ...input, code: minted.code }),
      call(handleCliExchange, fakes, { ...input, code: minted.code }),
    ])
    expect(results.map((result) => result.status).sort()).toEqual([200, 400])
  })

  test("public token issuance ignores body upgrades and remains unmarked", async () => {
    const fakes = fixture()
    const result = await call(handleCliToken, fakes, {
      purpose: "cli",
      client: "cli",
      jti: randomBytes(16).toString("base64url"),
    })
    expect(result.status).toBe(200)
    expect(verifyCliTokenClaims(String(result.body.token), now)).toEqual({ ...user, expiresAt: now + 90 * 86_400_000 })
    expect((await call(handleCliToken, fakes, {}, "Bearer invalid")).status).toBe(401)
  })
})

describe("A16 account-scoped token revocation", () => {
  test("a single revoked ID leaves sibling tokens and the same ID under another account alone", async () => {
    const fakes = fixture()
    const first = mintCliToken(user, now, "cli")
    const sibling = mintCliToken(user, now, "cli")
    const claims = verifyCliTokenClaims(first.token, now)
    await revokeCliToken(other.id, claims.jti!, claims.expiresAt, fakes.fetcher, now)
    expect(await requireUnrevokedCliToken(first.token, fakes.fetcher, now)).toMatchObject(user)
    await revokeCliToken(claims.id, claims.jti!, claims.expiresAt, fakes.fetcher, now)
    await expect(requireUnrevokedCliToken(first.token, fakes.fetcher, now)).rejects.toMatchObject({
      code: "CLI_TOKEN_INVALID",
    })
    expect(await requireUnrevokedCliToken(sibling.token, fakes.fetcher, now)).toMatchObject(user)
    expect(JSON.stringify(fakes.commands)).not.toContain(first.token)
    expect(JSON.stringify(fakes.commands)).not.toContain(user.email)
  })

  test("trusted repeated revocation replaces a shorter TTL using the token's signed immutable expiry", async () => {
    const fakes = fixture()
    const claims = verifyCliTokenClaims(mintCliToken(user, now, "cli").token, now)
    await revokeCliToken(claims.id, claims.jti!, claims.expiresAt, fakes.fetcher, now)
    await revokeCliToken(claims.id, claims.jti!, claims.expiresAt, fakes.fetcher, now + 1500)
    const writes = fakes.commands.filter((command) => command[0] === "SET")
    expect(writes).toHaveLength(2)
    expect(writes[0]?.slice(2)).toEqual(["1", "EX", 90 * 86_400])
    expect(writes[1]?.slice(2)).toEqual(["1", "EX", Math.ceil((claims.expiresAt - now - 1500) / 1000)])
    expect(writes.every((command) => !command.includes("NX"))).toBe(true)
  })

  test("account deletion revokes legacy, desktop and CLI credentials and storage failures fail closed", async () => {
    const fakes = fixture()
    fakes.records.set(`vector:cli-revoked:${user.id}`, "1")
    for (const client of [undefined, "desktop", "cli"] as const)
      await expect(
        requireUnrevokedCliToken(mintCliToken(user, now, client).token, fakes.fetcher, now),
      ).rejects.toMatchObject({ code: "CLI_TOKEN_INVALID" })
    fakes.records.clear()
    fakes.state.unavailable = true
    const minted = mintCliToken(user, now, "cli")
    const claims = verifyCliTokenClaims(minted.token, now)
    await expect(requireUnrevokedCliToken(minted.token, fakes.fetcher, now)).rejects.toMatchObject({ statusCode: 503 })
    await expect(revokeCliToken(claims.id, claims.jti!, claims.expiresAt, fakes.fetcher, now)).rejects.toMatchObject({
      statusCode: 503,
    })
  })

  test("invalid IDs/expiries never write; already expired credentials need no revocation record", async () => {
    const fakes = fixture()
    const jti = verifyCliTokenClaims(mintCliToken(user, now, "cli").token, now).jti!
    for (const account of ["", "not-an-account", `${user.id}:another`])
      await expect(revokeCliToken(account, jti, now + 1000, fakes.fetcher, now)).rejects.toMatchObject({
        statusCode: 400,
      })
    for (const invalid of ["", "bad", `${jti}:other`])
      await expect(revokeCliToken(user.id, invalid, now + 1000, fakes.fetcher, now)).rejects.toMatchObject({
        statusCode: 400,
      })
    for (const expiry of [NaN, Infinity, -1, now + 0.5])
      await expect(revokeCliToken(user.id, jti, expiry, fakes.fetcher, now)).rejects.toMatchObject({ statusCode: 400 })
    await revokeCliToken(user.id, jti, now, fakes.fetcher, now)
    expect(fakes.commands).toEqual([])
  })
})

const valkeyURL = process.env.VECTOR_TEST_REDIS_URL
describe.skipIf(!valkeyURL)("A16 PKCE purpose Lua on Valkey", () => {
  test("a malformed saved purpose cannot consume its code, and concurrent valid exchanges have one winner", async () => {
    const redis = new RedisClient(valkeyURL!, { autoReconnect: false })
    const keys: string[] = []
    const fetcher: typeof fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const command = JSON.parse(String(init?.body)) as (string | number)[]
        const result = await redis.send(String(command[0]), command.slice(1).map(String))
        return Response.json({ result })
      },
      { preconnect: () => {} },
    )
    try {
      const input = binding()
      const minted = await mintDesktopCode(user, { ...input, purpose: "cli" }, fetcher, now)
      const key = `vector:desktop-sign-in:${createHash("sha256").update(minted.code).digest("hex")}`
      keys.push(key)
      const raw = String(await redis.send("GET", [key]))
      await redis.send("SET", [key, JSON.stringify({ ...JSON.parse(raw), purpose: "invalid" }), "EX", "300"])
      await expect(consumeDesktopCode({ ...input, code: minted.code }, fetcher, now)).rejects.toThrow()
      expect(await redis.send("GET", [key])).not.toBeNull()
      await redis.send("SET", [key, raw, "EX", "300"])
      const results = await Promise.allSettled([
        consumeDesktopCode({ ...input, code: minted.code }, fetcher, now),
        consumeDesktopCode({ ...input, code: minted.code }, fetcher, now),
      ])
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
      const token = mintCliToken(user, now, "cli").token
      const sibling = mintCliToken(user, now, "cli").token
      const claims = verifyCliTokenClaims(token, now)
      keys.push(`vector:cli-revoked:${claims.id}:token:${claims.jti}`)
      await requireUnrevokedCliToken(token, fetcher, now)
      await revokeCliToken(claims.id, claims.jti!, claims.expiresAt, fetcher, now)
      await expect(requireUnrevokedCliToken(token, fetcher, now)).rejects.toMatchObject({ statusCode: 401 })
      expect((await requireUnrevokedCliToken(sibling, fetcher, now)).id).toBe(user.id)
    } finally {
      for (const key of keys) await redis.send("DEL", [key])
      redis.close()
    }
  })
})
