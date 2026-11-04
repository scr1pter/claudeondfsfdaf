import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { Readable } from "node:stream"
import { handleCodiumOwner } from "../api/_lib/codium-owner-api"
import { mintCliToken } from "../api/_lib/cli-token"
import { REMOTE_LIMITS } from "../api/_lib/codium-limits"
import { PROVISIONERS, relaySuspension, remote as remoteProvisioner } from "../api/_lib/codium-provisioners"
import { buildSnapshot, snapshotKey, type SnapshotFacts } from "../api/_lib/codium-snapshot"
import { switchKey } from "../api/_lib/codium-switches"
import type { ApiRequest, ApiResponse } from "../api/_lib/http"
import {
  isComputerOnline,
  killRelaySessions,
  relayAddress,
  relayConfigured,
  relayDevices,
  syncRelayKillFlag,
} from "../api/_lib/remote-relay"
import {
  parseTicketRequest,
  publicCloudRun,
  relayEpoch,
  remoteConfigured,
  ticketSigningKey,
  type CloudRunReader,
} from "../api/_lib/remote-ticket"
import { revokeAccountTokens } from "../api/_lib/revocation"
import { handleRemoteCloudRuns } from "../api/remote/cloud-runs"
import { handleRemoteDevices } from "../api/remote/devices"
import { handleRemoteRevoke } from "../api/remote/devices/[id]/revoke"
import { handleRemoteKill } from "../api/remote/kill"
import { handleRemoteTicket } from "../api/remote/ticket"
import { AccountRelay } from "../packages/relay/src/account-relay"
import { handleRequest } from "../packages/relay/src/index"
import { CLOSE } from "../packages/relay/src/protocol"
import type { Env } from "../packages/relay/src/runtime"
import { importTicketKeys, verifyTicket } from "../packages/relay/src/ticket"
import {
  FakeKV,
  FakeNamespace,
  FakeRuntime,
  type FakeSocket,
  type FakeState,
  type UpgradeResponse,
} from "../packages/relay/test/fakes"
import { ENTITLEMENTS, type EntitlementSnapshot } from "../packages/schema/src/codium-entitlements"
import type { PlanId } from "../packages/schema/src/codium-plan"
import { codiumFakes, codiumTestEnvironment, FAKE_KV_URL } from "../packages/web/test/fixture/codium-fakes"

// WP A40: Vector Remote's API. It decides who may connect to the relay and signs the tickets that let them; the relay
// (A39) admits a connection on a ticket alone. Here the API's routes run against the real relay Worker and its Durable
// Object, in memory (the relay package's own fakes, SQL on a real SQLite engine), so every ticket the API mints is
// checked by the relay's own code and every revocation is seen closing a socket. The store, the account service and
// the relay's runtime are fakes; nothing reaches a network, Stripe or Cloudflare.
//
// S6, server half: a revoked account cannot mint a ticket and its sockets close; paused and frozen plans suspend the
// relay; the owner's switch reaches the Worker's kill flag. S1: a pairing over the plan's count is refused whatever the
// request says. S3: run tokens are never accepted.

const SUPABASE = "https://accounts.remote-ticket.invalid"
const RELAY_HOST = "relay.remote-ticket.invalid"
const PHONE = "https://remote.vectordev.ai"
const INTERNAL_SECRET = "remote-ticket-fixture-internal-secret-".padEnd(48, "i")
const ACCOUNT_KEY = "remote-ticket-fixture-account-key-".padEnd(48, "a")
const OWNER = "owner@example.test"
const OWNER_ID = "0e0e0e0e-0000-4000-8000-0000000000ff"
const DAY = 86_400_000
// Half a second past a whole second, so "tickets issued before now" never falls on a boundary.
const NOW = Math.floor(Date.now() / 1000) * 1000 + 500

const PLUS = "a40a40a4-0000-4000-8000-000000000001"
const PRO = "a40a40a4-0000-4000-8000-000000000002"
const MAX = "a40a40a4-0000-4000-8000-000000000003"
const ULTRA = "a40a40a4-0000-4000-8000-000000000004"
const FREE = "a40a40a4-0000-4000-8000-000000000005"

const keys = generateKeyPairSync("ed25519")
const SIGNING_KEY = keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")
const PUBLIC_KEY = keys.publicKey.export({ format: "jwk" }).x!

const REMOTE_ENVIRONMENT = {
  NODE_ENV: "test",
  VECTOR_CLI_TOKEN_SECRET: "remote-ticket-fixture-cli-secret-".padEnd(48, "c"),
  VECTOR_ABUSE_SECRET: "remote-ticket-fixture-abuse-secret-".padEnd(48, "b"),
  SUPABASE_URL: SUPABASE,
  SUPABASE_PUBLISHABLE_KEY: "fixture-publishable-key",
  SUPABASE_ANON_KEY: undefined,
  VECTOR_ALLOWED_ORIGINS: undefined,
  VECTOR_PUBLIC_URL: undefined,
  VECTOR_ADMIN_EMAILS: OWNER,
  VECTOR_PHONE_APP_ORIGIN: PHONE,
  VECTOR_REMOTE_ENABLED: "true",
  VECTOR_REMOTE_TICKET_SIGNING_KEY: SIGNING_KEY,
  VECTOR_REMOTE_RELAY_URL: `wss://${RELAY_HOST}`,
  VECTOR_HOSTED_INTERNAL_SECRET: INTERNAL_SECRET,
}

// ── The relay Worker, in memory ─────────────────────────────────────────────────────────────────────────────────────

class Relay {
  readonly clock = { now: NOW }
  readonly runtime = new FakeRuntime(this.clock)
  readonly kv = new FakeKV()
  readonly namespace: FakeNamespace
  readonly env: Env
  readonly internal: string[] = []
  down = false

