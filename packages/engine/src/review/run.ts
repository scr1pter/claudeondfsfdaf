// Review.run (section 3.8): one read-only session per specialist, with Vector's own step, dollar and time limits, a
// finalize prompt for a session stopped early, a verify pass, then selection and cost. The engine's agent `steps`
// limit only adds text-only prompt guidance, which conflicts with this runner's required StructuredOutput tool.
// Review admits each provider attempt, including retries, and one separate finalizer. Dollar reservations are
// estimates; reported usage can exceed them, so they are not a hard billing cap. An eval projection (VS-21b,
// ReviewEval.project) may run what the dollar cap alone refuses, against a fake provider on this computer; nothing
// else sets it, and unset it changes nothing. Under privacy "zdr" (VS-23b) admission also holds every model and every
// provider attempt to the route rules (route.ts), before any reservation; a refusal stops the review unreviewed. Under
// holdback "secrets" (VS-34, SF-13b) the prompts leave out credential files and carry redacted values (holdback.ts),
// and (SF-14) the sessions' rules deny the read tool the credential files and the held paths, and the read, grep and
// glob tools redact what they return.

import path from "path"
import { Brain } from "@vectordevai/core/brain/brain"
import { Database } from "@vectordevai/core/database/database"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { publicCardGrant, takeCards } from "./card-access"
import { isDeepStrictEqual } from "node:util"
import { ReadOnlyGit } from "@vectordevai/core/read-only-git"
import { Billing } from "@vectordevai/schema/billing"
import { Cause, Deferred, Duration, Effect, Exit, Option, Scope } from "effect"
import type { EventV2 } from "@vectordevai/core/event"
import { SessionV1 } from "@vectordevai/core/v1/session"
import type { PermissionV1 } from "@vectordevai/core/v1/permission"
import {
  anchorText,
  budgetDiff,
  buildAnchorIndex,
  explicitPatchPaths,
  lookupFile,
  renderPatch,
  resolveAnchor,
  type DiffFile,
} from "@vectordevai/core/review/diff"
import { strictSelect } from "@vectordevai/core/review/guardrail"
import type { ScopeDrop } from "@vectordevai/core/review/guardrail"
import { strictReviewConfig } from "@vectordevai/core/review/config"
import {
  decideDispatch,
  estimateDispatch,
  remainingUsd,
  shrinkStepCap,
  type DispatchEstimate,
  type PassPlan,
  type Shrink,
} from "@vectordevai/core/review/dispatch"
import { fingerprint, normalizeCode, normalizeTitle } from "@vectordevai/core/review/fingerprint"
import { heldReason, holdbackContext, holdbackFiles, holdbackText, safeRulePrompt } from "@vectordevai/core/review/holdback"
import {
  IMPACT_LIMITS,
  impactRecord,
  orderImpactFiles,
  shrinkImpactDependents,
  type ImpactRecord,
} from "@vectordevai/core/review/impact"
import { checkedLabs, noteJudgeUnfinished, reviewModels } from "@vectordevai/core/review/second-lab"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { isFreeModel } from "@vectordevai/schema/free-model"
import {
  codeSpan,
  BUDGET_ESTIMATE_UNAVAILABLE,
  BUDGET_REQUEST_CHANGED,
  formatTokens,
  formatUsd,
  noteBudgetEstimate,
  noteHeldBack,
  noteIgnoreUnchecked,
  noteIgnoredCommitted,
  notePrivacyRefused,
  noteRedacted,
  noteTrivialSkip,
  noteTriageFixedUnchecked,
  noteTriageUnchecked,
  noteVerifySkipped,
  noteVerifyUnfinished,
} from "@vectordevai/core/review/format"
import { classifyPath, isSensitivePath } from "@vectordevai/core/review/ignore"
import {
  assessReview,
  evidenceScope,
  modelEvidenceNotes,
  type ModelCertificate,
  type ModelSubject,
} from "@vectordevai/core/review/model-evidence"
import { reviewPermissionRules } from "@vectordevai/core/review/permission"
import { evidencePath, packChanges, verifyHeadFiles } from "@vectordevai/core/review/pack"
import {
  combineCostKinds,
  diffBudgetChars,
  estimateCostUsd,
  NEXT_STEP_SLACK,
  OUTPUT_PER_STEP,
  nextStepCostUsd,
  planDepth,
  planSpecialists,
  verifyCandidates,
  verifyUnanswered,
  verifyUnconfirmed,
  type ReviewPrice,
} from "@vectordevai/core/review/plan"
import {
  buildFinalizePrompt,
  buildLensPrompt,
  buildJudgePrompt,
  buildReviewPrompt,
  buildSecurityPrompt,
  buildVerifyPrompt,
  impactNote,
  SCOPE,
  PINNED_SESSION_PREFIX,
  VECTORSCOPE_AGENT,
  type PromptInput,
} from "@vectordevai/core/review/prompt"
import {
  decodeReport,
  decodeVerify,
  ESCAPING_PATH,
  MAX_QUOTE_CHARS,
  MAX_TRACE_QUOTES,
  MAX_FINDING_QUOTES,
  strictReportJsonSchema,
  verifyCertJsonSchema,
  REVIEW_REPORT_JSON_SCHEMA,
  VERIFY_JSON_SCHEMA,
} from "@vectordevai/core/review/schema"
import { trustedRules } from "@vectordevai/core/review/citation"
import type { RulePart } from "@vectordevai/core/review/config"
import {
  checkedRuleFindings,
  ruleCheckNotes,
  sameFinding,
  selectFindings,
  wantsNits,
  type RuleCounts,
} from "@vectordevai/core/review/select"
import type { RouteRefusal } from "@vectordevai/core/review/privacy"
import { LENS_LIMITS, type ReviewLens } from "@vectordevai/core/review/types"
import type {
  CostKind,
  Finding,
  FocusHunk,
  ModelFinding,
  ModelReport,
  PriorFinding,
  ReviewConfig,
  ReviewCost,
  ReviewOutcome,
  ReviewPass,
  Risk,
  SkippedFile,
  Trigger,
  Trust,
} from "@vectordevai/core/review/types"
import { measureCost, reviewUsageMessages } from "@/cli/cmd/github.evidence"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { SessionPrompt } from "@/session/prompt"
import { SessionAdmission } from "@/session/admission"
import type { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { ProviderV2 } from "@vectordevai/core/provider"
import { Truncate } from "@/tool/truncate"
import { EffectBridge } from "@/effect/bridge"
import { MCP } from "@/mcp"
import { ReviewMcpSnapshot } from "./mcp-snapshot"
import { InstanceState } from "@/effect/instance-state"
import { readAuthority, type ReadAuthority } from "./read-authority"
import type { ResolvedModel } from "./model"
import { ReviewRoutes } from "./route"
import { ReviewSessionAdmission } from "@vectordevai/core/review/session-admission"
import { ReviewTrivial } from "./trivial"
import { ReviewImpact } from "./impact"
import { ReviewDepth } from "./depth"
import { activeReviewBatch, exceedsBatchLimits, finishReviewBatch, type ReviewBatchStore } from "./batch"
import { orderByRiskDensity, riskFeatures, riskOf } from "@vectordevai/core/review/risk"
import {
  checkStrict,
  decodeStrictVerify,
  decodeCertificateAnswers,
  containsHeldValue,
  type CertificateAnswer,
} from "./strict"
import { offlineChecks, redactDiagnosticData } from "./checks"
import { diagnosticReference, withDiagnosticEvidence } from "@vectordevai/core/review/diagnostic"

export interface RunInput {
  batchStore?: ReviewBatchStore
  /** A prior durable batch still owns this target’s cumulative spend. */
  accountBatchSpend?: true
  /** A trusted same-head checkpoint keeps its cost and coverage checks even if new size caps fit everything. */
  continuingBatch?: true
  /** Only an explicit new batch run discards its cursor; another policy may require a full diff. */
  restartBatch?: boolean
  parentID?: SessionID
  directory: string
  trigger: Trigger
  trust: Trust
  base: string // the merge-base
  head: string
  since?: string
  mode: "full" | "incremental"
  /** A requested full review bypasses the trivial policy. A first review also has mode "full". */
  forceFull?: boolean
  /** Issued for the exact committed diff by the private local or replay collector. */
  trivialProof?: ReviewTrivial.Proof
  /** Staged or working-tree changes have no committed head for graph context or strict evidence. */
  uncommittedDiff?: true
  /** Compatibility with the original graph-only flag. */
  impactWorktree?: true
  files: DiffFile[] // the PR diff for the model, classified and filtered
  anchors: DiffFile[] // the diff findings are anchored against
  focus?: FocusHunk[]
  skipped: SkippedFile[]
  headFiles?: { path: string; text: string; exact: boolean }[]
  selectedCards?: import("./context").CardGrant
  localCardEvaluation?: true
  context: Pick<
    PromptInput,
    "related" | "history" | "requirements" | "instructions" | "teamDismissed" | "humanComments"
  >
  pr?: PromptInput["pr"]
  prior: PriorFinding[]
  rules: string
  ruleParts?: readonly RulePart[]
  config: ReviewConfig
  /** Trusted prior spend for the PR and calendar month, when the caller keeps those ledgers. */
  spent?: { prUsd?: number; monthUsd?: number }
  model: ResolvedModel
  // A cheaper model for the review and security passes. The double-check then runs on `model` for every finding
  // above a nit, even with verify "off", and only the findings it confirmed are reported. Without one, a review on
  // Vector Codium runs the plan's review pair (WP A35, second-lab.ts).
  triage?: ResolvedModel
  // review.json's judgeModel for the panel, resolved by the caller. When it is absent and the panel is on, the runner
  // resolves judgeModel itself, or uses the plan's panel judge on Vector Codium.
  judge?: ResolvedModel
  allowDirs?: string[]
  checks?: boolean
  readDenies?: readonly string[]
  readRoot?: string
  /** Frozen internal authority admitted before asynchronous adapter setup. */
  admittedReads?: ReadAuthority
  instructionsFromContext?: true
  /** The shared service uses its own helper; legacy adapters retain their specialists. */
  identity?: "vectorscope"
  /** An owning cloud run can stop every specialist without discarding completed reports. */
  stopSignal?: AbortSignal
  knownPath: (path: string) => Promise<boolean>
  onProgress?: (
    e:
      | { type: "specialist"; name: string; status: string }
      | { type: "cost"; costUsd: number; kind?: CostKind; codium?: boolean },
  ) => void
  onCheckpoint?: (spent: ReviewCost) => Promise<void>
  baseRef?: string // the base branch name, for the prompt
  rulesSource?: PromptInput["rulesSource"] // defaults to the working tree for local and desktop runs
  inlinePosted?: number // state.inlinePosted, for the per-PR inline cap
  // The eval's view of the run (ReviewEval.replay): each pass's prompt and every provider attempt, admitted or
  // refused, with what it settled at. Off unless set, and observing changes nothing the review does.
  observe?: (event: Observation) => void
  // The certificates model evidence (VS-07) compares the models with when config.modelEvidence is "warn":
  // MODEL_EVIDENCE when absent. The eval and tests pass their own.
  certificates?: readonly ModelCertificate[]
  // VS-21b: asked about each decision the dollar cap would refuse. Off unless set, and only ReviewEval.project sets
  // it, after refusing any provider that sends off this computer.
  projection?: Projection
  // VS-34 item 4: the changed paths the repository's ignore rules exclude although committed, which the collector
  // asks git for (ReviewGit.ignoredPaths) under holdback "secrets" only. Absent means it was not checked, which the
  // review notes; Review.run itself makes no git call.
  ignored?: readonly string[]
}

type Name = ReviewOutcome["specialists"][number]["name"]
// "privacy": the route rules refused the model or the attempt (VS-23b).
type Stop = "budget" | "steps" | "timeout" | "privacy"
type Phase = "turn" | "finalize"

interface PassIdentity {
  name: Name
  lens?: ReviewLens
}

// Labels identify model roles to callers. Each concurrent lens still owns its own reservation and first-turn lease.
const passKey = (pass: PassIdentity) => pass.lens ?? pass.name
const lensField = (pass: { lens?: ReviewLens }) => (pass.lens ? { lens: pass.lens } : {})

// A decision the review's dollar cap would refuse, and where it was made: before a pass's session ("pass"), at a
// provider attempt ("attempt"), at the finalizer's reservation ("finalizer"), or at verify's pre-check ("verify").
// `sessionID` is the pass's session, at an attempt and at the finalizer's reservation.
export interface OverCap {
  pass: Name
  lens?: ReviewLens
  phase: Phase
  site: "pass" | "attempt" | "finalizer" | "verify"
  // The whole amount that went over the cap, which a lifted decision admits: at "pass" and at a turn's "attempt", the
  // turn's estimate plus the finalizer share reserved beside it; at "finalizer", a finalizing "attempt" and "verify",
  // which reserve no finalizer share, the estimate alone.
  estimateUsd: number
  sessionID?: SessionID
}

// VS-21b. ReviewEval.project runs the review against a fake provider on this computer, so the dollar cap must not cut
// a pass short there. `overCap` is asked only about a decision the cap would refuse, never about one it admits, a step
// or time stop, or an uncapped review. True runs it anyway, and its reservation is kept like any other; false, or a
// projection that throws, refuses it as the cap would.
export interface Projection {
  overCap: (decision: OverCap) => boolean
}

export type Observation =
  | { type: "strict-candidates"; findings: Finding[]; unanswered: string[] }
  | { type: "scope-drops"; base: string; drops: ScopeDrop[] }
  | { type: "impact"; record: ImpactRecord; locations: string[] }
  | { type: "dispatch"; estimate: DispatchEstimate; step?: Shrink }
  // A pass is about to run with this prompt and step cap, or was planned and skipped (verify with no budget or time
  // left).
  | { type: "pass"; pass: Name; lens?: ReviewLens; model: string; text: string; maxSteps: number }
  // One provider attempt the review's admission was asked for, retries included. A refused one was never sent.
  | {
      type: "attempt"
      pass: Name
      lens?: ReviewLens
      phase: Phase
      admitted: boolean
      stop?: Stop
      estimateUsd: number
      sessionID?: SessionID
      model?: { providerID: string; modelID: string; api: string; npm: string }
    }
  // What an admitted attempt settled at; incomplete usage keeps its estimate as uncertain spend.
  | {
      type: "settle"
      pass: Name
      lens?: ReviewLens
      phase: Phase
      costUsd: number
      complete: boolean
      tokens?: { input: number; output: number }
    }
type Progress = Parameters<NonNullable<RunInput["onProgress"]>>[0]

interface Track extends PassIdentity {
  sessionID: SessionID
  price?: ReviewPrice // set when this session's model is priced and the review has a dollar cap
  cost?: Provider.Model["cost"] // actual invocation rates, including its long-context tiers
  cap: number
  steps: number
  seen: Set<string>
  context: number // tokens the last step sent, cached ones included
  cached: number // of which the provider reported as cache reads
  stop?: Stop
  attempts: number // invocation admission counts retries and missing-usage failures, independently of steps
  finalizeAttempts: number
  finalizing: boolean
  denied: boolean
}

interface Spec<T> extends PassIdentity {
  model: ResolvedModel
  cap: number
  text: string
  schema: Record<string, unknown>
  decode: (value: unknown) => T | undefined
}

// A session runtime can supply this only when it can prepare the same complete first request without
// creating the session, running tools or contacting a provider. The conditional passes have no model
// output yet: they need a bound for every candidate/check payload the runtime would admit, including
// their head files. Measuring just their fixed instructions does not provide that bound.
export type ReviewRequestAccounting = Pick<SessionPrompt.Interface, "reviewFirstRequest">

type PlannedRequest = Pick<Spec<unknown>, "name" | "lens" | "model" | "cap" | "text" | "schema">

// Only the initial measurement and changes that actually reduce a binding limit are recorded. A cap
// changes admission's step count, never the first request: it needs no second pass through preparation.
function dispatchPlan(input: {
  requests: PlannedRequest[]
  dependents: boolean
  lenses: boolean
  cards: boolean
  dropLenses: () => PlannedRequest[]
  shrink: (lever: "cards" | "diff" | "dependents") => Iterable<{ requests: PlannedRequest[]; accept: () => void }>
  measure: (requests: PlannedRequest[]) => Effect.Effect<PassPlan[] | undefined>
  limits: { maxInputTokens: number; remainingUsd?: number }
  observe: (event: Extract<Observation, { type: "dispatch" }>) => void
}) {
  return Effect.gen(function* () {
    const initial = yield* input.measure(input.requests)
    if (!initial) return { decision: "unknown" as const, notes: [] }
    let plans = initial
    let estimate = estimateDispatch(plans)
    // Observers may retain and mutate their input. The admission decision and the prices used by later
    // shrink steps must stay independent of the replay's copy.
    input.observe({ type: "dispatch", estimate: structuredClone(estimate) })
    const available = new Set<Shrink>(["diff"])
    if (input.dependents) available.add("dependents")
    if (input.lenses) available.add("lenses")
    if (input.cards) available.add("cards")
    for (const plan of plans) {
      if (plan.pass === "review" || plan.pass === "security" || plan.pass === "verify")
        available.add(`steps:${plan.pass}`)
    }
    const notes: string[] = []
    for (;;) {
      const decision = decideDispatch(estimate, { ...input.limits, available: [...available] })
      if (decision.go) return { decision: "go" as const, plans, estimate, notes }
      if (decision.ineffective.length) {
        const passes = decision.ineffective.map((lever) => lever.replace("steps:", "")).join(", ")
        notes.push(`Lowering the step limits for ${passes} would leave the review over budget.`)
      }
      for (const lever of decision.ineffective) available.delete(lever)
      if ("stop" in decision) return { decision: "stop" as const, estimate, notes }
      const lever = decision.shrink
      available.delete(lever)
      if (lever === "lenses") {
        // Removing the lenses also changes whether verification is needed and its future candidate bound.
        const next = yield* input.measure(input.dropLenses())
        if (!next) return { decision: "unknown" as const, notes }
        plans = next
        notes.push("The single-class lens passes were removed to fit the review budget.")
      } else if (lever === "cards" || lever === "dependents" || lever === "diff") {
        // Try progressively smaller context without changing what any specialist sees until a measured
        // proposal actually lowers a binding limit. Preserve the step caps admitted in preceding rounds.
        const caps = new Map(plans.map((plan) => [plan.pass, plan.maxSteps]))
        let accepted = false
        for (const proposal of input.shrink(lever)) {
          const reduced = yield* input.measure(proposal.requests)
          if (!reduced) return { decision: "unknown" as const, notes }
          const next = reduced.map((plan) => ({ ...plan, maxSteps: caps.get(plan.pass) ?? plan.maxSteps }))
          const candidate = estimateDispatch(next)
          const lowersLimit =
            (decision.over.includes("input-tokens") && candidate.firstTurnTokens < estimate.firstTurnTokens) ||
            (decision.over.includes("usd") && candidate.usd && estimate.usd && candidate.usd.low < estimate.usd.low)
          if (!lowersLimit || next.some((plan, index) => plan.promptTokens > plans[index]!.promptTokens)) continue
          plans = next
          proposal.accept()
          accepted = true
          break
        }
        if (!accepted) {
          if (lever === "diff")
            notes.push(
              "Trimming the surrounding file context could not reduce the overage without growing a planned request.",
            )
          continue
        }
        if (lever === "dependents") available.add("dependents")
        notes.push(
          lever === "diff"
            ? "Coverage was reduced to changed hunks. Surrounding file context was trimmed."
            : lever === "cards"
              ? "Brain context cards were removed to fit the review budget."
              : "The lowest-ranked dependent context was removed to fit the review budget.",
        )
      } else {
        const pass = lever === "steps:verify" ? "verify" : lever === "steps:security" ? "security" : "review"
        plans = shrinkStepCap(plans, pass)
        notes.push(
          `The ${pass} pass was limited to ${plans.find((plan) => plan.pass === pass)!.maxSteps} steps to fit the review budget.`,
        )
      }
      estimate = estimateDispatch(plans)
      input.observe({ type: "dispatch", step: lever, estimate: structuredClone(estimate) })
    }
  })
}

interface Asked<T> extends PassIdentity {
  sessionID?: SessionID
  value?: T
  status: ReviewOutcome["specialists"][number]["status"]
  stop?: Stop // includes a request refused before admission
  steps: number
  detail?: string
}

type Sent = { timedOut: true } | { timedOut: false; message?: SessionV1.WithParts; contextError?: string }

const VERIFY_STEPS = 10
/**
 * The review token stop for Vector Codium (codium-tiers.md §3: 400K tokens per review, about five times a measured
 * review). Codium steps have no price, so the dollar cap never stops them; the check and the panel's judge start only
 * while the review's own passes so far, plus the next pass's prompt, stay under it. It counts new input, output,
 * reasoning and cache writes (cache reads are left out), stays inside the runner and is never shown. It only protects
 * the buyer's month: the gateway's pool, daily limit and caps are the real limits. The 2M-per-PR daily stop needs the
 * pull request's state and is not here.
 */
export const CODIUM_REVIEW_TOKEN_STOP = 400_000
const FINALIZE_MS = 90_000
const VERIFY_MIN_MS = 2 * 60_000
const DENY_ALL: PermissionV1.Rule = { permission: "*", pattern: "*", action: "deny" }
const ALLOW_OUTPUT: PermissionV1.Rule = { permission: "StructuredOutput", pattern: "*", action: "allow" }

export const run: (
  input: RunInput,
) => Effect.Effect<
  ReviewOutcome,
  never,
  | Session.Service
  | SessionPrompt.Service
  | Permission.Service
  | EventV2Bridge.Service
  | Provider.Service
  | SpendGuard.Service
> = (input) => {
  const result = execute(input)
  return input.config.diagnostics === "offline" ? result.pipe(Effect.map((outcome) => redactDiagnosticData(outcome))) : result
}

const execute = Effect.fn("Review.run")(function* (input: RunInput) {
  const sessions = yield* Session.Service
  const guard = yield* SpendGuard.Service
  const prompts = yield* SessionPrompt.Service
  const permission = yield* Permission.Service
  const events = yield* EventV2Bridge.Service

  const provider = yield* Provider.Service

  const started = Date.now()
  const deadline = started + input.config.timeoutMinutes * 60_000
  const inversion = input.model.inversion ?? input.triage?.inversion ?? input.judge?.inversion
  const requested = strictReviewConfig(inversion ? { ...input.config, privacy: "zdr" as const } : input.config)
  const config =
    requested.cards === "brain" &&
    input.trigger !== "local" &&
    !(input.localCardEvaluation && publicCardGrant(input.selectedCards, input))
      ? { ...requested, cards: "off" as const }
      : requested
  const strictMode = config.guardrail === "strict"
  const uncommitted = !!(input.uncommittedDiff || input.impactWorktree)
  // VS-34 (holdback "secrets"): credential files held back whole, and secret-shaped values redacted in every
  // untrusted block the prompts quote (holdback.ts). Only what the model is shown changes: anchors, the plan, stats,
  // findings' suggestions and review state keep the change as it is. Unset, nothing here runs.
  const diagnostics = config.diagnostics === "offline"
  // A diagnostics run never sends evidence alongside the raw value it found. Use the existing payload and tool
  // holdback, including on unsupported hosts, and rely on the caller's supplied review rules for this session.
  if (diagnostics) {
    const { observe, onProgress } = input
    input = {
      ...input,
      instructionsFromContext: true,
      ...(observe ? { observe: (event) => observe(redactDiagnosticData(event)) } : {}),
      ...(onProgress ? { onProgress: (event) => onProgress(redactDiagnosticData(event)) } : {}),
    }
  }
  const hold = config.holdback === "secrets" || diagnostics ? holdback(input) : undefined
  if (config.trivial === "skip" && !input.forceFull && input.trivialProof) {
    // Only the complete diff can justify skipping every reviewer. A filtered model payload, withheld reads,
    // or a failed proof keeps the normal review path. The GitHub job has no proof until its posting path handles skips.
    const whole =
      input.trust === "trusted" &&
      !uncommitted &&
      !input.skipped.length &&
      !input.ignored?.length &&
      !input.admittedReads?.patterns.length &&
      !input.readDenies?.length &&
      !input.stopSignal?.aborted &&
      isDeepStrictEqual(input.files, input.anchors)
    if (whole && !hold?.held.length && !hold?.redactions.length && (!hold || input.ignored)) {
      const kinds = yield* ReviewTrivial.kinds(input.trivialProof, {
        directory: input.directory,
        base: input.base,
        head: input.head,
        files: input.anchors,
        config: input.config, // The collector bound this exact policy, before reviewer-only settings are applied.
      })
      if (kinds?.length && !input.stopSignal?.aborted) {
        const strict = strictMode
          ? strictSelect([], {
              head: input.head,
              anchors: input.anchors,
              trust: input.trust,
              verifier: nameOf(input.model),
              unanswered: [],
              coverage: { unreviewed: [], skipped: [], specialists: [] },
              blobs: { head: new Map(), base: new Map() },
              config: { guardrail: "strict", maxComments: config.maxComments, suggestions: config.suggestions },
            })
          : undefined
        return {
          trivial: true,
          report: { summary: "", risk: "low", files: [], findings: [] },
          selection: {
            ...selectFindings({
              findings: [],
              anchors: input.anchors,
              head: input.head,
              trust: input.trust,
              mode: input.mode,
              config,
              prior: input.prior,
            }),
            ...(strict ? { strict: strictSummary(strict) } : {}),
          },
          ...(strict ? { strict } : {}),
          skipped: [],
          base: input.base,
          head: input.head,
          ...(input.since ? { since: input.since } : {}),
          mode: input.mode,
          unreviewed: [],
          specialists: [],
          sessions: [],
          stats: changeStats(input.files),
          notes: [noteTrivialSkip()],
          durationMs: Date.now() - started,
        } satisfies ReviewOutcome
      }
    }
  }
  let dollarLimit = config.maxCostUsd
  const priceOf = (model: ResolvedModel) => (model.costKind === "priced" && dollarLimit > 0 ? model.price : undefined)
  // VS-23b: under privacy "zdr" every model a pass may use needs a route the rules allow (route.ts), checked before any
  // session: the models' own refusals first, before the Codium listing or review.json's judgeModel is looked up, then
  // where each chosen model sends. Each pass's session and every provider attempt are checked again below.
  const route = ReviewRoutes.policyOf(config)
  const zdr = route.privacy === "zdr"
  const early = zdr
    ? [
        input.model,
        ...(input.triage ? [input.triage] : []),
        ...(input.judge ? [input.judge] : []),
        ...(config.panel && !input.judge && config.judgeModel ? [Provider.parseModel(config.judgeModel)] : []),
      ].flatMap((item) => {
        const refusal = ReviewRoutes.modelRefusal(item, route)
        return refusal ? [{ model: nameOf(item), refusal }] : []
      })[0]
    : undefined
  // WP A35: the models the passes run on. A review on Vector Codium without a triageModel runs the plan's review pair,
  // a same-lab pair runs one pass, and the panel adds a judge from a third lab.
  const picked = early
    ? { model: input.model, triage: input.triage, judge: input.judge, notes: [] }
    : yield* chooseModels(input, provider)
  const model = picked.model
  const triage = picked.triage ?? model
  const triaged = nameOf(triage) !== nameOf(model)
  const judgeModel = picked.judge
  const granted =
    config.cards === "brain" &&
    (input.trigger === "local" || (input.localCardEvaluation && publicCardGrant(input.selectedCards, input)))
      ? takeCards(input.selectedCards, input)
      : undefined
  const privateServices = granted?.items.some((row) => row.personal)
    ? {
        brain: Option.getOrUndefined(yield* Effect.serviceOption(Brain.Service)),
        db: Option.getOrUndefined(yield* Effect.serviceOption(Database.Service)),
        audience: Option.getOrUndefined(yield* Effect.serviceOption(SessionAudience.Service)),
      }
    : undefined
  const audience = privateServices?.audience ?? (privateServices?.db && SessionAudience.make(privateServices.db))
  const brain = privateServices?.brain
  const privateAllowed =
    !!granted?.eligible &&
    !!brain &&
    !!audience &&
    !input.parentID &&
    !input.instructionsFromContext &&
    !input.localCardEvaluation &&
    input.trust === "trusted" &&
    [model, triage, ...(judgeModel ? [judgeModel] : [])].every((chosen) => granted.models.includes(nameOf(chosen)))
  const cards = granted?.items.filter((row) => !row.personal || privateAllowed).slice(0, 3) ?? []
  let privateCardIds = cards.filter((row) => row.personal).map((row) => row.id)
  // Each session with personal cards must use the exact route checked when its grant was issued.
  // Snapshot the policy so a later edit cannot broaden the transport's registration.
  const privatePolicy: ReviewRoutes.Policy | undefined = privateCardIds.length
    ? { privacy: "zdr", attested: structuredClone(zdr ? route.attested : []) }
    : undefined
  const policyFor = () => (privateCardIds.length && privatePolicy ? privatePolicy : route)
  const chosenModels = [model, ...(triaged ? [triage] : []), ...(judgeModel ? [judgeModel] : [])]
  const decided = early
    ? []
    : yield* Effect.forEach(
        policyFor().privacy === "zdr" ? chosenModels : [],
        (chosen) =>
          ReviewRoutes.decide(provider, chosen, policyFor()).pipe(Effect.map((result) => ({ chosen, result }))),
      )
  // The first model or attempt the route rules refused (VS-23b), seeded here. Once set no pass starts another attempt.
  const refusedUpFront: { model: string; refusal: RouteRefusal } | undefined =
    early ??
    decided.flatMap((entry) =>
      entry.result.decision.allowed ? [] : [{ model: nameOf(entry.chosen), refusal: entry.result.decision.refusal }],
    )[0]
  // The dollar cap applies when any pass runs on a priced model.
  let capped =
    priceOf(model) !== undefined ||
    priceOf(triage) !== undefined ||
    (judgeModel !== undefined && priceOf(judgeModel) !== undefined)
  const heldPaths = new Set(hold?.held.flatMap((file) => [file.path, ...(file.oldPath ? [file.oldPath] : [])]))
  // The saved long outputs hold every session the user ever ran, so a review of someone else's pull request, which its
  // author can steer, cannot read them back; it only loses the cut-off end of a long tool output. Under holdback
  // "secrets" the rules also deny the read tool the credential files and every held path, old paths included (SF-14).
  const authority =
    input.admittedReads ??
    (input.readDenies?.length
      ? readAuthority(input.readDenies, {
          directory: input.directory,
          worktree: (yield* InstanceState.context).worktree,
          ...(input.readRoot ? { readRoot: input.readRoot } : {}),
        })
      : undefined)
  const rules = reviewPermissionRules({
    allowDirs: input.allowDirs,
    checks: input.checks,
    truncateGlob: input.trust === "untrusted" ? undefined : Truncate.GLOB,
    ...(hold ? { holdback: "secrets" as const, held: [...heldPaths] } : {}),
    readDenies: input.admittedReads
      ? input.admittedReads.patternsFor((yield* InstanceState.context).worktree)
      : authority?.patterns,
  })
  let sessionRules = rules
  const reviewed = {
    paths: input.files.map((file) => file.path),
    trust: input.trust,
    ...(input.instructionsFromContext ? { instructions: "provided" as const } : {}),
    ...(input.admittedReads?.patterns.length || input.readDenies?.length ? { restrictedReads: true as const } : {}),
  }
  const firstRequestLimits = new Map<string, number>()
  const tracks = new Map<string, Track>()
  const reservations = new Map<string, { turn: number; finalize: number }>()
  const sessionIDs: SessionID[] = []
  const state = {
    spent: 0,
    reported: 0,
    codium: false,
    ownReported: false,
    uncertain: 0,
    incomplete: false,
    served: [] as string[],
    refused: refusedUpFront,
  }
  const scope = yield* Scope.make()
  const bridge = input.stopSignal ? yield* EffectBridge.make() : undefined
  const previewAborted = config.maxInputTokens && input.stopSignal ? Deferred.makeUnsafe<void>() : undefined
  let previewTimedOut = false
  const stop = () => {
    if (previewAborted) Deferred.doneUnsafe(previewAborted, Exit.void)
    for (const track of tracks.values()) track.stop ??= "timeout"
    // Abort callbacks retain this review's instance and services. Admission below also checks the signal, so
    // a session created concurrently with cancellation cannot start a provider call or a finalizer.
    if (bridge)
      bridge.fork(
        Effect.forEach(sessionIDs, (sessionID) => prompts.cancel(sessionID), { concurrency: "unbounded" }).pipe(
          Effect.ignore,
          Effect.forkIn(scope),
          Effect.asVoid,
        ),
      )
  }
  input.stopSignal?.addEventListener("abort", stop, { once: true })

  const progress = (event: Progress) =>
    Effect.sync(() => input.onProgress?.(event)).pipe(Effect.catchCause(() => Effect.void))
  // Called from inside synchronous admission and settlement, so an observer that throws is dropped here rather than
  // allowed to refuse or leak an attempt.
  const observe = (event: Observation) => {
    if (!input.observe) return
    // Private source text and findings derived from it stay within the fenced owner-local conversation.
    if (privateCardIds.length && (event.type === "pass" || event.type === "strict-candidates")) return
    try {
      input.observe(event)
    } catch {
      return
    }
  }
  // Whether a projection runs a decision the dollar cap refuses. Unset, or throwing, it never does, so the cap holds.
  const lift = (decision: OverCap) => {
    if (!input.projection) return false
    try {
      return input.projection.overCap(decision) === true
    } catch {
      return false
    }
  }

  // Reservations are estimates, not billed spend. Replace this specialist's old reservation in one synchronous
  // operation: parallel specialists must not each spend the same remainder, including a pending finalization.
  const reserve = (
    pass: PassIdentity,
    turn: number,
    finalize: number,
    at: Pick<OverCap, "phase" | "site" | "sessionID">,
  ) => {
    if (!capped) return true
    const others = [...reservations].reduce(
      (total, [owner, amount]) => total + (owner === passKey(pass) ? 0 : amount.turn + amount.finalize),
      0,
    )
    if (
      state.spent + state.uncertain + others + turn + finalize > dollarLimit &&
      !lift({ pass: pass.name, ...lensField(pass), estimateUsd: turn + finalize, ...at })
    )
      return false
    reservations.set(passKey(pass), { turn, finalize })
    return true
  }
  const nextCost = (track: Pick<Track, "context" | "cached" | "price" | "cost">) => {
    const cost = track.cost && Session.costAt(track.cost, track.context + NEXT_STEP_SLACK)
    const price = track.price && ((cost && SpendGuard.priceOf(cost)) ?? track.price)
    return price ? nextStepCostUsd(track.context + NEXT_STEP_SLACK, price, track.cached) : 0
  }
  // Usage is settled by the processor lease before retry/continuation admission. Events only report progress.
  const identities = new Map<string, SessionV1.Assistant>()
  const unsubscribe = yield* events.listen((event) => {
    if (event.type === SessionV1.Event.MessageUpdated.type) {
      const info = (event.data as EventV2.Data<typeof SessionV1.Event.MessageUpdated>).info
      if (info.role === "assistant" && tracks.has(info.sessionID)) identities.set(info.id, info)
      return Effect.void
    }
    if (event.type === SessionV1.Event.PartUpdated.type) {
      const part = (event.data as EventV2.Data<typeof SessionV1.Event.PartUpdated>).part
      const track = tracks.get(part.sessionID)
      if (!track) return Effect.void
      if (part.type !== "step-finish" || track.seen.has(part.id)) return Effect.void
      track.seen.add(part.id)
      track.steps++
      const info = identities.get(part.messageID)
      const codium = Boolean(Billing.of(part) || (info && Billing.of(info)))
      if (codium) state.codium = true
      if (!codium && info && Billing.hasOwnIdentity(info)) {
        state.reported += part.cost
        state.ownReported = true
      }
      return progress({
        type: "cost",
        costUsd: state.reported,
        kind: state.codium && !state.ownReported ? "codium" : "unknown",
        ...(state.codium ? { codium: true } : {}),
      })
    }
    if (event.type === Permission.Event.Asked.type) {
      // Nothing is set to ask, so nothing should; if something does, it is refused rather than left waiting.
      const request = event.data as EventV2.Data<typeof Permission.Event.Asked>
      if (!tracks.has(request.sessionID)) return Effect.void
      return permission
        .reply({ requestID: request.id, reply: "reject" })
        .pipe(Effect.ignore, Effect.forkIn(scope), Effect.asVoid)
    }
    return Effect.void
  })

  const measure = Effect.fnUntraced(function* () {
    const children = (yield* Effect.forEach(sessionIDs, (id) => sessions.children(id))).flat().map((child) => child.id)
    const messages = yield* Effect.forEach([...sessionIDs, ...children], (id) =>
      sessions.messages({ sessionID: id }).pipe(
        Effect.map((messages) => ({ messages, complete: true })),
        Effect.catch(() => Effect.succeed({ messages: [], complete: false })),
      ),
    )
    const recorded = reviewUsageMessages(messages.flatMap((entry) => entry.messages)).filter(
      (message) => message.info.role !== "assistant" || !message.info.forked,
    )
    const measured = measureCost(recorded)
    // Admission can refuse the first request after an empty assistant marker is stored. No admitted attempt
    // means no provider spend; an attempted request without usage must still remain unknown.
    const unused =
      children.length === 0 &&
      [...tracks.values()].every((track) => track.attempts === 0 && track.finalizeAttempts === 0)
    const assistant = recorded.flatMap((message) => (message.info.role === "assistant" ? [message.info] : []))
    const own = assistant.filter(Billing.hasOwnIdentity)
    const codium = assistant.some((message) => Billing.of(message)) || (unused && model.costKind === "codium")
    const unknown = assistant.some((message) => !Billing.of(message) && !Billing.hasOwnIdentity(message))
    const incomplete =
      messages.some((entry) => !entry.complete) ||
      unknown ||
      own.some((message) => message.unpriced || !Number.isFinite(message.cost) || message.cost < 0)
    // Each model a reply came from, with its cost kind when it is one this review chose.
    const chosen = [model, ...(triaged ? [triage] : []), ...(judgeModel ? [judgeModel] : [])]
    const used = [...new Set(assistant.map((message) => `${message.providerID}/${message.modelID}`))]
    state.served = used
    const kinds = [...new Set(own.map((message) => `${message.providerID}/${message.modelID}`))].map(
      (name) => chosen.find((model) => nameOf(model) === name)?.costKind,
    )
    const known = kinds.every((kind) => kind !== undefined)
    return {
      ...(codium ? { codium: true } : {}),
      tokensOwnOnly: true,
      costUsd: measured && Number.isFinite(measured.costUsd) ? measured.costUsd : 0,
      input: measured?.input ?? 0,
      output: measured?.output ?? 0,
      reasoning: measured?.reasoning ?? 0,
      cacheRead: measured?.cacheRead ?? 0,
      cacheWrite: measured?.cacheWrite ?? 0,
      ...((!measured && !unused) || measured?.usageMissing ? { usageMissing: true } : {}),
      kind:
        codium && !own.length && !unknown
          ? "codium"
          : (!measured && !unused) || incomplete || (measured !== undefined && !Number.isFinite(measured.costUsd))
            ? "unknown"
            : !used.length
              ? model.costKind
              : known
                ? combineCostKinds(kinds.filter((kind) => kind !== undefined))
                : (measured?.costUsd ?? 0) > 0
                  ? "priced"
                  : "unknown",
      model: !used.length ? nameOf(model) : known || (codium && !own.length) ? used.join(" + ") : "Multiple models",
    } satisfies ReviewCost
  })

  // What each pass spent, from its own session's recorded messages.
  const passes = Effect.fnUntraced(function* () {
    const measured = yield* Effect.forEach([...tracks.values()], (track) =>
      sessions.messages({ sessionID: track.sessionID }).pipe(
        Effect.map((messages) => {
          const groups = Map.groupBy(
            reviewUsageMessages(messages).filter((message) => message.info.role === "assistant"),
            (message) => {
              const info = message.info as SessionV1.Assistant
              return `${info.providerID}/${info.modelID}/${Billing.of(info) ?? "own"}`
            },
          )
          return [...groups.values()].flatMap((group) => {
            const cost = measureCost(group)
            if (!cost) return []
            const used = `${cost.provider}/${cost.model}`
            const costKind: CostKind = cost.codium
              ? "codium"
              : cost.unknownTurns || cost.unpriced
                ? "unknown"
                : ([model, triage, ...(judgeModel ? [judgeModel] : [])].find((chosen) => nameOf(chosen) === used)
                    ?.costKind ?? (cost.costUsd > 0 ? "priced" : "unknown"))
            return [
              {
                name: track.name,
                ...lensField(track),
                model: used,
                costKind,
                ...(!cost.codium && (costKind === "priced" || (costKind === "unknown" && cost.costUsd > 0))
                  ? { costUsd: cost.costUsd }
                  : {}),
                ...(cost.usageMissing ? { usageMissing: true } : {}),
                input: cost.input + cost.cacheRead + cost.cacheWrite,
                output: cost.output + cost.reasoning,
                cacheRead: cost.cacheRead,
              } satisfies ReviewPass,
            ]
          })
        }),
        Effect.catch(() => Effect.succeed([])),
      ),
    )
    return measured.flat()
  })

  // The review token stop (CODIUM_REVIEW_TOKEN_STOP), only when a pass runs on Vector Codium. History that cannot be
  // read counts as over the stop.
  const onCodium = [model, triage, ...(judgeModel ? [judgeModel] : [])].some((chosen) => chosen.costKind === "codium")
  const tokensUsed = Effect.fnUntraced(function* () {
    const children = (yield* Effect.forEach(sessionIDs, (id) => sessions.children(id))).flat().map((child) => child.id)
    const read = yield* Effect.forEach([...sessionIDs, ...children], (id) =>
      sessions.messages({ sessionID: id }).pipe(Effect.catch(() => Effect.succeed(undefined))),
    )
    if (read.some((messages) => messages === undefined)) return Number.POSITIVE_INFINITY
    const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0)
    return read
      .flatMap((messages) => messages ?? [])
      .reduce((sum, message) => {
        if (message.info.role !== "assistant" || message.info.forked) return sum
        const tokens = message.info.tokens
        return (
          sum + count(tokens?.input) + count(tokens?.output) + count(tokens?.reasoning) + count(tokens?.cache?.write)
        )
      }, 0)
  })
  const overTokenStop = (prompt: string) =>
    onCodium && prompt
      ? tokensUsed().pipe(Effect.map((used) => used + Math.ceil(prompt.length / 3.5) > CODIUM_REVIEW_TOKEN_STOP))
      : Effect.succeed(false)

  const checkpoint = Effect.fnUntraced(function* () {
    const save = input.onCheckpoint
    if (!save) return
    const spent = yield* measure()
    yield* Effect.tryPromise(() => save(spent)).pipe(Effect.ignore)
  })

  const passSession = (pass: PassIdentity) => ({
    title: `Vectorscope review · ${input.head.slice(0, 7)} · ${passKey(pass)}`,
    internal: `${input.instructionsFromContext ? PINNED_SESSION_PREFIX : "vectorscope."}${pass.lens ? `lens.${pass.lens}` : pass.name}`,
    parentID: input.parentID,
    permission: sessionRules,
  })
  const passPrompt = (spec: Pick<Spec<unknown>, "name" | "model" | "schema">, text: string) => ({
    agent: input.identity === VECTORSCOPE_AGENT ? VECTORSCOPE_AGENT : spec.name === "security" ? "security" : "review",
    model: { providerID: spec.model.providerID, modelID: spec.model.modelID },
    ...(spec.model.variant ? { variant: spec.model.variant } : {}),
    format: new SessionV1.OutputFormatJsonSchema({ type: "json_schema", schema: spec.schema, retryCount: 0 }),
    parts: [{ type: "text" as const, text: diagnostics ? holdbackText(text) : text, metadata: { [SCOPE]: reviewed } }],
  })

  // One session: the prompt, and when it was stopped or returned nothing usable, a finalize prompt in the same
  // session with every tool but StructuredOutput denied.
  function ask<T>(spec: Spec<T>): Effect.Effect<Asked<T>> {
    const identity = { name: spec.name, ...lensField(spec) }
    const observedPass = { pass: spec.name, ...lensField(spec) }
    return Effect.gen(function* () {
      if (input.stopSignal?.aborted || previewTimedOut)
        return {
          ...identity,
          status: "stopped",
          stop: "timeout",
          detail: "timeout",
          steps: 0,
        } satisfies Asked<T>
      // Include the structured-output schema and a fixed context allowance. The first turn has no reported usage
      // yet, so this is only an admission estimate; provider usage replaces it as soon as it arrives.
      const context = Math.ceil((spec.text.length + JSON.stringify(spec.schema).length) / 3.5)
      const price = priceOf(spec.model)
      const firstCost = nextCost({ context, cached: 0, price })
      observe({
        type: "pass",
        ...observedPass,
        model: nameOf(spec.model),
        text: spec.text,
        maxSteps: spec.cap,
      })
      // VS-23b: before the session, the pass's model is decided again, and once any model or attempt of the review was
      // refused no pass starts.
      const passRoute = policyFor()
      const decided =
        passRoute.privacy === "zdr" && !state.refused
          ? yield* ReviewRoutes.decide(provider, spec.model, passRoute)
          : undefined
      if (decided && !decided.decision.allowed)
        state.refused = { model: nameOf(spec.model), refusal: decided.decision.refusal }
      if (state.refused) {
        observe({
          type: "attempt",
          ...observedPass,
          phase: "turn",
          admitted: false,
          stop: "privacy",
          estimateUsd: 0,
        })
        return {
          ...identity,
          status: "stopped",
          stop: "privacy",
          detail: "privacy",
          steps: 0,
        } satisfies Asked<T>
      }
      if (!reserve(spec, firstCost, firstCost, { phase: "turn", site: "pass" })) {
        observe({
          type: "attempt",
          ...observedPass,
          phase: "turn",
          admitted: false,
          stop: "budget",
          estimateUsd: firstCost,
        })
        return {
          ...identity,
          status: "stopped",
          stop: "budget",
          detail: "budget",
          steps: 0,
        } satisfies Asked<T>
      }
      // A helper session: it stays out of session lists, and the review reports what it spent.
      const session = yield* sessions.create({
        ...passSession(spec),
        ...(passRoute.privacy === "zdr" ? { metadata: { [ReviewSessionAdmission.ZDR_METADATA]: true } } : {}),
      })
      if (privateCardIds.length) {
        const isolated = yield* Effect.gen(function* () {
          if (
            !brain ||
            !audience ||
            !granted?.eligible ||
            !granted.allowsRoute?.(nameOf(spec.model), passRoute, decided) ||
            !(yield * granted.eligible(privateCardIds))
          )
            return false
          if (input.stopSignal?.aborted || Date.now() >= deadline) return false
          yield* audience.fenceIsolation({ sessionID: session.id, actor: "owner" })
          yield* brain.used(privateCardIds, {
            sessionID: session.id,
            tier: "review",
            tokens: Math.ceil(
              cards
                .filter((row) => row.personal)
                .map((row) => row.text)
                .join(" ").length / 3.5,
            ),
          })
          return true
        }).pipe(
          Effect.catch(() => Effect.succeed(false)),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            () => Effect.succeed(false),
          ),
        )
        if (!isolated) {
          // Still an empty, freshly allocated helper. Keep its id in the receipt if cleanup fails.
          yield* sessions.remove(session.id).pipe(
            Effect.catch(() =>
              Effect.sync(() => {
                sessionIDs.push(session.id)
              }),
            ),
          )
          return {
            ...identity,
            status: "failed",
            steps: 0,
            detail: "Private review context could not be isolated.",
          } satisfies Asked<T>
        }
      }
      const track: Track = {
        ...identity,
        sessionID: session.id,
        ...(price ? { price } : {}),
        cap: spec.cap,
        steps: 0,
        seen: new Set(),
        context,
        cached: 0,
        attempts: 0,
        finalizeAttempts: 0,
        finalizing: false,
        denied: false,
      }
      // The review has its own step, cost and time limits; the run guard's loop rules would pause a specialist that
      // re-reads a file, since review agents never edit one.
      yield* guard.ignoreLoops(session.id)
      tracks.set(session.id, track)
      sessionIDs.push(session.id)
      // The agent every turn of this pass is prompted with (send, below).
      const firstPrompt = passPrompt(spec, spec.text)
      const agent = firstPrompt.agent
      // Every session is registered with the review's policy and its pass's agent, and under "zdr" with the model its
      // pass was decided for and what it was decided on, which admission below and VS-23c's transport backstop
      // (provider.ts) hold each attempt to. Under "zdr" the session runtime (llm.ts) sends only that agent's turns of
      // the session, so no helper request of it goes out. Released when the review ends.
      ReviewRoutes.register(session.id, {
        policy: passRoute,
        agent,
        ...decided,
        ...(privateCardIds.length ? { pinDestinations: true } : {}),
      })
      yield* progress({ type: "specialist", name: passKey(spec), status: "running" })

      // One policy survives every processor instance, retry and prompt for this fresh owned session. It is never
      // rebuilt at a continuation boundary, and the finalizer gets exactly one separately reserved invocation.
      let firstMessageID: string | undefined
      let firstBudgetRefused = false
      const policy: SessionAdmission.Policy = {
        sessionID: session.id,
        admit: (request) => {
          if (firstBudgetRefused) return
          const phase: Phase = track.finalizing ? "finalize" : "turn"
          const attempt = {
            type: "attempt",
            ...observedPass,
            phase,
            sessionID: session.id,
          } as const
          // VS-23b, before the step and budget logic (never inside reserve(), which admits every uncapped attempt): the
          // attempt's model must be the one its pass was decided for, and no model or attempt of the review refused.
          // This holds every retry, continuation, finalizer and switch of model. A refused attempt is never sent.
          const refusal =
            passRoute.privacy === "zdr"
              ? (state.refused?.refusal ?? ReviewRoutes.attempt(session.id, request.model))
              : undefined
          if (refusal) {
            state.refused ??= { model: `${request.model.providerID}/${request.model.id}`, refusal }
            track.stop = "privacy"
            track.denied = true
            observe({ ...attempt, admitted: false, stop: "privacy", estimateUsd: 0 })
            return
          }
          const stop = input.stopSignal?.aborted
            ? "timeout"
            : track.finalizing
              ? track.finalizeAttempts >= 1 ||
                (track.lens && track.attempts >= track.cap) ||
                !request.tools.includes("StructuredOutput")
                ? "steps"
                : undefined
              : track.attempts >= track.cap
                ? "steps"
                : Date.now() >= deadline
                  ? "timeout"
                  : undefined
          if (stop) {
            track.stop ??= stop
            track.denied = true
            observe({ ...attempt, admitted: false, stop, estimateUsd: 0 })
            return
          }
          track.cost = request.model.cost
          const estimate = nextCost(track)
          if (
            !reserve(track, estimate, track.finalizing ? 0 : estimate, {
              phase,
              site: "attempt",
              sessionID: session.id,
            })
          ) {
            track.stop = "budget"
            track.denied = true
            observe({ ...attempt, admitted: false, stop: "budget", estimateUsd: estimate })
            return
          }
          // The catalog forecast can precede a workspace edit. Bind the first message (including retries)
          // to its reserved share, and publish admission only once the transport checks its actual prepared input.
          firstMessageID ??= request.messageID
          const limit =
            !track.finalizing && request.messageID === firstMessageID
              ? firstRequestLimits.get(passKey(spec))
              : undefined
          let admitted = false
          const accept = () => {
            if (admitted) return
            admitted = true
            if (track.finalizing) track.finalizeAttempts++
            else track.attempts++
            observe({
              ...attempt,
              admitted: true,
              estimateUsd: estimate,
              model: {
                providerID: request.model.providerID,
                modelID: request.model.id,
                api: request.model.api.id,
                npm: request.model.api.npm,
              },
            })
          }
          if (limit === undefined) accept()
          return {
            ...(limit === undefined
              ? {}
              : {
                  reviewFirstRequest: {
                    maxTokens: limit,
                    checked: (tokens: number | undefined) => {
                      if (admitted || firstBudgetRefused) return
                      if (tokens !== undefined && Number.isSafeInteger(tokens) && tokens > 0 && tokens <= limit) {
                        accept()
                        return
                      }
                      firstBudgetRefused = true
                      track.stop = "budget"
                      track.denied = true
                      reservations.delete(passKey(track))
                      observe({ ...attempt, admitted: false, stop: "budget", estimateUsd: 0 })
                    },
                  },
                }),
            ...(track.finalizing ? { tools: ["StructuredOutput"] } : {}),
            observe: (cost) => {
              const reservation = reservations.get(passKey(track))
              if (reservation) reservation.turn = Math.max(reservation.turn, cost)
            },
            settle: (result) => {
              if (firstBudgetRefused) return
              // A provider startup error may precede size measurement. It retains ordinary failure accounting.
              if (!admitted) accept()
              observe({
                type: "settle",
                ...observedPass,
                phase,
                costUsd: result.cost,
                complete: result.complete,
                ...(result.usage
                  ? { tokens: { input: result.usage.inputTokens ?? 0, output: result.usage.outputTokens ?? 0 } }
                  : {}),
              })
              state.spent += result.cost
              if (
                (batch || input.accountBatchSpend) &&
                !result.complete &&
                (spec.model.costKind === "priced" || spec.model.costKind === "unknown")
              )
                state.incomplete = true
              if (track.price && !result.complete) {
                // No usage, partial usage, and unpriced usage cannot turn an accepted attempt into free capacity.
                state.uncertain += Math.max(
                  0,
                  Math.max(estimate, reservations.get(passKey(track))?.turn ?? 0) - result.cost,
                )
                state.incomplete = true
              }
              track.context = result.complete ? result.context : Math.max(track.context, result.context)
              track.cached = result.complete ? result.cached : 0
              if (capped)
                reservations.set(passKey(track), { turn: 0, finalize: track.finalizing ? 0 : nextCost(track) })
            },
          }
        },
      }

      const send = (text: string, ms: number): Effect.Effect<Sent> =>
        Effect.suspend(() => {
          if (ms <= 0 || input.stopSignal?.aborted) return Effect.succeed<Sent>({ timedOut: true })
          return prompts
            .prompt({ sessionID: session.id, ...(text === spec.text ? firstPrompt : passPrompt(spec, text)) })
            .pipe(
              Effect.provideService(SessionAdmission.Current, policy),
              Effect.timeoutOption(Duration.millis(ms)),
              Effect.exit,
              Effect.flatMap((exit): Effect.Effect<Sent> => {
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  return Effect.succeed({
                    timedOut: false,
                    ...(error instanceof SessionPrompt.ReviewContextUnavailable ? { contextError: error.message } : {}),
                  })
                }
                if (Option.isNone(exit.value))
                  return prompts.cancel(session.id).pipe(Effect.as({ timedOut: true as const }))
                return Effect.succeed({ timedOut: false, message: exit.value.value })
              }),
            )
        }).pipe(Effect.ensuring(prompts.cancel(session.id)))
      const done = (value: T | undefined, status: Asked<T>["status"], stop?: Stop, detail?: string): Asked<T> => ({
        ...identity,
        sessionID: session.id,
        ...(value !== undefined ? { value } : {}),
        status,
        ...(stop ? { stop } : {}),
        steps: track.steps,
        ...(detail ? { detail } : {}),
      })

      const first = yield* send(spec.text, deadline - Date.now())
      if (firstBudgetRefused) return done(undefined, "skipped", "budget", "first-request-changed")
      if (!first.timedOut && first.contextError) return done(undefined, "failed", undefined, first.contextError)
      if (first.timedOut) track.stop ??= "timeout"
      const message = first.timedOut ? undefined : first.message
      // A budget.run cap can still stop a specialist through the run guard. Count it as a budget stop, so
      // the files it never reached are reported as not reviewed and the finalize prompt runs.
      if (message?.info.role === "assistant" && message.info.error?.name === "BudgetStopError") track.stop ??= "budget"
      const structured = message?.info.role === "assistant" ? message.info.structured : undefined
      // The report came back whole; a stop that landed after its last step changes nothing.
      const value =
        structured !== undefined ? spec.decode(structured) : !track.stop ? spec.decode(lastText(message)) : undefined
      if (value !== undefined) return done(value, "ok")
      if (input.stopSignal?.aborted) return done(undefined, "stopped", "timeout", "timeout")
      // A refused route is never finalized, and once any pass was refused no other pass starts its finalizer.
      if (track.stop === "privacy" || state.refused) return done(undefined, "stopped", "privacy", "privacy")

      // The first prompt is now idle. Unknown exposure stays in the review's ledger; only unused future work is
      // released. The finalizer must still fit beside every other specialist's admitted work.
      if (track.lens && track.attempts >= track.cap)
        return done(undefined, "stopped", track.stop ?? "steps", track.stop ?? "steps")
      if (!reserve(track, nextCost(track), 0, { phase: "finalize", site: "finalizer", sessionID: session.id })) {
        observe({
          type: "attempt",
          ...observedPass,
          phase: "finalize",
          admitted: false,
          stop: "budget",
          estimateUsd: nextCost(track),
          sessionID: session.id,
        })
        return done(undefined, "stopped", "budget", "budget")
      }
      track.finalizing = true
      track.denied = false
      yield* sessions.setPermission({ sessionID: session.id, permission: [...sessionRules, DENY_ALL, ALLOW_OUTPUT] })
      const last = yield* send(buildFinalizePrompt(), FINALIZE_MS)
      if (!last.timedOut && last.contextError) return done(undefined, "failed", undefined, last.contextError)
      const final = last.timedOut ? undefined : last.message
      const finalStructured = final?.info.role === "assistant" ? final.info.structured : undefined
      const finalValue = spec.decode(finalStructured !== undefined ? finalStructured : lastText(final))
      if (finalValue === undefined && track.denied) return done(undefined, "stopped", track.stop, track.stop)
      if (finalValue === undefined)
        return done(undefined, "failed", track.stop, errorOf([message, final]) ?? "no report")
      const status = track.stop === "timeout" ? "timeout" : track.stop ? "stopped" : "ok"
      return done(finalValue, status, track.stop, track.stop)
    }).pipe(
      Effect.ensuring(Effect.sync(() => reservations.delete(passKey(spec)))),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) =>
          Effect.succeed<Asked<T>>({
            ...identity,
            status: "failed",
            steps: 0,
            detail: Cause.prettyErrors(cause)[0]?.message ?? "the session failed",
          }),
      ),
      Effect.tap((done) => progress({ type: "specialist", name: passKey(done), status: done.status })),
      Effect.tap(() => checkpoint()),
    )
  }

  const fullInput = input
  let batch: ReturnType<typeof activeReviewBatch> | undefined
  let batchMayCharge = false
  let unavailable: string[] = []
  let batchRefusal: string | undefined
  const body = Effect.gen(function* () {
    let files = hold?.files ?? input.files
    let headFiles = hold ? hold.headFiles : input.headFiles
    let focus = hold ? input.focus?.filter((hunk) => !heldPaths.has(hunk.path)) : input.focus
    // Nothing to send: holdback held every changed file back or, in an incremental review, every hunk new since the
    // last one, so no pass runs (the files sent would carry nothing new and go out as a full review).
    let nothingToSend =
      hold !== undefined && (!files.length || (input.mode === "incremental" && !!input.focus?.length && !focus?.length))
    // A finding on a held path is never quoted to the verify or judge pass; selection drops it.
    const sendable = (finding: { path: string }) => !heldPaths.has(finding.path)
    // The earlier findings the prompts list: under holdback those on a held path left out, titles redacted. One left
    // out gets no status from the model (see `unshown`), and selection still keeps it open from `input.prior`.
    // Prompts: the diff that fits the model's context, focus files first in incremental mode.
    const focused = new Set((focus ?? []).map((hunk) => hunk.path))
    const context = Math.min(model.context, triage.context)
    const graph =
      config.impact === "graph" && !nothingToSend && files.length > 0 && !refusedUpFront && !input.stopSignal?.aborted
    const layout = (ranks?: ReadonlyMap<string, number>, dependents?: ReadonlyMap<string, number>) => {
      const ranked =
        config.depth === "auto" ? orderByRiskDensity(files, dependents) : ranks ? orderImpactFiles(files, ranks) : files
      const ordered =
        input.mode === "incremental"
          ? [...ranked.filter((file) => focused.has(file.path)), ...ranked.filter((file) => !focused.has(file.path))]
          : ranked
      const split = budgetDiff(ordered, diffBudgetChars(context, config.maxDiffChars))
      const overBudget = new Set(graph || strictMode || batch ? split.notInlined.map((file) => file.path) : [])
      // Each changed file once: annotated when its pull request text is at hand, and only its changed lines when an
      // incremental review has nothing new in it.
      const packed = packChanges({
        inline: split.inline,
        changed: files,
        ...(headFiles
          ? { headFiles: overBudget.size ? headFiles.filter((file) => !overBudget.has(file.path)) : headFiles }
          : {}),
        ...(input.mode === "incremental" && focus ? { focus } : {}),
      })
      return { ordered, split, overBudget, packed }
    }
    const excluded = new Set([...input.skipped.map((file) => file.path), ...heldPaths])
    // The private view admits regular Git blobs only. Match their relative and absolute spellings
    // against the alias rules frozen at admission, without resolving a candidate in the live checkout.
    const denied = (file: string) =>
      excluded.has(file) ||
      classifyPath(file, { config }) !== undefined ||
      (hold !== undefined && heldReason(file) !== undefined) ||
      Permission.evaluate("read", file, rules).action !== "allow" ||
      (!!authority?.patterns.length &&
        Permission.evaluate("read", path.resolve(input.directory, file).replaceAll("\\", "/"), rules).action !==
          "allow")
    // A move keeps the restrictions of both spellings, even when an adapter supplied only one skipped path.
    if (graph || strictMode)
      for (const file of input.anchors) {
        if (file.oldPath && (denied(file.path) || denied(file.oldPath))) {
          excluded.add(file.path)
          excluded.add(file.oldPath)
        }
      }
    const maxBatchChars = Math.max(0, diffBudgetChars(context, config.maxDiffChars) - 1)
    const needsBatch =
      config.largeChanges === "batch" &&
      input.trigger === "local" &&
      !refusedUpFront &&
      !nothingToSend &&
      !input.stopSignal?.aborted &&
      (input.continuingBatch || exceedsBatchLimits(files, { ...config, maxDiffChars: maxBatchChars }))
    const collectImpact = Effect.gen(function* () {
      const admitted = files.filter((file) => !denied(file.path) && (!file.oldPath || !denied(file.oldPath)))
      const remaining = deadline - Date.now()
      if (!admitted.length || remaining <= 0) return undefined
      return yield* ReviewImpact.build({
        directory: input.directory,
        base: input.base,
        head: input.head,
        files: admitted,
        ...((needsBatch && !batch) || config.depth === "auto" ? { batchClusters: true as const } : {}),
        context,
        ...(input.stopSignal ? { signal: input.stopSignal } : {}),
        promptView(ranks, dependents) {
          const { split, packed } = layout(ranks, dependents)
          const full = new Set(packed.headFiles.filter((file) => file.exact).map((file) => file.path))
          const shown = new Set(split.inline.map((file) => file.path))
          return { inline: (file) => full.has(file), diffShown: (file) => shown.has(file) }
        },
        ignore: config.ignore,
        ignored: denied,
        ...(hold ? { holdback: "secrets" as const } : {}),
        budgetMs: Math.min(IMPACT_LIMITS.timeBoxMs, remaining),
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          () => Effect.succeed(undefined),
        ),
      )
    })
    const plannable =
      !needsBatch ||
      (!uncommitted &&
        [input.base, input.head].every((id) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id)) &&
        new Set(files.map((file) => file.path)).size === files.length)
    const snapshotAuthority = ReviewMcpSnapshot.freezeSelection(yield* ReviewMcpSnapshot.Trusted)
    const snapshotBatch = needsBatch && !!snapshotAuthority
    const cardBatch = needsBatch && (!!input.selectedCards || (config.cards === "brain" && !input.batchStore))
    let impact =
      graph && !uncommitted && !cardBatch && !snapshotBatch && (!needsBatch || plannable)
        ? yield* collectImpact
        : undefined
    if (needsBatch && (!plannable || cardBatch || snapshotBatch)) {
      batchRefusal = snapshotBatch
        ? "Not reviewed. Resumable batches cannot reuse a review that uses owner-selected MCP context."
        : cardBatch
          ? "Not reviewed. Resumable batches cannot reuse a review that uses Brain cards."
          : "Not reviewed. Resumable batches require a committed change and a trusted review-state store."
      unavailable = [...new Set(input.files.map((file) => file.path))]
      nothingToSend = true
    } else if (needsBatch) {
      const eligible = files.filter((file) => !denied(file.path) && (!file.oldPath || !denied(file.oldPath)))
      batch = activeReviewBatch(
        { ...input, model, triage, judge: judgeModel },
        eligible,
        maxBatchChars,
        impact?.batchClusters,
        impact?.dependentsByFile,
      )
      const routes = [model, triage, judgeModel].filter((choice): choice is ResolvedModel => !!choice)
      batchMayCharge = routes.some((choice) => choice.costKind === "priced" || choice.costKind === "unknown")
      const spent = input.batchStore?.spent
        ? input.batchStore.spent(batch.plan, config.maxCostUsdPerMonth > 0, config.maxCostUsd > 0)
        : batch.cursor.completed
          ? undefined
          : 0
      const remaining = remainingUsd(config, input.spent ? { ...input.spent, trigger: input.trigger } : undefined)
      const planLimit =
        config.maxCostUsd > 0 && batchMayCharge
          ? spent === undefined || !Number.isFinite(spent) || spent < 0
            ? 0
            : Math.max(0, config.maxCostUsd - spent)
          : undefined
      const unknownSpend =
        batchMayCharge && remaining !== undefined && (spent === undefined || !Number.isFinite(spent) || spent < 0)
      const budget = unknownSpend
        ? 0
        : batchMayCharge
          ? Math.min(remaining ?? Infinity, planLimit ?? Infinity)
          : Infinity
      const unknownPrice =
        Number.isFinite(budget) &&
        routes.some((choice) => choice.costKind === "unknown" || (choice.costKind === "priced" && !choice.price))
      if (!input.batchStore)
        batchRefusal = "Not reviewed. Resumable batches require a committed change and a trusted review-state store."
      else if (batch.mismatch)
        batchRefusal =
          "Not reviewed. The saved batch plan no longer matches this change. Run a full review to begin a new plan."
      else if (unknownPrice)
        batchRefusal = "Not reviewed. The selected model has no confirmed price for this batch budget."
      else if (budget <= 0)
        batchRefusal =
          "Not reviewed. The remaining review budget is exhausted or its prior spend could not be confirmed."
      else if (Number.isFinite(budget)) {
        dollarLimit = budget
        capped = routes.some((choice) => priceOf(choice) !== undefined)
      }
      const selected = batchRefusal ? new Set<string>() : batch.paths
      const eligiblePaths = new Set(eligible.map((file) => file.path))
      unavailable = fullInput.files.filter((file) => !eligiblePaths.has(file.path)).map((file) => file.path)
      const deferred = files
        .filter((file) => !selected.has(file.path))
        .flatMap((file) => (file.oldPath ? [file.path, file.oldPath] : [file.path]))
      for (const path of deferred) excluded.add(path)
      if (selected.size && deferred.length) {
        // These are committed repository names, never paths resolved by following live forks' symlinks.
        // The existing restricted review tool policy checks the session's read rules for aliases/query results.
        const worktree = (yield* InstanceState.context).worktree
        const spellings =
          deferred.length > 256
            ? ["*"]
            : [
                ...new Set(
                  deferred.flatMap((file) => {
                    const absolute = path.resolve(input.directory, file)
                    return [file, absolute, path.relative(worktree, absolute)].map((name) => name.replaceAll("\\", "/"))
                  }),
                ),
              ]
        sessionRules = [
          ...rules,
          ...spellings.map((pattern) => ({ permission: "read", pattern, action: "deny" as const })),
        ]
        reviewed.restrictedReads = true
      }
      files = eligible.filter((file) => selected.has(file.path))
      headFiles = headFiles?.filter((file) => selected.has(file.path))
      focus = undefined
      nothingToSend = !files.length
      input = {
        ...input,
        mode: "full",
        focus: undefined,
        since: undefined,
        files: input.files.filter((file) => selected.has(file.path)),
        anchors: input.anchors.filter((file) => selected.has(file.path)),
        headFiles,
        prior: input.prior.filter((entry) => selected.has(entry.path)),
        knownPath: (file) => (excluded.has(file) ? Promise.resolve(false) : fullInput.knownPath(file)),
      }
      reviewed.paths = files.map((file) => file.path)
      impact = graph && files.length ? yield* collectImpact : undefined
    }
    // Inspect only the admitted batch's original lines. Lockfile presence is metadata about the full change:
    // a matching lock in a different batch still accompanies its manifest.
    const checks = !diagnostics
      ? undefined
      : process.platform !== "linux"
        ? { evidence: [], incomplete: "unavailable" as const }
        : yield *
          Effect.promise(() =>
            offlineChecks(
              input.files.filter((file) => !denied(file.path) && (!file.oldPath || !denied(file.oldPath))),
              fullInput.anchors,
              input.stopSignal,
            ),
          )
    const checkNotes = !checks?.incomplete
      ? []
      : [
          checks.incomplete === "unavailable"
            ? "Offline diagnostics did not run on this platform."
            : checks.incomplete === "cancelled"
              ? "Offline diagnostics were cancelled."
              : "Offline diagnostics reached their scan limit. Their evidence is incomplete.",
        ]
    const { ordered, split, overBudget, packed } = layout(impact?.changedRanks, impact?.dependentsByFile)
    const index = buildAnchorIndex(input.anchors)
    const strictDenied = (file: string) => {
      if (!ReadOnlyGit.repositoryPath(file) || ESCAPING_PATH.test(file) || denied(file)) return true
      const changed = lookupFile(index, file)?.file
      // Ordinary anchoring accepts an absolute checkout prefix by suffix. Strict evidence uses an
      // exact repository path or a diff's a/ or b/ spelling, so a nonexistent lookalike cannot borrow its blob.
      if (
        changed &&
        ![changed.path, changed.oldPath].some(
          (name) => name && (file === name || file === `a/${name}` || file === `b/${name}`),
        )
      )
        return true
      return (
        !!changed &&
        (denied(changed.path) || overBudget.has(changed.path) || (!!changed.oldPath && denied(changed.oldPath)))
      )
    }
    const allEarlier = hold?.context.prior ?? input.prior
    const earlier = batch ? allEarlier.filter((entry) => batch!.paths.has(entry.path)) : allEarlier
    const prior = strictMode
      ? earlier.filter((entry) => !strictDenied(entry.path) && (!hold || !containsHeldValue(entry)))
      : earlier
    const checkFiles = overBudget.size ? headFiles?.filter((file) => !overBudget.has(file.path)) : headFiles
    const ruleStrict = config.ruleCheck === "strict"
    const source =
      input.rulesSource ?? (input.trigger === "local" || input.trigger === "desktop" ? "working tree" : "base branch")
    const ruleInput = safeRulePrompt(
      { rules: input.rules, instructions: input.context.instructions, ruleParts: input.ruleParts },
      config,
    )
    const strictKeys = {
      ...(strictMode
        ? {
            guardrail: "strict" as const,
            ...(config.verifyEvidence === "certificate" ? { verifyEvidence: "certificate" as const } : {}),
            ...(config.scopeGate === "introduced" ? { scopeGate: "introduced" as const } : {}),
          }
        : {}),
      ...(ruleStrict ? { ruleCheck: "strict" as const } : {}),
    }
    const snapshots =
      snapshotAuthority?.selections.length && !nothingToSend && !refusedUpFront && !input.stopSignal?.aborted
        ? yield* Effect.gen(function* () {
            const manager = yield* Effect.serviceOption(MCP.Service)
            const current = Option.getOrUndefined(manager)?.reviewSnapshotGeneration
            const bridge = yield* EffectBridge.make()
            const managerDirectory = (yield* InstanceState.context).directory
            const selectedDirectory = snapshotAuthority.directory
            const invocation = ReviewMcpSnapshot.invocation(snapshotAuthority, selectedDirectory, async (server) => {
              if (
                !current ||
                !(await ReviewMcpSnapshot.sameCheckout(selectedDirectory, input.directory, managerDirectory))
              )
                return
              return bridge.promise(current(server))
            })
            return yield* Effect.promise((signal) =>
              invocation.capture(input.stopSignal ? AbortSignal.any([signal, input.stopSignal]) : signal),
            ).pipe(Effect.ensuring(Effect.sync(invocation.close)))
          })
        : undefined
    const snapshotNotes = snapshots?.incomplete ? [ReviewMcpSnapshot.unavailable] : []
    const promptInput: PromptInput = {
      ...(snapshots?.blocks.length ? { mcpSnapshots: snapshots.blocks } : {}),
      mode: input.mode,
      trust: input.trust,
      base: input.base,
      head: input.head,
      ...(input.baseRef ? { baseRef: input.baseRef } : {}),
      ...(input.since ? { since: input.since } : {}),
      ...(input.pr ? { pr: input.pr } : {}),
      diff: packed.diff,
      notInlined: split.notInlined.map((file) => ({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
      })),
      ...(focus ? { focus } : {}),
      ...(packed.settled.length ? { settled: packed.settled } : {}),
      ...(headFiles ? { headFiles: packed.headFiles } : {}),
      ...input.context,
      ...(cards.length ? { contextCards: cards.map((row) => row.text) } : {}),
      ...hold?.context,
      ...(batch
        ? {
            batchContext: batch.coverage.context,
            related: (hold?.context.related ?? input.context.related)
              ?.filter((entry) => batch!.paths.has(entry.path))
              .map((entry) => ({ ...entry, hits: entry.hits.filter((hit) => !excluded.has(hit.path)) })),
            history: (hold?.context.history ?? input.context.history)?.filter((entry) => batch!.paths.has(entry.path)),
          }
        : {}),
      ...(checks?.evidence.length ? { diagnostics: checks.evidence } : {}),
      ...(impact ? { impact: impact.slice } : {}),
      ...(hold ? { inputsRedacted: true as const } : {}),
      rules: ruleInput.rules,
      rulesSource: source,
      ...(ruleStrict
        ? {
            ruleCheck: "strict" as const,
            instructions: ruleInput.instructions,
            instructionsSource: source,
          }
        : // Under holdback "secrets" the context's raw instructions spread above never reach the prompt: these are
          // redacted (safeRulePrompt).
          config.holdback === "secrets" && input.context.instructions !== undefined
          ? { instructions: ruleInput.instructions }
          : {}),
      prior,
      maxComments: config.maxComments,
      nits: wantsNits(config),
      ...(strictMode ? { ...strictKeys, ...(uncommitted ? { uncommitted: true } : {}) } : {}),
    }
    let activePayload = promptInput
    let activeImpact = impact?.slice
    const recordImpact = (sent: boolean) => {
      if (activeImpact && !input.stopSignal?.aborted && input.observe)
        observe({
          type: "impact",
          record: structuredClone(impactRecord(activeImpact)),
          locations: sent ? [...activeImpact.locations] : [],
        })
    }
    const certificateSchema = verifyCertJsonSchema(strictKeys)
    const verifySchema = certificateSchema ?? VERIFY_JSON_SCHEMA
    const reportSchema = strictReportJsonSchema(strictKeys) ?? REVIEW_REPORT_JSON_SCHEMA
    const auto =
      config.depth === "auto" && !nothingToSend && !refusedUpFront && !input.stopSignal?.aborted
        ? yield*
          Effect.gen(function* () {
            const history =
              input.trigger === "local" && !uncommitted
                ? yield* ReviewDepth.history(
                    { directory: input.directory, base: input.base, head: input.head, signal: input.stopSignal },
                    files.filter((file) => !denied(file.path) && (!file.oldPath || !denied(file.oldPath))),
                    deadline,
                  )
                : undefined
            // An interrupted graph can still prove a lower bound. It cannot prove that no dependents exist.
            const observed = impact?.slice.stages.gated
            const incompleteReach = !!impact?.slice.incomplete?.length
            const dependents = observed !== undefined && (observed > 0 || !incompleteReach) ? observed : undefined
            const risk = riskOf(
              riskFeatures(files, {
                changed: [...input.anchors, ...input.skipped, ...input.files],
                ...(history ? { history } : {}),
                ...(dependents !== undefined ? { dependents } : {}),
              }),
            )
            const plan = planDepth({
              depth: "auto",
              files: input.files,
              risk,
              config: { security: config.security, lenses: config.lenses },
            })
            return { risk, plan, partialReach: dependents !== undefined && incompleteReach }
          })
        : undefined
    const names = nothingToSend ? [] : (auto?.plan.specialists ?? planSpecialists(input.files, config))
    let lenses = auto?.plan.lenses ?? []
    const decodePrimary = strictMode || ruleStrict ? (value: unknown) => decodeReport(value, strictKeys) : decodeReport
    const primaryRequests = (payload: PromptInput, activeLenses = lenses): Spec<ModelReport>[] => [
      ...names.map((name) => ({
        name,
        model: triage,
        cap: name === "security" ? Math.ceil((config.maxSteps * 2) / 3) : config.maxSteps,
        text: name === "security" ? buildSecurityPrompt(payload) : buildReviewPrompt(payload),
        schema: reportSchema,
        decode: decodePrimary,
      })),
      ...activeLenses.map(
        (lens): Spec<ModelReport> => ({
          name: "lens",
          lens,
          model,
          cap: Math.min(config.maxSteps, LENS_LIMITS.steps),
          text: buildLensPrompt(payload, lens),
          schema: reportSchema,
          decode: (value) => {
            const report = decodeReport(value, strictKeys)
            // A single-class session proposes at most four candidates. It cannot close a prior finding,
            // add free-form file notes, or set the primary review's risk.
            return report
              ? { summary: "", risk: "low", files: [], findings: report.findings.slice(0, LENS_LIMITS.findings) }
              : undefined
          },
        }),
      ),
    ]
    let requests = primaryRequests(promptInput)
    let checkHeadFiles = checkFiles
    let verifySteps = VERIFY_STEPS
    let checkerStop:
      | ((
          pass: "verify" | "judge",
          target: ResolvedModel,
          text: string,
          rows: number,
        ) => Effect.Effect<"budget" | "timeout" | undefined>)
      | undefined
    // VS-34's deterministic notes: what was held back, what was sent redacted, and what is committed although ignored.
    const holdNotes = hold
      ? [
          // The value-unsent wording only where the reviewer can run no check and read nothing outside the worktree
          // (the saved outputs of a trusted review, `allowDirs`), where the held paths are not denied.
          noteHeldBack(
            hold.held.map((file) => file.path),
            {
              promptOnly: input.checks === true || input.trust !== "untrusted" || (input.allowDirs?.length ?? 0) > 0,
            },
          ),
          noteRedacted(hold.redactions.map((row) => row.path)),
          input.ignored ? noteIgnoredCommitted(hold.ignoredCommitted) : noteIgnoreUnchecked(),
        ].filter((note) => note !== undefined)
      : []
    const dispatchNotes: string[] = []
    if (
      config.maxInputTokens &&
      config.maxInputTokens > 0 &&
      names.length &&
      !refusedUpFront &&
      !input.stopSignal?.aborted
    ) {
      const prepare = prompts.reviewFirstRequest
      function withinDeadline<A>(effect: Effect.Effect<A>) {
        return Effect.suspend(() => {
          const ms = deadline - Date.now()
          if (input.stopSignal?.aborted || ms <= 0) {
            previewTimedOut = true
            return Effect.succeed(undefined)
          }
          const work = previewAborted
            ? effect.pipe(Effect.raceFirst(Deferred.await(previewAborted).pipe(Effect.as(undefined))))
            : effect
          return work.pipe(
            Effect.timeoutOption(Duration.millis(ms)),
            Effect.map((value) => {
              if (Option.isNone(value) || input.stopSignal?.aborted) previewTimedOut = true
              return Option.getOrUndefined(value)
            }),
          )
        })
      }
      const prices = new Map<string, ReviewPrice>()
      const dispatchPrice = (chosen: ResolvedModel) =>
        Effect.gen(function* () {
          if (chosen.costKind !== "priced" || !chosen.price || chosen.price.tiers?.length) return chosen.price
          const key = nameOf(chosen)
          if (prices.has(key)) return prices.get(key)
          // A caller can supply a model without ever booting its catalog. Pricing a preview must not
          // initialize provider authentication or refresh a plan, even when only static rates are known.
          const loaded = provider.reviewProvider
            ? yield* withinDeadline(provider.reviewProvider(chosen.providerID))
            : undefined
          const cost = loaded?.models[chosen.modelID]?.cost
          const tiers = (
            cost?.tiers?.length
              ? cost.tiers.flatMap((item) =>
                  item.tier.type === "context" ? [{ above: item.tier.size, rates: item }] : [],
                )
              : cost?.experimentalOver200K
                ? [{ above: 200_000, rates: cost.experimentalOver200K }]
                : []
          ).map(({ above, rates }) => ({
            above,
            input: rates.input,
            output: rates.output,
            cacheRead: rates.cache.read,
            cacheWrite: rates.cache.write,
          }))
          const price = tiers.length ? { ...chosen.price, tiers } : chosen.price
          prices.set(key, price)
          return price
        })
      const fullPlan = (initial: PlannedRequest[], versions: typeof headFiles): PlannedRequest[] => {
        if (!triaged && config.verify === "off" && !initial.some((pass) => pass.lens)) return initial
        // These are the actual fixed blocks and the full set of eligible head files. Only the runtime's
        // conditional bound can account for future candidates, fixed claims and the judge's verdicts.
        const check = {
          trust: input.trust,
          head: input.head,
          candidates: [],
          headFiles: verifyHeadFiles(files, versions, versions ?? []),
          ...(strictMode ? { ...strictKeys, ...(uncommitted ? { uncommitted: true } : {}) } : {}),
        }
        return [
          ...initial,
          { name: "verify", model, text: buildVerifyPrompt(check), cap: VERIFY_STEPS, schema: verifySchema },
          ...(judgeModel
            ? [
                {
                  name: "judge" as const,
                  model: judgeModel,
                  text: buildJudgePrompt({ ...check, checks: [] }),
                  cap: VERIFY_STEPS,
                  schema: VERIFY_JSON_SCHEMA,
                },
              ]
            : []),
        ]
      }
      const candidateLimit = () => Math.max(4, 2 * config.maxComments) + lenses.length * LENS_LIMITS.findings
      // Future claims have no bytes yet. Reserve one ordinary model-output allowance per candidate
      // in addition to all concrete prompt text. Enforce both this serialized character budget and the
      // whole measured request before sending any materialized verifier or judge request.
      const checkerTextLimit = (text: string) =>
        JSON.stringify(text).length + Math.ceil(candidateLimit() * OUTPUT_PER_STEP * 3.5)
      const firstTurn = (draft: PlannedRequest, conditional?: "verify" | "judge") =>
        prepare
          ? withinDeadline(
              Effect.suspend(() => {
                const prompt = passPrompt(draft, draft.text)
                return prepare({
                  session: passSession(draft),
                  prompt,
                  route: {
                    policy: policyFor(),
                    agent: prompt.agent,
                    ...decided.find(({ chosen }) => chosen === draft.model)?.result,
                  },
                  ...(conditional
                    ? {
                        conditional: {
                          pass: conditional,
                          candidateLimit: candidateLimit(),
                          maxSerializedTextChars: checkerTextLimit(draft.text),
                        },
                      }
                    : {}),
                })
              }).pipe(
                Effect.catchCauseIf(
                  (cause) => !Cause.hasInterrupts(cause),
                  () => Effect.succeed(undefined),
                ),
                Effect.map((accounting) =>
                  accounting && Number.isSafeInteger(accounting.promptTokens) && accounting.promptTokens > 0
                    ? accounting
                    : undefined,
                ),
              ),
            )
          : Effect.succeed(undefined)
      const measure = (drafts: PlannedRequest[]) =>
        Effect.gen(function* () {
          if (!prepare) return undefined
          const plans: PassPlan[] = []
          for (const draft of drafts) {
            const accounting = yield* firstTurn(
              draft,
              draft.name === "verify" || draft.name === "judge" ? draft.name : undefined,
            )
            if (!accounting) return undefined
            const price = draft.model.costKind === "priced" ? yield* dispatchPrice(draft.model) : undefined
            if (previewTimedOut) return undefined
            plans.push({
              pass: passKey(draft),
              model: nameOf(draft.model),
              maxSteps: draft.cap,
              promptTokens: accounting.promptTokens,
              // Up to six trace and six guard excerpts per future answer, emitted once by the verifier.
              ...(certificateSchema && draft.name === "verify"
                ? {
                    extraOutputTokens: Math.ceil(
                      (candidateLimit() * (MAX_TRACE_QUOTES + MAX_FINDING_QUOTES) * MAX_QUOTE_CHARS) / 3.5,
                    ),
                  }
                : {}),
              ...(price ? { price } : {}),
              ...(draft.model.variant ? { effort: draft.model.variant } : {}),
              ...(accounting.cached === undefined ? {} : { cached: accounting.cached }),
            })
          }
          return plans
        })
      const proposal = (payload: PromptInput, versions: typeof checkFiles, slice = activeImpact) => {
        const next = primaryRequests(payload)
        return {
          requests: fullPlan(next, versions),
          accept: () => {
            activePayload = payload
            activeImpact = slice
            requests = next
            checkHeadFiles = versions
          },
        }
      }
      function* shrink(lever: "cards" | "dependents" | "diff") {
        if (lever === "cards") {
          const change = proposal({ ...activePayload, contextCards: undefined }, checkHeadFiles)
          yield {
            ...change,
            accept: () => {
              change.accept()
              privateCardIds = []
            },
          }
          return
        }
        if (lever === "dependents") {
          let slice = activeImpact
          while (slice && (slice = shrinkImpactDependents(slice)))
            yield proposal({ ...activePayload, impact: slice }, checkHeadFiles, slice)
          return
        }
        // Preserve the changed lines of all displayed files, including the ones whose inline representation
        // was a complete annotated head. A previously excluded file never becomes eligible while trimming.
        const displayed = new Set([
          ...split.inline.map((file) => file.path),
          ...packed.headFiles.filter((file) => file.annotated).map((file) => file.path),
        ])
        const changes = ordered.filter((file) => displayed.has(file.path))
        const byPath = new Map(changes.map((file) => [file.path, file]))
        const versions = checkHeadFiles?.map((file) => {
          const change = byPath.get(file.path)
          return change ? { path: file.path, exact: false, text: renderPatch([change], 0) } : file
        })
        yield proposal(
          {
            ...activePayload,
            diff: renderPatch(changes, 0),
            headFiles: packed.headFiles.filter((file) => !displayed.has(file.path)),
            notInlined: activePayload.notInlined?.filter((file) => !displayed.has(file.path)),
          },
          versions,
        )
      }
      const result = yield* dispatchPlan({
        requests: prepare ? fullPlan(requests, checkHeadFiles) : [],
        dependents: !!activeImpact?.dependents.length,
        cards: cards.length > 0,
        lenses: lenses.length > 0,
        dropLenses: () => {
          lenses = []
          requests = primaryRequests(activePayload)
          return fullPlan(requests, checkHeadFiles)
        },
        shrink,
        measure,
        observe,
        limits: {
          maxInputTokens: config.maxInputTokens,
          remainingUsd: remainingUsd(
            batch && dollarLimit > 0 ? { ...config, maxCostUsd: dollarLimit } : config,
            input.spent ? { ...input.spent, trigger: input.trigger } : undefined,
          ),
        },
      })
      // Codium exposes plan usage as a percentage. Per-pass token and dollar figures stay in the observation.
      if (result.decision !== "unknown" && !onCodium) {
        const { firstTurnTokens, usd, v2 } = result.estimate
        result.notes.push(
          `The planned first requests total an estimated ${formatTokens(firstTurnTokens)} tokens.` +
            (usd && v2.usd
              ? ` Priced passes are estimated at ${formatUsd(usd.low)}–${formatUsd(usd.high)}. The v2 range is ${formatUsd(v2.usd.low)}–${formatUsd(v2.usd.high)}.`
              : ""),
        )
      }
      if (result.decision !== "go" && !input.stopSignal?.aborted && !previewTimedOut) {
        const skipped = [
          ...input.skipped,
          ...(hold?.held ?? []).map((file) => ({ path: file.path, reason: "held-back" as const })),
        ]
        const unreviewed = [...new Set([...input.anchors, ...input.files, ...skipped].map((file) => file.path))]
        recordImpact(false)
        const strict = strictMode
          ? strictSelect([], {
              head: input.head,
              anchors: input.anchors,
              trust: input.trust,
              verifier: nameOf(model),
              unanswered: [],
              coverage: { partial: "budget-estimate", unreviewed, skipped, specialists: [], held: hold?.held },
              blobs: { head: new Map(), base: new Map() },
              config: { ...strictKeys, maxComments: config.maxComments, suggestions: config.suggestions },
            })
          : undefined
        return {
          partial: "budget-estimate",
          report: { summary: "", risk: "low", files: [], findings: [] },
          selection: {
            ...selectFindings({
              findings: [],
              anchors: input.anchors,
              head: input.head,
              trust: input.trust,
              mode: input.mode,
              config,
              prior: input.prior,
            }),
            ...(strict ? { strict: strictSummary(strict) } : {}),
          },
          ...(strict ? { strict } : {}),
          skipped,
          unreviewed,
          specialists: [],
          sessions: [],
          base: input.base,
          head: input.head,
          ...(input.since ? { since: input.since } : {}),
          mode: input.mode,
          stats: changeStats(input.files),
          notes: [
            result.decision === "unknown" ? BUDGET_ESTIMATE_UNAVAILABLE : noteBudgetEstimate(),
            ...result.notes,
            ...(auto ? ReviewDepth.notes(auto, []) : []),
            ...snapshotNotes,
            ...checkNotes,
            ...holdNotes,
          ],
          ...(hold?.held.length ? { held: hold.held } : {}),
          durationMs: Date.now() - started,
        } satisfies ReviewOutcome
      }
      if (result.decision === "go") {
        for (const plan of result.plans) {
          firstRequestLimits.set(plan.pass, plan.promptTokens)
        }
        dispatchNotes.push(...result.notes)
        const conditionalLimits = new Map(
          fullPlan(requests, checkHeadFiles)
            .filter((draft) => draft.name === "verify" || draft.name === "judge")
            .map((draft) => [draft.name, checkerTextLimit(draft.text)]),
        )
        const caps = new Map(result.plans.map((plan) => [plan.pass, plan.maxSteps]))
        requests = requests.map((spec) => ({ ...spec, cap: caps.get(passKey(spec)) ?? spec.cap }))
        verifySteps = caps.get("verify") ?? VERIFY_STEPS
        checkerStop = (pass, target, text, rows) =>
          Effect.gen(function* () {
            // Findings and the checker's reasons now exist. Never send them when their entire first request
            // cannot be accounted for within its reserved share; ordinary verification bookkeeping still
            // records which findings were left unchecked.
            const reserved = result.plans.find((plan) => plan.pass === pass)
            const fitsText =
              rows <= candidateLimit() && JSON.stringify(text).length <= (conditionalLimits.get(pass) ?? 0)
            const actual = fitsText
              ? yield* firstTurn({
                  name: pass,
                  model: target,
                  cap: caps.get(pass) ?? VERIFY_STEPS,
                  text,
                  schema: pass === "verify" ? verifySchema : VERIFY_JSON_SCHEMA,
                })
              : undefined
            if (previewTimedOut || input.stopSignal?.aborted) {
              dispatchNotes.push(`The ${pass} pass did not run before the review stopped.`)
              return "timeout" as const
            }
            if (reserved && actual && actual.promptTokens <= reserved.promptTokens) return undefined
            dispatchNotes.push(
              `The ${pass} pass did not run because its complete first request could not fit within the reserved review budget.`,
            )
            return "budget" as const
          })
      }
    }

    const trusted = ruleStrict
      ? trustedRules({
          ...activePayload,
          parts: ruleInput.ruleParts,
          anchors: overBudget.size ? files.filter((file) => !overBudget.has(file.path)) : files,
        })
      : undefined
    const ruleCounts: RuleCounts[] = []
    recordImpact(!input.stopSignal?.aborted && !previewTimedOut)
    // 1–5. The specialists fan out only after the opted-in plan fits.
    if (requests.length && batch && batchMayCharge) {
      // Even an uncapped request can be interrupted. A later retry may enable a cap on this same head.
      const journal = input.batchStore?.begin?.(batch.plan, batch.cursor)
      const recorded = journal
        ? yield * journal.pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))
        : false
      if (!recorded) {
        batchRefusal = "Not reviewed. The batch checkpoint could not be recorded before dispatch."
        nothingToSend = true
        requests = []
      }
    }
    const asked = yield* Effect.forEach(requests, (spec) => ask(spec), {
      concurrency: lenses.length ? LENS_LIMITS.parallel : 2,
    })

    // 6. Normalize.
    const reports = asked.flatMap((entry) => {
      if (!entry.value) return []
      let report = diagnostics ? redactDiagnosticData(entry.value) : entry.value
      if (trusted) {
        const checked = checkedRuleFindings(report.findings, trusted)
        ruleCounts.push(checked)
        report = { ...report, findings: checked.findings }
      }
      return [
        {
          source: entry.name === "security" ? ("security" as const) : ("review" as const),
          report,
          ...lensField(entry),
        },
      ]
    })
    const report = mergeReports(reports.map((entry) => entry.report))
    const hidden = new Set<string>()
    const lensCandidates = new Set<Finding>()
    const allFindings = reports.flatMap(({ report, source, lens }) => {
      const modelFindings = normalizeFindings(report.findings, source, input.anchors)
      const findings = checks ? withDiagnosticEvidence(modelFindings, checks.evidence) : modelFindings
      if (strictMode)
        for (const [i, finding] of findings.entries()) {
          const raw = report.findings[i]!
          const targets = raw.patch ? explicitPatchPaths(raw.patch) : []
          if (
            !targets ||
            targets.some(strictDenied) ||
            strictDenied(raw.path) ||
            raw.quotes?.some((quote) => strictDenied(quote.path)) ||
            raw.evidence?.some(
              (reference) => !(checks && diagnosticReference(reference)) && strictDenied(evidencePath(reference)),
            ) ||
            (hold && containsHeldValue(raw))
          )
            hidden.add(finding.id)
        }
      if (lens) for (const finding of findings) lensCandidates.add(finding)
      return findings
    })
    const code = (finding: Finding) => {
      const anchor = resolveAnchor(index, finding)
      return anchor.ok ? normalizeCode(anchorText(index, anchor.anchor)) : ""
    }
    const normalized = lensCandidates.size
      ? allFindings.reduce<Finding[]>((kept, finding) => {
          if (lensCandidates.has(finding)) {
            const matches = (other: Finding) => other.id === finding.id || sameFinding(other, finding, code)
            const representative = kept.find(matches)
            if (representative) {
              // Keep one checked copy even when earlier specialists fingerprinted the same defect differently.
              lensCandidates.add(representative)
              return kept.filter((other) => other === representative || !matches(other))
            }
          }
          kept.push(finding)
          return kept
        }, [])
      : allFindings

    // A fingerprint shared with an inaccessible candidate cannot authorize exposing its competing evidence.
    const eligible = strictMode ? normalized.filter((finding) => !hidden.has(finding.id)) : normalized
    // 7. Verify the candidates the effective policy names. A cheaper triage pass also requires confirmation.
    const shared = config.verifyPolicy === "shared"
    const candidates = verifyCandidates(
      eligible.filter(sendable),
      {
        verify: config.verify,
        policy: config.verifyPolicy,
        minConfidence: config.minConfidence,
        trust: input.trust,
        triaged,
      },
      "engine",
    )
    const lensChecks = eligible.filter((finding) => lensCandidates.has(finding) && sendable(finding))
    const requestedIds = new Set(candidates.map((finding) => finding.id))
    for (const finding of lensChecks) {
      if (requestedIds.has(finding.id)) continue
      requestedIds.add(finding.id)
      candidates.push(finding)
    }
    // After a triage pass the cheaper model's word that an earlier finding is fixed goes to the double-check too, so
    // only the review model closes a finding and resolves its thread. A claim about a finding the first pass reported
    // again contradicts itself and is dropped.
    const reported = new Set(normalized.map((finding) => finding.id))
    // Only an earlier finding the prompts listed can be claimed fixed, and its claim quotes the title they listed.
    const open = new Map(prior.filter((entry) => entry.status === "open").map((entry) => [entry.id, entry]))
    const shown = new Set(prior.map((entry) => entry.id))
    const unshown = new Set(input.prior.flatMap((entry) => (shown.has(entry.id) ? [] : [entry.id])))
    for (const entry of prior)
      if (overBudget.has(entry.path) || (strictMode && strictDenied(entry.path))) unshown.add(entry.id)
    const claims =
      triaged || strictMode
        ? (report.priorStatus ?? []).flatMap((entry) => {
            const listed = open.get(entry.id)
            if (strictMode && hold && listed && containsHeldValue(entry.reason)) {
              hidden.add(listed.id)
              return []
            }
            return entry.status === "fixed" && listed && !unshown.has(listed.id) && !reported.has(listed.id)
              ? [{ ...listed, reason: entry.reason }]
              : []
          })
        : []
    const verifyText =
      candidates.length || claims.length
        ? buildVerifyPrompt({
            trust: input.trust,
            head: input.head,
            candidates,
            ...(strictMode ? { ...strictKeys, ...(uncommitted ? { uncommitted: true } : {}) } : {}),
            ...(claims.length ? { fixed: claims } : {}),
            headFiles: verifyHeadFiles(files, checkHeadFiles, [...candidates, ...claims]),
          })
        : ""
    const verifyPrice = priceOf(model)
    const estimate = verifyPrice
      ? estimateCostUsd({
          promptTokens: Math.ceil(verifyText.length / 3.5),
          maxSteps: verifySteps,
          price: verifyPrice,
        }).low
      : 0
    const verifyStop =
      verifyText && checkerStop
        ? yield* checkerStop("verify", model, verifyText, candidates.length + claims.length)
        : undefined
    const late = verifyStop === "timeout" || deadline - Date.now() < VERIFY_MIN_MS
    // A projection is asked only about a verify pass that would otherwise run: one skipped for time never mattered.
    // The Codium token stop (CODIUM_REVIEW_TOKEN_STOP) is not a dollar decision, so no projection lifts it.
    const unaffordable =
      verifyStop === "budget" ||
      (yield* overTokenStop(verifyText)) ||
      (capped &&
        state.spent + state.uncertain + estimate > dollarLimit &&
        !(verifyText !== "" && !late && lift({ pass: "verify", phase: "turn", site: "verify", estimateUsd: estimate })))
    if (verifyText && (unaffordable || late)) {
      observe({ type: "pass", pass: "verify", model: nameOf(model), text: verifyText, maxSteps: verifySteps })
      observe({
        type: "attempt",
        pass: "verify",
        phase: "turn",
        admitted: false,
        stop: unaffordable ? "budget" : "timeout",
        estimateUsd: estimate,
      })
    }
    // A verifier can introduce secret-shaped text into its reason. Exclude such a row before a panel can
    // relay it; the ordinary strict unanswered bookkeeping keeps the claim open for another review.
    const candidateIds = new Set(candidates.map((finding) => finding.id))
    const verifyDecoder =
      strictMode || lensChecks.length > 0
        ? (value: unknown) => decodeStrictVerify(value)?.filter((row) => !hold || !containsHeldValue(row))
        : decodeVerify
    const verify: Asked<CertificateAnswer[]> | undefined = !verifyText
      ? undefined
      : unaffordable || late
        ? {
            name: "verify",
            status: "skipped",
            steps: 0,
            ...(verifyStop ? { stop: verifyStop } : {}),
            detail: verifyStop === "budget" ? "first-request-budget" : unaffordable ? "budget" : "time",
          }
        : yield* ask({
            name: "verify",
            model,
            cap: verifySteps,
            text: verifyText,
            schema: verifySchema,
            decode: certificateSchema
              ? (value: unknown) =>
                  decodeCertificateAnswers(value, candidateIds)?.filter((row) => !hold || !containsHeldValue(row))
              : verifyDecoder,
          })
    // 7b. The panel's judge (WP A35): a model from a third lab makes the final call on each candidate the check looked
    // at, with the first pass's claim and the check's verdict in front of it. It runs only once the check finished, with
    // the check's step cap, time floor, dollar cap and Codium token stop, so the panel adds no budget of its own.
    const judgeText =
      judgeModel && verify?.status === "ok" && candidates.length
        ? buildJudgePrompt({
            trust: input.trust,
            head: input.head,
            candidates,
            ...(strictMode ? { ...strictKeys, ...(uncommitted ? { uncommitted: true } : {}) } : {}),
            checks: (verify.value ?? []).map((entry) => ({
              ...entry,
              verdict: entry.certificate?.verdict ?? entry.verdict,
            })),
            headFiles: verifyHeadFiles(files, checkHeadFiles, candidates),
          })
        : ""
    const judgePrice = judgeModel ? priceOf(judgeModel) : undefined
    const judgeEstimate = judgePrice
      ? estimateCostUsd({ promptTokens: Math.ceil(judgeText.length / 3.5), maxSteps: VERIFY_STEPS, price: judgePrice })
          .low
      : 0
    const judgeStop =
      judgeText && judgeModel && checkerStop
        ? yield* checkerStop("judge", judgeModel, judgeText, candidates.length)
        : undefined
    const judgeLate = judgeStop === "timeout" || deadline - Date.now() < VERIFY_MIN_MS
    // As verify's pre-check: a projection may lift only the dollar cap, and only for a judge that would otherwise run.
    const judgeUnaffordable =
      judgeStop === "budget" ||
      (yield* overTokenStop(judgeText)) ||
      (capped &&
        state.spent + state.uncertain + judgeEstimate > dollarLimit &&
        !(
          judgeText !== "" &&
          !judgeLate &&
          lift({ pass: "judge", phase: "turn", site: "verify", estimateUsd: judgeEstimate })
        ))
    if (judgeModel && judgeText && (judgeUnaffordable || judgeLate)) {
      observe({ type: "pass", pass: "judge", model: nameOf(judgeModel), text: judgeText, maxSteps: VERIFY_STEPS })
      observe({
        type: "attempt",
        pass: "judge",
        phase: "turn",
        admitted: false,
        stop: judgeUnaffordable ? "budget" : "timeout",
        estimateUsd: judgeEstimate,
      })
    }
    const judged: Asked<ReturnType<typeof decodeVerify>> | undefined =
      !judgeModel || !judgeText
        ? undefined
        : judgeUnaffordable || judgeLate
          ? {
              name: "judge",
              status: "skipped",
              steps: 0,
              ...(judgeStop ? { stop: judgeStop } : {}),
              detail: judgeStop === "budget" ? "first-request-budget" : judgeUnaffordable ? "budget" : "time",
            }
          : yield* ask({
              name: "judge",
              model: judgeModel,
              cap: VERIFY_STEPS,
              text: judgeText,
              schema: VERIFY_JSON_SCHEMA,
              decode: verifyDecoder,
            })
    // The judge's verdict stands where it gave one; the check's stands for the rest, and for earlier fixed claims.
    const finalCall = judged?.status === "ok" ? (judged.value ?? []).filter((entry) => candidateIds.has(entry.id)) : []
    const verdicts = new Map([...(verify?.value ?? []), ...finalCall].map((entry) => [entry.id, entry.verdict]))
    if (strictMode || lensChecks.length) {
      // A stopped finalizer or a judge cannot supply a missing first check. Only a single readable verdict
      // from each required pass counts, and a model cannot confirm a finding it was never asked about.
      const readable = new Set(verify?.status === "ok" ? verify.value?.map((row) => row.id) : [])
      const judgedIds = new Set(finalCall.map((row) => row.id))
      const mustVerify = new Set(lensChecks.map((finding) => finding.id))
      for (const id of verdicts.keys())
        if (
          (strictMode || mustVerify.has(id)) &&
          (!readable.has(id) || (judgeModel && candidateIds.has(id) && !judgedIds.has(id)))
        )
          verdicts.delete(id)
    }
    // After a triage pass only what the review model confirmed is reported: a candidate it rejected, gave no verdict
    // for, or never saw because the double-check was skipped or failed is left out.
    const unchecked = new Set(verifyUnconfirmed(candidates, verdicts, triaged).map((finding) => finding.id))
    for (const finding of normalized)
      if (lensCandidates.has(finding) && verdicts.get(finding.id) !== "confirmed") unchecked.add(finding.id)
    // Under the shared policy the review says how many candidates it posts without a verdict, whether or not the pass
    // finished; after a triage pass, how many it left out for want of one.
    const unanswered = shared && verify ? verifyUnanswered(candidates, verdicts, triaged).length : 0
    const finished = verify?.status === "ok"
    const kept = normalized.filter((finding) => verdicts.get(finding.id) !== "rejected")
    const findings = kept
      .filter((finding) => !unchecked.has(finding.id))
      .map((finding) => (verdicts.get(finding.id) === "confirmed" ? { ...finding, verified: true } : finding))
    const rejected = normalized.length - kept.length
    const unconfirmed = kept.length - findings.length
    const fixed = new Set(claims.filter((claim) => verdicts.get(claim.id) === "confirmed").map((claim) => claim.id))
    // A status for an earlier finding the prompts left out (holdback) is dropped, so a held file's earlier finding is
    // never settled fixed on the model's word; unset, `unshown` is empty and the report is as it was.
    const lateVerify = verifyStop ?? (verify?.detail === "first-request-changed" ? ("budget" as const) : undefined)
    const lateJudge = judgeStop ?? (judged?.detail === "first-request-changed" ? ("budget" as const) : undefined)
    const conditionalUnreviewed = new Set(
      (lateVerify ? [...candidates, ...claims] : lateJudge ? candidates : []).map((finding) => finding.path),
    )
    const unreadLens = lensChecks.filter((finding) => !verdicts.has(finding.id))
    for (const finding of unreadLens) conditionalUnreviewed.add(finding.path)
    for (const entry of prior) if (conditionalUnreviewed.has(entry.path)) unshown.add(entry.id)
    const checked: ModelReport =
      triaged || strictMode
        ? {
            ...report,
            priorStatus: (report.priorStatus ?? []).filter(
              (entry) => !unshown.has(entry.id) && (entry.status !== "fixed" || fixed.has(entry.id)),
            ),
          }
        : unshown.size && report.priorStatus
          ? { ...report, priorStatus: report.priorStatus.filter((entry) => !unshown.has(entry.id)) }
          : report

    // 8. Select. Paths outside the diff are checked against the repository first; selection is synchronous. A review
    // the route rules stopped (VS-23b) is not reviewed, so it lists no finding, not even one a pass before the refusal
    // reported: no review that finished stands behind it (I-7). Nor does it assess risk or keep earlier findings'
    // bookkeeping, so its selection is the empty one the CLI gives a model refused before Review.run.
    const refused = state.refused
    // A partial run records the files no finished specialist saw, so the next run reviews them. A run where no
    // specialist finished, or one the route rules stopped, leaves every file unreviewed.
    const noRequestSent =
      !refused &&
      !input.stopSignal?.aborted &&
      asked.length > 0 &&
      asked.every((entry) => entry.status === "skipped" && entry.detail === "first-request-changed") &&
      [...tracks.values()].every((track) => !track.attempts && !track.finalizeAttempts)
    const lensStop = unreadLens.length
      ? (verify?.stop ??
        (verify?.detail === "budget" ? "budget" : verify?.detail === "time" ? "timeout" : "model-error"))
      : undefined
    const primaryStop = refused
      ? ("privacy" as const)
      : (asked.find((entry) => entry.stop)?.stop ??
        (asked.some((entry) => !entry.value) ? ("model-error" as const) : undefined))
    const partial = noRequestSent ? ("budget-estimate" as const) : (primaryStop ?? lateVerify ?? lateJudge ?? lensStop)
    const missed = nothingToSend
      ? []
      : refused || !reports.length || asked.some((entry) => entry.stop && !entry.value)
        ? files.map((file) => file.path)
        : primaryStop && primaryStop !== "model-error"
          ? yield* uncovered(asked.flatMap((entry) => (entry.value && entry.sessionID ? [entry.sessionID] : [])))
          : []
    const missedCoverage =
      batchRefusal && !batch
        ? unavailable
        : noRequestSent
          ? [...new Set([...input.anchors, ...input.files, ...input.skipped].map((file) => file.path))]
          : [...new Set([...missed, ...overBudget, ...conditionalUnreviewed])]

    const skippedFiles = hold?.held.length
      ? [...input.skipped, ...hold.held.map((file) => ({ path: file.path, reason: "held-back" as const }))]
      : input.skipped
    const specialists = [...asked, ...(verify ? [verify] : []), ...(judged ? [judged] : [])].map((entry) => ({
      name: entry.name,
      ...lensField(entry),
      status: entry.status,
      steps: entry.steps,
      ...(entry.detail ? { detail: entry.detail } : {}),
    }))

    const strict = strictMode
      ? yield* Effect.gen(function* () {
          const requested = new Set(candidates)
          const pool = refused
            ? []
            : eligible.map((finding) => {
                const verdict = requested.has(finding) ? verdicts.get(finding.id) : undefined
                return verdict ? { ...finding, verified: verdict === "confirmed" } : finding
              })
          const unanswered = refused
            ? []
            : [
                ...new Set([
                  ...hidden,
                  ...[...candidates, ...claims]
                    .filter((candidate) => !verdicts.has(candidate.id))
                    .map((candidate) => candidate.id),
                ]),
              ]
          if (!refused && input.observe)
            observe({ type: "strict-candidates", findings: structuredClone(pool), unanswered: [...unanswered] })
          const review = yield* checkStrict({
            findings: pool,
            recordScope: !!input.observe && !refused && !uncommitted,
            ...(trusted ? { trustedRules: trusted } : {}),
            ...(certificateSchema
              ? {
                  certificates: new Map(
                    (verify?.status === "ok" ? (verify.value ?? []) : []).flatMap((row) =>
                      row.certificate && candidateIds.has(row.id) ? [[row.id, row.certificate] as const] : [],
                    ),
                  ),
                }
              : {}),
            anchors: input.anchors,
            directory: input.directory,
            head: input.head,
            base: input.base,
            config: { ...strictKeys, maxComments: config.maxComments, suggestions: config.suggestions },
            trust: input.trust,
            verifier: nameOf(model),
            unanswered,
            coverage: { partial, unreviewed: missedCoverage, skipped: skippedFiles, specialists, held: hold?.held },
            changePaths: files.map((file) => file.path),
            pending: [...normalized, ...prior]
              .filter((item) => unanswered.includes(item.id))
              .flatMap((item) => {
                const path = lookupFile(index, item.path)?.file.path
                return path ? [path] : []
              }),
            uncommitted,
            denied: strictDenied,
            deadline,
            signal: input.stopSignal,
            ...(hold ? { holdback: "secrets" as const } : {}),
            ...(judgeModel && finalCall.length
              ? { judge: { model: nameOf(judgeModel), answered: new Set(finalCall.map((row) => row.id)) } }
              : {}),
          })
          if (input.observe && review.scopeDrops.length)
            observe({ type: "scope-drops", base: input.base, drops: review.scopeDrops })
          return review
        })
      : undefined
    const unreviewed = strict?.unreviewed ?? missedCoverage
    const listed = refused ? [] : strict ? strict.listed : findings
    const outside = [...new Set(listed.map((finding) => finding.path))].filter((file) => !lookupFile(index, file))
    const known = new Map(
      yield* Effect.forEach(outside, (file) =>
        Effect.tryPromise(() => input.knownPath(file)).pipe(
          Effect.catch(() => Effect.succeed(false)),
          Effect.map((found) => [file, found] as const),
        ),
      ),
    )
    const skipped = new Set([...input.skipped.map((file) => file.path), ...heldPaths])
    const selection = selectFindings({
      findings: listed,
      ...(trusted ? { trustedRules: trusted, ruleCounts: refused ? [] : ruleCounts } : {}),
      anchors: input.anchors,
      head: input.head,
      trust: input.trust,
      mode: input.mode,
      config,
      prior: refused ? [] : input.prior,
      ...(input.focus ? { focus: input.focus } : {}),
      inlinePosted: input.inlinePosted ?? 0,
      ignored: (file) => skipped.has(file) || classifyPath(file, { config }) !== undefined,
      knownPath: (file) => known.get(file) ?? true,
      teamDismissed: input.context.teamDismissed,
      dropped:
        refused || strict
          ? []
          : [
              ...(rejected ? [{ reason: "rejected-by-verify" as const, count: rejected }] : []),
              ...(unconfirmed ? [{ reason: "unconfirmed" as const, count: unconfirmed }] : []),
            ],
      modelRisk: refused || noRequestSent || strict ? "low" : report.risk,
      sensitiveChanged: !refused && !noRequestSent && input.files.some((file) => isSensitivePath(file.path)),
      changedLines:
        refused || noRequestSent ? 0 : input.files.reduce((sum, file) => sum + file.additions + file.deletions, 0),
    })

    function uncovered(ids: SessionID[]) {
      return Effect.gen(function* () {
        const covered = new Set([
          ...split.inline.map((file) => file.path),
          ...report.files.map((file) => file.path),
          ...report.findings.map((finding) => finding.path),
        ])
        const messages = yield* Effect.forEach(ids, (id) =>
          sessions.messages({ sessionID: id }).pipe(Effect.catch(() => Effect.succeed([]))),
        )
        for (const part of messages.flat().flatMap((message) => message.parts)) {
          if (part.type !== "tool" || part.tool !== "read") continue
          const read = part.state.input["filePath"]
          if (typeof read === "string") covered.add(path.isAbsolute(read) ? path.relative(input.directory, read) : read)
        }
        return files.map((file) => file.path).filter((file) => !covered.has(file))
      })
    }

    // What the review says about its verify pass. The shared policy (plan.ts) accounts for every candidate left without
    // a verdict, whether or not the pass finished. The legacy rule notes a skipped pass and, after a triage pass, one
    // that did not finish.
    const triageNote = (why: "unfinished" | "unanswered") =>
      unconfirmed ? [noteTriageUnchecked(unconfirmed, nameOf(triage), nameOf(model), why)] : []
    const fixedNote = claims.length ? [noteTriageFixedUnchecked(claims.length, nameOf(triage), nameOf(model))] : []
    const verifyNotes = !verify
      ? []
      : shared
        ? [
            ...(triaged ? triageNote(finished ? "unanswered" : "unfinished") : []),
            ...(triaged && !finished ? fixedNote : []),
            ...(unanswered ? [noteVerifyUnfinished(unanswered, finished ? "unanswered" : unfinished(verify))] : []),
          ]
        : triaged && !finished
          ? [...triageNote("unfinished"), ...fixedNote]
          : verify.status === "skipped"
            ? [noteVerifySkipped()]
            : []

    const spentByPass = yield* passes()
    // WP A35: how many labs checked what this review reports, for the "Checked by a second lab" line.
    const labs = checkedLabs({
      model,
      ...(triaged ? { triage } : {}),
      ...(judgeModel ? { judge: judgeModel } : {}),
      verified: verify?.status === "ok",
      judged: judged?.status === "ok",
    })
    const measuredCost = yield* measure()
    // Missing settlement of one admitted attempt cannot turn into an exact receipt just because
    // another attempt recorded priced tokens. Keep normal outcomes unchanged outside batch mode.
    const cost = (batch || input.accountBatchSpend) && state.incomplete ? { ...measuredCost, partial: true } : measuredCost
    // Model evidence (VS-07), only when review.json opts in: notes on what VectorScope's evaluation says about the
    // models, after the replies are known. It never changes which model ran. Under "zdr" the review ran on zero data
    // retention routes only, which admission, the transport and the session runtime enforce (VS-23c), so its scope is
    // the zdr route's.
    const evidenceNotes =
      config.modelEvidence === "warn"
        ? modelEvidenceNotes(
            assessReview({
              review: subjectOf(model),
              ...(triaged ? { triage: subjectOf(triage) } : {}),
              scope: evidenceScope({
                adapter: "engine",
                offlineDiagnostics:
                  checks !== undefined && checks.incomplete !== "unavailable" && checks.incomplete !== "cancelled",
                config,
                ...(triaged ? { triage: nameOf(triage) } : {}),
                ...(zdr ? { route: "zdr" as const } : {}),
              }),
              served: state.served,
              now: Date.now(),
              ...(input.certificates ? { certificates: input.certificates } : {}),
            }),
          )
        : []
    const incomplete = state.incomplete
      ? [
          "Reported cost may be incomplete; work with uncertain usage retained its estimated budget exposure for this review.",
        ]
      : []
    return {
      report: refused
        ? { summary: "", risk: "low", files: [], findings: [] }
        : strict
          ? {
              summary: "",
              risk: selection.risk,
              files: [],
              findings: listed,
              ...(checked.priorStatus
                ? {
                    priorStatus: checked.priorStatus.filter(
                      (entry) => strict.result.complete || entry.status !== "fixed",
                    ),
                  }
                : {}),
            }
          : lensCandidates.size
            ? { ...checked, findings }
            : checked,
      selection: {
        ...selection,
        ...(overBudget.size && !refused ? { diffIncomplete: true as const } : {}),
        ...(strict
          ? {
              strict: strictSummary(strict.result),
            }
          : {}),
      },
      ...(strict ? { strict: strict.result } : {}),
      skipped: skippedFiles,
      ...(noRequestSent ? {} : { cost: { ...cost, ...(labs ? { labs } : {}) } }),
      ...(!noRequestSent && spentByPass.length ? { passes: spentByPass } : {}),
      durationMs: Date.now() - started,
      base: input.base,
      head: input.head,
      ...(input.since ? { since: input.since } : {}),
      mode: input.mode,
      ...(partial ? { partial } : {}),
      unreviewed,
      specialists,
      sessions: [...sessionIDs],
      stats: changeStats(input.files),
      // A refusal says what was sent before it, and nothing about passes it stopped.
      notes: refused
        ? [
            notePrivacyRefused({
              ...refused,
              attempts: [...tracks.values()].reduce((sum, track) => sum + track.attempts + track.finalizeAttempts, 0),
            }),
            ...snapshotNotes,
            ...checkNotes,
            ...holdNotes,
            ...incomplete,
          ]
        : [
            ...(noRequestSent ? [BUDGET_REQUEST_CHANGED] : []),
            ...picked.notes,
            ...snapshotNotes,
            ...(strict?.preExistingUnchecked
              ? [
                  `The merge-base evidence was unavailable for ${strict.preExistingUnchecked} retained ${strict.preExistingUnchecked === 1 ? "finding" : "findings"}. The introduced-by-change check could not rule out a pre-existing defect.`,
                ]
              : []),
            ...ruleCheckNotes(ruleCounts),
            ...(graph && uncommitted
              ? ["Impact context is unavailable for staged or uncommitted changes."]
              : graph && !impact && !input.stopSignal?.aborted
                ? [impactNote(["error"])]
                : impact?.slice.incomplete?.length
                  ? [impactNote(impact.slice.incomplete, impact.slice.unsearched)]
                  : []),
            ...(impact?.slice.promptOmitted === "budget"
              ? ["The impact context did not fit the review's context budget."]
              : []),
            ...(overBudget.size
              ? [
                  `Changed files left unreviewed because their diffs exceeded the context budget include ${[...overBudget].slice(0, 10).map(codeSpan).join(", ")}${overBudget.size > 10 ? ` and ${overBudget.size - 10} more` : ""}.`,
                ]
              : []),
            ...dispatchNotes,
            ...(auto ? ReviewDepth.notes(auto, specialists) : []),
            ...(lenses.length ? [`Single-class lens passes: ${lenses.join(", ")}.`] : []),
            ...checkNotes,
            ...holdNotes,
            ...(judgeModel && judgeText && judged?.status !== "ok" ? [noteJudgeUnfinished(nameOf(judgeModel))] : []),
            ...(strictMode ? [] : verifyNotes),
            ...incomplete,
            ...evidenceNotes,
          ],
      ...(hold?.held.length ? { held: hold.held } : {}),
    } satisfies ReviewOutcome
  })

  return yield* body.pipe(
    Effect.map((outcome) =>
      batch
        ? finishReviewBatch(
            fullInput,
            batch,
            outcome,
            unavailable,
            batchRefusal,
            [...tracks.values()].some((track) => track.attempts > 0 || track.finalizeAttempts > 0),
          )
        : batchRefusal
          ? {
              ...outcome,
              selection: { ...outcome.selection, diffIncomplete: true as const },
              notes: [...outcome.notes, batchRefusal],
            }
          : outcome,
    ),
    Effect.ensuring(
      Effect.sync(() => input.stopSignal?.removeEventListener("abort", stop)).pipe(
        Effect.andThen(unsubscribe),
        Effect.andThen(Scope.close(scope, Exit.void)),
      ),
    ),
    // Its own finalizer, so the process-global registry is emptied of this review's sessions whatever the steps above
    // do; VS-23c's transport backstop reads it by session ID.
    Effect.ensuring(Effect.sync(() => sessionIDs.forEach((id) => ReviewRoutes.release(id)))),
  )
})

