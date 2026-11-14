export * as VectorScopeAdapter from "./vectorscope"

import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { Cause, Context, Effect, Exit, Option, Schema, Stream } from "effect"
import { Billing } from "@vectordevai/schema/billing"
import { Connect } from "@vectordevai/schema/connect"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { ConnectFindings } from "@vectordevai/core/connect/findings"
import { ConnectFrame } from "@vectordevai/core/connect/frame"
import { ConnectPolicy } from "@vectordevai/core/connect/policy"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { reviewModels } from "@vectordevai/core/review/second-lab"
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
import { ConnectFix } from "../fix"
import { ConnectReviewService } from "../review-service"
import type { ReviewService } from "@/review/service"
import { ConnectGit } from "../git"

// VectorScope as a member of connected tools: the Vector agent asks it for a review in this engine process, on the
// user's own models, through the bound ReviewService invocation and its existing Review.run pipeline.
// Connect re-implements no review pass, selection or anchoring. Before a review it checks, in order: that the changes
// do not edit VectorScope's own settings (check 1), which models the review would use and whether any of them needs
// `connect_model` (check 2; the hub has already applied the requester's read rules, check 3, before this adapter ran),
// and the dollar cap. Then it runs the review with the reviewer's sessions as hidden children of the requester, through
// the hub's helper handle, and turns the outcome into a typed result. It never posts, never pushes and never picks a
// model: the order is VectorScope's own (review.json, then `agent.review.model`, then the configured default).
// A fix (CW-07) is the Vector agent's work until VectorScope has a fix mode: the adapter reads what the review's target
// changes now and hands the rest to connect/fix.ts.

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
  // A review can run in the background (CW-08): its questions come first, then the caller stops waiting.
  { id: "review", title: "Review your changes", effects: ["read"], background: true, result: "review" },
  // The Vector agent makes the fix (here, or in a connect_fix child's worktree) until VectorScope has a fix mode.
  { id: "fix", title: "Fix chosen findings", effects: ["read", "write"], background: false, result: "fix" },
]

const SUMMARY =
  "Reviews your changes on your own review model and returns its findings as data. Connect never posts a review or pushes."

// Settings paths the check-1 walk resolves links for, relative to the repository's top level.
const LINKED = [".vector", ...ConnectPolicy.SETTINGS_PATHS]

const MAX_LIST_BYTES = 64 * 1024 * 1024

// The most the settings files may hold together, as git prints them from the base; past it check 1 fires.
const MAX_SETTINGS_BYTES = 16 * 1024 * 1024

// The branch state files connect trusts at most at once (one per branch reviewed in this engine process).
const MAX_TRUSTED_STATES = 200

const isSessionID = Schema.is(SessionID)

/** A model the review would use, as connect checked it without a model call. */
export type Checked = ConnectPolicy.ReviewModel

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
  readonly judge?: Checked
  readonly selected?: { readonly review: string; readonly triage?: string; readonly judge?: string }
}

/** What the reviewed changes touch, for check 1 and for comparing with an earlier review. */
export interface Scope {
  /** The repository's top level, where `vector review` reads its settings. */
  readonly root: string
  readonly head?: string
  readonly base?: string
  /** The paths the target changes: what the review covers. */
  readonly changed: readonly string[]
  /** Every path that differs between the target's base and the working tree, the index or the target. */
  readonly settings: readonly string[]
  readonly links: readonly ConnectPolicy.SettingsLink[]
}

/**
 * The options connect passes to `executeLocalReview`. It never sets `pr`, `post`, `yes` or `checks`, so nothing is
 * posted, nothing asks `confirm`, and no code under review runs. It asks for VectorScope's largest comment limit, so
 * selection keeps every finding it can, and passes the effective dollar cap as `maxCost`. `full` (branch reviews only)
 * makes VectorScope ignore its branch state file, which connect does when it did not see VectorScope write that file.
 */
