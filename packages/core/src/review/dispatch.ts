// The pre-dispatch estimate and decision (VectorScope upgrade contract §1.2 and §4 VS-24 item 4), with addendum A's
// VS-40 estimate v2 recorded beside it. Pure and browser-safe. Nothing calls it yet: VS-24 wiring builds every planned
// pass's first prompt before the specialists fan out in Review.run, estimates them here, shrinks while decideDispatch
// names a lever, and stops with "budget-estimate" and zero attempts when none is left.
//
// The gate decides on the legacy LOW estimate (estimateCostUsd's own low band) and on first-turn tokens, never on the
// high band or on v2. The high band's growth term, 4,000·S(S−1)/2, does not depend on the prompt: at the default
// maxSteps of 30 it alone is 1.74M input tokens a session and about 2.7M across review, security and verify, so a gate on
// it would fire on nearly every review at the $2 default and at the pilot's $0.75, and shrinking the prompt could not
// lower it. The high band and v2 go only into notes and artifacts. Every figure here is an estimate: admission in
// Review.run and provider-side key limits stay the real bounds (I-5, C-10). estimateCostUsd was fitted on one review
// (plan.ts) and must be recalibrated on replay data before the check leaves opt-in, and v2 takes over the gate only if
// the pilot shows its median absolute error at least 5 points lower (VS-40). VS-40a adds a tiered range beside both,
// priced at the long-context tiers a price lists, and keys v2's output per step by effort; the gate reads neither.
//
// `remainingUsd` undefined means no dollar check. In ReviewConfig a cap of 0 means "none" (maxCostUsd, maxCostUsdPerPr,
// maxCostUsdPerMonth), but a remainder of 0 or less stops every priced review, so a caller never passes a cap through
// as it is: remainingUsd() below drops the caps that are 0 before taking the smallest.

import {
  bandCostUsd,
  estimateBands,
  estimateCostUsd,
  NEXT_STEP_SLACK,
  nextStepCostUsd,
  OUTPUT_PER_STEP,
  passInputTokens,
  priceAt,
  type CacheReads,
  type EstimateBand,
  type ReviewPrice,
} from "./plan"
import type { ReviewConfig, Trigger } from "./types"

// VS-40's output tokens a step: the measured review behind plan.ts's S and R averaged 1,800, reasoning included
// [G3-15]. One case, so it is a starting point to recalibrate, not a fit. Only v2 uses it; OUTPUT_PER_STEP stays 600 for
// the existing budget checks (I-1).
export const CALIBRATED_OUTPUT_PER_STEP = { tokens: 1_800, fitted: "2026-09-14", cases: 1 } as const

// VS-40a: a measured output per step for one model at one effort, with its fit date and how many cases it rests on.
// `model` is the model id within its provider: PassPlan.model less its "provider/" prefix, so a projection's
// "vectorscope-projection/<id>" and a paid replay's "openrouter/<id>" find the same entry. `effort` is the engine
// variant name R2 pins per pass (a key of the model's variants: none, minimal, low, medium, high, xhigh or max, as its
// provider offers them).
export interface OutputFit {
  model: string
  effort: string
  tokens: number
  fitted: string
  cases: number
}

// VS-40a: measured entries only, each added from D7 pilot artifacts (VS-21e item 3) with its fit date and cases. None is
// measured yet.
export const OUTPUT_FITS: readonly OutputFit[] = []

// VS-40a: the output per step v2 prices a pass at, as a fit. Without an effort it is CALIBRATED_OUTPUT_PER_STEP itself;
// with one, the measured entry for this model (PassPlan.model, "provider/model") at exactly that effort, else that
// default. `fits` is for tests, as VS-21e's listPriceWarnings takes its table, and estimateDispatch passes its own on.
export function calibratedOutputPerStep(model?: string, effort?: string, fits: readonly OutputFit[] = OUTPUT_FITS) {
  if (effort === undefined || model === undefined) return CALIBRATED_OUTPUT_PER_STEP
  const id = model.slice(model.indexOf("/") + 1)
  return fits.find((fit) => fit.model === id && fit.effort === effort) ?? CALIBRATED_OUTPUT_PER_STEP
}

