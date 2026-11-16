import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdirSync } from "node:fs"
import { app, utilityProcess } from "electron"
import type { Details } from "electron"
import { getLogger } from "./logging"
import { fallbackBinDirectories, getUserShell, loadShellEnv, pathDelimiter, unionPath } from "./shell-env"
import { getStore } from "./store"
import { DEFAULT_SERVER_URL_KEY } from "./store-keys"
import { VECTOR_AGENT_RUNTIME_ENV } from "./agent-runtime"
import { sidecarEnvironment } from "./sidecar-environment"

export type HealthCheck = { wait: Promise<void> }

type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

export type SidecarListener = { stop: () => Promise<void> }

const SIDECAR_SERVICE_NAME = "Vector server"
const SIDECAR_START_STALL_TIMEOUT = 60_000
const SIDECAR_STOP_TIMEOUT = 6_000

type SpawnLocalServerOptions = {
  userDataPath: string
  /**
   * A first run's hold: the engine starts with the fetches Vector makes for itself at start held (StartupHold), until
   * desktop main lets them go once the person has chosen how to run models.
   */
  startupHold?: boolean
  /** The fingerprints of the certificate authorities from the user's own config that its owner trusted. */
  authorities?: readonly string[]
  /**
   * Values the engine receives only in its start message, never in its launch environment, such as the Hands
   * bridge pair (section 2.8). They are set inside the sidecar, so no other process can read them from its launch.
   */
  startEnvironment?: Readonly<Record<string, string>>
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onExit?: (code: number) => void
}

export function getDefaultServerUrl(): string | null {
  const value = getStore().get(DEFAULT_SERVER_URL_KEY)
  return typeof value === "string" ? value : null
}

export function setDefaultServerUrl(url: string | null) {
  if (url) {
    getStore().set(DEFAULT_SERVER_URL_KEY, url)
    return
  }

  getStore().delete(DEFAULT_SERVER_URL_KEY)
}

export function preferAppEnv(userDataPath: string) {
  const shell = process.platform === "win32" ? null : getUserShell()
  const configDir = join(userDataPath, "config", "vector")
  const dataHome = join(userDataPath, "xdg-data")
  const cacheHome = join(userDataPath, "xdg-cache")
  const stateHome = join(userDataPath, "xdg-state")
  for (const dir of [configDir, dataHome, cacheHome, stateHome]) {
    mkdirSync(dir, { recursive: true })
  }
  const logger = getLogger()
  const loaded = shell ? loadShellEnv(shell, logger) : null
  // XDG_CONFIG_HOME stays as Vector was launched. On Linux Electron derives appData from it, and app.relaunch() and the
  // AppImage updater hand this environment to the next launch, which would then open a different, empty profile. The
  // sidecar points its own XDG_CONFIG_HOME into userData (prepareSidecarEnv in sidecar.ts).
  const shellEnv = Object.fromEntries(Object.entries(loaded ?? {}).filter((entry) => entry[0] !== "XDG_CONFIG_HOME"))
  // The login shell's PATH first, then whatever Electron was launched with,
  // then the directories package and version managers install into. The
  // sidecar and every MCP child it spawns inherit this, so node/npx/bun stay
  // findable even when the probe failed and Finder handed us /usr/bin:/bin.
  const path = unionPath([loaded?.PATH, process.env.PATH, ...fallbackBinDirectories({ ...process.env, ...loaded })])
  logger.log(
    `[server] PATH for child processes has ${path.split(pathDelimiter()).length} entries (shell probe ${loaded ? "loaded" : "unavailable"})`,
  )
  Object.assign(process.env, {
    ...shellEnv,
    PATH: path,
    ...VECTOR_AGENT_RUNTIME_ENV,
    VECTOR_EXPERIMENTAL_ICON_DISCOVERY: "true",
    VECTOR_EXPERIMENTAL_FILEWATCHER: "true",
    VECTOR_CLIENT: "desktop",
    VECTOR_AGENT_CONFIG_DIR: configDir,

    VECTOR_APP_NAMESPACE: "vector",
    XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? dataHome,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? cacheHome,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? stateHome,
  })
}

