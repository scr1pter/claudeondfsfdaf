import { afterAll, afterEach, describe, expect, jest, mock, test } from "bun:test"
import type { LookupAddress } from "node:dns"
import http from "node:http"
import net from "node:net"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { ResearchProvenance } from "@vectordevai/core/research/provenance"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import { clickPoint, fieldValue, observePage, readPage, typeTarget, typingMoved, type PageRead } from "./browser-page"
import { NOT_LINK, PAGE_STARTED, POST, SCHEME } from "./research-navigation"
import { ResearchSearch } from "@vectordevai/core/research/search"
import { readSearchPage, type SearchPageRead } from "./research-search-page"
import { USER, useResearchNetwork } from "./research-proxy"

// Research browsers against a stand-in for Electron's windows, views, pages and sessions (section 5.6a). What only
// Chromium can show (cookies kept apart between partitions, `<-loopback>`, service workers failing, dialogs, holding
// scripts) is checked by scripts/research-browser-smoke.ts in the real Electron. Each desktop test file runs in its own process,
// so this file's Electron mock stays its own. The proxies are real and reach the fake web on loopback only.

const guard = NetworkGuard.use()
// Over the 20 MB a page load may receive, sent in chunks with no Content-Length.
const BIG = 21 * 1024 * 1024
const web = FakeWeb.start({
  sites: {
    ...FakeWeb.sites(),
    big: {
      "/stream.js": () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const chunk = new Uint8Array(1024 * 1024).fill(120)
              Array.from({ length: BIG / chunk.length }, () => controller.enqueue(chunk))
              controller.close()
            },
          }),
          { headers: { "content-type": "text/javascript" } },
        ),
      // An answer that never ends, a megabyte at a time, until its reader goes away.
      "/endless.js": () => {
        const state = { open: true }
        return new Response(
          new ReadableStream({
            pull: (controller) =>
              new Promise<void>((resolve) =>
                setTimeout(() => {
                  if (state.open) controller.enqueue(new Uint8Array(1024 * 1024).fill(121))
                  resolve()
                }, 10),
              ),
            cancel: () => {
              state.open = false
            },
          }),
          { headers: { "content-type": "text/javascript" } },
        )
      },
    },
  },
})
useResearchNetwork({
  resolver: (hostname: string): Promise<readonly LookupAddress[]> => web.resolver(hostname),
  privateHosts: [FakeWeb.DOMAIN],
})
afterAll(async () => {
  useResearchNetwork({})
  await web.close()
})

// A listener of any shape, as Electron's events take: a method's parameters are compared both ways, so a typed handler
// is one, and the fakes can call it with what Electron would pass.
type Listener = { listener(...input: unknown[]): unknown }["listener"]

class Emitter {
  readonly listeners = new Map<string, Listener[]>()
  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }
  once(event: string, listener: Listener) {
    const wrapped = (...input: unknown[]) => {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((item) => item !== wrapped),
      )
      return listener(...input)
    }
    return this.on(event, wrapped)
  }
  emit(event: string, ...input: unknown[]) {
    ;(this.listeners.get(event) ?? []).forEach((listener) => listener(...input))
  }
}

class FakeSession extends Emitter {
  readonly calls: string[] = []
  readonly proxies: unknown[] = []
  readonly ntlm: string[] = []
  request?: Listener
  check?: Listener
  device?: Listener
  failClear = false
  readonly web: Record<string, Listener> = {}
  readonly webRequest = {
    onBeforeRequest: (listener: Listener) => void (this.web.beforeRequest = listener),
    onBeforeSendHeaders: (listener: Listener) => void (this.web.beforeSendHeaders = listener),
    onHeadersReceived: (listener: Listener) => void (this.web.headersReceived = listener),
    onCompleted: (listener: Listener) => void (this.web.completed = listener),
    onErrorOccurred: (listener: Listener) => void (this.web.errorOccurred = listener),
    // The visible agent browser's request log, on its own session.
    onSendHeaders: (listener: Listener) => void (this.web.sendHeaders = listener),
  }
  constructor(readonly name: string) {
    super()
  }
  setPermissionRequestHandler(listener: Listener) {
    this.request = listener
  }
  setPermissionCheckHandler(listener: Listener) {
    this.check = listener
  }
  setDevicePermissionHandler(listener: Listener) {
    this.device = listener
  }
  allowNTLMCredentialsForDomains(domains: string) {
    this.ntlm.push(domains)
  }
  setSpellCheckerEnabled() {}
  async setProxy(config: unknown) {
    this.proxies.push(config)
  }
  clearStorageData(options?: unknown) {
    this.calls.push(`clearStorageData:${JSON.stringify(options ?? "all")}`)
    return this.failClear ? Promise.reject(new Error("clearing failed")) : Promise.resolve()
  }
  async clearCache() {
    this.calls.push("clearCache")
  }
  async clearAuthCache() {
    this.calls.push("clearAuthCache")
  }
  async clearHostResolverCache() {
    this.calls.push("clearHostResolverCache")
  }
  async closeAllConnections() {
    this.calls.push("closeAllConnections")
  }
}

// What each page script returns, by the function the code runs.
const scripts = new Map<Function, (contents: FakeContents) => unknown>()
const ids = { contents: 0, request: 0 }
// The next page made: its debugger cannot attach (another one holds it), or it does not close when told to.
const next = { attachFails: false, hangs: false }

