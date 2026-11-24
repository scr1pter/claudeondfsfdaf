import { Billing } from "@vectordevai/schema/billing"
import { codiumPass, reviewForOutput } from "./review-output"
// `vector review` (section 3.13): the review CI runs, on your own branch, your uncommitted or staged changes, or a
// pull request, printed here rather than posted. Your own changes are reviewed in place with the settings in your
// working tree. A pull request is reviewed untrusted: its commit is fetched into FETCH_HEAD only, its files go in the
// prompt, nothing of it is checked out, and its settings come from the base.

import { createHash } from "node:crypto"
import fs from "fs"
import fsp from "fs/promises"
import path from "path"
import { Cause, Effect, Option, Schema } from "effect"
import { InstallationVersion } from "@vectordevai/core/installation/version"
import { ReviewCheckpointLock } from "@vectordevai/core/review/checkpoint-lock"
import { Flock } from "@vectordevai/core/util/flock"
import {
  MAX_RULES_BYTES,
  mergeReviewConfig,
  parseReviewRules,
  REVIEW_CONFIG_PATH,
  REVIEW_RULES_PATHS,
  rulePromptInput,
} from "@vectordevai/core/review/config"
import { parseUnifiedDiff, renderPatch, type DiffFile } from "@vectordevai/core/review/diff"
import {
  buildReviewBody,
  buildSummaryBody,
  failedSpend,
  firstRequestStopDetail,
  formatUsd,
  noteBudgetEstimate,
  noteMoved,
  noteNothingToReview,
  notePartial,
  notePrivacyRefused,
  noteTrivialSkip,
} from "@vectordevai/core/review/format"
import {
  buildCreateReviewPayload,
  splitHalves,
  type CreateReviewPayload,
} from "@vectordevai/core/review/github-payload"
import {
  classifyFiles,
  classifyPath,
  DEFAULT_IGNORES,
  generatedHeaderDecision,
  hasGeneratedHeader,
  parseGitAttributes,
  type GitAttributes,
} from "@vectordevai/core/review/ignore"
import { completeStrictReview } from "@vectordevai/core/review/local-result"
import { policyDigest, REVIEW_PIPELINE_SOURCES } from "@vectordevai/core/review/model-evidence"
import { diffBudgetChars, estimateCostUsd } from "@vectordevai/core/review/plan"
import type { PromptInput } from "@vectordevai/core/review/prompt"
import { holdbackText } from "@vectordevai/core/review/holdback"
import { collectSecretValues, REDACTED, redactSecrets } from "@vectordevai/core/review/redact"
import {
  classifyPrior,
  decodeState,
  encodeState,
  emptyState,
  monthKey,
  nextState,
  type NextStateInput,
  priorFromState,
  reviewCostHasCodium,
  reviewCostIsCodium,
  SUMMARY_MARKER,
} from "@vectordevai/core/review/state"
import type {
  FocusHunk,
  PlacedFinding,
  PriorFinding,
  ReviewConfig,
  ReviewOutcome,
  ReviewState,
  Selection,
  Severity,
  SkippedFile,
  SummaryFinding,
  Trust,
} from "@vectordevai/core/review/types"
import { postingPlan, reviewVerdict, unfinishedCauses, type PostingPlan, type ReviewVerdict } from "@vectordevai/core/review/verdict"
import { Git } from "@/git"
import { ReviewGit } from "@/review/git"
import { ReviewMcpSnapshot } from "@/review/mcp-snapshot"
import { concurrentBatchRecord, lockBatchFile, localBatchStore, uncertainBatchMonth, unknownOwnSpend } from "@/review/batch-local"
import { redactDiagnosticData } from "@/review/checks"
import { ReviewTrivial } from "@/review/trivial"
import { Brain } from "@vectordevai/core/brain/brain"
import { Database } from "@vectordevai/core/database/database"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { freeModelMayTrain } from "@vectordevai/core/free-model-choice"
import { Provider } from "@/provider/provider"
import { EffectBridge } from "@/effect/bridge"
import { Instruction } from "@/session/instruction"
import { Config } from "@/config/config"
import { SessionPosting } from "@/session/posting"
import { ReviewCardAccess } from "@/review/card-access"
import { ReviewAuthor } from "@/review/author"
import { ReviewContext } from "@/review/context"
import type { ReviewModel, ResolvedModel } from "@/review/model"
import { ReviewRoutes } from "@/review/route"
import type { Review } from "@/review/run"
import { ReviewSource } from "@/review/source"
import { Process } from "@/util/process"
import type { SessionID } from "@/session/schema"
import { InstanceRef } from "@/effect/instance-ref"
import { readAuthority, type ReadAuthority } from "@/review/read-authority"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import type { ReviewGitHub, ReviewGitHubOptions } from "./github.review-api"
import { renderLocalReview, type LocalTarget } from "./review.render"
import type { FixStep } from "./review.fix"
import { githubFetch } from "./github.shared"

// --no-relative and the prefixes keep paths repository-relative and parseable whatever the user's diff config says.
const DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/"]
const MAX_DIFF_BYTES = 64 * 1024 * 1024
const MAX_UNTRACKED = 500
const MAX_SUBJECTS = 50
// Above this many files the cost estimate is shown before the review starts (section 5.2).
const ESTIMATE_FILES = 50
// The system prompt, tool definitions and context around the diff, in tokens, for that estimate.
const PROMPT_OVERHEAD_TOKENS = 8_000

export type FailOn = "blocking" | "concern" | "never"

export interface LocalReviewOptions {
  directory: string
  base?: string
  uncommitted?: boolean
  staged?: boolean
  pr?: number
  post?: boolean
  yes?: boolean
  json?: boolean
  model?: string
  security?: boolean // --security always runs the security reviewer, --no-security never does
  maxComments?: number
  minSeverity?: Severity
  maxCost?: number
  failOn?: FailOn
  checks?: boolean
  full?: boolean
  // --apply (VS-12c): after a review of your branch, offer its verified fixes; a flag, never a repository setting.
  apply?: boolean
  env?: Record<string, string | undefined> // REVIEW_* overrides; process.env by default
  // Internal service context, never parsed from CLI flags or repository settings.
  context?: {
    parentID?: SessionID
    expectedHead: string
    settingsRef: string
    stateless: boolean
    readDenies?: readonly string[]
    readRoot?: string
    admittedReads?: ReadAuthority
    identity?: "vectorscope"
    stopSignal?: AbortSignal
  }
}

// A pull request's text from `gh pr view`. Its author wrote it, so it only ever goes in the prompt's untrusted blocks.
export interface PullInfo {
  title?: string
  body?: string
  author?: string
  baseRefName?: string
}

export interface LocalReviewDeps<RunR = never, ModelR = never> {
  runReview: (input: Review.RunInput) => Effect.Effect<ReviewOutcome, never, RunR>
  // Under privacy "zdr" its error carries `refusal` when the model has no route the rules allow (VS-23b).
  resolveModel: (input: ReviewModel.ResolveInput) => Effect.Effect<ResolvedModel, ReviewModel.ReviewModelError, ModelR>
  confirm: (question: string) => Promise<boolean> // false when nobody can answer
  pullInfo?: (pr: number, directory: string) => Promise<PullInfo | undefined>
  stdout: (text: string) => Promise<void> // the review or the JSON
  stderr: (text: string) => void // progress and warnings
  // Trusted adapters can reuse only the exact state bytes their previous invocation published.
  branchCache?: { fingerprint?: string; written: (fingerprint: string) => void }
  now?: () => number
  color?: boolean
  github?: GitHubAccess // for --post; the GitHub CLI's token and the real API by default
  cards?: (input: ReviewCardAccess.Request) => Effect.Effect<ReviewContext.CardGrant | undefined>
  // What the user's documents require of the changed files, from Vector's brain; none outside a Vector repository.
  // `shared` is set when the review leaves this computer (--post): then no private document may be in it.
  requirements?: (input: {
    files: readonly string[]
    model: ResolvedModel
    shared: boolean
  }) => Effect.Effect<string | undefined>
  // The posting check --post goes through (section 6.4a): what repeats the owner's memory is left out, and a check
  // that cannot run posts nothing. Required, so a new caller cannot post unchecked; a test that means to skip it passes
  // one that sends every part as it is.
  posting: (input: {
    parts: readonly string[]
    sessionIDs: readonly string[]
    untrusted: boolean
  }) => Promise<readonly string[]>
  // The consented apply step behind --apply (review.fix.ts); only the vector review command gives one.
  fix?: FixStep
}

// What --post needs from GitHub: a token for the remote's host, who it belongs to, and the two writes it makes.
export interface GitHubAccess {
  token: (host: string, env: Record<string, string | undefined>) => Promise<string | undefined>
  login: (token: string, baseUrl?: string) => Promise<string | undefined>
  create: (options: ReviewGitHubOptions) => Promise<Pick<ReviewGitHub, "createReview" | "createIssueComment">>
}

export interface LocalReviewResult {
  exitCode: 0 | 1 | 2 // 0 completed, 1 --fail-on was triggered, 2 the review could not run
  error?: string
  target?: LocalTarget
  outcome?: ReviewOutcome
}

export class LocalReviewError extends Schema.TaggedErrorClass<LocalReviewError>()("LocalReviewError", {
  message: Schema.String,
}) {}

interface Base {
  ref: string
  sha: string
}

interface Range {
  target: LocalTarget
  head: string
  mergeBase: string
  files: DiffFile[] // everything that changed; findings are anchored against it
  mode: "full" | "incremental" | "carry"
  since?: string
  focus?: FocusHunk[]
  worktree?: "uncommitted" | "staged" // files are read from the working tree or the index, not a commit
  remote?: string // the remote a pull request was fetched from
  nothing: string // what to say when nothing changed
}

interface LocalOutputPolicy {
  diagnostics?: boolean
  failClosedPR?: boolean
  skipVerdict?: ReviewVerdict
}

export function executeLocalReview<RunR, ModelR>(
  options: LocalReviewOptions,
  deps: LocalReviewDeps<RunR, ModelR>,
): Effect.Effect<LocalReviewResult, never, Git.Service | RunR | ModelR> {
  return Effect.gen(function* () {
    // Each execution has its own output policy, including when the same Effect runs concurrently.
    const output: LocalOutputPolicy = {}
    let result = yield* localReview(options, deps, output)
    if (output.failClosedPR) {
      // A base policy applies to this PR even when an explicit severity flag or an environment override is weaker.
      // One-off PR reviews do not read or write the GitHub job's bot-owned state or check outputs.
      const verdict = result.outcome
        ? reviewVerdict({ kind: "outcome", outcome: result.outcome }).verdict
        : output.skipVerdict ?? "not-reviewed"
      const failed = verdict === "not-reviewed" || verdict === "incomplete" || verdict === "blocking"
      if (failed || result.error) result = { ...result, exitCode: 1 }
    }
    // Git can fail before a base settings blob is available. The owner's independent config still applies.
    if (result.error && output.diagnostics === undefined) {
      const settings = yield* Effect.serviceOption(Config.Service)
      output.diagnostics = Option.isSome(settings)
        ? yield* settings.value.getGlobal().pipe(
            Effect.map(
              ({ review }) =>
                !!review &&
                mergeReviewConfig({ surface: "local", global: review, trigger: "local" }).config.diagnostics ===
                  "offline",
            ),
            // When the owner's policy cannot be read, disclose only a masked error.
            Effect.catchDefect(() => Effect.succeed(true)),
          )
        : false
    }
    return output.diagnostics ? redactDiagnosticData(result) : result
  })
}

export const APPLY_DIAGNOSTICS_REFUSAL =
  "--apply is not available while review diagnostics are offline. Nothing was reviewed."

