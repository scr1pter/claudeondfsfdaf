#!/usr/bin/env bun
import { createHmac, randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { Option, Schema } from "effect"
import { fromGitHubFiles, parseUnifiedDiff, type GitHubPrFile } from "../../packages/core/src/review/diff"
import {
  DEFAULT_SLACK,
  proportion,
  severityGradient,
  type Proportion,
  type SeverityGradient,
} from "../../packages/core/src/review/eval"
import { spread } from "../../packages/core/src/review/eval-report"
import { classifyFiles } from "../../packages/core/src/review/ignore"
import {
  FIX_SUBJECT,
  REVERT_SUBJECT,
  RISK_BANDS,
  riskFeatures,
  riskOf,
  type RiskBand,
} from "../../packages/core/src/review/risk"
import {
  classifyPrior,
  encodeState,
  findSticky,
  MAX_STATE_CHARS,
  MAX_SUMMARY_FINDINGS,
  mergePrior,
  parseDismissalMarker,
  priorFromComment,
  priorFromState,
  readState,
  type ThreadInfo,
} from "../../packages/core/src/review/state"
import { BULK_RESOLVE_THREADS, type DismissalMarker } from "../../packages/core/src/review/team"
import {
  CATEGORIES,
  DEFAULT_REVIEW_CONFIG,
  SEVERITIES,
  type Category,
  type PriorFinding,
  type ReviewState,
  type Severity,
  type Side,
} from "../../packages/core/src/review/types"
import { UNTRUSTED_GIT, untrustedGitEnv } from "./dataset"
import { outsideRepository, REPO_ROOT } from "./paths"
import { OUTCOME_LEDGER_FILE, publicKey, PUBLIC_KEY_ENV, seal, unseal, type Sealed } from "./seal"

// The outcome ledger (VectorScope upgrade contract, addendum A, VS-46; the Now window's script, VS-46a). It reads what
// Vector's review job already recorded on merged pull requests (the sticky state and the finding markers) and what
// happened after the merge on the base branch (reverts, and follow-up fixes found by blame), and seals the result to
// the owner's key. It is not a second store: every marker is read with core review/state.ts, the job's own parsers.
//
// The owner runs it only after Q30 is answered, on a repository the owner nominates, with `gh` signed in and a full
// local clone. It makes no model call and has no key of its own. It reads GitHub with GET requests and two fixed
// GraphQL queries only, and git with read-only subcommands only. Nothing it collects is ever sent to a model, a tool,
// retrieval or Brain (I-13), and its results are internal (D12): the report claims no accuracy and compares nothing.
//
//   collect  Reads one repository's PRs merged in a window and writes only <out>/vectorscope-outcomes.sealed.json,
//            sealed to PUBLIC_KEY_ENV. It refuses to start in GitHub Actions, whose logs are public, and checks the
//            key before any read. It prints counts only.
//   open     On the owner's machine: unseals a ledger, refuses an expired one, and writes the report (and, with
//            --ledger, the ledger itself) to a directory outside every git work tree.

export const LEDGER_SCHEMA = "vectorscope-outcomes/1"
export const SEALED_LEDGER = "vectorscope-outcomes.sealed.json"
export const REPORT_FILE = "outcomes-report.md"
// A sealed ledger expires this many days after collection; the expiry is inside the sealed payload.
export const LEDGER_DAYS = 180
// A PR merged more recently than this before the clone's history ends (observedUntil, at most the collection time)
// gets no post-merge label: a later revert or fix may not have happened yet, or not reached the clone (bugbug's lag
// window [G2-9]).
export const MATURITY_DAYS = 90
export const LABEL_WINDOWS = [30, 90] as const
// A rate over settled findings is shown only from this many; smaller cells show the count and the interval.
export const MIN_SETTLED = 50
// The same floor for a rate over pull requests or reviews.
export const MIN_PULLS = 50
// Fewer settled human-stratum findings than this, on PRs merged in the 90 days before collection, gives the severity
// gradient only.
export const MIN_VOLUME = 200
// The band-separation check needs this many matured PRs with a band.
export const MIN_MATURED = 200
// How far after `now` a ledger's collection time may be and still open: the clock at collection against this one.
export const CLOCK_SKEW_MS = 300_000
// At most this many GitHub requests per collection. A PR that cannot be read within it is marked truncated.
export const MAX_API_CALLS = 4000
// A fix PR's label. Word-anchored, so "debug" does not match; "bugfix" and "bug-fix" do.
export const FIX_LABEL = /\b(?:bugs?|bug-?fix(?:e[sd])?|regressions?|hotfix(?:e[sd])?)\b/i
// A label that says the opposite, or only asks: "not a bug", "invalid", "won't fix", "duplicate", "bug?".
export const NOT_FIX_LABEL = /\bnot[\s_-]*a[\s_-]*bug\b|\binvalid\b|\bwon'?t[\s_-]*fix\b|\bwontfix\b|\bduplicate\b|\?/i
// The review job's WRITE_PERMISSIONS (packages/engine/src/cli/cmd/github.review-api.ts), held equal by a test.
export const WRITER_PERMISSIONS = ["admin", "maintain", "write"] as const
// The only git subcommands the ledger runs, each with the repository-local options it would read turned off.
export const READ_ONLY_GIT = ["rev-parse", "config", "log", "diff", "blame"] as const
// The review job posts as its App's bot or as github-actions[bot] (github.review.ts sameReviewBot). A --bot given
// without "[bot]" is read with it, so a User account named like the App is never taken for the job.
export const DEFAULT_BOTS = ["github-actions[bot]"]
// A reaction that acknowledges a finding. GraphQL spells them as uppercase enums, REST as lowercase or "+1".
export const POSITIVE_REACTIONS = ["thumbs_up", "+1", "heart", "hooray", "rocket"]

export const OUTCOMES = [
  "fixed-confirmed-by-thread", // marked fixed, and its thread resolved by a person who is neither a bot nor the PR author
  "fixed-self-resolved", // marked fixed, and its thread resolved by the PR author
  "fixed-model-only", // marked fixed with no person's resolve: the job resolves the thread itself, or it has none
  "acknowledged", // open at merge, with a reply that is not a dismissal or a positive reaction
  "dismissed-writer",
  "dismissed-author",
  "dismissed-unattributed", // marked dismissed, but no writer or author can be found among its signals now
  "open-at-merge",
  "outdated",
] as const
export type Outcome = (typeof OUTCOMES)[number]
// Outcomes a person decided. A model-only or self-resolved fix is not one: the sensitivity row counts them.
export const SETTLED: readonly Outcome[] = [
  "fixed-confirmed-by-thread",
  "acknowledged",
  "dismissed-writer",
  "dismissed-author",
]
const ANY_FIX: readonly Outcome[] = ["fixed-confirmed-by-thread", "fixed-self-resolved", "fixed-model-only"]
export const STRATA = ["human", "agent", "agent-signal", "bulk"] as const
export type Stratum = (typeof STRATA)[number]
export type PullStratum = Exclude<Stratum, "bulk">
export const RESOLVERS = ["author", "writer", "other", "bot"] as const
export type Resolver = (typeof RESOLVERS)[number]

const DAY = 86_400_000
const PER_PAGE = 100
const MAX_PULL_PAGES = 30
const MAX_LIST_PAGES = 30
const MAX_FILE_PAGES = 30 // GitHub lists at most 3,000 files of a PR
const MAX_COMMITS = 250 // and at most 250 commits
const MAX_THREAD_PAGES = 20 // as the review job
const MAX_EXTRA_COMMENT_PAGES = 50 // per PR, for threads with more than 50 comments
const PR_CALL_RESERVE = 200 // the most one PR's reads take before permission lookups, within the page caps
// pruneState drops summary findings until at most 60 remain and the encoded state fits 16,000 characters; a state at
// the cap or this close to the limit may have been pruned.
const PRUNE_MARGIN = 512
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
// The same regular expression the impact builder reads a clone's mode with (packages/engine/src/review/impact.ts).
const PARTIAL_CLONE = "^(extensions\\.partialclone|remote\\..*\\.promisor)$"
// git's C-quoting escapes (diff.ts ESCAPES).
const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 }
const FORBIDDEN_GIT_ARG = /^(?:--output\b|-o$|--ext-diff$|--textconv$|--show-signature$|--exec\b|--upload-pack\b)/
const GIT_HARDENING: Record<(typeof READ_ONLY_GIT)[number], readonly string[]> = {
  "rev-parse": [],
  config: [],
  log: ["--no-show-signature", "--no-ext-diff", "--no-textconv", "--no-color"],
  // The engine's reviewed-diff options (dataset.ts REVIEWED_DIFF): no external diff or textconv driver, no colour, no
  // relative paths and the standard prefixes, whatever the clone's own config says.
  diff: ["--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/"],
  blame: ["--no-textconv"],
}

const COMMENT_FIELDS = `fullDatabaseId body
        author { __typename login }
        reactionGroups { content reactors(first: 20) { nodes { __typename ... on Actor { login } } } }`

