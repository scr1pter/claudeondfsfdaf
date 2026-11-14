import { createSignal } from "solid-js"
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
import { createRemoteLink } from "../../../desktop/src/main/remote-link"
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

yieldLaunchScreen("app")

const ORIGIN = location.origin
const RELAY = `ws://${location.hostname}:8787/v1/connect`
const relay = createMemoryRelay()

const requests = []
const permissions = []
let wake
const queue = []
const engine = {
  async request(request) {
    requests.push(request)
    if (request.path === "/project")
      return { status: 200, body: [{ id: "prj_1", worktree: "/repo", name: "repo", sandboxes: [] }] }
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
  alertKeys: { save: async () => {}, remove: async () => {}, forget: async () => {} },
  phoneName: () => "Fixture phone",
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
    navigate: (to) => setPage(to.endsWith("sessions") || to.endsWith("approvals") ? "approvals" : "pair"),
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
            {page() === "pair" ? <PairRoute {...props} /> : <ApprovalsRoute {...props} />}
          </section>
        </div>
      </DialogProvider>
    </PlatformProvider>
  )
}

render(() => <Fixture />, document.querySelector("#root"))