function localReview<RunR, ModelR>(
  options: LocalReviewOptions,
  deps: LocalReviewDeps<RunR, ModelR>,
  output: LocalOutputPolicy,
): Effect.Effect<LocalReviewResult, never, Git.Service | RunR | ModelR> {
  return Effect.gen(function* () {
    const refused = refuseFlags(options)
    if (refused) return yield* new LocalReviewError({ message: refused })
    if (options.context?.identity === "vectorscope" && !(yield* ReviewGit.Current))
      return yield* new LocalReviewError({ message: "The VectorScope service requires a private Git view." })
    const git = yield* ReviewGit.client
    const env = options.env ?? process.env
    const now = deps.now ?? Date.now
    const publicValue = <T>(value: T) => (output.diagnostics ? redactDiagnosticData(value) : value)
    const say = (text: string) => deps.stderr(publicValue(text) + "\n")
    const print = (text: string) => Effect.promise(() => deps.stdout(publicValue(text)))
    const printJson = (data: unknown) =>
      Effect.promise(() => deps.stdout(JSON.stringify(publicValue(data), null, 2) + "\n"))
    // Every --apply refusal comes before a model is resolved or anything is reviewed.
    const fixRefused = !options.apply
      ? undefined
      : options.context || !deps.fix
        ? "--apply is only available to the vector review command."
        : deps.fix.refusal(env)
    if (fixRefused) return yield* new LocalReviewError({ message: fixRefused })

    // 1. The repository, and the branch or commit to compare with.
    const root = yield* toplevel(git, options.directory)
    const current = yield* commitOf(git, root, "HEAD")
    if (!current)
      return yield* new LocalReviewError({
        message: "This repository has no commits yet, so there is nothing to compare.",
      })
    if (options.context && current !== options.context.expectedHead)
      return yield* new LocalReviewError({
        message: "The review head changed. Start a new review of the current changes.",
      })
    if (options.context && (yield* commitOf(git, root, options.context.settingsRef)) !== options.context.settingsRef)
      return yield* new LocalReviewError({
        message: "The pinned review settings commit is not available in this repository.",
      })
    const readDenies = options.context?.admittedReads?.absolute ?? options.context?.readDenies
    const authority = options.context?.admittedReads?.absolute.includes("*")
      ? options.context.admittedReads
      : readDenies?.length
        ? readAuthority(readDenies, {
            directory: root,
            worktree: (yield* InstanceRef)?.worktree ?? root,
            ...(options.context?.readRoot ? { readRoot: options.context.readRoot } : {}),
          })
        : undefined
    const denied = (file: string) => authority?.denied(file) === true
    if (denied(REVIEW_CONFIG_PATH))
      return yield* new LocalReviewError({ message: "This conversation cannot read the review settings." })
    const branch = yield* git.branch(root)
    const branchRefused = options.apply ? deps.fix?.branchRefusal(branch) : undefined
    if (branchRefused) return yield* new LocalReviewError({ message: branchRefused })
    const trust = options.pr === undefined ? ("trusted" as const) : ("untrusted" as const)
    const pull =
      options.pr !== undefined && deps.pullInfo
        ? yield* Effect.promise(() => deps.pullInfo!(options.pr!, root))
        : undefined
    const worktree = options.uncommitted ? "uncommitted" : options.staged ? "staged" : undefined
    const base =
      worktree && options.base === undefined
        ? undefined
        : yield* resolveBase(git, root, { requested: options.base, suggested: pull?.baseRefName })

    // 2. Settings: your working tree for your own changes, the base for a pull request. review.json is read with its
    // sources tagged (VS-23b): `privacy` and `holdback` there or in REVIEW_PRIVACY / REVIEW_HOLDBACK can only raise,
    // and so can your user config's hidden `review` block (VS-23d, SF-15), the one source of `zdrAttested` here.
    // Every engine runtime has the config service: the CLI, the local review service, the owner's local run and
    // connect's reviews. Only tests that build executeLocalReview's runtime by hand omit it, and they read no user
    // config, as before SF-15. No production entry may omit it: without it the user config's privacy is not read.
    const settings = yield* Effect.serviceOption(Config.Service)
    const ownerSettings = Option.isSome(settings) ? yield* settings.value.getGlobal() : undefined
    const global = ownerSettings?.review
    const localInversion = global?.inversion === "local" && ReviewAuthor.localEnvironment("local", env)
    const setting = (file: string) =>
      denied(file)
        ? Effect.succeed(undefined)
        : options.context
          ? readBlob(git, root, options.context.settingsRef, file)
          : trust === "trusted"
            ? readWorkingFile(root, file)
            : readBlob(git, root, base!.sha, file)
    const settingsAt = options.context
      ? options.context.settingsRef === base?.sha
        ? "base"
        : "snapshot"
      : trust === "trusted"
        ? "working-tree"
        : "base"
    const settingsText = yield* setting(REVIEW_CONFIG_PATH)
    const parsed = mergeReviewConfig({
      surface: "local",
      ...(global ? { global } : {}),
      json: {
        at: settingsAt,
        text: settingsText,
      },
      env,
      trigger: "local",
    })
    output.failClosedPR = options.pr !== undefined && settingsAt === "base" && parsed.config.failOn === "blocking-or-incomplete"
    output.diagnostics = parsed.config.diagnostics === "offline"
    // An offline-diagnostics outcome is redacted before --apply would read it (redactDiagnosticData), suggestions and
    // patches included, so a fix could write "[redacted]" over the source. Refused before any model or review.
    if (options.apply && output.diagnostics)
      return yield* new LocalReviewError({ message: APPLY_DIAGNOSTICS_REFUSAL })
    for (const warning of parsed.warnings) say(`Warning: ${warning}`)
    let config = withFlags(
      parsed.config,
      options.context && options.maxCost !== undefined && parsed.config.maxCostUsd > 0
        ? { ...options, maxCost: Math.min(options.maxCost, parsed.config.maxCostUsd) }
        : options,
    )
    // A service may pin its settings to the reviewed head. Only its pinned base can supply rule evidence.
    const checkRules = config.ruleCheck === "strict"
    const ruleSourceAvailable = !checkRules || settingsAt !== "snapshot"
    // The regular config parser also supports linked files. They cannot establish path-specific citations.
    const ruleConfig =
      checkRules &&
      settingsAt === "working-tree" &&
      config.paths.length &&
      (yield* readWorkingRule(root, REVIEW_CONFIG_PATH, 1024 * 1024)) !== settingsText
        ? { ...config, paths: [] }
        : config
    const ruleFile = (file: string) =>
      checkRules && settingsAt === "working-tree" && !denied(file) ? readWorkingRule(root, file) : setting(file)
    if (!ruleSourceAvailable)
      say("Rule citations are unavailable because the pinned settings commit is not the review base.")
    let rulesText: string | undefined
    if (ruleSourceAvailable) for (const file of REVIEW_RULES_PATHS) rulesText ??= yield* ruleFile(file)
    const rules = parseReviewRules(rulesText ?? "")
    if (rules.truncated) say("Warning: .vector/review.md is over 16 KB; only the first 16 KB is used.")
    const attributesText = yield* setting(".gitattributes")
    const attributes = attributesText ? parseGitAttributes(attributesText) : undefined
    const ignored = (file: string) => denied(file) || classifyPath(file, { config, attributes }) !== undefined

    // 3. What changed. Only a branch keeps "since last review" state, in the repository's git directory.
    const batchKey = config.largeChanges === "batch"
    const branchCache =
      options.context && !options.context.stateless && !batchKey && config.guardrail !== "strict"
        ? deps.branchCache
        : undefined
    const cachePolicy = branchCache ? JSON.stringify([REVIEW_PIPELINE_SOURCES, config, rulesText, attributesText]) : ""
    const branchFingerprint = (bytes: string | Buffer) =>
      createHash("sha256").update(cachePolicy).update("\0").update(bytes).digest("hex")
    // A saved branch review can carry evidence only if the trusted adapter verified its read authority.
    // A grant can change without changing either commit. An invocation with selected MCP resources must not
    // consume or create an ordinary review result or a resumable batch checkpoint.
    const snapshot = ReviewMcpSnapshot.freezeSelection(yield* ReviewMcpSnapshot.Trusted)
    const requiresFreshCoverage =
      !!snapshot ||
      (options.context &&
        (config.guardrail === "strict" || (!branchCache && (!!options.context.admittedReads || !!readDenies?.length))))
    const cardProvider = config.cards === "brain" && !options.context ? deps.cards : undefined
    // A pull ref cannot collide with a Git branch (colon is forbidden in refnames).
    const stateName = options.pr === undefined ? branch : batchKey ? `pr:${options.pr}` : undefined
    const localPath =
      !cardProvider && !options.context?.stateless && !requiresFreshCoverage && !worktree && stateName
        ? yield* localStatePath(git, root, stateName)
        : undefined
    const locked =
      batchKey && localPath
        ? yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: (signal) =>
                lockBatchFile(
                  root,
                  localPath,
                  current,
                  options.context?.stopSignal ? AbortSignal.any([signal, options.context.stopSignal]) : signal,
                  branch || undefined,
                ),
              catch: () => new LocalReviewError({ message: "The local batch checkpoint could not be opened safely." }),
            }).pipe(Effect.catch(() => Effect.succeed(undefined))),
            (file) => (file ? Effect.promise(file.close) : Effect.void),
          )
        : undefined
    const statePath = batchKey ? locked?.file : localPath
    let contextPolicy: string | undefined
    if (statePath && (config.guardrail === "strict" || locked)) {
      const owner = Option.isSome(settings) ? yield * settings.value.get() : undefined
      const model =
        options.model?.trim() || config.model?.trim() || owner?.agent?.review?.model?.trim() || owner?.model?.trim()
      // A provider-history fallback can change without any local review setting changing. A fresh review
      // resolves it normally; consulting credentials or refreshing providers just to replay a cache is unnecessary.
      const specialists = [owner?.agent?.review, owner?.agent?.security]
      // Configured instruction files and URLs can change independently of a reviewed commit.
      if (
        (model || (locked && config.guardrail !== "strict")) &&
        (options.context || !owner?.instructions?.length) &&
        !specialists.some((agent) => Object.keys(agent?.options ?? {}).length > 0)
      ) {
        const agents = specialists.map(
          (agent) =>
            agent && [
              agent.model,
              agent.variant,
              agent.prompt,
              agent.steps,
              agent.temperature,
              agent.top_p,
              agent.tools,
              agent.permission,
            ],
        )
        // The actual reviewer loads local instruction sources and repository rules independently of the
        // committed diff. The read-only projection observes their current authority and never fetches a URL.
        const instruction = Option.getOrUndefined(yield * Effect.serviceOption(Instruction.Service))
        const brain = Option.getOrUndefined(yield * Effect.serviceOption(Brain.Service))
        const projectMemory = brain?.previewReviewContext
        const context = options.context
          ? { settingsRef: options.context.settingsRef } // Pinned reviewer sessions take instruction text from the admitted prompt.
          : instruction && projectMemory
            ? yield *
              Effect.gen(function* () {
                const place = yield* instruction.place()
                const instructions = yield* instruction.contents()
                // An empty habit selection projects rules and instruction mirrors without selecting task memories.
                const memory = yield* projectMemory(place, {
                  personal: true,
                  kinds: [],
                  query: "",
                  files: [],
                  wrap: (lines) => lines.join("\n"),
                })
                // A mirror waiting to be synchronized has no current comparable projection.
                if (memory) return { instructions, memory, place }
              }).pipe(
                Effect.catchCauseIf(
                  (cause) => !Cause.hasInterrupts(cause),
                  () => Effect.succeed(undefined),
                ),
              )
            : undefined
        const applied = [
          REVIEW_PIPELINE_SOURCES,
          context,
          policyDigest(config),
          config,
          rulesText,
          attributesText,
          model,
          agents,
          owner?.permission,
          options.checks === true,
        ]
        // Keep only the digest; prompts, review rules and attribute patterns can be private.
        if (context) contextPolicy = createHash("sha256").update(JSON.stringify(applied)).digest("hex")
      }
    }
    // A strict cache can be reused before resolving a model. The batch plan below also binds its resolved routes.
    const strictPolicy = config.guardrail === "strict" ? contextPolicy : undefined
    const record =
      statePath && (!branchCache || branchCache.fingerprint)
        ? yield* readLocalState(
            statePath,
            !options.full || !!strictPolicy,
            config.verifyEvidence,
            locked,
            branchCache ? (bytes) => branchFingerprint(bytes) === branchCache.fingerprint : undefined,
          )
        : undefined
    // Retain the literal stored text for the atomic retry check. Older review state can have raw finding
    // titles that local carry/fixed reconciliation reintroduces after the engine returns.
    const stored =
      record && config.diagnostics === "offline"
        ? {
            ...record,
            state: redactDiagnosticData(record.state),
            ...(record.outcome ? { outcome: redactDiagnosticData(record.outcome) } : {}),
          }
        : record
    const retryFull = stored?.state.retryFullAfterBudget === true
    // A strict result certifies one immutable pair and one policy. Even an unchanged patch on a new
    // commit must get its own strict result. Preserve the previous findings and spend when requesting that full run.
    const retryStrict =
      stored &&
      (config.guardrail === "strict"
        ? !strictPolicy ||
          stored.strictPolicy !== strictPolicy ||
          stored.state.head !== current ||
          stored.state.failed ||
          stored.state.unreviewed.length > 0 ||
          !stored.outcome ||
          stored.outcome.base !== stored.state.base ||
          !base ||
          stored.state.base !== (yield* mergeBaseOf(git, root, base, current, "HEAD"))
        : stored.strict)
    // Trusted instructions and their clipped, path-specific blocks are gathered after target resolution.
    // Recheck all findings when entering or leaving this policy, including an unchanged branch.
    const recheckRules = config.ruleCheck === "strict" || stored?.checkedRules === true
    const diagnosticsHost =
      config.diagnostics === "offline" ? (process.platform === "linux" ? "linux" : "unsupported") : undefined
    const fullRetry = retryFull || retryStrict === true || recheckRules || stored?.diagnosticsHost !== diagnosticsHost || (!localInversion && !!stored?.inversionKey)
    const saved = !options.full || fullRetry || batchKey ? stored?.state : undefined
    // Full review still starts with no prior findings, but cannot reset this target's accumulated spend.
    const accounting = saved ?? (stored?.batchAccounting ? { ...emptyState(), ...accountingOf(stored.state) } : undefined)
    if (locked?.text !== undefined && !stored)
      return yield* new LocalReviewError({
        message: "The existing local review checkpoint is unreadable. No batch ran.",
      })
    const stateOptions = { strictPolicy, checkedRules: config.ruleCheck === "strict", diagnosticsHost, locked } as const
    const range: Range =
      options.pr !== undefined
        ? yield* pullRange(git, root, options.pr, base!)
        : worktree
          ? yield* worktreeRange(git, root, { kind: worktree, head: current, branch, base })
          : yield* branchRange(git, root, {
              head: current,
              branch,
              base: base!,
              saved,
              config,
              ignored,
              full: options.full || fullRetry || batchKey || localInversion,
            })
    const target = range.target
    const open = (saved?.findings ?? []).filter((finding) => finding.status === "open")
    const failOn = options.failOn ?? (config.failOn === "blocking" ? "blocking" : "never")

    const early = (note: string, left: SummaryFinding[] = [], policySkip = false) =>
      Effect.gen(function* () {
        if (policySkip && output.failClosedPR)
          output.skipVerdict = countAtOrAbove(left, "blocking")
            ? "blocking"
            : reviewVerdict({ kind: "skip", reason: "nothing-to-review" }).verdict
        if (options.json) yield* printJson({ version: 1, target, outcome: null, note })
        else yield* print(note + "\n")
        return { exitCode: countAtOrAbove(left, failOn) ? 1 : 0, target } satisfies LocalReviewResult
      })
    // A review the route rules stopped (VS-23b), or one holdback left nothing to send (VS-34), reviewed nothing (I-7):
    // it is shown as not reviewed, never as clean, and fails as a review that could not run does, so a --fail-on hook
    // cannot pass the change. As that failure does, it leaves the "since last review" state alone, so the next run
    // reviews the change again. Nothing is applied or posted.
    const notReviewed = (
      outcome: ReviewOutcome,
      error = 'Vector did not review this change: privacy is "zdr", and a model this review would use has no zero data retention route Vector may use.',
    ) =>
      Effect.gen(function* () {
        if (options.json) yield* printJson({ version: 1, target, outcome: reviewForOutput(outcome) })
        else if (outcome.partial === "budget-estimate") {
          const count = outcome.unreviewed.length
          yield* print(`${error} ${count} changed ${count === 1 ? "file remains" : "files remain"} unreviewed.\n`)
        } else
          yield* print(
            renderLocalReview({
              target,
              outcome,
              limits: {
                maxCostUsd: config.maxCostUsd,
                maxSteps: config.maxSteps,
                timeoutMinutes: config.timeoutMinutes,
              },
              color: deps.color,
            }),
          )
        return { exitCode: 2, error, target, outcome } satisfies LocalReviewResult
      })

    if (!range.files.length) {
      if (target.kind === "branch" && (yield* dirty(git, root, true)))
        say("Add --uncommitted to review the changes you have not committed.")
      return yield* early(range.nothing, open, true)
    }
    // As CI skips a commit it already reviewed; --fail-on still sees what that review left open. The last review of
    // this commit is printed again, so a script, or someone who lost the first output, still gets its findings.
    const cacheable =
      !batchKey && !options.full && !fullRetry && saved?.head === range.head && !saved.unreviewed.length && !saved.failed
    const cached = Effect.gen(function* () {
      const note = `Nothing new to review: ${short(range.head)} was already reviewed.${stillOpen(open)} Run \`vector review --full\` to review it again.`
      if (options.apply)
        say(
          "Nothing was applied: --apply uses only findings from a review this run makes. Run `vector review --apply --full` to review it again.",
        )
      const last = stored?.outcome?.head === range.head ? stored.outcome : undefined
      if (!last) return yield* early(note, open)
      if (options.json) yield* printJson({ version: 1, target, outcome: reviewForOutput(last), cached: true })
      else
        yield* print(
          `${note}\n\n(from the last review of ${short(range.head)})\n` +
            renderLocalReview({
              target,
              outcome: last,
              limits: {
                maxCostUsd: config.maxCostUsd,
                maxSteps: config.maxSteps,
                timeoutMinutes: config.timeoutMinutes,
              },
              color: deps.color,
            }),
        )
      return { exitCode: countAtOrAbove(open, failOn) ? 1 : 0, target, outcome: last } satisfies LocalReviewResult
    })
    if (cacheable && !localInversion) return yield* cached

    // Earlier findings follow the lines through what changed since the last review.
    const priorHead = range.since ?? (fullRetry || localInversion ? saved?.head : undefined)
    const changes =
      saved && priorHead && priorHead !== range.head
        ? yield* ReviewSource.prDiff({ directory: root, mergeBase: priorHead, head: range.head }).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          )
        : undefined
    const settle = (entry: PriorFinding, modelStatus?: { status: "fixed" | "open"; reason: string }) =>
      classifyPrior(entry, {
        head: range.head,
        ...(changes ? { changes } : {}),
        ...(modelStatus ? { modelStatus } : {}),
        isWriter: () => true,
        prAuthor: "",
      })
    const prior = saved ? priorFromState(saved, changes).map((entry) => settle(entry)) : []

    if (range.mode === "carry") {
      yield* writeLocalState(
        stored,
        now(),
        statePath,
        nextState(accounting, { head: range.head, base: range.mergeBase, mode: "carry", now: now(), prior }),
        say,
        stateOptions,
      )
      return yield* early(
        `Nothing new to review: rebased onto ${target.baseRef} with no change to this branch's own diff.${stillOpen(open)}`,
        open,
      )
    }

    // 4. What to review: path rules first, then generated-file headers, which count only when the base agrees.
    const withheld = range.files.filter(
      (file) => denied(file.path) || (file.oldPath !== undefined && denied(file.oldPath)),
    )
    const classified = classifyFiles(
      range.files.filter((file) => !withheld.includes(file)),
      { config, attributes },
    )
    const readHead = (file: string) =>
      range.worktree === "uncommitted"
        ? readWorkingFile(root, file)
        : readBlob(git, root, range.worktree === "staged" ? "" : range.head, file)
    const headers = yield* generatedHeaders({
      files: classified.review,
      readHead,
      readBase: (file) => readBlob(git, root, range.mergeBase, file),
      attributes,
      config,
    })
    const review = headers.review
    const skipped: SkippedFile[] = [...classified.skipped, ...headers.skipped]
    if (!review.length && withheld.length)
      return yield* new LocalReviewError({
        message: "The changed files are outside this conversation's read access; no review ran.",
      })
    if (!review.length) return yield* early(noteNothingToReview(), open, true)

    yield* ReviewGit.preflight

    // 5. The model, and what running tests on this branch would mean.
    // Under "modelEvidence": "warn" (VS-07) a retired model is refused as retired. Under privacy "zdr" (VS-23b) each
    // model needs a route the rules allow, and a refused one stops the review here, before anything is gathered or sent.
    const evidence = config.modelEvidence === "warn" ? { evidence: true } : {}
    // Authorship is local, owner-opted-in and limited to a complete committed change the caller may read.
    // Uncommitted inputs and a partial read scope cannot be bound to the stored assistant's snapshots.
    const attribution =
      localInversion && !range.worktree && !withheld.length && review.length === range.files.length
        ? yield* ReviewAuthor.lookup({
            directory: root,
            base: range.mergeBase,
            head: range.head,
            paths: [...new Set(review.flatMap((file) => (file.oldPath ? [file.path, file.oldPath] : [file.path])))],
            parent: options.context?.parentID,
            branch,
            body: pull?.body,
          })
        : undefined
    // The same commit can acquire a conflicting snapshot or a fence. Recheck its proof before replaying
    // the saved result; the cache holds only a digest, never the assistant's session or snapshot IDs.
    const activeSettings =
      localInversion && !options.context?.identity && Option.isSome(settings)
        ? yield* settings.value.get()
        : ownerSettings
    const activeAgent = activeSettings?.agent?.[options.context?.identity ?? "review"]
    const inversionKey = localInversion
      ? createHash("sha256")
          .update(
            JSON.stringify([
              range.mergeBase,
              attribution && "proof" in attribution ? ReviewAuthor.trustedLab(attribution.proof) : undefined,
              global?.alternateModel,
              ownerSettings?.model,
              options.context?.identity ?? "review",
              ownerSettings?.agent?.[options.context?.identity ?? "review"]?.model,
              ownerSettings?.agent?.[options.context?.identity ?? "review"]?.variant,
              activeAgent?.model,
              activeAgent?.variant,
              activeSettings?.model,
              options.model,
              config.model,
              config.privacy,
              config.zdrAttested,
            ]),
          )
          .digest("hex")
      : undefined
    const authorChanged = localInversion && !!stored && stored.inversionKey !== inversionKey
    if (localInversion && cacheable && !authorChanged) return yield* cached
    const writeOptions = { ...stateOptions, inversionKey }
    const batchState =
      locked && contextPolicy
        ? localBatchStore(
            stored?.state,
            stored?.batch,
            // A service's grants and its execution identity must travel together across invocations.
            JSON.stringify([
              stateName,
              root,
              options.context?.identity,
              options.context?.readRoot,
              options.context?.settingsRef,
              contextPolicy,
              authority?.patterns,
              ...(diagnosticsHost ? [diagnosticsHost] : []),
              ...(inversionKey ? [inversionKey] : []),
            ]),
            !fullRetry && !authorChanged && !!stored?.outcome,
            (pending, metadata) =>
              writeLocalState(stored, now(), statePath, pending, say, { ...writeOptions, outcome: stored?.outcome, batch: metadata }),
            { now, carriedMonth: stored?.batchUncertainMonth, knownMonthLedger: stored?.batchAccounting },
          )
        : undefined
    let route = ReviewRoutes.policyOf(config)
    let routed = route.privacy === "zdr" ? { route } : {}
    const resolved = yield* Effect.gen(function* () {
      const model = yield* deps.resolveModel({
        trigger: "local",
        flag: options.model,
        ...(attribution && "proof" in attribution && attribution.proof ? { author: attribution.proof, route } : {}),
        config: config.model,
        env,
        ...evidence,
        ...routed,
        ...(options.context?.identity ? { identity: options.context.identity } : {}),
      })
      if (model.inversion) {
        config = { ...config, privacy: model.inversion.privacy }
        route = ReviewRoutes.policyOf(config)
        routed = { route }
      }
      // review.json's cheaper first pass; the double-check stays on `model`.
      const triage = config.triageModel
        ? yield* deps.resolveModel({
            trigger: "local",
            exact: config.triageModel,
            env,
            ...evidence,
            ...routed,
            ...(options.context?.identity ? { identity: options.context.identity } : {}),
          })
        : undefined
      // The panel's judge (WP A35); on Vector Codium the runner uses the plan's panel judge when judgeModel is unset.
      const judge =
        config.panel && config.judgeModel
          ? yield* deps.resolveModel({
              trigger: "local",
              exact: config.judgeModel,
              env,
              ...evidence,
              ...routed,
              ...(options.context?.identity ? { identity: options.context.identity } : {}),
            })
          : undefined
      return { model, triage, judge }
    }).pipe(
      Effect.catchTag("ReviewModelError", (error) =>
        error.refusal
          ? Effect.succeed({ refused: { model: error.model ?? "the review model", refusal: error.refusal } })
          : Effect.fail(error),
      ),
    )
    if ("refused" in resolved) {
      const refusal: ReviewOutcome = {
        report: { summary: "", risk: "low", files: [], findings: [] },
        selection: {
          inline: [],
          outsideDiff: [],
          elsewhere: [],
          nits: [],
          overflow: [],
          stillOpen: [],
          fixed: [],
          dismissed: [],
          reappeared: [],
          raised: [],
          dropped: [],
          risk: "low",
        },
        skipped,
        durationMs: 0,
        base: range.mergeBase,
        head: range.head,
        ...(range.since ? { since: range.since } : {}),
        mode: range.mode === "incremental" ? "incremental" : "full",
        partial: "privacy",
        unreviewed: [...new Set([...review, ...withheld].map((file) => file.path))],
        specialists: [],
        sessions: [],
        stats: {
          files: review.length,
          additions: review.reduce((sum, file) => sum + file.additions, 0),
          deletions: review.reduce((sum, file) => sum + file.deletions, 0),
        },
        notes: [notePrivacyRefused({ ...resolved.refused, attempts: 0 })],
      }
      return yield* notReviewed(config.guardrail === "strict" ? incompleteStrictCoverage(refusal) : refusal)
    }
    const model = resolved.model
    const modelName = `${model.providerID}/${model.modelID}`
    if (options.checks) {
      const start = target.kind === "branch" ? range.mergeBase : yield* branchStart(git, root, range.head, base)
      const others = start ? yield* otherAuthors(git, root, start, range.head) : 0
      if (others > 0 && !options.yes) {
        const question = `This branch has commits by ${others} other ${others === 1 ? "person" : "people"}, and --checks runs their code. Continue? (y/N)`
        if (!(yield* Effect.promise(() => deps.confirm(question))))
          return yield* new LocalReviewError({
            message: "Stopped before running other people's code. Add --yes to run --checks anyway.",
          })
      }
    }
    if (Billing.isCodium(model.providerID)) say("Runs on your Vector Codium plan.")
    if (review.length > ESTIMATE_FILES && model.price) {
      const chars = Math.min(renderPatch(review).length, diffBudgetChars(model.context, config.maxDiffChars))
      const estimate = estimateCostUsd({
        promptTokens: Math.ceil(chars / 3.5) + PROMPT_OVERHEAD_TOKENS,
        maxSteps: config.maxSteps,
        price: model.price,
      })
      const cap = config.maxCostUsd > 0 ? `; this review stops at ${formatUsd(config.maxCostUsd)}` : ""
      say(
        `${review.length} files to review: with ${modelName} that costs about ${formatUsd(estimate.low)}–${formatUsd(estimate.high)}${cap}.`,
      )
    }
    if (target.kind === "branch" && (yield* dirty(git, root, false)))
      say(
        "Uncommitted changes are not part of this review, but the reviewer reads your working tree; add --uncommitted to include them.",
      )

    // 6. Context Vector gathers itself: callers of changed symbols, history and blame, and for a pull request its files.
    const context = yield* ReviewContext.gather({
      directory: root,
      base: range.mergeBase,
      head: range.head,
      files: review,
      ignore: [...(config.ignoreDefaults ? DEFAULT_IGNORES.map((rule) => rule.glob) : []), ...config.ignore],
      ignored,
      ...((options.context || checkRules) && ruleSourceAvailable ? { instructions: ruleFile } : {}),
    })
    // The specs the change touches, with drift flags, so the reviewer can tell when it breaks one.
    const selectedCards = cardProvider
      ? yield* cardProvider({
          directory: root,
          base: range.mergeBase,
          head: range.head,
          files: review,
          denied: ignored,
          shared: !!options.post || options.pr !== undefined,
          trust,
          config,
          models: [model, ...(resolved.triage ? [resolved.triage] : []), ...(resolved.judge ? [resolved.judge] : [])],
          // Codium/panel fallbacks may introduce another checker; unknown destinations get no private text.
          onPrivateUnavailable: () =>
            say(
              "Personal Brain cards were left out because private storage or an enforceable model privacy route was unavailable.",
            ),
          mayUsePrivate:
            !Billing.isCodium(model.providerID) &&
            (!config.panel || !!resolved.judge) &&
            !options.checks &&
            !options.apply,
          deadline: performance.now() + Math.min(4_000, config.timeoutMinutes * 60_000),
        })
      : undefined
    const requirements =
      !cardProvider && deps.requirements
        ? yield* deps.requirements({ files: review.map((file) => file.path), model, shared: options.post === true })
        : undefined
    const headFiles =
      trust === "untrusted"
        ? yield* ReviewSource.headFiles({
            directory: root,
            mergeBase: range.mergeBase,
            head: range.head,
            files: review,
          })
        : undefined
    const known = range.worktree
      ? (file: string) => Promise.resolve(inTree(root, file))
      : yield* ReviewSource.knownPath({ directory: root, rev: range.head })
    const knownPath = options.context ? (file: string) => (denied(file) ? Promise.resolve(false) : known(file)) : known
    const commits = yield* subjects(git, root, range.mergeBase, range.head)
    const pr: PromptInput["pr"] | undefined =
      options.pr !== undefined
        ? {
            number: options.pr,
            title: pull?.title ?? `Pull request #${options.pr}`,
            body: pull?.body ?? "",
            ...(pull?.author ? { author: pull.author } : {}),
            ...(commits.length ? { commits } : {}),
          }
        : branch && commits.length
          ? { title: branch, body: "", commits }
          : undefined

    // VS-34 item 4: under holdback "secrets", which changed files the repository's ignore rules exclude although they
    // are committed, read before the last preflight so the bound view's read is checked like the others.
    const ignoredPaths =
      config.holdback === "secrets" || config.diagnostics === "offline"
        ? yield* ReviewGit.ignoredPaths(
            root,
            review.filter((file) => file.status !== "deleted").map((file) => file.path),
          )
        : undefined

    // Only a complete, trusted commit comparison can authorize the zero-token policy. Staged changes and
    // working files have no immutable head blob for their edits. A service cache reset is not a user --full.
    const forceFull = (options.full === true || fullRetry) && !options.context
    const trivialProof =
      config.trivial === "skip" &&
      !forceFull &&
      target.kind === "branch" &&
      trust === "trusted" &&
      !authority?.patterns.length &&
      !readDenies?.length &&
      !skipped.length &&
      !withheld.length &&
      !saved?.unreviewed?.length &&
      prior.filter((finding) => finding.status === "open").length === open.length &&
      Option.isSome(settings)
        ? yield* settings.value.get().pipe(
            Effect.flatMap((effective) =>
              ReviewTrivial.prove({
                directory: root,
                base: range.mergeBase,
                head: range.head,
                files: range.files,
                config,
                instructions: effective.instructions ?? [],
                denied: ignored,
              }),
            ),
            Effect.catchDefect(() => Effect.succeed(undefined)),
          )
        : undefined

    // 7. The review.
    if (options.context?.stopSignal?.aborted)
      return yield* new LocalReviewError({ message: "The review was cancelled before it started." })
    if (options.context && (yield* commitOf(git, root, "HEAD")) !== options.context.expectedHead)
      return yield* new LocalReviewError({ message: "The review head changed before the review could start." })
    yield* ReviewGit.preflight
    if (!trivialProof) {
      const action = (config.maxInputTokens ?? 0) > 0 ? "Checking the review budget for" : "Reviewing"
      say(`${action} ${review.length} ${review.length === 1 ? "file" : "files"} with ${modelName}…`)
    }
    const request = deps.runReview({
      directory: root,
      ...(options.context?.parentID ? { parentID: options.context.parentID } : {}),
      ...(options.context?.stopSignal ? { stopSignal: options.context.stopSignal } : {}),
      ...(options.context?.readDenies ? { readDenies: options.context.readDenies } : {}),
      ...(options.context?.readRoot ? { readRoot: options.context.readRoot } : {}),
      ...(authority ? { admittedReads: authority } : {}),
      ...(options.context ? { instructionsFromContext: true } : {}),
      ...(options.context?.identity ? { identity: options.context.identity } : {}),
      trigger: "local",
      trust,
      ...((config.impact === "graph" || config.guardrail === "strict" || config.depth === "auto" || batchKey) && range.worktree
        ? { uncommittedDiff: true as const }
        : {}),
      ...((config.trivial === "skip" && forceFull) || (batchKey && options.full) ? { forceFull: true } : {}),
      ...(batchKey
        ? { restartBatch: options.full === true || authorChanged || (!localInversion && !!stored?.inversionKey) || (!!stored && stored.diagnosticsHost !== diagnosticsHost) }
        : {}),
      ...(batchState ? { batchStore: batchState.store } : {}),
      ...(stored?.batchAccounting ? { accountBatchSpend: true as const } : {}),
      ...(batchState?.continues(range.head) ? { continuingBatch: true } : {}),
      ...(batchState
        ? {
            spent: {
              prUsd: saved?.costUsd ?? 0,
              monthUsd: saved?.month?.key === new Date(now()).toISOString().slice(0, 7) ? saved.month.costUsd : 0,
            },
          }
        : {}),
      ...(trivialProof ? { trivialProof } : {}),
      base: range.mergeBase,
      head: range.head,
      ...(range.since ? { since: range.since } : {}),
      mode: range.mode === "incremental" ? "incremental" : "full",
      files: review,
      anchors: range.files,
      ...(range.focus ? { focus: range.focus } : {}),
      skipped,
      ...(headFiles ? { headFiles } : {}),
      context: { ...context, ...(requirements ? { requirements } : {}) },
      ...(selectedCards ? { selectedCards } : {}),
      ...(pr ? { pr } : {}),
      prior,
      ...(ruleSourceAvailable
        ? rulePromptInput(
            rules,
            review.map((file) => file.path),
            ruleConfig,
          )
        : { rules: "", ruleParts: [] }),
      config,
      model,
      ...(resolved.triage ? { triage: resolved.triage } : {}),
      ...(resolved.judge ? { judge: resolved.judge } : {}),
      ...(options.checks ? { checks: true } : {}),
      knownPath,
      onProgress: (event) => {
        if (event.type === "specialist") say(`  ${event.name}: ${event.status}`)
      },
      baseRef: target.baseRef,
      rulesSource: options.context || trust !== "trusted" ? "base branch" : "working tree",
      ...(ignoredPaths ? { ignored: ignoredPaths } : {}),
    })
    const run = yield* Effect.provideService(request, ReviewMcpSnapshot.Trusted, snapshot)
    const authorNote =
      model.inversion?.note ??
      (localInversion && (!attribution || !("proof" in attribution) || !attribution.proof)
        ? "VectorScope kept the configured reviewer. No eligible local assistant snapshots established authorship of this change."
        : undefined)
    const result = localInversion
      ? {
          ...run,
          ...(attribution?.claimedAuthor.length ? { claimedAuthor: attribution.claimedAuthor } : {}),
          ...(authorNote ? { notes: [...run.notes, authorNote] } : {}),
        }
      : run
    const visible = withheld.length
      ? {
          ...result,
          unreviewed: [...new Set([...result.unreviewed, ...withheld.map((file) => file.path)])],
          notes: [...result.notes, "Some changed files were not reviewed because this conversation cannot read them."],
        }
      : result
    const reviewed = withheld.length && config.guardrail === "strict" ? incompleteStrictCoverage(visible) : visible
    if (
      batchState?.alreadyComplete &&
      !authorChanged &&
      !fullRetry &&
      !options.full &&
      stored?.outcome &&
      stored.outcome.head === range.head &&
      !withheld.length
    ) {
      if (options.json) yield* printJson({ version: 1, target, outcome: reviewForOutput(stored.outcome), cached: true })
      else
        yield* print(
          renderLocalReview({
            target,
            outcome: stored.outcome,
            color: deps.color,
            limits: { maxCostUsd: config.maxCostUsd, maxSteps: config.maxSteps, timeoutMinutes: config.timeoutMinutes },
          }),
        )
      return {
        exitCode: failingFindings(stored.outcome.selection, failOn) ? 1 : 0,
        target,
        outcome: stored.outcome,
      } satisfies LocalReviewResult
    }
    // A charged failure, an incomplete verification and a successful batch all use the usual
    // cost/finding record. Only a complete current batch advances the physical cursor.
    const stateVerdict = (outcome: ReviewOutcome): NextStateInput["verdict"] =>
      output.failClosedPR
        ? { failOn: "blocking-or-incomplete", result: reviewVerdict({ kind: "outcome", outcome }).verdict }
        : undefined
    const persistStoppedBatch = () =>
      Effect.gen(function* () {
        if (!batchState?.recorded || !locked) return
        const progress = batchState.coverage(
          nextState(accounting, {
            head: range.head,
            base: range.mergeBase,
            mode: reviewed.mode,
            now: now(),
            failed: true,
            unreviewed: reviewed.unreviewed,
            prior,
            verdict: stateVerdict(reviewed),
            ...(reviewed.cost ? { cost: reviewed.cost } : {}),
          }),
        )
        if (progress)
          yield* writeLocalState(stored, now(), statePath, progress, say, {
            ...writeOptions,
            outcome: reviewed,
            batch: batchState.metadata,
          })
      })
    if (reviewed.trivial) {
      const open = reviewed.selection.stillOpen
      if (options.json) yield* printJson({ version: 1, target, outcome: reviewForOutput(reviewed) })
      else yield* print(noteTrivialSkip() + stillOpen(open) + "\n")
      return { exitCode: countAtOrAbove(open, failOn) ? 1 : 0, target, outcome: reviewed } satisfies LocalReviewResult
    }
    if (reviewed.partial === "privacy") {
      yield* persistStoppedBatch()
      return yield* notReviewed(reviewed)
    }
    if (reviewed.partial === "budget-estimate") {
      yield* persistStoppedBatch()
      // A forced full run can refuse a head an earlier review completed. Retain that result and its spend, but
      // retry the whole branch on the next invocation even if its head or token cap changes in the meantime.
      if (options.full && stored && !retryFull && !batchState?.recorded)
        yield* writeLocalState(stored, now(), statePath, { ...stored.state, retryFullAfterBudget: true }, say, {
          ...writeOptions,
          unchangedRecord: stored.text,
        })
      return yield* notReviewed(reviewed, noteBudgetEstimate(reviewed.notes))
    }
    // Under holdback "secrets" a change whose every file, or in an incremental review every new hunk, was held back
    // from the model runs no pass (Review.run): no reviewer failed, but nothing was reviewed either.
    if (!reviewed.specialists.length && reviewed.held?.length)
      return yield* notReviewed(
        reviewed,
        `Vector did not review this change: ${reviewed.mode === "incremental" ? "everything new since the last review is in files" : "every changed file was"} held back from the model (holdback "secrets").`,
      )
    const batchStop =
      batchKey &&
      reviewed.selection.diffIncomplete &&
      !reviewed.specialists.length &&
      reviewed.notes.find((note) => note.startsWith("Not reviewed.") || note.startsWith("Partial batch coverage:"))
    if (batchStop) {
      yield* persistStoppedBatch()
      return yield* notReviewed(reviewed, batchStop)
    }
    const reviewers = reviewed.specialists.filter((entry) => entry.name !== "verify" && entry.name !== "judge")
    if (!reviewers.some((entry) => entry.status !== "failed")) {
      yield* persistStoppedBatch()
      const detail = (reviewers.find((entry) => entry.detail)?.detail ?? "the model returned no report").replace(
        /[.\s]+$/,
        "",
      )
      const visible = reviewForOutput(reviewed)
      if (options.json) yield* printJson({ version: 1, target, outcome: visible })
      const spent =
        visible.cost && !("input" in visible.cost)
          ? `Used before it stopped: ${"costUsd" in visible.cost && visible.cost.costUsd > 0 ? `${formatUsd(visible.cost.costUsd)} + ` : ""}Codium.`
          : reviewed.cost
            ? failedSpend(reviewed.cost)
            : undefined
      return {
        exitCode: 2,
        // The reviewers' sessions are hidden, so this is where what they spent before failing shows.
        error: `Vector could not finish this review: ${detail}${spent ? `. ${spent}` : ""}`,
        target,
        outcome: reviewed,
      } satisfies LocalReviewResult
    }

    // 8. Earlier findings the model says are fixed count as fixed when the code near them changed.
    const reported = new Map((reviewed.report.priorStatus ?? []).map((entry) => [entry.id, entry]))
    const settled = prior.map((entry) =>
      entry.status === "open" && reported.has(entry.id) ? settle(entry, reported.get(entry.id)) : entry,
    )
    const fixed = settled.filter((entry, index) => entry.status === "fixed" && prior[index]?.status === "open")
    const fixedIds = new Set(fixed.map((entry) => entry.id))
    const selection: Selection = {
      ...reviewed.selection,
      stillOpen: reviewed.selection.stillOpen.filter((entry) => !fixedIds.has(entry.id)),
      fixed: [...reviewed.selection.fixed, ...fixed],
    }
    const completed: ReviewOutcome = { ...reviewed, selection, notes: [...reviewed.notes, ...headers.notes] }
    const outcome = config.diagnostics === "offline" ? redactDiagnosticData(completed) : completed

    // Locally every finding is listed rather than commented, so the ones GitHub would carry inline are kept too.
    const next = nextState(accounting, {
      head: range.head,
      base: range.mergeBase,
      mode: outcome.mode,
      now: now(),
      unreviewed: outcome.unreviewed,
      ...(outcome.cost ? { cost: outcome.cost } : {}),
      prior: settled,
      selection,
      verdict: stateVerdict(outcome),
      moved: selection.inline,
    })
    if (retryFull && unfinishedCauses(outcome).length) next.retryFullAfterBudget = true
    const progress = batchState?.coverage(next)
    yield* writeLocalState(stored, now(), statePath, progress ?? next, say, {
      ...writeOptions,
      outcome,
      batch: batchState?.metadata,
      written: branchCache ? (bytes) => branchCache.written(branchFingerprint(bytes)) : undefined,
    })

    if (options.json) yield* printJson({ version: 1, target, outcome: reviewForOutput(outcome) })
    else
      yield* print(
        renderLocalReview({
          target,
          outcome,
          limits: { maxCostUsd: config.maxCostUsd, maxSteps: config.maxSteps, timeoutMinutes: config.timeoutMinutes },
          ...(saved?.head ? { since: saved.head } : {}),
          resumable: statePath !== undefined,
          color: deps.color,
        }),
      )
    if (options.apply && deps.fix) yield* deps.fix.run({ git, root, target, outcome, holdback: config.holdback, say, now })
    if (options.post && options.pr !== undefined && range.remote)
      yield* postToPull({
        git,
        root,
        pr: options.pr,
        remote: range.remote,
        target,
        outcome,
        config,
        files: review,
        yes: options.yes,
        confirm: deps.confirm,
        access: deps.github ?? GITHUB,
        env,
        say,
        posting: deps.posting,
        trust,
      })
    return {
      exitCode: failingFindings(selection, failOn)
        ? 1
        : batchState?.recorded && outcome.selection.diffIncomplete
          ? 2
          : 0,
      target,
      outcome,
    } satisfies LocalReviewResult
  }).pipe(
    Effect.catch((error) => Effect.succeed<LocalReviewResult>({ exitCode: 2, error: error.message })),
    Effect.scoped,
    Effect.withSpan("Cli.review.execute"),
  )
}

