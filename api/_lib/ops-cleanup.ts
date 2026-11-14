import { ShipDesk } from "../../packages/schema/src/ship-desk.js"
import { codiumKey } from "./codium-keys.js"
import { readSnapshot } from "./codium-snapshot.js"
import { ApiError } from "./http.js"
import {
  forgetOpsAccount,
  lostDispute,
  OPS_LOST_DISPUTE_ERASE_MS,
  opsAccountsKey,
  opsEraseDueKey,
  readEraseDue,
  readOpsAccounts,
  rosterPlan,
} from "./ops-accounts.js"
import { forgetGuardAccount } from "./ops-guard.js"
import { eraseAccountOpsHealth } from "./ops-health.js"
import { eraseAccountOpsRecords, incidentIndexKey, incidentKey } from "./ops-incidents.js"
import { eraseAccountOpsSettings } from "./ops-settings.js"
import { opsCall, opsConfigured, opsErasable } from "./ops-worker.js"
import { persistentStore } from "./persistent-store.js"
import {
  cardIndexKey,
  cardKey,
  cardRefreshKey,
  cardRunKey,
  decodeCard,
  deleteCardObjects,
  eraseAccountShipDesk,
  type Card,
} from "./ship-desk.js"

/*
 * The daily ops cleanup (WP A50; contract §4.19 `/api/ops/cleanup`, 04:40 UTC):
 *
 * - Ship Desk cards past their keep days (30 or 90) are deleted with their images in `vector-media`. A card's record
 *   outlives its expiry by a few days, hidden from every reader (ship-desk.ts `retainMs`), so this still finds its
 *   images; the bucket's lifecycle rules stay as the backstop. The cleanup deletes none of a frozen account's cards
 *   (§4.4: hidden, not deleted) until it is no longer frozen; a card's record and images still lapse by their own
 *   lifetimes (its keep days plus `retainMs` in the store, the bucket's rules in R2), as every card does.
 * - Incidents expire by themselves after 90 days (ops-incidents.ts); entries left in an account's card and incident
 *   lists after their record expired are removed.
 * - An account whose dispute was lost has every ops record erased 30 days after the loss: the Worker's data, settings,
 *   incidents, Release Guard records, cards with their images, domain health and the crons' own records (§4.4 keeps
 *   frozen accounts' cards hidden, not deleted, while a dispute is open).
 * - An account with nothing left to clean and no plan giving the Worker work is dropped from the cleanup's list.
 *
 * It answers counts only, and stops within its time budget, leaving the rest for the next day.
 */

export const OPS_CLEANUP = {
  /** Accounts read per run of the list. */
  batch: 500,
  /** Accounts cleaned at once. */
  concurrency: 6,
  /** Cards and incidents read per account. */
  perAccount: 2_000,
} as const

export const opsCleanupCursorKey = () => codiumKey("ops", "cleanup", "cursor")

export type OpsCleanupResult = {
  enabled: boolean
  accounts: number
  cardsExpired: number
  imagesDeleted: number
  entriesPruned: number
  erased: number
  dropped: number
  failures: number
  more: boolean
}

function unreadable(): never {
  throw new ApiError(503, "OPS_RECORDS_UNAVAILABLE", "Vector's production check records could not be read.")
}

async function indexMembers(key: string, fetcher: typeof fetch) {
  const raw = await persistentStore(
    ["ZRANGEBYSCORE", key, "-inf", "+inf", "LIMIT", "0", String(OPS_CLEANUP.perAccount)],
    fetcher,
  )
  if (!Array.isArray(raw)) unreadable()
  return raw.map(String)
}

/**
 * Erases everything ops holds for an account, in both Stripe modes: the Worker's data (while its address and secret are
 * set, even with VECTOR_OPS_ENABLED off), the ops settings, incidents and Release Guard records, Ship Desk's cards with
 * their images, domain health, and the guard's and cleanup's own records. Account deletion (A57) calls this one
 * function; the ops provisioner does the same on `closing`. Throws when a part cannot be reached, so the caller tries
 * again.
 */
export async function eraseAccountOps(account: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  if (opsErasable()) await opsCall("erase", { account }, fetcher, now)
  await eraseAccountOpsSettings(account, fetcher)
  await eraseAccountOpsRecords(account, fetcher, now)
  await eraseAccountShipDesk(account, fetcher, now)
  await eraseAccountOpsHealth(account, fetcher)
  await forgetGuardAccount(account, fetcher)
  await forgetOpsAccount(account, fetcher)
}

