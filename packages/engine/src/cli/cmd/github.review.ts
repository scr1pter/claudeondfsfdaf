// `vector github review` (section 3.11): one review job for one pull request. executeReviewJob holds the whole flow
// and takes GitHub, git and the engine as dependencies, so the tests run it against a fake GitHub server and a real
// repository; githubReview wires it to the Actions environment and the engine.

import { readFileSync } from "fs"
import { Cause, Effect, Exit } from "effect"
import { DEFAULT_MENTIONS, parseReviewCommand } from "@vectordevai/core/review/command"
import {
  REVIEW_CONFIG_PATH,
  REVIEW_RULES_PATHS,
  parseReviewConfig,
  parseReviewRules,
  rulesForPaths,
} from "@vectordevai/core/review/config"
import {
  buildAnchorIndex,
  fromGitHubFiles,
  resolveAnchor,
  suggestionAllowed,
  type DiffFile,
} from "@vectordevai/core/review/diff"
import {
  buildFixedEdit,
  buildNoteBody,
  buildReviewBody,
  buildRunningBody,
  buildSummaryBody,
  inlineLeads,
  noteAlreadyReviewed,
  noteCannotStart,
  noteCommitGone,
  noteFailed,
  noteForcePush,
  noteGeneratedHeaders,
  noteInlineCap,
  noteMonthBudget,
  noteMonthUnknown,
  noteMoved,
  noteNothingToReview,
  notePartial,
  notePrBudget,
  noteRebase,
  noteSuperseded,
  noteTooLarge,
} from "@vectordevai/core/review/format"
import {
  buildCreateReviewPayload,
  splitHalves,
  type CreateReviewPayload,
} from "@vectordevai/core/review/github-payload"
import {
  DEFAULT_IGNORES,
  LOCKFILES,
  classifyFiles,
  classifyPath,
  generatedHeaderDecision,
  hasGeneratedHeader,
  isSensitivePath,
  parseGitAttributes,
} from "@vectordevai/core/review/ignore"
import { diffBudgetChars, estimateCostUsd } from "@vectordevai/core/review/plan"
import type { HeadFile, HumanComment, TeamPattern } from "@vectordevai/core/review/prompt"
import { collectSecretValues, redactSecrets } from "@vectordevai/core/review/redact"
import { computeRisk } from "@vectordevai/core/review/select"
import { decideSkip, type SkipReason } from "@vectordevai/core/review/skip"
import {
  SUMMARY_MARKER,
  classifyPrior,
  followAlso,
  emptyState,
  findSticky,
  mergePrior,
  monthKey,
  nextState,
  parseFindingMarker,
  priorFromComment,
  priorFromState,
  readState,
  setFindingStatus,
  teamPatterns,
  type ClassifiedPrior,
  type ThreadInfo,
} from "@vectordevai/core/review/state"
import type {
  Finding,
  PlacedFinding,
  PriorFinding,
  ReviewConfig,
  ReviewCost,
  ReviewOutcome,
  ReviewState,
  Selection,
  Trigger,
  Trust,
} from "@vectordevai/core/review/types"
import { InstanceRef } from "@/effect/instance-ref"
import { Git } from "@/git"
import { ReviewContext } from "@/review/context"
import type { ResolvedModel } from "@/review/model"
import type { RunInput } from "@/review/run"
import { ReviewGitError, ReviewSource, type Compare, type RangePlan } from "@/review/source"
import { CliError, fail } from "../effect-cmd"
import {
  WRITE_PERMISSIONS,
  createReviewGitHub,
  sameLogin,
  statusOf,
  type IssueComment,
  type ReactionTarget,
  type ReviewGitHub,
  type ThreadNode,
} from "./github.review-api"
import { mentionsFrom, routeGithubEvent, type RouteComment, type RouteEvent } from "./github.route"
import { setSecret } from "@actions/core"
import { resolveGithubAuth } from "./github.auth"
import { appRequested, verifyAppPullRequest } from "./github.app"
import { prepareGithubGit } from "./github.git"
import { withGithubCallbacks, withGithubSignals } from "./github.lifecycle"
import { SessionPosting } from "@/session/posting"
import { GithubSecrets } from "./github.secrets"
import { withCodiumReview, type CodiumReviewControl } from "./github.review-codium"
import { agentModel, stoppedLine } from "./github.agent"
import { sanitizeActionsLog } from "./github.output"

// Reviews post with the workflow's GITHUB_TOKEN.
export const ACTIONS_BOT = "github-actions[bot]"

const TEAM_PAGES = 3
const MONTH_PAGES = 10
const MAX_HUMAN_COMMENTS = 30
const MAX_HUMAN_CHARS = 1_000
// The prompt around the diff, for the cost estimate in the too-large note.
const PROMPT_OVERHEAD_TOKENS = 6_000

export interface ReviewJobContext {
  owner: string
  repo: string
  pr: number
  trigger: "auto" | "command"
  full: boolean
  comment?: RouteComment // the command that asked, when there is one
  expectedHead?: string // the commit the workflow checked out: VECTOR_REVIEW_REF, or the event's head
  directory: string
  botLogin: string
  runUrl?: string
  env: Record<string, string | undefined>
  mentions?: string[]
}

// The git side, over the checkout the workflow made.
export interface ReviewGit {
  head(): Promise<string>
  fetch(input: {
    base: string
    head: string
    since?: string
    old?: { mergeBase?: string; head: string }
    pr?: number // untrusted: the head comes from refs/pull/<pr>/head into FETCH_HEAD
  }): Promise<{ head: string }>
  planRange(input: {
    head: string
    base: string
    state?: ReviewState
    full: boolean
    incremental: boolean
    compare: (a: string, b: string) => Promise<Compare>
    ignored: (path: string) => boolean
  }): Promise<RangePlan>
  diff(from: string, to: string): Promise<DiffFile[] | undefined> // undefined when either commit is missing
  show(rev: string, path: string): Promise<string | undefined>
  headFiles(input: { mergeBase: string; head: string; files: DiffFile[] }): Promise<HeadFile[]>
  context(input: {
    base: string
    head: string
    files: DiffFile[]
    ignore: string[]
    ignored: (path: string) => boolean
    instructions: (path: string) => Promise<string | undefined>
  }): Promise<Pick<RunInput["context"], "related" | "history" | "instructions">>
  knownPath(rev: string): Promise<(path: string) => Promise<boolean>>
}

export interface ReviewJobDeps {
  gh: ReviewGitHub
  git: ReviewGit
  runReview: (input: RunInput) => Promise<ReviewOutcome>
  resolveModel: (input: { trigger: Trigger; config?: string; exact?: string }) => Promise<ResolvedModel>
  log: (line: string) => void
  now: () => number
  dryRun?: boolean
  nonce?: () => string
  cloud?: CodiumReviewControl
}

export interface ReviewJobResult {
  exitCode: 0 | 1
  posted: { reviewIds: number[]; summaryId?: number }
  error?: string
}