// Findings at or above the --fail-on severity: every new one wherever it is listed, and earlier ones still open.
export function failingFindings(selection: Selection, failOn: FailOn): number {
  return countAtOrAbove(
    [
      ...selection.inline,
      ...selection.overflow,
      ...selection.outsideDiff,
      ...selection.elsewhere,
      ...selection.nits,
      ...selection.stillOpen,
    ],
    failOn,
  )
}

function countAtOrAbove(findings: { severity: Severity }[], failOn: FailOn): number {
  if (failOn === "never") return 0
  return findings.filter(
    (finding) => finding.severity === "blocking" || (failOn === "concern" && finding.severity === "concern"),
  ).length
}

// --post: a one-off review posted as you. CI never reads it back, since CI trusts only its own bot's comments, and the
// summary carries no summary marker. One review holds the inline comments; a comment GitHub refuses to attach is
// listed in the summary instead.
const postToPull = Effect.fnUntraced(function* (input: {
  git: ReviewGit.Client
  root: string
  pr: number
  remote: string
  target: LocalTarget
  outcome: ReviewOutcome
  config: ReviewConfig
  files: DiffFile[]
  yes?: boolean
  confirm: (question: string) => Promise<boolean>
  access: GitHubAccess
  env: Record<string, string | undefined>
  say: (text: string) => void
  posting: LocalReviewDeps["posting"]
  trust: Trust
}) {
  // The configured URL, before any insteadOf rewriting, is what names the repository.
  const url = (yield* input.git.run(["config", "--get", `remote.${input.remote}.url`], { cwd: input.root }))
    .text()
    .trim()
  const where = parseGitHubRemote(url)
  if (!where)
    return yield* new LocalReviewError({
      message: `--post needs a GitHub remote, and ${input.remote} is ${url || "not set"}.`,
    })
  const slug = `${where.owner}/${where.repo}#${input.pr}`
  const baseUrl = where.host === "github.com" ? undefined : `https://${where.host}/api/v3`
  const token = yield* Effect.promise(() => input.access.token(where.host, input.env))
  if (!token)
    return yield* new LocalReviewError({
      message: "--post needs a GitHub token: set GITHUB_TOKEN or sign in with `gh auth login`.",
    })
  const login = yield* Effect.promise(() => input.access.login(token, baseUrl))
  const secrets = [...collectSecretValues(input.env), token]
  const clean = (text: string) => {
    const value = redactSecrets(text, secrets)
    return input.config.diagnostics === "offline" ? redactDiagnosticData(value) : value
  }
  const repo = { owner: where.owner, repo: where.repo }
  const head = input.target.head
  // Remove unsafe edits before building suggestion fences. Redacting a fence's contents would leave it committable.
  const inline =
    input.config.holdback === "secrets" || input.config.diagnostics === "offline"
      ? input.outcome.selection.inline.map((finding) =>
          finding.suggestion !== undefined && holdbackText(clean(finding.suggestion)).includes(REDACTED)
            ? { ...finding, suggestion: undefined, suggestionAllowed: false }
            : finding,
        )
      : input.outcome.selection.inline
  const verdict = reviewVerdict({ kind: "outcome", outcome: input.outcome }).verdict
  const plan = postingPlan(verdict, inline.length, { failOn: input.config.failOn })
  const draft = buildCreateReviewPayload({
    head,
    inline,
    body: buildReviewBody({ head, run: nonce(), inline }),
    suggestions: input.config.suggestions,
    trust: "untrusted",
    repo,
  })
  const payload: CreateReviewPayload = {
    ...draft,
    body: clean(draft.body),
    comments: draft.comments.map((comment) => ({ ...comment, body: clean(comment.body) })),
  }
  const count = payload.comments.length
  const question = `Post ${count} ${count === 1 ? "comment" : "comments"} and a summary to ${slug} as ${login ? `@${login}` : "you"}? (y/N)`
  if (
    !input.yes &&
    !(yield* Effect.promise(() => input.confirm(input.config.diagnostics === "offline" ? clean(question) : question)))
  ) {
    input.say("Nothing was posted.")
    return
  }

  const failed = (error: unknown) =>
    new LocalReviewError({
      message: `Could not post to ${slug}: ${error instanceof Error ? error.message : String(error)}`,
    })
  const gh = yield* Effect.tryPromise({
    try: () =>
      input.access.create({
        token,
        owner: where.owner,
        repo: where.repo,
        botLogin: login ?? "",
        ...(baseUrl ? { baseUrl } : {}),
        check: (parts: readonly string[], pull: { readonly untrusted: boolean }) =>
          input.posting({
            parts,
            sessionIDs: input.outcome.sessions,
            untrusted: input.trust === "untrusted" || pull.untrusted,
          }),
      }),
    catch: failed,
  })
  const moved = plan.createReview && count
    ? yield* Effect.tryPromise({ try: () => postReview(gh, input.pr, inline, payload, plan.marker), catch: failed })
    : []
  const movedIds = new Set(moved.map((finding) => finding.id))
  const selection: Selection = {
    ...input.outcome.selection,
    inline: inline.filter((finding) => !movedIds.has(finding.id)),
    outsideDiff: [
      ...input.outcome.selection.outsideDiff,
      ...moved.map((finding) => ({ ...finding, reason: "line-outside-diff" as const })),
    ],
  }
  const requestStop = firstRequestStopDetail(input.outcome)
  const summary = buildSummaryBody({
    repo,
    pr: input.pr,
    head,
    baseRef: input.target.baseRef,
    mode: input.outcome.mode,
    report: input.outcome.report,
    selection,
    ...(input.config.failOn === "blocking-or-incomplete" && verdict === "incomplete" ? { incomplete: true } : {}),
    ...(requestStop
      ? {
          incomplete: true,
          banners: [notePartial({ reason: "budget", detail: requestStop, unreviewed: input.outcome.unreviewed })],
        }
      : {}),
    files: input.files.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions })),
    skipped: input.outcome.skipped,
    notes: [...input.outcome.notes, ...(moved.length ? [noteMoved(moved.length)] : [])],
    ...(input.outcome.cost ? { cost: input.outcome.cost } : {}),
    durationMs: input.outcome.durationMs,
  })
  const body = clean(
    summary
      .split("\n")
      .filter((line) => line !== SUMMARY_MARKER)
      .join("\n"),
  )
  const comment = yield* Effect.tryPromise({ try: () => gh.createIssueComment(input.pr, body), catch: failed })
  input.say(`Posted to ${slug}: ${comment.html_url}`)
})

