import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { setTimeout } from "node:timers/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  screen,
  session,
  type BrowserWindowConstructorOptions,
} from "electron"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { ComputerOverlayLayout } from "@vectordevai/app/computer/overlay-layout"
import { ComputerOverlayPage } from "@vectordevai/app/computer/overlay-page"
import { NativeHelperBackend } from "../src/main/computer-backend"
import { ComputerHelper, type HelperChannel, type HelperClient } from "../src/main/computer-helper"
import {
  computerOverlayWindowOptions,
  configureComputerOverlayWindow,
  createComputerOverlay,
  type OverlayElectron,
} from "../src/main/computer-overlay"
import { registerComputerOverlay, shouldEmitWindowAllClosed } from "../src/main/computer-overlay-registry"
import { registerComputerOverlayIpc, setComputerOverlayControls } from "../src/main/computer-overlay-ipc"
import { createComputerSession } from "../src/main/computer-session"
import { defaultPrefs, resolve } from "../src/main/computer-settings"
import {
  COMPUTER_SMOKE_CHECKS,
  COMPUTER_SMOKE_LIMIT_MS,
  COMPUTER_SMOKE_MARK,
  type ComputerSmokeCheck,
  type ComputerSmokeName,
  type ComputerSmokeReason,
} from "./computer-overlay-smoke-report"
import { runComputerNativeOverlayProof } from "./computer-overlay-smoke-native"

type WindowRecord = {
  window: BrowserWindow
  config: BrowserWindowConstructorOptions
  top: Parameters<BrowserWindow["setAlwaysOnTop"]>[]
  ignore: boolean[]
  workspaces: Parameters<BrowserWindow["setVisibleOnAllWorkspaces"]>[]
  protection: boolean[]
}
const directory = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(directory)
const preload = path.join(directory, "computer-overlay-smoke-preload.cjs")
const profile = path.join(root, "profile")
const platform = process.platform
const checks = new Map<ComputerSmokeName, ComputerSmokeCheck>()
const disposers: (() => void | Promise<void>)[] = []
const records: WindowRecord[] = []

function check(name: ComputerSmokeName, ok: boolean, reason?: ComputerSmokeReason) {
  checks.set(name, { name, ok, ...(!ok ? { reason: reason ?? "assertion_failed" } : {}) })
}
function skip(name: ComputerSmokeName, reason: ComputerSmokeReason) {
  checks.set(name, { name, ok: false, skipped: true, reason })
}
function require(value: unknown): asserts value {
  if (!value) throw new Error("A fixed computer smoke assertion failed.")
}
async function until(predicate: () => boolean | Promise<boolean>, timeout = 5000) {
  const deadline = performance.now() + timeout
  while (performance.now() < deadline) {
    if (await predicate()) return
    await setTimeout(20)
  }
  throw new Error("The fixed computer smoke wait expired.")
}
function window(config: BrowserWindowConstructorOptions) {
  const created = new BrowserWindow(config)
  const record: WindowRecord = {
    window: created,
    config: { ...config, webPreferences: { ...config.webPreferences } },
    top: [],
    ignore: [],
    workspaces: [],
    protection: [],
  }
  const top = created.setAlwaysOnTop.bind(created),
    ignore = created.setIgnoreMouseEvents.bind(created),
    workspaces = created.setVisibleOnAllWorkspaces.bind(created),
    protection = created.setContentProtection.bind(created)
  created.setAlwaysOnTop = (...args) => {
    record.top.push(args)
    top(...args)
  }
  created.setIgnoreMouseEvents = (value, options) => {
    record.ignore.push(value)
    ignore(value, options)
  }
  created.setVisibleOnAllWorkspaces = (...args) => {
    record.workspaces.push(args)
    workspaces(...args)
  }
  created.setContentProtection = (value) => {
    record.protection.push(value)
    protection(value)
  }
  records.push(record)
  return created
}
const electron: OverlayElectron = {
  createWindow: window,
  screen,
  partition: (name) => session.fromPartition(name),
  appPath: root,
}

