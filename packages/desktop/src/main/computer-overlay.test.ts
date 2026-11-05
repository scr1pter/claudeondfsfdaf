import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import path from "node:path"
import type { BrowserWindow, BrowserWindowConstructorOptions, Display, Session } from "electron"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerOverlayPage } from "@vectordevai/app/computer/overlay-page"
import { createComputerOverlay, isComputerOverlay, type OverlayClock, type OverlayElectron } from "./computer-overlay"

function state(patch: Partial<Computer.ComputerState> = {}): Computer.ComputerState {
  return {
    phase: "working",
    backend: "local-macos",
    mode: "foreground",
    holder: {
      sessionID: "ses_holder",
      directory: "/private/repo",
      title: "Private task title",
      startedAt: 1,
      actions: 4,
    },
    apps: [{ key: "app:macos:com.apple.notes", name: "Notes" }],
    step: "Clicking Save in Notes",
    queue: [],
    escStops: true,
    stopChord: "Command+Shift+Escape",
    lease: 1,
    reduceMotion: false,
    ...patch,
  }
}

function ask(requestID = "perm_app"): NonNullable<Computer.ComputerState["ask"]> {
  return {
    requestID,
    directory: "/private/repo",
    kind: "app",
    title: "Allow Notes?",
    detail: "Private ask detail",
    canAlways: true,
    shownAt: 0,
  }
}

function display(id: number, x = (id - 1) * 1200, scaleFactor = 2): Display {
  return {
    id,
    bounds: { x, y: 0, width: 1200, height: 800 },
    workArea: { x, y: 24, width: 1200, height: 776 },
    scaleFactor,
  } as Display
}

function manualClock() {
  const state = { now: 1000, id: 0 }
  const timers = new Map<number, { at: number; callback: () => void }>()
  const clock: OverlayClock = {
    now: () => state.now,
    setTimeout(callback, ms) {
      const id = ++state.id
      timers.set(id, { at: state.now + ms, callback })
      return id
    },
    clearTimeout(id) {
      timers.delete(id as number)
    },
  }
  return {
    clock,
    advance(ms: number) {
      const until = state.now + ms
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        timers.delete(next[0])
        state.now = next[1].at
        next[1].callback()
      }
      state.now = until
    },
    count: () => timers.size,
  }
}

class FakeContents extends EventEmitter {
  readonly scripts: string[] = []
  readonly messages: { channel: string; view: ComputerOverlayPage.OverlayMessage }[] = []
  open?: () => { action: string }
  constructor(readonly id: number) {
    super()
  }
  setWindowOpenHandler(callback: () => { action: string }) {
    this.open = callback
  }
  executeJavaScript(script: string) {
    this.scripts.push(script)
    return Promise.resolve()
  }
  send(channel: string, view: ComputerOverlayPage.OverlayMessage) {
    this.messages.push({ channel, view })
  }
}

class FakeWindow extends EventEmitter {
  readonly webContents: FakeContents
  readonly calls: { method: string; args: unknown[] }[] = []
  bounds: { x: number; y: number; width: number; height: number }
  visible = false
  destroyed = false
  ignored = false
  readySent = false
  url = ""
  mediaID: string
  handle: bigint
  nativeHandleReads = 0
  constructor(
    readonly id: number,
    readonly config: BrowserWindowConstructorOptions,
  ) {
    super()
    this.bounds = { x: config.x!, y: config.y!, width: config.width!, height: config.height! }
    this.webContents = new FakeContents(id + 100)
    this.mediaID = `window:${1000 + id}:0`
    this.handle = 9007199254740993n + BigInt(id)
  }
  ready() {
    if (!this.readySent) {
      this.readySent = true
      this.emit("ready-to-show")
    }
  }
  loadURL(url: string) {
    this.url = url
    return Promise.resolve()
  }
  showInactive() {
    this.calls.push({ method: "showInactive", args: [] })
    this.visible = true
  }
  isVisible() {
    return this.visible
  }
  isDestroyed() {
    return this.destroyed
  }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.visible = false
    this.emit("closed")
    this.webContents.emit("destroyed")
  }
  hide() {
    this.visible = false
    this.emit("hide")
  }
  setBounds(bounds: typeof this.bounds) {
    this.bounds = { ...bounds }
    this.calls.push({ method: "setBounds", args: [bounds] })
  }
  setIgnoreMouseEvents(ignore: boolean, extra?: unknown) {
    this.ignored = ignore
    this.calls.push({ method: "ignore", args: extra === undefined ? [ignore] : [ignore, extra] })
  }
  setAlwaysOnTop(...args: unknown[]) {
    this.calls.push({ method: "onTop", args })
  }
  setVisibleOnAllWorkspaces(...args: unknown[]) {
    this.calls.push({ method: "workspaces", args })
  }
  setContentProtection(...args: unknown[]) {
    this.calls.push({ method: "protection", args })
  }
  getMediaSourceId() {
    return this.mediaID
  }
  getNativeWindowHandle() {
    this.nativeHandleReads++
    const bytes = Buffer.alloc(8)
    bytes.writeBigUInt64LE(this.handle)
    return bytes
  }
}

