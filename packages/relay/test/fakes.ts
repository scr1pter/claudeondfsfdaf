// An in-memory stand-in for the parts of Cloudflare's runtime the relay uses. The SQL runs on a real SQLite engine
// (bun:sqlite, tests only), so the statements the object sends are exercised as written. The CI smoke test
// (e2e/relay-smoke.ts) runs the same code on the real runtime under `wrangler dev --local`.

import { Database } from "bun:sqlite"
import { AccountRelay } from "../src/account-relay"
import { base64url } from "../src/bytes"
import type {
  DurableObjectId,
  DurableObjectNamespace,
  DurableObjectState,
  DurableObjectStorage,
  Env,
  KVNamespace,
  RelaySocket,
  Runtime,
  SqlCursor,
  SqlStorage,
  SqlValue,
} from "../src/runtime"
import { signTicket, type TicketClaims } from "../src/ticket"

export const NOW = Date.UTC(2026, 10, 3, 12, 0, 0)
export const ACCOUNT = "acct_fixture_0001"
export const ACCOUNT_KEY = "relay-account-fixture-key-".padEnd(48, "k")
export const INTERNAL_SECRET = "relay-internal-fixture-secret-".padEnd(48, "s")
export const EPOCH = "epoch_fixture_0000001"

export class FakeSocket implements RelaySocket {
  readyState = 1
  readonly sent: Array<string | Uint8Array> = []
  closed: { code: number; reason: string } | undefined
  accepted = false
  private attachment: unknown = null

  send(message: string | ArrayBuffer | Uint8Array) {
    if (this.readyState !== 1) throw new Error("This socket is not open.")
    this.sent.push(typeof message === "string" ? message : new Uint8Array(message).slice())
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= 2) throw new Error("This socket is already closing.")
    this.readyState = 2
    this.closed = { code, reason }
  }

  accept() {
    this.accepted = true
  }

  serializeAttachment(value: unknown) {
    if (JSON.stringify(value).length > 2048) throw new Error("An attachment is at most 2,048 bytes.")
    this.attachment = structuredClone(value)
  }

  deserializeAttachment() {
    return structuredClone(this.attachment)
  }

  /** Control messages the relay sent, decoded. */
  messages(): Array<Record<string, unknown>> {
    return this.sent.filter((entry): entry is string => typeof entry === "string").map((entry) => JSON.parse(entry))
  }

  frames(): Uint8Array[] {
    return this.sent.filter((entry): entry is Uint8Array => entry instanceof Uint8Array)
  }

  last(type: string) {
    return this.messages()
      .filter((message) => message.t === type)
      .at(-1)
  }
}

class FakeSql implements SqlStorage {
  private db = new Database(":memory:")
  readonly statements: string[] = []

  exec<Row extends Record<string, SqlValue> = Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): SqlCursor<Row> {
    this.statements.push(query)
    const rows = this.db.query(query).all(...(bindings as Array<string | number | null>)) as Row[]
    return { toArray: () => rows }
  }

  reset() {
    this.db.close()
    this.db = new Database(":memory:")
  }

  tables() {
    return (
      this.db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
    ).map((row) => row.name)
  }

  rows<Row>(query: string, ...bindings: Array<string | number | null>) {
    return this.db.query(query).all(...bindings) as Row[]
  }
}

export class FakeState implements DurableObjectState {
  readonly entries: Array<{ socket: RelaySocket; tags: string[] }> = []
  readonly sql = new FakeSql()
  readonly pings = new Map<RelaySocket, Date>()
  alarm: number | null = null
  autoResponse: unknown
  alarmWrites = 0
  readonly storage: DurableObjectStorage = {
    sql: this.sql,
    getAlarm: async () => this.alarm,
    setAlarm: async (time) => {
      this.alarm = time
      this.alarmWrites++
    },
    deleteAlarm: async () => {
      this.alarm = null
    },
    deleteAll: async () => this.sql.reset(),
  }

  acceptWebSocket(socket: RelaySocket, tags: string[] = []) {
    if (tags.length > 10 || tags.some((tag) => tag.length > 256)) throw new Error("Too many or too long tags.")
    this.entries.push({ socket, tags })
  }

  getWebSockets(tag?: string) {
    return this.entries
      .filter((entry) => entry.socket.readyState < 3 && (tag === undefined || entry.tags.includes(tag)))
      .map((entry) => entry.socket)
  }

