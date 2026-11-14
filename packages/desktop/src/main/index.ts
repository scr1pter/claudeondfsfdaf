import "@vectordevai/core/local-mode/backstop"
import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { Event } from "electron"
import { app, dialog, powerSaveBlocker, session, webContents } from "electron"

import { Deferred, Effect, Fiber } from "effect"
import contextMenu from "electron-context-menu"

import type { ServerReadyData } from "../preload/types"
import { checkAppExists, resolveAppPath } from "./apps"
import { CHANNEL } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand } from "./ipc"
import { forwardInitializationFailure } from "./initialization"
import { exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import {
  getDefaultServerUrl,
  preferAppEnv,
  setDefaultServerUrl,
  spawnLocalServer,
  type SidecarListener,
} from "./server"
import { setupAutoUpdater, showUpdaterDialog } from "./updater"
import {
  getLastFocusedWindow,
  getMainWindow,
  getMainWindows,
  registerRendererProtocol,
  setRelaunchHandler,
  setAppQuitting,
  setBackgroundColor,
  setDockIcon,
  restoreMainWindows,
} from "./windows"
import { createWslServersController } from "./wsl/servers"
import { registerWslIpcHandlers } from "./wsl/ipc"
import { spawnWslSidecar } from "./wsl/sidecar"
import { migrate } from "./migrate"
import { leakedXdgHomes } from "./xdg-env"
import {
  answeredByEngine,
  connectDesktopLocal,
  installChromiumLocal,
  LOCAL_STORE,
  releaseStartupHold,
  startDesktopLocal,
  startFirstRun,
  trustAuthorities,
  trustedAuthorities,
  usageCheckinAllowed,
  watchCompanyCertificates,
  watchFirstRun,
} from "./local-mode"
import type { WaitingAuthority } from "./local-certificates"
import { readDesktopLocal } from "./local-policy"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { cleanupStoreFiles, removeLegacyAccessFiles } from "./store-cleanup"
import { startBrowserBridge, stopBrowserBridge } from "./browser-bridge"
import { setActivityTargets } from "./browser-agent"
import { startCloudBridge, stopCloudBridge } from "./cloud-bridge"
import { setupSecureRuntimeSecrets } from "./secure-runtime"
import { forgetRetiredCloudProviders, handleCloudOAuthDeepLinks } from "./cloud-connections"
import { registerManagedVectorAccount, vectorAccount } from "./vector-account-runtime"
import { backgroundModeStatus, requestQuit } from "./background-mode"
import {
  onScheduledAgentRunFinished,
  onScheduledAgentsChanged,
  runNextScheduledAgent,
  scheduledAgentWorkState,
  setAllScheduledAgentsPaused,
} from "./scheduled-agents"
import { createTray, destroyTray, notifyScheduledRunFinished, updateTray } from "./tray"
import { engineEventSource, setDesktopWorkBlocker, startKeepAwake } from "./keep-awake"
import { remoteLink, startRemote, stopRemote } from "./remote-runtime"
import { startVault, stopVault } from "./vault-runtime"
import { getStore } from "./store"
import { USAGE_STORE } from "./store-keys"
import { createUsageCheckin, usageCheckinEndpoint } from "./usage-checkin"
import { UsageReport } from "@vectordevai/schema/usage-report"

const APP_NAMES: Record<string, string> = {
  dev: "Vector Dev",
  beta: "Vector Beta",
  prod: "Vector",
}
const APP_IDS: Record<string, string> = {
  dev: "ai.vector.app.dev",
  beta: "ai.vector.app.beta",
  prod: "ai.vector.app",
}
const TEST_ONBOARDING = process.env.VECTOR_TEST_ONBOARDING === "1"
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let server: SidecarListener | null = null
let keepAwake: ReturnType<typeof startKeepAwake> | undefined
let trayReady = false

const pendingDeepLinks: string[] = []

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  const win = getLastFocusedWindow()
  if (win) sendDeepLinks(win, urls)
}

