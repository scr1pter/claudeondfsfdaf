import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { RedisClient } from "bun"
import { createHash, randomUUID } from "node:crypto"
import { Readable } from "node:stream"
import { __test, handleAccountDelete } from "../api/account/delete"
import { handleAccountDeletions } from "../api/account/deletions"
import { readEntitlement, requireEntitlement } from "../api/_lib/codium-entitlements"
import {
  DELETION_ALERT_AFTER,
  DELETION_RECHECK_MS,
  deletionRetryMs,
  ERASE_PARTS,
  eraseAccountData,
  eraseAccountKeys,
  eraseParts,
  finishAccountDeletion,
  keptAccountKey,
  registerErasePart,
  type ErasePart,
} from "../api/_lib/codium-erase"
import { codiumKey } from "../api/_lib/codium-keys"
import { readSnapshot, snapshotKey } from "../api/_lib/codium-snapshot"
import {
  decodeTombstone,
  markAccountDeleting,
  readTombstone,
  TOMBSTONE_KEEP_MS,
  tombstoneKey,
  tombstonesDueKey,
} from "../api/_lib/codium-tombstone"
import { hostedJobKey, hostedJobsAccountKey, hostedJobsNightKey, hostedRecurringKey } from "../api/_lib/hosted-jobs"
import {
  archiveKey,
  hostedArchivesKey,
  hostedComputersKey,
  hostedEgressKey,
  hostedPagesKey,
  hostedSessionKey,
  hostedSessionsKey,
} from "../api/_lib/hosted-sessions"
import type { ApiRequest, ApiResponse } from "../api/_lib/http"
import {
  keyExpiresAt,
  modelPlanChange,
  modelPlanCheckout,
  protectModelPlanKey,
  readModelPlanAccount,
  reconcileModelPlanAccount,
} from "../api/_lib/model-plan-account"
import { cardIndexKey, cardKey } from "../api/_lib/ship-desk"
import { incidentIndexKey, incidentKey } from "../api/_lib/ops-incidents"
import { opsAccountsKey } from "../api/_lib/ops-accounts"
import { opsHealthKey } from "../api/_lib/ops-health"
import { runTokensRevokedKey } from "../api/_lib/codium-provisioners"
import { OPS_SETTINGS_SCRIPTS, opsSettingsKey } from "../api/_lib/ops-settings"
import { accountTokensRevoked, revocationConfigured, revokeAccountTokens } from "../api/_lib/revocation"
import { ballotsKey, nominationsKey, quartersKey, voterField } from "../api/_lib/roadmap"
import { accountReportsKey, reportKey } from "../api/_lib/support-reports"
import { setupVault, vaultAccount } from "../api/_lib/vault-store"
import { verifyWorkspaceRequest } from "../packages/cloud-workspaces/src/signing"
import {
  codiumFakes,
  codiumTestEnvironment,
  loadStripeFixture,
  type CodiumFakes,
} from "../packages/web/test/fixture/codium-fakes"
import {
  MemoryVaultBackend,
  R2_ORIGIN,
  SERVICE_ROLE,
  SUPABASE_ORIGIN,
  VAULT_ENVIRONMENT,
  vaultBucket,
} from "./brain-vault-fixture"

const original = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  KV_REST_API_URL: process.env.KV_REST_API_URL,
  KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
}

afterEach(() => {
  Object.entries(original).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
})

describe("account deletion configuration", () => {
  test("refuses to consider deletion without a service-role key", () => {
    process.env.SUPABASE_URL = "https://vector.supabase.co"
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    expect(__test.adminConfiguration()).toBeUndefined()
  })

  test("is available once the service-role key is set", () => {
    process.env.SUPABASE_URL = "https://vector.supabase.co/"
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_key"
    expect(__test.adminConfiguration()).toEqual({
      url: "https://vector.supabase.co",
      serviceRole: "service_role_key",
    })
  })
})

