import path from "node:path"
import type { BrowserWindow, BrowserWindowConstructorOptions, Display, Session } from "electron"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerOverlayLayout } from "@vectordevai/app/computer/overlay-layout"
import { ComputerOverlayPage } from "@vectordevai/app/computer/overlay-page"
import { ComputerError } from "./computer-bridge"
import { registerComputerOverlay } from "./computer-overlay-registry"

export { isComputerOverlay } from "./computer-overlay-registry"

type DisplayEvent = "display-added" | "display-removed" | "display-metrics-changed"
export type OverlayElectron = {
  appPath?: string
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow
  screen: {
    getAllDisplays(): readonly Display[]
    getPrimaryDisplay(): Display
    on(event: DisplayEvent, callback: () => void): unknown
    removeListener(event: DisplayEvent, callback: () => void): unknown
  }
  partition(name: string): Pick<Session, "setPermissionRequestHandler" | "setPermissionCheckHandler">
}
export type OverlayClock = {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}
type Rect = ComputerOverlayLayout.Rect
type Cursor = { kind: "ring" | "ghost" | "hide"; point?: ComputerOverlayLayout.Point; visible: boolean }
type OverlayWindow = {
  key: string
  kind: "glow" | "banner" | "cursor"
  window: BrowserWindow
  bounds: Rect
  ready: Promise<void>
  stop(): void
  healthy: boolean
  loaded: boolean
  intentional: boolean
}

const PARTITION = "computer-overlay"
const DISPLAY_EVENTS: readonly DisplayEvent[] = ["display-added", "display-removed", "display-metrics-changed"]
const clock: OverlayClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

/** Shared native window configuration; Linux smoke checks properties without enabling a Linux backend. */
export function computerOverlayWindowOptions(input: {
  platform: NodeJS.Platform
  kind: "glow" | "banner" | "cursor"
  bounds: ComputerOverlayLayout.Rect
  preload?: string
}): BrowserWindowConstructorOptions {
  return {
      ...input.bounds,
      transparent: true,
      frame: false,
      // Frameless macOS overlays must retain display edges beyond AppKit's menu/work-area clamp.
      ...(input.platform === "darwin" ? { enableLargerThanScreen: true } : {}),
      hasShadow: false,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      show: false,
      backgroundColor: "#00000000",
      hiddenInMissionControl: true,
      type: input.platform === "darwin" ? "panel" : "toolbar",
      ...(input.kind === "banner" ? { acceptFirstMouse: true } : {}),
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        partition: PARTITION,
        backgroundThrottling: false,
        ...(input.kind === "banner" ? { preload: input.preload } : {}),
      },
    }
}

/** These are real Electron setters; native input/capture readiness is checked separately. */
export function configureComputerOverlayWindow(window: BrowserWindow, platform: NodeJS.Platform) {
  window.setAlwaysOnTop(true, "screen-saver")
  if (platform === "darwin")
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  if (platform === "win32") window.setContentProtection(true)
  window.setIgnoreMouseEvents(true)
}

