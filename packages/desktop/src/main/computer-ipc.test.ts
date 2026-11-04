import { describe, expect, test } from "bun:test"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import {
  broadcastComputerState,
  broadcastScreenshotsRemoved,
  registerComputerIpc,
  setComputerService,
  type ComputerIpcService,
} from "./computer-ipc"
import { registerComputerOverlay } from "./computer-overlay-registry"
import { defaultPolicy } from "./computer-policy"
import { defaultPrefs, resolve } from "./computer-settings"
import { isTrustedRendererEvent } from "./trusted-renderer"
import { settingsFromWire, settingsToWire, type ComputerSettingsWire } from "./computer-wire"

const TRUSTED = "vector://renderer/index.html"
const state: Computer.ComputerState = {
  phase: "ready",
  backend: "local-macos",
  mode: "foreground",
  apps: [],
  queue: [],
  escStops: false,
  stopChord: Hands.STOP_CHORD.darwin,
  lease: 0,
  reduceMotion: false,
}
const policy: Computer.ComputerPolicy = {
  ...defaultPolicy(),
  managed: true,
  apps: new Map([
    ["app:macos:com.apple.calculator", "allow"],
    ["app:macos:com.microsoft.excel", "deny"],
  ]),
}
const settings = resolve({ ...defaultPrefs("darwin"), enabled: true, consentedAt: 1 }, policy, [])

type Window = { id: number; destroyed?: boolean; url: string; sent: unknown[][] }
function fixture() {
  const calls: unknown[][] = []
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const windows = new Map<object, Window>()
  const record =
    (name: string, value: unknown = undefined) =>
    (...args: unknown[]) => {
      calls.push([name, ...args])
      return Promise.resolve(value)
    }
  const service: ComputerIpcService = {
    status: record("status", { available: false, reason: "permissions", backend: "local-macos" }) as never,
    state: () => (calls.push(["state"]), state),
    command: record("command") as never,
    prefs: () => (calls.push(["prefs"]), settings),
    setPrefs: record("setPrefs", settings) as never,
    permissions: record("permissions") as never,
    recheck: record("recheck") as never,
    openPane: record("openPane") as never,
    reset: record("reset") as never,
    apps: record("apps", []) as never,
    removeAlways: record("removeAlways") as never,
    removeAllAlways: record("removeAllAlways") as never,
    block: record("block") as never,
    unblock: record("unblock") as never,
    deleteScreenshots: record("deleteScreenshots", { removed: 0 }) as never,
  }
  setComputerService(service)
  registerComputerIpc(
    (channel, listener) => handlers.set(channel, listener as never),
    () => {
      throw new Error("No computer channel is fire-and-forget")
    },
    {
      assert(event) {
        const value = event as { sender: { isDestroyed(): boolean; getURL(): string }; senderFrame?: { url: string } }
        if (
          !isTrustedRendererEvent(value, {
            windowFor: (contents) =>
              [...windows.keys()].find((window) => (window as { contents: unknown }).contents === contents),
            trustedUrl: (url) => url === TRUSTED,
          })
        )
          throw new Error("Vector rejected a desktop command from an untrusted page.")
      },
    },
  )
  function sender(url: string, options: { overlay?: boolean; destroyed?: boolean; frame?: string } = {}) {
    const contents = { isDestroyed: () => !!options.destroyed, getURL: () => url }
    const window = { contents }
    windows.set(window, { id: windows.size + 1, url, sent: [] })
    if (options.overlay) registerComputerOverlay(window)
    return { sender: contents, senderFrame: { url: options.frame ?? url } }
  }
  return { calls, handlers, sender }
}

const ARGS: Record<string, unknown[]> = {
  "computer-command": ["stop"],
  "computer-set-prefs": [{ notify: false }],
  "computer-open-pane": ["screen"],
  "computer-reset": ["screen"],
  "computer-apps": ["Num"],
  "computer-remove-always": ["app:macos:com.apple.calculator"],
  "computer-block": [{ key: "app:macos:com.apple.iwork.numbers", name: "Numbers" }],
  "computer-unblock": ["app:macos:com.apple.iwork.numbers"],
}
const INVOKED = Computer.IPC_CHANNELS.filter((channel) => channel !== "computer-state-changed")

