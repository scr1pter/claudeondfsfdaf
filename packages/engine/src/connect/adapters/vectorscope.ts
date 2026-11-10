export * as VectorScopeAdapter from "./vectorscope"

import { lstat, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { Cause, Context, Effect, Exit, Option, Schema } from "effect"
import { Billing } from "@vectordevai/schema/billing"
import { Connect } from "@vectordevai/schema/connect"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { ConnectFindings } from "@vectordevai/core/connect/findings"
import { ConnectFrame } from "@vectordevai/core/connect/frame"
import { ConnectPolicy } from "@vectordevai/core/connect/policy"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { parseReviewConfig, REVIEW_CONFIG_PATH } from "@vectordevai/core/review/config"
import { contextRefusal, MIN_CONTEXT } from "@vectordevai/core/review/plan"
import type { ReviewConfig, ReviewOutcome } from "@vectordevai/core/review/types"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { Auth } from "@/auth"
import { reviewForOutput } from "@/cli/cmd/review-output"
import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Instruction } from "@/session/instruction"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
// Types only. The review modules are loaded inside `describe` and `handle`, as `vector review` loads them: review/run
// value-imports the prompt loop, and a value import here would close the cycle registry → connect tool → hub → this
// adapter → review run → prompt loop → registry.
import type { LocalReviewDeps, LocalReviewOptions, LocalReviewResult } from "@/cli/cmd/review"
import type { ResolvedModel, ReviewModel } from "@/review/model"
import type { Review } from "@/review/run"
import type { SessionPrompt } from "@/session/prompt"
import type { ConnectAdapter } from "../adapter"
import { ConnectReviewPrompt } from "../review-prompt"

// VectorScope as a member of connected tools: the Vector agent asks it for a review in this engine process, on the
// user's own models, through VectorScope's own entry points (`executeLocalReview` and `Review.run` on main's copy).
// Connect re-implements no review pass, selection or anchoring. Before a review it checks, in order: that the changes
// do not edit VectorScope's own settings (check 1), which models the review would use and whether any of them needs
// `connect_model` (check 2; the hub has already applied the requester's read rules, check 3, before this adapter ran),
// and the dollar cap. Then it runs the review with the reviewer's sessions as hidden children of the requester, through
// the hub's helper handle, and turns the outcome into a typed result. It never posts, never pushes and never picks a
// model: the order is VectorScope's own (review.json, then `agent.review.model`, then the configured default).

/** The member id. */
export const ID = "vectorscope"

/** The services the adapter is built over; they join the hub's dependencies (`DEPS`). */
export type Services =
  | Session.Service
  | Permission.Service
  | EventV2Bridge.Service
  | Provider.Service
  | SpendGuard.Service
  | Config.Service
  | Auth.Service
  | ModelCatalog.Service
  | Git.Service
  | Instruction.Service
  | BrainKnowledge.Service

/** What `Review.run` needs; the prompt loop is the bridge over the helper handle. */
export type ReviewServices =
  | Session.Service
  | SessionPrompt.Service
  | Permission.Service
  | EventV2Bridge.Service
  | Provider.Service
  | SpendGuard.Service

/** What `ReviewModel.resolveReviewModel` needs. */
export type ModelServices = Provider.Service | Config.Service | Auth.Service | ModelCatalog.Service

/** The layer nodes of `Services`, for the hub's `deps`. */
export const DEPS = [
  Session.node,
  Permission.node,
  EventV2Bridge.node,
  Provider.node,
  SpendGuard.node,
  Config.node,
  Auth.node,
  ModelCatalog.node,
  Git.node,
  Instruction.node,
  BrainKnowledge.node,
] as const

/**
 * What a test may replace. Each one defaults to VectorScope's own, loaded lazily. `requirements` reads Brain's linked
 * requirements for the changed files; `personal` is true only when every model sends to this computer or a model
 * server.
 */