// A step-cap shrink lowers a pass's cap to this fraction of its current cap, never above it (the pilot's 50%; other
// fractions only in projections or the funded ablation, Q9).
export const STEP_CAP_FRACTION = 0.5

// The shrink levers in VS-40's order: lenses, cards, step caps (verify, security, review), the lowest-ranked
// dependents, then diff trim. Lenses, cards and dependents exist only once VS-28, VS-26 and VS-25 are wired.
export const SHRINK_ORDER = [
  "lenses",
  "cards",
  "steps:verify",
  "steps:security",
  "steps:review",
  "dependents",
  "diff",
] as const
export type Shrink = (typeof SHRINK_ORDER)[number]
type StepPass = "verify" | "security" | "review"
const STEP_LEVERS: Partial<Record<Shrink, StepPass>> = {
  "steps:verify": "verify",
  "steps:security": "security",
  "steps:review": "review",
}

export interface Range {
  low: number
  high: number
}

// One planned pass, before its session starts.
export interface PassPlan {
  pass: string // "review", "security", "verify", and later VS-28's lenses
  model: string // "provider/model"
  promptTokens: number // its first request: prompt, system prompt, tools and output schema
  maxSteps: number
  price?: ReviewPrice // absent for a free, plan or local model, or one without a price snapshot
  // The route reads each step's prompt as the next step's cached prefix (a caching provider, or a last-message
  // breakpoint). v2 prices a cache-read share only when this is true and the price lists a cache read; otherwise it uses
  // the catalog's input price throughout.
  cached?: boolean
  // VS-40a: the effort the pass runs at, as an engine variant name. It keys calibratedOutputPerStep, so without a
  // measured entry for it v2 prices 1,800 tokens a step, as without it. Nothing sets it before R2 pins effort per pass.
  effort?: string
}

export interface PassEstimate extends PassPlan {
  inputTokens: Range // S·P + R·S(S−1)/2 per band, cache reads included; the same for both estimates
  outputTokens: Range // S·OUTPUT_PER_STEP per band
  usd?: Range // estimateCostUsd's legacy range, which the gate reads; absent without a price
  firstStepUsd?: number // what admission reserves for the first turn: nextStepCostUsd(P + NEXT_STEP_SLACK)
  v2: {
    cacheReadShare: Range // h(S) per band, or 0 when the pass is not cached or has no cache-read price
    outputTokens: Range // S·calibratedOutputPerStep(model, effort) per band
    usd?: Range
    // VS-40a: the measured OUTPUT_FITS entry `outputTokens` and `usd` rest on, only when the pass's model and effort have
    // one; without it they rest on CALIBRATED_OUTPUT_PER_STEP.
    fit?: OutputFit
  }
  // VS-40a, only when the price lists long-context tiers: `usd` and `v2.usd` again with step k priced at the tier its
  // prompt P + (k−1)·R passes (plan.ts bandCostUsd); a band whose last step passes no tier keeps its base-tier figure.
  // decideDispatch never reads it: the gate stays on the base-tier legacy low unless the tiered estimate's median
  // absolute error on pilot runs is at least 5 points lower (VS-40's kill rule).
  tiered?: { usd: Range; v2: Range }
}

export interface DispatchEstimate {
  passes: PassEstimate[]
  firstTurnTokens: number // summed over the passes: free, plan and local ones count too
  inputTokens: Range
  outputTokens: Range
  usd?: Range // over the priced passes; absent when none is priced
  firstStepUsd?: number
  unpriced: string[] // the passes with no price, which no dollar figure covers
  // `fitted` is CALIBRATED_OUTPUT_PER_STEP's date, the fit of every pass without a v2.fit, and is left out only when
  // every pass has one. `fits` (VS-40a) lists the measured OUTPUT_FITS entries the passes rest on, their v2.fit, once
  // each in pass order, and is there only when some pass has one.
  v2: { fitted?: string; outputTokens: Range; usd?: Range; fits?: OutputFit[] }
  // VS-40a, only when some pass has `tiered`: over the priced passes, each pass's tiered range, or its base-tier `usd`
  // and `v2.usd` when its price lists no tier.
  tiered?: { usd: Range; v2: Range }
}