function state(): Computer.ComputerState {
  return {
    phase: "working",
    backend: platform === "win32" ? "local-windows" : "local-macos",
    mode: "foreground",
    holder: {
      sessionID: "computer-overlay-smoke",
      directory: profile,
      title: "Controlled smoke task",
      startedAt: 1,
      actions: 0,
    },
    apps: [],
    queue: [],
    escStops: platform === "darwin",
    stopChord: platform === "win32" ? Hands.STOP_CHORD.win32 : Hands.STOP_CHORD.darwin,
    lease: 1,
    reduceMotion: true,
  }
}
async function underlay(nonce?: string) {
  const target = new BrowserWindow({
    ...screen.getPrimaryDisplay().workArea,
    frame: false,
    show: true,
    backgroundColor: "#303030",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: "computer-smoke-underlay",
    },
  })
  await target.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        "<!doctype html><title>Controlled computer smoke fixture</title><body style='margin:0;background:#303030'></body>",
      ),
  )
  if (nonce) target.setTitle(`Vector computer smoke underlay ${nonce}`)
  if (platform !== "linux") {
    app.focus({ steal: true })
    target.focus()
  }
  disposers.push(() => {
    if (!target.isDestroyed()) target.destroy()
  })
  return target
}
async function properties() {
  const user = await underlay()
  const first = records.length
  const overlay = createComputerOverlay({ platform, preloadPath: preload, electron })
  disposers.push(() => overlay.close())
  if (platform === "linux") {
    // Production render deliberately refuses Linux. Exercise its shared real window configuration
    // only, without inventing another platform, a native window ID or a running Hands session.
    for (const display of screen.getAllDisplays())
      for (const strip of ComputerOverlayLayout.stripBounds(display)) {
        const created = window(computerOverlayWindowOptions({ platform, kind: "glow", bounds: strip.bounds }))
        registerComputerOverlay(created)
        configureComputerOverlayWindow(created, platform)
        await created.loadURL(
          "data:text/html;charset=utf-8," + encodeURIComponent(ComputerOverlayPage.glowStripPage(strip.edge)),
        )
        created.showInactive()
      }
    const created = window(
      computerOverlayWindowOptions({
        platform,
        kind: "banner",
        bounds: ComputerOverlayLayout.bannerBounds(screen.getPrimaryDisplay(), ComputerOverlayLayout.BANNER.max),
        preload,
      }),
    )
    registerComputerOverlay(created)
    configureComputerOverlayWindow(created, platform)
    await created.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(ComputerOverlayPage.bannerPage()))
    created.showInactive()
    created.webContents.send("computer-overlay-state", ComputerOverlayPage.bannerView(state()))
  } else {
    await overlay.show(state())
    await overlay.ready()
  }
  const owned = records.slice(first)
  const banner = owned.find((record) => record.config.webPreferences?.preload)?.window
  require(banner)
  check("overlay-count", owned.length === screen.getAllDisplays().length * 4 + 1)
  const expected = screen
    .getAllDisplays()
    .flatMap((display) => ComputerOverlayLayout.stripBounds(display).map((strip) => strip.bounds))
  expected.push(ComputerOverlayLayout.bannerBounds(screen.getPrimaryDisplay(), ComputerOverlayLayout.BANNER.max))
  const rectangle = (value: Electron.Rectangle) => JSON.stringify([value.x, value.y, value.width, value.height])
  check(
    "overlay-bounds",
    expected.every((bounds) => owned.some((record) => rectangle(record.window.getBounds()) === rectangle(bounds))),
  )
  check(
    "overlay-window-properties",
    owned.every(
      (record) =>
        record.config.transparent === true &&
        record.config.frame === false &&
        record.config.focusable === false &&
        !record.window.isFocusable() &&
        !record.window.hasShadow() &&
        record.window.isVisible(),
    ),
  )
  check(
    "overlay-stack-level",
    owned.every(
      (record) => record.top.some(([top, level]) => top && level === "screen-saver") && record.window.isAlwaysOnTop(),
    ),
  )
  check(
    "overlay-ignore-pointer",
    owned.every((record) => record.ignore.at(-1) === true),
  )
  if (platform === "darwin")
    check(
      "overlay-workspaces",
      owned.every(
        (record) =>
          record.workspaces.some(([visible, options]) => visible && options?.visibleOnFullScreen === true) &&
          record.window.isVisibleOnAllWorkspaces(),
      ),
    )
  else skip("overlay-workspaces", "not_applicable")
  if (platform === "win32")
    check(
      "overlay-content-protection",
      owned.every((record) => record.protection.at(-1) === true && record.window.isContentProtected()),
    )
  else skip("overlay-content-protection", "not_applicable")
  await until(
    async () =>
      (await banner.webContents.executeJavaScript("document.querySelector('.line')?.textContent")) === Hands.BANNER,
  )
  check(
    "overlay-banner-copy",
    (await banner.webContents.executeJavaScript("document.querySelector('.line')?.textContent")) === Hands.BANNER,
  )
  const sandbox = await Promise.all(
    owned.map(async (record) => {
      const preferences = record.config.webPreferences
      require(preferences)
      return (
        preferences.sandbox === true &&
        preferences.contextIsolation === true &&
        preferences.nodeIntegration === false &&
        preferences.devTools === false &&
        (await record.window.webContents.executeJavaScript(
          "typeof window.api === 'undefined' && typeof window.require === 'undefined' && typeof window.process === 'undefined'",
        )) === true
      )
    }),
  )
  check("overlay-sandbox", sandbox.every(Boolean))
  let accepted = 0
  const remove = setComputerOverlayControls({
    banner: () => banner,
    state,
    armed: () => false,
    act: async () => {
      accepted++
      return true
    },
    hover: () => {},
  })
  const probe = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload,
      partition: "computer-smoke-untrusted",
    },
  })
  try {
    await probe.loadURL("data:text/html;charset=utf-8,<p>Controlled untrusted sender</p>")
    check(
      "overlay-ipc-rejected",
      (await probe.webContents.executeJavaScript("window.computerOverlay.act('stop')")) === false && accepted === 0,
    )
  } finally {
    remove()
    probe.destroy()
  }
  const theme = nativeTheme.themeSource
  try {
    nativeTheme.themeSource = "dark"
    await setTimeout(50)
    const dark = owned.every((record) => record.window.getBackgroundColor().toLowerCase() === "#00000000")
    nativeTheme.themeSource = "light"
    await setTimeout(50)
    check(
      "transparent-theme-switch",
      dark && owned.every((record) => record.window.getBackgroundColor().toLowerCase() === "#00000000"),
    )
  } finally {
    nativeTheme.themeSource = theme
  }
  if (platform === "linux") skip("focus-preserved", "linux_properties_only")
  else check("focus-preserved", user.isFocused())
  user.destroy()
  // The production predicate sees actual registered Electron windows after the only main window
  // closes. Full dev-app e2e exercises index.ts's event wiring as a separate integration layer.
  check(
    "window-all-closed",
    shouldEmitWindowAllClosed(
      0,
      owned.map((record) => record.window),
    ),
  )
  overlay.close()
  for (const record of owned) if (!record.window.isDestroyed()) record.window.destroy()
}

