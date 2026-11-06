import { createHmac } from "node:crypto"
import { Vault } from "../../packages/schema/src/vault.js"
import { ApiError } from "./http.js"
import { stripeMode, type StripeMode } from "./model-plan-stripe.js"
import { presignR2, r2Configured } from "./r2-presign.js"

/*
 * Brain Vault's store (WP A44): the durable records in Supabase (docs/vector/owner-actions/sql/brain-vault.sql, one
 * RPC, `vector_brain_vault`, called with the service role) and the encrypted bytes in the R2 bucket `vector-vault`.
 * Everything here is already sealed on the person's computer (P3): the server sees object ids (keyed HMACs), sizes,
 * version ids and the vault key wrapped under the recovery code, and moves no bytes itself. Uploads and downloads go
 * straight to R2 through links that live 900 seconds; a PUT signs its exact size, so nobody stores more than was
 * reserved.
 *
 * - **Quota before signing.** `reserveUploads` reserves every object the store does not hold yet in one transaction
 *   that locks the vault (parallel reservations queue on that lock), and only then are PUT links signed, only for
 *   those objects. The quota counts pending and stored bytes.
 * - **Commit.** `commitVersion` HEADs every object still pending for the version and its manifest. A size that differs
 *   from the declared one, or an object that never arrived, is deleted and answered 409 `VAULT_SIZE_MISMATCH`.
 * - **Deletion.** Forgetting a version, deleting the vault, the daily cleanup and account deletion only queue blobs
 *   (`trash`, which no longer counts against the quota); `purgeVaults` claims them, deletes them from R2 and removes
 *   their rows. A claimed blob cannot be reserved again until its deletion finishes, so a delete in flight never
 *   removes a fresh upload of the same object. A queued blob is claimed only once every PUT link signed for it has
 *   stopped working (`signed_until`, the link's life plus `linkGraceMs`): a PUT through a live link after the delete
 *   would otherwise recreate the object with no row behind it, uncounted and never deleted. So a blob queued within
 *   15 minutes of its upload links waits for the next cleanup.
 *
 * Names: an account is the HMAC of its id under VECTOR_VAULT_ACCOUNT_SALT (`vaultAccount`), so neither the database
 * nor the bucket names a Vector account. The salt must never change: a new salt is a new, empty vault for everyone.
 * Rows and keys carry the Stripe mode, so a test server never reads or deletes a live vault.
 *
 * This module imports nothing that reads the plan cache, so the `vault` provisioner can import it (an import of
 * codium-entitlements.ts here would close a cycle through model-plan-account.ts). The routes' plan rules are in
 * vault-api.ts.
 */

const DAY_MS = 86_400_000
/** What a sealed object takes beyond its compressed plaintext: the 12-byte header, the nonce and the tag (format.ts). */
export const VAULT_OBJECT_OVERHEAD = 40

/** The server's own limits. Public plan numbers (the quota in GB, the version days) come from ENTITLEMENTS. */
export const VAULT_LIMITS = Object.freeze({
  /** The largest stored object: a full chunk stored raw. */
  objectBytes: Vault.LIMIT.chunk + VAULT_OBJECT_OVERHEAD,
  /** The largest stored manifest. */
  manifestBytes: Vault.LIMIT.manifest + VAULT_OBJECT_OVERHEAD,
  /** Signed links live this long (r2-presign.ts's maximum). */
  linkSeconds: 900,
  /**
   * How long after a PUT link expires its blob may still be written: clock skew between this server and R2, and an
   * upload that started just before the link expired and is still sending. A queued blob is deleted only after both.
   */
  linkGraceMs: 5 * 60_000,
  /** A reservation, and a version that never commits, are swept this long after their last request. */
  reserveMs: 60 * 60_000,
  /**
   * Committed versions one vault holds. At the cap a new backup makes room by dropping the oldest (never the newest),
   * as forgetting it would; only a held vault, which loses nothing it committed, is refused.
   */
  versions: 60,
  /** Backups in progress at once (computers backing up together); one idle past `reserveMs` no longer counts. */
  open: 4,
  /** Objects one vault holds. */
  objects: 2_000_000,
  /** Objects one version names. */
  refs: 1_000_000,
  /** How far a version id's time may be behind or ahead of the server's clock. */
  versionPastMs: DAY_MS,
  versionAheadMs: 60 * 60_000,
  /** Read-only days after a plan ends, counted from the notice (§4.4). */
  lapseDays: 30,
  /** A deletion claimed this long ago and not finished is claimed again. Far above any function's run time. */
  claimStaleMs: 10 * 60_000,
  /** Objects a commit HEADs per round. */
  headBatch: 2_000,
  /** HEADs and DELETEs in flight at once. */
  parallel: 32,
})