// On a 422 the comments are split in halves and each half is posted as its own review, so one bad anchor never drops
// the others. A single comment GitHub still refuses is returned, to be listed in the summary.
async function postReview(
  gh: Pick<ReviewGitHub, "createReview">,
  pr: number,
  findings: PlacedFinding[],
  payload: CreateReviewPayload,
  marker?: PostingPlan["marker"],
): Promise<PlacedFinding[]> {
  try {
    // A 422 can split a review into several objects. Mark every actual incomplete review, including continuations.
    await gh.createReview(pr, marker ? { ...payload, body: marker + "\n" + payload.body } : payload)
    return []
  } catch (error) {
    if (statusOf(error) !== 422) throw error
    if (findings.length <= 1) return findings
    const [first, second] = splitHalves(payload)
    const middle = Math.ceil(findings.length / 2)
    return [
      ...(await postReview(gh, pr, findings.slice(0, middle), first, marker)),
      ...(await postReview(gh, pr, findings.slice(middle), second, marker)),
    ]
  }
}

function statusOf(error: unknown) {
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined
  return typeof status === "number" ? status : undefined
}

// The host, owner and repository of git@host:owner/repo.git, ssh://git@host[:port]/owner/repo.git or
// https://host/owner/repo; undefined for anything else, such as a local path.
export function parseGitHubRemote(url: string): { host: string; owner: string; repo: string } | undefined {
  const match =
    /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    )
  if (!match) return undefined
  return { host: match[1]!.toLowerCase(), owner: match[2]!, repo: match[3]! }
}