  setWebSocketAutoResponse(pair?: unknown) {
    this.autoResponse = pair
  }

  getWebSocketAutoResponseTimestamp(socket: RelaySocket) {
    return this.pings.get(socket) ?? null
  }
}

export class FakeKV implements KVNamespace {
  readonly values = new Map<string, string>()
  failing = false
  reads = 0

  async get(key: string) {
    this.reads++
    if (this.failing) throw new Error("KV is unavailable.")
    return this.values.get(key) ?? null
  }

  async put(key: string, value: string) {
    this.values.set(key, value)
  }

  async delete(key: string) {
    this.values.delete(key)
  }
}

export type UpgradeResponse = Response & { webSocket?: FakeSocket }

export class FakeRuntime implements Runtime {
  /** Client end → the server end the relay holds. */
  readonly servers = new Map<RelaySocket, FakeSocket>()
  readonly clock: { now: number }

  constructor(clock: { now: number }) {
    this.clock = clock
  }

  now() {
    return this.clock.now
  }

  pair() {
    const client = new FakeSocket()
    const server = new FakeSocket()
    this.servers.set(client, server)
    return { client, server }
  }

  upgrade(client: RelaySocket, headers: Record<string, string>) {
    return { status: 101, headers: new Headers(headers), webSocket: client } as unknown as Response
  }

  autoResponse(request: string, response: string) {
    return { request, response }
  }
}

export class FakeNamespace implements DurableObjectNamespace {
  readonly objects = new Map<string, { state: FakeState; relay: AccountRelay }>()
  readonly calls: Array<{ name: string; url: string; headers: Headers }> = []
  private readonly make: (state: FakeState) => AccountRelay

  constructor(make: (state: FakeState) => AccountRelay) {
    this.make = make
  }

  idFromName(name: string): DurableObjectId {
    return { name, toString: () => name } as DurableObjectId
  }

  get(id: DurableObjectId) {
    const name = (id as unknown as { name: string }).name
    return {
      fetch: async (request: Request) => {
        this.calls.push({ name, url: request.url, headers: new Headers(request.headers) })
        let object = this.objects.get(name)
        if (!object) {
          const state = new FakeState()
          object = { state, relay: this.make(state) }
          this.objects.set(name, object)
        }
        return object.relay.fetch(request)
      },
    }
  }
}

export function deviceId() {
  return base64url(crypto.getRandomValues(new Uint8Array(16)))
}

export function token() {
  return base64url(crypto.getRandomValues(new Uint8Array(18)))
}

export async function ticketKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  return { ...pair, publicText: base64url(raw) }
}

/** One relay object with its state, clock and keys, for driving the object directly. */
export class Harness {
  readonly clock = { now: NOW }
  readonly state = new FakeState()
  readonly kv = new FakeKV()
  readonly runtime = new FakeRuntime(this.clock)
  readonly env: Env
  readonly keys: Awaited<ReturnType<typeof ticketKeys>>
  relay: AccountRelay

  private constructor(keys: Awaited<ReturnType<typeof ticketKeys>>) {
    this.keys = keys
    this.env = {
      ACCOUNT_RELAY: new FakeNamespace(() => this.relay),
      REMOTE_FLAGS: this.kv,
      TICKET_PUBLIC_KEYS: keys.publicText,
      INTERNAL_SECRET,
      ACCOUNT_KEY,
    }
    this.relay = new AccountRelay(this.state, this.env, this.runtime)
  }

  static async create() {
    return new Harness(await ticketKeys())
  }

  /** A new instance over the same storage and sockets, as after hibernation: everything in memory is gone. */
  wake() {
    this.relay = new AccountRelay(this.state, this.env, this.runtime)
    return this.relay
  }

  advance(ms: number) {
    this.clock.now += ms
  }

  claims(overrides: Partial<TicketClaims> = {}): TicketClaims {
    const iat = Math.floor(this.clock.now / 1000)
    return {
      v: 1,
      aud: "vector-relay",
      sub: ACCOUNT,
      role: "computer",
      dev: deviceId(),
      computers: 3,
      viewerHours: 100,
      epoch: EPOCH,
      periodEnd: NOW + 20 * 24 * 60 * 60_000,
      iat,
      exp: iat + 300,
      jti: token(),
      ...overrides,
    }
  }

  ticket(overrides: Partial<TicketClaims> = {}) {
    return signTicket(this.claims(overrides), this.keys.privateKey)
  }

