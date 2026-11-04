import { afterAll, expect, mock, test } from "bun:test"
import { Computer } from "@vectordevai/schema/computer"
import type { ElectronAPI } from "../preload/types"

// The main window's preload, with Electron replaced: it must name exactly section 2.9's channels.
const invokes: unknown[][] = []
const listeners = new Map<string, Set<(event: unknown, value: unknown) => void>>()
const state: { api?: ElectronAPI } = {}
mock.module("electron", () => ({
  contextBridge: {
    exposeInMainWorld(name: string, api: ElectronAPI) {
      expect(name).toBe("api")
      state.api = api
    },
  },
  ipcRenderer: {
    invoke: async (...args: unknown[]) => void invokes.push(args),
    send: () => {},
    on(name: string, callback: (event: unknown, value: unknown) => void) {
      listeners.set(name, (listeners.get(name) ?? new Set()).add(callback))
    },
    removeListener(name: string, callback: (event: unknown, value: unknown) => void) {
      listeners.get(name)?.delete(callback)
    },
  },
  webUtils: { getPathForFile: () => "" },
}))
await import("../preload/index")
afterAll(() => mock.restore())

test("window.api.computer invokes exactly the section 2.9 channels, and Linux reports unsupported", async () => {
  const computer = state.api!.computer
  expect(computer.supported).toBe(process.platform !== "linux")
  expect(Object.keys(computer).sort()).toEqual([...Computer.PLATFORM_KEYS].sort())
  await computer.status()
  await computer.state()
  await computer.command("stop-session", { sessionID: "ses_a" })
  await computer.prefs()
  await computer.setPrefs({ notify: false })
  await computer.permissions()
  await computer.recheck()
  await computer.openPane("screen")
  await computer.reset("accessibility")
  await computer.apps("Num")
  await computer.removeAlways("app:macos:com.apple.calculator")
  await computer.removeAllAlways()
  // Only the row's key and name cross; any other field the caller holds stays in the renderer.
  await computer.block({ key: "app:macos:com.apple.iwork.numbers", name: "Numbers", icon: "x" } as never)
  await computer.unblock("app:macos:com.apple.iwork.numbers")
  await computer.deleteScreenshots()
  expect(invokes).toEqual([
    ["computer-status"],
    ["computer-state"],
    ["computer-command", "stop-session", { sessionID: "ses_a" }],
    ["computer-prefs"],
    ["computer-set-prefs", { notify: false }],
    ["computer-permissions"],
    ["computer-recheck"],
    ["computer-open-pane", "screen"],
    ["computer-reset", "accessibility"],
    ["computer-apps", "Num"],
    ["computer-remove-always", "app:macos:com.apple.calculator"],
    ["computer-remove-all-always"],
    ["computer-block", { key: "app:macos:com.apple.iwork.numbers", name: "Numbers" }],
    ["computer-unblock", "app:macos:com.apple.iwork.numbers"],
    ["computer-delete-screenshots"],
  ])
  const used = new Set(invokes.map(([channel]) => channel))
  expect([...used].sort()).toEqual(
    Computer.IPC_CHANNELS.filter((channel) => channel !== "computer-state-changed").sort(),
  )
})

test("state changes arrive on computer-state-changed, and unsubscribing stops them", () => {
  const seen: unknown[] = []
  const stop = state.api!.computer.onState((value) => seen.push(value))
  for (const listener of listeners.get("computer-state-changed") ?? [])
    listener({ sender: "ignored" }, { phase: "ready" })
  stop()
  for (const listener of listeners.get("computer-state-changed") ?? []) listener({}, { phase: "off" })
  expect(seen).toEqual([{ phase: "ready" }])
  expect(listeners.get("computer-state-changed")?.size).toBe(0)
})

test("a notification click arrives as an app path on computer-open-session", () => {
  const seen: string[] = []
  const stop = state.api!.onComputerOpen((href) => seen.push(href))
  for (const listener of listeners.get("computer-open-session") ?? []) listener({}, "/abc/session/ses_a")
  stop()
  expect(seen).toEqual(["/abc/session/ses_a"])
  expect(listeners.get("computer-open-session")?.size).toBe(0)
})
