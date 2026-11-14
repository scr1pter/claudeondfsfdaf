import { afterEach, beforeEach, describe, expect, mock, test, vi } from "bun:test"
import type { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { createFakeComputer, type FakeComputerScript } from "@/features/computer/fake-platform"
import { ComputerSendGate } from "@/features/computer/send-gate"
import { createComputerSettings, SEARCH_LIMIT, type SettingsState } from "./computer-controller"

const granted: Computer.PermissionsView = {
  rows: [
    { id: "screen", status: "granted", pane: "screen" },
    { id: "accessibility", status: "granted", pane: "accessibility" },
  ],
  canReset: false,
  adhoc: false,
  helperStart: "ok",
  vectorHoldsGrant: { screen: false, accessibility: false },
}
const denied: Computer.PermissionsView = { ...granted, rows: granted.rows.map((row) => ({ ...row, status: "denied" })) }
const state = (phase: Computer.ComputerPhase): Computer.ComputerState => ({
  phase,
  backend: "local-macos",
  mode: "foreground",
  apps: [],
  queue: [],
  escStops: false,
  stopChord: Hands.STOP_CHORD.darwin,
  lease: 0,
  reduceMotion: false,
})

const cleanups: (() => void)[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.useRealTimers()
})

function setup(computer: Computer.ComputerPlatform) {
  const focus = new EventTarget()
  const settings = createComputerSettings(computer, { focus })
  cleanups.push(settings.dispose)
  return { settings, focus }
}

function fake(script: FakeComputerScript = {}) {
  const platform = createFakeComputer({ prefs: { enabled: true, consentedAt: 1 }, permissions: granted, ...script })
  const permissions = mock(platform.permissions)
  const recheck = mock(platform.recheck)
  return { platform, computer: { ...platform, permissions, recheck }, permissions, recheck }
}

const flush = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}