describe("deleting the identity", () => {
  const admin = { url: "https://vector.supabase.co", serviceRole: "service_role_key" }

  test("calls Supabase's admin endpoint with the service role", async () => {
    let seen: { url: string; method?: string; apikey?: string } | undefined
    await __test.deleteAccountUser(admin, "9db2bb31-81d5-43cb-b4a1-f1d3d799c9cb", (async (url: string, init: any) => {
      seen = { url, method: init?.method, apikey: init?.headers?.apikey }
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch)
    expect(seen?.url).toBe("https://vector.supabase.co/auth/v1/admin/users/9db2bb31-81d5-43cb-b4a1-f1d3d799c9cb")
    expect(seen?.method).toBe("DELETE")
    expect(seen?.apikey).toBe("service_role_key")
  })

  test("treats an already-missing user as deleted", async () => {
    await expect(
      __test.deleteAccountUser(
        admin,
        "gone",
        (async () => new Response("", { status: 404 })) as unknown as typeof fetch,
      ),
    ).resolves.toBeUndefined()
  })

  test("reports a refusal rather than claiming success", async () => {
    await expect(
      __test.deleteAccountUser(
        admin,
        "user",
        (async () => new Response("", { status: 500 })) as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/could not delete/i)
  })
})

describe("CLI token revocation", () => {
  test("says so when no store is configured, instead of pretending", async () => {
    delete process.env.KV_REST_API_URL
    delete process.env.KV_REST_API_TOKEN
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
    expect(revocationConfigured()).toBe(false)
    expect(await revokeAccountTokens("user")).toBe(false)
    expect(await accountTokensRevoked("user")).toBe(false)
  })

  test("writes the account id with an expiry longer than a token's life", async () => {
    process.env.KV_REST_API_URL = "https://kv.example.com"
    process.env.KV_REST_API_TOKEN = "kv-token"
    let seen = ""
    const ok = await revokeAccountTokens("user-1", (async (url: string) => {
      seen = url
      return Response.json({ result: "OK" })
    }) as unknown as typeof fetch)
    expect(ok).toBe(true)
    expect(seen).toContain("/set/vector%3Acli-revoked%3Auser-1/1")
    const expiry = Number(new URL(seen).searchParams.get("ex"))
    expect(expiry).toBeGreaterThan(90 * 24 * 60 * 60)
  })

  test("reads a revoked account back", async () => {
    process.env.KV_REST_API_URL = "https://kv.example.com"
    process.env.KV_REST_API_TOKEN = "kv-token"
    const revoked = await accountTokensRevoked(
      "user-1",
      (async () => new Response(JSON.stringify({ result: "1" }), { status: 200 })) as unknown as typeof fetch,
    )
    expect(revoked).toBe(true)
  })

  test("fails open when the store is unreachable, so a Redis outage locks nobody out", async () => {
    process.env.KV_REST_API_URL = "https://kv.example.com"
    process.env.KV_REST_API_TOKEN = "kv-token"
    const revoked = await accountTokensRevoked("user-1", (async () => {
      throw new Error("unreachable")
    }) as unknown as typeof fetch)
    expect(revoked).toBe(false)
  })
})

// ── WP A57: the tombstone, the erase and the cleanup cron (P5) ─────────────────────────────────────────────────────
//
// Contract §3 P5: account deletion erases every Codium and hosted record (tombstone first, retried by cron), except
// pseudonymous financial ledger lines. The store, Stripe and OpenRouter are the Codium fakes
// (packages/web/test/fixture/codium-fakes.ts); the vault is A44's in-memory database and bucket; the relay and the ops
// Worker are stand-ins that answer `erase` (their own erase is tested in packages/relay and packages/ops-worker); the
// identity service records each deletion. Nothing reaches a real service.

const FIXTURE = loadStripeFixture("active-paid")
const ACCOUNT = FIXTURE.accountId
const EMAIL = "leaving@example.test"
const MINUTE = 60_000
const DAY = 86_400_000
const RELAY_HOST = "relay.deletion-fixture.invalid"
const WORKER_HOST = "ops-worker.deletion-fixture.invalid"
const WORKSPACES_HOST = "workspaces.deletion-fixture.invalid"
const WORKSPACES_SECRET = "deletion-fixture-workspaces-secret-".padEnd(48, "w")
/** A deployment that was given a cloud workspace host (cloud-workspaces.ts `cloudWorkspacesConfigured`). */
const WORKSPACES_ENVIRONMENT = {
  VECTOR_WORKSPACES_ORIGIN: `https://${WORKSPACES_HOST}`,
  VECTOR_WORKSPACES_SECRET: WORKSPACES_SECRET,
}
const CRON = "deletion-fixture-cron-secret"
const VAULT = "d".repeat(32)
const RID = `r_${"a".repeat(26)}`
const QUARTER = "2026-q3"
const SESSION = `hs_${"b".repeat(26)}`
const JOB = `jb_${"c".repeat(26)}`
const INCIDENT = `inc_${"d".repeat(22)}`
const CARD = `crd_${"e".repeat(22)}`
const OPS_ID = `ops_${"f".repeat(22)}`
const REPORT_HASH = createHash("sha256").update(`vector-report-account:${ACCOUNT}`).digest("hex")

function deletionEnvironment(overrides: Record<string, string | undefined> = {}) {
  return codiumTestEnvironment({
    ...VAULT_ENVIRONMENT,
    CODIUM_LISTED_PERKS: undefined,
    VECTOR_ADMIN_EMAILS: EMAIL,
    VECTOR_REMOTE_RELAY_URL: `wss://${RELAY_HOST}`,
    VECTOR_HOSTED_INTERNAL_SECRET: "deletion-fixture-internal-secret-".padEnd(48, "i"),
    VECTOR_OPS_WORKER_URL: `https://${WORKER_HOST}`,
    VECTOR_OPS_SHARED_SECRET: "deletion-fixture-ops-secret-".padEnd(48, "o"),
    // The Worker is still asked to erase with the ops services turned off (ops-worker.ts `opsErasable`).
    VECTOR_OPS_ENABLED: undefined,
    VECTOR_HOSTED_PROVIDER: undefined,
    VECTOR_HOSTED_ACCOUNT_SALT: "deletion-fixture-hosted-salt-".padEnd(48, "s"),
    CRON_SECRET: CRON,
    VECTOR_ABUSE_SECRET: "deletion-fixture-abuse-secret-".padEnd(48, "a"),
    RESEND_API_KEY: undefined,
    CODIUM_OWNER_EMAIL: undefined,
    VECTOR_BUG_REPORT_TO: undefined,
    // Cloud workspaces are off by default: a deployment that was never given a host skips their part.
    VECTOR_WORKSPACES_ORIGIN: undefined,
    VECTOR_WORKSPACES_SECRET: undefined,
    VECTOR_WORKSPACES_ENABLED: undefined,
    VECTOR_WORKSPACES_ACCOUNTS: undefined,
    ...overrides,
  })
}

type Services = {
  relayDown: boolean
  workerDown: boolean
  identityDown: boolean
  workspacesDown: boolean
  relay: string[]
  worker: string[]
  identities: string[]
  /** The account each close request to the workspace host was signed for, in order (failed ones too). */
  workspaces: string[]
  /** The accounts the workspace host has fenced, as its `closed_account` table holds them. */
  closedWorkspaces: Set<string>
  /** How many of the account's workspaces the host has not erased yet (its close answers this as `remaining`). */
  workspacesLeft: number
}
type World = {
  fakes: CodiumFakes
  fetcher: typeof fetch
  services: Services
  backend: MemoryVaultBackend
  clock: () => number
}

/** A Plus subscriber (the active-paid fixture) and every service around them, behind one fetch. */
function deletionWorld(): World {
  const fakes = codiumFakes({ now: FIXTURE.now * 1000 })
  fakes.stripe.load(FIXTURE.objects)
  fakes.store.set(codiumKey("account", ACCOUNT), JSON.stringify(FIXTURE.account))
  // A47's settings script, as its own fixture runs it (test/ops-fixture.ts `registerOpsScripts`).
  fakes.store.scripts.set(OPS_SETTINGS_SCRIPTS.SAVE, (keys, argv) => {
    const store = fakes.store
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
  const backend = new MemoryVaultBackend()
  const bucket = vaultBucket(() => fakes.clock.now)
  const services: Services = {
    relayDown: false,
    workerDown: false,
    identityDown: false,
    workspacesDown: false,
    relay: [],
    worker: [],
    identities: [],
    workspaces: [],
    closedWorkspaces: new Set(),
    workspacesLeft: 0,
  }
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.host === RELAY_HOST) {
      services.relay.push(url.pathname)
      return services.relayDown ? new Response("unavailable", { status: 503 }) : Response.json({ erased: true })
    }
    if (url.host === WORKER_HOST) {
      services.worker.push(url.pathname)
      return services.workerDown ? new Response("unavailable", { status: 503 }) : Response.json({ erased: true })
    }
    if (url.host === WORKSPACES_HOST) {
      // The workspace host's account close (packages/cloud-workspaces service.ts): signed for one account, `{}` only,
      // answered `closed` again for an account it already closed, with how many workspaces it has not erased yet.
      const body = String(init?.body ?? "")
      const { accountId } = verifyWorkspaceRequest({
        secret: WORKSPACES_SECRET,
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        path: url.pathname,
        body,
      })
      services.workspaces.push(accountId)
      if (url.pathname !== "/accounts/close" || init?.method !== "POST" || body !== "{}")
        return new Response(null, { status: 400 })
      if (services.workspacesDown) return new Response("unavailable", { status: 503 })
      services.closedWorkspaces.add(accountId)
      return Response.json({ closed: true, remaining: services.workspacesLeft }, { status: 202 })
    }
    if (url.origin === R2_ORIGIN) return bucket.handle(url, init)
    if (url.origin === SUPABASE_ORIGIN) {
      if (new Headers(init?.headers).get("apikey") !== SERVICE_ROLE) return new Response(null, { status: 401 })
      if (url.pathname === "/rest/v1/rpc/vector_brain_vault" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { request: Record<string, unknown> }
        return Response.json(await backend.call(body.request))
      }
      const user = /^\/auth\/v1\/admin\/users\/([^/]+)$/.exec(url.pathname)?.[1]
      if (user && init?.method === "DELETE") {
        if (services.identityDown) return new Response("unavailable", { status: 500 })
        services.identities.push(decodeURIComponent(user))
        return new Response(null, { status: 200 })
      }
    }
    return fakes.fetcher(input, init)
  }) as typeof fetch
  setSystemTime(new Date(fakes.clock.now))
  return { fakes, fetcher, services, backend, clock: () => fakes.clock.now }
}

/** Moves the fake clock and the system clock together. */
function advance(w: World, ms: number) {
  w.fakes.clock.advance(ms)
  setSystemTime(new Date(w.clock()))
}

/** A record in every Codium and hosted service, as each service stores it, plus an active Plus plan with its key. */
async function seedEverything(w: World) {
  const store = w.fakes.store
  const now = w.clock()
  expect((await reconcileModelPlanAccount(ACCOUNT, w.fetcher, now)).state).toBe("active")
  // A33's report record and the account's index of report ids.
  store.set(reportKey(RID), JSON.stringify({ v: 1, status: "received", createdAt: now, updatedAt: now }))
  store.members(accountReportsKey(ACCOUNT)).add(RID)
  // A34's ballot and nomination.
  store.members(quartersKey()).add(QUARTER)
  store.hash(ballotsKey(QUARTER)).set(voterField(ACCOUNT), JSON.stringify({ v: 1, plan: "vector-100" }))
  store.hash(nominationsKey(QUARTER)).set(voterField(ACCOUNT), JSON.stringify({ v: 1, plan: "vector-200" }))
  // A31's founding record, place on the founders page and display name.
  store.hash(codiumKey("founding", "member", ACCOUNT)).set("number", "7")
  store.zset(codiumKey("founding", "listed")).set(ACCOUNT, 7)
  store.hash(codiumKey("founding", "names")).set(ACCOUNT, "Ada")
  // A37's push subscription.
  store.hash(codiumKey("notify", "subs", ACCOUNT)).set("sub_1", JSON.stringify({ id: "sub_1" }))
  // A44's vault, with its wrapped key and one stored object.
  const key = {
    format: "vector-vault-key",
    version: 1,
    vault: VAULT,
    kdf: { name: "scrypt", N: 2 ** 17, r: 8, p: 1, salt: "c2FsdHNhbHRzYWx0c2FsdA" },
    nonce: "bm9uY2Vub25jZW5v",
    ciphertext: "Y2lwaGVydGV4dGNpcGhlcnRleHRjaXBoZXJ0ZXh0Y2lwaGVy",
    createdAt: now,
  } as Parameters<typeof setupVault>[1]["key"]
  await setupVault(ACCOUNT, { vault: VAULT, key, versionDays: 30 }, { fetcher: w.fetcher, now })
  await w.backend.seedStored(vaultAccount(ACCOUNT), 1_000)
  // A55's job and recurring job; A53's session and computer.
  store.zset(hostedJobsAccountKey(ACCOUNT)).set(JOB, now)
  store.set(hostedJobKey(JOB), JSON.stringify({ account: ACCOUNT, state: "done" }))
  store.hash(hostedRecurringKey(ACCOUNT)).set(`jr_${"g".repeat(26)}`, JSON.stringify({ account: ACCOUNT }))
  store.zset(hostedSessionsKey(ACCOUNT)).set(SESSION, now)
  store.set(hostedSessionKey(SESSION), JSON.stringify({ account: ACCOUNT, state: "ended" }))
  store.members(hostedComputersKey(ACCOUNT)).add("1")
  // A47-A50's settings, incident, card, domain health and the crons' roster.
  store.set(
    opsSettingsKey(ACCOUNT),
    JSON.stringify({ v: 1, opsId: OPS_ID, revision: 1, domains: [], monitors: [], repos: [] }),
  )
  store.zset(incidentIndexKey(ACCOUNT)).set(INCIDENT, now)
  store.set(incidentKey(ACCOUNT, INCIDENT), JSON.stringify({ account: ACCOUNT }))
  store.zset(cardIndexKey(ACCOUNT)).set(CARD, now)
  store.set(cardKey(ACCOUNT, CARD), JSON.stringify({ account: ACCOUNT }))
  store.set(opsHealthKey(ACCOUNT), JSON.stringify({ account: ACCOUNT }))
  store.zset(opsAccountsKey()).set(ACCOUNT, now)
  // Counters keyed by the account id that no part erases by name (the last part's sweep does): a per-period meter, a
  // cached estimate, the cloud computer's fair-use counts, Done by Morning's nightly count, the no-run spend counter.
  const day = new Date(now).toISOString().slice(0, 10)
  const keep = 40 * DAY
  for (const key of [
    codiumKey("meter", ACCOUNT, `sub_active:${now}`, "ship-desk-cards"),
    codiumKey("estimate", ACCOUNT, `sub_active:${now}`, "full", "0.25", 4),
    hostedPagesKey(ACCOUNT, `${day}T10`),
    hostedEgressKey(ACCOUNT, day),
    hostedJobsNightKey(ACCOUNT, day),
    codiumKey("run", `no-run-${ACCOUNT}`),
  ]) {
    store.set(key, "1")
    store.expires.set(key, now + keep)
  }
  // Kept on purpose: a pool debit (a pseudonymous ledger line) and the run-token revocation mark, both expiring.
  store.hash(codiumKey("debits", ACCOUNT, "f".repeat(64))).set("ref_1", JSON.stringify({ micro: 1_000, applied: true }))
  store.expires.set(codiumKey("debits", ACCOUNT, "f".repeat(64)), now + keep)
  store.set(runTokensRevokedKey(ACCOUNT), String(now))
  store.expires.set(runTokensRevokedKey(ACCOUNT), now + 35 * DAY)
}

/** Everything a stored value holds, as one string, to look for the account in it. */
function storedText(w: World, key: string) {
  const value = w.fakes.store.live(key)
  if (!value) return ""
  if (value.kind === "string") return value.value
  if (value.kind === "set") return [...value.value].join(" ")
  return [...value.value].map(([field, item]) => `${field} ${item}`).join(" ")
}

/**
 * P5's check: every store key that still names the account, by id or by the hashes its records are kept under, or
 * holds it, with the reason it may stay. A key with no reason is a record deletion left behind.
 */
function leftovers(w: World) {
  const names = [ACCOUNT, voterField(ACCOUNT), REPORT_HASH]
  const prefix = "vector:codium:test:"
  return w.fakes.store
    .keys()
    .filter((key) => names.some((name) => key.includes(name) || storedText(w, key).includes(name)))
    .map((key) => {
      const rest = key.startsWith(prefix) ? key.slice(prefix.length) : key
      const ttl = w.fakes.store.pttl(key)
      // The deletion record itself, kept TOMBSTONE_KEEP_MS once the deletion is finished.
      if (rest === `tombstone:${ACCOUNT}`) return { key: rest, kept: "tombstone", ttl }
      // The cron's list of unfinished deletions, until the follow-up pass takes it off.
      if (rest === "tombstones:due") return { key: rest, kept: "deletion due", ttl }
      // The pool's spend ledger (A17), named by the key's hash: a pseudonymous ledger line that expires with its period.
      if (/^(model-spend|model-reservations|held|day|purpose):/.test(rest))
        return { key: rest, kept: "pool ledger", ttl }
      // Pool debits (§4.6), the store's pseudonymous ledger lines, which expire 40 days after the period.
      if (rest.startsWith(`debits:${ACCOUNT}:`)) return { key: rest, kept: "ledger", ttl }
      // The run-token revocation mark, a security record that expires (35 days).
      if (rest === `runs:revoked-before:${ACCOUNT}`) return { key: rest, kept: "revocation mark", ttl }
      return { key: rest, kept: undefined, ttl }
    })
}

/** Runs a route handler with a request and answers what it sent. */
function invoke(
  handler: (request: ApiRequest, response: ApiResponse) => Promise<void>,
  input: { method: string; body?: unknown; authorization?: string },
): Promise<{ status: number; body: any }> {
  const request = Object.assign(Readable.from([]), {
    method: input.method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "192.0.2.57",
      ...(input.authorization ? { authorization: input.authorization } : {}),
    },
    url: "/api/account/delete",
    ...(input.body !== undefined ? { body: input.body } : {}),
  }) as unknown as ApiRequest
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      setHeader() {
        return response
      },
      end(value?: string) {
        resolve({ status: response.statusCode, body: value ? JSON.parse(value) : undefined })
        return response
      },
    }
    void handler(request, response as unknown as ApiResponse).catch(reject)
  })
}

