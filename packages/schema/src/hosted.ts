export * as Hosted from "./hosted.js"

/*
 * The cloud computer's shared vocabulary (contract WP A51): what the API (api/_lib/hosted-*.ts), the desktop and the
 * phone (WP A56) say about a computer Vector hosts. Browser-safe: no Node imports, and never a rate, a price or an
 * amount. What an hour costs stays in api/_lib/hosted-rates.ts, which only the API imports (P1).
 *
 * Copy about the cloud computer always says Vector hosts it and never mentions GitHub or Actions (H4).
 */

/** The computer sizes a plan may include (`Entitlements.hosted.sizes`). */
export const SIZES = ["standard", "large"] as const
export type Size = (typeof SIZES)[number]

export function isSize(value: unknown): value is Size {
  return SIZES.some((size) => size === value)
}

/**
 * How many of the plan's cloud computer hours one hour on each size uses: the large size counts double (§1.1). The
 * plan's hours are counted in these weighted minutes.
 */
export const SIZE_WEIGHT: Readonly<Record<Size, number>> = Object.freeze({ standard: 1, large: 2 })

/**
 * What an account's plan state lets its cloud computers do (contract §4.4, the cloud computer row):
 * - `start`     active: new sessions start within the plan's caps (with the trust ramp);
 * - `continue`  renewing: running sessions continue, no new ones;
 * - `wrap`      paused: running sessions wrap up, snapshot and stop within `WRAP_MS`; the queue waits;
 * - `stop`      ended or frozen, or no plan: nothing runs.
 */
export const ACCESS = ["start", "continue", "wrap", "stop"] as const
export type Access = (typeof ACCESS)[number]

/** A paused account's running sessions stop within this long (§4.4). */
export const WRAP_MS = 5 * 60_000

/**
 * What happens to a computer's disk when nothing may run (§4.4): kept for the plan's `diskDays` while a plan is live;
 * kept `ENDED_DISK_DAYS` for download after a plan ends (with a notice), then deleted; kept while a dispute is open and
 * deleted `LOST_DISPUTE_DISK_DAYS` after it is lost.
 */
export const ENDED_DISK_DAYS = 14
export const LOST_DISPUTE_DISK_DAYS = 30

/** The service's error codes (contract §4.10). Every message is plain copy with no amount. */
export const ERROR_CODES = {
  HOSTED_NOT_INCLUDED: 403,
  HOSTED_BUSY: 429,
  HOSTED_HOURS_USED: 402,
  HOSTED_PAUSED: 402,
  HOSTED_FROZEN: 403,
  HOSTED_UNAVAILABLE: 503,
  HOSTED_SESSION_PAUSED: 409,
} as const
export type ErrorCode = keyof typeof ERROR_CODES

/**
 * The share of the month's cloud computer hours used, as a whole percent between 0 and 1 (status `meters.hosted.used`,
 * H5): weighted minutes used over the plan's hours. A plan with no hours reads as used up.
 */
export function hoursUsedShare(usedMinutes: number, hours: number) {
  if (!(hours > 0)) return 1
  const used = Number.isFinite(usedMinutes) ? Math.max(0, usedMinutes) : 0
  return Math.min(100, Math.round((used / (hours * 60)) * 100)) / 100
}
