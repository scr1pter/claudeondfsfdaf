import { beforeEach, describe, expect, test } from "bun:test"
import { randomBytes, randomUUID } from "node:crypto"
import { GithubAgents } from "../packages/core/src/github-agents.js"
import { mintRunToken } from "../api/_lib/cloud-agents-run-token.js"
import {
  mintCliToken,
  mintDeletionGrant,
  verifyCliToken,
  verifyDeletionGrant,
  verifyDesktopToken,
} from "../api/_lib/cli-token.js"
import { ApiError } from "../api/_lib/http.js"

describe("cli tokens", () => {
  beforeEach(() => {
    process.env.VECTOR_LICENSE_SECRET = "a".repeat(48)
  })

  test("mint then verify round-trips the user", () => {
    const { token, expiresAt } = mintCliToken({ id: "3f2b9c9a-1111-4222-8333-444455556666", email: "k@vectordev.ai" })
    expect(token.startsWith("vct_")).toBe(true)
    expect(expiresAt).toBeGreaterThan(Date.now())
    const user = verifyCliToken(token)
    expect(user).toEqual({ id: "3f2b9c9a-1111-4222-8333-444455556666", email: "k@vectordev.ai" })
  })

  test("rejects tampered payloads", () => {
    const { token } = mintCliToken({ id: "u1", email: "k@vectordev.ai" })
    const [payload, signature] = token.slice(4).split(".")
    const forged = Buffer.from(
      JSON.stringify({ v: 1, sub: "someone-else", email: "x@y.z", exp: Date.now() + 1e9 }),
    ).toString("base64url")
    expect(() => verifyCliToken(`vct_${forged}.${signature}`)).toThrow(ApiError)
    expect(() => verifyCliToken(`vct_${payload}.AAAA`)).toThrow(ApiError)
  })

  test("rejects expired tokens with CLI_TOKEN_EXPIRED", () => {
    const { token } = mintCliToken({ id: "u1", email: "k@vectordev.ai" }, Date.now() - 91 * 24 * 60 * 60 * 1000)
    try {
      verifyCliToken(token)
      throw new Error("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).code).toBe("CLI_TOKEN_EXPIRED")
    }
  })

  test("rejects garbage", () => {
    for (const bad of ["", "vct_", "vct_x", "nope", "vct_a.b.c"]) {
      expect(() => verifyCliToken(bad)).toThrow(ApiError)
    }
  })

  test("only a token marked as the desktop app's own passes for it, and the mark changes nothing else", () => {
    const user = { id: "u1", email: "k@vectordev.ai" }
    const desktop = mintCliToken(user, Date.now(), "desktop").token
    expect(verifyDesktopToken(desktop)).toEqual(user)
    expect(verifyCliToken(desktop)).toEqual(user)
    const pasted = mintCliToken(user).token
    expect(verifyCliToken(pasted)).toEqual(user)
    expect(() => verifyDesktopToken(pasted)).toThrow(
      expect.objectContaining({ statusCode: 403, code: "DESKTOP_SIGN_IN_REQUIRED" }),
    )
    // An expired or forged desktop token is refused as any CLI token is.
    expect(() => verifyDesktopToken(mintCliToken(user, Date.now() - 91 * 86_400_000, "desktop").token)).toThrow(
      expect.objectContaining({ code: "CLI_TOKEN_EXPIRED" }),
    )
    expect(() => verifyDesktopToken(`${desktop}x`)).toThrow(expect.objectContaining({ code: "CLI_TOKEN_INVALID" }))
    expect(() => verifyDesktopToken(mintDeletionGrant(user).grant)).toThrow(ApiError)
  })

  test("refuses to mint without a configured secret", () => {
    process.env.VECTOR_LICENSE_SECRET = "short"
    expect(() => mintCliToken({ id: "u1", email: "k@vectordev.ai" })).toThrow(ApiError)
  })

  test("a run token is refused by verifyCliToken", () => {
    // Both kinds of token then derive their key from the one license secret, each for its own purpose.
    const dedicated = process.env.VECTOR_RUN_TOKEN_SECRET
    delete process.env.VECTOR_RUN_TOKEN_SECRET
    try {
      const now = Date.now()
      const repositoryId = "123456789"
      const token = mintRunToken({
        sub: randomUUID(),
        rid: GithubAgents.runId(repositoryId, 9_876_543_210, 1, 55_555_555_555),
        repo: repositoryId,
        thr: "12",
        gen: 1,
        src: "github-comment",
        pur: "task",
        epoch: `p${now - 86_400_000}`,
        dl: now + 30 * 60_000,
        iat: now,
        jti: randomBytes(16).toString("base64url"),
      }).token
      expect(token).toStartWith("vrt_")
      const invalid = expect.objectContaining({ statusCode: 401, code: "CLI_TOKEN_INVALID" })
      for (const presented of [token, `vct_${token.slice(4)}`]) {
        expect(() => verifyCliToken(presented)).toThrow(invalid)
        expect(() => verifyDesktopToken(presented)).toThrow(invalid)
      }
    } finally {
      dedicated === undefined
        ? delete process.env.VECTOR_RUN_TOKEN_SECRET
        : (process.env.VECTOR_RUN_TOKEN_SECRET = dedicated)
    }
  })
})

describe("deletion grants", () => {
  const user = { id: "3f2b9c9a-1111-4222-8333-444455556666", email: "k@vectordev.ai" }
  beforeEach(() => {
    process.env.VECTOR_LICENSE_SECRET = "a".repeat(48)
  })

  test("last ten minutes and name a single use", () => {
    const now = Date.now()
    const first = mintDeletionGrant(user, now)
    expect(first.grant).toStartWith("vdg_")
    expect(first.expiresAt).toBe(now + 10 * 60 * 1000)
    const verified = verifyDeletionGrant(first.grant, now)
    expect(verified).toMatchObject({ ...user, expiresAt: first.expiresAt })
    expect(verified.jti).not.toBe(verifyDeletionGrant(mintDeletionGrant(user, now).grant, now).jti)
    expect(() => verifyDeletionGrant(first.grant, first.expiresAt)).toThrow(ApiError)
  })

  test("and CLI tokens never pass for each other", () => {
    const { grant } = mintDeletionGrant(user)
    const { token } = mintCliToken(user)
    expect(() => verifyCliToken(grant)).toThrow(ApiError)
    expect(() => verifyCliToken(`vct_${grant.slice(4)}`)).toThrow(ApiError)
    expect(() => verifyDeletionGrant(token)).toThrow(ApiError)
    expect(() => verifyDeletionGrant(`vdg_${token.slice(4)}`)).toThrow(ApiError)
  })
})