/** A plan's quota in bytes: decimal gigabytes, as Vector shows sizes. */
export function vaultQuotaBytes(gb: number) {
  return Number.isFinite(gb) && gb > 0 ? Math.floor(gb * 1_000_000_000) : 0
}

// ── Configuration ──────────────────────────────────────────────────────────────────────────────────────────────────

function supabase() {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "") ?? ""
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ""
  const origin = URL.parse(url)
  const local =
    process.env.NODE_ENV !== "production" &&
    process.env.VERCEL_ENV !== "production" &&
    origin?.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
  if (
    !key ||
    !origin ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    (origin.protocol !== "https:" && !local)
  )
    return undefined
  return { url, key }
}

function salt() {
  const value = process.env.VECTOR_VAULT_ACCOUNT_SALT?.trim() ?? ""
  return value.length >= 32 ? value : undefined
}

/** Whether the store can be used: Supabase's service role, the account salt and the vault bucket. */
export function vaultStoreConfigured() {
  return supabase() !== undefined && salt() !== undefined && r2Configured("vault")
}

/** Whether the read-only notice can be emailed (Resend and a sender). */
export function vaultNoticeConfigured() {
  return Boolean(process.env.RESEND_API_KEY?.trim() && process.env.VECTOR_PURCHASE_EMAIL_FROM?.trim())
}

/**
 * Whether Brain Vault on Vector is ready to list (contract §4.14's "service configured"): `VECTOR_VAULT_ENABLED=true`,
 * the store, and the email that tells a person their vault turned read-only, because nothing is deleted without it.
 * The `vault` switch is checked with the other switches; the legal read stays the owner's call (§1.2).
 */
export function vaultConfigured() {
  return process.env.VECTOR_VAULT_ENABLED?.trim() === "true" && vaultStoreConfigured() && vaultNoticeConfigured()
}

/** The name the store knows an account by: HMAC-SHA-256 of its id under the salt, as hex. */
export function vaultAccount(account: string) {
  const key = salt()
  if (!key) throw unavailable()
  return createHmac("sha256", key).update(`vector-vault-account-v1:${account}`).digest("hex")
}

export type BlobKind = "object" | "manifest"

/** Where a blob lives in the vault bucket. */
export function vaultBlobKey(
  input: { mode?: StripeMode; account: string; vault: string; kind: BlobKind; id: string },
): string {
  const mode = input.mode ?? stripeMode()
  if (!/^[a-f0-9]{64}$/.test(input.account) || !/^[a-f0-9]{32}$/.test(input.vault))
    throw new Error("That vault blob key is not valid.")
  if (input.kind === "object" ? !OBJECT_ID.test(input.id) : !VERSION_ID.test(input.id))
    throw new Error("That vault blob id is not valid.")
  return `${mode}/${input.account}/${input.vault}/${input.kind === "object" ? "objects" : "versions"}/${input.id}`
}

export const OBJECT_ID = /^[0-9a-f]{64}$/
export const VERSION_ID = /^v\d{13}-[0-9a-f]{8}$/
const VAULT_ID = /^[0-9a-f]{32}$/

