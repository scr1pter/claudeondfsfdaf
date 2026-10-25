import { describe, expect, jest, mock, test } from "bun:test"
import type { BrowserAgentInput } from "../preload/types"

// The agent browser's hosting, tabs, request log, settling and navigation rules, against a stand-in for Electron's
// windows, views, pages and sessions. What only a real Electron run shows (a page painting and being captured in the
// hidden park window, dialogs answered by Chromium) is left to the desktop smoke. Bun keeps a module mock for the rest of
// a run; the desktop suite runs each file in its own process.

// A listener of any shape, as Electron's events take.
type Listener = { listener(...input: unknown[]): unknown }["listener"]

class Emitter {
  readonly listeners = new Map<string, Listener[]>()
  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }
  once(event: string, listener: Listener) {
    const wrapped = (...input: unknown[]) => {
      this.removeListener(event, wrapped)
      return listener(...input)
    }
    return this.on(event, wrapped)
  }
  removeListener(event: string, listener: Listener) {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((item) => item !== listener),
    )
    return this
  }
  emit(event: string, ...input: unknown[]) {
    ;(this.listeners.get(event) ?? []).forEach((listener) => listener(...input))
  }
}

class FakeSession extends Emitter {
  readonly web = new Map<string, Listener>()
  readonly webRequest = {
    onSendHeaders: (listener: Listener) => void this.web.set("sendHeaders", listener),
    onCompleted: (listener: Listener) => void this.web.set("completed", listener),
    onErrorOccurred: (listener: Listener) => void this.web.set("errorOccurred", listener),
  }
  setPermissionRequestHandler() {}
  setPermissionCheckHandler() {}
}

// An Electron event a listener may prevent.
const preventable = <T extends object>(details: T) => {
  const state = { prevented: false }
  return Object.assign(details, {
    preventDefault: () => {
      state.prevented = true
    },
    prevented: () => state.prevented,
  })
}

const ids = { contents: 0, request: 0 }
// While set, a new tab's debugger cannot attach, as when developer tools hold it.
const debuggers = { refuse: false }

// The debugger a tab's file chooser interception drives: it records what it was sent and can deliver an event.
class FakeDebugger extends Emitter {
  attached = false
  readonly sent: { method: string; params?: unknown }[] = []
  attach() {
    if (debuggers.refuse) throw new Error("Another debugger is already attached")
    this.attached = true
  }
  detach() {
    this.attached = false
  }
  isAttached() {
    return this.attached
  }
  async sendCommand(method: string, params?: unknown) {
    this.sent.push({ method, ...(params === undefined ? {} : { params }) })
    return {}
  }
}

class FakeContents extends Emitter {
  readonly id = ++ids.contents
  readonly debugger = new FakeDebugger()
  url = ""
  title = ""
  loading = false
  destroyed = false
  history: string[] = []
  index = -1
  openHandler?: Listener
  /** Where a load of a URL is redirected to, before it commits. */
  readonly redirects = new Map<string, { url: string; isMainFrame: boolean }>()
  /** What the page's own world hands back when Vector drains its issues and dialogs. */
  drain: unknown
  readonly inputs: { type: string; keyCode?: string; modifiers?: string[] }[] = []
  readonly navigationHistory = {
    canGoBack: () => this.index > 0,
    canGoForward: () => this.index < this.history.length - 1,
    goBack: () => this.traverse(-1),
    goForward: () => this.traverse(1),
  }
  setWindowOpenHandler(handler: Listener) {
    this.openHandler = handler
  }
  async loadURL(url: string) {
    this.emit("did-start-navigation")
    const redirect = this.redirects.get(url)
    if (redirect) {
      const event = preventable({ url: redirect.url, isMainFrame: redirect.isMainFrame })
      this.emit("will-redirect", event)
      if (event.prevented()) throw new Error(`ERR_ABORTED (-3) loading '${url}'`)
    }
    this.commit(redirect?.isMainFrame ? redirect.url : url)
  }
  commit(url: string) {
    this.history = [...this.history.slice(0, this.index + 1), url]
    this.index = this.history.length - 1
    this.url = url
    this.emit("did-navigate", {}, url)
    this.emit("did-stop-loading")
  }
  traverse(step: number) {
    this.index += step
    this.url = this.history[this.index]!
    setTimeout(() => {
      this.emit("did-navigate", {}, this.url)
      this.emit("did-stop-loading")
    }, 30)
  }
  reload() {
    setTimeout(() => {
      this.emit("did-navigate", {}, this.url)
      this.emit("did-stop-loading")
    }, 30)
  }
  isLoading() {
    return this.loading
  }
  getURL() {
    return this.url
  }
  getTitle() {
    return this.title
  }
  isDestroyed() {
    return this.destroyed
  }
  close() {
    this.destroyed = true
    this.emit("destroyed")
  }
  focus() {}
  sendInputEvent(event: { type: string; keyCode?: string; modifiers?: string[] }) {
    this.inputs.push(event)
  }
  getZoomFactor() {
    return 1
  }
  async capturePage() {
    return { toDataURL: () => "data:image/png;base64,iVBORw0KGgo=" }
  }
  async executeJavaScript(code: string) {
    if (code.includes("const issues = window.__vectorAgentIssues")) return this.drain
    return undefined
  }
  async executeJavaScriptInIsolatedWorld() {
    return undefined
  }
}

