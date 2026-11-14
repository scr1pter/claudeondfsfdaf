import type { EntitlementSnapshot, Entitlements } from "../../packages/schema/src/codium-entitlements.js"
import { ENTITLEMENTS } from "../../packages/schema/src/codium-entitlements.js"
import { PLANS, type PlanId } from "../../packages/schema/src/codium-plan.js"
import { Hosted } from "../../packages/schema/src/hosted.js"
import { codiumKey } from "./codium-keys.js"
import { renewalGraceMinutes } from "./codium-limits.js"
import { listedPerks } from "./codium-perks.js"
import { effectiveCaps, METER_KEEP_MS, requireUsableSnapshot } from "./codium-snapshot.js"
import { readSwitch } from "./codium-switches.js"
import { ApiError } from "./http.js"
import { readEntitlement } from "./model-plan-account.js"
import { persistentStore } from "./persistent-store.js"
import { hostedRatesProblems } from "./hosted-rates.js"

/*
 * What an account's plan lets its cloud computers do (contract WP A51, §4.4's cloud computer row), read from the
 * entitlement snapshot alone: no Stripe call on a hot path (M4), and nothing a client says grants anything (S1).
 *
 * Hours are counted in weighted minutes per period (`hosted:minutes:<account>:<meterEpoch>`, §4.6): a minute on the
 * large size counts two. Every new period starts at 0, an upgrade's included (Appendix A item 1), and the plan's
 * hours there apply in full (with the trust ramp, §4.2). Running blocks reserve their minutes in the same hash when they
 * open (hosted-ledger.ts), so parallel computers can never pass the hours together; a settled block's minutes count in
 * the period active when it settled.
 */

export type HostedCaps = NonNullable<Entitlements["hosted"]>

/**
 * The account's cloud computer caps at `now`, with the trust ramp as of `now` (§4.2: a quarter of the hours, one
 * computer, jobs of two hours at most until `ramp.hostedUntil`). Recomputed from the plan so a ramp that ended after the
 * snapshot was written no longer applies. Null when the plan has no cloud computer.
 */
export function hostedCaps(snapshot: EntitlementSnapshot, now = Date.now()): HostedCaps | null {
  if (!snapshot.plan || !snapshot.caps.hosted) return null
  return effectiveCaps(snapshot.plan, snapshot.ramp, now).hosted
}

/** Whether the computer may use its browser yet: from 24 hours after the first Max or Ultra payment (§4.2). */
export function hostedBrowserAllowed(snapshot: EntitlementSnapshot, now = Date.now()) {
  return now >= snapshot.ramp.browserFrom
}

/**
 * §4.4's cloud computer row for the snapshot's state, narrowed by the owner's `hosted` switch (`no-new` lets running
 * sessions continue; `stop` stops them too): `start` while the plan is active (and its period has not ended), `continue`
 * while it renews within the grace, `wrap` while a payment is owed (or a renewal ran past its grace), `stop` otherwise.
 */
export function hostedAccess(
  snapshot: EntitlementSnapshot | undefined,
  service: "on" | "no-new" | "stop" = "on",
  now = Date.now(),
): Hosted.Access {
  const plan = planAccess(snapshot, now)
  if (service === "stop") return "stop"
  if (service === "no-new" && plan === "start") return "continue"
  return plan
}

function planAccess(snapshot: EntitlementSnapshot | undefined, now: number): Hosted.Access {
  if (!snapshot || !snapshot.plan || !snapshot.caps.hosted) return "stop"
  switch (snapshot.state) {
    case "active":
      // Past its end, an active snapshot waits for reconcile to say what comes next: nothing new starts meanwhile.
      return now < snapshot.periodEnd ? "start" : "continue"
    case "renewing":
      return now < snapshot.periodEnd + renewalGraceMinutes() * 60_000 ? "continue" : "wrap"
    case "paused":
      return "wrap"
    default:
      return "stop"
  }
}