/** The deletion route as the website calls it, signed in as the fixture's account. */
function deleteRoute(w: World, confirm = EMAIL, overrides: Parameters<typeof handleAccountDelete>[2] = {}) {
  return invoke(
    (request, response) =>
      handleAccountDelete(request, response, {
        fetcher: w.fetcher,
        clock: w.clock,
        // The revocation mark goes through Upstash's path-style REST call, which the fake store does not speak; its
        // own tests are above. Usage counts live in the usage database (api/_lib/usage.ts).
        revoke: async () => true,
        forget: async () => true,
        verifyUser: async () => ({ id: ACCOUNT, email: EMAIL }),
        ...overrides,
      }),
    { method: "POST", body: { confirm } },
  )
}

function cronRoute(w: World, secret = CRON) {
  return invoke(
    (request, response) =>
      handleAccountDeletions(request, response, {
        fetcher: w.fetcher,
        clock: w.clock,
        revoke: async () => true,
        forget: async () => true,
      }),
    { method: "GET", authorization: `Bearer ${secret}` },
  )
}

describe("the tombstone (WP A57)", () => {
  let restore = () => {}
  beforeEach(() => {
    restore = deletionEnvironment()
  })
  afterEach(() => {
    restore()
    setSystemTime()
  })

  test("is set once, keeps its first time, files the deletion as due, and refuses anything else under its key", async () => {
    const w = deletionWorld()
    const now = w.clock()
    const first = await markAccountDeleting(ACCOUNT, now, now + 5 * MINUTE, w.fetcher)
    expect(first).toEqual({ v: 1, at: now, attempts: 0 })
    const again = await markAccountDeleting(ACCOUNT, now + MINUTE, now + 6 * MINUTE, w.fetcher)
    expect(again.at).toBe(now)
    expect(w.fakes.store.zset(tombstonesDueKey()).get(ACCOUNT)).toBe(now + 6 * MINUTE)
    expect(w.fakes.store.pttl(tombstoneKey(ACCOUNT))).toBe(-1)
    // Times, a count and part ids only.
    expect(decodeTombstone(JSON.stringify({ v: 1, at: now, attempts: 0, failed: ["ops"] }))).toMatchObject({
      failed: ["ops"],
    })
    expect(decodeTombstone(JSON.stringify({ v: 1, at: now, attempts: 0, failed: ["Ops failed for a@b.c"] }))).toBe(
      undefined,
    )
    expect(decodeTombstone(JSON.stringify({ v: 1, at: now, attempts: 0, email: EMAIL }))).toEqual({
      v: 1,
      at: now,
      attempts: 0,
    })
    // Something else under the key still means a deletion started: fail closed.
    w.fakes.store.set(tombstoneKey(ACCOUNT), "not a tombstone")
    expect(await readTombstone(ACCOUNT, w.fetcher)).toBeDefined()
  })

  test("checkout refuses an account being deleted that never bought anything, before any Stripe call", async () => {
    const w = deletionWorld()
    w.fakes.store.remove(codiumKey("account", ACCOUNT))
    w.fakes.store.set(
      codiumKey("funding"),
      JSON.stringify({
        status: "open",
        checkedAt: w.clock(),
        since: w.clock(),
        balance: 1_000_000,
        owed: 0,
        reserved: 0,
        required: 0,
        keys: 0,
      }),
    )
    await markAccountDeleting(ACCOUNT, w.clock(), w.clock() + 5 * MINUTE, w.fetcher)
    await expect(
      modelPlanCheckout({ id: ACCOUNT, email: EMAIL }, "vector-10", w.fetcher, w.clock()),
    ).rejects.toMatchObject({ statusCode: 409, code: "MODEL_PLAN_ACCOUNT_CLOSING" })
    expect(w.fakes.stripe.calls).toEqual([])
    expect(await readModelPlanAccount(ACCOUNT, w.fetcher)).toBeUndefined()
  })

  test("a plan change and every perk refuse it, and reconcile closes the account without asking Stripe", async () => {
    const w = deletionWorld()
    const active = await reconcileModelPlanAccount(ACCOUNT, w.fetcher, w.clock())
    expect(active.state).toBe("active")
    await markAccountDeleting(ACCOUNT, w.clock(), w.clock() + 5 * MINUTE, w.fetcher)
    await expect(
      modelPlanChange({ id: ACCOUNT, email: EMAIL }, "vector-50", w.fetcher, w.clock()),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "MODEL_PLAN_ACCOUNT_CLOSING",
    })
    const calls = w.fakes.stripe.calls.length
    advance(w, MINUTE)
    // A notification arriving now (any reconcile) cannot reopen it: the record is marked closing, the snapshot ends.
    const closed = await reconcileModelPlanAccount(ACCOUNT, w.fetcher, w.clock(), { source: "webhook" })
    expect(closed).toMatchObject({ state: "ended", reason: "closing", plan: "vector-10", version: active.version + 1 })
    expect(w.fakes.stripe.calls.length).toBe(calls)
    expect((await readModelPlanAccount(ACCOUNT, w.fetcher))?.closing).toBe(true)
    expect([...w.fakes.openRouter.keys.values()].every((key) => key.disabled === true)).toBe(true)
    for (const perk of ["codium", "hosted", "ops", "vault", "remote", "vote"] as const)
      await expect(requireEntitlement(ACCOUNT, perk, w.fetcher, w.clock())).rejects.toMatchObject({
        statusCode: 409,
        code: "MODEL_PLAN_ACCOUNT_CLOSING",
      })
  })

  test("once the records are erased, reads answer closing and nothing writes a record back", async () => {
    const w = deletionWorld()
    await markAccountDeleting(ACCOUNT, w.clock(), w.clock() + 5 * MINUTE, w.fetcher)
    // No account record and no snapshot, as after the erase.
    w.fakes.store.remove(codiumKey("account", ACCOUNT))
    const snapshot = await reconcileModelPlanAccount(ACCOUNT, w.fetcher, w.clock(), { source: "webhook" })
    expect(snapshot).toMatchObject({ state: "ended", reason: "closing", plan: null })
    expect(w.fakes.store.get(snapshotKey(ACCOUNT))).toBeUndefined()
    expect(await readEntitlement(ACCOUNT, w.fetcher, w.clock())).toMatchObject({ state: "ended", reason: "closing" })
    await expect(requireEntitlement(ACCOUNT, "codium", w.fetcher, w.clock())).rejects.toMatchObject({
      code: "MODEL_PLAN_ACCOUNT_CLOSING",
    })
    expect(w.fakes.store.get(snapshotKey(ACCOUNT))).toBeUndefined()
    expect(w.fakes.stripe.calls).toEqual([])
  })
})

