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

import { createHash } from "node:crypto"
import path from "path"
import { Cause, Effect, Exit, Schema } from "effect"
import {
  parseReviewConfig,
  parseReviewRules,
  REVIEW_CONFIG_PATH,
  REVIEW_RULES_PATHS,
  rulesForPaths,
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
import { evidenceScope, type EvidenceScope } from "@vectordevai/core/review/model-evidence"
import type { ReviewPrice } from "@vectordevai/core/review/plan"
import { Flag } from "@vectordevai/core/flag/flag"
import { redactSecrets } from "@vectordevai/core/review/redact"
import { nextState } from "@vectordevai/core/review/state"
import {
  DEFAULT_REVIEW_CONFIG,
  type CostKind,
  type ReviewConfig,
  type ReviewOutcome,
  type SkippedFile,
  type Trigger,
  type Trust,
} from "@vectordevai/core/review/types"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { Git } from "@/git"
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
  // The eval variant's settings, applied over the base's review.json. Its maxCostUsd must be a positive cap, and it
  // alone sets maxCostUsd, maxSteps and timeoutMinutes (the defaults where it leaves the last two out).
  config?: Partial<ReviewConfig>
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
}

export type PostedRecord =
  | { write: "createReview"; pr: number; payload: CreateReviewPayload }
  | { write: "createIssueComment"; pr: number; body: string }

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
  // The pipeline variant the eval asked for, when it set one (VS-06's verify policy), so the report can tell a
  // variant's replays from the frozen pipeline's.
  variant?: { verifyPolicy: ReviewConfig["verifyPolicy"] }
  // What a model certificate (core model-evidence.ts, VS-07) made from this replay would cover: the runner, pipeline
  // revision, prompts, review settings and triage model.
  scope: EvidenceScope
  rules: { digest: string }
  models: { review: ModelRecord; triage?: ModelRecord }
  context: { digest: string; related: number; history: number; instructions: boolean; headFiles: number }
  files: { reviewed: string[]; skipped: SkippedFile[] }
  passes: { pass: Pass; model: string; digest: string; chars: number }[]
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

const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/

export const replay = Effect.fn("ReviewEval.replay")(function* (input: ReplayInput) {
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

  // 2. Settings from the base commit, then the eval variant's.
  const json = yield* show(item.base, REVIEW_CONFIG_PATH)
  const rulesTexts = yield* Effect.forEach(REVIEW_RULES_PATHS, (file) => show(item.base, file))
  const attributesText = yield* show(item.base, ".gitattributes")
  // A variant that sets the verify policy (VS-06) is read as a repository that chose it would be: under "shared" the
  // base's own "verify" still wins, and without one the policy's default applies.
  const policy = input.config?.verifyPolicy
  const parsed = parseReviewConfig({ json, env: policy ? { REVIEW_VERIFY_POLICY: policy } : {}, trigger })
  const config: ReviewConfig = {
    ...parsed.config,
    ...input.config,
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
    ...(policy ? { variant: { verifyPolicy: policy } } : {}),
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
      context: { digest: digest({}), related: 0, history: 0, instructions: false, headFiles: 0 },
      passes: [],
      attempts: [],
      tools: [],
      placed: [],
      posted,
      ...(refusal.message !== undefined ? { refused: refusal.message } : {}),
    }
    return nothing
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

  // 6. The review.
  const observed: Observation[] = []
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

  // 8. The record: each pass's prompt by digest, every attempt with its settlement, and the tool calls each session
  // made, with this checkout's paths made relative.
  const attempts = foldAttempts(observed)
  const passOf = new Map(attempts.flatMap((attempt) => (attempt.sessionID ? [[attempt.sessionID, attempt.pass]] : [])))
  const tools = (yield* Effect.forEach(outcome.sessions, (id) =>
    sessions.messages({ sessionID: SessionID.make(id) }).pipe(
      Effect.map((messages) =>
        messages
          .flatMap((message) => message.parts)
          .flatMap((part) =>
            part.type === "tool"
              ? [
                  {
                    ...(passOf.has(SessionID.make(id)) ? { pass: passOf.get(SessionID.make(id)) } : {}),
                    tool: part.tool,
                    status: part.state.status,
                    input: relativeInput(part.state.input, directory),
                  },
                ]
              : [],
          ),
      ),
      Effect.catch(() => Effect.succeed([])),
    ),
  )).flat()

  const artifact: ReplayArtifact = {
    ...common,
    context: {
      digest: digest({ gathered, headFiles: headFiles ?? [] }),
      related: gathered.related.length,
      history: gathered.history.length,
      instructions: gathered.instructions !== undefined,
      headFiles: headFiles?.length ?? 0,
    },
    passes: observed.flatMap((event) =>
      event.type === "pass"
        ? [{ pass: event.pass, model: event.model, digest: digest(event.text), chars: event.text.length }]
        : [],
    ),
    attempts,
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
  return artifact
})

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
