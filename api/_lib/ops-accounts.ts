import { ENTITLEMENTS, type EntitlementSnapshot, type PlanId } from "../../packages/schema/src/codium-entitlements.js"
import { codiumKey, codiumKeyIn } from "./codium-keys.js"
import type { Transition } from "./codium-provision.js"
import { ApiError } from "./http.js"
import type { StripeMode } from "./model-plan-stripe.js"
import { persistentStore } from "./persistent-store.js"

/*
 * Which accounts the ops crons look at (WP A50). The ops provisioner (codium-provisioners.ts) keeps these records from
 * every snapshot change, so the guard and the cleanup never scan every account's snapshot:
 *
 * - `ops:roster:<plan>` (one sorted set per plan with ops caps, account → since when): accounts whose plan gives the ops
 *   Worker work now (active, renewing or paused). The guard counts them for its budget and reads their usage.
 * - `ops:accounts` (sorted set, account → last change): every account that ever had ops caps, so the cleanup finds
 *   cards and incidents that outlive the plan (§4.4: cards stay readable until they expire after a plan ends).
 * - `ops:erase:due` (sorted set, account → when): an account whose dispute was lost, due for erasure 30 days later
 *   (§4.4's cloud computer row, which A50's cleanup applies to the ops data too).
 *
 * They hold account ids and times only.
 */

const DAY_MS = 86_400_000
/** A lost dispute's ops data is erased this long after the loss. */
export const OPS_LOST_DISPUTE_ERASE_MS = 30 * DAY_MS
const LIVE: ReadonlySet<EntitlementSnapshot["state"]> = new Set(["active", "renewing", "paused"])
/** The plans whose caps include ops (Max and Ultra, ENTITLEMENTS). */
export const OPS_PLANS = (Object.keys(ENTITLEMENTS) as PlanId[]).filter((plan) => ENTITLEMENTS[plan].ops !== null)

function key(mode: StripeMode | undefined, ...parts: string[]) {
  return mode ? codiumKeyIn(mode, ...parts) : codiumKey(...parts)
}
export const opsRosterKey = (plan: PlanId, mode?: StripeMode) => key(mode, "ops", "roster", plan)
export const opsAccountsKey = (mode?: StripeMode) => key(mode, "ops", "accounts")
export const opsEraseDueKey = (mode?: StripeMode) => key(mode, "ops", "erase", "due")

function unavailable(): never {
  throw new ApiError(503, "OPS_RECORDS_UNAVAILABLE", "Vector's production check records could not be read.")
}

/** The plan an account's ops work runs under now, or undefined when the Worker has nothing to do for it. */
export function rosterPlan(snapshot: EntitlementSnapshot | undefined): PlanId | undefined {
  if (!snapshot?.plan || !snapshot.caps.ops || !LIVE.has(snapshot.state)) return undefined
  return OPS_PLANS.includes(snapshot.plan) ? snapshot.plan : undefined
}

/** A lost dispute: the plan ended because a dispute on one of its payments was lost (§4.4). */
export function lostDispute(snapshot: EntitlementSnapshot | undefined) {
  return snapshot?.state === "ended" && snapshot.reason === "disputed"
}

/**
 * Brings the records in line with a snapshot change. Called by the ops provisioner for every transition of an account
 * that has, or had, ops caps; idempotent, so a retried outbox item changes nothing twice.
 */
export async function trackOpsAccount(t: Pick<Transition, "account" | "from" | "to">, fetcher: typeof fetch = fetch) {
  const { account, from, to } = t
  const plan = rosterPlan(to)
  for (const other of OPS_PLANS)
    if (other === plan)
      // NX keeps the first date on this plan, so the guard knows how long the account has run at its rate.
      await persistentStore(["ZADD", opsRosterKey(other), "NX", to.updatedAt, account], fetcher)
    else await persistentStore(["ZREM", opsRosterKey(other), account], fetcher)
  if (to.caps.ops || from?.caps.ops) await persistentStore(["ZADD", opsAccountsKey(), to.updatedAt, account], fetcher)
  if (lostDispute(to))
    // The loss is the first ended/disputed snapshot; a later rewrite of the same state keeps the first date.
    await persistentStore(["ZADD", opsEraseDueKey(), "NX", to.updatedAt + OPS_LOST_DISPUTE_ERASE_MS, account], fetcher)
  else if (to.state !== "ended" || to.reason !== "closing")
    // Anything but a lost dispute (a won appeal, the owner clearing the block, a new plan) takes the date away.
    await persistentStore(["ZREM", opsEraseDueKey(), account], fetcher)
}

/** Forgets the account in every record, in both Stripe modes (its ops data was erased). */
export async function forgetOpsAccount(account: string, fetcher: typeof fetch = fetch) {
  for (const mode of ["live", "test"] as const) {
    for (const plan of OPS_PLANS) await persistentStore(["ZREM", opsRosterKey(plan, mode), account], fetcher)
    await persistentStore(["ZREM", opsAccountsKey(mode), account], fetcher)
    await persistentStore(["ZREM", opsEraseDueKey(mode), account], fetcher)
  }
}

export type RosterEntry = { account: string; plan: PlanId; since: number }

function pairs(raw: unknown) {
  if (!Array.isArray(raw)) unavailable()
  const out: [string, number][] = []
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const score = Number(raw[index + 1])
    if (Number.isFinite(score)) out.push([String(raw[index]), score])
  }
  return out
}

/** How many accounts each ops plan has now (the guard's budget). */
export async function rosterCounts(fetcher: typeof fetch = fetch) {
  const counts = {} as Record<PlanId, number>
  for (const plan of OPS_PLANS) {
    const count = Number(await persistentStore(["ZCARD", opsRosterKey(plan)], fetcher))
    if (!Number.isSafeInteger(count) || count < 0) unavailable()
    counts[plan] = count
  }
  return counts
}

/** Every account the Worker has work for now, with its plan and since when, oldest first. */
export async function readOpsRoster(fetcher: typeof fetch = fetch): Promise<RosterEntry[]> {
  const entries: RosterEntry[] = []
  for (const plan of OPS_PLANS) {
    const raw = await persistentStore(["ZRANGEBYSCORE", opsRosterKey(plan), "-inf", "+inf", "WITHSCORES"], fetcher)
    for (const [account, since] of pairs(raw)) entries.push({ account, plan, since })
  }
  return entries.sort((left, right) => left.since - right.since)
}

/** Accounts the cleanup looks at, oldest change first, at most `limit`, starting after `offset`. */
export async function readOpsAccounts(offset: number, limit: number, fetcher: typeof fetch = fetch) {
  const raw = await persistentStore(
    ["ZRANGEBYSCORE", opsAccountsKey(), "-inf", "+inf", "LIMIT", String(offset), String(limit)],
    fetcher,
  )
  if (!Array.isArray(raw)) unavailable()
  return raw.map(String)
}

/** Accounts whose erasure after a lost dispute is due by `now`. */
export async function readEraseDue(now: number, limit: number, fetcher: typeof fetch = fetch) {
  const raw = await persistentStore(
    ["ZRANGEBYSCORE", opsEraseDueKey(), "-inf", String(now), "LIMIT", "0", String(limit)],
    fetcher,
  )
  if (!Array.isArray(raw)) unavailable()
  return raw.map(String)
}