// The review job's thread query (github.review-api.ts), with originalLine for a thread GitHub marks outdated.
export const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine diffSide
          resolvedBy { __typename login }
          comments(first: 50) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} } }
        }
      }
    }
  }
}`

// The rest of a thread's comments, as the review job pages them.
export const THREAD_COMMENTS_QUERY = `query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: 50, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} } }
    }
  }
}`

export interface OutcomeLedger {
  schema: typeof LEDGER_SCHEMA
  repository: string // "owner/name": one nominated repository per ledger
  branch: string
  collectedAt: string // ISO 8601
  // The newest committer time on the clone's first-parent history, capped at collectedAt: the clone holds every commit
  // that reached the branch before it, so maturity and the label windows are measured to it.
  observedUntil: string
  expires: string // collectedAt plus LEDGER_DAYS
  merged: { since: string; until: string }
  logins: "hmac-sha256/per-run" // keyed with a random key that was never stored
  pulls: LedgerPull[]
  findings: LedgerFinding[]
  problems: string[] // reads cut short; the PR they touch is truncated
}

export interface LedgerPull {
  number: number
  author: string // hashLogin
  stratum: PullStratum
  reviewed: boolean // the review job's sticky state was found
  humanReview: boolean // a person other than the author and the bots reviewed or commented on the PR
  createdAt: string
  mergedAt: string
  cycleHours: number
  reviews: number // the sticky state's count of completed reviews
  rereviews: number // max(reviews - 1, 0)
  costUsd: number // the state's total spend; it keeps no per-review spend
  statePruned: boolean // the state is at its 60-finding cap or near its size limit, so summary findings may be lost
  band?: RiskBand // riskOf on the merged PR's reviewed files: no dependents, no history
  score?: number
  truncated: boolean // a read was cut short: left out of every rate
  matured: boolean // merged at least MATURITY_DAYS before observedUntil
  revertedDays?: number // matured only: the first revert on the base branch, in days after the merge
  fixes?: { days: number; lines: number; kind: "label" | "title" }[] // matured only, within 90 days
  lines?: { edited: number; flagged: number; escaped: number; unreviewed: number; skipped: number } // matured, kept
}

export interface LedgerFinding {
  pr: number
  id: string
  where: "inline" | "summary"
  severity: Severity
  category: Category
  outcome: Outcome
  stratum: Stratum
  humanEngaged: boolean // someone neither a bot nor the PR author resolved, replied or reacted
  resolver?: Resolver // who resolved its thread, when it is resolved
  dismisser?: string // hashLogin, when a dismissal is attributed
  laterFixed?: boolean // matured, not-reverted PRs only: a fix within 90 days edited a line within DEFAULT_SLACK
}

export interface GitHubRead {
  get(path: string): Promise<unknown>
  query(document: string, variables: Readonly<Record<string, string | number>>): Promise<unknown>
}
export type GhRequest =
  | { kind: "get"; path: string }
  | { kind: "query"; document: string; variables: Readonly<Record<string, string | number>> }
export type GitRead = (args: readonly string[]) => string

export interface CollectInput {
  repository: string
  branch?: string
  since: number
  until: number
  bots: readonly string[]
  agentPulls: ReadonlySet<number> // the owner's trusted record of agent-authored PRs
}

export interface CollectDeps {
  github: GitHubRead
  git: GitRead
  now: number
  key: Uint8Array // the HMAC key for logins; collect never stores it
  maxCalls?: number
}

// ---------------------------------------------------------------------------------------------------------------
// Per finding

/**
 * A finding's outcome from its marker status and its thread, the first rule that matches deciding:
 * - outdated: the marker says so;
 * - fixed: confirmed by thread when a person who is neither a bot nor the PR author resolved it, self-resolved when
 *   the author did, and model-only otherwise (the job resolves the thread itself when it marks a finding fixed);
 * - dismissed: a well-formed vector-dismissal marker gives the role; without one, the job's own dismissal rule
 *   (classifyPrior) finds the author or a writer among the signals, or the dismissal is unattributed;
 * - open: acknowledged by a reply that is not a dismissal or by a positive reaction from someone not a bot, and open at
 *   merge otherwise.
 */
export function findingOutcome(input: {
  prior: PriorFinding
  thread?: ThreadInfo
  dismissal?: DismissalMarker
  author: string
  isBot: (login: string) => boolean
  isWriter: (login: string) => boolean
}): { outcome: Outcome; humanEngaged: boolean; resolver?: Resolver; dismissedBy?: string } {
  const thread = input.thread
  const isAuthor = (login: string) => login.toLowerCase() === input.author.toLowerCase()
  // GraphQL gives a deleted ("ghost") account an empty login: nobody, as readPull reads it.
  const person = (login: string) => !!login && !input.isBot(login) && !isAuthor(login)
  const resolvedBy = thread?.resolved && thread.resolvedBy ? thread.resolvedBy : undefined
  const resolver = resolvedBy === undefined ? undefined : roleOf(resolvedBy, input)
  const humanEngaged =
    (resolvedBy !== undefined && person(resolvedBy)) ||
    (thread?.replies ?? []).some((reply) => person(reply.author)) ||
    (thread?.reactions ?? []).some((reaction) => reaction.users.some(person))
  const base = { humanEngaged, ...(resolver ? { resolver } : {}) }
  const status = input.prior.status
  if (status === "outdated") return { ...base, outcome: "outdated" }
  if (status === "fixed")
    return {
      ...base,
      outcome:
        resolver === "writer" || resolver === "other"
          ? "fixed-confirmed-by-thread"
          : resolver === "author"
            ? "fixed-self-resolved"
            : "fixed-model-only",
    }
  if (status === "dismissed") return { ...base, ...dismissedOutcome(input, isAuthor) }
  const replied = (thread?.replies ?? []).some(
    (reply) => !!reply.author && !input.isBot(reply.author) && !dismissalReply(input.prior, reply),
  )
  const liked = (thread?.reactions ?? []).some(
    (reaction) =>
      POSITIVE_REACTIONS.includes(reaction.content.toLowerCase()) &&
      reaction.users.some((user) => !!user && !input.isBot(user)),
  )
  return { ...base, outcome: replied || liked ? "acknowledged" : "open-at-merge" }
}

function roleOf(
  login: string,
  input: { author: string; isBot: (login: string) => boolean; isWriter: (login: string) => boolean },
): Resolver {
  if (input.isBot(login)) return "bot"
  if (login.toLowerCase() === input.author.toLowerCase()) return "author"
  return input.isWriter(login) ? "writer" : "other"
}

function dismissedOutcome(
  input: Parameters<typeof findingOutcome>[0],
  isAuthor: (login: string) => boolean,
): { outcome: Outcome; dismissedBy?: string } {
  if (input.dismissal) return { outcome: input.dismissal.by === "w" ? "dismissed-writer" : "dismissed-author" }
  // The job's rule on the thread as it is now. A line with no `changes` keeps the fix rule out, so only the dismissal
  // rule can apply; a bot is never a writer here.
  const classified = classifyPrior(
    { ...input.prior, status: "open", line: input.prior.line ?? 1 },
    {
      head: "0000000",
      ...(input.thread ? { thread: input.thread } : {}),
      isWriter: (login) => !input.isBot(login) && input.isWriter(login),
      prAuthor: input.author,
    },
  )
  const by = classified.status === "dismissed" ? classified.dismissedBy : undefined
  if (!by) return { outcome: "dismissed-unattributed" }
  return { outcome: isAuthor(by) ? "dismissed-author" : "dismissed-writer", dismissedBy: by }
}

// Whether the job would read this reply as a dismissal, whoever wrote it.
function dismissalReply(prior: PriorFinding, reply: { author: string; body: string }) {
  return (
    classifyPrior(
      { ...prior, status: "open", line: prior.line ?? 1 },
      { head: "0000000", thread: { resolved: false, replies: [reply] }, isWriter: () => true, prAuthor: "" },
    ).status === "dismissed"
  )
}

/**
 * Bulk resolutions on one PR: at least BULK_RESOLVE_THREADS inline threads resolved by one actor who is not a bot,
 * none with a reply from someone not a bot and none fixed. Count-based, because GitHub's review-thread API gives no
 * resolve time (team.ts also bounds a batch by BULK_RESOLVE_MS). Bulk findings are split out, never relabelled.
 */
export function bulkResolved(
  findings: readonly { prior: PriorFinding; thread?: ThreadInfo }[],
  isBot: (login: string) => boolean,
): Set<string> {
  const byActor = Map.groupBy(
    findings.filter(
      (entry) =>
        entry.prior.where === "inline" &&
        entry.prior.status !== "fixed" &&
        entry.thread?.resolved === true &&
        !!entry.thread.resolvedBy &&
        !isBot(entry.thread.resolvedBy) &&
        !(entry.thread.replies ?? []).some((reply) => !isBot(reply.author)),
    ),
    (entry) => entry.thread?.resolvedBy?.toLowerCase() ?? "",
  )
  return new Set(
    [...byActor.values()]
      .filter((group) => group.length >= BULK_RESOLVE_THREADS)
      .flatMap((group) => group.map((entry) => entry.prior.id)),
  )
}

/**
 * A PR's stratum. "agent" only from the owner's trusted record; a bot author, a bot commit author or a co-author
 * trailer naming a [bot] address only moves a PR out of "human", into "agent-signal". No agent or product is named.
 */
export function agentStratum(
  pull: {
    number: number
    author: { login: string; type?: string }
    coAuthors: readonly string[]
    commitAuthors?: readonly { login: string; type?: string }[]
  },
  trusted: ReadonlySet<number>,
): PullStratum {
  if (trusted.has(pull.number)) return "agent"
  const bot = (actor: { login: string; type?: string }) => actor.type === "Bot" || /\[bot\]$/i.test(actor.login)
  const signal =
    bot(pull.author) ||
    (pull.commitAuthors ?? []).some(bot) ||
    pull.coAuthors.some((trailer) => /\[bot\]/i.test(trailer))
  return signal ? "agent-signal" : "human"
}

// ---------------------------------------------------------------------------------------------------------------
// Post-merge labels

export interface BaseCommit {
  sha: string
  parents: string[]
  at: number // committer time, ms
  subject: string
  body: string
  merged: { sha: string; message: string }[] // a merge's: the commits it brought in, from git log <sha>^1..<sha>
}

// What a revert commit names: git's "This reverts commit <sha>" and GitHub's "Reverts <owner/name>#N", this
// repository's only.
export function revertTargets(
  commit: Pick<BaseCommit, "subject" | "body">,
  repository: string,
): { shas: string[]; pulls: number[] } {
  const text = `${commit.subject}\n${commit.body}`
  const shas = [...text.matchAll(/\bThis reverts commit ([0-9a-f]{40})\b/gi)].map((match) => match[1]!.toLowerCase())
  const pulls = [...text.matchAll(/\bReverts ([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)#(\d+)\b/g)]
    .filter((match) => match[1]!.toLowerCase() === repository.toLowerCase())
    .map((match) => Number(match[2]))
  return { shas: [...new Set(shas)], pulls: [...new Set(pulls)] }
}

/**
 * What a first-parent commit reverts: its own message's targets and, for a merge, those of the commits it brought in.
 * A --no-ff merge of a revert PR carries the revert on its second parent, under GitHub's "Merge pull request #N from
 * ..." message, which names no target. A brought-in revert of a commit on the same branch reverts nothing on the base.
 */
export function revertsOf(commit: Pick<BaseCommit, "subject" | "body" | "merged">, repository: string) {
  const own = revertTargets(commit, repository)
  const branch = new Set(commit.merged.map((entry) => entry.sha))
  const brought = commit.merged.map((entry) => revertTargets({ subject: "", body: entry.message }, repository))
  return {
    shas: [...new Set([...own.shas, ...brought.flatMap((targets) => targets.shas).filter((sha) => !branch.has(sha))])],
    pulls: [...new Set([...own.pulls, ...brought.flatMap((targets) => targets.pulls)])],
  }
}

/**
 * Whether a base-branch commit is a follow-up fix, and from what: a revert is never a fix (REVERT_SUBJECT on its
 * subject and its PR's title, or on the PR's title alone for a merge commit, whose subject names the source branch, as
 * in "Merge pull request #7 from owner/fix-revert-button"; the caller also skips a commit revertsOf finds a target
 * in); then a fix label on its PR; then FIX_SUBJECT on its PR's title, or on the commit subject when it has no PR.
 * Only the writer-merged history and its PRs' labels and titles are read.
 */
export function fixKind(
  commit: Pick<BaseCommit, "subject"> & { parents?: readonly string[] },
  pull?: { labels: readonly string[]; title: string },
): "label" | "title" | undefined {
  const subjects = !pull
    ? [commit.subject]
    : (commit.parents?.length ?? 0) > 1
      ? [pull.title]
      : [commit.subject, pull.title]
  if (subjects.some((subject) => REVERT_SUBJECT.test(subject))) return undefined
  if (pull?.labels.some((label) => FIX_LABEL.test(label) && !NOT_FIX_LABEL.test(label))) return "label"
  return FIX_SUBJECT.test(pull?.title ?? commit.subject) ? "title" : undefined
}

export function matured(mergedAt: number, now: number) {
  return mergedAt <= now - MATURITY_DAYS * DAY
}

// ---------------------------------------------------------------------------------------------------------------
// Privacy and I/O

// The first 16 hex characters of an HMAC-SHA256 of the lowercased login. The key is random per run and never stored,
// so the hashes of two ledgers do not match; the PR numbers they keep still identify people to anyone who can read
// the repository.
export function hashLogin(login: string, key: Uint8Array): string {
  return createHmac("sha256", key).update(login.toLowerCase()).digest("hex").slice(0, 16)
}

/**
 * The `gh` arguments for one read: a REST GET under /repos/<repository>, always with --method GET so no field can turn
 * it into a write, or a GraphQL query. A string variable goes through -f (raw); -F reads @file values and converts
 * types, so it carries safe integers only.
 */
export function ghArgs(request: GhRequest, repository: string): string[] {
  if (request.kind === "get")
    return [
      "api",
      "--method",
      "GET",
      "-H",
      "Accept: application/vnd.github+json",
      checkedPath(request.path, repository),
    ]
  if (!/^query\b/.test(request.document) || /\b(?:mutation|subscription)\b/i.test(request.document))
    throw new Error("Only a read query may be sent.")
  return [
    "api",
    "graphql",
    "-f",
    `query=${request.document}`,
    ...Object.entries(request.variables).flatMap(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name === "query")
        throw new Error(`Bad variable name ${JSON.stringify(name)}.`)
      if (typeof value === "string") return ["-f", `${name}=${value}`]
      if (Number.isSafeInteger(value)) return ["-F", `${name}=${value}`]
      throw new Error(`Variable ${name} must be a string or a safe integer.`)
    }),
  ]
}

function checkedPath(request: string, repository: string) {
  const refuse = (why: string) => {
    throw new Error(`Refused GitHub path ${JSON.stringify(request)}: ${why}.`)
  }
  // No whitespace, fragment, backslash or gh placeholder ({owner} and the like), and no encoded dot.
  if (/[\s#\\{}]/.test(request) || /%2e/i.test(request)) refuse("it has a character the ledger never sends")
  const at = request.indexOf("?")
  const path = at === -1 ? request : request.slice(0, at)
  const query = at === -1 ? "" : request.slice(at + 1)
  const segments = path.split("/")
  if (segments[0] !== "" || segments.slice(1).some((segment) => segment === "" || segment === "." || segment === ".."))
    refuse("it is not a plain absolute path")
  const [owner, name] = repository.toLowerCase().split("/")
  if (segments[1] !== "repos" || segments[2]?.toLowerCase() !== owner || segments[3]?.toLowerCase() !== name)
    refuse(`it is outside /repos/${repository}`)
  if (!/^[A-Za-z0-9_.~%=&,+-]*$/.test(query)) refuse("its query string has a character the ledger never sends")
  return request
}

// Reads GitHub through `gh api`: one process per read, its output parsed as JSON. A failed read throws.
export function ghReader(
  repository: string,
  run: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> = runGh,
): GitHubRead {
  const read = async (request: GhRequest) => {
    const result = await run(ghArgs(request, repository))
    if (result.code !== 0) throw new Error(`gh api exited with ${result.code}: ${result.stderr.trim().slice(0, 300)}`)
    return JSON.parse(result.stdout) as unknown
  }
  return {
    get: (path) => read({ kind: "get", path }),
    query: (document, variables) => read({ kind: "query", document, variables }),
  }
}

async function runGh(args: string[]) {
  const child = Bun.spawn(["gh", ...args], {
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

/**
 * Read-only git in the nominated clone, with dataset.ts's untrusted-git settings (no hooks, fsmonitor or transport,
 * no global or system config) and no lazy fetch. Only READ_ONLY_GIT subcommands run (config only as --get-regexp),
 * each with the repository-local options it would read turned off: textconv and external diff drivers, colour,
 * relative paths, prefixes, signature checks and blame's ignore-revs file, and blame names files unquoted where git
 * can (core.quotePath=false). Options are checked up to `--`: a path after it, which a PR author can name `-o`, is
 * only a path. A failed command throws.
 */
export function localGit(dir: string): GitRead {
  return (args) => {
    const command = READ_ONLY_GIT.find((entry) => entry === args[0])
    if (!command) throw new Error(`The ledger runs only ${READ_ONLY_GIT.join(", ")}, not ${JSON.stringify(args[0])}.`)
    if (command === "config" && !(args.length === 3 && args[1] === "--get-regexp"))
      throw new Error("The ledger reads config only with --get-regexp.")
    const end = args.indexOf("--")
    const forbidden = args.slice(1, end === -1 ? undefined : end).find((arg) => FORBIDDEN_GIT_ARG.test(arg))
    if (forbidden) throw new Error(`The ledger never passes ${JSON.stringify(forbidden)} to git.`)
    const result = Bun.spawnSync(
      [
        "git",
        ...UNTRUSTED_GIT,
        ...(command === "blame" ? ["-c", "blame.ignoreRevsFile=", "-c", "core.quotePath=false"] : []),
        "-C",
        dir,
        command,
        ...GIT_HARDENING[command],
        ...args.slice(1),
      ],
      { env: { ...untrustedGitEnv(), GIT_NO_LAZY_FETCH: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    const stderr = result.stderr.toString()
    // `git config --get-regexp` exits 1 when nothing matches, and `rev-parse --verify --quiet` when there is no such ref.
    const none = command === "config" || (command === "rev-parse" && args.includes("--quiet"))
    if (none && result.exitCode === 1 && !stderr.trim()) return ""
    if (result.exitCode !== 0) throw new Error(`git ${command} failed: ${stderr.trim().slice(0, 300)}`)
    return result.stdout.toString()
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Collection

interface ListedPull {
  number: number
  title: string
  labels: string[]
  author: { login: string; type?: string }
  createdAt: number
  mergedAt: number
  updatedAt: number
  mergeSha: string
  base: string
}

interface Place {
  path: string
  // The anchor first (the head line, or the original line of an outdated thread), then the other lines the finding
  // names as the same defect (`also`).
  lines: number[]
}

interface ReadFinding {
  prior: PriorFinding
  thread?: ThreadInfo
  result: ReturnType<typeof findingOutcome>
  place?: Place // where a fix's blamed lines are compared
}

interface PullRead {
  pull: ListedPull
  stratum: PullStratum
  state?: ReviewState
  humanReview: boolean
  risk?: { band: RiskBand; score: number }
  skipped: Set<string> // paths the default skip rules leave out of review
  findings: ReadFinding[]
  bulk: Set<string>
  truncated: string[]
}

interface Hit {
  fix: string
  days: number
  kind: "label" | "title"
  path: string
  line: number
}

interface Budget extends GitHubRead {
  left(): number
}

// A read past the call cap. The budget refuses it, so the cap holds even where a caller forgot to check left().
class CallCapReached extends Error {}

/**
 * Collects one repository's ledger. Read errors throw, so no partial ledger is ever written; a page cap or the call
 * cap marks the PR truncated, and it is left out of every rate. A clone whose base branch lacks a PR GitHub lists as
 * merged is refused before any PR is read: its history stops before collection, so later reverts and fixes would be
 * missing and PRs would read as clean.
 */
export async function collect(input: CollectInput, deps: CollectDeps): Promise<OutcomeLedger> {
  const github = budgeted(deps.github, deps.maxCalls ?? MAX_API_CALLS)
  const git = deps.git
  const problems: string[] = []
  requireFullClone(git)
  const repository = obj(await github.get(`/repos/${input.repository}`))
  const branch = input.branch ?? str(repository.default_branch)
  if (!branch) throw new Error(`GitHub gave no default branch for ${input.repository}: pass --branch.`)
  const ref = baseRef(git, branch)
  const listed = await mergedPulls(github, input.repository, branch, input.since, problems)
  const reach = firstParents(git, ref)
  requireFetched(listed, reach.shas, { ref, branch, since: input.since })
  const observed = Math.min(deps.now, reach.newest)
  const history = baseHistory(git, ref, input.since)
  const onBase = new Set(history.map((commit) => commit.sha))
  const window = listed.filter((pull) => pull.mergedAt >= input.since && pull.mergedAt <= input.until)
  const bots = input.bots.map((bot) => (/\[bot\]$/i.test(bot) ? bot : `${bot}[bot]`))
  const writers = new Map<string, Promise<boolean>>()
  const reads: PullRead[] = []
  for (const pull of window) {
    if (github.left() < PR_CALL_RESERVE) {
      reads.push(cappedPull(pull, input.agentPulls))
      continue
    }
    reads.push(
      await readPull(pull, {
        github,
        repository: input.repository,
        bots,
        isBot: isBotLogin,
        writers,
        trusted: input.agentPulls,
      }).catch((error: unknown) =>
        error instanceof CallCapReached ? cappedPull(pull, input.agentPulls) : Promise.reject(error),
      ),
    )
  }
  const lookup = commitPulls(github, input.repository, branch, listed, onBase, problems)
  const reverts = await revertDays(history, window, input.repository, lookup)
  const hits = await fixHits(history, window, { git, lookup, repository: input.repository })
  for (const read of reads) for (const reason of read.truncated) problems.push(`PR #${read.pull.number}: ${reason}`)
  const ctx = { observed, key: deps.key, reverts, hits }
  return {
    schema: LEDGER_SCHEMA,
    repository: input.repository,
    branch,
    collectedAt: new Date(deps.now).toISOString(),
    observedUntil: new Date(observed).toISOString(),
    expires: new Date(deps.now + LEDGER_DAYS * DAY).toISOString(),
    merged: { since: new Date(input.since).toISOString(), until: new Date(input.until).toISOString() },
    logins: "hmac-sha256/per-run",
    pulls: reads.map((read) => ledgerPull(read, ctx)),
    findings: reads.flatMap((read) => ledgerFindings(read, ctx)),
    problems,
  }
}