class FakeScreen extends EventEmitter {
  constructor(public displays: Display[]) {
    super()
  }
  getAllDisplays() {
    return this.displays
  }
  getPrimaryDisplay() {
    return this.displays[0]!
  }
}

// No Electron process or wall-clock timers: real D10 views and the production window controller use narrow fakes.
function fixture(
  count = 1,
  platform: NodeJS.Platform = "darwin",
  preloadPath: string | undefined = "/app/out/preload/computer-overlay.js",
) {
  const clock = manualClock()
  const screen = new FakeScreen(Array.from({ length: count }, (_, index) => display(index + 1)))
  const windows: FakeWindow[] = []
  const permissions: {
    request?: Parameters<Session["setPermissionRequestHandler"]>[0]
    check?: Parameters<Session["setPermissionCheckHandler"]>[0]
    partitions: string[]
  } = { partitions: [] }
  const electron: OverlayElectron = {
    appPath: "/packaged/vector",
    screen,
    createWindow(config) {
      const window = new FakeWindow(windows.length + 1, config)
      windows.push(window)
      return window as unknown as BrowserWindow
    },
    partition(name) {
      permissions.partitions.push(name)
      return {
        setPermissionRequestHandler(callback) {
          permissions.request = callback
        },
        setPermissionCheckHandler(callback) {
          permissions.check = callback
        },
      }
    },
  }
  const overlay = createComputerOverlay({ platform, preloadPath, electron, clock: clock.clock })
  return {
    clock,
    screen,
    windows,
    permissions,
    electron,
    overlay,
    live: () => windows.filter((window) => !window.destroyed),
    banner: () => windows.findLast((window) => !window.destroyed && window.config.acceptFirstMouse)!,
    async finish(pending: Promise<void>) {
      await flush()
      for (const window of windows) if (!window.destroyed) window.ready()
      await flush()
      clock.advance(50)
      await flush()
      await pending
    },
    async open(current = state(), target?: { x: number; y: number; width: number; height: number }) {
      const pending = overlay.show(current, target)
      await this.finish(pending)
    },
  }
}

async function flush() {
  for (let count = 0; count < 24; count++) await Promise.resolve()
}