export interface Deps {
  readonly runReview?: (input: Review.RunInput) => Effect.Effect<ReviewOutcome, never, ReviewServices>
  readonly resolveModel?: (
    input: ReviewModel.ResolveInput,
  ) => Effect.Effect<ResolvedModel, ReviewModel.ReviewModelError, ModelServices>
  readonly requirements?: (input: {
    readonly files: readonly string[]
    readonly personal: boolean
  }) => Effect.Effect<string | undefined>
  /** REVIEW_* overrides, as `vector review` reads them; the engine's environment by default. */
  readonly env?: Record<string, string | undefined>
}

const ACTIONS: Connect.Action[] = [
  { id: "review", title: "Review your changes", effects: ["read"], background: false, result: "review" },
]

const SUMMARY =
  "Reviews your changes on your own review model and returns its findings as data. Connect never posts a review or pushes."

// Settings paths the check-1 walk resolves links for, relative to the repository's top level.
const LINKED = [".vector", ...ConnectPolicy.SETTINGS_PATHS]

const MAX_LIST_BYTES = 64 * 1024 * 1024

const isSessionID = Schema.is(SessionID)

/** A model the review would use, as connect checked it without a model call. */
export interface Checked extends ConnectPolicy.ReviewModel {
  readonly resolved: ResolvedModel
}

/** Why VectorScope cannot review right now, as a member state. */
export interface NotReady {
  readonly state: "off" | "unavailable"
  readonly reason: string
}

/** The review's models and the settings it reads them from. */
export interface Plan {
  readonly config: ReviewConfig
  readonly review: Checked
  readonly triage?: Checked
}

/** What the reviewed changes touch, for check 1 and for comparing with an earlier review. */
export interface Scope {
  /** The repository's top level, where `vector review` reads its settings. */
  readonly root: string
  /** The paths the target changes: what the review covers. */
  readonly changed: readonly string[]
  /** Every path that differs between the target's base and the working tree, the index or the target. */
  readonly settings: readonly string[]
  readonly links: readonly ConnectPolicy.SettingsLink[]
}

/**
 * The options connect passes to `executeLocalReview`. It never sets `pr`, `post`, `yes` or `checks`, so nothing is
 * posted, nothing asks `confirm`, and no code under review runs. It asks for VectorScope's largest comment limit, so
 * selection keeps every finding it can, and passes the effective dollar cap as `maxCost`.
 */
export function reviewOptions(input: {
  readonly request: Connect.ReviewRequest
  readonly maxCost?: number
  readonly env: Record<string, string | undefined>
}): LocalReviewOptions {
  const target = input.request.target
  return {
    directory: input.request.directory,
    ...(target.kind === "uncommitted" ? { uncommitted: true } : {}),
    ...(target.kind === "staged" ? { staged: true } : {}),
    ...(target.kind === "branch" && target.base !== undefined ? { base: target.base } : {}),
    post: false,
    json: true,
    checks: false,
    maxComments: ConnectPolicy.MAX_COMMENTS,
    ...(input.request.security !== undefined ? { security: input.request.security } : {}),
    ...(input.maxCost !== undefined ? { maxCost: input.maxCost } : {}),
    env: input.env,
  }
}

