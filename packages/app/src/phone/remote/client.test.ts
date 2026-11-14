import { describe, expect, test } from "bun:test"
import { generateDeviceIdentity } from "@vectordevai/core/remote/crypto"
import { createPhoneRemote, type RemoteSocket } from "./client"
import { PasskeyError } from "./passkey"
import { decodeRecord, memoryRemoteStore } from "./store"

// WP A42: the phone's Remote client on its own: how it asks for tickets, which relay it opens, what it keeps and how it
// answers the relay's refusals. Pairing and requests against the real desktop half run in
// packages/desktop/src/main/remote-phone-app.test.ts.

const RELAY = "wss://relay.vectordev.ai/v1/connect"

class FakeSocket implements RemoteSocket {
  readyState = 0
  binaryType = "blob"
  sent: (string | Uint8Array)[] = []
  onopen: RemoteSocket["onopen"] = null
  onmessage: RemoteSocket["onmessage"] = null
  onclose: RemoteSocket["onclose"] = null
  onerror: RemoteSocket["onerror"] = null
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string | Uint8Array) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
  }
  open(device: string) {
    this.readyState = 1
    this.onopen?.({})
    this.onmessage?.({ data: JSON.stringify({ t: "hello", v: 1, role: "phone", device, exp: 0, peers: [], viewers: 1 }) })
  }
  texts() {
    return this.sent.filter((item): item is string => typeof item === "string")
  }
}

