import { afterEach, beforeEach, expect, test } from "bun:test"
import { createECDH, createHash } from "node:crypto"
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
function lookup(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) {
  const { endpoint, keys } = subscription
  return {
    id: pushSubscriptionId(endpoint),
    fingerprint: createHash("sha256")
      .update(JSON.stringify(["vector-phone-push-v1", endpoint, keys.p256dh, keys.auth]))
      .digest("hex"),
  }
}
const check = lookup(subscription)
let restore: () => void

beforeEach(() => {
  restore = codiumTestEnvironment({
    SUPABASE_URL: auth,
    SUPABASE_PUBLISHABLE_KEY: "fixture-publishable",
    VECTOR_PHONE_APP_ORIGIN: phone,
  })
})
afterEach(() => restore())

function fixture(expiresAt?: number, afterRead = now) {
  const fake = codiumFakes({ now })
  let currentTime = now
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
    const command = JSON.parse(String(options?.body)) as string[]
    commands.push(command)
    if (command[0] === "HGET") currentTime = afterRead
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
    await handleNotifySubscribe(request, response as unknown as ApiResponse, fetcher, () => currentTime)
    return { status: response.statusCode, headers, payload }
  }
  return { commands, call }
}

test("only the same account and exact current endpoint and keys count as registered", async () => {
  const { commands, call } = fixture()
  const owner = await call({ check }, "fixture-alice")
  expect(owner.status).toBe(200)
  expect(owner.payload).toEqual({ subscribed: true })
  expect(owner.headers.get("cache-control")).toBe("no-store")
  expect((await call({ check }, "fixture-bob")).payload).toEqual({ subscribed: false })
  expect(
    (await call({ check: lookup({ ...subscription, endpoint: `${endpoint}-rotated` }) }, "fixture-alice")).payload,
  ).toEqual({ subscribed: false })
  expect(
    (
      await call(
        {
          check: lookup({
            ...subscription,
            keys: { ...subscription.keys, auth: Buffer.alloc(16, 2).toString("base64url") },
          }),
        },
        "fixture-alice",
      )
    ).payload,
  ).toEqual({ subscribed: false })
  expect(commands.filter(([verb]) => verb !== "EVAL")).toEqual([
    ["HGET", pushSubscriptionsKey(alice), subscriptionId],
    ["HGET", pushSubscriptionsKey(bob), subscriptionId],
    ["HGET", pushSubscriptionsKey(alice), pushSubscriptionId(`${endpoint}-rotated`)],
    ["HGET", pushSubscriptionsKey(alice), subscriptionId],
  ])
  // Passive checks count against their own limit, so they never use up the registration budget.
  const limits = commands.filter(([verb]) => verb === "EVAL").map(([, , , key]) => key.split(":").slice(0, 3).join(":"))
  expect(limits).toHaveLength(4)
  expect(new Set(limits)).toEqual(new Set(["vector:abuse:notify-subscribe-check"]))
})

test("expired records, raw passive data and unauthorized or malformed requests never enable alerts", async () => {
  const { commands, call } = fixture(now)
  expect((await call({ check }, "fixture-alice")).payload).toEqual({ subscribed: false })
  expect((await call({ check })).status).toBe(401)
  expect((await call({ check }, "fixture-alice", "https://other.fixture.invalid")).status).toBe(403)
  for (const body of [
    { check, subscription },
    { check: subscription },
    { check: { ...check, ...subscription } },
    { check: { ...check, id: `${check.id}\n` } },
    { check: { ...check, fingerprint: check.fingerprint.toUpperCase() } },
    { check: { ...check, fingerprint: `${check.fingerprint}\n` } },
  ])
    expect((await call(body, "fixture-alice")).status).toBe(400)
  expect(commands.filter(([verb]) => verb !== "EVAL")).toEqual([["HGET", pushSubscriptionsKey(alice), subscriptionId]])
})

test("a record that expires during the account lookup reads as unregistered", async () => {
  const { call } = fixture(now + 100, now + 100)
  expect((await call({ check }, "fixture-alice")).payload).toEqual({ subscribed: false })
})
