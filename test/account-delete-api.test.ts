import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { once } from "node:events"
import handler from "../api/account/delete"
import { accountTokensRevoked } from "../api/_lib/revocation"
import { mintCliToken, mintDeletionGrant } from "../api/_lib/cli-token"

const keys = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "NODE_ENV",
  "VERCEL_ENV",
  "STRIPE_SECRET_KEY",
  "CODIUM_STRIPE_MODE",
  "VECTOR_ACCESS_MODE",
  "VECTOR_CLI_TOKEN_SECRET",
] as const
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
const servers: ReturnType<typeof createServer>[] = []
let endpoint = ""
let accountID = ""
let identityDeletions = 0
let revocationWrites = 0
let revocationAvailable = false
// The persistent store's JSON commands, as the deletion grant's single use reads and writes them.
const store = new Map<string, string>()

beforeEach(async () => {
  keys.forEach((key) => delete process.env[key])
  const id = crypto.randomUUID()
  accountID = id
  identityDeletions = 0
  revocationWrites = 0
  revocationAvailable = false
  store.clear()
  const auth = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json")
    if (request.url === "/" && request.method === "POST") {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const command = JSON.parse(Buffer.concat(chunks).toString("utf8")) as string[]
      if (command[0] === "GET") {
        response.end(JSON.stringify({ result: store.get(command[1]!) ?? null }))
        return
      }
      if (command[0] === "SET") {
        if (!command.includes("NX") || !store.has(command[1]!)) store.set(command[1]!, command[2]!)
        response.end(JSON.stringify({ result: "OK" }))
        return
      }
      response.end(JSON.stringify({ result: [1, 60] }))
      return
    }
    if (request.url?.startsWith("/set/")) {
      revocationWrites++
      response.end(JSON.stringify(revocationAvailable ? { result: "OK" } : { error: "Redis write failed" }))
      return
    }
    if (request.url?.startsWith("/get/")) {
      response.end(JSON.stringify({ result: null }))
      return
    }
    if (request.method === "DELETE") {
      identityDeletions++
      response.end("{}")
      return
    }
    if (request.url !== "/auth/v1/user" || request.headers.authorization !== "Bearer test-session") {
      response.writeHead(401).end("{}")
      return
    }
    response.end(JSON.stringify({ id, email: "owner@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" }))
  })
  const api = createServer((request, response) => {
    void handler(request, response)
  })
  servers.push(auth, api)
  auth.listen(0, "127.0.0.1")
  api.listen(0, "127.0.0.1")
  await Promise.all([once(auth, "listening"), once(api, "listening")])
  const authAddress = auth.address()
  const apiAddress = api.address()
  if (!authAddress || typeof authAddress === "string" || !apiAddress || typeof apiAddress === "string")
    throw new Error("Missing test listeners")
  process.env.SUPABASE_URL = `http://127.0.0.1:${authAddress.port}`
  process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable"
  endpoint = `http://127.0.0.1:${apiAddress.port}`
})

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
  keys.forEach((key) => {
    const value = original[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
})

function attempt(confirm: string, authorization = "Bearer test-session") {
  return fetch(endpoint, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ confirm }),
  })
}

// Everything a full deletion needs, with the store and Supabase's admin API as local fakes.
function configureDeletion() {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role"
  process.env.KV_REST_API_URL = process.env.SUPABASE_URL
  process.env.KV_REST_API_TOKEN = "test-redis-token"
  process.env.VECTOR_CLI_TOKEN_SECRET = "test-cli-token-secret".repeat(3)
  revocationAvailable = true
}