export async function executeReviewJob(ctx: ReviewJobContext, deps: ReviewJobDeps): Promise<ReviewJobResult> {
  if (deps.cloud) {
    const cloud = deps.cloud
    const log = deps.log
    deps = { ...deps, log: (line) => log(sanitizeActionsLog(cloud.redact(line))) }
  }
  const seen: Seen = {}
  try {
    return await reviewJob(ctx, deps, seen)
  } catch (error) {
    // Reading the pull request, its comments, threads or files failed before the review started; anything later is
    // caught inside. A refused token or a missing pull request is a configuration error. Anything else, such as GitHub
    // still failing after its retries, exits 0, with a note when there is a summary comment to put it in.
    const message = deps.cloud ? "Codium is unavailable right now." : messageOf(error)
    deps.log(`The review could not start: ${message}`)
    if (seen.cannotStart) {
      deps.log(`Configuration error: ${seen.cannotStart}`)
      return { exitCode: 1, posted: { reviewIds: [] }, error: seen.cannotStart }
    }
    const status = statusOf(error)
    if (status === 401 || status === 403 || status === 404)
      return { exitCode: 1, posted: { reviewIds: [] }, error: message }
    const sticky = seen.sticky
    if (sticky) {
      const gh = deps.dryRun ? dryRunGitHub(deps.gh, deps.log) : deps.gh
      const body = buildNoteBody({ previous: sticky.body, note: noteFailed(message), state: readState(sticky.body) })
      await gh
        .updateIssueComment(sticky.id, deps.cloud?.redact(body) ?? redactSecrets(body, collectSecretValues(ctx.env)))
        .catch((cause) => deps.log(`Could not post the failure: ${messageOf(cause)}`))
    }
    return { exitCode: 0, posted: { reviewIds: [] } }
  }
}

// What the job had read when it failed, for the note it leaves.
interface Seen {
  sticky?: { id: number; body: string }
  cannotStart?: string // why the model cannot run, which fails the job whatever GitHub does
}