class FakeContents extends Emitter {
  readonly id = ++ids.contents
  readonly inputs: { type: string; x?: number; keyCode?: string }[] = []
  focused = 0
  readonly devtools: { method: string; params?: unknown }[] = []
  url = ""
  title = ""
  destroyed = false
  crashed = false
  readonly attachFails = next.attachFails
  readonly hangs = next.hangs
  muted = false
  webrtc = ""
  openHandler?: Listener
  /** What the page does after a trusted mouse up. */
  onMouseUp?: () => void
  readonly debugger = {
    attach: () => {
      if (this.attachFails) throw new Error("Another debugger is already attached")
    },
    sendCommand: async (method: string, params?: unknown) => void this.devtools.push({ method, params }),
    on: () => undefined,
  }
  readonly navigationHistory = {
    entries: [] as string[],
    getActiveIndex: () => this.navigationHistory.entries.length - 1,
    getEntryAtIndex: (index: number) => ({ url: this.navigationHistory.entries[index]!, title: "" }),
    goBack: () => {
      const back = this.navigationHistory.entries.at(-2)
      if (back) void this.navigate(back, { browser: true })
    },
  }
  constructor(readonly partition: FakeSession) {
    super()
  }
  setAudioMuted(muted: boolean) {
    this.muted = muted
  }
  setWebRTCIPHandlingPolicy(policy: string) {
    this.webrtc = policy
  }
  setWindowOpenHandler(handler: Listener) {
    this.openHandler = handler
  }
  loadURL(url: string) {
    return this.navigate(url, { browser: true })
  }
  /** A navigation through the slot session's onBeforeRequest, as Chromium's network stack makes it. */
  async navigate(url: string, options: { readonly method?: string; readonly browser?: boolean } = {}) {
    const id = ++ids.request
    const cancelled = await new Promise<boolean>((resolve) =>
      this.partition.web.beforeRequest!(
        {
          id,
          url,
          method: options.method ?? "GET",
          webContentsId: this.id,
          resourceType: "mainFrame",
          referrer: "",
          timestamp: Date.now(),
          uploadData: [],
        },
        (response: { cancel?: boolean }) => resolve(response.cancel === true),
      ),
    )
    if (cancelled) throw new Error("ERR_BLOCKED_BY_CLIENT (-20) loading " + url)
    if (/\.pdf$/.test(new URL(url).pathname)) {
      const prevented: string[] = []
      this.partition.emit(
        "will-download",
        { preventDefault: () => prevented.push(url) },
        { getURL: () => url, getMimeType: () => "application/pdf" },
        this,
      )
      throw new Error("ERR_ABORTED (-3) loading " + url)
    }
    this.url = url
    this.navigationHistory.entries.push(url)
    this.emit("did-navigate", {}, url, 200, "OK")
    this.partition.web.completed?.({ id, webContentsId: this.id })
  }
  isLoading() {
    return false
  }
  stop() {}
  focus() {
    this.focused++
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
    if (this.hangs) return
    this.destroyed = true
    this.emit("destroyed")
  }
  forcefullyCrashRenderer() {
    this.crashed = true
  }
  sendInputEvent(event: { type: string; x?: number; keyCode?: string }) {
    this.inputs.push(event)
    if (event.type === "mouseUp") this.onMouseUp?.()
  }
  async executeJavaScript() {
    return undefined
  }
  getZoomFactor() {
    return 1
  }
  async capturePage() {
    return { toDataURL: () => `data:image/png;base64,${Buffer.from(this.url).toString("base64")}` }
  }
  async executeJavaScriptInIsolatedWorld(world: number, code: { code: string }[]) {
    const source = code[0]!.code
    const known = [...scripts.entries()].find(([fn]) => source.startsWith(`(${fn.toString()})(window`))
    if (known) return known[1](this)
    if (source.includes("scrollBy")) return undefined
    throw new Error(`No script stand-in for ${source.slice(0, 60)} in world ${world}`)
  }
}

const views: FakeView[] = []
class FakeView {
  readonly webContents: FakeContents
  bounds?: unknown
  constructor(readonly options: { webPreferences: { session: FakeSession } & Record<string, unknown> }) {
    this.webContents = new FakeContents(options.webPreferences.session)
    views.push(this)
  }
  setBounds(bounds: unknown) {
    this.bounds = bounds
  }
  setBackgroundColor() {}
  setVisible() {}
}

const windows: FakeWindow[] = []
class FakeWindow {
  readonly children = new Set<FakeView>()
  readonly contentView = {
    addChildView: (view: FakeView) => void this.children.add(view),
    removeChildView: (view: FakeView) => void this.children.delete(view),
  }
  destroyed = false
  constructor(readonly options: Record<string, unknown>) {
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
const electron = {
  app: { getPath: () => "/tmp", isPackaged: false },
  BrowserWindow: Object.assign(FakeWindow, { fromWebContents: () => undefined }),
  WebContentsView: FakeView,
  session: {
    fromPartition: (name: string) => {
      const existing = partitions.get(name) ?? new FakeSession(name)
      partitions.set(name, existing)
      return existing
    },
  },
}
mock.module("electron", () => ({ default: electron, ...electron }))

const research = await import("./research-browser")

const ARTICLE = web.url("article", "/")
// A page on another site, with no robots.txt (so every path is allowed).
const PAPER = web.url("copy", "/heat-pumps")
const read = (links: readonly string[] = []): PageRead => ({
  html: "<html><body><p>The study followed 412 homes.</p></body></html>",
  title: "Heat pumps",
  url: ARTICLE,
  links: links.map((url) => ({ url, text: "a link", main: true })),
  forms: [],
  truncated: false,
})
scripts.set(readPage, () => read([PAPER]))
scripts.set(observePage, () => ({ title: "", url: "", text: "", elements: [], links: [], forms: [] }))

const base = (
  input: Partial<research.ResearchInput> & Pick<research.ResearchInput, "command" | "sessionID">,
): research.ResearchInput => ({
  runID: "run_one",
  agent: input.sessionID === "ses_lead" ? "research" : "researcher",
  rootID: "ses_lead",
  max: 3,
  provenance: [ARTICLE],
  ...input,
})
const send = (input: Partial<research.ResearchInput> & Pick<research.ResearchInput, "command" | "sessionID">) =>
  research.runResearchBrowser(base(input))
// The view a command just opened: views are made in order, one per browser.
const latest = () => views.at(-1)!
const close = (sessionID: string, runID = "run_one") => send({ command: "research.close", sessionID, runID })

describe("the slot pool", () => {
  const fake = (name: string) => new FakeSession(name)

  test("a slot serves one agent at a time and is cleared, every storage type, before the next", async () => {
    const pool = research.slotPool(fake)
    const first = pool.acquire()
    const second = pool.acquire()
    expect([first.name, second.name]).toEqual(["vector-research-1", "vector-research-2"])
    expect(await pool.release(first)).toBe(true)
    expect(first.session.calls).toEqual([
      'clearStorageData:"all"',
      "clearCache",
      "clearAuthCache",
      "clearHostResolverCache",
      "closeAllConnections",
    ])
    // The cleared slot serves the next agent; the busy one does not.
    expect(pool.acquire()).toBe(first)
    expect(pool.acquire().name).toBe("vector-research-3")
  })

  test("a slot whose page may still be alive is retired, though it was cleared", async () => {
    const pool = research.slotPool(fake)
    const first = pool.acquire()
    expect(await pool.release(first, true)).toBe(true)
    expect(first.retired).toBe(true)
    expect(pool.acquire()).not.toBe(first)
  })

  test("a slot whose clearing fails is retired and never used again; the pool grows and does not shrink", async () => {
    const pool = research.slotPool(fake)
    const first = pool.acquire()
    first.session.failClear = true
    expect(await pool.release(first)).toBe(false)
    expect(first.retired).toBe(true)
    const next = pool.acquire()
    expect(next).not.toBe(first)
    expect(next.name).toBe("vector-research-2")
    expect(pool.slots().map((slot) => slot.name)).toEqual(["vector-research-1", "vector-research-2"])
  })
})

describe("research browsers", () => {
  test("each research agent gets a browser of its own, in a slot of its own, apart from the user's browser", async () => {
    const lead = await send({ command: "research.scroll", sessionID: "ses_lead" })
    const view = latest()
    const researcher = await send({ command: "research.scroll", sessionID: "ses_r1" })
    const other = latest()
    expect([lead.ok, researcher.ok]).toEqual([true, true])
    expect([lead.label, researcher.label]).toEqual(["Research lead", "Researcher 1"])
    const names = [view, other].map((item) => item.webContents.partition.name)
    expect(new Set(names).size).toBe(2)
    for (const name of names) expect(name).toMatch(/^vector-research-\d+$/)
    expect(partitions.has("persist:vector-browser")).toBe(false)
    // Hidden, at a real size, with the page's options locked down.
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1280, height: 900 })
    expect(view.options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      disableDialogs: true,
      spellcheck: false,
      backgroundThrottling: false,
      webviewTag: false,
      plugins: false,
    })
    expect(view.options.webPreferences).not.toHaveProperty("preload")
    expect(view.webContents.muted).toBe(true)
    expect(view.webContents.webrtc).toBe("disable_non_proxied_udp")
    // One hidden host for every research browser, which never takes focus and is in no taskbar.
    expect(windows).toHaveLength(1)
    expect(windows[0]!.options).toMatchObject({
      show: false,
      focusable: false,
      skipTaskbar: true,
      width: 1280,
      height: 900,
    })
    expect(windows[0]!.children.has(view)).toBe(true)
    // Two calls from one agent at once still open one browser.
    await Promise.all([
      send({ command: "research.scroll", sessionID: "ses_r1" }),
      send({ command: "research.scroll", sessionID: "ses_r1" }),
    ])
    expect(research.ResearchWatch.list().filter((chip) => chip.sessionID === "ses_r1")).toHaveLength(1)
    await close("ses_lead")
    // The host stays while a research browser is open, and goes with the last one, so no window of Vector's is left
    // for a Dock click, a second launch or the tray to show, and none keeps Vector open once its windows close.
    expect(windows[0]!.destroyed).toBe(false)
    await close("ses_r1")
    expect(windows[0]!.destroyed).toBe(true)
    expect(windows[0]!.children.size).toBe(0)
    // The next research browser gets a host of its own.
    await send({ command: "research.scroll", sessionID: "ses_lead" })
    expect(windows).toHaveLength(2)
    expect(windows[1]!.children.has(latest())).toBe(true)
    await close("ses_lead")
    expect(windows[1]!.destroyed).toBe(true)
  })