/** The adapter over VectorScope's own entry points, with any of them replaced (tests). */
export const make = (deps: Deps = {}): ConnectAdapter.Factory<Services> =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const config = yield* Config.Service
    const git = yield* Git.Service
    const instruction = yield* Instruction.Service
    const knowledge = yield* BrainKnowledge.Service
    const env = deps.env ?? process.env
    // Exactly the services the review and the model resolution use, captured when the hub's layer is built.
    const base = Context.make(Session.Service, yield* Session.Service).pipe(
      Context.add(Permission.Service, yield* Permission.Service),
      Context.add(EventV2Bridge.Service, yield* EventV2Bridge.Service),
      Context.add(Provider.Service, provider),
      Context.add(SpendGuard.Service, yield* SpendGuard.Service),
      Context.add(Config.Service, config),
      Context.add(Auth.Service, yield* Auth.Service),
      Context.add(ModelCatalog.Service, yield* ModelCatalog.Service),
      Context.add(Git.Service, git),
    )

    const resolver = Effect.fnUntraced(function* () {
      if (deps.resolveModel) return deps.resolveModel
      const { ReviewModel } = yield* Effect.promise(() => import("@/review/model"))
      return ReviewModel.resolveReviewModel as NonNullable<Deps["resolveModel"]>
    })

    // One model, checked as the review would need it: listed, at least 32k of context, able to make tool calls (the
    // review forces a StructuredOutput call), and where it sends the diff. No model call is made.
    const check = Effect.fnUntraced(function* (
      resolved: ResolvedModel,
      role: "review" | "triage",
      fromRepository: boolean,
    ) {
      const name = nameOf(resolved)
      const small = resolved.context < MIN_CONTEXT ? contextRefusal(name, resolved.context) : undefined
      if (small) return yield* Effect.fail<NotReady>({ state: "unavailable", reason: small })
      const model = yield* provider
        .getModel(resolved.providerID, resolved.modelID)
        .pipe(Effect.orElseSucceed(() => undefined))
      if (!model)
        return yield* Effect.fail<NotReady>({
          state: "unavailable",
          reason: `${name} is not available. Check the provider and its key.`,
        })
      if (!model.capabilities.toolcall)
        return yield* Effect.fail<NotReady>({
          state: "unavailable",
          reason: `${name} cannot make tool calls, and a VectorScope review needs one to return its report.`,
        })
      const line = yield* provider.line(model).pipe(Effect.orElseSucceed(() => undefined))
      const costKind = ConnectPolicy.costKindOf(resolved.costKind)
      const sendsTo = ConnectPolicy.sendsToOf({
        providerID: resolved.providerID,
        codium: Billing.isCodium(resolved.providerID),
        local: costKind === "local",
        url: line?.origin || model.api.url || undefined,
      })
      return { resolved, model: name, role, costKind, sendsTo, fromRepository } satisfies Checked
    })

    // The models a review of `root` would use, in VectorScope's own order, read from the settings in its working tree.
    const plan = Effect.fnUntraced(function* (root: string) {
      const json = yield* Effect.promise(() =>
        readFile(path.join(root, REVIEW_CONFIG_PATH), "utf8").catch(() => undefined),
      )
      const parsed = parseReviewConfig({ json, env, trigger: "local" })
      const resolve = yield* resolver()
      const resolveOne = (input: ReviewModel.ResolveInput) =>
        resolve(input).pipe(
          Effect.provideContext(base),
          Effect.catch((error) => notReady(error.message)),
        )
      const reviewModel = yield* resolveOne({ trigger: "local", config: parsed.config.model, env })
      const review = yield* check(reviewModel, "review", parsed.config.model !== undefined)
      const triageModel = parsed.config.triageModel
        ? yield* resolveOne({ trigger: "local", exact: parsed.config.triageModel, env })
        : undefined
      const triage = triageModel ? yield* check(triageModel, "triage", true) : undefined
      return { config: parsed.config, review, ...(triage ? { triage } : {}) } satisfies Plan
    })

    // A model that cannot run reads "off" when Vector Local keeps it off (the provider's own wording), else unavailable.
    const notReady = (message: string) =>
      Effect.gen(function* () {
        const local = (yield* config.localPolicy()).enabled
        return yield* Effect.fail<NotReady>({
          state: local && /off in Vector Local/i.test(message) ? "off" : "unavailable",
          reason: message.trim() || "VectorScope has no review model it can use.",
        })
      })

    // The user's own review model: `agent.review.model`, else the configured default; undefined when there is none.
    const userModel = Effect.fnUntraced(function* () {
      const resolve = yield* resolver()
      const exit = yield* resolve({ trigger: "local", env }).pipe(Effect.provideContext(base), Effect.exit)
      return Exit.isSuccess(exit) ? nameOf(exit.value) : undefined
    })

    const describe: ConnectAdapter.Adapter["describe"] = () =>
      Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        const root = ctx.worktree === "/" ? ctx.directory : ctx.worktree
        const exit = yield* plan(root).pipe(Effect.exit)
        if (Exit.isFailure(exit))
          return member(
            Option.getOrUndefined(Cause.findErrorOption(exit.cause)) ?? {
              state: "unavailable",
              reason: "Connect could not check VectorScope's review model.",
            },
          )
        return member({ state: "ready", sendsTo: widest(exit.value) })
      }).pipe(
        Effect.catchCause(() =>
          Effect.succeed(
            member({ state: "unavailable", reason: "Connect could not check VectorScope's review model." }),
          ),
        ),
      )

    const handle: NonNullable<ConnectAdapter.Adapter["handle"]> = (request, context) =>
      Effect.gen(function* () {
        if (request.action !== "review")
          return yield* refusal("unknown", "VectorScope takes reviews through connect; fixes arrive in a later build.")
        if (!context.sessionID)
          return yield* refusal("unavailable", "A VectorScope review through connect needs a session to run in.")
        if (!context.helper)
          return yield* refusal(
            "unavailable",
            "Connect can run a VectorScope review only from a tool call that lends it this session's prompt calls.",
          )
        const helper = context.helper
        const say = (pass: string, message: string) => context.progress({ pass, message })

        // Check 1: the settings the reviewed changes may have edited. No model runs when they did.
        yield* say("settings", "Checking what the changes edit")
        const scope = yield* changes(git, request.directory, request.target)
        const edited = ConnectPolicy.editedSettings(scope.settings, scope.links)
        if (edited.length > 0) return settingsResult(request.target, edited)

        // Check 2: the models, the dollar cap, and `connect_model` when a model is priced, has no readable price, or is
        // the repository's choice and not the user's own review model.
        yield* say("model", "Checking the review model")
        const planned = yield* plan(scope.root).pipe(Effect.catch((why) => refusal("unavailable", why.reason)))
        const models = [planned.review, ...(planned.triage ? [planned.triage] : [])]
        const cap = ConnectPolicy.effectiveCap({
          costKind: capKind(models),
          repository: planned.config.maxCostUsd,
          tool: request.budget?.maxCostUsd,
          run: context.spend,
        })
        if (!cap.ok) return yield* cap.refusal
        const repository = models.some((model) => model.fromRepository)
        const user = repository ? yield* userModel() : undefined
        const consents = ConnectPolicy.reviewConsents({
          models,
          ...(user ? { userModel: user } : {}),
          ...(cap.value !== undefined ? { maxCostUsd: cap.value } : {}),
        }).filter((consent) => consent.permission === "connect_model")
        // `connect` itself was asked by the hub before this adapter ran.
        for (const consent of consents) yield* context.ask(consent)

        // The review, through VectorScope's own entry point.
        const loaded = yield* Effect.promise(async () => {
          const [cli, run, model, review] = await Promise.all([
            import("@/cli/cmd/review"),
            import("@/review/run"),
            import("@/review/model"),
            import("@/review/context"),
          ])
          return {
            executeLocalReview: cli.executeLocalReview,
            run: run.Review.run,
            ReviewModel: model.ReviewModel,
            ReviewContext: review.ReviewContext,
          }
        })
        const prompts = yield* ConnectReviewPrompt.service(helper)
        const reviewContext = Context.merge(base, prompts)
        const runReview = deps.runReview ?? loaded.run
        const resolve = yield* resolver()
        const personal = models.every((model) => Connect.isLocal(model.sendsTo))
        const requirements =
          deps.requirements ??
          ((input: { readonly files: readonly string[]; readonly personal: boolean }) =>
            Effect.gen(function* () {
              const place = yield* instruction.place()
              return yield* loaded.ReviewContext.requirements({ place, files: input.files, personal: input.personal })
            }).pipe(
              Effect.provideService(BrainKnowledge.Service, knowledge),
              Effect.catchCause(() => Effect.succeed(undefined)),
            ))
        const bridge = yield* EffectBridge.make()
        const out: string[] = []
        const local: LocalReviewDeps = {
          runReview: (input) =>
            runReview({ ...input, parentID: context.sessionID }).pipe(Effect.provideContext(reviewContext)),
          // VectorScope resolves the model again; it must be the one connect checked and asked about.
          resolveModel: (input) =>
            resolve(input).pipe(
              Effect.provideContext(base),
              Effect.flatMap((model) => {
                const expected = input.exact !== undefined ? planned.triage?.model : planned.review.model
                if (nameOf(model) === expected) return Effect.succeed(model)
                return Effect.fail(
                  new loaded.ReviewModel.ReviewModelError({
                    message: `The review model changed to ${nameOf(model)} after connect checked ${expected ?? "another model"}, so connect stopped. Ask for the review again.`,
                  }),
                )
              }),
            ),
          // Connect passes no `checks`, `post` or `pr`, so nothing reaches `confirm`; if a change ever does, the
          // answer is no.
          confirm: async () => false,
          stdout: async (text) => {
            out.push(text)
          },
          stderr: (text) => {
            for (const line of text.split("\n").map((item) => item.trim()))
              if (line) bridge.fork(progressOf(context, line))
          },
          // Connect never posts.
          posting: async () => [],
          requirements: (input) => requirements({ files: input.files, personal: personal && !input.shared }),
        }
        yield* say("review", "Reviewing")
        const result = yield* loaded
          .executeLocalReview(reviewOptions({ request, maxCost: cap.value, env }), local)
          .pipe(Effect.provideService(Git.Service, git))
        return resultOf({
          request,
          local: result,
          printed: printed(out),
          plan: planned,
          scope,
          ...(context.previous ? { previous: context.previous } : {}),
        })
      })

    return { id: ID, owner: "vectorscope", describe, handle } satisfies ConnectAdapter.Adapter
  })