function budgeted(github: GitHubRead, limit: number): Budget {
  const calls = { left: limit }
  const spend = <T>(read: () => Promise<T>) => {
    if (calls.left <= 0) return Promise.reject(new CallCapReached(`the API call cap of ${limit} was reached`))
    calls.left--
    return read()
  }
  return {
    left: () => calls.left,
    get: (path) => spend(() => github.get(path)),
    query: (document, variables) => spend(() => github.query(document, variables)),
  }
}

// A shallow clone hides the history the labels need, and a partial clone would fetch blobs (refused here, so blame
// would fail partway): both are refused before any read.
function requireFullClone(git: GitRead) {
  if (git(["rev-parse", "--is-shallow-repository"]).trim() !== "false")
    throw new Error("The clone is shallow: fetch its full history (git fetch --unshallow) first.")
  const settings = git(["config", "--get-regexp", PARTIAL_CLONE])
    .split("\n")
    .filter(Boolean)
    .map((line) => [line.slice(0, line.indexOf(" ")).toLowerCase(), line.slice(line.indexOf(" ") + 1).trim()] as const)
  const partial = settings.some(([key, value]) =>
    key === "extensions.partialclone" ? value !== "" : key.endsWith(".promisor") && /^(true|yes|on|1)$/i.test(value),
  )
  if (partial) throw new Error("The clone is partial: use a full clone, so blame never needs to fetch.")
}

// A stale clone hides what reached the base branch after its last fetch: every PR GitHub lists as merged since --since
// (not only those in the window) must have its merge commit on the clone's first-parent history.
function requireFetched(
  listed: readonly ListedPull[],
  onBranch: ReadonlySet<string>,
  where: { ref: string; branch: string; since: number },
) {
  const missing = listed.filter((pull) => !onBranch.has(pull.mergeSha))
  if (!missing.length) return
  const named = missing.slice(0, 5).map((pull) => `#${pull.number}`)
  throw new Error(
    `The clone's ${where.ref} lacks the merge commits of ${missing.length} PR(s) GitHub lists as merged into ${where.branch} since ${new Date(where.since).toISOString().slice(0, 10)} (${[...named, ...(missing.length > 5 ? ["..."] : [])].join(", ")}): fetch the base branch (git fetch origin ${where.branch}) and run again. Nothing was written.`,
  )
}

function baseRef(git: GitRead, branch: string) {
  const remote = `refs/remotes/origin/${branch}`
  const local = `refs/heads/${branch}`
  const found = [remote, local].find((ref) =>
    git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]).trim(),
  )
  if (!found) throw new Error(`The clone has neither ${remote} nor ${local}.`)
  return found
}

async function mergedPulls(github: Budget, repository: string, branch: string, since: number, problems: string[]) {
  const out: ListedPull[] = []
  for (let page = 1; page <= MAX_PULL_PAGES; page++) {
    if (github.left() <= 0) {
      problems.push("the API call cap was reached in the merged-PR listing: PRs updated earlier are missing")
      return out.toSorted((a, b) => a.mergedAt - b.mergedAt)
    }
    const items = list(
      await github.get(
        `/repos/${repository}/pulls?state=closed&base=${encodeURIComponent(branch)}&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}`,
      ),
      "the merged-PR listing",
    )
    const pulls = items.flatMap((item) => listedPull(item) ?? [])
    out.push(...pulls.filter((pull) => pull.mergedAt >= since && pull.base === branch))
    const older = items.every((item) => Date.parse(str(obj(item).updated_at)) < since)
    if (items.length < PER_PAGE || older) return out.toSorted((a, b) => a.mergedAt - b.mergedAt)
  }
  problems.push(`the merged-PR listing stopped at ${MAX_PULL_PAGES} pages: PRs updated earlier are missing`)
  return out.toSorted((a, b) => a.mergedAt - b.mergedAt)
}

// Every first-parent commit of the base branch, and the newest committer time among them. A commit reaches the branch
// no earlier than its committer time and the clone was fetched after the newest one reached it, so the clone holds
// every commit that reached the branch before that time.
function firstParents(git: GitRead, ref: string) {
  const rows = git(["log", "--first-parent", "--format=%H %ct", ref])
    .split("\n")
    .filter(Boolean)
    .map((row) => row.split(" "))
  return {
    shas: new Set(rows.map((row) => (row[0] ?? "").toLowerCase())),
    newest: rows.reduce((newest, row) => Math.max(newest, Number(row[1]) * 1000 || 0), 0),
  }
}

function baseHistory(git: GitRead, ref: string, since: number): BaseCommit[] {
  return git([
    "log",
    "--first-parent",
    "--format=%H%x1f%P%x1f%ct%x1f%s%x1f%b%x1e",
    `--since=@${Math.floor(since / 1000)}`,
    ref,
  ])
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter(Boolean)
    .map((record) => {
      const [sha = "", parents = "", at = "", subject = "", ...body] = record.split("\x1f")
      const parentShas = parents.split(" ").filter(Boolean)
      return {
        sha: sha.toLowerCase(),
        parents: parentShas,
        at: Number(at) * 1000,
        subject,
        body: body.join("\x1f"),
        merged: parentShas.length > 1 ? broughtIn(git, sha.toLowerCase()) : [],
      }
    })
    .toReversed()
}

