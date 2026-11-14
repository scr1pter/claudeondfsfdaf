import { createHash, createHmac, generateKeyPairSync } from "node:crypto"
import { Readable } from "node:stream"
import type { EntitlementSnapshot } from "../packages/schema/src/codium-entitlements"
import { Hosted } from "../packages/schema/src/hosted"
import { mintCliToken } from "../api/_lib/cli-token"
import { codiumKey } from "../api/_lib/codium-keys"
import { effectiveCaps } from "../api/_lib/codium-snapshot"
import type { ComputerInfo, ComputerStatus, HostedProvider, StopResult } from "../api/_lib/hosted-provider"
import { HOSTED_SESSION_SCRIPTS } from "../api/_lib/hosted-sessions"
import type { ApiRequest, ApiResponse } from "../api/_lib/http"
import { keyExpiresAt, protectModelPlanKey, reconcileModelPlanAccount } from "../api/_lib/model-plan-account"
import {
  codiumFakes,
  codiumTestEnvironment,
  FAKE_KV_URL,
  loadStripeFixture,
  type CodiumFakes,
} from "../packages/web/test/fixture/codium-fakes"
import {
  HOSTED_SALT,
  hostedFetcher,
  registerHostedScripts,
  SERVICE_ROLE,
  SUPABASE_ORIGIN,
  type LedgerBackend,
} from "./hosted-fixture"

/*
 * Fakes for the cloud computer's sessions (WP A53), shared by its four test files:
 * - `registerSessionScripts` teaches the Codium fake store the sessions' scripts (SAVE, CLAIM, LEASE) as TypeScript;
 * - `FakeProvider` is an in-memory provider (WP A52's interface) that records every call and can be made to fail;
 * - `hostedWorld` is a Max plan in its first period, reconciled from the Stripe fixtures, with the ledger (WP A51), the
 *   provider, the signing keys, the media bucket and website sessions, all fakes behind one fetcher;
 * - `invoke` drives a route handler with a request and collects its answer.
 * Nothing here reaches a real service.
 */

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
export const P1 = { start: 1788220800, end: 1790812800 }
export const SEEDED = "hash_hosted1"
export const R2_ACCOUNT = "ab".repeat(16)
export const R2_HOST = `${R2_ACCOUNT}.r2.cloudflarestorage.com`
export const CRON = "fixture-cron-secret-hosted-sessions"
export const BUDGET_SECRET = "fixture-budget-read-secret-".padEnd(40, "b")
export const OWNER = "owner@example.invalid"

const fixture = loadStripeFixture("renewing-draft-invoice") // a Max plan
export const ACCOUNT_ID = fixture.accountId

const viewerKeys = generateKeyPairSync("ed25519")
export const VIEWER_SIGNING_KEY = viewerKeys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")
export const VIEWER_PUBLIC_X = (viewerKeys.publicKey.export({ format: "jwk" }) as { x: string }).x

/** The settings every hosted session test runs with: the ledger, the salt, both signing keys, the bucket, the crons. */
export function hostedSessionEnvironment(overrides: Record<string, string | undefined> = {}) {
  return codiumTestEnvironment({
    NODE_ENV: "test",
    SUPABASE_URL: SUPABASE_ORIGIN,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
    SUPABASE_PUBLISHABLE_KEY: "fixture-publishable-key",
    SUPABASE_ANON_KEY: undefined,
    VECTOR_HOSTED_ACCOUNT_SALT: HOSTED_SALT,
    VECTOR_HOSTED_ALLOW_ACCOUNTS: ACCOUNT_ID,
    VECTOR_HOSTED_EGRESS_MICRO_USD_PER_GB: undefined,
    VECTOR_HOSTED_PROVIDER: undefined,
    VECTOR_HOSTED_RUN_HOST: undefined,
    VECTOR_HOSTED_RUN_SIGNING_KEY: "fixture-hosted-run-signing-key-".padEnd(48, "r"),
    VECTOR_HOSTED_VIEWER_SIGNING_KEY: VIEWER_SIGNING_KEY,
    VECTOR_HOSTED_BUDGET_READ_SECRET: BUDGET_SECRET,
    VECTOR_CLI_TOKEN_SECRET: "hosted-sessions-fixture-cli-secret-".padEnd(48, "c"),
    VECTOR_ABUSE_SECRET: "hosted-sessions-fixture-abuse-secret-".padEnd(48, "a"),
    VECTOR_ALLOWED_ORIGINS: undefined,
    VECTOR_PUBLIC_URL: undefined,
    VECTOR_PHONE_APP_ORIGIN: undefined,
    VECTOR_ADMIN_EMAILS: OWNER,
    VECTOR_USAGE_OWNER_EMAILS: undefined,
    VECTOR_R2_ACCOUNT_ID: R2_ACCOUNT,
    VECTOR_R2_MEDIA_ACCESS_KEY_ID: "FIXTUREACCESSKEY0001",
    VECTOR_R2_MEDIA_SECRET_ACCESS_KEY: "fixture/secret/access/key/for/r2/media0000",
    VECTOR_R2_MEDIA_BUCKET: undefined,
    CRON_SECRET: CRON,
    CODIUM_LISTED_PERKS: undefined,
    RESEND_API_KEY: undefined,
    ...overrides,
  })
}

