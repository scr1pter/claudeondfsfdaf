import { describe, expect, test } from "bun:test"
import { CLOSE } from "@vectordevai/relay/protocol"
import {
  createPhoneRemote,
  PHONE_REVIEW_START_MS,
  type EngineEvent,
  type PhoneRemote,
} from "../../../app/src/phone/remote/client"
import { PasskeyError, type PasskeyAdapter } from "../../../app/src/phone/remote/passkey"
import { memoryRemoteStore, type RemoteStore } from "../../../app/src/phone/remote/store"
import { createRemoteLink, type EngineEvent as DesktopEvent } from "./remote-link"
import { softPasskey } from "./remote-phone.fixture"
import { createMemoryRelay, ticketFor, type MemoryRelay } from "./remote-relay.fixture"
import { REVIEW_START_MS, type EngineRequest } from "./remote-routes"
import { fromBase64url } from "./remote-crypto"

// WP A42: Vector Remote end to end. The phone app's real client (packages/app/src/phone/remote/client.ts) pairs with
// and drives this desktop's real link (remote-link.ts, A41) through an in-memory relay that behaves as packages/relay
// does on the wire. The phone's passkey is a software authenticator that answers the way a platform passkey does; the
// desktop verifies it with packages/core/src/webauthn/verify.ts. CI's browser spec repeats pairing and approving with
// Chromium's virtual WebAuthn authenticator (packages/app/e2e/regression/remote-phone.spec.ts).

const ORIGIN = "https://remote.vectordev.ai"
const RELAY = "wss://relay.vectordev.ai/v1/connect"
const DETACHED_REVIEW = {
  id: "cr_02",
  status: "running",
  request: {
    id: "cr_02",
    to: "vectorscope",
    action: "review",
    background: true,
    requester: { kind: "user", sessionID: "ses_1" },
    directory: "/repo",
    target: { kind: "uncommitted" },
  },
}
const FINISHED_REVIEW = { ...DETACHED_REVIEW, status: "done", result: { state: "completed" } }

