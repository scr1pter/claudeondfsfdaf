import { afterEach, beforeEach, expect, test } from "bun:test"
import { createECDH } from "node:crypto"
import type { ApiRequest, ApiResponse } from "../../../api/_lib/http"
import { pushSubscriptionId, pushSubscriptionsKey } from "../../../api/_lib/web-push"
import { handleNotifySubscribe } from "../../../api/notify/subscribe"
import { codiumFakes, codiumTestEnvironment } from "./fixture/codium-fakes"

const now = 1_795_516_000_000
const alice = "00000000-0000-4000-8000-000000000001"
const bob = "00000000-0000-4000-8000-000000000002"
const auth = "https://account.fixture.invalid"
const phone = "https://phone.fixture.invalid"
const endpoint = "https://web.push.apple.com/fixture"
const key = createECDH("prime256v1")
key.generateKeys()
const subscription = {
  endpoint,
  keys: { p256dh: key.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") },
}
const subscriptionId = pushSubscriptionId(endpoint)
let restore: () => void

beforeEach(() => {
  restore = codiumTestEnvironment({
    SUPABASE_URL: auth,
    SUPABASE_PUBLISHABLE_KEY: "fixture-publishable",
    VECTOR_PHONE_APP_ORIGIN: phone,
  })
})
afterEach(() => restore())

function fixture(expiresAt?: number) {
  const fake = codiumFakes({ now })
  fake.store.command([
    "HSET",
    pushSubscriptionsKey(alice),
    subscriptionId,
    JSON.stringify({ endpoint, id: subscriptionId, createdAt: now - 1000, ...subscription.keys, expiresAt }),
  ])
  const commands: string[][] = []
  const fetcher = (async (input, options) => {
    const url = String(input)
    if (url === `${auth}/auth/v1/user`) {
      const authorization = new Headers(options?.headers).get("authorization")
      const id = authorization === "Bearer fixture-alice" ? alice : authorization === "Bearer fixture-bob" ? bob : ""
      return id
        ? Response.json({ id, email: "confirmed@example.test", email_confirmed_at: "2026-11-01T00:00:00Z" })
        : Response.json({}, { status: 401 })
    }
    expect(url).toBe(process.env.KV_REST_API_URL!)
    commands.push(JSON.parse(String(options?.body)))
    return fake.fetcher(input, options)
  }) as typeof fetch
  const call = async (body: unknown, token?: string, origin = phone) => {
    const request = {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body,
    } as ApiRequest
    const headers = new Headers()
    let payload: unknown
    const response = {
      statusCode: 0,
      setHeader: (name: string, value: string) => headers.set(name, value),
      end: (body: string) => (payload = JSON.parse(body)),
    }
    await handleNotifySubscribe(request, response as unknown as ApiResponse, fetcher, () => now)
    return { status: response.statusCode, headers, payload }
  }
  return { commands, call }
}

test("only the same account and exact current endpoint and keys count as registered", async () => {
  const { commands, call } = fixture()
  const owner = await call({ check: subscription }, "fixture-alice")
  expect(owner.status).toBe(200)
  expect(owner.payload).toEqual({ subscribed: true })
  expect(owner.headers.get("cache-control")).toBe("no-store")
  expect((await call({ check: subscription }, "fixture-bob")).payload).toEqual({ subscribed: false })
  expect(
    (await call({ check: { ...subscription, endpoint: `${endpoint}-rotated` } }, "fixture-alice")).payload,
  ).toEqual({ subscribed: false })
  expect(
    (
      await call(
        { check: { ...subscription, keys: { ...subscription.keys, auth: Buffer.alloc(16, 2).toString("base64url") } } },
        "fixture-alice",
      )
    ).payload,
  ).toEqual({ subscribed: false })
  expect(commands.filter(([verb]) => verb !== "EVAL").map(([verb, key]) => [verb, key])).toEqual([
    ["HGET", pushSubscriptionsKey(alice)],
    ["HGET", pushSubscriptionsKey(bob)],
    ["HGET", pushSubscriptionsKey(alice)],
    ["HGET", pushSubscriptionsKey(alice)],
  ])
})

test("expired records, ambiguous requests and unauthenticated reads never enable alerts", async () => {
  const { commands, call } = fixture(now)
  expect((await call({ check: subscription }, "fixture-alice")).payload).toEqual({ subscribed: false })
  expect((await call({ check: subscription })).status).toBe(401)
  expect((await call({ check: subscription }, "fixture-alice", "https://other.fixture.invalid")).status).toBe(403)
  expect((await call({ check: subscription, subscription }, "fixture-alice")).status).toBe(400)
  expect(commands.filter(([verb]) => verb !== "EVAL")).toEqual([["HGET", pushSubscriptionsKey(alice), subscriptionId]])
})