describe("Settings computer controller: reads", () => {
  test("the first read uses the desktop's current permission view once and never starts a recheck", async () => {
    const { computer, permissions, recheck } = fake({ state: { phase: "ready" } })
    const { settings } = setup(computer)
    expect(settings.state.loading).toBe(true)
    expect(await settings.start()).toBe(true)
    expect(permissions).toHaveBeenCalledTimes(1)
    expect(recheck).not.toHaveBeenCalled()
    expect(settings.state).toMatchObject({
      loading: false,
      failed: false,
      phase: "ready",
      backend: "local-macos",
      permissions: granted,
      status: { available: true },
    })
    expect(settings.state.settings?.prefs.enabled).toBe(true)
    expect(await settings.start()).toBe(false)
    expect(permissions).toHaveBeenCalledTimes(1)
  })

  test("window focus starts one recheck; focus during a check joins it; there is no polling", async () => {
    const pending = Promise.withResolvers<Computer.PermissionsView>()
    const { computer, recheck } = fake({ permissions: denied })
    computer.recheck = recheck
    recheck.mockImplementation(() => pending.promise)
    const { settings, focus } = setup(computer)
    await settings.start()
    vi.advanceTimersByTime(30_000)
    await flush()
    expect(recheck).not.toHaveBeenCalled()

    focus.dispatchEvent(new Event("focus"))
    const check = settings.check()
    focus.dispatchEvent(new Event("focus"))
    expect(settings.check()).toBe(check)
    await flush()
    expect(recheck).toHaveBeenCalledTimes(1)
    expect(settings.state.checking).toBe(true)
    pending.resolve(granted)
    expect(await check).toBe(true)
    expect(settings.state).toMatchObject({ checking: false, permissions: granted })
    vi.advanceTimersByTime(30_000)
    await flush()
    expect(recheck).toHaveBeenCalledTimes(1)
  })

  test("focus during the first read joins it instead of queueing a second probe", async () => {
    const { computer, permissions, recheck } = fake()
    const { settings, focus } = setup(computer)
    const first = settings.start()
    focus.dispatchEvent(new Event("focus"))
    expect(settings.check()).toBe(first)
    await first
    expect(permissions).toHaveBeenCalledTimes(1)
    expect(recheck).not.toHaveBeenCalled()
  })

  test("a live state event that lands while the initial snapshot is in flight wins over it", async () => {
    const { platform, computer } = fake({ state: { phase: "off" } })
    const snapshot = Promise.withResolvers<Computer.ComputerState>()
    const read = mock(() => snapshot.promise)
    computer.state = read
    const { settings } = setup(computer)
    const first = settings.start()
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    platform.emit(state("working"))
    snapshot.resolve(state("off"))
    await first
    expect(settings.state.phase).toBe("working")
    platform.emit(state("ready"))
    expect(settings.state.phase).toBe("ready")
  })

  test("a snapshot requested after the last event is newer than it and applies", async () => {
    const { platform, computer } = fake({ state: { phase: "off" } })
    const { settings } = setup(computer)
    await settings.start()
    platform.emit(state("setup"))
    platform.emit(state("ready"))
    await settings.check()
    expect(settings.state.phase).toBe("ready")
  })

  test("a failed first read is reported, and a later check that succeeds clears it", async () => {
    const { computer } = fake()
    const prefs = computer.prefs
    computer.prefs = () => Promise.reject(new Error("main is busy"))
    const { settings } = setup(computer)
    expect(await settings.start()).toBe(false)
    expect(settings.state).toMatchObject({ loading: false, failed: true })
    expect(settings.state.settings).toBeUndefined()
    expect(await settings.setPrefs({ notify: false })).toBe(false)
    computer.prefs = prefs
    expect(await settings.check()).toBe(true)
    expect(settings.state.failed).toBe(false)
    expect(settings.state.error).toBeUndefined()
    expect(settings.state.settings?.prefs.enabled).toBe(true)
  })

  test("a failed probe drops the old permission view and keeps the last good settings", async () => {
    const { computer, recheck } = fake()
    const { settings } = setup(computer)
    await settings.start()
    const before = settings.state.settings
    recheck.mockImplementation(() => Promise.reject(new Error("probe failed")))
    expect(await settings.check()).toBe(false)
    expect(settings.state.permissions).toBeUndefined()
    expect(settings.state.error).toBe("computer.onboarding.checkFailed")
    expect(settings.state.settings).toEqual(before)
  })

  test("a probe that never answers fails after the limit, so it holds neither the page nor Use off", async () => {
    const { platform, computer, permissions, recheck } = fake()
    permissions.mockImplementation(() => new Promise(() => undefined))
    const { settings } = setup(computer)
    const first = settings.start()
    await flush()
    // Preferences have landed, so a change can be queued behind the hung first probe.
    expect(settings.state).toMatchObject({ loading: true, settings: { prefs: { enabled: true } } })
    const off = settings.setPrefs({ enabled: false })
    vi.advanceTimersByTime(ComputerSendGate.LIMIT - 1)
    await flush()
    expect(settings.state.loading).toBe(true)
    expect(platform.calls).toEqual([])
    vi.advanceTimersByTime(1)
    // Assert before awaiting, so a missing limit fails here instead of hanging the test.
    await flush()
    await flush()
    expect(settings.state).toMatchObject({ loading: false, failed: false, error: "computer.onboarding.checkFailed" })
    expect(settings.state.permissions).toBeUndefined()
    expect(platform.calls).toEqual([{ method: "setPrefs", prefs: { enabled: false } }])
    expect(await first).toBe(true)
    expect(await off).toBe(true)

    // A focus recheck that never answers gives way the same way, and a later answer is not published.
    const late = Promise.withResolvers<Computer.PermissionsView>()
    recheck.mockImplementation(() => late.promise)
    const check = settings.check()
    const notify = settings.setPrefs({ notify: false })
    await flush()
    expect(platform.calls).toHaveLength(1)
    vi.advanceTimersByTime(ComputerSendGate.LIMIT)
    await flush()
    await flush()
    expect(platform.calls.at(-1)).toEqual({ method: "setPrefs", prefs: { notify: false } })
    expect(settings.state).toMatchObject({ checking: false, error: "computer.onboarding.checkFailed" })
    expect(await check).toBe(false)
    expect(await notify).toBe(true)
    late.resolve(granted)
    await flush()
    expect(settings.state.permissions).toBeUndefined()
  })
})

