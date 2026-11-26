import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { PhoneApiError } from "./api"
import { base64url } from "./auth"
import {
  alertsErrorText,
  alertsState,
  turnOffAlerts,
  turnOnAlerts,
  type PushDeps,
  type PushManagerLike,
  type SubscriptionLike,
} from "./push"

// WP A38: turning alerts on subscribes the browser with the server's VAPID key and registers the phone with A37's
// /api/notify/subscribe; turning them off unsubscribes first. These run against fakes of the browser and the API.

const session = { accessToken: "session-token", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }
const serverKey = new Uint8Array(65).fill(4)

function lookup(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) {
  const { endpoint, keys } = subscription
  return {
    id: createHash("sha256").update(endpoint).digest("base64url").slice(0, 22),
    fingerprint: createHash("sha256")
      .update(JSON.stringify(["vector-phone-push-v1", endpoint, keys.p256dh, keys.auth]))
      .digest("hex"),
  }
}

function subscription(endpoint: string, key: Uint8Array = serverKey, auth = "a") {
  const value: SubscriptionLike & { unsubscribed: boolean } = {
    endpoint,
    unsubscribed: false,
    options: { applicationServerKey: key.slice().buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth } }),
    unsubscribe: async () => {
      value.unsubscribed = true
      return true
    },
  }
  return value
}

function fakes(
  options: {
    permission?: "default" | "denied" | "granted"
    grant?: "granted" | "denied"
    existing?: SubscriptionLike
    post?: number
    check?: () => void
    checkError?: boolean
  } = {},
) {
  let permission = options.permission ?? "default"
  let current: SubscriptionLike | null = options.existing ?? null
  const created: ReturnType<typeof subscription>[] = []
  const calls: { url: string; method: string; body?: unknown; authorization?: string }[] = []
  const registered = new Map<string, ReturnType<typeof lookup>>()
  const manager: PushManagerLike = {
    getSubscription: async () => current,
    subscribe: async (input) => {
      expect(input.userVisibleOnly).toBe(true)
      expect([...input.applicationServerKey]).toEqual([...serverKey])
      const made = subscription("https://fcm.googleapis.com/fcm/send/new")
      created.push(made)
      current = made
      return made
    },
  }
  const deps: PushDeps = {
    fetcher: async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({
        url,
        method: init?.method ?? "GET",
        ...(body ? { body } : {}),
        ...(headers.authorization ? { authorization: headers.authorization } : {}),
      })
      if ((init?.method ?? "GET") === "GET")
        return new Response(JSON.stringify({ publicKey: base64url(serverKey) }), {
          headers: { "content-type": "application/json" },
        })
      if (body?.check) {
        options.check?.()
        if (options.checkError) return Response.json({}, { status: 503 })
        return Response.json({
          subscribed: JSON.stringify(registered.get(headers.authorization)) === JSON.stringify(body.check),
        })
      }
      const status = init?.method === "POST" ? (options.post ?? 200) : 200
      if (init?.method === "POST" && status === 200) registered.set(headers.authorization, lookup(body.subscription))
      return new Response(
        JSON.stringify(
          status === 200 ? { subscribed: true } : { error: { code: "MODEL_PLAN_REQUIRED", message: "x" } },
        ),
        { status, headers: { "content-type": "application/json" } },
      )
    },
    pushManager: async () => manager,
    permission: () => permission,
    requestPermission: async () => {
      permission = options.grant ?? "granted"
      return permission
    },
  }
  return { deps, calls, created, replace: (subscription: SubscriptionLike | null) => (current = subscription) }
}

describe("checking alert status", () => {
  const endpoint = "https://fcm.googleapis.com/fcm/send/current"

  test("granted browser permission and an existing subscription do not turn alerts on for an unregistered account", async () => {
    const { deps, calls } = fakes({ permission: "granted", existing: subscription(endpoint) })
    expect(await alertsState(deps, session)).toBe("off")
    expect(calls).toEqual([
      {
        url: "/api/notify/subscribe",
        method: "POST",
        body: { check: lookup({ endpoint, keys: { p256dh: "p", auth: "a" } }) },
        authorization: "Bearer session-token",
      },
    ])
  })

  test("changed endpoint or keys stay off until an explicit registration for the same account", async () => {
    const { deps, calls, replace, created } = fakes({ permission: "granted", existing: subscription(endpoint) })
    await turnOnAlerts(session, deps)
    expect(await alertsState(deps, session)).toBe("on")
    expect(await alertsState(deps, { ...session, accessToken: "another-session" })).toBe("off")
    replace(subscription(endpoint, serverKey, "new key"))
    expect(await alertsState(deps, session)).toBe("off")
    replace(subscription(`${endpoint}-rotated`))
    expect(await alertsState(deps, session)).toBe("off")
    expect(
      calls.filter((call) => call.body && typeof call.body === "object" && Object.hasOwn(call.body, "subscription")),
    ).toHaveLength(1)
    expect(created).toHaveLength(0)
    await turnOnAlerts(session, deps)
    expect(await alertsState(deps, session)).toBe("on")
  })

  test("a positive reply for a subscription that changed during the read is stale", async () => {
    const { deps, replace } = fakes({
      permission: "granted",
      existing: subscription(endpoint),
      check: () => replace(subscription(`${endpoint}-rotated`)),
    })
    await turnOnAlerts(session, deps)
    expect(await alertsState(deps, session)).toBe("off")
  })

  test("denied permission and missing browser subscriptions skip the account check", async () => {
    const denied = fakes({ permission: "denied", existing: subscription(endpoint) })
    expect(await alertsState(denied.deps, session)).toBe("denied")
    expect(denied.calls).toEqual([])
    const absent = fakes({ permission: "granted" })
    expect(await alertsState(absent.deps, session)).toBe("off")
    expect(absent.calls).toEqual([])
  })

  test("an expired browser subscription stays off and is replaced only after opting in", async () => {
    const existing = subscription(endpoint)
    existing.expirationTime = Date.now() - 1
    const { deps, calls, created } = fakes({ permission: "granted", existing })
    expect(await alertsState(deps, session)).toBe("off")
    expect(calls).toEqual([])
    expect(existing.unsubscribed).toBe(false)
    await turnOnAlerts(session, deps)
    expect(existing.unsubscribed).toBe(true)
    expect(created).toHaveLength(1)
  })

  test("a failed read is unknown without changing the subscription", async () => {
    const existing = subscription(endpoint)
    const { deps, calls, created } = fakes({ permission: "granted", existing, checkError: true })
    expect(await alertsState(deps, session)).toBe("unknown")
    expect(calls).toHaveLength(1)
    expect(created).toEqual([])
    expect(existing.unsubscribed).toBe(false)
  })

  test("unavailable subscription keys never produce a passive request", async () => {
    const existing = subscription(endpoint)
    existing.toJSON = () => ({ endpoint })
    const { deps, calls } = fakes({ permission: "granted", existing })
    expect(await alertsState(deps, session)).toBe("unknown")
    expect(calls).toEqual([])
  })
})

