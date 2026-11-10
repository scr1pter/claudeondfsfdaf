import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ApiRequest, ApiResponse } from "../api/_lib/http"
import { handleAccountStatus } from "../api/account/status"

const variables = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_ANON_KEY",
  "VECTOR_ADMIN_EMAILS",
  "VECTOR_DESIGN_LAB_EMAILS",
]
const original = Object.fromEntries(variables.map((key) => [key, process.env[key]]))

beforeEach(() => {
  variables.forEach((key) => delete process.env[key])
  process.env.SUPABASE_URL = "https://vector.supabase.co"
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_vector"
})

afterEach(() => {
  Object.entries(original).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
})

const ID = "9db2bb31-81d5-43cb-b4a1-f1d3d799c9cb"

// Supabase's /auth/v1/user for a confirmed account with this address, or a rejected session.
function supabase(email?: string) {
  return (() =>
    Promise.resolve(
      email
        ? Response.json({ id: ID, email, email_confirmed_at: "2026-09-01T12:00:00.000Z" })
        : new Response(null, { status: 401 }),
    )) as unknown as typeof fetch
}

function status(fetcher: typeof fetch, request: Partial<ApiRequest> = {}) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const response = {
      statusCode: 200,
      setHeader() {
        return this
      },
      end(value?: string) {
        resolve({ status: this.statusCode, body: value ? JSON.parse(value) : {} })
        return this
      },
    } as unknown as ApiResponse
    const merged = { method: "GET", headers: { authorization: "Bearer session" }, ...request } as ApiRequest
    void handleAccountStatus(merged, response, fetcher).catch(reject)
  })
}

describe("account status", () => {
  test("answers whether the account is on the Design Lab allowlist, as a boolean beside the user", async () => {
    process.env.VECTOR_DESIGN_LAB_EMAILS = " Owner@Example.com , second@example.com"
    expect(await status(supabase("OWNER@example.com"))).toEqual({
      status: 200,
      body: { user: { id: ID, email: "owner@example.com" }, owner: true },
    })
    expect(await status(supabase("second@example.com"))).toMatchObject({ status: 200, body: { owner: true } })
    expect(await status(supabase("user@example.com"))).toEqual({
      status: 200,
      body: { user: { id: ID, email: "user@example.com" }, owner: false },
    })
  })

  // The answer only shows the Design tab, so it follows the list /design opens the lab for, not the usage dashboard's.
  test("follows the Design Lab owners whatever the admin allowlist says", async () => {
    process.env.VECTOR_DESIGN_LAB_EMAILS = "designer@example.com"
    expect(await status(supabase("designer@example.com"))).toMatchObject({ body: { owner: true } })
    process.env.VECTOR_ADMIN_EMAILS = "admin@example.com"
    expect(await status(supabase("admin@example.com"))).toMatchObject({ body: { owner: false } })
    expect(await status(supabase("designer@example.com"))).toMatchObject({ body: { owner: true } })
  })

  test("an ordinary account is not the owner when no allowlist is configured", async () => {
    expect(await status(supabase("user@example.com"))).toMatchObject({ status: 200, body: { owner: false } })
  })

  test("answers nothing about ownership without a valid session", async () => {
    process.env.VECTOR_DESIGN_LAB_EMAILS = "owner@example.com"
    const signedOut = await status(supabase("owner@example.com"), { headers: {} })
    expect(signedOut.status).toBe(401)
    expect(signedOut.body).not.toHaveProperty("owner")
    const expired = await status(supabase())
    expect(expired.status).toBe(401)
    expect(expired.body).not.toHaveProperty("owner")
    const posted = await status(supabase("owner@example.com"), { method: "POST" })
    expect(posted.status).toBe(405)
    expect(posted.body).not.toHaveProperty("owner")
  })
})