async function controllerFixture() {
  require(platform === "darwin" || platform === "win32")
  const fault = { heartbeat: false }
  const children: ChildProcessWithoutNullStreams[] = []
  const acknowledged: Computer.HelperOpName[] = []
  const helper = new ComputerHelper({
    platform,
    channel: "dev",
    packaged: false,
    devRoot: root,
    check: async () => {},
    spawn(_executable, args): HelperChannel {
      const child = spawn(
        process.execPath,
        [
          path.join(directory, "computer-fake-helper.mjs"),
          ...args,
          "--channel",
          "stdio",
          "--platform",
          platform === "win32" ? "windows" : "macos",
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH ?? "",
            ELECTRON_RUN_AS_NODE: "1",
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          },
          windowsHide: true,
        },
      )
      children.push(child)
      child.stderr.on("data", () => {})
      const ended = new Set<(event: { code?: number; signal?: string }) => void>()
      child.once("error", () => {
        for (const callback of ended) callback({})
      })
      child.once("exit", (code, signal) => {
        for (const callback of ended) callback({ ...(code === null ? {} : { code }), ...(signal ? { signal } : {}) })
      })
      child.stdin.on("error", () => {
        for (const callback of ended) callback({})
      })
      child.stdout.on("error", () => {
        for (const callback of ended) callback({})
      })
      return {
        write(bytes) {
          require(bytes.byteLength <= Computer.LIMITS.helperFrameBytes + 4)
          const body: unknown = JSON.parse(Buffer.from(bytes).subarray(4).toString("utf8"))
          if (fault.heartbeat && body && typeof body === "object" && "op" in body && body.op === "heartbeat") return
          child.stdin.write(bytes)
        },
        end: () => child.stdin.end(),
        kill: () => {
          child.kill("SIGKILL")
        },
        onData(callback) {
          child.stdout.on("data", callback)
          return () => {
            child.stdout.removeListener("data", callback)
          }
        },
        onExit(callback) {
          ended.add(callback)
          return () => {
            ended.delete(callback)
          }
        },
      }
    },
  })
  const observed: HelperClient = {
    async request<T>(op: Computer.HelperOpName, args?: Record<string, unknown>, timeout?: number) {
      const value = await helper.request<T>(op, args, timeout)
      acknowledged.push(op)
      return value
    },
    onEvent: (callback) => helper.onEvent(callback),
    close: () => helper.close(),
  }
  const backend = new NativeHelperBackend(observed, platform === "win32" ? "local-windows" : "local-macos")
  const overlay = createComputerOverlay({ platform, preloadPath: preload, electron })
  const prefs = {
    ...defaultPrefs(platform),
    enabled: true,
    consentedAt: 1,
    mode: "foreground" as const,
    reduceMotion: true,
  }
  const policy: Computer.ComputerPolicy = {
    managed: false,
    enabled: true,
    defaultAccess: "ask",
    allowAlways: false,
    background: false,
    keepAwake: false,
    apps: new Map(),
    ignored: [],
  }
  const controller = createComputerSession({
    backend,
    overlay,
    settings: { get: () => resolve(prefs, policy, []) },
    approved: () => [],
    grants: { beginTask() {}, endTask() {}, disconnect() {} },
    helper,
    exclusions: () => ({ vectorPids: [process.pid], vectorWindowIds: [] }),
    abort: async () => {},
    keepAwake: { update() {}, close() {} },
  })
  const remove = helper.onEvent((event) => controller.helperEvent(event))
  const controls = setComputerOverlayControls({
    banner: overlay.banner,
    state: controller.state,
    armed: overlay.armed,
    hover: overlay.hover,
    act: async (action) => {
      if (action !== "stop") return false
      await controller.stop()
      return true
    },
  })
  let engineHeartbeat: ReturnType<typeof globalThis.setInterval> | undefined
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    if (engineHeartbeat) clearInterval(engineHeartbeat)
    controls()
    remove()
    controller.close()
    overlay.close()
    await Promise.allSettled([backend.close(), helper.close()])
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await until(() => children.every((child) => child.exitCode !== null || child.signalCode !== null), 1500)
  }
  disposers.push(close)
  const request = {
    v: 1 as const,
    command: "acquire" as const,
    rootSessionID: "computer-smoke-root",
    sessionID: "computer-smoke-child",
    directory: profile,
    title: "Controlled smoke task",
    wait: false,
  }
  const result = await controller.acquire(
    request,
    Object.freeze({
      id: 1,
      command: "acquire" as const,
      rootSessionID: request.rootSessionID,
      sessionID: request.sessionID,
      directory: request.directory,
    }),
  )
  require("lease" in result)
  const scope = {
    rootSessionID: request.rootSessionID,
    sessionID: request.sessionID,
    directory: request.directory,
    lease: result.lease,
  }
  engineHeartbeat = setInterval(() => {
    void controller.heartbeat(scope).catch(() => {})
  }, 1000)
  return { helper, backend, controller, overlay, scope, fault, children, acknowledged, close }
}