function nonce() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8)
}

// GITHUB_TOKEN, or the GitHub CLI's token for the remote's host; the login comes from the API. Octokit is loaded only
// when something is posted.
const GITHUB: GitHubAccess = {
  token: async (host, env) => {
    const set = env.GITHUB_TOKEN?.trim()
    if (set) return set
    const result = await Process.text(["gh", "auth", "token", ...(host === "github.com" ? [] : ["--hostname", host])], {
      nothrow: true,
    }).catch(() => undefined)
    return result?.code === 0 ? result.text.trim() || undefined : undefined
  },
  login: async (token, baseUrl = "https://api.github.com") => {
    const response = await githubFetch(`${baseUrl}/user`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": `vector/${InstallationVersion}`,
      },
    }).catch(() => undefined)
    if (!response?.ok) return undefined
    const data = parseJson(await response.text().catch(() => ""))
    return typeof data?.login === "string" ? data.login : undefined
  },
  create: async (options) => (await import("./github.review-api")).createReviewGitHub(options),
}

function refuseFlags(options: LocalReviewOptions): string | undefined {
  const pr = options.pr !== undefined
  if (options.uncommitted && options.staged) return "Use --uncommitted or --staged, not both."
  if (pr && (!Number.isInteger(options.pr) || options.pr! < 1)) return "--pr needs a pull request number."
  if (pr && (options.uncommitted || options.staged))
    return "--pr reviews a pull request's commits; it cannot be combined with --uncommitted or --staged."
  if (pr && options.checks)
    return "--checks runs the code under review, so it is only allowed on your own branch, not with --pr."
  if (options.post && !pr) return "--post needs --pr <number>: only a pull request can be posted to."
  if (options.apply && pr) return "--apply fixes your own branch; it cannot be combined with --pr."
  if (options.apply && (options.uncommitted || options.staged))
    return "--apply fixes the commits of your branch; it cannot be combined with --uncommitted or --staged."
  if (options.apply && options.yes) return "--apply asks before each step, so it cannot be combined with --yes."
  return undefined
}

