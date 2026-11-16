// ReviewEval.replay (VectorScope plan, Phase 0 "Runner and baselines"): one case through the production engine
// pipeline with nothing replaced but the GitHub writes. The range, the pull request's files and the context come from
// ReviewSource and ReviewContext over a local checkout that already holds the case's commits; Review.run runs the
// specialists with their real read tools, the finalize and verify passes, selection, anchoring and its own step,
// dollar and time limits. What a first review of the pull request would post is built with the core builders the
// GitHub job uses, redacted, put through the posting check and handed to a posting adapter, which records it instead
// of sending it. The artifact names the source, settings, models and prompts by digest and lists every provider
// attempt, admitted or refused, with what it settled at.
//
// Settings come from the case's base commit, as in CI, so the change under review cannot choose them, except its limits:
// the dollar cap, steps and time come from the eval alone, and a replay without its own positive dollar cap is refused,
// since a dataset's review.json could otherwise lift them. Nothing is fetched: a missing commit is an error, never a
// network request. An untrusted case replays only under the GitHub review job's isolation (VECTOR_PURE and
// VECTOR_DISABLE_PROJECT_CONFIG), so the case's repository cannot load its own config, plugins or tools, and the
// artifact records that isolation. The case's label names the artifact only and never reaches a prompt. The review's
// dollar reservations are its usual estimates; an eval's total budget and per-case bound are a separate ledger in the
// eval driver.
//
// A pipeline variant (VS-21a) arrives only as `variant`: a registry name and the keys it sets over the base's settings,
// which the artifact records with the run. The registry (script/vectorscope-eval/replay.ts) refuses a variant whose
// package has not landed; this replay cannot see the registry, so it refuses any variant that would run the frozen
// pipeline under its name: one with no key and no model requirement, or a key outside VARIANT_KEYS.engine.
//
// ReviewEval.project (VS-21b) runs the same replay against a fake model server on this computer, so every pass runs,
// verify, the finalizer and retries included, and records each pass's real wire body with its estimated tokens and
// dollars. It is the only caller of Review.run's projection hook, which runs what the dollar cap alone would refuse;
// so before anything boots a provider it refuses a run with model catalogs fetched, without the strict egress guard,
// against a fake server that is not on this computer, or on a model with no price snapshot or a Vector route, and then
// any model whose requests could go anywhere but that fake server. A run whose egress log saw none of the requests
// the fake server received fails, since that log is not the strict guard's. Its record names every decision the cap
// refused, and from the first one on it describes an uncapped run: the upper side of the cost estimate, not the
// capped paid run. Nothing calls it yet (VS-21c).

import { createHash } from "node:crypto"
import path from "path"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import {
  parseReviewConfig,
  parseReviewRules,
  REVIEW_CONFIG_PATH,
  REVIEW_RULES_PATHS,
  rulesForPaths,
  SOURCED_REVIEW_KEYS,
  type SourcedReviewKey,
} from "@vectordevai/core/review/config"
import {
  buildNoteBody,
  buildReviewBody,
  buildSummaryBody,
  inlineLeads,
  noteFailed,
  noteGeneratedHeaders,
  noteInlineCap,
  noteNothingToReview,
  notePartial,
} from "@vectordevai/core/review/format"
import { buildCreateReviewPayload, type CreateReviewPayload } from "@vectordevai/core/review/github-payload"
import {
  classifyFiles,
  classifyPath,
  DEFAULT_IGNORES,
  generatedHeaderDecision,
  hasGeneratedHeader,
  parseGitAttributes,
} from "@vectordevai/core/review/ignore"
import {
  estimateDispatch,
  type DispatchEstimate,
  type PassEstimate,
  type Shrink,
} from "@vectordevai/core/review/dispatch"
import { VARIANT_KEYS, VARIANT_NAME, type SliceUtilisation } from "@vectordevai/core/review/eval"
import type { ImpactRecord } from "@vectordevai/core/review/impact"
import { evidenceScope, type EvidenceScope } from "@vectordevai/core/review/model-evidence"
import { estimateCostUsd, nextStepCostUsd, type ReviewPrice } from "@vectordevai/core/review/plan"
import { MAX_HITS, MAX_SYMBOLS, type RelatedCode } from "@vectordevai/core/review/prompt"
import { Flag } from "@vectordevai/core/flag/flag"
import { sendsToOpenRouter } from "@vectordevai/core/free-model-catalog"
import { EgressGuard } from "@vectordevai/core/local-mode/guard"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { redactSecrets } from "@vectordevai/core/review/redact"
import { nextState } from "@vectordevai/core/review/state"
import {
  DEFAULT_REVIEW_CONFIG,
  UNAPPLIED_REVIEW_KEYS,
  type CostKind,
  type ReviewConfig,
  type ReviewOutcome,
  type SkippedFile,
  type Trigger,
  type Trust,
} from "@vectordevai/core/review/types"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { measureCost } from "@/cli/cmd/github.evidence"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { Git } from "@/git"
import { Provider } from "@/provider/provider"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { ReviewContext } from "./context"
import type { ResolvedModel } from "./model"
import { Review, type Observation } from "./run"
import { ReviewSource } from "./source"

export interface ReplayCase {
  label: string // names the case in the artifact; never sent to a model
  directory: string // the engine instance's checkout: at `head` for a trusted case, never at `head` for an untrusted one
  base: string // full SHA of the commit the change was made against; settings are read from it
  head: string // full SHA of the change under review
  trust: Trust
  // "command" by default: a writer asked for the review, so the automatic size and fork skips do not apply.
  trigger?: Extract<Trigger, "auto" | "command">
  repository?: { owner: string; repo: string; url?: string }
  baseRef?: string
  pr?: { number: number; title: string; body: string; author?: string }
}

// The two writes a first review makes. A replay's adapter records them; see recordingPosting.
export interface Posting {
  createReview(pr: number, payload: CreateReviewPayload): Promise<{ id: number }>
  createIssueComment(pr: number, body: string): Promise<{ id: number; html_url: string }>
}

// The posting check every write goes through first, as the CLI's `posting` dependency takes it: the parts of one
// post, the sessions that wrote them, and whether the change is untrusted. A check that fails posts nothing.
export type PostingCheck = (input: {
  parts: readonly string[]
  sessionIDs: readonly string[]
  untrusted: boolean
}) => Effect.Effect<readonly string[], unknown>

export interface ReplayInput {
  case: ReplayCase
  model: ResolvedModel
  triage?: ResolvedModel
  // The eval's own settings, applied over the base's review.json: its limits, and settings a test fixes. Its
  // maxCostUsd must be a positive cap, and it alone sets maxCostUsd, maxSteps and timeoutMinutes (the defaults where
  // it leaves the last two out). It never sets a variant's key (VARIANT_KEYS.engine): that goes in `variant`. Nor does
  // it set a route setting (SOURCED_REVIEW_KEYS: privacy, zdrAttested), which comes only from a trusted source through
  // mergeReviewConfig once a runner enforces it (VS-23b). Nor a key no runner applies yet (core UNAPPLIED_REVIEW_KEYS:
  // VS-24's trivial and maxInputTokens, VS-25b's impact, VS-27's guardrail, VS-42's scopeGate, VS-44's verifyEvidence,
  // VS-28's depth and lenses, and VS-30's runtime, which is also trusted-only). The type says so, and step 0b refuses
  // any of them from an untyped caller.
  config?: Partial<
    Omit<ReviewConfig, (typeof VARIANT_KEYS.engine)[number] | SourcedReviewKey | (typeof UNAPPLIED_REVIEW_KEYS)[number]>
  >
  // The pipeline variant the eval admitted the replay for (admitReplay), applied over the base's settings and `config`.
  // Absent for the frozen pipeline.
  variant?: Omit<VariantRecord, "applied">
  posting: Posting
  check: PostingCheck
  secrets?: string[] // values redacted from everything posted
  repetition?: number
  source?: { vector?: string; manifest?: string } // the Vector commit and the dataset manifest digest under test
  now?: () => number
}