  /** Connects straight to the object, as the Worker would after checking the ticket. */
  async connect(overrides: Partial<TicketClaims> = {}, ticket?: string) {
    const text = ticket ?? (await this.ticket(overrides))
    const response = (await this.relay.fetch(
      new Request("https://relay.invalid/connect", {
        headers: { upgrade: "websocket", "x-vector-relay-ticket": text },
      }),
    )) as UpgradeResponse
    const socket = response.webSocket ? this.runtime.servers.get(response.webSocket) : undefined
    return { response, socket: socket as FakeSocket, ticket: text }
  }

  async computer(overrides: Partial<TicketClaims> = {}) {
    const dev = overrides.dev ?? deviceId()
    const { socket, response } = await this.connect({ role: "computer", dev, ...overrides })
    return { socket, dev, response }
  }

  async phone(overrides: Partial<TicketClaims> = {}) {
    const dev = overrides.dev ?? deviceId()
    const { socket, response } = await this.connect({ role: "phone", dev, ...overrides })
    return { socket, dev, response }
  }

  message(socket: FakeSocket, message: string | Uint8Array) {
    return this.relay.webSocketMessage(socket, typeof message === "string" ? message : message.slice().buffer)
  }

  /** The client closes: the runtime marks the socket closed and tells the object. */
  async disconnect(socket: FakeSocket, code = 1000) {
    socket.readyState = 3
    await this.relay.webSocketClose(socket, code, "", true)
  }

  /** The runtime answered a heartbeat on this socket now. */
  ping(socket: FakeSocket) {
    this.state.pings.set(socket, new Date(this.clock.now))
  }

  /** Lets time pass in steps, answering heartbeats from every open socket (live clients) and firing due alarms. */
  async run(ms: number, options: { step?: number; silent?: ReadonlySet<RelaySocket> } = {}) {
    const end = this.clock.now + ms
    while (this.clock.now < end) {
      this.advance(Math.min(options.step ?? 20_000, end - this.clock.now))
      for (const entry of this.state.entries)
        if (entry.socket.readyState === 1 && !options.silent?.has(entry.socket)) this.ping(entry.socket as FakeSocket)
      if (this.state.alarm !== null && this.state.alarm <= this.clock.now) {
        this.state.alarm = null
        await this.relay.alarm()
      }
    }
  }

  /**
   * Lets time pass while phone apps stay open: heartbeats, a ticket refresh every 4 minutes and, with `computer`, a data
   * frame to it each time (a user doing something, which keeps a viewer from going idle).
   */
  async watch(
    phones: ReadonlyArray<{ socket: FakeSocket; dev: string }>,
    ms: number,
    options: { claims?: Partial<TicketClaims>; computer?: string } = {},
  ) {
    const end = this.clock.now + ms
    while (this.clock.now < end) {
      await this.run(Math.min(4 * 60_000, end - this.clock.now))
      for (const phone of phones) {
        if (phone.socket.readyState !== 1) continue
        if (options.computer) await this.message(phone.socket, frame(0x01, options.computer, new Uint8Array([1])))
        const ticket = await this.ticket({ ...options.claims, role: "phone", dev: phone.dev })
        await this.message(phone.socket, JSON.stringify({ t: "refresh", ticket }))
      }
    }
  }

  async internal(action: string, body: Record<string, unknown>, nonce = token() + token()) {
    const response = await this.relay.fetch(
      new Request(`https://relay.invalid/internal/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-vector-relay-nonce": nonce },
        body: JSON.stringify(body),
      }),
    )
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  meter(name: string, epoch = EPOCH) {
    return (
      this.state.sql.rows<{ ms: number }>("SELECT ms FROM meters WHERE epoch = ? AND name = ?", epoch, name)[0]?.ms ?? 0
    )
  }

  devices() {
    return this.state.sql.rows<{
      id: string
      role: string
      name: string | null
      public_key: string | null
      revoked_at: number | null
    }>("SELECT id, role, name, public_key, revoked_at FROM devices ORDER BY paired_at, id")
  }
}

/** Builds a data frame: kind, the 16-byte device id, then the payload. */
export function frame(kind: number, device: string, payload: Uint8Array) {
  const id = Uint8Array.from(atob(device.replace(/-/g, "+").replace(/_/g, "/") + "=="), (c) => c.charCodeAt(0))
  const out = new Uint8Array(17 + payload.byteLength)
  out[0] = kind
  out.set(id, 1)
  out.set(payload, 17)
  return out
}
