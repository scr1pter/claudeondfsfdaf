// What a review runs and what it may cost: which specialists, which findings the verify pass re-checks, how much diff
// fits a model's context, and the cost estimates behind the budget checks (sections 5.2 and 5.3). Pure and
// browser-safe.

import type { DiffFile } from "./diff"
import { isSensitivePath } from "./ignore"
import type { RiskAssessment, RiskBand } from "./risk"
import { REVIEW_LENSES, type CostKind, type Finding, type ReviewConfig, type ReviewLens, type Trust } from "./types"

export type Specialist = "review" | "security"

export const MIN_CONTEXT = 32_000

// Tokens a step adds to the context before the next one: tool results and the model's own output.
export const NEXT_STEP_SLACK = 3_000

// USD per million tokens, as the catalog lists them.
export interface ReviewPrice {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

// Estimate constants: output tokens per step, and how many tokens each step adds to the next one's input. S and R
// fitted 2026-09-14 on a measured review of a 5-file change: the review and security sessions took
// 5 and 4 steps, and R = 2,000 makes S·P + R·S·(S−1)/2 match their measured 79.3k input tokens. HIGH_GROWTH is
// unchanged (the largest one-step growth was 4,032). That run averaged 1,800 output tokens a step, reasoning
// included; OUTPUT_PER_STEP also prices the budget check's next step, so it stays until a priced run confirms it.
// Exported for dispatch.ts, whose VS-40 estimate prices output at the measured 1,800 instead.
export const OUTPUT_PER_STEP = 600
const LOW_STEPS = 5
const LOW_GROWTH = 2_000
const HIGH_GROWTH = 4_000

// One side of estimateCostUsd's range: S steps, each adding R tokens to the next one's input.
export interface EstimateBand {
  steps: number
  growth: number
}

// The two bands estimateCostUsd prices. Low: S = 5 (or maxSteps if lower) and R = 2,000. High: S = maxSteps (at least
// one) and R = 4,000.
export function estimateBands(maxSteps: number): { low: EstimateBand; high: EstimateBand } {
  const steps = Math.max(1, Math.floor(maxSteps))
  return { low: { steps: Math.min(LOW_STEPS, steps), growth: LOW_GROWTH }, high: { steps, growth: HIGH_GROWTH } }
}

// A session's input over a band, cache reads included: S·P plus the growth R·S·(S−1)/2.
export function passInputTokens(promptTokens: number, band: EstimateBand): number {
  return band.steps * promptTokens + (band.growth * band.steps * (band.steps - 1)) / 2
}

// `review` always runs. `security` runs when it is "always", or "auto" and a sensitive path changed.
export function planSpecialists(
  files: Pick<DiffFile, "path" | "oldPath">[],
  config: Pick<ReviewConfig, "security">,
): Specialist[] {
  if (config.security === "off") return ["review"]
  if (config.security === "always") return ["review", "security"]
  const sensitive = files.some(
    (file) => isSensitivePath(file.path) || (!!file.oldPath && isSensitivePath(file.oldPath)),
  )
  return sensitive ? ["review", "security"] : ["review"]
}

// The most sessions one review may open (contract §4 VS-28 item 4): review, security, verify, up to four lenses and
// VS-30's repro. Finalizers run inside their own session. Read by no runner before VS-28 wiring, which enforces it.
export const MAX_REVIEW_SESSIONS = 8

// Why a plan runs less than its band asks: "security-off" is an explicit `security: "off"`, which drops the security
// pass and the access lens wherever the band would add them.
export type DepthLimit = "security-off"

// What a review runs at a depth. `effective` is the depth that ran: "fixed", or the band an automatic depth planned
// for (gap-6 G6-2: the output carries the effective depth, and a request that cannot run in full says so in `limited`).
// `sessions` is the most the plan can open: its specialists and lenses and one verify pass; VS-30's repro adds one.
export interface DepthPlan {
  requested: "fixed" | "auto"
  effective: "fixed" | RiskBand
  specialists: Specialist[]
  lenses: ReviewLens[]
  sessions: number
  limited: DepthLimit[]
}

// An automatic depth always has a band: riskOf is pure and needs only the files, and a feature it lacks (history,
// dependents) is listed in its `missing`, not a missing band. So "auto" without a risk does not type-check.
export type DepthInput =
  | { depth: "fixed"; files: Pick<DiffFile, "path" | "oldPath">[]; config: Pick<ReviewConfig, "security"> }
  | {
      depth: "auto"
      files: Pick<DiffFile, "path" | "oldPath">[]
      config: Pick<ReviewConfig, "security" | "lenses">
      risk: Pick<RiskAssessment, "band">
    }

/**
 * The passes for a requested depth (contract §4 VS-28's depth table, addendum A VS-39 item 7). Nothing calls it before
 * VS-28 wiring, which calls it in place of planSpecialists under `depth: "auto"`.
 * - "fixed" is exactly planSpecialists: today's passes, no lens (D3).
 * - "auto" plans by band. Low runs what planSpecialists runs under `security: "auto"` (the review, and security only on
 *   a sensitive path); medium runs the review and security; high adds the four lenses when `lenses` is "high".
 *   `security: "always"` adds security on every band. `security: "off"` wins over every band: no security pass and no
 *   access lens (it looks for authentication and authorization defects, the security pass's ground), and "security-off"
 *   in `limited` wherever the band would have added either.
 * So under any security setting an automatic depth runs at least the passes a fixed one runs (I-2: no input lowers a
 * review below today's default).
 */
export function planDepth(input: DepthInput): DepthPlan {
  if (input.depth === "fixed") {
    const specialists = planSpecialists(input.files, input.config)
    return {
      requested: "fixed",
      effective: "fixed",
      specialists,
      lenses: [],
      sessions: specialists.length + 1,
      limited: [],
    }
  }
  const band = input.risk.band
  const security = input.config.security
  const wanted = band === "low" ? planSpecialists(input.files, { security: "auto" }).includes("security") : true
  const lensed = band === "high" && input.config.lenses === "high"
  const specialists: Specialist[] =
    security === "always" || (security === "auto" && wanted) ? ["review", "security"] : ["review"]
  const lenses = lensed ? REVIEW_LENSES.filter((lens) => security !== "off" || lens !== "access") : []
  return {
    requested: "auto",
    effective: band,
    specialists,
    lenses,
    sessions: specialists.length + lenses.length + 1,
    limited: security === "off" && (wanted || lensed) ? ["security-off"] : [],
  }
}

// The verify policy (VS-06). After the review and security passes, a second pass on the review model re-reads the
// code behind each candidate finding and answers confirmed or rejected. A rejected finding is dropped; a confirmed one
// is marked verified, which an untrusted review needs before it posts the finding's suggestion as a committable one.
//
// Candidates, by `verify`:
//   "blocking"  each blocking finding at or above minConfidence
//   "all"       each finding above a nit at or above minConfidence
//   "off"       none
// Two rules are stricter than the setting:
//   - In an untrusted review every finding with a suggestion is a candidate too, whatever its severity or confidence.
//   - After a cheaper triage pass, verify is read as "all" even when it is "off", and a candidate above a nit is
//     reported only when the review model confirmed it (verifyUnconfirmed). A triage model's claims that earlier
//     findings are fixed go to the same pass; the runner adds them.
// An explicit setting wins over the default: REVIEW_VERIFY, then review.json's "verify", then the default, which is
// SHARED_VERIFY_DEFAULT ("all") under this policy (the config parser applies it). Each id is a candidate once.
//
// A candidate the pass gave no verdict for is never passed over in silence, whether the pass finished or was skipped,
// denied by the review's budget, stopped, timed out or failed. After a triage pass one above a nit is left out, and the
// review says how many were (noteTriageUnchecked). Any other is posted without the verified mark, and the review says
// how many were not re-checked and why (verifyUnanswered, noteVerifyUnfinished). Both surfaces give the same notes.
//
// verifyPolicy "shared" (D3's opt-in) applies all of this on every surface. Under "legacy", the default, each surface
// keeps the rule it had before this policy. The engine leaves the untrusted-suggestion rule out of "all" and of a
// triage pass, and notes only a pass it skipped or, after a triage pass, one that did not finish. The desktop reads
// "blocking" as "all", does not merge candidates that share an id, and gives one note, without a count unless a triage
// pass left findings out, for a pass that did not finish. Neither says anything of a finished pass that left out
// verdicts.
export type VerifySurface = "engine" | "desktop"

export interface VerifyRule {
  verify: ReviewConfig["verify"]
  policy: ReviewConfig["verifyPolicy"] | undefined // anything but "shared" is the legacy rule
  minConfidence: number
  trust: Trust
  triaged: boolean // the review and security passes ran on a cheaper triage model
}

type Candidate = Pick<Finding, "id" | "severity" | "confidence" | "suggestion">
type Verdicts = ReadonlyMap<string, "confirmed" | "rejected">

// The findings the verify pass re-checks, in the order they were found.
export function verifyCandidates<F extends Candidate>(
  findings: readonly F[],
  rule: VerifyRule,
  surface: VerifySurface,
) {
  if (rule.policy !== "shared")
    return surface === "engine" ? legacyEngine(findings, rule) : legacyDesktop(findings, rule)
  if (rule.verify === "off" && !rule.triaged) return []
  const all = rule.verify === "all" || rule.triaged
  return onePerId(
    findings.filter(
      (finding) =>
        (finding.confidence >= rule.minConfidence &&
          (all ? finding.severity !== "nit" : finding.severity === "blocking")) ||
        (rule.trust === "untrusted" && finding.suggestion !== undefined),
    ),
  )
}

// After a triage pass, the candidates above a nit that the review model did not confirm: they are left out. Outside a
// triage pass nothing is left out for want of a verdict.
export function verifyUnconfirmed<F extends Candidate>(candidates: readonly F[], verdicts: Verdicts, triaged: boolean) {
  return triaged
    ? candidates.filter((finding) => finding.severity !== "nit" && verdicts.get(finding.id) !== "confirmed")
    : []
}

// The candidates the verify pass gave no verdict for that are still posted, unverified. After a triage pass only nits
// (an untrusted review's suggestions) are; verifyUnconfirmed leaves the others out.
export function verifyUnanswered<F extends Candidate>(candidates: readonly F[], verdicts: Verdicts, triaged = false) {
  return candidates.filter((finding) => !verdicts.has(finding.id) && !(triaged && finding.severity !== "nit"))
}

// The engine's rule before the policy: "all" and a triage pass leave out the untrusted-suggestion rule.
function legacyEngine<F extends Candidate>(findings: readonly F[], rule: VerifyRule) {
  const all = rule.verify === "all" || rule.triaged
  return onePerId(
    (rule.verify === "off" && !rule.triaged ? [] : findings).filter((finding) =>
      all
        ? finding.severity !== "nit" && finding.confidence >= rule.minConfidence
        : (finding.severity === "blocking" && finding.confidence >= rule.minConfidence) ||
          (rule.trust === "untrusted" && finding.suggestion !== undefined),
    ),
  )
}

// The desktop's rule before the policy: every finding above a nit and every untrusted suggestion unless verify is
// "off", so "blocking" reads as "all"; candidates that share an id are each sent.
function legacyDesktop<F extends Candidate>(findings: readonly F[], rule: VerifyRule) {
  return rule.verify === "off" && !rule.triaged
    ? []
    : findings.filter(
        (finding) =>
          (finding.severity !== "nit" && finding.confidence >= rule.minConfidence) ||
          (rule.trust === "untrusted" && finding.suggestion !== undefined),
      )
}

// One candidate per id, at the place its id first appears, carrying the last finding with that id, as the engine has
// always sent them.
function onePerId<F extends Candidate>(findings: readonly F[]): F[] {
  return [...new Map(findings.map((finding) => [finding.id, finding])).values()]
}

// Characters of diff to inline for a model: 30% of the context left after a reserve, at 3.5 characters a token,
// clamped to 8,000..maxDiffChars. That is 16.8k at 32k of context, 79.8k at 128k, and the cap at 1M.
export function diffBudgetChars(context: number, maxDiffChars: number): number {
  const reserve = Math.min(52_000, Math.floor(context / 2))
  // × 3.5 × 0.3 = × 21/20, kept in integers so the result is exact.
  const chars = Math.floor(((context - reserve) * 21) / 20)
  return Math.min(Math.max(chars, 8_000), maxDiffChars)
}

// The cost kind of a review whose passes ran on models of these kinds. Free passes add nothing to a priced or a
// subscription one; any other mix has no single price to show.
export function combineCostKinds(kinds: readonly CostKind[]): CostKind {
  const distinct = [...new Set(kinds)]
  if (distinct.length === 1) return distinct[0]!
  const paid = distinct.filter((kind) => kind !== "free")
  return paid.length === 1 && paid[0] !== "unknown" ? paid[0]! : "unknown"
}

// The refusal for a model below MIN_CONTEXT, or undefined when it is large enough.
export function contextRefusal(model: string, context: number): string | undefined {
  if (context >= MIN_CONTEXT) return undefined
  const size = context > 0 ? `${Math.round(context / 1000)}k` : "no listed context size"
  return `Vectorscope reviews need a model with at least 32k tokens of context; ${model} has ${size}.`
}

function usd(tokens: number, perMillion: number) {
  return (tokens * perMillion) / 1_000_000
}

// A range for a review of a prompt of P tokens. Over S steps the input is S·P plus the growth R·S·(S−1)/2, and the
// output S·600. Low: S = 5 (or maxSteps if lower) and R = 2,000, with the cache-read price for (S−1)·P when one is
// known. High: S = maxSteps and R = 4,000, all at the full input price.
//
// VS-40's estimate v2 (dispatch.ts) passes three more inputs, and with none of them the result is exactly the one
// above. `cacheReadShare` is the share of each band's input read from the cache, h(S), in place of the (S−1)·P rule; it
// applies only when the price lists a cache read, and a value that is not a number reads as 0. The rest of the input is
// priced at `writePrice` (the catalog's cache-write price on a caching route) instead of the input price, and output at
// `outputPerStep` tokens a step instead of 600.
export function estimateCostUsd(input: {
  promptTokens: number
  maxSteps: number
  price: ReviewPrice
  cacheReadShare?: { low: number; high: number }
  writePrice?: number
  outputPerStep?: number
}): {
  low: number
  high: number
} {
  const { promptTokens, price } = input
  const bands = estimateBands(input.maxSteps)
  const share = price.cacheRead === undefined ? undefined : input.cacheReadShare
  const write = input.writePrice ?? price.input
  const output = input.outputPerStep ?? OUTPUT_PER_STEP
  // The legacy low band reads (S−1)·P from the cache when there is a cache-read price; the legacy high band reads none
  // and has no cache-read term at all, so its sum is the same floating-point sum as before VS-40.
  const lowCached =
    price.cacheRead === undefined
      ? 0
      : share
        ? readShare(share.low) * passInputTokens(promptTokens, bands.low)
        : (bands.low.steps - 1) * promptTokens
  const highCached = share ? readShare(share.high) * passInputTokens(promptTokens, bands.high) : undefined
  const bandUsd = (band: EstimateBand, cached: number | undefined) => {
    const uncached = band.steps * promptTokens - (cached ?? 0) + (band.growth * band.steps * (band.steps - 1)) / 2
    const out = usd(band.steps * output, price.output)
    return cached === undefined
      ? usd(uncached, write) + out
      : usd(uncached, write) + usd(cached, price.cacheRead ?? 0) + out
  }
  return { low: bandUsd(bands.low, lowCached), high: bandUsd(bands.high, highCached) }
}

function readShare(share: number) {
  return Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0
}

// What the next step of a session will cost: its whole context as input plus one step of output. `cachedTokens` is
// the part the provider reported as cache reads on the last step; it is charged at the cache-read price when there
// is one. Callers pass the last step's context plus NEXT_STEP_SLACK.
export function nextStepCostUsd(contextTokens: number, price: ReviewPrice, cachedTokens = 0): number {
  const cached = price.cacheRead === undefined ? 0 : Math.min(Math.max(cachedTokens, 0), contextTokens)
  return (
    usd(contextTokens - cached, price.input) + usd(cached, price.cacheRead ?? 0) + usd(OUTPUT_PER_STEP, price.output)
  )
}
