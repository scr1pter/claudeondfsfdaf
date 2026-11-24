import { createSignal, Match, Switch } from "solid-js"
import { render } from "solid-js/web"
import { DialogProvider } from "@vectordevai/ui/context/dialog"
import { PlatformProvider } from "../../src/context/platform"
import { SettingsRemoteV2 } from "../../src/components/settings-v2/remote"
import { createPhoneRemote } from "../../src/phone/remote/client"
import { browserPasskeys } from "../../src/phone/remote/passkey"
import { memoryRemoteStore } from "../../src/phone/remote/store"
import { readEnvironment } from "../../src/phone/environment"
import { decodePhoneStatus } from "../../src/phone/status"
import { PairRoute } from "../../src/phone/routes/pair"
import { ApprovalsRoute } from "../../src/phone/routes/approvals"
import { SessionsRoute } from "../../src/phone/routes/sessions"
import { ALERT_AAD, decodePushPayload, notificationFor, openAlert } from "../../src/phone/alerts"
import { forgetAlertKey, forgetAlertKeys, readAlertKey, saveAlertKey } from "../../src/phone/alert-keys"
import { fromBase64url } from "../../src/phone/auth"
import { createHelperPhoneAlerts } from "../../src/context/helper-phone-alert"
import { sessionNotificationAllowed } from "../../src/context/notification-event-gate"
import { sendPhoneAlert } from "../../src/context/phone-alerts"
import { createRemoteLink } from "../../../desktop/src/main/remote-link"
import { createRemoteNotify } from "../../../desktop/src/main/remote-notify"
import { createMemoryRelay, ticketFor } from "../../../desktop/src/main/remote-relay.fixture"
import { yieldLaunchScreen } from "../../src/features/launch/launch-bridge"
import "../../src/index.css"
import "../../src/phone/phone.css"

// WP A42: Vector Remote end to end in a browser, for packages/app/e2e/regression/remote-phone.spec.ts. The left pane is
// Settings → Remote on the desktop's real link (packages/desktop/src/main/remote-link.ts); the right pane is the phone
// app's real Pair and Approvals pages on its real client. They meet through the in-memory relay the desktop's tests use.
// Passkeys are the browser's own WebAuthn: the spec adds Chromium's virtual authenticator, so the desktop's verifier
// (packages/core/src/webauthn/verify.ts) checks what a real authenticator makes, with the origin exactly this page's.
// What the fake engine was asked is kept on window.remoteFixture for the spec to read.
//
// Track B B09 (Codium finish B09b, for e2e/regression/codium-remote-helpers.spec.ts): the same link also carries the
// phone's real Sessions page and its Tasks view, so every phone request goes through the desktop's real forwarder
// (remote-link.ts → remote-routes.ts) before it reaches the fake engine. The fake engine answers one session ("Fix the
// login"), its task board (a helper waiting for approval, one working, one interrupted, one disconnected, and a
// background command) and Stop; its Stop answer lists only the two helpers it stopped. A helper's alert takes the app's
// own path (createHelperPhoneAlerts and sendPhoneAlert, as notification.tsx wires them), then the desktop's
// remote-notify sealing with the alert key the phone received when it paired, and the phone opens it as its service
// worker does. Every field the phone must never show (reports, steps, commands, output paths, prompts, usage figures)
// holds PRIVATE or 98765.

yieldLaunchScreen("app")

const ORIGIN = location.origin
const RELAY = `ws://${location.hostname}:8787/v1/connect`
const relay = createMemoryRelay()
const connections = new URLSearchParams(location.search).get("connect") === "1"