async function routeDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  const remaining = await handleCloudOAuthDeepLinks(await vectorAccount.consume(urls))
  logger.log("deep links routed", {
    received: urls.length,
    handled: urls.length - remaining.length,
    forwarded: remaining.length,
  })
  emitDeepLinks(remaining)
}

async function killSidecar() {
  if (!server) return
  const current = server
  server = null
  await current.stop()
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  process.env.VECTOR_DISABLE_EMBEDDED_WEB_UI = "true"

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "ai.vector.app.dev"
  // A Restart or AppImage update from 1.99.99 passes its leaked XDG values on; undo them before anything reads appData.
  if (process.platform === "linux") {
    const leaked = leakedXdgHomes(process.env, appId)
    if (leaked.appData) app.setPath("appData", leaked.appData)
    for (const key of leaked.keys) delete process.env[key]
  }
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `vector-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.VECTOR_AGENT_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  // Keep the product identity stable in both packaged and local development
  // launches. macOS otherwise exposes the Electron runtime name in menus and
  // permission surfaces, which makes a development build look like a different
  // application.
  app.setName(APP_NAMES[CHANNEL])
  app.setAppUserModelId(appId)
  const userDataPath = onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId)
  app.setPath("userData", userDataPath)
  app.setPath("sessionData", join(userDataPath, "session"))
  logger = initLogging()
  initCrashReporter()

  const wslServers = createWslServersController(
    import.meta.env.VECTOR_REQUIRED_CLI_VERSION,
    async (distro, input) => {
      logger.log("spawning wsl sidecar", { distro })
      return spawnWslSidecar(distro, {
        ...input,
        onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
      })
    },
    {
      localEnabled: () => Egress.policy().enabled,
      logger: {
        log: (message, meta) => logger.log(message, meta),
        error: (message, meta) => logger.error(message, meta),
      },
    },
  )
  const unregisterManagedAccount = registerManagedVectorAccount((token, synchronize) =>
    wslServers.replaceAccount(token, synchronize),
  )
  const stopSidecars = async () => {
    unregisterManagedAccount()
    stopRemote()
    stopVault()
    keepAwake?.stop()
    setDesktopWorkBlocker(undefined)
    await Promise.all([killSidecar(), stopBrowserBridge(), stopCloudBridge(), wslServers.stopAll()])
  }
  const relaunch = () => {
    // A relaunch ends this process, so it counts as an explicit quit: without
    // the intent flag, the last window closing on the way out would ask
    // background mode whether to stay resident and answer yes.
    requestQuit()
    setAppQuitting()
    void stopSidecars().finally(() => {
      // An AppImage runs from a temporary mount that is removed when this process exits, so relaunch the AppImage
      // file instead. APPIMAGE alone can be inherited from another AppImage (e.g. a dev run from its terminal), so
      // only trust it when this executable is inside APPDIR. Electron drops the original arguments whenever execPath
      // is given, so pass them on.
      const appDir = process.env.APPDIR
      const appImage = appDir && process.execPath.startsWith(`${appDir}/`) ? process.env.APPIMAGE : undefined
      app.relaunch(appImage ? { execPath: appImage, args: process.argv.slice(1) } : undefined)
      app.exit(0)
    })
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  // Local development builds have an unstable code identity, so keep their
  // Chromium profile isolated from the user's OS credential prompts. Packaged
  // builds must use the platform credential backend; setupSecureRuntimeSecrets
  // fails visibly after app readiness if one is unavailable.
  if (!app.isPackaged) {
    app.commandLine.appendSwitch("password-store", "basic")
  }
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  preferAppEnv(app.getPath("userData"))
  // Vector Local's policy, the company's certificate authorities and Chromium's switches, all before app.whenReady.
  startDesktopLocal({
    userData: app.getPath("userData"),
    commandLine: app.commandLine,
    log: (message, data) => logger.log(message, data),
    confirmed: trustedAuthorities(getStore(LOCAL_STORE)),
  })
  // On a first run, the requests Vector makes for itself at start wait until the person chooses how to run models. The
  // engine's database, in <XDG_DATA_HOME>/vector, which preferAppEnv set, tells an upgraded install from a new one.
  const firstRun = startFirstRun({
    userData: app.getPath("userData"),
    store: getStore(LOCAL_STORE),
    reported: getStore(USAGE_STORE).get("sent") !== undefined,
    engineData: process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "vector") : undefined,
  })

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("vector://"))
    if (urls.length) void routeDeepLinks(urls)
    // A main window only: never a hidden helper window such as the research browsers' host.
    const win = getMainWindow()
    if (!win) {
      restoreMainWindows()
      return
    }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    void routeDeepLinks([url])
  })

  let quitting = false
  app.on("before-quit", () => {
    quitting = true
    // Quitting through the app menu, Cmd+Q, or the updater is just as explicit
    // as the tray's own item, and window-all-closed still fires on the way out.
    requestQuit()
    setAppQuitting()
    void stopSidecars()
  })

  app.on("will-quit", () => {
    quitting = true
    destroyTray()
    setAppQuitting()
    void stopSidecars()
  })

  app.on("window-all-closed", () => {
    logger.warn("all windows closed; waiting for explicit activation")
    // Without a tray there is no way back to a window and no way to quit, so a
    // failed tray falls back to the old behaviour rather than stranding the
    // user with an invisible process.
    if (!trayReady) {
      if (process.platform !== "darwin") app.quit()
      return
    }
    void backgroundModeStatus(scheduledAgentWorkState()).then((status) => {
      logger.log("background mode decision", { keepAlive: status.keepAlive, reason: status.reason })
      void updateTray()
      if (!status.keepAlive) app.quit()
    })
  })

  app.on("activate", () => {
    if (quitting) return
    const win = getMainWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      return
    }
    restoreMainWindows()
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: webContents.getURL(), details }, "error")
  })

  setRelaunchHandler(() => {
    relaunch()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      setAppQuitting()
      void stopSidecars().finally(() => app.exit(0))
    })
  }

  const serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()

  yield* Effect.promise(() => app.whenReady())
  // Before any window or partition loads anything: one Vector Local dispatcher on every Chromium session.
  const chromium = installChromiumLocal({
    app,
    defaultSession: session.defaultSession,
    fromPartition: (partition, options) => session.fromPartition(partition, options),
    webContents: () => webContents.getAllWebContents(),
    directory: join(app.getPath("userData"), "local-mode"),
  })
  yield* Effect.tryPromise({
    try: () => setupSecureRuntimeSecrets(),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => {
        logger.error("secure runtime vault unavailable", error)
        dialog.showErrorBox("Vector couldn't open its secure credential vault", String(error))
        app.quit()
      }),
    ),
  )
  // The agent browser's activity reaches every main window, so the app shows it with Preview closed too.
  setActivityTargets(getMainWindows)
  const browserBridge = yield* Effect.promise(() => startBrowserBridge())
  process.env.VECTOR_BROWSER_BRIDGE_URL = browserBridge.url
  process.env.VECTOR_BROWSER_BRIDGE_TOKEN = browserBridge.token
  const cloudBridge = yield* Effect.promise(() =>
    startCloudBridge({
      workspaces: async () => {
        const { parallelWorkspaceCloudScopes } = await import("./parallel-workspaces")
        return parallelWorkspaceCloudScopes()
      },
    }),
  )
  process.env.VECTOR_CLOUD_BRIDGE_URL = cloudBridge.url
  process.env.VECTOR_CLOUD_BRIDGE_TOKEN = cloudBridge.token
  if (forgetRetiredCloudProviders()) logger.log("removed a retired Netlify credential from the cloud vault")

  if (!TEST_ONBOARDING && process.env.VECTOR_ENABLE_LEGACY_MIGRATION === "1") migrate()
  yield* Effect.promise(() => cleanupStoreFiles(app.getPath("userData"))).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        if (result.deleted.length === 0) return
        logger.log("cleaned scoped store files", { count: result.deleted.length, scanned: result.scanned })
      }),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to clean scoped store files", error)
      }),
    ),
  )
  void removeLegacyAccessFiles(app.getPath("userData"))
  app.setAsDefaultProtocolClient("vector")
  registerRendererProtocol()
  setDockIcon()
  const updater = setupAutoUpdater({ stop: stopSidecars, relaunch })
  const usageSharing = () => getStore(USAGE_STORE).get("enabled") !== false
  registerIpcHandlers({
    killSidecar: () => killSidecar(),
    relaunch,
    awaitInitialization: Effect.fnUntraced(
      function* () {
        logger.log("awaiting server ready")
        const res = yield* Deferred.await(serverReady)
        logger.log("server ready", { url: res.url })
        return res
      },
      (e) => Effect.runPromise(e),
    ),
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    parseMarkdown: async (markdown) => parseMarkdown(markdown),
    checkAppExists: (appName) => checkAppExists(appName),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    updater,
    showUpdater: () => showUpdaterDialog(updater, true),
    setBackgroundColor: (color) => setBackgroundColor(color),
    exportDebugLogs: () => exportDebugLogs(),
    recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
    getUsageSharing: usageSharing,
    setUsageSharing: (enabled) => getStore(USAGE_STORE).set("enabled", enabled),
  })
  registerWslIpcHandlers(wslServers)
  // Automatic checks wait for the first run's answer; Vector Local's own rules apply inside the updater.
  void updater.start()
  if (firstRun.held()) void firstRun.answered().then(() => updater.start())
  const updateTimer = setInterval(() => void updater.poll(), 10 * 60 * 1000)
  updateTimer.unref()
  app.once("will-quit", () => clearInterval(updateTimer))
  yield* Effect.promise(() => startNetLog()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to start net log", error)
      }),
    ),
  )

  const port = yield* Effect.gen(function* () {
    const fromEnv = process.env.VECTOR_PORT
    if (fromEnv) {
      const parsed = Number.parseInt(fromEnv, 10)
      if (!Number.isNaN(parsed)) return parsed
    }

    const res = yield* Deferred.make<number, unknown>()
    const server = createServer()
    server.on("error", (e) => Deferred.failSync(res, () => e))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        Deferred.failSync(res, () => new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => Effect.runSync(Deferred.succeed(res, port)))
    })

    return yield* Deferred.await(res)
  })
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  const password = randomUUID()

  const loadingTask = yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { url })

    ensureLoopbackNoProxy()
    useEnvProxy()

    logger.log("spawning sidecar", { url })
    const { listener, health } = yield* Effect.promise(() =>
      spawnLocalServer(hostname, port, password, {
        userDataPath: app.getPath("userData"),
        // During the first run's hold the engine holds the fetches it makes for itself at start, until the answer.
        startupHold: firstRun.held(),
        // The engine trusts the certificate authorities from the user's own config that desktop main does.
        authorities: trustedAuthorities(getStore(LOCAL_STORE)),
        onStdout: (message) => writeLog("server", "stdout", { message }),
        onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
        onExit: (code) => writeLog("utility", "sidecar exited", { code }, "warn"),
      }),
    )
    server = listener
    yield* Deferred.succeed(serverReady, {
      url,
      username: "vector",
      password,
    })

    yield* Effect.promise(() => health.wait).pipe(
      Effect.timeout("30 seconds"),
      Effect.catch((e) =>
        Effect.sync(() => {
          logger.error("sidecar health check failed", e.toString())
        }),
      ),
    )

    // The engine's Vector Local against the app's, and the app's own requests into the engine's network log.
    // A change to Vector Local applies here as soon as the engine says so (local.updated), Chromium included.
    const local = connectDesktopLocal({
      engine: { url, password },
      own: () => readDesktopLocal(app.getPath("userData")),
      changed: () => {
        chromium.apply()
        void wslServers.applyLocalPolicy().catch((error) => logger.error("could not stop WSL for Vector Local", error))
      },
      log: (message, data) => logger.log(message, data),
    })
    app.once("will-quit", () => local.stop())
    if (firstRun.held()) {
      const stop = watchFirstRun(firstRun, {
        answered: () => answeredByEngine({ url, password }, () => vectorAccount.status().authenticated),
      })
      app.once("will-quit", stop)
      // The engine's own startup fetches (the model catalog's refresh, the free models and plans catalogs, the provider
      // policy) load as soon as the person has answered, in this engine.
      void firstRun.answered().then(() => releaseStartupHold({ url, password }))
    }
    // The engine trusts the certificate authorities Vector Local names from its start, so a change takes a restart. One
    // the user's own config names waits until its owner trusts it here.
    const stopCertificates = watchCompanyCertificates({
      userData: app.getPath("userData"),
      changed: () => void askToRestartForCertificates(relaunch),
      confirmed: () => trustedAuthorities(getStore(LOCAL_STORE)),
      ask: askToTrustCertificates,
      trust: (fingerprints) => trustAuthorities(getStore(LOCAL_STORE), fingerprints),
    })
    app.once("will-quit", stopCertificates)

    // Idle sleep freezes agents mid-run, so the machine stays awake while the engine has work running, and while the
    // desktop runs an external agent or a workspace's checks itself.
    const blocker = {
      start: () => powerSaveBlocker.start("prevent-app-suspension"),
      stop: (id: number) => powerSaveBlocker.stop(id),
    }
    keepAwake = startKeepAwake({
      source: engineEventSource({ url, username: "vector", password }),
      blocker,
      // While a paired phone watches, busy sessions keep the computer awake, those waiting on a person included.
      watching: () => remoteLink()?.watching() ?? false,
      log: (message, meta) => logger.log(message, meta),
    })
    setDesktopWorkBlocker(blocker)

    yield* Effect.promise(() => vectorAccount.restore())
    // Vector Remote (WP A41): connects only while Remote is on and a phone is paired or pairing.
    startRemote({
      engine: { url, password },
      packaged: app.isPackaged,
      watchingChanged: () => {
        keepAwake?.refresh()
        void updateTray()
      },
      log: (message, meta) => logger.log(message, meta),
    })
    app.once("will-quit", () => stopRemote())
    // Brain Vault (WP A45): Settings → Memory → Backup, and the nightly backup while the app is open.
    startVault({ engine: { url, password }, log: (message, meta) => logger.log(message, meta) })
    app.once("will-quit", () => stopVault())
    // The sidebar's name and photo; never holds up startup.
    void vectorAccount.refreshProfile()
    if (process.platform === "win32") {
      yield* Effect.promise(() => wslServers.initialize())
    }
    logger.log("loading task finished")
  }).pipe(forwardInitializationFailure(serverReady), Effect.forkChild)

  yield* Fiber.await(loadingTask)

  // The local engine keeps its history in <XDG_DATA_HOME>/vector, which preferAppEnv set above.
  const engineData = process.env.XDG_DATA_HOME
  const usageEndpoint = usageCheckinEndpoint({
    packaged: app.isPackaged,
    channel: CHANNEL,
    override: process.env.VECTOR_USAGE_URL,
  })
  const usage = createUsageCheckin({
    endpoint: usageEndpoint,
    store: getStore(USAGE_STORE),
    enabled: usageSharing,
    allowed: () => (usageEndpoint ? usageCheckinAllowed(usageEndpoint) : false),
    engine: { url, username: "vector", password },
    token: () => vectorAccount.token(),
    fetch: (input, init) => fetch(input, init),
    send: (input, init) => Egress.fetch("usage-checkin", input, init),
    now: Date.now,
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    // A note beside that history that this check-in reports it. Only a CLI given the same XDG_DATA_HOME, as some Linux
    // sessions export to both, reads that directory, and it then leaves the history to this check-in rather than
    // counting it twice.
    reported: engineData
      ? () =>
          writeFile(
            join(engineData, "vector", UsageReport.DESKTOP_MARKER),
            `${JSON.stringify({ reportedBy: "Vector desktop usage check-in" })}\n`,
          )
      : undefined,
  })
  usage.start()
  app.once("will-quit", () => usage.stop())
  if (firstRun.held()) void firstRun.answered().then(() => usage.checkin())

  // The tray is what makes staying resident survivable: without it a
  // background-mode keep-alive would leave a process the user can see no window
  // for and has no menu to quit. trayReady gates the keep-alive below on that.
  trayReady = createTray({
    readState: () => scheduledAgentWorkState(),
    openVector: () => {
      const win = getMainWindow()
      if (!win) {
        restoreMainWindows()
        return
      }
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    },
    runNext: () => {
      runNextScheduledAgent()
      void updateTray()
    },
    setAllPaused: (paused) => {
      setAllScheduledAgentsPaused(paused)
      void updateTray()
    },
    quit: () => {
      requestQuit()
      app.quit()
    },
    remote: {
      read: () => {
        const status = remoteLink()?.status()
        return {
          phones: status?.phones.length ?? 0,
          connected: status?.phones.filter((phone) => phone.connected).length ?? 0,
          watching: status?.phones.some((phone) => phone.watching) ?? false,
        }
      },
      disconnectAll: () =>
        void remoteLink()
          ?.disconnectAll()
          .then(() => updateTray())
          .catch((error) => logger.warn("could not disconnect Remote's phones", error)),
    },
  })
  onScheduledAgentsChanged(() => void updateTray())
  onScheduledAgentRunFinished((record) => {
    notifyScheduledRunFinished(record)
    void updateTray()
  })

  const windows = restoreMainWindows()
  if (windows.length) {
    createMenu({
      trigger: (id) => {
        const win = getLastFocusedWindow()
        if (win) sendMenuCommand(win, id)
      },
      checkForUpdates: () => {
        void showUpdaterDialog(updater, true)
      },
      relaunch: () => {
        relaunch()
      },
    })
  }
})

// A certificate authority the user's own config names applies only once its owner trusts it (local-certificates.ts):
// anything that can write the config, an agent's shell command included, could have added it.
async function askToTrustCertificates(waiting: readonly WaitingAuthority[]) {
  const named = waiting.map((item) => `${item.subject} (${item.file})`).join("; ")
  const one = waiting.length === 1
  const answer = await dialog.showMessageBox({
    type: "warning",
    title: "Vector Local",
    message: one
      ? "Trust a certificate authority from your config?"
      : `Trust ${waiting.length} certificate authorities from your config?`,
    detail: `Your Vector config names ${one ? "a certificate authority" : "certificate authorities"} in local.ca.files: ${named}. Vector and its engine would accept the secure connections ${one ? "it vouches" : "they vouch"} for, so whoever holds ${one ? "its key" : "their keys"} could read and change what Vector sends over them. Trust ${one ? "it" : "them"} only if you or your company added ${one ? "it" : "them"}. Until then, Vector does not use ${one ? "it" : "them"}.`,
    buttons: ["Trust", "Not now"],
    defaultId: 1,
    cancelId: 1,
  })
  return answer.response === 0
}

// The certificate authorities company policy or the user's config names changed while Vector runs: its engine trusts
// them once it restarts, which stops what agents are running, so the person chooses when.
async function askToRestartForCertificates(relaunch: () => void) {
  const answer = await dialog.showMessageBox({
    type: "question",
    title: "Vector Local",
    message: "Vector's certificate authorities changed",
    detail:
      "Vector's engine reads the certificate authorities your company's policy or your config names when it starts, so it needs a restart to trust the new ones. Restarting stops what agents are running now.",
    buttons: ["Restart Vector", "Later"],
    defaultId: 1,
    cancelId: 1,
  })
  if (answer.response === 0) relaunch()
}

Effect.runFork(main)