type Pass = ReviewOutcome["specialists"][number]["name"]
type Attempt = Extract<Observation, { type: "attempt" }>
type Settle = Extract<Observation, { type: "settle" }>

export interface ModelRecord {
  id: string // "provider/model"
  variant?: string
  context: number
  costKind: CostKind
  price?: ReviewPrice // the pricing snapshot the review's admission used
}

export type AttemptRecord = Omit<Attempt, "type"> & {
  seq: number
  settled?: Omit<Settle, "type" | "pass" | "phase"> // absent when an admitted attempt never settled
  // VS-21e: the reasoning tokens of the provider call this attempt admitted, from its session's step record; absent when
  // the provider reported none or the step cannot be told apart (step 8). Recording only.
  reasoning?: number
}

export type PostedRecord =
  | { write: "createReview"; pr: number; payload: CreateReviewPayload }
  | { write: "createIssueComment"; pr: number; body: string }

// A pipeline variant as a replay records it (VS-21a). `name` is its registry name (script/vectorscope-eval/replay.ts,
// VARIANTS), such as "engine:shared-verify". `keys` are the settings it set over the base's review.json, as the runner
// read them. `models: "triage-pair"` marks a variant made by its models rather than a key: a triage model other than
// the review model (VS-29a's cross-family pair). `applied` is false when the desktop adapter could not hand every key
// to its runner, so the run was the frozen pipeline's; the engine replay never sets it.
export interface VariantRecord {
  name: string
  keys: Partial<ReviewConfig>
  models?: "triage-pair"
  applied?: boolean
}

// What an artifact's `variant` may hold: VS-21a's record, or VS-06's, the verify policy alone, in an artifact written
// before VS-21a. Read it with replayVariant (script/vectorscope-eval/replay.ts), which names both.
export type ReplayVariant = VariantRecord | { verifyPolicy?: ReviewConfig["verifyPolicy"]; applied?: boolean }

// One step of VS-24's pre-dispatch shrink, in the order it ran: the lever core dispatch.ts's decideDispatch named, and
// the estimate after it, which holds both the legacy range the gate decides on and VS-40's v2 beside it, per pass.
// Nothing writes it before VS-24 wiring.
export interface ShrinkStep {
  step: Shrink
  estimate: DispatchEstimate
}

export interface PlacedRecord {
  id: string
  path: string
  line: number
  startLine?: number
  side: "RIGHT" | "LEFT"
  severity: string
  category: string
  title: string
  source: "review" | "security"
  verified: boolean
}

export interface ReplayArtifact {
  version: 1
  label: string
  adapter: "engine"
  repetition: number
  runtime: { node: string; bun?: string; platform: string; arch: string; isolation: Isolation }
  source: { repository?: string; base: string; head: string; mergeBase: string; vector?: string; manifest?: string }
  trust: Trust
  trigger: Trigger
  config: { digest: string; warnings: string[]; value: ReviewConfig }
  // The pipeline variant the eval asked for, when it named one, so the report can tell a variant's replays from the
  // frozen pipeline's. This replay writes a VariantRecord; an artifact written before VS-21a holds VS-06's record.
  variant?: ReplayVariant
  // What a model certificate (core model-evidence.ts, VS-07) made from this replay would cover: the runner, pipeline
  // revision, prompts, review settings and triage model.
  scope: EvidenceScope
  rules: { digest: string }
  models: { review: ModelRecord; triage?: ModelRecord }
  context: {
    digest: string
    related: number
    history: number
    instructions: boolean
    headFiles: number
    // "path:line" of every code location the prompt quotes as context, in prompt order and each once, to be joined
    // with the case's labels offline only: today the related-code call sites, and VS-25b's impact slice after them.
    // The changed files, history and instructions carry no line and are left out. Absent before VS-21a.
    locations?: string[]
  }
  // VS-25b's Tier 1 impact slice as core impact.ts's ImpactRecord: its stage counts and drops, the scan plan, git's
  // version, the clone mode, grep, parse and total time, tokens, tests, unsupported files and why it is incomplete.
  // Absent until VS-25b wiring builds the slice inside Review.run; context.locations then gains the slice's locations.
  tier1?: ImpactRecord
  files: { reviewed: string[]; skipped: SkippedFile[] }
  // Each pass's prompt, and, for a pass that had a session, its wall time and cache use from the messages of every
  // session of that name: `startMs` after the first message of any pass, `ms` from its first message created to its
  // last completed, and the cache reads and writes measureCost counts, so `cacheRead` is the outcome's `passes` entry
  // of the same name's. A pass planned and skipped, or refused before its session, has none of the four.
  passes: {
    pass: Pass
    model: string
    digest: string
    chars: number
    startMs?: number
    ms?: number
    cacheRead?: number
    cacheWrite?: number
    reasoning?: number // VS-21e: the reasoning tokens measureCost counts; absent when the provider reported none
  }[]
  // VS-24's first pre-dispatch estimate, before any shrink, then its shrink steps, in order. Both absent until VS-24
  // wiring.
  dispatch?: DispatchEstimate
  shrink?: ShrinkStep[]
  // VS-49's slice utilisation (core eval.ts SliceUtilisation), from the passes' session events at zero tokens: each
  // pass's tool calls by name, the paths it read inside and outside the slice's own locations, its greps for names the
  // slice shows, where each proposed finding's evidence falls, and each lens's received and cited locations. Absent
  // until the VS-49 wiring observer fills it; its slice is empty without `tier1`. It enters no digest. The eval's
  // replay.ts utilisationProblems checks it against the rest of the artifact.
  utilisation?: SliceUtilisation
  attempts: AttemptRecord[]
  tools: { pass?: Pass; tool: string; status: string; input: Record<string, string | number | boolean> }[]
  outcome?: ReviewOutcome // absent when nothing was left to review and no model was asked
  placed: PlacedRecord[] // the findings that would go on lines, where they would go
  posted: PostedRecord[] // what the posting adapter was handed, after redaction and the posting check
  refused?: string // the posting check failed, so nothing after it was posted
}

// The isolation the engine instance ran the review under, as the GitHub review job sets it (core review/workflow.ts:
// VECTOR_PURE, VECTOR_DISABLE_PROJECT_CONFIG and lsp, formatter and snapshot off).
export interface Isolation {
  pure: boolean // VECTOR_PURE: no project plugins or workspace trust
  projectConfig: boolean // whether the checkout's own vector.json and .vector settings could load
  trusted: boolean // the workspace was trusted, so its language servers and formatters could run
  lsp: boolean // language servers could start
  formatter: boolean // formatters could run
  snapshot: boolean // file snapshots were on
}

export class ReviewEvalError extends Schema.TaggedErrorClass<ReviewEvalError>()("ReviewEvalError", {
  message: Schema.String,
}) {}

// A request the loopback provider received (VS-21b): its X-Session-Id header and its raw body, exactly as they
// arrived. No other header is kept.
export interface WireRequest {
  sessionID?: string
  path: string
  body: string
}