/** The adapter the engine builds, over VectorScope's own entry points. */
export const factory = make()

// ---------------------------------------------------------------------------------------------------------------

function member(input: { state: Connect.State; reason?: string; sendsTo?: Connect.SendsTo }): Connect.Member {
  return {
    id: ID,
    kind: "agent",
    title: "VectorScope",
    summary: SUMMARY,
    owner: "vectorscope",
    place: "local",
    ...(input.sendsTo ? { sendsTo: input.sendsTo } : {}),
    state: input.state,
    ...(input.state !== "ready" ? { reason: clip(input.reason?.trim() || "VectorScope cannot review now.", 500) } : {}),
    reach: "connect",
    actions: ACTIONS,
  }
}

function refusal(code: Connect.RefusalCode, message: string) {
  return Effect.fail(new Connect.Refusal({ code, message: clip(message, Connect.MAX_SUMMARY) }))
}

function nameOf(model: Pick<ResolvedModel, "providerID" | "modelID">) {
  return `${model.providerID}/${model.modelID}`
}

// How far code goes: this computer, a model server, then anywhere else.
function reach(sendsTo: Connect.SendsTo) {
  if (sendsTo === "this-computer") return 0
  if (sendsTo.startsWith("model-server:")) return 1
  return 2
}

/** Where the review sends the diff: the review model's destination, or the triage model's when that goes further. */
export function widest(plan: Pick<Plan, "review" | "triage">): Connect.SendsTo {
  const triage = plan.triage?.sendsTo
  return triage && reach(triage) > reach(plan.review.sendsTo) ? triage : plan.review.sendsTo
}