  test("a run has at most its count of browsers open, and an agent past it waits for one to close", async () => {
    await send({ command: "research.scroll", sessionID: "ses_lead", max: 2 })
    await send({ command: "research.scroll", sessionID: "ses_r1", max: 2 })
    const state = { done: false }
    const waiting = send({ command: "research.scroll", sessionID: "ses_r2", max: 2 }).then((result) => {
      state.done = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(state.done).toBe(false)
    // Another run's agent does not wait on this run's count.
    const other = await send({ command: "research.scroll", sessionID: "ses_lead", runID: "run_two", max: 1 })
    expect(other.ok).toBe(true)
    await close("ses_lead", "run_two")
    await close("ses_r1")
    const third = await waiting
    expect(third.ok).toBe(true)
    expect(third.label).toBe("Researcher 2")
    expect(
      research.ResearchWatch.list()
        .map((chip) => chip.sessionID)
        .toSorted(),
    ).toEqual(["ses_lead", "ses_r2"])
    await close("ses_lead")
    await close("ses_r2")
  })

  test("commands that overlap leave one idle timer, so no stale one closes a browser still in use", async () => {
    await send({ command: "research.scroll", sessionID: "ses_idle" })
    const open = () => research.ResearchWatch.list().some((chip) => chip.sessionID === "ses_idle")
    jest.useFakeTimers()
    try {
      await Promise.all([
        send({ command: "research.scroll", sessionID: "ses_idle" }),
        send({ command: "research.scroll", sessionID: "ses_idle" }),
      ])
      jest.advanceTimersByTime(research.IDLE_MS - 60_000)
      // The agent works on: this command replaces the idle timer the overlapping ones left.
      await send({ command: "research.scroll", sessionID: "ses_idle" })
      jest.advanceTimersByTime(60_001)
      expect(open()).toBe(true)
      // Idle for the whole time after its last command, it closes.
      jest.advanceTimersByTime(research.IDLE_MS)
      expect(open()).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  test("a slot session is hardened, sends everything through the browser's own proxy, and keeps the rule's listener", async () => {
    await send({ command: "research.scroll", sessionID: "ses_lead" })
    const view = latest()
    const partition = view.webContents.partition
    // Every permission is denied, fullscreen included.
    const answers: boolean[] = []
    for (const permission of [
      "fullscreen",
      "media",
      "notifications",
      "geolocation",
      "clipboard-read",
      "display-capture",
    ])
      partition.request!(view.webContents, permission, (granted: boolean) => answers.push(granted))
    expect(answers).toEqual([false, false, false, false, false, false])
    expect(partition.check!(view.webContents, "fullscreen", ARTICLE, {})).toBe(false)
    expect(partition.device!({})).toBe(false)
    // Never called: Electron applies it to the whole app, and an empty list is no list on Windows. A challenge for
    // ambient sign-in is cancelled in headersReceived instead.
    expect(partition.ntlm).toEqual([])
    // The rule runs in the session's one onBeforeRequest listener, Vector Local's dispatcher (egress-filter.ts), after
    // its own decision: a request no research browser made reaches the rule, which refuses it.
    const unowned = await new Promise<{ cancel?: boolean }>((resolve) =>
      partition.web.beforeRequest!(
        {
          id: 1,
          url: ARTICLE,
          method: "GET",
          resourceType: "script",
          webContentsId: -5,
          referrer: "",
          timestamp: 0,
          uploadData: [],
        },
        resolve,
      ),
    )
    expect(unowned).toEqual({ cancel: true })
    expect(partition.web.beforeSendHeaders).toBe(research.researchRequestHandlers.beforeSendHeaders)
    const config = partition.proxies.at(-1) as { mode: string; proxyRules: string; proxyBypassRules: string }
    expect(config).toMatchObject({ mode: "fixed_servers", proxyBypassRules: "<-loopback>" })
    const port = Number(config.proxyRules.split(":").at(-1))
    // The proxy is live, needs its secret, and `login` answers it alone.
    const given: unknown[][] = []
    view.webContents.emit(
      "login",
      { preventDefault: () => given.push(["prevented"]) },
      {},
      { isProxy: true, host: "127.0.0.1", port },
      (...answer: unknown[]) => given.push(answer),
    )
    view.webContents.emit(
      "login",
      { preventDefault: () => given.push(["prevented"]) },
      {},
      { isProxy: false, host: "journal.example", port: 443 },
      (...answer: unknown[]) => given.push(answer),
    )
    expect(given[0]).toEqual(["prevented"])
    expect(given[1]![0]).toBe(USER)
    expect(given.slice(2)).toEqual([["prevented"], []])
    // A client certificate request is answered with none.
    const certificates: unknown[][] = []
    view.webContents.emit(
      "select-client-certificate",
      { preventDefault: () => certificates.push(["prevented"]) },
      ARTICLE,
      [{ subjectName: "user" }],
      (...answer: unknown[]) => certificates.push(answer),
    )
    expect(certificates).toEqual([["prevented"], []])
    // The page's scripts are held in the debugger between commands, and file choosers never open.
    const methods = view.webContents.devtools.map(
      (item) =>
        `${item.method}${item.method === "Debugger.setSkipAllPauses" ? `:${(item.params as { skip: boolean }).skip}` : ""}`,
    )
    expect(methods).toContain("Page.setInterceptFileChooserDialog")
    expect(methods).toContain("Page.addScriptToEvaluateOnNewDocument")
    // File System Access pickers are off in every frame, and stubbed for any frame that still has them.
    expect(view.options.webPreferences.disableBlinkFeatures).toBe("FileSystemAccessLocal")
    const stubs = view.webContents.devtools.find((item) => item.method === "Page.addScriptToEvaluateOnNewDocument")
    for (const picker of ["showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker"])
      expect((stubs?.params as { source: string }).source).toContain(picker)
    // Typing reaches a field with the page told it has focus, so Vector never focuses the browser.
    expect(methods).toContain("Emulation.setFocusEmulationEnabled")
    expect(methods.filter((method) => method.startsWith("Debugger."))).toEqual([
      "Debugger.enable",
      "Debugger.setSkipAllPauses:true",
      // The command runs, then the page's scripts are held until the next one.
      "Debugger.setSkipAllPauses:true",
      "Debugger.resume",
      "Debugger.setSkipAllPauses:false",
      "Debugger.pause",
    ])
    await close("ses_lead")
    // Closed: its pages, then its slot cleared, and its proxy stopped.
    expect(view.webContents.destroyed).toBe(true)
    expect(partition.calls.slice(-5)).toEqual([
      'clearStorageData:"all"',
      "clearCache",
      "clearAuthCache",
      "clearHostResolverCache",
      "closeAllConnections",
    ])
    const refused = await new Promise<boolean>((resolve) =>
      net
        .connect(port, "127.0.0.1")
        .on("error", () => resolve(true))
        .on("connect", () => resolve(false)),
    )
    expect(refused).toBe(true)
  })

  test("opens only what the run's provenance holds, and follows a clicked link, which joins it as via S#", async () => {
    const outside = await send({ command: "research.open", sessionID: "ses_lead", url: "https://elsewhere.example/" })
    const view = latest()
    expect(outside).toMatchObject({ ok: false, error: ResearchProvenance.REFUSAL })
    const opened = await send({ command: "research.open", sessionID: "ses_lead", url: ARTICLE })
    expect(opened).toMatchObject({ ok: true, url: ARTICLE, status: 200 })
    // The article's robots.txt came through the browser's proxy.
    expect(web.count("article", "/robots.txt")).toBe(1)
    expect(web.count("article", "/")).toBe(0)
    // The agent read the page, so its links are on it; a click on one is followed.
    await send({ command: "research.read", sessionID: "ses_lead" })
    scripts.set(clickPoint, () => ({ ok: true, x: 40, y: 60, hit: true, href: PAPER }))
    view.webContents.onMouseUp = () => void view.webContents.navigate(PAPER).catch(() => undefined)
    const clicked = await send({ command: "research.click", sessionID: "ses_lead", ref: "ref_1" })
    expect(
      view.webContents.inputs.filter((input) => input.type.startsWith("mouse")).map((input) => input.type),
    ).toEqual(["mouseMove", "mouseDown", "mouseUp"])
    expect(clicked.joined).toEqual([PAPER])
    // The page later walking the browser to another site on its own is refused, and the browser stays.
    view.webContents.onMouseUp = undefined
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    await view.webContents.navigate("https://tracker.example/?id=1").catch(() => undefined)
    const after = await send({ command: "research.scroll", sessionID: "ses_lead" })
    expect(after.refused).toEqual([{ url: "https://tracker.example/?id=1", reason: PAGE_STARTED }])
    expect(after.url).toBe(PAPER)
    // A form that would send data is refused in any frame, and so is a non-web scheme.
    await view.webContents.navigate("https://other.example/comment", { method: "POST" }).catch(() => undefined)
    const frame = await new Promise<boolean>((resolve) =>
      research.researchRequestHandlers.beforeRequest(
        {
          id: 9_001,
          url: "https://ads.example/form",
          method: "POST",
          webContentsId: view.webContents.id,
          resourceType: "subFrame",
          referrer: "",
          timestamp: 0,
          uploadData: [],
        } as never,
        (response) => resolve(response.cancel === true),
      ),
    )
    expect(frame).toBe(true)
    const navigate = { prevented: false }
    view.webContents.emit("will-frame-navigate", {
      url: "data:text/html,hi",
      isMainFrame: true,
      isSameDocument: false,
      preventDefault: () => (navigate.prevented = true),
    })
    expect(navigate.prevented).toBe(true)
    const refused = await send({ command: "research.scroll", sessionID: "ses_lead" })
    expect(refused.refused).toEqual([
      { url: "https://other.example/comment", reason: POST },
      { url: "https://ads.example/form", reason: POST },
      { url: "data:text/html,hi", reason: SCHEME },
    ])
    await close("ses_lead")
  }, 30_000)

  test("bounds what a page loads: no fonts, images only for image models, 150 requests, nothing private", async () => {
    await send({ command: "research.open", sessionID: "ses_lead", url: ARTICLE })
    const view = latest()
    const request = (
      url: string,
      resourceType: string,
      from: { readonly webContentsId?: number } = { webContentsId: view.webContents.id },
    ) =>
      new Promise<boolean>((resolve) =>
        research.researchRequestHandlers.beforeRequest(
          {
            id: ++ids.request,
            url,
            method: "GET",
            ...from,
            resourceType,
            referrer: "",
            timestamp: 0,
            uploadData: [],
          } as never,
          (response) => resolve(response.cancel !== true),
        ),
      )
    expect(await request("https://cdn.example/font.woff2", "font")).toBe(false)
    expect(await request("https://cdn.example/photo.jpg", "image")).toBe(false)
    expect(await request("https://cdn.example/clip.mp4", "media")).toBe(false)
    // A request no research browser made, such as a service worker's, is refused.
    expect(await request("https://cdn.example/app.js", "script", {})).toBe(false)
    expect(await request("https://cdn.example/app.js", "script", { webContentsId: 99_999 })).toBe(false)
    expect(await request("http://127.0.0.1:4096/session", "xhr")).toBe(false)
    expect(await request("ws://localhost:3000/socket", "webSocket")).toBe(false)
    const allowed = await Promise.all(
      Array.from({ length: research.MAX_SUBRESOURCES + 1 }, (_, index) =>
        request(`https://cdn.example/${index}.js`, "script"),
      ),
    )
    expect(allowed.filter(Boolean)).toHaveLength(research.MAX_SUBRESOURCES)
    // A service worker's script is refused in the network stack.
    const headers = await new Promise<boolean>((resolve) =>
      research.researchRequestHandlers.beforeSendHeaders(
        {
          id: 1,
          url: "https://journal.example/sw.js",
          method: "GET",
          webContentsId: view.webContents.id,
          resourceType: "script",
          referrer: "",
          timestamp: 0,
          requestHeaders: { "Service-Worker": "script" },
        } as never,
        (response) => resolve(response.cancel === true),
      ),
    )
    expect(headers).toBe(true)
    // The next page load starts its own count; an image model's browser loads images.
    await send({ command: "research.open", sessionID: "ses_lead", url: ARTICLE, images: true })
    expect(await request("https://cdn.example/photo.jpg", "image")).toBe(true)
    // 20 MB is the most one page load receives, counted by the browser's proxy as the bytes arrive: an answer sent in
    // chunks, with no Content-Length, counts in full.
    const config = view.webContents.partition.proxies.at(-1) as { proxyRules: string }
    const port = Number(config.proxyRules.split(":").at(-1))
    const secret = await new Promise<string>((resolve) =>
      view.webContents.emit(
        "login",
        { preventDefault: () => undefined },
        {},
        { isProxy: true, host: "127.0.0.1", port },
        (_user: string, password: string) => resolve(password),
      ),
    )
    const target = web.url("big", "/stream.js")
    const received = await new Promise<{ readonly bytes: number; readonly length?: string }>((resolve, reject) =>
      http
        .get(
          {
            host: "127.0.0.1",
            port,
            path: target,
            headers: {
              host: new URL(target).host,
              "proxy-authorization": `Basic ${Buffer.from(`${USER}:${secret}`).toString("base64")}`,
            },
          },
          (response) => {
            const state = { bytes: 0 }
            response.on("data", (chunk: Buffer) => (state.bytes += chunk.length))
            response.on("end", () =>
              resolve({
                bytes: state.bytes,
                ...(response.headers["content-length"] ? { length: response.headers["content-length"] } : {}),
              }),
            )
          },
        )
        .on("error", reject),
    )
    expect(received).toEqual({ bytes: BIG })
    const refusedAfter = await request("https://cdn.example/after.js", "script")
    expect(refusedAfter).toBe(false)
    expect((await send({ command: "research.scroll", sessionID: "ses_lead" })).refused).toEqual([
      { url: "https://cdn.example/after.js", reason: research.SUBRESOURCES },
    ])
    // A new page load starts its count again.
    await send({ command: "research.open", sessionID: "ses_lead", url: ARTICLE })
    expect(await request("https://cdn.example/after.js", "script")).toBe(true)
    await close("ses_lead")
  })

  test("every document and frame a research browser loads is sandboxed with no dialogs; other answers are left as sent", async () => {
    await send({ command: "research.scroll", sessionID: "ses_lead" })
    const view = latest()
    const answer = (resourceType: string, responseHeaders: Record<string, string[]>) =>
      new Promise<{ responseHeaders?: Record<string, string[]> }>((resolve) =>
        research.researchRequestHandlers.headersReceived(
          {
            id: ++ids.request,
            url: ARTICLE,
            method: "GET",
            webContentsId: view.webContents.id,
            resourceType,
            responseHeaders,
          } as never,
          resolve,
        ),
      )
    expect((await answer("mainFrame", { "content-type": ["text/html"] })).responseHeaders).toEqual({
      "content-type": ["text/html"],
      "Content-Security-Policy": [research.SANDBOX],
    })
    // The page's own policy stays, and the sandbox joins it.
    expect((await answer("subFrame", { "content-security-policy": ["default-src 'self'"] })).responseHeaders).toEqual({
      "content-security-policy": ["default-src 'self'", research.SANDBOX],
    })
    expect(research.SANDBOX).not.toContain("allow-modals")
    expect(await answer("script", { "content-type": ["text/javascript"] })).toEqual({})
    await close("ses_lead")
  })

  test("downloads stay off, and a PDF is read into memory through the browser's proxy", async () => {
    const pdf = web.url("docs", "/report.pdf")
    const result = await send({ command: "research.open", sessionID: "ses_lead", url: pdf, provenance: [pdf] })
    const view = latest()
    expect(result.ok).toBe(true)
    expect(result.pdf?.url).toBe(pdf)
    expect(Buffer.from(result.pdf!.base64, "base64").subarray(0, 5).toString()).toBe("%PDF-")
    expect(result.pdf?.contentType).toBe("application/pdf")
    const prevented: string[] = []
    view.webContents.partition.emit(
      "will-download",
      { preventDefault: () => prevented.push("cancelled") },
      { getURL: () => "https://files.example/archive.zip", getMimeType: () => "application/zip" },
      view.webContents,
    )
    expect(prevented).toEqual(["cancelled"])
    const next = await send({ command: "research.scroll", sessionID: "ses_lead" })
    expect(next.refused).toEqual([{ url: "https://files.example/archive.zip", reason: research.DOWNLOADS_OFF }])
    await close("ses_lead")
  })

  test("types only what the agent may, and presses only the keys research needs", async () => {
    await send({ command: "research.open", sessionID: "ses_lead", url: ARTICLE })
    const view = latest()
    scripts.set(typeTarget, () => ({
      ok: false,
      reason: "Research browsers never type into a sign-in, contact or payment field.",
    }))
    expect(
      await send({ command: "research.type", sessionID: "ses_lead", ref: "ref_2", text: "heat pumps" }),
    ).toMatchObject({
      ok: false,
      error: "Research browsers never type into a sign-in, contact or payment field.",
    })
    expect(
      await send({ command: "research.type", sessionID: "ses_lead", ref: "ref_2", text: "heat\npumps" }),
    ).toMatchObject({ ok: false })
    expect(await send({ command: "research.press", sessionID: "ses_lead", key: "a" })).toMatchObject({ ok: false })
    expect(await send({ command: "research.press", sessionID: "ses_lead", key: "Escape" })).toMatchObject({ ok: true })
    expect(
      view.webContents.inputs.filter((input) => input.type.startsWith("key")).map((input) => input.keyCode),
    ).toEqual(["Escape", "Escape"])
    // A search field takes the text as trusted key input, without Vector focusing the browser, which would take the
    // keyboard from the user's window.
    scripts.set(typeTarget, () => ({ ok: true }))
    scripts.set(typingMoved, () => false)
    scripts.set(fieldValue, () => "hp")
    expect(await send({ command: "research.type", sessionID: "ses_lead", ref: "ref_3", text: "hp" })).toMatchObject({
      ok: true,
    })
    expect(view.webContents.inputs.filter((input) => input.type === "char").map((input) => input.keyCode)).toEqual([
      "h",
      "p",
    ])
    expect(view.webContents.focused).toBe(0)
    // Screenshots only for a model that reads images.
    expect(await send({ command: "research.screenshot", sessionID: "ses_lead" })).toMatchObject({ ok: false })
    expect(
      (await send({ command: "research.screenshot", sessionID: "ses_lead", images: true })).screenshot,
    ).toStartWith("data:image/png")
    await close("ses_lead")
  })

  test("watching shows chips and snapshots, offers Stop and no way to send input", async () => {
    await send({ command: "research.open", sessionID: "ses_r1", url: ARTICLE })
    expect(Object.keys(research.ResearchWatch).toSorted()).toEqual(["list", "snapshot", "stop", "subscribe"])
    const chips = research.ResearchWatch.list()
    expect(chips).toEqual([
      {
        id: "run_one:ses_r1",
        runID: "run_one",
        sessionID: "ses_r1",
        label: "Researcher 1",
        host: "article.web.test",
        state: "idle",
      },
    ])
    expect(await research.ResearchWatch.snapshot("run_one:ses_r1")).toStartWith("data:image/png;base64,")
    const events: string[] = []
    const stop = research.ResearchWatch.subscribe(() => events.push("changed"))
    expect(await research.ResearchWatch.stop("run_one:ses_r1")).toBe(true)
    stop()
    expect(events.length).toBeGreaterThan(0)
    expect(research.ResearchWatch.list()).toEqual([])
    expect(await research.ResearchWatch.snapshot("run_one:ses_r1")).toBeUndefined()
    // A stopped researcher gets no other browser in this research; another agent of the run still does.
    const made = views.length
    expect(await send({ command: "research.open", sessionID: "ses_r1", url: ARTICLE })).toMatchObject({
      ok: false,
      error: research.STOPPED,
    })
    expect(views.length).toBe(made)
    expect((await send({ command: "research.scroll", sessionID: "ses_r2" })).ok).toBe(true)
    await close("ses_r2")
    expect((await close("ses_r1")).ok).toBe(true)
  })

  test("closing a browser of a run the desktop no longer holds starts no copy of that run", async () => {
    const closed = await close("ses_gone", "run_gone")
    expect(closed).toMatchObject({ ok: true, generation: "" })
    // Nothing was kept for it: a command naming any copy is told to send the run's addresses whole.
    expect(
      await send({ command: "research.scroll", sessionID: "ses_gone", runID: "run_gone", generation: "copy" }),
    ).toMatchObject({
      ok: false,
      resync: true,
    })
  })

  test("a click's href is good for the navigation that click starts, never for a later command's", async () => {
    const elsewhere = web.url("nav", "/")
    await send({ command: "research.open", sessionID: "ses_lead", url: ARTICLE })
    const view = latest()
    await send({ command: "research.read", sessionID: "ses_lead" })
    scripts.set(clickPoint, () => ({ ok: true, x: 40, y: 60, hit: true, href: PAPER }))
    view.webContents.onMouseUp = () => void view.webContents.navigate(PAPER).catch(() => undefined)
    expect((await send({ command: "research.click", sessionID: "ses_lead", ref: "ref_1" })).joined).toEqual([PAPER])
    view.webContents.onMouseUp = undefined
    expect(view.webContents.url).toBe(PAPER)
    // After an open, and after a press, within the 2 seconds an agent action allows, the page sending itself to another
    // site is refused: the earlier click's href does not carry over.
    await send({ command: "research.open", sessionID: "ses_lead", url: ARTICLE })
    await view.webContents.navigate(elsewhere).catch(() => undefined)
    expect((await send({ command: "research.scroll", sessionID: "ses_lead" })).refused).toEqual([
      { url: elsewhere, reason: NOT_LINK },
    ])
    expect(view.webContents.url).toBe(ARTICLE)
    await send({ command: "research.press", sessionID: "ses_lead", key: "Enter" })
    await view.webContents.navigate(elsewhere).catch(() => undefined)
    expect((await send({ command: "research.scroll", sessionID: "ses_lead" })).refused).toEqual([
      { url: elsewhere, reason: NOT_LINK },
    ])
    expect(view.webContents.url).toBe(ARTICLE)
    // A page that swaps the clicked link's address at click time has that one navigation decided as a hop; a second
    // navigation the page starts after it is the page's own.
    const further = web.url("copy", "/further")
    view.webContents.onMouseUp = () =>
      void view.webContents
        .navigate(elsewhere)
        .then(() => view.webContents.navigate(further))
        .catch(() => undefined)
    const swapped = await send({ command: "research.click", sessionID: "ses_lead", ref: "ref_1" })
    view.webContents.onMouseUp = undefined
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(view.webContents.url).toBe(elsewhere)
    const after = await send({ command: "research.scroll", sessionID: "ses_lead" })
    expect([...swapped.refused, ...after.refused]).toEqual([{ url: further, reason: NOT_LINK }])
    await close("ses_lead")
  })

  test("a command naming another copy of the run's provenance is told to send it whole", async () => {
    const started = await send({ command: "research.scroll", sessionID: "ses_lead" })
    expect(started.generation).toBeTruthy()
    expect(await send({ command: "research.scroll", sessionID: "ses_lead", generation: "stale" })).toMatchObject({
      ok: false,
      resync: true,
    })
    expect(
      await send({ command: "research.scroll", sessionID: "ses_lead", generation: started.generation }),
    ).toMatchObject({ ok: true })
    await close("ses_lead")
    expect(guard.outside()).toEqual([])
    expect(LocalPolicy.hostClass("article.web.test")).toBe("internet")
  })
})

// What each results page shows, by the address the research browser loaded: Google's page answers with its results,
// unless `blocked` names it, when it shows the unusual-traffic check instead.
const shown = { blocked: new Set<string>() }
const resultsFor = (url: string): SearchPageRead => {
  const engine = ResearchSearch.engineOf(url)
  const query = URL.canParse(url) ? (new URL(url).searchParams.get("q") ?? "") : ""
  if (engine && shown.blocked.has(engine))
    return {
      url: engine === "google" ? "https://www.google.com/sorry/index?continue=x" : url,
      title: "",
      items: [],
      check: "captcha",
      none: false,
      text: "Our systems have detected unusual traffic from your computer network.",
    }
  return {
    url,
    title: `${query} - ${engine}`,
    items: [
      { href: ARTICLE, title: `Study on ${query}`, snippet: "The study followed 412 homes." },
      { href: `/url?q=${encodeURIComponent(PAPER)}`, title: "A copy", snippet: "" },
    ],
    none: false,
    text: "",
  }
}
scripts.set(readSearchPage, (contents) => resultsFor(contents.url))
// The addresses a research browser loaded, its first empty page left out.
const loaded = (view: FakeView) => view.webContents.navigationHistory.entries.filter((url) => url !== "about:blank")

describe("searching in research browsers", () => {
  // A run of its own, so no browser an earlier test stopped stands in the way.
  const search = (input: Partial<research.ResearchInput> & Pick<research.ResearchInput, "sessionID">) =>
    send({ command: "research.search", runID: "run_search", ...input })
  const done = (sessionID: string) => close(sessionID, "run_search")

  test("the lead and each researcher search at once, each in a browser of its own, within 1 + the researcher cap", async () => {
    const asked = [
      { sessionID: "ses_lead", query: "heat pump savings" },
      { sessionID: "ses_r1", query: "heat pump costs site:nature.com" },
      { sessionID: "ses_r2", query: "heat pump noise" },
    ]
    const before = views.length
    const reports = await Promise.all(
      asked.map((item) => search({ sessionID: item.sessionID, query: item.query, max: 3 })),
    )
    expect(reports.map((report) => report.ok)).toEqual([true, true, true])
    expect(reports.map((report) => report.label).toSorted()).toEqual(["Research lead", "Researcher 1", "Researcher 2"])
    const opened = views.slice(before)
    expect(opened).toHaveLength(3)
    expect(new Set(opened.map((view) => view.webContents.partition.name)).size).toBe(3)
    // Each browser loaded Google's results page for its own agent's query, and nothing else.
    expect(opened.flatMap(loaded).toSorted()).toEqual(
      asked.map((item) => ResearchSearch.page("google", { query: item.query })).toSorted(),
    )
    const lead = reports[asked.findIndex((item) => item.sessionID === "ses_lead")]!
    expect(lead.search).toEqual({
      engine: "google",
      results: [
        { url: ARTICLE, title: "Study on heat pump savings", snippet: "The study followed 412 homes." },
        { url: PAPER, title: "A copy", snippet: "" },
      ],
      tried: [],
    })
    // A fourth agent past the run's count waits for one of the three to close.
    const state = { done: false }
    const waiting = search({ sessionID: "ses_r3", query: "heat pumps", max: 3 }).then((report) => {
      state.done = true
      return report
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(state.done).toBe(false)
    await done("ses_r1")
    expect((await waiting).ok).toBe(true)
    await Promise.all(["ses_lead", "ses_r2", "ses_r3"].map((sessionID) => done(sessionID)))
  }, 30_000)

  test("a check on Google is never answered: the same browser loads DuckDuckGo's page once instead", async () => {
    shown.blocked = new Set(["google"])
    const report = await search({ sessionID: "ses_lead", query: "heat pumps", recency: "week" })
    const view = latest()
    expect(report.ok).toBe(true)
    expect(report.search?.engine).toBe("duckduckgo")
    expect(report.search?.tried).toEqual([
      { engine: "google", reason: "Google asked for a check that it is not automated traffic." },
    ])
    expect(loaded(view)).toEqual([
      ResearchSearch.page("google", { query: "heat pumps", recency: "week" }),
      ResearchSearch.page("duckduckgo", { query: "heat pumps", recency: "week" }),
    ])
    // Nothing on the check was clicked, typed into or pressed.
    expect(view.webContents.inputs).toEqual([])

    // Both asked for a check: search is unavailable, and neither page is tried again.
    shown.blocked = new Set(["google", "duckduckgo"])
    const unavailable = await search({ sessionID: "ses_lead", query: "heat pump noise" })
    expect(unavailable).toMatchObject({
      ok: false,
      error: ResearchSearch.unavailable([{ engine: "google" }, { engine: "duckduckgo" }]),
    })
    expect(unavailable.search?.tried.map((item) => item.engine)).toEqual(["google", "duckduckgo"])
    expect(loaded(view)).toHaveLength(4)
    expect(view.webContents.inputs).toEqual([])

    // On a search engine's page the agent may not read, observe, click, type, press, scroll or take a screenshot.
    for (const command of [
      "research.read",
      "research.observe",
      "research.click",
      "research.type",
      "research.press",
      "research.scroll",
      "research.screenshot",
    ] as const)
      expect(
        await send({
          command,
          runID: "run_search",
          sessionID: "ses_lead",
          ref: "ref_1",
          text: "x",
          key: "Enter",
          images: true,
        }),
      ).toMatchObject({ ok: false, error: research.ON_SEARCH })
    expect(view.webContents.inputs).toEqual([])
    // Opening a result leaves the search page, and the page can be read again.
    expect(
      await send({ command: "research.open", runID: "run_search", sessionID: "ses_lead", url: ARTICLE }),
    ).toMatchObject({ ok: true })
    expect((await send({ command: "research.read", runID: "run_search", sessionID: "ses_lead" })).read?.title).toBe(
      "Heat pumps",
    )
    shown.blocked = new Set()
    await done("ses_lead")
  }, 30_000)

  test("a search reaches only the engines it was given, and loads no page of the agent's choosing", async () => {
    const report = await search({ sessionID: "ses_lead", query: "heat pumps", engines: ["duckduckgo"] })
    expect(report.search?.engine).toBe("duckduckgo")
    expect(loaded(latest())).toEqual([ResearchSearch.page("duckduckgo", { query: "heat pumps" })])
    expect(await search({ sessionID: "ses_lead", query: "  " })).toMatchObject({
      ok: false,
      error: "Give the words to search for.",
    })
    // With only DuckDuckGo's page let through, and a check on it, the agent is told of DuckDuckGo alone.
    shown.blocked = new Set(["duckduckgo"])
    const unavailable = await search({ sessionID: "ses_lead", query: "heat pump noise", engines: ["duckduckgo"] })
    expect(unavailable).toMatchObject({ ok: false, error: ResearchSearch.unavailable([{ engine: "duckduckgo" }]) })
    expect(unavailable.error).not.toContain("Google")
    shown.blocked = new Set()
    await done("ses_lead")
    expect(guard.outside()).toEqual([])
  })

  test("a result that never commits, a PDF, leaves the search page's guard on until another page commits", async () => {
    const pdf = web.url("docs", "/report.pdf")
    const from = { runID: "run_search", sessionID: "ses_lead", provenance: [ARTICLE, pdf] }
    shown.blocked = new Set(["google", "duckduckgo"])
    expect(await send({ ...from, command: "research.search", query: "heat pumps" })).toMatchObject({ ok: false })
    const view = latest()
    const check = ResearchSearch.page("duckduckgo", { query: "heat pumps" })
    expect(view.webContents.url).toBe(check)
    // The PDF is a download, so it is read into memory and the check page stays shown.
    const opened = await send({ ...from, command: "research.open", url: pdf })
    expect(opened).toMatchObject({ ok: true, pdf: { url: pdf } })
    expect(view.webContents.url).toBe(check)
    for (const command of ["research.observe", "research.click", "research.read", "research.type"] as const)
      expect(await send({ ...from, command, ref: "ref_1", text: "x" })).toMatchObject({
        ok: false,
        error: research.ON_SEARCH,
      })
    expect(view.webContents.inputs).toEqual([])
    // The page is still a search's, so its own navigation to another results page is the search's too: robots.txt,
    // which no fake site serves for DuckDuckGo, does not decide it.
    await view.webContents.navigate(`${check}&s=30`)
    expect(view.webContents.url).toBe(`${check}&s=30`)
    expect(await send({ ...from, command: "research.observe" })).toMatchObject({ ok: false, error: research.ON_SEARCH })
    // A result that commits lifts the guard.
    expect(await send({ ...from, command: "research.open", url: ARTICLE })).toMatchObject({ ok: true })
    expect((await send({ ...from, command: "research.read" })).read?.title).toBe("Heat pumps")
    shown.blocked = new Set()
    await done("ses_lead")
  }, 30_000)

  test("a page on a search engine's own host is held to the guard, however the browser got there", async () => {
    // An address the user typed, which the rule lets the agent open.
    const wall = "https://consent.google.com/ml?continue=https://www.google.com/search"
    const from = { runID: "run_search", sessionID: "ses_lead", typed: [wall] }
    expect(await send({ ...from, command: "research.open", url: wall })).toMatchObject({ ok: true })
    expect(latest().webContents.url).toBe(wall)
    for (const command of ["research.observe", "research.click", "research.read", "research.press"] as const)
      expect(await send({ ...from, command, ref: "ref_1", key: "Enter" })).toMatchObject({
        ok: false,
        error: research.ON_SEARCH,
      })
    expect(latest().webContents.inputs).toEqual([])
    await done("ses_lead")
  })
})

describe("research browsers that misbehave", () => {
  // Each test's browser is closed whatever the test found, so a failed one cannot hand the next its browser.
  afterEach(() => close("ses_lead"))

  test("a site's NTLM or Negotiate challenge is cancelled before Chromium answers it, whatever asked for it", async () => {
    await send({ command: "research.scroll", sessionID: "ses_lead" })
    const view = latest()
    const answer = (resourceType: string, statusCode: number, responseHeaders: Record<string, string[]>) =>
      new Promise<Electron.HeadersReceivedResponse>((resolve) =>
        research.researchRequestHandlers.headersReceived(
          {
            id: ++ids.request,
            url: ARTICLE,
            method: "GET",
            webContentsId: view.webContents.id,
            resourceType,
            statusCode,
            responseHeaders,
          } as never,
          resolve,
        ),
      )
    expect(await answer("mainFrame", 401, { "WWW-Authenticate": ["Negotiate"] })).toEqual({ cancel: true })
    expect(await answer("xhr", 401, { "www-authenticate": ['Basic realm="members", NTLM'] })).toEqual({ cancel: true })
    expect(await answer("image", 401, { "www-authenticate": ["Negotiate oYH1MIHyoAMKAQ"] })).toEqual({ cancel: true })
    // Basic goes on to `login`, which cancels it, and the document is sandboxed as any is.
    expect(await answer("mainFrame", 401, { "www-authenticate": ['Basic realm="members"'] })).toEqual({
      responseHeaders: { "www-authenticate": ['Basic realm="members"'], "Content-Security-Policy": [research.SANDBOX] },
    })
    // Only a 401 is a challenge.
    expect(await answer("script", 200, { "www-authenticate": ["Negotiate"] })).toEqual({})
    expect((await send({ command: "research.scroll", sessionID: "ses_lead" })).refused).toEqual([
      { url: ARTICLE, reason: research.AMBIENT },
    ])
    await close("ses_lead")
  })

  test("one endless answer is cut once its page load has received 40 MB, and the next page load starts again", async () => {
    await send({ command: "research.open", sessionID: "ses_lead", url: ARTICLE })
    const view = latest()
    const config = view.webContents.partition.proxies.at(-1) as { proxyRules: string }
    const port = Number(config.proxyRules.split(":").at(-1))
    const secret = await new Promise<string>((resolve) =>
      view.webContents.emit(
        "login",
        { preventDefault: () => undefined },
        {},
        { isProxy: true, host: "127.0.0.1", port },
        (_user: string, password: string) => resolve(password),
      ),
    )
    const target = web.url("big", "/endless.js")
    const received = await new Promise<number>((resolve) => {
      const state = { bytes: 0 }
      http
        .get(
          {
            host: "127.0.0.1",
            port,
            path: target,
            headers: {
              host: new URL(target).host,
              "proxy-authorization": `Basic ${Buffer.from(`${USER}:${secret}`).toString("base64")}`,
            },
          },
          (response) => {
            response.on("data", (chunk: Buffer) => (state.bytes += chunk.length))
            response.on("error", () => undefined)
            response.on("close", () => resolve(state.bytes))
          },
        )
        .on("error", () => resolve(state.bytes))
    })
    // Cut soon after the bound: the check runs a few times a second. The proxy counts what it hands the client, chunk
    // framing included, so the cut can come right after the piece that brought the body itself to 40 MB.
    expect(received).toBeGreaterThanOrEqual(research.MAX_PAGE_BYTES)
    expect(received).toBeLessThan(research.MAX_PAGE_BYTES + 32 * 1024 * 1024)
    expect((await send({ command: "research.scroll", sessionID: "ses_lead" })).refused).toEqual([
      { url: ARTICLE, reason: research.PAGE_CUT },
    ])
    await send({ command: "research.open", sessionID: "ses_lead", url: ARTICLE })
    expect((await send({ command: "research.scroll", sessionID: "ses_lead" })).refused).toEqual([])
    await close("ses_lead")
  })

  test("a page still alive after it was told to close has its renderer ended, and its slot is never used again", async () => {
    next.hangs = true
    await send({ command: "research.scroll", sessionID: "ses_lead" })
    next.hangs = false
    const hung = latest()
    await close("ses_lead")
    expect(hung.webContents.destroyed).toBe(false)
    expect(hung.webContents.crashed).toBe(true)
    await send({ command: "research.scroll", sessionID: "ses_lead" })
    expect(latest().webContents.partition.name).not.toBe(hung.webContents.partition.name)
    await close("ses_lead")
  }, 10_000)

  test("a browser whose page the debugger cannot attach to is closed, and says why", async () => {
    next.attachFails = true
    const result = await send({ command: "research.scroll", sessionID: "ses_lead" })
    next.attachFails = false
    expect(result).toMatchObject({ ok: false, error: research.NO_DEVTOOLS })
    expect(latest().webContents.destroyed).toBe(true)
    expect(research.ResearchWatch.list()).toEqual([])
    // The next command opens a browser of its own, held as usual.
    expect((await send({ command: "research.scroll", sessionID: "ses_lead" })).ok).toBe(true)
    expect(latest().webContents.devtools.map((item) => item.method)).toContain("Debugger.pause")
    await close("ses_lead")
  })
})

describe("the bridge", () => {
  test("research and visible commands sent with each other's IDs fail, and neither reaches the other's browsers", async () => {
    const agent = await import("./browser-agent")
    expect(
      (await agent.runBrowserAgent(undefined, { contextId: "ses_lead", command: "wait", milliseconds: 0 })).ok,
    ).toBe(true)
    const user = latest()
    expect(user.webContents.partition.name).toBe("persist:vector-browser")
    // The same session's research browser is another page, in a research slot.
    expect((await send({ command: "research.scroll", sessionID: "ses_lead" })).ok).toBe(true)
    const mine = latest()
    expect(mine).not.toBe(user)
    expect(mine.webContents.partition.name).toMatch(/^vector-research-\d+$/)
    // A visible command naming a research browser's ID gets a visible page of its own, never the research one.
    await agent.runBrowserAgent(undefined, { contextId: "run_one:ses_lead", command: "wait", milliseconds: 0 })
    expect(latest()).not.toBe(mine)
    expect(latest().webContents.partition.name).toBe("persist:vector-browser")
    expect(research.ResearchWatch.list().map((chip) => chip.id)).toEqual(["run_one:ses_lead"])

    const { startBrowserBridge, stopBrowserBridge } = await import("./browser-bridge")
    const bridge = await startBrowserBridge()
    const post = (path: string, body: unknown, token = bridge.token) =>
      fetch(`${bridge.url}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (response) => ({
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      }))
    try {
      const command = { command: "research.scroll", runID: "run_one", sessionID: "ses_lead", agent: "research", max: 3 }
      expect(await post("/research", command)).toMatchObject({
        status: 200,
        body: { ok: true, label: "Research lead" },
      })
      expect(await post("/research", { ...command, contextId: "ses_lead" })).toEqual({
        status: 400,
        body: { error: "Research browser commands take no contextId." },
      })
      expect(await post("/research", { contextId: "ses_lead", command: "openUrl", url: ARTICLE })).toMatchObject({
        status: 400,
      })
      expect(await post("/command", { ...command, contextId: "run_one:ses_lead" })).toEqual({
        status: 400,
        body: { error: "Unknown browser command." },
      })
      expect(await post("/research", command, "wrong")).toMatchObject({ status: 401 })
    } finally {
      await stopBrowserBridge()
    }
    await close("ses_lead")
  })
})