const NOW = Date.now()
const ROOT = {
  id: "ses_1",
  projectID: "prj_1",
  directory: "/repo",
  title: "Fix the login",
  time: { created: NOW - 60_000, updated: NOW },
}
const REVIEW_ID = "cr_phone_review"
let review
let stopped = false
// A Task.Info as the engine sends it (packages/schema/src/task.ts), with private text in every field the phone drops.
const helperTask = (id, title, status, extra) => ({
  id,
  sessionID: `ses_${id}`,
  parentSessionID: ROOT.id,
  source: "subagent",
  title,
  agent: "general",
  status,
  startedAt: NOW - 30_000,
  elapsedMs: 30_000,
  currentStep: "PRIVATE step",
  lastTool: "PRIVATE tool",
  usage: {
    cost: 0.98765,
    tokens: { input: 98765, output: 98765, reasoning: 0, cache: { read: 0, write: 0 } },
    total: 98765,
    toolUses: 1,
    steps: 1,
  },
  ownedPaths: [],
  dependsOn: [],
  resultAvailable: false,
  reason: "PRIVATE report",
  attempt: 1,
  controls: { inspect: true, message: true, stop: status === "running" || status === "waiting_on_user" },
  ...extra,
})
const board = () => ({
  tasks: [
    stopped
      ? helperTask("tsk_wait", "Check the login form", "stopped")
      : helperTask("tsk_wait", "Check the login form", "waiting_on_user", {
          waiting: { kind: "permission", since: NOW - 5_000, requestID: "per_9", summary: "PRIVATE rm -rf build" },
        }),
    helperTask("tsk_log", "Update the changelog", stopped ? "stopped" : "running"),
    helperTask("tsk_icon", "Rebuild the icons", "stopped", { interrupted: { at: NOW - 10_000, cause: "crash" } }),
    helperTask("tsk_docs", "Index the docs", "running", { connection: "disconnected" }),
  ],
  shells: [
    {
      id: "shl_1",
      title: "Unit tests",
      command: "PRIVATE bun test",
      status: stopped ? "stopped" : "running",
      startedAt: NOW - 20_000,
      outputPath: "/PRIVATE/shl_1.log",
      outputBytes: 98765,
    },
  ],
  truncated: false,
})

const requests = []
const permissions = []
let wake
const queue = []
const engine = {
  async request(request) {
    requests.push(request)
    if (request.path === "/project")
      return { status: 200, body: [{ id: "prj_1", worktree: "/repo", name: "repo", sandboxes: [] }] }
    if (request.method === "GET" && request.path === "/session") return { status: 200, body: [ROOT] }
    if (request.path === "/session/status") return { status: 200, body: { [ROOT.id]: { type: "busy" } } }
    if (request.path === "/experimental/capabilities")
      return {
        status: 200,
        body: { backgroundSubagents: true, sessionStop: true, ...(connections ? { connections } : {}) },
      }
    if (connections && request.method === "GET" && request.path === "/experimental/connect/runs")
      return { status: 200, body: review ? [review] : [] }
    if (connections && request.method === "POST" && request.path === `/experimental/session/${ROOT.id}/connect`) {
      review = {
        id: REVIEW_ID,
        request: {
          ...request.body,
          id: REVIEW_ID,
          action: "review",
          requester: { kind: "user", sessionID: ROOT.id },
          requestID: "phone-review",
          directory: ROOT.directory,
        },
        status: "running",
        time: { created: NOW, started: NOW },
      }
      return { status: 200, body: review }
    }
    if (connections && request.method === "POST" && request.path === `/experimental/connect/runs/${REVIEW_ID}/cancel`) {
      if (review?.status !== "running") return { status: 200, body: false }
      review = {
        ...review,
        status: "done",
        time: { ...review.time, ended: Date.now() },
        result: {
          state: "cancelled",
          verdict: "not-reviewed",
          summary: "Review cancelled.",
          findings: [],
          sessions: [],
          notes: [],
        },
      }
      return { status: 200, body: true }
    }
    if (request.path === `/experimental/session/${ROOT.id}/tasks`) return { status: 200, body: board() }
    if (request.method === "POST" && request.path === `/experimental/session/${ROOT.id}/stop`) {
      stopped = true
      // SessionStopResult (packages/schema/src/task.ts): the helpers this Stop ended, and the one command it stopped.
      const ended = board().tasks.filter((task) => task.id === "tsk_wait" || task.id === "tsk_log")
      return { status: 200, body: { aborted: true, tasks: ended, shells: 1, excluded: 0, skipped: 1 } }
    }
    if (request.path === "/permission") return { status: 200, body: permissions.slice() }
    if (request.path === "/question") return { status: 200, body: [] }
    if (request.path.startsWith("/permission/") && request.path.endsWith("/reply")) {
      const id = request.path.split("/")[2]
      const index = permissions.findIndex((item) => item.id === id)
      if (index >= 0) {
        const [removed] = permissions.splice(index, 1)
        queue.push({
          directory: "/repo",
          payload: { type: "permission.replied", properties: { sessionID: removed.sessionID, requestID: id, reply: request.body.reply } },
        })
        wake?.()
      }
      return { status: 200, body: true }
    }
    return { status: 200, body: [] }
  },
  async *events(signal) {
    while (!signal.aborted) {
      const next = queue.shift()
      if (next) {
        yield next
        continue
      }
      await new Promise((resolve) => {
        wake = resolve
        signal.addEventListener("abort", () => resolve(), { once: true })
      })
    }
  },
}