async function reviewJob(ctx: ReviewJobContext, deps: ReviewJobDeps, seen: Seen): Promise<ReviewJobResult> {
  const { log } = deps
  const gh = deps.dryRun ? dryRunGitHub(deps.gh, log) : deps.gh
  const posted: ReviewJobResult["posted"] = { reviewIds: [] }
  const secrets = collectSecretValues(ctx.env)
  const clean = (text: string) => deps.cloud?.redact(redactSecrets(text, secrets)) ?? redactSecrets(text, secrets)
  const repoRef = { owner: ctx.owner, repo: ctx.repo }
  const finish = (exitCode: 0 | 1, error?: string): ReviewJobResult => ({
    exitCode,
    posted,
    ...(error ? { error } : {}),
  })
  // A configuration error fails the job and posts nothing, except a model that cannot run, which says so (step 4).
  const configError = (message: string) => {
    log(`Configuration error: ${message}`)
    return finish(1, message)
  }

  // 1. Identify.
  const pull = await gh.getPull(ctx.pr)
  let full = ctx.full
  if (ctx.comment) {
    const kind = parseReviewCommand(ctx.comment.body, ctx.mentions ?? DEFAULT_MENTIONS).kind
    if (kind !== "review" && kind !== "review-full") {
      log(`Nothing to review: the comment asks for "${kind}".`)
      return finish(0)
    }
    if (!WRITE_PERMISSIONS.includes(await gh.permissionOf(ctx.comment.author))) {
      log(`@${ctx.comment.author} does not have write access to ${ctx.owner}/${ctx.repo}; nothing was posted.`)
      return finish(0)
    }
    full = full || kind === "review-full"
  }
  const trust: Trust = pull.fork ? "untrusted" : "trusted"
  const checkedOut = await deps.git.head()
  if (trust === "trusted") {
    const expected = ctx.expectedHead ?? pull.head.sha
    if (checkedOut !== expected)
      return configError(
        `the working tree is at ${short(checkedOut)}, but this review is of ${short(expected)}. Check out the pull request's head (VECTOR_REVIEW_REF in the workflow).`,
      )
  } else if (checkedOut === pull.head.sha)
    return configError(
      `the working tree is the fork's head ${short(checkedOut)}. A fork's code is never checked out: check out the merge-base the route job resolved.`,
    )
  let head = trust === "trusted" ? checkedOut : pull.head.sha

  // 2. Settings, from the base commit, so a pull request cannot change the rules it is reviewed under.
  const base = pull.base.sha
  const [json, rulesText, attributesText] = await Promise.all([
    gh.getContent(REVIEW_CONFIG_PATH, base),
    firstContent(gh, REVIEW_RULES_PATHS, base),
    gh.getContent(".gitattributes", base),
  ])
  const { config, warnings } = parseReviewConfig({ json, env: ctx.env, trigger: ctx.trigger })
  if (deps.cloud) {
    // A run credential authorizes Codium only. Dollar limits and a repository's own-key model cannot select a
    // different provider or print historical dollar amounts into this run's public output.
    config.maxCostUsd = 0
    config.maxCostUsdPerPr = 0
    config.maxCostUsdPerMonth = 0
    config.model = ctx.env.MODEL || "vector-plan"
    config.triageModel = undefined
  }
  for (const warning of warnings) log(`warning: ${warning}`)
  const rules = parseReviewRules(rulesText ?? "")
  if (rules.truncated) log("warning: .vector/review.md is over 16 KB; the rest of it is ignored.")
  const attributes = attributesText === undefined ? undefined : parseGitAttributes(attributesText)
  const ignored = (path: string) => classifyPath(path, { config, attributes }) !== undefined
  const model = await deps.resolveModel({ trigger: ctx.trigger, config: config.model }).then(
    (value) => value,
    (error: unknown) => new Error(messageOf(error)),
  )
  // review.json's cheaper first pass; the double-check stays on `model`.
  const triage = config.triageModel
    ? await deps.resolveModel({ trigger: ctx.trigger, exact: config.triageModel }).then(
        (value) => value,
        (error: unknown) => new Error(`triageModel: ${messageOf(error)}`),
      )
    : undefined
  // A model that cannot run fails the job only once the skips below have had their say, so a pull request the settings
  // skip without a word stays quiet. If GitHub fails before then, executeReviewJob still fails the job with this.
  seen.cannotStart = model instanceof Error ? model.message : triage instanceof Error ? triage.message : undefined

  // 3. Earlier state.
  const comments = await gh.listIssueComments(ctx.pr)
  const sticky = findSticky(comments, ctx.botLogin) ?? findSticky(comments, ACTIONS_BOT)
  let stickyId = sticky?.id
  let stickyUrl = sticky?.url
  let stickyBody = sticky?.body
  if (sticky) seen.sticky = { id: sticky.id, body: sticky.body }
  const state = foldInflight(sticky ? readState(sticky.body) : undefined)
  const threads = await gh.reviewThreads(ctx.pr)
  const humans = humanComments(comments, threads, ctx.botLogin)
  const team = await gh.listRepoReviewComments(TEAM_PAGES).then(
    (list) =>
      teamPatterns(
        list
          .filter((comment) => sameReviewBot(comment.user.login, ctx.botLogin))
          .map((comment) => ({ path: comment.path, body: comment.body })),
      ),
    (error: unknown): TeamPattern[] => {
      log(`Team memory is unavailable: ${messageOf(error)}`)
      return []
    },
  )
  const scan: { error?: string } = {}
  const month =
    config.maxCostUsdPerMonth > 0
      ? await monthSpend(gh, ctx, state, deps.now()).catch((error: unknown) => {
          scan.error = messageOf(error)
          log(`The month's review spend could not be read: ${scan.error}`)
          return undefined
        })
      : undefined

  const upsertSticky = async (body: string) => {
    const text = clean(body)
    if (stickyId !== undefined) await gh.updateIssueComment(stickyId, text)
    else {
      const created = await gh.createIssueComment(ctx.pr, text)
      stickyId = created.id
      stickyUrl = created.html_url || undefined
    }
    stickyBody = text
    posted.summaryId = stickyId
  }
  const target: ReactionTarget | undefined = ctx.comment ? { id: ctx.comment.id, kind: ctx.comment.kind } : undefined
  const clearEyes = async () => {
    if (target) await gh.unreact(target, "eyes").catch((error) => log(`Could not remove the eyes: ${messageOf(error)}`))
  }
  const finishCommand = async () => {
    if (!target) return
    await clearEyes()
    await gh.react(target, "+1").catch((error) => log(`Could not react: ${messageOf(error)}`))
  }

  // 4. Files and skips. Sizes come from listFiles and path rules, before any git fetch.
  const listed = await gh.listFiles(ctx.pr)
  // listFiles shows the pull request as it is now. It anchors findings only if the head has not moved since getPull;
  // otherwise its lines would be those of a later commit.
  const listedHead = (await gh.getPull(ctx.pr)).head.sha
  const counted = listed.filter((file) => !ignored(file.filename))
  const size = {
    files: counted.length,
    changedLines: counted.reduce((sum, file) => sum + file.additions + file.deletions, 0),
  }
  const decision = decideSkip({
    trigger: ctx.trigger,
    full,
    config,
    state,
    head,
    pr: {
      draft: pull.draft,
      author: pull.author,
      labels: pull.labels,
      headBranch: pull.head.ref,
      fork: pull.fork,
    },
    size,
    monthCostUsd: month?.costUsd,
  })
  if (decision.skip && decision.notify === "none") {
    log(`Skipped: ${decision.reason}.`)
    return finish(0)
  }
  // The job fails either way; without a note the pull request shows only a red check, and a person who commented
  // `/vector review` sees nothing at all. The note is best effort, and wins over a skip's note: it names what to fix.
  const cannotStart = async (message: string) => {
    await upsertSticky(
      buildNoteBody({
        previous: stickyBody,
        note: noteCannotStart(message),
        state: sticky ? readState(sticky.body) : undefined,
      }),
    ).catch((error: unknown) => log(`Could not post why the review cannot start: ${messageOf(error)}`))
    return configError(message)
  }
  if (model instanceof Error) return cannotStart(model.message)
  if (triage instanceof Error) return cannotStart(triage.message)
  if (decision.skip) {
    log(`Skipped: ${decision.reason}.`)
    if (decision.notify === "summary") {
      const note = skipNote(decision.reason)
      if (note)
        await upsertSticky(
          buildNoteBody({ previous: stickyBody, note, state: { ...(state ?? emptyState()), notedHead: head } }),
        )
    }
    if (decision.notify === "reply") {
      if (target) await gh.createIssueComment(ctx.pr, clean(noteAlreadyReviewed(head)))
      else log(noteAlreadyReviewed(head))
    }
    return finish(0)
  }
  // With a monthly limit set, an automatic review never runs uncapped: when the month's spend could not be read it
  // waits for a command, and says so once per commit.
  if (scan.error !== undefined && ctx.trigger === "auto") {
    log("Skipped: the month's review spend could not be read, and a monthly limit is set.")
    if (state?.notedHead !== head)
      await upsertSticky(
        buildNoteBody({
          previous: stickyBody,
          note: noteMonthUnknown({ maxUsd: config.maxCostUsdPerMonth, error: scan.error }),
          state: { ...(state ?? emptyState()), notedHead: head },
        }),
      )
    return finish(0)
  }

  function skipNote(reason: SkipReason): string | undefined {
    if (reason === "month-budget")
      return noteMonthBudget({
        maxUsd: config.maxCostUsdPerMonth,
        spentUsd: month?.costUsd ?? 0,
        reviews: month?.pulls ?? 0,
        month: monthKey(deps.now()),
      })
    if (reason === "pr-budget")
      return notePrBudget({
        maxUsd: config.maxCostUsdPerPr,
        spentUsd: state?.costUsd ?? 0,
        reviews: state?.reviews ?? 0,
      })
    if (reason === "nothing-to-review") return noteNothingToReview()
    if (reason === "too-large") {
      const chars = Math.min(
        counted.reduce((sum, file) => sum + (file.patch?.length ?? 0), 0),
        diffBudgetChars((model as ResolvedModel).context, config.maxDiffChars),
      )
      const price = (model as ResolvedModel).price
      return noteTooLarge({
        files: size.files,
        lines: size.changedLines,
        maxFiles: config.maxFiles,
        maxLines: config.maxChangedLines,
        ...(price
          ? {
              estimate: estimateCostUsd({
                promptTokens: Math.ceil(chars / 3.5) + PROMPT_OVERHEAD_TOKENS,
                maxSteps: config.maxSteps,
                price,
              }),
            }
          : {}),
      })
    }
    return undefined
  }

  // 5. Start: the sticky says a review is under way, and holds the state checkpoints write to.
  const run = deps.nonce?.() ?? crypto.randomUUID().replaceAll("-", "").slice(0, 8)
  const startedAt = deps.now()
  const before = stickyBody
  const running = (costUsd: number): ReviewState => ({
    ...(state ?? emptyState()),
    inflight: { run, head, at: startedAt, costUsd },
  })
  await upsertSticky(buildRunningBody({ previous: before, head, startedAt, state: running(0) }))
  if (target) await gh.react(target, "eyes").catch((error) => log(`Could not react: ${messageOf(error)}`))
  let spent: ReviewCost | undefined

  try {
    // 6. Objects: exactly the commits this review needs.
    const since = state?.head && state.head !== head ? state.head : undefined
    const fetched = await deps.git.fetch({
      base,
      head,
      ...(since ? { since, old: { head: since, ...(state?.base ? { mergeBase: state.base } : {}) } } : {}),
      ...(trust === "untrusted" ? { pr: ctx.pr } : {}),
    })
    if (fetched.head !== head) {
      log(`The pull request moved to ${short(fetched.head)} before it was fetched; reviewing that commit.`)
      head = fetched.head
    }

    // 7. Range.
    const plan = await deps.git.planRange({
      head,
      base,
      ...(state ? { state } : {}),
      full,
      incremental: config.incremental,
      compare: (a, b) => gh.compare(a, b),
      ignored,
    })
    const sinceChanges = since ? await deps.git.diff(since, head) : undefined
    const fromState = state ? priorFromState(state, sinceChanges) : []
    if (plan.mode === "carry") {
      const next = nextState(state, { head, base: plan.mergeBase, mode: "carry", now: deps.now(), prior: fromState })
      await upsertSticky(buildNoteBody({ previous: before, note: noteRebase(pull.base.ref), state: next }))
      await finishCommand()
      return finish(0)
    }
    const mode = plan.mode === "incremental" ? "incremental" : "full"

    // 8. Diffs and context. A generated header counts only when the base agrees.
    const notes: string[] = []
    const classified = classifyFiles(plan.files, { config, attributes })
    const skipped = [...classified.skipped]
    const files: DiffFile[] = []
    const generated: string[] = []
    for (const file of classified.review) {
      const text = file.status === "deleted" ? undefined : await deps.git.show(head, file.path)
      if (text === undefined || !hasGeneratedHeader(text)) {
        files.push(file)
        continue
      }
      const baseText =
        file.status === "added" ? undefined : await deps.git.show(plan.mergeBase, file.oldPath ?? file.path)
      const header = generatedHeaderDecision({
        path: file.path,
        headText: text,
        baseText,
        attributes,
        ignoreDefaults: config.ignoreDefaults,
      })
      if (header.skip) skipped.push({ path: file.path, reason: "generated" })
      else {
        files.push(file)
        if (header.reviewedAnyway) generated.push(file.path)
      }
    }
    const generatedNote = noteGeneratedHeaders(generated)
    if (generatedNote) notes.push(generatedNote)
    if (!files.length) {
      const next = nextState(state, {
        head,
        base: plan.mergeBase,
        mode,
        now: deps.now(),
        prior: fromState,
        notedHead: head,
      })
      await upsertSticky(buildNoteBody({ previous: before, note: noteNothingToReview(), state: next }))
      await finishCommand()
      return finish(0)
    }
    const headFiles =
      trust === "untrusted" ? await deps.git.headFiles({ mergeBase: plan.mergeBase, head, files }) : undefined
    const gathered = await deps.git.context({
      base: plan.mergeBase,
      head,
      files,
      ignore: ignoreGlobs(config),
      ignored,
      instructions: (path) => gh.getContent(path, base),
    })

    // Earlier findings: the state's summary findings plus inline findings rebuilt from Vector's own comments, so a
    // run that died while posting causes no duplicates.
    const findingThreads = new Map<number, { thread: ThreadNode; body: string }>()
    const fromComments: PriorFinding[] = []
    for (const thread of threads) {
      const root = thread.comments[0]
      if (!root || !sameReviewBot(root.author, ctx.botLogin)) continue
      const prior = priorFromComment({
        id: root.id,
        body: root.body,
        path: thread.path,
        line: thread.line,
        ...(thread.side ? { side: thread.side } : {}),
        threadId: thread.id,
      })
      if (!prior) continue
      fromComments.push(prior)
      findingThreads.set(root.id, { thread, body: root.body })
    }
    // The other places a comment names are lines of the commit it was raised on, so they follow the code from there.
    const moves = new Map<string, Promise<DiffFile[] | undefined>>()
    const followed = await Promise.all(
      fromComments.map(async (prior) => {
        if (!prior.also?.length || head.startsWith(prior.sha)) return prior
        if (!moves.has(prior.sha))
          moves.set(
            prior.sha,
            deps.git.diff(prior.sha, head).catch(() => undefined),
          )
        const changes = await moves.get(prior.sha)
        return changes ? followAlso(prior, changes) : prior
      }),
    )
    const merged = mergePrior(fromState, followed)
    const open = merged.filter((prior) => prior.status === "open")
    const infos = new Map<number, ThreadInfo>()
    const logins = new Set<string>()
    for (const prior of open) {
      const entry = prior.commentId === undefined ? undefined : findingThreads.get(prior.commentId)
      if (!entry || prior.commentId === undefined) continue
      const [root, ...rest] = entry.thread.comments
      const info: ThreadInfo = {
        resolved: entry.thread.isResolved,
        ...(entry.thread.resolvedBy ? { resolvedBy: entry.thread.resolvedBy } : {}),
        reactions: root?.reactions ?? [],
        replies: rest
          .filter((reply) => !sameReviewBot(reply.author, ctx.botLogin))
          .map((reply) => ({ author: reply.author, body: reply.body })),
      }
      infos.set(prior.commentId, info)
      if (info.resolvedBy) logins.add(info.resolvedBy)
      for (const reaction of info.reactions ?? [])
        if (isThumbsDown(reaction.content)) reaction.users.forEach((user) => logins.add(user))
      for (const reply of info.replies ?? []) logins.add(reply.author)
    }
    const writers = new Map(
      await Promise.all(
        [...logins].map(
          async (login) => [login.toLowerCase(), WRITE_PERMISSIONS.includes(await gh.permissionOf(login))] as const,
        ),
      ),
    )
    // Each open finding's file at this head, under the path a rename since the last review gave it. null only when the
    // file is gone: one that exists but cannot be read as text (a NUL byte) is not a deletion.
    const known = await deps.git.knownPath(head)
    const renamed = (file: string) =>
      sinceChanges?.find((change) => change.status === "renamed" && change.oldPath === file)?.path ?? file
    const texts = new Map(
      await Promise.all(
        [...new Set(open.map((prior) => prior.path))].map(async (file) => {
          const current = renamed(file)
          const text = await deps.git.show(head, current)
          if (text !== undefined) return [file, text] as const
          return [file, (await known(current)) ? undefined : null] as const
        }),
      ),
    )
    const classify = (prior: PriorFinding, modelStatus?: { status: "fixed" | "open"; reason: string }) => {
      const thread = prior.commentId === undefined ? undefined : infos.get(prior.commentId)
      const headText = texts.get(prior.path)
      return classifyPrior(prior, {
        head,
        ...(sinceChanges ? { changes: sinceChanges } : {}),
        ...(headText !== undefined ? { headText } : {}),
        ...(modelStatus ? { modelStatus } : {}),
        ...(thread ? { thread } : {}),
        isWriter: (login) => writers.get(login.toLowerCase()) ?? false,
        prAuthor: pull.author,
        // A `@<slug> dismiss` reply the route job accepted is read with the same mentions here.
        ...(ctx.mentions ? { mentions: ctx.mentions } : {}),
      })
    }
    const prior: ClassifiedPrior[] = merged.map((entry) => classify(entry))

    // 9. Run. The anchors are GitHub's own diff when it is of the reviewed commit, otherwise the local one.
    const input: RunInput = {
      directory: ctx.directory,
      trigger: ctx.trigger,
      trust,
      base: plan.mergeBase,
      head,
      ...(plan.since ? { since: plan.since } : {}),
      mode,
      files,
      anchors: pull.head.sha === head && listedHead === head ? fromGitHubFiles(listed) : plan.files,
      ...(plan.focus ? { focus: plan.focus } : {}),
      skipped,
      ...(headFiles ? { headFiles } : {}),
      context: { ...gathered, teamDismissed: team, humanComments: humans },
      pr: { number: pull.number, title: pull.title, body: pull.body, author: pull.author },
      prior,
      rules: rulesForPaths(
        rules,
        files.map((file) => file.path),
        config.paths,
      ),
      config,
      model,
      ...(deps.cloud ? { checks: false, stopSignal: deps.cloud.signal } : {}),
      ...(triage ? { triage } : {}),
      knownPath: known,
      onProgress: (event) =>
        log(
          event.type === "cost"
            ? deps.cloud || event.kind === "codium" || (event.codium && event.costUsd === 0)
              ? "Spent: Codium"
              : `Spent $${event.costUsd.toFixed(4)}${event.codium ? " + Codium" : ""}`
            : `${event.name}: ${event.status}`,
        ),
      onCheckpoint: async (cost) => {
        spent = cost
        await upsertSticky(buildRunningBody({ previous: before, head, startedAt, state: running(cost.costUsd) })).catch(
          (error) => log(`Could not save a checkpoint: ${messageOf(error)}`),
        )
      },
      baseRef: pull.base.ref,
      rulesSource: "base branch",
      inlinePosted: state?.inlinePosted ?? 0,
    }
    const outcome = await deps.runReview(input)
    if (outcome.cost) spent = outcome.cost

    // No specialist produced output: the head stays where it was, so a re-run retries.
    const reviewers = outcome.specialists.filter((entry) => entry.name !== "verify")
    if (reviewers.length && reviewers.every((entry) => entry.status === "failed")) {
      const stopped = deps.cloud?.stopped()
      const detail = deps.cloud
        ? stopped
          ? stoppedLine(stopped)
          : "Codium is unavailable right now."
        : (reviewers.find((entry) => entry.detail)?.detail ?? "the model returned no review")
      log(`The review failed: ${detail}`)
      const next = nextState(state, {
        head,
        base: plan.mergeBase,
        mode,
        now: deps.now(),
        failed: true,
        ...(outcome.cost ? { cost: outcome.cost } : {}),
      })
      await upsertSticky(buildNoteBody({ previous: before, note: noteFailed(detail, outcome.cost), state: next }))
      await clearEyes()
      return finish(0)
    }

    // 10. Anchors, and whether the head moved. commit_id is always the reviewed head, so a head that moved means the
    // anchors are checked again against the diff of the commit that was reviewed.
    let selection = outcome.selection
    const fresh = await gh.getPull(ctx.pr)
    if (fresh.head.sha !== head) {
      notes.push(noteSuperseded(fresh.head.sha))
      const index = buildAnchorIndex(plan.files)
      const inline: PlacedFinding[] = []
      const outside = [...selection.outsideDiff]
      for (const finding of selection.inline) {
        const resolved = resolveAnchor(index, finding)
        if (!resolved.ok) {
          outside.push({ ...unplace(finding), reason: resolved.reason })
          continue
        }
        const allowed =
          finding.suggestionAllowed &&
          finding.suggestion !== undefined &&
          suggestionAllowed(index, resolved.anchor, finding.suggestion, { trust, verified: finding.verified })
        inline.push({ ...finding, anchor: resolved.anchor, suggestionAllowed: allowed })
      }
      selection = { ...selection, inline, outsideDiff: outside }
    }

    // The model's word that an earlier finding is fixed counts only when the code near it changed.
    const statuses = new Map((outcome.report.priorStatus ?? []).map((entry) => [entry.id, entry]))
    const settled: ClassifiedPrior[] = prior.map((entry) => {
      const status = statuses.get(entry.id)
      return entry.status === "open" && status?.status === "fixed" ? classify(entry, status) : entry
    })
    const newlyFixed = settled.filter((entry, index) => entry.status === "fixed" && prior[index]?.status === "open")
    if (newlyFixed.length) {
      const ids = new Set(newlyFixed.map((entry) => entry.id))
      selection = {
        ...selection,
        stillOpen: selection.stillOpen.filter((entry) => !ids.has(entry.id)),
        fixed: [...selection.fixed, ...newlyFixed],
      }
    }

    // 11.1 One review, only new inline findings. A 422 splits the batch in halves, so one bad anchor never drops the
    // others; a single refused comment moves to the summary.
    const moved: PlacedFinding[] = []
    let commitGone = false
    let postedCount = 0
    const post = async (payload: CreateReviewPayload, findings: PlacedFinding[]): Promise<void> => {
      if (!payload.comments.length) return
      try {
        const created = await gh.createReview(ctx.pr, payload)
        posted.reviewIds.push(created.id)
        postedCount += payload.comments.length
      } catch (error) {
        if (statusOf(error) !== 422) throw error
        // A refusal of the commit itself (it left the pull request after a force-push) is the same for every half.
        if (commitRefused(error)) {
          log(`GitHub refused the review: ${short(head)} is no longer part of the pull request.`)
          commitGone = true
          moved.push(...findings)
          return
        }
        const [only] = payload.comments
        if (payload.comments.length === 1 && only) {
          log(`GitHub refused the comment on ${only.path}:${only.line}; it is listed in the summary instead.`)
          moved.push(...findings)
          return
        }
        const [first, second] = splitHalves(payload)
        await post(first, findings.slice(0, first.comments.length))
        await post({ ...second, body: clean(second.body) }, findings.slice(first.comments.length))
      }
    }
    if (selection.inline.length) {
      const payload = buildCreateReviewPayload({
        head,
        inline: selection.inline,
        body: buildReviewBody({ head, run, inline: selection.inline, ...(stickyUrl ? { summaryUrl: stickyUrl } : {}) }),
        suggestions: config.suggestions,
        trust,
        leads: inlineLeads(selection, settled),
        repo: repoRef,
      })
      await post(
        {
          ...payload,
          body: clean(payload.body),
          comments: payload.comments.map((comment) => ({ ...comment, body: clean(comment.body) })),
        },
        selection.inline,
      )
    }
    if (moved.length) {
      const ids = new Set(moved.map((finding) => finding.id))
      selection = {
        ...selection,
        inline: selection.inline.filter((finding) => !ids.has(finding.id)),
        outsideDiff: [
          ...selection.outsideDiff,
          ...moved.map((finding) => ({ ...unplace(finding), reason: "line-outside-diff" as const })),
        ],
      }
      notes.push(commitGone ? noteCommitGone(head, moved.length) : noteMoved(moved.length))
    }

    // 11.2 Link finding ids to their new comments.
    const commentUrls: Record<string, string> = {}
    for (const id of posted.reviewIds) {
      const list = await gh.listCommentsForReview(ctx.pr, id).catch(() => [])
      for (const comment of list) {
        const marker = parseFindingMarker(comment.body)
        if (marker) commentUrls[marker.id] = `${fresh.url}#discussion_r${comment.id}`
      }
    }

    // 11.3 and 11.4: fixed findings are edited and their threads resolved, which sends no notification; dismissed
    // ones get the dismissed marker; one raised to blocking marks the comment it replaced superseded.
    // The review is posted, so these are best-effort: a comment someone deleted, or one GitHub will not let Vector
    // edit, is logged and never turns a posted review into a failed run that would review the commit again.
    const bestEffort = async (what: string, action: () => Promise<unknown>) => {
      try {
        await action()
      } catch (error) {
        log(`Could not ${what}: ${messageOf(error)}`)
      }
    }
    for (const [index, entry] of settled.entries()) {
      const raw = merged[index]
      const commentId = entry.commentId
      if (entry.where !== "inline" || raw?.status !== "open" || commentId === undefined) continue
      const source = findingThreads.get(commentId)
      if (!source) continue
      if (entry.status === "fixed") {
        await bestEffort(`mark the comment on ${entry.path} fixed`, () =>
          gh.updateReviewComment(commentId, clean(buildFixedEdit(source.body, head))),
        )
        if (!source.thread.isResolved && !(await gh.resolveThread(source.thread.id)))
          log(`The thread on ${entry.path} stays open; its comment is marked fixed.`)
        if (config.replyOnFix)
          await bestEffort(`reply on ${entry.path}`, () =>
            gh.replyToReviewComment(ctx.pr, commentId, `Fixed in \`${short(head)}\`.`),
          )
      } else if (entry.status === "dismissed")
        await bestEffort(`mark the comment on ${entry.path} dismissed`, () =>
          gh.updateReviewComment(commentId, clean(setFindingStatus(source.body, "dismissed"))),
        )
    }
    // Only a raised finding that is now on a line supersedes the comment it continues.
    const onLines = new Set(selection.inline.map((finding) => finding.id))
    for (const raised of selection.raised) {
      const entry = settled.find((item) => item.id === raised.id && item.where === "inline")
      const commentId = entry?.commentId
      const source = commentId === undefined ? undefined : findingThreads.get(commentId)
      if (!entry || commentId === undefined || !source || !onLines.has(raised.id)) continue
      await bestEffort(`mark the comment on ${entry.path} superseded`, () =>
        gh.updateReviewComment(commentId, clean(setFindingStatus(source.body, "outdated"))),
      )
    }

    // 11.5 The final summary, with the next state.
    const blockingOpen = [
      ...selection.inline,
      ...selection.overflow,
      ...selection.outsideDiff,
      ...selection.elsewhere,
      ...selection.stillOpen,
    ].some((finding) => finding.severity === "blocking")
    selection = {
      ...selection,
      risk: computeRisk({
        findings: [
          ...selection.inline,
          ...selection.overflow,
          ...selection.outsideDiff,
          ...selection.elsewhere,
          ...selection.nits,
          ...selection.stillOpen,
        ],
        sensitiveChanged: files.some((file) => isSensitivePath(file.path)),
        changedLines: files.reduce((sum, file) => sum + file.additions + file.deletions, 0),
        modelRisk: outcome.report.risk,
      }),
    }
    const next = nextState(state, {
      head,
      base: plan.mergeBase,
      mode,
      now: deps.now(),
      unreviewed: outcome.unreviewed,
      ...(outcome.cost ? { cost: outcome.cost } : {}),
      prior: settled,
      selection,
      moved: moved.map(unplace),
      posted: postedCount,
    })
    const banners: string[] = []
    const stopped = deps.cloud?.stopped()
    if (stopped) banners.push(stoppedLine(stopped), ...(stopped.advice ? [stopped.advice] : []))
    else if (outcome.partial) {
      const detail = outcome.specialists.find((entry) => entry.status === "failed")?.detail
      banners.push(
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
      )
    }
    if (plan.forcePushed && mode === "incremental" && plan.since)
      notes.unshift(noteForcePush(plan.since, new Set((plan.focus ?? []).map((hunk) => hunk.path)).size))
    if (selection.overflow.length) {
      const prCap = (state?.inlinePosted ?? 0) + postedCount >= config.maxCommentsPerPr
      notes.push(prCap ? noteInlineCap(config.maxCommentsPerPr, "pr") : noteInlineCap(config.maxComments, "review"))
    }
    const summarySince = plan.since && plan.since !== head ? plan.since : since
    await upsertSticky(
      buildSummaryBody({
        repo: repoRef,
        pr: ctx.pr,
        head,
        baseRef: pull.base.ref,
        ...(summarySince ? { since: summarySince } : {}),
        mode,
        report: outcome.report,
        selection,
        files: files.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions })),
        skipped,
        banners,
        notes: [...notes, ...outcome.notes],
        ...(outcome.cost ? { cost: outcome.cost } : {}),
        durationMs: outcome.durationMs,
        prTotal: { costUsd: next.costUsd, reviews: next.reviews, codiumReviews: next.codiumReviews },
        ...(ctx.runUrl ? { runUrl: ctx.runUrl } : {}),
        commentUrls,
        state: next,
      }),
    )
    await finishCommand()

    if (config.failOn === "blocking" && blockingOpen)
      return finish(1, 'Blocking findings are open, and failOn is "blocking".')
    return finish(0)
  } catch (error) {
    // The model or a tool failed. The state does not advance, so a re-run retries; the job still exits 0.
    const message = deps.cloud ? "Codium is unavailable right now." : messageOf(error)
    log(`The review failed: ${message}`)
    const next = nextState(state, {
      head,
      base,
      mode: "full",
      now: deps.now(),
      failed: true,
      ...(spent ? { cost: spent } : {}),
    })
    await upsertSticky(buildNoteBody({ previous: before, note: noteFailed(message, spent), state: next })).catch(
      (cause) => log(`Could not post the failure: ${messageOf(cause)}`),
    )
    await clearEyes()
    return finish(0)
  }
}

