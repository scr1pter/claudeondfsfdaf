import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import handleDefaultSetup, { handleVaultSetup } from "../api/vault/setup"
import { handleVaultUploads } from "../api/vault/uploads"
import { handleVaultCommit } from "../api/vault/commit"
import { handleVaultSnapshots } from "../api/vault/snapshots"
import { handleVaultSnapshot } from "../api/vault/snapshots/[id]"
import { handleVaultDelete } from "../api/vault/index"
import { handleVaultCleanup } from "../api/vault/cleanup"
import { mintCliToken } from "../api/_lib/cli-token"
import { codiumKey } from "../api/_lib/codium-keys"
import { listedPerks, perkServices } from "../api/_lib/codium-perks"
import { vault as vaultProvisioner, vaultPolicy } from "../api/_lib/codium-provisioners"
import { buildSnapshot, snapshotKey, type SnapshotFacts } from "../api/_lib/codium-snapshot"
import type { ApiRequest, ApiResponse } from "../api/_lib/http"
import { readVaultMeter } from "../api/_lib/vault-meter"
import {
  readVault,
  VAULT_LIMITS,
  VAULT_OBJECT_OVERHEAD,
  vaultAccount,
  vaultConfigured,
  vaultStoreConfigured,
} from "../api/_lib/vault-store"
import type { EntitlementSnapshot } from "../packages/schema/src/codium-entitlements"
import type { PlanId } from "../packages/schema/src/codium-plan"
import { Vault } from "../packages/schema/src/vault"
import { VaultFormat } from "../packages/core/src/vault/format"
import { VaultRemote } from "../packages/core/src/vault/remote"
import { VaultBackup } from "../packages/core/src/vault/vault"
import { R2_ORIGIN, VAULT_ENVIRONMENT, vaultBackend, vaultWorld, type VaultBackend } from "./brain-vault-fixture"
import { roadmapEnvironment } from "./roadmap-fixture"
import { jsonHeaders } from "./support-reports-fixture"

// WP A44: the Vault API. Quota is a server gate: every upload is reserved, in one transaction that locks the vault,
// before anything is signed, and a PUT link carries the exact size reserved. Read-only states follow §4.4, and deleting
// a version or the vault reaches storage. The store is `vector_brain_vault` (brain-vault.sql): an in-memory emulation
// here, the real SQL on Postgres when VECTOR_TEST_POSTGRES_URL is set (CI). R2 is a fake that checks each presigned
// URL's signature and expiry. Nothing leaves this process.

const DAY = 86_400_000
const HOUR = 3_600_000
/** Past the life of every upload link signed now, and the grace after it: a queued blob can then be deleted. */
const LINKS = VAULT_LIMITS.linkSeconds * 1000 + VAULT_LIMITS.linkGraceMs + 1
const BASE = Date.now() - (Date.now() % 1000)
let offset = 0
const clock = () => BASE + offset
const PRO = "3c4d5e6f-0000-4000-8000-000000000001"
const MAX = "3c4d5e6f-0000-4000-8000-000000000002"
const PLUS = "3c4d5e6f-0000-4000-8000-000000000003"
const NONE = "3c4d5e6f-0000-4000-8000-000000000004"
const ULTRA = "3c4d5e6f-0000-4000-8000-000000000005"
const QUOTA = 10_000_000_000
const API = "https://vectordev.test/api/vault"
const encoder = new TextEncoder()

let backend: VaultBackend
let restore = () => {}
let w: ReturnType<typeof vaultWorld>

beforeAll(async () => {
  backend = await vaultBackend()
})
afterAll(async () => {
  await backend.close()
})
beforeEach(async () => {
  offset = 0
  restore = roadmapEnvironment(VAULT_ENVIRONMENT)
  await backend.reset()
  w = vaultWorld(backend, clock)
})
afterEach(() => restore())

/** A fresh world over the same store (switch caches are kept per fetch), with plans seeded again. */
function rebuild(plans: [string, PlanId | null, SnapshotFacts["state"]?][] = []) {
  restore()
  restore = roadmapEnvironment(VAULT_ENVIRONMENT)
  w = vaultWorld(backend, clock)
  for (const [account, plan, state] of plans) seedPlan(account, plan, state)
}

const token = (account: string) =>
  mintCliToken({ id: account, email: `${account}@example.invalid` }, Date.now(), "desktop").token

function snapshotFor(
  account: string,
  plan: PlanId | null,
  state: SnapshotFacts["state"] = "active",
  extra: Partial<SnapshotFacts> = {},
): EntitlementSnapshot {
  const now = clock()
  const reason =
    state === "paused"
      ? ("payment_failed" as const)
      : state === "frozen"
        ? ("disputed" as const)
        : state === "ended"
          ? ("canceled" as const)
          : undefined
  return buildSnapshot(
    {
      account,
      state,
      ...(reason ? { reason } : {}),
      plan,
      ...(plan ? { subscription: `sub_${account.slice(-4)}` } : {}),
      periodStart: state === "renewing" ? now - 30 * DAY : now - DAY,
      periodEnd: state === "renewing" ? now - 60_000 : now + 29 * DAY,
      cancelAtPeriodEnd: false,
      source: "webhook",
      ...extra,
    },
    undefined,
    now,
  )
}

function seedPlan(account: string, plan: PlanId | null, state: SnapshotFacts["state"] = "active", extra = {}) {
  const snapshot = snapshotFor(account, plan, state, extra)
  w.store.command(["SET", snapshotKey(account), JSON.stringify(snapshot)])
  return snapshot
}

type Route = (request: ApiRequest, response: ApiResponse, fetcher: typeof fetch, clock: () => number) => Promise<void>
type Answer = { status: number; headers: Record<string, string>; body: any }

/** Runs a route as Vercel would, with this world's fetch and clock. */
function api(
  route: Route,
  input: { method?: string; account?: string; authorization?: string; body?: unknown; id?: string } = {},
): Promise<Answer> {
  const authorization = input.authorization ?? (input.account ? `Bearer ${token(input.account)}` : undefined)
  const headers: Record<string, string> = {}
  return new Promise((resolve, reject) => {
    const target = {
      statusCode: 200,
      setHeader(name: string, value: string | number | readonly string[]) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value)
        return target
      },
      end(value?: string) {
        resolve({ status: target.statusCode, headers, body: value ? JSON.parse(value) : undefined })
        return target
      },
    }
    const request = {
      method: input.method ?? "GET",
      url: `/api/vault${input.id ? `/snapshots/${input.id}` : ""}`,
      headers: jsonHeaders("192.0.2.80", authorization ? { authorization } : {}),
      ...(input.id ? { query: { id: input.id } } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
    }
    void route(request as unknown as ApiRequest, target as unknown as ApiResponse, w.fetcher, clock).catch(reject)
  })
}

const vaultHex = (n: number) => n.toString(16).padStart(32, "a")
const object = (n: number) => n.toString(16).padStart(64, "0")
const versionId = (n = 1, at = clock()) => `v${at}-${n.toString(16).padStart(8, "0")}`

function wrapped(vault: string): Vault.WrappedKey {
  return {
    format: "vector-vault-key",
    version: 1,
    vault,
    kdf: { name: "scrypt", N: 2 ** 17, r: 8, p: 1, salt: "c2FsdHNhbHRzYWx0c2FsdA" },
    nonce: "bm9uY2Vub25jZW5v",
    ciphertext: "Y2lwaGVydGV4dGNpcGhlcnRleHRjaXBoZXJ0ZXh0Y2lwaGVy",
    createdAt: clock(),
  }
}