async function until(condition: () => boolean, ms = 2_000) {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error("condition never held")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function setup(
  options: { ticket?: (count: number) => Record<string, unknown> | Error; allowed?: boolean; timing?: object } = {},
) {
  const sockets: FakeSocket[] = []
  const calls: { path: string; body?: unknown }[] = []
  const store = memoryRemoteStore()
  let tickets = 0
  const remote = createPhoneRemote({
    origin: "https://remote.vectordev.ai",
    api: async (path, init) => {
      calls.push({ path, body: init.body })
      if (path === "/api/remote/ticket") {
        tickets += 1
        const answer = options.ticket?.(tickets) ?? {
          ticket: `vt1.ticket-${tickets}`,
          url: RELAY,
          protocol: "vector.v1",
          expiresAt: Date.now() + 300_000,
        }
        if (answer instanceof Error) throw answer
        return answer
      }
      return { ok: true }
    },
    store,
    socket: (url, protocols) => {
      const socket = new FakeSocket(url, protocols)
      sockets.push(socket)
      return socket
    },
    relayAllowed: () => options.allowed ?? true,
    passkeys: {
      create: async () => {
        throw new PasskeyError("cancelled", "cancelled")
      },
      get: async () => {
        throw new PasskeyError("cancelled", "cancelled")
      },
    },
    alertKeys: { save: async () => {}, remove: async () => {}, forget: async () => {} },
    phoneName: () => "iPhone",
    timing: { heartbeatMs: 20, retryMs: 10, ...options.timing },
  })
  return { remote, sockets, calls, store, tickets: () => tickets }
}

const refusal = (status: number, message = "Refused.") => Object.assign(new Error(message), { status })

describe("tickets", () => {
  test("asks for a phone ticket with its own device id and a plain name, then offers it beside vector.v1", async () => {
    const env = setup()
    await env.remote.connect()
    const device = env.remote.view().device!
    expect(device).toMatch(/^[A-Za-z0-9_-]{21}[AQgw]$/)
    expect(env.calls).toEqual([{ path: "/api/remote/ticket", body: { role: "phone", device, name: "iPhone" } }])
    expect(env.sockets[0]!.url).toBe(RELAY)
    expect(env.sockets[0]!.protocols).toEqual(["vector.v1", "vt1.ticket-1"])
    expect(env.sockets[0]!.binaryType).toBe("arraybuffer")
    env.sockets[0]!.open(device)
    await until(() => env.remote.view().state === "online")
    await until(() => env.sockets[0]!.texts().includes("ping"))
    // The same identity is kept: a second connection asks under the same id.
    env.remote.disconnect()
    await env.remote.connect()
    expect((env.calls[1]!.body as { device: string }).device).toBe(device)
    env.remote.disconnect()
  })

  test("refreshes its ticket in-band before it expires", async () => {
    const env = setup({
      ticket: (count) => ({ ticket: `vt1.ticket-${count}`, url: RELAY, protocol: "vector.v1", expiresAt: Date.now() + 1_100 }),
      timing: { refreshEarlyMs: 1_000 },
    })
    await env.remote.connect()
    env.sockets[0]!.open(env.remote.view().device!)
    await until(() => env.sockets[0]!.texts().some((text) => text.includes('"refresh"')), 3_000)
    expect(JSON.parse(env.sockets[0]!.texts().find((text) => text.includes('"refresh"'))!)).toEqual({
      t: "refresh",
      ticket: "vt1.ticket-2",
    })
    env.remote.disconnect()
  })

  test("a refused ticket says why and opens nothing", async () => {
    for (const [answer, state] of [
      [refusal(401), "signed-out"],
      [refusal(403, "Remote is not in your plan."), "not-in-plan"],
      [refusal(402), "not-in-plan"],
      [refusal(503), "unavailable"],
      [refusal(0), "offline"],
    ] as const) {
      const env = setup({ ticket: () => answer })
      await env.remote.connect()
      expect({ state: env.remote.view().state, sockets: env.sockets.length }).toEqual({ state, sockets: 0 })
    }
    const env = setup({ ticket: () => refusal(403, "Remote is not in your plan.") })
    await env.remote.connect()
    expect(env.remote.view().message).toBe("Remote is not in your plan.")
  })

  test("a relay address that is not Vector's, or not a relay, is never opened", async () => {
    const blocked = setup({ allowed: false })
    await blocked.remote.connect()
    expect(blocked.remote.view().state).toBe("unavailable")
    expect(blocked.sockets).toEqual([])
    for (const url of ["https://relay.vectordev.ai/v1/connect", "wss://relay.vectordev.ai/elsewhere", "wss://relay.vectordev.ai/v1/connect?x=1"]) {
      const odd = setup({ ticket: () => ({ ticket: "vt1.x", url, protocol: "vector.v1", expiresAt: 0 }) })
      await odd.remote.connect()
      expect({ url, sockets: odd.sockets.length }).toEqual({ url, sockets: 0 })
    }
    const wrong = setup({ ticket: () => ({ ticket: "vt1.x", url: RELAY, protocol: "other" }) })
    await wrong.remote.connect()
    expect(wrong.sockets).toEqual([])
  })
})

describe("what the phone keeps", () => {
  test("its private key never leaves as bytes; a malformed record is read as nothing", async () => {
    const env = setup()
    await env.remote.connect()
    const record = await env.store.read()
    expect(record.identity!.privateKey).toBeInstanceOf(CryptoKey)
    expect(record.identity!.privateKey.extractable).toBe(false)
    expect(record.identity!.publicKey.byteLength).toBe(32)
    env.remote.disconnect()

    const identity = await generateDeviceIdentity()
    const decoded = decodeRecord({
      identity: { v: 1, device: "short", ...identity, createdAt: 1 },
      computers: [
        { device: Buffer.alloc(16, 1).toString("base64url"), key: "k".repeat(43), name: "Mac", credential: "c".repeat(22), pairedAt: 1 },
        { device: Buffer.alloc(16, 2).toString("base64url"), key: "short", name: "Bad", credential: "c".repeat(22), pairedAt: 1 },
        "junk",
      ],
    })
    expect(decoded.identity).toBeUndefined()
    expect(decoded.computers.map((item) => item.name)).toEqual(["Mac"])
    expect(decodeRecord(null)).toEqual({ computers: [] })
  })

  test("signing out forgets Remote on this phone; starting over revokes the old device id first", async () => {
    const env = setup()
    await env.remote.connect()
    const first = env.remote.view().device!
    await env.remote.reset()
    expect(env.calls.at(-1)).toEqual({ path: `/api/remote/devices/${first}/revoke`, body: {} })
    expect(env.remote.view().device).toBeUndefined()
    await env.remote.connect()
    const second = env.remote.view().device!
    expect(second).not.toBe(first)
    await env.remote.signOut()
    expect(await env.store.read()).toEqual({ computers: [] })
    expect(env.remote.view().state).toBe("idle")
  })
})

describe("pairing links", () => {
  test("refuses links for another origin, malformed offers and expired ones", async () => {
    const env = setup()
    const offer = (exp: number) =>
      Buffer.from(
        JSON.stringify({
          v: 1,
          computer: Buffer.alloc(16, 3).toString("base64url"),
          key: Buffer.alloc(32, 4).toString("base64url"),
          secret: Buffer.alloc(32, 5).toString("base64url"),
          exp,
        }),
      ).toString("base64url")
    await env.remote.startPairing(`https://elsewhere.example.test/phone/pair#${offer(4_000_000_000)}`)
    expect(env.remote.view().pairing).toEqual({ state: "failed", message: "That is not a Vector Remote pairing code." })
    await env.remote.startPairing(`https://remote.vectordev.ai/phone/pair#${offer(1)}`)
    expect(env.remote.view().pairing).toEqual({
      state: "failed",
      message: "That pairing code expired. Start again on the computer.",
    })
    await env.remote.startPairing(`https://remote.vectordev.ai/phone/pair#${offer(Math.floor(Date.now() / 1000) + 60)}`)
    expect(env.remote.view().pairing.state).toBe("connecting")
    expect(env.sockets).toHaveLength(1)
    env.remote.cancelPairing()
    expect(env.remote.view().pairing).toEqual({ state: "idle" })
    env.remote.disconnect()
  })
})