async function controllerChecks() {
  if (platform === "linux") {
    for (const name of [
      "controller-stop-cancels-helper",
      "heartbeat-loss-removes-overlays",
      "helper-crash-removes-overlays",
      "native-os-stop",
      "native-capture-exclusion",
    ] as const)
      skip(name, "linux_properties_only")
    return
  }
  const user = await underlay()
  {
    const fixture = await controllerFixture()
    try {
      const before = fixture.acknowledged.filter((op) => op === "cancel").length
      await fixture.controller.stop()
      await until(() => fixture.acknowledged.filter((op) => op === "cancel").length > before)
      check("controller-stop-cancels-helper", true)
    } finally {
      await fixture.close()
    }
  }
  {
    const fixture = await controllerFixture()
    try {
      fixture.fault.heartbeat = true
      await until(
        () => !fixture.controller.state().holder && records.every((record) => record.window.isDestroyed()),
        Computer.LIMITS.helperHaltMs,
      )
      check("heartbeat-loss-removes-overlays", true)
    } catch {
      check("heartbeat-loss-removes-overlays", false)
    } finally {
      await fixture.close()
    }
  }
  {
    const fixture = await controllerFixture()
    try {
      require(fixture.children.at(-1))
      fixture.children.at(-1)!.kill("SIGKILL")
      await until(
        () => !fixture.controller.state().holder && records.every((record) => record.window.isDestroyed()),
        1500,
      )
      check("helper-crash-removes-overlays", true)
    } catch {
      check("helper-crash-removes-overlays", false)
    } finally {
      await fixture.close()
    }
  }
  const nonceArgument = process.argv
    .find((value) => value.startsWith("--computer-smoke-nonce="))
    ?.slice("--computer-smoke-nonce=".length)
  const nonce = nonceArgument && /^[0-9a-f]{64}$/.test(nonceArgument) ? nonceArgument : randomBytes(32).toString("hex")
  user.setTitle(`Vector computer smoke underlay ${nonce}`)
  app.setAccessibilitySupportEnabled(true)
  const fixture = await controllerFixture()
  try {
    await fixture.controller.pause("button")
    await fixture.overlay.ready()
    const banner = fixture.overlay.banner()
    require(banner)
    banner.setTitle(`Vector computer smoke ${nonce}`)
    const before = fixture.acknowledged.filter((op) => op === "cancel").length
    await banner.webContents.executeJavaScript(
      "window.__computerSmokeTrustedStop = false; document.addEventListener('click', event => { if (event.isTrusted && event.button === 0 && event.target?.closest('button[data-action=stop]')) window.__computerSmokeTrustedStop = true }, {capture:true})",
    )
    const proof = await runComputerNativeOverlayProof({
      root,
      nonce,
      banner,
      underlay: user,
      glow: records
        .filter((record) => !record.window.isDestroyed() && record.window !== banner)
        .map((record) => record.window),
    })
    if (proof.stop.skipped) skip("native-os-stop", proof.stop.reason)
    else {
      require(proof.stop.ok)
      await until(
        async () =>
          fixture.acknowledged.filter((op) => op === "cancel").length > before &&
          (await banner.webContents.executeJavaScript("window.__computerSmokeTrustedStop === true")) === true,
      )
      check("native-os-stop", !fixture.controller.state().holder)
    }
    if (proof.capture.skipped) skip("native-capture-exclusion", proof.capture.reason)
    else check("native-capture-exclusion", proof.capture.ok, proof.capture.reason)
  } catch {
    check("native-os-stop", false, "native_proof_invalid")
    check("native-capture-exclusion", false, "native_proof_invalid")
  } finally {
    await fixture.close()
  }
}