// The cost kind the dollar cap is worked out for: local only when every model is local.
function capKind(models: readonly Checked[]): Connect.CostKind {
  const kinds = models.map((model) => model.costKind)
  return (
    kinds.find((kind) => kind === "priced") ??
    kinds.find((kind) => kind === "unknown") ??
    kinds.find((kind) => kind !== "local") ??
    "local"
  )
}

function progressOf(context: ConnectAdapter.HandoffContext, line: string) {
  const pass = /^(review|security|verify): (\S+)$/.exec(line)
  return context.progress(pass ? { pass: pass[1], message: `${pass[1]} ${pass[2]}` } : { message: line })
}

/**
 * Whether `executeLocalReview` returned the stored outcome of an earlier review of this commit, which only its JSON on
 * stdout says. Nothing else is read from stdout: the outcome comes back as a value, and every note is Vector's own.
 */
export function printed(chunks: readonly string[]): { readonly cached: boolean } {
  try {
    const value: unknown = JSON.parse(chunks.join(""))
    return { cached: !!value && typeof value === "object" && (value as Record<string, unknown>).cached === true }
  } catch {
    return { cached: false }
  }
}

function settingsResult(target: Connect.Target, edited: readonly string[]): Connect.Result {
  const shown = edited.slice(0, 5).map((file) => clip(file, 200))
  return {
    state: "completed",
    verdict: "incomplete",
    summary: ConnectFrame.summarize({ verdict: "incomplete", target, findings: [], settingsEdited: true }),
    findings: [],
    sessions: [],
    notes: [
      ConnectPolicy.SETTINGS_NOTE,
      clip(
        `Settings the changes edit: ${shown.join(", ")}${edited.length > shown.length ? ` and ${edited.length - shown.length} more` : ""}.`,
        1_000,
      ),
    ],
    target,
  }
}

