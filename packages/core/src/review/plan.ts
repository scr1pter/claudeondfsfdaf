// What a review runs and what it may cost: which specialists, which findings the verify pass re-checks (and, for
// VS-44c's ablation, which of them it re-checks one call each), how much diff fits a model's context, and the cost
// estimates behind the budget checks (sections 5.2 and 5.3). Pure and browser-safe.

import { renderPatch, type DiffFile } from "./diff"
import { sha256 } from "../util/sha256"
import { isSensitivePath } from "./ignore"
import { orderByRiskDensity, type RiskAssessment, type RiskBand } from "./risk"
import {
  FAILURE_CLASSES,
  FAILURE_MECHANISMS,
  REVIEW_LENSES,
  type CostKind,
  type Finding,
  type ReviewConfig,
  type ReviewLens,
  type Trust,
} from "./types"

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
  // VS-40a: the long-context tiers, absent unless a caller lists them. Only bandCostUsd reads them (and dispatch.ts's
  // tiered estimate through it): estimateCostUsd and nextStepCostUsd price the base rates, so the gate's legacy low stays
  // base-tier (VS-40's kill rule), and a caller that knows a step's context resolves its tier first with priceAt, as
  // run.ts resolves Session.costAt before nextStepCostUsd.
  tiers?: readonly ReviewTier[]
}