describe("Settings computer controller: changes", () => {
  test("changes run in order, so a slow earlier save cannot overwrite a later one", async () => {
    const { platform, computer } = fake()
    const gate = Promise.withResolvers<void>()
    let calls = 0
    computer.setPrefs = async (patch) => {
      if (calls++ === 0) await gate.promise
      return platform.setPrefs(patch)
    }
    const { settings } = setup(computer)
    await settings.start()
    const first = settings.setPrefs({ notify: false })
    const second = settings.setPrefs({ notify: true })
    await flush()
    expect(platform.calls).toEqual([])
    gate.resolve()
    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(platform.calls).toEqual([
      { method: "setPrefs", prefs: { notify: false } },
      { method: "setPrefs", prefs: { notify: true } },
    ])
    expect(settings.state.settings?.prefs.notify).toBe(true)
    expect(settings.state.saving).toBe(false)
  })

  test("locked fields, consent, grants and turning Hands on make no call", async () => {
    const { platform, computer } = fake({ locked: ["pointer"], policy: { background: false, keepAwake: false } })
    const { settings } = setup(computer)
    await settings.start()
    for (const patch of [
      { pointer: "take" },
      { mode: "background" },
      { keepAwake: true },
      { enabled: true },
      { consentedAt: 99 },
      { granted: { helperVersion: "1", at: 1 } },
      { notify: false, mode: "background" },
    ] satisfies Partial<Computer.ComputerPrefs>[])
      expect(await settings.setPrefs(patch)).toBe(false)
    expect(platform.calls).toEqual([])
    expect(await settings.setPrefs({ enabled: false })).toBe(true)
    expect(platform.calls).toEqual([{ method: "setPrefs", prefs: { enabled: false } }])
  })

  test("a failed save reports it and keeps the last good settings", async () => {
    const { computer } = fake()
    const { settings } = setup(computer)
    await settings.start()
    const before = settings.state.settings
    computer.setPrefs = () => Promise.reject(new Error("store is read-only"))
    expect(await settings.setPrefs({ notify: false })).toBe(false)
    expect(settings.state.error).toBe("computer.settings.saveFailed")
    expect(settings.state.settings).toEqual(before)
  })

  test("removing always-allowed apps and blocking or unblocking rereads the preferences", async () => {
    const { platform, computer } = fake({
      always: [
        { key: "app:macos:com.apple.notes", name: "Notes", addedAt: 1 },
        { key: "app:macos:com.apple.mail", name: "Mail", addedAt: 2 },
      ],
      now: 7,
    })
    const { settings } = setup(computer)
    await settings.start()
    await settings.removeAlways("app:macos:com.apple.notes")
    expect(settings.state.settings?.always.map((app) => app.name)).toEqual(["Mail"])
    await settings.removeAllAlways()
    expect(settings.state.settings?.always).toEqual([])
    await settings.block({ key: "app:macos:com.apple.textedit", name: "TextEdit‮" })
    expect(settings.state.settings?.prefs.blocked).toEqual([
      { key: "app:macos:com.apple.textedit", name: "TextEdit", addedAt: 7 },
    ])
    await settings.unblock("app:macos:com.apple.textedit")
    expect(settings.state.settings?.prefs.blocked).toEqual([])
    // A key main could never accept is not sent.
    expect(await settings.block({ key: "TextEdit", name: "TextEdit" })).toBe(false)
    expect(platform.calls).toEqual([
      { method: "removeAlways", key: "app:macos:com.apple.notes" },
      { method: "removeAllAlways" },
      { method: "block", app: { key: "app:macos:com.apple.textedit", name: "TextEdit" } },
      { method: "unblock", key: "app:macos:com.apple.textedit" },
    ])
  })

  test("a blocked lock refuses blocking and unblocking without a call", async () => {
    const { platform, computer } = fake({ locked: ["blocked"] })
    const { settings } = setup(computer)
    await settings.start()
    expect(await settings.block({ key: "app:macos:com.apple.textedit", name: "TextEdit" })).toBe(false)
    expect(await settings.unblock("app:macos:com.apple.textedit")).toBe(false)
    expect(platform.calls).toEqual([])
  })

  test("allowing a grouped default row is one write built from fresh preferences", async () => {
    const builtins: Computer.ResolvedComputerSettings["builtins"] = [
      { key: "builtin:tradingview", name: "TradingView", reason: "user", removable: true },
      { key: "builtin:binance", name: "Binance", reason: "user", removable: true },
      { key: "builtin:find-my", name: "Find My", reason: "user", removable: true },
      { key: "builtin:terminal", name: "Terminal", reason: "terminal", removable: false },
    ]
    const { platform, computer } = fake({ builtins })
    const { settings } = setup(computer)
    await settings.start()
    // Another window allowed Find My after this page read its settings.
    await platform.setPrefs({ unblocked: ["builtin:find-my"] })
    expect(await settings.allowDefault(["builtin:tradingview", "builtin:binance", "builtin:terminal"])).toBe(true)
    expect(platform.calls.at(-1)).toEqual({
      method: "setPrefs",
      prefs: { unblocked: ["builtin:find-my", "builtin:tradingview", "builtin:binance"] },
    })
    expect(await settings.blockDefault(["builtin:tradingview", "builtin:binance"])).toBe(true)
    expect(platform.calls.at(-1)).toEqual({ method: "setPrefs", prefs: { unblocked: ["builtin:find-my"] } })
    expect(settings.state.settings?.prefs.unblocked).toEqual(["builtin:find-my"])
  })

  test("a default row under a company lock, or after a failed write, is unchanged", async () => {
    const builtins: Computer.ResolvedComputerSettings["builtins"] = [
      { key: "builtin:tradingview", name: "TradingView", reason: "user", removable: true },
      { key: "builtin:binance", name: "Binance", reason: "user", removable: true },
    ]
    const locked = fake({ builtins, locked: ["unblocked"] })
    const lockedSettings = setup(locked.computer).settings
    await lockedSettings.start()
    expect(await lockedSettings.allowDefault(["builtin:tradingview", "builtin:binance"])).toBe(false)
    expect(locked.platform.calls).toEqual([])

    const failing = fake({ builtins })
    failing.computer.setPrefs = () => Promise.reject(new Error("store is read-only"))
    const failingSettings = setup(failing.computer).settings
    await failingSettings.start()
    expect(await failingSettings.allowDefault(["builtin:tradingview", "builtin:binance"])).toBe(false)
    expect(failingSettings.state.error).toBe("computer.settings.saveFailed")
    expect((await failing.platform.prefs()).prefs.unblocked).toEqual([])
  })

  test("Delete all publishes the count, and a second press while it runs joins it", async () => {
    const { platform, computer } = fake({ removedScreenshots: 4 })
    const gate = Promise.withResolvers<void>()
    const remove = mock(async () => {
      await gate.promise
      return platform.deleteScreenshots()
    })
    computer.deleteScreenshots = remove
    const { settings } = setup(computer)
    await settings.start()
    const first = settings.deleteScreenshots()
    expect(settings.deleteScreenshots()).toBe(first)
    expect(settings.state.deleting).toBe(true)
    gate.resolve()
    expect(await first).toBe(true)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(settings.state).toMatchObject({ deleting: false, deleted: 4 })
    // A later, separate press runs again and reports its own count.
    expect(await settings.deleteScreenshots()).toBe(true)
    expect(remove).toHaveBeenCalledTimes(2)
    expect(settings.state.deleted).toBe(0)
  })

  test("a failed or malformed deletion is reported, never shown as a count", async () => {
    const { computer } = fake()
    computer.deleteScreenshots = async () => ({ removed: -1 })
    const { settings } = setup(computer)
    await settings.start()
    expect(await settings.deleteScreenshots()).toBe(false)
    expect(settings.state.deleted).toBeUndefined()
    expect(settings.state.error).toBe("computer.settings.screenshots.deleteFailed")
  })

  test("reset needs a reset row the platform supports; panes must match the backend", async () => {
    const noRow = fake({ permissions: { ...granted, canReset: true } })
    const plain = setup(noRow.computer).settings
    await plain.start()
    expect(await plain.reset("screen")).toBe(false)
    expect(await plain.openPane("windows-capture")).toBe(false)
    expect(await plain.openPane("screen")).toBe(true)
    expect(noRow.platform.calls).toEqual([{ method: "openPane", id: "screen" }])

    const afterUpdate: Computer.PermissionsView = {
      ...granted,
      canReset: true,
      rows: [granted.rows[0]!, { ...granted.rows[1]!, status: "reset-after-update" }],
    }
    const withRow = fake({ permissions: afterUpdate, reset: granted })
    const resetting = setup(withRow.computer).settings
    await resetting.start()
    expect(await resetting.reset("screen")).toBe(false)
    expect(await resetting.reset("accessibility")).toBe(true)
    expect(withRow.platform.calls).toEqual([{ method: "reset", id: "accessibility" }])
    expect(resetting.state.permissions).toEqual(granted)
  })
})