describe("running a deletion (WP A57)", () => {
  let restore = () => {}
  beforeEach(() => {
    restore = deletionEnvironment()
  })
  afterEach(() => {
    restore()
    setSystemTime()
  })

  /** Parts that record their order and can be made to fail. */
  function recordingParts(log: string[], failing: Set<string>): ErasePart[] {
    return ERASE_PARTS.map((part) => ({
      ...part,
      configured: () => true,
      erase: async () => {
        log.push(part.id)
        if (failing.has(part.id)) throw new Error("unreachable")
      },
    }))
  }

  function steps(log: string[], failing = new Set<string>()) {
    return {
      parts: recordingParts(log, failing),
      close: async () => void log.push("close"),
      revoke: async () => (log.push("revoke"), !failing.has("revoke")),
      closeWorkspaces: async () => void log.push("workspaces-close"),
      cancel: async () => {
        log.push("billing")
        if (failing.has("billing")) throw new Error("stripe down")
      },
      forget: async () => (log.push("usage"), true),
      identity: async () => {
        log.push("identity")
        if (failing.has("identity")) throw new Error("identity down")
      },
    }
  }

  test("goes tombstone, revoke, the workspaces' close, close, billing, the contract's erase order, the marker, usage, then the identity", async () => {
    const w = deletionWorld()
    const log: string[] = []
    await markAccountDeleting(ACCOUNT, w.clock(), w.clock() + 5 * MINUTE, w.fetcher)
    const outcome = await finishAccountDeletion(ACCOUNT, { fetcher: w.fetcher, clock: w.clock, ...steps(log) })
    expect(outcome).toEqual({ state: "deleted", tokens: "revoked", usage: "deleted" })
    expect(log).toEqual([
      "revoke",
      "workspaces-close",
      "close",
      "billing",
      "workspaces",
      "reports",
      "roadmap",
      "founding",
      "push",
      "remote",
      "vault",
      "overnight",
      "computer",
      "ops",
      "codium",
      "keys",
      "usage",
      "identity",
    ])
    const record = await readTombstone(ACCOUNT, w.fetcher)
    expect(record).toMatchObject({ attempts: 0, erasedAt: w.clock(), identityAt: w.clock() })
    // The follow-up pass is filed for later.
    expect(w.fakes.store.zset(tombstonesDueKey()).get(ACCOUNT)).toBe(w.clock() + DELETION_RECHECK_MS)
  })

  test("a part that fails leaves the tombstone, keeps the identity, and still erases every part that does not need it", async () => {
    const w = deletionWorld()
    const log: string[] = []
    await markAccountDeleting(ACCOUNT, w.clock(), w.clock() + 5 * MINUTE, w.fetcher)
    const outcome = await finishAccountDeletion(ACCOUNT, {
      fetcher: w.fetcher,
      clock: w.clock,
      ...steps(log, new Set(["overnight"])),
    })
    expect(outcome).toEqual({ state: "pending", stage: "erase", failed: ["overnight", "computer", "codium", "keys"] })
    // The cloud computer waits for Done by Morning (it deletes the session list the jobs' logs are found by); the
    // account's own records and the last sweep wait for every part; the identity waits for the erase marker.
    expect(log).toEqual([
      "revoke",
      "workspaces-close",
      "close",
      "billing",
      "workspaces",
      "reports",
      "roadmap",
      "founding",
      "push",
      "remote",
      "vault",
      "overnight",
      "ops",
    ])
    expect(await readTombstone(ACCOUNT, w.fetcher)).toEqual({
      v: 1,
      at: w.clock(),
      attempts: 1,
      stage: "erase",
      failed: ["overnight", "computer", "codium", "keys"],
    })
    expect(w.fakes.store.zset(tombstonesDueKey()).get(ACCOUNT)).toBe(w.clock() + deletionRetryMs(1))
  })

  test("each earlier step that fails stops the deletion there, and a retry finishes it", async () => {
    for (const stage of ["revoke", "billing", "identity"] as const) {
      const w = deletionWorld()
      const log: string[] = []
      await markAccountDeleting(ACCOUNT, w.clock(), w.clock() + 5 * MINUTE, w.fetcher)
      const failed = await finishAccountDeletion(ACCOUNT, {
        fetcher: w.fetcher,
        clock: w.clock,
        ...steps(log, new Set([stage])),
      })
      expect(failed).toEqual({ state: "pending", stage, failed: [] })
      expect(log.includes("identity")).toBe(stage === "identity")
      log.length = 0
      const retried = await finishAccountDeletion(ACCOUNT, { fetcher: w.fetcher, clock: w.clock, ...steps(log) })
      expect(retried.state).toBe("deleted")
      // Once the erase marker is written, only the identity is left.
      if (stage === "identity") expect(log).toEqual(["usage", "identity"])
      else expect(log.at(-1)).toBe("identity")
    }
  })

  test("one run at a time: a second run while the first holds the lease is busy", async () => {
    const w = deletionWorld()
    await markAccountDeleting(ACCOUNT, w.clock(), w.clock() + 5 * MINUTE, w.fetcher)
    let inner: unknown
    const log: string[] = []
    const outcome = await finishAccountDeletion(ACCOUNT, {
      fetcher: w.fetcher,
      clock: w.clock,
      ...steps(log),
      close: async () => {
        inner = await finishAccountDeletion(ACCOUNT, { fetcher: w.fetcher, clock: w.clock, ...steps([]) })
      },
    })
    expect(inner).toEqual({ state: "busy" })
    expect(outcome.state).toBe("deleted")
  })

  test("the last part erases every key that still names the account, and keeps the ledger lines and marks", async () => {
    const w = deletionWorld()
    const store = w.fakes.store
    const keys = {
      meter: codiumKey("meter", ACCOUNT, "sub_active:1", "cloud-agents"),
      estimate: codiumKey("estimate", ACCOUNT, "sub_active:1", "full", "none", 3),
      noRun: codiumKey("run", `no-run-${ACCOUNT}`),
      status: codiumKey("status", ACCOUNT),
      // Kept on purpose (keptAccountKey).
      tombstone: tombstoneKey(ACCOUNT),
      deletionLease: `${tombstoneKey(ACCOUNT)}:lease`,
      billingLease: codiumKey("lease", ACCOUNT),
      debit: codiumKey("debits", ACCOUNT, "a".repeat(64)),
      revocationMark: runTokensRevokedKey(ACCOUNT),
      // Not this account's: another id that only starts with it, a key outside the Codium prefix, a pool's counter,
      // and (on this test-mode server) a live record, which only a live server erases.
      neighbour: codiumKey("meter", `${ACCOUNT}0`, "sub_other:1", "cloud-agents"),
      outside: `vector:cli-revoked:${ACCOUNT}`,
      pool: codiumKey("day", "b".repeat(64), "2026-11-09"),
      live: `vector:codium:live:meter:${ACCOUNT}:sub_live:1:cloud-agents`,
    }
    // Only these keys: the world's billing record goes too, and is counted apart.
    expect(store.remove(codiumKey("account", ACCOUNT))).toBe(true)
    for (const key of Object.values(keys)) store.set(key, "1")
    expect(await eraseAccountKeys(ACCOUNT, { fetcher: w.fetcher, now: w.clock() })).toBe(4)
    const left = Object.entries(keys)
      .filter(([, key]) => store.live(key))
      .map(([name]) => name)
    expect(left.sort()).toEqual(
      [
        "billingLease",
        "debit",
        "deletionLease",
        "live",
        "neighbour",
        "outside",
        "pool",
        "revocationMark",
        "tombstone",
      ].sort(),
    )
    expect(keptAccountKey(`meter:${ACCOUNT}:x`, ACCOUNT)).toBe(false)
    // One SCAN over the test prefix only.
    const scans = store.commands.filter((command) => command[0] === "SCAN")
    expect(scans).toEqual([["SCAN", "0", "MATCH", `vector:codium:test:*${ACCOUNT}*`, "COUNT", "1000"]])
    // A scan that runs out of time fails the part, so the cron runs it again.
    await expect(
      eraseAccountKeys(ACCOUNT, { fetcher: w.fetcher, now: w.clock(), deadline: Date.now() - 1 }),
    ).rejects.toMatchObject({ code: "ACCOUNT_ERASE_PENDING" })
  })

  test("a part another package registers (A59: Codex's records) runs before the account's own records, which wait for it", async () => {
    const w = deletionWorld()
    let fail = true
    const seen: string[] = []
    const unregister = registerErasePart({
      id: "cloud-agents",
      configured: () => true,
      erase: async (account) => {
        seen.push(account)
        if (fail) throw new Error("unreachable")
      },
    })
    try {
      expect(() => registerErasePart({ id: "codium", configured: () => true, erase: async () => {} })).toThrow()
      expect(() => registerErasePart({ id: "Not An Id", configured: () => true, erase: async () => {} })).toThrow()
      const ids = eraseParts().map((part) => part.id)
      expect(ids.slice(-3)).toEqual(["cloud-agents", "codium", "keys"])
      expect(eraseParts().find((part) => part.id === "codium")?.requires).toContain("cloud-agents")
      await markAccountDeleting(ACCOUNT, w.clock(), w.clock() + 5 * MINUTE, w.fetcher)
      const step = { fetcher: w.fetcher, clock: w.clock, revoke: async () => true, forget: async () => true }
      const failed = await finishAccountDeletion(ACCOUNT, step)
      expect(failed).toEqual({ state: "pending", stage: "erase", failed: ["cloud-agents", "codium", "keys"] })
      expect(w.services.identities).toEqual([])
      fail = false
      expect((await finishAccountDeletion(ACCOUNT, step)).state).toBe("deleted")
      expect(seen).toEqual([ACCOUNT, ACCOUNT])
      expect(w.services.identities).toEqual([ACCOUNT])
    } finally {
      unregister()
    }
    expect(eraseParts()).toBe(ERASE_PARTS)
  })

  test("cloud workspaces: a deployment never given a host skips their part; a partial setting fails it unsent", async () => {
    const w = deletionWorld()
    const workspaces = ERASE_PARTS.filter((part) => part.id === "workspaces")
    expect(workspaces).toHaveLength(1)
    // The account's own records and the last sweep wait for it, as they wait for every service part.
    expect(ERASE_PARTS.find((part) => part.id === "codium")?.requires).toContain("workspaces")
    expect(await eraseAccountData(ACCOUNT, { fetcher: w.fetcher, now: w.clock(), parts: workspaces })).toEqual({
      erased: true,
      failed: [],
      skipped: ["workspaces"],
    })
    process.env.VECTOR_WORKSPACES_ORIGIN = WORKSPACES_ENVIRONMENT.VECTOR_WORKSPACES_ORIGIN
    expect(await eraseAccountData(ACCOUNT, { fetcher: w.fetcher, now: w.clock(), parts: workspaces })).toEqual({
      erased: false,
      failed: ["workspaces"],
      skipped: [],
    })
    expect(w.services.workspaces).toEqual([])
  })

  test("cloud workspaces: a host that never answers stops their part by the deletion's deadline", async () => {
    restore()
    restore = deletionEnvironment(WORKSPACES_ENVIRONMENT)
    const w = deletionWorld()
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
      })) as typeof fetch
    const started = performance.now()
    const result = await eraseAccountData(ACCOUNT, {
      fetcher: hanging,
      now: w.clock(),
      deadline: Date.now() + 1_000,
      parts: ERASE_PARTS.filter((part) => part.id === "workspaces"),
    })
    expect(result).toEqual({ erased: false, failed: ["workspaces"], skipped: [] })
    // Its own limit is 10 seconds; inside a deletion it waits only until the deadline (at least a second).
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  test("cloud workspaces: closed right after the revoke, so a deletion that billing stops has already fenced them", async () => {
    restore()
    restore = deletionEnvironment(WORKSPACES_ENVIRONMENT)
    const w = deletionWorld()
    await markAccountDeleting(ACCOUNT, w.clock(), w.clock() + 5 * MINUTE, w.fetcher)
    const stripeDown = async () => {
      throw new Error("stripe down")
    }
    const quiet = { fetcher: w.fetcher, clock: w.clock, revoke: async () => true, close: async () => undefined }
    // The revoke store being down stops the deletion too, after the host was asked.
    expect(
      await finishAccountDeletion(ACCOUNT, { ...quiet, revoke: async () => false, cancel: stripeDown }),
    ).toMatchObject({ state: "pending" })
    expect(await finishAccountDeletion(ACCOUNT, { ...quiet, cancel: stripeDown })).toEqual({
      state: "pending",
      stage: "billing",
      failed: [],
    })
    expect(w.services.workspaces).toEqual([ACCOUNT, ACCOUNT])
    expect([...w.services.closedWorkspaces]).toEqual([ACCOUNT])
    // Once billing goes through, the erase part takes this run's close: the host is asked once per run.
    const outcome = await finishAccountDeletion(ACCOUNT, {
      ...quiet,
      cancel: async () => undefined,
      identity: async () => undefined,
    })
    expect(outcome).toMatchObject({ state: "deleted" })
    expect(w.services.workspaces).toEqual([ACCOUNT, ACCOUNT, ACCOUNT])
  })

  test("cloud workspaces: a close this run already failed fails their part without asking the host again", async () => {
    restore()
    restore = deletionEnvironment(WORKSPACES_ENVIRONMENT)
    const w = deletionWorld()
    const workspaces = ERASE_PARTS.filter((part) => part.id === "workspaces")
    const erase = (workspacesClosed?: boolean, pass?: "erase" | "check") =>
      eraseAccountData(ACCOUNT, {
        fetcher: w.fetcher,
        now: w.clock(),
        parts: workspaces,
        ...(workspacesClosed === undefined ? {} : { workspacesClosed }),
        ...(pass === undefined ? {} : { pass }),
      })
    expect((await erase(false, "erase")).failed).toEqual(["workspaces"])
    expect((await erase(true, "erase")).erased).toBe(true)
    expect(w.services.workspaces).toEqual([])
    // Without this run's close, the part asks the host; only the follow-up pass needs every workspace erased.
    w.services.workspacesLeft = 1
    expect((await erase(undefined, "erase")).erased).toBe(true)
    expect((await erase(undefined, "check")).failed).toEqual(["workspaces"])
    w.services.workspacesLeft = 0
    expect((await erase(undefined, "check")).erased).toBe(true)
    expect(w.services.workspaces).toEqual([ACCOUNT, ACCOUNT, ACCOUNT])
  })

  test("parts not started by the deadline are left for the cron", async () => {
    const w = deletionWorld()
    await markAccountDeleting(ACCOUNT, w.clock(), w.clock() + 5 * MINUTE, w.fetcher)
    const result = await eraseAccountData(ACCOUNT, {
      fetcher: w.fetcher,
      now: w.clock(),
      deadline: Date.now() - 1,
      parts: recordingParts([], new Set()),
    })
    expect(result.erased).toBe(false)
    expect(result.failed).toEqual(ERASE_PARTS.map((part) => part.id))
  })

  test("the cron backs off to six hours and emails the owner once a deletion keeps failing", async () => {
    restore()
    restore = deletionEnvironment({
      RESEND_API_KEY: "re_fixture",
      VECTOR_PURCHASE_EMAIL_FROM: "Vector <alerts@example.invalid>",
      CODIUM_OWNER_EMAIL: "owner@example.invalid",
    })
    expect([1, 2, 3, 6, 7, 12].map(deletionRetryMs)).toEqual([
      10 * MINUTE,
      20 * MINUTE,
      40 * MINUTE,
      320 * MINUTE,
      360 * MINUTE,
      360 * MINUTE,
    ])
    const w = deletionWorld()
    await markAccountDeleting(ACCOUNT, w.clock(), w.clock(), w.fetcher)
    for (let attempt = 1; attempt <= DELETION_ALERT_AFTER; attempt++) {
      const outcome = await finishAccountDeletion(ACCOUNT, {
        fetcher: w.fetcher,
        clock: w.clock,
        ...steps([], new Set(["ops"])),
      })
      expect(outcome.state).toBe("pending")
      expect(w.fakes.mail.sent.length).toBe(attempt < DELETION_ALERT_AFTER ? 0 : 1)
    }
    const email = w.fakes.mail.sent[0]!
    expect(email.subject).toBe("A Vector account deletion is stuck")
    expect(email.text).toContain(ACCOUNT)
    expect(email.text).toContain("ops, codium, keys")
    expect(email.text).not.toContain(EMAIL)
  })
})