export function unavailable(retryAfterSeconds?: number) {
  return new ApiError(503, "VAULT_UNAVAILABLE", "Brain Vault is temporarily unavailable. Try again shortly.", {
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  })
}

export function vaultNotFound() {
  return new ApiError(404, "VAULT_NOT_FOUND", "Your Brain Vault holds nothing yet.")
}

function sizeMismatch() {
  return new ApiError(
    409,
    "VAULT_SIZE_MISMATCH",
    "A piece of this backup did not arrive whole and was deleted. Run the backup again.",
  )
}

// ── The RPC ────────────────────────────────────────────────────────────────────────────────────────────────────────

type Options = { readonly fetcher?: typeof fetch; readonly now?: number }
type Answer = Record<string, unknown> & { status: string }
const ANSWER_LIMIT = 4_000_000

/** One call to `vector_brain_vault`. A store that cannot be reached, or answers what it never should, is a 503. */
async function rpc(request: Record<string, unknown>, options: Options): Promise<Answer> {
  const target = supabase()
  if (!target) throw unavailable()
  const fetcher = options.fetcher ?? fetch
  const response = await fetcher(`${target.url}/rest/v1/rpc/vector_brain_vault`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", apikey: target.key, authorization: `Bearer ${target.key}` },
    body: JSON.stringify({
      request: { mode: stripeMode(), now: Math.trunc(options.now ?? Date.now()), ...request },
    }),
  }).catch(() => undefined)
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => undefined)
    throw unavailable()
  }
  const text = await boundedText(response)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw unavailable()
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unavailable()
  const answer = parsed as Record<string, unknown>
  if (typeof answer.status !== "string" || answer.status === "invalid") throw unavailable()
  return answer as Answer
}

async function boundedText(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > ANSWER_LIMIT) {
      await reader.cancel().catch(() => undefined)
      throw unavailable()
    }
    chunks.push(next.value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

const account = (id: string) => ({ account: vaultAccount(id) })

function count(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw unavailable()
  return value as number
}

function optionalTime(value: unknown) {
  if (value === null || value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw unavailable()
  return value as number
}

function ids(value: unknown, pattern: RegExp): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && pattern.test(item)))
    throw unavailable()
  return value
}

function vaultId(value: unknown) {
  if (typeof value !== "string" || !VAULT_ID.test(value)) throw unavailable()
  return value
}

function snapshot(value: unknown): Vault.Snapshot {
  const item = value as Record<string, unknown> | null
  if (!item || typeof item !== "object" || typeof item.id !== "string" || !VERSION_ID.test(item.id))
    throw unavailable()
  const createdAt = optionalTime(item.createdAt)
  if (createdAt === undefined) throw unavailable()
  return { id: item.id, createdAt, bytes: count(item.bytes), objects: count(item.objects) }
}

function wrappedKey(value: unknown): Vault.WrappedKey {
  const key = value as Vault.WrappedKey | null
  if (!key || typeof key !== "object" || key.format !== "vector-vault-key" || !VAULT_ID.test(String(key.vault)))
    throw unavailable()
  return key
}

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type VaultRecord = { vault: string; key: Vault.WrappedKey; createdAt: number; deleteAt?: number; usedBytes: number }

/** The account's vault, or undefined when it has none (or it is being deleted). */
export async function readVault(user: string, options: Options = {}): Promise<VaultRecord | undefined> {
  const answer = await rpc({ action: "read", ...account(user) }, options)
  if (answer.status === "not_found") return undefined
  if (answer.status !== "ok") throw unavailable()
  const deleteAt = optionalTime(answer.deleteAt)
  const createdAt = optionalTime(answer.createdAt)
  if (createdAt === undefined) throw unavailable()
  return {
    vault: vaultId(answer.vault),
    key: wrappedKey(answer.key),
    createdAt,
    ...(deleteAt ? { deleteAt } : {}),
    usedBytes: count(answer.usedBytes),
  }
}