async function createVault(account: string, vault = vaultHex(1)) {
  const answer = await api(handleVaultSetup, { method: "POST", account, body: { vault, key: wrapped(vault) } })
  expect(answer.status).toBe(200)
  return vault
}

const uploads = (account: string, body: unknown) => api(handleVaultUploads, { method: "POST", account, body })
const commit = (account: string, version: string, objects: number) =>
  api(handleVaultCommit, { method: "POST", account, body: { version, objects } })

function put(url: string, size: number, fill = 7) {
  return w.fetcher(url, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", "content-length": String(size) },
    body: new Uint8Array(size).fill(fill),
  })
}

/** A whole backup the way the client sends it: declare, upload what was signed, declare the manifest, commit. */
async function backUp(account: string, version: string, objects: { id: string; size: number }[], manifest = 500) {
  const sizes = new Map(objects.map((item) => [item.id, item.size]))
  const first = objects.length ? await uploads(account, { version, objects }) : undefined
  if (first) expect(first.status).toBe(200)
  for (const item of first?.body.uploads ?? []) expect((await put(item.url, sizes.get(item.id)!)).status).toBe(200)
  const last = await uploads(account, { version, objects: [], manifest: { size: manifest } })
  expect(last.status).toBe(200)
  expect((await put(last.body.manifest.url, manifest)).status).toBe(200)
  const done = await commit(account, version, objects.length)
  expect(done.status).toBe(200)
  return { first, last, done }
}

const r2Keys = () => [...w.bucket.objects.keys()].sort()
const cleanupNow = () => api(handleVaultCleanup, { authorization: `Bearer ${VAULT_ENVIRONMENT.CRON_SECRET}` })
const deletes = () => w.bucket.calls.filter((call) => call.method === "DELETE").map((call) => call.key.split("/").pop())
const hashOf = (account: string) => vaultAccount(account)
const live = async (account: string) =>
  (await backend.blobs(hashOf(account))).filter((blob) => blob.state === "pending" || blob.state === "stored")

// ── The store's contract ───────────────────────────────────────────────────────────────────────────────────────────

