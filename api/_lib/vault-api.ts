import { Option, Schema } from "effect"
import { Vault } from "../../packages/schema/src/vault.js"
import type { EntitlementSnapshot } from "../../packages/schema/src/codium-entitlements.js"
import { enforceRateLimit } from "./abuse.js"
import { cheapestPlanWith, includes, readEntitlement, requireUsableSnapshot } from "./codium-entitlements.js"
import { listedPerks } from "./codium-perks.js"
import { readSnapshot } from "./codium-snapshot.js"
import { renewalGraceMinutes } from "./codium-limits.js"
import { ApiError, type ApiRequest, type ApiResponse } from "./http.js"
import { requireUnrevokedCliToken } from "./revocation.js"
import {
  VAULT_LIMITS,
  VAULT_OBJECT_OVERHEAD,
  VERSION_ID,
  unavailable,
  vaultQuotaBytes,
  vaultStoreConfigured,
} from "./vault-store.js"

/*
 * The Vault API's rules (WP A44, contract §4.4's Brain Vault row), shared by the routes in api/vault/:
 *
 * - **Who.** Only a Vector account token (`vct_`, the desktop's or the CLI's); run tokens never (S3). A revoked account
 *   or token gets 401.
 * - **Writes** (creating the vault, reserving uploads, committing) need `vault` listed (H1: `CODIUM_LISTED_PERKS`, the
 *   `vault` switch, `VECTOR_VAULT_ENABLED` and the store; listing waits on the legal read, §1.2), and a plan that
 *   includes Brain Vault in a state that takes uploads, read from the entitlement snapshot (S1):
 *   - active, or renewing within the grace: uploads, up to the plan's quota (checked before anything is signed);
 *   - paused, ended (read-only 30 days from the notice) and frozen: 409 `VAULT_READ_ONLY`, restore still works;
 *   - no plan: 402 `MODEL_PLAN_REQUIRED`; a plan without Vault: 403 `CODIUM_PERK_REQUIRED {perk: "vault"}`; renewing
 *     past the grace: 503 `MODEL_PLAN_RENEWING`; an account being deleted: 409 `MODEL_PLAN_ACCOUNT_CLOSING`.
 * - **Reads and deletes** (the wrapped key, versions, signed downloads, forgetting a version, deleting the vault) need
 *   only the sign-in, whatever the plan and the listing, so a vault can always be restored or deleted while it exists.
 */

const TOKEN = /^Bearer (vct_[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)$/
const HOUR_SECONDS = 3_600
const READ_ONLY_STATES = new Set(["paused", "ended", "frozen"])

/** Request limits per account and hour. A large first backup sends one uploads request per 1000 objects. */
export const VAULT_RATES = { read: 1_200, write: 1_200, remove: 60 } as const

/** The signed-in account, or 401. */
export async function requireVaultCaller(request: ApiRequest, fetcher: typeof fetch, now: number) {
  const token = TOKEN.exec(String(request.headers.authorization ?? ""))?.[1]
  if (!token) throw new ApiError(401, "CLI_TOKEN_INVALID", "Sign in to Vector again to continue.")
  return (await requireUnrevokedCliToken(token, fetcher, now)).id
}

async function limit(
  request: ApiRequest,
  response: ApiResponse,
  account: string,
  kind: keyof typeof VAULT_RATES,
  fetcher: typeof fetch,
) {
  await enforceRateLimit(
    request,
    response,
    { scope: `vault-${kind}`, identifier: account, limit: VAULT_RATES[kind], windowSeconds: HOUR_SECONDS, requirePersistent: true },
    fetcher,
  )
}

export type VaultWriter = { account: string; snapshot: EntitlementSnapshot; quotaBytes: number; versionDays: number }

/**
 * A caller who may write to their vault now (the rules above). The listing is checked before the sign-in is read, so
 * an unlisted Vault says nothing about the caller.
 */
export async function requireVaultWriter(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch,
  now: number,
): Promise<VaultWriter> {
  if (!(await listedPerks(fetcher)).has("vault") || !vaultStoreConfigured())
    throw new ApiError(503, "VAULT_UNAVAILABLE", "Brain Vault on Vector is not available.")
  const account = await requireVaultCaller(request, fetcher, now)
  await limit(request, response, account, "write", fetcher)
  const snapshot = await readEntitlement(account, fetcher, now)
  if (snapshot && READ_ONLY_STATES.has(snapshot.state) && snapshot.reason !== "closing") throw readOnly(snapshot)
  const usable = requireUsableSnapshot(snapshot, now)
  if (!includes(usable.caps, "vault"))
    throw new ApiError(403, "CODIUM_PERK_REQUIRED", "Your Vector Codium plan does not include Brain Vault.", {
      detail: { perk: "vault", plan: cheapestPlanWith("vault") },
    })
  return {
    account,
    snapshot: usable,
    quotaBytes: vaultQuotaBytes(usable.caps.vault.gb),
    versionDays: Math.min(3_650, Math.max(1, Math.trunc(usable.caps.vault.versionDays) || 30)),
  }
}

function readOnly(snapshot: EntitlementSnapshot) {
  return new ApiError(
    409,
    "VAULT_READ_ONLY",
    snapshot.state === "frozen"
      ? "Brain Vault takes no new backups while this account is on hold. Restoring still works."
      : "Brain Vault takes no new backups while your plan is paused or has ended. Restoring still works.",
    { detail: { state: snapshot.state } },
  )
}

export type VaultReader = { account: string; snapshot?: EntitlementSnapshot }

/**
 * A caller who may read or delete their vault: the store configured, a sign-in, and an account that is not being
 * deleted. The snapshot is the stored one (no Stripe call); it decides only what the listing shows.
 */
export async function requireVaultReader(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch,
  now: number,
  kind: "read" | "remove" = "read",
): Promise<VaultReader> {
  if (!vaultStoreConfigured()) throw unavailable()
  const account = await requireVaultCaller(request, fetcher, now)
  await limit(request, response, account, kind, fetcher)
  const snapshot = await readSnapshot(account, fetcher)
  if (snapshot?.state === "ended" && snapshot.reason === "closing")
    throw new ApiError(409, "MODEL_PLAN_ACCOUNT_CLOSING", "This account is being deleted. Brain Vault is closed.")
  return { account, ...(snapshot ? { snapshot } : {}) }
}

/** Whether uploads are refused now (§4.4), for the listing's `readOnly`, and the quota the listing shows. */
export function vaultReadState(snapshot: EntitlementSnapshot | undefined, now: number) {
  const quotaBytes = vaultQuotaBytes(snapshot?.caps.vault.gb ?? 0)
  const writable =
    snapshot !== undefined &&
    quotaBytes > 0 &&
    (snapshot.state === "active" ||
      (snapshot.state === "renewing" && now < snapshot.periodEnd + renewalGraceMinutes() * 60_000))
  return { readOnly: !writable, quotaBytes }
}

// ── Bodies ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function invalid(message = "That Brain Vault request is not valid.") {
  return new ApiError(400, "VAULT_REQUEST_INVALID", message)
}

