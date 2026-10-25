import { describe, expect, mock, test } from "bun:test"
import type { BrowserAgentInput } from "../preload/types"

// The agent browser's permissions, downloads, dialog cover and per-page queue, against a stand-in for Electron's
// views, windows and sessions. Bun keeps a module mock for the rest of a run; the desktop suite runs each file in
// its own process.

type Handler = (...input: unknown[]) => unknown

class FakeSession {
  request?: Handler
  check?: Handler
  installs = 0
  readonly listeners = new Map<string, Handler>()
  readonly web = new Map<string, Handler>()
  readonly webRequest = {
    onSendHeaders: (listener: Handler) => void this.web.set("sendHeaders", listener),
    onCompleted: (listener: Handler) => void this.web.set("completed", listener),
    onErrorOccurred: (listener: Handler) => void this.web.set("errorOccurred", listener),
  }
  setPermissionRequestHandler(handler: Handler) {
    this.installs++
    this.request = handler
  }
  setPermissionCheckHandler(handler: Handler) {
    this.check = handler
  }
  on(event: string, listener: Handler) {
    this.listeners.set(event, listener)
  }
}

// While set, a page's scripts never answer, as a page in a busy loop or one that replaced its timers would not.
const page = { stuck: false }
const answer = () => (page.stuck ? new Promise<never>(() => undefined) : Promise.resolve(undefined))
const worlds: { world: number; code: string }[] = []
const ids = { contents: 0 }
const contents = () => {
  const state = { closed: false }
  return {
    id: ++ids.contents,
    on: () => undefined,
    once: () => undefined,
    removeListener: () => undefined,
    setWindowOpenHandler: () => undefined,
    isDestroyed: () => state.closed,
    getURL: () => "",
    getTitle: () => "",
    close: () => {
      state.closed = true
    },
    isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack: () => undefined },
    executeJavaScript: answer,
    // Only the wait helpers run in their own world.
    executeJavaScriptInIsolatedWorld: (world: number, scripts: { code: string }[]) => {
      worlds.push({ world, code: scripts[0]!.code })
      return answer()
    },
  }
}

// Every view the agent creates, newest last.
const created: FakeView[] = []

class FakeView {
  readonly webContents = contents()
  visible = true
  constructor() {
    created.push(this)
  }
  setBackgroundColor() {}
  setBounds() {}
  setVisible(visible: boolean) {
    this.visible = visible
  }
  getVisible() {
    return this.visible
  }
}

// Every window made, the park window included, with the views it holds.
const made: FakeWindow[] = []
class FakeWindow {
  readonly children = new Set<FakeView>()
  readonly contentView = {
    addChildView: (view: FakeView) => void this.children.add(view),
    removeChildView: (view: FakeView) => void this.children.delete(view),
  }
  readonly webContents = { send: () => undefined }
  destroyed = false
  constructor(readonly options?: Record<string, unknown>) {
    made.push(this)
  }
  once() {}
  isDestroyed() {
    return this.destroyed
  }
  destroy() {
    this.destroyed = true
  }
}
const fakeWindow = () => new FakeWindow()
// The hidden window that holds every view no Preview shows.
const parked = () => made.find((window) => window.options?.show === false && !window.destroyed)

const partitions = new Map<string, FakeSession>()
const windows = new Map<unknown, FakeWindow>()
const electron = {
  BrowserWindow: Object.assign(FakeWindow, { fromWebContents: (sender: unknown) => windows.get(sender) }),
  WebContentsView: FakeView,
  session: {
    fromPartition: (name: string) => {
      const existing = partitions.get(name) ?? new FakeSession()
      partitions.set(name, existing)
      return existing
    },
  },
}
mock.module("electron", () => ({ default: electron, ...electron }))

const agent = await import("./browser-agent")
const run = (input: BrowserAgentInput, event?: unknown) =>
  agent.runBrowserAgent(event as Parameters<typeof agent.runBrowserAgent>[0], input)
const panel = () => {
  const sender = { getZoomFactor: () => 1 }
  const window = fakeWindow()
  windows.set(sender, window)
  return { event: { sender }, window }
}

