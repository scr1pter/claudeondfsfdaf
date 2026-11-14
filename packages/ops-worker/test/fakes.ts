// An in-memory stand-in for the parts of Cloudflare's runtime the ops Worker uses. The SQL runs on a real SQLite engine
// (bun:sqlite, tests only), so the statements the object sends are exercised as written, and the outbound fetch is a
// scripted network: DNS-over-HTTPS answers, the sites being probed, and the API taking reports. The CI smoke test
// (e2e/ops-smoke.mjs) runs the same code on Cloudflare's local runtime through miniflare.

import { Database } from "bun:sqlite"
import { ENTITLEMENTS } from "../../schema/src/codium-entitlements"
import { base64url } from "../src/bytes"
import { OpsAccount } from "../src/ops-account"
import type { OpsPlan } from "../src/protocol"
import type {
  DurableObjectId,
  DurableObjectNamespace,
  DurableObjectState,
  DurableObjectStorage,
  Env,
  KVNamespace,
  Runtime,
  SqlCursor,
  SqlStorage,
  SqlValue,
} from "../src/runtime"
import { DOH_ENDPOINT } from "../src/ssrf"

export const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)
export const DAY = 24 * 60 * 60_000
export const ACCOUNT = "acct_ops_fixture_0001"
export const ACCOUNT_KEY = "ops-account-fixture-key-".padEnd(48, "k")
export const INTERNAL_SECRET = "ops-internal-fixture-secret-".padEnd(48, "s")
export const API_ORIGIN = "https://vectordev.ai"
export const SHA = (digit: string) => digit.repeat(40)

/** The plan the API would push for a plan id: its private ops caps from ENTITLEMENTS. */
export function planFor(id: "vector-100" | "vector-200", overrides: Partial<OpsPlan> = {}): OpsPlan {
  const ops = ENTITLEMENTS[id].ops!
  return {
    version: 1,
    domains: ops.onCall.domains,
    onCall: { urls: ops.onCall.urls, intervalSec: ops.onCall.intervalSec },
    releaseGuard: { ...ops.releaseGuard },
    validUntil: NOW + 31 * DAY,
    ...overrides,
  }
}

class FakeSql implements SqlStorage {
  private db = new Database(":memory:")

  exec<Row extends Record<string, SqlValue> = Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): SqlCursor<Row> {
    const rows = this.db.query(query).all(...(bindings as Array<string | number | null>)) as Row[]
    return { toArray: () => rows }
  }

  reset() {
    this.db.close()
    this.db = new Database(":memory:")
  }

  rows<Row>(query: string, ...bindings: Array<string | number | null>) {
    return this.db.query(query).all(...bindings) as Row[]
  }
}

export class FakeState implements DurableObjectState {
  readonly sql = new FakeSql()
  alarm: number | null = null
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

export class FakeNamespace implements DurableObjectNamespace {
  readonly objects = new Map<string, { state: FakeState; object: OpsAccount }>()
  readonly calls: Array<{ name: string; url: string; headers: Headers; body: string }> = []
  private readonly make: (state: FakeState, name: string) => OpsAccount

  constructor(make: (state: FakeState, name: string) => OpsAccount) {
    this.make = make
  }

  idFromName(name: string): DurableObjectId {
    return { name, toString: () => name } as DurableObjectId
  }