describe("the store", () => {
  test("brain-vault.sql: invoker function, empty search path, RLS on every table, grants to service_role only", async () => {
    const sql = await Bun.file(path.join(import.meta.dir, "../docs/vector/owner-actions/sql/brain-vault.sql")).text()
    const functions = [...sql.matchAll(/create or replace function ([^\s(]+)\(/g)].map((match) => match[1])
    expect(functions).toEqual(["public.vector_brain_vault"])
    expect(sql).toContain("returns jsonb language plpgsql security invoker set search_path = ''")
    expect(sql).not.toContain("security definer")
    for (const table of ["vaults", "vault_versions", "vault_refs", "vault_blobs"])
      expect(sql).toContain(`alter table public.vector_brain_${table} enable row level security;`)
    expect(sql).toContain("from public, anon, authenticated;")
    expect(sql).toContain("revoke all on function public.vector_brain_vault(jsonb) from public, anon, authenticated;")
    expect(sql).toContain("grant execute on function public.vector_brain_vault(jsonb) to service_role;")
    expect([...sql.matchAll(/\bgrant\b[^;]*\bto (\w+)/g)].map((match) => match[1])).toEqual(["service_role", "service_role"])
    // No account id, email or content is a column: accounts are a keyed hash.
    expect(sql).not.toMatch(/\bemail\b\s+text|\baccount_id\b|\bcontent\b\s+(?:text|bytea)/)
  })

  test("sizes follow the vault format", () => {
    expect(VAULT_OBJECT_OVERHEAD).toBe(VaultFormat.OVERHEAD)
    expect(VAULT_LIMITS.objectBytes).toBe(Vault.LIMIT.chunk + VaultFormat.OVERHEAD)
    expect(VAULT_LIMITS.manifestBytes).toBe(Vault.LIMIT.manifest + VaultFormat.OVERHEAD)
    expect(VAULT_LIMITS.linkSeconds).toBeLessThanOrEqual(900)
  })

  test("the store and the bucket never name the account, and a live server never reads a test vault", async () => {
    seedPlan(PRO, "vector-50")
    await createVault(PRO)
    await backUp(PRO, versionId(), [{ id: object(1), size: 1000 }])
    expect(JSON.stringify(w.rpc)).not.toContain(PRO)
    expect(r2Keys().every((key) => key.startsWith(`test/${hashOf(PRO)}/${vaultHex(1)}/`) && !key.includes(PRO))).toBe(true)
    expect((await backend.vaults(hashOf(PRO))).map((row) => row.vault)).toEqual([vaultHex(1)])
    expect(await readVault(PRO, { fetcher: w.fetcher, now: clock() })).toMatchObject({ vault: vaultHex(1) })
    process.env.CODIUM_STRIPE_MODE = "live"
    expect(await readVault(PRO, { fetcher: w.fetcher, now: clock() })).toBeUndefined()
  })

  test("readiness: Vault lists only with the switch on, VECTOR_VAULT_ENABLED, the store, the bucket and the notice email", async () => {
    expect(vaultConfigured()).toBe(true)
    expect(await perkServices.vault!(w.fetcher)).toBe(true)
    expect((await listedPerks(w.fetcher)).has("vault")).toBe(true)
    for (const name of [
      "VECTOR_VAULT_ENABLED",
      "VECTOR_VAULT_ACCOUNT_SALT",
      "SUPABASE_SERVICE_ROLE_KEY",
      "VECTOR_R2_VAULT_SECRET_ACCESS_KEY",
      "RESEND_API_KEY",
      "VECTOR_PURCHASE_EMAIL_FROM",
    ]) {
      rebuild()
      delete process.env[name]
      expect({ name, ready: vaultConfigured(), listed: (await listedPerks(w.fetcher)).has("vault") }).toEqual({
        name,
        ready: false,
        listed: false,
      })
    }
    rebuild()
    process.env.VECTOR_VAULT_ACCOUNT_SALT = "too-short"
    expect(vaultStoreConfigured()).toBe(false)
    rebuild()
    w.store.command(["SET", codiumKey("switch", "vault"), "off"])
    expect((await listedPerks(w.fetcher)).has("vault")).toBe(false)
  })
})

// ── Who may write, and when ────────────────────────────────────────────────────────────────────────────────────────

describe("who may write", () => {
  test("writes need Vault listed and answer 503 before reading any sign-in; reads and deletes work whatever the listing", async () => {
    seedPlan(PRO, "vector-50")
    await createVault(PRO)
    const id = versionId()
    await backUp(PRO, id, [{ id: object(1), size: 1000 }])
    const dark: [string, () => void][] = [
      ["not in CODIUM_LISTED_PERKS", () => void (process.env.CODIUM_LISTED_PERKS = "vote")],
      ["VECTOR_VAULT_ENABLED off", () => void (process.env.VECTOR_VAULT_ENABLED = "false")],
      ["Codium not enabled", () => void (process.env.MODEL_PLANS_ENABLED = "false")],
      ["vault switch off", () => void w.store.command(["SET", codiumKey("switch", "vault"), "off"])],
      ["codium switch off", () => void w.store.command(["SET", codiumKey("switch", "codium"), "off"])],
      ["perk switched off", () => void w.store.command(["SADD", codiumKey("perks-off"), "vault"])],
      ["no notice email", () => void delete process.env.RESEND_API_KEY],
    ]
    for (const [reason, apply] of dark) {
      rebuild([[PRO, "vector-50"]])
      apply()
      const writes = [
        await api(handleVaultSetup, { method: "POST", account: PRO, body: { vault: vaultHex(2), key: wrapped(vaultHex(2)) } }),
        await api(handleVaultUploads, { method: "POST", body: { version: versionId(2), objects: [] } }),
        await api(handleVaultCommit, { method: "POST", authorization: "Bearer vrt_fixture.run", body: { version: id, objects: 1 } }),
      ]
      expect({ reason, writes: writes.map((answer) => [answer.status, answer.body.error.code]) }).toEqual({
        reason,
        writes: [
          [503, "VAULT_UNAVAILABLE"],
          [503, "VAULT_UNAVAILABLE"],
          [503, "VAULT_UNAVAILABLE"],
        ],
      })
      const reads = [
        await api(handleVaultSetup, { account: PRO }),
        await api(handleVaultSnapshots, { account: PRO }),
        await api(handleVaultSnapshot, { account: PRO, id }),
      ]
      expect({ reason, reads: reads.map((answer) => answer.status) }).toEqual({ reason, reads: [200, 200, 200] })
    }
    // Without the store itself nothing can be read either.
    rebuild([[PRO, "vector-50"]])
    delete process.env.VECTOR_VAULT_ACCOUNT_SALT
    const answer = await api(handleVaultSnapshots, { account: PRO })
    expect([answer.status, answer.body.error.code]).toEqual([503, "VAULT_UNAVAILABLE"])
  })

  test("S3: only a Vector account token; run tokens, no token and a revoked account get 401 at every route", async () => {
    seedPlan(PRO, "vector-50")
    await createVault(PRO)
    const id = versionId()
    const routes: [Route, string, unknown?][] = [
      [handleVaultSetup, "GET"],
      [handleVaultSetup, "POST", { vault: vaultHex(1), key: wrapped(vaultHex(1)) }],
      [handleVaultUploads, "POST", { version: id, objects: [] }],
      [handleVaultCommit, "POST", { version: id, objects: 0 }],
      [handleVaultSnapshots, "GET"],
      [handleVaultSnapshot, "GET"],
      [handleVaultSnapshot, "POST", { objects: [] }],
      [handleVaultSnapshot, "DELETE"],
      [handleVaultDelete, "DELETE"],
    ]
    for (const authorization of [undefined, "Bearer vrt_fixture.run", "Bearer vht_fixture.hosted", "Bearer vct_bad"]) {
      for (const [route, method, body] of routes) {
        const answer = await api(route, {
          method,
          ...(authorization ? { authorization } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(route === handleVaultSnapshot ? { id } : {}),
        })
        expect({ method, authorization, status: answer.status }).toEqual({ method, authorization, status: 401 })
      }
    }
    w.store.command(["SET", `vector:cli-revoked:${PRO}`, "1"])
    expect((await api(handleVaultSetup, { account: PRO })).status).toBe(401)
    expect((await api(handleVaultDelete, { method: "DELETE", account: PRO })).status).toBe(401)
    expect(await backend.vaults(hashOf(PRO))).toHaveLength(1)
    // The default export is the same route.
    expect(handleDefaultSetup).toBeInstanceOf(Function)
  })

  test("S1: the plan comes from the snapshot: Plus, no plan, closing and renewing past the grace are refused", async () => {
    seedPlan(PLUS, "vector-10")
    const plus = await api(handleVaultSetup, { method: "POST", account: PLUS, body: { vault: vaultHex(3), key: wrapped(vaultHex(3)) } })
    expect([plus.status, plus.body.error]).toEqual([
      403,
      { perk: "vault", plan: "vector-50", code: "CODIUM_PERK_REQUIRED", message: expect.any(String) },
    ])
    seedPlan(NONE, null, "none")
    const none = await api(handleVaultSetup, { method: "POST", account: NONE, body: { vault: vaultHex(4), key: wrapped(vaultHex(4)) } })
    expect([none.status, none.body.error.code]).toEqual([402, "MODEL_PLAN_REQUIRED"])
    expect(await backend.vaults(hashOf(PLUS))).toEqual([])
    expect(await backend.vaults(hashOf(NONE))).toEqual([])

    // Renewing within the grace keeps uploading; past it, the plan has to catch up first.
    seedPlan(MAX, "vector-100", "renewing")
    await createVault(MAX)
    expect((await uploads(MAX, { version: versionId(), objects: [{ id: object(1), size: 100 }] })).status).toBe(200)
    seedPlan(MAX, "vector-100", "renewing", { periodEnd: clock() - 3 * HOUR })
    const late = await uploads(MAX, { version: versionId(2), objects: [{ id: object(2), size: 100 }] })
    expect([late.status, late.body.error.code]).toEqual([503, "MODEL_PLAN_RENEWING"])

    // An account being deleted is closed for reads and writes alike.
    seedPlan(MAX, "vector-100", "ended", { reason: "closing" })
    const closingWrite = await uploads(MAX, { version: versionId(3), objects: [] })
    const closingRead = await api(handleVaultSetup, { account: MAX })
    expect([closingWrite.status, closingWrite.body.error.code]).toEqual([409, "MODEL_PLAN_ACCOUNT_CLOSING"])
    expect([closingRead.status, closingRead.body.error.code]).toEqual([409, "MODEL_PLAN_ACCOUNT_CLOSING"])
  })

  test("read-only states (§4.4): paused, ended and frozen refuse uploads with 409 VAULT_READ_ONLY and still restore", async () => {
    seedPlan(PRO, "vector-50")
    await createVault(PRO)
    const id = versionId()
    await backUp(PRO, id, [{ id: object(1), size: 1000 }])
    const open = await api(handleVaultSnapshots, { account: PRO })
    expect(open.body).toMatchObject({ readOnly: false, usage: { usedBytes: 1500, quotaBytes: QUOTA } })
    for (const state of ["paused", "ended", "frozen"] as const) {
      seedPlan(PRO, "vector-50", state)
      for (const answer of [
        await uploads(PRO, { version: versionId(2), objects: [{ id: object(2), size: 100 }] }),
        await api(handleVaultSetup, { method: "POST", account: PRO, body: { vault: vaultHex(1), key: wrapped(vaultHex(1)) } }),
        await commit(PRO, id, 1),
      ])
        expect({ state, status: answer.status, error: answer.body.error.code, detail: answer.body.error.state }).toEqual({
          state,
          status: 409,
          error: "VAULT_READ_ONLY",
          detail: state,
        })
      const listing = await api(handleVaultSnapshots, { account: PRO })
      expect(listing.body).toMatchObject({ readOnly: true, snapshots: [{ id }] })
      const manifest = await api(handleVaultSnapshot, { account: PRO, id })
      expect((await w.fetcher(manifest.body.manifest.url)).status).toBe(200)
      const downloads = await api(handleVaultSnapshot, { method: "POST", account: PRO, id, body: { objects: [object(1), object(9)] } })
      expect(downloads.body.downloads.map((item: { id: string }) => item.id)).toEqual([object(1)])
      expect((await w.fetcher(downloads.body.downloads[0].url)).status).toBe(200)
    }
    expect(r2Keys().filter((key) => key.includes(object(2)))).toEqual([])
  })
})

// ── Quota ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("quota is a server gate", () => {
  test("a request that does not fit is refused whole: nothing reserved, nothing signed, nothing sent to storage", async () => {
    seedPlan(PRO, "vector-50")
    await createVault(PRO)
    await backend.seedStored(hashOf(PRO), QUOTA - 2_000)
    const id = versionId()
    const refused = await uploads(PRO, { version: id, objects: [1, 2, 3].map((n) => ({ id: object(n), size: 1_000 })) })
    expect([refused.status, refused.body.error.code]).toEqual([402, "VAULT_QUOTA"])
    expect(refused.body.uploads).toBeUndefined()
    expect(w.bucket.calls).toEqual([])
    expect((await backend.blobs(hashOf(PRO))).map((blob) => blob.state)).toEqual(["stored"])
    expect(await backend.versions(hashOf(PRO))).toEqual([])

    const fits = await uploads(PRO, { version: id, objects: [1, 2].map((n) => ({ id: object(n), size: 1_000 })) })
    expect(fits.status).toBe(200)
    expect(fits.body.uploads.map((item: { id: string }) => item.id)).toEqual([object(1), object(2)])
    expect(fits.body.present).toEqual([])
    const url = new URL(fits.body.uploads[0].url)
    expect(url.origin).toBe(R2_ORIGIN)
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host")
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBe(900)
    expect(fits.body.expiresAt).toBe(Math.floor(clock() / 1000) * 1000 + 900_000)
    // The link stores exactly the size reserved, and nothing after it expires.
    expect((await put(fits.body.uploads[0].url, 1_001)).status).toBe(403)
    expect((await put(fits.body.uploads[0].url, 1_000)).status).toBe(200)
    offset += 901_000
    expect((await put(fits.body.uploads[1].url, 1_000)).status).toBe(403)
    offset = 0
    const more = await uploads(PRO, { version: id, objects: [{ id: object(9), size: 40 }] })
    expect([more.status, more.body.error.code]).toEqual([402, "VAULT_QUOTA"])
    // Bodies the format never writes are refused before the store is asked.
    for (const body of [
      { version: id, objects: [{ id: object(5), size: VAULT_LIMITS.objectBytes + 1 }] },
      { version: id, objects: [{ id: object(5), size: 10 }, { id: object(5), size: 10 }] },
      { version: id, objects: Array.from({ length: 1001 }, (_, n) => ({ id: object(1000 + n), size: 100 })) },
      { version: versionId(3, clock() - 2 * DAY), objects: [] },
      { version: "v1-1", objects: [] },
    ])
      expect((await uploads(PRO, body)).body.error.code).toBe("VAULT_REQUEST_INVALID")
  })

  test("20 parallel reservations never pass the quota together", async () => {
    seedPlan(PRO, "vector-50")
    await createVault(PRO)
    const size = VAULT_LIMITS.objectBytes
    await backend.seedStored(hashOf(PRO), QUOTA - 10 * size)
    const id = versionId()
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, n) => uploads(PRO, { version: id, objects: [{ id: object(100 + n), size }] })),
    )
    const granted = answers.filter((answer) => answer.status === 200)
    expect(granted).toHaveLength(10)
    expect(answers.filter((answer) => answer.status === 402).map((answer) => answer.body.error.code)).toEqual(
      Array(10).fill("VAULT_QUOTA"),
    )
    const pending = (await backend.blobs(hashOf(PRO))).filter((blob) => blob.state === "pending")
    expect(pending).toHaveLength(10)
    expect(pending.reduce((sum, blob) => sum + blob.size, 0) + QUOTA - 10 * size).toBe(QUOTA)
    // The same objects declared 20 times at once are reserved once.
    const objects = granted.map((answer) => ({ id: answer.body.uploads[0].id as string, size }))
    const again = await Promise.all(Array.from({ length: 20 }, () => uploads(PRO, { version: id, objects })))
    expect(again.every((answer) => answer.status === 200 && answer.body.uploads.length === 10)).toBe(true)
    expect((await backend.blobs(hashOf(PRO))).filter((blob) => blob.state === "pending")).toHaveLength(10)
    const listing = await api(handleVaultSnapshots, { account: PRO })
    expect(listing.body.usage).toEqual({ usedBytes: QUOTA, quotaBytes: QUOTA })
  })

  test("only missing objects are signed; a version records what it names; backups in progress are capped", async () => {
    seedPlan(PRO, "vector-50")
    await createVault(PRO)
    const a = versionId(1)
    await backUp(PRO, a, [1, 2, 3].map((n) => ({ id: object(n), size: 1_000 + n })), 600)
    const b = versionId(2)
    const declared = await uploads(PRO, { version: b, objects: [2, 3, 4].map((n) => ({ id: object(n), size: 1_000 + n })) })
    expect(declared.body.uploads.map((item: { id: string }) => item.id)).toEqual([object(4)])
    expect(declared.body.present).toEqual([object(2), object(3)])
    expect((await put(declared.body.uploads[0].url, 1_004)).status).toBe(200)
    const manifest = await uploads(PRO, { version: b, objects: [], manifest: { size: 700 } })
    expect((await put(manifest.body.manifest.url, 700)).status).toBe(200)
    w.bucket.calls.length = 0
    const done = await commit(PRO, b, 3)
    expect(done.body.snapshot).toEqual({ id: b, createdAt: Number(b.slice(1, 14)), bytes: 1_002 + 1_003 + 1_004 + 700, objects: 3 })
    // Only what had not been confirmed yet was checked.
    expect(w.bucket.calls.map((call) => `${call.method} ${call.key.split("/").slice(-2).join("/")}`).sort()).toEqual(
      [`HEAD objects/${object(4)}`, `HEAD versions/${b}`].sort(),
    )
    const listing = await api(handleVaultSnapshots, { account: PRO })
    expect(listing.body.snapshots.map((item: { id: string }) => item.id)).toEqual([b, a])
    expect(listing.body.usage.usedBytes).toBe(1_001 + 1_002 + 1_003 + 1_004 + 600 + 700)
    // A committed version takes no more uploads; four backups at once is the most.
    expect((await uploads(PRO, { version: b, objects: [] })).body.error.code).toBe("VAULT_EXISTS")
    for (const n of [10, 11, 12, 13]) expect((await uploads(PRO, { version: versionId(n), objects: [] })).status).toBe(200)
    const fifth = await uploads(PRO, { version: versionId(14), objects: [] })
    expect([fifth.status, fifth.body.error.code]).toEqual([429, "RATE_LIMITED"])
    // A backup with no request for an hour can no longer commit, so it stops counting before the cleanup sweeps it.
    offset += VAULT_LIMITS.reserveMs - 1_000
    expect((await uploads(PRO, { version: versionId(15), objects: [] })).status).toBe(429)
    offset += 1_001
    expect((await uploads(PRO, { version: versionId(16), objects: [] })).status).toBe(200)
    expect((await backend.versions(hashOf(PRO))).filter((item) => !item.committed)).toHaveLength(5)
  })

  test("past the version cap a backup makes room: the oldest version goes, with what only it names", async () => {
    seedPlan(PRO, "vector-50")
    const vault = await createVault(PRO)
    // Several computers sharing one vault back up far more than twice a day; every version is inside its 30 days.
    const ids: string[] = []
    for (let n = 1; n <= VAULT_LIMITS.versions; n++) {
      ids.push(versionId(n))
      await backUp(PRO, ids.at(-1)!, [{ id: object(1), size: 1_000 }, { id: object(1_000 + n), size: 100 }], 300)
      offset += 60_000
    }
    const next = versionId(61)
    const declared = await uploads(PRO, { version: next, objects: [{ id: object(1), size: 1_000 }, { id: object(2_000), size: 100 }] })
    expect(declared.status).toBe(200)
    expect(declared.body.present).toEqual([object(1)])
    const listing = await api(handleVaultSnapshots, { account: PRO })
    expect(listing.body.snapshots).toHaveLength(VAULT_LIMITS.versions - 1)
    expect(listing.body.snapshots.map((item: { id: string }) => item.id)).not.toContain(ids[0])
    // The dropped version's manifest and the object only it named are queued; the shared object stays.
    const blobs = await backend.blobs(hashOf(PRO))
    const state = (kind: string, id: string) => blobs.find((blob) => blob.kind === kind && blob.id === id)?.state
    expect([state("manifest", ids[0]!), state("object", object(1_001)), state("object", object(1))]).toEqual([
      "trash",
      "trash",
      "stored",
    ])
    await put(declared.body.uploads[0].url, 100)
    const last = await uploads(PRO, { version: next, objects: [], manifest: { size: 300 } })
    await put(last.body.manifest.url, 300)
    expect((await commit(PRO, next, 2)).status).toBe(200)
    const after = (await api(handleVaultSnapshots, { account: PRO })).body.snapshots.map((item: { id: string }) => item.id)
    expect(after).toHaveLength(VAULT_LIMITS.versions)
    expect(after[0]).toBe(next)
    expect(after.at(-1)).toBe(ids[1])
    offset += LINKS
    await cleanupNow()
    const prefix = `test/${hashOf(PRO)}/${vault}`
    expect(r2Keys()).not.toContain(`${prefix}/versions/${ids[0]}`)
    expect(r2Keys()).not.toContain(`${prefix}/objects/${object(1_001)}`)
    expect(r2Keys()).toContain(`${prefix}/objects/${object(1)}`)

    // A held vault (frozen) loses nothing it committed, so at the cap it refuses instead of dropping.
    const active = snapshotFor(PRO, "vector-50")
    await vaultProvisioner.apply(
      { account: PRO, from: active, to: { ...snapshotFor(PRO, "vector-50", "frozen"), version: active.version + 1 }, cause: "disputed" },
      w.fetcher,
    )
    const held = await uploads(PRO, { version: versionId(62), objects: [] })
    expect([held.status, held.body.error.code]).toEqual([402, "VAULT_QUOTA"])
    expect((await api(handleVaultSnapshots, { account: PRO })).body.snapshots).toHaveLength(VAULT_LIMITS.versions)
  })
})