// The commits a merge brought in, with their full messages: the merged branch's revert commit lives there.
function broughtIn(git: GitRead, sha: string) {
  return git(["log", "--format=%H%x1f%B%x1e", `${sha}^1..${sha}`])
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter(Boolean)
    .map((record) => ({
      sha: record.slice(0, record.indexOf("\x1f")).toLowerCase(),
      message: record.slice(record.indexOf("\x1f") + 1),
    }))
    .filter((entry) => entry.sha !== sha)
}

async function readPull(
  pull: ListedPull,
  ctx: {
    github: Budget
    repository: string
    bots: readonly string[]
    isBot: (login: string) => boolean
    writers: Map<string, Promise<boolean>>
    trusted: ReadonlySet<number>
  },
): Promise<PullRead> {
  const base = `/repos/${ctx.repository}/pulls/${pull.number}`
  const truncated: string[] = []
  const comments = await pages(
    ctx.github,
    `/repos/${ctx.repository}/issues/${pull.number}/comments`,
    MAX_LIST_PAGES,
    "the PR's comments",
  )
  if (comments.capped) truncated.push(`its comments stopped at ${MAX_LIST_PAGES} pages`)
  const issueComments = comments.items.map((item) => {
    const comment = obj(item)
    return { id: int(comment.id) ?? 0, body: str(comment.body), user: { login: str(obj(comment.user).login) } }
  })
  const sticky = ctx.bots.map((bot) => findSticky(issueComments, bot)).find((comment) => comment !== undefined)
  const state = sticky ? readState(sticky.body ?? "") : undefined
  const threads = state ? await readThreads(ctx.github, ctx.repository, pull.number) : { threads: [], truncated: [] }
  truncated.push(...threads.truncated)

  const files = await pages(ctx.github, `${base}/files`, MAX_FILE_PAGES, "the PR's files")
  if (files.capped) truncated.push(`its files stopped at ${MAX_FILE_PAGES * PER_PAGE}`)
  const changed = fromGitHubFiles(files.items.map(prFile))
  const classified = classifyFiles(changed, {
    config: { ignore: DEFAULT_REVIEW_CONFIG.ignore, ignoreDefaults: DEFAULT_REVIEW_CONFIG.ignoreDefaults },
  })
  const assessed = files.capped ? undefined : riskOf(riskFeatures(classified.review, { changed }))
  const reviews = await pages(ctx.github, `${base}/reviews`, MAX_LIST_PAGES, "the PR's reviews")
  if (reviews.capped) truncated.push(`its reviews stopped at ${MAX_LIST_PAGES} pages`)
  const commits = await pages(ctx.github, `${base}/commits`, Math.ceil(MAX_COMMITS / PER_PAGE), "the PR's commits")
  if (commits.items.length >= MAX_COMMITS) truncated.push(`its commits stopped at ${MAX_COMMITS}`)

  const person = (login: string) =>
    !!login && !ctx.isBot(login) && login.toLowerCase() !== pull.author.login.toLowerCase()
  const humanReview =
    reviews.items.some((item) => person(str(obj(obj(item).user).login))) ||
    issueComments.some((comment) => person(comment.user.login)) ||
    threads.threads.some((thread) => thread.comments.some((comment) => person(comment.author)))
  const stratum = agentStratum(
    {
      number: pull.number,
      author: pull.author,
      coAuthors: commits.items.flatMap((item) =>
        [...str(obj(obj(item).commit).message).matchAll(/^co-authored-by:\s*(.+)$/gim)].map((match) => match[1]!),
      ),
      commitAuthors: commits.items.map((item) => {
        const author = obj(obj(item).author)
        return { login: str(author.login), type: str(author.type) }
      }),
    },
    ctx.trusted,
  )
  const findings = state ? await readFindings(pull, state, threads.threads, ctx, truncated) : []
  return {
    pull,
    stratum,
    ...(state ? { state } : {}),
    humanReview,
    ...(assessed ? { risk: { band: assessed.band, score: assessed.likelihood.score } } : {}),
    skipped: new Set(classified.skipped.map((file) => file.path)),
    findings,
    bulk: bulkResolved(findings, ctx.isBot),
    truncated,
  }
}

async function readFindings(
  pull: ListedPull,
  state: ReviewState,
  threads: readonly GraphThread[],
  ctx: {
    github: Budget
    repository: string
    bots: readonly string[]
    isBot: (login: string) => boolean
    writers: Map<string, Promise<boolean>>
  },
  truncated: string[],
): Promise<ReadFinding[]> {
  // Findings are rebuilt only from the configured bots' own comments. Every --bot carries "[bot]" and graphLogin adds it
  // to a Bot actor, so a User account named like the App never matches.
  const vector = (login: string) => ctx.bots.some((bot) => bot.toLowerCase() === login.toLowerCase())
  const rooted = threads.flatMap((thread) => {
    const root = thread.comments[0]
    if (!root || !vector(root.author)) return []
    const prior = priorFromComment({
      id: root.id,
      body: root.body,
      path: thread.path,
      line: thread.line,
      ...(thread.side ? { side: thread.side } : {}),
      threadId: thread.id,
    })
    if (!prior) return []
    const info: ThreadInfo = {
      resolved: thread.resolved,
      ...(thread.resolvedBy ? { resolvedBy: thread.resolvedBy } : {}),
      reactions: root.reactions,
      replies: thread.comments
        .slice(1)
        .filter((reply) => !vector(reply.author))
        .map((reply) => ({ author: reply.author, body: reply.body })),
    }
    return [{ prior, info, body: root.body, line: thread.line ?? thread.originalLine }]
  })
  const byComment = new Map(rooted.map((entry) => [entry.prior.commentId, entry]))
  const merged = mergePrior(
    priorFromState(state),
    rooted.map((entry) => entry.prior),
  )
  // As the job looks them up: each resolver, thumbs-down reactor and replier, cached; a bot is never looked up.
  const logins = [
    ...new Set(
      rooted
        .flatMap((entry) => [
          ...(entry.info.resolvedBy ? [entry.info.resolvedBy] : []),
          ...(entry.info.reactions ?? []).flatMap((reaction) =>
            ["thumbs_down", "-1"].includes(reaction.content.toLowerCase()) ? reaction.users : [],
          ),
          ...(entry.info.replies ?? []).map((reply) => reply.author),
        ])
        .filter((login) => !!login && !ctx.isBot(login))
        .map((login) => login.toLowerCase()),
    ),
  ]
  const unknown = logins.filter((login) => !ctx.writers.has(login))
  if (unknown.length > ctx.github.left())
    truncated.push("the API call cap was reached before its permissions were read")
  for (const login of unknown.length > ctx.github.left() ? [] : unknown)
    ctx.writers.set(login, permission(ctx.github, ctx.repository, login))
  const roles = new Map(
    await Promise.all(logins.map(async (login) => [login, (await ctx.writers.get(login)) ?? false] as const)),
  )
  const isWriter = (login: string) => roles.get(login.toLowerCase()) ?? false
  return merged.map((prior) => {
    const entry = prior.commentId === undefined ? undefined : byComment.get(prior.commentId)
    const thread = entry?.prior === prior ? entry.info : undefined
    const dismissal = entry?.prior === prior ? parseDismissalMarker(entry.body) : undefined
    const line = entry?.prior === prior ? entry.line : prior.line
    return {
      prior,
      ...(thread ? { thread } : {}),
      result: findingOutcome({
        prior,
        ...(thread ? { thread } : {}),
        ...(dismissal ? { dismissal } : {}),
        author: pull.author.login,
        isBot: ctx.isBot,
        isWriter,
      }),
      // A LEFT finding's line is a base line, which a fix's blame never returns.
      ...(line !== null && prior.side === "RIGHT"
        ? { place: { path: prior.path, lines: [line, ...(prior.also ?? [])] } }
        : {}),
    }
  })
}

// A permission lookup as the job does it: a writer has admin, maintain or write, and any error reads as none, except
// the call cap, which truncates the PR instead of reading as "not a writer".
function permission(github: Budget, repository: string, login: string) {
  return github
    .get(`/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`)
    .then((value) => {
      const data = obj(value)
      return WRITER_PERMISSIONS.some((entry) => entry === str(data.role_name) || entry === str(data.permission))
    })
    .catch((error: unknown) => (error instanceof CallCapReached ? Promise.reject(error) : false))
}

function cappedPull(pull: ListedPull, trusted: ReadonlySet<number>): PullRead {
  return {
    pull,
    stratum: agentStratum({ number: pull.number, author: pull.author, coAuthors: [] }, trusted),
    humanReview: false,
    skipped: new Set(),
    findings: [],
    bulk: new Set(),
    truncated: ["the API call cap was reached before it was read"],
  }
}

interface GraphComment {
  id: number
  body: string
  author: string
  reactions: { content: string; users: string[] }[]
}

interface GraphThread {
  id: string
  resolved: boolean
  resolvedBy?: string
  path: string
  line: number | null
  originalLine: number | null
  side?: Side
  comments: GraphComment[]
}

async function readThreads(github: Budget, repository: string, number: number) {
  const [owner = "", name = ""] = repository.split("/")
  const threads: GraphThread[] = []
  const truncated: string[] = []
  const extra = { pages: 0 }
  const after = { cursor: "" }
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const data = graphData(
      await github.query(THREADS_QUERY, { owner, name, number, ...(after.cursor ? { cursor: after.cursor } : {}) }),
    )
    const connection = obj(obj(obj(data.repository).pullRequest).reviewThreads)
    for (const value of list(connection.nodes ?? [], "the review threads")) {
      const node = obj(value)
      const id = str(node.id)
      const comments = graphComments(node.comments)
      const pageInfo = { next: obj(obj(node.comments).pageInfo) }
      while (pageInfo.next.hasNextPage === true && extra.pages < MAX_EXTRA_COMMENT_PAGES) {
        extra.pages++
        const more = obj(
          obj(graphData(await github.query(THREAD_COMMENTS_QUERY, { id, cursor: str(pageInfo.next.endCursor) })).node)
            .comments,
        )
        comments.push(...graphComments(more))
        pageInfo.next = obj(more.pageInfo)
      }
      if (pageInfo.next.hasNextPage === true) truncated.push(`a review thread's comments stopped at the page cap`)
      const resolvedBy = graphLogin(node.resolvedBy)
      const side = str(node.diffSide)
      threads.push({
        id,
        resolved: node.isResolved === true,
        ...(resolvedBy ? { resolvedBy } : {}),
        path: str(node.path),
        line: int(node.line) ?? null,
        originalLine: int(node.originalLine) ?? null,
        ...(side === "LEFT" || side === "RIGHT" ? { side } : {}),
        comments,
      })
    }
    const info = obj(connection.pageInfo)
    if (info.hasNextPage !== true) return { threads, truncated }
    after.cursor = str(info.endCursor)
  }
  return { threads, truncated: [...truncated, `its review threads stopped at ${MAX_THREAD_PAGES} pages`] }
}

function graphComments(connection: unknown): GraphComment[] {
  return list(obj(connection).nodes ?? [], "a thread's comments").flatMap((value) => {
    const node = obj(value)
    const id = Number(node.fullDatabaseId)
    if (!Number.isSafeInteger(id) || id <= 0) return []
    return [
      {
        id,
        body: str(node.body),
        author: graphLogin(node.author),
        reactions: list(node.reactionGroups ?? [], "a comment's reactions")
          .map((group) => ({
            content: str(obj(group).content),
            users: list(obj(obj(group).reactors).nodes ?? [], "a reaction's reactors")
              .map(graphLogin)
              .filter(Boolean),
          }))
          .filter((group) => group.users.length > 0),
      },
    ]
  })
}

// GraphQL names a bot "name" where REST says "name[bot]" (github.review-api.ts graphLogin).
function graphLogin(actor: unknown) {
  const value = obj(actor)
  const login = str(value.login)
  return str(value.__typename) === "Bot" && login && !login.endsWith("[bot]") ? `${login}[bot]` : login
}

