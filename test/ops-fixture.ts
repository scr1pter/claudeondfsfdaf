import { Readable } from "node:stream"
import { mintCliToken } from "../api/_lib/cli-token"
import { buildSnapshot, snapshotKey, type SnapshotFacts } from "../api/_lib/codium-snapshot"
import { switchKey } from "../api/_lib/codium-switches"
import { signInternal } from "../api/_lib/hosted-internal"
import type { ApiRequest, ApiResponse } from "../api/_lib/http"
import { DOH_ENDPOINT } from "../api/_lib/ops-domains"
import {
  OPS_SETTINGS_SCRIPTS,
  registerRepoBindingReader,
  type OpsBindingReader,
  type OpsRepoBinding,
} from "../api/_lib/ops-settings"
import { handleRequest } from "../packages/ops-worker/src/index"
import { OpsAccount } from "../packages/ops-worker/src/ops-account"
import type { OpsPlan } from "../packages/ops-worker/src/protocol"
import type { Env, Runtime } from "../packages/ops-worker/src/runtime"
import { FakeKV, FakeNamespace, FakeNet } from "../packages/ops-worker/test/fakes"
import { ENTITLEMENTS, type EntitlementSnapshot } from "../packages/schema/src/codium-entitlements"
import type { PlanId } from "../packages/schema/src/codium-plan"
import { codiumFakes, codiumTestEnvironment, FAKE_KV_URL } from "../packages/web/test/fixture/codium-fakes"

// WP A47's fakes, shared by test/github-webhook.test.ts and test/on-call.test.ts. The store is the Codium fake (with
// A47's three scripts run as TypeScript here, and on a real Valkey in CI), the account service answers fixture
// sessions, DNS-over-HTTPS answers from a table, and the ops Worker is A46's own code in memory (its Durable Objects on
// a real SQLite engine), so every call the API signs is checked and applied by the Worker itself. Nothing reaches a
// network, GitHub, Stripe or Cloudflare.

export const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)
export const DAY = 86_400_000
export const SUPABASE = "https://accounts.ops-fixture.invalid"
export const WORKER_HOST = "ops-worker.ops-fixture.invalid"
export const WORKER_SECRET = "ops-fixture-shared-secret-".padEnd(48, "s")
export const ACCOUNT_KEY = "ops-fixture-account-key-".padEnd(48, "k")
export const WEBHOOK_SECRET = "ops-fixture-webhook-secret-".padEnd(48, "w")
export const CRON_SECRET = "ops-fixture-cron-secret-value"
export const APP_SLUG = "vector-fixture-app"
export const PHONE = "https://remote.vectordev.ai"
export const OWNER_EMAIL = "owner@example.test"

export const MAX = "a47a47a4-0000-4000-8000-000000000003"
export const ULTRA = "a47a47a4-0000-4000-8000-000000000004"
export const PRO = "a47a47a4-0000-4000-8000-000000000002"
export const FREE = "a47a47a4-0000-4000-8000-000000000005"
export const OTHER = "a47a47a4-0000-4000-8000-000000000006"

export const OPS_ENVIRONMENT = {
  NODE_ENV: "test",
  VECTOR_CLI_TOKEN_SECRET: "ops-fixture-cli-secret-".padEnd(48, "c"),
  VECTOR_ABUSE_SECRET: "ops-fixture-abuse-secret-".padEnd(48, "b"),
  SUPABASE_URL: SUPABASE,
  SUPABASE_PUBLISHABLE_KEY: "fixture-publishable-key",
  SUPABASE_ANON_KEY: undefined,
  VECTOR_ALLOWED_ORIGINS: undefined,
  VECTOR_PUBLIC_URL: undefined,
  VECTOR_PHONE_APP_ORIGIN: PHONE,
  VECTOR_OPS_ENABLED: "true",
  VECTOR_OPS_WORKER_URL: `https://${WORKER_HOST}`,
  VECTOR_OPS_SHARED_SECRET: WORKER_SECRET,
  VECTOR_GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
  VECTOR_GITHUB_APP_SLUG: APP_SLUG,
  CRON_SECRET,
  VECTOR_ADMIN_EMAILS: OWNER_EMAIL,
}