/** Bytes the account's vault takes against its quota (pending and stored), or 0 without a vault. */
export async function vaultUsage(user: string, options: Options = {}) {
  const answer = await rpc({ action: "usage", ...account(user) }, options)
  if (answer.status === "not_found") return 0
  if (answer.status !== "ok") throw unavailable()
  return count(answer.usedBytes)
}

/** The committed versions, newest first, and the bytes used; undefined without a vault. */
export async function listVault(user: string, options: Options = {}) {
  const answer = await rpc({ action: "list", ...account(user) }, options)
  if (answer.status === "not_found") return undefined
  if (answer.status !== "ok" || !Array.isArray(answer.snapshots)) throw unavailable()
  const deleteAt = optionalTime(answer.deleteAt)
  return {
    snapshots: answer.snapshots.map(snapshot),
    usedBytes: count(answer.usedBytes),
    ...(deleteAt ? { deleteAt } : {}),
  }
}

/** A committed version with a signed link to its manifest, or undefined. */
export async function readVersion(user: string, version: string, options: Options = {}) {
  const answer = await rpc({ action: "version", ...account(user), version }, options)
  if (answer.status === "not_found") return undefined
  if (answer.status !== "ok") throw unavailable()
  const item = snapshot(answer.snapshot)
  const key = vaultBlobKey({ account: vaultAccount(user), vault: vaultId(answer.vault), kind: "manifest", id: item.id })
  return {
    snapshot: item,
    manifest: { url: presignR2("vault", { method: "GET", key, expiresIn: VAULT_LIMITS.linkSeconds, now: options.now }).url },
  }
}

/**
 * Signed GET links for the objects asked for that the committed version names and the store holds; any other id is
 * left out. Undefined when the version is not committed.
 */
export async function downloadLinks(user: string, version: string, objects: readonly string[], options: Options = {}) {
  const answer = await rpc({ action: "downloads", ...account(user), version, objects }, options)
  if (answer.status === "not_found") return undefined
  if (answer.status !== "ok") throw unavailable()
  const vault = vaultId(answer.vault)
  const owner = vaultAccount(user)
  return ids(answer.objects, OBJECT_ID).map((id) => ({
    id,
    url: presignR2("vault", {
      method: "GET",
      key: vaultBlobKey({ account: owner, vault, kind: "object", id }),
      expiresIn: VAULT_LIMITS.linkSeconds,
      now: options.now,
    }).url,
  }))
}

// ── Writes ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Creates the account's vault once. Answers the stored vault (also for the same vault id again), or `exists`. */
export async function setupVault(
  user: string,
  input: { vault: string; key: Vault.WrappedKey; versionDays: number },
  options: Options = {},
): Promise<Vault.Setup | "exists"> {
  const answer = await rpc(
    { action: "setup", ...account(user), vault: input.vault, key: input.key, versionDays: input.versionDays },
    options,
  )
  if (answer.status === "exists") return "exists"
  if (answer.status !== "ok") throw unavailable()
  const createdAt = optionalTime(answer.createdAt)
  if (createdAt === undefined) throw unavailable()
  return { vault: vaultId(answer.vault), key: wrappedKey(answer.key), createdAt }
}

export type Reservation =
  | { status: "ok"; uploads: { id: string; url: string }[]; present: string[]; manifest?: { url: string }; expiresAt: number }
  | { status: "not_found" | "committed" | "quota" | "versions" | "open" | "mismatch" | "busy" }

/**
 * Reserves quota for the objects (and the manifest) the store does not hold yet, atomically, and only then signs a PUT
 * for each of them, carrying its exact size. Objects the store holds are answered `present`; the version records every
 * object declared. Nothing is reserved or signed unless all of it fits.
 */