// ── Commit ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("commit", () => {
  test("HEADs each object: a size mismatch is deleted and refused, a missing piece too; then a whole backup commits", async () => {
    seedPlan(PRO, "vector-50")
    await createVault(PRO)
    const id = versionId()
    const objects = [1, 2].map((n) => ({ id: object(n), size: 1_000 }))
    const declared = await uploads(PRO, { version: id, objects })
    // Storage keeps one byte less of object 1 than was sent; object 2 never arrives.
    w.bucket.state.alter = (key, bytes) => (key.endsWith(object(1)) ? bytes.slice(1) : bytes)
    expect((await put(declared.body.uploads[0].url, 1_000)).status).toBe(200)
    w.bucket.state.alter = undefined
    const manifest = await uploads(PRO, { version: id, objects: [], manifest: { size: 500 } })
    await put(manifest.body.manifest.url, 500)
    expect((await commit(PRO, id, 5)).body.error.code).toBe("VAULT_SIZE_MISMATCH")
    const refused = await commit(PRO, id, 2)
    expect([refused.status, refused.body.error.code]).toEqual([409, "VAULT_SIZE_MISMATCH"])
    // Both are queued at once (the quota no longer counts them), and deleted once no upload link can write them.
    expect((await live(PRO)).map((blob) => blob.kind)).toEqual(["manifest"])
    expect(deletes()).toEqual([])
    offset += LINKS
    expect((await cleanupNow()).body).toMatchObject({ deleted: 2 })
    expect(deletes().sort()).toEqual([object(1), object(2)].sort())
    expect(r2Keys().some((key) => key.endsWith(object(1)))).toBe(false)
    // Running the backup again (a new version) uploads both and commits.
    const again = versionId(2)
    const { done } = await backUp(PRO, again, objects)
    expect(done.body.snapshot).toMatchObject({ id: again, objects: 2, bytes: 2_500 })
    expect((await commit(PRO, again, 2)).body.snapshot).toEqual(done.body.snapshot)
    // Storage that cannot answer leaves the version as it is: nothing deleted.
    const third = versionId(3)
    const pending = await uploads(PRO, { version: third, objects: [{ id: object(3), size: 1_000 }] })
    await put(pending.body.uploads[0].url, 1_000)
    const last = await uploads(PRO, { version: third, objects: [], manifest: { size: 500 } })
    await put(last.body.manifest.url, 500)
    w.bucket.state.down = true
    const down = await commit(PRO, third, 1)
    expect([down.status, down.body.error.code]).toEqual([503, "VAULT_UNAVAILABLE"])
    w.bucket.state.down = false
    expect((await commit(PRO, third, 1)).status).toBe(200)
  })
})