async function expireCards(account: string, now: number, fetcher: typeof fetch, result: OpsCleanupResult) {
  const index = cardIndexKey(account)
  const ids = (await indexMembers(index, fetcher)).filter((id) => ShipDesk.CARD_ID.test(id))
  if (!ids.length) return 0
  const stored = await persistentStore(["MGET", ...ids.map((id) => cardKey(account, id))], fetcher)
  if (!Array.isArray(stored)) unreadable()
  let left = 0
  for (const [position, id] of ids.entries()) {
    const raw = stored[position]
    let card: Card | undefined
    try {
      card = raw === null || raw === undefined ? undefined : decodeCard(JSON.parse(String(raw)))
    } catch {
      card = undefined
    }
    if (raw !== null && raw !== undefined && !card) {
      // A record that cannot be read is left for a person; it still expires with its lifetime.
      left++
      continue
    }
    if (card && card.expiresAt > now) {
      left++
      continue
    }
    if (card) {
      const objects = [...card.images.map((image) => image.key), ...(card.capture?.files.map((file) => file.key) ?? [])]
      if (objects.length) {
        // Images first: a card whose images could not all be deleted stays for the next run.
        if (!(await deleteCardObjects(objects, fetcher, now))) {
          left++
          result.failures++
          continue
        }
        result.imagesDeleted += objects.length
      }
      const keys = [
        cardKey(account, id),
        cardRefreshKey(account, id),
        ...(card.rid ? [cardRunKey(account, card.rid)] : []),
      ]
      await persistentStore(["DEL", ...keys], fetcher)
      result.cardsExpired++
    } else result.entriesPruned++
    await persistentStore(["ZREM", index, id], fetcher)
  }
  return left
}

async function pruneIncidents(account: string, fetcher: typeof fetch, result: OpsCleanupResult) {
  const index = incidentIndexKey(account)
  const ids = await indexMembers(index, fetcher)
  if (!ids.length) return 0
  const stored = await persistentStore(["MGET", ...ids.map((id) => incidentKey(account, id))], fetcher)
  if (!Array.isArray(stored)) unreadable()
  let left = 0
  for (const [position, id] of ids.entries()) {
    if (stored[position] !== null && stored[position] !== undefined) {
      left++
      continue
    }
    await persistentStore(["ZREM", index, id], fetcher)
    result.entriesPruned++
  }
  return left
}

async function cleanAccount(account: string, now: number, fetcher: typeof fetch, result: OpsCleanupResult) {
  const snapshot = await readSnapshot(account, fetcher).catch((error: unknown) => {
    if (error instanceof ApiError && error.code === "PERSISTENT_STORE_UNAVAILABLE") throw error
    return undefined
  })
  // A frozen account's cards are hidden, and the cleanup deletes none of them (§4.4) until the dispute or warning is
  // settled; their own lifetimes still apply. The account stays on the list.
  if (snapshot?.state === "frozen") return
  const cards = await expireCards(account, now, fetcher, result)
  const incidents = await pruneIncidents(account, fetcher, result)
  if (lostDispute(snapshot)) {
    // A loss the provisioner never saw (ops was off then): its date is the snapshot's.
    await persistentStore(
      ["ZADD", opsEraseDueKey(), "NX", snapshot!.updatedAt + OPS_LOST_DISPUTE_ERASE_MS, account],
      fetcher,
    )
    return
  }
  if (!cards && !incidents && !rosterPlan(snapshot)) {
    // Nothing left to expire and no plan giving the Worker work: a new plan's transition adds it back.
    await persistentStore(["ZREM", opsAccountsKey(), account], fetcher)
    result.dropped++
  }
}

export type OpsCleanupInput = { fetcher?: typeof fetch; clock?: () => number; budgetMs: number }

/** One run of the cleanup. */
export async function cleanupOps(input: OpsCleanupInput): Promise<OpsCleanupResult> {
  const fetcher = input.fetcher ?? fetch
  const clock = input.clock ?? Date.now
  const started = clock()
  const result: OpsCleanupResult = {
    enabled: opsConfigured(),
    accounts: 0,
    cardsExpired: 0,
    imagesDeleted: 0,
    entriesPruned: 0,
    erased: 0,
    dropped: 0,
    failures: 0,
    more: false,
  }
  if (!result.enabled) return result
  const late = () => clock() - started > input.budgetMs

  // Lost disputes 30 days on: erase, unless the account is no longer in that state (a won appeal, a cleared block).
  for (const account of await readEraseDue(started, OPS_CLEANUP.batch, fetcher)) {
    if (late()) {
      result.more = true
      return result
    }
    try {
      const snapshot = await readSnapshot(account, fetcher)
      if (lostDispute(snapshot)) {
        await eraseAccountOps(account, fetcher, clock())
        result.erased++
      } else await persistentStore(["ZREM", opsEraseDueKey(), account], fetcher)
    } catch {
      result.failures++
    }
  }

  // Every account with ops records, a batch a day, continuing where the last run stopped.
  const cursor = Number((await persistentStore(["GET", opsCleanupCursorKey()], fetcher)) ?? 0)
  const offset = Number.isSafeInteger(cursor) && cursor > 0 ? cursor : 0
  const accounts = await readOpsAccounts(offset, OPS_CLEANUP.batch, fetcher)
  const queue = [...accounts]
  let done = 0
  const work = async () => {
    for (let account = queue.shift(); account; account = queue.shift()) {
      if (late()) {
        queue.unshift(account)
        return
      }
      try {
        await cleanAccount(account, clock(), fetcher, result)
        result.accounts++
      } catch {
        result.failures++
      }
      done++
    }
  }
  await Promise.all(Array.from({ length: OPS_CLEANUP.concurrency }, work))
  result.more = queue.length > 0 || accounts.length === OPS_CLEANUP.batch
  // Dropped accounts shift the list left; the next run starts a little early rather than skip anyone.
  const next = result.more ? Math.max(0, offset + done - result.dropped) : 0
  await persistentStore(["SET", opsCleanupCursorKey(), String(next)], fetcher)
  return result
}
