import { afterAll, beforeAll, expect, test } from "bun:test"
import { createServer } from "node:http"
import handler from "../../../api/account/delete"

const identity = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    expect(new URL(request.url).pathname).toBe("/auth/v1/user")
    expect(request.method).toBe("GET")
    return Response.json({
      id: "11111111-1111-4111-8111-111111111111",
      email: "fixture@example.test",
      email_confirmed_at: "2026-01-01T00:00:00Z",
    })
  },
})
const server = createServer((request, response) => void handler(request, response))
const state = { origin: "" }
const variables = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "NODE_ENV",
  "VERCEL_ENV",
]

beforeAll(async () => {
  variables.forEach((key) => delete process.env[key])
  process.env.NODE_ENV = "development"
  process.env.SUPABASE_URL = identity.url.origin
  process.env.SUPABASE_PUBLISHABLE_KEY = "fixture-public-key"
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No fixture address")
  state.origin = `http://127.0.0.1:${address.port}`
})
afterAll(() => {
  server.closeAllConnections()
  server.close()
  identity.stop(true)
  variables.forEach((key) => delete process.env[key])
})

test("deletion reads the confirmation body and reaches no destructive step without admin configuration", async () => {
  for (const [confirm, status, code] of [
    ["another@example.test", 400, "CONFIRMATION_MISMATCH"],
    ["fixture@example.test", 503, "DELETION_NOT_CONFIGURED"],
  ] as const) {
    const response = await fetch(state.origin, {
      method: "POST",
      headers: { authorization: "Bearer synthetic-session", "content-type": "application/json" },
      body: JSON.stringify({ confirm }),
    })
    expect(response.status).toBe(status)
    expect((await response.json()).error.code).toBe(code)
  }
})

test("the account page warns that deletion ends any Codium plan and what is left of its month", async () => {
  // cancelModelPlanAccount cancels the account's subscriptions and disables its keys before the identity goes.
  const page = (
    await Bun.file(new URL("../src/components/marketing/account/AccountPage.tsx", import.meta.url)).text()
  ).replace(/\s+/g, " ")
  expect(page).toContain("stops the CLI tokens this account has issued.")
  expect(page).toContain("Any Vector Codium plan ends at once, and what is left of this month can no longer be used.")
  // Codium sells monthly plans only (A29): the warning names no credits and no purchased top-ups.
  expect(page).not.toMatch(/credits|purchased/i)
})

test("in production, deletion without the token store stops before anything is destroyed", async () => {
  // The CLI-token revocation list lives in the same store as the rate limit, which production requires, so a
  // deletion that succeeds there has always stopped the account's CLI tokens, as the account pages say.
  process.env.NODE_ENV = "production"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service-role"
  const response = await fetch(state.origin, {
    method: "POST",
    headers: { authorization: "Bearer synthetic-session", "content-type": "application/json" },
    body: JSON.stringify({ confirm: "fixture@example.test" }),
  })
  process.env.NODE_ENV = "development"
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  expect(response.status).toBe(503)
  expect((await response.json()).error.code).toBe("ABUSE_PROTECTION_UNAVAILABLE")
})