export async function reserveUploads(
  user: string,
  input: {
    version: string
    versionAt: number
    objects: readonly Vault.ObjectRef[]
    manifest?: number
    quotaBytes: number
    versionDays: number
  },
  options: Options = {},
): Promise<Reservation> {
  // One time for the store and the links: each row records when the links signed below stop working.
  const now = Math.trunc(options.now ?? Date.now())
  const answer = await rpc(
    {
      action: "reserve",
      ...account(user),
      version: input.version,
      versionAt: input.versionAt,
      objects: input.objects.map((item) => ({ id: item.id, size: item.size })),
      ...(input.manifest !== undefined ? { manifest: input.manifest } : {}),
      quota: input.quotaBytes,
      versionDays: input.versionDays,
      reserveMs: VAULT_LIMITS.reserveMs,
      signedMs: VAULT_LIMITS.linkSeconds * 1000 + VAULT_LIMITS.linkGraceMs,
      limits: { open: VAULT_LIMITS.open, versions: VAULT_LIMITS.versions, objects: VAULT_LIMITS.objects, refs: VAULT_LIMITS.refs },
    },
    { ...options, now },
  )
  if (["not_found", "committed", "quota", "versions", "open", "mismatch", "busy"].includes(answer.status))
    return { status: answer.status as Exclude<Reservation["status"], "ok"> }
  if (answer.status !== "ok" || typeof answer.manifest !== "boolean") throw unavailable()
  const vault = vaultId(answer.vault)
  const owner = vaultAccount(user)
  const sizes = new Map(input.objects.map((item) => [item.id, item.size]))
  const sign = ids(answer.sign, OBJECT_ID)
  const present = ids(answer.present, OBJECT_ID)
  if (sign.some((id) => !sizes.has(id)) || present.some((id) => !sizes.has(id))) throw unavailable()
  if (answer.manifest && input.manifest === undefined) throw unavailable()
  const put = (kind: BlobKind, id: string, size: number) =>
    presignR2("vault", {
      method: "PUT",
      key: vaultBlobKey({ account: owner, vault, kind, id }),
      contentLength: size,
      contentType: "application/octet-stream",
      expiresIn: VAULT_LIMITS.linkSeconds,
      now,
    })
  return {
    status: "ok",
    uploads: sign.map((id) => ({ id, url: put("object", id, sizes.get(id)!).url })),
    present,
    ...(answer.manifest ? { manifest: { url: put("manifest", input.version, input.manifest!).url } } : {}),
    expiresAt: Math.floor(now / 1000) * 1000 + VAULT_LIMITS.linkSeconds * 1000,
  }
}

type Head = { kind: BlobKind; id: string; size: number }

function heads(value: unknown): Head[] {
  if (!Array.isArray(value)) throw unavailable()
  return value.map((item: Record<string, unknown>) => {
    if (
      !item ||
      (item.kind !== "object" && item.kind !== "manifest") ||
      typeof item.id !== "string" ||
      !(item.kind === "object" ? OBJECT_ID : VERSION_ID).test(item.id)
    )
      throw unavailable()
    return { kind: item.kind, id: item.id, size: count(item.size) }
  })
}

/**
 * Commits a version: HEADs every object still pending for it and its manifest, in rounds within `budgetMs`. Each round
 * confirms what arrived whole (stored at once, so a backup run again finds it present). An object whose size differs,
 * or that never arrived, is deleted and answered 409 `VAULT_SIZE_MISMATCH`. A version too large to check in the budget
 * is answered 503 with what was confirmed kept. Committing a committed version answers its snapshot again.
 */
