import { describe, expect, test } from "bun:test"
import { isTrustedRendererEvent } from "./trusted-renderer"
import { readFile } from "node:fs/promises"
import { registerComputerOverlay } from "./computer-overlay-registry"
import {
  dispatchComputerOverlayAction,
  registerComputerOverlayIpc,
  setComputerOverlayControls,
  type ComputerOverlayControls,
} from "./computer-overlay-ipc"
import type { Computer } from "@vectordevai/schema/computer"

const event = (url: string, topLevel = "vector://renderer/index.html") =>
  ({
    sender: {
      isDestroyed: () => false,
      getURL: () => topLevel,
    },
    senderFrame: { url },
  }) as never

describe("trusted renderer IPC", () => {
  test("GitHub agent methods are fixed preload calls registered through the trusted-frame guard", async () => {
    const [main, preload] = await Promise.all([
      readFile(new URL("./ipc.ts", import.meta.url), "utf8"),
      readFile(new URL("../preload/index.ts", import.meta.url), "utf8"),
    ])
    const names = [
      "status",
      "setup-preview",
      "setup",
      "bind",
      "run",
      "schedules",
      "bindings",
      "unbind",
      "runs",
      "brain-preview",
      "returned-artifacts",
      "returned-preview",
      "returned-import",
    ]
    for (const name of names) {
      expect(main).toMatch(new RegExp('handle\\(\\s*"github-agents-' + name + '"'))
      expect(preload).toContain('ipcRenderer.invoke("github-agents-' + name + '"')
    }
    expect(main).toContain("assertTrustedRenderer(event)")
    expect(main).not.toMatch(/ipcMain\.handle\(\s*["']github-agents-/)
  })
  test("rejects WSL requests sent by an untrusted child frame", () => {
    const trusted = isTrustedRendererEvent(event("https://attacker.example"), {
      windowFor: () => ({}),
      trustedUrl: (url) => url === "vector://renderer/index.html",
    })

    expect(trusted).toBe(false)
  })

  test("accepts the trusted renderer frame", () => {
    const trusted = isTrustedRendererEvent(event("vector://renderer/index.html"), {
      windowFor: () => ({}),
      trustedUrl: (url) => url === "vector://renderer/index.html",
    })

    expect(trusted).toBe(true)
  })

  test("an overlay never inherits main-window IPC even with a trusted renderer URL", () => {
    const overlay = {}
    registerComputerOverlay(overlay)
    expect(
      isTrustedRendererEvent(event("vector://renderer/index.html"), {
        windowFor: () => overlay,
        trustedUrl: () => true,
      }),
    ).toBe(false)
  })
})

function overlayFixture() {
  const clock = { elapsed: 700 }
  const frame = {}
  const contents = { id: 42, mainFrame: frame, isDestroyed: () => false }
  const calls: { action: Computer.OverlayAction; requestID?: string }[] = []
  const hovers: boolean[] = []
  const state: Computer.ComputerState = {
    phase: "asking",
    backend: "local-macos",
    mode: "foreground",
    apps: [],
    queue: [],
    escStops: false,
    stopChord: "Command+Shift+Escape",
    lease: 1,
    reduceMotion: false,
    ask: {
      requestID: "per_open",
      directory: "/fixture",
      kind: "app",
      title: "Allow Writer?",
      canAlways: false,
      shownAt: 1000,
    },
  }
  const control: ComputerOverlayControls = {
    banner: () => ({ isDestroyed: () => false, webContents: contents }),
    state: () => state,
    armed: (requestID) => requestID === state.ask?.requestID && clock.elapsed >= 700,
    async act(action, requestID) {
      calls.push({ action, ...(requestID ? { requestID } : {}) })
      return true
    },
    hover(on) {
      hovers.push(on)
    },
  }
  return { control, state, contents, calls, hovers, clock, event: { sender: contents, senderFrame: frame } }
}

describe("banner IPC authority", () => {
  test("wall-clock jumps cannot replace the banner's monotonic arming witness", async () => {
    const fake = overlayFixture()
    fake.clock.elapsed = 699
    const control = { ...fake.control, state: () => ({ ...fake.state, ask: { ...fake.state.ask!, shownAt: 1 } }) }
    expect(await dispatchComputerOverlayAction(fake.event, control, "allow", "per_open")).toBe(false)
    fake.clock.elapsed = 700
    expect(await dispatchComputerOverlayAction(fake.event, control, "allow", "per_open")).toBe(true)
  })
  test("Allow binds the open request and exact 700 ms arm boundary", async () => {
    const fake = overlayFixture()
    fake.clock.elapsed = 699
    expect(await dispatchComputerOverlayAction(fake.event, fake.control, "allow", "per_other")).toBe(false)
    expect(await dispatchComputerOverlayAction(fake.event, fake.control, "allow", "per_open")).toBe(false)
    expect(fake.calls).toEqual([])
    fake.clock.elapsed = 700
    expect(await dispatchComputerOverlayAction(fake.event, fake.control, "allow", "per_open")).toBe(true)
    expect(fake.calls).toEqual([{ action: "allow", requestID: "per_open" }])
  })

  test("another sender, a child frame, destroyed banner and stale controller cannot answer", async () => {
    const fake = overlayFixture()
    expect(
      await dispatchComputerOverlayAction({ ...fake.event, sender: { ...fake.contents } }, fake.control, "stop"),
    ).toBe(false)
    expect(await dispatchComputerOverlayAction({ ...fake.event, senderFrame: {} }, fake.control, "stop")).toBe(false)
    expect(await dispatchComputerOverlayAction({ sender: fake.contents }, fake.control, "stop")).toBe(false)
    const closed = { ...fake.control, banner: () => ({ isDestroyed: () => true, webContents: fake.contents }) }
    expect(await dispatchComputerOverlayAction(fake.event, closed, "stop")).toBe(false)
    expect(await dispatchComputerOverlayAction(fake.event, undefined, "stop")).toBe(false)
    expect(fake.calls).toEqual([])
  })

  test("Stop remains immediate while an ask is still arming", async () => {
    const fake = overlayFixture()
    fake.clock.elapsed = 0
    expect(await dispatchComputerOverlayAction(fake.event, fake.control, "stop", undefined)).toBe(true)
    expect(await dispatchComputerOverlayAction(fake.event, fake.control, "stop", "per_open")).toBe(false)
    expect(await dispatchComputerOverlayAction(fake.event, fake.control, "always", "per_open")).toBe(false)
    expect(fake.calls).toEqual([{ action: "stop" }])
  })

  test("every displayed answer requires its current request and cannot call an unoffered action", async () => {
    for (const [kind, action] of [
      ["app", "deny"],
      ["sensitive", "allow"],
      ["handoff", "continue"],
      ["check_in", "keep-going"],
      ["pointer", "hand-over"],
      ["pointer", "not-now"],
    ] as const) {
      const fake = overlayFixture()
      const control = { ...fake.control, state: () => ({ ...fake.state, ask: { ...fake.state.ask!, kind } }) }
      expect(await dispatchComputerOverlayAction(fake.event, control, action, "per_old")).toBe(false)
      expect(await dispatchComputerOverlayAction(fake.event, control, action, "per_open")).toBe(true)
    }
    const fake = overlayFixture()
    expect(await dispatchComputerOverlayAction(fake.event, fake.control, "continue", "per_open")).toBe(false)
    expect(await dispatchComputerOverlayAction(fake.event, { ...fake.control, act: async () => false }, "stop")).toBe(
      false,
    )
    expect(
      await dispatchComputerOverlayAction(
        fake.event,
        {
          ...fake.control,
          act: async () => {
            throw new Error("closed")
          },
        },
        "stop",
      ),
    ).toBe(false)
  })

  test("registered handlers guard hover and stop using the current controller", async () => {
    const fake = overlayFixture()
    const invoke = new Map<string, Parameters<Parameters<typeof registerComputerOverlayIpc>[0]["handle"]>[1]>()
    const listeners = new Map<string, Parameters<Parameters<typeof registerComputerOverlayIpc>[0]["on"]>[1]>()
    registerComputerOverlayIpc({
      handle: (name, fn) => {
        invoke.set(name, fn)
      },
      on: (name, fn) => {
        listeners.set(name, fn)
      },
    })
    const detachOld = setComputerOverlayControls(fake.control)
    try {
      listeners.get("computer-overlay-hover")!({ ...fake.event, senderFrame: {} }, true)
      listeners.get("computer-overlay-hover")!(fake.event, "true")
      expect(fake.hovers).toEqual([])
      listeners.get("computer-overlay-hover")!(fake.event, true)
      expect(fake.hovers).toEqual([true])
      expect(await invoke.get("computer-overlay-act")!(fake.event, "stop")).toBe(true)
      const detachCurrent = setComputerOverlayControls({ ...fake.control })
      detachOld()
      expect(await invoke.get("computer-overlay-act")!(fake.event, "stop")).toBe(true)
      detachCurrent()
      expect(await invoke.get("computer-overlay-act")!(fake.event, "stop")).toBe(false)
      setComputerOverlayControls(undefined)
      expect(await invoke.get("computer-overlay-act")!(fake.event, "stop")).toBe(false)
    } finally {
      setComputerOverlayControls(undefined)
    }
  })
})