// VS-40a: one long-context tier, the rates of a request whose context is more than `above` tokens. A cache rate the
// tier does not list is no cache rate at that tier, never the base one: the engine reads a missing rate as 0, and
// SpendGuard.priceOf drops it.
export interface ReviewTier {
  above: number
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

// VS-44c (addendum B §1.10): what a blind verifier sees of a candidate, VS-44 item 1's list and nothing more. No title,
// body, suggestion, rule, quotes, patch or category. `failure.trigger` and `failure.impact` are the reviewer's words,
// and VS-44 lets them through on purpose. Only decodeReport under `guardrail: "strict"` fills `failure`, so until a
// runner asks for strict (VS-27c) a candidate has no class and no failure fields.
export type BlindCandidate = Pick<Finding, "id" | "path" | "line" | "side" | "severity" | "failure" | "evidence">

// One verify candidate, with what estimateCostUsd needs to price its own call: `promptTokens` counts that candidate's
// isolated (blind) verify prompt.
export interface IsolatedVerifyInput<C extends BlindCandidate = BlindCandidate> {
  candidate: C
  promptTokens: number
  maxSteps: number
  price: ReviewPrice
}

// One planned verify call. An isolated call holds one candidate, and the batched call the rest in the order given.
// `positions` are the candidates' places in planIsolatedVerify's `calls`, so a caller finds its own findings again
// without matching ids, which the desktop's legacy rule does not merge.
export interface PlannedVerifyCall {
  kind: "isolated" | "batched"
  candidates: BlindCandidate[]
  positions: number[]
  estimate: { low: number; high: number }
}

// VS-44c's planner, an ablation candidate (Q9) and never a default: the top k blocking candidates (3 unless set) get
// one verify call each, and the rest go to one batched call. Each call's estimate is estimateCostUsd's legacy range,
// with no VS-40 inputs and no tiers. No runner calls it before runner-wiring R3, which admits each call (I-5) on the
// review model's route (I-3).
//
// The batched call's tokens come from `batched.promptTokens`, because that prompt depends on which candidates were
// isolated, and estimateCostUsd is not additive: each call pays its own S·600 output and R·S(S−1)/2 growth. It is
// called once, only when the rest is not empty, with the caller's own candidates in the order given, so it can count
// the prompt it would send. Every planned call holds blind copies only (blindCandidate). A count of k that is not a
// number isolates none, a negative one none, and a fraction rounds down.
//
// Only the isolated calls go blind: R3 renders each one from its `candidates`. The batched call stays today's verify
// pass for the rest (the spec sends the rest "through today's batched pass", and at k = 0 its estimate is today's), so
// R3 renders it from its own findings through `positions`, title, body and suggestion included, as run.ts does now,
// and its `candidates` are only a blind record of what it holds. A batched pass that went blind too would render from
// `candidates` and pass a counter of that blind prompt as `batched.promptTokens`.
//
// A token count that is not a number gives a NaN estimate, as estimateCostUsd does, and a check written as
// `estimate.high > budget` is false for NaN, so it would admit the call: R3 must treat a non-finite estimate as
// unaffordable.
export function planIsolatedVerify<C extends BlindCandidate>(
  calls: readonly IsolatedVerifyInput<C>[],
  options: {
    k?: number
    batched: { promptTokens: (rest: readonly C[]) => number; maxSteps: number; price: ReviewPrice }
  },
): PlannedVerifyCall[] {
  // slice reads a NaN end as 0 and drops a fraction; Math.max keeps a negative count from counting from the end.
  const picked = calls
    .map((call, position) => ({ call, position }))
    .filter((entry) => entry.call.candidate.severity === "blocking")
    .toSorted((a, b) => isolatedOrder(a.call.candidate, b.call.candidate))
    .slice(0, Math.max(0, options.k ?? 3))
  const isolated = new Set(picked.map((entry) => entry.position))
  const rest = calls.flatMap((call, position) => (isolated.has(position) ? [] : [{ call, position }]))
  return [
    ...picked.map((entry) => ({
      kind: "isolated" as const,
      candidates: [blindCandidate(entry.call.candidate)],
      positions: [entry.position],
      estimate: estimateCostUsd({
        promptTokens: entry.call.promptTokens,
        maxSteps: entry.call.maxSteps,
        price: entry.call.price,
      }),
    })),
    ...(rest.length
      ? [
          {
            kind: "batched" as const,
            candidates: rest.map((entry) => blindCandidate(entry.call.candidate)),
            positions: rest.map((entry) => entry.position),
            estimate: estimateCostUsd({
              promptTokens: options.batched.promptTokens(rest.map((entry) => entry.call.candidate)),
              maxSteps: options.batched.maxSteps,
              price: options.batched.price,
            }),
          },
        ]
      : []),
  ]
}

// The isolation order, a named concept of its own: severity first, which only blocking candidates reach. Then the
// failure class in FAILURE_CLASSES order, with no known failure last; then path by code unit, as select.ts's posting
// order compares it (never localeCompare, which diff.ts's mergeFocus uses); then line, then id. Candidates that share
// all of these keep the order given.
function isolatedOrder(a: BlindCandidate, b: BlindCandidate) {
  const rank = (candidate: BlindCandidate) => {
    const failure = knownFailure(candidate)
    return failure ? FAILURE_CLASSES.indexOf(failure.class) : FAILURE_CLASSES.length
  }
  return (
    rank(a) - rank(b) ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
    a.line - b.line ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

// A path:line or path:start-end reference with no whitespace. Any other evidence entry is left out: a narrowing only,
// not what keeps reviewer text out (a token such as "trust-me:1" still matches, and a path with a space never does).
const EVIDENCE_REFERENCE = /^\S+:\d+(?:-\d+)?$/

// A fresh copy of the blind fields alone. A whole Finding is structurally a BlindCandidate, so this projection, not
// the type, is what keeps the reviewer's title, body and suggestion out of every planned call. `side` is copied as is:
// Finding requires one, and the desktop sets `side ?? "RIGHT"` before it builds a Finding.
function blindCandidate(candidate: BlindCandidate): BlindCandidate {
  const failure = knownFailure(candidate)
  const evidence = (candidate.evidence ?? []).filter((entry) => EVIDENCE_REFERENCE.test(entry))
  return {
    id: candidate.id,
    path: candidate.path,
    line: candidate.line,
    side: candidate.side,
    severity: candidate.severity,
    ...(failure
      ? {
          failure: {
            class: failure.class,
            mechanism: failure.mechanism,
            trigger: failure.trigger,
            impact: failure.impact,
          },
        }
      : {}),
    ...(evidence.length ? { evidence } : {}),
  }
}

// A failure as schema.ts's decodeFailure keeps one: a class and a mechanism the enums name. Anything else is no
// failure, for the order and the blind copy alike, so a caller that skips the strict decoder passes no arbitrary class.
function knownFailure(candidate: BlindCandidate) {
  const failure = candidate.failure
  return failure && FAILURE_CLASSES.includes(failure.class) && FAILURE_MECHANISMS.includes(failure.mechanism)
    ? failure
    : undefined
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
// `outputPerStep` tokens a step instead of 600. It never reads `price.tiers` (VS-40a: bandCostUsd prices them).
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
// is one. Callers pass the last step's context plus NEXT_STEP_SLACK. It never reads `price.tiers`: a caller that prices
// a tier passes priceAt's rates (VS-40a).
export function nextStepCostUsd(contextTokens: number, price: ReviewPrice, cachedTokens = 0): number {
  const cached = price.cacheRead === undefined ? 0 : Math.min(Math.max(cachedTokens, 0), contextTokens)
  return (
    usd(contextTokens - cached, price.input) + usd(cached, price.cacheRead ?? 0) + usd(OUTPUT_PER_STEP, price.output)
  )
}

// VS-40a: the rates a request carrying `contextTokens` of context is billed at, by engine Session.costAt's rule: the
// tier with the highest threshold the context is strictly over, the first listed among equal ones, else the base rates
// (`price` itself). A tier comes back flat, without `tiers`, with the cache rates it lists and no others. A context that
// is not a number passes no tier. models.dev's context_over_200k stand-in is the caller's to map, as a tier above
// 200,000 only when no exact tier is listed (the replay script's catalogTiers does). priceAt follows the engine for any
// list; a reader of untrusted tiers refuses a list with tierProblems first.
export function priceAt(price: ReviewPrice, contextTokens: number): ReviewPrice {
  const tier = (price.tiers ?? []).reduce<ReviewTier | undefined>(
    (best, item) => (contextTokens > item.above && (best === undefined || item.above > best.above) ? item : best),
    undefined,
  )
  if (!tier) return price
  return {
    input: tier.input,
    output: tier.output,
    ...(tier.cacheRead === undefined ? {} : { cacheRead: tier.cacheRead }),
    ...(tier.cacheWrite === undefined ? {} : { cacheWrite: tier.cacheWrite }),
  }
}

// VS-40a: what is wrong with a tier list, one line per problem. Each threshold is a finite number of tokens above 0 and
// above the one before it (so a list is in rising order and names no threshold twice), each rate a finite number of 0
// or more, and the input or output rate above 0: SpendGuard.priceOf reads a tier with neither as unpriced, and run.ts
// then reserves at the base rates.
export function tierProblems(tiers: readonly ReviewTier[]): string[] {
  return tiers.flatMap((tier, index) => {
    const name = `tier ${index + 1}`
    const previous = index > 0 ? tiers[index - 1] : undefined
    const rates = [
      ["input", tier.input],
      ["output", tier.output],
      ["cache read", tier.cacheRead],
      ["cache write", tier.cacheWrite],
    ] as const
    return [
      ...(Number.isFinite(tier.above) && tier.above > 0
        ? []
        : [`${name}'s threshold, ${tier.above}, is not a number of tokens above 0`]),
      ...(previous && tier.above === previous.above ? [`${name} repeats the threshold before it, ${tier.above}`] : []),
      ...(previous && tier.above < previous.above
        ? [
            `${name}'s threshold, ${tier.above}, is below the one before it, ${previous.above}: tiers are listed in rising order`,
          ]
        : []),
      ...rates.flatMap(([label, rate]) =>
        rate === undefined || (Number.isFinite(rate) && rate >= 0)
          ? []
          : [`${name}'s ${label} rate, ${rate}, is not a number of 0 or more`],
      ),
      ...(tier.input > 0 || tier.output > 0 ? [] : [`${name} has no input or output rate above 0`]),
    ]
  })
}

// VS-40a: how a band's input is read from the cache, step by step. "none": nothing. "prompt": the legacy low band's rule,
// every step after the first reads P. "prefix": v2's h(S) rule, step 1 writes P and step k reads L(k−1) and writes R,
// so the reads add up to h(S)·(S·P + R·S(S−1)/2) (dispatch.ts cacheReadShare).
export type CacheReads = "none" | "prompt" | "prefix"

// VS-40a: one band's cost with each step priced at its own tier. Step k = 1..S sends L(k) = P + (k−1)·R tokens, cache
// reads and writes included, and is priced at priceAt(price, L(k)). Its cache reads follow `reads`, from step 2 on and
// only when that step's rates list a cache read; the rest is written, at the step's cache-write rate (else its input
// rate) under "cache-write" and at its input rate under "input"; and it outputs `outputPerStep` tokens at the step's
// output rate. L(k) rises with k, so the steps at each tier form one run, and each run is summed in closed form: no loop
// over the steps and no allocation, whatever S is. A band whose steps are not a whole number of at least 1, whose growth
// is below 0 or whose last prompt is not finite costs NaN. With no tier passed the result is estimateCostUsd's closed
// form for the same band and reads, to rounding; dispatch.ts keeps estimateCostUsd's own figure for a band whose last
// step passes no tier, so a tier that is listed but never reached changes nothing there.
export function bandCostUsd(input: {
  promptTokens: number
  band: EstimateBand
  price: ReviewPrice
  reads: CacheReads
  write: "input" | "cache-write"
  outputPerStep: number
}): number {
  const prompt = input.promptTokens
  const steps = input.band.steps
  const growth = input.band.growth
  const sent = (step: number) => prompt + (step - 1) * growth
  const last = sent(steps)
  if (!(Number.isInteger(steps) && steps >= 1 && growth >= 0 && Number.isFinite(last))) return Number.NaN
  // The first step past a threshold that the last step passes: the quotient's floor, corrected by one step either way,
  // so a rounded quotient never moves a run's boundary off the strict comparison priceAt makes.
  const past = (threshold: number) => {
    if (prompt > threshold) return 1
    const guess = Math.floor((threshold - prompt) / growth) + 2
    if (sent(guess - 1) > threshold) return guess - 1
    return sent(guess) > threshold ? guess : guess + 1
  }
  const starts = [
    ...new Set([1, ...(input.price.tiers ?? []).filter((tier) => last > tier.above).map((tier) => past(tier.above))]),
  ].toSorted((a, b) => a - b)
  return starts.reduce((total, first, index) => {
    const end = (starts[index + 1] ?? steps + 1) - 1
    const rates = priceAt(input.price, sent(first))
    const count = end - first + 1
    // The run's tokens, Σ L(k) over first..end, and its reads over the steps from max(first, 2) on.
    const tokens = count * prompt + (growth * (end * (end - 1) - (first - 1) * (first - 2))) / 2
    const from = Math.max(first, 2)
    const reading = end - from + 1
    const cached =
      rates.cacheRead === undefined || input.reads === "none" || reading < 1
        ? 0
        : input.reads === "prompt"
          ? reading * prompt
          : reading * prompt + (growth * ((end - 1) * (end - 2) - (from - 2) * (from - 3))) / 2
    const write = input.write === "cache-write" ? (rates.cacheWrite ?? rates.input) : rates.input
    return (
      total +
      usd(tokens - cached, write) +
      usd(cached, rates.cacheRead ?? 0) +
      usd(count * input.outputPerStep, rates.output)
    )
  }, 0)
}

// VS-19 operates on whole admitted changes. The planner never reads project files or lets
// PR text describe tasks. Only file identities, sizes and dependency group memberships survive.
export interface ReviewBatch {
  readonly id: string
  readonly paths: readonly string[]
  readonly changedLines: number
  readonly diffChars: number
}
export interface ReviewBatchPlan {
  readonly id: string
  readonly base: string
  readonly head: string
  readonly batches: readonly ReviewBatch[]
  readonly omitted: readonly string[]
  readonly clusters: readonly (readonly string[])[]
}

type BatchLimits = Pick<ReviewConfig, "maxFiles" | "maxChangedLines" | "maxDiffChars">

export function planReviewBatches(input: {
  base: string
  head: string
  files: readonly DiffFile[]
  limits: BatchLimits
  policy?: string
  clusters?: ReadonlyMap<string, string>
  dependents?: ReadonlyMap<string, number>
}): ReviewBatchPlan {
  const { base, head, limits } = input
  const commit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
  if (!commit.test(base) || !commit.test(head)) throw new Error("Batch coverage requires full commit IDs.")
  const caps = [limits.maxFiles, limits.maxChangedLines, limits.maxDiffChars]
  if (!caps.every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error("Invalid batch limit.")
  if (new Set(input.files.map((file) => file.path)).size !== input.files.length)
    throw new Error("Duplicate changed path in a review batch plan.")
  const ordered = orderByRiskDensity(input.files, input.dependents)
  const groups = new Map<string | DiffFile, DiffFile[]>()
  for (const file of ordered) {
    const key = input.clusters?.get(file.path) ?? file
    const group = groups.get(key)
    if (group) group.push(file)
    else groups.set(key, [file])
  }
  // Review files in density order, keeping the members of each impact cluster together as far as the caps allow.
  const omitted: string[] = []
  const batches: ReviewBatch[] = []
  const identity: string[] = []
  let current = { paths: [] as string[], changedLines: 0, diffChars: 0 }
  const flush = () => {
    if (!current.paths.length) return
    batches.push(
      Object.freeze({
        ...current,
        paths: Object.freeze(current.paths),
        id: sha256(JSON.stringify([base, head, batches.length, current.paths])),
      }),
    )
    current = { paths: [], changedLines: 0, diffChars: 0 }
  }
  for (const group of groups.values()) {
    const members = []
    for (const file of group) {
      const patch = renderPatch([file])
      const lines = file.additions + file.deletions
      const complete =
        !file.binary &&
        [file.additions, file.deletions].every((n) => Number.isSafeInteger(n) && n >= 0) &&
        file.hunks.reduce((n, h) => n + h.lines.filter((line) => line.kind === "add").length, 0) === file.additions &&
        file.hunks.reduce((n, h) => n + h.lines.filter((line) => line.kind === "del").length, 0) === file.deletions
      identity.push(
        sha256(JSON.stringify([file.path, file.oldPath, file.status, file.additions, file.deletions, sha256(patch)])),
      )
      if (!complete || limits.maxFiles === 0 || lines > limits.maxChangedLines || patch.length > limits.maxDiffChars) {
        omitted.push(file.path)
        continue
      }
      members.push({ path: file.path, lines, chars: patch.length })
    }
    const groupLines = members.reduce((sum, member) => sum + member.lines, 0)
    const groupChars = members.reduce((sum, member) => sum + member.chars, Math.max(0, members.length - 1))
    if (
      members.length <= limits.maxFiles &&
      groupLines <= limits.maxChangedLines &&
      groupChars <= limits.maxDiffChars &&
      (current.paths.length + members.length > limits.maxFiles ||
        current.changedLines + groupLines > limits.maxChangedLines ||
        current.diffChars + 1 + groupChars > limits.maxDiffChars)
    )
      flush()
    for (const member of members) {
      if (
        current.paths.length >= limits.maxFiles ||
        current.changedLines + member.lines > limits.maxChangedLines ||
        current.diffChars + Number(current.paths.length > 0) + member.chars > limits.maxDiffChars
      )
        flush()
      current.diffChars += Number(current.paths.length > 0) + member.chars
      current.changedLines += member.lines
      current.paths.push(member.path)
    }
  }
  flush()
  const clusters = [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => Object.freeze(group.map((file) => file.path)))
  const id = sha256(
    JSON.stringify([
      1,
      base,
      head,
      caps,
      input.policy ?? "",
      identity,
      batches.map((batch) => batch.id),
      omitted,
      clusters,
    ]),
  )
  return Object.freeze({
    id,
    base,
    head,
    batches: Object.freeze(batches),
    omitted: Object.freeze(omitted),
    clusters: Object.freeze(clusters),
  })
}