export async function commitVersion(
  user: string,
  input: { version: string; objects: number },
  options: Options & { readonly budgetMs?: number; readonly clock?: () => number } = {},
): Promise<Vault.Snapshot> {
  const clock = options.clock ?? Date.now
  const deadline = clock() + (options.budgetMs ?? 40_000)
  const owner = vaultAccount(user)
  for (;;) {
    const now = clock()
    const check = await rpc({ action: "check", ...account(user), ...input, limit: VAULT_LIMITS.headBatch }, { ...options, now })
    if (check.status === "not_found") throw vaultNotFound()
    if (check.status === "committed") return snapshot(check.snapshot)
    if (check.status === "count" || check.status === "manifest" || check.status === "missing") throw sizeMismatch()
    if (check.status !== "ok") throw unavailable()
    const vault = vaultId(check.vault)
    const pending = heads(check.heads)
    const verified: Head[] = []
    const bad: Head[] = []
    await inParallel(pending, async (head) => {
      if (clock() >= deadline) return
      const key = vaultBlobKey({ account: owner, vault, kind: head.kind, id: head.id })
      const response = await (options.fetcher ?? fetch)(
        presignR2("vault", { method: "HEAD", key, expiresIn: 300, now: clock() }).url,
        { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(10_000) },
      ).catch(() => undefined)
      if (response?.status === 404) return void bad.push(head)
      if (!response?.ok) throw unavailable()
      const length = Number(response.headers.get("content-length"))
      if (Number.isSafeInteger(length) && length === head.size) verified.push(head)
      else bad.push(head)
    })
    if (bad.length) {
      await rpc(
        { action: "discard", ...account(user), items: bad.map((head) => ({ kind: head.kind, id: head.id })) },
        { ...options, now: clock() },
      )
      await purgeVaults({ ...options, user, budgetMs: 5_000, clock }).catch(() => undefined)
      throw sizeMismatch()
    }
    const done = await rpc({ action: "commit", ...account(user), ...input, verified }, { ...options, now: clock() })
    if (done.status === "ok" || done.status === "committed") return snapshot(done.snapshot)
    if (done.status === "not_found") throw vaultNotFound()
    if (done.status === "count" || done.status === "manifest" || done.status === "missing") throw sizeMismatch()
    if (done.status !== "more" || !verified.length || clock() >= deadline)
      throw new ApiError(503, "VAULT_UNAVAILABLE", "Brain Vault is still checking this backup. Run it again shortly.", {
        retryAfterSeconds: 5,
      })
  }
}

/** Forgets a committed version and queues what only it named. False when there is no such version. */
export async function forgetVersion(user: string, version: string, options: Options = {}) {
  const answer = await rpc({ action: "forget", ...account(user), version }, options)
  if (answer.status === "not_found") return false
  if (answer.status !== "ok") throw unavailable()
  return true
}

/**
 * Deletes the account's vault: the wrapped key and the listing go in one step, so nothing can be restored from then
 * on, and every blob is queued for deletion from R2. False when there is no vault.
 */
export async function destroyVault(user: string, options: Options = {}) {
  const answer = await rpc({ action: "destroy", ...account(user) }, options)
  if (answer.status === "not_found") return false
  if (answer.status !== "ok") throw unavailable()
  return true
}

type Claimed = { vaultId: string; account: string; vault: string; kind: BlobKind; id: string }

/**
 * Deletes queued blobs from R2, one account's (`user`) or every vault's in this mode, until nothing is queued or the
 * budget is spent. A delete that fails stays claimed and is claimed again later.
 */