describe("turnOnAlerts", () => {
  test("asks, subscribes with the server's key and registers the phone with its session", async () => {
    const { deps, calls, created } = fakes()
    expect(await alertsState(deps, session)).toBe("off")
    await turnOnAlerts(session, deps)
    expect(created).toHaveLength(1)
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /api/notify/subscribe",
      "POST /api/notify/subscribe",
    ])
    // The key is public: it is fetched without the session.
    expect(calls[0].authorization).toBeUndefined()
    expect(calls[1]).toEqual({
      url: "/api/notify/subscribe",
      method: "POST",
      body: { subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/new", keys: { p256dh: "p", auth: "a" } } },
      authorization: "Bearer session-token",
    })
    expect(await alertsState(deps, session)).toBe("on")
  })

  test("stops when notifications are refused", async () => {
    const { deps, calls } = fakes({ grant: "denied" })
    await expect(turnOnAlerts(session, deps)).rejects.toMatchObject({ code: "NOTIFICATIONS_DENIED" })
    expect(calls).toHaveLength(0)
    expect(await alertsState(deps, session)).toBe("denied")
  })

  test("reuses a subscription for the same key and replaces one made for an older key", async () => {
    const same = subscription("https://fcm.googleapis.com/fcm/send/old")
    const reuse = fakes({ permission: "granted", existing: same })
    await turnOnAlerts(session, reuse.deps)
    expect(reuse.created).toHaveLength(0)
    expect(same.unsubscribed).toBe(false)

    const stale = subscription("https://fcm.googleapis.com/fcm/send/old", new Uint8Array(65).fill(9))
    const replace = fakes({ permission: "granted", existing: stale })
    await turnOnAlerts(session, replace.deps)
    expect(stale.unsubscribed).toBe(true)
    expect(replace.created).toHaveLength(1)
  })

  test("a refusal from the server undoes the new subscription and says why in plain words", async () => {
    const { deps, created } = fakes({ post: 402 })
    const error = await turnOnAlerts(session, deps).catch((cause) => cause)
    expect(error).toBeInstanceOf(PhoneApiError)
    expect(created[0].unsubscribed).toBe(true)
    expect(alertsErrorText(error)).toBe("Phone alerts come with an active Vector Codium plan.")
  })

  test("a refusal to register a subscription already present in the browser leaves this account off", async () => {
    const existing = subscription("https://fcm.googleapis.com/fcm/send/current")
    const { deps } = fakes({ permission: "granted", existing, post: 402 })
    await expect(turnOnAlerts(session, deps)).rejects.toMatchObject({ status: 402 })
    expect(existing.unsubscribed).toBe(false)
    expect(await alertsState(deps, session)).toBe("off")
  })
})

test("turning alerts off unsubscribes the browser, then asks the server to forget it", async () => {
  const existing = subscription("https://web.push.apple.com/abc")
  const { deps, calls } = fakes({ permission: "granted", existing })
  await turnOffAlerts(session, deps)
  expect(existing.unsubscribed).toBe(true)
  expect(calls).toEqual([
    {
      url: "/api/notify/subscribe",
      method: "DELETE",
      body: { endpoint: "https://web.push.apple.com/abc" },
      authorization: "Bearer session-token",
    },
  ])
})

test("failures read as plain words", () => {
  expect(alertsErrorText(new PhoneApiError(401, "SESSION_INVALID", "x"))).toBe("Your sign-in expired. Sign in again.")
  expect(alertsErrorText(new PhoneApiError(403, "CODIUM_PERK_REQUIRED", "x"))).toBe(
    "Phone alerts come with an active Vector Codium plan.",
  )
  expect(alertsErrorText(new PhoneApiError(503, "PUSH_UNAVAILABLE", "x"))).toBe(
    "Phone alerts are temporarily unavailable.",
  )
  expect(alertsErrorText(new PhoneApiError(429, "RATE_LIMITED", "x"))).toBe(
    "Too many tries. Wait a little and try again.",
  )
  expect(alertsErrorText(new Error("boom"))).toBe("Alerts could not be turned on. Try again.")
})