describe("P5: deleting an account erases every Codium and hosted record (WP A57)", () => {
  let restore = () => {}
  beforeEach(() => {
    restore = deletionEnvironment()
  })
  afterEach(() => {
    restore()
    setSystemTime()
  })

  test("the request erases everything, deletes the identity after the marker, and the follow-up pass finishes", async () => {
    const w = deletionWorld()
    await seedEverything(w)
    expect(leftovers(w).filter((left) => !left.kept).length).toBeGreaterThan(10)

    const answer = await deleteRoute(w)
    expect(answer).toEqual({
      status: 200,
      body: { deleted: true, email: EMAIL, cliTokens: "revoked", usageCounts: "deleted", codium: "erased" },
    })
    expect(w.services.identities).toEqual([ACCOUNT])
    // The relay and the Worker were asked to erase what they hold.
    expect(w.services.relay.filter((path) => path.endsWith("/erase"))).toHaveLength(1)
    expect(w.services.worker.filter((path) => path.endsWith("/erase"))).toHaveLength(1)
    // Cloud workspaces are off by default: a deployment never given a workspace host has nothing to close.
    expect(w.services.workspaces).toEqual([])
    // Billing was cancelled and the key switched off.
    expect(w.fakes.stripe.subscription("sub_active")?.status).toBe("canceled")
    expect([...w.fakes.openRouter.keys.values()].every((key) => key.disabled === true)).toBe(true)
    // The vault's wrapped key and listing are gone; its object was queued and deleted from the bucket.
    expect((await w.backend.vaults(vaultAccount(ACCOUNT))).filter((vault) => vault.wrappedKey)).toEqual([])
    expect((await w.backend.blobs(vaultAccount(ACCOUNT))).filter((blob) => blob.state !== "trash")).toEqual([])
    expect(leftovers(w).filter((left) => !left.kept)).toEqual([])
    // Records kept under ids of their own (the report itself, the job and the session) went with their indexes.
    for (const key of [reportKey(RID), hostedJobKey(JOB), hostedSessionKey(SESSION), cardKey(ACCOUNT, CARD)])
      expect(w.fakes.store.live(key)).toBeUndefined()

    // The follow-up pass, 15 minutes later, finds nothing and finishes the deletion.
    advance(w, DELETION_RECHECK_MS)
    const cron = await cronRoute(w)
    expect(cron).toEqual({ status: 200, body: { due: 1, deleted: 0, checked: 1, pending: 0, busy: 0 } })
    expect(w.fakes.store.zset(tombstonesDueKey()).has(ACCOUNT)).toBe(false)
    const tombstone = await readTombstone(ACCOUNT, w.fetcher)
    expect(tombstone).toMatchObject({
      checkedAt: w.clock(),
      identityAt: expect.any(Number),
      erasedAt: expect.any(Number),
    })
    expect(w.fakes.store.pttl(tombstoneKey(ACCOUNT))).toBe(TOMBSTONE_KEEP_MS)
    // What may stay: the tombstone (which lapses), the pseudonymous ledger lines and the run-token revocation mark.
    const left = leftovers(w)
    expect(left.filter((entry) => !entry.kept)).toEqual([])
    expect(left.find((entry) => entry.kept === "tombstone")).toBeDefined()
    expect(left.find((entry) => entry.kept === "ledger")).toBeDefined()
    expect(left.find((entry) => entry.kept === "revocation mark")).toBeDefined()
    expect(left.some((entry) => /^(meter|estimate|run|hosted:(pages|egress|jobs:night)):/.test(entry.key))).toBe(false)
    expect(left.find((entry) => entry.kept === "deletion due")).toBeUndefined()
    // Each of them lapses by itself.
    expect(left.every((entry) => entry.ttl > 0)).toBe(true)
    // A late notification about the old subscription writes nothing back.
    await reconcileModelPlanAccount(ACCOUNT, w.fetcher, w.clock(), { source: "webhook" })
    expect(leftovers(w).filter((entry) => !entry.kept)).toEqual([])
    expect(w.fakes.store.get(snapshotKey(ACCOUNT))).toBeUndefined()
    expect(await readSnapshot(ACCOUNT, w.fetcher)).toBeUndefined()
  })

  test("the cloud computer's packed files are deleted from the media bucket, retried while it refuses (P8 review)", async () => {
    restore()
    restore = deletionEnvironment({
      VECTOR_R2_MEDIA_ACCESS_KEY_ID: "FIXTUREMEDIAKEY00001",
      VECTOR_R2_MEDIA_SECRET_ACCESS_KEY: "fixture/media/secret/for/deletion/0000",
    })
    const base = deletionWorld()
    const deleted: string[] = []
    let mediaDown = true
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin === R2_ORIGIN && url.pathname.startsWith("/vector-media/")) {
        if (init?.method !== "DELETE") return new Response(null, { status: 405 })
        if (mediaDown) return new Response("unavailable", { status: 503 })
        deleted.push(decodeURIComponent(url.pathname.slice("/vector-media/".length)))
        return new Response(null, { status: 204 })
      }
      return base.fetcher(input, init)
    }) as typeof fetch
    const w: World = { ...base, fetcher }
    await seedEverything(w)
    // An upload link for the session's packed files was signed, so the object may be in the bucket.
    w.fakes.store.members(hostedArchivesKey(ACCOUNT)).add(SESSION)

    const answer = await deleteRoute(w)
    expect(answer.status).toBe(503)
    expect(answer.body.error).toMatchObject({ code: "ACCOUNT_ERASE_PENDING", stage: "erase" })
    expect((await readTombstone(ACCOUNT, w.fetcher))?.failed).toContain("computer")
    expect(w.services.identities).toEqual([])
    // The session's records stay until its files are gone, so a retry still knows which files to delete.
    expect(w.fakes.store.members(hostedArchivesKey(ACCOUNT)).has(SESSION)).toBe(true)

    mediaDown = false
    advance(w, deletionRetryMs(1))
    expect((await cronRoute(w)).body).toMatchObject({ due: 1, deleted: 1 })
    expect(deleted).toEqual([archiveKey(ACCOUNT, SESSION)])
    expect(deleted[0]).toMatch(new RegExp(`^hosted/test/[a-f0-9]{32}/${SESSION}/files\\.tar\\.gz$`))
    expect(deleted[0]).not.toContain(ACCOUNT)
    expect(w.services.identities).toEqual([ACCOUNT])
    expect(w.fakes.store.live(hostedArchivesKey(ACCOUNT))).toBeUndefined()
  })

  test("Worker outage: the request answers pending, the tombstone stays, and the cron retries until it finishes", async () => {
    const w = deletionWorld()
    await seedEverything(w)
    w.services.workerDown = true

    const answer = await deleteRoute(w)
    expect(answer.status).toBe(503)
    expect(answer.body.error).toMatchObject({ code: "ACCOUNT_ERASE_PENDING", pending: true, stage: "erase" })
    expect(answer.body.error.message).toContain("Vector keeps trying")
    // The identity waits for the erase marker; the tombstone and the closing snapshot hold the account shut.
    expect(w.services.identities).toEqual([])
    expect(await readTombstone(ACCOUNT, w.fetcher)).toMatchObject({
      attempts: 1,
      stage: "erase",
      failed: ["ops", "codium", "keys"],
    })
    expect(await readSnapshot(ACCOUNT, w.fetcher)).toMatchObject({ state: "ended", reason: "closing" })
    await expect(requireEntitlement(ACCOUNT, "ops", w.fetcher, w.clock())).rejects.toMatchObject({
      code: "MODEL_PLAN_ACCOUNT_CLOSING",
    })
    expect(w.fakes.stripe.subscription("sub_active")?.status).toBe("canceled")
    // Everything that does not need the Worker is already gone. What waits: the account's own records and the counters
    // keyed by its id, which only the last two parts erase, after every other part.
    const waiting = leftovers(w)
      .filter((left) => !left.kept)
      .map((left) => left.key)
    expect(waiting.filter((key) => /^(reports|roadmap|notify|founding):/.test(key))).toEqual([])
    expect(
      waiting.filter((key) => key.startsWith("hosted:") && !/^hosted:(pages|egress|jobs:night):/.test(key)),
    ).toEqual([])
    expect(waiting).toContain(`account:${ACCOUNT}`)
    expect(waiting.some((key) => key.startsWith(`meter:${ACCOUNT}:`))).toBe(true)

    // The cron does nothing before the deletion is due again, and keeps it pending while the Worker is still down.
    expect((await cronRoute(w)).body).toEqual({ due: 0, deleted: 0, checked: 0, pending: 0, busy: 0 })
    advance(w, deletionRetryMs(1))
    expect((await cronRoute(w)).body).toEqual({ due: 1, deleted: 0, checked: 0, pending: 1, busy: 0 })
    expect(await readTombstone(ACCOUNT, w.fetcher)).toMatchObject({ attempts: 2 })
    expect(w.services.identities).toEqual([])

    // The Worker is back: the next due run erases the rest, writes the marker and deletes the identity.
    w.services.workerDown = false
    advance(w, deletionRetryMs(2))
    expect((await cronRoute(w)).body).toEqual({ due: 1, deleted: 1, checked: 0, pending: 0, busy: 0 })
    expect(w.services.identities).toEqual([ACCOUNT])
    expect(leftovers(w).filter((left) => !left.kept)).toEqual([])
    advance(w, DELETION_RECHECK_MS)
    expect((await cronRoute(w)).body).toEqual({ due: 1, deleted: 0, checked: 1, pending: 0, busy: 0 })
    expect(w.fakes.store.zset(tombstonesDueKey()).size).toBe(0)
    expect(w.fakes.store.pttl(tombstoneKey(ACCOUNT))).toBe(TOMBSTONE_KEEP_MS)
  })

  test("cloud workspaces: closed first, a host outage keeps the identity and the cron retries, every later pass closes again", async () => {
    restore()
    restore = deletionEnvironment(WORKSPACES_ENVIRONMENT)
    const w = deletionWorld()
    await seedEverything(w)
    w.services.workspacesDown = true

    const answer = await deleteRoute(w)
    expect(answer.status).toBe(503)
    expect(answer.body.error).toMatchObject({ code: "ACCOUNT_ERASE_PENDING", pending: true, stage: "erase" })
    // The close request was signed for the account being deleted, and the host refused it.
    expect(w.services.workspaces).toEqual([ACCOUNT])
    expect(w.services.closedWorkspaces.size).toBe(0)
    // Recorded like every other part: the tombstone names it, the account's own records and the last sweep wait for
    // it, the identity stays, and the deletion is filed as due again after the first backoff.
    expect(await readTombstone(ACCOUNT, w.fetcher)).toMatchObject({
      attempts: 1,
      stage: "erase",
      failed: ["workspaces", "codium", "keys"],
    })
    expect(w.fakes.store.zset(tombstonesDueKey()).get(ACCOUNT)).toBe(w.clock() + deletionRetryMs(1))
    expect(w.services.identities).toEqual([])
    // The parts that do not wait for it still ran.
    expect(w.services.relay.filter((path) => path.endsWith("/erase"))).toHaveLength(1)
    expect(w.services.worker.filter((path) => path.endsWith("/erase"))).toHaveLength(1)

    // Not due yet: the cron leaves it alone. Due, with the host still down: tried again and still pending.
    expect((await cronRoute(w)).body).toEqual({ due: 0, deleted: 0, checked: 0, pending: 0, busy: 0 })
    advance(w, deletionRetryMs(1))
    expect((await cronRoute(w)).body).toEqual({ due: 1, deleted: 0, checked: 0, pending: 1, busy: 0 })
    expect(await readTombstone(ACCOUNT, w.fetcher)).toMatchObject({
      attempts: 2,
      failed: ["workspaces", "codium", "keys"],
    })
    expect(w.services.workspaces).toEqual([ACCOUNT, ACCOUNT])
    expect(w.services.identities).toEqual([])

    // The host is back: the next due run closes the account there, erases the rest and deletes the identity.
    w.services.workspacesDown = false
    advance(w, deletionRetryMs(2))
    expect((await cronRoute(w)).body).toEqual({ due: 1, deleted: 1, checked: 0, pending: 0, busy: 0 })
    expect([...w.services.closedWorkspaces]).toEqual([ACCOUNT])
    expect(w.services.identities).toEqual([ACCOUNT])
    expect(leftovers(w).filter((left) => !left.kept)).toEqual([])

    // The follow-up pass closes it once more; the host answers closed for an account it already closed, so the
    // deletion finishes and the host still holds one fence.
    advance(w, DELETION_RECHECK_MS)
    expect((await cronRoute(w)).body).toEqual({ due: 1, deleted: 0, checked: 1, pending: 0, busy: 0 })
    expect(w.services.workspaces).toEqual([ACCOUNT, ACCOUNT, ACCOUNT, ACCOUNT])
    expect([...w.services.closedWorkspaces]).toEqual([ACCOUNT])
    expect(w.fakes.store.zset(tombstonesDueKey()).size).toBe(0)
  })

  test("cloud workspaces: the follow-up pass waits for the host to erase them, retrying and alerting the owner until it has", async () => {
    restore()
    restore = deletionEnvironment({
      ...WORKSPACES_ENVIRONMENT,
      RESEND_API_KEY: "re_fixture",
      VECTOR_PURCHASE_EMAIL_FROM: "Vector <alerts@example.invalid>",
      CODIUM_OWNER_EMAIL: "owner@example.invalid",
    })
    const w = deletionWorld()
    await seedEverything(w)
    // The host fenced the account at once but keeps failing to erase one workspace's volume.
    w.services.workspacesLeft = 1

    // Access is closed, so the identity still goes: the close answered, and the host erases in the background.
    expect((await deleteRoute(w)).status).toBe(200)
    expect(w.services.identities).toEqual([ACCOUNT])
    expect([...w.services.closedWorkspaces]).toEqual([ACCOUNT])

    // The follow-up pass does not finish the deletion while the host still holds a workspace of the account.
    advance(w, DELETION_RECHECK_MS)
    expect((await cronRoute(w)).body).toEqual({ due: 1, deleted: 0, checked: 0, pending: 1, busy: 0 })
    expect(await readTombstone(ACCOUNT, w.fetcher)).toMatchObject({
      attempts: 1,
      stage: "check",
      failed: ["workspaces", "codium", "keys"],
    })
    expect(w.fakes.store.zset(tombstonesDueKey()).get(ACCOUNT)).toBe(w.clock() + deletionRetryMs(1))
    for (let attempt = 2; attempt <= DELETION_ALERT_AFTER; attempt++) {
      advance(w, deletionRetryMs(attempt - 1))
      expect((await cronRoute(w)).body).toMatchObject({ due: 1, pending: 1 })
    }
    expect(w.fakes.mail.sent).toHaveLength(1)
    expect(w.fakes.mail.sent[0]!.text).toContain("Parts not erased: workspaces, codium, keys.")
    expect(w.fakes.mail.sent[0]!.text).not.toContain(EMAIL)

    // Once the host reports none left, the next due pass finishes the deletion.
    w.services.workspacesLeft = 0
    advance(w, deletionRetryMs(DELETION_ALERT_AFTER))
    expect((await cronRoute(w)).body).toEqual({ due: 1, deleted: 0, checked: 1, pending: 0, busy: 0 })
    expect(w.fakes.store.zset(tombstonesDueKey()).size).toBe(0)
  })

  test("the follow-up pass erases what a request already past its checks created after the erase", async () => {
    const w = deletionWorld()
    await seedEverything(w)
    expect((await deleteRoute(w)).status).toBe(200)
    // A report that was being filed while the deletion ran lands afterwards, and an outbox item writes its applied
    // version back.
    w.fakes.store.set(reportKey(RID), JSON.stringify({ v: 1 }))
    w.fakes.store.members(accountReportsKey(ACCOUNT)).add(RID)
    w.fakes.store.set(codiumKey("prov", "vault", ACCOUNT), "3")
    expect(leftovers(w).filter((left) => !left.kept).length).toBeGreaterThan(0)
    advance(w, DELETION_RECHECK_MS)
    expect((await cronRoute(w)).body).toMatchObject({ checked: 1 })
    expect(leftovers(w).filter((left) => !left.kept)).toEqual([])
  })

  test("the outbox keeps no item that carries the account's snapshots", async () => {
    const w = deletionWorld()
    await seedEverything(w)
    // Reconcile queued the provisioners' items for the active plan; deletion's closing snapshot queues more.
    expect([...w.fakes.store.zset(codiumKey("outbox")).keys()].some((id) => id.includes(ACCOUNT))).toBe(true)
    expect((await deleteRoute(w)).status).toBe(200)
    const outbox = [...w.fakes.store.zset(codiumKey("outbox")).keys()]
    expect(outbox.filter((id) => id.includes(ACCOUNT))).toEqual([])
    expect(w.fakes.store.keys().filter((key) => key.includes(":outbox:item:") && key.includes(ACCOUNT))).toEqual([])
  })

  test("a wrong email or a deployment that cannot delete identities changes nothing", async () => {
    const w = deletionWorld()
    await seedEverything(w)
    const mismatch = await deleteRoute(w, "someone-else@example.test")
    expect(mismatch.status).toBe(400)
    expect(mismatch.body.error.code).toBe("CONFIRMATION_MISMATCH")
    expect(w.fakes.store.get(tombstoneKey(ACCOUNT))).toBeUndefined()
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const unconfigured = await deleteRoute(w)
    expect(unconfigured.status).toBe(503)
    expect(unconfigured.body.error.code).toBe("DELETION_NOT_CONFIGURED")
    expect(w.fakes.store.get(tombstoneKey(ACCOUNT))).toBeUndefined()
    expect(await readSnapshot(ACCOUNT, w.fetcher)).toMatchObject({ state: "active" })
  })

  test("the cron needs its secret", async () => {
    const w = deletionWorld()
    expect((await cronRoute(w, "not-the-secret")).status).toBe(401)
  })
})

