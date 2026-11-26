import { describe, expect, jest, test } from "bun:test"
import { RELAY_LIMITS } from "@vectordevai/relay/limits"
import { CLOSE, DEVICE_BYTES, FRAME, decodeFrame, encodeFrame } from "@vectordevai/relay/protocol"
import { deviceBytes, ENVELOPE, fromBase64url, toBase64url, type Channel } from "./remote-crypto"
import { createRemoteLink, type EngineEvent, type LinkDependencies, type RemoteSocket } from "./remote-link"
import { PHONE_APP_ADDRESS } from "../../../app/src/components/settings-v2/notifications-model"
import { computerName, PHONE_APP_ORIGIN, phoneAppOrigin, relayName } from "./remote-host"
import { decodeIdentity, type RemoteIdentity } from "./remote-pairing"
import { fakePhone, type FakePhone } from "./remote-phone.fixture"
import { createMemoryRelay, ticketFor, type MemoryRelay } from "./remote-relay.fixture"
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

function setup(
  options: {
    ticket?: (count: number) => Response
    allowed?: boolean
    jobs?: LinkDependencies["jobs"]
    log?: LinkDependencies["log"]
    timing?: LinkDependencies["timing"]
  } = {},
) {
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
    jobs: options.jobs,
    log: options.log,
    timing: options.timing ?? { heartbeatMs: 30, refreshMs: 60_000, batchMs: 20, retryMs: 10 },
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

describe("jobs (R-C2)", () => {
  const OFFER = `vef1.${"A".repeat(40)}.${"B".repeat(86)}`
  const ascii = (text: string) => new TextEncoder().encode(text)
  const offerFrame = (body: Uint8Array, device = new Uint8Array(DEVICE_BYTES), kind: number = FRAME.JOB_OFFER) =>
    encodeFrame(kind, device, body)

  /** Microtask turns only, so no timer fires meanwhile: a check that needs a timer's turn fails here. */
  async function turns(condition: () => boolean, count = 1_000) {
    for (let turn = 0; turn < count && !condition(); turn++) await Promise.resolve()
    if (!condition()) throw new Error("condition never held within microtask turns")
  }
  async function flush(count = 200) {
    for (let turn = 0; turn < count; turn++) await Promise.resolve()
  }

  /** A computer on the memory relay that only jobs want. Its fake API mints `vt1.computer.<device>`. */
  function jobsComputer(
    relay: MemoryRelay,
    timing?: LinkDependencies["timing"],
    reply?: (attempt: number) => Response | undefined,
    token: LinkDependencies["token"] = async () => "vct_desktop",
  ) {
    const stored: { value?: RemoteIdentity } = {}
    const enabled = { value: false }
    const jobs = { want: true, offers: [] as string[] }
    const minted: number[] = []
    const attempts: number[] = []
    const opened = { count: 0 }
    const link = createRemoteLink({
      store: { read: async () => stored.value, write: async (identity) => void (stored.value = identity) },
      enabled: { get: () => enabled.value, set: (value) => void (enabled.value = value) },
      token,
      api: async () => {
        attempts.push(Date.now())
        const refusal = reply?.(attempts.length)
        if (refusal) return refusal
        const identity = stored.value!
        relay.key(identity.device, identity.publicKey)
        minted.push(Date.now())
        return Response.json({ ticket: ticketFor("computer", identity.device), url: RELAY, protocol: "vector.v1" })
      },
      allowed: () => true,
      socket: (url, protocols) => {
        opened.count += 1
        return relay.socket(url, protocols)
      },
      engine: engine().api,
      origin: ORIGIN,
      computerName: () => "Studio Mac",
      jobs: { want: () => jobs.want, offer: (text) => void jobs.offers.push(text) },
      timing: timing ?? { heartbeatMs: 30, refreshMs: 60_000, batchMs: 20, retryMs: 10 },
    })
    return { link, stored, enabled, jobs, minted, attempts, sockets: () => opened.count }
  }

  test("an offer frame reaches the subscriber unchanged on a computer connected only for jobs", async () => {
    const relay = createMemoryRelay()
    const env = jobsComputer(relay)
    await env.link.setEnabled(true)
    await until(() => env.link.status().state === "online")
    expect(relay.online(env.stored.value!.device)).toBe(true)
    expect(relay.offer(OFFER)).toBe(1)
    await until(() => env.jobs.offers.length === 1)
    expect(env.jobs.offers).toEqual([OFFER])
    // Nothing binary went from this computer to the relay.
    expect(relay.seen).toEqual([])
    env.link.stop()
  })

  test("want() with no phone opens a computer connection and keeps it", async () => {
    const relay = createMemoryRelay()
    const env = jobsComputer(relay)
    env.jobs.want = false
    await env.link.setEnabled(true)
    expect(env.link.status().state).toBe("ready")
    expect(env.sockets()).toBe(0)
    env.jobs.want = true
    await env.link.jobsChanged()
    const device = env.stored.value!.device
    await until(() => env.link.status().state === "online")
    expect(relay.online(device)).toBe(true)
    expect(env.link.status().phones).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 100))
    // Looking again (a sign-in, a plan change, a pairing given up) keeps the same connection.
    env.link.cancelPairing()
    await env.link.refresh()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(relay.online(device)).toBe(true)
    expect(env.link.status().state).toBe("online")
    expect(env.sockets()).toBe(1)
    expect(env.minted.length).toBe(1)
    expect(relay.texts.length).toBeGreaterThan(0)
    expect(relay.texts.every((text) => text === "ping")).toBe(true)
    expect(relay.seen).toEqual([])
    env.link.stop()
  })

  test("want() turning false closes the connection, and turning true opens it again", async () => {
    const relay = createMemoryRelay()
    const env = jobsComputer(relay)
    await env.link.setEnabled(true)
    const device = env.stored.value!.device
    await until(() => relay.online(device))
    env.jobs.want = false
    await env.link.jobsChanged()
    expect(relay.online(device)).toBe(false)
    expect(env.link.status().state).toBe("ready")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(env.sockets()).toBe(1)
    expect(env.minted.length).toBe(1)
    env.jobs.want = true
    await env.link.jobsChanged()
    await until(() => relay.online(device))
    expect(env.sockets()).toBe(2)
    env.link.stop()
  })

  test("over a simulated day, a job-only computer sends only heartbeats and refreshes at most twice", async () => {
    const relay = createMemoryRelay()
    // The app's own timing: a 25-s ping, a 4-minute phone cadence and the 12-hour jobs cadence.
    const env = jobsComputer(relay, {})
    env.jobs.want = false
    // The identity's keys are made under real timers.
    await env.link.setEnabled(true)
    env.jobs.want = true
    jest.useFakeTimers()
    try {
      const start = Date.now()
      await env.link.jobsChanged()
      const device = env.stored.value!.device
      await turns(() => env.link.status().state === "online")
      // A phone of the account, there for another computer, stays attached all day. The relay asks this computer for
      // a fresh ticket when it arrives; a computer kept only for jobs does not take one.
      relay.socket(RELAY, ["vector.v1", ticketFor("phone", "PHONE_OF_ANOTHER_MAC_A")])
      await turns(() => env.link.status().viewers === 1)
      // Stepped an hour at a time, so each refresh's API call reads the clock at the hour it was made.
      const step = 60 * 60_000
      for (let hour = 0; hour < 24; hour++) {
        jest.advanceTimersByTime(step)
        await flush()
      }
      const day = 24 * step
      expect(relay.seen).toEqual([])
      const pings = relay.texts.filter((text) => text === "ping").length
      const refreshes = relay.texts.filter((text) => text !== "ping").map((text) => JSON.parse(text))
      expect(pings).toBe(day / RELAY_LIMITS.heartbeatEveryMs)
      expect(refreshes.every((message) => message.t === "refresh" && typeof message.ticket === "string")).toBe(true)
      expect(refreshes.length).toBeGreaterThanOrEqual(1)
      expect(refreshes.length).toBeLessThanOrEqual(2)
      expect(env.minted.length).toBe(1 + refreshes.length)
      // The first refresh lands at half the relay's limit, and no ticket is older than the limit at any time.
      const first = env.minted[1]! - env.minted[0]!
      expect(first).toBeGreaterThanOrEqual(RELAY_LIMITS.computerTicketMaxAgeMs / 2)
      expect(first).toBeLessThan(RELAY_LIMITS.computerTicketMaxAgeMs / 2 + step)
      expect(env.minted[0]).toBe(start)
      const gaps = [...env.minted.slice(1), start + day].map((at, index) => at - env.minted[index]!)
      expect(gaps.every((gap) => gap < RELAY_LIMITS.computerTicketMaxAgeMs)).toBe(true)
      expect(relay.online(device)).toBe(true)
      expect(env.link.status().state).toBe("online")
      expect(env.sockets()).toBe(1)
    } finally {
      // Stopped here so that a failed assertion leaves no ping or refresh timer running for the tests after it.
      env.link.stop()
      jest.useRealTimers()
    }
  })

  const renewing = () =>
    Response.json({ error: { code: "MODEL_PLAN_RENEWING" } }, { status: 503, headers: { "retry-after": "30" } })

  test.each([
    { name: "a renewed plan", reply: (attempt: number) => (attempt === 2 ? renewing() : undefined), mint: true },
    { name: "a plan still renewing", reply: (attempt: number) => (attempt > 1 ? renewing() : undefined), mint: false },
  ])("retries a pre-mint renewal only once on the same socket for $name", async ({ reply, mint }) => {
    const relay = createMemoryRelay()
    const env = jobsComputer(relay, {}, reply)
    env.jobs.want = false
    await env.link.setEnabled(true)
    env.jobs.want = true
    jest.useFakeTimers()
    try {
      await env.link.jobsChanged()
      await turns(() => env.link.status().state === "online")
      jest.advanceTimersByTime(RELAY_LIMITS.computerTicketMaxAgeMs / 2)
      await flush()
      expect(env.attempts).toHaveLength(2)
      expect(env.minted).toHaveLength(1)

      jest.advanceTimersByTime(29_999)
      await flush()
      expect(env.attempts).toHaveLength(2)
      jest.advanceTimersByTime(1)
      await flush()
      expect(env.attempts).toHaveLength(3)
      expect(env.attempts[2]! - env.attempts[1]!).toBe(30_000)
      expect(env.minted).toHaveLength(mint ? 2 : 1)
      expect(relay.texts.filter((text) => text.includes('"refresh"'))).toHaveLength(mint ? 1 : 0)
      jest.advanceTimersByTime(2 * 60_000)
      await flush()
      expect(env.attempts).toHaveLength(3)
      expect(env.sockets()).toBe(1)
    } finally {
      env.link.stop()
      jest.useRealTimers()
    }
  })

  test.each([
    {
      name: "a lost response",
      reply: () => {
        throw new Error("response lost")
      },
      disable: false,
    },
    { name: "an unreadable success", reply: () => new Response("{"), disable: false },
    {
      name: "an unrelated refusal",
      reply: () =>
        Response.json({ error: { code: "REMOTE_UNAVAILABLE" } }, { status: 503, headers: { "retry-after": "30" } }),
      disable: false,
    },
    { name: "an owner disabling the link during the wait", reply: renewing, disable: true },
  ])("does not make an early ticket request after $name", async ({ reply, disable }) => {
    const relay = createMemoryRelay()
    const env = jobsComputer(relay, {}, (attempt) => (attempt === 2 ? reply() : undefined))
    env.jobs.want = false
    await env.link.setEnabled(true)
    env.jobs.want = true
    jest.useFakeTimers()
    try {
      await env.link.jobsChanged()
      await turns(() => env.link.status().state === "online")
      jest.advanceTimersByTime(RELAY_LIMITS.computerTicketMaxAgeMs / 2)
      await flush()
      expect(env.attempts).toHaveLength(2)
      if (disable) await env.link.setEnabled(false)
      jest.advanceTimersByTime(2 * 60_000)
      await flush()
      expect(env.attempts).toHaveLength(2)
      expect(relay.texts.some((text) => text.includes('"refresh"'))).toBe(false)
    } finally {
      env.link.stop()
      jest.useRealTimers()
    }
  })

  test("a pending token lookup cannot mint a retry after Remote is disabled", async () => {
    const relay = createMemoryRelay()
    let tokenReads = 0
    const pending = Promise.withResolvers<string>()
    const env = jobsComputer(
      relay,
      {},
      (attempt) => (attempt === 2 ? renewing() : undefined),
      async () => (++tokenReads === 3 ? pending.promise : "vct_desktop"),
    )
    env.jobs.want = false
    await env.link.setEnabled(true)
    env.jobs.want = true
    jest.useFakeTimers()
    try {
      await env.link.jobsChanged()
      await turns(() => env.link.status().state === "online")
      jest.advanceTimersByTime(RELAY_LIMITS.computerTicketMaxAgeMs / 2)
      await flush()
      expect(env.attempts).toHaveLength(2)

      jest.advanceTimersByTime(30_000)
      await turns(() => tokenReads === 3)
      await env.link.setEnabled(false)
      pending.resolve("vct_desktop")
      await flush()

      expect(env.link.status().state).toBe("off")
      expect(env.attempts).toHaveLength(2)
      expect(relay.texts.some((text) => text.includes('"refresh"'))).toBe(false)
    } finally {
      pending.resolve("vct_desktop")
      env.link.stop()
      jest.useRealTimers()
    }
  })

  test("the jobs cadence counts from each connection, and a close, want(false) or stop() ends it", async () => {
    const relay = createMemoryRelay()
    // The app's own timing: a 25-s ping, the 12-hour jobs cadence and a 1-s retry base.
    const env = jobsComputer(relay, {})
    env.jobs.want = false
    await env.link.setEnabled(true)
    env.jobs.want = true
    const hour = 60 * 60_000
    const hours = async (count: number) => {
      for (let step = 0; step < count; step++) {
        jest.advanceTimersByTime(hour)
        await flush()
      }
    }
    const refreshes = () => relay.texts.filter((text) => text !== "ping").length
    jest.useFakeTimers()
    try {
      await env.link.jobsChanged()
      const device = env.stored.value!.device
      await turns(() => env.link.status().state === "online")
      await hours(11)
      expect(env.minted.length).toBe(1)

      // The relay closes the connection and the link reconnects after its backoff (2 s here).
      relay.drop(device, CLOSE.TICKET_EXPIRED)
      await turns(() => env.link.status().state === "connecting")
      jest.advanceTimersByTime(2_000)
      await turns(() => env.link.status().state === "online")
      expect(env.minted.length).toBe(2)
      expect(env.sockets()).toBe(2)
      // The first connection's 12 hours end an hour after the reconnect; the refresh comes 12 hours after the new mint.
      await hours(11)
      expect(env.minted.length).toBe(2)
      await hours(1)
      expect(env.minted.length).toBe(3)
      expect(env.minted[2]! - env.minted[1]!).toBe(12 * hour)
      expect(refreshes()).toBe(1)

      // Jobs turned off: the connection closes, and no refresh comes while it is closed.
      env.jobs.want = false
      await env.link.jobsChanged()
      expect(relay.online(device)).toBe(false)
      await hours(6)
      expect(env.minted.length).toBe(3)
      // On again: a new connection, whose first refresh again comes 12 hours after its own mint.
      env.jobs.want = true
      await env.link.jobsChanged()
      await turns(() => env.link.status().state === "online")
      expect(env.minted.length).toBe(4)
      await hours(11)
      expect(env.minted.length).toBe(4)
      await hours(1)
      expect(env.minted.length).toBe(5)
      expect(env.minted[4]! - env.minted[3]!).toBe(12 * hour)
      expect(refreshes()).toBe(2)

      // stop() leaves no timer of the link running, so nothing is minted or sent again. A minute passes first, so the
      // last mint's 15-s request timeout (AbortSignal.timeout, a timer too) has lapsed.
      jest.advanceTimersByTime(60_000)
      await flush()
      env.link.stop()
      expect(jest.getTimerCount()).toBe(0)
      const sent = relay.texts.length
      await hours(24)
      expect(env.minted.length).toBe(5)
      expect(relay.texts.length).toBe(sent)
      expect(relay.online(device)).toBe(false)
    } finally {
      env.link.stop()
      jest.useRealTimers()
    }
  })

  test("the jobs cadence starts only once the relay's hello arrives", async () => {
    const env = setup({
      jobs: { want: () => true, offer: () => {} },
      timing: { heartbeatMs: 30, refreshMs: 60_000, jobsRefreshMs: 40, batchMs: 20, retryMs: 10 },
    })
    await env.link.setEnabled(true)
    await until(() => env.sockets.length === 1)
    // The socket is still opening: several of the jobs cadence's periods pass with no ticket minted for it.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(env.tickets()).toBe(1)
    expect(env.link.status().state).toBe("connecting")
    env.socket().open(env.stored.value!.device)
    await until(() => env.link.status().state === "online")
    await until(() =>
      env
        .socket()
        .texts()
        .some((text) => text.includes('"refresh"')),
    )
    expect(env.tickets()).toBeGreaterThanOrEqual(2)
    env.link.stop()
  })

  test("a phone paired later restores the phone's cadence, and the jobs cadence returns without it", async () => {
    const jobs = { want: true }
    const env = setup({
      jobs: { want: () => jobs.want, offer: () => {} },
      timing: { heartbeatMs: 30, refreshMs: 25, jobsRefreshMs: 3_600_000, batchMs: 20, retryMs: 10 },
    })
    const refreshes = () =>
      env
        .socket()
        .texts()
        .filter((text) => text.includes('"refresh"')).length
    await env.link.setEnabled(true)
    await until(() => env.sockets.length === 1)
    env.socket().open(env.stored.value!.device)
    await until(() => env.link.status().state === "online")
    const phone = await fakePhone({ origin: ORIGIN, name: "Pixel" })
    // The account's phone arrives for another computer: kept only for jobs, this one takes no ticket for it.
    env.socket().server({ t: "peers", peers: [{ device: phone.device, role: "phone" }], viewers: 1, refresh: true })
    await until(() => env.link.status().viewers === 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(refreshes()).toBe(0)
    expect(env.tickets()).toBe(1)

    // A pairing opens with that phone already attached, and the relay says nothing more: its ticket lapsed, so one
    // refresh goes at once, before any timer, then one every refreshMs.
    const offer = await env.link.startPairing()
    await turns(() => refreshes() === 1)
    await flush()
    expect(refreshes()).toBe(1)
    await until(() => refreshes() >= 4)

    // The phone scans the code and is paired.
    env.socket().frame(phone.device, await phone.pairRequest(offer.link))
    await until(() =>
      env
        .socket()
        .frames()
        .some((frame) => frame.to === phone.device),
    )
    const pending = await phone.readPending(env.socket().frames().at(-1)!.envelope)
    await env.link.confirmPairing(pending.code)
    expect(env.stored.value!.phones.map((item) => item.device)).toEqual([phone.device])

    // The phone leaves: the phone's cadence stops, and the jobs cadence (an hour here) takes over.
    env.socket().server({ t: "peers", peers: [], viewers: 0 })
    await until(() => env.link.status().viewers === 0)
    const left = refreshes()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(refreshes()).toBe(left)

    // It comes back and the relay asks for a ticket: exactly one refresh for that, then the phone's cadence.
    env.socket().server({ t: "peers", peers: [{ device: phone.device, role: "phone" }], viewers: 1, refresh: true })
    await turns(() => refreshes() === left + 1)
    await flush()
    expect(refreshes()).toBe(left + 1)
    await until(() => refreshes() >= left + 3)

    // Jobs no longer wanted: the paired phone keeps the connection and its cadence.
    jobs.want = false
    await env.link.jobsChanged()
    const kept = refreshes()
    await until(() => refreshes() >= kept + 2)
    expect(env.sockets.length).toBe(1)
    expect(env.socket().closedWith).toBeUndefined()

    // Jobs wanted again and the phone removed while still attached: with no word from the relay, the phone's cadence
    // stops and the jobs cadence takes over, on the same connection.
    jobs.want = true
    await env.link.jobsChanged()
    await env.link.unpair(phone.device)
    const after = refreshes()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(refreshes()).toBe(after)
    expect(env.sockets.length).toBe(1)
    expect(env.socket().closedWith).toBeUndefined()
    expect(env.link.status().state).toBe("online")
    env.link.stop()
  })

  test("a malformed offer frame is dropped, and so is any offer with no subscriber; neither throws", async () => {
    const offers: string[] = []
    const logs: string[] = []
    const env = setup({
      jobs: { want: () => true, offer: (text) => void offers.push(text) },
      log: (message) => void logs.push(message),
    })
    await env.link.setEnabled(true)
    await until(() => env.sockets.length === 1)
    env.socket().open(env.stored.value!.device)
    await until(() => env.link.status().state === "online")
    const device = new Uint8Array(DEVICE_BYTES)
    device[DEVICE_BYTES - 1] = 1
    const malformed = [
      offerFrame(ascii(OFFER), device),
      offerFrame(new Uint8Array()),
      offerFrame(ascii("vef1.")),
      offerFrame(ascii("vef2.x")),
      offerFrame(ascii("VEF1.x")),
      offerFrame(ascii("vef1.a b")),
      offerFrame(ascii(`${OFFER}\n`)),
      offerFrame(ascii(` ${OFFER}`)),
      // Valid UTF-8 that is not ASCII, a byte-order mark, an invalid byte, NUL and DEL.
      offerFrame(ascii(`${OFFER}é`)),
      offerFrame(new Uint8Array([0xef, 0xbb, 0xbf, ...ascii(OFFER)])),
      offerFrame(new Uint8Array([...ascii(OFFER), 0xff])),
      offerFrame(new Uint8Array([...ascii(OFFER), 0x00])),
      offerFrame(new Uint8Array([...ascii(OFFER), 0x7f])),
      // One byte longer than the relay forwards.
      offerFrame(ascii(`vef1.${"a".repeat(RELAY_LIMITS.internalBodyBytes - 4)}`)),
      // Shorter than a frame's header, and a kind that is neither data nor an offer.
      new Uint8Array([FRAME.JOB_OFFER, 0, 0]),
      offerFrame(ascii(OFFER), new Uint8Array(DEVICE_BYTES), 0x03),
    ]
    for (const frame of malformed) env.socket().onmessage?.({ data: frame.buffer })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(offers).toEqual([])
    expect(logs).toEqual([])
    expect(env.socket().closedWith).toBeUndefined()
    expect(env.socket().frames()).toEqual([])
    expect(env.link.status().state).toBe("online")
    // The longest offer the relay forwards still arrives, and so does a real one, unchanged and in order.
    const longest = `vef1.${"a".repeat(RELAY_LIMITS.internalBodyBytes - 5)}`
    env.socket().onmessage?.({ data: offerFrame(ascii(longest)).buffer })
    env.socket().onmessage?.({ data: offerFrame(ascii(OFFER)).buffer })
    await until(() => offers.length === 2)
    expect(offers).toEqual([longest, OFFER])
    env.link.stop()

    // With no subscriber the same good frame is dropped quietly, and the phone's connection stays up.
    const plain = setup({ log: (message) => void logs.push(message) })
    await plain.link.startPairing()
    await until(() => plain.sockets.length === 1)
    plain.socket().open(plain.stored.value!.device)
    await until(() => plain.link.status().state === "online")
    plain.socket().onmessage?.({ data: offerFrame(ascii(OFFER)).buffer })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(logs).toEqual([])
    expect(plain.socket().closedWith).toBeUndefined()
    expect(plain.link.status().state).toBe("online")
    plain.link.stop()
  })

  test("a subscriber that throws or rejects is contained, and the log line holds no offer", async () => {
    const offers: string[] = []
    const logs: { message: string; meta?: Record<string, unknown> }[] = []
    const calls = { count: 0 }
    const env = setup({
      jobs: {
        want: () => true,
        offer: (text) => {
          calls.count += 1
          if (calls.count === 1) throw new Error(`refused ${text}`)
          if (calls.count === 2) return Promise.reject(new Error(`refused ${text}`))
          offers.push(text)
          return Promise.resolve(true)
        },
      },
      log: (message, meta) => void logs.push({ message, meta }),
    })
    await env.link.setEnabled(true)
    await until(() => env.sockets.length === 1)
    env.socket().open(env.stored.value!.device)
    await until(() => env.link.status().state === "online")
    for (let index = 0; index < 3; index++) env.socket().onmessage?.({ data: offerFrame(ascii(OFFER)).buffer })
    await until(() => offers.length === 1 && logs.length === 2)
    expect(calls.count).toBe(3)
    expect(offers).toEqual([OFFER])
    expect(logs.map((entry) => entry.message)).toEqual([
      "remote: a job offer was not taken",
      "remote: a job offer was not taken",
    ])
    expect(logs.every((entry) => entry.meta === undefined)).toBe(true)
    expect(JSON.stringify(logs)).not.toContain("vef1.")
    expect(env.socket().closedWith).toBeUndefined()
    expect(env.link.status().state).toBe("online")
    env.link.stop()
  })

  test("jobs alone never turn Remote on or make an identity", async () => {
    const env = setup({ jobs: { want: () => true, offer: () => {} } })
    await env.link.start()
    await env.link.jobsChanged()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(env.sockets).toEqual([])
    expect(env.apiCalls).toEqual([])
    expect(env.stored.value).toBeUndefined()
    expect(env.link.status().state).toBe("off")
    // Remote is on, but no identity was made yet: still nothing.
    env.enabled.value = true
    await env.link.jobsChanged()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(env.sockets).toEqual([])
    expect(env.apiCalls).toEqual([])
    expect(env.stored.value).toBeUndefined()
    expect(env.link.status().state).toBe("ready")
    // The person turns Remote on here: the identity is made, then one computer ticket and one connection follow.
    await env.link.setEnabled(true)
    await until(() => env.sockets.length === 1)
    expect(env.stored.value?.device).toBeDefined()
    expect(env.tickets()).toBe(1)
    expect(env.apiCalls.map((call) => call.body.role)).toEqual(["computer"])
    env.link.stop()
  })

  test("a want() that throws counts as not wanted, and the phone's path keeps working", async () => {
    const env = setup({
      jobs: {
        want: () => {
          throw new Error("settings unreadable")
        },
        offer: () => {},
      },
    })
    await env.link.setEnabled(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(env.sockets).toEqual([])
    expect(env.link.status().state).toBe("ready")
    // A pairing connects as it does without jobs, and the relay's ask for a ticket when a phone arrives is answered.
    await env.link.startPairing()
    await until(() => env.sockets.length === 1)
    env.socket().open(env.stored.value!.device)
    await until(() => env.link.status().state === "online")
    env.socket().server({ t: "peers", peers: [{ device: "PHONE_A", role: "phone" }], viewers: 1, refresh: true })
    await until(() =>
      env
        .socket()
        .texts()
        .some((text) => text.includes('"refresh"')),
    )
    // A dropped connection is retried.
    env.socket().drop(CLOSE.TICKET_EXPIRED)
    await until(() => env.sockets.length === 2)
    expect(env.link.status().state).toBe("connecting")
    env.link.stop()
  })

  test("at most eight offers wait on the subscriber at once; more are dropped until one settles", async () => {
    const offers: string[] = []
    const logs: string[] = []
    const waiting: { resolve: () => void; reject: (error: Error) => void }[] = []
    const env = setup({
      jobs: {
        want: () => true,
        offer: (text) => {
          offers.push(text)
          return new Promise<void>((resolve, reject) => void waiting.push({ resolve, reject }))
        },
      },
      log: (message) => void logs.push(message),
    })
    await env.link.setEnabled(true)
    await until(() => env.sockets.length === 1)
    env.socket().open(env.stored.value!.device)
    await until(() => env.link.status().state === "online")
    const send = (index: number) => env.socket().onmessage?.({ data: offerFrame(ascii(`${OFFER}${index}`)).buffer })
    for (let index = 0; index < 12; index++) send(index)
    await until(() => offers.length === 8)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(offers).toEqual(Array.from({ length: 8 }, (_, index) => `${OFFER}${index}`))
    // One rejects and one resolves: two places free up, and the next two offers are taken.
    waiting.shift()!.reject(new Error("declined"))
    waiting.shift()!.resolve()
    await until(() => logs.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    for (const index of [12, 13, 14]) send(index)
    await until(() => offers.length === 10)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(offers.slice(8)).toEqual([`${OFFER}12`, `${OFFER}13`])
    expect(logs).toEqual(["remote: a job offer was not taken"])
    expect(env.socket().closedWith).toBeUndefined()
    expect(env.link.status().state).toBe("online")
    for (const item of waiting) item.resolve()
    env.link.stop()
  })

  test("want() decides only the connection: an offer on a phone's connection reaches the subscriber", async () => {
    const offers: string[] = []
    const env = setup({ jobs: { want: () => false, offer: (text) => void offers.push(text) } })
    await env.link.startPairing()
    await until(() => env.sockets.length === 1)
    env.socket().open(env.stored.value!.device)
    await until(() => env.link.status().state === "online")
    env.socket().onmessage?.({ data: offerFrame(ascii(OFFER)).buffer })
    await until(() => offers.length === 1)
    expect(offers).toEqual([OFFER])
    env.link.stop()
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
    // A Connect run's updates reach the phone too, so a review started there refreshes without its own part.
    env.fake.push({ directory: "/repo", payload: { type: "connect.run.updated", properties: { sessionID: "ses_1" } } })
    await until(
      async () =>
        (await read())
          .filter((item) => (item as { t?: string }).t === "events")
          .flatMap((item) => (item as { events: unknown[] }).events).length === 31,
    )
    const batches = inbox.filter((item) => (item as { t?: string }).t === "events")
    expect(batches.length).toBeLessThan(31)
    expect(JSON.stringify(batches)).not.toContain("/elsewhere")
    expect(JSON.stringify(batches)).not.toContain("pty.created")
    expect(JSON.stringify(batches)).toContain("connect.run.updated")
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

  test("a helper the phone's turn starts keeps the hold and the event stream open after the session is idle", async () => {
    const { env, send, read } = await paired()
    await send({
      t: "req",
      id: 10,
      method: "POST",
      path: "/session/ses_1/prompt_async",
      directory: "/repo",
      body: { parts: [{ type: "text", text: "Clean the build in the background" }] },
    })
    await until(async () => (await read()).some((item) => (item as { id?: number }).id === 10))
    await until(() => env.fake.open() === 1)
    env.fake.push({
      directory: "/repo",
      payload: {
        type: "session.created",
        properties: {
          sessionID: "ses_helper",
          info: { id: "ses_helper", parentID: "ses_1", metadata: { subagent: { status: "running" } } },
        },
      },
    })
    env.fake.push({
      directory: "/repo",
      payload: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } },
    })
    await until(() => !env.link.isPhoneTurn(["ses_1"]))
    expect(env.link.isPhoneTurn(["ses_helper", "ses_1"])).toBe(true)
    expect(env.fake.open()).toBe(1)
    env.fake.push({ directory: "/repo", payload: { type: "session.idle", properties: { sessionID: "ses_helper" } } })
    await until(() => !env.link.isPhoneTurn(["ses_helper", "ses_1"]))
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