function graphData(response: unknown) {
  const value = obj(response)
  if (Array.isArray(value.errors) && value.errors.length) throw new Error("GitHub's GraphQL API returned errors.")
  return obj(value.data)
}

// The commit-to-PR map: the merged-PR listing's merge commits first, then GitHub's commit-to-PR link (merge, squash
// and rebase merges) for a first-parent commit the listing cannot match, within the call cap.
function commitPulls(
  github: Budget,
  repository: string,
  branch: string,
  listed: readonly ListedPull[],
  onBase: ReadonlySet<string>,
  problems: string[],
) {
  const bySha = new Map(listed.map((pull) => [pull.mergeSha, pull]))
  const cache = new Map<string, Promise<ListedPull[]>>()
  const missed = { count: 0 }
  return {
    // Every lookup the cap stopped, reported once at the end.
    missed: () => missed.count,
    async of(sha: string): Promise<ListedPull[]> {
      const known = bySha.get(sha)
      if (known) return [known]
      // A commit older than the window is no reviewed PR's.
      if (!onBase.has(sha)) return []
      if (!cache.has(sha)) {
        if (github.left() <= 0) {
          missed.count++
          if (missed.count === 1) problems.push("the API call cap was reached: some commits were not mapped to PRs")
          return []
        }
        cache.set(
          sha,
          github.get(`/repos/${repository}/commits/${sha}/pulls`).then((value) =>
            list(value, "a commit's PRs")
              .flatMap((item) => listedPull(item) ?? [])
              .filter((pull) => pull.base === branch),
          ),
        )
      }
      return (await cache.get(sha)) ?? []
    },
  }
}

async function revertDays(
  history: readonly BaseCommit[],
  window: readonly ListedPull[],
  repository: string,
  lookup: ReturnType<typeof commitPulls>,
) {
  const out = new Map<number, number>()
  const numbers = new Map(window.map((pull) => [pull.number, pull]))
  for (const commit of history) {
    const targets = revertsOf(commit, repository)
    const viaSha = await Promise.all(targets.shas.map((sha) => lookup.of(sha)))
    const reverted = [...new Set([...targets.pulls, ...viaSha.flat().map((pull) => pull.number)])]
    for (const number of reverted) {
      const pull = numbers.get(number)
      if (!pull || commit.at <= pull.mergedAt) continue
      const days = (commit.at - pull.mergedAt) / DAY
      out.set(number, Math.min(out.get(number) ?? days, days))
    }
  }
  return out
}

// Follow-up fixes and the reviewed PRs' lines they edited: the fix's deleted lines, blamed at its first parent along
// the first-parent history, so each blamed commit is a base-branch merge, squash or rebased commit. A commit that
// reverts anything, itself or through a commit it merged, is never a fix.
async function fixHits(
  history: readonly BaseCommit[],
  window: readonly ListedPull[],
  deps: { git: GitRead; lookup: ReturnType<typeof commitPulls>; repository: string },
) {
  const out = new Map<number, Hit[]>()
  if (!window.length) return out
  const numbers = new Set(window.map((pull) => pull.number))
  const first = Math.min(...window.map((pull) => pull.mergedAt))
  const last = Math.max(...window.map((pull) => pull.mergedAt)) + MATURITY_DAYS * DAY
  for (const commit of history) {
    if (commit.at <= first || commit.at > last || !commit.parents.length) continue
    const reverts = revertsOf(commit, deps.repository)
    if (reverts.shas.length || reverts.pulls.length) continue
    const [own] = await deps.lookup.of(commit.sha)
    const kind = fixKind(commit, own)
    if (!kind) continue
    const runs = parseUnifiedDiff(deps.git(["diff", "--unified=0", "-M", `${commit.sha}^1`, commit.sha])).flatMap(
      (file) =>
        lineRuns(
          file.hunks.flatMap((hunk) =>
            hunk.lines.flatMap((line) => (line.kind === "del" && line.oldLine ? [line.oldLine] : [])),
          ),
        ).map((run) => ({ path: file.oldPath ?? file.path, run })),
    )
    for (const entry of runs) {
      const blamed = blameLines(
        deps.git([
          "blame",
          "--line-porcelain",
          "--first-parent",
          "-L",
          `${entry.run[0]},${entry.run[1]}`,
          `${commit.sha}^1`,
          "--",
          entry.path,
        ]),
      )
      for (const line of blamed) {
        const pulls = (await deps.lookup.of(line.sha)).filter((pull) => numbers.has(pull.number))
        for (const pull of pulls) {
          const days = (commit.at - pull.mergedAt) / DAY
          if (days <= 0 || days > MATURITY_DAYS) continue
          out.set(pull.number, [
            ...(out.get(pull.number) ?? []),
            { fix: commit.sha, days, kind, path: line.path, line: line.line },
          ])
        }
      }
    }
  }
  return out
}

// Consecutive line numbers as [first, last] runs, for one blame call each.
function lineRuns(lines: readonly number[]): [number, number][] {
  return lines
    .toSorted((a, b) => a - b)
    .reduce<[number, number][]>((runs, line) => {
      const last = runs.at(-1)
      if (last && line === last[1] + 1) return [...runs.slice(0, -1), [last[0], line]]
      return [...runs, [line, line]]
    }, [])
}

// `git blame --line-porcelain`: each line's commit, its line number in that commit's file, and that file's path, which
// git still quotes under core.quotePath=false when it holds a quote, a backslash or a control character.
function blameLines(text: string) {
  return text.split("\n").reduce<{ sha: string; line: number; path: string }[]>((out, row) => {
    const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/.exec(row)
    if (header) return [...out, { sha: header[1]!, line: Number(header[2]), path: "" }]
    const last = out.at(-1)
    if (last && row.startsWith("filename ")) last.path = unquotedPath(row.slice("filename ".length))
    return out
  }, [])
}

// A C-quoted git path, read as diff.ts readQuoted reads one: octal escapes are bytes of UTF-8, and \a to \r, \" and
// \\ are their characters.
function unquotedPath(text: string) {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text
  const encoder = new TextEncoder()
  const bytes = [...text.slice(1, -1).matchAll(/\\([0-7]{1,3}|[\s\S])|[^\\]+/g)].flatMap((match) => {
    const escape = match[1]
    if (escape === undefined) return [...encoder.encode(match[0])]
    if (/^[0-7]+$/.test(escape)) return [parseInt(escape, 8) & 0xff]
    const known = C_ESCAPES[escape]
    return known === undefined ? [...encoder.encode(escape)] : [known]
  })
  return new TextDecoder().decode(new Uint8Array(bytes))
}

function ledgerPull(
  read: PullRead,
  ctx: { observed: number; key: Uint8Array; reverts: Map<number, number>; hits: Map<number, Hit[]> },
): LedgerPull {
  const pull = read.pull
  const state = read.state
  const ripe = matured(pull.mergedAt, ctx.observed)
  const reverted = ctx.reverts.get(pull.number)
  const hits = ctx.hits.get(pull.number) ?? []
  const kept = ripe && (reverted === undefined || reverted > MATURITY_DAYS)
  return {
    number: pull.number,
    author: hashLogin(pull.author.login, ctx.key),
    stratum: read.stratum,
    reviewed: !!state,
    humanReview: read.humanReview,
    createdAt: new Date(pull.createdAt).toISOString(),
    mergedAt: new Date(pull.mergedAt).toISOString(),
    cycleHours: Math.max(0, (pull.mergedAt - pull.createdAt) / 3_600_000),
    reviews: state?.reviews ?? 0,
    rereviews: Math.max((state?.reviews ?? 0) - 1, 0),
    costUsd: state?.costUsd ?? 0,
    statePruned:
      !!state &&
      (state.findings.length >= MAX_SUMMARY_FINDINGS || encodeState(state).length > MAX_STATE_CHARS - PRUNE_MARGIN),
    ...(read.risk ? { band: read.risk.band, score: read.risk.score } : {}),
    truncated: read.truncated.length > 0,
    matured: ripe,
    ...(ripe && reverted !== undefined ? { revertedDays: reverted } : {}),
    ...(ripe
      ? {
          fixes: [...Map.groupBy(hits, (hit) => hit.fix).values()].map((group) => ({
            days: group[0]!.days,
            lines: group.length,
            kind: group[0]!.kind,
          })),
        }
      : {}),
    ...(kept && state ? { lines: lineCounts(read, hits) } : {}),
  }
}

// Each fix-edited line of a matured, not-reverted PR: skipped by the default rules, left unreviewed by the last run,
// flagged by a finding on its file within DEFAULT_SLACK lines of its anchor or of a line it also names, or escaped.
function lineCounts(read: PullRead, hits: readonly Hit[]) {
  const unreviewed = new Set(read.state?.unreviewed ?? [])
  const near = (hit: Hit) => read.findings.some((finding) => !!finding.place && touches(finding.place, hit))
  return hits.reduce(
    (counts, hit) => {
      const kind = read.skipped.has(hit.path)
        ? "skipped"
        : unreviewed.has(hit.path)
          ? "unreviewed"
          : near(hit)
            ? "flagged"
            : "escaped"
      return { ...counts, edited: counts.edited + 1, [kind]: counts[kind] + 1 }
    },
    { edited: 0, flagged: 0, escaped: 0, unreviewed: 0, skipped: 0 },
  )
}

function touches(place: Place, hit: Hit) {
  return place.path === hit.path && place.lines.some((line) => Math.abs(line - hit.line) <= DEFAULT_SLACK)
}