// The last part's SCAN with a MATCH glob and its whole-word filter, on a real Valkey when VECTOR_TEST_REDIS_URL is set
// (the CI lane); skipped otherwise. The store fake above only emulates the glob.
const valkeyURL = process.env.VECTOR_TEST_REDIS_URL
describe.skipIf(!valkeyURL)("the last part on a real Valkey (CI only)", () => {
  let restore = () => {}
  beforeEach(() => {
    restore = deletionEnvironment()
  })
  afterEach(() => restore())

  test("erases the account's keys and keeps the kept ones, another account's and the other mode's", async () => {
    const client = new RedisClient(valkeyURL!)
    // The store's REST commands, sent to Valkey as they are.
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const [name, ...args] = JSON.parse(String(init?.body)) as (string | number)[]
      return Response.json({ result: await client.send(String(name), args.map(String)) })
    }) as typeof fetch
    const account = randomUUID()
    const erased = [
      codiumKey("meter", account, "sub_1:1", "cloud-agents"),
      codiumKey("estimate", account, "sub_1:1", "full", "none", 3),
      codiumKey("run", `no-run-${account}`),
    ]
    const kept = [
      tombstoneKey(account),
      codiumKey("debits", account, "a".repeat(64)),
      runTokensRevokedKey(account),
      codiumKey("meter", `${account}0`, "sub_2:1", "cloud-agents"),
      `vector:codium:live:meter:${account}:sub_3:1:cloud-agents`,
    ]
    try {
      for (const key of [...erased, ...kept]) await client.send("SET", [key, "1", "PX", "600000"])
      expect(await eraseAccountKeys(account, { fetcher, now: Date.now() })).toBe(erased.length)
      for (const key of erased) expect(await client.send("EXISTS", [key])).toBe(0)
      for (const key of kept) expect(await client.send("EXISTS", [key])).toBe(1)
    } finally {
      await client.send("DEL", [...erased, ...kept])
      client.close()
    }
  })
})
