import "@vectordevai/core/local-mode/backstop"
import * as http from "node:http"
import { join } from "node:path"
import { mkdirSync } from "node:fs"
import { VECTOR_AGENT_RUNTIME_ENV } from "./agent-runtime"
import { trustCompanyCertificates } from "./local-certificates"
import { PREFERENCE_MESSAGE, SESSION_MESSAGE, preferenceMessage, requestMessage } from "./everywhere-preference-bridge"
import type { EverywherePreferenceWire } from "@vectordevai/core/everywhere/preferences"
import type { EverywhereSessionWire } from "@vectordevai/core/everywhere/session-binding"

type NodeHttpWithEnvProxy = typeof http & {
  setGlobalProxyFromEnv: () => void
}

type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
  userDataPath: string
  /** Vector's own secrets, kept out of this process's launch environment (see sidecar-environment.ts). */
  environment: Record<string, string>
  /** The fingerprints of the certificate authorities from the user's own config that its owner trusted. */
  authorities: string[]
}

type StopCommand = { type: "stop" }
type SidecarCommand = StartCommand | StopCommand

type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }
  | { type: typeof PREFERENCE_MESSAGE; id: string; result: EverywherePreferenceWire.Result }
  | { type: typeof SESSION_MESSAGE; id: string; result: EverywhereSessionWire.Result }

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

type Listener = {
  stop(close?: boolean): void | Promise<void>
  everywherePreferences?: (request: unknown) => Promise<EverywherePreferenceWire.Result>
  everywhereSession?: (request: unknown) => Promise<EverywhereSessionWire.Result>
}

const parentPort = getParentPort()
let listener: Listener | undefined

parentPort.on("message", (event) => {
  const session = requestMessage(event.data, SESSION_MESSAGE)
  if (session) {
    const answer =
      listener?.everywhereSession?.(session.request) ??
      Promise.resolve({ version: 1, kind: listener ? "unsupported" : "unavailable" } as const)
    void answer
      .catch(() => ({ version: 1, kind: "unavailable" }) as const)
      .then((result) => {
        parentPort.postMessage({ type: SESSION_MESSAGE, id: session.id, result })
      })
    return
  }
  const preferences = preferenceMessage(event.data)
  if (preferences) {
    const answer =
      listener?.everywherePreferences?.(preferences.request) ??
      Promise.resolve({ version: 1, kind: listener ? "unsupported" : "unavailable" } as const)
    void answer
      .catch(() => ({ version: 1, kind: "unavailable" }) as const)
      .then((result) => {
        parentPort.postMessage({ type: PREFERENCE_MESSAGE, id: preferences.id, result })
      })
    return
  }
  const command = parseCommand(event.data)
  if (!command) return
  if (command.type === "stop") {
    void stop()
    return
  }
  void start(command)
})

async function start(command: StartCommand) {
  try {
    prepareSidecarEnv(command)
    ensureLoopbackNoProxy()
    useSystemCertificates(command.userDataPath, command.authorities)
    useEnvProxy()
    const { Server } = await import("virtual:vector-server")

    listener = await Server.listen({
      port: command.port,
      hostname: command.hostname,
      username: "vector",
      password: command.password,
      cors: ["oc://renderer"],
      everywherePreferencesPath: join(command.userDataPath, "everywhere-preferences.v1.json"),
    })
    parentPort.postMessage({ type: "ready" })
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}

async function stop() {
  try {
    await listener?.stop()
  } finally {
    listener = undefined
    parentPort.postMessage({ type: "stopped" })
    setImmediate(() => process.exit(0))
  }
}

function prepareSidecarEnv(command: StartCommand) {
  const configDir = join(command.userDataPath, "config", "vector")
  const dataHome = join(command.userDataPath, "xdg-data")
  const xdgConfigHome = join(command.userDataPath, "xdg-config")
  const cacheHome = join(command.userDataPath, "xdg-cache")
  const stateHome = join(command.userDataPath, "xdg-state")
  for (const dir of [configDir, dataHome, xdgConfigHome, cacheHome, stateHome]) {
    mkdirSync(dir, { recursive: true })
  }
  Object.assign(process.env, {
    ...command.environment,
    ...VECTOR_AGENT_RUNTIME_ENV,
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: command.password,
    VECTOR_AGENT_CONFIG_DIR: configDir,

    VECTOR_APP_NAMESPACE: "vector",
    XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? dataHome,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? xdgConfigHome,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? cacheHome,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? stateHome,
  })
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

// Node's and the system's certificates, with the certificate authorities Vector Local names (ca.files) after them,
// as desktop main trusts them (trustCompanyCertificates): the user's own config's only where its owner trusted them in
// desktop main, which says which. They are read once, here: desktop main asks to restart Vector when they change.
function useSystemCertificates(userDataPath: string, authorities: readonly string[]) {
  try {
    const trusted = trustCompanyCertificates({ userData: userDataPath, confirmed: authorities })
    trusted.problems.forEach((problem) => console.warn("company certificate skipped", problem))
  } catch (error) {
    console.warn("failed to load system certificates", error)
  }
}

function useEnvProxy() {
  try {
    ;(http as NodeHttpWithEnvProxy).setGlobalProxyFromEnv()
  } catch (error) {
    console.warn("failed to load proxy environment", error)
  }
}

function parseCommand(value: unknown): SidecarCommand | undefined {
  if (!value || typeof value !== "object") return
  const command = value as Partial<StartCommand | StopCommand>
  if (command.type === "stop") return { type: "stop" }
  if (command.type !== "start") return
  if (typeof command.hostname !== "string") return
  if (typeof command.port !== "number") return
  if (typeof command.password !== "string") return
  if (typeof command.userDataPath !== "string") return
  const environment = command.environment
  if (!environment || typeof environment !== "object") return
  if (Object.values(environment).some((value) => typeof value !== "string")) return
  // A command without the list trusts none of the user's own certificate authorities.
  const authorities = Array.isArray(command.authorities)
    ? command.authorities.filter((item): item is string => typeof item === "string")
    : []
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    userDataPath: command.userDataPath,
    environment,
    authorities,
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function getParentPort() {
  const port = process.parentPort as ParentPort | undefined
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}
