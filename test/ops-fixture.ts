import { createHash, generateKeyPairSync } from "node:crypto"
import { Readable } from "node:stream"
import { compactVerify, importSPKI } from "jose"
import { mintCliToken } from "../api/_lib/cli-token"
import { buildSnapshot, snapshotKey, type SnapshotFacts } from "../api/_lib/codium-snapshot"
import { switchKey } from "../api/_lib/codium-switches"
import { signInternal } from "../api/_lib/hosted-internal"
import type { ApiRequest, ApiResponse } from "../api/_lib/http"
import { DOH_ENDPOINT } from "../api/_lib/ops-domains"
import { OPS_RECORD_SCRIPTS } from "../api/_lib/ops-records"
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
import {
  codiumFakes,
  codiumTestEnvironment,
  FAKE_KV_URL,
  type FakeClock,
} from "../packages/web/test/fixture/codium-fakes"

// WP A47's fakes, shared by test/github-webhook.test.ts, test/on-call.test.ts and test/release-guard.test.ts. The store is the Codium fake (with
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
export const APP_ID = "424242"
export const APP_CLIENT_ID = "Iv1.fixtureclient"

// The App's key for these tests only: made fresh in memory each run, never written anywhere.
const APP_KEYS = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
})

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
  // WP A48: Release Guard's server tokens. The App is used only where VERCEL_ENV is production or unset.
  VECTOR_GITHUB_APP_ENABLED: "true",
  VECTOR_GITHUB_APP_ID: APP_ID,
  VECTOR_GITHUB_APP_CLIENT_ID: APP_CLIENT_ID,
  VECTOR_GITHUB_APP_PRIVATE_KEY: APP_KEYS.privateKey,
  VERCEL_ENV: undefined,
  CRON_SECRET,
  VECTOR_ADMIN_EMAILS: OWNER_EMAIL,
}

type Store = ReturnType<typeof codiumFakes>["store"]

/** A48's record scripts (ops-records.ts) as TypeScript; test/release-guard.test.ts runs them on Valkey in CI. */
export function registerRecordScripts(store: Store, clock: FakeClock) {
  const expire = (key: string, ms: string) => store.expires.set(key, clock.now + Number(ms))
  const ordered = (key: string) => [...store.zset(key)].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
  const index = (key: string, score: string, member: string, oldest: string, max: string, ms: string) => {
    const set = store.zset(key)
    set.set(member, Number(score))
    for (const [entry, value] of [...set]) if (value < Number(oldest)) set.delete(entry)
    const all = ordered(key)
    for (const [entry] of all.slice(0, Math.max(0, all.length - Number(max)))) set.delete(entry)
    store.prune(key)
    if (store.live(key)) expire(key, ms)
  }
  store.scripts.set(OPS_RECORD_SCRIPTS.SAVE, (keys, argv) => {
    if ((store.get(keys[0]!) ?? "") !== argv[0]) return 0
    store.set(keys[0]!, argv[1]!)
    expire(keys[0]!, argv[2]!)
    if (keys.length > 1) index(keys[1]!, argv[3]!, argv[4]!, argv[5]!, argv[6]!, argv[7]!)
    return 1
  })
  store.scripts.set(OPS_RECORD_SCRIPTS.CLAIM, (keys, argv) => {
    if (store.live(keys[0]!)) return 0
    const used = Number(store.get(keys[1]!) ?? "0")
    let value = argv[0]!
    let result = 1
    if (used >= Number(argv[2])) {
      if (argv[1] === "") return -1
      value = argv[1]!
      result = -1
    } else {
      const ttl = store.expires.get(keys[1]!)
      store.set(keys[1]!, String(used + 1))
      if (ttl !== undefined) store.expires.set(keys[1]!, ttl)
      expire(keys[1]!, argv[4]!)
    }
    store.set(keys[0]!, value)
    expire(keys[0]!, argv[3]!)
    if (keys.length > 2) index(keys[2]!, argv[5]!, argv[6]!, argv[7]!, argv[8]!, argv[9]!)
    return result
  })
  store.scripts.set(OPS_RECORD_SCRIPTS.UNCLAIM, (keys, argv) => {
    if (store.get(keys[0]!) !== argv[0]) return 0
    store.remove(keys[0]!)
    const used = Number(store.get(keys[1]!) ?? "0")
    if (used > 0) {
      const ttl = store.expires.get(keys[1]!)
      store.set(keys[1]!, String(used - 1))
      if (ttl !== undefined) store.expires.set(keys[1]!, ttl)
    }
    if (keys.length > 2) {
      store.zset(keys[2]!).delete(argv[1]!)
      store.prune(keys[2]!)
    }
    return 1
  })
  store.scripts.set(OPS_RECORD_SCRIPTS.AUDIT, ([key], [score, member, max, ms]) => {
    const set = store.zset(key!)
    set.set(member!, Number(score))
    const all = ordered(key!)
    for (const [entry] of all.slice(0, Math.max(0, all.length - Number(max)))) set.delete(entry)
    expire(key!, ms!)
    return 1
  })
}