// Prints every write as JSON and sends none. Reads still go to GitHub.
export function dryRunGitHub(gh: ReviewGitHub, print: (line: string) => void): ReviewGitHub {
  let id = 0
  const write = <T>(name: string, args: Record<string, unknown>, result: T): Promise<T> => {
    print(JSON.stringify({ write: name, ...args }, null, 2))
    return Promise.resolve(result)
  }
  return {
    ...gh,
    listCommentsForReview: (n, reviewId) =>
      reviewId < 0 ? Promise.resolve([]) : gh.listCommentsForReview(n, reviewId),
    createReview: (n, payload) => write("createReview", { pr: n, payload }, { id: --id }),
    createIssueComment: (n, body) => write("createIssueComment", { pr: n, body }, { id: --id, html_url: "" }),
    updateIssueComment: (commentId, body) => write("updateIssueComment", { id: commentId, body }, undefined),
    updateReviewComment: (commentId, body) => write("updateReviewComment", { id: commentId, body }, undefined),
    replyToReviewComment: (n, commentId, body) =>
      write("replyToReviewComment", { pr: n, id: commentId, body }, undefined),
    resolveThread: (threadId) => write("resolveThread", { threadId }, true),
    react: (reaction, content) => write("react", { target: reaction, content }, undefined),
    unreact: (reaction, content) => write("unreact", { target: reaction, content }, undefined),
  }
}

