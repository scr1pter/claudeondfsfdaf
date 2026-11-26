import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { createRoot, createSignal } from "solid-js"
import { PHONE_PUSH_CHANGED } from "../src/phone/config"
import { useAlertsState } from "../src/phone/push"

test("the foreground checks the current account on worker invalidation and on return", async () => {
  const session = { accessToken: "fixture-a", refreshToken: "refresh", expiresAt: 1_800_000_000_000 }
  const endpoint = "https://web.push.apple.com/test"
  const keys = { p256dh: "fixture-public-key", auth: "fixture-auth" }
  const lookup = (endpoint: string) => ({
    id: createHash("sha256").update(endpoint).digest("base64url").slice(0, 22),
    fingerprint: createHash("sha256")
      .update(JSON.stringify(["vector-phone-push-v1", endpoint, keys.p256dh, keys.auth]))
      .digest("hex"),
  })
  let current = endpoint
  let permission = "granted"
  let visibility = "visible"
  const calls: { token: string | null; body: unknown }[] = []
  const controller = {}
  const worker = Object.assign(new EventTarget(), {
    controller,
    getRegistration: async () => ({
      pushManager: {
        getSubscription: async () => ({ endpoint: current, toJSON: () => ({ endpoint: current, keys }) }),
      },
    }),
  })
  const restore: (() => void)[] = []
  const replace = (target: object, key: string, descriptor: PropertyDescriptor) => {
    const before = Object.getOwnPropertyDescriptor(target, key)
    Object.defineProperty(target, key, { configurable: true, ...descriptor })
    restore.push(() => {
      if (before) Object.defineProperty(target, key, before)
      else Reflect.deleteProperty(target, key)
    })
  }
  replace(navigator, "serviceWorker", { value: worker })
  replace(document, "visibilityState", { get: () => visibility })
  replace(globalThis, "Notification", {
    value: {
      get permission() {
        return permission
      },
    },
  })
  replace(globalThis, "fetch", {
    value: async (url: string, init: RequestInit) => {
      const token = new Headers(init.headers).get("authorization")
      const body = JSON.parse(String(init.body))
      calls.push({ token, body })
      expect(url).toBe("/api/notify/subscribe")
      expect(init.method).toBe("POST")
      expect(body).toEqual({ check: lookup(current) })
      return Response.json({ subscribed: token === "Bearer fixture-a" && body.check.id === lookup(endpoint).id })
    },
  })
  const message = (source: object) => {
    const event = new MessageEvent("message", { data: PHONE_PUSH_CHANGED })
    Object.defineProperty(event, "source", { value: source })
    worker.dispatchEvent(event)
  }
  const [account, setAccount] = createSignal(session)
  const route = createRoot((dispose) => ({ ...useAlertsState(account, () => true), dispose }))
  const settled = async () => {
    for (let attempt = 0; attempt < 30 && route.state.loading; attempt++) await Bun.sleep(1)
    return route.state()
  }
  try {
    expect(await settled()).toBe("on")
    current += "-rotated"
    // A message from anything but the controlling worker starts no check.
    message({})
    expect(route.state.loading).toBe(false)
    await settled()
    expect(calls).toHaveLength(1)
    message(controller)
    expect(route.state.loading).toBe(true)
    expect(await settled()).toBe("off")
    expect(calls).toHaveLength(2)
    current = endpoint
    setAccount({ ...session, accessToken: "fixture-b" })
    expect(route.state.loading).toBe(true)
    expect(await settled()).toBe("off")
    expect(calls.at(-1)?.token).toBe("Bearer fixture-b")
    // Going into the background starts no check; coming back does.
    visibility = "hidden"
    document.dispatchEvent(new Event("visibilitychange"))
    expect(route.state.loading).toBe(false)
    visibility = "visible"
    permission = "denied"
    document.dispatchEvent(new Event("visibilitychange"))
    expect(await settled()).toBe("denied")
    expect(calls).toHaveLength(3)
    // A new controlling worker rechecks too.
    permission = "granted"
    worker.dispatchEvent(new Event("controllerchange"))
    expect(route.state.loading).toBe(true)
    expect(await settled()).toBe("off")
    expect(calls).toHaveLength(4)
    // After the route is gone, nothing it listened to starts a check.
    route.dispose()
    message(controller)
    worker.dispatchEvent(new Event("controllerchange"))
    document.dispatchEvent(new Event("visibilitychange"))
    expect(route.state.loading).toBe(false)
    await settled()
    expect(calls).toHaveLength(4)
  } finally {
    route.dispose()
    for (const reset of restore.reverse()) reset()
  }
})