// ── The client (A43) ───────────────────────────────────────────────────────────────────────────────────────────────

/** The A43 client's `send`, reaching these routes for the API and the fake bucket for signed links. */
const send: VaultRemote.Send = async (url, init) => {
  if (url.startsWith(R2_ORIGIN)) return w.fetcher(url, init)
  const route = url.slice(API.length)
  const headers = new Headers(init.headers)
  const method = init.method ?? "GET"
  const body = typeof init.body === "string" ? init.body : undefined
  const id = /^\/snapshots\/([^/]+)$/.exec(route)?.[1]
  const handler: Route =
    route === "/setup"
      ? handleVaultSetup
      : route === "/uploads"
        ? handleVaultUploads
        : route === "/commit"
          ? handleVaultCommit
          : route === "/snapshots"
            ? handleVaultSnapshots
            : id
              ? handleVaultSnapshot
              : handleVaultDelete
  const answer = await api(handler, {
    method,
    authorization: headers.get("authorization") ?? "",
    ...(body !== undefined ? { body } : {}),
    ...(id ? { id: decodeURIComponent(id) } : {}),
  })
  return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status })
}

function memoryFile(seed: number, entries: number) {
  let state = seed
  const random = () => (state = (state * 1_103_515_245 + 12_345) % 2_147_483_648)
  const memory = Array.from({ length: entries }, (_, n) => ({
    id: `m${seed}-${n}`,
    text: Array.from({ length: 24 }, () => random().toString(36)).join(" "),
  }))
  return encoder.encode(JSON.stringify({ kind: "vector-memory", version: 1, entries: memory }))
}