// A projection's input: a replay's, with the posting adapter and check its own (a recording adapter and a check that
// passes every part), and the logs it records against.
export interface ProjectionInput extends Omit<ReplayInput, "posting" | "check" | "secrets"> {
  // The fake server's base URL, on this computer. Every URL a model's requests may name must have its origin: a
  // gateway elsewhere on this computer may forward to a paid API.
  server: string
  // Every request the loopback provider has received so far, in the order they arrived.
  received: Effect.Effect<readonly WireRequest[]>
  // The strict egress guard's log of connection attempts (EgressGuard.Handle["attempts"]): the one installStrict
  // returns in VS-21c's entry point, NetworkGuard's in tests.
  egress: EgressGuard.Handle["attempts"]
}

// A dollar-cap decision the projection ran anyway (Review.OverCap). Its `estimateUsd` is the whole reservation that went
// over the cap: at a turn's "attempt", the turn's estimate and the finalizer share beside it, twice its request's
// `estimateUsd`. `attempt` is the seq of the provider attempt it admitted, for a decision made at admission
// ("attempt"); the others came before a session, a finalizer or verify.
export type ProjectedOverCap = Review.OverCap & { attempt?: number }

// One request a pass sent, paired with the admitted attempt it was sent for.
export interface ProjectedRequest {
  seq: number // the attempt's seq in the replay's attempt order
  phase: "turn" | "finalize"
  estimateUsd: number // admission's estimate for it
  lifted?: true // admitted only because the projection ran a decision the dollar cap refused
  digest: string
  chars: number
  tokens: number // chars / CHARS_PER_TOKEN, rounded up: the whole JSON body, system prompt and tools included
  stepUsd?: number // nextStepCostUsd(tokens, price): this request as input plus one step of output
  body: string
}

// One planned pass: its prompt, every request its sessions sent, and what estimateCostUsd makes of its first one.
export interface ProjectedPass {
  pass: Pass
  model: string
  maxSteps: number
  status?: ReviewOutcome["specialists"][number]["status"]
  digest: string // of its prompt
  chars: number
  requests: ProjectedRequest[]
  promptTokens?: number // its first request's tokens
  usd?: { low: number; high: number } // estimateCostUsd({ promptTokens, maxSteps, price }), with its model's price
  // VS-40's estimate v2 of the same first request (core dispatch.ts estimateDispatch), with its model's price. The
  // projection cannot see whether the route caches, so it assumes what the legacy low band does: a price that lists a
  // cache read is a caching route.
  v2?: PassEstimate["v2"]
  lifted?: ProjectedOverCap // its first decision the dollar cap refused and the projection ran
  unsent: number // admitted attempts in its sessions that no request carried
  unadmitted: number // requests in its sessions that no admitted attempt accounts for
}

// What ReviewEval.project records. It has no outcome, placed findings or posts: those come from the fake model.
// `kind` keeps report.ts and certify.ts from ever reading one as a replay. A replay's artifact names prompts only by
// digest and holds redacted posts; this record holds every raw request body, unredacted: whole prompts, the case's
// code and the pull request's untrusted text. It is a sealed eval output, handled at least as strictly as a checkout,
// and is never committed.
export interface ProjectionRecord {
  version: 1
  kind: "projection"
  label: string
  repetition: number
  runtime: ReplayArtifact["runtime"]
  source: ReplayArtifact["source"]
  trust: Trust
  trigger: Trigger
  config: { digest: string }
  variant?: ReplayVariant
  scope: EvidenceScope
  rules: { digest: string }
  context: { digest: string }
  models: ReplayArtifact["models"]
  files: ReplayArtifact["files"]
  // Every decision the dollar cap refused, which the projection ran. From the first on, the record describes an
  // uncapped run: a capped paid run would have stopped that pass there, and every lifted reservation and settlement
  // counts against the other passes too.
  cap: { maxCostUsd: number; over: ProjectedOverCap[] }
  passes: ProjectedPass[]
  unattributed: number // requests that name no session any attempt names
  // The connection attempts the guard logged during the run, and how many of them were refused or went to a host that
  // is not this computer by its name or address.
  egress: { attempts: number; outside: number }
}

const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/
// How Review.run's admission turns prompt text into tokens (run.ts, `/ 3.5` in ask and in verify's estimate), which a
// projection applies to each wire body. A copy, because run.ts holds the rule as a literal and its edits beyond the
// projection hook wait for the runner-wiring window (Q13). That window exports one constant from core plan.ts for
// run.ts, core impact.ts and this file (the deviation log's wiring list); until then the engine eval test checks
// verify's pre-check estimate against this value.
export const CHARS_PER_TOKEN = 3.5
// The SDKs whose requests the loopback provider answers: chat completions and responses.
const PROJECTION_SDKS = ["@ai-sdk/openai-compatible", "@ai-sdk/openai"]

export const replay = (input: ReplayInput) => replayWith(input, false).pipe(Effect.map((result) => result.artifact))

// ReviewEval.project (VS-21b): the replay against the loopback provider, with every decision the dollar cap refuses
// run anyway, and each pass's real wire body recorded with its estimated tokens and dollars.
export const project = Effect.fn("ReviewEval.project")(function* (input: ProjectionInput) {
  // The egress log first, so the record counts the connections providers make as they boot in step 2: a catalog
  // fetch, which VECTOR_DISABLE_MODELS_FETCH stops, would be one.
  const earlier = new Set(input.egress())

  // 1. What needs no provider, before anything boots one: booting providers with catalogs on would fetch them.
  const chosen = [input.model, ...(input.triage ? [input.triage] : [])]
  const refused = projectionRefusal({
    modelsFetchDisabled: Flag.VECTOR_DISABLE_MODELS_FETCH,
    strictGuard: EgressGuard.strictInstalled(),
    server: input.server,
    models: chosen,
  })
  if (refused) return yield* new ReviewEvalError({ message: refused })

  // 2. Where each model's requests would go, as the provider builds them, before any git work or request.
  const provider = yield* Provider.Service
  const unrouted = yield* Effect.forEach(chosen, (model) =>
    Effect.gen(function* () {
      // getProvider indexes the booted providers by ID, so an unknown one is undefined, whatever its type says.
      const info = yield* provider.getProvider(model.providerID)
      const loaded = yield* provider.getModel(model.providerID, model.modelID).pipe(Effect.option)
      return routeRefusal({
        name: `${model.providerID}/${model.modelID}`,
        providerID: model.providerID,
        server: input.server,
        ...(Option.isSome(loaded) ? { model: loaded.value } : {}),
        ...(info ? { options: info.options } : {}),
        ...(model.price ? { price: model.price } : {}),
      })
    }),
  )
  const unroutable = unrouted.find((message) => message !== undefined)
  if (unroutable) return yield* new ReviewEvalError({ message: unroutable })

  // 3. The replay, with the fake server's log taken before and after it.
  const before = (yield* input.received).length
  const replayed = yield* replayWith(
    { ...input, posting: recordingPosting(), check: (call) => Effect.succeed(call.parts) },
    true,
  )
  const wire = (yield* input.received).slice(before)
  const attempts = input.egress().filter((attempt) => !earlier.has(attempt))
  // Each request the fake server received was a connection the strict guard logs. A log that saw none of them is not
  // its log, and a record built on it would claim connections nothing observed.
  if (wire.length > 0 && attempts.length === 0)
    return yield* new ReviewEvalError({
      message: `The egress log saw none of the ${wire.length} requests the fake server received, so it is not the strict guard's log.`,
    })
  return projectionOf({ ...replayed, wire, attempts })
})