function withFlags(config: ReviewConfig, options: LocalReviewOptions): ReviewConfig {
  const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value)
  return {
    ...config,
    ...(options.security !== undefined ? { security: options.security ? "always" : "off" } : {}),
    ...(finite(options.maxComments) ? { maxComments: Math.min(50, Math.max(0, Math.floor(options.maxComments))) } : {}),
    ...(options.minSeverity ? { minSeverity: options.minSeverity } : {}),
    ...(finite(options.maxCost) ? { maxCostUsd: Math.max(0, options.maxCost) } : {}),
  }
}

// Your branch: section 3.4's range planning, with the last local review as the state.
const branchRange = Effect.fnUntraced(function* (
  git: ReviewGit.Client,
  root: string,
  input: {
    head: string
    branch?: string
    base: Base
    saved?: ReviewState
    config: ReviewConfig
    ignored: (file: string) => boolean
    full?: boolean
  },
) {
  const plan = yield* ReviewSource.planRange({
    directory: root,
    head: input.head,
    base: input.base.sha,
    ...(input.saved ? { state: input.saved } : {}),
    ...(input.full ? { full: true } : {}),
    incremental: input.config.incremental,
    compare: yield* ReviewSource.localCompare(root),
    ignored: input.ignored,
  })
  return {
    target: {
      kind: "branch",
      label: input.branch ?? `HEAD (${short(input.head)})`,
      baseRef: input.base.ref,
      mergeBase: plan.mergeBase,
      head: input.head,
      ...(input.branch ? { branch: input.branch } : {}),
    },
    head: input.head,
    mergeBase: plan.mergeBase,
    files: plan.files,
    mode: plan.mode,
    ...(plan.since ? { since: plan.since } : {}),
    ...(plan.focus ? { focus: plan.focus } : {}),
    nothing: `Nothing to review: this branch has no changes against ${input.base.ref}.`,
  } satisfies Range
})

// Uncommitted or staged changes, against HEAD, or against the merge-base when --base is given.
const worktreeRange = Effect.fnUntraced(function* (
  git: ReviewGit.Client,
  root: string,
  input: { kind: "uncommitted" | "staged"; head: string; branch?: string; base?: Base },
) {
  const from = input.base ? yield* mergeBaseOf(git, root, input.base, input.head, "HEAD") : input.head
  const what = input.kind === "staged" ? "staged changes" : "uncommitted changes"
  return {
    target: {
      kind: input.kind,
      label: input.base ? `${input.branch ?? "HEAD"} with ${what}` : what,
      baseRef: input.base?.ref ?? "HEAD",
      mergeBase: from,
      head: input.head,
      ...(input.branch ? { branch: input.branch } : {}),
    },
    head: input.head,
    mergeBase: from,
    files: yield* worktreeDiff(git, root, from, input.kind),
    mode: "full",
    worktree: input.kind,
    nothing: input.base
      ? `Nothing to review: no changes against ${input.base.ref}.`
      : input.kind === "staged"
        ? "Nothing to review: nothing is staged."
        : "Nothing to review: there are no uncommitted changes.",
  } satisfies Range
})

// A pull request, fetched into FETCH_HEAD and never checked out.
const pullRange = Effect.fnUntraced(function* (git: ReviewGit.Client, root: string, pr: number, base: Base) {
  const pulled = yield* fetchPull(git, root, pr)
  const head = pulled.sha
  const mergeBase = yield* mergeBaseOf(git, root, base, head, `pull request #${pr}`)
  return {
    target: { kind: "pr", label: `pull request #${pr}`, baseRef: base.ref, mergeBase, head, pr },
    head,
    mergeBase,
    files: yield* ReviewSource.prDiff({ directory: root, mergeBase, head }),
    mode: "full",
    remote: pulled.remote,
    nothing: `Nothing to review: pull request #${pr} has no changes against ${base.ref}.`,
  } satisfies Range
})

const toplevel = Effect.fnUntraced(function* (git: ReviewGit.Client, directory: string) {
  const result = yield* git.run(["rev-parse", "--show-toplevel"], { cwd: directory })
  const found = result.exitCode === 0 ? result.text().trim() : ""
  if (!found)
    return yield* new LocalReviewError({ message: "vector review works inside a git repository. Run it in one." })
  // Keep the caller's spelling of the same directory: it is the one the sessions' tools report paths under.
  return sameDirectory(directory, found) ? directory : found
})

const commitOf = Effect.fnUntraced(function* (git: ReviewGit.Client, root: string, ref: string) {
  if (!ref || ref.startsWith("-")) return undefined
  const result = yield* git.run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], {
    cwd: root,
  })
  return result.exitCode === 0 ? result.text().trim() || undefined : undefined
})

// --base as given; otherwise the remote-tracking default branch, as a pull request would be compared with it. A pull
// request's own base, from `gh`, comes first when there is one.
const resolveBase = Effect.fnUntraced(function* (
  git: ReviewGit.Client,
  root: string,
  input: { requested?: string; suggested?: string },
) {
  if (input.requested !== undefined) {
    const sha = yield* commitOf(git, root, input.requested)
    if (!sha)
      return yield* new LocalReviewError({
        message: `Could not find ${input.requested} to compare with. Pass a branch or commit to --base.`,
      })
    return { ref: input.requested, sha } satisfies Base
  }
  const found = yield* git.defaultBranch(root)
  const candidates = [
    ...(input.suggested ? [`origin/${input.suggested}`, input.suggested] : []),
    ...(found
      ? [found.ref.includes("/") ? found.ref : `origin/${found.name}`, `origin/${found.name}`, found.name]
      : []),
  ]
  for (const ref of new Set(candidates)) {
    const sha = yield* commitOf(git, root, ref)
    if (sha) return { ref, sha } satisfies Base
  }
  return yield* new LocalReviewError({
    message: "Could not find the default branch to compare with. Pass one to --base.",
  })
})

const mergeBaseOf = Effect.fnUntraced(function* (
  git: ReviewGit.Client,
  root: string,
  base: Base,
  head: string,
  what: string,
) {
  const result = yield* git.run(["merge-base", base.sha, head], { cwd: root })
  const found = result.exitCode === 0 ? result.text().trim() : ""
  if (!found)
    return yield* new LocalReviewError({
      message: `Could not find where ${what} branches from ${base.ref}. Run \`git fetch\` and try again, or pass --base.`,
    })
  return found
})

// The branch's own commits start at its merge-base with the default branch, when that can be found.
const branchStart = Effect.fnUntraced(function* (git: ReviewGit.Client, root: string, head: string, base?: Base) {
  const found = base ?? (yield* resolveBase(git, root, {}).pipe(Effect.catch(() => Effect.succeed(undefined))))
  if (!found) return undefined
  return yield* mergeBaseOf(git, root, found, head, "HEAD").pipe(Effect.catch(() => Effect.succeed(undefined)))
})

// `git fetch <remote> +refs/pull/<n>/head` with no destination and an empty --refmap: the commit lands in FETCH_HEAD
// and no ref is created or moved.
const fetchPull = Effect.fnUntraced(function* (git: ReviewGit.Client, root: string, pr: number) {
  const remotes = (yield* git.run(["remote"], { cwd: root }))
    .text()
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean)
  const order = [...new Set(["origin", "upstream", ...remotes])].filter((name) => remotes.includes(name)).slice(0, 2)
  if (!order.length)
    return yield* new LocalReviewError({ message: "--pr fetches from a remote, and this repository has none." })
  let reason = ""
  for (const remote of order) {
    const fetched = yield* git.run(
      ["fetch", "--no-tags", "--no-recurse-submodules", "--refmap=", remote, `+refs/pull/${pr}/head`],
      { cwd: root },
    )
    if (fetched.exitCode !== 0) {
      reason = stderrOf(fetched)
      continue
    }
    const sha = yield* commitOf(git, root, "FETCH_HEAD")
    if (sha) return { sha, remote }
  }
  return yield* new LocalReviewError({
    message: `Could not fetch pull request #${pr} from ${order.join(" or ")}: ${reason}`,
  })
})

// The working tree (untracked files included) or the index, against `from`, with the same flags as every other diff.
const worktreeDiff = Effect.fnUntraced(function* (
  git: ReviewGit.Client,
  root: string,
  from: string,
  kind: "uncommitted" | "staged",
) {
  const tracked = yield* git.run(
    ["diff", ...DIFF, "--find-renames", "--unified=3", ...(kind === "staged" ? ["--cached"] : []), from, "--"],
    { cwd: root, maxOutputBytes: MAX_DIFF_BYTES },
  )
  if (tracked.exitCode !== 0) return yield* new LocalReviewError({ message: `git diff failed: ${stderrOf(tracked)}` })
  if (tracked.truncated) return yield* new LocalReviewError({ message: "The diff is over 64 MB." })
  const texts = [tracked.text()]
  if (kind === "uncommitted") {
    const listed = yield* git.run(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root })
    const untracked = listed.text().split("\0").filter(Boolean)
    if (untracked.length > MAX_UNTRACKED)
      return yield* new LocalReviewError({
        message: `There are ${untracked.length} untracked files; add them to .gitignore or commit some first.`,
      })
    for (const file of untracked) {
      const patch = yield* git.run(["diff", "--no-index", ...DIFF, "--unified=3", "--", "/dev/null", file], {
        cwd: root,
        maxOutputBytes: MAX_DIFF_BYTES,
      })
      // --no-index exits 1 when the two sides differ, which they always do here.
      if (patch.exitCode <= 1 && !patch.truncated) texts.push(patch.text())
    }
  }
  return parseUnifiedDiff(texts.join(""))
})

