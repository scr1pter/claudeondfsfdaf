import { afterAll, expect, mock, test } from "bun:test"
import type { OverlayApi, OverlayMessage } from "@vectordevai/app/computer/overlay-page"

const listeners = new Set<(event: unknown, message: unknown) => void>()
const invokes: unknown[][] = []
const sends: unknown[][] = []
const state: { api?: OverlayApi; name?: string; result: unknown; rejects: boolean } = { result: true, rejects: false }
mock.module("electron", () => ({
  contextBridge: {
    exposeInMainWorld(name: string, api: OverlayApi) {
      state.name = name
      state.api = api
    },
  },
  ipcRenderer: {
    on(name: string, callback: (event: unknown, message: unknown) => void) {
      expect(name).toBe("computer-overlay-state")
      listeners.add(callback)
    },
    removeListener(name: string, callback: (event: unknown, message: unknown) => void) {
      expect(name).toBe("computer-overlay-state")
      listeners.delete(callback)
    },
    async invoke(...args: unknown[]) {
      invokes.push(args)
      if (state.rejects) throw new Error("closed")
      return state.result
    },
    send(...args: unknown[]) {
      sends.push(args)
    },
  },
}))
await import("../preload/computer-overlay")
afterAll(() => mock.restore())

test("the isolated overlay receives only projected view data and can unsubscribe", () => {
  expect(state.name).toBe("computerOverlay")
  expect(Object.keys(state.api!).sort()).toEqual(["act", "hover", "onState"])
  const received: OverlayMessage[] = []
  const unsubscribe = state.api!.onState((value) => received.push(value))
  const view = {
    type: "banner",
    tone: "ask",
    line: "Allow Writer?",
    key: "Esc",
    waiting: "",
    reduceMotion: false,
    buttons: [{ action: "allow", label: "Allow", requestID: "per_one", arm: true, directory: "/private" }],
    holder: { directory: "/private" },
    token: "private-fixture-value",
  }
  for (const listener of listeners) listener({ sender: "must never escape" }, view)
  expect(received).toEqual([
    {
      type: "banner",
      tone: "ask",
      line: "Allow Writer?",
      key: "Esc",
      waiting: "",
      reduceMotion: false,
      buttons: [{ action: "allow", label: "Allow", requestID: "per_one", arm: true }],
    },
  ])
  expect(received[0]).not.toBe(view)
  for (const listener of listeners) {
    listener({}, { phase: "working", holder: { directory: "/private" } })
    listener({}, { ...view, buttons: [{ action: "always", label: "Always" }] })
    listener({}, { ...view, line: "x".repeat(4097) })
  }
  expect(received).toHaveLength(1)
  if (typeof unsubscribe === "function") unsubscribe()
  expect(listeners.size).toBe(0)
})

test("only valid bounded actions and literal successful replies cross the preload", async () => {
  const before = invokes.length
  expect(await state.api!.act("always" as never)).toBe(false)
  expect(await state.api!.act("allow", "x".repeat(129))).toBe(false)
  expect(invokes).toHaveLength(before)
  expect(await state.api!.act("allow", "per_one")).toBe(true)
  expect(invokes.at(-1)).toEqual(["computer-overlay-act", "allow", "per_one"])
  state.result = "true"
  expect(await state.api!.act("stop")).toBe(false)
  state.rejects = true
  expect(await state.api!.act("stop")).toBe(false)
  state.rejects = false
  state.api!.hover(true)
  state.api!.hover("true" as never)
  expect(sends).toEqual([["computer-overlay-hover", true]])
})
