import { describe, expect, test } from "bun:test"
import { CLOSE } from "@vectordevai/relay/protocol"
import { createPhoneRemote, type EngineEvent, type PhoneRemote } from "../../../app/src/phone/remote/client"
import { PasskeyError, type PasskeyAdapter } from "../../../app/src/phone/remote/passkey"
import { memoryRemoteStore, type RemoteStore } from "../../../app/src/phone/remote/store"
import { createRemoteLink, type EngineEvent as DesktopEvent } from "./remote-link"
import { softPasskey } from "./remote-phone.fixture"
import { createMemoryRelay, ticketFor, type MemoryRelay } from "./remote-relay.fixture"
import type { EngineRequest } from "./remote-routes"
import { fromBase64url } from "./remote-crypto"

// WP A42: Vector Remote end to end. The phone app's real client (packages/app/src/phone/remote/client.ts) pairs with
// and drives this desktop's real link (remote-link.ts, A41) through an in-memory relay that behaves as packages/relay
// does on the wire. The phone's passkey is a software authenticator that answers the way a platform passkey does; the
// desktop verifies it with packages/core/src/webauthn/verify.ts. CI's browser spec repeats pairing and approving with
// Chromium's virtual WebAuthn authenticator (packages/app/e2e/regression/remote-phone.spec.ts).

const ORIGIN = "https://remote.vectordev.ai"
const RELAY = "wss://relay.vectordev.ai/v1/connect"

