// Review.run (section 3.8): one read-only session per specialist, with Vector's own step, dollar and time limits, a
// finalize prompt for a session stopped early, a verify pass, then selection and cost. The engine's agent `steps`
// limit only adds text-only prompt guidance, which conflicts with this runner's required StructuredOutput tool.
// Review admits each provider attempt, including retries, and one separate finalizer. Dollar reservations are
// estimates; reported usage can exceed them, so they are not a hard billing cap. An eval projection (VS-21b,
// ReviewEval.project) may run what the dollar cap alone refuses, against a fake provider on this computer; nothing
// else sets it, and unset it changes nothing.

import path from "path"
import { Billing } from "@vectordevai/schema/billing"
import { Cause, Duration, Effect, Exit, Option, Scope } from "effect"
import type { EventV2 } from "@vectordevai/core/event"
import { SessionV1 } from "@vectordevai/core/v1/session"
import type { PermissionV1 } from "@vectordevai/core/v1/permission"
import {
  anchorText,
  budgetDiff,
  buildAnchorIndex,
  lookupFile,
  resolveAnchor,
  type DiffFile,
} from "@vectordevai/core/review/diff"
import { fingerprint, normalizeCode, normalizeTitle } from "@vectordevai/core/review/fingerprint"
import { checkedLabs, noteJudgeUnfinished, reviewModels } from "@vectordevai/core/review/second-lab"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { isFreeModel } from "@vectordevai/schema/free-model"
import {
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
import { packChanges, verifyHeadFiles } from "@vectordevai/core/review/pack"
import {
  combineCostKinds,
  diffBudgetChars,
  estimateCostUsd,
  NEXT_STEP_SLACK,
  nextStepCostUsd,
  planSpecialists,
  verifyCandidates,
  verifyUnanswered,
  verifyUnconfirmed,
  type ReviewPrice,
} from "@vectordevai/core/review/plan"
import {
  buildFinalizePrompt,
  buildJudgePrompt,
  buildReviewPrompt,
  buildSecurityPrompt,
  buildVerifyPrompt,
  SCOPE,
  PINNED_SESSION_PREFIX,
  VECTORSCOPE_AGENT,
  type PromptInput,
} from "@vectordevai/core/review/prompt"
import {
  decodeReport,
  decodeVerify,
  REVIEW_REPORT_JSON_SCHEMA,
  VERIFY_JSON_SCHEMA,
} from "@vectordevai/core/review/schema"
import { selectFindings, wantsNits } from "@vectordevai/core/review/select"
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
import { InstanceState } from "@/effect/instance-state"
import { readAuthority, type ReadAuthority } from "./read-authority"
import type { ResolvedModel } from "./model"

export interface RunInput {
  parentID?: SessionID
  directory: string
  trigger: Trigger
  trust: Trust
  base: string // the merge-base
  head: string
  since?: string
  mode: "full" | "incremental"
  files: DiffFile[] // the PR diff for the model, classified and filtered
  anchors: DiffFile[] // the diff findings are anchored against
  focus?: FocusHunk[]
  skipped: SkippedFile[]
  headFiles?: { path: string; text: string; exact: boolean }[]
  context: Pick<
    PromptInput,
    "related" | "history" | "requirements" | "instructions" | "teamDismissed" | "humanComments"
  >
  pr?: PromptInput["pr"]
  prior: PriorFinding[]
  rules: string
  config: ReviewConfig
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
}

type Name = ReviewOutcome["specialists"][number]["name"]
type Stop = "budget" | "steps" | "timeout"
type Phase = "turn" | "finalize"

// A decision the review's dollar cap would refuse, and where it was made: before a pass's session ("pass"), at a
// provider attempt ("attempt"), at the finalizer's reservation ("finalizer"), or at verify's pre-check ("verify").
// `sessionID` is the pass's session, at an attempt and at the finalizer's reservation.
export interface OverCap {
  pass: Name
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
  // A pass is about to run with this prompt and step cap, or was planned and skipped (verify with no budget or time
  // left).
  | { type: "pass"; pass: Name; model: string; text: string; maxSteps: number }
  // One provider attempt the review's admission was asked for, retries included. A refused one was never sent.
  | {
      type: "attempt"
      pass: Name
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
      phase: Phase
      costUsd: number
      complete: boolean
      tokens?: { input: number; output: number }
    }
type Progress = Parameters<NonNullable<RunInput["onProgress"]>>[0]

interface Track {
  name: Name
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

interface Spec<T> {
  name: Name
  model: ResolvedModel
  cap: number
  text: string
  schema: Record<string, unknown>
  decode: (value: unknown) => T | undefined
}

interface Asked<T> {
  name: Name
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
> = Effect.fn("Review.run")(function* (input: RunInput) {
  const sessions = yield* Session.Service
  const guard = yield* SpendGuard.Service
  const prompts = yield* SessionPrompt.Service
  const permission = yield* Permission.Service
  const events = yield* EventV2Bridge.Service

  const provider = yield* Provider.Service

  const started = Date.now()
  const deadline = started + input.config.timeoutMinutes * 60_000
  const config = input.config
  const priceOf = (model: ResolvedModel) =>
    model.costKind === "priced" && config.maxCostUsd > 0 ? model.price : undefined
  // WP A35: the models the passes run on. A review on Vector Codium without a triageModel runs the plan's review pair,
  // a same-lab pair runs one pass, and the panel adds a judge from a third lab.
  const picked = yield* chooseModels(input, provider)
  const model = picked.model
  const triage = picked.triage ?? model
  const triaged = nameOf(triage) !== nameOf(model)
  const judgeModel = picked.judge
  // The dollar cap applies when any pass runs on a priced model.
  const capped =
    priceOf(model) !== undefined ||
    priceOf(triage) !== undefined ||
    (judgeModel !== undefined && priceOf(judgeModel) !== undefined)
  // The saved long outputs hold every session the user ever ran, so a review of someone else's pull request, which its
  // author can steer, cannot read them back; it only loses the cut-off end of a long tool output.
  const rules = reviewPermissionRules({
    allowDirs: input.allowDirs,
    checks: input.checks,
    truncateGlob: input.trust === "untrusted" ? undefined : Truncate.GLOB,
    readDenies: input.admittedReads
      ? input.admittedReads.patternsFor((yield* InstanceState.context).worktree)
      : input.readDenies?.length
        ? readAuthority(input.readDenies, {
            directory: input.directory,
            worktree: (yield* InstanceState.context).worktree,
            ...(input.readRoot ? { readRoot: input.readRoot } : {}),
          }).patterns
        : undefined,
  })
  const reviewed = {
    paths: input.files.map((file) => file.path),
    trust: input.trust,
    ...(input.instructionsFromContext ? { instructions: "provided" as const } : {}),
    ...(input.admittedReads?.patterns.length || input.readDenies?.length ? { restrictedReads: true as const } : {}),
  }
  const tracks = new Map<string, Track>()
  const reservations = new Map<Name, { turn: number; finalize: number }>()
  const sessionIDs: SessionID[] = []
  const state = {
    spent: 0,
    reported: 0,
    codium: false,
    ownReported: false,
    uncertain: 0,
    incomplete: false,
    served: [] as string[],
  }
  const scope = yield* Scope.make()
  const bridge = input.stopSignal ? yield* EffectBridge.make() : undefined
  const stop = () => {
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
  const reserve = (name: Name, turn: number, finalize: number, at: Pick<OverCap, "phase" | "site" | "sessionID">) => {
    if (!capped) return true
    const others = [...reservations].reduce(
      (total, [owner, amount]) => total + (owner === name ? 0 : amount.turn + amount.finalize),
      0,
    )
    if (
      state.spent + state.uncertain + others + turn + finalize > config.maxCostUsd &&
      !lift({ pass: name, estimateUsd: turn + finalize, ...at })
    )
      return false
    reservations.set(name, { turn, finalize })
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

  // One session: the prompt, and when it was stopped or returned nothing usable, a finalize prompt in the same
  // session with every tool but StructuredOutput denied.
  function ask<T>(spec: Spec<T>): Effect.Effect<Asked<T>> {
    return Effect.gen(function* () {
      if (input.stopSignal?.aborted)
        return { name: spec.name, status: "stopped", stop: "timeout", detail: "timeout", steps: 0 } satisfies Asked<T>
      // Include the structured-output schema and a fixed context allowance. The first turn has no reported usage
      // yet, so this is only an admission estimate; provider usage replaces it as soon as it arrives.
      const context = Math.ceil((spec.text.length + JSON.stringify(spec.schema).length) / 3.5)
      const price = priceOf(spec.model)
      const firstCost = nextCost({ context, cached: 0, price })
      observe({ type: "pass", pass: spec.name, model: nameOf(spec.model), text: spec.text, maxSteps: spec.cap })
      if (!reserve(spec.name, firstCost, firstCost, { phase: "turn", site: "pass" })) {
        observe({
          type: "attempt",
          pass: spec.name,
          phase: "turn",
          admitted: false,
          stop: "budget",
          estimateUsd: firstCost,
        })
        return { name: spec.name, status: "stopped", stop: "budget", detail: "budget", steps: 0 } satisfies Asked<T>
      }
      // A helper session: it stays out of session lists, and the review reports what it spent.
      const session = yield* sessions.create({
        title: `Vectorscope review · ${input.head.slice(0, 7)} · ${spec.name}`,
        internal: `${input.instructionsFromContext ? PINNED_SESSION_PREFIX : "vectorscope."}${spec.name}`,
        parentID: input.parentID,
        permission: rules,
      })
      const track: Track = {
        name: spec.name,
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
      yield* progress({ type: "specialist", name: spec.name, status: "running" })

      // One policy survives every processor instance, retry and prompt for this fresh owned session. It is never
      // rebuilt at a continuation boundary, and the finalizer gets exactly one separately reserved invocation.
      const policy: SessionAdmission.Policy = {
        sessionID: session.id,
        admit: (request) => {
          const phase: Phase = track.finalizing ? "finalize" : "turn"
          const attempt = { type: "attempt", pass: track.name, phase, sessionID: session.id } as const
          const stop = input.stopSignal?.aborted
            ? "timeout"
            : track.finalizing
              ? track.finalizeAttempts >= 1 || !request.tools.includes("StructuredOutput")
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
            !reserve(track.name, estimate, track.finalizing ? 0 : estimate, {
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
          return {
            ...(track.finalizing ? { tools: ["StructuredOutput"] } : {}),
            observe: (cost) => {
              const reservation = reservations.get(track.name)
              if (reservation) reservation.turn = Math.max(reservation.turn, cost)
            },
            settle: (result) => {
              observe({
                type: "settle",
                pass: track.name,
                phase,
                costUsd: result.cost,
                complete: result.complete,
                ...(result.usage
                  ? { tokens: { input: result.usage.inputTokens ?? 0, output: result.usage.outputTokens ?? 0 } }
                  : {}),
              })
              state.spent += result.cost
              if (track.price && !result.complete) {
                // No usage, partial usage, and unpriced usage cannot turn an accepted attempt into free capacity.
                state.uncertain += Math.max(
                  0,
                  Math.max(estimate, reservations.get(track.name)?.turn ?? 0) - result.cost,
                )
                state.incomplete = true
              }
              track.context = result.complete ? result.context : Math.max(track.context, result.context)
              track.cached = result.complete ? result.cached : 0
              if (capped) reservations.set(track.name, { turn: 0, finalize: track.finalizing ? 0 : nextCost(track) })
            },
          }
        },
      }

      const send = (text: string, ms: number): Effect.Effect<Sent> =>
        Effect.suspend(() => {
          if (ms <= 0 || input.stopSignal?.aborted) return Effect.succeed<Sent>({ timedOut: true })
          return prompts
            .prompt({
              sessionID: session.id,
              agent:
                input.identity === VECTORSCOPE_AGENT
                  ? VECTORSCOPE_AGENT
                  : spec.name === "security"
                    ? "security"
                    : "review",
              model: { providerID: spec.model.providerID, modelID: spec.model.modelID },
              ...(spec.model.variant ? { variant: spec.model.variant } : {}),
              // A class instance: the stored user message only accepts the schema class, not a plain object.
              format: new SessionV1.OutputFormatJsonSchema({ type: "json_schema", schema: spec.schema, retryCount: 0 }),
              // The changed paths and the trust choose how the owner reviews (section 6.4a), never the PR's own text.
              parts: [{ type: "text", text, metadata: { [SCOPE]: reviewed } }],
            })
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
        name: spec.name,
        sessionID: session.id,
        ...(value !== undefined ? { value } : {}),
        status,
        ...(stop ? { stop } : {}),
        steps: track.steps,
        ...(detail ? { detail } : {}),
      })

      const first = yield* send(spec.text, deadline - Date.now())
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

      // The first prompt is now idle. Unknown exposure stays in the review's ledger; only unused future work is
      // released. The finalizer must still fit beside every other specialist's admitted work.
      if (!reserve(track.name, nextCost(track), 0, { phase: "finalize", site: "finalizer", sessionID: session.id })) {
        observe({
          type: "attempt",
          pass: spec.name,
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
      yield* sessions.setPermission({ sessionID: session.id, permission: [...rules, DENY_ALL, ALLOW_OUTPUT] })
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
      Effect.ensuring(Effect.sync(() => reservations.delete(spec.name))),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) =>
          Effect.succeed<Asked<T>>({
            name: spec.name,
            status: "failed",
            steps: 0,
            detail: Cause.prettyErrors(cause)[0]?.message ?? "the session failed",
          }),
      ),
      Effect.tap((done) => progress({ type: "specialist", name: done.name, status: done.status })),
      Effect.tap(() => checkpoint()),
    )
  }

  const body = Effect.gen(function* () {
    // Prompts: the diff that fits the model's context, focus files first in incremental mode.
    const focused = new Set((input.focus ?? []).map((hunk) => hunk.path))
    const ordered =
      input.mode === "incremental"
        ? [
            ...input.files.filter((file) => focused.has(file.path)),
            ...input.files.filter((file) => !focused.has(file.path)),
          ]
        : input.files
    const split = budgetDiff(ordered, diffBudgetChars(Math.min(model.context, triage.context), config.maxDiffChars))
    // Each changed file once: annotated when its pull request text is at hand, and only its changed lines when an
    // incremental review has nothing new in it.
    const packed = packChanges({
      inline: split.inline,
      changed: input.files,
      ...(input.headFiles ? { headFiles: input.headFiles } : {}),
      ...(input.mode === "incremental" && input.focus ? { focus: input.focus } : {}),
    })
    const promptInput: PromptInput = {
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
      ...(input.focus ? { focus: input.focus } : {}),
      ...(packed.settled.length ? { settled: packed.settled } : {}),
      ...(input.headFiles ? { headFiles: packed.headFiles } : {}),
      ...input.context,
      rules: input.rules,
      rulesSource:
        input.rulesSource ??
        (input.trigger === "local" || input.trigger === "desktop" ? "working tree" : "base branch"),
      prior: input.prior,
      maxComments: config.maxComments,
      nits: wantsNits(config),
    }

    // 1–5. The specialists, in parallel, one session each.
    const asked = yield* Effect.forEach(
      planSpecialists(input.files, config),
      (name) =>
        ask({
          name,
          model: triage,
          cap: name === "security" ? Math.ceil((config.maxSteps * 2) / 3) : config.maxSteps,
          text: name === "security" ? buildSecurityPrompt(promptInput) : buildReviewPrompt(promptInput),
          schema: REVIEW_REPORT_JSON_SCHEMA,
          decode: decodeReport,
        }),
      { concurrency: 2 },
    )

    // 6. Normalize.
    const reports = asked.flatMap((entry) =>
      entry.value
        ? [{ source: entry.name === "security" ? ("security" as const) : ("review" as const), report: entry.value }]
        : [],
    )
    const report = mergeReports(reports.map((entry) => entry.report))
    const normalized = reports.flatMap((entry) => normalizeFindings(entry.report.findings, entry.source, input.anchors))

    // 7. Verify: the candidates the verify policy names (plan.ts). After a cheaper triage pass, everything of concern
    // or above is confirmed on the review model, whatever `verify` says.
    const shared = config.verifyPolicy === "shared"
    const candidates = verifyCandidates(
      normalized,
      {
        verify: config.verify,
        policy: config.verifyPolicy,
        minConfidence: config.minConfidence,
        trust: input.trust,
        triaged,
      },
      "engine",
    )
    // After a triage pass the cheaper model's word that an earlier finding is fixed goes to the double-check too, so
    // only the review model closes a finding and resolves its thread. A claim about a finding the first pass reported
    // again contradicts itself and is dropped.
    const reported = new Set(normalized.map((finding) => finding.id))
    const open = new Map(input.prior.filter((prior) => prior.status === "open").map((prior) => [prior.id, prior]))
    const claims = triaged
      ? (report.priorStatus ?? []).flatMap((entry) => {
          const prior = open.get(entry.id)
          return entry.status === "fixed" && prior && !reported.has(prior.id)
            ? [{ ...prior, reason: entry.reason }]
            : []
        })
      : []
    const verifyText =
      candidates.length || claims.length
        ? buildVerifyPrompt({
            trust: input.trust,
            head: input.head,
            candidates,
            ...(claims.length ? { fixed: claims } : {}),
            headFiles: verifyHeadFiles(input.files, input.headFiles, [...candidates, ...claims]),
          })
        : ""
    const verifyPrice = priceOf(model)
    const estimate = verifyPrice
      ? estimateCostUsd({
          promptTokens: Math.ceil(verifyText.length / 3.5),
          maxSteps: VERIFY_STEPS,
          price: verifyPrice,
        }).low
      : 0
    const late = deadline - Date.now() < VERIFY_MIN_MS
    // A projection is asked only about a verify pass that would otherwise run: one skipped for time never mattered.
    // The Codium token stop (CODIUM_REVIEW_TOKEN_STOP) is not a dollar decision, so no projection lifts it.
    const unaffordable =
      (yield* overTokenStop(verifyText)) ||
      (capped &&
        state.spent + state.uncertain + estimate > config.maxCostUsd &&
        !(verifyText !== "" && !late && lift({ pass: "verify", phase: "turn", site: "verify", estimateUsd: estimate })))
    if (verifyText && (unaffordable || late)) {
      observe({ type: "pass", pass: "verify", model: nameOf(model), text: verifyText, maxSteps: VERIFY_STEPS })
      observe({
        type: "attempt",
        pass: "verify",
        phase: "turn",
        admitted: false,
        stop: unaffordable ? "budget" : "timeout",
        estimateUsd: estimate,
      })
    }
    const verify: Asked<ReturnType<typeof decodeVerify>> | undefined = !verifyText
      ? undefined
      : unaffordable || late
        ? { name: "verify", status: "skipped", steps: 0, detail: unaffordable ? "budget" : "time" }
        : yield* ask({
            name: "verify",
            model,
            cap: VERIFY_STEPS,
            text: verifyText,
            schema: VERIFY_JSON_SCHEMA,
            decode: decodeVerify,
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
            checks: verify.value ?? [],
            headFiles: verifyHeadFiles(input.files, input.headFiles, candidates),
          })
        : ""
    const judgePrice = judgeModel ? priceOf(judgeModel) : undefined
    const judgeEstimate = judgePrice
      ? estimateCostUsd({ promptTokens: Math.ceil(judgeText.length / 3.5), maxSteps: VERIFY_STEPS, price: judgePrice })
          .low
      : 0
    const judgeLate = deadline - Date.now() < VERIFY_MIN_MS
    // As verify's pre-check: a projection may lift only the dollar cap, and only for a judge that would otherwise run.
    const judgeUnaffordable =
      (yield* overTokenStop(judgeText)) ||
      (capped &&
        state.spent + state.uncertain + judgeEstimate > config.maxCostUsd &&
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
          ? { name: "judge", status: "skipped", steps: 0, detail: judgeUnaffordable ? "budget" : "time" }
          : yield* ask({
              name: "judge",
              model: judgeModel,
              cap: VERIFY_STEPS,
              text: judgeText,
              schema: VERIFY_JSON_SCHEMA,
              decode: decodeVerify,
            })
    const candidateIds = new Set(candidates.map((finding) => finding.id))
    // The judge's verdict stands where it gave one; the check's stands for the rest, and for earlier fixed claims.
    const finalCall = judged?.status === "ok" ? (judged.value ?? []).filter((entry) => candidateIds.has(entry.id)) : []
    const verdicts = new Map([...(verify?.value ?? []), ...finalCall].map((entry) => [entry.id, entry.verdict]))
    // After a triage pass only what the review model confirmed is reported: a candidate it rejected, gave no verdict
    // for, or never saw because the double-check was skipped or failed is left out.
    const unchecked = new Set(verifyUnconfirmed(candidates, verdicts, triaged).map((finding) => finding.id))
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
    const checked: ModelReport = triaged
      ? {
          ...report,
          priorStatus: (report.priorStatus ?? []).filter((entry) => entry.status !== "fixed" || fixed.has(entry.id)),
        }
      : report

    // 8. Select. Paths outside the diff are checked against the repository first; selection is synchronous.
    const index = buildAnchorIndex(input.anchors)
    const outside = [...new Set(findings.map((finding) => finding.path))].filter((file) => !lookupFile(index, file))
    const known = new Map(
      yield* Effect.forEach(outside, (file) =>
        Effect.tryPromise(() => input.knownPath(file)).pipe(
          Effect.catch(() => Effect.succeed(false)),
          Effect.map((found) => [file, found] as const),
        ),
      ),
    )
    const skipped = new Set(input.skipped.map((file) => file.path))
    const selection = selectFindings({
      findings,
      anchors: input.anchors,
      head: input.head,
      trust: input.trust,
      mode: input.mode,
      config,
      prior: input.prior,
      ...(input.focus ? { focus: input.focus } : {}),
      inlinePosted: input.inlinePosted ?? 0,
      ignored: (file) => skipped.has(file) || classifyPath(file, { config }) !== undefined,
      knownPath: (file) => known.get(file) ?? true,
      teamDismissed: input.context.teamDismissed,
      dropped: [
        ...(rejected ? [{ reason: "rejected-by-verify" as const, count: rejected }] : []),
        ...(unconfirmed ? [{ reason: "unconfirmed" as const, count: unconfirmed }] : []),
      ],
      modelRisk: report.risk,
      sensitiveChanged: input.files.some((file) => isSensitivePath(file.path)),
      changedLines: input.files.reduce((sum, file) => sum + file.additions + file.deletions, 0),
    })

    // A partial run records the files no finished specialist saw, so the next run reviews them. A run where no
    // specialist finished leaves every file unreviewed.
    const partial =
      asked.find((entry) => entry.stop)?.stop ??
      (asked.some((entry) => !entry.value) ? ("model-error" as const) : undefined)
    const unreviewed =
      !reports.length || asked.some((entry) => entry.stop && !entry.value)
        ? input.files.map((file) => file.path)
        : partial && partial !== "model-error"
          ? yield* uncovered(asked.flatMap((entry) => (entry.value && entry.sessionID ? [entry.sessionID] : [])))
          : []

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
        return input.files.map((file) => file.path).filter((file) => !covered.has(file))
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
    const cost = yield* measure()
    // Model evidence (VS-07), only when review.json opts in: notes on what VectorScope's evaluation says about the
    // models, after the replies are known. It never changes which model ran.
    const evidenceNotes =
      config.modelEvidence === "warn"
        ? modelEvidenceNotes(
            assessReview({
              review: subjectOf(model),
              ...(triaged ? { triage: subjectOf(triage) } : {}),
              scope: evidenceScope({ adapter: "engine", config, ...(triaged ? { triage: nameOf(triage) } : {}) }),
              served: state.served,
              now: Date.now(),
              ...(input.certificates ? { certificates: input.certificates } : {}),
            }),
          )
        : []
    return {
      report: checked,
      selection,
      skipped: input.skipped,
      cost: { ...cost, ...(labs ? { labs } : {}) },
      ...(spentByPass.length ? { passes: spentByPass } : {}),
      durationMs: Date.now() - started,
      base: input.base,
      head: input.head,
      ...(input.since ? { since: input.since } : {}),
      mode: input.mode,
      ...(partial ? { partial } : {}),
      unreviewed,
      specialists: [...asked, ...(verify ? [verify] : []), ...(judged ? [judged] : [])].map((entry) => ({
        name: entry.name,
        status: entry.status,
        steps: entry.steps,
        ...(entry.detail ? { detail: entry.detail } : {}),
      })),
      sessions: [...sessionIDs],
      stats: {
        files: input.files.length,
        additions: input.files.reduce((sum, file) => sum + file.additions, 0),
        deletions: input.files.reduce((sum, file) => sum + file.deletions, 0),
      },
      notes: [
        ...picked.notes,
        ...(judgeModel && judgeText && judged?.status !== "ok" ? [noteJudgeUnfinished(nameOf(judgeModel))] : []),
        ...verifyNotes,
        ...(state.incomplete
          ? [
              "Reported cost may be incomplete; work with uncertain usage retained its estimated budget exposure for this review.",
            ]
          : []),
        ...evidenceNotes,
      ],
    } satisfies ReviewOutcome
  })

  return yield* body.pipe(
    Effect.ensuring(
      Effect.sync(() => input.stopSignal?.removeEventListener("abort", stop)).pipe(
        Effect.andThen(unsubscribe),
        Effect.andThen(Scope.close(scope, Exit.void)),
      ),
    ),
  )
})

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
