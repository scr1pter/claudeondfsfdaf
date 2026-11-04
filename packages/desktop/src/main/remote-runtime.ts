import { BrowserWindow } from "electron"
import { EgressAttribution } from "@vectordevai/core/local-mode/attribution"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { EgressGuard } from "@vectordevai/core/local-mode/guard"
import { engineEventSource } from "./keep-awake"
import { createRemoteLink, type RemoteLink, type RemoteSocket, type RemoteStatus } from "./remote-link"
import { createRemoteNotify, type RemoteNotify } from "./remote-notify"
import { computerName, phoneAppOrigin, relayName } from "./remote-pairing"
import type { EngineRequest } from "./remote-routes"
import { getStore } from "./store"
import { vaultSecrets } from "./vault-secrets"
import { onVectorAccountChanged, vectorAccount } from "./vector-account-runtime"

// Vector Remote in the running app (WP A41): the link (remote-link.ts) and the phone-alert sender (remote-notify.ts)
// with Electron's pieces. The identity and the paired phones are sealed in-process with the key the OS credential store
// holds (vault-secrets.ts, the app's use of safeStorage) and kept in the `vector-remote` store; whether Remote is on is
// kept beside them in the clear. Every connection is labelled for Vector Local: `remote` for tickets and the relay,
// `phone-alerts` for alerts, both off under Vector Local unless the person allows them.

const STORE = "vector-remote"
const PURPOSE = "vector-remote-identity"
const state: { link?: RemoteLink; notify?: RemoteNotify; stopAccount?: () => void } = {}

function broadcast(status: RemoteStatus) {
  for (const window of BrowserWindow.getAllWindows())
    if (!window.isDestroyed()) window.webContents.send("remote-changed", status)
}

/** Starts Remote once the local engine is up. Safe to call once per launch. */
export function startRemote(input: {
  engine: { url: string; password: string }
  packaged: boolean
  watchingChanged: () => void
  log: (message: string, meta?: Record<string, unknown>) => void
}) {
  if (state.link) return state.link
  const authorization = `Basic ${Buffer.from(`vector:${input.engine.password}`).toString("base64")}`
  const store = () => getStore(STORE)
  const events = engineEventSource({ url: input.engine.url, username: "vector", password: input.engine.password })
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
    changed: broadcast,
    log: input.log,
  })
  state.link = link
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
  return link
}

export function stopRemote() {
  state.stopAccount?.()
  state.link?.stop()
  state.link = undefined
  state.notify = undefined
}

export const remoteLink = () => state.link
export const remoteNotify = () => state.notify

/** What the renderer sees before the engine is up and Remote has started. */
export const REMOTE_STARTING: RemoteStatus = {
  enabled: false,
  state: "off",
  phones: [],
  limit: 5,
  viewers: 0,
  pairing: { state: "idle" },
}

/** One request to the local engine over its authenticated loopback server. */
async function engineRequest(base: string, authorization: string, request: EngineRequest) {
  const url = new URL(request.path, base)
  for (const [name, value] of Object.entries(request.query)) url.searchParams.set(name, value)
  const response = await fetch(url, {
    method: request.method,
    headers: {
      authorization,
      accept: "application/json",
      ...(request.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = {
        error: { code: "REMOTE_ENGINE_ANSWER", message: "Vector's engine answered with something other than JSON." },
      }
    }
  }
  return { status: response.status, body }
}