describe("agent browser permissions and downloads", () => {
  test("grants a page fullscreen and nothing else", () => {
    expect(agent.browserPermissionAllowed("fullscreen")).toBe(true)
    for (const permission of [
      "media",
      "geolocation",
      "notifications",
      "clipboard-read",
      "clipboard-sanitized-write",
      "midi",
      "midiSysex",
      "pointerLock",
      "keyboardLock",
      "openExternal",
      "display-capture",
      "window-management",
      "storage-access",
      "fileSystem",
      "hid",
      "serial",
      "usb",
      "unknown",
    ])
      expect({ permission, allowed: agent.browserPermissionAllowed(permission) }).toEqual({
        permission,
        allowed: false,
      })
  })

  test("the agent browser's partition answers permission requests and checks itself, once", async () => {
    await run({ contextId: "ses_permissions", command: "wait", milliseconds: 0 })
    await run({ contextId: "ses_permissions_other", command: "wait", milliseconds: 0 })
    const partition = partitions.get("persist:vector-browser")!
    expect(partition.installs).toBe(1)
    const answers: boolean[] = []
    partition.request!(undefined, "media", (granted: boolean) => answers.push(granted))
    partition.request!(undefined, "notifications", (granted: boolean) => answers.push(granted))
    partition.request!(undefined, "fullscreen", (granted: boolean) => answers.push(granted))
    expect(answers).toEqual([false, false, true])
    expect(partition.check!(undefined, "geolocation", "https://example.com", {})).toBe(false)
    expect(partition.check!(undefined, "fullscreen", "https://example.com", {})).toBe(true)
  })

  test("cancels a download and says so in the page's next report", async () => {
    const first = await run({ contextId: "ses_download", command: "wait", milliseconds: 0 })
    expect(first.networkErrors).toEqual([])
    const partition = partitions.get("persist:vector-browser")!
    const view = created.at(-1)!
    const cancelled: string[] = []
    partition.listeners.get("will-download")!(
      { preventDefault: () => cancelled.push("cancelled") },
      { getURL: () => "https://files.example.com/report.zip?token=abc123" },
      view.webContents,
    )
    expect(cancelled).toEqual(["cancelled"])
    const next = await run({ contextId: "ses_download", command: "wait", milliseconds: 0 })
    expect(next.networkErrors).toEqual([
      { url: expect.stringContaining("https://files.example.com/report.zip"), error: agent.DOWNLOADS_OFF },
    ])
    expect(next.networkErrors[0]!.url).not.toContain("abc123")
    expect(next.actions.some((action) => action.label === "Cancelled a download" && !action.ok)).toBe(true)
    // A download from a page no task owns is still cancelled.
    partition.listeners.get("will-download")!(
      { preventDefault: () => cancelled.push("cancelled") },
      { getURL: () => "https://files.example.com/other.zip" },
      contents(),
    )
    expect(cancelled).toEqual(["cancelled", "cancelled"])
  })
})

describe("dialogs over the agent browser", () => {
  const context = (id: string, window: object, visible: boolean) => {
    const view = new FakeView()
    view.visible = visible
    return {
      id,
      tabs: [{ id: "tab_1", view, window }],
      active: "tab_1",
      hostWindow: window,
    } as unknown as agent.BrowserContext
  }

  test("hide every view in the dialog's window, and restore only the ones they hid", () => {
    const window = fakeWindow()
    const elsewhere = fakeWindow()
    const shown = context("shown", window, true)
    const hidden = context("hidden", window, false)
    const other = context("other", elsewhere, true)
    const all = [shown, hidden, other]
    const visible = () => all.map((item) => (item.tabs[0]!.view as unknown as FakeView).visible)

    agent.setWindowVisible(window as never, false, all)
    expect(visible()).toEqual([false, false, true])
    agent.setWindowVisible(window as never, false, all)
    expect(visible()).toEqual([false, false, true])
    agent.setWindowVisible(window as never, true, all)
    expect(visible()).toEqual([true, false, true])
  })

  test("the app's dialog hides the attached browser whatever context it names, and a view attached under it waits", async () => {
    const { event, window } = panel()
    const bounds = { x: 0, y: 0, width: 800, height: 600 }
    await run({ contextId: "ses_panel", command: "attach", bounds }, event)
    const view = created.at(-1)!
    expect(view.visible).toBe(true)
    expect(window.children.has(view)).toBe(true)

    expect((await run({ contextId: "modal", command: "setVisible", visible: false }, event)).browserStatus).toBe(
      "stopped",
    )
    expect(view.visible).toBe(false)

    await run({ contextId: "ses_panel_late", command: "attach", bounds }, event)
    const late = created.at(-1)!
    expect(late).not.toBe(view)
    expect(late.visible).toBe(false)

    await run({ contextId: "modal", command: "setVisible", visible: true }, event)
    // The view attached last is the one the panel shows; attaching it parked the first, which keeps drawing there.
    expect(late.visible).toBe(true)
    expect(window.children.has(late)).toBe(true)
    expect(window.children.has(view)).toBe(false)
    expect(parked()!.children.has(view)).toBe(true)
    expect(view.visible).toBe(true)
    expect(windows.get(event.sender)).toBe(window)
  })

  test("a show request that does not come from the panel waits for the dialog to close too", async () => {
    const { event } = panel()
    await run(
      { contextId: "ses_bridge_show", command: "attach", bounds: { x: 0, y: 0, width: 800, height: 600 } },
      event,
    )
    const view = created.at(-1)!
    await run({ contextId: "modal", command: "setVisible", visible: false }, event)
    expect(view.visible).toBe(false)
    // The browser bridge has no IPC event: its show leaves the view hidden under the dialog.
    await run({ contextId: "ses_bridge_show", command: "setVisible", visible: true })
    expect(view.visible).toBe(false)
    await run({ contextId: "modal", command: "setVisible", visible: true }, event)
    expect(view.visible).toBe(true)
  })
})