const views: FakeView[] = []
class FakeView {
  readonly webContents: FakeContents
  bounds?: unknown
  visible = true
  constructor(readonly options: { webPreferences: Record<string, unknown> }) {
    this.webContents = new FakeContents()
    views.push(this)
  }
  setBackgroundColor() {}
  setBounds(bounds: unknown) {
    this.bounds = bounds
  }
  setVisible(visible: boolean) {
    this.visible = visible
  }
  getVisible() {
    return this.visible
  }
}

const windows: FakeWindow[] = []
class FakeWindow extends Emitter {
  readonly children = new Set<FakeView>()
  readonly contentView = {
    addChildView: (view: FakeView) => void this.children.add(view),
    removeChildView: (view: FakeView) => void this.children.delete(view),
  }
  readonly sent: { channel: string; payload: { contextId: string; url: string } }[] = []
  readonly webContents = {
    send: (channel: string, payload: { contextId: string; url: string }) => void this.sent.push({ channel, payload }),
  }
  destroyed = false
  constructor(readonly options?: Record<string, unknown>) {
    super()
    windows.push(this)
  }
  isDestroyed() {
    return this.destroyed
  }
  destroy() {
    this.destroyed = true
  }
}

const partitions = new Map<string, FakeSession>()
const senders = new Map<unknown, FakeWindow>()
const electron = {
  BrowserWindow: Object.assign(FakeWindow, { fromWebContents: (sender: unknown) => senders.get(sender) }),
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
// A Preview panel in a window of its own, at zoom 1.
const panel = () => {
  const sender = { getZoomFactor: () => 1 }
  const window = new FakeWindow()
  senders.set(sender, window)
  return { event: { sender }, window }
}
const park = () => windows.find((window) => window.options?.show === false && !window.destroyed)
const latest = () => views.at(-1)!
const session = () => partitions.get("persist:vector-browser")!
const BOUNDS = { x: 10, y: 20, width: 900, height: 700 }
const PARK = { x: 0, y: 0, width: 1280, height: 800 }

describe("hosting the agent browser", () => {
  test("a page no Preview shows waits in a hidden park window at a real size, and moves into the Preview and back", async () => {
    const first = await run({ contextId: "ses_park", command: "openUrl", url: "http://localhost:3000/" })
    expect(first.ok).toBe(true)
    const view = latest()
    // Pages keep running unseen; dialogs are answered at once; no File System Access picker opens.
    expect(view.options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      disableDialogs: true,
      disableBlinkFeatures: "FileSystemAccessLocal",
    })
    const host = park()!
    expect(host.options).toMatchObject({ show: false, focusable: false, skipTaskbar: true, width: 1280, height: 800 })
    const preferences = host.options!.webPreferences as { partition: string; backgroundThrottling: boolean }
    expect(preferences.backgroundThrottling).toBe(false)
    // Its own page loads nothing and keeps nothing on disk.
    expect(preferences.partition.startsWith("persist:")).toBe(false)
    expect(host.children.has(view)).toBe(true)
    expect(view.bounds).toEqual(PARK)
    expect(first.viewport).toEqual(PARK)
    expect((await run({ contextId: "ses_park", command: "takeScreenshot" })).screenshotDataUrl).toContain("base64,i")

    const { event, window } = panel()
    await run({ contextId: "ses_park", command: "attach", bounds: BOUNDS }, event)
    expect(window.children.has(view)).toBe(true)
    expect(host.children.has(view)).toBe(false)
    expect(view.bounds).toEqual(BOUNDS)
    expect(view.visible).toBe(true)
    expect((await run({ contextId: "ses_park", command: "wait", milliseconds: 0 })).viewport).toEqual(BOUNDS)

    await run({ contextId: "ses_park", command: "detach" }, event)
    expect(window.children.has(view)).toBe(false)
    expect(park()!.children.has(view)).toBe(true)
    expect(view.bounds).toEqual(PARK)
    expect(view.visible).toBe(true)
    expect((await run({ contextId: "ses_park", command: "wait", milliseconds: 0 })).viewport).toEqual(PARK)

    // The park window lives only while it holds a view.
    await run({ contextId: "ses_park", command: "closeBrowser" })
    expect(host.destroyed).toBe(true)
  })

  test("a Preview with no size yet leaves the page parked until it measures, and is told what the page shows", async () => {
    await run({ contextId: "ses_measure", command: "openUrl", url: "http://localhost:3000/dashboard" })
    const view = latest()
    const { event, window } = panel()
    await run({ contextId: "ses_measure", command: "attach" }, event)
    expect(park()!.children.has(view)).toBe(true)
    expect(window.sent.at(-1)?.payload).toMatchObject({
      contextId: "ses_measure",
      url: "http://localhost:3000/dashboard",
    })
    await run({ contextId: "ses_measure", command: "setBounds", bounds: BOUNDS }, event)
    expect(window.children.has(view)).toBe(true)
    expect(view.bounds).toEqual(BOUNDS)
    await run({ contextId: "ses_measure", command: "closeBrowser" })
  })

  test("a page that closed itself is replaced where the browser is shown, with its bounds and visibility", async () => {
    const { event, window } = panel()
    await run({ contextId: "ses_closed", command: "attach", bounds: BOUNDS }, event)
    const first = latest()
    expect(window.children.has(first)).toBe(true)
    // The page calls window.close(): Electron destroys its web contents.
    first.webContents.close()
    expect(window.children.has(first)).toBe(false)
    const next = await run({ contextId: "ses_closed", command: "wait", milliseconds: 0 })
    expect(next.ok).toBe(true)
    const replacement = latest()
    expect(replacement).not.toBe(first)
    expect(window.children.has(replacement)).toBe(true)
    expect(replacement.bounds).toEqual(BOUNDS)
    expect(replacement.visible).toBe(true)
    // Hidden by the bridge, a replacement stays hidden.
    await run({ contextId: "ses_closed", command: "setVisible", visible: false })
    replacement.webContents.close()
    await run({ contextId: "ses_closed", command: "wait", milliseconds: 0 })
    expect(window.children.has(latest())).toBe(true)
    expect(latest().visible).toBe(false)
    await run({ contextId: "ses_closed", command: "closeBrowser" })
  })
})

