import { afterEach, beforeEach, describe, expect, mock, test, vi } from "bun:test"
import type { Computer } from "@vectordevai/schema/computer"
import { createFakeComputer } from "./fake-platform"
import { createComputerOnboarding } from "./onboarding-controller"
import { ComputerSendGate } from "./send-gate"

const healthy: Computer.PermissionsView = {
  rows: [
    { id: "screen", status: "granted", pane: "ignored-provider-url" },
    { id: "accessibility", status: "granted", pane: "ignored-provider-url" },
  ],
  canReset: false,
  adhoc: false,
  helperStart: "ok",
  vectorHoldsGrant: { screen: false, accessibility: false },
}
const denied: Computer.PermissionsView = {
  ...healthy,
  rows: healthy.rows.map((row) => ({ ...row, status: "denied" })),
}
const windows: Computer.PermissionsView = {
  ...healthy,
  rows: [],
  windows: { captureBlocked: false, elevated: false, inputSetup: { state: "ready", mouse: true, keyboard: true } },
}
const cleanups: (() => void)[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.useRealTimers()
})
function controller(computer: Computer.ComputerPlatform) {
  const focus = new EventTarget()
  const setup = createComputerOnboarding(computer, { focus, now: () => 1234 })
  cleanups.push(setup.dispose)
  return { setup, focus }
}