export function reviewOptions(input: {
  readonly request: Connect.ReviewRequest
  readonly maxCost?: number
  readonly full?: boolean
  readonly env: Record<string, string | undefined>
}): LocalReviewOptions {
  const target = input.request.target
  return {
    directory: input.request.directory,
    ...(target.kind === "uncommitted" ? { uncommitted: true } : {}),
    ...(target.kind === "staged" ? { staged: true } : {}),
    ...(target.kind === "branch" && target.base !== undefined ? { base: target.base } : {}),
    ...(target.kind === "branch" && input.full ? { full: true } : {}),
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
    const env = Object.fromEntries(
      Object.entries(deps.env ?? process.env).filter(([name]) => name === "MODEL" || /^REVIEW_[A-Z0-9_]+$/.test(name)),
    )
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
    // The branch state files connect saw VectorScope write, by path, with a hash of what it wrote. Any other state file
    // (one written by a model's shell, by `vector review`, or before this engine started) is not trusted: the review
    // then runs with `full`, so no stored outcome or earlier head that a model could have written picks its result or
    // its range (I2).
    const states = new Map<string, { fingerprint: string; authority: string }>()

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
      return { model: name, role, costKind, sendsTo, fromRepository } satisfies Checked
    })

    // The models a review of `root` would use, in VectorScope's own order, read from the settings in its working tree.
    const plan = Effect.fnUntraced(function* (root: string, selectedGit?: Git.Interface, settingsRef?: string) {
      const selectedBase = selectedGit ? Context.add(base, Git.Service, selectedGit) : base
      const json =
        selectedGit && settingsRef
          ? yield* selectedGit.show(root, settingsRef, REVIEW_CONFIG_PATH)
          : yield* Effect.promise(() => readFile(path.join(root, REVIEW_CONFIG_PATH), "utf8").catch(() => undefined))
      const parsed = parseReviewConfig({ json, env, trigger: "local" })
      const resolve = yield* resolver()
      const resolveOne = (input: ReviewModel.ResolveInput) =>
        resolve({
          ...input,
          identity: "vectorscope",
          ...(parsed.config.modelEvidence === "warn" ? { evidence: true } : {}),
        }).pipe(
          Effect.provideContext(selectedBase),
          Effect.catch((error) => notReady(error.message)),
        )
      const reviewModel = yield* resolveOne({ trigger: "local", config: parsed.config.model, env })
      const triageModel = parsed.config.triageModel
        ? yield* resolveOne({ trigger: "local", exact: parsed.config.triageModel, env })
        : undefined
      const judgeModel =
        parsed.config.panel && parsed.config.judgeModel
          ? yield* resolveOne({ trigger: "local", exact: parsed.config.judgeModel, env })
          : undefined
      const codium = reviewModel.providerID === ModelPlanStatus.PROVIDER_ID && !triageModel
      const listed = codium ? ((yield* provider.list())[reviewModel.providerID]?.models ?? {}) : {}
      const role = (name: "triage" | "confirm" | "panelJudge") => {
        const model = Object.values(listed).find(
          (item) => item.codium?.review?.includes(name) && !item.codium.locked && !item.codium.auto,
        )
        return model
          ? { providerID: model.providerID, modelID: model.id, ...(model.codium?.lab ? { lab: model.codium.lab } : {}) }
          : undefined
      }
      // Use the runner's shared pure choice policy for consent; never choose a different route here.
      const picked = reviewModels<Pick<ResolvedModel, "providerID" | "modelID"> & { lab?: string }>({
        model: reviewModel,
        ...(triageModel ? { triage: triageModel } : {}),
        ...(judgeModel ? { judge: judgeModel } : {}),
        panel: parsed.config.panel,
        ...(codium
          ? { codium: { triage: role("triage"), confirm: role("confirm"), panelJudge: role("panelJudge") } }
          : {}),
        auto: reviewModel.providerID === ModelPlanStatus.PROVIDER_ID && reviewModel.modelID === ModelPlanStatus.AUTO_ID,
      })
      const known = [reviewModel, triageModel, judgeModel].filter((item) => item !== undefined)
      const checked = (
        model: Pick<ResolvedModel, "providerID" | "modelID">,
        role: "review" | "triage",
        fromRepository: boolean,
      ) =>
        Effect.gen(function* () {
          const name = nameOf(model)
          const resolved =
            known.find((item) => nameOf(item) === name) ?? (yield* resolveOne({ trigger: "local", exact: name, env }))
          return yield* check(resolved, role, fromRepository)
        })
      const review = yield* checked(picked.model, "review", parsed.config.model !== undefined)
      const triage = picked.triage
        ? yield* checked(picked.triage, "triage", parsed.config.triageModel !== undefined)
        : undefined
      const judge = picked.judge
        ? yield* checked(picked.judge, "review", parsed.config.judgeModel !== undefined)
        : undefined
      return {
        config: parsed.config,
        review,
        ...(triage ? { triage } : {}),
        ...(judge ? { judge } : {}),
        selected: {
          review: nameOf(reviewModel),
          ...(triageModel ? { triage: nameOf(triageModel) } : {}),
          ...(judgeModel ? { judge: nameOf(judgeModel) } : {}),
        },
      } satisfies Plan
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
    const userModel = Effect.fnUntraced(function* (selectedGit?: Git.Interface) {
      const resolve = yield* resolver()
      const exit = yield* resolve({ trigger: "local", env, identity: "vectorscope" }).pipe(
        Effect.provideContext(selectedGit ? Context.add(base, Git.Service, selectedGit) : base),
        Effect.exit,
      )
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
      ConnectGit.use(
        request.directory,
        (selected) =>
          Effect.gen(function* () {
            const git = selected.git
            const selectedBase = Context.add(base, Git.Service, git)
            if (request.action === "fix") return yield* fix(request, context, selected)
            if (request.target.kind === "task")
              return yield* refusal("input", "A task review must be placed by the connected-tools hub.")
            if (!context.sessionID && !context.reviewParentID)
              return yield* refusal("unavailable", "A VectorScope review through connect needs a session to run in.")
            const capability = context.reviewService
            if (!capability)
              return yield* refusal("unavailable", "Connect has no qualified VectorScope service for this run.")
            const reads = yield* ConnectReviewService.scope(capability)
            const target = context.reviewTarget ?? request.target
            const say = (pass: string, message: string) => context.progress({ pass, message })

            // Check 1: the settings the reviewed changes may have edited. No model runs when they did. It runs again right
            // before the review and once more after it, since an edit can land while connect waits on a question or while
            // the review runs (a parallel tool call, a background helper).
            yield* say("settings", "Checking what the changes edit")
            const settings = Effect.fnUntraced(function* () {
              const scope = yield* changes(git, request.directory, request.target)
              return { scope, edited: ConnectPolicy.editedSettings(scope.settings, scope.links) }
            })
            const { scope, edited } = yield* settings()
            if (edited.length > 0) return settingsResult(target, edited)

            // Check 2: the models, the dollar cap, and `connect_model` when a model is priced, has no readable price, or is
            // the repository's choice and not the user's own review model.
            yield* say("model", "Checking the review model")
            const planned = yield* plan(scope.root, git, scope.head).pipe(
              Effect.catch((why) => refusal("unavailable", why.reason)),
            )
            const models = [
              planned.review,
              ...(planned.triage ? [planned.triage] : []),
              ...(planned.judge ? [planned.judge] : []),
            ]
            const cap = ConnectPolicy.effectiveCap({
              costKind: capKind(models),
              repository: planned.config.maxCostUsd,
              tool: request.budget?.maxCostUsd,
              run: context.spend,
            })
            if (!cap.ok) return yield* cap.refusal
            const repository = models.some((model) => model.fromRepository)
            const user = repository ? yield* userModel(git) : undefined
            const consents = ConnectPolicy.reviewConsents({
              models,
              ...(user ? { userModel: user } : {}),
              ...(cap.value !== undefined ? { maxCostUsd: cap.value } : {}),
            }).filter((consent) => consent.permission === "connect_model")
            // `connect` itself was asked by the hub before this adapter ran.
            for (const consent of consents) yield* context.ask(consent)

            // The review, through VectorScope's own entry point.
            const loaded = yield* Effect.promise(async () => {
              const [service, run, model, review] = await Promise.all([
                import("@/review/service"),
                import("@/review/run"),
                import("@/review/model"),
                import("@/review/context"),
              ])
              return {
                execute: service.ReviewService.execute,
                run: run.Review.run,
                ReviewModel: model.ReviewModel,
                ReviewContext: review.ReviewContext,
              }
            })
            const prompts = yield* ConnectReviewService.service(capability, (input) =>
              selected.check().pipe(
                Effect.flatMap(() => {
                  const name = input.model && `${input.model.providerID}/${input.model.modelID}`
                  return name && models.some((model) => model.model === name)
                    ? Effect.void
                    : refusal("unavailable", "The review attempted a model that connect did not check and approve.")
                }),
              ),
            )
            const reviewContext = Context.merge(selectedBase, prompts)
            const runReview = deps.runReview ?? loaded.run
            const resolve = yield* resolver()
            const personal = models.every((model) => Connect.isLocal(model.sendsTo))
            const requirements =
              deps.requirements ??
              ((input: { readonly files: readonly string[]; readonly personal: boolean }) =>
                Effect.gen(function* () {
                  const place = yield* instruction.place()
                  return yield* loaded.ReviewContext.requirements({
                    place,
                    files: input.files,
                    personal: input.personal,
                  })
                }).pipe(
                  Effect.provideService(BrainKnowledge.Service, knowledge),
                  Effect.catchCause(() => Effect.succeed(undefined)),
                ))
            const bridge = yield* EffectBridge.make()
            const out: string[] = []
            const local: LocalReviewDeps = {
              runReview: (input) =>
                selected.check().pipe(
                  Effect.orDie,
                  Effect.flatMap(() =>
                    runReview({ ...input, parentID: context.reviewParentID ?? context.sessionID }).pipe(
                      Effect.provideContext(reviewContext),
                    ),
                  ),
                ),
              // VectorScope resolves the model again; it must be the one connect checked and asked about.
              resolveModel: (input) =>
                resolve(input).pipe(
                  Effect.provideContext(selectedBase),
                  Effect.flatMap((model) => {
                    const expected =
                      input.exact !== undefined
                        ? [planned.selected.triage, planned.selected.judge].find((name) => name === input.exact)
                        : planned.selected.review
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
            // Check 1 again: nothing may have edited the settings while connect asked or loaded.
            const before = yield* settings()
            if (before.edited.length > 0) return settingsResult(target, before.edited)
            // A branch review reads VectorScope's state file only when connect saw VectorScope write it as it is now.
            const statePath = request.target.kind === "branch" ? yield* stateFile(git, scope.root) : undefined
            const stateBefore = statePath ? yield* Effect.promise(() => fingerprint(statePath)) : undefined
            const authority = createHash("sha256")
              .update(JSON.stringify({ root: reads.readRoot, denies: [...reads.readDenies].sort() }))
              .digest("hex")
            const trusted =
              statePath !== undefined &&
              stateBefore !== undefined &&
              states.get(statePath)?.fingerprint === stateBefore &&
              states.get(statePath)?.authority === authority
            // Every question is behind it: a background run's caller stops waiting here.
            if (context.working) yield* context.working(cap.value !== undefined ? { maxCostUsd: cap.value } : {})
            yield* say("review", "Reviewing")
            const placement = yield* loadedMetadata(scope.root)
            yield* selected.check()
            const result = yield* loaded
              .execute(
                {
                  version: 1,
                  mode: "review",
                  directory: request.directory,
                  target: {
                    kind: request.target.kind === "uncommitted" ? "working-tree" : request.target.kind,
                    head: scope.head,
                    ...(request.target.kind === "branch" ? { base: scope.base } : {}),
                  },
                  settingsRef: scope.head,
                  parentID: context.reviewParentID ?? context.sessionID,
                  ...reads,
                  ...(cap.value === undefined ? {} : { maxCost: cap.value }),
                  stopSignal: context.abort,
                },
                local,
                placement,
                {
                  ...(request.security === undefined ? {} : { security: request.security }),
                  maxComments: ConnectPolicy.MAX_COMMENTS,
                  environment: env,
                  ...(request.target.kind === "branch" ? { cache: { full: !!context.fullReview || !trusted } } : {}),
                },
              )
              .pipe(Effect.provideService(Git.Service, git))

            if (statePath) {
              const stateAfter = yield* Effect.promise(() => fingerprint(statePath))
              states.delete(statePath)
              // Trusted from here: what VectorScope wrote in this run, or the trusted file it left as it was.
              if (stateAfter !== undefined && (stateAfter !== stateBefore || trusted)) {
                states.set(statePath, { fingerprint: stateAfter, authority })
                for (const key of states.keys()) if (states.size > MAX_TRUSTED_STATES) states.delete(key)
              }
            }
            const shown = printed(out)
            // Check 1 once more: a review whose settings changed while it ran is never shown as VectorScope's result. Its
            // sessions and cost stay on the result, since they were made and spent.
            const after = yield* settings().pipe(
              Effect.map((again) => again.edited),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.failCause(cause)
                  : Effect.succeed([...ConnectPolicy.SETTINGS_PATHS]),
              ),
            )
            if (after.length > 0)
              return settingsResult(target, after, spentOf({ local: result, printed: shown, plan: planned }))
            return resultOf({
              request,
              target,
              local: result,
              printed: shown,
              plan: planned,
              scope,
              ...(context.previous ? { previous: context.previous } : {}),
            })
          }),
        context.reviewGit,
      )

    // A fix works from the review it names, over what that review's target changes now (the owned-path rule's diff).
    const fix = Effect.fnUntraced(function* (
      request: Connect.FixRequest,
      context: ConnectAdapter.HandoffContext,
      selected: ConnectGit.Selected,
    ) {
      if (!context.sessionID)
        return yield* refusal("unavailable", "A fix through connect needs a session to ask in and to report to.")
      const source = context.source
      if (!source?.result || source.request.action !== "review")
        return yield* refusal("input", `There is no review ${request.run} in this session to fix.`)
      if (source.request.target.kind === "task")
        return yield* refusal(
          "input",
          "Fix the isolated task through its own task conversation, then settle and review it again.",
        )
      yield* context.progress({ pass: "fix", message: "Checking what the changes edit" })
      const scope = yield* changes(selected.git, request.directory, ConnectFix.targetOf(source))
      yield* selected.check()
      return yield* ConnectFix.run({ request, context, source, root: scope.root, changed: scope.changed })
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

const loadedMetadata = Effect.fnUntraced(function* (root: string) {
  const { ReviewGit } = yield* Effect.promise(() => import("@/review/git"))
  return yield* ReviewGit.metadata(root).pipe(
    Effect.mapError((error) => new Connect.Refusal({ code: "unavailable", message: error.message })),
  )
})

// How far code goes: this computer, a model server, then anywhere else.
function reach(sendsTo: Connect.SendsTo) {
  if (sendsTo === "this-computer") return 0
  if (sendsTo.startsWith("model-server:")) return 1
  return 2
}

/** Where the review sends the diff: the review model's destination, or the triage model's when that goes further. */
export function widest(plan: Pick<Plan, "review" | "triage" | "judge">): Connect.SendsTo {
  return [plan.review, plan.triage, plan.judge]
    .filter((item) => item !== undefined)
    .map((item) => item.sendsTo)
    .reduce((widest, next) => (reach(next) > reach(widest) ? next : widest))
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

/** The note a review gets when its settings changed while it ran; its findings are left out. */
export const SETTINGS_CHANGED_NOTE =
  "They changed after connect checked them, while the review ran, so what it found is not shown."

/**
 * The result when check 1 fires: verdict `incomplete`, no findings. `spent` is set when it fired after the review ran,
 * and keeps what that review made and spent, and where it sent the diff.
 */
function settingsResult(target: Connect.Target, edited: readonly string[], spent?: Spent): Connect.Result {
  const shown = edited.slice(0, 5).map((file) => clip(file, 200))
  return {
    state: "completed",
    verdict: "incomplete",
    summary: ConnectFrame.summarize({ verdict: "incomplete", target, findings: [], settingsEdited: true }),
    findings: [],
    ...(spent?.sendsTo ? { sendsTo: spent.sendsTo } : {}),
    ...(spent?.cost ? { cost: spent.cost } : {}),
    sessions: spent ? [...spent.sessions] : [],
    notes: [
      ConnectPolicy.SETTINGS_NOTE,
      clip(
        `Settings the changes edit: ${shown.join(", ")}${edited.length > shown.length ? ` and ${edited.length - shown.length} more` : ""}.`,
        1_000,
      ),
      ...(spent ? [SETTINGS_CHANGED_NOTE] : []),
    ],
    target,
  }
}

/** What a review made and spent, and where it sent the diff. */
export interface Spent {
  readonly sendsTo?: Connect.SendsTo
  readonly cost?: Connect.Cost
  readonly sessions: readonly SessionID[]
}

/**
 * What this run made and spent, and where it sent the diff. A stored outcome (cached) or no outcome at all means no
 * model ran now: no sessions, no cost, and no `sendsTo`, since the diff went nowhere this time (section 3.2).
 */
export function spentOf(input: {
  readonly local: LocalReviewResult & { verdict?: ReviewService.Result["verdict"] }
  readonly printed: { readonly cached: boolean }
  readonly plan: Pick<Plan, "review" | "triage" | "judge">
}): Spent {
  const outcome = input.local.outcome
  if (!outcome || input.printed.cached) return { sessions: [] }
  const sendsTo = widest(input.plan)
  const cost = costOf(outcome, sendsTo)
  return {
    sendsTo,
    ...(cost ? { cost } : {}),
    sessions: outcome.sessions.filter(isSessionID).slice(0, Connect.MAX_SESSIONS),
  }
}

/** The note a stored outcome gets: this run sent no code anywhere. */
export const CACHED_NOTE = "Connect sent no code this time: these findings are from that earlier review."

/** The result of a review VectorScope ran (or chose not to run), from what `executeLocalReview` returned. */
export function resultOf(input: {
  readonly request: Connect.ReviewRequest
  readonly target?: Connect.Target
  readonly local: LocalReviewResult & { verdict?: ReviewService.Result["verdict"] }
  readonly printed: { readonly cached: boolean }
  readonly plan: Pick<Plan, "review" | "triage" | "judge">
  readonly scope: Pick<Scope, "changed">
  readonly previous?: Connect.Run
}): Connect.Result {
  const { request, local } = input
  const target = input.target ?? request.target
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

  const cached = input.printed.cached
  // A stored outcome: no model ran and no diff went anywhere in this run, so there is no `sendsTo`, cost or session.
  const { sendsTo, cost, sessions } = spentOf(input)
  const notes: string[] = []
  if (cached) notes.push(ConnectFindings.cachedNote(outcome.head), CACHED_NOTE)
  const triage = input.plan.triage
  if (!cached && triage && triage.sendsTo !== input.plan.review.sendsTo)
    notes.push(
      `The review pass ran on ${input.plan.review.model}, which sent the diff to ${ConnectFrame.describeSendsTo(input.plan.review.sendsTo)}; the triage pass ran on ${triage.model}, which sent it to ${ConnectFrame.describeSendsTo(triage.sendsTo)}.`,
    )
  notes.push(...ConnectFindings.outcomeNotes(outcome))

  if (local.exitCode === 2)
    return {
      state: "failed",
      verdict: "not-reviewed",
      summary: clip(
        `VectorScope could not finish reviewing ${ConnectFindings.targetWords(target)}: ${local.error ?? "every reviewer failed."}`,
        Connect.MAX_SUMMARY,
      ),
      findings: [],
      ...(sendsTo ? { sendsTo } : {}),
      ...(cost ? { cost } : {}),
      sessions: [...sessions],
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
  const verdict: Connect.Verdict = local.verdict
    ? local.verdict.verdict === "clean-complete"
      ? "clean"
      : local.verdict.verdict === "policy-skip"
        ? "not-reviewed"
        : local.verdict.verdict
    : ConnectFindings.verdict({ outcome, findings })
  const finished = ConnectFindings.finish(findings)
  notes.push(...finished.notes)
  const partial =
    local.verdict?.verdict === "incomplete" ||
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
    ...(sendsTo ? { sendsTo } : {}),
    cached,
    ...(cost ? { cost } : {}),
    sessions: [...sessions],
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
 * (`links`). Any git error refuses, so check 1 never passes on what it could not read. Every settings file whose bytes
 * differ from the base's (`drifted`) counts too, since git's own view of the working tree can be told to look away.
 */
export const changes = Effect.fnUntraced(function* (git: Git.Interface, directory: string, target: Connect.Target) {
  const fail = (message: string) => refusal("input", message)
  if (target.kind === "task") return yield* fail("The task target has not been placed in its registered worktree.")
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
  const drift = yield* drifted(git, root, from)
  return {
    root,
    head,
    base: from,
    changed: [...new Set(changed)],
    settings: [...new Set([...worktree, ...index, ...untracked, ...ignored, ...committed, ...drift])],
    links,
  } satisfies Scope
})

/** A settings file at the base, as a checkout of it would read the file. */
type BaseFile = { readonly kind: "blob"; readonly bytes: Buffer } | { readonly kind: "missing" | "outside" }

/**
 * The settings files whose bytes in the working tree, read as the review reads them (through links), are not what the
 * same file holds at `from`. Raw bytes, so nothing that makes git's own view of the working tree look away hides an
 * edit: an assume-unchanged or skip-worktree entry, `core.ignoreStat`, a stat setting, or a clean filter (and git
 * already runs with the fsmonitor off). A file that is there is looked up at `from` under its real path, so a link or
 * a case-insensitive disk reads the same file on both sides; one that is not there is looked up under its own name,
 * with git following links inside its tree as a checkout of `from` would. Carriage returns before a line feed are
 * ignored, so a checkout's line-ending conversion is not an edit. A file present on one side only counts. A file that
 * leads out of the repository counts only when it did not lead out at `from` too, since the changes cannot edit what
 * lies there. Anything git cannot answer counts as edited, so check 1 fails closed.
 */
export const drifted = Effect.fnUntraced(function* (git: Git.Interface, root: string, from: string) {
  const files = ConnectPolicy.SETTINGS_PATHS
  const home = yield* Effect.promise(() => realpath(root).catch(() => undefined))
  if (!home) return [...files]
  const outside = (real: string | undefined) => {
    if (real === undefined) return undefined
    const relative = path.relative(home, real)
    return relative.startsWith("..") || path.isAbsolute(relative) ? true : relative === "" ? undefined : relative
  }
  const seen = yield* Effect.forEach(files, (file) =>
    Effect.promise(async () => {
      const full = path.join(root, file)
      // As `executeLocalReview` reads it: any error reads as no file.
      const now = await readFile(full).catch(() => undefined)
      const where = now === undefined ? undefined : outside(await realpath(full).catch(() => undefined))
      return { file, full, now, where }
    }),
  )
  // A file that is there and inside the repository is looked up under its real path, without links.
  const lookup = seen.map((item) => (typeof item.where === "string" ? item.where.replaceAll("\\", "/") : item.file))
  const result = yield* git.run(["cat-file", "--batch", "--follow-symlinks"], {
    cwd: root,
    stdin: Stream.make(new TextEncoder().encode(lookup.map((file) => `${from}:${file}\n`).join(""))),
    maxOutputBytes: MAX_SETTINGS_BYTES,
  })
  const base = result.exitCode === 0 && !result.truncated ? parseBatch(result.stdout, files.length) : undefined
  if (!base) return [...files]
  const edited: string[] = []
  for (const [index, item] of seen.entries()) {
    const found = base[index]!
    // A link out of the repository at `from` that git read as no file (`ledOutAt`) is a link out all the same.
    const then: BaseFile =
      found.kind === "missing" && (yield* ledOutAt(git, root, from, item.file)) ? { kind: "outside" } : found
    if (item.now !== undefined && item.where === undefined) edited.push(item.file)
    else if (then.kind === "blob") {
      if (item.now === undefined || !sameText(item.now, then.bytes)) edited.push(item.file)
    } else if (then.kind === "outside") {
      // Out of the repository at `from`: fine while it still leads out.
      const now = item.now === undefined ? outside(yield* Effect.promise(() => resolved(item.full))) : item.where
      if (now !== true) edited.push(item.file)
    } else if (item.now !== undefined) edited.push(item.file)
  }
  return edited
})

/**
 * Whether `file` passed at `from` through a link to a Windows drive or network path. Git follows only a target that
 * starts with "/" out of the tree, and reads `C:\...` as a path inside it that is not there, so on Windows a link
 * that led out at `from` comes back from `cat-file --follow-symlinks` as no file at all. Anything git cannot answer
 * reads as no such link, so the file still counts as edited.
 */
const ledOutAt = Effect.fnUntraced(function* (git: Git.Interface, root: string, from: string, file: string) {
  if (process.platform !== "win32") return false
  const parts = file.split("/")
  for (let end = 1; end <= parts.length; end++) {
    const listed = yield* git.run(["ls-tree", "-z", from, "--", parts.slice(0, end).join("/")], { cwd: root })
    const entry = listed.exitCode === 0 ? listed.text().split("\0")[0] : undefined
    if (!entry || !entry.includes("\t")) return false
    const [mode, type, oid] = entry.slice(0, entry.indexOf("\t")).split(" ")
    if (mode === "120000" && oid) {
      const target = yield* git.run(["cat-file", "blob", oid], { cwd: root })
      return target.exitCode === 0 && /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(target.text())
    }
    if (type !== "tree") return false
  }
  return false
})

// `git cat-file --batch --follow-symlinks` output, one record per requested object, or undefined when it does not
// read as that.
function parseBatch(out: Buffer, count: number): BaseFile[] | undefined {
  const files: BaseFile[] = []
  let at = 0
  for (let item = 0; item < count; item++) {
    const end = out.indexOf(10, at)
    if (end < 0) return undefined
    const header = out.subarray(at, end).toString("utf8")
    at = end + 1
    if (header.endsWith(" missing")) {
      files.push({ kind: "missing" })
      continue
    }
    const fields = header.split(" ")
    const linked = ["symlink", "dangling", "loop", "notdir"].includes(fields[0]!)
    if (fields.length !== (linked ? 2 : 3)) return undefined
    const kind = linked ? fields[0]! : fields[1]!
    const size = Number(fields.at(-1))
    if (!Number.isSafeInteger(size) || size < 0 || at + size >= out.length || out[at + size] !== 10) return undefined
    const body = out.subarray(at, at + size)
    at += size + 1
    // A link out of the repository; a dangling or looping link, or a path through a file, reads as no file; so does a
    // directory or a submodule, which the review cannot read as text either.
    files.push(kind === "blob" ? { kind: "blob", bytes: body } : { kind: kind === "symlink" ? "outside" : "missing" })
  }
  return files
}

// Where a path leads: its real path, or for a file that is not there, its nearest existing folder's real path joined
// with the rest.
async function resolved(full: string): Promise<string | undefined> {
  const real = await realpath(full).catch(() => undefined)
  if (real) return real
  const parent = path.dirname(full)
  if (parent === full) return undefined
  const up = await resolved(parent)
  return up ? path.join(up, path.basename(full)) : undefined
}

function sameText(a: Buffer, b: Buffer) {
  if (a.equals(b)) return true
  const lines = (bytes: Buffer) => bytes.toString("latin1").replaceAll("\r\n", "\n")
  return lines(a) === lines(b)
}

/**
 * VectorScope's state file for the branch checked out at `root`, where `executeLocalReview` keeps it: the git
 * directory's vector/review/<branch>.json. Undefined on a detached head or when git cannot say.
 */
export const stateFile = Effect.fnUntraced(function* (git: Git.Interface, root: string) {
  const branch = yield* git.branch(root)
  if (!branch) return undefined
  const result = yield* git.run(["rev-parse", "--absolute-git-dir"], { cwd: root })
  const dir = result.exitCode === 0 ? result.text().trim() : ""
  return dir ? path.join(dir, "vector", "review", `${encodeURIComponent(branch)}.json`) : undefined
})

/** A hash of a file's bytes; undefined when it cannot be read. */
export async function fingerprint(file: string): Promise<string | undefined> {
  const bytes = await readFile(file).catch(() => undefined)
  return bytes ? createHash("sha256").update(bytes).digest("hex") : undefined
}

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
