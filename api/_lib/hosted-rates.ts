import type { Hosted } from "../../packages/schema/src/hosted.js"

/*
 * What a cloud computer costs Vector, and what its time is charged into the subscriber's pool (contract WP A51, M8).
 * Imported only by `api/`: these figures would let a client work out the size of a plan's pool, so no client package,
 * page or answer ever carries them (P1). Every amount is in integer micro-dollars (1 USD = 1,000,000).
 *
 * Rates are pinned to Vercel Sandbox in region iad1 (https://vercel.com/docs/vercel-sandbox/pricing, read 2026-09-10,
 * as docs/vector/build/cloud-envs-plan.md records): Active CPU $0.128 per vCPU-hour, provisioned memory $0.0212 per
 * GB-hour, snapshot storage $0.08 per GB-month. The worst case bills the CPU as busy for every minute the computer runs
 * (Vercel bills CPU only while it is busy), so a standard computer (2 vCPU, 4 GB) costs at most $0.3408 an hour and a
 * large one (4 vCPU, 8 GB) $0.6816. Each minute is charged at that worst case plus 10%, rounded up to a cent an hour:
 * $0.375 and $0.75. A price change at Vercel means changing this file before the next block is held.
 */

export const HOSTED_REGION = "iad1"
export const HOSTED_RATES_SOURCE = "https://vercel.com/docs/vercel-sandbox/pricing (read 2026-09-10)"

/** Active CPU, per vCPU-hour, and provisioned memory, per GB-hour (iad1). */
export const VCPU_HOUR_MICRO = 128_000
export const MEMORY_GB_HOUR_MICRO = 21_200
/** Snapshot storage, per GB-month. */
export const SNAPSHOT_GB_MONTH_MICRO = 80_000
/** The markup on every worst-case cost: what the pool is charged is at least the cost plus 10%. */
export const MARKUP_PERCENT = 10

/** What each size is: the vCPUs and memory Vector asks the provider for (WP A52 creates them). */
export const HOSTED_SIZES: Readonly<Record<Hosted.Size, { vcpus: number; memoryGb: number }>> = Object.freeze({
  standard: { vcpus: 2, memoryGb: 4 },
  large: { vcpus: 4, memoryGb: 8 },
})

/** The provider's worst-case cost of one hour on `size`: every vCPU busy the whole hour, plus its memory. */
export function worstCaseHourMicro(size: Hosted.Size) {
  const { vcpus, memoryGb } = HOSTED_SIZES[size]
  return vcpus * VCPU_HOUR_MICRO + memoryGb * MEMORY_GB_HOUR_MICRO
}

/** What one hour on each size is charged into the pool (§WP A51: $0.375 and $0.75), and its worst-case cost. */
export const HOSTED_RATES: Readonly<Record<Hosted.Size, { costHourMicro: number; chargeHourMicro: number }>> =
  Object.freeze({
    standard: { costHourMicro: worstCaseHourMicro("standard"), chargeHourMicro: 375_000 },
    large: { costHourMicro: worstCaseHourMicro("large"), chargeHourMicro: 750_000 },
  })

/** A running computer's time is held and settled in blocks of this many minutes. */
export const BLOCK_MINUTES = 15
/**
 * Each block holds this many minutes ahead: its own 15, plus the 5 a session may still run to wrap up and snapshot if
 * the next block cannot be held (§4.4's 5 minutes). So the hold always covers everything the computer can still run.
 */
export const HOLD_MINUTES = 20
/** A block's hold lapses this long after it was placed, which leaves its settlement 10 minutes past the hold. */
export const BLOCK_HOLD_TTL_MS = 30 * 60_000

/** The pool charge per minute on `size`, never rounded down. */
export function chargeMinuteMicro(size: Hosted.Size) {
  return Math.ceil(HOSTED_RATES[size].chargeHourMicro / 60)
}

/** The provider's worst-case cost per minute on `size`, never rounded down. */
export function costMinuteMicro(size: Hosted.Size) {
  return Math.ceil(HOSTED_RATES[size].costHourMicro / 60)
}

/** What a block holds on `size`: `HOLD_MINUTES` at the charged rate. */
export function blockHoldMicro(size: Hosted.Size) {
  return HOLD_MINUTES * chargeMinuteMicro(size)
}

/** Whole minutes for a stretch of time, rounded up: any part of a minute is charged as a minute. */
export function wholeMinutes(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.ceil(ms / 60_000)
}

/** The charge for `minutes` whole minutes on `size`, and their worst-case cost. */
export function minutesCharge(size: Hosted.Size, minutes: number) {
  if (!Number.isSafeInteger(minutes) || minutes < 0) throw new RangeError("Minutes must be a whole number.")
  return { chargedMicro: minutes * chargeMinuteMicro(size), costMicro: minutes * costMinuteMicro(size) }
}

