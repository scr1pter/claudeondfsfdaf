import { randomUUID } from "node:crypto"
import { codiumKey } from "./codium-keys.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

/*
 * Account deletion's tombstone (contract §4.6 `tombstone:<id>`, P5; WP A57). Deletion sets it before anything else and
 * it stays until the deletion is finished and checked once more, then for `TOMBSTONE_KEEP_MS`:
 * - reconcile reads it, so no notification, sweep or request can reopen an account being deleted, and once its Codium
 *   records are erased reconcile answers "closing" without writing anything back;
 * - checkout and plan changes refuse an account that has it, record or not (an account that never bought has no
 *   closing snapshot to refuse on);
 * - every other path that starts or queues paid work reads the snapshot, which deletion turns `ended`/`closing` right
 *   after the tombstone (in the same request, after revoking the account's tokens), and once the records are erased
 *   `readEntitlement` finds no snapshot, reads the tombstone and answers "closing" (codium-erase.ts). Those paths do not
 *   read the tombstone themselves, so a hot path (chat, status) costs no extra store call; if the closing snapshot
 *   cannot be written, the deletion stops there and the cron retries it.
 * The cleanup cron (`/api/account/deletions`) finds unfinished deletions in `tombstones:due`.
 *
 * The record holds times, a count and the ids of the parts that failed. Never an email, a name or an error message.
 * This module imports nothing that reads the plan, so model-plan-account.ts can use it without an import cycle.
 */

const DAY_MS = 86_400_000

/**
 * How long a finished deletion's tombstone is kept: past Stripe's webhook retries, the replay window and the dispute
 * window, so a late notification about the old subscription cannot write a record for the account again.
 */
export const TOMBSTONE_KEEP_MS = 180 * DAY_MS

export const tombstoneKey = (account: string) => codiumKey("tombstone", account)
/** `tombstones:due`: unfinished deletions, scored by when the cleanup cron should next work on each. */
export const tombstonesDueKey = () => codiumKey("tombstones", "due")
const leaseKey = (account: string) => codiumKey("tombstone", account, "lease")

/**
 * Where a deletion stands:
 * - `at`: when the person confirmed it;
 * - `attempts`: passes that did not finish (the cron's backoff and the owner alert count them);
 * - `erasedAt`: the erase marker, set once every Codium and hosted record is erased; the identity waits for it;
 * - `identityAt`: the Vector identity was deleted;
 * - `checkedAt`: the follow-up pass found nothing left, and the deletion is finished;
 * - `stage` and `failed`: where the last unfinished pass stopped, and which erase parts failed (ids only).
 */
export type Tombstone = {
  v: 1
  at: number
  attempts: number
  erasedAt?: number
  identityAt?: number
  checkedAt?: number
  stage?: DeletionStage
  failed?: string[]
}

export type DeletionStage = "close" | "revoke" | "billing" | "erase" | "identity" | "check"
const STAGES: ReadonlySet<string> = new Set(["close", "revoke", "billing", "erase", "identity", "check"])
const PART = /^[a-z][a-z-]{0,31}$/

const time = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0

/** A stored tombstone, or undefined for anything this module never writes. */
export function decodeTombstone(raw: unknown): Tombstone | undefined {
  if (typeof raw !== "string") return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.v !== 1 || !time(record.at)) return undefined
  if (typeof record.attempts !== "number" || !Number.isSafeInteger(record.attempts) || record.attempts < 0)
    return undefined
  for (const field of ["erasedAt", "identityAt", "checkedAt"] as const)
    if (record[field] !== undefined && !time(record[field])) return undefined
  if (record.stage !== undefined && (typeof record.stage !== "string" || !STAGES.has(record.stage))) return undefined
  if (
    record.failed !== undefined &&
    (!Array.isArray(record.failed) || !record.failed.every((part) => typeof part === "string" && PART.test(part)))
  )
    return undefined
  return {
    v: 1,
    at: record.at as number,
    attempts: record.attempts,
    ...(record.erasedAt === undefined ? {} : { erasedAt: record.erasedAt as number }),
    ...(record.identityAt === undefined ? {} : { identityAt: record.identityAt as number }),
    ...(record.checkedAt === undefined ? {} : { checkedAt: record.checkedAt as number }),
    ...(record.stage === undefined ? {} : { stage: record.stage as DeletionStage }),
    ...(record.failed === undefined ? {} : { failed: [...(record.failed as string[])] }),
  }
}

/** The account's tombstone, if it is being (or was recently) deleted. Throws when the store cannot be read. */
export async function readTombstone(account: string, fetcher: typeof fetch = fetch) {
  const raw = await persistentStore(["GET", tombstoneKey(account)], fetcher)
  if (raw === null || raw === undefined) return undefined
  // Something under the key that is not a tombstone still means someone started deleting the account: fail closed.
  return decodeTombstone(raw) ?? { v: 1 as const, at: 1, attempts: 0 }
}