// ── Scripts ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The sessions' scripts as TypeScript, step for step (hosted-sessions.ts). */
export function registerSessionScripts(fakes: Pick<CodiumFakes, "store" | "clock">) {
  const { store, clock } = fakes
  const keep = (key: string, ms: number) => {
    if (store.pttl(key) < ms) store.expires.set(key, clock.now + ms)
  }
  store.scripts.set(HOSTED_SESSION_SCRIPTS.SAVE, ([key], [old, next, px]) => {
    if ((store.get(key!) ?? "") !== old) return 0
    store.set(key!, next!)
    store.expires.set(key!, clock.now + Number(px))
    return 1
  })
  store.scripts.set(HOSTED_SESSION_SCRIPTS.CLAIM, ([lease], [session, cap, until, now, ms]) => {
    const fields = store.hash(lease!)
    let free: number | undefined
    for (let n = 1; n <= Number(cap); n++) {
      const value = fields.get(String(n))
      if (value !== undefined) {
        const match = /^([^:]+):(\d+)$/.exec(value)
        if (match?.[1] === session) {
          fields.set(String(n), `${session}:${until}`)
          return n
        }
        if ((!match || Number(match[2]) <= Number(now)) && free === undefined) free = n
      } else if (free === undefined) free = n
    }
    if (free === undefined) {
      store.prune(lease!)
      return 0
    }
    fields.set(String(free), `${session}:${until}`)
    keep(lease!, Number(ms))
    return free
  })
  store.scripts.set(HOSTED_SESSION_SCRIPTS.LEASE, ([lease], [computer, session, until, ms]) => {
    const fields = store.hash(lease!)
    const value = fields.get(computer!)
    if (value === undefined || !value.startsWith(`${session}:`)) {
      store.prune(lease!)
      return 0
    }
    if (until === "") {
      fields.delete(computer!)
      store.prune(lease!)
      return 1
    }
    fields.set(computer!, `${session}:${until}`)
    keep(lease!, Number(ms))
    return 1
  })
}

// ── The provider ───────────────────────────────────────────────────────────────────────────────────────────────────

type FakeComputer = {
  status: ComputerStatus
  size: Hosted.Size
  token?: string
  activeCpuMs: number
  durationMs: number
  egressBytes: number
  timeoutMs: number
}

/** An in-memory provider: computers by name, every call recorded, failures on demand. */
export class FakeProvider implements HostedProvider {
  readonly id = "vercel" as const
  readonly computers = new Map<string, FakeComputer>()
  readonly calls: string[] = []
  readonly boots: { name: string; runHost: string; session: string }[] = []
  ready = true
  fail = { start: false, boot: false, stop: false, token: false, list: false }
  constructor(private readonly clock: () => number) {}
  configured() {
    return this.ready
  }
  problems() {
    return this.ready ? [] : ["the fake provider is not ready"]
  }
  async start(config: Parameters<HostedProvider["start"]>[0]) {
    this.calls.push(`start ${config.name}`)
    if (this.fail.start) throw new Error("provider down")
    const existing = this.computers.get(config.name)
    this.computers.set(config.name, {
      status: "running",
      size: config.size,
      token: config.injection.value,
      activeCpuMs: existing?.activeCpuMs ?? 0,
      durationMs: existing?.durationMs ?? 0,
      egressBytes: existing?.egressBytes ?? 0,
      timeoutMs: config.timeoutMs,
    })
    return {
      name: config.name,
      created: !existing,
      viewerUrl: `https://${config.name}-6080.sandbox.invalid`,
      expiresAt: this.clock() + config.timeoutMs,
    }
  }
  async setRunToken(config: Parameters<HostedProvider["setRunToken"]>[0]) {
    this.calls.push(`token ${config.name}`)
    if (this.fail.token) throw new Error("provider down")
    const computer = this.computers.get(config.name)
    if (computer) computer.token = config.injection.value
  }
  async boot(name: string, input: { runHost: string; session: string }) {
    this.calls.push(`boot ${name}`)
    if (this.fail.boot) throw new Error("provider down")
    this.boots.push({ name, ...input })
  }
  async stop(name: string): Promise<StopResult> {
    this.calls.push(`stop ${name}`)
    if (this.fail.stop) throw new Error("provider down")
    const computer = this.computers.get(name)
    if (!computer) return "missing"
    if (computer.status !== "running" && computer.status !== "pending") return "not-running"
    computer.status = "stopped"
    return "stopped"
  }
  async destroy(name: string) {
    this.calls.push(`destroy ${name}`)
    return this.computers.delete(name) ? ("deleted" as const) : ("missing" as const)
  }
  async list(prefix: string): Promise<ComputerInfo[]> {
    this.calls.push(`list ${prefix}`)
    if (this.fail.list) throw new Error("provider down")
    return [...this.computers]
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, computer]) => ({
        name,
        status: computer.status,
        size: computer.size,
        activeCpuMs: computer.activeCpuMs,
        durationMs: computer.durationMs,
        egressBytes: computer.egressBytes,
      }))
  }
  /** The run token the computer's egress proxy adds now (without "Bearer "). */
  token(name: string) {
    return this.computers.get(name)?.token?.replace(/^Bearer /, "")
  }
}