// The real git side: the engine's ReviewSource and ReviewContext over the workflow's checkout.
export function createReviewGit(input: {
  directory: string
  run: <A, E>(effect: Effect.Effect<A, E, Git.Service>) => Promise<A>
  token?: string
  server?: string
  appGit?: Awaited<ReturnType<typeof prepareGithubGit>>
}): ReviewGit {
  const { directory, run } = input
  const auth =
    input.appGit?.env ??
    (input.token
      ? {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `http.${(input.server ?? "https://github.com").replace(/\/+$/, "")}/.extraheader`,
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${input.token}`).toString("base64")}`,
        }
      : undefined)
  const git = (args: string[], env?: Record<string, string>) =>
    run(Git.Service.use((service) => service.run(args, { cwd: directory, ...(env ? { env } : {}) })))
  const has = async (sha: string) =>
    !!sha && !sha.startsWith("-") && (await git(["cat-file", "-e", `${sha}^{commit}`])).exitCode === 0
  // The merge-base can be older than the 50 commits of base history the fetch brings; it is fetched on its own.
  const ensure = async (sha: string) => {
    if (!sha || sha.startsWith("-") || (await has(sha))) return
    await input.appGit?.verify()
    await git(["fetch", "--no-tags", "--no-recurse-submodules", "--depth=1", "origin", sha], auth)
  }
  return {
    head: async () => (await git(["rev-parse", "HEAD"])).text().trim(),
    fetch: async (request) => {
      await input.appGit?.verify()
      return await run(
        ReviewSource.ensureObjects({
          directory,
          ...request,
          ...(input.token ? { token: input.token } : {}),
          ...(input.server ? { server: input.server } : {}),
          ...(input.appGit ? { authEnvironment: input.appGit.env } : {}),
        }),
      )
    },
    planRange: (request) =>
      run(
        ReviewSource.planRange({
          directory,
          head: request.head,
          base: request.base,
          ...(request.state ? { state: request.state } : {}),
          full: request.full,
          incremental: request.incremental,
          ignored: request.ignored,
          // A refused compare (a 404 for an old head a force-push orphaned) is an error planRange can act on.
          compare: (a, b) =>
            Effect.tryPromise({
              try: async () => {
                const compared = await request.compare(a, b)
                if (a === request.base && b === request.head) await ensure(compared.mergeBase)
                return compared
              },
              catch: (error) =>
                new ReviewGitError({
                  message: `GitHub could not compare ${short(a)}...${short(b)}: ${messageOf(error)}`,
                }),
            }),
        }),
      ),
    diff: async (from, to) =>
      (await has(from)) && (await has(to))
        ? run(ReviewSource.prDiff({ directory, mergeBase: from, head: to }))
        : undefined,
    show: async (rev, path) => {
      if (rev.startsWith("-")) return undefined
      const result = await git(["cat-file", "blob", `${rev}:${path}`])
      return result.exitCode === 0 && !result.stdout.includes(0) ? result.text() : undefined
    },
    headFiles: (request) => run(ReviewSource.headFiles({ directory, ...request })),
    context: (request) =>
      run(
        ReviewContext.gather({
          directory,
          base: request.base,
          head: request.head,
          files: request.files,
          ignore: request.ignore,
          ignored: request.ignored,
          instructions: (path) => Effect.promise(() => request.instructions(path).catch(() => undefined)),
        }),
      ),
    knownPath: (rev) => run(ReviewSource.knownPath({ directory, rev })),
  }
}