let identity
let enabled = false
const link = createRemoteLink({
  store: {
    read: async () => identity,
    write: async (value) => void (identity = JSON.parse(JSON.stringify(value))),
  },
  enabled: { get: () => enabled, set: (value) => void (enabled = value) },
  token: async () => "vct_fixture",
  api: async (url, init) => {
    const body = JSON.parse(String(init.body ?? "{}"))
    if (url.endsWith("/ticket")) {
      relay.key(body.device, body.key)
      return Response.json({ ticket: ticketFor("computer", body.device), url: RELAY, protocol: "vector.v1", expiresAt: Date.now() + 300_000 })
    }
    if (url.endsWith("/kill")) relay.kill()
    return Response.json({ ok: true })
  },
  allowed: () => true,
  socket: (url, protocols) => relay.socket(url, protocols),
  engine,
  origin: ORIGIN,
  computerName: () => "Fixture Mac",
  relayName: () => "Mac",
  timing: { batchMs: 20 },
})
const listeners = new Set()
const platformRemote = {
  status: async () => link.status(),
  setEnabled: (value) => link.setEnabled(value),
  startPairing: () => link.startPairing(),
  confirmPairing: (code) => link.confirmPairing(code),
  cancelPairing: async () => link.cancelPairing(),
  unpair: (device) => link.unpair(device),
  disconnectAll: () => link.disconnectAll(),
  isPhoneTurn: async (ids) => link.isPhoneTurn(ids),
  onChange: (callback) => {
    listeners.add(callback)
    return () => listeners.delete(callback)
  },
}
setInterval(() => {
  const current = link.status()
  for (const listener of listeners) listener(current)
}, 100)

const remote = createPhoneRemote({
  origin: ORIGIN,
  api: async (path, init) => {
    if (path === "/api/remote/ticket")
      return { ticket: ticketFor("phone", init.body.device), url: RELAY, protocol: "vector.v1", expiresAt: Date.now() + 300_000 }
    return { ok: true }
  },
  store: memoryRemoteStore(),
  socket: (url, protocols) => relay.socket(url, protocols),
  relayAllowed: () => true,
  passkeys: browserPasskeys(),
  // The phone app's own alert-key store (as app.tsx wires it), so an alert this computer seals opens on this phone.
  alertKeys: { save: saveAlertKey, remove: forgetAlertKey, forget: forgetAlertKeys },
  phoneName: () => "Fixture phone",
})

// The helper alert path. `asked` holds what the app hands the desktop (the `phone-alert-send` IPC's argument,
// desktop ipc.ts), `notices` what the desktop's remote-notify posts to vectordev.ai; nothing leaves the page.
const asked = []
const notices = []
const notify = createRemoteNotify({
  token: async () => "vct_fixture",
  alertKey: () => link.alertKey(),
  fetch: async (url, init) => {
    notices.push({ url, body: JSON.parse(String(init.body)) })
    return Response.json({ ok: true })
  },
})
// What the renderer's platform gives sendPhoneAlert (desktop renderer/index.tsx): the plan status lists phone alerts,
// and send goes to the desktop's sender. Settings → Notifications' choices are on with no quiet hours.
const alertPlatform = {
  vectorAccount: {
    codium: async () => ({ signedIn: true, enabled: true, listed: ["alerts", "remote"], entitlements: { rank: 2 } }),
  },
  phoneAlerts: {
    send: async (alert) => {
      asked.push(JSON.parse(JSON.stringify(alert)))
      await notify.send(alert)
    },
  },
}
// As notification.tsx builds it, with the conversation looked up from the fake engine's one session and nothing open on
// screen; the settle is the real 3 s.
const helperAlerts = createHelperPhoneAlerts({
  lookup: async (_directory, id) => (id === ROOT.id ? ROOT : undefined),
  allowed: sessionNotificationAllowed,
  viewed: () => false,
  disposed: () => false,
  send: (alert) => sendPhoneAlert(alertPlatform, { event: () => true, quietHours: () => null }, alert),
})
// A helper session of "Fix the login" and its lifecycle record (engine agent/subagent-kind.ts SubagentRecord).
const HELPER = { id: "ses_wait", parentID: ROOT.id, title: "Check the login form (@general subagent)" }
const helperRecord = (state) => ({
  kind: "subagent",
  agent: "general",
  custom: false,
  title: "Check the login form",
  parentSessionID: ROOT.id,
  parentMessageID: "msg_1",
  rootSessionID: ROOT.id,
  model: { providerID: "fixture", modelID: "fixture" },
  background: true,
  startedAt: Date.now() - 1_000,
  resultSummary: "PRIVATE report",
  reason: "PRIVATE reason",
  ...(state === "waiting"
    ? {
        status: "running",
        waiting: { kind: "permission", requestID: "per_9", since: Date.now() - 50, summary: "PRIVATE rm -rf build" },
      }
    : { status: "cancelled", interruption: { at: Date.now() - 50, cause: "crash" }, error: "PRIVATE error" }),
})