/** A47's store scripts as TypeScript, on the Codium fake store. */
export function registerOpsScripts(store: Store) {
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

  /** Lets `ms` pass, firing every account object's alarm that falls due on the way, earliest first. */
  async runFor(ms: number, advance: (to: number) => void) {
    const end = this.clock.now + ms
    for (let fired = 0; fired < 10_000; fired++) {
      let next: { at: number; object: OpsAccount; state: { alarm: number | null } } | undefined
      for (const entry of this.namespace.objects.values())
        if (entry.state.alarm !== null && entry.state.alarm <= end && (!next || entry.state.alarm < next.at))
          next = { at: entry.state.alarm, object: entry.object, state: entry.state }
      if (!next) break
      advance(Math.max(this.clock.now, next.at))
      next.state.alarm = null
      await next.object.alarm()
    }
    advance(end)
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

// ── GitHub ──────────────────────────────────────────────────────────────────────────────────────────────────────────

type Json = Record<string, any>
export type FakePull = {
  number: number
  node_id: string
  html_url: string
  state: "open" | "closed"
  title: string
  body?: string
  merged: boolean
  merged_at?: string
  merge_commit_sha?: string
  commits: number
  base: { ref: string; repo: { id: number } }
  head: { ref: string; repo: { id: number } }
  user: { login: string; type: string }
}

const sha40 = (seed: string) => createHash("sha1").update(seed).digest("hex")

/**
 * GitHub's API for one App, as Release Guard uses it: installation tokens (minted with the App's JWT, checked against
 * the fixture key; scoped to one repository; revoked), the repository's contents, compare, commits, refs, pull requests
 * and GraphQL's revertPullRequest. Every write is recorded; a merge is recorded too, so a test can say none happened.
 * `fail` makes the next matching requests fail, as an unreachable or refusing GitHub does.
 */
export class FakeGithub {
  readonly repos = new Map<number, { fullName: string; defaultBranch: string; installationId: number }>()
  readonly tokens = new Map<string, { repositoryId: number; permissions: Record<string, string>; revoked: boolean }>()
  readonly minted: { repositoryId: number; installationId: number; permissions: Record<string, string> }[] = []
  readonly optIns = new Map<string, string | null>()
  readonly compares = new Map<string, Json>()
  readonly commitPulls = new Map<string, Json[]>()
  readonly pulls = new Map<string, FakePull>()
  readonly refs = new Map<string, string>()
  readonly commits = new Map<string, { tree: string; parents: string[] }>()
  readonly writes: { method: string; path: string; body?: Json }[] = []
  readonly requests: { method: string; path: string }[] = []
  readonly failures: { match: RegExp; status?: number; times: number }[] = []
  down = false
  private serial = 0
  private nextPull = 900

  constructor(private readonly clock: () => number) {}

  addRepo(id: number, fullName: string, options: { installationId?: number; defaultBranch?: string } = {}) {
    this.repos.set(id, {
      fullName,
      defaultBranch: options.defaultBranch ?? "main",
      installationId: options.installationId ?? 77,
    })
  }

  /** `.vector/ops.json` at `ref` ("*" for every ref not named); null removes it. */
  commitOptIn(repositoryId: number, file: object | string | null, ref = "*") {
    this.optIns.set(
      `${repositoryId}@${ref}`,
      file === null ? null : typeof file === "string" ? file : JSON.stringify(file),
    )
  }

  fail(match: RegExp, times = 1, status?: number) {
    this.failures.push({ match, times, ...(status !== undefined ? { status } : {}) })
  }

  /** Revoked and live tokens, for the "revoked after use" checks. */
  live() {
    return [...this.tokens.values()].filter((token) => !token.revoked)
  }

  addPull(repositoryId: number, pull: Partial<FakePull> & { number: number }) {
    const repo = this.repos.get(repositoryId)!
    const full: FakePull = {
      node_id: `PR_node${pull.number}`,
      html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
      state: "closed",
      title: `Change ${pull.number}`,
      merged: true,
      merged_at: new Date(this.clock()).toISOString(),
      commits: 1,
      base: { ref: repo.defaultBranch, repo: { id: repositoryId } },
      head: { ref: `feature-${pull.number}`, repo: { id: repositoryId } },
      user: { login: "octo-person", type: "User" },
      ...pull,
    }
    this.pulls.set(`${repositoryId}#${pull.number}`, full)
    return full
  }

  newSha() {
    return sha40(`fake-${++this.serial}`)
  }

  private json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }

  private async appJwt(authorization: string | null) {
    const jwt = authorization?.replace(/^Bearer /, "") ?? ""
    try {
      const { payload } = await compactVerify(jwt, await importSPKI(APP_KEYS.publicKey, "RS256"))
      return (JSON.parse(new TextDecoder().decode(payload)) as { iss?: string }).iss === APP_CLIENT_ID
    } catch {
      return false
    }
  }

  async fetch(url: URL, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET"
    const path = `${url.pathname}${url.search}`
    this.requests.push({ method, path })
    if (this.down) throw new Error("GitHub unreachable")
    const failure = this.failures.find((entry) => entry.times > 0 && entry.match.test(`${method} ${path}`))
    if (failure) {
      failure.times--
      if (failure.status === undefined) throw new Error("GitHub unreachable")
      return this.json({ message: "fixture failure" }, failure.status)
    }
    const headers = new Headers(init?.headers)
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Json) : undefined

    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname)
    if (mint && method === "POST") {
      if (!(await this.appJwt(headers.get("authorization")))) return this.json({ message: "Bad credentials" }, 401)
      const installationId = Number(mint[1])
      const repositoryId = Number(body?.repository_ids?.[0])
      const repo = this.repos.get(repositoryId)
      if (!repo || repo.installationId !== installationId || body?.repository_ids?.length !== 1)
        return this.json({ message: "Not Found" }, 404)
      const token = `ghs_${sha40(`token-${++this.serial}`).slice(0, 36)}`
      this.tokens.set(token, { repositoryId, permissions: body!.permissions, revoked: false })
      this.minted.push({ repositoryId, installationId, permissions: body!.permissions })
      return this.json(
        { token, expires_at: new Date(this.clock() + 3_600_000).toISOString(), permissions: body!.permissions },
        201,
      )
    }
    const lookup = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url.pathname)
    if (lookup && method === "GET") {
      if (!(await this.appJwt(headers.get("authorization")))) return this.json({ message: "Bad credentials" }, 401)
      const repo = [...this.repos.values()].find((item) => item.fullName === lookup[1])
      return repo ? this.json({ id: repo.installationId, app_id: Number(APP_ID) }) : this.json({}, 404)
    }

    const token = this.tokens.get(headers.get("authorization")?.replace(/^Bearer /, "") ?? "")
    if (!token || token.revoked) return this.json({ message: "Bad credentials" }, 401)
    const repoId = token.repositoryId
    const repo = this.repos.get(repoId)!
    if (url.pathname === "/installation/token" && method === "DELETE") {
      token.revoked = true
      return new Response(null, { status: 204 })
    }
    if (url.pathname === "/installation/repositories")
      return this.json({
        total_count: 1,
        repositories: [
          { id: repoId, full_name: repo.fullName, default_branch: repo.defaultBranch, private: true, archived: false },
        ],
      })
    const can = (permission: string) => token.permissions[permission] === "write"
    if (url.pathname === "/graphql" && method === "POST") {
      if (!can("pull_requests") || !can("contents")) return this.json({ message: "Forbidden" }, 403)
      const pull = [...this.pulls.values()].find((item) => item.node_id === body?.variables?.id)
      if (!pull || !pull.merged) return this.json({ errors: [{ message: "Could not resolve to a node" }] })
      this.writes.push({ method, path: "/graphql", body })
      const created = this.addPull(repoId, {
        number: ++this.nextPull,
        state: "open",
        merged: false,
        merged_at: undefined,
        title: body?.variables?.title,
        body: body?.variables?.body,
        base: { ref: pull.base.ref, repo: { id: repoId } },
        head: { ref: `revert-${pull.number}-${pull.head.ref}`, repo: { id: repoId } },
        user: { login: `${APP_SLUG}[bot]`, type: "Bot" },
      })
      return this.json({
        data: {
          revertPullRequest: {
            revertPullRequest: { number: created.number, url: created.html_url, headRefName: created.head.ref },
          },
        },
      })
    }
    const prefix = `/repos/${repo.fullName}`
    if (!url.pathname.startsWith(`${prefix}/`)) return this.json({ message: "Not Found" }, 404)
    const rest = url.pathname.slice(prefix.length)
    if (method !== "GET") {
      const needs = rest.startsWith("/pulls") ? "pull_requests" : "contents"
      if (!can(needs)) return this.json({ message: "Resource not accessible by integration" }, 403)
      this.writes.push({ method, path: rest, ...(body ? { body } : {}) })
    }
    if (rest === "/contents/.vector/ops.json" && method === "GET") {
      const ref = url.searchParams.get("ref") ?? repo.defaultBranch
      const file = this.optIns.has(`${repoId}@${ref}`)
        ? this.optIns.get(`${repoId}@${ref}`)
        : this.optIns.get(`${repoId}@*`)
      if (file === null || file === undefined) return this.json({ message: "Not Found" }, 404)
      return this.json({
        type: "file",
        encoding: "base64",
        size: Buffer.byteLength(file),
        content: Buffer.from(file)
          .toString("base64")
          .replace(/(.{60})/g, "$1\n"),
      })
    }
    const compare = /^\/compare\/(.+)$/.exec(rest)
    if (compare && method === "GET") {
      const found = this.compares.get(`${repoId}:${decodeURIComponent(compare[1]!)}`)
      return found ? this.json(found) : this.json({ message: "Not Found" }, 404)
    }
    const commitPulls = /^\/commits\/([0-9a-f]{40})\/pulls$/.exec(rest)
    if (commitPulls && method === "GET") return this.json(this.commitPulls.get(`${repoId}:${commitPulls[1]}`) ?? [])
    const onePull = /^\/pulls\/(\d+)$/.exec(rest)
    if (onePull && method === "GET") {
      const pull = this.pulls.get(`${repoId}#${onePull[1]}`)
      return pull ? this.json(pull) : this.json({ message: "Not Found" }, 404)
    }
    if (rest === "/pulls" && method === "GET") {
      const base = url.searchParams.get("base")
      const head = url.searchParams.get("head")
      const [owner] = repo.fullName.split("/")
      return this.json(
        [...this.pulls.values()].filter(
          (pull) =>
            pull.state === "open" &&
            pull.base.repo.id === repoId &&
            (!base || pull.base.ref === base) &&
            (!head || head === `${owner}:${pull.head.ref}`),
        ),
      )
    }
    if (rest === "/pulls" && method === "POST") {
      const exists = [...this.pulls.values()].some(
        (pull) => pull.state === "open" && pull.base.repo.id === repoId && pull.head.ref === body?.head,
      )
      if (exists) return this.json({ message: "A pull request already exists" }, 422)
      const created = this.addPull(repoId, {
        number: ++this.nextPull,
        state: "open",
        merged: false,
        merged_at: undefined,
        title: body?.title,
        body: body?.body,
        base: { ref: body?.base, repo: { id: repoId } },
        head: { ref: body?.head, repo: { id: repoId } },
        user: { login: `${APP_SLUG}[bot]`, type: "Bot" },
      })
      return this.json(created, 201)
    }
    if (/^\/pulls\/\d+\/merge$/.test(rest)) return this.json({ merged: true })
    const ref = /^\/git\/ref\/heads\/(.+)$/.exec(rest)
    if (ref && method === "GET") {
      const branch = ref[1]!.split("/").map(decodeURIComponent).join("/")
      const sha = this.refs.get(`${repoId}:${branch}`)
      return sha
        ? this.json({ ref: `refs/heads/${branch}`, object: { sha, type: "commit" } })
        : this.json({ message: "Not Found" }, 404)
    }
    const commit = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest)
    if (commit && method === "GET") {
      const found = this.commits.get(`${repoId}:${commit[1]}`)
      return found
        ? this.json({
            sha: commit[1],
            tree: { sha: found.tree },
            parents: found.parents.map((parent) => ({ sha: parent })),
          })
        : this.json({ message: "Not Found" }, 404)
    }
    if (rest === "/git/commits" && method === "POST") {
      const sha = this.newSha()
      this.commits.set(`${repoId}:${sha}`, { tree: body?.tree, parents: body?.parents })
      return this.json({ sha }, 201)
    }
    if (rest === "/git/refs" && method === "POST") {
      const branch = String(body?.ref).replace(/^refs\/heads\//, "")
      if (this.refs.has(`${repoId}:${branch}`)) return this.json({ message: "Reference already exists" }, 422)
      this.refs.set(`${repoId}:${branch}`, body?.sha)
      return this.json({ ref: body?.ref, object: { sha: body?.sha } }, 201)
    }
    return this.json({ message: "Not Found" }, 404)
  }
}