export type DispatchLimit = "input-tokens" | "usd"

// `ineffective` lists the available levers SHRINK_ORDER passed over before the one it names (all of them on a stop),
// because they cannot lower a limit that is over: a step cap never lowers first-turn tokens, and lowers the low dollar
// estimate only when it cuts S below 5. They belong in the notes.
export type DispatchDecision =
  | { go: true }
  | { go: false; over: DispatchLimit[]; shrink: Shrink; ineffective: Shrink[] }
  | { go: false; over: DispatchLimit[]; stop: "budget-estimate"; ineffective: Shrink[] }

// Each pass estimated twice, the legacy range and v2, through the same estimateCostUsd so the two cannot drift (I-10).
// `fits` is for tests (calibratedOutputPerStep).
export function estimateDispatch(
  passes: readonly PassPlan[],
  fits: readonly OutputFit[] = OUTPUT_FITS,
): DispatchEstimate {
  const estimates = passes.map((plan) => estimatePass(plan, fits))
  const measured = [...new Set(estimates.flatMap((estimate) => (estimate.v2.fit ? [estimate.v2.fit] : [])))]
  const priced = estimates.flatMap((estimate) =>
    estimate.usd && estimate.v2.usd
      ? [
          {
            usd: estimate.usd,
            v2: estimate.v2.usd,
            firstStep: estimate.firstStepUsd ?? 0,
            tiered: estimate.tiered ?? { usd: estimate.usd, v2: estimate.v2.usd },
          },
        ]
      : [],
  )
  return {
    passes: estimates,
    firstTurnTokens: estimates.reduce((total, estimate) => total + estimate.promptTokens, 0),
    inputTokens: sum(estimates.map((estimate) => estimate.inputTokens)),
    outputTokens: sum(estimates.map((estimate) => estimate.outputTokens)),
    ...(priced.length
      ? {
          usd: sum(priced.map((entry) => entry.usd)),
          firstStepUsd: priced.reduce((total, entry) => total + entry.firstStep, 0),
        }
      : {}),
    unpriced: estimates.filter((estimate) => estimate.price === undefined).map((estimate) => estimate.pass),
    v2: {
      ...(estimates.length && estimates.every((estimate) => estimate.v2.fit)
        ? {}
        : { fitted: CALIBRATED_OUTPUT_PER_STEP.fitted }),
      outputTokens: sum(estimates.map((estimate) => estimate.v2.outputTokens)),
      ...(priced.length ? { usd: sum(priced.map((entry) => entry.v2)) } : {}),
      ...(measured.length ? { fits: measured } : {}),
    },
    ...(estimates.some((estimate) => estimate.tiered)
      ? {
          tiered: {
            usd: sum(priced.map((entry) => entry.tiered.usd)),
            v2: sum(priced.map((entry) => entry.tiered.v2)),
          },
        }
      : {}),
  }
}

// Whether the planned review fits, and if not, the first lever in SHRINK_ORDER that is available and can lower a limit
// that is over, or a stop. Reads only first-turn tokens and the legacy low dollars.
// - "input-tokens": maxInputTokens is a cap (above 0; NaN reads as a cap nothing fits under) and first-turn tokens are
//   not at or under it.
// - "usd": remainingUsd is given, a pass is priced, and the low estimate is not at or under it (so a remainder of 0 or
//   less, or one that is not a number, is over).
// `available` names the levers the caller can apply now; VS-24 wiring has the step caps and diff trim only.
export function decideDispatch(
  estimate: DispatchEstimate,
  limits: { maxInputTokens: number; remainingUsd?: number; available?: readonly Shrink[] },
): DispatchDecision {
  const over = overLimits(estimate, limits)
  if (!over.length) return { go: true }
  const available = SHRINK_ORDER.filter((lever) => limits.available?.includes(lever))
  const shrink = available.find((lever) => canLower(estimate, lever, over))
  if (!shrink) return { go: false, over, stop: "budget-estimate", ineffective: available }
  return { go: false, over, shrink, ineffective: available.slice(0, available.indexOf(shrink)) }
}