/** The result of a review VectorScope ran (or chose not to run), from what `executeLocalReview` returned. */
export function resultOf(input: {
  readonly request: Connect.ReviewRequest
  readonly local: LocalReviewResult
  readonly printed: { readonly cached: boolean }
  readonly plan: Pick<Plan, "review" | "triage">
  readonly scope: Pick<Scope, "changed">
  readonly previous?: Connect.Run
}): Connect.Result {
  const { request, local } = input
  const target = request.target
  const where = {
    ...(local.target ? { head: clip(local.target.head, 200), base: clip(local.target.mergeBase, 200) } : {}),
  }
  const outcome = local.outcome
  if (!outcome) {
    if (local.exitCode === 2)
      return {
        state: "failed",
        verdict: "not-reviewed",
        summary: clip(
          `VectorScope could not review ${ConnectFindings.targetWords(target)}: ${local.error ?? "no reason was given."}`,
          Connect.MAX_SUMMARY,
        ),
        findings: [],
        sessions: [],
        notes: [],
        target,
        ...where,
      }
    // Nothing to review: no changes, nothing left after the review's own path rules, or a commit already reviewed
    // whose stored outcome is gone. No model ran and the diff went nowhere.
    return {
      state: "completed",
      verdict: "not-reviewed",
      summary: ConnectFrame.summarize({ verdict: "not-reviewed", target, findings: [] }),
      findings: [],
      sessions: [],
      notes: [],
      target,
      ...where,
    }
  }

  const sendsTo = widest(input.plan)
  const cached = input.printed.cached
  const notes: string[] = []
  if (cached) notes.push(ConnectFindings.cachedNote(outcome.head))
  const triage = input.plan.triage
  if (triage && triage.sendsTo !== input.plan.review.sendsTo)
    notes.push(
      `The review pass ran on ${input.plan.review.model}, which sent the diff to ${ConnectFrame.describeSendsTo(input.plan.review.sendsTo)}; the triage pass ran on ${triage.model}, which sent it to ${ConnectFrame.describeSendsTo(triage.sendsTo)}.`,
    )
  notes.push(...ConnectFindings.outcomeNotes(outcome))
  const sessions = cached ? [] : outcome.sessions.filter(isSessionID).slice(0, Connect.MAX_SESSIONS)
  const cost = cached ? undefined : costOf(outcome, sendsTo)

  if (local.exitCode === 2)
    return {
      state: "failed",
      verdict: "not-reviewed",
      summary: clip(
        `VectorScope could not finish reviewing ${ConnectFindings.targetWords(target)}: ${local.error ?? "every reviewer failed."}`,
        Connect.MAX_SUMMARY,
      ),
      findings: [],
      sendsTo,
      ...(cost ? { cost } : {}),
      sessions,
      notes: bounded(notes),
      target,
      ...where,
    }

  let findings = ConnectFindings.fromSelection(outcome.selection)
  const previous = input.previous?.result
  if (previous && input.previous) {
    const earlier =
      previous.target ?? (input.previous.request.action === "review" ? input.previous.request.target : undefined)
    const compared = ConnectFindings.compare({
      target,
      previous: { ...(earlier ? { target: earlier } : {}), findings: previous.findings },
      current: findings,
      selection: outcome.selection,
      changed: input.scope.changed,
    })
    if (compared.ok) {
      findings = compared.findings
      notes.push(...compared.notes)
    } else notes.push(compared.refusal.message)
  }
  // The verdict sees every finding before the cut at the schema's limit.
  const verdict = ConnectFindings.verdict({ outcome, findings })
  const finished = ConnectFindings.finish(findings)
  notes.push(...finished.notes)
  const partial =
    outcome.partial !== undefined ||
    outcome.specialists.some(
      (pass) => pass.status === "failed" || pass.status === "timeout" || pass.status === "stopped",
    ) ||
    outcome.unreviewed.length > 0
  return {
    state: partial ? "partial" : "completed",
    verdict,
    summary: ConnectFrame.summarize({
      verdict,
      target,
      findings: finished.findings,
      ...(findings.length > finished.findings.length ? { total: findings.length } : {}),
      files: outcome.stats.files,
      cached,
    }),
    findings: finished.findings,
    sendsTo,
    cached,
    ...(cost ? { cost } : {}),
    sessions,
    notes: bounded(notes),
    target,
    ...where,
  }
}

