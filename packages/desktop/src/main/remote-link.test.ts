import { describe, expect, test } from "bun:test"
import { CLOSE, FRAME, decodeFrame, encodeFrame } from "@vectordevai/relay/protocol"
import { deviceBytes, ENVELOPE, fromBase64url, toBase64url, type Channel } from "./remote-crypto"
import { createRemoteLink, type EngineEvent, type RemoteSocket } from "./remote-link"
import { PHONE_APP_ADDRESS } from "../../../app/src/components/settings-v2/notifications-model"
import {
  computerName,
  decodeIdentity,
  PHONE_APP_ORIGIN,
  phoneAppOrigin,
  relayName,
  type RemoteIdentity,
} from "./remote-pairing"
import { fakePhone, type FakePhone } from "./remote-phone.fixture"
import type { EngineRequest } from "./remote-routes"

const ORIGIN = "https://remote.vectordev.ai"
const RELAY = "wss://relay.example.test/v1/connect"

class FakeSocket implements RemoteSocket {
  readyState = 0
  binaryType = "blob"
  sent: (string | Uint8Array)[] = []
  closedWith?: number
  onopen: RemoteSocket["onopen"] = null
  onmessage: RemoteSocket["onmessage"] = null
  onclose: RemoteSocket["onclose"] = null
  onerror: RemoteSocket["onerror"] = null
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string | Uint8Array) {
    this.sent.push(typeof data === "string" ? data : new Uint8Array(data))
  }
  close(code?: number) {
    this.readyState = 3
    this.closedWith = code
  }
  open(device: string, viewers = 0, peers: { device: string; role: "phone" | "computer" }[] = []) {
    this.readyState = 1
    this.onopen?.({})
    this.server({ t: "hello", v: 1, role: "computer", device, exp: 0, peers, viewers })
  }
  server(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  frame(from: string, envelope: Uint8Array) {
    this.onmessage?.({ data: encodeFrame(FRAME.DATA, deviceBytes(from), envelope).buffer })
  }
  drop(code: number) {
    this.readyState = 3
    this.onclose?.({ code })
  }
  frames() {
    return this.sent.flatMap((data) => {
      if (typeof data === "string") return []
      const frame = decodeFrame(data)
      return frame ? [{ to: toBase64url(frame.device), envelope: frame.ciphertext.slice() }] : []
    })
  }
  texts() {
    return this.sent.filter((data): data is string => typeof data === "string")
  }
}