describe("tabs", () => {
  test("listTabs opens no page", async () => {
    const before = views.length
    const report = await run({ contextId: "ses_list", command: "listTabs" })
    expect(report).toMatchObject({ ok: true, tabs: [] })
    expect(views.length).toBe(before)
  })

  test("openTab opens a new active tab with openUrl's rules, and every report lists the tabs", async () => {
    await run({ contextId: "ses_tabs", command: "openUrl", url: "http://localhost:3000/" })
    const refused = await run({ contextId: "ses_tabs", command: "openTab", url: "https://docs.example/guide" })
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain("blocked this external website")
    expect(refused.tabs?.map((tab) => tab.id)).toEqual(["tab_1"])
    const opened = await run({
      contextId: "ses_tabs",
      command: "openTab",
      url: "https://docs.example/guide",
      allowExternal: true,
    })
    expect(opened.ok).toBe(true)
    expect(opened.activeTab).toBe("tab_2")
    expect(opened.url).toBe("https://docs.example/guide")
    expect(opened.tabs).toEqual([
      { id: "tab_1", url: "http://localhost:3000/", title: "", active: false, loading: false },
      { id: "tab_2", url: "https://docs.example/guide", title: "", active: true, loading: false },
    ])
    // The new tab's origin is approved like open_url's: a link there is followed.
    const event = preventable({})
    latest().webContents.emit("will-navigate", event, "https://docs.example/next")
    expect(event.prevented()).toBe(false)
    await run({ contextId: "ses_tabs", command: "closeBrowser" })
  })

  test("switchTab swaps the view the Preview shows and tells it; the other tab waits in the park window", async () => {
    const { event, window } = panel()
    await run({ contextId: "ses_switch", command: "attach", bounds: BOUNDS }, event)
    await run({ contextId: "ses_switch", command: "openUrl", url: "http://localhost:3000/one" })
    const one = latest()
    await run({ contextId: "ses_switch", command: "openTab", url: "http://localhost:3000/two" })
    const two = latest()
    expect(window.children.has(two)).toBe(true)
    expect(window.children.has(one)).toBe(false)
    expect(park()!.children.has(one)).toBe(true)
    const switched = await run({ contextId: "ses_switch", command: "switchTab", tabId: "tab_1" })
    expect(switched).toMatchObject({ ok: true, activeTab: "tab_1", url: "http://localhost:3000/one" })
    expect(window.children.has(one)).toBe(true)
    expect(one.bounds).toEqual(BOUNDS)
    expect(park()!.children.has(two)).toBe(true)
    expect(two.bounds).toEqual(PARK)
    expect(window.sent.at(-1)?.payload.url).toBe("http://localhost:3000/one")
    const missing = await run({ contextId: "ses_switch", command: "switchTab", tabId: "tab_9" })
    expect(missing).toMatchObject({ ok: false, error: "This browser has no tab_9. List the tabs again." })
    await run({ contextId: "ses_switch", command: "closeBrowser" })
  })

  test("closeTab shows the tab before it, tab ids are never used twice, and closing the last tab closes the browser", async () => {
    await run({ contextId: "ses_close", command: "openUrl", url: "http://localhost:3000/a" })
    await run({ contextId: "ses_close", command: "openTab", url: "http://localhost:3000/b" })
    await run({ contextId: "ses_close", command: "openTab", url: "http://localhost:3000/c" })
    const closed = await run({ contextId: "ses_close", command: "closeTab", tabId: "tab_3" })
    expect(closed).toMatchObject({ ok: true, activeTab: "tab_2", url: "http://localhost:3000/b" })
    const reopened = await run({ contextId: "ses_close", command: "openTab", url: "http://localhost:3000/d" })
    expect(reopened.tabs?.map((tab) => tab.id)).toEqual(["tab_1", "tab_2", "tab_4"])
    // Closing a tab that is not shown leaves the shown one as it is.
    expect(await run({ contextId: "ses_close", command: "closeTab", tabId: "tab_1" })).toMatchObject({
      activeTab: "tab_4",
    })
    await run({ contextId: "ses_close", command: "closeTab", tabId: "tab_2" })
    const last = await run({ contextId: "ses_close", command: "closeTab", tabId: "tab_4" })
    expect(last).toMatchObject({ ok: true, browserStatus: "stopped", tabs: [] })
  })

  test("a popup the navigation rule allows opens a new active tab, in place once 8 are open; one it blocks opens nothing", async () => {
    await run({ contextId: "ses_popup", command: "openUrl", url: "http://localhost:3000/" })
    const opener = latest().webContents
    expect(opener.openHandler!({ url: "http://localhost:3000/popup" })).toEqual({ action: "deny" })
    await Bun.sleep(0)
    const popped = await run({ contextId: "ses_popup", command: "listTabs" })
    expect(popped).toMatchObject({ activeTab: "tab_2", url: "http://localhost:3000/popup" })
    // An unapproved site opens nothing, and the next report says why.
    latest().webContents.openHandler!({ url: "https://tracker.example/" })
    const blocked = await run({ contextId: "ses_popup", command: "listTabs" })
    expect(blocked.ok).toBe(false)
    expect(blocked.error).toContain("did not follow https://tracker.example/")
    expect(blocked.tabs).toHaveLength(2)
    // Not settled: each settled command waits most of a second, and this one is about the tabs, not the page.
    for (const page of ["c", "d", "e", "f", "g", "h"])
      await run({ contextId: "ses_popup", command: "openTab", url: `http://localhost:3000/${page}`, settle: false })
    const full = await run({ contextId: "ses_popup", command: "openTab", url: "http://localhost:3000/i" })
    expect(full).toMatchObject({
      ok: false,
      error: "This browser already has 8 tabs open, the most it holds. Close one first.",
    })
    const before = views.length
    const page = latest().webContents
    page.openHandler!({ url: "http://localhost:3000/in-place" })
    await Bun.sleep(0)
    expect(views.length).toBe(before)
    expect(page.url).toBe("http://localhost:3000/in-place")
    await run({ contextId: "ses_popup", command: "closeBrowser" })
  })

  test("a popup the user opens from Preview loads in place, so Back returns to their page", async () => {
    await run({ contextId: "ses_user_popup", command: "openUrl", url: "http://localhost:3000/" })
    const page = latest().webContents
    const before = views.length
    jest.useFakeTimers()
    try {
      // Past the moment the command's own input counts as the agent's, the user clicks a link to a new tab.
      jest.advanceTimersByTime(1_000)
      page.emit("input-event", {}, { type: "mouseDown" })
      expect(page.openHandler!({ url: "http://localhost:3000/docs" })).toEqual({ action: "deny" })
    } finally {
      jest.useRealTimers()
    }
    await Bun.sleep(0)
    expect(views.length).toBe(before)
    expect(page.url).toBe("http://localhost:3000/docs")
    expect(page.navigationHistory.canGoBack()).toBe(true)
    expect(await run({ contextId: "ses_user_popup", command: "listTabs" })).toMatchObject({
      activeTab: "tab_1",
      tabs: [expect.objectContaining({ id: "tab_1" })],
    })
    await run({ contextId: "ses_user_popup", command: "closeBrowser" })
  })

  test("every tab's file choosers are held by the debugger, and a tab whose debugger cannot attach is not driven", async () => {
    await run({ contextId: "ses_chooser", command: "openUrl", url: "http://localhost:3000/" })
    const tools = latest().webContents.debugger
    expect(tools.attached).toBe(true)
    expect(tools.sent).toEqual([
      { method: "Page.enable" },
      { method: "Page.setInterceptFileChooserDialog", params: { enabled: true } },
    ])
    // A chooser the page's own script opens is dropped, and the next report says so.
    tools.emit("message", {}, "Page.fileChooserOpened", { mode: "selectSingle" })
    const report = await run({ contextId: "ses_chooser", command: "wait", milliseconds: 0 })
    expect(report.pageErrors).toContain(
      "The page tried to open a file picker. Vector never opens one in a page; hand that step to the user.",
    )
    // A dialog the debugger would hold is answered as the browser's own setting answers it, and a page is left.
    tools.sent.length = 0
    tools.emit("message", {}, "Page.javascriptDialogOpening", { type: "confirm", message: "Discard?" })
    tools.emit("message", {}, "Page.javascriptDialogOpening", { type: "beforeunload", message: "" })
    expect(tools.sent).toEqual([
      { method: "Page.handleJavaScriptDialog", params: { accept: false } },
      { method: "Page.handleJavaScriptDialog", params: { accept: true } },
    ])
    expect((await run({ contextId: "ses_chooser", command: "press", key: "Tab", settle: false })).ok).toBe(true)
    // Detached by something else, the tab is no longer driven.
    tools.emit("detach", {}, "canceled_by_user")
    const unheld =
      "Vector did not act on this page: it cannot keep the page from opening a file picker here, because the browser's debugger did not attach. Close any developer tools open on it, or open the page again."
    expect(await run({ contextId: "ses_chooser", command: "press", key: "Tab", settle: false })).toMatchObject({
      ok: false,
      error: unheld,
    })
    debuggers.refuse = true
    try {
      await run({ contextId: "ses_chooser", command: "openTab", url: "http://localhost:3000/two" })
      for (const input of [
        { command: "click", selector: "#pay" },
        { command: "press", key: "Enter" },
        { command: "type", selector: "#q", text: "x" },
      ] as const)
        expect(await run({ contextId: "ses_chooser", settle: false, ...input })).toMatchObject({
          ok: false,
          error: unheld,
        })
      expect(latest().webContents.inputs).toEqual([])
      // Reading the page still works.
      expect((await run({ contextId: "ses_chooser", command: "wait", milliseconds: 0 })).ok).toBe(true)
    } finally {
      debuggers.refuse = false
    }
    // A closed tab lets its debugger go.
    await run({ contextId: "ses_chooser", command: "closeBrowser" })
    expect(tools.attached).toBe(false)
  })

  test("console, errors, the request log and dialogs belong to their tab; downloads stay off in every tab", async () => {
    await run({ contextId: "ses_logs", command: "openUrl", url: "http://localhost:3000/" })
    const one = latest().webContents
    one.emit("console-message", { level: "error", message: "one failed", sourceId: "app.js", lineNumber: 3 })
    await run({ contextId: "ses_logs", command: "openTab", url: "http://localhost:3000/two" })
    const two = latest().webContents
    two.emit("console-message", { level: "info", message: "two loaded", sourceId: "", lineNumber: 0 })
    const prevented: string[] = []
    session().emit(
      "will-download",
      { preventDefault: () => prevented.push("download") },
      { getURL: () => "http://localhost:3000/a.zip" },
      two,
    )
    const shown = await run({ contextId: "ses_logs", command: "listTabs" })
    expect(shown.console.map((entry) => entry.message)).toEqual(["two loaded"])
    expect(prevented).toEqual(["download"])
    expect(shown.networkErrors).toEqual([{ url: "http://localhost:3000/a.zip", error: agent.DOWNLOADS_OFF }])
    const first = await run({ contextId: "ses_logs", command: "switchTab", tabId: "tab_1" })
    expect(first.console.map((entry) => entry.message)).toEqual(["one failed"])
    expect(first.networkErrors).toEqual([])
    await run({ contextId: "ses_logs", command: "closeBrowser" })
  })
})