// Section 2.8's header rule. A file with a generated header is skipped only when its base agrees; otherwise it is
// reviewed and the output says so.
const generatedHeaders = Effect.fnUntraced(function* (input: {
  files: DiffFile[]
  readHead: (file: string) => Effect.Effect<string | undefined>
  readBase: (file: string) => Effect.Effect<string | undefined>
  attributes?: GitAttributes
  config: ReviewConfig
}) {
  const checked = yield* Effect.forEach(
    input.files,
    Effect.fnUntraced(function* (file: DiffFile) {
      if (!input.config.ignoreDefaults || file.status === "deleted" || file.binary) return { file }
      const headText = yield* input.readHead(file.path)
      if (!headText || !hasGeneratedHeader(headText)) return { file }
      const baseText = file.status === "added" ? undefined : yield* input.readBase(file.oldPath ?? file.path)
      return {
        file,
        ...generatedHeaderDecision({
          path: file.path,
          headText,
          baseText,
          attributes: input.attributes,
          ignoreDefaults: input.config.ignoreDefaults,
        }),
      }
    }),
    { concurrency: 8 },
  )
  return {
    review: checked.filter((entry) => !("skip" in entry && entry.skip)).map((entry) => entry.file),
    skipped: checked.flatMap((entry) =>
      "skip" in entry && entry.skip ? [{ path: entry.file.path, reason: "generated" } satisfies SkippedFile] : [],
    ),
    notes: checked.flatMap((entry) =>
      "reviewedAnyway" in entry && entry.reviewedAnyway
        ? [`${entry.file.path} has a generated-file header that its base does not, so Vectorscope reviewed it anyway.`]
        : [],
    ),
  }
})

const otherAuthors = Effect.fnUntraced(function* (git: ReviewGit.Client, root: string, from: string, head: string) {
  const log = yield* git.run(["log", "--no-color", "--format=%aE", `${from}..${head}`], { cwd: root })
  const me = (yield* git.run(["config", "user.email"], { cwd: root })).text().trim().toLowerCase()
  const authors = new Set(
    log
      .text()
      .split("\n")
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean),
  )
  authors.delete(me)
  return authors.size
})

// Commit subjects for the prompt, where they are placed as untrusted text.
const subjects = Effect.fnUntraced(function* (git: ReviewGit.Client, root: string, from: string, head: string) {
  if (from === head) return []
  const log = yield* git.run(["log", "--no-color", "-n", String(MAX_SUBJECTS), "--format=%s", `${from}..${head}`], {
    cwd: root,
  })
  if (log.exitCode !== 0) return []
  return log
    .text()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
})

// Tracked changes against HEAD, and with `untracked` new files too.
const dirty = Effect.fnUntraced(function* (git: ReviewGit.Client, root: string, untracked: boolean) {
  const result = yield* git.run(
    ["status", "--porcelain", `--untracked-files=${untracked ? "normal" : "no"}`, "--no-renames"],
    { cwd: root },
  )
  return result.exitCode === 0 && result.text().trim() !== ""
})

const localStatePath = Effect.fnUntraced(function* (git: ReviewGit.Client, root: string, branch: string) {
  const result = yield* git.run(["rev-parse", "--absolute-git-dir"], { cwd: root })
  const dir = result.exitCode === 0 ? result.text().trim() : ""
  return dir ? path.join(dir, "vector", "review", `${encodeURIComponent(branch)}.json`) : undefined
})

// The local command can refuse model selection or omit files before the runner sees them. Its strict
// result must include that coverage loss, including alongside findings the runner could verify.
function incompleteStrictCoverage(outcome: ReviewOutcome): ReviewOutcome {
  const previous = outcome.strict
  const incomplete = [
    ...new Set([...unfinishedCauses({ ...outcome, strict: undefined }), ...(previous?.incomplete ?? [])]),
  ]
  const strict: NonNullable<ReviewOutcome["strict"]> = {
    version: 1,
    head: outcome.head,
    findings: previous?.findings ?? [],
    dropped: previous?.dropped ?? [],
    fixUnchecked: previous?.fixUnchecked ?? 0,
    complete: false,
    incomplete,
  }
  return {
    ...outcome,
    strict,
    selection: {
      ...outcome.selection,
      strict: {
        complete: false,
        findingCount: strict.findings.length,
        dropped: strict.dropped,
      },
    },
  }
}

// `{ version: 1, state, outcome? }`: the state encoded as in the sticky comment, so the same validation reads it back,
// and the last review's outcome, printed again when its commit is asked about.
interface LocalReviewRecord {
  text: string
  state: ReviewState
  strict: boolean
  checkedRules: boolean
  batch?: unknown
  batchAccounting?: true
  batchUncertainMonth?: string
  diagnosticsHost?: "linux" | "unsupported"
  inversionKey?: string
  strictPolicy?: string
  outcome?: ReviewOutcome
}

function readLocalState(
  file: string,
  includeOutcome: boolean,
  evidence?: ReviewConfig["verifyEvidence"],
  locked?: { text?: string },
  validate?: (bytes: Buffer) => boolean,
) {
  return Effect.promise(async (): Promise<LocalReviewRecord | undefined> => {
    const bytes = locked ? undefined : await fsp.readFile(file).catch(() => undefined)
    if (validate && (!bytes || !validate(bytes))) return undefined
    const text = locked ? locked.text : bytes?.toString("utf8")
    if (!text) return undefined
    const data = parseJson(text)
    if (!data || data.version !== 1 || typeof data.state !== "string") return undefined
    const state = decodeState(data.state)
    if (!state) return undefined
    // Legacy strict records have no policy marker. Keep their history, but never certify them as current.
    const strict =
      Object.hasOwn(data, "strictPolicy") ||
      (typeof data.outcome === "object" && data.outcome !== null && Object.hasOwn(data.outcome, "strict")) ||
      (isOutcome(data.outcome) && Object.hasOwn(data.outcome.selection, "strict"))
    const record: LocalReviewRecord = {
      text,
      state,
      strict,
      checkedRules: data.checkedRules === true,
      ...(data.batch !== undefined ? { batch: data.batch } : {}),
      ...(data.batch !== undefined ||
      data.batchAccounting === true ||
      data.batchUncertainMonth ||
      state.inflight?.run.startsWith("batch:")
        ? { batchAccounting: true as const }
        : {}),
      ...(typeof data.batchUncertainMonth === "string" ? { batchUncertainMonth: data.batchUncertainMonth } : {}),
      ...(data.diagnosticsHost === "linux" || data.diagnosticsHost === "unsupported"
        ? { diagnosticsHost: data.diagnosticsHost }
        : {}),
      ...(typeof data.inversionKey === "string" ? { inversionKey: data.inversionKey } : {}),
      ...(typeof data.strictPolicy === "string" ? { strictPolicy: data.strictPolicy } : {}),
    }
    if (
      !includeOutcome ||
      !isOutcome(data.outcome) ||
      (strict && !completeStrictReview(data.outcome, state.head ?? "", evidence))
    )
      return record
    // Serialized caches are useful history, but cannot certify that old mixed token aggregates were partitioned.
    const outcome = data.outcome
    const mixed =
      (outcome.cost && reviewCostHasCodium(outcome.cost)) || outcome.passes?.some((pass) => codiumPass(pass))
    const pure =
      outcome.cost &&
      (reviewCostIsCodium(outcome.cost) ||
        (outcome.cost.codium !== true &&
          !!outcome.passes?.length &&
          outcome.passes.every((pass) => codiumPass(pass)) &&
          !outcome.cost.model
            .split(" + ")
            .some((model) => model.includes("/") && Billing.hasOwnIdentity({ providerID: model.split("/")[0] }))))
    return {
      ...record,
      outcome: {
        ...outcome,
        ...(outcome.cost
          ? {
              cost: {
                ...outcome.cost,
                tokensOwnOnly: false,
                ...(mixed ? { codium: true, kind: pure ? ("codium" as const) : outcome.cost.kind } : {}),
              },
            }
          : {}),
        ...(mixed && outcome.passes
          ? {
              passes: outcome.passes.map((pass) => ({
                ...pass,
                usageMissing: true,
                input: 0,
                output: 0,
                cacheRead: 0,
              })),
            }
          : {}),
      },
    }
  })
}

function isOutcome(value: unknown): value is ReviewOutcome {
  if (!value || typeof value !== "object") return false
  const outcome = value as Partial<Record<keyof ReviewOutcome, unknown>>
  return (
    typeof outcome.head === "string" &&
    !!outcome.selection &&
    typeof outcome.selection === "object" &&
    !!outcome.report &&
    typeof outcome.report === "object" &&
    !!outcome.stats &&
    Array.isArray(outcome.specialists)
  )
}

// Copy only the existing money, token and review counters. Finding lifecycle and coverage stay
// with the review that owns the state, even when another review settles under the same lock.
function accountingOf(state: ReviewState) {
  const { reviews, codiumReviews, costUsd, tokens, month } = state
  return { reviews, codiumReviews, costUsd, tokens, month }
}