describe("account deletion request boundary", () => {
  test("reads the confirmation and stops before mutations without an admin key", async () => {
    const response = await attempt("owner@example.com")
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "DELETION_NOT_CONFIGURED" } })
  })

  test("rejects the sixth attempt instead of swallowing the account rate limit", async () => {
    for (let index = 0; index < 5; index++) {
      const response = await attempt("wrong@example.com")
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: "CONFIRMATION_MISMATCH" } })
    }
    const response = await attempt("wrong@example.com")
    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({ error: { code: "RATE_LIMITED" } })
  })

  test("retains the account when Redis cannot durably revoke its tokens", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role"
    process.env.KV_REST_API_URL = process.env.SUPABASE_URL
    process.env.KV_REST_API_TOKEN = "test-redis-token"
    const response = await attempt("owner@example.com")
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "REVOCATION_FAILED" } })
    expect(revocationWrites).toBe(1)
    expect(identityDeletions).toBe(0)
    // A recovered Redis read with no key is valid only because the account
    // still exists; it must not resurrect tokens for a deleted identity.
    expect(await accountTokensRevoked(accountID)).toBe(false)
  })

  test("retains the account when paid billing cleanup is unavailable", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role"
    process.env.KV_REST_API_URL = process.env.SUPABASE_URL
    process.env.KV_REST_API_TOKEN = "test-redis-token"
    process.env.VECTOR_ACCESS_MODE = "paid"
    revocationAvailable = true
    // The account has a Codium billing record, and Stripe is not configured to close it. With no key and no
    // CODIUM_STRIPE_MODE, Codium's records live in the test namespace.
    store.set(`vector:codium:test:account:${accountID}`, JSON.stringify({ customer: "cus_fixture" }))
    const response = await attempt("owner@example.com")
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "BILLING_DELETION_FAILED" } })
    expect(revocationWrites).toBe(1)
    expect(identityDeletions).toBe(0)
  })
})

describe("deleting from the desktop app", () => {
  test("the app's long-lived account token cannot delete the account", async () => {
    configureDeletion()
    const response = await attempt(
      "owner@example.com",
      `Bearer ${mintCliToken({ id: accountID, email: "owner@example.com" }).token}`,
    )
    expect(response.status).toBe(401)
    expect(identityDeletions).toBe(0)
    expect(revocationWrites).toBe(0)
  })

  test("a deletion grant deletes the account once, after the typed email matches", async () => {
    configureDeletion()
    const { grant } = mintDeletionGrant({ id: accountID, email: "owner@example.com" })
    const mismatch = await attempt("someone@example.com", `Bearer ${grant}`)
    expect(mismatch.status).toBe(400)
    expect(await mismatch.json()).toMatchObject({ error: { code: "CONFIRMATION_MISMATCH" } })
    const response = await attempt("Owner@Example.com", `Bearer ${grant}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ deleted: true, email: "owner@example.com", cliTokens: "revoked" })
    expect(identityDeletions).toBe(1)
    const replay = await attempt("owner@example.com", `Bearer ${grant}`)
    expect(replay.status).toBe(401)
    expect(await replay.json()).toMatchObject({ error: { code: "DELETION_GRANT_USED" } })
    expect(identityDeletions).toBe(1)
  })

  test("a step that fails leaves the grant usable for a retry", async () => {
    configureDeletion()
    revocationAvailable = false
    const { grant } = mintDeletionGrant({ id: accountID, email: "owner@example.com" })
    const failed = await attempt("owner@example.com", `Bearer ${grant}`)
    expect(failed.status).toBe(503)
    expect(await failed.json()).toMatchObject({ error: { code: "REVOCATION_FAILED" } })
    revocationAvailable = true
    expect((await attempt("owner@example.com", `Bearer ${grant}`)).status).toBe(200)
    expect(identityDeletions).toBe(1)
  })

  test("an expired or forged grant is refused before anything changes", async () => {
    configureDeletion()
    const user = { id: accountID, email: "owner@example.com" }
    const expired = mintDeletionGrant(user, Date.now() - 11 * 60 * 1000).grant
    const forged = `vdg_${mintCliToken(user).token.slice(4)}`
    for (const grant of [expired, forged, `${mintDeletionGrant(user).grant}x`]) {
      const response = await attempt("owner@example.com", `Bearer ${grant}`)
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ error: { code: "DELETION_GRANT_INVALID" } })
    }
    expect(revocationWrites).toBe(0)
    expect(identityDeletions).toBe(0)
  })
})