function ledgerFindings(
  read: PullRead,
  ctx: { observed: number; key: Uint8Array; reverts: Map<number, number>; hits: Map<number, Hit[]> },
): LedgerFinding[] {
  const reverted = ctx.reverts.get(read.pull.number)
  const kept = matured(read.pull.mergedAt, ctx.observed) && (reverted === undefined || reverted > MATURITY_DAYS)
  const hits = ctx.hits.get(read.pull.number) ?? []
  return read.findings.map((finding) => {
    const result = finding.result
    const stratum: Stratum =
      read.stratum === "agent" ? "agent" : read.bulk.has(finding.prior.id) ? "bulk" : read.stratum
    const place = finding.place
    return {
      pr: read.pull.number,
      id: finding.prior.id,
      where: finding.prior.where,
      severity: finding.prior.severity,
      category: finding.prior.category,
      outcome: result.outcome,
      stratum,
      humanEngaged: result.humanEngaged,
      ...(result.resolver ? { resolver: result.resolver } : {}),
      ...(result.dismissedBy ? { dismisser: hashLogin(result.dismissedBy, ctx.key) } : {}),
      ...(kept
        ? {
            laterFixed: !!place && hits.some((hit) => touches(place, hit)),
          }
        : {}),
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Expiry

// Every entry the report reads, checked before it reads any (I-8): anyone with the public key can seal a payload, and
// an unknown outcome or a non-numeric cycle time would make rates silently wrong.
const IsoDate = Schema.String.check(Schema.makeFilter((value: string) => Number.isFinite(Date.parse(value))))
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Amount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const PullNumber = Schema.Int.check(Schema.isGreaterThan(0))
const LedgerEntries = Schema.Struct({
  repository: Schema.String,
  branch: Schema.String,
  observedUntil: IsoDate,
  merged: Schema.Struct({ since: IsoDate, until: IsoDate }),
  pulls: Schema.Array(
    Schema.Struct({
      number: PullNumber,
      author: Schema.String,
      stratum: Schema.Literals(["human", "agent", "agent-signal"]),
      reviewed: Schema.Boolean,
      humanReview: Schema.Boolean,
      createdAt: IsoDate,
      mergedAt: IsoDate,
      cycleHours: Amount,
      reviews: Count,
      rereviews: Count,
      costUsd: Amount,
      statePruned: Schema.Boolean,
      band: Schema.optionalKey(Schema.Literals(RISK_BANDS)),
      score: Schema.optionalKey(Schema.Finite),
      truncated: Schema.Boolean,
      matured: Schema.Boolean,
      revertedDays: Schema.optionalKey(Amount),
      fixes: Schema.optionalKey(
        Schema.Array(Schema.Struct({ days: Amount, lines: Count, kind: Schema.Literals(["label", "title"]) })),
      ),
      lines: Schema.optionalKey(
        Schema.Struct({ edited: Count, flagged: Count, escaped: Count, unreviewed: Count, skipped: Count }),
      ),
    }),
  ),
  findings: Schema.Array(
    Schema.Struct({
      pr: PullNumber,
      id: Schema.String,
      where: Schema.Literals(["inline", "summary"]),
      severity: Schema.Literals(SEVERITIES),
      category: Schema.Literals(CATEGORIES),
      outcome: Schema.Literals(OUTCOMES),
      stratum: Schema.Literals(STRATA),
      humanEngaged: Schema.Boolean,
      resolver: Schema.optionalKey(Schema.Literals(RESOLVERS)),
      dismisser: Schema.optionalKey(Schema.String),
      laterFixed: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  problems: Schema.Array(Schema.String),
})

// Why a ledger cannot be opened now, or undefined. The bounds are checked because anyone with the public key can seal
// a payload: a collection time in the future, or an expiry more than LEDGER_DAYS after it, is refused, and so is any
// entry the report could not read.
export function ledgerProblem(value: unknown, now: number): string | undefined {
  const ledger = obj(value)
  if (ledger.schema !== LEDGER_SCHEMA) return `not a ${LEDGER_SCHEMA} ledger`
  const collected = Date.parse(str(ledger.collectedAt))
  const expires = Date.parse(str(ledger.expires))
  if (!Number.isFinite(collected)) return "the ledger has no collection date"
  if (!Number.isFinite(expires)) return "the ledger has no expiry date"
  if (collected > now + CLOCK_SKEW_MS) return "the ledger says it was collected after now"
  if (expires <= collected) return "the ledger expires before it was collected"
  if (expires - collected > LEDGER_DAYS * DAY)
    return `the ledger's expiry is more than ${LEDGER_DAYS} days after its collection`
  if (now >= expires) return `the ledger expired on ${str(ledger.expires).slice(0, 10)}: delete it`
  if (Option.isNone(Schema.decodeUnknownOption(LedgerEntries)(value))) return "the ledger is malformed"
  if (Date.parse(str(ledger.observedUntil)) > collected) return "the ledger's history ends after its collection"
  return undefined
}

// ---------------------------------------------------------------------------------------------------------------
// Report

// Cycle time in hours over a row's PRs (created to merged), or null for none: every result is paired with one.
export type Cycle = { p50: number; p90: number } | null

export interface OutcomeRow {
  settled: number
  byOutcome: Record<Outcome, number>
  confirmedFix: Proportion
  cycle: Cycle
}

export interface BandRow {
  pulls: number
  reverted: Record<(typeof LABEL_WINDOWS)[number], Proportion>
  fixed: Record<(typeof LABEL_WINDOWS)[number], Proportion> // over matured PRs not reverted within 90 days
  cycle: Cycle
}

// VS-45's gradient, with each severity's cycle time over the PRs of the findings it counts.
export type GradientReport = SeverityGradient & { cycle: Record<string, Cycle> }

export interface OutcomeReport {
  repository: string
  branch: string
  collectedAt: string
  observedUntil: string
  expires: string
  merged: { since: string; until: string }
  pulls: { total: number; reviewed: number; matured: number; truncated: number; byStratum: Record<PullStratum, number> }
  findings: { total: number; byStratum: Record<Stratum, number>; byOutcome: Record<Outcome, number> }
  volume: { settled90: number; decision: "full" | "gradient-only" }
  gradient: GradientReport // the confirmed-fix share of settled human-stratum findings, by severity
  sensitivity: GradientReport // any fix, model-only and self-resolved included, over settled plus those
  resolution?: { bySeverity: Record<string, OutcomeRow>; byCategory: Record<string, OutcomeRow> }
  // The confirmed-fix share by humanReview [GU19].
  humanPresence?: { withHuman: Proportion; withoutHuman: Proportion; cycle: { withHuman: Cycle; withoutHuman: Cycle } }
  writerDismissal?: { rate: Proportion; dismissers: number; cycle: Cycle }
  escapes?: {
    pulls: Proportion // matured, not-reverted, reviewed PRs with an escaped fix-edited line
    lines: { edited: number; flagged: number; escaped: number; unreviewed: number; skipped: number }
    cycle: Cycle
  }
  laterFixed?: Record<
    "dismissed-writer" | "dismissed-author" | "dismissed-unattributed" | "open-at-merge",
    { share: Proportion; cycle: Cycle }
  >
  rereviews?: {
    reviews: number
    rereviews: number
    share: Proportion
    costUsd: number
    spendShare: "not recorded"
    cycle: Cycle
  }
  bands?: { rows: Record<RiskBand, BandRow>; separation: "too-few" | "overlap" | "separated" }
  split: Record<"agent" | "agent-signal" | "bulk", Record<Outcome, number>>
  cycle: { n: number; p50: number; p90: number } | null
  problems: string[]
}

/**
 * The internal report (D12). Truncated PRs are left out of every count but the totals. Rates come from settled
 * human-stratum findings; a cell over fewer than MIN_SETTLED settled findings, or MIN_PULLS PRs or reviews, keeps its
 * count and interval and shows no rate. Below MIN_VOLUME settled human-stratum findings on PRs merged in the 90 days
 * before collection, only the gradient, its sensitivity row, the split and the counts are reported.
 */
export function outcomeReport(ledger: OutcomeLedger): OutcomeReport {
  const collected = Date.parse(ledger.collectedAt)
  const byNumber = new Map(ledger.pulls.map((pull) => [pull.number, pull]))
  const pulls = ledger.pulls.filter((pull) => !pull.truncated)
  const findings = ledger.findings.filter((finding) => byNumber.get(finding.pr)?.truncated === false)
  const human = findings.filter((finding) => finding.stratum === "human")
  const settled = human.filter((finding) => SETTLED.includes(finding.outcome))
  const settled90 = settled.filter(
    (finding) => Date.parse(byNumber.get(finding.pr)?.mergedAt ?? "") > collected - MATURITY_DAYS * DAY,
  ).length
  const decision = settled90 >= MIN_VOLUME ? "full" : "gradient-only"
  const matured = pulls.filter((pull) => pull.matured)
  const kept = matured.filter((pull) => pull.revertedDays === undefined || pull.revertedDays > MATURITY_DAYS)
  const keptNumbers = new Set(kept.map((pull) => pull.number))
  const cycleOf = (numbers: Iterable<number>): Cycle => {
    const found = spread([...new Set(numbers)].flatMap((number) => byNumber.get(number)?.cycleHours ?? []))
    return found ? { p50: found.p50, p90: found.p90 } : null
  }
  const overall = spread(pulls.map((pull) => pull.cycleHours))
  const base = {
    repository: ledger.repository,
    branch: ledger.branch,
    collectedAt: ledger.collectedAt,
    observedUntil: ledger.observedUntil,
    expires: ledger.expires,
    merged: ledger.merged,
    pulls: {
      total: ledger.pulls.length,
      reviewed: pulls.filter((pull) => pull.reviewed).length,
      matured: matured.length,
      truncated: ledger.pulls.length - pulls.length,
      byStratum: tally(
        ["human", "agent", "agent-signal"] as const,
        pulls.map((pull) => pull.stratum),
      ),
    },
    findings: {
      total: findings.length,
      byStratum: tally(
        STRATA,
        findings.map((finding) => finding.stratum),
      ),
      byOutcome: tally(
        OUTCOMES,
        findings.map((finding) => finding.outcome),
      ),
    },
    volume: { settled90, decision },
    gradient: gradientOf(human, ["fixed-confirmed-by-thread"], SETTLED, cycleOf),
    sensitivity: gradientOf(human, ANY_FIX, [...SETTLED, "fixed-self-resolved", "fixed-model-only"], cycleOf),
    split: {
      agent: tally(
        OUTCOMES,
        findings.filter((f) => f.stratum === "agent").map((f) => f.outcome),
      ),
      "agent-signal": tally(
        OUTCOMES,
        findings.filter((f) => f.stratum === "agent-signal").map((f) => f.outcome),
      ),
      bulk: tally(
        OUTCOMES,
        findings.filter((f) => f.stratum === "bulk").map((f) => f.outcome),
      ),
    },
    cycle: overall ? { n: overall.n, p50: overall.p50, p90: overall.p90 } : null,
    problems: ledger.problems,
  } satisfies OutcomeReport
  if (decision === "gradient-only") return base

  const row = (group: readonly LedgerFinding[]): OutcomeRow => {
    const counted = group.filter((finding) => SETTLED.includes(finding.outcome))
    return {
      settled: counted.length,
      byOutcome: tally(
        OUTCOMES,
        group.map((finding) => finding.outcome),
      ),
      confirmedFix: cell(
        counted.filter((f) => f.outcome === "fixed-confirmed-by-thread").length,
        counted.length,
        MIN_SETTLED,
      ),
      cycle: cycleOf(group.map((finding) => finding.pr)),
    }
  }
  const confirmed = (group: readonly LedgerFinding[]) =>
    cell(group.filter((f) => f.outcome === "fixed-confirmed-by-thread").length, group.length, MIN_SETTLED)
  const keptHuman = human.filter((finding) => keptNumbers.has(finding.pr))
  const later = (outcome: Outcome) => {
    const group = keptHuman.filter((finding) => finding.outcome === outcome)
    return {
      share: cell(group.filter((finding) => finding.laterFixed === true).length, group.length, MIN_SETTLED),
      cycle: cycleOf(group.map((finding) => finding.pr)),
    }
  }
  const prsOf = (group: readonly LedgerFinding[]) => group.map((finding) => finding.pr)
  const withHuman = settled.filter((f) => byNumber.get(f.pr)?.humanReview === true)
  const withoutHuman = settled.filter((f) => byNumber.get(f.pr)?.humanReview === false)
  const reviewedKept = kept.filter((pull) => pull.reviewed && pull.lines)
  const reviewed = pulls.filter((pull) => pull.reviewed)
  const reviews = reviewed.reduce((sum, pull) => sum + pull.reviews, 0)
  const rereviews = reviewed.reduce((sum, pull) => sum + pull.rereviews, 0)
  return {
    ...base,
    resolution: {
      bySeverity: Object.fromEntries(
        SEVERITIES.map((severity) => [severity, row(human.filter((f) => f.severity === severity))]),
      ),
      byCategory: Object.fromEntries(
        CATEGORIES.flatMap((category) => {
          const group = human.filter((f) => f.category === category)
          return group.length ? [[category, row(group)]] : []
        }),
      ),
    },
    humanPresence: {
      withHuman: confirmed(withHuman),
      withoutHuman: confirmed(withoutHuman),
      cycle: { withHuman: cycleOf(prsOf(withHuman)), withoutHuman: cycleOf(prsOf(withoutHuman)) },
    },
    writerDismissal: {
      rate: cell(settled.filter((f) => f.outcome === "dismissed-writer").length, settled.length, MIN_SETTLED),
      dismissers: new Set(
        settled.flatMap((f) => (f.outcome === "dismissed-writer" && f.dismisser ? [f.dismisser] : [])),
      ).size,
      cycle: cycleOf(prsOf(settled)),
    },
    escapes: {
      pulls: cell(reviewedKept.filter((pull) => (pull.lines?.escaped ?? 0) > 0).length, reviewedKept.length, MIN_PULLS),
      lines: reviewedKept.reduce(
        (sum, pull) => ({
          edited: sum.edited + (pull.lines?.edited ?? 0),
          flagged: sum.flagged + (pull.lines?.flagged ?? 0),
          escaped: sum.escaped + (pull.lines?.escaped ?? 0),
          unreviewed: sum.unreviewed + (pull.lines?.unreviewed ?? 0),
          skipped: sum.skipped + (pull.lines?.skipped ?? 0),
        }),
        { edited: 0, flagged: 0, escaped: 0, unreviewed: 0, skipped: 0 },
      ),
      cycle: cycleOf(reviewedKept.map((pull) => pull.number)),
    },
    laterFixed: {
      "dismissed-writer": later("dismissed-writer"),
      "dismissed-author": later("dismissed-author"),
      "dismissed-unattributed": later("dismissed-unattributed"),
      "open-at-merge": later("open-at-merge"),
    },
    rereviews: {
      reviews,
      rereviews,
      share: cell(rereviews, reviews, MIN_PULLS),
      costUsd: reviewed.reduce((sum, pull) => sum + pull.costUsd, 0),
      spendShare: "not recorded",
      cycle: cycleOf(reviewed.map((pull) => pull.number)),
    },
    bands: bandsOf(matured, cycleOf),
  }
}

function bandsOf(
  matured: readonly LedgerPull[],
  cycleOf: (numbers: Iterable<number>) => Cycle,
): NonNullable<OutcomeReport["bands"]> {
  const reverted = (pull: LedgerPull, days: number) => pull.revertedDays !== undefined && pull.revertedDays <= days
  const fixed = (pull: LedgerPull, days: number) => (pull.fixes ?? []).some((fix) => fix.days <= days)
  const rows = Object.fromEntries(
    RISK_BANDS.map((band) => {
      const inBand = matured.filter((pull) => pull.band === band)
      const clean = inBand.filter((pull) => !reverted(pull, MATURITY_DAYS))
      const windows = (test: (pull: LedgerPull, days: number) => boolean, group: readonly LedgerPull[]) =>
        Object.fromEntries(
          LABEL_WINDOWS.map((days) => [
            days,
            cell(group.filter((pull) => test(pull, days)).length, group.length, MIN_PULLS),
          ]),
        ) as Record<(typeof LABEL_WINDOWS)[number], Proportion>
      return [
        band,
        {
          pulls: inBand.length,
          reverted: windows(reverted, inBand),
          fixed: windows(fixed, clean),
          cycle: cycleOf(inBand.map((pull) => pull.number)),
        },
      ]
    }),
  ) as Record<RiskBand, BandRow>
  const banded = matured.filter((pull) => pull.band !== undefined)
  // Reverted or fixed within 90 days, over every matured PR of the band, with Wilson intervals.
  const interval = (band: RiskBand) => {
    const group = banded.filter((pull) => pull.band === band)
    return proportion(
      group.filter((pull) => reverted(pull, MATURITY_DAYS) || fixed(pull, MATURITY_DAYS)).length,
      group.length,
    ).interval
  }
  const low = interval("low")
  const high = interval("high")
  const separation =
    banded.length < MIN_MATURED || !low || !high
      ? "too-few"
      : low[1] >= high[0] && high[1] >= low[0]
        ? "overlap"
        : "separated"
  return { rows, separation }
}

// The share of `fixes` among `among`, by severity, through VS-45's severityGradient. A share over fewer than
// MIN_SETTLED findings keeps its count and interval and shows no value; the steps' own intervals decide the trend.
function gradientOf(
  findings: readonly LedgerFinding[],
  fixes: readonly Outcome[],
  among: readonly Outcome[],
  cycleOf: (numbers: Iterable<number>) => Cycle,
): GradientReport {
  const counted = findings.filter((finding) => among.includes(finding.outcome))
  const gradient = severityGradient(
    Object.fromEntries(
      SEVERITIES.map((severity) => {
        const group = counted.filter((finding) => finding.severity === severity)
        return [
          severity,
          { count: group.filter((finding) => fixes.includes(finding.outcome)).length, total: group.length },
        ]
      }),
    ),
  )
  return {
    ...gradient,
    shares: Object.fromEntries(
      Object.entries(gradient.shares).map(([name, share]) => [
        name,
        share.total < MIN_SETTLED ? { ...share, value: null } : share,
      ]),
    ),
    cycle: Object.fromEntries(
      Object.keys(gradient.shares).map((severity) => [
        severity,
        cycleOf(counted.filter((finding) => finding.severity === severity).map((finding) => finding.pr)),
      ]),
    ),
  }
}

function cell(count: number, total: number, minimum: number): Proportion {
  const value = proportion(count, total)
  return total < minimum ? { ...value, value: null } : value
}

function tally<const T extends string>(names: readonly T[], values: readonly T[]): Record<T, number> {
  return Object.fromEntries(names.map((name) => [name, values.filter((value) => value === name).length])) as Record<
    T,
    number
  >
}

export function renderOutcomes(report: OutcomeReport): string {
  const counts = (record: Record<string, number>) =>
    Object.entries(record)
      .filter((entry) => entry[1] > 0)
      .map(([name, value]) => `${name} ${value}`)
      .join(", ") || "none"
  const cycle = (value: Cycle) => (value ? `${hours(value.p50)} / ${hours(value.p90)}` : "n/a")
  const paired = (value: Cycle) => `cycle p50 / p90 ${cycle(value)} h`
  const lines = [
    "# Outcome ledger report",
    "",
    `Internal measurement: no accuracy or comparative claim (D12). Sealed; expires ${report.expires.slice(0, 10)}.`,
    "",
    `- Repository ${report.repository}, branch ${report.branch}; PRs merged ${report.merged.since.slice(0, 10)} to ${report.merged.until.slice(0, 10)}; collected ${report.collectedAt.slice(0, 10)}; the clone's history ends ${report.observedUntil.slice(0, 10)}.`,
    `- Pull requests: ${report.pulls.total} merged, ${report.pulls.reviewed} reviewed, ${report.pulls.matured} matured (merged at least ${MATURITY_DAYS} days before the clone's history ends), ${report.pulls.truncated} truncated and left out of every count below. By stratum: ${counts(report.pulls.byStratum)}.`,
    `- Findings: ${report.findings.total}. By stratum: ${counts(report.findings.byStratum)}. By outcome: ${counts(report.findings.byOutcome)}.`,
    `- Volume: ${report.volume.settled90} settled human-stratum findings on PRs merged in the ${MATURITY_DAYS} days before collection; ${report.volume.decision === "full" ? "the full report follows" : `fewer than ${MIN_VOLUME}, so only the severity gradient is reported`}.`,
    `- Cycle time (hours, p50 / p90): ${report.cycle ? `${cycle(report.cycle)} over ${report.cycle.n} PRs` : "n/a"}. Every rate below carries its own.`,
    "",
    "## Severity gradient",
    "",
    `The confirmed-fix share of settled human-stratum findings (fixed and resolved by a person who is neither a bot nor the PR author, over ${SETTLED.join(", ")}). A share over fewer than ${MIN_SETTLED} findings shows its count and interval only.`,
    "",
    ...gradientTable(report.gradient, cycle),
    "",
    "Sensitivity: every fix, model-only and self-resolved included, over settled findings plus those.",
    "",
    ...gradientTable(report.sensitivity, cycle),
    "",
    "## Split out",
    "",
    `Never pooled with the human stratum. Agent: ${counts(report.split.agent)}. Agent signal (untrusted, split only): ${counts(report.split["agent-signal"])}. Bulk resolutions: ${counts(report.split.bulk)}.`,
  ]
  const full = report.resolution
    ? [
        "",
        "## Resolution",
        "",
        "| Row | Settled | Confirmed fixes | Cycle p50 / p90 (h) | Outcomes |",
        "| --- | --- | --- | --- | --- |",
        ...Object.entries(report.resolution.bySeverity).map(
          ([name, row]) =>
            `| ${name} | ${row.settled} | ${formatCell(row.confirmedFix)} | ${cycle(row.cycle)} | ${counts(row.byOutcome)} |`,
        ),
        ...Object.entries(report.resolution.byCategory).map(
          ([name, row]) =>
            `| ${name} | ${row.settled} | ${formatCell(row.confirmedFix)} | ${cycle(row.cycle)} | ${counts(row.byOutcome)} |`,
        ),
        "",
        `- Human presence [GU19]: confirmed fixes with a person reviewing ${formatCell(report.humanPresence!.withHuman)} (${paired(report.humanPresence!.cycle.withHuman)}), without ${formatCell(report.humanPresence!.withoutHuman)} (${paired(report.humanPresence!.cycle.withoutHuman)}).`,
        `- Writer dismissals: ${formatCell(report.writerDismissal!.rate)} of settled findings, by ${report.writerDismissal!.dismissers} distinct writers (${paired(report.writerDismissal!.cycle)}).`,
        `- Escapes: ${formatCell(report.escapes!.pulls)} of matured, not-reverted reviewed PRs had a fix-edited line with no finding within ${DEFAULT_SLACK} lines (${paired(report.escapes!.cycle)}). Lines: ${counts(report.escapes!.lines)}. Skip rules other than the defaults are not re-applied, so escapes are overstated.`,
        `- Later fixed within ${MATURITY_DAYS} days: ${Object.entries(report.laterFixed!)
          .map(([name, value]) => `${name} ${formatCell(value.share)} (${paired(value.cycle)})`)
          .join(", ")}.`,
        `- Re-reviews: ${report.rereviews!.rereviews} of ${report.rereviews!.reviews} reviews (${formatCell(report.rereviews!.share)}; ${paired(report.rereviews!.cycle)}); total spend ${report.rereviews!.costUsd.toFixed(2)} USD. The re-review share of spend is not recorded: the state keeps only a PR's total.`,
        "",
        "## Risk band against post-merge outcomes",
        "",
        "| Band | Matured PRs | Reverted 30 d | Reverted 90 d | Fixed 30 d | Fixed 90 d | Cycle p50 / p90 (h) |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        ...RISK_BANDS.map((band) => {
          const row = report.bands!.rows[band]
          return `| ${band} | ${row.pulls} | ${formatCell(row.reverted[30])} | ${formatCell(row.reverted[90])} | ${formatCell(row.fixed[30])} | ${formatCell(row.fixed[90])} | ${cycle(row.cycle)} |`
        }),
        "",
        `A fix rate counts only matured PRs not reverted within ${MATURITY_DAYS} days: a backed-out PR is neither positive nor clean. Separation: ${report.bands!.separation}.${
          report.bands!.separation === "overlap"
            ? " The low and high bands' intervals overlap: document riskOf as a size, reach and sensitivity heuristic for this repository, and never enable history risk areas for it."
            : report.bands!.separation === "too-few"
              ? ` Fewer than ${MIN_MATURED} matured PRs with a band, or an empty low or high band.`
              : ""
        }`,
      ]
    : []
  const problems = report.problems.length
    ? ["", "## Problems", "", ...report.problems.map((problem) => `- ${problem}`)]
    : []
  return [...lines, ...full, ...problems, ""].join("\n")
}

function gradientTable(gradient: GradientReport, cycle: (value: Cycle) => string) {
  return [
    "| Severity | Share | Steps | Cycle p50 / p90 (h) |",
    "| --- | --- | --- | --- |",
    ...Object.entries(gradient.shares).map(([name, share]) => {
      const steps = gradient.steps
        .filter((step) => step.higher === name)
        .map((step) => `${step.trend} to ${step.lower}`)
        .join(", ")
      return `| ${name} | ${formatCell(share)} | ${steps || "-"} | ${cycle(gradient.cycle[name] ?? null)} |`
    }),
    "",
    `Trend: ${gradient.trend}${gradient.flagged ? " (flagged: flat or inverted)" : ""}.`,
  ]
}

function formatCell(value: Proportion) {
  const interval = value.interval ? ` [${percent(value.interval[0])}, ${percent(value.interval[1])}]` : ""
  return `${value.count}/${value.total}${value.value === null ? "" : ` ${percent(value.value)}`}${interval}`
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

function hours(value: number) {
  return value.toFixed(1)
}

// ---------------------------------------------------------------------------------------------------------------
// Command line

const USAGE = `Usage: bun script/vectorscope-eval/outcomes.ts collect --repository <owner/name> --repo-dir <clone> --since <YYYY-MM-DD> --out <dir> [options]
       bun script/vectorscope-eval/outcomes.ts open <sealed.json> <private-key.pem> <directory> [--ledger]

Run only after Q30 is answered, on a repository the owner nominates. Never in GitHub Actions.

collect:
  --repository <owner/name>  The nominated repository; gh must be signed in
  --repo-dir <path>          A full (not shallow, not partial) clone of it, with its base branch fetched
  --since <date>             The first merge day of the window
  --until <date>             The last merge day (default: today)
  --branch <name>            The base branch (default: the repository's default branch)
  --bot <login>              The review job's login (repeatable; default github-actions[bot])
  --agent-prs <path>         The owner's trusted record of agent-authored PRs: {"repository": "<owner/name>", "pulls": [1, 2]}
  --out <dir>                Where the sealed ledger goes: absolute, outside every git work tree
                             The ledger is sealed to ${PUBLIC_KEY_ENV}.
open:
  --ledger                   Also write the ledger itself, beside the report
`

const OPTIONS = {
  repository: { type: "string" },
  "repo-dir": { type: "string" },
  since: { type: "string" },
  until: { type: "string" },
  branch: { type: "string" },
  bot: { type: "string", multiple: true },
  "agent-prs": { type: "string" },
  out: { type: "string" },
  ledger: { type: "boolean" },
  help: { type: "boolean" },
} as const

export async function main(
  argv: readonly string[],
  deps: {
    env?: Record<string, string | undefined>
    github?: GitHubRead
    git?: GitRead
    now?: number
    key?: Uint8Array
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const parsed = parseArgs({ args: [...argv], options: OPTIONS, strict: false, allowPositionals: true })
  const values = parsed.values
  const unknown = Object.keys(values).filter((name) => !Object.hasOwn(OPTIONS, name))
  if (values.help) return { code: 0, stdout: USAGE, stderr: "" }
  const [command, ...rest] = parsed.positionals
  if (unknown.length) return usage("Unknown option.")
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now()
  if (env.GITHUB_ACTIONS === "true")
    return refuse(
      1,
      "The outcome ledger never runs in GitHub Actions: its logs are public. Run it on the owner's machine.",
    )
  if (command === "collect" && !rest.length) return collectCommand(values, { ...deps, env, now })
  if (command === "open" && rest.length === 3) return openCommand(rest, values.ledger === true, now)
  return usage("Give collect with its options, or open with three paths.")
}

async function collectCommand(
  values: Record<string, string | boolean | (string | boolean)[] | undefined>,
  deps: { env: Record<string, string | undefined>; github?: GitHubRead; git?: GitRead; now: number; key?: Uint8Array },
) {
  const text = (name: string) => (typeof values[name] === "string" ? (values[name] as string) : undefined)
  // The key first: nothing is read unless the result can be sealed.
  const key = publicKey(deps.env[PUBLIC_KEY_ENV])
  if (typeof key === "string") return refuse(1, `${key}\nNothing was read.`)
  const repository = text("repository") ?? ""
  if (!REPOSITORY.test(repository)) return usage("Give --repository as owner/name.")
  const repoDir = text("repo-dir") ? resolve(text("repo-dir")!) : ""
  if (!repoDir || !statSync(repoDir, { throwIfNoEntry: false })?.isDirectory())
    return usage("Give --repo-dir, the path of a local clone of the repository.")
  if (!text("out") || !isAbsolute(text("out")!)) return usage("Give --out as an absolute directory.")
  const out = realPath(text("out")!)
  if (!outsideRepository(out, realPath(REPO_ROOT)) || !outsideRepository(out, realPath(repoDir)) || insideWorkTree(out))
    return usage(
      "--out must be outside the VectorScope checkout, the clone and every other git work tree, so the ledger is never committed.",
    )
  if (existsSync(join(out, SEALED_LEDGER)))
    return refuse(1, `${join(out, SEALED_LEDGER)} already exists. Nothing was read.`)
  const since = day(text("since"), false)
  const until = text("until") === undefined ? deps.now : day(text("until"), true)
  if (since === undefined || until === undefined || since > until || since > deps.now)
    return usage("Give --since (and --until) as YYYY-MM-DD, with since no later than until and today.")
  const bots = Array.isArray(values.bot)
    ? values.bot.filter((bot): bot is string => typeof bot === "string")
    : DEFAULT_BOTS
  if (!bots.length || !bots.every((bot) => LOGIN.test(bot))) return usage("Give each --bot as a GitHub login.")
  const agents = agentRecord(text("agent-prs"), repository, repoDir)
  if (typeof agents === "string") return usage(agents)

  const ledger = await collect(
    {
      repository,
      ...(text("branch") ? { branch: text("branch")! } : {}),
      since,
      until: Math.min(until, deps.now),
      bots,
      agentPulls: agents,
    },
    {
      github: deps.github ?? ghReader(repository),
      git: deps.git ?? localGit(repoDir),
      now: deps.now,
      // Random per run and never stored, so no hash can be recomputed from a login later.
      key: deps.key ?? randomBytes(32),
    },
  )
  mkdirSync(out, { recursive: true, mode: 0o700 })
  writePrivate(
    join(out, SEALED_LEDGER),
    JSON.stringify(seal({ [OUTCOME_LEDGER_FILE]: Buffer.from(JSON.stringify(ledger)) }, key)) + "\n",
  )
  const truncated = ledger.pulls.filter((pull) => pull.truncated).length
  return {
    code: 0,
    stdout: `Collected ${ledger.pulls.length} merged PR(s) (${truncated} truncated), ${ledger.findings.length} finding(s) and ${ledger.problems.length} problem(s), sealed to the owner's key in ${join(out, SEALED_LEDGER)}. It expires on ${ledger.expires.slice(0, 10)}. Open it with: bun script/vectorscope-eval/outcomes.ts open.\n`,
    stderr: "",
  }
}

function openCommand(paths: readonly string[], withLedger: boolean, now: number) {
  const [file = "", keyFile = "", directory = ""] = paths
  const target = realPath(directory)
  if (!outsideRepository(target, realPath(REPO_ROOT)) || insideWorkTree(target))
    return usage("The directory must be outside the VectorScope checkout and every other git work tree.")
  const sealedText = readText(resolve(file))
  if (sealedText === undefined) return refuse(1, `Cannot read the sealed file ${resolve(file)}. Nothing was written.`)
  const pem = readText(resolve(keyFile))
  if (pem === undefined) return refuse(1, `Cannot read the private key ${resolve(keyFile)}. Nothing was written.`)
  const sealed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(sealedText)
  if (Option.isNone(sealed)) return refuse(1, "The sealed file is not valid JSON. Nothing was written.")
  const files = unsealed(sealed.value, pem)
  if (!files) return refuse(1, "The key does not open this file. Nothing was written.")
  const data = files[OUTCOME_LEDGER_FILE]
  if (!Object.hasOwn(files, OUTCOME_LEDGER_FILE) || !data) return refuse(1, "This sealed file holds no outcome ledger.")
  const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(data.toString("utf8"))
  if (Option.isNone(decoded))
    return refuse(1, "The ledger cannot be opened: it is not valid JSON. Nothing was written.")
  const problem = ledgerProblem(decoded.value, now)
  if (problem) return refuse(1, `The ledger cannot be opened: ${problem}. Nothing was written.`)
  // ledgerProblem checked every entry the report reads.
  const ledger = decoded.value as OutcomeLedger
  mkdirSync(target, { recursive: true, mode: 0o700 })
  writePrivate(join(target, REPORT_FILE), renderOutcomes(outcomeReport(ledger)))
  if (withLedger) writePrivate(join(target, OUTCOME_LEDGER_FILE), JSON.stringify(ledger, null, 2) + "\n")
  return {
    code: 0,
    stdout: `Wrote ${withLedger ? `${REPORT_FILE} and ${OUTCOME_LEDGER_FILE}` : REPORT_FILE} to ${target}. The ledger expires on ${ledger.expires.slice(0, 10)}: delete these files by then.\n`,
    stderr: "",
  }
}

// The owner's trusted record of agent-authored PRs. It may not live in the clone or the VectorScope checkout, whose
// files PR authors control (I-2).
function agentRecord(path: string | undefined, repository: string, repoDir: string): ReadonlySet<number> | string {
  if (path === undefined) return new Set()
  const file = realPath(path)
  if (!outsideRepository(file, realPath(REPO_ROOT)) || !outsideRepository(file, realPath(repoDir)))
    return "--agent-prs must be outside the clone and the VectorScope checkout: their files are not trusted."
  const text = readText(file)
  if (text === undefined) return "--agent-prs names no readable file."
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
  if (Option.isNone(parsed)) return "--agent-prs is not valid JSON."
  const record = obj(parsed.value)
  const pulls = record.pulls
  if (str(record.repository).toLowerCase() !== repository.toLowerCase())
    return `--agent-prs is a record for ${JSON.stringify(str(record.repository))}, not ${repository}.`
  if (!Array.isArray(pulls) || !pulls.every((value) => Number.isSafeInteger(value) && value > 0))
    return "--agent-prs must list its PRs as positive integers."
  return new Set(pulls as number[])
}

// Whether a path is inside a git work tree: some directory at or above it holds .git. Callers pass realPath's result,
// so a symbolic link cannot hide the work tree it points into.
function insideWorkTree(path: string): boolean {
  const dir = resolve(path)
  if (existsSync(join(dir, ".git"))) return true
  return dirname(dir) === dir ? false : insideWorkTree(dirname(dir))
}

// A path with every symbolic link in its existing part resolved, and the part that does not exist yet appended, so a
// link cannot carry an output or the trusted record into a work tree (I-13).
function realPath(path: string): string {
  const full = resolve(path)
  if (existsSync(full)) return realpathSync(full)
  return dirname(full) === full ? full : join(realPath(dirname(full)), basename(full))
}

// Written for the owner alone (mode 0600, kept when the file already existed): the ledger and its report keep PR
// numbers, which identify people (I-3, I-4).
function writePrivate(file: string, text: string) {
  writeFileSync(file, text, { mode: 0o600 })
  chmodSync(file, 0o600)
}

// A file's text, or undefined when it is missing or cannot be read.
function readText(path: string) {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

// unseal throws on a wrong or malformed key and on a file that is not a sealed bundle or was altered: all read as
// "this key does not open it".
function unsealed(sealed: unknown, pem: string) {
  try {
    return unseal(sealed as Sealed, pem)
  } catch {
    return undefined
  }
}

function day(value: string | undefined, end: boolean) {
  if (value === undefined || !DATE.test(value)) return undefined
  const at = Date.parse(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z`)
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value ? at : undefined
}

function usage(problem: string) {
  return { code: 2, stdout: "", stderr: `${problem}\n\n${USAGE}` }
}

function refuse(code: number, problem: string) {
  return { code, stdout: "", stderr: `${problem}\n` }
}

// ---------------------------------------------------------------------------------------------------------------
// Reading GitHub's JSON

type Json = Record<string, unknown>

function obj(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {}
}

function str(value: unknown) {
  return typeof value === "string" ? value : ""
}

function int(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`GitHub returned ${what} in a shape the ledger does not read.`)
  return value
}

async function pages(github: Budget, path: string, max: number, what: string) {
  const items: unknown[] = []
  for (let page = 1; page <= max; page++) {
    const batch = list(
      await github.get(`${path}${path.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page=${page}`),
      what,
    )
    items.push(...batch)
    if (batch.length < PER_PAGE) return { items, capped: false }
  }
  return { items, capped: true }
}

function listedPull(value: unknown): ListedPull | undefined {
  const item = obj(value)
  const number = int(item.number)
  const mergedAt = Date.parse(str(item.merged_at))
  if (number === undefined || !Number.isFinite(mergedAt)) return undefined
  const created = Date.parse(str(item.created_at))
  const user = obj(item.user)
  return {
    number,
    title: str(item.title),
    labels: (Array.isArray(item.labels) ? item.labels : []).map((label) => str(obj(label).name)).filter(Boolean),
    author: { login: str(user.login), ...(str(user.type) ? { type: str(user.type) } : {}) },
    createdAt: Number.isFinite(created) ? created : mergedAt,
    mergedAt,
    updatedAt: Date.parse(str(item.updated_at)),
    mergeSha: str(item.merge_commit_sha).toLowerCase(),
    base: str(obj(item.base).ref),
  }
}

function prFile(value: unknown): GitHubPrFile {
  const item = obj(value)
  const status = str(item.status)
  return {
    filename: str(item.filename),
    status:
      (["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"] as const).find(
        (entry) => entry === status,
      ) ?? "modified",
    additions: int(item.additions) ?? 0,
    deletions: int(item.deletions) ?? 0,
    ...(str(item.patch) ? { patch: str(item.patch) } : {}),
    ...(str(item.previous_filename) ? { previous_filename: str(item.previous_filename) } : {}),
  }
}

// A login is a bot's when it ends in [bot]: REST names a bot so, graphLogin gives a GraphQL Bot actor that form, and
// every --bot is normalised to it.
function isBotLogin(login: string) {
  return /\[bot\]$/i.test(login)
}

if (import.meta.main) {
  const result = await main(process.argv.slice(2))
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exit(result.code)
}