/** Whether the account is being deleted (or was, within `TOMBSTONE_KEEP_MS`). Throws when the store cannot be read. */
export async function accountDeleting(account: string, fetcher: typeof fetch = fetch) {
  return (await readTombstone(account, fetcher)) !== undefined
}

/** The refusal every Codium path gives an account being deleted (the same code as a closing account record). */
export function deletingRefusal() {
  return new ApiError(409, "MODEL_PLAN_ACCOUNT_CLOSING", "This account is being deleted. Vector Codium is closed.")
}

/** Refuses with 409 `MODEL_PLAN_ACCOUNT_CLOSING` when the account is being deleted. */
export async function requireAccountOpen(account: string, fetcher: typeof fetch = fetch) {
  if (await accountDeleting(account, fetcher)) throw deletingRefusal()
}

/**
 * Sets the tombstone (keeping one already there, and taking a finished one's lifetime off so it cannot lapse while the
 * deletion runs again) and files it as due at `dueAt`, so the cleanup cron picks the deletion up if the request that
 * started it never finishes. Returns the tombstone. Throws when the store cannot be written: then nothing was changed.
 */
export async function markAccountDeleting(account: string, now: number, dueAt: number, fetcher: typeof fetch = fetch) {
  const fresh: Tombstone = { v: 1, at: now, attempts: 0 }
  const set = await persistentStore(["SET", tombstoneKey(account), JSON.stringify(fresh), "NX"], fetcher)
  let record = fresh
  if (set !== "OK") {
    // Written again without a lifetime, which a finished deletion's tombstone has. A finished deletion runs again.
    const { checkedAt: _checked, ...kept } = (await readTombstone(account, fetcher)) ?? fresh
    record = kept
    await saveTombstone(account, record, fetcher)
  }
  await scheduleTombstone(account, dueAt, fetcher)
  return record
}

/** Writes the tombstone, kept `keepMs` when given (a finished deletion), else until it is finished. */
export async function saveTombstone(
  account: string,
  record: Tombstone,
  fetcher: typeof fetch = fetch,
  keepMs?: number,
) {
  const written = await persistentStore(
    keepMs === undefined
      ? ["SET", tombstoneKey(account), JSON.stringify(record)]
      : ["SET", tombstoneKey(account), JSON.stringify(record), "PX", keepMs],
    fetcher,
  )
  if (written !== "OK")
    throw new ApiError(503, "PERSISTENT_STORE_UNAVAILABLE", "Protected account services are temporarily unavailable.")
}

/** Files the deletion as due at `at` for the cleanup cron. */
export async function scheduleTombstone(account: string, at: number, fetcher: typeof fetch = fetch) {
  await persistentStore(["ZADD", tombstonesDueKey(), Math.trunc(at), account], fetcher)
}

/** Takes the deletion off the cleanup cron's list (it is finished). */
export async function unscheduleTombstone(account: string, fetcher: typeof fetch = fetch) {
  await persistentStore(["ZREM", tombstonesDueKey(), account], fetcher)
}

/** Up to `limit` deletions due by `now`, oldest due first. */
export async function dueTombstones(now: number, limit: number, fetcher: typeof fetch = fetch) {
  const due = await persistentStore(
    ["ZRANGEBYSCORE", tombstonesDueKey(), "-inf", Math.trunc(now), "LIMIT", 0, limit],
    fetcher,
  )
  if (!Array.isArray(due))
    throw new ApiError(503, "PERSISTENT_STORE_UNAVAILABLE", "Protected account services are temporarily unavailable.")
  return due.map(String)
}

// One deletion runs at a time per account: the person's request, a retry of it, or the cleanup cron. The release script
// is the billing lease's, word for word.
const RELEASE = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0"

/** Takes the account's deletion lease for `ms`. Returns its token, or undefined while another run holds it. */
export async function takeDeletionLease(account: string, ms: number, fetcher: typeof fetch = fetch) {
  const token = randomUUID()
  const taken = await persistentStore(["SET", leaseKey(account), token, "NX", "PX", Math.trunc(ms)], fetcher)
  return taken === "OK" ? token : undefined
}

/** Gives the lease back, only if it is still this run's. */
export async function releaseDeletionLease(account: string, token: string, fetcher: typeof fetch = fetch) {
  await persistentStore(["EVAL", RELEASE, 1, leaseKey(account), token], fetcher).catch(() => undefined)
}

/** The lease's key, for the erase step that must not delete it and for tests. */
export const deletionLeaseKey = leaseKey