const status = decodePhoneStatus({
  enabled: true,
  plan: { id: "vector-50", name: "Pro", state: "active" },
  listed: ["remote"],
  entitlements: { rank: 2, remote: { computers: 3 } },
  meters: { remote: { computers: 1, limit: 3 } },
})

window.remoteFixture = {
  link: () => {
    const pairing = link.status().pairing
    return pairing.state === "waiting" ? pairing.link : undefined
  },
  ask: (id, command) => {
    permissions.push({ id, sessionID: "ses_1", permission: "bash", patterns: [command], metadata: { command }, always: [] })
    queue.push({
      directory: "/repo",
      payload: {
        type: "permission.asked",
        properties: { id, sessionID: "ses_1", permission: "bash", patterns: [command], metadata: { command }, always: [] },
      },
    })
    wake?.()
  },
  replies: () => requests.filter((request) => /^\/permission\/[^/]+\/reply$/.test(request.path)).map((request) => ({ path: request.path, body: request.body })),
  phones: () => identity?.phones?.map((phone) => phone.name) ?? [],
  engine: () => requests.slice(),
  phoneTurn: () => link.isPhoneTurn([ROOT.id]),
  phone: (request) => remote.request(remote.view().computers[0].device, request),
  // Stands in for notification.tsx reading the engine's own `session.updated` for the helper session.
  helper: (state) => void helperAlerts("/repo", { ...HELPER, metadata: { subagent: helperRecord(state) } }),
  asked: () => asked.slice(),
  // Each alert as sent, its sealed plaintext opened with the key the phone stored at pairing (the format alerts.ts
  // documents), and what the phone's service worker shows: the server relays `{v: 1, kind: "e2e", c, k}`
  // (api/_lib/web-push.ts parseEncryptedAlert) and the worker opens it with openAlert and notificationFor (phone sw.ts).
  alerts: () =>
    Promise.all(
      notices.map(async (notice) => {
        const sealed = fromBase64url(notice.body.ciphertext)
        const key = await readAlertKey(notice.body.key)
        // Mirrors openAlert's decrypt (src/phone/alerts.ts) on purpose: openAlert keeps only the title and the route,
        // so the raw plaintext the desktop sealed is read here.
        const plain = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: sealed.slice(0, 12),
            additionalData: new TextEncoder().encode(ALERT_AAD),
            tagLength: 128,
          },
          key,
          sealed.slice(12),
        )
        const payload = JSON.stringify({ v: 1, kind: "e2e", c: notice.body.ciphertext, k: notice.body.key })
        return {
          url: notice.url,
          sent: notice.body,
          sealed: JSON.parse(new TextDecoder().decode(plain)),
          shown: notificationFor(await openAlert(decodePushPayload(payload), readAlertKey)),
        }
      }),
    ),
}

function Fixture() {
  const [page, setPage] = createSignal("pair")
  const props = {
    get status() {
      return status
    },
    session: { accessToken: "fixture", refreshToken: "fixture", expiresAt: Date.now() + 3_600_000 },
    environment: readEnvironment(navigator, window),
    remote,
    navigate: (to) => setPage(to.endsWith("sessions") ? "sessions" : to.endsWith("approvals") ? "approvals" : "pair"),
    refresh: () => {},
  }
  return (
    <PlatformProvider
      value={{
        platform: "desktop",
        version: "0.0.0-remote-fixture",
        openLink: () => {},
        restart: async () => {},
        openDirectoryPickerDialog: async () => null,
        back: () => {},
        forward: () => {},
        notify: async () => {},
        remote: platformRemote,
      }}
    >
      <DialogProvider>
        <div style={{ display: "grid", "grid-template-columns": "1fr 420px", gap: "16px" }}>
          <section aria-label="Desktop" data-pane="desktop">
            <SettingsRemoteV2 />
          </section>
          <section aria-label="Phone" data-pane="phone" class="phone-app">
            <nav>
              <button type="button" onClick={() => setPage("pair")}>
                Phone: Pair
              </button>
              <button type="button" onClick={() => setPage("approvals")}>
                Phone: Approvals
              </button>
            </nav>
            <Switch fallback={<PairRoute {...props} />}>
              <Match when={page() === "sessions"}>
                <SessionsRoute {...props} />
              </Match>
              <Match when={page() === "approvals"}>
                <ApprovalsRoute {...props} />
              </Match>
            </Switch>
          </section>
        </div>
      </DialogProvider>
    </PlatformProvider>
  )
}

render(() => <Fixture />, document.querySelector("#root"))