describe("the Vault client against these routes", () => {
  test("create, back up twice with dedupe, restore elsewhere, forget a version and delete the vault", async () => {
    seedPlan(PRO, "vector-50")
    const store = VaultRemote.store({ base: API, token: token(PRO), send })
    const created = await VaultBackup.create(store, { now: clock(), cost: 2 ** 14 })
    const personal = memoryFile(1, 3_000)
    const first = await VaultBackup.backup({
      store,
      opened: created,
      files: [{ path: "memory/personal.json", section: "memory", bytes: personal }],
      now: clock(),
    })
    expect(first.uploaded).toBeGreaterThan(1)
    offset += 60_000
    const repository = memoryFile(2, 500)
    const second = await VaultBackup.backup({
      store,
      opened: created,
      files: [
        { path: "memory/personal.json", section: "memory", bytes: personal },
        { path: "memory/repository-a.json", section: "memory", bytes: repository, repository: "a" },
      ],
      now: clock(),
    })
    expect(second.reused).toBe(first.uploaded)
    expect(second.uploaded).toBeLessThan(first.uploaded)

    // Another computer restores with the recovery code alone.
    const elsewhere = VaultRemote.store({ base: API, token: token(PRO), send })
    const opened = await VaultBackup.unlock(elsewhere, created.code)
    const restored = await VaultBackup.read({ store: elsewhere, opened })
    expect(restored.files.map((file) => Buffer.from(file.bytes).equals(Buffer.from(file.file.path.includes("personal") ? personal : repository)))).toEqual([true, true])
    const listing = await elsewhere.list()
    expect(listing).toMatchObject({ readOnly: false, usage: { quotaBytes: QUOTA } })
    expect(listing.snapshots.map((item) => item.id)).toEqual([second.snapshot.id, first.snapshot.id])
    // P1: bytes and counts only.
    expect(JSON.stringify(listing)).not.toMatch(/\$|usd|credit|cents/i)

    // Forgetting the first version deletes only its manifest: every object is still named by the second. (The upload
    // links have expired by now, so the deletes happen at once.)
    offset += LINKS
    const before = r2Keys()
    await VaultBackup.forget({ store, opened: created, version: first.snapshot.id })
    expect(before.filter((key) => !r2Keys().includes(key))).toEqual([
      `test/${hashOf(PRO)}/${created.vault}/versions/${first.snapshot.id}`,
    ])
    expect((await VaultBackup.read({ store, opened: created })).files).toHaveLength(2)

    await store.destroy()
    expect(await store.readKey()).toBeUndefined()
    expect(r2Keys()).toEqual([])
    expect(await backend.vaults(hashOf(PRO))).toEqual([])
    // The wrapped key went before any object was deleted from storage.
    expect(w.log.indexOf("rpc:destroy")).toBeLessThan(w.log.findLastIndex((entry) => entry.startsWith("r2:DELETE")))
    expect(w.log.slice(w.log.indexOf("rpc:destroy")).find((entry) => entry.startsWith("r2:"))).toMatch(/^r2:DELETE/)
  })
})

// ── Deletion and cleanup ───────────────────────────────────────────────────────────────────────────────────────────

describe("deletion", () => {
  test("forgetting a version frees its quota at once and deletes only what no other version names", async () => {
    seedPlan(PRO, "vector-50")
    const vault = await createVault(PRO)
    const a = versionId(1)
    const b = versionId(2)
    await backUp(PRO, a, [1, 2].map((n) => ({ id: object(n), size: 1_000 })), 500)
    await backUp(PRO, b, [2, 3].map((n) => ({ id: object(n), size: 1_000 })), 600)
    expect((await api(handleVaultSnapshots, { account: PRO })).body.usage.usedBytes).toBe(4_100)
    offset += LINKS
    const forgotten = await api(handleVaultSnapshot, { method: "DELETE", account: PRO, id: a })
    expect(forgotten.body).toEqual({ forgotten: true })
    expect((await api(handleVaultSnapshots, { account: PRO })).body).toMatchObject({
      snapshots: [{ id: b }],
      usage: { usedBytes: 2_600 },
    })
    const prefix = `test/${hashOf(PRO)}/${vault}`
    expect(r2Keys()).toEqual([`${prefix}/objects/${object(2)}`, `${prefix}/objects/${object(3)}`, `${prefix}/versions/${b}`])
    expect((await api(handleVaultSnapshot, { method: "DELETE", account: PRO, id: a })).status).toBe(404)
    expect((await api(handleVaultSnapshot, { account: PRO, id: a })).body.error.code).toBe("VAULT_NOT_FOUND")
    expect((await api(handleVaultSnapshot, { method: "POST", account: PRO, id: a, body: { objects: [object(1)] } })).status).toBe(404)
  })

  test("deleting the vault removes its key with its listing in one step and every object from storage", async () => {
    seedPlan(PRO, "vector-50")
    await createVault(PRO)
    await backUp(PRO, versionId(1), [1, 2, 3].map((n) => ({ id: object(n), size: 1_000 })))
    // Storage is down: the vault is gone from the listing at once, and its objects wait for the cleanup.
    w.bucket.state.down = true
    expect((await api(handleVaultDelete, { method: "DELETE", account: PRO })).body).toEqual({ deleted: true })
    expect((await api(handleVaultSetup, { account: PRO })).body.error.code).toBe("VAULT_NOT_FOUND")
    expect((await api(handleVaultSnapshots, { account: PRO })).status).toBe(404)
    expect(await backend.vaults(hashOf(PRO))).toEqual([
      { vault: vaultHex(1), wrappedKey: null, deleting: true, held: false, noticeAt: null, deleteAt: null },
    ])
    expect(r2Keys()).toHaveLength(4)
    // The same vault id cannot come back while it is being deleted; a new vault can be made at once.
    expect((await api(handleVaultSetup, { method: "POST", account: PRO, body: { vault: vaultHex(1), key: wrapped(vaultHex(1)) } })).body.error.code).toBe("VAULT_EXISTS")
    await createVault(PRO, vaultHex(2))
    // Once the upload links are dead the cleanup claims them; storage still down, the deletes fail and stay claimed.
    offset += LINKS
    expect((await cleanupNow()).body).toMatchObject({ deleted: 0, failed: 4 })
    expect(r2Keys()).toHaveLength(4)
    w.bucket.state.down = false
    offset += VAULT_LIMITS.claimStaleMs + 1
    const cleaned = await cleanupNow()
    expect(cleaned.body).toMatchObject({ enabled: true, deleted: 4, failed: 0 })
    expect(r2Keys()).toEqual([])
    expect((await backend.vaults(hashOf(PRO))).map((row) => row.vault)).toEqual([vaultHex(2)])
    expect((await api(handleVaultDelete, { method: "DELETE", account: PRO })).status).toBe(200)
    expect((await api(handleVaultDelete, { method: "DELETE", account: PRO })).body.error.code).toBe("VAULT_NOT_FOUND")
  })
})