/**
 * How long a computer's disk is kept when nothing runs on it (§4.4): the plan's `diskDays` while a plan is live (Vector
 * pays nothing extra for it beyond the nightly storage charge); `Hosted.ENDED_DISK_DAYS` for download after a plan
 * ends, paid from the final period (`chargeRetention` in hosted-ledger.ts, which shortens it when that period cannot
 * cover it); until the dispute closes while frozen; `Hosted.LOST_DISPUTE_DISK_DAYS` after a lost dispute, at Vector's
 * cost, since that payment was reversed. `undefined` days means kept with no deletion date.
 */
export function hostedDiskPolicy(snapshot: EntitlementSnapshot | undefined, now = Date.now()) {
  if (!snapshot || snapshot.state === "none") return { keep: "none" as const, days: 0 }
  if (snapshot.state === "frozen") return { keep: "dispute" as const, days: undefined }
  if (snapshot.state === "ended") {
    if (snapshot.reason === "closing") return { keep: "none" as const, days: 0 }
    if (snapshot.reason === "disputed") return { keep: "lost-dispute" as const, days: Hosted.LOST_DISPUTE_DISK_DAYS }
    return { keep: "ended" as const, days: Hosted.ENDED_DISK_DAYS }
  }
  return { keep: "plan" as const, days: hostedCaps(snapshot, now)?.diskDays ?? 0 }
}

// ── The owner's gates ──────────────────────────────────────────────────────────────────────────────────────────────

const ACCOUNT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The accounts that may start a cloud computer before `computer` is listed (`VECTOR_HOSTED_ALLOW_ACCOUNTS`, account ids,
 * comma separated; contract §2 and §8.2 step 18). They still need a plan with a cloud computer and the switch on.
 */
export function hostedAllowedAccounts(env: Record<string, string | undefined> = process.env) {
  return new Set(
    (env.VECTOR_HOSTED_ALLOW_ACCOUNTS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => ACCOUNT.test(value)),
  )
}

/** Whether new cloud computer work may start for `account`: `computer` listed, or the account on the owner's list. */
export async function hostedOpen(account: string, fetcher: typeof fetch = fetch) {
  if (hostedAllowedAccounts().has(account.toLowerCase())) return true
  return (await listedPerks(fetcher)).has("computer")
}

// ── Hours ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The period's weighted-minute hash: `used`, `r:<block ref>` (reserved minutes and when they lapse), `d:<ref>`. */
export const hostedMinutesKey = (account: string, meterEpoch: string) =>
  codiumKey("hosted", "minutes", account, meterEpoch)

/**
 * MINUTES. The period's weighted minutes: settled (`used`) and still reserved by running blocks, after dropping
 * reservations that lapsed (ARGV[1] is now). Read only by status and the start check; blocks reserve inside OPEN.
 */
const MINUTES = `local used = tonumber(redis.call('HGET', KEYS[1], 'used') or '0') local reserved = 0 local fields = redis.call('HGETALL', KEYS[1]) for i = 1, #fields, 2 do if string.sub(fields[i], 1, 2) == 'r:' then local minutes, lapses = string.match(fields[i + 1], '^(%d+):(%d+)$') if not minutes then return {-1, -1} end if tonumber(lapses) <= tonumber(ARGV[1]) then redis.call('HDEL', KEYS[1], fields[i]) else reserved = reserved + tonumber(minutes) end end end if not used then return {-1, -1} end return {used, reserved}`

export const HOSTED_ENTITLEMENT_SCRIPTS = Object.freeze({ MINUTES })