type ReviewArguments = {
  event?: string
  pr?: number
  dryRun?: boolean
}

export const githubReview = Effect.fn("Cli.github.review")(function* (args: ReviewArguments) {
  if (process.env.VECTOR_MODE === "codium")
    return yield* withCodiumReview((cloud) => githubReviewJob(args, cloud), { env: process.env })
  return yield* githubReviewJob(args)
})

const githubReviewJob = Effect.fn("Cli.github.reviewJob")(function* (
  args: ReviewArguments,
  cloud?: CodiumReviewControl,
) {
  const instance = yield* InstanceRef
  if (!instance) return yield* Effect.die("InstanceRef not provided")
  const env = cloud ? { ...process.env, VECTOR_GITHUB_AUTH: "github", USE_GITHUB_TOKEN: "true" } : process.env
  const event = loadEvent(args.event, env)
  const repository = env["GITHUB_REPOSITORY"] || String(event.payload.repository?.full_name ?? "")
  const [owner, repo] = repository.split("/")
  if (!owner || !repo) return yield* fail("Set GITHUB_REPOSITORY to owner/repo, the repository to review.")
  // The command turns both on before the instance loads. In Actions a review never runs without them: the pull
  // request's own config and plugins would load next to the token and the provider keys.
  if (env["GITHUB_ACTIONS"] && !(isOn(env["VECTOR_PURE"]) && isOn(env["VECTOR_DISABLE_PROJECT_CONFIG"])))
    return yield* fail(
      "VECTOR_PURE and VECTOR_DISABLE_PROJECT_CONFIG must be set for a review in GitHub Actions. Run `vector github install` again to update the workflow.",
    )

  const mentions = mentionsFrom(env["MENTIONS"])
  const route = event.eventName ? routeGithubEvent(event, mentions) : undefined
  const routed = route?.job === "review" || route?.job === "control" ? route.pr : undefined
  const pr = args.pr ?? (Number(env["VECTOR_REVIEW_PR"]) || routed)
  if (!pr || !Number.isInteger(pr)) return yield* fail("No pull request to review: pass --pr or set VECTOR_REVIEW_PR.")
  const comment = route?.job === "review" || route?.job === "control" ? route.comment : commentOf(event)
  const automatic = event.eventName === "pull_request" || event.eventName === "workflow_dispatch"
  const trigger = route?.job === "review" ? route.trigger : automatic ? "auto" : "command"
  const eventHead =
    event.eventName === "pull_request" && event.payload.pull_request?.number === pr
      ? String(event.payload.pull_request.head?.sha ?? "")
      : ""
  const server = (env["GITHUB_SERVER_URL"] || "https://github.com").replace(/\/+$/, "")
  const expectedHead = env["VECTOR_REVIEW_REF"] || eventHead

  return yield* Effect.acquireUseRelease(
    Effect.tryPromise(async (signal) => {
      await verifyAppPullRequest({ repository, pr, env, signal })
      return await resolveGithubAuth({
        purpose: "review",
        repository,
        pullRequest: pr,
        env,
        ...(cloud ? { providedToken: GithubSecrets.credentials.githubToken() } : {}),
        signal,
        notice: console.log,
      })
    }),
    (auth) =>
      withGithubCallbacks((run) =>
        Effect.gen(function* () {
          const token = auth.token
          const botLogin = auth.source === "app" ? auth.botLogin : env["VECTOR_REVIEW_BOT"] || ACTIONS_BOT
          const appGit =
            auth.source === "app" || (appRequested(env) && env.GITHUB_ACTIONS === "true")
              ? yield* Effect.tryPromise(() =>
                  prepareGithubGit({
                    auth,
                    mask: setSecret,
                    identity: false,
                    run: (args, env) =>
                      run(Git.Service.use((service) => service.run(args, { cwd: instance.worktree, env }))),
                  }),
                )
              : undefined
          const { Review } = yield* Effect.promise(() => import("@/review/run"))
          const { ReviewModel } = yield* Effect.promise(() => import("@/review/model"))
          const log = (line: string) => console.log(cloud ? sanitizeActionsLog(cloud.redact(line)) : line)
          const context: ReviewJobContext = {
            owner,
            repo,
            pr,
            trigger,
            full: route?.job === "review" ? route.full : false,
            ...(comment ? { comment } : {}),
            ...(expectedHead ? { expectedHead } : {}),
            directory: instance.directory,
            botLogin,
            ...(env["GITHUB_RUN_ID"]
              ? { runUrl: `${server}/${owner}/${repo}/actions/runs/${env["GITHUB_RUN_ID"]}` }
              : {}),
            env,
            mentions,
          }
          const result = yield* Effect.promise((signal) =>
            executeReviewJob(context, {
              gh: createReviewGitHub({
                token,
                signal,
                owner,
                repo,
                botLogin,
                ...(env["GITHUB_API_URL"] ? { baseUrl: env["GITHUB_API_URL"] } : {}),
                log,
                // Nobody answers questions in a review job: what repeats the owner's memory is dropped and counted,
                // and a fork's review links and embeds only on GitHub.
                check: (parts, pull) =>
                  run(SessionPosting.headless({ parts: [...parts], typed: false, untrusted: pull.untrusted, log })),
              }),
              git: createReviewGit({
                directory: instance.worktree,
                run,
                token,
                server,
                appGit,
              }),
              runReview: (input) => run(Review.run(input)),
              resolveModel: async (input) => {
                if (cloud) {
                  const { Provider } = await import("@/provider/provider")
                  const providers = await run(Provider.Service.use((provider) => provider.list()))
                  const selected = agentModel({ mode: "codium", model: env.MODEL, providers })
                  const model = await run(
                    Provider.Service.use((provider) => provider.getModel(selected.providerID, selected.modelID)),
                  )
                  return { ...selected, context: model.limit.context, costKind: "codium" as const }
                }
                const exit = await run(Effect.exit(ReviewModel.resolveReviewModel(input)))
                if (Exit.isSuccess(exit)) return exit.value
                throw new Error(Cause.prettyErrors(exit.cause)[0]?.message ?? "The review model could not be resolved.")
              },
              log,
              now: Date.now,
              ...(cloud ? { cloud } : {}),
              ...(args.dryRun ? { dryRun: true } : {}),
            }),
          )
          cloud?.outcome(cloud.stopped() ? "draft" : result.exitCode === 0 ? "no-changes" : "failed")
          if (result.exitCode !== 0) return yield* fail(result.error ?? "The review job failed.")
        }),
      ),
    (auth) =>
      Effect.promise(() =>
        auth.dispose().catch(() => {
          process.exitCode = 1
          console.error("Vector could not revoke its GitHub App credential. It expires automatically within one hour.")
        }),
      ),
  ).pipe(
    Effect.catchTag("UnknownError", (error) =>
      Effect.fail(
        new CliError({
          message: cloud
            ? "Codium is unavailable right now."
            : error.cause instanceof Error
              ? error.cause.message
              : "GitHub App authentication failed.",
          exitCode: 1,
        }),
      ),
    ),
    withGithubSignals,
  )
})