/** A47's store scripts as TypeScript, on the Codium fake store. */
export function registerOpsScripts(store: ReturnType<typeof codiumFakes>["store"]) {
  store.scripts.set(OPS_SETTINGS_SCRIPTS.SAVE, (keys, argv) => {
    if ((store.get(keys[0]!) ?? "") !== argv[0]) return 0
    if (argv[1] === "") store.remove(keys[0]!)
    else store.set(keys[0]!, argv[1]!)
    const due = store.zset(keys[1]!)
    if (argv[3] === "") due.delete(argv[2]!)
    else due.set(argv[2]!, Number(argv[3]))
    store.prune(keys[1]!)
    for (let index = 2; index < keys.length; index++) {
      const members = store.members(keys[index]!)
      if (argv[index + 2] === "+") members.add(argv[2]!)
      else members.delete(argv[2]!)
      store.prune(keys[index]!)
    }
    return 1
  })
  store.scripts.set(OPS_SETTINGS_SCRIPTS.MEMBERS, (keys) =>
    keys.map((key) => {
      const value = store.live(key)
      return value?.kind === "set" ? [...value.value] : []
    }),
  )
  store.scripts.set(OPS_SETTINGS_SCRIPTS.FORGET, ([key], [account]) => {
    const removed = store.members(key!).delete(account!) ? 1 : 0
    store.prune(key!)
    return removed
  })
}

/** A46's Worker in memory: the API's signed calls arrive at its real router and Durable Objects. */
export class Worker {
  readonly clock = { now: NOW }
  readonly kv = new FakeKV()
  readonly net = new FakeNet()
  readonly runtime: Runtime = { now: () => this.clock.now, fetch: this.net.fetch }
  readonly namespace: FakeNamespace
  readonly env: Env
  readonly actions: string[] = []
  readonly bodies: Record<string, unknown>[] = []
  down = false

  constructor() {
    this.namespace = new FakeNamespace((state) => new OpsAccount(state, this.env, this.runtime))
    this.env = {
      OPS_ACCOUNT: this.namespace,
      OPS_FLAGS: this.kv,
      INTERNAL_SECRET: WORKER_SECRET,
      ACCOUNT_KEY,
      API_ORIGIN: "https://vectordev.ai",
    }
  }

  async fetch(url: URL, init?: RequestInit) {
    if (this.down) throw new Error("ops Worker unreachable")
    this.actions.push(url.pathname.slice("/internal/v1/".length))
    if (typeof init?.body === "string") this.bodies.push(JSON.parse(init.body) as Record<string, unknown>)
    return handleRequest(
      new Request(url, { method: init?.method, headers: init?.headers, body: init?.body }),
      this.env,
      this.runtime,
    )
  }

  /** Pushes a plan the way the ops provisioner will (A48/A50), signed by the API's own code. */
  async plan(account: string, plan: PlanId, overrides: Partial<OpsPlan> = {}) {
    const ops = ENTITLEMENTS[plan].ops!
    const body = JSON.stringify({
      account,
      plan: {
        version: 1,
        domains: ops.onCall.domains,
        onCall: { urls: ops.onCall.urls, intervalSec: ops.onCall.intervalSec },
        releaseGuard: { ...ops.releaseGuard },
        validUntil: this.clock.now + 30 * DAY,
        ...overrides,
      },
    })
    const path = "/internal/v1/plan"
    const headers = signInternal("ops", { method: "POST", path, body, now: this.clock.now, secret: WORKER_SECRET })
    const response = await handleRequest(
      new Request(`https://${WORKER_HOST}${path}`, { method: "POST", headers, body }),
      this.env,
      this.runtime,
    )
    if (!response.ok) throw new Error(`plan refused: ${response.status}`)
  }
}

export type Session = { id: string; email: string; google?: boolean }

/** Every fake, reset per test. */
export class OpsWorld {
  fakes = codiumFakes({ now: NOW })
  worker = new Worker()
  readonly sessions = new Map<string, Session>()
  /** DNS-over-HTTPS answers: TXT values per name, or a status, or a failure. */
  readonly txt = new Map<string, string[] | { status: number } | "fail">()
  readonly bindings = new Map<string, OpsRepoBinding>()
  now = NOW
  restore = () => {}

  constructor(overrides: Record<string, string | undefined> = {}) {
    this.restore = codiumTestEnvironment({ ...OPS_ENVIRONMENT, ...overrides })
    registerOpsScripts(this.fakes.store)
    const reader: OpsBindingReader = async (repositoryId) => this.bindings.get(repositoryId)
    registerRepoBindingReader(reader)
  }

  close() {
    registerRepoBindingReader(undefined)
    this.restore()
  }