async function until(condition: () => boolean | Promise<boolean>, ms = 3_000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error("condition never held")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function engine() {
  const requests: EngineRequest[] = []
  const queue: DesktopEvent[] = []
  let wake: (() => void) | undefined
  const permissions: { id: string; sessionID: string; permission: string; patterns: string[] }[] = []
  return {
    requests,
    permissions,
    push(event: DesktopEvent) {
      queue.push(event)
      wake?.()
    },
    api: {
      async request(request: EngineRequest) {
        requests.push(request)
        if (request.path === "/project")
          return { status: 200, body: [{ id: "prj_1", worktree: "/repo", name: "repo", sandboxes: [] }] }
        if (request.path === "/session") return { status: 200, body: [{ id: "ses_1", title: "Fix the login" }] }
        if (request.path === "/permission") return { status: 200, body: permissions }
        if (request.path === "/session/ses_big/message") return { status: 200, body: [{ text: "y".repeat(90_000) }] }
        if (request.path.startsWith("/permission/") && request.path.endsWith("/reply")) {
          const id = request.path.split("/")[2]
          const index = permissions.findIndex((item) => item.id === id)
          if (index >= 0) permissions.splice(index, 1)
          return { status: 200, body: true }
        }
        return { status: 200, body: { ok: true } }
      },
      async *events(signal: AbortSignal) {
        while (!signal.aborted) {
          const next = queue.shift()
          if (next) {
            yield next
            continue
          }
          await new Promise<void>((resolve) => {
            wake = resolve
            signal.addEventListener("abort", () => resolve(), { once: true })
          })
        }
      },
    },
  }
}

function computer(relay: MemoryRelay) {
  const fake = engine()
  const stored: { value?: unknown } = {}
  const enabled = { value: false }
  const link = createRemoteLink({
    store: {
      read: async () => stored.value,
      write: async (identity) => void (stored.value = JSON.parse(JSON.stringify(identity))),
    },
    enabled: { get: () => enabled.value, set: (value) => void (enabled.value = value) },
    token: async () => "vct_desktop",
    api: async (url, init) => {
      const body = JSON.parse(String(init.body ?? "{}"))
      if (url.endsWith("/ticket")) {
        relay.key(body.device, body.key)
        return Response.json({
          ticket: ticketFor("computer", body.device),
          url: RELAY,
          protocol: "vector.v1",
          expiresAt: Date.now() + 300_000,
        })
      }
      if (url.endsWith("/kill")) relay.kill()
      return Response.json({ ok: true })
    },
    allowed: () => true,
    socket: (url, protocols) => relay.socket(url, protocols) as never,
    engine: fake.api,
    origin: ORIGIN,
    computerName: () => "Studio Mac",
    relayName: () => "Mac",
    timing: { heartbeatMs: 1_000, refreshMs: 60_000, batchMs: 10, retryMs: 10 },
  })
  return { link, fake, stored, enabled }
}

function phone(relay: MemoryRelay, options: { store?: RemoteStore; passkeyOrigin?: string } = {}) {
  const store = options.store ?? memoryRemoteStore()
  const key = softPasskey({ origin: options.passkeyOrigin ?? ORIGIN, rpId: "remote.vectordev.ai" })
  const alertKeys = new Map<string, Uint8Array>()
  const calls: { path: string; body?: unknown }[] = []
  let refuseGets = 0
  const passkeys: PasskeyAdapter = {
    async create({ challenge, rpId }) {
      expect(rpId).toBe("remote.vectordev.ai")
      return { id: key.id, ...(await key.create(challenge)) }
    },
    async get({ challenge, credential }) {
      expect(credential).toBe(key.id)
      if (refuseGets > 0) {
        refuseGets -= 1
        throw new PasskeyError("cancelled", "The passkey was cancelled or timed out. Try again.")
      }
      return key.get(challenge)
    },
  }
  const remote = createPhoneRemote({
    origin: ORIGIN,
    api: async (path, init) => {
      calls.push({ path, body: init.body })
      if (path === "/api/remote/ticket") {
        const body = init.body as { device: string }
        return { ticket: ticketFor("phone", body.device), url: RELAY, protocol: "vector.v1", expiresAt: Date.now() + 300_000 }
      }
      return { ok: true }
    },
    store,
    socket: (url, protocols) => relay.socket(url, protocols),
    relayAllowed: (url) => url.host === "relay.vectordev.ai",
    passkeys,
    alertKeys: {
      save: async (id, raw) => void alertKeys.set(id, raw),
      remove: async (id) => void alertKeys.delete(id),
      forget: async () => alertKeys.clear(),
    },
    phoneName: () => "iPhone",
    timing: { heartbeatMs: 1_000, channelMs: 300, requestMs: 3_000, retryMs: 20 },
  })
  return { remote, store, alertKeys, calls, key, refuseGets: (count: number) => void (refuseGets = count) }
}

/** Pairs a phone with the computer through the relay, the person confirming the six digits on the computer. */
async function pair(desktop: ReturnType<typeof computer>, mobile: ReturnType<typeof phone>) {
  const offer = await desktop.link.startPairing()
  await mobile.remote.startPairing(offer.link)
  await until(() => mobile.remote.view().pairing.state === "ready")
  await mobile.remote.pair()
  await until(() => desktop.link.status().pairing.state === "confirm")
  await until(() => mobile.remote.view().pairing.state === "confirm")
  const shown = desktop.link.status().pairing as { code: string; phone: string }
  const onPhone = mobile.remote.view().pairing as { code: string }
  return { offer, shown, onPhone }
}

const deviceOf = (desktop: ReturnType<typeof computer>) => (desktop.stored.value as { device: string }).device

describe("pairing a phone with a computer", () => {
  test("both screens show the same six digits; confirming stores the phone, the computer and the alert key", async () => {
    const relay = createMemoryRelay()
    const desktop = computer(relay)
    const mobile = phone(relay)
    const { shown, onPhone } = await pair(desktop, mobile)
    expect(shown.code).toMatch(/^\d{6}$/)
    expect(onPhone.code).toBe(shown.code)
    expect(shown.phone).toBe("iPhone")
    expect(mobile.remote.view().computers).toEqual([])
    await desktop.link.confirmPairing(shown.code)
    await until(() => mobile.remote.view().pairing.state === "paired")
    expect(mobile.remote.view().pairing).toEqual({ state: "paired", name: "Studio Mac" })
    const record = await mobile.store.read()
    expect(record.computers).toHaveLength(1)
    expect(record.computers[0]).toMatchObject({ device: deviceOf(desktop), name: "Studio Mac", credential: mobile.key.id })
    // The desktop's alert key reached the phone, sealed for it alone.
    const identity = desktop.stored.value as { alertKey: string; alertKeyId: string; phones: { name: string }[] }
    expect(mobile.alertKeys.get(identity.alertKeyId)).toEqual(fromBase64url(identity.alertKey))
    expect(identity.phones.map((item) => item.name)).toEqual(["iPhone"])
    await until(() => mobile.remote.view().computers[0]?.channel === "open")
    // The phone asked for its own ticket with a plain name and no key.
    const ticket = mobile.calls.find((call) => call.path === "/api/remote/ticket")!
    expect(Object.keys(ticket.body as object).sort()).toEqual(["device", "name", "role"])
    expect(ticket.body).toMatchObject({ role: "phone", name: "iPhone" })
    desktop.link.stop()
    mobile.remote.disconnect()
  })

  test("the relay sees only ciphertext: no code, name, prompt, passkey or key material in clear", async () => {
    const relay = createMemoryRelay()
    const desktop = computer(relay)
    const mobile = phone(relay)
    const { shown } = await pair(desktop, mobile)
    await desktop.link.confirmPairing(shown.code)
    await until(() => mobile.remote.view().computers[0]?.channel === "open")
    const computerID = deviceOf(desktop)
    await mobile.remote.request(computerID, {
      method: "POST",
      path: "/session/ses_1/prompt_async",
      directory: "/repo",
      body: { parts: [{ type: "text", text: "Rename the login button" }] },
    })
    const identity = desktop.stored.value as { alertKey: string; privateKey: string }
    const decoder = new TextDecoder("latin1")
    const wire = relay.seen.map((frame) => decoder.decode(frame)).join("\n") + relay.texts.join("\n")
    for (const secret of [shown.code, "Studio Mac", "Rename the login button", "pair-request", identity.alertKey, mobile.key.id])
      expect({ secret, found: wire.includes(secret) }).toEqual({ secret, found: false })
    desktop.link.stop()
    mobile.remote.disconnect()
  })

  test("a code that does not match is never confirmed; a second phone on the same QR stops pairing", async () => {
    const relay = createMemoryRelay()
    const desktop = computer(relay)
    const first = phone(relay)
    const { offer, shown } = await pair(desktop, first)
    await expect(desktop.link.confirmPairing(shown.code === "000000" ? "111111" : "000000")).rejects.toThrow()
    const second = phone(relay)
    await second.remote.startPairing(offer.link)
    await until(() => second.remote.view().pairing.state === "ready")
    await second.remote.pair()
    await until(() => second.remote.view().pairing.state === "failed")
    expect((second.remote.view().pairing as { message: string }).message).toContain("Another phone")
    await until(() => desktop.link.status().pairing.state === "failed")
    expect((desktop.stored.value as { phones: unknown[] }).phones).toEqual([])
    desktop.link.stop()
    first.remote.disconnect()
    second.remote.disconnect()
  })

  test("a passkey made for another origin is refused by the computer", async () => {
    const relay = createMemoryRelay()
    const desktop = computer(relay)
    const mobile = phone(relay, { passkeyOrigin: "https://remote.example.test" })
    const offer = await desktop.link.startPairing()
    await mobile.remote.startPairing(offer.link)
    await until(() => mobile.remote.view().pairing.state === "ready")
    await mobile.remote.pair()
    await until(() => mobile.remote.view().pairing.state === "failed")
    expect((mobile.remote.view().pairing as { message: string }).message).toContain("refused")
    expect((desktop.stored.value as { phones: unknown[] }).phones).toEqual([])
    desktop.link.stop()
    mobile.remote.disconnect()
  })

  test("links that are not pairing codes, or have expired, are refused on the phone", async () => {
    const relay = createMemoryRelay()
    const mobile = phone(relay)
    await mobile.remote.startPairing("https://remote.vectordev.ai/phone/pair#not-an-offer")
    expect(mobile.remote.view().pairing).toEqual({ state: "failed", message: "That is not a Vector Remote pairing code." })
    const desktop = computer(relay)
    const offer = await desktop.link.startPairing()
    await mobile.remote.startPairing(offer.link.replace("https://remote.vectordev.ai", "https://evil.example.test"))
    expect(mobile.remote.view().pairing.state).toBe("failed")
    desktop.link.stop()
    mobile.remote.disconnect()
  })
})

async function paired() {
  const relay = createMemoryRelay()
  const desktop = computer(relay)
  const mobile = phone(relay)
  const { shown } = await pair(desktop, mobile)
  await desktop.link.confirmPairing(shown.code)
  await until(() => mobile.remote.view().computers[0]?.channel === "open")
  return { relay, desktop, mobile, computerID: deviceOf(desktop) }
}

describe("using a paired computer from the phone", () => {
  test("requests go through the computer's allowlist; a large answer arrives whole", async () => {
    const { desktop, mobile, computerID } = await paired()
    const projects = await mobile.remote.request(computerID, { method: "GET", path: "/project" })
    expect(projects).toEqual({ status: 200, body: [{ id: "prj_1", worktree: "/repo", name: "repo", sandboxes: [] }] })
    const sessions = await mobile.remote.request(computerID, {
      method: "GET",
      path: "/session",
      directory: "/repo",
      query: { roots: "true", limit: "30" },
    })
    expect(sessions.body).toEqual([{ id: "ses_1", title: "Fix the login" }])
    const big = await mobile.remote.request(computerID, { method: "GET", path: "/session/ses_big/message", directory: "/repo" })
    expect((big.body as { text: string }[])[0]!.text.length).toBe(90_000)
    const refused = await mobile.remote.request(computerID, { method: "GET", path: "/config", directory: "/repo" })
    expect(refused.status).toBe(403)
    const elsewhere = await mobile.remote.request(computerID, { method: "GET", path: "/session", directory: "/" })
    expect(elsewhere.status).toBe(403)
    desktop.link.stop()
    mobile.remote.disconnect()
  })

  test("a turn the phone starts is marked, so the app's auto-accept leaves its requests to a person", async () => {
    const { desktop, mobile, computerID } = await paired()
    const answer = await mobile.remote.request(computerID, {
      method: "POST",
      path: "/session/ses_1/prompt_async",
      directory: "/repo",
      body: { parts: [{ type: "text", text: "Run the tests" }], agent: "build", tools: { bash: true } },
    })
    expect(answer.status).toBe(200)
    expect(desktop.link.isPhoneTurn(["ses_1"])).toBe(true)
    const sent = desktop.fake.requests.find((request) => request.path === "/session/ses_1/prompt_async")!
    expect(sent.body).toEqual({ parts: [{ type: "text", text: "Run the tests" }] })
    desktop.link.stop()
    mobile.remote.disconnect()
  })

  test("allowing once needs the phone's passkey, which the computer verifies; deny rejects; always is refused", async () => {
    const { desktop, mobile, computerID } = await paired()
    desktop.fake.permissions.push(
      { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["bun test"] },
      { id: "per_2", sessionID: "ses_1", permission: "edit", patterns: ["src/a.ts"] },
      { id: "per_3", sessionID: "ses_1", permission: "bash", patterns: ["rm -rf build"] },
    )
    const allowed = await mobile.remote.approve(computerID, "/repo", "per_1")
    expect(allowed.kind).toBe("answered")
    expect((allowed as { answer: { status: number } }).answer.status).toBe(200)
    const reply = desktop.fake.requests.find((request) => request.path === "/permission/per_1/reply")!
    expect(reply.body).toEqual({ reply: "once" })

    const denied = await mobile.remote.deny(computerID, "/repo", "per_2", "Not that file")
    expect(denied.status).toBe(200)
    expect(desktop.fake.requests.find((request) => request.path === "/permission/per_2/reply")!.body).toEqual({
      reply: "reject",
      message: "Not that file",
    })

    // A patched phone asking for "always", or "once" without a passkey, is refused by the computer.
    const always = await mobile.remote.request(computerID, {
      method: "POST",
      path: "/permission/per_3/reply",
      directory: "/repo",
      body: { reply: "always" },
    })
    expect(always.status).toBe(403)
    const bare = await mobile.remote.request(computerID, {
      method: "POST",
      path: "/permission/per_3/reply",
      directory: "/repo",
      body: { reply: "once" },
    })
    expect(bare.status).toBe(403)
    expect(desktop.fake.requests.some((request) => request.path === "/permission/per_3/reply")).toBe(false)
    desktop.link.stop()
    mobile.remote.disconnect()
  })

  test("a passkey prompt the browser refuses outside a tap is kept for the next tap", async () => {
    const { desktop, mobile, computerID } = await paired()
    desktop.fake.permissions.push({ id: "per_9", sessionID: "ses_1", permission: "bash", patterns: ["ls"] })
    mobile.refuseGets(1)
    const first = await mobile.remote.approve(computerID, "/repo", "per_9")
    expect(first.kind).toBe("tap")
    const second = await (first as { confirm: () => Promise<{ kind: string; answer?: { status: number } }> }).confirm()
    expect(second).toMatchObject({ kind: "answered", answer: { status: 200 } })
    expect(desktop.fake.requests.find((request) => request.path === "/permission/per_9/reply")!.body).toEqual({
      reply: "once",
    })
    desktop.link.stop()
    mobile.remote.disconnect()
  })

  test("events stream to the phone only while it watches", async () => {
    const { desktop, mobile, computerID } = await paired()
    const received: EngineEvent[] = []
    mobile.remote.onEvents((from, events) => {
      expect(from).toBe(computerID)
      received.push(...events)
    })
    await mobile.remote.request(computerID, { method: "GET", path: "/project" })
    await mobile.remote.watch(computerID, true)
    await until(() => desktop.link.watching())
    desktop.fake.push({
      directory: "/repo",
      payload: { type: "permission.asked", properties: { id: "per_5", sessionID: "ses_1", permission: "bash" } },
    })
    await until(() => received.length === 1)
    expect(received[0]).toMatchObject({ directory: "/repo", type: "permission.asked" })
    await mobile.remote.watch(computerID, false)
    await until(() => !desktop.link.watching())
    desktop.link.stop()
    mobile.remote.disconnect()
  })
})

describe("devices", () => {
  test("forgetting a computer on the phone drops its keys and its alert key, and closes its channel", async () => {
    const { desktop, mobile, computerID } = await paired()
    expect(mobile.alertKeys.size).toBe(1)
    await mobile.remote.forget(computerID)
    expect(mobile.remote.view().computers).toEqual([])
    expect((await mobile.store.read()).computers).toEqual([])
    expect(mobile.alertKeys.size).toBe(0)
    await expect(mobile.remote.request(computerID, { method: "GET", path: "/project" })).rejects.toThrow()
    desktop.link.stop()
    mobile.remote.disconnect()
  })

  test("a computer that unpaired this phone no longer opens a channel to it", async () => {
    const { desktop, mobile, computerID, relay } = await paired()
    const phoneID = mobile.remote.view().device!
    await desktop.link.unpair(phoneID)
    // With no phone paired the computer leaves the relay; a new pairing offer brings it back.
    await until(() => !relay.online(computerID))
    expect(mobile.remote.view().computers[0]).toMatchObject({ online: false, channel: "offline" })
    await desktop.link.startPairing()
    await until(() => relay.online(computerID))
    await until(() => mobile.remote.view().computers[0]?.channel === "not-paired")
    await expect(mobile.remote.request(computerID, { method: "GET", path: "/project" })).rejects.toThrow()
    desktop.link.stop()
    mobile.remote.disconnect()
  })

  test("Disconnect all phones on the computer: the phone reconnects once and no longer reaches it", async () => {
    const { desktop, mobile, computerID, relay } = await paired()
    const phoneID = mobile.remote.view().device!
    await desktop.link.disconnectAll()
    await until(() => mobile.remote.view().state === "online" && relay.online(phoneID))
    expect(deviceOf(desktop)).not.toBe(computerID)
    expect(mobile.remote.view().computers[0]).toMatchObject({ device: computerID, online: false, channel: "offline" })
    desktop.link.stop()
    mobile.remote.disconnect()
  })

  test("a phone refused for revocation twice is removed; starting over revokes its old device id", async () => {
    const relay = createMemoryRelay()
    const mobile = phone(relay)
    await mobile.remote.connect()
    const phoneID = mobile.remote.view().device!
    await until(() => relay.online(phoneID))
    // "Disconnect all": one refusal, then a new ticket connects again.
    relay.drop(phoneID, CLOSE.REMOTE_REVOKED)
    await until(() => relay.online(phoneID) && mobile.remote.view().state === "online")
    // A revoked device: refused again after its one new ticket.
    relay.revoke(phoneID)
    relay.drop(phoneID, CLOSE.REMOTE_REVOKED)
    await until(() => mobile.remote.view().state === "revoked")
    expect(mobile.remote.view().message).toContain("removed")
    await mobile.remote.reset()
    expect(mobile.calls.some((call) => call.path === `/api/remote/devices/${phoneID}/revoke`)).toBe(true)
    expect(mobile.remote.view().device).toBeUndefined()
    expect((await mobile.store.read()).identity).toBeUndefined()
    mobile.remote.disconnect()
  })

  test("idle, replaced and paused connections say why and do not reconnect by themselves", async () => {
    for (const [code, state] of [
      [CLOSE.IDLE, "idle-closed"],
      [CLOSE.REPLACED, "replaced"],
      [CLOSE.REMOTE_PAUSED, "paused"],
      [CLOSE.REMOTE_DEVICE_LIMIT, "device-limit"],
      [CLOSE.REMOTE_FAIR_USE, "fair-use"],
    ] as const) {
      const relay = createMemoryRelay()
      const mobile = phone(relay)
      await mobile.remote.connect()
      const phoneID = mobile.remote.view().device!
      await until(() => relay.online(phoneID))
      relay.drop(phoneID, code)
      await until(() => mobile.remote.view().state === state)
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(relay.online(phoneID)).toBe(false)
      mobile.remote.disconnect()
    }
  })
})

export type { PhoneRemote }