describe("computer overlay windows", () => {
  for (const count of [1, 2, 3])
    test(`${count} displays create four DIP strips each and one hardened banner`, async () => {
      const f = fixture(count)
      await f.open()
      expect(f.live()).toHaveLength(count * 4 + 1)
      expect(f.overlay.windowIds()).toHaveLength(count * 4 + 1)
      for (const window of f.live()) {
        expect(window.config).toMatchObject({
          transparent: true,
          frame: false,
          enableLargerThanScreen: true,
          hasShadow: false,
          focusable: false,
          skipTaskbar: true,
          resizable: false,
          movable: false,
          show: false,
          backgroundColor: "#00000000",
          hiddenInMissionControl: true,
          type: "panel",
        })
        expect(window.config.webPreferences).toMatchObject({
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          devTools: false,
          partition: "computer-overlay",
        })
        expect(window.config.x).toBeNumber()
        expect(window.config.y).toBeNumber()
        expect(window.calls).toContainEqual({ method: "onTop", args: [true, "screen-saver"] })
        expect(window.calls).toContainEqual({
          method: "workspaces",
          args: [true, { visibleOnFullScreen: true, skipTransformProcessType: true }],
        })
        expect(window.calls.some((call) => call.method === "protection")).toBe(false)
        expect(window.url.startsWith("data:text/html;charset=utf-8;base64,")).toBe(true)
        expect(window.ignored).toBe(true)
        expect(isComputerOverlay(window)).toBe(true)
        if (window === f.banner())
          expect(window.config.webPreferences?.preload).toBe("/app/out/preload/computer-overlay.js")
        else expect(window.config.webPreferences?.preload).toBeUndefined()
      }
      expect(f.windows[0]!.bounds).toEqual({ x: 0, y: 0, width: 1200, height: 24 })
      expect(f.windows[1]!.bounds).toEqual({ x: 1176, y: 24, width: 24, height: 752 })
      f.overlay.close()
      expect(f.clock.count()).toBe(0)
      expect(isComputerOverlay(f.windows[0])).toBe(true)
    })

  test("permission, navigation and popup boundaries deny every renderer", async () => {
    const f = fixture()
    await f.open()
    expect(f.permissions.partitions).toEqual(["computer-overlay"])
    const decision: boolean[] = []
    f.permissions.request!(
      f.banner().webContents as unknown as Electron.WebContents,
      "media",
      (allow) => decision.push(allow),
      {} as Electron.PermissionRequest,
    )
    expect(decision).toEqual([false])
    expect(
      f.permissions.check!(
        f.banner().webContents as unknown as Electron.WebContents,
        "media",
        "https://untrusted.invalid",
        {} as Electron.PermissionCheckHandlerHandlerDetails,
      ),
    ).toBe(false)
    for (const window of f.live()) {
      expect(window.webContents.open!()).toEqual({ action: "deny" })
      const event = {
        prevented: false,
        preventDefault() {
          this.prevented = true
        },
      }
      window.webContents.emit("will-navigate", event, "https://untrusted.invalid")
      expect(event.prevented).toBe(true)
    }
    f.overlay.close()
  })

  test("Windows protects content before show and preserves 64-bit HWND identities", async () => {
    const f = fixture(1, "win32")
    await f.open(state({ backend: "local-windows" }))
    for (const window of f.live()) {
      expect(window.config.type).toBe("toolbar")
      expect(window.calls.findIndex((call) => call.method === "protection")).toBeLessThan(
        window.calls.findIndex((call) => call.method === "showInactive"),
      )
      expect(window.calls).toContainEqual({ method: "protection", args: [true] })
      expect(window.calls.some((call) => call.method === "workspaces")).toBe(false)
    }
    expect(f.overlay.windowIds()).toEqual(f.live().map((window) => window.handle.toString()))
    f.overlay.close()
  })

  test("macOS exclusions use CGWindowID instead of NSView pointers", async () => {
    const f = fixture()
    await f.open()
    expect(f.overlay.windowIds()).toEqual(["1001", "1002", "1003", "1004", "1005"])
    expect(f.windows.every((window) => window.nativeHandleReads === 0)).toBe(true)
    f.overlay.close()
  })

  test("preload defaults to the packaged app path rather than the output chunk directory", async () => {
    const f = fixture(1, "darwin", undefined)
    // Omit the explicit path; the adapter supplies Electron app.getAppPath().
    const overlay = createComputerOverlay({ platform: "darwin", electron: f.electron, clock: f.clock.clock })
    const pending = overlay.show(state())
    await f.finish(pending)
    expect(f.banner().config.webPreferences?.preload).toBe(
      path.join("/packaged/vector", "out", "preload", "computer-overlay.js"),
    )
    overlay.close()
  })

  test("ready waits for the last display window and then a full 50 ms", async () => {
    const f = fixture(2)
    const pending = f.overlay.show(state())
    const ready = { value: false }
    void f.overlay.ready().then(() => {
      ready.value = true
    })
    await flush()
    for (const window of f.windows.slice(0, -1)) window.ready()
    await flush()
    f.clock.advance(500)
    await flush()
    expect(ready.value).toBe(false)
    f.windows.at(-1)!.ready()
    await flush()
    f.clock.advance(49)
    await flush()
    expect(ready.value).toBe(false)
    f.clock.advance(1)
    await pending
    await flush()
    expect(ready.value).toBe(true)
    f.overlay.close()
  })

  test("readiness times out closed and never releases an unshown overlay", async () => {
    const f = fixture()
    const losses: number[] = []
    f.overlay.onLost(() => losses.push(1))
    const result = f.overlay.show(state()).then(
      () => "ready",
      (error: unknown) => error,
    )
    await flush()
    f.clock.advance(5000)
    await flush()
    expect(await result).toMatchObject({ code: "unavailable" })
    expect(losses.length).toBeGreaterThan(0)
    expect(f.live()).toHaveLength(0)
    await expect(f.overlay.ready()).rejects.toMatchObject({ code: "unavailable" })
    f.overlay.close()
  })

  test("missing or duplicate native identities fail readiness closed", async () => {
    for (const mediaID of ["window:0:0", "window:4294967296:0", "window:12:0"]) {
      const f = fixture()
      const result = f.overlay.show(state()).then(
        () => "ready",
        (error: unknown) => error,
      )
      await flush()
      for (const window of f.windows) {
        window.mediaID = mediaID
        window.ready()
      }
      await flush()
      expect(await result).toMatchObject({ code: "unavailable" })
      expect(f.live()).toHaveLength(0)
      f.overlay.close()
    }
  })

  test("foreground hover remains click-through; background yields to real pointer input for 300 ms", async () => {
    const f = fixture()
    await f.open()
    f.overlay.hover(true)
    f.overlay.hover(false)
    expect(f.banner().ignored).toBe(true)
    await f.overlay.update(state({ mode: "background" }))
    expect(f.banner().ignored).toBe(false)
    f.overlay.realPointer(true)
    expect(f.banner().ignored).toBe(true)
    f.overlay.hover(true)
    expect(f.banner().ignored).toBe(true)
    f.overlay.realPointer(false)
    f.clock.advance(299)
    expect(f.banner().ignored).toBe(true)
    f.clock.advance(1)
    expect(f.banner().ignored).toBe(false)
    await f.overlay.update(state({ phase: "asking", ask: ask() }))
    expect(f.banner().ignored).toBe(false)
    expect(
      f.windows
        .flatMap((window) => window.calls.filter((call) => call.method === "ignore"))
        .every((call) => call.args.length === 1),
    ).toBe(true)
    f.overlay.close()
  })

  test("add, remove and metrics events pause and relayout without scaling DIP", async () => {
    const f = fixture()
    await f.open()
    const losses: string[] = []
    f.overlay.onLost(() => losses.push("lost"))
    f.screen.displays = [display(1), display(2)]
    f.screen.emit("display-added")
    expect(losses).toEqual(["lost"])
    await f.finish(f.overlay.ready())
    expect(f.live()).toHaveLength(9)
    await f.overlay.update(state(), { x: 1250, y: 150, width: 500, height: 400 })
    expect(f.banner().bounds).toEqual({ x: 1480, y: 32, width: 640, height: 40 })
    f.screen.displays = [
      display(1),
      { ...display(2, -1200, 1), workArea: { x: -1200, y: 50, width: 1200, height: 750 } },
    ]
    f.screen.emit("display-metrics-changed")
    await f.overlay.ready()
    expect(
      f
        .live()
        .some((window) => window.bounds.x === -1200 && window.bounds.width === 1200 && window.bounds.height === 24),
    ).toBe(true)
    f.screen.displays = [display(1)]
    f.screen.emit("display-removed")
    await f.overlay.ready()
    expect(f.live()).toHaveLength(5)
    expect(losses).toHaveLength(3)
    f.overlay.close()
    expect(f.screen.listenerCount("display-added")).toBe(0)
  })

  test("a lost strip pauses, fails ready, then must recreate and settle before reuse", async () => {
    const f = fixture()
    await f.open()
    const losses: number[] = []
    f.overlay.onLost(() => losses.push(1))
    const strip = f.windows[0]!
    strip.destroy()
    expect(losses).toEqual([1])
    await expect(f.overlay.ready()).rejects.toMatchObject({ code: "unavailable" })
    const next = f.overlay.update(state({ phase: "paused", pause: "overlay" }))
    await f.finish(next)
    expect(f.live()).toHaveLength(5)
    expect(f.overlay.windowIds()).not.toContain("1001")
    await f.overlay.ready()
    f.overlay.close()
    expect(losses).toEqual([1])
    expect(isComputerOverlay(strip)).toBe(true)
  })

  for (const event of ["hide", "minimize", "unresponsive", "render-process-gone"])
    test(`${event} is overlay loss`, async () => {
      const f = fixture()
      await f.open()
      const losses: number[] = []
      f.overlay.onLost(() => losses.push(1))
      if (event === "render-process-gone") f.windows[0]!.webContents.emit(event)
      else f.windows[0]!.emit(event)
      expect(losses).toEqual([1])
      await expect(f.overlay.ready()).rejects.toMatchObject({ code: "unavailable" })
      f.overlay.close()
    })

  test("a cancelled generation's delayed rejection cannot close the next task", async () => {
    const f = fixture()
    const first = f.overlay.show(state()).then(
      () => "ready",
      (error: unknown) => error,
    )
    await flush()
    expect(f.live()).toHaveLength(5)
    f.overlay.close()
    // A's pending rejection has not run its catch; B is already the current state.
    const second = f.overlay.show(state({ lease: 2 }))
    await f.finish(second)
    expect(await first).toMatchObject({ code: "stopped" })
    expect(f.overlay.state()?.lease).toBe(2)
    expect(f.live()).toHaveLength(5)
    await f.overlay.ready()
    f.overlay.close()
  })

  test("Allow arms from first visible publication, survives same-ask updates, and resets for a new ask", async () => {
    const f = fixture()
    const pending = f.overlay.show(state({ phase: "asking", ask: ask() }))
    await flush()
    f.clock.advance(1000)
    expect(f.overlay.armed("perm_app")).toBe(false)
    await f.finish(pending)
    expect(f.overlay.armed("perm_app")).toBe(false)
    f.clock.advance(649)
    expect(f.overlay.armed("perm_app")).toBe(false)
    await f.overlay.update(state({ phase: "asking", ask: { ...ask(), shownAt: 9999999999999 } }))
    f.clock.advance(1)
    expect(f.overlay.armed("perm_app")).toBe(true)
    expect(f.overlay.armed("wrong")).toBe(false)
    await f.overlay.update(state({ phase: "asking", ask: ask("perm_new") }))
    expect(f.overlay.armed("perm_new")).toBe(false)
    f.clock.advance(700)
    expect(f.overlay.armed("perm_new")).toBe(true)
    await f.overlay.update(state())
    expect(f.overlay.armed("perm_new")).toBe(false)
    f.overlay.close()
  })

  test("recreating the banner resets an existing request's arming time", async () => {
    const f = fixture()
    const current = state({ phase: "asking", ask: ask() })
    await f.open(current)
    f.clock.advance(700)
    expect(f.overlay.armed("perm_app")).toBe(true)
    f.banner().destroy()
    expect(f.overlay.armed("perm_app")).toBe(false)
    await f.finish(f.overlay.update(current))
    expect(f.overlay.armed("perm_app")).toBe(false)
    f.clock.advance(650)
    expect(f.overlay.armed("perm_app")).toBe(true)
    f.overlay.close()
    expect(f.overlay.armed("perm_app")).toBe(false)
  })

  test("the banner steps aside and restores after three clear steps or five seconds", async () => {
    const f = fixture()
    await f.open()
    expect(f.banner().bounds.y).toBe(32)
    f.overlay.step({ x: 500, y: 40 })
    expect(f.banner().bounds.y).toBe(752)
    f.overlay.step({ x: 0, y: 500 })
    f.overlay.step({ x: 0, y: 500 })
    expect(f.banner().bounds.y).toBe(752)
    f.overlay.step({ x: 0, y: 500 })
    expect(f.banner().bounds.y).toBe(32)
    f.overlay.step({ x: 500, y: 40 })
    f.clock.advance(4999)
    expect(f.banner().bounds.y).toBe(752)
    f.clock.advance(1)
    expect(f.banner().bounds.y).toBe(32)
    f.overlay.close()
  })

  test("only narrow D10 views enter renderers", async () => {
    const f = fixture()
    await f.open(
      state({ phase: "asking", ask: ask(), queue: [{ sessionID: "ses_secret", title: "Secret queued title" }] }),
    )
    const payload = JSON.stringify(
      f.windows.flatMap((window) => [window.webContents.scripts, window.webContents.messages]),
    )
    for (const secret of [
      "/private/repo",
      "Private task title",
      "Private ask detail",
      "Secret queued title",
      "ses_secret",
      "ses_holder",
    ])
      expect(payload).not.toContain(secret)
    expect(f.banner().webContents.messages.every((message) => message.channel === "computer-overlay-state")).toBe(true)
    expect(f.banner().webContents.messages.at(-1)!.view).toMatchObject({ type: "banner", line: "Allow Notes?" })
    const snapshot = f.overlay.state()!
    ;(snapshot as { step?: string }).step = "altered"
    expect(f.overlay.state()!.step).toBe("Clicking Save in Notes")
    f.overlay.close()
  })

  test("cursor host is lazy, isolated, excluded and retained transparently when hidden", async () => {
    const f = fixture(2)
    const losses: number[] = []
    f.overlay.onLost(() => losses.push(1))
    await f.open(state({ mode: "background" }))
    await f.overlay.cursor({ kind: "ghost", point: { x: 1250, y: 100 }, visible: false })
    expect(f.live()).toHaveLength(9)
    await f.finish(f.overlay.cursor({ kind: "ghost", point: { x: 1250, y: 100 }, visible: true }))
    expect(f.live()).toHaveLength(10)
    const cursor = f.windows.at(-1)!
    expect(cursor.config.webPreferences?.preload).toBeUndefined()
    expect(cursor.ignored).toBe(true)
    expect(cursor.bounds).toEqual({ x: 1200, y: 0, width: 1200, height: 800 })
    expect(cursor.webContents.scripts.at(-1)).toContain('"kind":"ghost"')
    expect(cursor.webContents.scripts.at(-1)).toContain('"x":50')
    expect(f.overlay.windowIds()).toContain(cursor.mediaID.split(":")[1]!)
    await f.overlay.cursor({ kind: "hide", visible: false })
    expect(f.live()).toHaveLength(10)
    expect(cursor.visible).toBe(true)
    expect(cursor.webContents.scripts.at(-1)).toContain('"kind":"hide"')
    await f.overlay.update(state())
    await f.overlay.cursor({ kind: "ghost", point: { x: 1250, y: 100 }, visible: true })
    expect(cursor.webContents.scripts.at(-1)).toContain('"kind":"hide"')
    expect(losses).toEqual([])
    f.overlay.close()
  })

  test("fade applies only to end states and an older fade cannot close the next lease", async () => {
    const f = fixture()
    await f.open()
    f.overlay.fade()
    f.clock.advance(500)
    expect(f.live()).toHaveLength(5)
    await f.overlay.update(state({ phase: "done" }))
    f.overlay.fade()
    await flush()
    expect(f.banner().webContents.messages.at(-1)!.view).toEqual({ type: "fade" })
    const next = f.overlay.show(state({ lease: 2 }))
    await f.finish(next)
    f.clock.advance(500)
    expect(f.overlay.state()?.lease).toBe(2)
    expect(f.live()).toHaveLength(5)
    await f.overlay.update(state({ lease: 2, phase: "stopped" }))
    f.overlay.fade()
    f.clock.advance(400)
    expect(f.live()).toHaveLength(0)
    f.overlay.close()
  })

  test("remote, off, setup and ready states leave no native overlay", async () => {
    const f = fixture()
    await f.open()
    await f.overlay.update(state({ backend: "remote" }))
    expect(f.live()).toHaveLength(0)
    for (const phase of ["off", "setup", "ready"] as const) {
      await f.overlay.show(state({ phase }))
      expect(f.live()).toHaveLength(0)
    }
    f.overlay.close()
  })
})