  get(id: DurableObjectId) {
    const name = (id as unknown as { name: string }).name
    return {
      fetch: async (request: Request) => {
        this.calls.push({
          name,
          url: request.url,
          headers: new Headers(request.headers),
          body: await request.clone().text(),
        })
        let entry = this.objects.get(name)
        if (!entry) {
          const state = new FakeState()
          entry = { state, object: this.make(state, name) }
          this.objects.set(name, entry)
        }
        return entry.object.fetch(request)
      },
    }
  }
}

type Site = (request: { url: string; init: RequestInit }) => Response | Promise<Response>
export type Report = { url: string; headers: Headers; body: string }

/**
 * The outside world, scripted. Hosts resolve to a public address unless `dns` says otherwise; sites answer 200 unless a
 * URL has its own handler; the API takes reports with `reportStatus`.
 */
export class FakeNet {
  readonly requests: Array<{ url: string; init: RequestInit }> = []
  readonly reports: Report[] = []
  readonly sites = new Map<string, Site>()
  readonly dns = new Map<string, { A?: string[]; AAAA?: string[]; status?: number; fail?: boolean }>()
  reportStatus = 200
  inFlight = 0
  maxInFlight = 0
  dnsQueries = 0

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    this.requests.push({ url, init })
    if (url.startsWith(DOH_ENDPOINT)) return this.answerDns(new URL(url))
    if (url === `${API_ORIGIN}/api/ops/worker`) {
      this.reports.push({ url, headers: new Headers(init.headers), body: String(init.body) })
      return new Response("{}", { status: this.reportStatus })
    }
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      const site = this.sites.get(url)
      return site ? await site({ url, init }) : new Response("ok", { status: 200 })
    } finally {
      this.inFlight--
    }
  }

  /** Probe requests to one URL (DNS and reports left out). */
  probes(url: string) {
    return this.requests.filter((request) => request.url === url).length
  }

  /** Events of every report the API took, in order. */
  events() {
    return this.reports.flatMap(
      (report) => (JSON.parse(report.body) as { events: Array<Record<string, unknown>> }).events,
    )
  }

  private answerDns(url: URL) {
    this.dnsQueries++
    const host = url.searchParams.get("name")!
    const type = url.searchParams.get("type") as "A" | "AAAA"
    const entry = this.dns.get(host) ?? { A: ["104.16.132.229"] }
    if (entry.fail) return new Response("unavailable", { status: 502 })
    if (entry.status !== undefined) return Response.json({ Status: entry.status })
    const data = entry[type] ?? []
    return Response.json({
      Status: 0,
      Answer: data.map((address) => ({ name: host, type: type === "A" ? 1 : 28, TTL: 300, data: address })),
    })
  }
}

/** One account's object with its clock, network and storage, for driving the object directly. */
export class Harness {
  readonly clock = { now: NOW }
  readonly state = new FakeState()
  readonly kv = new FakeKV()
  readonly net = new FakeNet()
  readonly runtime: Runtime = { now: () => this.clock.now, fetch: this.net.fetch }
  readonly env: Env
  object: OpsAccount

  constructor(env: Partial<Env> = {}) {
    this.env = {
      OPS_ACCOUNT: new FakeNamespace(() => this.object),
      OPS_FLAGS: this.kv,
      INTERNAL_SECRET,
      ACCOUNT_KEY,
      API_ORIGIN,
      ...env,
    }
    this.object = new OpsAccount(this.state, this.env, this.runtime)
  }

  /** A new instance over the same storage, as after eviction: nothing in memory survives. */
  wake() {
    this.object = new OpsAccount(this.state, this.env, this.runtime)
    return this.object
  }

  advance(ms: number) {
    this.clock.now += ms
  }

  async call(action: string, body: Record<string, unknown>, options: { signedAt?: number; nonce?: string } = {}) {
    const response = await this.object.fetch(
      new Request(`https://ops.invalid/internal/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vector-ops-nonce": options.nonce ?? token(),
          "x-vector-ops-signed-at": String(options.signedAt ?? Math.floor(this.clock.now / 1000) * 1000),
        },
        body: JSON.stringify(body),
      }),
    )
    return { status: response.status, body: (await response.json()) as Record<string, any> }
  }

  plan(plan: OpsPlan) {
    return this.call("plan", { account: ACCOUNT, plan })
  }

  config(domains: string[], monitors: Array<{ id: string; url: string }>) {
    return this.call("config", { account: ACCOUNT, domains, monitors })
  }

  release(input: {
    sha: string
    at?: number
    urls: string[]
    repositoryId?: number
    environment?: string
    deployment?: string
  }) {
    return this.call("release", {
      account: ACCOUNT,
      repositoryId: input.repositoryId ?? 42,
      environment: input.environment ?? "production",
      sha: input.sha,
      deployment: input.deployment ?? `d${input.sha.slice(0, 6)}`,
      at: input.at ?? this.clock.now,
      urls: input.urls,
    })
  }

  state_() {
    return this.call("state", { account: ACCOUNT })
  }

  /** Fires the alarm if one is set, moving the clock to its time first. */
  async fire() {
    const at = this.state.alarm
    if (at === null) return false
    this.clock.now = Math.max(this.clock.now, at)
    this.state.alarm = null
    await this.object.alarm()
    return true
  }

  /** Lets `ms` pass, firing every alarm that falls due on the way. Returns how many fired. */
  async runFor(ms: number) {
    const end = this.clock.now + ms
    let fired = 0
    while (this.state.alarm !== null && this.state.alarm <= end) {
      await this.fire()
      fired++
      if (fired > 10_000) throw new Error("runaway alarm")
    }
    this.clock.now = end
    return fired
  }

  rows<Row>(query: string, ...bindings: Array<string | number | null>) {
    return this.state.sql.rows<Row>(query, ...bindings)
  }
}

export function token() {
  return base64url(crypto.getRandomValues(new Uint8Array(24)))
}

export function html(status: number, body: string, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } })
}