describe("the request log", () => {
  test("lists each request of the tab, redacted; failed answers and failed requests are network errors too", async () => {
    await run({ contextId: "ses_requests", command: "openUrl", url: "http://localhost:3000/" })
    const page = latest().webContents
    const send = (url: string, type: string) => {
      const id = ++ids.request
      session().web.get("sendHeaders")!({ id, url, method: "GET", webContentsId: page.id, resourceType: type })
      return id
    }
    const api = send("http://localhost:3000/api/items?token=secret123", "xhr")
    session().web.get("completed")!({
      id: api,
      url: "http://localhost:3000/api/items?token=secret123",
      method: "GET",
      webContentsId: page.id,
      resourceType: "xhr",
      statusCode: 404,
    })
    const refused = send("http://localhost:4000/events", "other")
    session().web.get("errorOccurred")!({
      id: refused,
      url: "http://localhost:4000/events",
      method: "GET",
      webContentsId: page.id,
      resourceType: "other",
      error: "net::ERR_CONNECTION_REFUSED",
    })
    const aborted = send("http://localhost:3000/slow.js", "script")
    session().web.get("errorOccurred")!({
      id: aborted,
      url: "http://localhost:3000/slow.js",
      method: "GET",
      webContentsId: page.id,
      resourceType: "script",
      error: "net::ERR_ABORTED",
    })
    Array.from({ length: 40 }, (_, index) =>
      page.emit("console-message", { level: "warning", message: `warning ${index}`, sourceId: "", lineNumber: 0 }),
    )
    const logs = await run({ contextId: "ses_requests", command: "readLogs" })
    expect(logs.network).toEqual([
      {
        method: "GET",
        url: expect.stringContaining("http://localhost:3000/api/items"),
        type: "xhr",
        status: 404,
        at: expect.any(String),
        durationMs: expect.any(Number),
      },
      expect.objectContaining({ url: "http://localhost:4000/events", error: "net::ERR_CONNECTION_REFUSED" }),
      expect.objectContaining({ url: "http://localhost:3000/slow.js", error: "net::ERR_ABORTED" }),
    ])
    expect(JSON.stringify(logs)).not.toContain("secret123")
    expect(logs.networkErrors).toEqual([
      { url: expect.stringContaining("/api/items"), method: "GET", status: 404 },
      { url: "http://localhost:4000/events", method: "GET", error: "net::ERR_CONNECTION_REFUSED" },
    ])
    // readLogs reports the whole console; other reports its end.
    expect(logs.console).toHaveLength(40)
    expect((await run({ contextId: "ses_requests", command: "listTabs" })).console).toHaveLength(30)
    await run({ contextId: "ses_requests", command: "closeBrowser" })
  })
})