// The passes with every pass named `pass` given a lower step cap: Math.floor(cap · fraction), at least one step, and
// never above the current cap (a fraction above 1, or one that is not a positive number, leaves it as it is).
export function shrinkStepCap(passes: readonly PassPlan[], pass: StepPass, fraction = STEP_CAP_FRACTION): PassPlan[] {
  return passes.map((plan) => (plan.pass === pass ? { ...plan, maxSteps: shrunkCap(plan.maxSteps, fraction) } : plan))
}

// h(S) = 1 − (P + (S−1)R) / (S·P + R·S(S−1)/2) [G3-6]: each step writes its new tokens (the prompt, then R a step) and
// reads the rest from the cache. 0 for a single step, or when the input is not a positive number.
export function cacheReadShare(promptTokens: number, band: EstimateBand): number {
  const total = passInputTokens(promptTokens, band)
  if (!(band.steps > 1) || !(total > 0) || !Number.isFinite(total)) return 0
  const share = 1 - (promptTokens + (band.steps - 1) * band.growth) / total
  return Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0
}

// VS-40's dollar remainder: the smallest of maxCostUsd, the per-PR cap less this PR's prior spend, and the month cap less
// this month's spend. A cap of 0 is none and is left out, and so is a spend the caller does not pass: without `spent`
// the remainder is maxCostUsd, the CLI's case. The per-PR cap bounds automatic reviews only, as in decideSkip (skip.ts),
// so a review a command asked for leaves it out whatever the PR has spent; the month cap bounds every trigger. A spend
// that is not a number of at least 0 leaves nothing of its cap. Undefined when no cap applies. RunInput.spent, which
// would feed it, lands with VS-24 wiring (GitHub after the @vector merge).
export function remainingUsd(
  config: Pick<ReviewConfig, "maxCostUsd" | "maxCostUsdPerPr" | "maxCostUsdPerMonth">,
  spent?: { trigger: Trigger; prUsd?: number; monthUsd?: number },
): number | undefined {
  const perPr = spent?.trigger === "auto" ? spent.prUsd : undefined
  const terms = [
    config.maxCostUsd > 0 ? config.maxCostUsd : undefined,
    config.maxCostUsdPerPr > 0 && perPr !== undefined ? left(config.maxCostUsdPerPr, perPr) : undefined,
    config.maxCostUsdPerMonth > 0 && spent?.monthUsd !== undefined
      ? left(config.maxCostUsdPerMonth, spent.monthUsd)
      : undefined,
  ].filter((term) => term !== undefined)
  return terms.length ? Math.min(...terms) : undefined
}