export async function spawnLocalServer(
  hostname: string,
  port: number,
  password: string,
  options: SpawnLocalServerOptions,
) {
  const sidecar = join(dirname(fileURLToPath(import.meta.url)), "sidecar.js")
  const environment = sidecarEnvironment(process.env, options.startEnvironment)
  const child = utilityProcess.fork(sidecar, [], {
    cwd: process.cwd(),
    env: { ...createSidecarEnv(environment.launch), ...(options.startupHold ? { VECTOR_STARTUP_HOLD: "1" } : {}) },
    serviceName: SIDECAR_SERVICE_NAME,
    stdio: "pipe",
  })
  let exited = false
  const exit = defer<number>()

  const onProcessGone = (_event: unknown, details: Details) => {
    if (details.type !== "Utility" || details.name !== SIDECAR_SERVICE_NAME) return
    options.onStderr?.(`utility process gone reason=${details.reason} exitCode=${details.exitCode}`)
  }

  app.on("child-process-gone", onProcessGone)
  child.once("exit", (code) => {
    exited = true
    app.off("child-process-gone", onProcessGone)
    options.onExit?.(code)
    exit.resolve(code)
  })
  child.on("error", (error) => options.onStderr?.(`utility process error: ${serializeError(error).message}`))

  child.stdout?.on("data", (chunk: Buffer) => options.onStdout?.(chunk.toString("utf8").trimEnd()))
  child.stderr?.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8").trimEnd()))

  await new Promise<void>((resolve, reject) => {
    let done = false
    let timeout: NodeJS.Timeout

    const fail = (error: Error) => {
      if (done) return
      done = true
      cleanup()
      reject(error)
    }

    const refreshTimeout = () => {
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        fail(new Error(`Sidecar did not become ready within ${SIDECAR_START_STALL_TIMEOUT}ms: ${sidecar}`))
      }, SIDECAR_START_STALL_TIMEOUT)
    }

    const onMessage = (message: SidecarMessage) => {
      if (message.type === "ready") {
        if (done) return
        done = true
        cleanup()
        resolve()
        return
      }
      if (message.type === "error") {
        fail(Object.assign(new Error(message.error.message), { stack: message.error.stack }))
      }
    }
    const onExit = (code: number) => {
      fail(new Error(`Sidecar exited before ready with code ${code}`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.off("message", onMessage)
      child.off("exit", onExit)
    }

    child.on("message", onMessage)
    child.on("exit", onExit)
    refreshTimeout()
    child.postMessage({
      type: "start",
      hostname,
      port,
      password,
      userDataPath: options.userDataPath,
      environment: environment.secrets,
      authorities: [...(options.authorities ?? [])],
    })
  }).catch((error) => {
    if (!exited) child.kill()
    throw error
  })

  const wait = (async () => {
    const url = `http://${hostname}:${port}`
    let healthy = false
    const gone = exit.promise.then((code) => {
      if (healthy) return
      throw new Error(`Sidecar exited before health check passed with code ${code}`)
    })

    const ready = async () => {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (await checkHealth(url, password)) {
          healthy = true
          return
        }
      }
    }

    await Promise.race([ready(), gone])
  })()

  let stopping: Promise<void> | undefined

  return {
    listener: {
      stop: () => {
        if (stopping) return stopping
        if (exited) return Promise.resolve()
        child.postMessage({ type: "stop" })
        stopping = Promise.race([
          exit.promise.then(() => undefined),
          delay(SIDECAR_STOP_TIMEOUT).then(() => {
            if (!exited) child.kill()
          }),
        ])
        return stopping
      },
    },
    health: { wait },
  }
}

export async function checkHealth(url: string, password?: string | null): Promise<boolean> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }

  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`vector:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

function createSidecarEnv(launch: Record<string, string>): Record<string, string> {
  const env = { ...launch }
  delete env.DEBUG
  if (process.platform === "linux") delete env.LD_PRELOAD
  if (!app.isPackaged) Object.assign(env, { VECTOR_DISABLE_CHANNEL_DB: "1" })
  return env
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