// VS-34: what the prompts quote under holdback "secrets": the files and head files sent (credential files held back,
// values redacted), and the untrusted context blocks the same way, with the pull request's text and the earlier
// findings among them.
function changeStats(files: DiffFile[]) {
  return {
    files: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  }
}

function holdback(input: RunInput) {
  const result = holdbackFiles(input.files, {
    ...(input.headFiles ? { headFiles: input.headFiles } : {}),
    ignored: input.ignored ?? [],
  })
  return {
    ...result,
    context: holdbackContext(
      { ...input.context, ...(input.pr ? { pr: input.pr } : {}), prior: input.prior },
      { held: result.held },
    ),
  }
}

type Chosen = ResolvedModel & { lab?: string }

// WP A35: the models the review's passes run on (second-lab.ts). The plan's review pair comes from Vector Codium's
// listing, which names each entry's part in it; review.json's judgeModel is resolved here when the caller did not.
const chooseModels = Effect.fnUntraced(function* (input: RunInput, provider: Provider.Interface) {
  const plan = ModelPlanStatus.PROVIDER_ID
  const codium = input.model.providerID === plan && !input.triage
  const judgeName = input.config.panel && !input.judge ? input.config.judgeModel : undefined
  const listed = codium ? ((yield* provider.list())[ProviderV2.ID.make(plan)]?.models ?? {}) : {}
  const role = (name: "triage" | "confirm" | "panelJudge"): Chosen | undefined => {
    const entry = Object.values(listed).find(
      (item) => item.codium?.review?.includes(name) && !item.codium.locked && !item.codium.auto,
    )
    return entry && resolved(entry)
  }
  const judge = input.judge ?? (judgeName ? yield* resolveName(provider, judgeName) : undefined)
  return reviewModels<Chosen>({
    model: input.model,
    ...(input.triage ? { triage: input.triage } : {}),
    ...(judge ? { judge } : {}),
    panel: input.config.panel,
    ...(codium ? { codium: { triage: role("triage"), confirm: role("confirm"), panelJudge: role("panelJudge") } } : {}),
    auto: input.model.providerID === plan && input.model.modelID === ModelPlanStatus.AUTO_ID,
  })
})