describe("upload links and deletion", () => {
  test("a blob queued while an upload link still works is deleted only after the link expires, so a late PUT leaves nothing", async () => {
    seedPlan(PRO, "vector-50")
    await createVault(PRO)
    const id = versionId()
    const declared = await uploads(PRO, { version: id, objects: [{ id: object(1), size: 1_000 }] })
    const manifest = await uploads(PRO, { version: id, objects: [], manifest: { size: 500 } })
    await put(manifest.body.manifest.url, 500)
    // Nothing arrived for object 1: the commit queues it and answers 409, and its own purge deletes nothing yet.
    expect((await commit(PRO, id, 1)).body.error.code).toBe("VAULT_SIZE_MISMATCH")
    expect(deletes()).toEqual([])
    // The old link still works, so the bytes land in storage after the queueing; the quota no longer counts them.
    expect((await put(declared.body.uploads[0].url, 1_000)).status).toBe(200)
    expect(r2Keys().some((key) => key.endsWith(object(1)))).toBe(true)
    expect((await api(handleVaultSnapshots, { account: PRO })).body.usage.usedBytes).toBe(500)
    // A cleanup inside the link's life and its grace leaves it queued; the first one after deletes what the PUT wrote.
    offset += VAULT_LIMITS.linkSeconds * 1000
    expect((await cleanupNow()).body).toMatchObject({ deleted: 0 })
    expect((await backend.blobs(hashOf(PRO))).find((blob) => blob.id === object(1))?.state).toBe("trash")
    offset += VAULT_LIMITS.linkGraceMs + 1
    expect((await cleanupNow()).body).toMatchObject({ deleted: 1 })
    expect(r2Keys().some((key) => key.endsWith(object(1)))).toBe(false)
    expect((await backend.blobs(hashOf(PRO))).find((blob) => blob.id === object(1))).toBeUndefined()
    // And the link is dead now, so nothing comes back.
    expect((await put(declared.body.uploads[0].url, 1_000)).status).toBe(403)

    // A queued object reserved again (the backup run again at once) is pending with a new link: nothing deletes it.
    const again = versionId(2)
    await uploads(PRO, { version: again, objects: [{ id: object(2), size: 1_000 }] })
    const second = await uploads(PRO, { version: again, objects: [], manifest: { size: 500 } })
    await put(second.body.manifest.url, 500)
    expect((await commit(PRO, again, 1)).status).toBe(409)
    const state = async () => (await backend.blobs(hashOf(PRO))).find((blob) => blob.id === object(2))?.state
    expect(await state()).toBe("trash")
    const retried = await uploads(PRO, { version: versionId(3), objects: [{ id: object(2), size: 1_000 }] })
    expect(retried.body.uploads.map((item: { id: string }) => item.id)).toEqual([object(2)])
    expect((await put(retried.body.uploads[0].url, 1_000)).status).toBe(200)
    offset += LINKS
    await cleanupNow()
    expect(r2Keys().some((key) => key.endsWith(object(2)))).toBe(true)
    expect(await state()).toBe("pending")
  })
})