// Why a projection cannot start, from what needs no provider: model catalogs that booting a provider would fetch
// (VECTOR_DISABLE_MODELS_FETCH, read when the engine loads, so it must be set in the environment before then), no
// strict egress guard (Vector Local's guard is installed too, but follows the user's policy and logs nothing while
// Vector Local is off), a fake server that is not on this computer, a model whose route chooses its own destination
// (Vector's free models and plans, provider.ts offInLocal), and a model with no price snapshot, whose dollars cannot
// be estimated. It never reads a key.
export function projectionRefusal(input: {
  modelsFetchDisabled: boolean
  strictGuard: boolean
  server: string
  models: readonly Pick<ResolvedModel, "providerID" | "modelID" | "costKind" | "price">[]
}): string | undefined {
  if (!input.modelsFetchDisabled)
    return "A projection boots providers without fetching model catalogs: set VECTOR_DISABLE_MODELS_FETCH=1 in the environment before the engine loads."
  if (!input.strictGuard)
    return "A projection runs only under the strict egress guard (EgressGuard.installStrict), which refuses connections off this computer and logs every attempt the record counts."
  if (!loopbackURL(input.server))
    return `A projection reads its requests from a fake server on this computer, and ${input.server} is not one.`
  const routed = input.models.find(
    (model) => model.providerID === ProviderV2.ID.vector || model.providerID === ModelPlans.PROVIDER_ID,
  )
  if (routed)
    return `${routed.providerID}/${routed.modelID} goes through Vector's own route, which chooses where it sends; a projection needs a model on a server on this computer.`
  const unpriced = input.models.find((model) => model.costKind !== "priced" || !model.price)
  if (unpriced)
    return `${unpriced.providerID}/${unpriced.modelID} has no price snapshot, so a projection cannot estimate its dollars.`
  return undefined
}

// Why a model's requests could go anywhere but the projection's fake server, or to something it cannot answer, if
// they could. It follows where Provider.getLanguage sends them (provider.ts resolveSDK, and the private offInLocal and
// requestOrigins it mirrors): the free-model and OpenRouter routes, a plugin's or sign-in's own fetch, the SDK, and
// every base URL and preconnect a request may name, each of which must be on this computer. The projection lifts the
// dollar cap, so where the SDK sends (provider.ts resolveBaseURL: the configured base URL, else the catalog's) and the
// preconnect must be the fake server itself: this computer alone is not enough, since a gateway on it (a LiteLLM-style
// proxy) may forward to a paid API. A catalog URL a configured base URL replaces (LM Studio's default port, say) is
// not sent to. The price snapshot must be the provider's own price, re-derived from its rates.
export function routeRefusal(input: {
  name: string
  providerID: string
  server: string // the fake server's base URL (ProjectionInput.server)
  model?: { freeModel?: unknown; api: { npm: string; url: string }; cost: Parameters<typeof SpendGuard.priceOf>[0] }
  options?: Record<string, unknown>
  price?: ReviewPrice
}): string | undefined {
  const model = input.model
  const options = input.options
  if (!model || !options) return `${input.name} is not available to this engine.`
  if (model.freeModel) return `${input.name} is a free model, which goes through Vector's free-model route.`
  if (typeof options["fetch"] === "function")
    return `${input.name}'s provider sends through a fetch of its own (a plugin or sign-in), which need not go to its base URL.`
  if (
    sendsToOpenRouter({
      providerID: input.providerID,
      destinations: [model.api.url, model.api.npm, options["baseURL"]],
    })
  )
    return `${input.name} goes to OpenRouter.`
  if (!PROJECTION_SDKS.includes(model.api.npm))
    return `${input.name} uses ${model.api.npm}; the loopback provider answers only ${PROJECTION_SDKS.join(" and ")} requests.`
  const sent = typeof options["baseURL"] === "string" && options["baseURL"] !== "" ? options["baseURL"] : model.api.url
  if (!sent) return `${input.name} names no base URL, so its SDK would choose where it sends.`
  const named = [options["baseURL"], model.api.url, options["preconnect"]].filter(
    (url) => url !== undefined && url !== "",
  )
  const away = named.find((url) => !loopbackURL(url))
  if (away !== undefined) return `${input.name} may send to ${String(away)}, which is not this computer.`
  const server = LocalPolicy.origin(input.server)
  const elsewhere = [sent, options["preconnect"]]
    .filter((url) => url !== undefined && url !== "")
    .find((url) => server === undefined || LocalPolicy.origin(String(url)) !== server)
  if (elsewhere !== undefined)
    return `${input.name} may send to ${String(elsewhere)}, which is not the projection's fake server at ${input.server}.`
  const rates = SpendGuard.priceOf(model.cost)
  if (!rates || !input.price || digest(rates) !== digest(input.price))
    return `${input.name}'s price snapshot is not its provider's price.`
  return undefined
}

// An http(s) URL, with no variable left to fill in, whose host is this computer by its name or address.
function loopbackURL(value: unknown) {
  if (typeof value !== "string" || value.includes("${") || !URL.canParse(value)) return false
  const url = new URL(value)
  return (url.protocol === "http:" || url.protocol === "https:") && LocalPolicy.loopback(url.hostname)
}

