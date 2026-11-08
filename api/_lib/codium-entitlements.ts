import {
  ENTITLEMENTS,
  type EntitlementSnapshot,
  type Entitlements,
} from "../../packages/schema/src/codium-entitlements.js"
import { PLANS, type PlanId } from "../../packages/schema/src/codium-plan.js"
import {
  isStale,
  METER_KEEP_MS,
  meterKey,
  onEntitlementChange,
  requireUsableSnapshot,
  runMeterAdd,
} from "./codium-snapshot.js"
import { readSwitch } from "./codium-switches.js"
import { ApiError } from "./http.js"
import { readEntitlement, reconcileOnDemand } from "./model-plan-account.js"

/*
 * The plan cache, as every Codium service reads it (contract §4.3). A service asks `requireEntitlement` (or
 * `readEntitlement`) and acts on the snapshot reconcile wrote; nothing here calls Stripe except `reconcileOnDemand`,
 * which runs at most once a minute per account, so a hot path with a fresh snapshot makes no Stripe call at all (M4).
 * The snapshot itself is written only by reconcile (`reconcileModelPlanAccount`), through codium-snapshot.ts.
 */

export type { EntitlementChange, EntitlementListener, OutboxItem, TransitionCause } from "./codium-snapshot.js"
// `readEntitlement` (the read rules) lives beside `reconcileOnDemand` in model-plan-account.ts, so the pool's own holds
// read the snapshot by the same rules without an import cycle.
export { isStale, meterKey, onEntitlementChange, readEntitlement, reconcileOnDemand, requireUsableSnapshot }

/**
 * The account's snapshot when it may use `perk` now ("codium" for model access alone), or the refusal:
 * - 402 `MODEL_PLAN_REQUIRED` without a plan, or once it ended (409 `MODEL_PLAN_ACCOUNT_CLOSING` while the account is
 *   being deleted);
 * - 402 `MODEL_PLAN_PAYMENT_REQUIRED {reason, action}` while a payment is owed;
 * - 403 `MODEL_PLAN_BLOCKED {reason}` while a dispute, a fraud warning or the owner holds it;
 * - 503 `MODEL_PLAN_RENEWING` (retry after 30 s) once a renewal's grace ran out before reconcile caught up;
 * - 403 `CODIUM_PERK_REQUIRED {perk, plan}` when the plan does not include the perk, naming the cheapest plan that does.
 * During `renewing` the previous period's caps still apply. Services apply their own row of §4.4 on top.
 */
export async function requireEntitlement(
  account: string,
  perk: keyof Entitlements | "codium",
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<EntitlementSnapshot> {
  if (perk === "codium" && (await readSwitch("codium", fetcher, { now })) !== "on")
    throw new ApiError(503, "MODEL_PLANS_DISABLED", "Vector Codium is temporarily unavailable.")
  const snapshot = requireUsableSnapshot(await readEntitlement(account, fetcher, now), now)
  if (perk !== "codium" && !includes(snapshot.caps, perk)) {
    const plan = cheapestPlanWith(perk)
    throw new ApiError(403, "CODIUM_PERK_REQUIRED", "Your Vector Codium plan does not include this.", {
      detail: { perk, ...(plan ? { plan } : {}) },
    })
  }
  return snapshot
}

/**
 * Whether caps include a perk: a flag that is true, a count above 0, or an object of a service the plan has. Vector
 * Velocity and Vector Labs are "Coming": nothing to use yet, on any plan. Model caps (rank, the daily limit and the
 * like) are not perks and always count as included.
 */
export function includes(caps: Entitlements, perk: keyof Entitlements) {
  switch (perk) {
    case "velocity":
    case "labs":
      return false
    case "rank":
    case "usageMultiple":
    case "inFlight":
    case "perMinute":
    case "dailyShare":
    case "contextMax":
      return true
    case "purposeShare":
      return caps.purposeShare.brain > 0
    case "cloudAgents":
      return caps.cloudAgents.atOnce > 0 && caps.cloudAgents.hours > 0
    case "remote":
      return caps.remote.computers > 0
    case "vault":
      return caps.vault.gb > 0
    case "reports":
      return caps.reports.perHour > 0
  }
  const value: unknown = caps[perk]
  if (typeof value === "number") return value > 0
  return value !== null && value !== undefined && value !== false
}

/** The cheapest plan whose caps include `perk`, or undefined when none does. */
export function cheapestPlanWith(perk: keyof Entitlements): PlanId | undefined {
  return PLANS.find((plan) => includes(ENTITLEMENTS[plan.id], perk))?.id
}

/**
 * Adds `amount` to one of the period's meters only while the total stays within `cap`, in one step, so parallel
 * requests can never pass a cap together. Meters are whole units (runs, cards, seconds, bytes), keyed by the
 * snapshot's `meterEpoch` so every new period, an upgrade's included, starts at 0, and kept until 40 days after the
 * period ends. `amount` 0 reads the meter. An account without a subscription has no meter: never ok.
 */
export async function meterAdd(
  snapshot: EntitlementSnapshot,
  name: string,
  amount: number,
  cap: number,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: boolean; used: number }> {
  if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(cap) || cap < 0 || !name)
    throw new ApiError(500, "CODIUM_METER_INVALID", "This Vector Codium limit could not be checked.")
  if (!snapshot.subscription || snapshot.meterEpoch === "none") return { ok: false, used: 0 }
  const result = await runMeterAdd(meterKey(snapshot, name), amount, cap, snapshot.periodEnd + METER_KEEP_MS, fetcher)
  if (!result) throw new ApiError(503, "CODIUM_METER_UNAVAILABLE", "This Vector Codium limit could not be checked.")
  return result
}
