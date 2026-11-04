import { afterAll, expect, mock, test } from "bun:test"
import { registerComputerOverlay } from "./computer-overlay-registry"

// Exercise the real window setters with inert native edges; no Electron process or OS window is created.
const calls: { window: string; method: string; value: unknown }[] = []
function window(name: string) {
  const state = { zoom: 2 }
  return {
    setBackgroundColor: (color: string) => calls.push({ window: name, method: "background", value: color }),
    setTitleBarOverlay: (value: unknown) => calls.push({ window: name, method: "titlebar", value }),
    webContents: {
      send: (channel: string, value: unknown) => calls.push({ window: name, method: channel, value }),
      getZoomFactor: () => state.zoom,
      setZoomFactor(value: number) {
        state.zoom = value
        calls.push({ window: name, method: "zoom", value })
      },
    },
  }
}
const main = window("main")
const overlay = window("overlay")
registerComputerOverlay(overlay)
const stored = new Map<string, unknown>()
mock.module("electron", () => ({
  app: {},
  BrowserWindow: { getAllWindows: () => [main, overlay] },
  dialog: {},
  net: {},
  nativeImage: {},
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged() {} },
}))
mock.module("electron-window-state", () => ({ default() {} }))
mock.module("./logging", () => ({ exportDebugLogs() {}, write() {} }))
mock.module("./store", () => ({
  getStore: () => ({
    get: (key: string) => stored.get(key),
    set: (key: string, value: unknown) => stored.set(key, value),
  }),
  removeStoreFile() {},
}))
const { setBackgroundColor, setPinchZoomEnabled } = await import("./windows")
afterAll(() => mock.restore())

test("a theme change leaves overlays transparent and pinch-zoom changes never touch them", () => {
  setBackgroundColor("#123456")
  setPinchZoomEnabled(false)
  setPinchZoomEnabled(true)
  expect(calls.filter((call) => call.window === "overlay")).toEqual([])
  expect(calls.filter((call) => call.method === "background")).toEqual([
    { window: "main", method: "background", value: "#123456" },
  ])
  expect(calls.filter((call) => call.method === "pinch-zoom-enabled-changed")).toEqual([
    { window: "main", method: "pinch-zoom-enabled-changed", value: false },
    { window: "main", method: "pinch-zoom-enabled-changed", value: true },
  ])
  expect(calls.filter((call) => call.method === "zoom")).toEqual([{ window: "main", method: "zoom", value: 1 }])
  expect(main.webContents.getZoomFactor()).toBe(1)
  expect(overlay.webContents.getZoomFactor()).toBe(2)
})