const replayWith = Effect.fn("ReviewEval.replay")(function* (input: ReplayInput, projecting: boolean) {
  const git = yield* Git.Service
  const sessions = yield* Session.Service
  const item = input.case
  const directory = item.directory
  const trigger = item.trigger ?? "command"
  const now = input.now ?? Date.now
  const repetition = input.repetition ?? 1
  const show = (rev: string, file: string) => ReviewSource.show({ directory, rev, path: file })

  // 0. The eval's own dollar cap: Review.run admits every attempt against it, and the dataset never sets it.
  const cap = input.config?.maxCostUsd
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0)
    return yield* new ReviewEvalError({
      message:
        "A replay needs the eval's own positive config.maxCostUsd, such as the case bound admitReplay hands out; a dataset's review.json never sets it.",
    })
  // 0b. The variant's name and keys, before any git or instance work.
  const unnamed = variantProblem(input)
  if (unnamed) return yield* new ReviewEvalError({ message: unnamed })

  // 1. The checkout: the reviewer's tools read the engine instance's directory, so it must be this one, holding both
  // commits, with a trusted head checked out and an untrusted one not, as the GitHub job requires.
  const instance = yield* InstanceRef
  if (!instance || path.resolve(instance.directory) !== path.resolve(directory))
    return yield* new ReviewEvalError({ message: `A replay runs in an engine instance on its checkout, ${directory}.` })
  const malformed = [item.base, item.head].filter((sha) => !FULL_SHA.test(sha))
  if (malformed.length)
    return yield* new ReviewEvalError({ message: `A replay needs full commit SHAs, not ${malformed.join(", ")}.` })
  const missing = yield* ReviewSource.missingCommits({ directory, revs: [item.base, item.head] })
  if (missing.length)
    return yield* new ReviewEvalError({
      message: `The checkout does not have ${missing.map(short).join(", ")}, and a replay never fetches.`,
    })
  const checkedOut = (yield* git.run(["rev-parse", "HEAD"], { cwd: directory })).text().trim()
  if (item.trust === "trusted" && checkedOut !== item.head)
    return yield* new ReviewEvalError({
      message: `A trusted case is reviewed in place: check out ${short(item.head)}, not ${short(checkedOut)}.`,
    })
  if (item.trust === "untrusted" && checkedOut === item.head)
    return yield* new ReviewEvalError({
      message: `An untrusted case's head ${short(item.head)} is never checked out: check out its base.`,
    })
  if (item.trust === "untrusted" && !(Flag.VECTOR_PURE && Flag.VECTOR_DISABLE_PROJECT_CONFIG))
    return yield* new ReviewEvalError({
      message:
        "An untrusted case replays only as the GitHub review job runs: set VECTOR_PURE=1 and VECTOR_DISABLE_PROJECT_CONFIG=1, so the case's repository cannot load its own config, plugins or tools.",
    })
  const settings = yield* Config.Service
  const effective = yield* settings.get()
  const trusted = (yield* settings.trust()).trusted
  const isolation: Isolation = {
    pure: Flag.VECTOR_PURE,
    projectConfig: !Flag.VECTOR_DISABLE_PROJECT_CONFIG,
    trusted,
    lsp: !!effective.lsp && trusted,
    formatter: !!effective.formatter && trusted,
    snapshot: effective.snapshot !== false,
  }

  // 2. Settings from the base commit, then the eval's, then the variant's, so the variant's keys are what the runner
  // reads.
  const json = yield* show(item.base, REVIEW_CONFIG_PATH)
  const rulesTexts = yield* Effect.forEach(REVIEW_RULES_PATHS, (file) => show(item.base, file))
  const attributesText = yield* show(item.base, ".gitattributes")
  // A variant that sets the verify policy (VS-06) is read as a repository that chose it would be: under "shared" the
  // base's own "verify" still wins, and without one the policy's default applies.
  const variant = input.variant
  const policy = variant?.keys.verifyPolicy
  const parsed = parseReviewConfig({ json, env: policy ? { REVIEW_VERIFY_POLICY: policy } : {}, trigger })
  // Keys config.ts parses and no runner applies yet (UNAPPLIED_REVIEW_KEYS) are dropped, so a base review.json that sets
  // one is replayed, and recorded, without it. Its "not applied" warning stays in the artifact's warnings.
  const applied: ReviewConfig = { ...parsed.config }
  UNAPPLIED_REVIEW_KEYS.forEach((key) => delete applied[key])
  const config: ReviewConfig = {
    ...applied,
    ...input.config,
    ...variant?.keys,
    maxCostUsd: cap,
    maxSteps: input.config?.maxSteps ?? DEFAULT_REVIEW_CONFIG.maxSteps,
    timeoutMinutes: input.config?.timeoutMinutes ?? DEFAULT_REVIEW_CONFIG.timeoutMinutes,
  }
  const rules = parseReviewRules(rulesTexts.find((text) => text !== undefined) ?? "")
  const attributes = attributesText === undefined ? undefined : parseGitAttributes(attributesText)
  const ignored = (file: string) => classifyPath(file, { config, attributes }) !== undefined

  // 3. A first, full review of merge-base → head.
  const plan = yield* ReviewSource.planRange({
    directory,
    head: item.head,
    base: item.base,
    full: true,
    compare: yield* ReviewSource.localCompare(directory),
    ignored,
  })

  // 4. Path rules, then generated headers, which count only when the base agrees.
  const classified = classifyFiles(plan.files, { config, attributes })
  const decided = yield* Effect.forEach(
    classified.review,
    Effect.fnUntraced(function* (file) {
      const text = file.status === "deleted" ? undefined : yield* show(item.head, file.path)
      if (text === undefined || !hasGeneratedHeader(text)) return { file }
      const baseText = file.status === "added" ? undefined : yield* show(plan.mergeBase, file.oldPath ?? file.path)
      const header = generatedHeaderDecision({
        path: file.path,
        headText: text,
        baseText,
        attributes,
        ignoreDefaults: config.ignoreDefaults,
      })
      return { file, header }
    }),
  )
  const files = decided.filter((entry) => !entry.header?.skip).map((entry) => entry.file)
  const skipped: SkippedFile[] = [
    ...classified.skipped,
    ...decided
      .filter((entry) => entry.header?.skip)
      .map((entry) => ({ path: entry.file.path, reason: "generated" as const })),
  ]
  const generatedNote = noteGeneratedHeaders(
    decided.filter((entry) => entry.header?.reviewedAnyway).map((entry) => entry.file.path),
  )

  // The cheaper first pass, as Review.run reads it: a triage model that is the review model is no triage pass.
  const triaged =
    input.triage && modelRecord(input.triage).id !== modelRecord(input.model).id
      ? modelRecord(input.triage).id
      : undefined
  const common = {
    version: 1 as const,
    label: item.label,
    adapter: "engine" as const,
    repetition,
    runtime: {
      node: process.version,
      ...(process.versions.bun ? { bun: process.versions.bun } : {}),
      platform: process.platform,
      arch: process.arch,
      isolation,
    },
    source: {
      ...(item.repository
        ? { repository: item.repository.url ?? `${item.repository.owner}/${item.repository.repo}` }
        : {}),
      base: item.base,
      head: item.head,
      mergeBase: plan.mergeBase,
      ...input.source,
    },
    trust: item.trust,
    trigger,
    config: { digest: digest(config), warnings: parsed.warnings, value: config },
    ...(variant
      ? {
          variant: {
            name: variant.name,
            keys: variant.keys,
            ...(variant.models ? { models: variant.models } : {}),
          } satisfies VariantRecord,
        }
      : {}),
    scope: evidenceScope({ adapter: "engine", config, ...(triaged ? { triage: triaged } : {}) }),
    rules: { digest: digest(rules) },
    models: { review: modelRecord(input.model), ...(input.triage ? { triage: modelRecord(input.triage) } : {}) },
    files: { reviewed: files.map((file) => file.path), skipped },
  }
  const prNumber = item.pr?.number ?? 0
  const untrusted = item.trust === "untrusted"
  const repo = item.repository ? { owner: item.repository.owner, repo: item.repository.repo } : undefined
  const clean = (text: string) => redactSecrets(text, input.secrets ?? [])
  const posted: PostedRecord[] = []
  const refusal: { message?: string } = {}
  // One post through the posting check, as the GitHub client sends it: a review's body and comments as one text, a
  // comment the check emptied left out. Once the check fails, nothing else is posted.
  const post = Effect.fnUntraced(function* (write: PostedRecord, sessionIDs: readonly string[]) {
    if (refusal.message !== undefined) return
    const parts =
      write.write === "createReview"
        ? [clean(write.payload.body), ...write.payload.comments.map((comment) => clean(comment.body))]
        : [clean(write.body)]
    const checked = yield* input.check({ parts, sessionIDs, untrusted }).pipe(Effect.exit)
    if (Exit.isFailure(checked)) {
      refusal.message = Cause.prettyErrors(checked.cause)[0]?.message ?? "the posting check failed"
      return
    }
    const sent: PostedRecord =
      write.write === "createReview"
        ? {
            ...write,
            payload: {
              ...write.payload,
              body: checked.value[0] ?? "",
              comments: write.payload.comments
                .map((comment, index) => ({ ...comment, body: checked.value[index + 1] ?? "" }))
                .filter((comment) => comment.body.trim()),
            },
          }
        : { ...write, body: checked.value[0] ?? "" }
    if (sent.write === "createReview") yield* Effect.promise(() => input.posting.createReview(sent.pr, sent.payload))
    else yield* Effect.promise(() => input.posting.createIssueComment(sent.pr, sent.body))
    posted.push(sent)
  })

  if (!files.length) {
    const note = buildNoteBody({
      note: noteNothingToReview(),
      state: nextState(undefined, {
        head: item.head,
        base: plan.mergeBase,
        mode: "full",
        now: now(),
        notedHead: item.head,
      }),
    })
    yield* post({ write: "createIssueComment", pr: prNumber, body: note }, [])
    const nothing: ReplayArtifact = {
      ...common,
      context: { digest: digest({}), related: 0, history: 0, instructions: false, headFiles: 0, locations: [] },
      passes: [],
      attempts: [],
      tools: [],
      placed: [],
      posted,
      ...(refusal.message !== undefined ? { refused: refusal.message } : {}),
    }
    return { artifact: nothing, observed: [], over: [] }
  }

  // 5. Context Vector gathers itself, and for an untrusted change its files, which go in the prompt.
  const headFiles = untrusted
    ? yield* ReviewSource.headFiles({ directory, mergeBase: plan.mergeBase, head: item.head, files })
    : undefined
  const gathered = yield* ReviewContext.gather({
    directory,
    base: plan.mergeBase,
    head: item.head,
    files,
    ignore: [...(config.ignoreDefaults ? DEFAULT_IGNORES.map((rule) => rule.glob) : []), ...config.ignore],
    ignored,
    instructions: (file) => show(item.base, file).pipe(Effect.provideService(Git.Service, git)),
  })
  const known = yield* ReviewSource.knownPath({ directory, rev: item.head })

  // 6. The review. A projection runs every decision the dollar cap refuses and keeps it; one made at admission is
  // followed at once by the attempt it admitted, so that attempt's seq is the next one.
  const observed: Observation[] = []
  const over: ProjectedOverCap[] = []
  const outcome = yield* Review.run({
    directory,
    trigger,
    trust: item.trust,
    base: plan.mergeBase,
    head: item.head,
    mode: "full",
    files,
    anchors: plan.files,
    skipped,
    ...(headFiles ? { headFiles } : {}),
    context: gathered,
    ...(item.pr ? { pr: item.pr } : {}),
    prior: [],
    rules: rulesForPaths(
      rules,
      files.map((file) => file.path),
      config.paths,
    ),
    config,
    model: input.model,
    ...(input.triage ? { triage: input.triage } : {}),
    knownPath: known,
    baseRef: item.baseRef ?? "base",
    rulesSource: "base branch",
    inlinePosted: 0,
    observe: (event) => observed.push(event),
    ...(projecting
      ? {
          projection: {
            overCap: (decision: Review.OverCap) => {
              const next = observed.filter((event) => event.type === "attempt").length + 1
              over.push({ ...decision, ...(decision.site === "attempt" ? { attempt: next } : {}) })
              return true
            },
          },
        }
      : {}),
  })

  // 7. What a first review posts: the line comments as one review, then the summary; a review whose every reviewer
  // failed posts only the failure note.
  const selection = outcome.selection
  const reviewers = outcome.specialists.filter((entry) => entry.name !== "verify")
  const failed = reviewers.length > 0 && reviewers.every((entry) => entry.status === "failed")
  const run = digest([item.label, repetition]).slice(0, 8)
  if (failed) {
    const detail = reviewers.find((entry) => entry.detail)?.detail ?? "the model returned no review"
    const state = nextState(undefined, {
      head: item.head,
      base: plan.mergeBase,
      mode: "full",
      now: now(),
      failed: true,
      ...(outcome.cost ? { cost: outcome.cost } : {}),
    })
    yield* post(
      {
        write: "createIssueComment",
        pr: prNumber,
        body: buildNoteBody({ note: noteFailed(detail, outcome.cost), state }),
      },
      outcome.sessions,
    )
  }
  if (!failed && selection.inline.length) {
    const payload = buildCreateReviewPayload({
      head: item.head,
      inline: selection.inline,
      body: buildReviewBody({ head: item.head, run, inline: selection.inline }),
      suggestions: config.suggestions,
      trust: item.trust,
      leads: inlineLeads(selection, []),
      ...(repo ? { repo } : {}),
    })
    yield* post({ write: "createReview", pr: prNumber, payload }, outcome.sessions)
  }
  if (!failed) {
    const count = posted.flatMap((write) => (write.write === "createReview" ? write.payload.comments : [])).length
    const detail = outcome.specialists.find((entry) => entry.status === "failed")?.detail
    const banners = outcome.partial
      ? [
          notePartial({
            reason: outcome.partial,
            reviewed: files.length - outcome.unreviewed.length,
            total: files.length,
            unreviewed: outcome.unreviewed,
            maxCostUsd: config.maxCostUsd,
            maxSteps: config.maxSteps,
            timeoutMinutes: config.timeoutMinutes,
            ...(detail ? { detail } : {}),
          }),
        ]
      : []
    const notes = [
      ...(generatedNote ? [generatedNote] : []),
      ...(selection.overflow.length
        ? [
            count >= config.maxCommentsPerPr
              ? noteInlineCap(config.maxCommentsPerPr, "pr")
              : noteInlineCap(config.maxComments, "review"),
          ]
        : []),
      ...outcome.notes,
    ]
    const state = nextState(undefined, {
      head: item.head,
      base: plan.mergeBase,
      mode: "full",
      now: now(),
      unreviewed: outcome.unreviewed,
      ...(outcome.cost ? { cost: outcome.cost } : {}),
      prior: [],
      selection,
      moved: [],
      posted: count,
    })
    const summary = buildSummaryBody({
      ...(repo ? { repo } : {}),
      ...(item.pr ? { pr: item.pr.number } : {}),
      head: item.head,
      baseRef: item.baseRef ?? "base",
      mode: "full",
      report: outcome.report,
      selection,
      files: files.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions })),
      skipped,
      banners,
      notes,
      ...(outcome.cost ? { cost: outcome.cost } : {}),
      durationMs: outcome.durationMs,
      prTotal: { costUsd: state.costUsd, reviews: state.reviews },
      commentUrls: {},
      state,
    })
    yield* post({ write: "createIssueComment", pr: prNumber, body: summary }, outcome.sessions)
  }

  // 8. The record: each pass's prompt by digest with its session's timing and cache use, every attempt with its
  // settlement, and the tool calls each session made, with this checkout's paths made relative. Each session's
  // messages are read once.
  const attempts = foldAttempts(observed)
  const passOf = new Map(attempts.flatMap((attempt) => (attempt.sessionID ? [[attempt.sessionID, attempt.pass]] : [])))
  const recorded = yield* Effect.forEach(outcome.sessions, (id) =>
    sessions.messages({ sessionID: SessionID.make(id) }).pipe(
      Effect.map((messages) => ({ pass: passOf.get(SessionID.make(id)), messages })),
      Effect.catch(() => Effect.succeed({ pass: passOf.get(SessionID.make(id)), messages: [] })),
    ),
  )
  const tools = recorded.flatMap((session) =>
    session.messages
      .flatMap((message) => message.parts)
      .flatMap((part) =>
        part.type === "tool"
          ? [
              {
                ...(session.pass ? { pass: session.pass } : {}),
                tool: part.tool,
                status: part.state.status,
                input: relativeInput(part.state.input, directory),
              },
            ]
          : [],
      ),
  )
  const start = Math.min(...recorded.flatMap((session) => session.messages.map((message) => message.info.time.created)))
  // VS-21e: each admitted attempt's reasoning tokens, from the step its provider call finished. An attempt settles with
  // the provider's own counts, cache reads and writes inside input and reasoning inside output, and its step records
  // getUsage's split of the same counts, so an attempt matches the steps of its session whose parts add back up to its
  // counts. Retries settle in the same assistant message, so steps are matched by count, not by message. Attempts and
  // steps with the same counts pair in seq and step order when there are as many of each; otherwise none of them gets a
  // value, so no attempt is credited with another's tokens. A value of 0 is never written.
  const reasoning = new Map(
    recorded.flatMap((session, index) => {
      const steps = session.messages.flatMap((message) =>
        message.info.role === "assistant" && !message.info.forked
          ? message.parts.flatMap((part) => (part.type === "step-finish" ? [part.tokens] : []))
          : [],
      )
      const tried = attempts.flatMap((attempt) =>
        attempt.admitted && attempt.sessionID === outcome.sessions[index] && attempt.settled?.tokens
          ? [{ seq: attempt.seq, key: `${attempt.settled.tokens.input}:${attempt.settled.tokens.output}` }]
          : [],
      )
      const keyed = steps.map((tokens) => ({
        key: `${tokens.input + tokens.cache.read + tokens.cache.write}:${tokens.output + tokens.reasoning}`,
        reasoning: tokens.reasoning,
      }))
      return [...new Set(tried.map((attempt) => attempt.key))].flatMap((key) => {
        const mine = tried.filter((attempt) => attempt.key === key)
        const theirs = keyed.filter((step) => step.key === key)
        if (mine.length !== theirs.length) return []
        return mine.flatMap((attempt, at) => {
          const value = theirs[at]?.reasoning ?? 0
          return value > 0 ? [[attempt.seq, value] as const] : []
        })
      })
    }),
  )

  const artifact: ReplayArtifact = {
    ...common,
    context: {
      digest: digest({ gathered, headFiles: headFiles ?? [] }),
      related: gathered.related.length,
      history: gathered.history.length,
      instructions: gathered.instructions !== undefined,
      headFiles: headFiles?.length ?? 0,
      locations: quotedLocations(gathered.related),
    },
    // Every session of a pass counts toward it. One pass event per pass name today; VS-28's lenses add several "lens"
    // passes and must match them by lens too.
    passes: observed.flatMap((event) =>
      event.type === "pass"
        ? [
            {
              pass: event.pass,
              model: event.model,
              digest: digest(event.text),
              chars: event.text.length,
              ...passUsage(
                recorded.flatMap((session) => (session.pass === event.pass ? session.messages : [])),
                start,
              ),
            },
          ]
        : [],
    ),
    attempts: attempts.map((attempt) => {
      const value = reasoning.get(attempt.seq)
      return value === undefined ? attempt : { ...attempt, reasoning: value }
    }),
    tools,
    outcome,
    placed: selection.inline.map((finding) => ({
      id: finding.id,
      path: finding.anchor.path,
      line: finding.anchor.line,
      ...(finding.anchor.startLine !== undefined ? { startLine: finding.anchor.startLine } : {}),
      side: finding.anchor.side,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      source: finding.source,
      verified: finding.verified === true,
    })),
    posted,
    ...(refusal.message !== undefined ? { refused: refusal.message } : {}),
  }
  return { artifact, observed, over }
})

