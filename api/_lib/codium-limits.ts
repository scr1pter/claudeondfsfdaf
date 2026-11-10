import type { PlanId } from "../../packages/schema/src/codium-plan.js"
import { ApiError } from "./http.js"
import { stripeMode, type StripeMode } from "./model-plan-stripe.js"

/*
 * Limits that stay on the server (contract §4.2). Unlike `ENTITLEMENTS`, these are never shipped to a client or shown
 * on a page: they bound abuse and fraud, and some would hint at the size of a plan's pool. The env overrides named
 * here are validated, and an invalid value turns Codium off (`codiumLimitProblems()` feeds `codiumBillingConfig()`).
 */

/**
 * For the first days after `firstHighPaidAt` (the first paid invoice of a rank 3 or higher price), cloud computers run
 * at a quarter of the plan's hours, one at a time, with jobs of two hours at most, and browser use starts a day after
 * that payment. More than 14 days without a paid period restarts the ramp.
 */
export const TRUST_RAMP = {
  defaultDays: 7,
  maxDays: 30,
  hostedHoursFactor: 0.25,
  computers: 1,
  jobMinutes: 120,
  browserAfterMs: 24 * 60 * 60_000,
  restartGapDays: 14,
} as const

/**
 * When that first rank 3 or higher payment was not authenticated with 3-D Secure, the key's limit is this share of the
 * credits for the first hours (an outbox job raises it), and Ultra's daily share for that first period is lower.
 */
export const POOL_RAMP = { creditsShare: 0.3, hours: 72, ultraDailyShare: 0.4 } as const

export const REMOTE_LIMITS = {
  phones: 5,
  viewerHours: { "vector-10": 60, "vector-50": 100, "vector-100": 200, "vector-200": 200 } satisfies Record<
    PlanId,
    number
  >,
  // Awake-hours per account are at most this multiple of viewer-hours.
  awakeFactor: 1.5,
  viewerIdleMinutes: 30,
  frameBytes: 64 * 1024,
  framesPerSecond: 20,
} as const

export const HOSTED_ABUSE = {
  pageLoadsPerHour: 600,
  // Egress to anything except Vector's run-API host, per day. Plans without a cloud computer have none.
  egressGbPerDay: { "vector-100": 5, "vector-200": 15 } satisfies Partial<Record<PlanId, number>>,
  busyCpu: { minutes: 30, percent: 80 },
  takeoverMinutes: 30,
} as const

/** During `renewing`, the previous key serves until `periodEnd` plus this grace. */
export const RENEWAL_GRACE = { defaultMinutes: 120, maxMinutes: 360 } as const

/**
 * In Stripe test mode every OpenRouter key Codium creates is capped at this many dollars, whatever the plan's credits:
 * a test checkout still spends Vector's real OpenRouter balance. The owner may raise it to try a larger model.
 */
export const TEST_CREDIT_CAP = { defaultUsd: 0.5, maxUsd: 200 } as const

export function trustRampDays() {
  return integerSetting("CODIUM_TRUST_RAMP_DAYS", TRUST_RAMP.defaultDays, 0, TRUST_RAMP.maxDays)
}

export function renewalGraceMinutes() {
  return integerSetting("CODIUM_RENEWAL_GRACE_MINUTES", RENEWAL_GRACE.defaultMinutes, 0, RENEWAL_GRACE.maxMinutes)
}

export function testCreditCapUsd() {
  const configured = process.env.CODIUM_TEST_CREDIT_CAP_USD?.trim()
  if (!configured) return TEST_CREDIT_CAP.defaultUsd
  const value = Number(configured)
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    value > TEST_CREDIT_CAP.maxUsd ||
    Math.abs(Math.round(value * 100) - value * 100) > 1e-6
  )
    throw limitError()
  return value
}

/**
 * The limit an OpenRouter key gets for `credits` of plan allowance: the credits themselves in live mode, and no more
 * than the test cap in test mode.
 */
export function codiumKeyLimitUsd(credits: number, mode: StripeMode = stripeMode()) {
  return mode === "test" ? Math.min(credits, testCreditCapUsd()) : credits
}

/** Each invalid override, by env name, for `codiumBillingConfig()` and the owner page. */
export function codiumLimitProblems(mode: StripeMode = stripeMode()) {
  const checks: [string, () => unknown][] = [
    ["CODIUM_TRUST_RAMP_DAYS", trustRampDays],
    ["CODIUM_RENEWAL_GRACE_MINUTES", renewalGraceMinutes],
    ...(mode === "test" ? ([["CODIUM_TEST_CREDIT_CAP_USD", testCreditCapUsd]] as [string, () => unknown][]) : []),
  ]
  return checks.flatMap(([name, read]) => {
    try {
      read()
      return []
    } catch {
      return [`${name} is out of range`]
    }
  })
}

function integerSetting(name: string, fallback: number, min: number, max: number) {
  const configured = process.env[name]?.trim()
  if (!configured) return fallback
  const value = Number(configured)
  if (!Number.isSafeInteger(value) || value < min || value > max) throw limitError()
  return value
}

function limitError() {
  return new ApiError(503, "MODEL_PLANS_CONFIGURATION", "Vector Codium is temporarily unavailable.")
}
