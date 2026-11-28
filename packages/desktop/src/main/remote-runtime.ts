import path from "node:path"
import { app, BrowserWindow, powerMonitor } from "electron"
import { EgressAttribution } from "@vectordevai/core/local-mode/attribution"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { EgressGuard } from "@vectordevai/core/local-mode/guard"
import { createEverywhereJobs, jobsForLink, type EverywhereJobs } from "./everywhere-wiring"
import { engineEventSource } from "./keep-awake"
import { createRemoteLink, type RemoteLink, type RemoteSocket, type RemoteStatus } from "./remote-link"
import { createRemoteNotify, type RemoteNotify } from "./remote-notify"
import { computerName, phoneAppOrigin, relayName } from "./remote-host"
import { engineRequest } from "./remote-engine"
import { getStore } from "./store"
import { vaultSecrets } from "./vault-secrets"
import { onVectorAccountChanged, vectorAccount } from "./vector-account-runtime"
import { broadcastRendererStatus } from "./renderer-status"
import type { EverywhereJobsDeps } from "./everywhere-wiring"

// Vector Remote in the running app (WP A41): the link (remote-link.ts) and the phone-alert sender (remote-notify.ts)
// with Electron's pieces. The identity and the paired phones are sealed in-process with the key the OS credential store
// holds (vault-secrets.ts, the app's use of safeStorage) and kept in the `vector-remote` store; whether Remote is on is
// kept beside them in the clear. Every connection is labelled for Vector Local: `remote` for tickets and the relay,
// `phone-alerts` for alerts, both off under Vector Local unless the person allows them.

const STORE = "vector-remote"
const PURPOSE = "vector-remote-identity"
const state: { link?: RemoteLink; notify?: RemoteNotify; jobs?: EverywhereJobs; stopAccount?: () => void } = {}

function broadcast(status: RemoteStatus) {
  broadcastRendererStatus(BrowserWindow.getAllWindows(), "remote-changed", status)
}

/** Starts Remote once the local engine is up. Safe to call once per launch. */
export function startRemote(input: {
  engine: { url: string; password: string }
  preferences?: EverywhereJobsDeps["preferences"]
  packaged: boolean
  watchingChanged: () => void
  log: (message: string, meta?: Record<string, unknown>) => void
}) {
  if (state.link) return state.link
  const authorization = `Basic ${Buffer.from(`vector:${input.engine.password}`).toString("base64")}`
  const store = () => getStore(STORE)
  const events = engineEventSource({ url: input.engine.url, username: "vector", password: input.engine.password })
  // Vector everywhere's jobs (R-C3): the link takes them as its subscriber, and they read the link back once started.
  const jobs = createEverywhereJobs({
    engine: input.engine,
    preferences: input.preferences,
    token: () => vectorAccount.token(),
    events: (signal) => events.events(signal),
    ledgerPath: path.join(app.getPath("userData"), "everywhere", "runner.json"),
    log: (message) => input.log(message),
    // The stay-awake option (everywhere-awake.ts) watches power only while jobs and the option are on. `on-ac` fires on
    // macOS and Windows and `on-battery` on macOS alone, so a one-minute check covers the rest.
    power: {
      onBattery: () => powerMonitor.isOnBatteryPower(),
      changed: (listener) => {
        powerMonitor.on("on-ac", listener)
        powerMonitor.on("on-battery", listener)
        const timer = setInterval(listener, 60_000)
        return () => {
          powerMonitor.off("on-ac", listener)
          powerMonitor.off("on-battery", listener)
          clearInterval(timer)
        }
      },
    },
  })
  const link = createRemoteLink({
    store: {
      read: async () => {
        const sealed = store().get("identity")
        if (typeof sealed !== "string" || !vaultSecrets.available()) return undefined
        return JSON.parse((await vaultSecrets.open(sealed, PURPOSE)).text) as unknown
      },
      write: async (identity) => {
        if (!vaultSecrets.available())
          throw new Error("Vector cannot store Remote's keys securely. Unlock the operating system credential store.")
        store().set("identity", vaultSecrets.seal(JSON.stringify(identity), PURPOSE))
      },
    },
    enabled: {
      get: () => store().get("enabled") === true,
      set: (value) => store().set("enabled", value),
    },
    token: () => vectorAccount.token(),
    api: (url, init) => Egress.fetch("remote", url, init),
    // The relay is reached over wss:, which Vector Local decides as the matching https address.
    allowed: (url) =>
      Egress.decide({ source: "remote", url: url.replace(/^ws(s?):/, "http$1:"), method: "GET" }).decision === "allow",
    // Opened with the relay's host granted to the `remote` source, as Egress.fetch grants a labelled request's, so
    // Vector Local's backstop lets it through exactly when `allowed` did.
    socket: (url, protocols) =>
      EgressAttribution.granted(
        { source: "remote", purpose: "account", grants: EgressGuard.destinations(new URL(url)) },
        () => new WebSocket(url, protocols) as unknown as RemoteSocket,
      ),
    engine: {
      request: (request) => engineRequest(input.engine.url, authorization, request),
      events: (signal) => events.events(signal),
    },
    origin: phoneAppOrigin(input.packaged),
    computerName: () => computerName(),
    relayName: () => relayName(),
    watchingChanged: input.watchingChanged,
    ...jobsForLink(jobs, broadcast),
    log: input.log,
  })
  state.link = link
  state.jobs = jobs
  state.notify = createRemoteNotify({
    token: () => vectorAccount.token(),
    alertKey: () => link.alertKey(),
    fetch: (url, init) => Egress.fetch("phone-alerts", url, init),
    log: input.log,
  })
  state.stopAccount = onVectorAccountChanged((status) => {
    if (status.authenticated) void link.refresh()
    else link.signedOut()
  })
  void link.start()
  jobs.start(link)
  return link
}

export function stopRemote() {
  state.stopAccount?.()
  state.jobs?.stop()
  state.jobs = undefined
  state.link?.stop()
  state.link = undefined
  state.notify = undefined
}

export const remoteLink = () => state.link
export const remoteNotify = () => state.notify
export const refreshEverywhereJobs = async () => {
  await state.jobs?.refresh()
}
export const waitingForEverywhereJobs = () => state.jobs?.want() === true

/** What the renderer sees before the engine is up and Remote has started. */
export const REMOTE_STARTING: RemoteStatus = {
  enabled: false,
  state: "off",
  phones: [],
  limit: 5,
  viewers: 0,
  pairing: { state: "idle" },
}