async function main() {
  mkdirSync(path.join(profile, "session"), { recursive: true })
  app.setPath("userData", profile)
  app.setPath("sessionData", path.join(profile, "session"))
  app.setPath("home", profile)
  app.on("window-all-closed", () => {})
  registerComputerOverlayIpc(ipcMain)
  await app.whenReady()
  try {
    await properties()
    await controllerChecks()
  } catch {
    for (const name of COMPUTER_SMOKE_CHECKS) if (!checks.has(name)) check(name, false, "runtime_failure")
  } finally {
    for (const dispose of disposers.reverse())
      await Promise.resolve()
        .then(dispose)
        .catch(() => check("helper-crash-removes-overlays", false, "native_cleanup_failed"))
    for (const target of BrowserWindow.getAllWindows()) if (!target.isDestroyed()) target.destroy()
  }
  for (const name of COMPUTER_SMOKE_CHECKS) if (!checks.has(name)) check(name, false, "runtime_failure")
  const results = COMPUTER_SMOKE_CHECKS.map((name) => checks.get(name)!)
  process.stdout.write(
    COMPUTER_SMOKE_MARK +
      JSON.stringify({ protocol: 1, platform, electron: process.versions.electron, checks: results }) +
      "\n",
  )
  app.exit(results.some((result) => !result.ok && !result.skipped) ? 1 : 0)
}

if (process.versions.electron) {
  const watchdog = globalThis.setTimeout(() => app.exit(1), COMPUTER_SMOKE_LIMIT_MS - 2000)
  void main()
    .catch(() => {
      process.stderr.write("The bounded computer smoke failed.\n")
      app.exit(1)
    })
    .finally(() => clearTimeout(watchdog))
}