/** The period's weighted minutes used and reserved, or a 503 when the store cannot say. */
export async function readHostedMinutes(
  snapshot: Pick<EntitlementSnapshot, "account" | "meterEpoch">,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  if (snapshot.meterEpoch === "none") return { used: 0, reserved: 0 }
  const result = await persistentStore(
    ["EVAL", MINUTES, 1, hostedMinutesKey(snapshot.account, snapshot.meterEpoch), now],
    fetcher,
  )
  const [used, reserved] = Array.isArray(result) ? result.map(Number) : []
  if (!Number.isSafeInteger(used) || !Number.isSafeInteger(reserved) || used! < 0 || reserved! < 0) throw unavailable()
  return { used: used!, reserved: reserved! }
}

/** The plan's hours this period in weighted minutes, the trust ramp applied. */
export function hostedMinutesCap(snapshot: EntitlementSnapshot, now = Date.now()) {
  return Math.floor((hostedCaps(snapshot, now)?.hours ?? 0) * 60)
}

/**
 * The share of this period's cloud computer hours used (§WP A51 `hoursUsedShare`; status `meters.hosted.used`): settled
 * weighted minutes over the plan's hours, a whole percent between 0 and 1. Running blocks are not counted until they
 * settle, as a running model request does not move the month's share.
 */
export async function hoursUsedShare(snapshot: EntitlementSnapshot, fetcher: typeof fetch = fetch, now = Date.now()) {
  const hours = hostedCaps(snapshot, now)?.hours ?? 0
  const { used } = await readHostedMinutes(snapshot, fetcher, now)
  return Hosted.hoursUsedShare(used, hours)
}

/** Keeps a period's minutes as long as its other meters (§4.3: 40 days past its end). */
export function hostedMinutesExpireAt(periodEnd: number) {
  return periodEnd + METER_KEEP_MS
}

// ── Starting work ──────────────────────────────────────────────────────────────────────────────────────────────────

export type HostedStart = {
  snapshot: EntitlementSnapshot
  caps: HostedCaps
  size: Hosted.Size
  jobMinutes: number
  /** Whether the computer may use its browser (§4.2's day after the first Max or Ultra payment). */
  browser: boolean
  /** Weighted minutes still free this period, after settled and reserved minutes. */
  minutesLeft: number
}

/**
 * Whether `account` may start a cloud computer session now, and the plan it starts on (WP A53 calls this before it
 * holds the first block; every block then re-checks the plan as it opens). Refusals:
 * - 503 `HOSTED_UNAVAILABLE` while the `hosted` switch is not `on`, a rate setting is invalid, or `computer` is neither
 *   listed nor the account on `VECTOR_HOSTED_ALLOW_ACCOUNTS`;
 * - the plan's own answers from the snapshot, with the service's codes where it has one: 402 `MODEL_PLAN_REQUIRED`,
 *   402 `HOSTED_PAUSED {reason, action}`, 403 `HOSTED_FROZEN {reason}`, 403 `HOSTED_NOT_INCLUDED {perk, plan}` (Plus
 *   and Pro), 409 `MODEL_PLAN_ACCOUNT_CLOSING`, 503 `MODEL_PLAN_RENEWING` (no new session while a renewal is collected);
 * - 403 `HOSTED_NOT_INCLUDED {limit: "size" | "job-length"}` for a size or job length the plan does not include now;
 * - 402 `HOSTED_HOURS_USED` once this period's hours are used or reserved.
 * Computers at once are counted when the first block opens (hosted-ledger.ts), atomically with its reservation.
 */