  constructor() {
    this.namespace = new FakeNamespace((state: FakeState) => new AccountRelay(state, this.env, this.runtime))
    this.env = {
      ACCOUNT_RELAY: this.namespace,
      REMOTE_FLAGS: this.kv,
      TICKET_PUBLIC_KEYS: PUBLIC_KEY,
      INTERNAL_SECRET,
      ACCOUNT_KEY,
    }
  }

  /** The API's signed calls arrive here, over https to the relay's host. */
  async fetch(url: URL, init?: RequestInit) {
    if (this.down) throw new Error("relay unreachable")
    this.internal.push(url.pathname.slice("/internal/v1/".length))
    return handleRequest(
      new Request(url, { method: init?.method, headers: init?.headers, body: init?.body }),
      this.env,
      this.runtime,
    )
  }

  /** A device opening the relay's WebSocket with a ticket, as the relay's own routing test does. */
  async connect(ticket: string) {
    const response = (await handleRequest(
      new Request(`https://${RELAY_HOST}/v1/connect`, {
        headers: { upgrade: "websocket", "sec-websocket-protocol": `vector.v1, ${ticket}` },
      }),
      this.env,
      this.runtime,
    )) as UpgradeResponse
    const socket = response.webSocket ? (this.runtime.servers.get(response.webSocket) as FakeSocket) : undefined
    return { status: response.status, socket }
  }
}

// ── Fakes and helpers ───────────────────────────────────────────────────────────────────────────────────────────────

let restore = () => {}
let fakes = codiumFakes({ now: NOW })
let relay = new Relay()
let apiNow = NOW
let supabaseCalls = 0
const sessions = new Map<string, { id: string; email: string; google?: boolean }>()

beforeEach(() => {
  restore = codiumTestEnvironment(REMOTE_ENVIRONMENT)
  fakes = codiumFakes({ now: NOW })
  relay = new Relay()
  apiNow = NOW
  supabaseCalls = 0
  sessions.clear()
})
afterEach(() => restore())

function advance(ms: number) {
  apiNow += ms
  relay.clock.now += ms
}

/** A new identity per call, so the 30-second switch cache (kept per fetcher) never carries over between calls. */
function fetcher(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.host === RELAY_HOST) return relay.fetch(url, init)
    if (url.origin === SUPABASE && url.pathname === "/auth/v1/user") {
      supabaseCalls++
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? ""
      const user = sessions.get(token)
      if (!user) return new Response("{}", { status: 401 })
      return Response.json({
        id: user.id,
        email: user.email,
        email_confirmed_at: "2026-01-01T00:00:00Z",
        identities: user.google
          ? [{ provider: "google", identity_data: { email: user.email, email_verified: true } }]
          : [{ provider: "email" }],
      })
    }
    // The account revocation list is written through the store's REST path (revocation.ts).
    if (url.origin === FAKE_KV_URL && url.pathname.startsWith("/set/")) {
      const [, , key, value] = url.pathname.split("/")
      fakes.store.set(decodeURIComponent(key!), value!)
      return Response.json({ result: "OK" })
    }
    return fakes.fetcher(input, init)
  }) as typeof fetch
}

const FACT_REASONS: Partial<Record<SnapshotFacts["state"], SnapshotFacts["reason"]>> = {
  paused: "payment_failed",
  frozen: "disputed",
  ended: "canceled",
}

function snapshotFor(
  account: string,
  plan: PlanId | null,
  state: SnapshotFacts["state"] = "active",
  options: { reason?: SnapshotFacts["reason"]; previous?: EntitlementSnapshot; at?: number } = {},
) {
  const at = options.at ?? apiNow
  const reason = options.reason ?? FACT_REASONS[state]
  return buildSnapshot(
    {
      account,
      state,
      ...(reason ? { reason } : {}),
      plan,
      ...(plan ? { subscription: `sub_fixture${account.slice(-4)}` } : {}),
      periodStart: state === "renewing" ? NOW - 30 * DAY : NOW - DAY,
      periodEnd: state === "renewing" ? NOW - 60_000 : NOW + 29 * DAY,
      cancelAtPeriodEnd: false,
      source: "webhook",
    },
    options.previous,
    at,
  )
}

function seed(account: string, plan: PlanId | null, state: SnapshotFacts["state"] = "active") {
  const snapshot = snapshotFor(account, plan, state)
  fakes.store.set(snapshotKey(account), JSON.stringify(snapshot))
  return snapshot
}

const desktop = (account: string, client: "desktop" | "cli" | "unmarked" = "desktop") =>
  mintCliToken(
    { id: account, email: `${account.slice(-4)}@example.invalid` },
    Date.now(),
    client === "unmarked" ? undefined : client,
  ).token

function session(account: string) {
  const token = `session-${account}`
  sessions.set(token, { id: account, email: `${account.slice(-4)}@example.invalid` })
  return token
}

const device = (seed: number) => Buffer.alloc(16, seed).toString("base64url")

type Answer = { status: number; headers: Record<string, string>; body: any }

function invoke(
  handler: (request: ApiRequest, response: ApiResponse) => Promise<void>,
  input: { method: string; authorization?: string; origin?: string; body?: unknown; query?: Record<string, string> },
): Promise<Answer> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": "192.0.2.40",
    ...(input.authorization ? { authorization: `Bearer ${input.authorization}` } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
  }
  const request = Object.assign(Readable.from([]), {
    method: input.method,
    headers,
    url: "/api/remote",
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.query ? { query: input.query } : {}),
  }) as unknown as ApiRequest
  return new Promise((resolve, reject) => {
    const out: Record<string, string> = {}
    const response = {
      statusCode: 200,
      setHeader(name: string, value: unknown) {
        out[name.toLowerCase()] = String(value)
        return response
      },
      end(value?: string) {
        resolve({ status: response.statusCode, headers: out, body: value ? JSON.parse(value) : undefined })
        return response
      },
    }
    void handler(request, response as unknown as ApiResponse).catch(reject)
  })
}