// ── The world ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type HostedWorld = {
  fakes: CodiumFakes
  provider: FakeProvider
  fetcher: typeof fetch
  /** Options for every hosted function: the fetcher, the fake clock and the fake provider. */
  options: { fetcher: typeof fetch; clock: () => number; provider: FakeProvider }
  /** Objects in the media bucket (key → size). */
  bucket: Map<string, number>
  /** Website sessions: bearer → account. */
  sessions: Map<string, string>
  advance(ms: number): number
  snapshot(): EntitlementSnapshot
  /** Rewrites the stored snapshot (state, plan, ramp …), keeping it fresh. */
  setSnapshot(patch: Partial<EntitlementSnapshot>): EntitlementSnapshot
  desktopToken(client?: "desktop" | "cli" | "unmarked"): string
  /** A website session for the account. */
  sessionToken(): string
  /** The owner's Google session, signed in `agoMs` ago. */
  ownerToken(agoMs?: number): string
}

/** A Max plan in its first period with a key Codium already made, reconciled once as the webhook would. */
export async function hostedWorld(ledger: LedgerBackend, at = P1.start * 1000 + 10 * DAY): Promise<HostedWorld> {
  const fakes = codiumFakes({ now: at })
  const objects = structuredClone(fixture.objects)
  const subscription = objects.subscriptions![0]!
  Object.assign(subscription, {
    current_period_start: P1.start,
    current_period_end: P1.end,
    latest_invoice: "in_renewingP1",
  })
  objects.invoices = objects.invoices!.filter((invoice) => invoice.id !== "in_renewal")
  fakes.stripe.load(objects)
  registerHostedScripts(fakes)
  registerSessionScripts(fakes)
  const credits = 48
  fakes.openRouter.seed(SEEDED, {
    name: `Vector test ${ACCOUNT_ID} sub_renewing ${P1.start}`,
    limit: credits,
    usage: 0,
    expires_at: keyExpiresAt(P1.end),
  })
  fakes.store.set(
    codiumKey("account", ACCOUNT_ID),
    JSON.stringify({
      ...fixture.account,
      firstPaidAt: P1.start * 1000 - 30 * DAY,
      firstHighPaidAt: P1.start * 1000 - 30 * DAY,
      paidThrough: P1.end * 1000,
      highValueVerified: true,
      key: {
        hash: SEEDED,
        encrypted: protectModelPlanKey("seeded-secret", `${ACCOUNT_ID}:sub_renewing:${P1.start}`),
        subscription: "sub_renewing",
        start: P1.start,
        end: P1.end,
        credits,
        creditsMicro: credits * 1_000_000,
        limitMicro: credits * 1_000_000,
        spendGenesis: fakes.store.seedSpendGenesis({
          account: ACCOUNT_ID,
          pool: SEEDED,
          subscription: "sub_renewing",
          start: P1.start,
          end: P1.end,
        }),
      },
    }),
  )
  const bucket = new Map<string, number>()
  const sessions = new Map<string, string>()
  const owners = new Set<string>()
  const reach = hostedFetcher(fakes, ledger)
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin === SUPABASE_ORIGIN && url.pathname === "/auth/v1/user") {
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? ""
      if (owners.has(token))
        return Response.json({
          id: "9d3c1b2a-4e5f-4a6b-8c7d-0e1f2a3b4c5d",
          email: OWNER,
          email_confirmed_at: "2026-01-01T00:00:00Z",
          identities: [{ provider: "google", identity_data: { email: OWNER, email_verified: true } }],
        })
      const account = sessions.get(token)
      if (!account) return new Response("{}", { status: 401 })
      return Response.json({
        id: account,
        email: `${account.slice(-4)}@example.invalid`,
        email_confirmed_at: "2026-01-01T00:00:00Z",
        identities: [{ provider: "email" }],
      })
    }
    if (url.host === R2_HOST) {
      const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"))
      const size = bucket.get(key)
      if (init?.method === "HEAD")
        return size === undefined
          ? new Response(null, { status: 404 })
          : new Response(null, { status: 200, headers: { "content-length": String(size) } })
      return new Response("unexpected", { status: 400 })
    }
    if (url.origin === FAKE_KV_URL && url.pathname.startsWith("/set/")) {
      const [, , key, value] = url.pathname.split("/")
      fakes.store.set(decodeURIComponent(key!), value!)
      return Response.json({ result: "OK" })
    }
    return reach(input, init)
  }) as typeof fetch
  const clock = () => fakes.clock.now
  const provider = new FakeProvider(clock)
  const snapshot = await reconcileModelPlanAccount(ACCOUNT_ID, fetcher, at)
  if (snapshot.state !== "active" || snapshot.plan !== "vector-100") throw new Error("The hosted world did not start as an active Max plan.")
  const read = () => JSON.parse(fakes.store.get(codiumKey("ent", ACCOUNT_ID))!) as EntitlementSnapshot
  return {
    fakes,
    provider,
    fetcher,
    options: { fetcher, clock, provider },
    bucket,
    sessions,
    advance: (ms) => fakes.clock.advance(ms),
    snapshot: read,
    setSnapshot(patch) {
      const current = read()
      const plan = patch.plan === undefined ? current.plan : patch.plan
      const ramp = patch.ramp ?? current.ramp
      const next = {
        ...current,
        ...patch,
        caps: patch.caps ?? effectiveCaps(plan, ramp, fakes.clock.now),
        version: current.version + 1,
        checkedAt: fakes.clock.now,
        updatedAt: fakes.clock.now,
      } as EntitlementSnapshot
      fakes.store.set(codiumKey("ent", ACCOUNT_ID), JSON.stringify(next))
      return next
    },
    sessionToken() {
      const token = `session-${sessions.size + 1}-hosted`
      sessions.set(token, ACCOUNT_ID)
      return token
    },
    ownerToken(agoMs = MINUTE) {
      const claims = { amr: [{ method: "oauth", timestamp: Math.floor((fakes.clock.now - agoMs) / 1000) }] }
      const token = `owner.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature${owners.size}`
      owners.add(token)
      return token
    },
    desktopToken: (client = "desktop") =>
      mintCliToken(
        { id: ACCOUNT_ID, email: "max@example.invalid" },
        fakes.clock.now,
        client === "unmarked" ? undefined : client,
      ).token,
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Answer = { status: number; headers: Record<string, string>; body: any }

/** Drives one route handler with a request and answers what it sent. */
export function invoke(
  handler: (request: ApiRequest, response: ApiResponse) => Promise<void>,
  input: {
    method: string
    authorization?: string
    headers?: Record<string, string>
    body?: unknown
    query?: Record<string, string>
  },
): Promise<Answer> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": "192.0.2.53",
    ...(input.authorization ? { authorization: `Bearer ${input.authorization}` } : {}),
    ...input.headers,
  }
  const request = Object.assign(Readable.from([]), {
    method: input.method,
    headers,
    url: "/api/hosted",
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

/** The cloud computer daemon's own key for a session in these tests (fixed per session), base64url of 32 bytes. */
export function hostdKey(session: string) {
  return createHash("sha256").update(`hostd-fixture:${session}`).digest("base64url")
}

/**
 * A heartbeat body as the daemon sends it (P8 review): its key, which the first beat registers, and `mac`, the HMAC of
 * `Hosted.hostdMacInput(session, body)` with that key. Pass `key` to sign as someone else.
 */
export function daemonBeat(session: string, body: Record<string, unknown>, key = hostdKey(session)) {
  const signed = { ...body, hostdKey: key }
  const mac = createHmac("sha256", Buffer.from(key, "base64url")).update(Hosted.hostdMacInput(session, signed)).digest("base64url")
  return { ...signed, mac }
}