/** Local overlays only. Tests inject windows/screen/clock; importing this module never starts Electron. */
export function createComputerOverlay(options: {
  platform: NodeJS.Platform
  preloadPath?: string
  electron?: OverlayElectron
  clock?: OverlayClock
}) {
  const time = options.clock ?? clock
  const windows = new Map<string, OverlayWindow>()
  const lost = new Set<() => void>()
  const waits = new Set<() => void>()
  const state: {
    current?: Computer.ComputerState
    target?: Rect
    cursor: Cursor
    cursorDisplay?: ComputerOverlayLayout.Display
    display?: ComputerOverlayLayout.Display
    aside: ComputerOverlayLayout.Aside
    asideTimer?: unknown
    pointerTimer?: unknown
    fadeTimer?: unknown
    armed?: { requestID: string; at: number; window: BrowserWindow }
    realPointer: boolean
    pointerUntil: number
    epoch: number
    listening: boolean
    dependencies?: OverlayElectron
  } = {
    cursor: { kind: "hide", visible: false },
    aside: ComputerOverlayLayout.HOME,
    realPointer: false,
    pointerUntil: 0,
    epoch: 0,
    listening: false,
  }
  let work: Promise<void> = Promise.resolve()
  let loading: Promise<OverlayElectron> | undefined

  function notifyLost() {
    for (const callback of lost) {
      try {
        callback()
      } catch {
        console.warn("Computer overlay loss handler failed.")
      }
    }
  }

  function report(record: OverlayWindow) {
    if (record.intentional || !record.healthy || !state.current) return
    record.healthy = false
    notifyLost()
  }

  function delay(ms: number) {
    return new Promise<void>((resolve, reject) => {
      const cancel = () => {
        time.clearTimeout(timer)
        waits.delete(cancel)
        reject(new ComputerError("stopped", "The computer overlays stopped."))
      }
      const timer = time.setTimeout(() => {
        waits.delete(cancel)
        resolve()
      }, ms)
      waits.add(cancel)
    })
  }

  async function dependencies() {
    if (state.dependencies) return state.dependencies
    loading ??= (async () => {
      if (options.electron) return options.electron
      const electron = await import("electron")
      return {
        createWindow: (config: BrowserWindowConstructorOptions) => new electron.BrowserWindow(config),
        screen: electron.screen,
        partition: (name: string) => electron.session.fromPartition(name),
        appPath: electron.app.getAppPath(),
      }
    })()
    const electron = await loading
    const partition = electron.partition(PARTITION)
    partition.setPermissionRequestHandler((_contents, _permission, answer) => answer(false))
    partition.setPermissionCheckHandler(() => false)
    state.dependencies = electron
    return electron
  }

  function pointerRule() {
    const window = windows.get("banner")?.window
    if (!window || window.isDestroyed()) return
    const current = state.current
    const ignore =
      (current?.phase === "working" && current.mode === "foreground") ||
      state.realPointer ||
      time.now() < state.pointerUntil
    window.setIgnoreMouseEvents(ignore)
  }

  async function paint(record: OverlayWindow) {
    const current = state.current
    if (!current || record.intentional || record.window.isDestroyed()) return
    if (record.kind === "banner") {
      const view = ComputerOverlayPage.bannerView(current)
      if (view) {
        record.window.webContents.send("computer-overlay-state", view)
        const requestID = current.ask?.requestID
        if (!requestID || !view.buttons.some((button) => button.requestID === requestID)) state.armed = undefined
        else if (
          record.loaded &&
          record.healthy &&
          record.window.isVisible() &&
          (state.armed?.requestID !== requestID || state.armed.window !== record.window)
        )
          state.armed = { requestID, at: time.now(), window: record.window }
      }
      pointerRule()
      return
    }
    const view = record.kind === "glow" ? ComputerOverlayPage.glowView(current) : cursorView(current)
    if (view) await record.window.webContents.executeJavaScript(ComputerOverlayPage.messageScript(view))
  }

  function cursorView(current: Computer.ComputerState): ComputerOverlayPage.CursorMessage {
    const cursor = state.cursor
    const display = state.cursorDisplay
    const visible =
      cursor.visible &&
      current.phase === "working" &&
      cursor.kind !== "hide" &&
      cursor.point &&
      display &&
      (cursor.kind !== "ghost" || current.mode === "background")
    return {
      type: "cursor",
      kind: visible ? cursor.kind : "hide",
      x: visible ? cursor.point!.x - display!.bounds.x : 0,
      y: visible ? cursor.point!.y - display!.bounds.y : 0,
      reduceMotion: current.reduceMotion,
    }
  }

  function create(electron: OverlayElectron, key: string, kind: OverlayWindow["kind"], bounds: Rect, html: string) {
    const preload =
      options.preloadPath ?? (electron.appPath && path.join(electron.appPath, "out/preload/computer-overlay.js"))
    if (kind === "banner" && !preload)
      throw new ComputerError("unavailable", "The computer overlay preload is unavailable.")
    const window = electron.createWindow(computerOverlayWindowOptions({ platform: options.platform, kind, bounds, preload }))
    registerComputerOverlay(window)
    if (kind === "banner") state.armed = undefined
    const pending = Promise.withResolvers<void>()
    void pending.promise.catch(() => {})
    const status = { painted: false, preparing: false, settled: false }
    const listeners: (() => void)[] = []
    const epoch = state.epoch
    const record: OverlayWindow = {
      key,
      kind,
      window,
      bounds: { ...bounds },
      ready: pending.promise,
      healthy: true,
      loaded: false,
      intentional: false,
      stop() {
        if (record.intentional) return
        record.intentional = true
        time.clearTimeout(timeout)
        for (const remove of listeners) remove()
        if (!status.settled) {
          status.settled = true
          pending.reject(new ComputerError("stopped", "The computer overlays stopped."))
        }
        if (!window.isDestroyed()) window.destroy()
      },
    }
    const fail = () => {
      report(record)
      time.clearTimeout(timeout)
      if (!status.settled) {
        status.settled = true
        pending.reject(new ComputerError("unavailable", "A computer overlay could not be shown."))
      }
    }
    const finish = async () => {
      if (!record.loaded || !status.painted || status.preparing || record.intentional || state.epoch !== epoch) return
      status.preparing = true
      try {
        await paint(record)
        if (record.intentional || state.epoch !== epoch) return
        window.showInactive()
        if (!window.isVisible()) return fail()
        nativeId(window, options.platform)
        await paint(record)
        if (record.intentional || state.epoch !== epoch) return
        time.clearTimeout(timeout)
        status.settled = true
        pending.resolve()
      } catch {
        fail()
      }
    }
    const timeout = time.setTimeout(fail, 5000)
    windows.set(key, record)
    configureComputerOverlayWindow(window, options.platform)
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    const navigate = (event: { preventDefault(): void }) => event.preventDefault()
    window.webContents.on("will-navigate", navigate)
    listeners.push(() => window.webContents.removeListener("will-navigate", navigate))
    const ready = () => {
      status.painted = true
      void finish()
    }
    window.on("ready-to-show", ready)
    listeners.push(() => window.removeListener("ready-to-show", ready))
    const loss = () => {
      report(record)
      if (!status.settled) fail()
    }
    window.on("closed", loss)
    window.on("hide", loss)
    window.on("minimize", loss)
    window.on("unresponsive", loss)
    listeners.push(
      () => window.removeListener("closed", loss),
      () => window.removeListener("hide", loss),
      () => window.removeListener("minimize", loss),
      () => window.removeListener("unresponsive", loss),
    )
    window.webContents.on("render-process-gone", loss)
    window.webContents.on("destroyed", loss)
    listeners.push(
      () => window.webContents.removeListener("render-process-gone", loss),
      () => window.webContents.removeListener("destroyed", loss),
    )
    void window.loadURL(ComputerOverlayPage.pageUrl(html)).then(() => {
      record.loaded = true
      void finish()
    }, fail)
    return record
  }

  function setBounds(record: OverlayWindow, bounds: Rect) {
    if (Object.keys(bounds).some((key) => bounds[key as keyof Rect] !== record.bounds[key as keyof Rect])) {
      record.window.setBounds(bounds)
      record.bounds = { ...bounds }
    }
  }

  function bannerBounds() {
    return (
      state.display &&
      ComputerOverlayLayout.bannerBounds(
        state.display,
        ComputerOverlayLayout.BANNER.max,
        state.aside.aside ? "bottom" : "top",
      )
    )
  }

  async function render() {
    if (!state.current) return
    if (options.platform !== "darwin" && options.platform !== "win32")
      throw new ComputerError("unsupported_os", "Computer overlays are not supported on this OS.")
    const epoch = state.epoch
    const electron = await dependencies()
    if (epoch !== state.epoch || !state.current) return
    if (!state.listening) {
      for (const event of DISPLAY_EVENTS) electron.screen.on(event, displaysChanged)
      state.listening = true
    }
    const displays = electron.screen.getAllDisplays()
    if (
      !displays.length ||
      displays.length > 32 ||
      displays.some((display) => !validRect(display.bounds) || !validRect(display.workArea))
    )
      throw new ComputerError("unavailable", "The computer display layout is unavailable.")
    const primary = displays.find((display) => display.id === electron.screen.getPrimaryDisplay().id) ?? displays[0]!
    state.display = ComputerOverlayLayout.bannerDisplay(displays, state.target, primary)
    if (state.cursor.point)
      state.cursorDisplay = displays.find((display) => inside(display.bounds, state.cursor.point!))
    const wanted = new Set<string>()
    const creating: OverlayWindow[] = []
    const put = (key: string, kind: OverlayWindow["kind"], bounds: Rect, html: string) => {
      wanted.add(key)
      const old = windows.get(key)
      if (old && old.healthy && !old.window.isDestroyed()) {
        setBounds(old, bounds)
        return
      }
      old?.stop()
      creating.push(create(electron, key, kind, bounds, html))
    }
    for (const display of displays)
      for (const strip of ComputerOverlayLayout.stripBounds(display))
        put(`${display.id}:${strip.edge}`, "glow", strip.bounds, ComputerOverlayPage.glowStripPage(strip.edge))
    put("banner", "banner", bannerBounds()!, ComputerOverlayPage.bannerPage())
    if (windows.has("cursor") || (state.cursor.visible && state.cursor.kind !== "hide" && state.cursorDisplay))
      put("cursor", "cursor", state.cursorDisplay?.bounds ?? primary.bounds, ComputerOverlayPage.cursorPage())
    await Promise.all([...windows.values()].filter((record) => wanted.has(record.key)).map((record) => record.ready))
    if (epoch !== state.epoch || !state.current) return
    for (const [key, record] of windows)
      if (!wanted.has(key)) {
        record.stop()
        windows.delete(key)
      }
    await Promise.all([...windows.values()].map(paint))
    pointerRule()
    const ids = windowIds()
    if (new Set(ids).size !== windows.size)
      throw new ComputerError("unavailable", "Computer overlay identities are unavailable.")
    if (creating.length) await delay(50)
    if (
      epoch !== state.epoch ||
      [...windows.values()].some(
        (record) => !record.healthy || record.window.isDestroyed() || !record.window.isVisible(),
      )
    )
      throw new ComputerError("unavailable", "The computer overlays are not visible.")
  }

  function enqueue() {
    const epoch = state.epoch
    const next = work
      .catch(() => {})
      .then(() => (epoch === state.epoch ? render() : undefined))
      .catch((error) => {
        if (epoch === state.epoch && state.current) {
          notifyLost()
          close()
        }
        throw error
      })
    work = next
    void next.catch(() => {})
    return next
  }

  function displaysChanged() {
    if (!state.current) return
    // D18 pauses before a new display can receive any input, then refreshes native exclusion IDs after ready().
    notifyLost()
    if (state.current) void enqueue().catch(() => {})
  }

  function close() {
    state.epoch++
    state.current = undefined
    state.armed = undefined
    for (const timer of [state.asideTimer, state.pointerTimer, state.fadeTimer])
      if (timer !== undefined) time.clearTimeout(timer)
    state.asideTimer = state.pointerTimer = state.fadeTimer = undefined
    for (const cancel of [...waits]) cancel()
    for (const record of windows.values()) record.stop()
    windows.clear()
    if (state.listening && state.dependencies)
      for (const event of DISPLAY_EVENTS) state.dependencies.screen.removeListener(event, displaysChanged)
    state.listening = false
    state.aside = ComputerOverlayLayout.HOME
    state.cursor = { kind: "hide", visible: false }
    state.cursorDisplay = undefined
    state.realPointer = false
    state.pointerUntil = 0
  }

  function update(current: Computer.ComputerState, target?: Rect) {
    if (!ComputerOverlayPage.glowView(current) || !ComputerOverlayPage.bannerView(current)) {
      close()
      return Promise.resolve()
    }
    if (state.current && state.current.lease !== current.lease) close()
    if (state.fadeTimer !== undefined) {
      time.clearTimeout(state.fadeTimer)
      state.fadeTimer = undefined
    }
    state.current = structuredClone(current)
    if (state.armed?.requestID !== current.ask?.requestID) state.armed = undefined
    state.target = target ? { ...target } : undefined
    return enqueue()
  }

  function step(point?: ComputerOverlayLayout.Point) {
    if (!state.current || !state.display) return
    const home = ComputerOverlayLayout.bannerBounds(state.display, ComputerOverlayLayout.BANNER.max)
    state.aside = ComputerOverlayLayout.stepAside(state.aside, home, point, time.now())
    const bounds = bannerBounds()
    const banner = windows.get("banner")
    if (bounds && banner && !banner.window.isDestroyed()) setBounds(banner, bounds)
    if (state.asideTimer !== undefined) time.clearTimeout(state.asideTimer)
    state.asideTimer = state.aside.aside
      ? time.setTimeout(() => step(), Math.max(0, state.aside.at + ComputerOverlayLayout.ASIDE.ms - time.now()))
      : undefined
  }

  function windowIds() {
    return [...windows.values()]
      .filter((record) => !record.window.isDestroyed())
      .map((record) => nativeId(record.window, options.platform))
  }

  return {
    show: update,
    update,
    async ready() {
      while (true) {
        const pending = work
        await pending
        if (pending === work) break
      }
      if (
        !state.current ||
        !windows.size ||
        [...windows.values()].some(
          (record) => !record.healthy || record.window.isDestroyed() || !record.window.isVisible(),
        )
      )
        throw new ComputerError("unavailable", "The computer overlays are not visible.")
    },
    close,
    fade() {
      const current = state.current
      if (!current || (current.phase !== "done" && current.phase !== "stopped")) return
      const epoch = state.epoch
      state.cursor = { kind: "hide", visible: false }
      for (const record of windows.values()) {
        void paint(record)
          .then(() =>
            record.kind === "banner"
              ? record.window.webContents.send("computer-overlay-state", { type: "fade" })
              : record.window.webContents.executeJavaScript(ComputerOverlayPage.messageScript({ type: "fade" })),
          )
          .catch(() => report(record))
      }
      if (state.fadeTimer !== undefined) time.clearTimeout(state.fadeTimer)
      state.fadeTimer = time.setTimeout(() => {
        if (epoch === state.epoch && state.current === current) close()
      }, Computer.LIMITS.overlayFadeMs)
    },
    windowIds,
    onLost(callback: () => void) {
      lost.add(callback)
      return () => void lost.delete(callback)
    },
    banner: () => windows.get("banner")?.window,
    state: () => state.current && structuredClone(state.current),
    armed(requestID: string) {
      const proof = state.armed
      const banner = windows.get("banner")
      return (
        !!proof &&
        proof.requestID === requestID &&
        state.current?.ask?.requestID === requestID &&
        banner?.window === proof.window &&
        banner.healthy &&
        !proof.window.isDestroyed() &&
        proof.window.isVisible() &&
        time.now() - proof.at >= Computer.LIMITS.askArmMs
      )
    },
    hover(_on: boolean) {
      pointerRule()
    },
    step,
    realPointer(active: boolean) {
      state.realPointer = active
      if (state.pointerTimer !== undefined) time.clearTimeout(state.pointerTimer)
      if (!active) {
        state.pointerUntil = time.now() + 300
        state.pointerTimer = time.setTimeout(pointerRule, 300)
      }
      pointerRule()
    },
    cursor(cursor: Cursor) {
      const point = cursor.point
      state.cursor = {
        ...cursor,
        visible: cursor.visible && !!point && Number.isFinite(point.x) && Number.isFinite(point.y),
        ...(point ? { point: { ...point } } : {}),
      }
      return state.current ? enqueue() : Promise.resolve()
    },
  }
}

/** A window's native id as the helper names it (macOS CGWindowID, Windows HWND); throws when none is known. */
export function nativeId(window: BrowserWindow, platform: NodeJS.Platform) {
  if (platform === "darwin") {
    // getNativeWindowHandle() is an NSView*, not the CGWindowID ScreenCaptureKit excludes.
    const id = /^window:([1-9]\d*):/.exec(window.getMediaSourceId())?.[1]
    if (id && BigInt(id) <= 0xffffffffn) return id
  }
  if (platform === "win32") {
    const bytes = window.getNativeWindowHandle()
    const id = bytes.length === 8 ? bytes.readBigUInt64LE() : bytes.length === 4 ? BigInt(bytes.readUInt32LE()) : 0n
    if (id > 0n) return id.toString()
  }
  throw new ComputerError("unavailable", "A computer overlay has no native window identity.")
}

function validRect(rect: Rect) {
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0
}

function inside(rect: Rect, point: ComputerOverlayLayout.Point) {
  return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height
}