// The Actions event, or a mock one passed with --event.
function loadEvent(mock: string | undefined, env: Record<string, string | undefined>): RouteEvent {
  if (mock) {
    const parsed = JSON.parse(mock) as Partial<RouteEvent>
    return { eventName: String(parsed.eventName ?? ""), payload: parsed.payload ?? {} }
  }
  const file = env["GITHUB_EVENT_PATH"]
  if (!file) return { eventName: env["GITHUB_EVENT_NAME"] ?? "", payload: {} }
  return { eventName: env["GITHUB_EVENT_NAME"] ?? "", payload: JSON.parse(readFileSync(file, "utf8")) }
}

function commentOf(event: RouteEvent): RouteComment | undefined {
  const comment = event.payload.comment
  if (!comment || (event.eventName !== "issue_comment" && event.eventName !== "pull_request_review_comment"))
    return undefined
  return {
    id: comment.id,
    kind: event.eventName === "issue_comment" ? "issue" : "review",
    author: String(comment.user?.login ?? ""),
    body: String(comment.body ?? ""),
  }
}

async function firstContent(gh: ReviewGitHub, paths: readonly string[], ref: string) {
  for (const path of paths) {
    const text = await gh.getContent(path, ref)
    if (text !== undefined) return text
  }
  return undefined
}

