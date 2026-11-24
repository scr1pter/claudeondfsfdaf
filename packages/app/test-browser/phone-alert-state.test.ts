import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { PHONE_PUSH_CHANGED } from "../src/phone/config"
import { useAlertsState } from "../src/phone/push"

test("the foreground checks the current account on worker invalidation and on return", async () => {
  const session = { accessToken: "fixture-a", refreshToken: "refresh", expiresAt: 1_800_000_000_000 }
  const endpoint = "https://web.push.apple.com/test"
  let current = endpoint
  let permission = "granted"
  const calls: { token: string | null; body: unknown }[] = []
  const controller = {}
  const worker = Object.assign(new EventTarget(), {
    controller,
    getRegistration: async () => ({
      pushManager: {
        getSubscription: async () => ({ toJSON: () => ({ endpoint: current }) }),
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
  replace(document, "visibilityState", { value: "visible" })
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
      expect(Object.keys(body)).toEqual(["check"])
      return Response.json({ subscribed: token === "Bearer fixture-a" && body.check.endpoint === endpoint })
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
    message({})
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
    permission = "denied"
    document.dispatchEvent(new Event("visibilitychange"))
    expect(await settled()).toBe("denied")
    expect(calls).toHaveLength(3)
    route.dispose()
    message(controller)
    expect(calls).toHaveLength(3)
  } finally {
    route.dispose()
    for (const reset of restore.reverse()) reset()
  }
})