// A model the runner picked itself, as the callers' resolveReviewModel would describe it.
function resolved(model: Provider.Model): Chosen {
  const codium = model.providerID === ModelPlanStatus.PROVIDER_ID
  const price = !codium && !isFreeModel(model) ? SpendGuard.priceOf(model.cost) : undefined
  return {
    providerID: model.providerID,
    modelID: model.id,
    context: model.limit.context,
    ...(price ? { price } : {}),
    costKind: codium ? "codium" : isFreeModel(model) ? "free" : price ? "priced" : "unknown",
    ...(model.codium?.lab ? { lab: model.codium.lab } : {}),
  }
}

function resolveName(provider: Provider.Interface, name: string) {
  const ref = Provider.parseModel(name)
  return provider.getModel(ref.providerID, ref.modelID).pipe(
    Effect.map(resolved),
    Effect.catch(() => Effect.succeed(undefined)),
  )
}

// A finding's id is its fingerprint over the path, category, title words and the code it is anchored to, so the
// same finding keeps its id when lines shift or the title's words are reordered.
export function normalizeFindings(findings: ModelFinding[], source: Finding["source"], anchors: DiffFile[]): Finding[] {
  const index = buildAnchorIndex(anchors)
  return findings.map((finding) => {
    const side = finding.side ?? "RIGHT"
    const file = lookupFile(index, finding.path)?.file.path ?? finding.path
    const anchored = resolveAnchor(index, { ...finding, side })
    const code = anchored.ok ? anchorText(index, anchored.anchor) : ""
    return {
      ...finding,
      path: file,
      side,
      source,
      id: fingerprint(file, finding.category, normalizeTitle(finding.title), normalizeCode(code)),
    }
  })
}