/** Every fake, reset per test. */
export class OpsWorld {
  fakes = codiumFakes({ now: NOW })
  worker = new Worker()
  readonly sessions = new Map<string, Session>()
  /** DNS-over-HTTPS answers: TXT values per name, or a status, or a failure. */
  readonly txt = new Map<string, string[] | { status: number } | "fail">()
  readonly bindings = new Map<string, OpsRepoBinding>()
  now = NOW
  readonly github = new FakeGithub(() => this.now)
  restore = () => {}

  constructor(overrides: Record<string, string | undefined> = {}) {
    this.restore = codiumTestEnvironment({ ...OPS_ENVIRONMENT, ...overrides })
    registerOpsScripts(this.fakes.store)
    registerRecordScripts(this.fakes.store, this.fakes.clock)
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
      if (url.origin === "https://api.github.com") return this.github.fetch(url, init)
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
    const binding = { account, repository: `octo-fixture/repo-${repositoryId}`, ...extra }
    this.bindings.set(String(repositoryId), binding)
    // The repository on GitHub, with the App installed (A48's server tokens).
    if (!this.github.repos.has(repositoryId))
      this.github.addRepo(repositoryId, binding.repository, {
        ...(binding.installationId !== undefined ? { installationId: Number(binding.installationId) } : {}),
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