async function until(condition: () => boolean | Promise<boolean>, ms = 3_000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error("condition never held")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function engine() {
  const requests: EngineRequest[] = []
  const queue: EngineEvent[] = []
  const streams: AbortSignal[] = []
  let wake: (() => void) | undefined
  return {
    requests,
    streams,
    push(event: EngineEvent) {
      queue.push(event)
      wake?.()
    },
    open: () => streams.filter((signal) => !signal.aborted).length,
    api: {
      async request(request: EngineRequest) {
        requests.push(request)
        if (request.path === "/project")
          return { status: 200, body: [{ id: "prj_1", worktree: "/repo", sandboxes: [] }] }
        if (request.path === "/session/ses_big/message") return { status: 200, body: [{ text: "y".repeat(100_000) }] }
        return { status: 200, body: [{ id: "ses_1", title: "Fix the login" }] }
      },
      async *events(signal: AbortSignal) {
        streams.push(signal)
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

function setup(options: { ticket?: (count: number) => Response; allowed?: boolean } = {}) {
  const sockets: FakeSocket[] = []
  const apiCalls: { url: string; body: Record<string, unknown>; authorization?: string }[] = []
  const stored: { value?: RemoteIdentity } = {}
  const enabled = { value: false }
  const fake = engine()
  const watching: boolean[] = []
  let tickets = 0
  const link = createRemoteLink({
    store: {
      read: async () => stored.value,
      write: async (identity) => void (stored.value = JSON.parse(JSON.stringify(identity))),
    },
    enabled: { get: () => enabled.value, set: (value) => void (enabled.value = value) },
    token: async () => "vct_desktop",
    api: async (url, init) => {
      const body = JSON.parse(String(init.body ?? "{}"))
      apiCalls.push({ url, body, authorization: (init.headers as Record<string, string>).authorization })
      if (url.endsWith("/ticket")) {
        tickets += 1
        if (options.ticket) return options.ticket(tickets)
        return Response.json({
          ticket: `vt1.ticket-${tickets}`,
          url: RELAY,
          protocol: "vector.v1",
          expiresAt: Date.now() + 300_000,
        })
      }
      return Response.json({ ok: true })
    },
    allowed: () => options.allowed ?? true,
    socket: (url, protocols) => {
      const socket = new FakeSocket(url, protocols)
      sockets.push(socket)
      return socket
    },
    engine: fake.api,
    origin: ORIGIN,
    computerName: () => "Studio Mac",
    relayName: () => "Mac",
    watchingChanged: () => watching.push(link.watching()),
    timing: { heartbeatMs: 30, refreshMs: 60_000, batchMs: 20, retryMs: 10 },
  })
  const socket = () => sockets.at(-1)!
  return { link, sockets, socket, apiCalls, stored, enabled, fake, watching, tickets: () => tickets }
}

/** Pairs `phone` through the link and the fake relay; returns the code both showed. */
async function pair(env: ReturnType<typeof setup>, phone: FakePhone) {
  const offer = await env.link.startPairing()
  await until(() => env.sockets.length > 0)
  const identity = env.stored.value!
  env.socket().open(identity.device)
  env.socket().server({ t: "peers", peers: [{ device: phone.device, role: "phone" }], viewers: 1, refresh: true })
  await until(() => env.link.status().viewers === 1)
  env.socket().frame(phone.device, await phone.pairRequest(offer.link))
  await until(() =>
    env
      .socket()
      .frames()
      .some((frame) => frame.to === phone.device),
  )
  const pending = await phone.readPending(env.socket().frames().at(-1)!.envelope)
  const status = env.link.status()
  return { offer, pending, status, identity }
}

async function connect(env: ReturnType<typeof setup>, phone: FakePhone) {
  const identity = env.stored.value!
  const before = env.socket().frames().length
  env.socket().frame(phone.device, await phone.init({ device: identity.device, key: identity.publicKey }))
  await until(() => env.socket().frames().length > before)
  const channel = await phone.finish(env.socket().frames().at(-1)!.envelope)
  const inbox: unknown[] = []
  let seen = env.socket().frames().length
  const read = async () => {
    const frames = env.socket().frames()
    for (const frame of frames.slice(seen))
      if (frame.to === phone.device) inbox.push(await channel.open(frame.envelope))
    seen = frames.length
    return inbox
  }
  const send = async (message: unknown) => env.socket().frame(phone.device, await channel.seal(message))
  await send({ t: "hello", protocol: 1, minPeer: 1 })
  await until(async () => (await read()).some((item) => (item as { t?: string }).t === "hello"))
  return { channel, inbox, read, send }
}

describe("connection", () => {
  test("stays off until Remote is on and a phone is paired or pairing", async () => {
    const env = setup()
    await env.link.start()
    expect(env.link.status().state).toBe("off")
    await env.link.setEnabled(true)
    expect(env.link.status().state).toBe("ready")
    expect(env.sockets).toEqual([])
    expect(env.stored.value?.device).toBeDefined()
    env.link.stop()
  })

  test("asks vectordev.ai for a computer ticket and offers it to the relay beside vector.v1", async () => {
    const env = setup()
    await env.link.startPairing()
    await until(() => env.sockets.length === 1)
    const ticket = env.apiCalls[0]!
    expect(ticket.url).toBe("https://vectordev.ai/api/remote/ticket")
    expect(ticket.authorization).toBe("Bearer vct_desktop")
    expect(ticket.body).toEqual({
      role: "computer",
      device: env.stored.value!.device,
      key: env.stored.value!.publicKey,
      name: "Mac",
    })
    expect(env.socket().url).toBe(RELAY)
    expect(env.socket().protocols).toEqual(["vector.v1", "vt1.ticket-1"])
    env.socket().open(env.stored.value!.device)
    await until(() => env.link.status().state === "online")
    await until(() => env.socket().texts().includes("ping"))
    // A phone arriving asks for a fresh ticket, sent in-band.
    env
      .socket()
      .server({ t: "peers", peers: [{ device: "AAAAAAAAAAAAAAAAAAAAAA", role: "phone" }], viewers: 1, refresh: true })
    await until(() =>
      env
        .socket()
        .texts()
        .some((text) => text.includes('"refresh"')),
    )
    expect(
      JSON.parse(
        env
          .socket()
          .texts()
          .find((text) => text.includes('"refresh"'))!,
      ),
    ).toEqual({
      t: "refresh",
      ticket: "vt1.ticket-2",
    })
    env.link.stop()
  })

  test("a plan without Remote, Vector Local and an odd relay address leave no connection", async () => {
    const refused = setup({
      ticket: () =>
        Response.json(
          { error: { code: "CODIUM_PERK_REQUIRED", message: "Remote is not in your plan." } },
          { status: 403 },
        ),
    })
    await refused.link.startPairing()
    await until(() => refused.link.status().state === "not-in-plan")
    expect(refused.link.status().message).toBe("Remote is not in your plan.")
    expect(refused.sockets).toEqual([])
    refused.link.stop()

    const local = setup({ allowed: false })
    await local.link.startPairing()
    await until(() => local.link.status().state === "local-off")
    expect(local.sockets).toEqual([])
    local.link.stop()

    for (const url of [
      "ws://relay.example.test/v1/connect",
      "wss://relay.example.test/elsewhere",
      "https://relay.example.test/v1/connect",
    ]) {
      const odd = setup({ ticket: () => Response.json({ ticket: "vt1.x", url, protocol: "vector.v1", expiresAt: 0 }) })
      await odd.link.startPairing()
      await until(() => odd.link.status().state === "unavailable")
      expect(odd.sockets).toEqual([])
      odd.link.stop()
    }
  })

  test("asks for one new ticket after a refusal for revocation, then stops", async () => {
    const env = setup()
    await env.link.startPairing()
    await until(() => env.sockets.length === 1)
    env.socket().drop(CLOSE.REMOTE_REVOKED)
    await until(() => env.sockets.length === 2)
    expect(env.tickets()).toBe(2)
    env.socket().drop(CLOSE.REMOTE_REVOKED)
    await until(() => env.link.status().state === "revoked")
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(env.sockets.length).toBe(2)
    env.link.stop()
  })

  test("reports a paused plan, the device limit and fair use from the relay's close codes", async () => {
    for (const [code, state] of [
      [CLOSE.REMOTE_PAUSED, "paused"],
      [CLOSE.REMOTE_DEVICE_LIMIT, "device-limit"],
      [CLOSE.REMOTE_FAIR_USE, "fair-use"],
      [CLOSE.RELAY_OFF, "unavailable"],
    ] as const) {
      const env = setup()
      await env.link.startPairing()
      await until(() => env.sockets.length === 1)
      env.socket().drop(code)
      await until(() => env.link.status().state === state)
      env.link.stop()
    }
  })
})

describe("pairing", () => {
  test("pairs a phone: transcript proofs, the same six digits on both screens, then the alert key", async () => {
    const env = setup()
    const phone = await fakePhone({ origin: ORIGIN, name: "Pixel" })
    const { offer, pending, status, identity } = await pair(env, phone)
    expect(offer.link.startsWith(`${ORIGIN}/phone/pair#`)).toBe(true)
    expect(pending.code).toMatch(/^\d{6}$/)
    expect(status.pairing).toEqual({
      state: "confirm",
      code: pending.code!,
      phone: "Pixel",
      expiresAt: offer.expiresAt,
    })
    // Nothing is stored before the person confirms.
    expect(env.stored.value!.phones).toEqual([])
    await expect(env.link.confirmPairing("000000" === pending.code ? "111111" : "000000")).rejects.toThrow()
    await env.link.confirmPairing(pending.code)
    await until(() => env.socket().frames().at(-1)?.envelope[0] === ENVELOPE.PAIR_DONE)
    const done = await phone.readDone(env.socket().frames().at(-1)!.envelope)
    expect(done.t).toBe("pair-done")
    expect(done.alertKey).toBe(identity.alertKey)
    expect(done.alertKeyId).toBe(identity.alertKeyId)
    expect(env.stored.value!.phones.map((item) => item.name)).toEqual(["Pixel"])
    expect(env.stored.value!.phones[0]!.key).toBe(toBase64url(phone.identity.publicKey))
    expect(env.link.status().pairing).toEqual({ state: "paired", phone: "Pixel" })
    expect(env.link.alertKey()).toEqual({ key: identity.alertKey, id: identity.alertKeyId })
    // The stored identity decodes again after a restart.
    expect(decodeIdentity(env.stored.value)?.phones.length).toBe(1)
    env.link.stop()
  })

  test("refuses a passkey made on another origin, and a request without the QR's secret", async () => {
    const env = setup()
    const phone = await fakePhone({ origin: ORIGIN, passkeyOrigin: "https://remote.vectordev.ai.evil.example" })
    const { pending } = await pair(env, phone)
    expect(pending.code).toBeUndefined()
    expect((pending.message as { t: string }).t).toBe("pair-refused")
    expect(env.link.status().pairing.state).toBe("waiting")

    const forger = await fakePhone({ origin: ORIGIN })
    env.socket().server({ t: "peers", peers: [{ device: forger.device, role: "phone" }], viewers: 1 })
    const before = env.socket().frames().length
    env
      .socket()
      .frame(
        forger.device,
        await forger.pairRequest(((await env.link.status().pairing) as { link: string }).link, { proof: "wrong" }),
      )
    await until(() => env.socket().frames().length > before)
    expect(((await forger.readPending(env.socket().frames().at(-1)!.envelope)).message as { t: string }).t).toBe(
      "pair-refused",
    )
    expect(env.stored.value!.phones).toEqual([])
    env.link.stop()
  })

  test("stops when a second phone answers the same QR", async () => {
    const env = setup()
    const first = await fakePhone({ origin: ORIGIN })
    const { offer } = await pair(env, first)
    const second = await fakePhone({ origin: ORIGIN })
    env.socket().server({
      t: "peers",
      peers: [
        { device: first.device, role: "phone" },
        { device: second.device, role: "phone" },
      ],
      viewers: 2,
    })
    env.socket().frame(second.device, await second.pairRequest(offer.link))
    await until(() => env.link.status().pairing.state === "failed")
    await expect(env.link.confirmPairing()).rejects.toThrow()
    expect(env.stored.value!.phones).toEqual([])
    env.link.stop()
  })
})

describe("paired phones", () => {
  async function paired() {
    const env = setup()
    const phone = await fakePhone({ origin: ORIGIN })
    const { pending } = await pair(env, phone)
    await env.link.confirmPairing(pending.code)
    return { env, phone, ...(await connect(env, phone)) }
  }

  test("only a paired phone gets an answer to its connection request", async () => {
    const { env } = await paired()
    const stranger = await fakePhone({ origin: ORIGIN })
    const identity = env.stored.value!
    const before = env.socket().frames().length
    env.socket().frame(stranger.device, await stranger.init({ device: identity.device, key: identity.publicKey }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(env.socket().frames().length).toBe(before)
    env.link.stop()
  })

  test("answers requests through the allowlist, in parts when large", async () => {
    const { env, send, read, inbox } = await paired()
    await send({ t: "req", id: 1, method: "GET", path: "/session", directory: "/repo" })
    await until(async () => (await read()).some((item) => (item as { id?: number }).id === 1))
    expect(inbox.find((item) => (item as { id?: number }).id === 1)).toEqual({
      t: "res",
      id: 1,
      status: 200,
      body: [{ id: "ses_1", title: "Fix the login" }],
    })
    await send({ t: "req", id: 2, method: "GET", path: "/config", directory: "/repo" })
    await until(async () => (await read()).some((item) => (item as { id?: number }).id === 2))
    expect((inbox.find((item) => (item as { id?: number }).id === 2) as { status: number }).status).toBe(403)
    await send({ t: "req", id: 3, method: "GET", path: "/session/ses_big/message", directory: "/repo" })
    await until(async () => (await read()).filter((item) => (item as { id?: number }).id === 3).length === 3)
    const parts = inbox.filter((item) => (item as { id?: number }).id === 3) as {
      part: number
      parts: number
      data: string
    }[]
    expect(parts.map((part) => [part.part, part.parts])).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ])
    const joined = new TextDecoder().decode(new Uint8Array(parts.flatMap((part) => [...fromBase64url(part.data)])))
    expect(JSON.parse(joined)).toEqual([{ text: "y".repeat(100_000) }])
    // The relay saw only sealed bytes: no answer, path or folder in any frame, and only pings and refreshes as text.
    const wire = new TextDecoder("latin1").decode(
      new Uint8Array(env.socket().sent.flatMap((data) => (typeof data === "string" ? [] : [...data]))),
    )
    for (const plain of ["Fix the login", "ses_1", "/repo", "yyyyyyyy", "/session"]) expect(wire).not.toContain(plain)
    expect(
      env
        .socket()
        .texts()
        .every((text) => text === "ping" || JSON.parse(text).t === "refresh"),
    ).toBe(true)
    env.link.stop()
  })

  test("sends each watching phone at most one batch per interval", async () => {
    const env = setup()
    const phone = await fakePhone({ origin: ORIGIN })
    const { pending } = await pair(env, phone)
    await env.link.confirmPairing(pending.code)
    const { send, read, inbox } = await connect(env, phone)
    await send({ t: "watch" })
    await until(() => env.fake.open() === 1)
    const started = Date.now()
    // A busy stream: an event every few milliseconds for half a second.
    while (Date.now() - started < 500) {
      env.fake.push({
        directory: "/repo",
        payload: { type: "message.part.delta", properties: { sessionID: "ses_1", delta: "x" } },
      })
      await new Promise((resolve) => setTimeout(resolve, 3))
    }
    await new Promise((resolve) => setTimeout(resolve, 60))
    await read()
    const batches = inbox.filter((item) => (item as { t?: string }).t === "events").length
    const events = inbox
      .filter((item) => (item as { t?: string }).t === "events")
      .flatMap((item) => (item as { events: unknown[] }).events).length
    // timing.batchMs is 20 here (250 in the app: four a second).
    expect(batches).toBeGreaterThan(0)
    expect(batches).toBeLessThanOrEqual(Math.ceil((Date.now() - started) / 20) + 1)
    expect(events).toBeGreaterThan(batches)
    env.link.stop()
  })

  test("streams the engine's events only while the phone watches, batched", async () => {
    const { env, send, read, inbox } = await paired()
    expect(env.fake.open()).toBe(0)
    await send({ t: "watch" })
    await until(() => env.fake.open() === 1)
    expect(env.link.watching()).toBe(true)
    expect(env.watching).toContain(true)
    for (let index = 0; index < 30; index++)
      env.fake.push({
        directory: "/repo",
        payload: { type: "message.part.delta", properties: { sessionID: "ses_1", delta: `${index}` } },
      })
    // Events of other folders and of other kinds stay on this computer.
    env.fake.push({ directory: "/elsewhere", payload: { type: "session.status", properties: { sessionID: "x" } } })
    env.fake.push({ directory: "/repo", payload: { type: "pty.created", properties: {} } })
    await until(
      async () =>
        (await read())
          .filter((item) => (item as { t?: string }).t === "events")
          .flatMap((item) => (item as { events: unknown[] }).events).length === 30,
    )
    const batches = inbox.filter((item) => (item as { t?: string }).t === "events")
    expect(batches.length).toBeLessThan(30)
    expect(JSON.stringify(batches)).not.toContain("/elsewhere")
    expect(JSON.stringify(batches)).not.toContain("pty.created")
    await send({ t: "unwatch" })
    await until(() => env.fake.open() === 0)
    expect(env.link.watching()).toBe(false)
    expect(env.watching.at(-1)).toBe(false)
    env.link.stop()
  })

  test("marks a turn the phone started until its session is idle, reading events meanwhile", async () => {
    const { env, send, read } = await paired()
    expect(env.link.isPhoneTurn(["ses_1"])).toBe(false)
    await send({
      t: "req",
      id: 9,
      method: "POST",
      path: "/session/ses_1/prompt_async",
      directory: "/repo",
      body: { parts: [{ type: "text", text: "Run the tests" }], tools: { bash: true } },
    })
    await until(async () => (await read()).some((item) => (item as { id?: number }).id === 9))
    expect(env.link.isPhoneTurn(["ses_child", "ses_1"])).toBe(true)
    expect(env.link.isPhoneTurn("ses_1")).toBe(false)
    expect(env.fake.requests.at(-1)?.body).toEqual({ parts: [{ type: "text", text: "Run the tests" }] })
    await until(() => env.fake.open() === 1)
    env.fake.push({
      directory: "/repo",
      payload: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } },
    })
    await until(() => !env.link.isPhoneTurn(["ses_1"]))
    await until(() => env.fake.open() === 0)
    env.link.stop()
  })

  test("sends no data frame while no phone is attached", async () => {
    const { env, send } = await paired()
    env.socket().server({ t: "peers", peers: [], viewers: 0 })
    await until(() => env.link.status().viewers === 0)
    const before = env.socket().frames().length
    await send({ t: "req", id: 4, method: "GET", path: "/session", directory: "/repo" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(env.socket().frames().length).toBe(before)
    env.link.stop()
  })

  test("Disconnect all phones makes a new identity, closes every connection and frees the old device", async () => {
    const { env, phone } = await paired()
    const old = env.stored.value!
    const socket = env.socket()
    const result = await env.link.disconnectAll()
    expect(result.killed).toBe(true)
    expect(socket.closedWith).toBe(1000)
    const next = env.stored.value!
    expect(next.device).not.toBe(old.device)
    expect(next.publicKey).not.toBe(old.publicKey)
    expect(next.alertKey).not.toBe(old.alertKey)
    expect(next.phones).toEqual([])
    expect(env.apiCalls.map((call) => call.url).slice(-2)).toEqual([
      "https://vectordev.ai/api/remote/kill",
      `https://vectordev.ai/api/remote/devices/${old.device}/revoke`,
    ])
    // With no phone paired there is nothing to connect for, and the old phone's keys open nothing here.
    expect(env.link.status().state).toBe("ready")
    expect(env.link.alertKey()).toBeUndefined()
    await env.link.startPairing()
    await until(() => env.sockets.length === 2)
    env.socket().open(next.device, 1, [{ device: phone.device, role: "phone" }])
    const before = env.socket().frames().length
    env.socket().frame(phone.device, await phone.init({ device: old.device, key: old.publicKey }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(env.socket().frames().length).toBe(before)
    env.link.stop()
  })

  test("unpairing one phone stops its connection here", async () => {
    const { env, phone, send } = await paired()
    await env.link.unpair(phone.device)
    expect(env.stored.value!.phones).toEqual([])
    expect(env.link.status().phones).toEqual([])
    const before = env.socket().frames().length
    await send({ t: "req", id: 5, method: "GET", path: "/session", directory: "/repo" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(env.socket().frames().length).toBe(before)
    env.link.stop()
  })

  test("a phone too old for this desktop is told to update", async () => {
    const env = setup()
    const phone = await fakePhone({ origin: ORIGIN })
    const { pending } = await pair(env, phone)
    await env.link.confirmPairing(pending.code)
    const identity = env.stored.value!
    const before = env.socket().frames().length
    env.socket().frame(phone.device, await phone.init({ device: identity.device, key: identity.publicKey }))
    await until(() => env.socket().frames().length > before)
    const channel: Channel = await phone.finish(env.socket().frames().at(-1)!.envelope)
    env.socket().frame(phone.device, await channel.seal({ t: "hello", protocol: 0, minPeer: 0 }))
    await until(() => env.socket().frames().length > before + 1)
    expect(await channel.open(env.socket().frames().at(-1)!.envelope)).toEqual({ t: "update", side: "phone" })
    env.link.stop()
  })
})

describe("this computer's names and the phone app's origin", () => {
  test("a packaged app uses Vector's phone origin, whatever the environment says", () => {
    expect(PHONE_APP_ORIGIN).toBe(`https://${PHONE_APP_ADDRESS}`)
    expect(phoneAppOrigin(true, { VECTOR_PHONE_APP_ORIGIN: "https://evil.example" })).toBe(PHONE_APP_ORIGIN)
    expect(phoneAppOrigin(false, {})).toBe(PHONE_APP_ORIGIN)
    expect(phoneAppOrigin(false, { VECTOR_PHONE_APP_ORIGIN: "http://localhost:5173" })).toBe("http://localhost:5173")
    expect(phoneAppOrigin(false, { VECTOR_PHONE_APP_ORIGIN: "https://phone.dev.example" })).toBe(
      "https://phone.dev.example",
    )
    for (const value of [
      "http://phone.dev.example",
      "https://phone.dev.example/",
      "https://phone.dev.example/phone",
      "nonsense",
    ])
      expect(phoneAppOrigin(false, { VECTOR_PHONE_APP_ORIGIN: value })).toBe(PHONE_APP_ORIGIN)
  })

  test("the relay lists a kind of computer; only phones see its own name", () => {
    expect(relayName("darwin")).toBe("Mac")
    expect(relayName("win32")).toBe("Windows PC")
    expect(relayName("linux")).toBe("Linux computer")
    expect(computerName("Studio-Mac.local", "darwin")).toBe("Studio-Mac")
    expect(computerName("", "linux")).toBe("Linux computer")
    expect(computerName("x".repeat(100), "darwin").length).toBe(64)
  })
})