describe("settling after a driving command", () => {
  test("waits until the tab has had no request in flight for half a second, and says how it settled", async () => {
    await run({ contextId: "ses_settle", command: "openUrl", url: "http://localhost:3000/" })
    const page = latest().webContents
    const id = ++ids.request
    session().web.get("sendHeaders")!({
      id,
      url: "http://localhost:3000/api/save",
      method: "POST",
      webContentsId: page.id,
      resourceType: "fetch",
    })
    setTimeout(
      () =>
        session().web.get("completed")!({
          id,
          url: "http://localhost:3000/api/save",
          method: "POST",
          webContentsId: page.id,
          resourceType: "fetch",
          statusCode: 200,
        }),
      400,
    )
    const started = Date.now()
    const pressed = await run({ contextId: "ses_settle", command: "press", key: "Tab" })
    expect(pressed.ok).toBe(true)
    expect(pressed.settled).toMatchObject({ navigated: false, idle: true })
    expect(pressed.settled!.waitedMs).toBeGreaterThanOrEqual(850)
    expect(Date.now() - started).toBeGreaterThanOrEqual(850)
    // Told not to, it returns once the key is sent.
    const quick = await run({ contextId: "ses_settle", command: "press", key: "Tab", settle: false })
    expect(quick.settled).toBeUndefined()
    // A load the action starts is waited for, and counts as a navigation.
    page.loading = true
    setTimeout(() => {
      page.loading = false
      page.commit("http://localhost:3000/next")
    }, 400)
    const navigated = await run({ contextId: "ses_settle", command: "press", key: "Enter" })
    expect(navigated.settled).toMatchObject({ navigated: true, idle: true })
    expect(navigated.url).toBe("http://localhost:3000/next")
    await run({ contextId: "ses_settle", command: "closeBrowser" })
  })

  test("a request that never ends lets the command go after five seconds, not idle", async () => {
    await run({ contextId: "ses_busy", command: "openUrl", url: "http://localhost:3000/" })
    const page = latest().webContents
    session().web.get("sendHeaders")!({
      id: ++ids.request,
      url: "http://localhost:3000/stream",
      method: "GET",
      webContentsId: page.id,
      resourceType: "xhr",
    })
    const pressed = await run({ contextId: "ses_busy", command: "press", key: "Tab" })
    expect(pressed.settled).toMatchObject({ navigated: false, idle: false })
    expect(pressed.settled!.waitedMs).toBeGreaterThanOrEqual(5_000)
    await run({ contextId: "ses_busy", command: "closeBrowser" })
  }, 15_000)

  test("reload, back and forward wait for their navigation; back and forward with no history fail", async () => {
    await run({ contextId: "ses_history", command: "openUrl", url: "http://localhost:3000/a" })
    expect(await run({ contextId: "ses_history", command: "goBack" })).toMatchObject({
      ok: false,
      error: "There is no earlier page in this tab.",
    })
    expect(await run({ contextId: "ses_history", command: "goForward" })).toMatchObject({
      ok: false,
      error: "There is no later page in this tab.",
    })
    await run({ contextId: "ses_history", command: "openUrl", url: "http://localhost:3000/b" })
    const back = await run({ contextId: "ses_history", command: "goBack", settle: false })
    expect(back).toMatchObject({ ok: true, url: "http://localhost:3000/a" })
    const forward = await run({ contextId: "ses_history", command: "goForward" })
    expect(forward).toMatchObject({ ok: true, url: "http://localhost:3000/b" })
    expect(forward.settled).toMatchObject({ idle: true })
    const reloaded = await run({ contextId: "ses_history", command: "reload" })
    expect(reloaded).toMatchObject({ ok: true, settled: { navigated: true } })
    await run({ contextId: "ses_history", command: "closeBrowser" })
  })
})