describe("computer renderer IPC", () => {
  test("every section 2.9 channel is registered behind the trusted-renderer check", () => {
    const f = fixture()
    expect([...f.handlers.keys()].sort()).toEqual([...INVOKED].sort())
  })

  test("every channel rejects an untrusted sender before reading an argument", async () => {
    const f = fixture()
    const untrusted = [
      f.sender(TRUSTED, { overlay: true }),
      f.sender("https://example.invalid/"),
      f.sender(TRUSTED, { frame: "https://example.invalid/frame" }),
      f.sender(TRUSTED, { destroyed: true }),
    ]
    for (const channel of INVOKED)
      for (const event of untrusted)
        await expect(
          Promise.resolve().then(() => f.handlers.get(channel)!(event, ...(ARGS[channel] ?? []))),
        ).rejects.toThrow()
    expect(f.calls).toEqual([])
    const trusted = f.sender(TRUSTED)
    for (const channel of INVOKED) await f.handlers.get(channel)!(trusted, ...(ARGS[channel] ?? []))
    expect(f.calls.map(([name]) => name)).toEqual([
      "status",
      "state",
      "command",
      "prefs",
      "setPrefs",
      "permissions",
      "recheck",
      "openPane",
      "reset",
      "apps",
      "removeAlways",
      "removeAllAlways",
      "block",
      "unblock",
      "deleteScreenshots",
    ])
  })

  test("arguments are checked before the service sees them", async () => {
    const f = fixture()
    const trusted = f.sender(TRUSTED)
    const call = (channel: string, ...args: unknown[]) =>
      Promise.resolve().then(() => f.handlers.get(channel)!(trusted, ...args))
    for (const [channel, args] of [
      ["computer-command", ["always"]],
      ["computer-command", ["stop-session", { sessionID: "ses_a", extra: true }]],
      ["computer-set-prefs", [{ granted: undefined, hidden: true }]],
      ["computer-set-prefs", [[]]],
      ["computer-open-pane", ["x-apple.systempreferences:anything"]],
      ["computer-reset", ["windows-capture"]],
      ["computer-apps", ["x".repeat(257)]],
      ["computer-block", [{ key: "app:macos:a", name: "A", teamId: "X" }]],
      ["computer-unblock", [42]],
    ] as const)
      await expect(call(channel, ...args)).rejects.toThrow()
    expect(f.calls).toEqual([])
    await call("computer-command", "stop-session", { sessionID: "ses_a" })
    await call("computer-block", { key: "app:macos:com.apple.iwork.numbers", name: "Numbers" })
    expect(f.calls).toEqual([
      ["command", "stop-session", { sessionID: "ses_a" }],
      ["block", { key: "app:macos:com.apple.iwork.numbers", name: "Numbers" }],
    ])
  })

  test("company rules cross the bridge as pairs and the renderer receives them as a Map", async () => {
    const f = fixture()
    const wire = (await f.handlers.get("computer-prefs")!(f.sender(TRUSTED))) as ComputerSettingsWire
    // The context bridge copies plain objects by their own properties; a Map would arrive empty.
    const copied = JSON.parse(JSON.stringify(wire)) as ComputerSettingsWire
    expect(JSON.parse(JSON.stringify(settings)).policy.apps).toEqual({})
    const received = settingsFromWire(copied)
    expect(received.policy.apps).toBeInstanceOf(Map)
    expect([...received.policy.apps]).toEqual([
      ["app:macos:com.apple.calculator", "allow"],
      ["app:macos:com.microsoft.excel", "deny"],
    ])
    expect({ ...received, policy: { ...received.policy, apps: undefined } }).toEqual({
      ...settings,
      policy: { ...settings.policy, apps: undefined },
    })
    // Malformed rules yield no rules rather than an allow.
    const malformed = settingsFromWire({
      ...settingsToWire(settings),
      policy: { ...settingsToWire(settings).policy, apps: [["app:macos:x", "always"], ["app:macos:y"], "z"] as never },
    })
    expect(malformed.policy.apps.size).toBe(0)
  })
})

describe("computer state broadcast", () => {
  test("state reaches trusted main windows only, never an overlay or another page", () => {
    const window = (url: string, options: { destroyed?: boolean; contentsDestroyed?: boolean } = {}) => {
      const sent: unknown[][] = []
      return {
        sent,
        isDestroyed: () => !!options.destroyed,
        webContents: {
          isDestroyed: () => !!options.contentsDestroyed,
          getURL: () => url,
          send: (...args: unknown[]) => sent.push(args),
        },
      }
    }
    const main = window(TRUSTED)
    const overlay = window(TRUSTED)
    registerComputerOverlay(overlay)
    const other = window("https://example.invalid/")
    const closed = window(TRUSTED, { destroyed: true })
    const gone = window(TRUSTED, { contentsDestroyed: true })
    broadcastComputerState(
      state,
      () => [main, overlay, other, closed, gone],
      (url) => url === TRUSTED,
    )
    expect(main.sent).toEqual([["computer-state-changed", state]])
    for (const item of [overlay, other, closed, gone]) expect(item.sent).toEqual([])
    // D23: a deletion's selection takes the same path, so only Vector's own windows refresh their history.
    broadcastScreenshotsRemoved(
      { before: 5, sessionID: "ses_a" },
      () => [main, overlay, other, closed, gone],
      (url) => url === TRUSTED,
    )
    expect(main.sent.at(-1)).toEqual(["computer-screenshots-removed", { before: 5, sessionID: "ses_a" }])
    for (const item of [overlay, other, closed, gone]) expect(item.sent).toEqual([])
  })
})
