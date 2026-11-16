import { expect, test } from "bun:test"
import { createResource, createRoot, createSignal } from "solid-js"
import { vectorScopeOwner } from "@/components/settings-v2/vectorscope-model"

const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve))

test("a delayed owner-to-guest server change cannot reuse the retained owner proof", async () => {
  const ownerSDK = { server: "owner" }
  const guestSDK = { server: "guest" }
  const owner = Promise.withResolvers<boolean>()
  const guest = Promise.withResolvers<boolean>()
  const state = createRoot((dispose) => {
    const [sdk, setSDK] = createSignal(ownerSDK)
    const [check] = createResource(sdk, async (captured) => ({
      sdk: captured,
      provedOwner: await (captured === ownerSDK ? owner.promise : guest.promise),
    }))
    return { dispose, sdk, setSDK, check, allowed: () => vectorScopeOwner(check(), sdk(), check.loading) }
  })
  try {
    expect(state.allowed()).toBe(false)
    owner.resolve(true)
    await owner.promise
    await settle()
    expect(state.allowed()).toBe(true)
    state.setSDK(guestSDK)
    // Solid retains the previous resource value until the new request settles.
    // The same production gate must reject it before any guest reply arrives.
    expect(state.check()?.sdk).toBe(ownerSDK)
    expect(state.check.loading).toBe(true)
    expect(state.allowed()).toBe(false)
    guest.resolve(false)
    await guest.promise
    await settle()
    expect(state.check()?.sdk).toBe(guestSDK)
    expect(state.allowed()).toBe(false)
    state.setSDK(ownerSDK)
    expect(state.allowed()).toBe(false)
    await settle()
    expect(state.allowed()).toBe(true)
  } finally {
    state.dispose()
  }
})