export async function purgeVaults(
  options: Options & { readonly user?: string; readonly budgetMs: number; readonly clock?: () => number },
) {
  const clock = options.clock ?? Date.now
  const deadline = clock() + options.budgetMs
  const owner = options.user === undefined ? undefined : vaultAccount(options.user)
  let deleted = 0
  let failed = 0
  while (clock() < deadline) {
    const now = clock()
    const answer = await rpc(
      { action: "claim", ...(owner ? { account: owner } : {}), limit: 200, staleMs: VAULT_LIMITS.claimStaleMs },
      { ...options, now },
    )
    if (answer.status !== "ok" || !Array.isArray(answer.items)) throw unavailable()
    const items = answer.items.map((item: Record<string, unknown>): Claimed => {
      if (
        typeof item?.vaultId !== "string" ||
        typeof item.account !== "string" ||
        typeof item.vault !== "string" ||
        (item.kind !== "object" && item.kind !== "manifest") ||
        typeof item.id !== "string"
      )
        throw unavailable()
      return { vaultId: item.vaultId, account: item.account, vault: item.vault, kind: item.kind, id: item.id }
    })
    if (!items.length) break
    const done: Claimed[] = []
    await inParallel(items, async (item) => {
      const response = await (options.fetcher ?? fetch)(
        presignR2("vault", { method: "DELETE", key: vaultBlobKey(item), expiresIn: 300, now: clock() }).url,
        { method: "DELETE", redirect: "error", signal: AbortSignal.timeout(10_000) },
      ).catch(() => undefined)
      if (response && (response.ok || response.status === 404)) done.push(item)
      else failed++
    })
    if (done.length)
      await rpc(
        {
          action: "purged",
          items: done.map((item) => ({ vaultId: item.vaultId, kind: item.kind, id: item.id })),
          claimedAt: answer.claimedAt,
        },
        { ...options, now: clock() },
      )
    deleted += done.length
    if (items.length < 200 || !done.length) break
  }
  return { deleted, failed }
}

/**
 * The daily cleanup (`/api/vault/cleanup`, 03:40 UTC): per vault, deletes a read-only vault whose notice ran out,
 * sweeps versions and uploads that never committed an hour after their last request, prunes committed versions older
 * than the plan's version days (the newest is always kept) and queues the objects no version names. A vault held by
 * a dispute loses nothing it committed. Then it deletes what is queued, within the budget.
 */
export async function cleanupVaults(options: Options & { readonly budgetMs: number; readonly clock?: () => number }) {
  const clock = options.clock ?? Date.now
  const deadline = clock() + options.budgetMs
  const totals = { vaults: 0, lapsed: 0, uncommitted: 0, expired: 0, pruned: 0, collected: 0 }
  let cursor: string | undefined
  do {
    const answer = await rpc(
      { action: "cleanup", uncommittedMs: VAULT_LIMITS.reserveMs, limit: 50, ...(cursor ? { cursor } : {}) },
      { ...options, now: clock() },
    )
    if (answer.status !== "ok") throw unavailable()
    for (const name of Object.keys(totals) as (keyof typeof totals)[]) totals[name] += count(answer[name])
    cursor = typeof answer.cursor === "string" ? answer.cursor : undefined
  } while (cursor && clock() < deadline)
  const purged = await purgeVaults({ ...options, budgetMs: Math.max(0, deadline - clock()), clock })
  return { ...totals, more: cursor !== undefined, ...purged }
}

// ── The provisioner's side (§4.4's Brain Vault row) ────────────────────────────────────────────────────────────────

/** Frozen (a dispute or a fraud warning): uploads stop and nothing is deleted, not even by age. */
export async function holdVault(user: string, options: Options = {}) {
  if ((await rpc({ action: "hold", ...account(user) }, options)).status !== "ok") throw unavailable()
}

/** Active, renewing or paused on a plan with Brain Vault: no hold, and no deletion date. */
export async function releaseVault(user: string, options: Options = {}) {
  if ((await rpc({ action: "release", ...account(user) }, options)).status !== "ok") throw unavailable()
}

/**
 * The plan ended, or no longer includes Brain Vault: the vault turns read-only for `VAULT_LIMITS.lapseDays` from the
 * notice, then the cleanup deletes it.
 * The notice is emailed once (an idempotency key per snapshot version keeps a retried send from going twice) and only
 * then recorded, so a vault is never deleted without it. An account whose identity is already gone gets no email.
 */