  advance(ms: number) {
    this.now += ms
    this.fakes.clock.now = this.now
    this.worker.clock.now = this.now
  }

  /** A new identity per call, so the 30-second switch cache (kept per fetcher) never carries over between calls. */
  fetcher(): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.host === WORKER_HOST) return this.worker.fetch(url, init)
      if (url.href.startsWith(`${DOH_ENDPOINT}?`)) {
        const entry = this.txt.get(url.searchParams.get("name") ?? "")
        if (entry === "fail") return new Response("unavailable", { status: 502 })
        if (!entry) return Response.json({ Status: 3 })
        if (!Array.isArray(entry)) return Response.json({ Status: entry.status })
        return Response.json({
          Status: 0,
          Answer: entry.map((data) => ({ name: url.searchParams.get("name"), type: 16, TTL: 300, data })),
        })
      }
      if (url.origin === SUPABASE && url.pathname === "/auth/v1/user") {
        const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? ""
        const user = this.sessions.get(token)
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
      if (url.origin === FAKE_KV_URL && url.pathname.startsWith("/set/")) {
        const [, , key, value] = url.pathname.split("/")
        this.fakes.store.set(decodeURIComponent(key!), value!)
        return Response.json({ result: "OK" })
      }
      return this.fakes.fetcher(input, init)
    }) as typeof fetch
  }

  snapshotFor(
    account: string,
    plan: PlanId | null,
    state: SnapshotFacts["state"] = "active",
    options: { reason?: SnapshotFacts["reason"]; previous?: EntitlementSnapshot } = {},
  ) {
    const reasons: Partial<Record<SnapshotFacts["state"], SnapshotFacts["reason"]>> = {
      paused: "payment_failed",
      frozen: "disputed",
      ended: "canceled",
    }
    const reason = options.reason ?? reasons[state]
    return buildSnapshot(
      {
        account,
        state,
        ...(reason ? { reason } : {}),
        plan,
        ...(plan ? { subscription: `sub_fixture${account.slice(-4)}` } : {}),
        periodStart: this.now - DAY,
        periodEnd: this.now + 29 * DAY,
        cancelAtPeriodEnd: false,
        source: "webhook",
      },
      options.previous,
      this.now,
    )
  }

  /** Writes a fresh snapshot, as reconcile would. */
  seed(account: string, plan: PlanId | null, state: SnapshotFacts["state"] = "active") {
    const snapshot = this.snapshotFor(account, plan, state)
    this.fakes.store.set(snapshotKey(account), JSON.stringify(snapshot))
    return snapshot
  }

  switchOff(name: "ops") {
    this.fakes.store.set(
      switchKey(name),
      JSON.stringify({ value: "off", changedAt: this.now, generation: "g1", offSince: this.now }),
    )
  }

  token(account: string, client: "desktop" | "cli" | "unmarked" = "desktop") {
    return mintCliToken(
      { id: account, email: `${account.slice(-4)}@example.invalid` },
      this.now,
      client === "unmarked" ? undefined : client,
    ).token
  }

  session(account: string, google = false) {
    const token = `session-${account}-${this.sessions.size}`
    this.sessions.set(token, { id: account, email: `${account.slice(-4)}@example.invalid`, google })
    return token
  }

  bind(repositoryId: number, account: string, extra: Partial<OpsRepoBinding> = {}) {
    this.bindings.set(String(repositoryId), {
      account,
      repository: `octo-fixture/repo-${repositoryId}`,
      ...extra,
    })
  }

  /** Publishes the TXT record a domain's token asks for. */
  publish(domain: string, value: string) {
    this.txt.set(`_vector-verify.${domain}`, [`"${value}"`])
  }
}

export type Answer = { status: number; headers: Record<string, string>; body: any }

/** Runs a route handler with a fake request and collects its answer. */
export function invoke(
  handler: (request: ApiRequest, response: ApiResponse) => Promise<void>,
  input: {
    method: string
    authorization?: string
    origin?: string
    body?: unknown
    raw?: string | Buffer
    headers?: Record<string, string>
    url?: string
  },
): Promise<Answer> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": "192.0.2.47",
    ...(input.authorization ? { authorization: `Bearer ${input.authorization}` } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    ...input.headers,
  }
  const chunks = input.raw !== undefined ? [Buffer.from(input.raw)] : []
  const request = Object.assign(Readable.from(chunks), {
    method: input.method,
    headers,
    url: input.url ?? "/api/ops",
    ...(input.body !== undefined ? { body: input.body } : {}),
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