/** Cost plus the markup, never rounded down. */
export function withMarkup(costMicro: number) {
  return Math.ceil((costMicro * (100 + MARKUP_PERCENT)) / 100)
}

/**
 * Snapshot storage per GB-day. A month is taken as 28 days, its shortest, so a day is never charged below what any
 * month's share of the GB-month costs.
 */
export const SNAPSHOT_GB_DAY_COST_MICRO = Math.ceil(SNAPSHOT_GB_MONTH_MICRO / 28)

/** The charge and cost for `gbDays` of snapshot storage (GB times days, from the provider's snapshot sizes). */
export function storageCharge(gbDays: number) {
  if (!Number.isFinite(gbDays) || gbDays < 0) throw new RangeError("Storage must be a non-negative number of GB-days.")
  const costMicro = Math.ceil(gbDays * SNAPSHOT_GB_DAY_COST_MICRO)
  return { chargedMicro: withMarkup(costMicro), costMicro }
}

/**
 * The provider's cost of one GB of egress, from `VECTOR_HOSTED_EGRESS_MICRO_USD_PER_GB` (integer micro-dollars), until
 * Vercel confirms what egress from a sandbox costs (owner step 14). Unset, it is $0.15 per GB, the highest data
 * transfer rate Vercel publishes for iad1, so egress is never charged below what it could cost. An invalid value is a
 * configuration problem and stops new cloud computer work (`hostedRatesProblems`).
 */
export const DEFAULT_EGRESS_GB_COST_MICRO = 150_000
const MAX_EGRESS_GB_COST_MICRO = 10_000_000

export function egressGbCostMicro(env: Record<string, string | undefined> = process.env) {
  const configured = env.VECTOR_HOSTED_EGRESS_MICRO_USD_PER_GB?.trim()
  if (!configured) return DEFAULT_EGRESS_GB_COST_MICRO
  const value = Number(configured)
  if (!/^\d+$/.test(configured) || !Number.isSafeInteger(value) || value > MAX_EGRESS_GB_COST_MICRO)
    throw new RangeError("VECTOR_HOSTED_EGRESS_MICRO_USD_PER_GB must be whole micro-dollars per GB.")
  return value
}

/** The charge and cost for `gb` of egress. */
export function egressCharge(gb: number, env: Record<string, string | undefined> = process.env) {
  if (!Number.isFinite(gb) || gb < 0) throw new RangeError("Egress must be a non-negative number of GB.")
  const costMicro = Math.ceil(gb * egressGbCostMicro(env))
  return { chargedMicro: withMarkup(costMicro), costMicro }
}

/**
 * The provider's actual cost of a stretch of compute, from what it reports: busy vCPU time is billed per vCPU, memory
 * for the whole time the computer ran. Used by the nightly true-up (WP A53), which can only lower a charge.
 */
export function computeCostMicro(input: { size: Hosted.Size; activeCpuMs: number; wallMs: number }) {
  const { memoryGb, vcpus } = HOSTED_SIZES[input.size]
  if (
    !Number.isFinite(input.activeCpuMs) ||
    !Number.isFinite(input.wallMs) ||
    input.activeCpuMs < 0 ||
    input.wallMs < 0 ||
    input.activeCpuMs > input.wallMs * vcpus
  )
    throw new RangeError("Compute usage must be non-negative, with CPU time within the computer's vCPUs.")
  return Math.ceil((input.activeCpuMs * VCPU_HOUR_MICRO + input.wallMs * memoryGb * MEMORY_GB_HOUR_MICRO) / 3_600_000)
}

/**
 * The true-up of a charge once the provider's actual cost is known (M8): it only ever lowers the charge, to the actual
 * cost plus the markup, and never below the actual cost. A charge already at or under that stays as it is.
 */
export function trueUpMicro(chargedMicro: number, actualCostMicro: number) {
  if (
    !Number.isSafeInteger(chargedMicro) ||
    chargedMicro < 0 ||
    !Number.isFinite(actualCostMicro) ||
    actualCostMicro < 0
  )
    throw new RangeError("A true-up needs a whole charge and a non-negative cost.")
  // Cost plus the markup is never below the cost, so the floor holds whenever the charge was at least the cost; a
  // charge below it (a rate that was wrong) is never raised here.
  return Math.min(chargedMicro, withMarkup(Math.ceil(actualCostMicro)))
}

/** Each invalid hosted rate setting, by env name; any one stops new cloud computer work. */
export function hostedRatesProblems(env: Record<string, string | undefined> = process.env) {
  try {
    egressGbCostMicro(env)
    return []
  } catch {
    return ["VECTOR_HOSTED_EGRESS_MICRO_USD_PER_GB is invalid"]
  }
}