function strictSummary(strict: NonNullable<ReviewOutcome["strict"]>) {
  return { complete: strict.complete, findingCount: strict.findings.length, dropped: strict.dropped }
}

function nameOf(model: Pick<ResolvedModel, "providerID" | "modelID">) {
  return `${model.providerID}/${model.modelID}`
}

// What model evidence reads about a model. One built without the resolver gives only its name and whether it is free,
// so its note says nothing about why it was used.
function subjectOf(model: ResolvedModel): ModelSubject {
  return (
    model.subject ?? {
      model: nameOf(model),
      ...(model.variant ? { variant: model.variant } : {}),
      free: model.costKind === "free",
    }
  )
}

// Why a verify pass did not finish, for its note: skipped or denied for budget, out of time, or anything else.
function unfinished(verify: Pick<Asked<unknown>, "status" | "stop" | "detail">) {
  if (verify.status === "timeout" || verify.stop === "timeout" || verify.detail === "time") return "time" as const
  if (verify.stop === "budget" || verify.detail === "budget") return "budget" as const
  return "unfinished" as const
}

function lastText(message: SessionV1.WithParts | undefined) {
  return message?.parts.findLast((part) => part.type === "text")?.text ?? ""
}

// Why a reviewer failed, from its turns in order. A turn that only missed the report or was stopped says less than a
// provider's own error, which can come from either turn: a first turn refused by the provider makes the finalizer miss
// the report too, and a first turn that answered in prose leaves the finalizer to hit, say, an empty balance.
function errorOf(messages: (SessionV1.WithParts | undefined)[]) {
  const errors = messages.flatMap((message) =>
    message?.info.role === "assistant" && message.info.error ? [message.info.error] : [],
  )
  const error = errors.find((item) => !VAGUE_ERRORS.has(item.name)) ?? errors[0]
  if (!error) return undefined
  const data: { message?: unknown } | undefined = error.data
  return typeof data?.message === "string" ? `${error.name}: ${data.message}` : error.name
}

const VAGUE_ERRORS = new Set(["StructuredOutputError", "MessageAbortedError"])

// The review's summary and file notes lead; the security specialist's findings and notes are added to them.
function mergeReports(reports: ModelReport[]): ModelReport {
  const rank: Risk[] = ["low", "medium", "high"]
  const files = new Map(
    reports
      .flatMap((report) => report.files)
      .toReversed()
      .map((entry) => [entry.path, entry.note]),
  )
  const prior = new Map(
    reports
      .flatMap((report) => report.priorStatus ?? [])
      .toReversed()
      .map((entry) => [entry.id, entry]),
  )
  return {
    summary: reports.find((report) => report.summary.trim())?.summary ?? "",
    risk: reports.reduce<Risk>(
      (risk, report) => (rank.indexOf(report.risk) > rank.indexOf(risk) ? report.risk : risk),
      "low",
    ),
    files: [...files].toReversed().map(([file, note]) => ({ path: file, note })),
    findings: reports.flatMap((report) => report.findings),
    ...(prior.size ? { priorStatus: [...prior.values()].toReversed() } : {}),
  }
}

export * as Review from "./run"