function ticket(authorization: string | undefined, body: Record<string, unknown>, options: { origin?: string } = {}) {
  return invoke((request, response) => handleRemoteTicket(request, response, fetcher(), () => apiNow), {
    method: "POST",
    ...(authorization ? { authorization } : {}),
    ...options,
    body,
  })
}

const computerTicket = (account: string, dev = device(1), extra: Record<string, unknown> = {}) =>
  ticket(desktop(account), { role: "computer", device: dev, name: "Studio Mac", ...extra })
const phoneTicket = (account: string, dev = device(9)) =>
  ticket(session(account), { role: "phone", device: dev, name: "Pixel" }, { origin: PHONE })

function claims(text: string) {
  return JSON.parse(Buffer.from(text.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>
}

async function connected(account: string, dev: string, role: "computer" | "phone" = "computer") {
  const answer = role === "computer" ? await computerTicket(account, dev) : await phoneTicket(account, dev)
  expect(answer.status).toBe(200)
  const opened = await relay.connect(answer.body.ticket)
  expect(opened.status).toBe(101)
  expect(opened.socket?.closed).toBeUndefined()
  return opened.socket!
}

const off = (name: "remote") =>
  fakes.store.set(switchKey(name), JSON.stringify({ value: "off", changedAt: NOW, generation: "g1", offSince: NOW }))

// ── Tickets ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("tickets", () => {
  test("a computer gets a ticket the relay accepts, with the caps from the snapshot and not from the request", async () => {
    const snapshot = seed(PLUS, "vector-10")
    const answer = await computerTicket(PLUS, device(1), {
      computers: 5,
      viewerHours: 1000,
      plan: "vector-200",
      periodEnd: NOW + 400 * DAY,
    })
    expect(answer.status).toBe(200)
    const iat = Math.floor(NOW / 1000)
    expect(answer.body).toEqual({
      ticket: expect.stringMatching(/^vt1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/),
      url: `wss://${RELAY_HOST}/v1/connect`,
      protocol: "vector.v1",
      expiresAt: (iat + 300) * 1000,
    })
    const check = await verifyTicket(answer.body.ticket, await importTicketKeys(PUBLIC_KEY), relay.clock.now)
    expect(check).toEqual({
      ok: true,
      claims: {
        v: 1,
        aud: "vector-relay",
        sub: PLUS,
        role: "computer",
        dev: device(1),
        name: "Studio Mac",
        computers: ENTITLEMENTS["vector-10"].remote.computers,
        viewerHours: REMOTE_LIMITS.viewerHours["vector-10"],
        epoch: relayEpoch(snapshot.meterEpoch),
        periodEnd: snapshot.periodEnd,
        iat,
        exp: iat + 300,
        jti: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      },
    })
    // No Stripe id reaches the relay: the epoch is a hash of `<subscription>:<periodStart>`.
    expect(snapshot.meterEpoch).toStartWith("sub_")
    expect(relayEpoch(snapshot.meterEpoch)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Object.values(claims(answer.body.ticket))).not.toContain(snapshot.meterEpoch)
    expect(Object.values(claims(answer.body.ticket))).not.toContain(snapshot.subscription)
    const opened = await relay.connect(answer.body.ticket)
    expect(opened.status).toBe(101)
    expect(opened.socket?.closed).toBeUndefined()
    // M4: a fresh snapshot is enough; Stripe is never asked.
    expect(fakes.stripe.calls).toEqual([])
  })

  test("each plan's ticket carries its own paired computers and viewer-hours", async () => {
    for (const [account, plan] of [
      [PLUS, "vector-10"],
      [PRO, "vector-50"],
      [MAX, "vector-100"],
      [ULTRA, "vector-200"],
    ] as const) {
      seed(account, plan)
      const answer = await computerTicket(account)
      expect(answer.status).toBe(200)
      expect(claims(answer.body.ticket)).toMatchObject({
        computers: ENTITLEMENTS[plan].remote.computers,
        viewerHours: REMOTE_LIMITS.viewerHours[plan],
      })
    }
  })

  test("every ticket is new: its own id, and a ticket is good for one connection", async () => {
    seed(PRO, "vector-50")
    const first = await computerTicket(PRO)
    const second = await computerTicket(PRO)
    expect(claims(first.body.ticket).jti).not.toBe(claims(second.body.ticket).jti)
    expect((await relay.connect(first.body.ticket)).socket?.closed).toBeUndefined()
    // The relay refuses a ticket it has already seen.
    const again = await relay.connect(first.body.ticket)
    expect(again.socket?.closed?.code ?? again.status).not.toBe(101)
  })

  test("a phone needs a website session sent from the phone app's origin", async () => {
    seed(PRO, "vector-50")
    const phone = await phoneTicket(PRO)
    expect(phone.status).toBe(200)
    expect(claims(phone.body.ticket)).toMatchObject({ role: "phone", dev: device(9), name: "Pixel" })
    expect((await relay.connect(phone.body.ticket)).socket?.closed).toBeUndefined()

    const body = { role: "phone", device: device(8) }
    for (const origin of ["https://vectordev.ai", undefined]) {
      const answer = await ticket(session(PRO), body, origin ? { origin } : {})
      expect(answer).toMatchObject({ status: 403, body: { error: { code: "REMOTE_PHONE_APP_REQUIRED" } } })
    }
    // The desktop's sign-in cannot connect a phone, and a website session cannot connect a computer.
    expect(await ticket(desktop(PRO), body, { origin: PHONE })).toMatchObject({
      status: 403,
      body: { error: { code: "REMOTE_PHONE_APP_REQUIRED" } },
    })
    expect(await ticket(session(PRO), { role: "computer", device: device(7) }, { origin: PHONE })).toMatchObject({
      status: 403,
      body: { error: { code: "DESKTOP_SIGN_IN_REQUIRED" } },
    })
    // Another site's page cannot ask at all.
    expect(await ticket(session(PRO), body, { origin: "https://evil.example" })).toMatchObject({
      status: 403,
      body: { error: { code: "ORIGIN_NOT_ALLOWED" } },
    })
    // Without the phone origin configured there is no phone app to connect from.
    delete process.env.VECTOR_PHONE_APP_ORIGIN
    expect(await ticket(session(PRO), body)).toMatchObject({
      status: 503,
      body: { error: { code: "REMOTE_UNAVAILABLE" } },
    })
  })

  test("pasted CLI tokens and old unmarked tokens are refused, and run tokens never reach the account service (S3)", async () => {
    seed(PRO, "vector-50")
    const body = { role: "computer", device: device(1) }
    for (const client of ["cli", "unmarked"] as const)
      expect(await ticket(desktop(PRO, client), body)).toMatchObject({
        status: 403,
        body: { error: { code: "DESKTOP_SIGN_IN_REQUIRED" } },
      })
    for (const token of ["vrt_fixture.signature", "vht_fixture.signature"])
      expect(await ticket(token, body)).toMatchObject({ status: 401, body: { error: { code: "SIGN_IN_REQUIRED" } } })
    expect(await ticket(undefined, body)).toMatchObject({ status: 401, body: { error: { code: "SIGN_IN_REQUIRED" } } })
    expect(supabaseCalls).toBe(0)
    expect(await ticket("not-a-session", { role: "phone", device: device(2) }, { origin: PHONE })).toMatchObject({
      status: 401,
      body: { error: { code: "SESSION_INVALID" } },
    })
  })

  test("the body is checked: role, a 16-byte device id, a plain name and a public key", () => {
    expect(parseTicketRequest({ role: "phone", device: device(3), name: "  Pixel  ", key: "k".repeat(43) })).toEqual({
      role: "phone",
      device: device(3),
      name: "Pixel",
      key: "k".repeat(43),
    })
    for (const body of [
      null,
      [],
      { role: "viewer", device: device(3) },
      { role: "phone" },
      { role: "phone", device: "short" },
      { role: "phone", device: `${device(3)}x` },
      { role: "phone", device: device(3), name: "" },
      { role: "phone", device: device(3), name: "x".repeat(65) },
      { role: "phone", device: device(3), name: "Line\nbreak" },
      { role: "phone", device: device(3), name: "Reads‮backwards" },
      { role: "phone", device: device(3), name: 7 },
      { role: "phone", device: device(3), key: "short" },
      { role: "phone", device: device(3), key: "has space and more than thirty two characters" },
    ])
      expect(() => parseTicketRequest(body)).toThrow("Check the device details")
  })

  test("refused when the plan is not active or renewing, is frozen, or has no paired computers", async () => {
    const cases: [SnapshotFacts["state"], PlanId | null, number, string][] = [
      ["none", null, 402, "MODEL_PLAN_REQUIRED"],
      ["paused", "vector-50", 402, "MODEL_PLAN_PAYMENT_REQUIRED"],
      ["ended", "vector-50", 402, "MODEL_PLAN_REQUIRED"],
      ["frozen", "vector-50", 403, "MODEL_PLAN_BLOCKED"],
    ]
    for (const [state, plan, status, code] of cases) {
      seed(PRO, plan, state)
      expect(await computerTicket(PRO)).toMatchObject({ status, body: { error: { code } } })
    }
    // §4.4: Remote stays on while a renewal is being paid, within the grace.
    seed(PRO, "vector-50", "renewing")
    expect((await computerTicket(PRO)).status).toBe(200)
    // A plan whose caps pair no computer (none does today) is refused by the perk, naming the cheapest plan with it.
    const none = snapshotFor(PRO, "vector-50")
    fakes.store.set(snapshotKey(PRO), JSON.stringify({ ...none, caps: { ...none.caps, remote: { computers: 0 } } }))
    expect(await computerTicket(PRO)).toMatchObject({
      status: 403,
      body: { error: { code: "CODIUM_PERK_REQUIRED", perk: "remote", plan: "vector-10" } },
    })
  })

  test("refused while Remote is not configured or the owner's switch is off", async () => {
    seed(PRO, "vector-50")
    expect(remoteConfigured()).toBe(true)
    off("remote")
    expect(await computerTicket(PRO)).toMatchObject({ status: 503, body: { error: { code: "REMOTE_UNAVAILABLE" } } })
    fakes.store.set(switchKey("remote"), JSON.stringify({ value: "on", changedAt: NOW, generation: "g2" }))
    expect((await computerTicket(PRO)).status).toBe(200)
    const settings: Record<string, string | undefined>[] = [
      { VECTOR_REMOTE_ENABLED: undefined },
      { VECTOR_REMOTE_ENABLED: "1" },
      { VECTOR_REMOTE_TICKET_SIGNING_KEY: undefined },
      { VECTOR_REMOTE_TICKET_SIGNING_KEY: "not-a-key" },
      // An RSA or P-256 key is not a ticket key.
      {
        VECTOR_REMOTE_TICKET_SIGNING_KEY: generateKeyPairSync("ec", { namedCurve: "P-256" })
          .privateKey.export({ format: "der", type: "pkcs8" })
          .toString("base64url"),
      },
      { VECTOR_REMOTE_RELAY_URL: undefined },
      { VECTOR_REMOTE_RELAY_URL: `https://${RELAY_HOST}` },
      { VECTOR_REMOTE_RELAY_URL: `wss://${RELAY_HOST}/v1/connect` },
      { VECTOR_REMOTE_RELAY_URL: `wss://user:pass@${RELAY_HOST}` },
      { VECTOR_REMOTE_RELAY_URL: `ws://${RELAY_HOST}` },
      { VECTOR_HOSTED_INTERNAL_SECRET: undefined },
      { VECTOR_HOSTED_INTERNAL_SECRET: "too-short" },
    ]
    for (const setting of settings) {
      const saved = Object.fromEntries(Object.keys(setting).map((name) => [name, process.env[name]]))
      for (const [name, value] of Object.entries(setting)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      expect(remoteConfigured()).toBe(false)
      expect(await computerTicket(PRO)).toMatchObject({
        status: 503,
        body: { error: { code: "REMOTE_UNAVAILABLE" } },
      })
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
    expect(ticketSigningKey()?.asymmetricKeyType).toBe("ed25519")
  })

  test("a local relay over plain ws: is accepted only outside production", () => {
    process.env.VECTOR_REMOTE_RELAY_URL = "ws://localhost:8787"
    expect(relayAddress()?.socket).toBe("ws://localhost:8787/v1/connect")
    expect(relayAddress()?.internal.href).toBe("http://localhost:8787/")
    process.env.VECTOR_REMOTE_RELAY_URL = `wss://${RELAY_HOST}/`
    expect(relayAddress()?.internal.href).toBe(`https://${RELAY_HOST}/`)
    process.env.VECTOR_REMOTE_RELAY_URL = "ws://localhost:8787"
    process.env.VERCEL_ENV = "production"
    expect(relayAddress()).toBeUndefined()
  })

  test("over the plan's paired computers, the relay refuses the pairing whatever the client asks (S1)", async () => {
    seed(PLUS, "vector-10")
    await connected(PLUS, device(1))
    const second = await computerTicket(PLUS, device(2), { computers: 5 })
    expect(second.status).toBe(200)
    const opened = await relay.connect(second.body.ticket)
    expect(opened.socket?.closed?.code).toBe(CLOSE.REMOTE_DEVICE_LIMIT)
  })
})

// ── Revocation (S6, server half) ────────────────────────────────────────────────────────────────────────────────────

describe("revocation", () => {
  test("a revoked account cannot mint a ticket, and its relay sockets close", async () => {
    seed(PRO, "vector-50")
    const computer = await connected(PRO, device(1))
    const phone = await connected(PRO, device(9), "phone")
    expect(await revokeAccountTokens(PRO, fetcher())).toBe(true)
    expect(fakes.store.get(`vector:cli-revoked:${PRO}`)).toBe("1")
    expect(computer.closed?.code).toBe(CLOSE.REMOTE_REVOKED)
    expect(phone.closed?.code).toBe(CLOSE.REMOTE_REVOKED)
    expect(relay.internal).toEqual(["kill"])
    advance(2_000)
    expect(await computerTicket(PRO, device(1))).toMatchObject({
      status: 401,
      body: { error: { code: "CLI_TOKEN_INVALID" } },
    })
    expect(await phoneTicket(PRO, device(9))).toMatchObject({
      status: 401,
      body: { error: { code: "CLI_TOKEN_INVALID" } },
    })
  })

  test("revocation still succeeds when the relay cannot be reached or Remote is not configured", async () => {
    relay.down = true
    expect(await revokeAccountTokens(PRO, fetcher())).toBe(true)
    expect(await killRelaySessions(PRO, fetcher())).toBe(false)
    delete process.env.VECTOR_REMOTE_RELAY_URL
    relay.down = false
    expect(await revokeAccountTokens(PLUS, fetcher())).toBe(true)
    expect(relay.internal).toEqual([])
  })

  test("Disconnect all closes every connection and refuses tickets issued before it", async () => {
    seed(MAX, "vector-100")
    const one = await connected(MAX, device(1))
    const two = await connected(MAX, device(2))
    const phone = await connected(MAX, device(9), "phone")
    const unused = await computerTicket(MAX, device(3))
    const kill = await invoke((request, response) => handleRemoteKill(request, response, fetcher(), () => apiNow), {
      method: "POST",
      authorization: desktop(MAX),
      body: {},
    })
    expect(kill).toMatchObject({ status: 200, body: { revokedBefore: NOW, closed: 3 } })
    for (const socket of [one, two, phone]) expect(socket.closed?.code).toBe(CLOSE.REMOTE_REVOKED)
    expect((await relay.connect(unused.body.ticket)).socket?.closed?.code).toBe(CLOSE.REMOTE_REVOKED)
    // A second later the devices connect again with new tickets; they stay paired.
    advance(1_000)
    await connected(MAX, device(1))
    // A website session can disconnect everything too; a run token cannot.
    expect(
      await invoke((request, response) => handleRemoteKill(request, response, fetcher(), () => apiNow), {
        method: "POST",
        authorization: session(MAX),
        origin: PHONE,
        body: {},
      }),
    ).toMatchObject({ status: 200, body: { closed: 1 } })
    expect(
      await invoke((request, response) => handleRemoteKill(request, response, fetcher(), () => apiNow), {
        method: "POST",
        authorization: "vrt_fixture.signature",
        body: {},
      }),
    ).toMatchObject({ status: 401 })
  })
})

// ── Devices ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function devices(authorization: string) {
  return invoke((request, response) => handleRemoteDevices(request, response, fetcher(), () => apiNow), {
    method: "GET",
    authorization,
  })
}

function revoke(authorization: string, id: string) {
  return invoke((request, response) => handleRemoteRevoke(request, response, fetcher(), () => apiNow), {
    method: "POST",
    authorization,
    body: {},
    query: { id },
  })
}

describe("devices", () => {
  test("lists the paired devices in pairing order, and revoking one closes it and refuses its id for good", async () => {
    seed(PRO, "vector-50")
    const studio = await connected(PRO, device(1))
    advance(1_000)
    await connected(PRO, device(2))
    advance(1_000)
    await connected(PRO, device(9), "phone")
    const listed = await devices(desktop(PRO))
    expect(listed.status).toBe(200)
    expect(listed.body).toEqual({
      devices: [
        expect.objectContaining({
          device: device(1),
          role: "computer",
          name: "Studio Mac",
          online: true,
          overLimit: false,
        }),
        expect.objectContaining({ device: device(2), role: "computer", online: true, overLimit: false }),
        expect.objectContaining({ device: device(9), role: "phone", name: "Pixel", online: true, overLimit: false }),
      ],
      limits: { computers: ENTITLEMENTS["vector-50"].remote.computers, phones: REMOTE_LIMITS.phones },
      fairUse: "ok",
      available: true,
    })
    expect(listed.body.devices[0].pairedAt).toBeLessThan(listed.body.devices[1].pairedAt)

    expect(await revoke(session(PRO), device(1))).toMatchObject({ status: 200, body: { revoked: true, closed: 1 } })
    expect(studio.closed?.code).toBe(CLOSE.REMOTE_REVOKED)
    const again = await computerTicket(PRO, device(1))
    expect((await relay.connect(again.body.ticket)).socket?.closed?.code).toBe(CLOSE.REMOTE_REVOKED)
    expect((await devices(session(PRO))).body.devices.map((entry: { device: string }) => entry.device)).toEqual([
      device(2),
      device(9),
    ])
    expect(await revoke(desktop(PRO), "not-a-device")).toMatchObject({
      status: 400,
      body: { error: { code: "REMOTE_DEVICE_INVALID" } },
    })
  })

  test("listing and revoking work whatever the plan, and the limit is the plan's while it allows Remote", async () => {
    seed(PRO, "vector-50")
    await connected(PRO, device(1))
    await connected(PRO, device(2))
    seed(PRO, "vector-50", "paused")
    const paused = await devices(desktop(PRO))
    expect(paused.body).toMatchObject({ limits: { computers: 0, phones: 5 }, available: false })
    expect(paused.body.devices.map((entry: { overLimit: boolean }) => entry.overLimit)).toEqual([true, true])
    expect((await revoke(desktop(PRO), device(2))).status).toBe(200)
    // An account that never had a plan has nothing at the relay, so it is not asked.
    seed(FREE, null, "none")
    relay.internal.length = 0
    expect((await devices(desktop(FREE))).body).toEqual({
      devices: [],
      limits: { computers: 0, phones: 5 },
      fairUse: "ok",
      available: false,
    })
    expect(relay.internal).toEqual([])
  })

  test("refuses run tokens and pasted CLI tokens, and answers 503 when the relay cannot be reached", async () => {
    seed(PRO, "vector-50")
    expect(await devices("vht_fixture.signature")).toMatchObject({ status: 401 })
    expect(await devices(desktop(PRO, "cli"))).toMatchObject({
      status: 403,
      body: { error: { code: "DESKTOP_SIGN_IN_REQUIRED" } },
    })
    relay.down = true
    expect(await devices(desktop(PRO))).toMatchObject({ status: 503, body: { error: { code: "REMOTE_UNAVAILABLE" } } })
    expect(await revoke(desktop(PRO), device(1))).toMatchObject({ status: 503 })
  })
})

// ── The remote provisioner (§4.4's Remote relay row) ────────────────────────────────────────────────────────────────

describe("remote provisioner", () => {
  test("is in the provisioner list and configured exactly while the relay can be called", () => {
    expect(PROVISIONERS.map((provisioner) => provisioner.id)).toContain("remote")
    expect(remoteProvisioner.configured()).toBe(true)
    delete process.env.VECTOR_REMOTE_RELAY_URL
    expect(relayConfigured()).toBe(false)
    expect(remoteProvisioner.configured()).toBe(false)
  })

  test("paused suspends, active lifts, frozen revokes, and account deletion erases", async () => {
    const active = seed(PRO, "vector-50")
    const first = await connected(PRO, device(1))
    const spare = await computerTicket(PRO, device(2))

    advance(1_000)
    const paused = snapshotFor(PRO, "vector-50", "paused", { previous: active })
    await remoteProvisioner.apply({ account: PRO, from: active, to: paused, cause: "payment_failed" }, fetcher())
    expect(first.closed?.code).toBe(CLOSE.REMOTE_PAUSED)
    expect((await relay.connect(spare.body.ticket)).socket?.closed?.code).toBe(CLOSE.REMOTE_PAUSED)

    advance(1_000)
    const recovered = snapshotFor(PRO, "vector-50", "active", { previous: paused })
    fakes.store.set(snapshotKey(PRO), JSON.stringify(recovered))
    await remoteProvisioner.apply({ account: PRO, from: paused, to: recovered, cause: "payment_recovered" }, fetcher())
    const back = await connected(PRO, device(2))

    advance(1_000)
    const frozen = snapshotFor(PRO, "vector-50", "frozen", { previous: recovered })
    expect(frozen.revokedBefore).toBe(apiNow)
    relay.internal.length = 0
    await remoteProvisioner.apply({ account: PRO, from: recovered, to: frozen, cause: "disputed" }, fetcher())
    expect(relay.internal).toEqual(["kill", "suspend"])
    expect(back.closed?.code).toBe(CLOSE.REMOTE_REVOKED)
    expect(relaySuspension(frozen)).toBe("frozen")
    expect(relaySuspension(snapshotFor(PRO, "vector-50", "frozen", { reason: "owner" }))).toBe("owner")

    advance(1_000)
    const closing = snapshotFor(PRO, "vector-50", "ended", { reason: "closing", previous: frozen })
    await remoteProvisioner.apply({ account: PRO, from: frozen, to: closing, cause: "closing" }, fetcher())
    expect((await relayDevices(PRO, fetcher(), apiNow)).devices).toEqual([])
  })

  test("an ended plan closes connections from earlier tickets and lifts any suspension for a returning subscriber", async () => {
    const active = seed(MAX, "vector-100")
    const socket = await connected(MAX, device(1))
    const paused = snapshotFor(MAX, "vector-100", "paused", { previous: active })
    await remoteProvisioner.apply({ account: MAX, from: active, to: paused, cause: "payment_failed" }, fetcher())
    advance(1_000)
    const ended = snapshotFor(MAX, "vector-100", "ended", { previous: paused })
    relay.internal.length = 0
    await remoteProvisioner.apply({ account: MAX, from: paused, to: ended, cause: "ended" }, fetcher())
    expect(relay.internal).toEqual(["kill", "suspend"])
    expect(socket.closed).toBeDefined()
    advance(1_000)
    seed(MAX, "vector-100")
    await connected(MAX, device(1))
  })

  test("asks the relay only when the change needs it, and always when the previous state is unknown", async () => {
    const none = snapshotFor(ULTRA, null, "none")
    const active = snapshotFor(ULTRA, "vector-200", "active", { previous: none })
    await remoteProvisioner.apply({ account: ULTRA, from: none, to: active, cause: "first_payment" }, fetcher())
    const renewing = snapshotFor(ULTRA, "vector-200", "renewing", { previous: active })
    await remoteProvisioner.apply({ account: ULTRA, from: active, to: renewing, cause: "renewal" }, fetcher())
    await remoteProvisioner.apply({ account: ULTRA, to: none, cause: "owner" }, fetcher())
    expect(relay.internal).toEqual([])
    // The daily sweep's catch-up carries no previous snapshot: the relay is told the current state.
    await remoteProvisioner.apply({ account: ULTRA, to: active, cause: "owner" }, fetcher())
    expect(relay.internal).toEqual(["suspend"])
  })

  test("a relay that cannot be reached fails the item, so the outbox retries it", async () => {
    const active = seed(PRO, "vector-50")
    const paused = snapshotFor(PRO, "vector-50", "paused", { previous: active })
    relay.down = true
    await expect(
      remoteProvisioner.apply({ account: PRO, from: active, to: paused, cause: "payment_failed" }, fetcher()),
    ).rejects.toMatchObject({ code: "REMOTE_UNAVAILABLE" })
  })
})

// ── The owner's switch and the Worker's kill flag ───────────────────────────────────────────────────────────────────

function ownerToken() {
  const token = `fixture.${Buffer.from(JSON.stringify({ amr: [{ method: "oauth", timestamp: Math.floor(apiNow / 1000) }], iat: Math.floor(apiNow / 1000) })).toString("base64url")}.fixture`
  sessions.set(token, { id: OWNER_ID, email: OWNER, google: true })
  return token
}

function ownerSwitch(value: "on" | "off") {
  return invoke((request, response) => handleCodiumOwner(request, response, "switch", fetcher(), apiNow), {
    method: "POST",
    authorization: ownerToken(),
    origin: "https://vectordev.ai",
    body: { name: "remote", value },
  })
}

describe("the remote switch", () => {
  test("turning it off sets the relay's kill flag, which closes new connections; on clears it", async () => {
    seed(PRO, "vector-50")
    const early = await computerTicket(PRO, device(1))
    expect(await ownerSwitch("off")).toMatchObject({ status: 200, body: { accepted: true, relay: "updated" } })
    expect(relay.kv.values.get("kill")).toBe("1")
    expect((await relay.connect(early.body.ticket)).socket?.closed?.code).toBe(CLOSE.RELAY_OFF)
    expect(await computerTicket(PRO, device(2))).toMatchObject({ status: 503 })
    expect(await ownerSwitch("on")).toMatchObject({ status: 200, body: { relay: "updated" } })
    expect(relay.kv.values.has("kill")).toBe(false)
    await connected(PRO, device(2))
  })

  test("an unreachable relay does not undo the switch; the owner is told", async () => {
    relay.down = true
    expect(await ownerSwitch("off")).toMatchObject({ status: 200, body: { accepted: true, relay: "failed" } })
    expect(JSON.parse(fakes.store.get(switchKey("remote"))!)).toMatchObject({ value: "off" })
    delete process.env.VECTOR_REMOTE_RELAY_URL
    expect(await syncRelayKillFlag(true, fetcher())).toBe("not-configured")
    expect((await ownerSwitch("on")).body).toMatchObject({ relay: "not-configured" })
  })
})

// ── Presence and GitHub runs ────────────────────────────────────────────────────────────────────────────────────────

describe("presence", () => {
  test("isComputerOnline follows the relay, and treats an unreachable or unconfigured relay as offline", async () => {
    seed(PRO, "vector-50")
    expect(await isComputerOnline(PRO, fetcher(), apiNow)).toBe(false)
    await connected(PRO, device(9), "phone")
    expect(await isComputerOnline(PRO, fetcher(), apiNow)).toBe(false)
    await connected(PRO, device(1))
    expect(await isComputerOnline(PRO, fetcher(), apiNow)).toBe(true)
    relay.down = true
    expect(await isComputerOnline(PRO, fetcher(), apiNow)).toBe(false)
    relay.down = false
    delete process.env.VECTOR_HOSTED_INTERNAL_SECRET
    expect(await isComputerOnline(PRO, fetcher(), apiNow)).toBe(false)
  })
})

const CODEX_RUN = {
  rid: "gh-101-202-1-1",
  repository: "octo/app",
  repositoryId: "101",
  runUrl: "https://github.com/octo/app/actions/runs/202",
  event: "issue_comment",
  source: "github-comment",
  purpose: "task",
  startedAt: NOW - 60_000,
  endedAt: NOW - 30_000,
  outcome: "pr-opened",
  verdict: "pass",
  actor: { login: "octocat", id: "1" },
  // Fields a record could carry that the phone must never see.
  account: PRO,
  jti: "j".repeat(22),
  generation: "3",
  usage: 0.42,
  plan: "vector-50",
}

function runs(authorization: string, reader?: CloudRunReader, query?: Record<string, string>) {
  return invoke((request, response) => handleRemoteCloudRuns(request, response, fetcher(), () => apiNow, reader), {
    method: "GET",
    authorization,
    ...(query ? { query } : {}),
  })
}

describe("GitHub runs", () => {
  test("every paid plan lists its runs, with only what the phone may show", async () => {
    let asked: { account: string; limit: number } | undefined
    const reader: CloudRunReader = async (account, input) => {
      asked = { account, ...input }
      return [CODEX_RUN, { ...CODEX_RUN, rid: "bad id with spaces" }, { rid: "gh-1-2-1-1" }]
    }
    for (const [account, plan] of [
      [PLUS, "vector-10"],
      [PRO, "vector-50"],
      [MAX, "vector-100"],
      [ULTRA, "vector-200"],
    ] as const) {
      seed(account, plan)
      const answer = await runs(desktop(account), reader, { limit: "5" })
      expect(answer.status).toBe(200)
      expect(asked).toEqual({ account, limit: 5 })
      expect(answer.body).toEqual({
        runs: [
          {
            id: "gh-101-202-1-1",
            repository: "octo/app",
            url: "https://github.com/octo/app/actions/runs/202",
            event: "issue_comment",
            source: "github-comment",
            purpose: "task",
            startedAt: NOW - 60_000,
            endedAt: NOW - 30_000,
            outcome: "pr-opened",
            verdict: "pass",
            actor: { login: "octocat" },
          },
        ],
        available: true,
      })
      // P1, P6: no usage, plan, account, amount or Stripe id.
      expect(JSON.stringify(answer.body)).not.toMatch(/usage|plan|vector-\d|sub_|\$|usd|credit|a40a40a4/i)
    }
  })

  test("before the integration commit registers Codex's records, the list is empty and says so", async () => {
    seed(PRO, "vector-50")
    expect(await runs(session(PRO))).toMatchObject({ status: 200, body: { runs: [], available: false } })
  })

  test("refused without a plan that allows Remote, while Remote is off, or for a bad limit", async () => {
    const reader: CloudRunReader = async () => [CODEX_RUN]
    seed(FREE, null, "none")
    expect(await runs(desktop(FREE), reader)).toMatchObject({ status: 402 })
    seed(PRO, "vector-50", "paused")
    expect(await runs(desktop(PRO), reader)).toMatchObject({
      status: 402,
      body: { error: { code: "MODEL_PLAN_PAYMENT_REQUIRED" } },
    })
    seed(PRO, "vector-50")
    for (const limit of ["0", "51", "abc", "1e1"])
      expect(await runs(desktop(PRO), reader, { limit })).toMatchObject({
        status: 400,
        body: { error: { code: "REMOTE_RUNS_LIMIT" } },
      })
    off("remote")
    expect(await runs(desktop(PRO), reader)).toMatchObject({ status: 503 })
  })

  test("a reader that fails gives 503, and malformed records never pass", async () => {
    seed(PRO, "vector-50")
    expect(
      await runs(desktop(PRO), async () => {
        throw new Error("store down")
      }),
    ).toMatchObject({ status: 503, body: { error: { code: "REMOTE_RUNS_UNAVAILABLE" } } })
    for (const record of [
      { ...CODEX_RUN, source: "slack" },
      { ...CODEX_RUN, startedAt: "yesterday" },
      { ...CODEX_RUN, event: "Issue Comment" },
      null,
      "gh-101-202-1-1",
    ])
      expect(publicCloudRun(record)).toBeUndefined()
    expect(publicCloudRun({ ...CODEX_RUN, runUrl: "https://evil.example/octo/app/actions/runs/1" })).not.toHaveProperty(
      "url",
    )
    expect(publicCloudRun({ ...CODEX_RUN, actor: { login: "bad login!" } })).not.toHaveProperty("actor")
  })
})

// ── P1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("no amount, plan name or Stripe id leaves the ticket or devices routes (P1)", async () => {
  seed(ULTRA, "vector-200")
  const minted = await computerTicket(ULTRA)
  await relay.connect(minted.body.ticket)
  const listed = await devices(desktop(ULTRA))
  // The ticket, the epoch and the ticket id are base64url (random-looking text), checked by form instead.
  const { ticket: text, ...rest } = minted.body
  const { epoch, jti, ...fields } = claims(text)
  expect(epoch).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(jti).toMatch(/^[A-Za-z0-9_-]{22}$/)
  expect(Object.keys(rest).sort()).toEqual(["expiresAt", "protocol", "url"])
  for (const scanned of [JSON.stringify(rest), JSON.stringify(fields), JSON.stringify(listed.body)])
    expect(scanned).not.toMatch(/sub_|\$|usd|credit|cents|vector-200|ultra/i)
})
