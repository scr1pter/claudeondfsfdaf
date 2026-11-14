import { describe, expect, test } from "bun:test"
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

function subscription(endpoint: string, key: Uint8Array = serverKey) {
  const value: SubscriptionLike & { unsubscribed: boolean } = {
    endpoint,
    unsubscribed: false,
    options: { applicationServerKey: key.slice().buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
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
  } = {},
) {
  let permission = options.permission ?? "default"
  let current: SubscriptionLike | null = options.existing ?? null
  const created: ReturnType<typeof subscription>[] = []
  const calls: { url: string; method: string; body?: unknown; authorization?: string }[] = []
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
      calls.push({
        url,
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        ...(headers.authorization ? { authorization: headers.authorization } : {}),
      })
      if ((init?.method ?? "GET") === "GET")
        return new Response(JSON.stringify({ publicKey: base64url(serverKey) }), {
          headers: { "content-type": "application/json" },
        })
      const status = init?.method === "POST" ? (options.post ?? 200) : 200
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
  return { deps, calls, created, current: () => current }
}

describe("turnOnAlerts", () => {
  test("asks, subscribes with the server's key and registers the phone with its session", async () => {
    const { deps, calls, created } = fakes()
    expect(await alertsState(deps)).toBe("off")
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
    expect(await alertsState(deps)).toBe("on")
  })

  test("stops when notifications are refused", async () => {
    const { deps, calls } = fakes({ grant: "denied" })
    await expect(turnOnAlerts(session, deps)).rejects.toMatchObject({ code: "NOTIFICATIONS_DENIED" })
    expect(calls).toHaveLength(0)
    expect(await alertsState(deps)).toBe("denied")
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