// What a review cost. Vector Codium is plan usage: no dollars and no tokens, whatever the outcome recorded.
function costOf(outcome: ReviewOutcome, sendsTo: Connect.SendsTo): Connect.Cost | undefined {
  const cost = outcome.cost
  if (!cost) return undefined
  const visible = reviewForOutput(outcome).cost
  const codium =
    sendsTo === "vector-codium" ||
    cost.codium === true ||
    visible?.kind === "codium" ||
    (visible !== undefined && "billing" in visible && visible.billing === "codium")
  if (codium) return { kind: "plan" }
  const kind = ConnectPolicy.costKindOf(cost.kind)
  const usd = Number.isFinite(cost.costUsd) && cost.costUsd >= 0 ? cost.costUsd : undefined
  return {
    kind,
    ...(usd !== undefined && (kind === "priced" || (kind === "unknown" && usd > 0)) ? { usd } : {}),
  }
}

function bounded(notes: readonly string[]): string[] {
  return notes
    .map((note) => note.trim())
    .filter(Boolean)
    .map((note) => clip(note, 1_000))
    .slice(0, 100)
}

// ---------------------------------------------------------------------------------------------------------------
// Check 1: what the changes touch

/**
 * What the reviewed changes touch, read with git from the repository's top level. `changed` is what the target
 * covers: for uncommitted changes the working tree against HEAD with untracked files; for staged changes the index
 * against HEAD; for a branch the merge base against HEAD. `settings` is wider, because VectorScope reads its settings
 * from the working tree whatever the target: every path that differs between the target's base and the working tree
 * or the index, every untracked file (ignored ones too, under `.vector` and `.gitattributes`), and the branch's own
 * changes. Renames count on both sides. Settings paths that are links, or lie beneath one, are resolved with realpath
 * (`links`). Any git error refuses, so check 1 never passes on what it could not read.
 */