describe("commands on one page", () => {
  test("run one after the other, while other pages run alongside", async () => {
    const order: string[] = []
    const slow = run({ contextId: "ses_queue", command: "wait", milliseconds: 80 }).then(() => order.push("slow"))
    const next = run({ contextId: "ses_queue", command: "wait", milliseconds: 0 }).then(() => order.push("next"))
    const elsewhere = run({ contextId: "ses_queue_other", command: "wait", milliseconds: 0 }).then(() =>
      order.push("elsewhere"),
    )
    await Promise.all([slow, next, elsewhere])
    expect(order).toEqual(["elsewhere", "slow", "next"])
  })

  test("a failed command does not stop the next one", async () => {
    const failed = await run({ contextId: "ses_queue_fail", command: "click" })
    expect(failed.ok).toBe(false)
    const after = await run({ contextId: "ses_queue_fail", command: "wait", milliseconds: 0 })
    expect(after.ok).toBe(true)
  })

  test("a page that never answers gives the queue up at the deadline, and the next command runs", async () => {
    const page = { queue: Promise.resolve() as Promise<unknown>, closing: new AbortController() }
    const order: string[] = []
    const stuck = agent.queueTurn(
      page,
      () => new Promise<string>(() => undefined),
      (reason) => reason,
      20,
    )
    const next = agent.queueTurn(
      page,
      async () => "next",
      (reason) => reason,
      20,
    )
    void stuck.then((result) => order.push(result))
    void next.then((result) => order.push(result))
    expect(await stuck).toBe("timeout")
    expect(await next).toBe("next")
    expect(order).toEqual(["timeout", "next"])
  })

  test("closing a page ends its running command and every waiting one at once", async () => {
    const page = { queue: Promise.resolve() as Promise<unknown>, closing: new AbortController() }
    const stuck = agent.queueTurn(
      page,
      () => new Promise<string>(() => undefined),
      (reason) => reason,
    )
    const waiting = agent.queueTurn(
      page,
      async () => "ran",
      (reason) => reason,
    )
    page.closing.abort()
    expect(await Promise.all([stuck, waiting])).toEqual(["closed", "closed"])
    expect(
      await agent.queueTurn(
        page,
        async () => "ran",
        (reason) => reason,
      ),
    ).toBe("closed")
  })

  test("a command that finishes in time keeps its own result and leaves no timer behind", async () => {
    const page = { queue: Promise.resolve() as Promise<unknown>, closing: new AbortController() }
    const ended: string[] = []
    const end = (reason: string) => {
      ended.push(reason)
      return reason
    }
    expect(await agent.queueTurn(page, async () => "done", end, 30)).toBe("done")
    page.closing.abort()
    await Bun.sleep(60)
    expect(ended).toEqual([])
  })

  test("Close and the Preview's own buttons never wait behind a page that stopped answering", async () => {
    const pending = Symbol("still waiting")
    const settled = <T>(promise: Promise<T>) => Promise.race([promise, Bun.sleep(500).then(() => pending)])
    await run({ contextId: "ses_stuck", command: "wait", milliseconds: 0 })
    page.stuck = true
    try {
      const hung = run({ contextId: "ses_stuck", command: "waitForSelector", selector: "#never" })
      const behind = run({ contextId: "ses_stuck", command: "scroll", deltaY: 100 })
      expect(await settled(hung)).toBe(pending)
      // The wait helper ran in its own world, away from the page's globals.
      expect(worlds.at(-1)?.code).toContain("#never")
      expect(worlds.at(-1)!.world).toBeGreaterThan(0)

      // The user's Back button in Preview runs alongside the stuck command.
      expect(await settled(run({ contextId: "ses_stuck", command: "goBack" }, { sender: {} }))).not.toBe(pending)

      // Close ends the stuck command and the one behind it at once.
      expect(await settled(run({ contextId: "ses_stuck", command: "closeBrowser" }))).not.toBe(pending)
      expect(await settled(hung)).toMatchObject({
        ok: false,
        error: "The browser was closed before waitForSelector finished.",
      })
      expect(await settled(behind)).toMatchObject({
        ok: false,
        error: "The browser was closed before scroll finished.",
      })
    } finally {
      page.stuck = false
    }
    // The next command on that task opens a fresh page and runs at once.
    expect(await settled(run({ contextId: "ses_stuck", command: "wait", milliseconds: 0 }))).toMatchObject({
      ok: true,
      browserStatus: "running",
    })
  })

  test("a page waiting for its first command is not retired to make room for another", async () => {
    const first = run({ contextId: "ses_new_a", command: "wait", milliseconds: 20 })
    const second = run({ contextId: "ses_new_b", command: "wait", milliseconds: 0 })
    expect(await Promise.all([first, second])).toMatchObject([{ ok: true }, { ok: true }])
  })

  test("sets no cap on pages", async () => {
    const reports = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        run({ contextId: `ses_many_${index}`, command: "wait", milliseconds: 0 }),
      ),
    )
    expect(reports.every((report) => report.ok && report.browserStatus === "running")).toBe(true)
  })
})