function decode<A>(schema: Schema.Decoder<A>, value: unknown): A {
  const decoded = Schema.decodeUnknownOption(schema)(value)
  if (Option.isNone(decoded)) throw invalid()
  return decoded.value
}

export function decodeSetup(value: unknown): Vault.SetupRequest {
  const body = decode(Vault.SetupRequest, value)
  if (body.key.vault !== body.vault) throw invalid("The vault's key record names another vault.")
  return body
}

/** The smallest object or manifest the format can write: its header, nonce and tag. */
const VAULT_LIMITS_MIN = VAULT_OBJECT_OVERHEAD

/** An uploads request: up to 1000 distinct objects within the format's sizes, a version made recently. */
export function decodeUploads(value: unknown, now: number) {
  const body = decode(Vault.UploadsRequest, value)
  if (body.objects.length > Vault.LIMIT.batch) throw invalid(`Declare at most ${Vault.LIMIT.batch} objects at a time.`)
  if (new Set(body.objects.map((item) => item.id)).size !== body.objects.length)
    throw invalid("Each object is declared once.")
  if (body.objects.some((item) => item.size < VAULT_LIMITS_MIN || item.size > VAULT_LIMITS.objectBytes))
    throw invalid("An object's size is outside what Brain Vault writes.")
  if (body.manifest && (body.manifest.size < VAULT_LIMITS_MIN || body.manifest.size > VAULT_LIMITS.manifestBytes))
    throw invalid("The manifest's size is outside what Brain Vault writes.")
  const versionAt = versionTime(body.version)
  if (versionAt < now - VAULT_LIMITS.versionPastMs || versionAt > now + VAULT_LIMITS.versionAheadMs)
    throw invalid("That backup version is too old, or ahead of this server's clock. Run the backup again.")
  return { ...body, versionAt }
}

export function decodeCommit(value: unknown): Vault.CommitRequest {
  const body = decode(Vault.CommitRequest, value)
  if (body.objects > VAULT_LIMITS.refs) throw invalid()
  return body
}

export function decodeDownloads(value: unknown): Vault.DownloadsRequest {
  const body = decode(Vault.DownloadsRequest, value)
  if (body.objects.length > Vault.LIMIT.batch) throw invalid(`Ask for at most ${Vault.LIMIT.batch} objects at a time.`)
  return { objects: [...new Set(body.objects)] }
}

/** A version id from the path, or 400. */
export function versionParam(value: string | undefined) {
  if (!value || !VERSION_ID.test(value)) throw invalid("Choose one of your backup versions.")
  return value
}

export function versionTime(version: string) {
  return Number(version.slice(1, 14))
}