export const changes = Effect.fnUntraced(function* (git: Git.Interface, directory: string, target: Connect.Target) {
  const fail = (message: string) => refusal("input", message)
  const top = yield* git.run(["rev-parse", "--show-toplevel"], { cwd: directory })
  const found = top.exitCode === 0 ? top.text().trim() : ""
  if (!found) return yield* fail("VectorScope reviews work inside a git repository, and this directory is not in one.")
  const root = found
  const head = yield* commitOf(git, root, "HEAD")
  if (!head) return yield* fail("This repository has no commits yet, so there is nothing to compare.")
  const from = target.kind === "branch" ? yield* mergeBase(git, root, head, target.base) : head

  const list = Effect.fnUntraced(function* (args: string[]) {
    const result = yield* git.run(args, { cwd: root, maxOutputBytes: MAX_LIST_BYTES })
    if (result.exitCode !== 0 || result.truncated)
      return yield* fail("Connect could not list what these changes edit, so it did not review them.")
    return result
      .text()
      .split("\0")
      .filter((item) => item !== "")
  })
  const NAMES = ["--name-only", "--no-renames", "--no-ext-diff", "--no-relative", "-z"]
  const worktree = yield* list(["diff", ...NAMES, from, "--"])
  const index = yield* list(["diff", "--cached", ...NAMES, from, "--"])
  const untracked = yield* list(["ls-files", "--others", "--exclude-standard", "-z"])
  const ignored = yield* list(["ls-files", "--others", "-z", "--", ":(icase).vector", ":(icase).gitattributes"])
  const committed = target.kind === "branch" ? yield* list(["diff", ...NAMES, from, head, "--"]) : []
  const changed =
    target.kind === "uncommitted" ? [...worktree, ...untracked] : target.kind === "staged" ? index : committed
  const links = yield* Effect.promise(() => settingsLinks(root))
  return {
    root,
    changed: [...new Set(changed)],
    settings: [...new Set([...worktree, ...index, ...untracked, ...ignored, ...committed])],
    links,
  } satisfies Scope
})

const commitOf = Effect.fnUntraced(function* (git: Git.Interface, root: string, ref: string) {
  if (!ref || ref.startsWith("-")) return undefined
  const result = yield* git.run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], {
    cwd: root,
  })
  return result.exitCode === 0 ? result.text().trim() || undefined : undefined
})

// The branch's merge base with `base`, else with the default branch, found as `vector review` finds it.
const mergeBase = Effect.fnUntraced(function* (git: Git.Interface, root: string, head: string, base?: string) {
  let sha: string | undefined
  let ref = base
  if (base !== undefined) sha = yield* commitOf(git, root, base)
  else {
    const found = yield* git.defaultBranch(root)
    const candidates = found
      ? [found.ref.includes("/") ? found.ref : `origin/${found.name}`, `origin/${found.name}`, found.name]
      : []
    for (const candidate of new Set(candidates)) {
      sha = yield* commitOf(git, root, candidate)
      ref = candidate
      if (sha) break
    }
  }
  if (!sha)
    return yield* refusal(
      "input",
      base !== undefined
        ? `Could not find ${clip(base, 200)} to compare with. Pass a branch or commit as the base.`
        : "Could not find the default branch to compare with. Pass one as the base.",
    )
  const result = yield* git.run(["merge-base", sha, head], { cwd: root })
  const found = result.exitCode === 0 ? result.text().trim() : ""
  if (!found)
    return yield* refusal(
      "input",
      `Could not find where this branch starts from ${clip(ref ?? sha, 200)}. Run git fetch and try again, or pass a base.`,
    )
  return found
})

/**
 * The settings paths whose real path is not their own: `.vector` or a settings file that is a link or lies beneath
 * one. A link that cannot be resolved is returned without a target (check 1 then fires); one whose target lies outside
 * the repository is marked so, since the changes cannot edit it.
 */
export async function settingsLinks(root: string): Promise<ConnectPolicy.SettingsLink[]> {
  const home = await realpath(root)
  const links: ConnectPolicy.SettingsLink[] = []
  for (const file of LINKED) {
    const full = path.join(root, file)
    const real = await realpath(full).catch((error: unknown) => ({ error }))
    if (typeof real !== "string") {
      const link = await lstat(full)
        .then((info) => info.isSymbolicLink())
        .catch(() => false)
      if (!link && gone(real.error)) continue
      links.push({ path: file })
      continue
    }
    if (real === path.join(home, file)) continue
    const relative = path.relative(home, real)
    // A settings path that resolves to the repository's top level itself names nothing check 1 can match: fail closed.
    if (relative === "") links.push({ path: file })
    else if (relative.startsWith("..") || path.isAbsolute(relative))
      links.push({ path: file, target: relative.replaceAll("\\", "/"), outside: true })
    else links.push({ path: file, target: relative.replaceAll("\\", "/") })
  }
  return links
}

function gone(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
  return code === "ENOENT" || code === "ENOTDIR"
}

function clip(value: string, max: number) {
  return value.length <= max ? value : value.slice(0, max - 1) + "…"
}