function estimatePass(plan: PassPlan, fits: readonly OutputFit[]): PassEstimate {
  const bands = estimateBands(plan.maxSteps)
  const price = plan.price
  const caching = plan.cached === true && price?.cacheRead !== undefined
  const share = caching
    ? { low: cacheReadShare(plan.promptTokens, bands.low), high: cacheReadShare(plan.promptTokens, bands.high) }
    : { low: 0, high: 0 }
  const fit = calibratedOutputPerStep(plan.model, plan.effort, fits)
  const output = fit.tokens
  const legacy = price
    ? estimateCostUsd({ promptTokens: plan.promptTokens, maxSteps: plan.maxSteps, price })
    : undefined
  const v2 = price
    ? estimateCostUsd({
        promptTokens: plan.promptTokens,
        maxSteps: plan.maxSteps,
        price,
        cacheReadShare: share,
        writePrice: caching ? (price.cacheWrite ?? price.input) : price.input,
        outputPerStep: output,
      })
    : undefined
  // VS-40a: a band again with step k at the tier its prompt passes. A band whose last step passes no tier, or whose last
  // prompt is not finite, keeps its base-tier figure, so a tier that is listed but never reached changes nothing, bit for
  // bit, and a step count that is not a number stays NaN or Infinity as it is without tiers.
  const atTiers = (
    band: EstimateBand,
    base: number,
    reads: CacheReads,
    write: "input" | "cache-write",
    per: number,
  ) => {
    const last = plan.promptTokens + (band.steps - 1) * band.growth
    return price && Number.isFinite(last) && priceAt(price, last) !== price
      ? bandCostUsd({ promptTokens: plan.promptTokens, band, price, reads, write, outputPerStep: per })
      : base
  }
  const reads = caching ? "prefix" : "none"
  const write = caching ? "cache-write" : "input"
  const tiered =
    price?.tiers?.length && legacy && v2
      ? {
          usd: {
            low: atTiers(bands.low, legacy.low, "prompt", "input", OUTPUT_PER_STEP),
            high: atTiers(bands.high, legacy.high, "none", "input", OUTPUT_PER_STEP),
          },
          v2: {
            low: atTiers(bands.low, v2.low, reads, write, output),
            high: atTiers(bands.high, v2.high, reads, write, output),
          },
        }
      : undefined
  return {
    pass: plan.pass,
    model: plan.model,
    promptTokens: plan.promptTokens,
    maxSteps: plan.maxSteps,
    ...(price ? { price } : {}),
    ...(plan.cached === undefined ? {} : { cached: plan.cached }),
    ...(plan.effort === undefined ? {} : { effort: plan.effort }),
    inputTokens: perBand(bands, (band) => passInputTokens(plan.promptTokens, band)),
    outputTokens: perBand(bands, (band) => band.steps * OUTPUT_PER_STEP),
    ...(legacy && price
      ? { usd: legacy, firstStepUsd: nextStepCostUsd(plan.promptTokens + NEXT_STEP_SLACK, price) }
      : {}),
    v2: {
      cacheReadShare: share,
      outputTokens: perBand(bands, (band) => band.steps * output),
      ...(v2 ? { usd: v2 } : {}),
      ...("effort" in fit ? { fit } : {}),
    },
    ...(tiered ? { tiered } : {}),
  }
}

function overLimits(
  estimate: DispatchEstimate,
  limits: { maxInputTokens: number; remainingUsd?: number },
): DispatchLimit[] {
  const cap = limits.maxInputTokens
  const tokens = (cap > 0 || Number.isNaN(cap)) && !(estimate.firstTurnTokens <= cap)
  const remaining = limits.remainingUsd
  const usd = remaining !== undefined && estimate.usd !== undefined && !(estimate.usd.low <= remaining)
  return [...(tokens ? ["input-tokens" as const] : []), ...(usd ? ["usd" as const] : [])]
}

// Lenses, cards, dependents and diff trim shorten the prompts, so they can lower either limit; the caller lists them
// only when it has something to drop. A step cap can lower only the dollars, and only when it lowers the low estimate.
function canLower(estimate: DispatchEstimate, lever: Shrink, over: readonly DispatchLimit[]) {
  const pass = STEP_LEVERS[lever]
  if (!pass) return true
  if (!over.includes("usd") || !estimate.usd) return false
  const shrunk = estimateDispatch(shrinkStepCap(estimate.passes.map(planOf), pass)).usd
  return shrunk !== undefined && shrunk.low < estimate.usd.low
}

function planOf(estimate: PassEstimate): PassPlan {
  return {
    pass: estimate.pass,
    model: estimate.model,
    promptTokens: estimate.promptTokens,
    maxSteps: estimate.maxSteps,
    ...(estimate.price ? { price: estimate.price } : {}),
    ...(estimate.cached === undefined ? {} : { cached: estimate.cached }),
    ...(estimate.effort === undefined ? {} : { effort: estimate.effort }),
  }
}

function shrunkCap(cap: number, fraction: number) {
  if (!Number.isFinite(fraction) || fraction <= 0 || !Number.isFinite(cap)) return cap
  return Math.min(cap, Math.max(1, Math.floor(cap * fraction)))
}

function left(cap: number, spent: number) {
  return Number.isFinite(spent) && spent >= 0 ? cap - spent : -Infinity
}

function perBand(bands: { low: EstimateBand; high: EstimateBand }, value: (band: EstimateBand) => number): Range {
  return { low: value(bands.low), high: value(bands.high) }
}

function sum(ranges: readonly Range[]): Range {
  return {
    low: ranges.reduce((total, range) => total + range.low, 0),
    high: ranges.reduce((total, range) => total + range.high, 0),
  }
}