export async function requireHostedStart(
  account: string,
  input: { size: unknown; jobMinutes: unknown },
  options: { fetcher?: typeof fetch; now?: number; clock?: () => number } = {},
): Promise<HostedStart> {
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? options.clock?.() ?? Date.now()
  if (hostedRatesProblems().length || (await readSwitch("hosted", fetcher, { now })) !== "on") throw unavailable()
  if (!(await hostedOpen(account, fetcher)))
    throw new ApiError(503, "HOSTED_UNAVAILABLE", "The cloud computer is not available on Vector yet.")
  const snapshot = await hostedSnapshot(account, fetcher, now)
  const caps = hostedCaps(snapshot, now)!
  if (hostedAccess(snapshot, "on", now) !== "start")
    throw new ApiError(503, "MODEL_PLAN_RENEWING", "Your Vector Codium plan is renewing. Try again in a moment.", {
      retryAfterSeconds: 30,
    })
  if (!Hosted.isSize(input.size) || !caps.sizes.includes(input.size))
    throw notIncluded("This computer size is not included in your plan.", {
      limit: "size",
      ...planWith((hosted) => Hosted.isSize(input.size) && hosted.sizes.includes(input.size)),
    })
  const jobMinutes = input.jobMinutes
  if (typeof jobMinutes !== "number" || !Number.isSafeInteger(jobMinutes) || jobMinutes < 1)
    throw new ApiError(400, "HOSTED_REQUEST", "Say how many minutes this job may run.")
  if (jobMinutes > caps.jobMin)
    throw notIncluded("This job is longer than your plan allows right now.", {
      limit: "job-length",
      ...planWith((hosted) => hosted.jobMin >= jobMinutes),
    })
  const { used, reserved } = await readHostedMinutes(snapshot, fetcher, now)
  const minutesLeft = Math.max(0, hostedMinutesCap(snapshot, now) - used - reserved)
  if (minutesLeft < Hosted.SIZE_WEIGHT[input.size]) throw hoursUsed()
  return {
    snapshot,
    caps,
    size: input.size,
    jobMinutes,
    browser: hostedBrowserAllowed(snapshot, now),
    minutesLeft,
  }
}

/**
 * The snapshot when its plan includes a cloud computer, or the plan's refusal in the service's codes (§4.10): the
 * snapshot's own answers from `requireUsableSnapshot`, with paused, frozen and not included mapped to HOSTED_*.
 */
export async function hostedSnapshot(account: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  let snapshot: EntitlementSnapshot
  try {
    snapshot = requireUsableSnapshot(await readEntitlement(account, fetcher, now), now)
  } catch (error) {
    throw hostedRefusal(error)
  }
  if (!hostedCaps(snapshot, now))
    throw notIncluded("Your Vector Codium plan does not include a cloud computer.", {
      perk: "computer",
      ...planWith(() => true),
    })
  return snapshot
}

/** A plan refusal in the cloud computer's own codes, where §4.10 gives it one; anything else unchanged. */
export function hostedRefusal(error: unknown) {
  if (!(error instanceof ApiError)) return error
  if (error.code === "MODEL_PLAN_PAYMENT_REQUIRED")
    return new ApiError(402, "HOSTED_PAUSED", "The cloud computer is paused until your payment goes through.", {
      ...(error.detail ? { detail: error.detail } : {}),
    })
  if (error.code === "MODEL_PLAN_BLOCKED")
    return new ApiError(403, "HOSTED_FROZEN", "The cloud computer is on hold for this account.", {
      ...(error.detail ? { detail: error.detail } : {}),
    })
  return error
}

/** The cheapest plan whose cloud computer satisfies `fits`, for an upgrade hint. */
function planWith(fits: (hosted: HostedCaps) => boolean): { plan?: PlanId } {
  const plan = PLANS.find((candidate) => {
    const hosted = ENTITLEMENTS[candidate.id].hosted
    return hosted !== null && fits(hosted)
  })
  return plan ? { plan: plan.id } : {}
}

function notIncluded(message: string, detail: Record<string, unknown>) {
  return new ApiError(403, "HOSTED_NOT_INCLUDED", message, { detail: { perk: "computer", ...detail } })
}

export function hoursUsed() {
  return new ApiError(
    402,
    "HOSTED_HOURS_USED",
    "This month's cloud computer hours are used. They renew with your plan.",
  )
}

export function unavailable() {
  return new ApiError(503, "HOSTED_UNAVAILABLE", "The cloud computer is temporarily unavailable. Try again shortly.")
}