describe("cleanup", () => {
  const cron = (secret: string | null = VAULT_ENVIRONMENT.CRON_SECRET!) =>
    api(handleVaultCleanup, secret ? { authorization: `Bearer ${secret}` } : {})

  test("needs CRON_SECRET; prunes past the version days (newest kept), collects unnamed objects, sweeps uncommitted uploads", async () => {
    expect((await cron(null)).status).toBe(401)
    expect((await cron("wrong")).status).toBe(401)
    seedPlan(PRO, "vector-50")
    const vault = await createVault(PRO)
    const [v1, v2, v3, v4] = [1, 2, 3, 4].map((n) => versionId(n))
    await backUp(PRO, v1!, [1, 2].map((n) => ({ id: object(n), size: 1_000 })))
    await backUp(PRO, v2!, [2, 3].map((n) => ({ id: object(n), size: 1_000 })))
    await backUp(PRO, v3!, [3, 4].map((n) => ({ id: object(n), size: 1_000 })))
    await backend.age(hashOf(PRO), v1!, clock() - 40 * DAY)
    await backend.age(hashOf(PRO), v2!, clock() - 35 * DAY)
    // A backup that uploaded an object and never committed.
    const started = await uploads(PRO, { version: v4, objects: [{ id: object(5), size: 1_000 }] })
    await put(started.body.uploads[0].url, 1_000)
    // Under an hour, nothing of it is touched.
    offset += 30 * 60_000
    expect((await cron()).body).toMatchObject({ uncommitted: 0, expired: 0, pruned: 2, collected: 2 })
    offset += 31 * 60_000
    const answer = await cron()
    expect(answer.body).toEqual({
      enabled: true,
      vaults: 1,
      lapsed: 0,
      uncommitted: 1,
      expired: 1,
      pruned: 0,
      collected: 0,
      more: false,
      deleted: 1,
      failed: 0,
    })
    const prefix = `test/${hashOf(PRO)}/${vault}`
    expect(r2Keys()).toEqual([`${prefix}/objects/${object(3)}`, `${prefix}/objects/${object(4)}`, `${prefix}/versions/${v3}`])
    expect((await api(handleVaultSnapshots, { account: PRO })).body.snapshots.map((item: { id: string }) => item.id)).toEqual([v3])
    // The newest version is kept however old it is.
    await backend.age(hashOf(PRO), v3!, clock() - 400 * DAY)
    expect((await cron()).body).toMatchObject({ pruned: 0, collected: 0 })
    expect(r2Keys()).toHaveLength(3)
  })

  test("a held vault (frozen) loses nothing it committed, not even versions past their days", async () => {
    seedPlan(PRO, "vector-50")
    await createVault(PRO)
    const [v1, v2] = [1, 2].map((n) => versionId(n))
    await backUp(PRO, v1!, [{ id: object(1), size: 1_000 }])
    await backUp(PRO, v2!, [{ id: object(2), size: 1_000 }])
    await backend.age(hashOf(PRO), v1!, clock() - 40 * DAY)
    const active = snapshotFor(PRO, "vector-50")
    const frozen = { ...snapshotFor(PRO, "vector-50", "frozen"), version: active.version + 1 }
    await vaultProvisioner.apply({ account: PRO, from: active, to: frozen, cause: "disputed" }, w.fetcher)
    expect((await backend.vaults(hashOf(PRO)))[0]).toMatchObject({ held: true, deleteAt: null })
    expect((await cron()).body).toMatchObject({ pruned: 0, collected: 0, deleted: 0 })
    expect(r2Keys()).toHaveLength(4)
    const won = { ...active, version: frozen.version + 1 }
    await vaultProvisioner.apply({ account: PRO, from: frozen, to: won, cause: "dispute_won" }, w.fetcher)
    expect((await backend.vaults(hashOf(PRO)))[0]).toMatchObject({ held: false })
    offset += LINKS
    expect((await cron()).body).toMatchObject({ pruned: 1, collected: 1, deleted: 2 })
  })

  test("an ended plan's vault is read-only for 30 days after an emailed notice, then deleted; a new plan clears it", async () => {
    w.users.set(PRO, "pro@example.invalid")
    seedPlan(PRO, "vector-50")
    await createVault(PRO)
    await backUp(PRO, versionId(), [{ id: object(1), size: 1_000 }])
    const active = snapshotFor(PRO, "vector-50")
    const ended = { ...snapshotFor(PRO, "vector-50", "ended"), version: active.version + 1 }
    // The email failing leaves no notice, so nothing can be deleted yet; the outbox retries.
    w.state.mailDown = true
    await expect(vaultProvisioner.apply({ account: PRO, from: active, to: ended, cause: "ended" }, w.fetcher)).rejects.toThrow()
    expect((await backend.vaults(hashOf(PRO)))[0]).toMatchObject({ noticeAt: null, deleteAt: null })
    w.state.mailDown = false
    await vaultProvisioner.apply({ account: PRO, from: active, to: ended, cause: "ended" }, w.fetcher)
    await vaultProvisioner.apply({ account: PRO, from: active, to: ended, cause: "ended" }, w.fetcher)
    expect(w.emails).toHaveLength(1)
    const [email] = w.emails
    expect(email).toMatchObject({ to: ["pro@example.invalid"], subject: "Your Brain Vault is read-only" })
    expect(email!.key).toMatch(/^vault-notice-[0-9a-f]{32}-\d+$/)
    expect(email!.text).toContain("vector vault restore")
    expect(email!.text).not.toMatch(/\$|usd|credit|\b\d+ ?GB\b/i)
    const row = (await backend.vaults(hashOf(PRO)))[0]!
    expect(row.deleteAt! - Date.now()).toBeGreaterThan(30 * DAY - 60_000)
    expect(row.deleteAt! - Date.now()).toBeLessThanOrEqual(30 * DAY)
    seedPlan(PRO, "vector-50", "ended")
    expect((await api(handleVaultSnapshots, { account: PRO })).body).toMatchObject({ readOnly: true, deleteAt: row.deleteAt })

    // A plan that starts again before then clears the date.
    const back = { ...active, version: ended.version + 1 }
    await vaultProvisioner.apply({ account: PRO, from: ended, to: back, cause: "first_payment" }, w.fetcher)
    expect((await backend.vaults(hashOf(PRO)))[0]).toMatchObject({ noticeAt: null, deleteAt: null })
    offset = row.deleteAt! - BASE + DAY
    expect((await cron()).body).toMatchObject({ lapsed: 0 })
    expect(r2Keys()).toHaveLength(2)

    // Ended for good: 30 days after the notice, the vault and its objects go.
    offset = 0
    const again = { ...ended, version: back.version + 1 }
    await vaultProvisioner.apply({ account: PRO, from: back, to: again, cause: "ended" }, w.fetcher)
    expect(w.emails).toHaveLength(2)
    const deleteAt = (await backend.vaults(hashOf(PRO)))[0]!.deleteAt!
    offset = deleteAt - BASE - 60_000
    expect((await cron()).body).toMatchObject({ lapsed: 0 })
    offset = deleteAt - BASE + 1
    expect((await cron()).body).toMatchObject({ lapsed: 1, deleted: 2 })
    expect(r2Keys()).toEqual([])
    expect(await backend.vaults(hashOf(PRO))).toEqual([])
  })

  test("account deletion (closing) erases the vault at once, the wrapped key first", async () => {
    seedPlan(ULTRA, "vector-200")
    await createVault(ULTRA)
    await backUp(ULTRA, versionId(), [1, 2].map((n) => ({ id: object(n), size: 1_000 })))
    const active = snapshotFor(ULTRA, "vector-200")
    const closing = { ...snapshotFor(ULTRA, "vector-200", "ended", { reason: "closing" }), version: active.version + 1 }
    w.log.length = 0
    await vaultProvisioner.apply({ account: ULTRA, from: active, to: closing, cause: "closing" }, w.fetcher)
    expect(w.log[0]).toBe("rpc:destroy")
    expect(await backend.vaults(hashOf(ULTRA))).toEqual([
      { vault: vaultHex(1), wrappedKey: null, deleting: true, held: false, noticeAt: null, deleteAt: null },
    ])
    expect(w.emails).toEqual([])
    // The backup's upload links still work, so its objects go with the first cleanup after they expire.
    expect(r2Keys()).toHaveLength(3)
    offset += LINKS
    expect((await cron()).body).toMatchObject({ deleted: 3 })
    expect(r2Keys()).toEqual([])
    expect(await backend.vaults(hashOf(ULTRA))).toEqual([])
  })

  test("a plan without Brain Vault (Pro down to Plus) turns the vault read-only with the notice; a plan with it clears that", async () => {
    w.users.set(PRO, "pro@example.invalid")
    seedPlan(PRO, "vector-50")
    await createVault(PRO)
    await backUp(PRO, versionId(), [{ id: object(1), size: 1_000 }])
    const pro = snapshotFor(PRO, "vector-50")
    const plus = { ...snapshotFor(PRO, "vector-10"), version: pro.version + 1 }
    expect([vaultPolicy(pro), vaultPolicy(plus), vaultPolicy({ ...plus, state: "paused" })]).toEqual([
      "release",
      "lapse",
      "lapse",
    ])
    await vaultProvisioner.apply({ account: PRO, from: pro, to: plus, cause: "downgrade" }, w.fetcher)
    await vaultProvisioner.apply({ account: PRO, from: pro, to: plus, cause: "downgrade" }, w.fetcher)
    expect(w.emails).toHaveLength(1)
    expect(w.emails[0]!.text).toContain("no longer includes Brain Vault")
    expect(w.emails[0]!.text).not.toMatch(/\$|usd|credit|\b\d+ ?GB\b/i)
    const row = (await backend.vaults(hashOf(PRO)))[0]!
    expect(row.deleteAt! - Date.now()).toBeGreaterThan(30 * DAY - 60_000)
    expect(row.deleteAt! - Date.now()).toBeLessThanOrEqual(30 * DAY)
    seedPlan(PRO, "vector-10")
    expect((await api(handleVaultSnapshots, { account: PRO })).body).toMatchObject({ readOnly: true, deleteAt: row.deleteAt })
    expect((await uploads(PRO, { version: versionId(2), objects: [] })).body.error.code).toBe("CODIUM_PERK_REQUIRED")

    // Back up to a plan with Brain Vault before the date: the date goes, and nothing is deleted.
    const back = { ...pro, version: plus.version + 1 }
    await vaultProvisioner.apply({ account: PRO, from: plus, to: back, cause: "upgrade" }, w.fetcher)
    expect((await backend.vaults(hashOf(PRO)))[0]).toMatchObject({ noticeAt: null, deleteAt: null })
    offset = row.deleteAt! - BASE + DAY
    expect((await cron()).body).toMatchObject({ lapsed: 0 })
    expect(r2Keys()).toHaveLength(2)

    // Down to Plus for good: 30 days after the notice the vault and its objects go.
    offset = 0
    const again = { ...plus, version: back.version + 1 }
    await vaultProvisioner.apply({ account: PRO, from: back, to: again, cause: "downgrade" }, w.fetcher)
    expect(w.emails).toHaveLength(2)
    const deleteAt = (await backend.vaults(hashOf(PRO)))[0]!.deleteAt!
    offset = deleteAt - BASE + 1
    expect((await cron()).body).toMatchObject({ lapsed: 1, deleted: 2 })
    expect(await backend.vaults(hashOf(PRO))).toEqual([])
  })
})

// ── Status ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the status meter", () => {
  test("meters.vault is the vault's bytes against the plan's quota, registered by the status route", async () => {
    const snapshot = seedPlan(MAX, "vector-100")
    expect(await readVaultMeter(snapshot, w.fetcher)).toEqual({ usedBytes: 0, quotaBytes: 25_000_000_000 })
    await createVault(MAX)
    await backUp(MAX, versionId(), [{ id: object(1), size: 2_000 }], 400)
    expect(await readVaultMeter(snapshot, w.fetcher)).toEqual({ usedBytes: 2_400, quotaBytes: 25_000_000_000 })
    delete process.env.VECTOR_VAULT_ACCOUNT_SALT
    expect(await readVaultMeter(snapshot, w.fetcher)).toBeUndefined()
    const route = await Bun.file(path.join(import.meta.dir, "../api/model-plans/status.ts")).text()
    expect(route).toContain('import "../_lib/vault-meter.js"')
  })
})