// A run that died after a checkpoint still spent money: its cost joins the totals before this run starts.
function foldInflight(state: ReviewState | undefined): ReviewState | undefined {
  if (!state?.inflight) return state
  const { inflight, ...rest } = state
  if (!(inflight.costUsd > 0)) return rest
  const key = monthKey(inflight.at)
  return {
    ...rest,
    costUsd: money(rest.costUsd + inflight.costUsd),
    month: { key, costUsd: money((rest.month?.key === key ? rest.month.costUsd : 0) + inflight.costUsd) },
  }
}

// The repository's review spend this month: the state of every bot sticky updated this month, the oldest per pull
// request, plus this pull request's own. Best-effort: very busy repositories have more comments than it reads.
async function monthSpend(gh: ReviewGitHub, ctx: ReviewJobContext, state: ReviewState | undefined, now: number) {
  const key = monthKey(now)
  const oldest = new Map<number, IssueComment>()
  for (const comment of await gh.listRepoIssueCommentsSince(`${key}-01T00:00:00Z`, MONTH_PAGES)) {
    if (comment.issue === undefined || comment.issue === ctx.pr) continue
    if (!sameReviewBot(comment.user.login, ctx.botLogin) || !comment.body.includes(SUMMARY_MARKER)) continue
    const known = oldest.get(comment.issue)
    if (!known || comment.id < known.id) oldest.set(comment.issue, comment)
  }
  let costUsd = 0
  let pulls = 0
  const states = [...[...oldest.values()].map((comment) => readState(comment.body)), state]
  for (const entry of states) {
    if (entry?.month?.key !== key || !(entry.month.costUsd > 0)) continue
    costUsd += entry.month.costUsd
    pulls++
  }
  return { costUsd: money(costUsd), pulls }
}

// Whether a 422 refuses the review's commit rather than one comment's line.
function commitRefused(error: unknown): boolean {
  const data = (error as { response?: { data?: { message?: unknown; errors?: unknown } } } | null)?.response?.data
  const errors: unknown[] = Array.isArray(data?.errors) ? data.errors : []
  const text = [
    messageOf(error),
    String(data?.message ?? ""),
    ...errors.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))),
  ].join(" ")
  return /commit_id|commit id|commit sha|no commit found|not part of (?:this|the) pull request/i.test(text)
}

function isOn(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true"
}

// The last 30 comments by people and other bots, for the prompt's <untrusted_comments>.
function humanComments(comments: IssueComment[], threads: ThreadNode[], bot: string): HumanComment[] {
  const out: (HumanComment & { at: string })[] = []
  for (const comment of comments) {
    if (sameReviewBot(comment.user.login, bot) || !comment.body.trim()) continue
    out.push({
      author: comment.user.login,
      ...(comment.association ? { association: comment.association } : {}),
      body: clip(comment.body, MAX_HUMAN_CHARS),
      at: comment.createdAt,
    })
  }
  for (const thread of threads)
    for (const comment of thread.comments) {
      if (sameReviewBot(comment.author, bot) || !comment.body.trim()) continue
      out.push({
        author: comment.author,
        ...(comment.association ? { association: comment.association } : {}),
        path: thread.path,
        ...(thread.line !== null ? { line: thread.line } : {}),
        body: clip(comment.body, MAX_HUMAN_CHARS),
        at: comment.createdAt ?? "",
      })
    }
  return out
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .slice(-MAX_HUMAN_COMMENTS)
    .map(({ at: _, ...comment }) => comment)
}

function sameReviewBot(author: string, bot: string) {
  return sameLogin(author, bot) || sameLogin(author, ACTIONS_BOT)
}

// Pathspecs for git grep: the default ignores and the repository's own.
function ignoreGlobs(config: ReviewConfig): string[] {
  const defaults = config.ignoreDefaults
    ? [...DEFAULT_IGNORES.map((rule) => rule.glob), ...LOCKFILES.map((name) => `**/${name}`)]
    : []
  return [...defaults, ...config.ignore]
}

function unplace(finding: PlacedFinding): Finding {
  const { anchor: _anchor, suggestionAllowed: _allowed, ...rest } = finding
  return rest
}

function isThumbsDown(content: string): boolean {
  const value = content.toLowerCase()
  return value === "thumbs_down" || value === "-1"
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error && "message" in error) return String(error.message)
  return String(error)
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…"
}

function money(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

function short(sha: string): string {
  return sha.slice(0, 7)
}