// The projection's record: each planned pass in order, with its admitted attempts paired with the requests its
// sessions sent. For each session the k-th admitted attempt, in seq order, goes with the k-th request that names it,
// in arrival order; what is left on either side is unsent or unadmitted. A pass's price is its model's snapshot.
function projectionOf(input: {
  artifact: ReplayArtifact
  observed: readonly Observation[]
  over: readonly ProjectedOverCap[]
  wire: readonly WireRequest[]
  attempts: readonly EgressGuard.Attempt[]
}): ProjectionRecord {
  const artifact = input.artifact
  const lifted = new Set(input.over.flatMap((decision) => (decision.attempt === undefined ? [] : [decision.attempt])))
  const named = new Set<string>(artifact.attempts.flatMap((attempt) => (attempt.sessionID ? [attempt.sessionID] : [])))
  const events = input.observed.flatMap((event) => (event.type === "pass" ? [event] : []))
  // One pass event per pass name today; VS-28's lenses add several "lens" passes and must match them by lens too.
  const planned = events.filter((event, index) => events.findIndex((other) => other.pass === event.pass) === index)
  const passes = planned.map((event): ProjectedPass => {
    const price = [artifact.models.review, artifact.models.triage].find((model) => model?.id === event.model)?.price
    const tried = artifact.attempts.filter((attempt) => attempt.pass === event.pass)
    const sessions = [...new Set(tried.flatMap((attempt) => (attempt.sessionID ? [attempt.sessionID] : [])))]
    const paired = sessions.map((sessionID) => {
      const admitted = tried.filter((attempt) => attempt.admitted && attempt.sessionID === sessionID)
      const sent = input.wire.filter((request) => request.sessionID === sessionID)
      const requests = admitted.flatMap((attempt, index) => {
        const request = sent[index]
        if (!request) return []
        const tokens = Math.ceil(request.body.length / CHARS_PER_TOKEN)
        return [
          {
            seq: attempt.seq,
            phase: attempt.phase,
            estimateUsd: attempt.estimateUsd,
            ...(lifted.has(attempt.seq) ? { lifted: true as const } : {}),
            digest: digest(request.body),
            chars: request.body.length,
            tokens,
            ...(price ? { stepUsd: nextStepCostUsd(tokens, price) } : {}),
            body: request.body,
          } satisfies ProjectedRequest,
        ]
      })
      return { requests, unsent: admitted.length - requests.length, unadmitted: sent.length - requests.length }
    })
    const requests = paired.flatMap((entry) => entry.requests).toSorted((a, b) => a.seq - b.seq)
    const first = requests[0]
    const status = artifact.outcome?.specialists.find((entry) => entry.name === event.pass)?.status
    const decision = input.over.find((entry) => entry.pass === event.pass)
    return {
      pass: event.pass,
      model: event.model,
      maxSteps: event.maxSteps,
      ...(status ? { status } : {}),
      digest: digest(event.text),
      chars: event.text.length,
      requests,
      ...(first ? { promptTokens: first.tokens } : {}),
      ...(first && price
        ? {
            usd: estimateCostUsd({ promptTokens: first.tokens, maxSteps: event.maxSteps, price }),
            v2: estimateDispatch([
              {
                pass: event.pass,
                model: event.model,
                promptTokens: first.tokens,
                maxSteps: event.maxSteps,
                price,
                cached: price.cacheRead !== undefined,
              },
            ]).passes[0]?.v2,
          }
        : {}),
      ...(decision ? { lifted: decision } : {}),
      unsent: paired.reduce((total, entry) => total + entry.unsent, 0),
      unadmitted: paired.reduce((total, entry) => total + entry.unadmitted, 0),
    }
  })
  return {
    version: 1,
    kind: "projection",
    label: artifact.label,
    repetition: artifact.repetition,
    runtime: artifact.runtime,
    source: artifact.source,
    trust: artifact.trust,
    trigger: artifact.trigger,
    config: { digest: artifact.config.digest },
    ...(artifact.variant ? { variant: artifact.variant } : {}),
    scope: artifact.scope,
    rules: artifact.rules,
    context: { digest: artifact.context.digest },
    models: artifact.models,
    files: artifact.files,
    cap: { maxCostUsd: artifact.config.value.maxCostUsd, over: [...input.over] },
    passes,
    unattributed: input.wire.filter((request) => !request.sessionID || !named.has(request.sessionID)).length,
    egress: {
      attempts: input.attempts.length,
      outside: input.attempts.filter((attempt) => !attempt.allowed || !LocalPolicy.loopback(attempt.host)).length,
    },
  }
}