export async function lapseVault(user: string, options: Options & { readonly version: number }) {
  const status = await rpc({ action: "lapse-status", ...account(user) }, options)
  if (status.status === "not_found") return { notice: "none" as const }
  if (status.status !== "ok") throw unavailable()
  const recorded = optionalTime(status.deleteAt)
  if (recorded && optionalTime(status.noticeAt)) return { notice: "recorded" as const, deleteAt: recorded }
  const now = options.now ?? Date.now()
  const deleteAt = now + VAULT_LIMITS.lapseDays * DAY_MS
  await sendVaultNotice(user, deleteAt, `vault-notice-${vaultAccount(user).slice(0, 32)}-${options.version}`, options)
  const answer = await rpc({ action: "notice", ...account(user), deleteAt }, { ...options, now })
  if (answer.status === "not_found") return { notice: "none" as const }
  if (answer.status !== "ok") throw unavailable()
  return { notice: "sent" as const, deleteAt: optionalTime(answer.deleteAt) ?? deleteAt }
}

/**
 * Account deletion (P5): the vault goes at once (wrapped key first), and its blobs as far as a short budget allows;
 * those an upload link can still write go with the next cleanup.
 */
export async function eraseAccountVault(user: string, options: Options = {}) {
  if (!vaultStoreConfigured()) return false
  const erased = await destroyVault(user, options)
  await purgeVaults({ ...options, user, budgetMs: 5_000 }).catch(() => undefined)
  return erased
}

const NOTICE_DATE = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" })

/** The read-only notice. No amount and no plan detail; the address comes from the account's identity. */
async function sendVaultNotice(user: string, deleteAt: number, idempotencyKey: string, options: Options) {
  const key = process.env.RESEND_API_KEY?.trim()
  const from = process.env.VECTOR_PURCHASE_EMAIL_FROM?.trim()
  const target = supabase()
  if (!key || !from || !target)
    throw new ApiError(503, "VAULT_NOTICE_UNAVAILABLE", "The Brain Vault notice could not be sent.")
  const fetcher = options.fetcher ?? fetch
  const identity = await fetcher(`${target.url}/auth/v1/admin/users/${encodeURIComponent(user)}`, {
    headers: { apikey: target.key, authorization: `Bearer ${target.key}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (identity?.status === 404) return false
  if (!identity?.ok) throw new ApiError(503, "VAULT_NOTICE_UNAVAILABLE", "The Brain Vault notice could not be sent.")
  const record = (await identity.json().catch(() => undefined)) as { id?: unknown; email?: unknown } | undefined
  if (record?.id !== user || typeof record.email !== "string" || !record.email.includes("@"))
    throw new ApiError(503, "VAULT_NOTICE_UNAVAILABLE", "The Brain Vault notice could not be sent.")
  const date = NOTICE_DATE.format(deleteAt)
  const response = await fetcher("https://api.resend.com/emails", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({
      from,
      to: [record.email],
      subject: "Your Brain Vault is read-only",
      text: [
        "Your Vector Codium plan no longer includes Brain Vault on Vector, so it takes no new backups.",
        `Your backups stay readable until ${date}. Restore them from the Vector app or with \`vector vault restore\`.`,
        "After that date Vector deletes them.",
        "",
        "To keep them, choose a plan at https://vectordev.ai/codium, or back up to a private GitHub repository you own with `vector vault backup --github <owner/repo>`.",
      ].join("\n"),
    }),
  }).catch(() => undefined)
  if (!response?.ok) throw new ApiError(503, "VAULT_NOTICE_UNAVAILABLE", "The Brain Vault notice could not be sent.")
  return true
}

/** Runs `work` over `items`, `VAULT_LIMITS.parallel` at a time. The first error stops new work and is thrown. */
async function inParallel<T>(items: readonly T[], work: (item: T) => Promise<void>) {
  let next = 0
  let failure: unknown
  await Promise.all(
    Array.from({ length: Math.min(VAULT_LIMITS.parallel, items.length) }, async () => {
      while (next < items.length && failure === undefined) {
        const item = items[next++]!
        await work(item).catch((error: unknown) => {
          failure ??= error
        })
      }
    }),
  )
  if (failure !== undefined) throw failure
}