describe("navigation rules", () => {
  test("the user's own Preview navigation follows a redirect to another site; the agent's does not", async () => {
    const { event } = panel()
    await run({ contextId: "ses_user", command: "attach", bounds: BOUNDS }, event)
    latest().webContents.redirects.set("https://google.com/", { url: "https://www.google.com/", isMainFrame: true })
    const user = await run(
      { contextId: "ses_user", command: "openUrl", url: "https://google.com", allowExternal: true },
      event,
    )
    expect(user).toMatchObject({ ok: true, url: "https://www.google.com/" })
    await run({ contextId: "ses_user", command: "closeBrowser" })

    await run({ contextId: "ses_agent", command: "wait", milliseconds: 0 })
    latest().webContents.redirects.set("https://google.com/", { url: "https://www.google.com/", isMainFrame: true })
    const automated = await run({
      contextId: "ses_agent",
      command: "openUrl",
      url: "https://google.com",
      allowExternal: true,
    })
    expect(automated.ok).toBe(false)
    expect(automated.error).toContain("did not follow https://www.google.com/")
    await run({ contextId: "ses_agent", command: "closeBrowser" })
  })

  test("a frame's redirect to another site is neither blocked nor the command's failure", async () => {
    await run({ contextId: "ses_frame", command: "wait", milliseconds: 0 })
    const page = latest().webContents
    page.redirects.set("http://localhost:3000/", { url: "https://ads.example/banner", isMainFrame: false })
    const event = preventable({ url: "https://ads.example/banner", isMainFrame: false })
    page.emit("will-redirect", event)
    expect(event.prevented()).toBe(false)
    const opened = await run({ contextId: "ses_frame", command: "openUrl", url: "http://localhost:3000/" })
    expect(opened).toMatchObject({ ok: true, url: "http://localhost:3000/" })
    await run({ contextId: "ses_frame", command: "closeBrowser" })
  })

  test("a command given up at its deadline lets the user's own clicks count again", async () => {
    await run({ contextId: "ses_deadline", command: "openUrl", url: "http://localhost:3000/" })
    const page = latest().webContents
    // The page stops answering: its script for the click never returns.
    page.executeJavaScriptInIsolatedWorld = () => new Promise<undefined>(() => undefined)
    jest.useFakeTimers()
    try {
      const stuck = run({ contextId: "ses_deadline", command: "click", selector: "#pay" })
      // Until the command is stuck on the page, with its deadline set.
      for (const _ of Array.from({ length: 20 })) await Promise.resolve()
      jest.advanceTimersByTime(agent.TURN_DEADLINE_MS)
      expect(await stuck).toMatchObject({ ok: false, status: 504 })
      jest.advanceTimersByTime(1_000)
      // The user clicks a link to a site no one approved: it is theirs, so it is followed.
      page.emit("input-event", {}, { type: "mouseDown" })
      const event = preventable({})
      page.emit("will-navigate", event, "https://news.example/story")
      expect(event.prevented()).toBe(false)
    } finally {
      jest.useRealTimers()
    }
    await run({ contextId: "ses_deadline", command: "closeBrowser" })
  })
})

describe("dialogs", () => {
  test("what a page asked is reported once, and a page that asks before it is left is left", async () => {
    await run({ contextId: "ses_dialogs", command: "openUrl", url: "http://localhost:3000/" })
    const page = latest().webContents
    page.drain = {
      issues: [],
      dialogs: [
        { type: "confirm", message: "Delete this project?", url: "http://localhost:3000/?token=abc123", at: "now" },
        { type: "print", message: "not a dialog Vector reports" },
        null,
      ],
    }
    const leaving = preventable({})
    page.emit("will-prevent-unload", leaving)
    expect(leaving.prevented()).toBe(true)
    const report = await run({ contextId: "ses_dialogs", command: "wait", milliseconds: 0 })
    expect(report.dialogs).toEqual([
      { type: "beforeunload", message: "", url: "http://localhost:3000/", at: expect.any(String) },
      { type: "confirm", message: "Delete this project?", url: expect.not.stringContaining("abc123"), at: "now" },
    ])
    page.drain = undefined
    expect((await run({ contextId: "ses_dialogs", command: "wait", milliseconds: 0 })).dialogs).toBeUndefined()
    await run({ contextId: "ses_dialogs", command: "closeBrowser" })
  })
})