async function until(condition: () => boolean | Promise<boolean>, ms = 3_000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error("condition never held")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function engine() {
  const requests: EngineRequest[] = []
  const queue: (DesktopEvent | "disconnect")[] = []
  let wake: (() => void) | undefined
  const permissions: { id: string; sessionID: string; permission: string; patterns: string[] }[] = []
  // Whether connected tools are on, and the id of a `connect` question a review start raises and waits on.
  const connect: { connections: boolean; ask?: string; review?: typeof DETACHED_REVIEW } = { connections: true }
  // Paths the engine answers only after this many milliseconds.
  const slow = new Map<string, number>()
  return {
    requests,
    permissions,
    connect,
    slow,
    get queuedEvents() {
      return queue.length
    },
    push(event: DesktopEvent | "disconnect") {
      queue.push(event)
      wake?.()
    },
    api: {
      async request(request: EngineRequest) {
        requests.push(request)
        const delay = slow.get(request.path)
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
        if (request.path === "/project")
          return { status: 200, body: [{ id: "prj_1", worktree: "/repo", name: "repo", sandboxes: [] }] }
        if (request.path === "/session") return { status: 200, body: [{ id: "ses_1", title: "Fix the login" }] }
        if (request.path === "/permission") return { status: 200, body: permissions }
        if (request.path === "/session/ses_big/message") return { status: 200, body: [{ text: "y".repeat(90_000) }] }
        if (request.path === "/experimental/capabilities")
          return { status: 200, body: { connections: connect.connections } }
        if (request.path === "/experimental/connect/runs")
          return { status: 200, body: [{ id: "cr_01", status: "running" }] }
        if (request.path === "/experimental/session/ses_1/connect") {
          // As the engine's background start: it answers once the review's own question has been answered. The engine
          // sets no bound of its own on that wait; this fake gives up after 20 s, past every window the tests use.
          const ask = connect.ask
          if (ask) {
            permissions.push({ id: ask, sessionID: "ses_1", permission: "connect", patterns: ["vectorscope"] })
            await until(() => !permissions.some((item) => item.id === ask), 20_000)
          }
          return { status: 200, body: connect.review ?? { id: "cr_02", status: "running" } }
        }
        if (request.path === "/experimental/connect/runs/cr_02" && connect.review)
          return { status: 200, body: connect.review }
        if (request.path.startsWith("/experimental/connect/runs/") && request.path.endsWith("/cancel"))
          return { status: 200, body: true }
        if (request.path.startsWith("/permission/") && request.path.endsWith("/reply")) {
          const id = request.path.split("/")[2]
          const index = permissions.findIndex((item) => item.id === id)
          if (index >= 0) permissions.splice(index, 1)
          return { status: 200, body: true }
        }
        return { status: 200, body: { ok: true } }
      },
      async *events(signal: AbortSignal) {
        yield { payload: { type: "server.connected" } }
        while (!signal.aborted) {
          const next = queue.shift()
          if (next === "disconnect") return
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
  // Paths whose engine call this computer stops waiting on after this many milliseconds, at test scale.
  const windows = new Map<string, number>()
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
    engine: {
      events: fake.api.events,
      // As remote-engine.ts's fetch: once the window ends, the call rejects with its AbortSignal.timeout's reason, a
      // TimeoutError, while the engine still waits.
      request: (request) => {
        const window = windows.get(request.path)
        if (window === undefined) return fake.api.request(request)
        const signal = AbortSignal.timeout(window)
        const ended = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
        return Promise.race([fake.api.request(request), ended])
      },
    },
    origin: ORIGIN,
    computerName: () => "Studio Mac",
    relayName: () => "Mac",
    timing: { heartbeatMs: 1_000, refreshMs: 60_000, batchMs: 10, retryMs: 10 },
  })
  return { link, fake, stored, enabled, windows }
}

function phone(
  relay: MemoryRelay,
  options: { store?: RemoteStore; passkeyOrigin?: string; requestMs?: number; reviewStartMs?: number } = {},
) {
  const store = options.store ?? memoryRemoteStore()
  const key = softPasskey({ origin: options.passkeyOrigin ?? ORIGIN, rpId: "remote.vectordev.ai" })
  const alertKeys = new Map<string, Uint8Array>()
  const calls: { path: string; body?: unknown }[] = []
  let refuseGets = 0
  let gets = 0
  const passkeys: PasskeyAdapter = {
    async create({ challenge, rpId }) {
      expect(rpId).toBe("remote.vectordev.ai")
      return { id: key.id, ...(await key.create(challenge)) }
    },
    async get({ challenge, credential }) {
      expect(credential).toBe(key.id)
      gets += 1
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
    timing: {
      heartbeatMs: 1_000,
      channelMs: 300,
      requestMs: options.requestMs ?? 3_000,
      reviewStartMs: options.reviewStartMs ?? 6_000,
      retryMs: 20,
    },
  })
  return {
    remote,
    store,
    alertKeys,
    calls,
    key,
    refuseGets: (count: number) => void (refuseGets = count),
    gets: () => gets,
  }
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

async function paired(options: Parameters<typeof phone>[1] = {}) {
  const relay = createMemoryRelay()
  const desktop = computer(relay)
  const mobile = phone(relay, options)
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

  test("a paired phone lists connected runs, starts a VectorScope review with its passkey and cancels it (CW-23b)", async () => {
    const { desktop, mobile, computerID } = await paired()
    const list = {
      method: "GET",
      path: "/experimental/connect/runs",
      directory: "/repo",
      query: { sessionID: "ses_1" },
    } as const
    expect(await mobile.remote.request(computerID, list)).toEqual({
      status: 200,
      body: [{ id: "cr_01", status: "running" }],
    })

    // The computer issues a challenge for this conversation and target, the phone's passkey signs it, and the computer
    // checks the signature before the engine hears of the review.
    const target = { kind: "branch", base: "main" }
    const issued = await mobile.remote.request(computerID, {
      method: "POST",
      path: "/remote/approval",
      directory: "/repo",
      body: { review: { sessionID: "ses_1", target } },
    })
    expect(issued.status).toBe(200)
    const passkey = await mobile.key.get((issued.body as { challenge: string }).challenge)
    const start = {
      method: "POST",
      path: "/experimental/session/ses_1/connect",
      directory: "/repo",
      body: { to: "vectorscope", action: "review", target, passkey },
    } as const
    expect(await mobile.remote.request(computerID, start)).toEqual({
      status: 200,
      body: { id: "cr_02", status: "running" },
    })
    const starts = () => desktop.fake.requests.filter((request) => request.path === start.path)
    expect(starts()).toEqual([
      {
        method: "POST",
        path: start.path,
        query: { directory: "/repo" },
        body: { to: "vectorscope", target, background: true },
        timeoutMs: REVIEW_START_MS,
      },
    ])
    // The review's questions wait for a person, as a phone's turn does.
    expect(desktop.link.isPhoneTurn(["ses_1"])).toBe(true)
    // The same passkey answer starts nothing more, and a fix is refused.
    expect((await mobile.remote.request(computerID, start)).status).toBe(403)
    expect((await mobile.remote.request(computerID, { ...start, body: { ...start.body, action: "fix" } })).status).toBe(
      400,
    )
    expect(starts().length).toBe(1)

    const cancelled = await mobile.remote.request(computerID, {
      method: "POST",
      path: "/experimental/connect/runs/cr_02/cancel",
      directory: "/repo",
      query: { sessionID: "ses_1" },
    })
    expect(cancelled).toEqual({ status: 200, body: true })
    expect(desktop.fake.requests.at(-1)).toEqual({
      method: "POST",
      path: "/experimental/connect/runs/cr_02/cancel",
      query: { sessionID: "ses_1", directory: "/repo" },
      body: {},
    })

    // Connected tools turned off on the computer: the phone reaches none of them.
    desktop.fake.connect.connections = false
    const reached = desktop.fake.requests.filter((request) => request.path.includes("/connect")).length
    const off = await mobile.remote.request(computerID, list)
    expect(off.status).toBe(403)
    expect((off.body as { error: { code: string } }).error.code).toBe("REMOTE_CONNECT_OFF")
    expect(desktop.fake.requests.filter((request) => request.path.includes("/connect")).length).toBe(reached)
    desktop.link.stop()
    mobile.remote.disconnect()
  })

  test("a review start waits on its own question, which the phone allows once with its passkey (CW-23b)", async () => {
    const { desktop, mobile, computerID } = await paired()
    desktop.fake.connect.ask = "per_c"
    const target = { kind: "uncommitted" }
    const issued = await mobile.remote.request(computerID, {
      method: "POST",
      path: "/remote/approval",
      directory: "/repo",
      body: { review: { sessionID: "ses_1", target } },
    })
    const passkey = await mobile.key.get((issued.body as { challenge: string }).challenge)
    const started = mobile.remote.request(computerID, {
      method: "POST",
      path: "/experimental/session/ses_1/connect",
      directory: "/repo",
      body: { to: "vectorscope", action: "review", target, passkey },
    })
    await until(() => desktop.fake.permissions.some((item) => item.id === "per_c"))
    // While the start waits on the review's question, the conversation is held, so the app's auto-accept leaves the
    // question to a person.
    expect(desktop.link.isPhoneTurn(["ses_1"])).toBe(true)
    const allowed = await mobile.remote.approve(computerID, "/repo", "per_c")
    expect(allowed).toMatchObject({ kind: "answered", answer: { status: 200 } })
    expect(desktop.fake.requests.find((request) => request.path === "/permission/per_c/reply")!.body).toEqual({
      reply: "once",
    })
    expect(await started).toEqual({ status: 200, body: { id: "cr_02", status: "running" } })
    expect(desktop.link.isPhoneTurn(["ses_1"])).toBe(true)
    desktop.link.stop()
    mobile.remote.disconnect()
  })

  test("the phone's review start asks for its passkey, then waits on its own question, which the phone allows once (CW-23c)", async () => {
    const { desktop, mobile, computerID } = await paired()
    desktop.fake.connect.ask = "per_c"
    const started = mobile.remote.startReview(computerID, "/repo", "ses_1", { kind: "branch", base: "main" })
    await until(() => desktop.fake.permissions.some((item) => item.id === "per_c"))
    // While the start waits, the phone answers the review's own question with a second passkey.
    expect(await mobile.remote.approve(computerID, "/repo", "per_c")).toMatchObject({
      kind: "answered",
      answer: { status: 200 },
    })
    expect(await started).toEqual({
      kind: "answered",
      answer: { status: 200, body: { id: "cr_02", status: "running" } },
    })
    expect(desktop.fake.requests.filter((request) => request.path === "/experimental/session/ses_1/connect")).toEqual([
      {
        method: "POST",
        path: "/experimental/session/ses_1/connect",
        query: { directory: "/repo" },
        body: { to: "vectorscope", target: { kind: "branch", base: "main" }, background: true },
        timeoutMs: REVIEW_START_MS,
      },
    ])
    expect(mobile.gets()).toBe(2)
    desktop.link.stop()
    mobile.remote.disconnect()
  })

  test.each(["completion", "cancellation", "reconnect"])(
    "a detached phone review keeps only its own asks held until %s (CW-23c)",
    async (ending) => {
      const { desktop, mobile, computerID } = await paired()
      const scope = { runID: "cr_02", sessionID: "ses_1", directory: "/repo" }
      // This takes the same optional ask identity the Desktop renderer sends for a Connect permission.
      const held = (review = scope, sessionID = "ses_1") => desktop.link.isPhoneTurn([sessionID], review)
      const finished = (directory: string, sessionID: string, run = FINISHED_REVIEW) =>
        desktop.fake.push({ directory, payload: { type: "connect.run.updated", properties: { sessionID, run } } })
      try {
        desktop.fake.connect.review = DETACHED_REVIEW
        expect(await mobile.remote.startReview(computerID, "/repo", "ses_1", { kind: "uncommitted" })).toMatchObject({
          kind: "answered",
          answer: { status: 200, body: DETACHED_REVIEW },
        })
        // The response can follow an idle event that the source did not see. Ordinary asks must still be free.
        expect(desktop.link.isPhoneTurn(["ses_1"])).toBe(false)
        desktop.fake.push({ directory: "/repo", payload: { type: "session.idle", properties: { sessionID: "ses_1" } } })
        await until(() => desktop.fake.queuedEvents === 0)
        expect(held()).toBe(true)
        expect(held({ ...scope, directory: "/elsewhere" })).toBe(false)
        expect(held({ ...scope, runID: "cr_different" })).toBe(false)
        expect(held({ ...scope, sessionID: "ses_other" }, "ses_other")).toBe(false)

        finished("/elsewhere", "ses_1")
        finished("/repo", "ses_other")
        finished("/repo", "ses_1", { ...FINISHED_REVIEW, id: "cr_other" })
        // Wait for a later event to cross the same stream before checking that the malformed updates changed nothing.
        desktop.fake.push({
          directory: "/repo",
          payload: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
        })
        await until(() => desktop.fake.queuedEvents === 0)
        expect(held()).toBe(true)

        if (ending === "cancellation") {
          expect(
            await mobile.remote.request(computerID, {
              method: "POST",
              path: "/experimental/connect/runs/cr_02/cancel",
              directory: "/repo",
              query: { sessionID: "ses_1" },
            }),
          ).toEqual({ status: 200, body: true })
        } else if (ending === "reconnect") {
          desktop.fake.connect.review = FINISHED_REVIEW
          desktop.fake.push("disconnect")
        } else {
          mobile.remote.disconnect()
          finished("/repo", "ses_1")
        }
        await until(() => !held())
      } finally {
        desktop.link.stop()
        mobile.remote.disconnect()
      }
    },
  )

  test("a review start held for a fresh tap starts on that tap; one the computer refuses asks for no passkey (CW-23c)", async () => {
    const { desktop, mobile, computerID } = await paired()
    const starts = () =>
      desktop.fake.requests.filter((request) => request.path === "/experimental/session/ses_1/connect")
    mobile.refuseGets(1)
    const first = await mobile.remote.startReview(computerID, "/repo", "ses_1", { kind: "uncommitted" })
    expect(first.kind).toBe("tap")
    expect(starts()).toEqual([])
    const second = await (first as { confirm: () => Promise<unknown> }).confirm()
    expect(second).toMatchObject({ kind: "answered", answer: { status: 200 } })
    expect(starts()).toHaveLength(1)

    desktop.fake.connect.connections = false
    const gets = mobile.gets()
    const off = await mobile.remote.startReview(computerID, "/repo", "ses_1", { kind: "staged" })
    expect(off).toMatchObject({
      kind: "answered",
      answer: { status: 403, body: { error: { code: "REMOTE_CONNECT_OFF" } } },
    })
    expect(mobile.gets()).toBe(gets)
    expect(starts()).toHaveLength(1)
    desktop.link.stop()
    mobile.remote.disconnect()
  })

  test("a review start may wait past the plain request window, which every other request keeps (CW-23b)", async () => {
    // The phone gives up on a start only after the computer would have.
    expect(PHONE_REVIEW_START_MS).toBeGreaterThan(REVIEW_START_MS)
    // The plain window is long enough for pairing and the challenge on a loaded runner; the start's is longer.
    const { desktop, mobile, computerID } = await paired({ requestMs: 1_500, reviewStartMs: 10_000 })
    desktop.fake.connect.ask = "per_slow"
    const started = mobile.remote.startReview(computerID, "/repo", "ses_1", { kind: "uncommitted" })
    await until(() => desktop.fake.permissions.some((item) => item.id === "per_slow"))
    // The person answers the review's question only after the plain window has passed; the start still waits.
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    expect(await mobile.remote.approve(computerID, "/repo", "per_slow")).toMatchObject({
      kind: "answered",
      answer: { status: 200 },
    })
    expect(await started).toEqual({
      kind: "answered",
      answer: { status: 200, body: { id: "cr_02", status: "running" } },
    })
    // The computer gave the start, and only the start, its own window.
    expect(desktop.fake.requests.filter((request) => request.timeoutMs !== undefined)).toEqual([
      {
        method: "POST",
        path: "/experimental/session/ses_1/connect",
        query: { directory: "/repo" },
        body: { to: "vectorscope", target: { kind: "uncommitted" }, background: true },
        timeoutMs: REVIEW_START_MS,
      },
    ])
    // Any other request still ends at the plain window.
    desktop.fake.slow.set("/experimental/connect/runs", 2_000)
    await expect(
      mobile.remote.request(computerID, {
        method: "GET",
        path: "/experimental/connect/runs",
        directory: "/repo",
        query: { sessionID: "ses_1" },
      }),
    ).rejects.toMatchObject({ code: "REMOTE_TIMEOUT" })
    desktop.link.stop()
    mobile.remote.disconnect()
  })

  test("a review start whose question is not answered in time says so, and the conversation stays held (CW-23c)", async () => {
    // Long enough for pairing and the challenge on a loaded runner; the start alone waits until the ask is answered.
    const { desktop, mobile, computerID } = await paired({ requestMs: 1_500, reviewStartMs: 2_500 })
    desktop.fake.connect.ask = "per_late"
    const started = mobile.remote.startReview(computerID, "/repo", "ses_1", { kind: "uncommitted" })
    await expect(started).rejects.toMatchObject({
      code: "REMOTE_REVIEW_TIMEOUT",
      message: expect.stringContaining("did not answer within 3 minutes"),
    })
    // Fail-closed: the review's question still waits for a person, and the conversation is still held.
    expect(desktop.fake.permissions.map((item) => item.id)).toEqual(["per_late"])
    expect(desktop.link.isPhoneTurn(["ses_1"])).toBe(true)
    // Answered at the computer afterwards, so the fake engine's start returns.
    desktop.fake.permissions.splice(0)
    desktop.link.stop()
    mobile.remote.disconnect()
  })

  test("a review start the computer stops waiting on shows the same 3-minute message, before the phone's own window ends (CW-23b)", async () => {
    // As a real start, the computer's window (REVIEW_START_MS) ends well before the phone's; here at test scale.
    const { desktop, mobile, computerID } = await paired({ requestMs: 1_500, reviewStartMs: 10_000 })
    desktop.fake.connect.ask = "per_wait"
    desktop.windows.set("/experimental/session/ses_1/connect", 500)
    const began = Date.now()
    const started = mobile.remote.startReview(computerID, "/repo", "ses_1", { kind: "uncommitted" })
    // What the phone's review card shows (session-tasks.tsx `errorText`), as for its own timeout.
    await expect(started).rejects.toMatchObject({
      code: "REMOTE_REVIEW_TIMEOUT",
      message:
        "Your computer did not answer within 3 minutes. A review still waiting for an approval stops then; answer its approval right away.",
    })
    // The computer's answer, not the phone's own timer.
    expect(Date.now() - began).toBeLessThan(10_000)
    // Fail-closed: the review's question still waits for a person, and the conversation is still held.
    expect(desktop.fake.permissions.map((item) => item.id)).toEqual(["per_wait"])
    expect(desktop.link.isPhoneTurn(["ses_1"])).toBe(true)
    // Answered at the computer afterwards, so the fake engine's start returns.
    desktop.fake.permissions.splice(0)
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