// A posting adapter that sends nothing and keeps every write, in order.
export function recordingPosting() {
  const writes: PostedRecord[] = []
  return {
    writes,
    createReview: async (pr: number, payload: CreateReviewPayload) => {
      writes.push({ write: "createReview", pr, payload })
      return { id: writes.length }
    },
    createIssueComment: async (pr: number, body: string) => {
      writes.push({ write: "createIssueComment", pr, body })
      return { id: writes.length, html_url: "" }
    },
  } satisfies Posting & { writes: PostedRecord[] }
}

// SHA-256 of a text, or of a value as JSON with its object keys sorted, so equal settings give equal digests.
export function digest(value: unknown) {
  const text =
    typeof value === "string"
      ? value
      : JSON.stringify(value, (_key, entry: unknown) =>
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? Object.fromEntries(Object.entries(entry).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
            : entry,
        )
  return createHash("sha256")
    .update(text ?? "")
    .digest("hex")
}

// "path:line" of each related-code location the prompt quotes, in prompt order and each once, selected as buildPrompt
// selects them for its related_code block, so a location is listed only when the model saw it, whatever ReviewContext
// gathered.
export function quotedLocations(related: readonly RelatedCode[]) {
  return [
    ...new Set(
      related
        .filter((entry) => entry.hits.length)
        .slice(0, MAX_SYMBOLS)
        .flatMap((entry) => entry.hits.slice(0, MAX_HITS).map((hit) => `${hit.path}:${hit.line}`)),
    ),
  ]
}

// The package whose wiring applies each key no runner applies yet.
const WIRING: Record<(typeof UNAPPLIED_REVIEW_KEYS)[number], string> = {
  trivial: "VS-24 wiring",
  maxInputTokens: "VS-24 wiring",
  impact: "VS-25b wiring",
  guardrail: "VS-27c",
  scopeGate: "VS-42 wiring",
  verifyEvidence: "VS-44 wiring",
  depth: "VS-28 wiring",
  lenses: "VS-28 wiring",
  runtime: "the VS-30 executor",
}

// Why a replay's settings cannot name its run, if they cannot: a variant's key set through `config`, which would leave
// the run unnamed, a route setting there, which nothing would enforce, or a variant that would run the frozen pipeline,
// or anything but itself, under its name.
function variantProblem(input: ReplayInput) {
  const misplaced = VARIANT_KEYS.engine.filter((key) => input.config && Object.hasOwn(input.config, key))
  if (misplaced.length)
    return `config sets ${misplaced.join(", ")}, a pipeline variant's setting: pass the variant in \`variant\`, as admitReplay hands it out, so the artifact names the run.`
  // Nothing enforces the route rules in a replay yet, so its artifact may not record a route setting. A sourced key that
  // no runner applies yet (VS-30's runtime) gets the unwired message below, which names what applies it.
  const sourced = SOURCED_REVIEW_KEYS.filter(
    (key) => input.config && Object.hasOwn(input.config, key) && !UNAPPLIED_REVIEW_KEYS.some((item) => item === key),
  )
  if (sourced.length)
    return `config sets ${sourced.join(", ")}, a route setting a replay cannot apply: route settings come only from trusted settings once a runner enforces them.`
  const unwired = UNAPPLIED_REVIEW_KEYS.filter((key) => input.config && Object.hasOwn(input.config, key))
  if (unwired.length) {
    const packages = [...new Set(unwired.map((key) => WIRING[key]))]
    const wiring =
      packages.length === 1
        ? packages[0]
        : packages.map((item) => `${item} for ${unwired.filter((key) => WIRING[key] === item).join(", ")}`).join("; ")
    return `config sets ${unwired.join(", ")}, which no runner applies yet (${wiring}), so the artifact would record a setting the run did not have.`
  }
  const variant = input.variant
  if (!variant) return undefined
  if (!variant.name.startsWith("engine:") || !VARIANT_NAME.test(variant.name))
    return `A replay's variant is named engine:<name> from the eval registry, not "${variant.name}".`
  const allowed: readonly string[] = VARIANT_KEYS.engine
  const keys = Object.entries(variant.keys)
  const unapplied = keys.filter(([key, value]) => value === undefined || !allowed.includes(key)).map(([key]) => key)
  if (unapplied.length)
    return `${variant.name} sets ${unapplied.join(", ")}, which this replay does not apply (it applies ${allowed.join(", ")}, each with a value), so the run would not be ${variant.name}.`
  if (!keys.length && !variant.models)
    return `${variant.name} sets no key and no model requirement, so it would run the frozen pipeline under its name.`
  const triaged = input.triage && modelRecord(input.triage).id !== modelRecord(input.model).id
  if (variant.models === "triage-pair" && !triaged)
    return `${variant.name} is made by its models: it needs a triage model other than the review model.`
  return undefined
}

// A pass's wall time and cache use, from the messages of every session it had: `startMs` after `start` (the first
// message of any pass), `ms` from its first message created to its last one completed, and the cache reads and writes
// measureCost counts, as Review.run's ReviewPass does, and its reasoning tokens when the provider reported any (VS-21e).
function passUsage(messages: readonly SessionV1.WithParts[], start: number) {
  if (!messages.length) return {}
  const first = Math.min(...messages.map((message) => message.info.time.created))
  const last = Math.max(
    ...messages.map((message) =>
      message.info.role === "assistant"
        ? (message.info.time.completed ?? message.info.time.created)
        : message.info.time.created,
    ),
  )
  const cost = measureCost(messages)
  return {
    startMs: first - start,
    ms: last - first,
    ...(cost
      ? {
          cacheRead: cost.cacheRead,
          cacheWrite: cost.cacheWrite,
          ...(cost.reasoning > 0 ? { reasoning: cost.reasoning } : {}),
        }
      : {}),
  }
}

// Each attempt in the order admission saw it, with the settlement that followed it.
function foldAttempts(observed: Observation[]): AttemptRecord[] {
  const attempts: AttemptRecord[] = []
  for (const event of observed) {
    if (event.type === "attempt") {
      const { type: _type, ...rest } = event
      attempts.push({ ...rest, seq: attempts.length + 1 })
      continue
    }
    if (event.type !== "settle") continue
    const open = attempts.findLast(
      (attempt) => attempt.pass === event.pass && attempt.phase === event.phase && attempt.admitted && !attempt.settled,
    )
    if (open)
      open.settled = {
        costUsd: event.costUsd,
        complete: event.complete,
        ...(event.tokens ? { tokens: event.tokens } : {}),
      }
  }
  return attempts
}

function modelRecord(model: ResolvedModel): ModelRecord {
  return {
    id: `${model.providerID}/${model.modelID}`,
    ...(model.variant ? { variant: model.variant } : {}),
    context: model.context,
    costKind: model.costKind,
    ...(model.price ? { price: model.price } : {}),
  }
}

// A tool call's scalar arguments, with paths in this checkout made relative so artifacts compare across machines.
// Relative paths use "/" on every platform, like the case's file paths, so a Windows artifact matches a Linux one.
function relativeInput(input: Record<string, unknown>, directory: string) {
  return Object.fromEntries(
    Object.entries(input).flatMap(([key, value]): [string, string | number | boolean][] => {
      if (typeof value === "number" || typeof value === "boolean") return [[key, value]]
      if (typeof value !== "string") return []
      if (value === directory) return [[key, "."]]
      if (!value.startsWith(directory + path.sep)) return [[key, value]]
      return [[key, path.relative(directory, value).split(path.sep).join("/")]]
    }),
  )
}

function short(sha: string) {
  return sha.slice(0, 7)
}

export * as ReviewEval from "./eval"