describe("computer onboarding lifecycle", () => {
  test("consent remains off; only Finish writes enabled after another probe", async () => {
    const fake = createFakeComputer({ permissions: healthy, recheck: healthy })
    const recheck = mock(fake.recheck)
    const { setup } = controller({ ...fake, recheck })
    await setup.start()
    expect(recheck).not.toHaveBeenCalled()
    expect(await setup.finish()).toBe(false)
    await setup.consent()
    expect(setup.state.step).toBe("permissions")
    expect(fake.calls).toEqual([{ method: "setPrefs", prefs: { consentedAt: 1234 } }])
    expect((await fake.prefs()).prefs.enabled).toBe(false)
    expect(setup.advance()).toBe(true)
    const first = setup.finish()
    expect(setup.finish()).toBe(first)
    expect(await first).toBe(true)
    expect(recheck).toHaveBeenCalledTimes(1)
    expect(fake.calls).toEqual([
      { method: "setPrefs", prefs: { consentedAt: 1234 } },
      { method: "setPrefs", prefs: { enabled: true, consentedAt: 1234 } },
    ])
  })

  test("coalesces poll/focus/manual probes and stops them when closing starts", async () => {
    const pending = Promise.withResolvers<Computer.PermissionsView>()
    const fake = createFakeComputer({ permissions: denied })
    const recheck = mock(() => pending.promise)
    const { setup, focus } = controller({ ...fake, recheck })
    await setup.start()
    vi.advanceTimersByTime(2000)
    const check = setup.check()
    focus.dispatchEvent(new Event("focus"))
    expect(setup.check()).toBe(check)
    await Promise.resolve()
    expect(recheck).toHaveBeenCalledTimes(1)
    pending.resolve(healthy)
    await check
    expect(setup.state.permissions).toEqual(healthy)
    setup.dispose()
    vi.advanceTimersByTime(6000)
    focus.dispatchEvent(new Event("focus"))
    await Promise.resolve()
    expect(recheck).toHaveBeenCalledTimes(1)
    expect(await setup.check()).toBe(false)
  })

  test("Finish waits for a running poll then probes again; a new denial prevents enabling", async () => {
    const pending = Promise.withResolvers<Computer.PermissionsView>()
    const fake = createFakeComputer({ permissions: healthy })
    let probes = 0
    const { setup } = controller({
      ...fake,
      recheck: () => (++probes === 1 ? pending.promise : Promise.resolve(denied)),
    })
    await setup.start()
    await setup.consent()
    setup.advance()
    const poll = setup.check()
    const finish = setup.finish()
    await Promise.resolve()
    expect(probes).toBe(1)
    pending.resolve(healthy)
    await poll
    expect(await finish).toBe(false)
    expect(probes).toBe(2)
    expect(setup.state.step).toBe("permissions")
    expect((await fake.prefs()).prefs.enabled).toBe(false)
    expect(fake.calls).toHaveLength(1)
  })

  test.each(["policy", "locked"] as const)(
    "fresh %s restrictions after the final probe prevent enabling",
    async (restriction) => {
      const pending = Promise.withResolvers<Computer.PermissionsView>()
      const fake = createFakeComputer({ permissions: healthy })
      let restricted = false
      const { setup } = controller({
        ...fake,
        recheck: () => pending.promise,
        prefs: async () => {
          const value = await fake.prefs()
          return {
            ...value,
            policy: { ...value.policy, enabled: !(restricted && restriction === "policy") },
            locked: restricted && restriction === "locked" ? ["enabled"] : [],
          }
        },
      })
      await setup.start()
      await setup.consent()
      setup.advance()
      const finish = setup.finish()
      await Promise.resolve()
      restricted = true
      pending.resolve(healthy)
      expect(await finish).toBe(false)
      expect(fake.calls).toHaveLength(1)
      expect((await fake.prefs()).prefs.enabled).toBe(false)
    },
  )

  test("close-start disposal prevents a final probe's late continuation from writing preferences", async () => {
    const pending = Promise.withResolvers<Computer.PermissionsView>()
    const fake = createFakeComputer({ permissions: healthy })
    const { setup } = controller({ ...fake, recheck: () => pending.promise })
    await setup.start()
    await setup.consent()
    setup.advance()
    const finish = setup.finish()
    await Promise.resolve()
    setup.dispose()
    pending.resolve(healthy)
    expect(await finish).toBe(false)
    expect(fake.calls).toEqual([{ method: "setPrefs", prefs: { consentedAt: 1234 } }])
  })

  test("a probe that never answers fails as check failed at the limit, so the first read and Finish settle", async () => {
    const flush = async () => {
      for (let turn = 0; turn < 20; turn++) await Promise.resolve()
    }
    const fake = createFakeComputer({ permissions: healthy })
    const stuck = controller({ ...fake, permissions: () => new Promise<Computer.PermissionsView>(() => {}) })
    // Each step reads a flag rather than awaiting, so a probe left unbounded fails here instead of hanging the file.
    let started: boolean | undefined
    void stuck.setup.start().then((value) => (started = value))
    await flush()
    vi.advanceTimersByTime(ComputerSendGate.LIMIT - 1)
    await flush()
    expect(started).toBeUndefined()
    vi.advanceTimersByTime(1)
    await flush()
    expect(started).toBe(false)
    expect(stuck.setup.state).toMatchObject({
      loading: false,
      checking: false,
      error: "computer.onboarding.checkFailed",
    })

    const { setup } = controller({ ...fake, recheck: () => new Promise<Computer.PermissionsView>(() => {}) })
    await setup.start()
    await setup.consent()
    expect(setup.advance()).toBe(true)
    let settled: boolean | undefined
    void setup.finish().then((value) => (settled = value))
    await flush()
    vi.advanceTimersByTime(ComputerSendGate.LIMIT - 1)
    await flush()
    expect(settled).toBeUndefined()
    expect(setup.state.saving).toBe(true)
    vi.advanceTimersByTime(1)
    await flush()
    expect(settled).toBe(false)
    expect(setup.state).toMatchObject({ saving: false, error: "computer.onboarding.checkFailed" })
    expect((await fake.prefs()).prefs.enabled).toBe(false)
    expect(fake.calls).toEqual([{ method: "setPrefs", prefs: { consentedAt: 1234 } }])
  })

  test("failed preference writes remain retryable without an automatic retry", async () => {
    const fake = createFakeComputer({ permissions: healthy })
    let fail = true
    const { setup } = controller({
      ...fake,
      setPrefs: async (prefs) => {
        if (prefs.enabled && fail) throw new Error("save failed")
        return fake.setPrefs(prefs)
      },
    })
    await setup.start()
    await setup.consent()
    setup.advance()
    expect(await setup.finish()).toBe(false)
    expect(setup.state.error).toBe("computer.onboarding.saveFailed")
    expect((await fake.prefs()).prefs.enabled).toBe(false)
    fail = false
    expect(await setup.finish()).toBe(true)
    expect(setup.state.error).toBeUndefined()
    expect((await fake.prefs()).prefs.enabled).toBe(true)
  })

  test("reset and fixed settings panes run only on explicit supported actions", async () => {
    const reset = {
      ...healthy,
      rows: [{ ...healthy.rows[0], status: "reset-after-update" as const }, healthy.rows[1]],
      canReset: true,
    }
    const fake = createFakeComputer({ permissions: reset, reset: healthy })
    const { setup } = controller(fake)
    await setup.start()
    expect(fake.calls).toEqual([])
    expect(await setup.openPane("windows-capture")).toBe(false)
    expect(await setup.openPane("screen")).toBe(true)
    expect(await setup.reset("screen")).toBe(true)
    expect(fake.calls).toEqual([
      { method: "openPane", id: "screen" },
      { method: "reset", id: "screen" },
    ])
    expect(await setup.reset("screen")).toBe(false)
    expect((await fake.prefs()).prefs.enabled).toBe(false)
  })

  test("healthy Windows skips grant rows, but a fresh helper failure stops Finish", async () => {
    const fake = createFakeComputer({
      state: { backend: "local-windows" },
      permissions: windows,
      recheck: { ...windows, helperStart: "failed" },
    })
    const { setup } = controller(fake)
    await setup.start()
    await setup.consent()
    expect(setup.platform()).toBe("windows")
    expect(setup.state.step).toBe("try")
    expect(await setup.finish()).toBe(false)
    expect(setup.state.step).toBe("permissions")
    expect((await fake.prefs()).prefs.enabled).toBe(false)
  })

  test.each([
    { backend: "local-windows" as const, permissions: healthy },
    { backend: "local-macos" as const, permissions: windows },
    { backend: "remote" as const, permissions: healthy },
  ])("a $backend backend with mismatched permission shape cannot proceed", async ({ backend, permissions }) => {
    const fake = createFakeComputer({ state: { backend }, permissions })
    const { setup } = controller(fake)
    await setup.start()
    expect(await setup.consent()).toBe(false)
    expect(await setup.finish()).toBe(false)
    expect(fake.calls).toEqual([])
  })

  test("main-app grants remain a warning and do not block the helper's completed setup", async () => {
    const fake = createFakeComputer({
      permissions: { ...healthy, vectorHoldsGrant: { screen: true, accessibility: true } },
    })
    const { setup } = controller(fake)
    await setup.start()
    await setup.consent()
    expect(setup.advance()).toBe(true)
    expect(await setup.finish()).toBe(true)
  })
})