describe("Settings computer controller: search and disposal", () => {
  test("app search drops stale answers and leaves out never-listed and blocked apps", async () => {
    const { computer } = fake()
    const answers = new Map<string, PromiseWithResolvers<Awaited<ReturnType<Computer.ComputerPlatform["apps"]>>>>()
    computer.apps = (query = "") => {
      const answer = Promise.withResolvers<Awaited<ReturnType<Computer.ComputerPlatform["apps"]>>>()
      answers.set(query, answer)
      return answer.promise
    }
    const { settings } = setup(computer)
    await settings.start()
    const older = settings.searchApps("T")
    const newer = settings.searchApps("Te")
    answers.get("Te")!.resolve([
      { key: "app:macos:com.apple.textedit", name: "TextEdit", running: true },
      { key: "app:macos:com.apple.terminal", name: "Terminal", running: true, rule: "never" },
      { key: "app:macos:com.example.textexpander", name: "TextExpander", running: false, rule: "blocked" },
      { key: "app:macos:com.example.tex", name: "TeX\u0007", running: false, rule: "company-deny" },
      { key: "Not a key", name: "Broken", running: false },
    ])
    answers.get("T")!.resolve([{ key: "app:macos:com.apple.tv", name: "TV", running: false }])
    expect(await newer).toEqual([
      { key: "app:macos:com.apple.textedit", name: "TextEdit", running: true },
      { key: "app:macos:com.example.tex", name: "TeX", running: false },
    ])
    expect(await older).toBeUndefined()

    const cancelled = settings.searchApps("Ca")
    settings.cancelSearch()
    answers.get("Ca")!.resolve([{ key: "app:macos:com.apple.calculator", name: "Calculator", running: false }])
    expect(await cancelled).toBeUndefined()
  })

  test("search answers at most the limit", async () => {
    const apps = Array.from({ length: SEARCH_LIMIT + 3 }, (_, index) => ({
      key: `app:macos:com.example.app${index}`,
      name: `App ${index}`,
      running: false,
    }))
    const { computer } = fake({ apps })
    const { settings } = setup(computer)
    await settings.start()
    expect(await settings.searchApps("App")).toHaveLength(SEARCH_LIMIT)
  })

  test("after dispose nothing is published, focus starts no probe, and state events are ignored", async () => {
    const { platform, computer, recheck } = fake()
    const { settings, focus } = setup(computer)
    const seen: SettingsState[] = []
    settings.subscribe((next) => seen.push(next))
    await settings.start()
    const count = seen.length
    settings.dispose()
    focus.dispatchEvent(new Event("focus"))
    platform.emit(state("working"))
    expect(await settings.check()).toBe(false)
    expect(await settings.setPrefs({ notify: false })).toBe(false)
    expect(await settings.deleteScreenshots()).toBe(false)
    await flush()
    expect(recheck).not.toHaveBeenCalled()
    expect(seen).toHaveLength(count)
    expect(settings.state.phase).not.toBe("working")
    expect(platform.calls).toEqual([])
  })

  test("an unsupported desktop reads nothing", async () => {
    const { computer, permissions } = fake({ supported: false })
    const prefs = mock(computer.prefs)
    computer.prefs = prefs
    const { settings } = setup(computer)
    expect(await settings.start()).toBe(false)
    expect(settings.state.loading).toBe(false)
    expect(prefs).not.toHaveBeenCalled()
    expect(permissions).not.toHaveBeenCalled()
  })
})