function writeLocalState(
  previous: LocalReviewRecord | undefined,
  now: number,
  file: string | undefined,
  state: ReviewState,
  say: (text: string) => void,
  {
    outcome,
    unchangedRecord,
    strictPolicy,
    checkedRules,
    diagnosticsHost,
    inversionKey,
    locked,
    batch,
    written,
  }: Partial<
    Pick<LocalReviewRecord, "outcome" | "strictPolicy" | "checkedRules" | "diagnosticsHost" | "inversionKey">
  > & {
    locked?: Awaited<ReturnType<typeof lockBatchFile>>
    batch?: ReturnType<typeof localBatchStore>["metadata"]
    unchangedRecord?: string
    written?: (bytes: string) => void
  } = {},
) {
  if (!file) return Effect.void
  let writer: ReviewCheckpointLock.Lease | undefined
  const encodeLocal = (value: ReviewState) => encodeState(diagnosticsHost ? redactDiagnosticData(value) : value)
  const publish = async (record: { state: string }, notify = false) => {
    // Compare the original bytes under the lock. Mask the visible fields at publication for both a normal
    // write and a stale charge reconciled against a newer checkpoint. The decoded state was masked by encodeLocal.
    const saved = diagnosticsHost
      ? { ...redactDiagnosticData({ ...record, state: undefined }), state: record.state }
      : record
    const text = JSON.stringify(saved) + "\n"
    if (locked) return locked.replace(text)
    if (!writer && process.platform === "linux") throw new Error("The local review writer is not held.")
    const destination = writer ? path.join(writer.directory, path.basename(file)) : file
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`
    try {
      if (writer) {
        const output = await fsp.open(temporary, "wx", 0o600)
        try {
          await output.writeFile(text)
          await output.sync()
        } finally {
          await output.close()
        }
      } else await fsp.writeFile(temporary, text, { mode: 0o600, flag: "wx" })
      await fsp.rename(temporary, destination)
      await writer?.sync()
      if (notify) written?.(text)
    } finally {
      await fsp.rm(temporary, { force: true })
    }
  }
  const write = async () => {
    if (locked) await locked.verify()
    else {
      const latest = await concurrentBatchRecord(file, previous?.text, !!previous?.batchAccounting, writer)
      if (latest) {
        // An ordinary review acquired the publication lock after a funded review had already
        // written its checkpoint. Settle its own charge without displacing that review's state.
        if (!latest.state || !outcome?.cost || unchangedRecord !== undefined) return
        const totals = nextState(latest.state, {
          head: outcome.head,
          base: outcome.base,
          mode: outcome.mode,
          cost: outcome.cost,
          now,
        })
        // The writer obtained its settlement time before waiting for the lock. Never rewind a
        // later UTC month if the newer review published across midnight in the meantime.
        const settledMonth = monthKey(now)
        const olderMonth = !!latest.state.month && latest.state.month.key > settledMonth
        if (olderMonth) totals.month = latest.state.month
        const row = { ...latest.row, state: encodeLocal({ ...latest.state, ...accountingOf(totals) }) }
        // An older head's charge belongs to the month and branch total, but predates the
        // current head's per-plan allowance. Advance its starting balance by that same amount.
        if (row.batch?.cursor?.head !== outcome.head && Number.isFinite(row.batch?.initialCostUsd)) {
          const charged = Math.max(0, totals.costUsd - latest.state.costUsd)
          row.batch = { ...row.batch, initialCostUsd: row.batch.initialCostUsd + charged }
        }
        // The first funded review can race an older ordinary invocation that never opted into
        // settlement tracking. Its paid total is a lower bound even when some usage is present.
        const untrackedPaid =
          !previous?.batchAccounting &&
          !reviewCostIsCodium(outcome.cost) &&
          (outcome.cost.kind === "priced" || outcome.cost.costUsd > 0) &&
          outcome.specialists.some((specialist) => specialist.status !== "skipped")
        if (untrackedPaid || unknownOwnSpend(outcome.cost)) {
          if (!olderMonth) row.batchUncertainMonth = settledMonth
          if (row.batch?.cursor?.head === outcome.head)
            row.batch = { ...row.batch, usageMissing: true, ...(!olderMonth ? { uncertainMonth: settledMonth } : {}) }
        }
        return publish(row)
      }
    }
    // A newer run can finish while an earlier one checks its budget. Change only the marker on the exact
    // record we started with, keeping the original outcome (including legacy usage metadata) intact.
    if (unchangedRecord !== undefined) {
      const current = locked
        ? await locked.read()
        : await fsp.readFile(writer ? path.join(writer.directory, path.basename(file)) : file, "utf8")
      if (current !== unchangedRecord) return
    }
    const carried =
      !batch && previous?.batchAccounting
        ? unknownOwnSpend(outcome?.cost)
          ? monthKey(now)
          : uncertainBatchMonth(previous.state, previous.batch, previous.batchUncertainMonth, now)
        : undefined
    const encoded = encodeLocal(state)
    const record =
      unchangedRecord === undefined
        ? {
            version: 1,
            state: encoded,
            ...(outcome ? { outcome } : {}),
            ...(batch ? { batch } : previous?.batchAccounting ? { batchAccounting: true } : {}),
            ...(carried ? { batchUncertainMonth: carried } : {}),
            ...(strictPolicy ? { strictPolicy } : {}),
            ...(checkedRules ? { checkedRules: true } : {}),
            ...(diagnosticsHost ? { diagnosticsHost } : {}),
            ...(inversionKey ? { inversionKey } : {}),
          }
        : { ...JSON.parse(unchangedRecord), state: encoded }
    return publish(record, unchangedRecord === undefined)
  }
  if (locked)
    return Effect.tryPromise({
      try: write,
      catch: () =>
        new LocalReviewError({ message: "The local batch checkpoint could not be saved. Coverage was not committed." }),
    })
  return Effect.promise(async () => {
    try {
      // Funded batches are Linux-only. Preserve ordinary cache behavior on other supported hosts.
      if (process.platform !== "linux")
        return await Flock.withLock(path.basename(file), write, { dir: path.dirname(file) })
      writer = await ReviewCheckpointLock.acquire(path.basename(file), { dir: path.dirname(file) })
      try {
        await writer.use(write)
      } finally {
        await writer.release()
      }
    } catch (error) {
      say(`Warning: could not save this review for next time: ${error instanceof Error ? error.message : error}`)
    }
  })
}

// Only repository-relative, regular instruction files can establish a local rule. A linked file or directory
// must not let a reviewed checkout quote material from another project or the owner's home.
function readWorkingRule(root: string, file: string, maxBytes = MAX_RULES_BYTES + 1) {
  return Effect.tryPromise(async () => {
    const directory = await fsp.realpath(root)
    const name = path.join(directory, file)
    const before = await fsp.lstat(name)
    if (!before.isFile() || before.nlink !== 1 || (await fsp.realpath(name)) !== name) return undefined
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
    const handle = await fsp.open(name, O_RDONLY | (O_NOFOLLOW ?? 0) | (O_NONBLOCK ?? 0))
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.nlink !== 1) return undefined
      const buffer = Buffer.alloc(Math.min(info.size, maxBytes))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const bytes = buffer.subarray(0, bytesRead)
      if ((await fsp.realpath(name)) !== name || bytes.includes(0)) return undefined
      return bytes.toString("utf8")
    } finally {
      await handle.close()
    }
  }).pipe(Effect.orElseSucceed(() => undefined))
}

function readWorkingFile(root: string, file: string) {
  return Effect.promise(() => fsp.readFile(path.join(root, file), "utf8").catch(() => undefined))
}

// A file at `rev`; an empty `rev` reads the index.
function readBlob(git: ReviewGit.Client, root: string, rev: string, file: string) {
  return git
    .run(["cat-file", "blob", `${rev}:${file}`], { cwd: root })
    .pipe(Effect.map((result) => (result.exitCode === 0 && !result.stdout.includes(0) ? result.text() : undefined)))
}

function inTree(root: string, file: string) {
  const full = path.resolve(root, file)
  if (full !== root && !full.startsWith(root + path.sep)) return false
  return fs.existsSync(full)
}

function stillOpen(open: readonly { severity: Severity }[]): string {
  if (!open.length) return ""
  const blocking = open.filter((finding) => finding.severity === "blocking").length
  const which = blocking ? ` (${blocking} blocking)` : ""
  return ` ${open.length} ${open.length === 1 ? "finding" : "findings"} from the last review ${open.length === 1 ? "is" : "are"} still open${which}.`
}

function sameDirectory(a: string, b: string) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b)
  } catch {
    return false
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function stderrOf(result: Git.Result) {
  return result.stderr.toString("utf8").trim().split("\n").slice(-3).join(" ") || `exit ${result.exitCode}`
}

function short(sha: string) {
  return sha.slice(0, 7)
}

// The repository root for the engine instance, so the reviewer's tools resolve the diff's repository-relative paths
// wherever in the repository the command was run.
function repositoryRoot(start: string) {
  let dir = path.resolve(start)
  while (!fs.existsSync(path.join(dir, ".git"))) {
    const parent = path.dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
  return dir
}

async function confirm(question: string) {
  if (!process.stdin.isTTY) return false
  const readline = await import("readline")
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  const answer = await new Promise<string>((resolve) => rl.question(`${question} `, resolve))
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

// The pull request's title, body, author and base branch from the GitHub CLI, when it is installed and signed in.
async function githubPullInfo(pr: number, directory: string): Promise<PullInfo | undefined> {
  const result = await Process.text(["gh", "pr", "view", String(pr), "--json", "title,body,author,baseRefName"], {
    cwd: directory,
    nothrow: true,
  }).catch(() => undefined)
  if (!result || result.code !== 0) return undefined
  const data = parseJson(result.text)
  if (!data) return undefined
  const text = (value: unknown) => (typeof value === "string" ? value : undefined)
  const author =
    data.author && typeof data.author === "object" ? (data.author as Record<string, unknown>).login : undefined
  return {
    title: text(data.title),
    body: text(data.body),
    author: text(author),
    baseRefName: text(data.baseRefName),
  }
}

function write(text: string) {
  return new Promise<void>((resolve) => process.stdout.write(text, () => resolve()))
}

export const ReviewCommand = effectCmd({
  command: "review",
  aliases: ["vectorscope"],
  describe: "Vectorscope: review your branch, uncommitted changes or a pull request",
  builder: (yargs) =>
    yargs
      .option("base", {
        type: "string",
        describe: "branch or commit to compare with (default: the merge-base with origin's default branch)",
      })
      .option("uncommitted", {
        type: "boolean",
        describe: "review changes you have not committed, untracked files included",
      })
      .option("staged", { type: "boolean", describe: "review only staged changes" })
      .option("pr", { type: "number", describe: "review pull request <n> from origin without checking it out" })
      .option("post", { type: "boolean", describe: "post the review to the pull request (with --pr)" })
      .option("yes", { type: "boolean", describe: "answer yes to confirmation questions" })
      .option("json", { type: "boolean", describe: "print { version, target, outcome } as JSON" })
      .option("model", { type: "string", describe: "model to review with, as provider/model" })
      .option("security", {
        type: "boolean",
        describe: "always run the security reviewer (--no-security: never)",
      })
      .option("max-comments", { type: "number", describe: "findings listed in detail, 0 to 50 (default 10)" })
      .option("min-severity", {
        type: "string",
        choices: ["blocking", "concern", "nit"],
        describe: "lowest severity listed in detail (default concern)",
      })
      .option("max-cost", { type: "number", describe: "stop the review at this many US dollars; 0 for no limit" })
      .option("fail-on", {
        type: "string",
        choices: ["blocking", "concern", "never"],
        describe: "exit 1 while findings of this severity or above are open",
      })
      .option("checks", { type: "boolean", describe: "let the reviewer run your tests and typecheck" })
      .option("full", { type: "boolean", describe: "review the whole change again, ignoring the last local review" })
      .option("apply", {
        type: "boolean",
        hidden: true,
        describe:
          "experimental: after a review of your branch, offer to apply its verified fixes in a separate checkout, asking before each step",
      }),
  directory: () => repositoryRoot(process.cwd()),
  handler: Effect.fn("Cli.review")(function* (args) {
    const { ReviewModel } = yield* Effect.promise(() => import("@/review/model"))
    const { Review } = yield* Effect.promise(() => import("@/review/run"))
    const knowledge = yield* BrainKnowledge.Service
    const brain = Option.getOrUndefined(yield* Effect.serviceOption(Brain.Service))
    const db = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
    const instruction = yield* Instruction.Service
    const provider = yield* Provider.Service
    const bridge = yield* EffectBridge.make()
    // The step behind --apply, loaded and configured only when it is asked for; it is honoured only when the GLOBAL
    // settings turn VectorScope on, so a project's config cannot.
    const fix = args.apply
      ? yield* Effect.gen(function* () {
          const { cliFixStep } = yield* Effect.promise(() => import("./review.fix"))
          const config = yield* Config.Service
          const global = yield* config.getGlobal()
          return cliFixStep({
            experimental: global.experimental?.vectorscope === true && !global.agent?.vectorscope?.disable,
          })
        })
      : undefined
    const result = yield* executeLocalReview(
      {
        directory: repositoryRoot(process.cwd()),
        base: args.base,
        uncommitted: args.uncommitted,
        staged: args.staged,
        pr: args.pr,
        post: args.post,
        yes: args.yes,
        json: args.json,
        model: args.model,
        security: args.security,
        maxComments: args["max-comments"],
        minSeverity: args["min-severity"] as Severity | undefined,
        maxCost: args["max-cost"],
        failOn: args["fail-on"] as FailOn | undefined,
        checks: args.checks,
        full: args.full,
        apply: args.apply,
      },
      {
        runReview: Review.run,
        resolveModel: ReviewModel.resolveReviewModel,
        confirm,
        pullInfo: githubPullInfo,
        stdout: write,
        stderr: (text) => void process.stderr.write(text),
        color: process.stdout.isTTY === true && !process.env.NO_COLOR,
        // What a posted review says is checked against the owner's memory first; it says how many sentences went.
        posting: (input) =>
          bridge.promise(
            SessionPosting.headless({
              parts: [...input.parts],
              typed: false,
              sessionIDs: input.sessionIDs,
              untrusted: input.untrusted,
              log: (line) => void process.stderr.write(`${line}\n`),
            }),
          ),
        cards: (input) =>
          instruction.place().pipe(
            Effect.flatMap((place) => ReviewCardAccess.collect(input, place, !!brain && !!db)),
            Effect.timeoutOption(Math.max(0, input.deadline - performance.now())),
            Effect.map(Option.getOrUndefined),
            Effect.provideService(BrainKnowledge.Service, knowledge),
            Effect.provideService(Provider.Service, provider),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterrupts(cause),
              () => Effect.succeed(undefined),
            ),
          ),
        // Private documents only for a review model that may not train on prompts, and never in a posted review.
        requirements: (input) =>
          Effect.gen(function* () {
            const place = yield* instruction.place()
            const chosen = yield* provider
              .getModel(input.model.providerID, input.model.modelID)
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
            return yield* ReviewContext.requirements({
              place,
              files: input.files,
              personal: !input.shared && chosen !== undefined && !freeModelMayTrain(chosen),
            })
          }).pipe(
            Effect.provideService(BrainKnowledge.Service, knowledge),
            Effect.catchCause(() => Effect.succeed(undefined)),
          ),
        ...(fix ? { fix } : {}),
      },
    )
    if (result.error) UI.error(result.error)
    process.exitCode = result.exitCode
  }),
})
