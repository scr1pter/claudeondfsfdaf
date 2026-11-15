#!/usr/bin/env bun
import { createHmac, createPrivateKey, hkdfSync, randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path"
import { parseArgs } from "node:util"
import { Option, Schema } from "effect"
import { fromGitHubFiles, parseUnifiedDiff, type GitHubPrFile } from "../../packages/core/src/review/diff"
import {
  DEFAULT_CONFIDENCE,
  DEFAULT_SLACK,
  independentDifference,
  proportion,
  severityGradient,
  wilson,
  type Proportion,
  type SeverityGradient,
} from "../../packages/core/src/review/eval"
import { spread } from "../../packages/core/src/review/eval-report"
import { classifyFiles, classifyPath } from "../../packages/core/src/review/ignore"
import {
  FIX_SUBJECT,
  REVERT_SUBJECT,
  RISK_BANDS,
  RISK_CUTPOINTS,
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
import { BULK_RESOLVE_THREADS, DISMISSAL_WHY, type DismissalMarker } from "../../packages/core/src/review/team"
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
// retrieval or Brain (I-13), and its results are internal (D12): the report claims no accuracy and compares nothing
// outside the repository's own PRs (the risk band against size and random order, VS-46c).
//
//   collect  Reads one repository's PRs merged in a window and writes only <out>/vectorscope-outcomes.sealed.json,
//            sealed to PUBLIC_KEY_ENV. It refuses to start in GitHub Actions, whose logs are public, and checks the
//            key before any read. It prints counts only.
//   open     On the owner's machine: unseals a ledger, refuses an expired one, and writes the report (and, with
//            --ledger, the ledger itself) to a directory outside every git work tree. With --audit it also writes
//            VS-46d's audit sample for the owner to label by hand, and --labels reads those answers back.
//
// Schema 2 (addendum B §1.8 and §1.9: VS-46c and VS-46d as one schema change) keeps every v1 field with its v1 value
// and adds what their report sections need: per-PR line counts, a second, filtered follow-up-fix label (blame with -w,
// -M and -C over code lines only) beside the unfiltered one, the kinds of each fix's blamed lines, hashed fix
// locations, the same-agent flag from the trusted record, and the base branch's subject counts and fix commits.
// Collection writes only schema 2. `open` still reads a schema-1 ledger, read-only and as v1: it is never upgraded, and
// every schema-2 section reads "unavailable". Collection also seals VS-46c's measurement rule into the ledger, so the
// report applies the rule that was fixed before any outcome was seen; a schema-2 ledger SF-03's collection sealed has
// none, and its report applies the report config's rule and says so.

export const LEDGER_SCHEMA = "vectorscope-outcomes/2"
export const LEDGER_SCHEMA_V1 = "vectorscope-outcomes/1"
// What every schema-2 report section says for a schema-1 ledger.
export const V1_UNAVAILABLE = "unavailable: a /1 ledger has no added or deleted counts"
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
// The band-separation check needs this many matured PRs with a band, and so does the measurement verdict.
export const MIN_MATURED = 200
// VS-46c (addendum B §1.8 item 1): a comparison with fewer expected positives than this in either compared group (the
// group's PRs times the label's rate, pooled over every band) is underpowered and gives no verdict.
export const MIN_EXPECTED = 10
// The top shares of matured PRs at which capture is compared (item 4).
export const CAPTURE_OVERHEADS = [0.1, 0.2, 0.5] as const
// The normal quantiles behind the minimum detectable effect: two-sided at DEFAULT_CONFIDENCE (0.95), the level the
// bootstrap interval uses too (a test holds the two equal), and 80% power. Core's normalQuantile is not exported.
export const Z_ALPHA = 1.959963984540054
export const Z_POWER = 0.8416212335729143

// VS-46c's measurement rule (item 6): pre-registered here, in the report config, before any schema-2 ledger is
// collected, and sealed into each ledger at collection. The report applies the ledger's own rule, not this one, and says
// when the two differ. A schema-2 ledger SF-03's collection sealed carries no rule: the report applies this one to it,
// and says so.
export interface MeasurementRule {
  margin: number // no-better-than-size: the band-minus-size interval lies wholly below this, in capture-share points
  overhead: (typeof CAPTURE_OVERHEADS)[number] // the top share the verdict reads
  seed: number // the bootstrap's seed, so a rerun gives the same intervals
  replicates: number
}
export const MEASUREMENT_RULE: Readonly<MeasurementRule> = Object.freeze({
  margin: 0.05,
  overhead: 0.2,
  seed: 46_003,
  replicates: 2000,
})
export type MeasurementVerdict = "underpowered" | "beats-size" | "no-better-than-size" | "undecided"
// VS-46d item 1's label audit (addendum B §1.9; SF-05a). `open --audit` writes AUDIT_FILE beside the report: a seeded
// sample of up to AUDIT_DRAW positive and AUDIT_DRAW negative PRs on the filtered follow-up-fix label, for the owner to
// answer by hand on their own machine. `open --labels` reads the answers back. The filtered label counts as audited once
// at least AUDIT_PER_LABEL of each are answered, so up to AUDIT_DRAW − AUDIT_PER_LABEL of each may be skipped.
export const AUDIT_FILE = "outcomes-audit.json"
export const AUDIT_SCHEMA = "vectorscope-outcomes-audit/1"
export const AUDIT_PER_LABEL = 50
export const AUDIT_DRAW = 60
export const AUDIT_QUESTION = `Did a commit merged within ${MATURITY_DAYS} days after this PR fix a defect this PR introduced? Set fixInducing to true or false, or leave it null to skip this PR (at most ${AUDIT_DRAW - AUDIT_PER_LABEL} of each label). For a positive, its filtered and unfiltered fixes say where the label looked: check that a fix changes behaviour this PR added, not only formatting, comments or where code sits.`
// The HKDF info auditKey derives the audit's key with: changing it redraws every sample.
export const AUDIT_INFO = "vectorscope-outcomes audit ids/1"
// A labels file larger than this is refused before it is read. A sample's own file, at most 2 × AUDIT_DRAW entries,
// stays far below it.
export const MAX_LABELS_BYTES = 4 * 1024 * 1024
// VS-46d items 5 to 11's report (addendum B §1.9; SF-05b). Items 5 and 9 compare PRs within size terciles: the matured
// PRs with a band, every stratum, cut by added plus deleted lines into three groups of about equal count.
export const TERCILES = ["small", "middle", "large"] as const
export type Tercile = (typeof TERCILES)[number]
// Item 5's proxy for the review's verdict: ReviewState records none until SF-39, and no ledger reads one before a /3.
export const VERDICT_PROXIES = ["clean", "findings", "incomplete", "unreviewed"] as const
export type VerdictProxy = (typeof VERDICT_PROXIES)[number]
// Item 10: an earlier fix counts toward recurrence when it lies within this many days before the reviewed PR's merge.
export const RECURRENCE_DAYS = 365
// Item 11's kill criterion: latent-forecast precision under LATENT_KILL_PRECISION on at least LATENT_MIN_DROPS matured
// drops. The report says whether the criterion is met; the decision is the owner's.
export const LATENT_KILL_PRECISION = 0.1
export const LATENT_MIN_DROPS = 100
// latentDrops reads at most this many drops from one artifact: anyone who can write the file sets its length.
export const MAX_LATENT_DROPS = 10_000
// Item 11's status when latent outcomes were given and hold none, and when none were given: `open` reads no eval
// artifact and nothing joins drops to later fixes yet, so it passes none, and the report cannot say none were recorded.
export const NO_DROPS = "no drops recorded"
export const NO_DROPS_READ = "no drops read: open reads no eval artifact and no join is built"
// Item 6: schema 2 keeps each dismissal's role (writer, author or unattributed), not its reason.
export const NO_DISMISSAL_REASON = "unavailable: schema 2 records no dismissal reason"
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
// A fix commit keeps at most this many hashed locations (its first, in diff order); `capped` says when it had more.
export const MAX_FIX_LOCATIONS = 32
// The filtered pass blames a file whole only up to this many lines at the fix's first parent. A longer file, or one the
// default skip rules leave out (lockfiles, generated and vendored files), is blamed by its deleted lines' runs, as v1's
// own blame is, so its cost is bounded as v1's is.
export const MAX_FILTERED_BLAME_LINES = 5000

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
// The most PRs the merged-PR listing reads, and so the most a schema-2 ledger may hold: its decoder checks it.
export const MAX_LEDGER_PULLS = MAX_PULL_PAGES * PER_PAGE
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
// git's empty tree, which every repository holds without storing it: SHA-1 and SHA-256.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const EMPTY_TREE_SHA256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"
// What readPull classifies a PR's files with: the default skip rules, no .gitattributes.
const SKIP_RULES = {
  config: { ignore: DEFAULT_REVIEW_CONFIG.ignore, ignoreDefaults: DEFAULT_REVIEW_CONFIG.ignoreDefaults },
}
// The same regular expression the impact builder reads a clone's mode with (packages/engine/src/review/impact.ts).
const PARTIAL_CLONE = "^(extensions\\.partialclone|remote\\..*\\.promisor)$"
// A hunk header's ranges; what follows them is git's funcname for the hunk (diff.ts HUNK_HEADER).
const HUNK_RANGE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?/
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

// A schema-1 ledger, as VS-46a collected it. `open` still reads one, read-only.
export interface OutcomeLedgerV1 {
  schema: typeof LEDGER_SCHEMA_V1
  repository: string // "owner/name": one nominated repository per ledger
  branch: string
  collectedAt: string // ISO 8601
  // The newest committer time on the clone's first-parent history, capped at collectedAt: the clone holds every commit
  // that reached the branch before it, so maturity and the label windows are measured to it.
  observedUntil: string
  expires: string // collectedAt plus LEDGER_DAYS
  merged: { since: string; until: string }
  logins: "hmac-sha256/per-run" // keyed with a random key that was never stored
  pulls: LedgerPullV1[]
  findings: LedgerFinding[]
  problems: string[] // reads cut short; the PR they touch is truncated
}

// Schema 2: every v1 field with its v1 value, and the fields VS-46c and VS-46d add.
export interface OutcomeLedger extends Omit<OutcomeLedgerV1, "schema" | "pulls"> {
  schema: typeof LEDGER_SCHEMA
  pulls: LedgerPull[]
  subjects: LedgerSubjects
  fixCommits: LedgerFixCommit[]
  rule?: MeasurementRule // MEASUREMENT_RULE as it was at collection; absent from a ledger SF-03's collection sealed
}

// The base branch's first-parent commits in the merge window, and how many of their subjects are fix-prefixed or
// revert-prefixed (subjectCounts).
export interface LedgerSubjects {
  commits: number
  fix: number
  revert: number
}

// One follow-up-fix candidate the scan blamed (a commit fixKind labels, in the window fixes are looked for): when, why,
// what kinds of line it deleted, and where it edited. A fix with no deleted line is the untraceable kind (VS-46d item 2).
export interface LedgerFixCommit {
  date: string // YYYY-MM-DD: the day, not the time, so the ledger keeps no commit's exact timestamp
  kind: "label" | "title"
  deleted: { code: number; blank: number; comment: number }
  locations: LedgerLocation[] // distinct, in diff order, at most MAX_FIX_LOCATIONS
  capped?: true
}

// A file, and the function git's hunk header names (its funcname, when it finds one), both hashed with hashName.
export interface LedgerLocation {
  path: string
  fn?: string
}

export interface LedgerFixV1 {
  days: number
  lines: number
  kind: "label" | "title"
}

// What the filter makes of each deleted line the unfiltered blame put on the PR: still the PR's under -w -M -C (code),
// dropped as blank or comment-only, or put elsewhere by -w alone (whitespace) or by -M and -C (moved). The five sum to
// the entry's `lines`.
export interface LedgerLineKinds {
  code: number
  blank: number
  comment: number
  whitespace: number
  moved: number
}

export interface LedgerFix extends LedgerFixV1 {
  commit: number // the fix commit's index in the ledger's fixCommits: a link within this ledger, not a new name
  deleted?: LedgerLineKinds // absent only on a PR marked filteredIncomplete, for the fix whose filtered pass was cut short
  sameAgent?: boolean // agent-stratum PRs only, and absent there only for a fix whose own PR the call cap left unknown
}

// The filtered label: `lines` are the code lines the filtered blame puts on the PR, never 0, so a non-empty list means
// fixed, as for `fixes`.
export interface LedgerFilteredFix extends LedgerFixV1 {
  commit: number
  location: LedgerLocation // where most of those lines are, the first in diff order on a tie
  sameAgent?: boolean
}

export interface LedgerPullV1 {
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
  fixes?: LedgerFixV1[] // matured only, within 90 days
  lines?: { edited: number; flagged: number; escaped: number; unreviewed: number; skipped: number } // matured, kept
}

export interface LedgerPull extends LedgerPullV1 {
  // With band: the reviewed files' added and deleted lines, as riskFeatures counts them for riskOf.
  added?: number
  deleted?: number
  // Reviewed PRs only: the files the state's last run left unreviewed, and comments by people other than the author
  // and the bots (issue comments, review-thread comments and reviews with a body).
  unreviewedFiles?: number
  humanComments?: number
  fixes?: LedgerFix[]
  fixesFiltered?: LedgerFilteredFix[] // matured only, as fixes
  // The call cap stopped a lookup of the filtered blame for a fix in this PR's label window: its filtered label is
  // incomplete, and the fix's `deleted` kinds are left out.
  filteredIncomplete?: true
  // Agent-stratum PRs only: the call cap stopped the lookup of a fix commit's own PR, so whether that fix is the same
  // agent's is unknown, and its entries carry no sameAgent.
  sameAgentIncomplete?: true
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

// Core's fix and revert words, anchored at the start: a fix-prefixed or revert-prefixed subject (VS-46c item 1). Unlike
// risk.ts's history count, which matches them anywhere in a subject, "Add a fix for x" is neither here.
const FIX_PREFIX = new RegExp(`^\\s*(?:${FIX_SUBJECT.source})`, FIX_SUBJECT.flags)
const REVERT_PREFIX = new RegExp(`^\\s*(?:${REVERT_SUBJECT.source})`, REVERT_SUBJECT.flags)
// GitHub's merge-commit subject, which names the source branch; GitHub puts the PR's title on the body's first line.
const GITHUB_MERGE = /^Merge pull request #\d+ from \S+/

/**
 * The base rate of fix-prefixed and revert-prefixed subjects: the base branch's first-parent commits with
 * `since <= at <= until`, each read by its subject, except a GitHub merge commit, which is read by its body's first line
 * (the PR title) when that line is not empty. Both word lists are anchored at the start, so no line is both a fix and
 * a revert. Git only: no PR is looked up.
 */
export function subjectCounts(
  history: readonly Pick<BaseCommit, "at" | "parents" | "subject" | "body">[],
  window: { since: number; until: number },
): LedgerSubjects {
  const lines = history
    .filter((commit) => commit.at >= window.since && commit.at <= window.until)
    .map((commit) => {
      const title = commit.body.split("\n")[0]?.trim() ?? ""
      return commit.parents.length > 1 && GITHUB_MERGE.test(commit.subject) && title ? title : commit.subject
    })
  return {
    commits: lines.length,
    fix: lines.filter((line) => FIX_PREFIX.test(line)).length,
    revert: lines.filter((line) => REVERT_PREFIX.test(line)).length,
  }
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

// A path or a hunk's function header, as the first 16 hex characters of an HMAC-SHA256 under the same per-run key,
// separated from logins and from each other by its kind, and case-sensitive. A per-run pseudonym, not a secret: nobody
// can hash a path without the key, but a PR number, its merge time and a fix's days name the fix commit to anyone who
// can read the repository, whose diff then links that entry's hashes to their paths, and every other use of the same
// hash in the ledger with them.
export function hashName(kind: "path" | "fn", text: string, key: Uint8Array): string {
  return createHmac("sha256", key).update(`${kind}\0${text}`).digest("hex").slice(0, 16)
}

// VS-46d item 1's audit key: HKDF-SHA256 over the owner's private key, read as its PKCS#8 DER so every PEM encoding of
// one key gives one audit key. `open` derives it in memory from the key it already reads to unseal, and never stores or
// prints it. So a ledger's sample is the same on every open, a PR keeps its id in every ledger of the repository sealed
// to that key, and nobody who holds only the public key or these files can tell which PRs a sample will draw: a PR
// author cannot steer a PR into or out of the audit. A new owner key draws a new sample, whose answers are given anew.
export function auditKey(pem: string): Uint8Array {
  return new Uint8Array(
    hkdfSync("sha256", createPrivateKey(pem).export({ type: "pkcs8", format: "der" }), "", AUDIT_INFO, 32),
  )
}

// A PR's audit id: the first 16 hex characters of an HMAC-SHA256 of its repository (lowercased) and number under the
// audit key. It is the join key between the sample and the owner's answers, not a pseudonym: the sample keeps each PR's
// number and fix days beside it.
function auditId(repository: string, number: number, key: Uint8Array) {
  return createHmac("sha256", key).update(`pr\0${repository.toLowerCase()}\0${number}`).digest("hex").slice(0, 16)
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
  humanComments: number
  risk?: { band: RiskBand; score: number; added: number; deleted: number }
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

// A follow-up-fix candidate as the unfiltered scan read it, for the filtered pass and the ledger's fix commits.
interface FixCommit {
  sha: string
  at: number
  kind: "label" | "title"
  own?: ListedPull // its PR, as the v1 scan looked it up
  ownUnknown: boolean // the call cap stopped that lookup, so `own` is not known to be absent
  files: {
    path: string // the path blamed at the first parent: a renamed file's old path
    // section: the hunk header's funcname. Each deleted line keeps its number and kind, never its text.
    hunks: { section: string; deleted: { line: number; kind: DeletedLineKind }[] }[]
  }[]
  // `${path}\0${line}` of each deleted line: the window PRs the unfiltered blame put it on within their label window.
  owners: Map<string, number[]>
}

interface FilteredRow {
  path: string
  section: string
  kind: DeletedLineKind
  line: number
  u: number[]
  f: number[]
  w: number[]
}

// What one fix's filtered pass makes of one PR's lines (LedgerLineKinds, and the filtered label).
interface Attribution {
  fix: string
  days: number
  kind: "label" | "title"
  deleted: LedgerLineKinds
  lines: number
  location?: { path: string; section: string }
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
  const scanned = await fixHits(history, window, { git, lookup, repository: input.repository })
  for (const read of reads) for (const reason of read.truncated) problems.push(`PR #${read.pull.number}: ${reason}`)
  // Schema 2's filtered pass runs after every v1 read, so v1's reads, their order and their problem lines are as they
  // were; at the call cap the filtered pass adds its own line after them.
  const filtered = await filteredFixes(scanned.fixes, window, { git, lookup })
  const ctx: LedgerContext = {
    observed,
    key: deps.key,
    reverts,
    hits: scanned.hits,
    filtered,
    fixes: new Map(scanned.fixes.map((fix, index) => [fix.sha, { index, own: fix.own, ownUnknown: fix.ownUnknown }])),
    trusted: input.agentPulls,
  }
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
    subjects: subjectCounts(history, { since: input.since, until: input.until }),
    fixCommits: scanned.fixes.map((fix) => ledgerFixCommit(fix, deps.key)),
    rule: { ...MEASUREMENT_RULE },
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
  const classified = classifyFiles(changed, SKIP_RULES)
  const features = files.capped ? undefined : riskFeatures(classified.review, { changed })
  const assessed = features ? riskOf(features) : undefined
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
  const humanComments =
    issueComments.filter((comment) => person(comment.user.login)).length +
    threads.threads.flatMap((thread) => thread.comments).filter((comment) => person(comment.author)).length +
    reviews.items.filter((item) => person(str(obj(obj(item).user).login)) && str(obj(item).body).trim() !== "").length
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
    humanComments,
    ...(assessed && features
      ? {
          risk: {
            band: assessed.band,
            score: assessed.likelihood.score,
            added: features.added,
            deleted: features.deleted,
          },
        }
      : {}),
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
    humanComments: 0,
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
  const missed = { v1: 0, filtered: 0 }
  // A commit's PRs, or undefined when the call cap stops the lookup.
  const find = (sha: string): Promise<ListedPull[]> | undefined => {
    const known = bySha.get(sha)
    if (known) return Promise.resolve([known])
    // A commit older than the window is no reviewed PR's.
    if (!onBase.has(sha)) return Promise.resolve([])
    if (!cache.has(sha)) {
      if (github.left() <= 0) return undefined
      cache.set(
        sha,
        github.get(`/repos/${repository}/commits/${sha}/pulls`).then((value) =>
          list(value, "a commit's PRs")
            .flatMap((item) => listedPull(item) ?? [])
            .filter((pull) => pull.base === branch),
        ),
      )
    }
    return cache.get(sha)
  }
  // v1's lookup, with v1's problem when the cap stops it; undefined then.
  const mapped = async (sha: string): Promise<ListedPull[] | undefined> => {
    const found = find(sha)
    if (found) return found
    missed.v1++
    if (missed.v1 === 1) problems.push("the API call cap was reached: some commits were not mapped to PRs")
    return undefined
  }
  return {
    // As v1 reads it: no PR when the cap stopped the lookup.
    of: async (sha: string): Promise<ListedPull[]> => (await mapped(sha)) ?? [],
    // The same, for a caller that must tell a commit with no PR from one the cap left unknown (a fix commit's own PR).
    mapped,
    // The filtered pass's lookups: the same cache and cap, but a miss is the filtered pass's own, with its own problem,
    // so it never reads as a v1 label left incomplete. Undefined when the cap stopped it.
    async filtered(sha: string): Promise<ListedPull[] | undefined> {
      const found = find(sha)
      if (found) return found
      missed.filtered++
      if (missed.filtered === 1)
        problems.push(
          "the API call cap was reached in the filtered blame: PRs marked filteredIncomplete have an incomplete filtered label",
        )
      return undefined
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
// reverts anything, itself or through a commit it merged, is never a fix. Each fix commit is also kept, with its
// deleted lines and which PR the blame put each on, for schema 2's filtered pass and fix commits; that adds no read.
async function fixHits(
  history: readonly BaseCommit[],
  window: readonly ListedPull[],
  deps: { git: GitRead; lookup: ReturnType<typeof commitPulls>; repository: string },
) {
  const out = new Map<number, Hit[]>()
  const fixes: FixCommit[] = []
  if (!window.length) return { hits: out, fixes }
  const numbers = new Set(window.map((pull) => pull.number))
  const first = Math.min(...window.map((pull) => pull.mergedAt))
  const last = Math.max(...window.map((pull) => pull.mergedAt)) + MATURITY_DAYS * DAY
  for (const commit of history) {
    if (commit.at <= first || commit.at > last || !commit.parents.length) continue
    const reverts = revertsOf(commit, deps.repository)
    if (reverts.shas.length || reverts.pulls.length) continue
    const mine = await deps.lookup.mapped(commit.sha)
    const own = mine?.[0]
    const kind = fixKind(commit, own)
    if (!kind) continue
    const diff = parseUnifiedDiff(deps.git(["diff", "--unified=0", "-M", `${commit.sha}^1`, commit.sha]))
    const runs = diff.flatMap((file) =>
      lineRuns(
        file.hunks.flatMap((hunk) =>
          hunk.lines.flatMap((line) => (line.kind === "del" && line.oldLine ? [line.oldLine] : [])),
        ),
      ).map((run) => ({ path: file.oldPath ?? file.path, run })),
    )
    const owners = new Map<string, number[]>()
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
          const at = `${entry.path}\0${line.final}`
          owners.set(at, [...(owners.get(at) ?? []), pull.number])
        }
      }
    }
    fixes.push({
      sha: commit.sha,
      at: commit.at,
      kind,
      ...(own ? { own } : {}),
      ownUnknown: mine === undefined,
      files: diff.map((file) => {
        const path = file.oldPath ?? file.path
        return {
          path,
          hunks: file.hunks.map((hunk) => ({
            section: hunk.header.replace(HUNK_RANGE, "").trim(),
            deleted: hunk.lines.flatMap((line) =>
              line.kind === "del" && line.oldLine
                ? [{ line: line.oldLine, kind: deletedLineKind(path, line.text) }]
                : [],
            ),
          })),
        }
      }),
      owners,
    })
  }
  return { hits: out, fixes }
}

/**
 * Schema 2's filtered label (VS-46d item 3): each fix commit's deleted code lines blamed again with -w -M -C, and the
 * kinds of every deleted line the unfiltered blame put on a PR. Blank and comment-only lines (deletedLineKind) are never
 * blamed by it. The blame covers the whole file at the fix's first parent: git blames a line moved to another file on
 * its mover when -L names only that line's range, and on its original commit over the whole file. A file the default
 * skip rules leave out, or one longer than MAX_FILTERED_BLAME_LINES, is blamed by its deleted code lines' runs instead,
 * as v1 blames it, so a line moved into it may stay on its mover. A code line the unfiltered blame puts on a PR and the
 * filtered one does not is blamed once more with -w alone, which tells the whitespace share from the move share.
 * Lookups share the v1 cache and call cap; a fix whose filtered lookups the cap stopped gets no attribution, and every
 * PR in its label window is marked incomplete instead.
 */
async function filteredFixes(
  fixes: readonly FixCommit[],
  window: readonly ListedPull[],
  deps: { git: GitRead; lookup: ReturnType<typeof commitPulls> },
): Promise<{ byPull: Map<number, Attribution[]>; incomplete: Set<number> }> {
  const byPull = new Map<number, Attribution[]>()
  const incomplete = new Set<number>()
  const pulls = new Map(window.map((pull) => [pull.number, pull]))
  for (const fix of fixes) {
    const labelled = (pull: ListedPull) => {
      const days = (fix.at - pull.mergedAt) / DAY
      return days > 0 && days <= MATURITY_DAYS
    }
    const cut = { short: false }
    const owned = async (sha: string | undefined) => {
      if (!sha) return []
      const found = await deps.lookup.filtered(sha)
      if (!found) cut.short = true
      return (found ?? []).filter((pull) => pulls.has(pull.number) && labelled(pull)).map((pull) => pull.number)
    }
    // Each deleted line, in diff order, with the PRs each blame puts it on: u unfiltered, f filtered, w with -w alone.
    const rows: FilteredRow[] = []
    for (const file of fix.files) {
      const deleted = file.hunks.flatMap((hunk) => hunk.deleted.map((line) => ({ ...line, section: hunk.section })))
      const code = deleted.filter((line) => line.kind === "code").map((line) => line.line)
      // Undefined for a whole-file blame; otherwise the runs a bounded one names.
      const runs =
        code.length &&
        (classifyPath(file.path, SKIP_RULES) !== undefined ||
          linesAt(deps.git, fix.sha, file.path) > MAX_FILTERED_BLAME_LINES)
          ? lineRuns(code)
          : undefined
      const filtered = code.length
        ? blameAt(deps.git, ["-w", "-M", "-C"], fix.sha, file.path, runs)
        : new Map<number, string>()
      const read: FilteredRow[] = []
      for (const line of deleted)
        read.push({
          path: file.path,
          section: line.section,
          kind: line.kind,
          line: line.line,
          u: fix.owners.get(`${file.path}\0${line.line}`) ?? [],
          f: line.kind === "code" ? await owned(filtered.get(line.line)) : [],
          w: [],
        })
      const disputed = read.filter((row) => row.kind === "code" && row.u.some((number) => !row.f.includes(number)))
      const spaced = disputed.length ? blameAt(deps.git, ["-w"], fix.sha, file.path, runs) : new Map<number, string>()
      for (const row of disputed) row.w = await owned(spaced.get(row.line))
      rows.push(...read)
    }
    if (cut.short) {
      for (const pull of window) if (labelled(pull)) incomplete.add(pull.number)
      continue
    }
    for (const number of new Set(rows.flatMap((row) => [...row.u, ...row.f]))) {
      const pull = pulls.get(number)!
      const mine = rows.filter((row) => row.u.includes(number))
      const away = mine.filter((row) => row.kind === "code" && !row.f.includes(number))
      const kept = rows.filter((row) => row.f.includes(number))
      // Where most of the PR's filtered lines are; Map keeps diff order, and a later place must have strictly more.
      const places = Map.groupBy(kept, (row) => `${row.path}\0${row.section}`)
      const top = [...places.values()].reduce<typeof kept | undefined>(
        (best, group) => (!best || group.length > best.length ? group : best),
        undefined,
      )
      byPull.set(number, [
        ...(byPull.get(number) ?? []),
        {
          fix: fix.sha,
          days: (fix.at - pull.mergedAt) / DAY,
          kind: fix.kind,
          deleted: {
            code: mine.filter((row) => row.kind === "code" && row.f.includes(number)).length,
            blank: mine.filter((row) => row.kind === "blank").length,
            comment: mine.filter((row) => row.kind === "comment").length,
            whitespace: away.filter((row) => !row.w.includes(number)).length,
            moved: away.filter((row) => row.w.includes(number)).length,
          },
          lines: kept.length,
          ...(top ? { location: { path: top[0].path, section: top[0].section } } : {}),
        },
      ])
    }
  }
  return { byPull, incomplete }
}

// `git blame --line-porcelain --first-parent` at a fix's first parent, with extra options, over the whole file or, given
// runs, one call per run as v1 blames: each blamed line, by its number there, and the commit blamed for it.
function blameAt(
  git: GitRead,
  options: readonly string[],
  sha: string,
  path: string,
  runs?: readonly [number, number][],
) {
  const ranges = runs?.map((run) => ["-L", `${run[0]},${run[1]}`]) ?? [[]]
  return new Map(
    ranges.flatMap((range) =>
      blameLines(
        git(["blame", "--line-porcelain", "--first-parent", ...options, ...range, `${sha}^1`, "--", path]),
      ).map((line) => [line.final, line.sha] as const),
    ),
  )
}

// A file's line count at a fix's first parent: its added lines against the empty tree (0 for a binary file). The
// `:(literal)` magic keeps a path a PR author named like a pathspec only a path.
function linesAt(git: GitRead, sha: string, path: string) {
  const empty = sha.length === 64 ? EMPTY_TREE_SHA256 : EMPTY_TREE
  return Number(git(["diff", "--numstat", empty, `${sha}^1`, "--", `:(literal)${path}`]).split("\t")[0]) || 0
}

export type DeletedLineKind = "code" | "blank" | "comment"

// Comment-only line starts, tested on the trimmed line. `#` is never one in C, C++, C#, Rust (preprocessor lines and
// attributes) or a PHP attribute, and a shebang is code. Block comments are not tracked: a deleted line inside one is
// code unless it starts like a comment line (`*` continuations do, and so does a C line that starts with `* `).
const SLASH = /^(?:\/\/|\/\*|\*\/|\*(?:\s|$))/
const BLOCK = /^(?:\/\*|\*\/|\*(?:\s|$))/
const MARKUP = /^<!--/
const HASH = /^#(?!!)/
const COMMENT_STARTS: readonly [string, readonly RegExp[]][] = [
  [
    "ts tsx mts cts js jsx mjs cjs go rs java kt kts scala groovy cs fs c h cc cpp cxx hpp hh m mm swift dart sol",
    [SLASH],
  ],
  ["proto scss less", [SLASH]],
  ["css", [BLOCK]],
  ["vue svelte astro", [SLASH, MARKUP]],
  ["html htm xhtml xml svg md markdown", [MARKUP]],
  ["php", [SLASH, /^#(?!\[)/]],
  ["tf hcl", [SLASH, HASH]],
  ["py pyi rb sh bash zsh pl r jl ex exs graphql yml yaml toml nix cmake", [HASH]],
  ["dockerfile makefile gnumakefile mk gitignore gitattributes dockerignore editorconfig", [HASH]],
  ["ps1", [/^(?:#(?!!)|<#)/]],
  ["sql lua hs elm", [/^--/]],
  ["erl", [/^%/]],
  ["clj cljs el lisp scm", [/^;/]],
]
const COMMENT_RULES = new Map(
  COMMENT_STARTS.flatMap(([names, rules]) => names.split(" ").map((name) => [name, rules] as const)),
)

/**
 * A deleted line's kind for the filtered label: blank (only whitespace), comment-only (it starts with a comment marker
 * of its file's language, from the fixed table above, keyed by extension, or for a file with none by its lowercased
 * name: Dockerfile, Makefile, .gitignore and the like), or code. A language the table does not name has no comment
 * lines. CMakeLists.txt is read as a .txt file, so as code.
 */
export function deletedLineKind(path: string, text: string): DeletedLineKind {
  const line = text.trim()
  if (line === "") return "blank"
  // Git paths are POSIX on every system: a backslash is part of a name, never a separator.
  const name = posix.basename(path).toLowerCase()
  const dot = name.lastIndexOf(".")
  const rules = COMMENT_RULES.get(dot === -1 ? name : name.slice(dot + 1)) ?? []
  return rules.some((rule) => rule.test(line)) ? "comment" : "code"
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

// `git blame --line-porcelain`: each line's commit, its line number in that commit's file, that file's path, which git
// still quotes under core.quotePath=false when it holds a quote, a backslash or a control character, and its line
// number in the blamed revision (`final`).
function blameLines(text: string) {
  return text.split("\n").reduce<{ sha: string; line: number; final: number; path: string }[]>((out, row) => {
    const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/.exec(row)
    if (header) return [...out, { sha: header[1], line: Number(header[2]), final: Number(header[3]), path: "" }]
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

function ledgerPull(read: PullRead, ctx: LedgerContext): LedgerPull {
  const pull = read.pull
  const state = read.state
  const ripe = matured(pull.mergedAt, ctx.observed)
  const reverted = ctx.reverts.get(pull.number)
  const hits = ctx.hits.get(pull.number) ?? []
  const kept = ripe && (reverted === undefined || reverted > MATURITY_DAYS)
  const attributions = ctx.filtered.byPull.get(pull.number) ?? []
  // Every fix and attribution comes from a scanned fix commit.
  const scanned = (fix: string) => ctx.fixes.get(fix)!
  // From the trusted record only: the fix's PR and this one are both in it, by the same author. An untrusted marker
  // (agent-signal) never sets it, and a fix whose own PR the call cap left unknown gets no flag.
  const same = (fix: string) => {
    const commit = scanned(fix)
    if (read.stratum !== "agent" || commit.ownUnknown) return {}
    const login = commit.own?.author.login.toLowerCase()
    return {
      sameAgent:
        !!commit.own && !!login && ctx.trusted.has(commit.own.number) && login === pull.author.login.toLowerCase(),
    }
  }
  const fixes = ripe
    ? [...Map.groupBy(hits, (hit) => hit.fix).values()].map((group) => {
        const attribution = attributions.find((entry) => entry.fix === group[0].fix)
        return {
          days: group[0].days,
          lines: group.length,
          kind: group[0].kind,
          commit: scanned(group[0].fix).index,
          ...(attribution ? { deleted: attribution.deleted } : {}),
          ...same(group[0].fix),
        }
      })
    : undefined
  const fixesFiltered = ripe
    ? attributions.flatMap((entry) =>
        entry.lines > 0 && entry.location
          ? [
              {
                days: entry.days,
                lines: entry.lines,
                kind: entry.kind,
                commit: scanned(entry.fix).index,
                location: hashedLocation(entry.location, ctx.key),
                ...same(entry.fix),
              },
            ]
          : [],
      )
    : undefined
  const unknown =
    read.stratum === "agent" &&
    [...(fixes ?? []), ...(fixesFiltered ?? [])].some((entry) => entry.sameAgent === undefined)
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
    ...(state ? { unreviewedFiles: state.unreviewed.length, humanComments: read.humanComments } : {}),
    ...(read.risk
      ? { band: read.risk.band, score: read.risk.score, added: read.risk.added, deleted: read.risk.deleted }
      : {}),
    truncated: read.truncated.length > 0,
    matured: ripe,
    ...(ripe && reverted !== undefined ? { revertedDays: reverted } : {}),
    ...(fixes && fixesFiltered
      ? {
          fixes,
          fixesFiltered,
          ...(ctx.filtered.incomplete.has(pull.number) ? { filteredIncomplete: true as const } : {}),
          ...(unknown ? { sameAgentIncomplete: true as const } : {}),
        }
      : {}),
    ...(kept && state ? { lines: lineCounts(read, hits) } : {}),
  }
}

interface LedgerContext {
  observed: number
  key: Uint8Array
  reverts: Map<number, number>
  hits: Map<number, Hit[]>
  filtered: { byPull: Map<number, Attribution[]>; incomplete: Set<number> }
  // Each scanned fix commit, by sha: its index in fixCommits and its own PR, as the v1 scan looked it up.
  fixes: Map<string, { index: number; own: ListedPull | undefined; ownUnknown: boolean }>
  trusted: ReadonlySet<number>
}

function hashedLocation(location: { path: string; section: string }, key: Uint8Array): LedgerLocation {
  return {
    path: hashName("path", location.path, key),
    ...(location.section ? { fn: hashName("fn", location.section, key) } : {}),
  }
}

// A fix commit as the ledger keeps it: its day, its kind, its deleted lines by kind and its distinct hashed locations
// (every hunk's file and funcname, add-only hunks included), at most MAX_FIX_LOCATIONS.
function ledgerFixCommit(fix: FixCommit, key: Uint8Array): LedgerFixCommit {
  const kinds = fix.files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.deleted.map((line) => line.kind)))
  const places = [
    ...new Map(
      fix.files.flatMap((file) =>
        file.hunks.map(
          (hunk) => [`${file.path}\0${hunk.section}`, { path: file.path, section: hunk.section }] as const,
        ),
      ),
    ).values(),
  ]
  return {
    date: new Date(fix.at).toISOString().slice(0, 10),
    kind: fix.kind,
    deleted: {
      code: kinds.filter((kind) => kind === "code").length,
      blank: kinds.filter((kind) => kind === "blank").length,
      comment: kinds.filter((kind) => kind === "comment").length,
    },
    locations: places.slice(0, MAX_FIX_LOCATIONS).map((place) => hashedLocation(place, key)),
    ...(places.length > MAX_FIX_LOCATIONS ? { capped: true as const } : {}),
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
const FixKind = Schema.Literals(["label", "title"])
// Today's VS-46a decoder, unchanged: what a schema-1 ledger is checked against.
const LedgerPullV1Entry = Schema.Struct({
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
  fixes: Schema.optionalKey(Schema.Array(Schema.Struct({ days: Amount, lines: Count, kind: FixKind }))),
  lines: Schema.optionalKey(
    Schema.Struct({ edited: Count, flagged: Count, escaped: Count, unreviewed: Count, skipped: Count }),
  ),
})
const LedgerEntriesV1 = Schema.Struct({
  repository: Schema.String,
  branch: Schema.String,
  observedUntil: IsoDate,
  merged: Schema.Struct({ since: IsoDate, until: IsoDate }),
  pulls: Schema.Array(LedgerPullV1Entry),
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
// Schema 2: the v1 entries with VS-46c's and VS-46d's fields, and the rules that tie them together.
const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/))
const Location = Schema.Struct({ path: Hash, fn: Schema.optionalKey(Hash) })
const LineKinds = Schema.Struct({ code: Count, blank: Count, comment: Count, whitespace: Count, moved: Count })
const LedgerFixEntry = Schema.Struct({
  days: Amount,
  lines: Count,
  kind: FixKind,
  commit: Count,
  deleted: Schema.optionalKey(LineKinds),
  sameAgent: Schema.optionalKey(Schema.Boolean),
}).check(
  Schema.makeFilter(
    (fix) =>
      !fix.deleted ||
      fix.deleted.code + fix.deleted.blank + fix.deleted.comment + fix.deleted.whitespace + fix.deleted.moved ===
        fix.lines,
  ),
)
const LedgerPullEntry = Schema.Struct({
  ...LedgerPullV1Entry.fields,
  unreviewedFiles: Schema.optionalKey(Count),
  humanComments: Schema.optionalKey(Count),
  added: Schema.optionalKey(Count),
  deleted: Schema.optionalKey(Count),
  fixes: Schema.optionalKey(Schema.Array(LedgerFixEntry)),
  fixesFiltered: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        days: Amount,
        lines: Schema.Int.check(Schema.isGreaterThan(0)),
        kind: FixKind,
        commit: Count,
        location: Location,
        sameAgent: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
  filteredIncomplete: Schema.optionalKey(Schema.Literal(true)),
  sameAgentIncomplete: Schema.optionalKey(Schema.Literal(true)),
}).check(
  Schema.makeFilter((pull) => {
    const flags = [...(pull.fixes ?? []), ...(pull.fixesFiltered ?? [])].map((fix) => fix.sameAgent)
    return (
      // Line counts and the score come with the band, and the two labels and the incompleteness mark come together.
      (pull.band !== undefined) === (pull.score !== undefined) &&
      (pull.band !== undefined) === (pull.added !== undefined) &&
      (pull.band !== undefined) === (pull.deleted !== undefined) &&
      (pull.fixes !== undefined) === (pull.fixesFiltered !== undefined) &&
      (!pull.filteredIncomplete || pull.fixesFiltered !== undefined) &&
      (pull.fixes ?? []).every((fix) => fix.deleted !== undefined || pull.filteredIncomplete === true) &&
      pull.reviewed === (pull.unreviewedFiles !== undefined) &&
      pull.reviewed === (pull.humanComments !== undefined) &&
      // Same-agent comes from the trusted record only, so only an agent-stratum PR carries it, on every entry but those
      // of a fix whose own PR the call cap left unknown, which the PR's mark names.
      flags.every((flag) =>
        flag === undefined ? pull.stratum !== "agent" || pull.sameAgentIncomplete === true : pull.stratum === "agent",
      ) &&
      (!pull.sameAgentIncomplete || (pull.stratum === "agent" && flags.some((flag) => flag === undefined)))
    )
  }),
)
const LedgerEntries = Schema.Struct({
  ...LedgerEntriesV1.fields,
  // With the replicate bound below, this bounds the bootstrap `open` runs (replicates × PRs per label) for a payload
  // anyone with the public key could seal.
  pulls: Schema.Array(LedgerPullEntry).check(Schema.makeFilter((pulls) => pulls.length <= MAX_LEDGER_PULLS)),
  subjects: Schema.Struct({ commits: Count, fix: Count, revert: Count }).check(
    Schema.makeFilter((subjects) => subjects.fix + subjects.revert <= subjects.commits),
  ),
  fixCommits: Schema.Array(
    Schema.Struct({
      date: Schema.String.check(
        Schema.isPattern(DATE),
        Schema.makeFilter((value: string) => Number.isFinite(Date.parse(value))),
      ),
      kind: FixKind,
      deleted: Schema.Struct({ code: Count, blank: Count, comment: Count }),
      locations: Schema.Array(Location).check(Schema.makeFilter((locations) => locations.length <= MAX_FIX_LOCATIONS)),
      capped: Schema.optionalKey(Schema.Literal(true)),
    }),
  ),
  // The sealed measurement rule, checked whenever it is present. SF-03's collection sealed /2 ledgers without one, and
  // those still open: the report applies MEASUREMENT_RULE to them and says so.
  rule: Schema.optionalKey(
    Schema.Struct({
      margin: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThan(1)),
      overhead: Schema.Literals(CAPTURE_OVERHEADS),
      seed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(0xffffffff)),
      replicates: Schema.Int.check(Schema.isGreaterThanOrEqualTo(100), Schema.isLessThanOrEqualTo(10_000)),
    }),
  ),
}).check(
  // Every fix entry names a fix commit of this ledger, of its own kind.
  Schema.makeFilter((ledger) =>
    ledger.pulls.every((pull) =>
      [...(pull.fixes ?? []), ...(pull.fixesFiltered ?? [])].every(
        (fix) => ledger.fixCommits[fix.commit]?.kind === fix.kind,
      ),
    ),
  ),
)
const decodeLedger = Schema.decodeUnknownOption(LedgerEntries)
const decodeLedgerV1 = Schema.decodeUnknownOption(LedgerEntriesV1)
// The owner's answers to an audit sample (`open --labels`): the file `open --audit` wrote, answered by hand. Only these
// fields are read.
const AuditLabelsFile = Schema.Struct({
  schema: Schema.Literal(AUDIT_SCHEMA),
  repository: Schema.String,
  expires: IsoDate,
  entries: Schema.Array(Schema.Struct({ id: Hash, fixInducing: Schema.NullOr(Schema.Boolean) })).check(
    Schema.makeFilter((entries) => entries.length <= MAX_LEDGER_PULLS),
  ),
})
const decodeAuditLabels = Schema.decodeUnknownOption(AuditLabelsFile)
// VS-42 pre-existing drops in a local eval artifact (latentDrops). Provisional: R5's producer owns the record. The class
// is a finding category, so no artifact text reaches the report's class table. `at` is a UTC instant in the ECMAScript
// date-time string format (toISOString's), the form Date.parse is specified to read: the scorer sorts and matures drops
// by it.
const LineNumber = Schema.Int.check(Schema.isGreaterThan(0))
const LatentDropEntry = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  base: Schema.Struct({
    sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)),
    start: LineNumber,
    end: LineNumber,
  }).check(Schema.makeFilter((base) => base.end >= base.start)),
  class: Schema.Literals(CATEGORIES),
  fingerprint: Schema.String.check(Schema.isPattern(/^[0-9a-f]{12}$/)),
  at: IsoDate.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)),
})
const decodeLatentDrops = Schema.decodeUnknownOption(Schema.Array(LatentDropEntry))
// What latentForecast scores: each drop as latentDrops reads it, and the days to its fix as the ledger counts a fix
// entry's days (finite, at or above 0).
const decodeLatentOutcomes = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ drop: LatentDropEntry, fixedDays: Schema.optional(Amount) })),
)

// The owner's answers for this ledger's repository and when the file holding them expires, or why they cannot be read:
// not JSON, malformed, another repository's, expired (it names PRs, and carries the expiry of the ledger it was drawn
// from), or naming one PR twice.
export function auditLabels(
  text: string,
  repository: string,
  now: number,
): { answers: AuditLabels; expires: string } | string {
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
  if (Option.isNone(parsed)) return "the labels file is not valid JSON"
  const file = decodeAuditLabels(parsed.value)
  if (Option.isNone(file))
    return `the labels file is not a ${AUDIT_SCHEMA} file with an expiry and, on each entry, an audit id and a fixInducing of true, false or null`
  if (file.value.repository.toLowerCase() !== repository.toLowerCase())
    return `the labels file is for ${JSON.stringify(file.value.repository)}, not ${repository}`
  if (now >= Date.parse(file.value.expires))
    return `the labels file expired on ${file.value.expires.slice(0, 10)}: delete it`
  const ids = file.value.entries.map((entry) => entry.id)
  if (new Set(ids).size !== ids.length) return "the labels file names one PR twice"
  return {
    answers: new Map(
      file.value.entries.flatMap((entry): [string, boolean][] =>
        entry.fixInducing === null ? [] : [[entry.id, entry.fixInducing]],
      ),
    ),
    expires: file.value.expires,
  }
}

// Why a ledger cannot be opened now, or undefined. The bounds are checked because anyone with the public key can seal
// a payload: a collection time in the future, or an expiry more than LEDGER_DAYS after it, is refused, and so is any
// entry the report could not read. Only a schema-2 ledger passes: collection writes no other, and a schema-1 ledger is
// opened only through v1LedgerProblem.
export function ledgerProblem(value: unknown, now: number): string | undefined {
  if (obj(value).schema !== LEDGER_SCHEMA) return `not a ${LEDGER_SCHEMA} ledger`
  return entriesProblem(value, now, decodeLedger)
}

// The same checks for a schema-1 ledger, which `open` reads read-only, against VS-46a's own decoder.
export function v1LedgerProblem(value: unknown, now: number): string | undefined {
  if (obj(value).schema !== LEDGER_SCHEMA_V1) return `not a ${LEDGER_SCHEMA_V1} ledger`
  return entriesProblem(value, now, decodeLedgerV1)
}

function entriesProblem(value: unknown, now: number, decode: (value: unknown) => Option.Option<unknown>) {
  const ledger = obj(value)
  const collected = Date.parse(str(ledger.collectedAt))
  const expires = Date.parse(str(ledger.expires))
  if (!Number.isFinite(collected)) return "the ledger has no collection date"
  if (!Number.isFinite(expires)) return "the ledger has no expiry date"
  if (collected > now + CLOCK_SKEW_MS) return "the ledger says it was collected after now"
  if (expires <= collected) return "the ledger expires before it was collected"
  if (expires - collected > LEDGER_DAYS * DAY)
    return `the ledger's expiry is more than ${LEDGER_DAYS} days after its collection`
  if (now >= expires) return `the ledger expired on ${str(ledger.expires).slice(0, 10)}: delete it`
  if (Option.isNone(decode(value))) return "the ledger is malformed"
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
  bands?: {
    rows: Record<RiskBand, BandRow>
    // Read from v1 fields only, so a /1 and a /2 ledger give the same section. Item 2's label: reverts within 90 days
    // when both the low and the high band expect at least MIN_EXPECTED, else VS-46a's unfiltered fix label.
    separation: "too-few" | "underpowered" | "overlap" | "separated"
    label: "revert" | "unfiltered"
    // A band's PRs times the label's rate pooled over every banded matured PR (for the fix label, over those not
    // reverted within 90 days).
    expected: Record<"revert" | "unfiltered", { low: number; high: number }>
  }
  // VS-46c's measurement: a schema-2 ledger in the full decision only.
  measurement?: Measurement
  // VS-46d items 1 to 4 (SF-05a): a schema-2 ledger in the full decision only, as the measurement.
  labelQuality?: LabelQuality
  // VS-46d items 5 to 11 (SF-05b): the same.
  cohorts?: Cohorts
  split: Record<"agent" | "agent-signal" | "bulk", Record<Outcome, number>>
  cycle: { n: number; p50: number; p90: number } | null
  // A schema-1 ledger only: it has none of the fields the schema-2 sections read, so each says so, whatever the volume
  // decision. VS-46c's, SF-05a's and SF-05b's sections are in that list.
  unavailable?: typeof V1_UNAVAILABLE
  problems: string[]
}

// One side of a capture comparison: the top PRs in one order, the positives among them, and their shares.
export interface CaptureSide {
  captured: number
  positives: number | null // the share of all positives, or null with none
  lines: number | null // the share of all changed lines (added plus deleted), or null with none
  cycle: Cycle
}

export interface CaptureRow {
  overhead: (typeof CAPTURE_OVERHEADS)[number]
  pulls: number // round(overhead × PRs), at least 1, and 0 with no PR
  band: CaptureSide // ranked by final band, ties by score, then PR number
  size: CaptureSide // ranked by added plus deleted lines, then PR number
  random: number | null // a random order's expected share of positives: pulls over PRs
  difference: number | null // band less size, in shares of all positives (capture-share points)
  interval: [number, number] | null // the paired bootstrap's percentile interval, at DEFAULT_CONFIDENCE
}

// One label over its population: matured PRs with a band, less (for the filtered label) those reverted within 90 days
// and those marked filteredIncomplete. Rates and minimum detectable effects are in rate points.
export interface LabelMeasure {
  pulls: number
  positives: number
  rate: number | null
  low: { pulls: number; expected: number }
  high: { pulls: number; expected: number }
  mde: number | null // low against high
  // The PRs a floor or the test-only rule put in another band than their score's own (likelyBand), the positives among
  // them, their expected positives at the label's rate, and the MDE of their rate against that rate.
  floorMoved: { pulls: number; positives: number; expected: number; mde: number | null }
  capture: CaptureRow[] // one per CAPTURE_OVERHEADS
  ran: number // the bootstrap replicates run: the rule's count, or 0 with no PR
  replicates: number // those that held a positive; the rest were skipped
  lowMiss: { positives: Proportion; pulls: number | null; lines: number | null } // the low band's shares
}

export interface Measurement {
  rule: MeasurementRule // the ledger's sealed rule, or MEASUREMENT_RULE when it has none: the one applied
  sealed: boolean // the ledger carries a rule (SF-03's collection sealed none)
  differs: boolean // the sealed rule is not this source's MEASUREMENT_RULE
  base: {
    pulls: number // matured PRs with a band that no read cut short
    cycle: Cycle
    subjects: { commits: number; fix: Proportion; revert: Proportion } // over the base branch's first-parent commits
    reverted: Record<(typeof LABEL_WINDOWS)[number], Proportion> // over every one of those PRs
    fixed: Record<(typeof LABEL_WINDOWS)[number], Proportion> // the unfiltered label, over those not reverted in 90 days
    filtered: Record<(typeof LABEL_WINDOWS)[number], Proportion> // and over those not marked filteredIncomplete either
    filteredIncomplete: number // not-reverted PRs the mark left out of the filtered rates
  }
  labels: Record<"revert" | "filtered", LabelMeasure>
  deciding: "revert" | "filtered"
  verdict: MeasurementVerdict
  reasons: string[] // why it is underpowered, in fixed wording
}

// VS-46d item 1 (SF-05a). One fix the sample shows for a PR, within MATURITY_DAYS of its merge: its fix commit's day,
// its days after the merge, the lines it blamed on the PR and how it was labelled a fix.
export interface AuditFix {
  date: string
  days: number
  lines: number
  kind: "label" | "title"
}

// One sampled PR. `id` is the join key the owner's answers are read by; `pr` is there so the owner can find the PR.
export interface AuditEntry {
  id: string
  pr: number
  label: "positive" | "negative" // on the filtered label: a fixesFiltered entry within MATURITY_DAYS, or none
  filtered: AuditFix[]
  unfiltered: AuditFix[]
  fixInducing: boolean | null // the owner's answer: null until answered, or skipped
}

// What `open --audit` writes. Read back as labels, only schema, repository, expires and each entry's id and fixInducing
// count; the rest may be changed or deleted.
export interface AuditSample {
  schema: typeof AUDIT_SCHEMA
  repository: string
  branch: string
  collectedAt: string
  expires: string // the ledger's expiry, or a labels file's when answers were carried in from it and it expires sooner
  question: string
  population: { positives: number; negatives: number }
  entries: AuditEntry[] // positives, then negatives, each in id order
}

// The owner's answers by audit id, with unanswered (null) entries left out.
export type AuditLabels = ReadonlyMap<string, boolean>

export interface LabelAudit {
  // The filtered label's population, as the measurement reads it, and the not-reverted PRs the mark left out of it.
  population: { positives: number; negatives: number; filteredIncomplete: number }
  sample: { positives: number; negatives: number } // what a sample draws: up to AUDIT_DRAW of each
  // With a labels file: the answered sampled PRs of each label and what the answers give.
  labels?: {
    positives: number
    negatives: number
    precision: Proportion // fix-inducing among the answered positives
    omission: Proportion // fix-inducing among the answered negatives: the label's miss rate
    // Weighted by the population's positives and negatives; the value needs AUDIT_PER_LABEL answers of each.
    recall: { value: number | null; interval: [number, number] | null }
    ignored: number // answers whose id is not in this sample
    cycle: Cycle
  }
  audited: boolean // at least AUDIT_PER_LABEL answered positives and AUDIT_PER_LABEL answered negatives
}

// One side of a band's fix-edited lines per kLOC added (item 4).
export interface DensitySide {
  pulls: number
  added: number
  lines: number
  perKloc: number | null // null with no line added
}

export interface DensityRow {
  filtered: DensitySide // the filtered label over its population
  unfiltered: DensitySide // VS-46a's label over the PRs not reverted within MATURITY_DAYS
  cycle: Cycle // over the unfiltered side's PRs, which hold the filtered side's
}

export interface LabelQuality {
  audit: LabelAudit
  // Item 2, over every fix commit the scan labelled: those with no deleted line, and with no deleted code line.
  untraceable: { commits: number; unfiltered: Proportion; filtered: Proportion }
  // Item 3, over the filtered label's population: the kinds of every line the unfiltered label blamed on it within
  // MATURITY_DAYS, the lines the filtered label blames on it, and those it gained (filtered less code).
  reattribution: {
    pulls: number
    filteredIncomplete: number
    lines: number
    kinds: LedgerLineKinds
    filtered: number
    gained: number
    cycle: Cycle
  }
  density: Record<RiskBand | "all", DensityRow> // item 4
}

// VS-46d items 5 and 9 (SF-05b). One side of a stratum's comparison: its PRs, the label's positives among them, and
// their rate, shown from MIN_PULLS PRs.
export interface CohortSide {
  pulls: number
  positives: number
  rate: Proportion
}

// One stratum's comparison of two groups on one label: item 5's clean against findings, item 9's agent against human.
export interface CohortRow {
  stratum: RiskBand | Tercile | "all"
  a: CohortSide
  b: CohortSide
  expected: { a: number; b: number } // each group's PRs times the label's rate over both groups in this stratum
  // "shown": both groups have at least MIN_PULLS PRs and MIN_EXPECTED expected positives; "empty": a group has no PR;
  // "underpowered": otherwise; "unpaired": the unstratified row, powered, with no stratified difference of its label
  // shown to set it beside.
  status: "shown" | "empty" | "underpowered" | "unpaired"
  difference: { difference: number; interval: [number, number] } | null // a less b, Newcombe's interval, when shown
  cycle: Cycle // over both groups' PRs
}

export interface VerdictLabel {
  bands: CohortRow[] // one per RISK_BANDS
  terciles: CohortRow[] // one per TERCILES
  raw: CohortRow // every compared PR of the label's population, unstratified, so confounded by size
}

// Item 5, over the human-stratum matured PRs with a band that no read cut short.
export interface VerdictStrata {
  proxy: true // the verdict is a proxy from the sticky state and the findings, not ReviewState's
  groups: Record<VerdictProxy, number> // those PRs by proxy group; only clean and findings are compared
  excluded: { agent: number; "agent-signal": number } // matured PRs with a band of the other strata, left out
  filteredIncomplete: number // compared PRs not reverted within MATURITY_DAYS whose mark leaves the filtered rows
  labels: Record<"revert" | "filtered", VerdictLabel>
}

// Item 7: the confirmed-fix share of settled human-stratum findings, with its population's human-comment volume.
export interface AddressedRate {
  rate: Proportion
  pulls: number // distinct PRs of those findings
  comments: { total: number; p50: number | null; p90: number | null; missing: number } // missing: PRs with no count
  cycle: Cycle
}

export interface HumanReviewRow {
  pulls: number
  rate: Proportion // humanReview over the row's PRs
  cycle: Cycle
}

// Item 9, within item 5's size terciles: agent-stratum PRs (the owner's trusted record) against human-stratum ones.
export interface AgentSplit {
  excluded: number // agent-signal matured PRs with a band: untrusted, so in neither group
  // filteredOther: the filtered label with same-agent follow-ups removed from agent PRs.
  labels: Record<"revert" | "filtered" | "filteredOther", CohortRow[]>
  unknown: number // agent PRs left out of filteredOther: only fixes with no sameAgent flag could make them positive
  // The same-agent share of fix entries within MATURITY_DAYS on agent PRs, with no interval; unknown entries left out.
  sameAgent: Record<"filtered" | "unfiltered", { share: Proportion; unknown: number }>
}

// Item 10, over one label's fix entries within MATURITY_DAYS: those with an earlier fix in the same file, or the same
// function, within RECURRENCE_DAYS before the PR's merge. Shares carry no interval.
export interface RecurrenceSide {
  fixes: number
  file: Proportion
  fn: Proportion
  cycle: Cycle
}

export interface Recurrence {
  // `full`: only entries whose PR's lookback starts after the first merge's day, before which no fix commit is kept.
  labels: Record<"filtered" | "unfiltered", RecurrenceSide & { full: RecurrenceSide }>
  first: string | null // the day of the ledger's first merge, YYYY-MM-DD
  capped: number // fix commits that kept only their first MAX_FIX_LOCATIONS locations
}

// Item 11: one VS-42 pre-existing drop, as R5 is to record it in a local eval artifact. Provisional: SF-21 produces the
// record and owns its shape. `at` is when the review dropped it, per drop.
export interface LatentDrop {
  path: string
  base: { sha: string; start: number; end: number } // the base commit and its line span
  class: Category
  fingerprint: string
  at: string
}

// A drop joined to the base branch's later history: the days from the drop to the first fix that edited its base
// lines, when one did, finite and at or above 0. Nothing builds the join yet; see latentForecast.
export interface LatentOutcome {
  drop: LatentDrop
  fixedDays?: number
}

export interface LatentForecast {
  // "not-read": no latent outcomes were given, as `open` gives none. "refused": one was malformed, so none is scored.
  // "kill-met": precision under LATENT_KILL_PRECISION on at least LATENT_MIN_DROPS matured drops.
  status: "not-read" | "refused" | "no-drops" | "too-few" | "kill-met" | "kill-not-met"
  drops: number // distinct fingerprints
  repeated: number // further drops of a fingerprint already counted
  matured: number
  precision: Proportion // fixed within MATURITY_DAYS among matured drops: a value from LATENT_MIN_DROPS, no interval
  byClass: { class: Category; matured: number; fixed: number }[]
}

export interface Cohorts {
  size: { cut: [number, number] | null; pulls: Record<Tercile, number> } // the terciles items 5 and 9 share
  verdict: VerdictStrata // item 5
  dismissals: { reason: typeof NO_DISMISSAL_REASON } // item 6
  addressed: AddressedRate // item 7
  humanReview: Record<RiskBand | "all", HumanReviewRow> // item 8
  agent: AgentSplit // item 9
  recurrence: Recurrence // item 10
  latent: LatentForecast // item 11
}

/**
 * The internal report (D12). Truncated PRs are left out of every count but the totals. Rates come from settled
 * human-stratum findings; a cell over fewer than MIN_SETTLED settled findings, or MIN_PULLS PRs or reviews, keeps its
 * count and interval and shows no rate. Below MIN_VOLUME settled human-stratum findings on PRs merged in the 90 days
 * before collection, only the gradient, its sensitivity row, the split and the counts are reported. In the full
 * decision a schema-2 ledger also gets VS-46c's measurement, under the rule sealed in it (MEASUREMENT_RULE when it has
 * none), VS-46d's label quality, and VS-46d's outcome strata, dismissals, agent split, recurrence and latent forecasts
 * (`cohorts`). `audit` is a sample auditSample drew from this ledger and the owner's answers to it, without which every
 * follow-up-fix rate is unaudited. `latent` is VS-42's pre-existing drops joined to later fixes. Nothing builds that
 * join yet, so `open` passes none and the section reads NO_DROPS_READ; NO_DROPS is only for latent outcomes given and
 * holding none. It never changes the ledger.
 */
export function outcomeReport(
  ledger: OutcomeLedger | OutcomeLedgerV1,
  audit?: { sample: AuditSample; labels: AuditLabels },
  latent?: readonly LatentOutcome[],
): OutcomeReport {
  // Every v1 section reads only v1 fields, whichever schema the ledger has.
  const all: readonly LedgerPullV1[] = ledger.pulls
  const collected = Date.parse(ledger.collectedAt)
  const byNumber = new Map(all.map((pull) => [pull.number, pull]))
  const pulls = all.filter((pull) => !pull.truncated)
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
  // A schema-2 ledger's label populations, computed once for the measurement and the label sections.
  const v2 = ledger.schema === LEDGER_SCHEMA ? { ledger, populations: labelPopulations(ledger) } : undefined
  const base = {
    repository: ledger.repository,
    branch: ledger.branch,
    collectedAt: ledger.collectedAt,
    observedUntil: ledger.observedUntil,
    expires: ledger.expires,
    merged: ledger.merged,
    pulls: {
      total: all.length,
      reviewed: pulls.filter((pull) => pull.reviewed).length,
      matured: matured.length,
      truncated: all.length - pulls.length,
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
    ...(ledger.schema === LEDGER_SCHEMA_V1 ? { unavailable: V1_UNAVAILABLE } : {}),
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
    ...(v2
      ? {
          measurement: measurementOf(v2.ledger, v2.populations, cycleOf),
          labelQuality: labelQualityOf(v2.ledger, v2.populations, cycleOf, audit),
          cohorts: cohortsOf({ ...v2, findings, settled, cycleOf, latent }),
        }
      : {}),
  }
}

function bandsOf(
  matured: readonly LedgerPullV1[],
  cycleOf: (numbers: Iterable<number>) => Cycle,
): NonNullable<OutcomeReport["bands"]> {
  const rows = Object.fromEntries(
    RISK_BANDS.map((band) => {
      const inBand = matured.filter((pull) => pull.band === band)
      const clean = inBand.filter((pull) => !reverted(pull, MATURITY_DAYS))
      return [
        band,
        {
          pulls: inBand.length,
          reverted: windows(inBand, reverted),
          fixed: windows(clean, fixed),
          cycle: cycleOf(inBand.map((pull) => pull.number)),
        },
      ]
    }),
  ) as Record<RiskBand, BandRow>
  const banded = matured.filter((pull) => pull.band !== undefined)
  // Item 2's two v1 labels: a revert within 90 days over every banded PR, and a v1 fix within 90 days over those not
  // reverted, as the table's fix rates count it.
  const labels = {
    revert: { pulls: banded, positive: (pull: LedgerPullV1) => reverted(pull, MATURITY_DAYS) },
    unfiltered: {
      pulls: banded.filter((pull) => !reverted(pull, MATURITY_DAYS)),
      positive: (pull: LedgerPullV1) => fixed(pull, MATURITY_DAYS),
    },
  }
  const expected = {
    revert: expectedIn(labels.revert.pulls, labels.revert.positive),
    unfiltered: expectedIn(labels.unfiltered.pulls, labels.unfiltered.positive),
  }
  const label = expected.revert.low >= MIN_EXPECTED && expected.revert.high >= MIN_EXPECTED ? "revert" : "unfiltered"
  const chosen = labels[label]
  // The label's positives over the band's PRs in its population, with Wilson intervals.
  const interval = (band: RiskBand) => {
    const group = chosen.pulls.filter((pull) => pull.band === band)
    return proportion(group.filter(chosen.positive).length, group.length).interval
  }
  const low = interval("low")
  const high = interval("high")
  const separation =
    banded.length < MIN_MATURED ||
    !banded.some((pull) => pull.band === "low") ||
    !banded.some((pull) => pull.band === "high")
      ? "too-few"
      : expected[label].low < MIN_EXPECTED || expected[label].high < MIN_EXPECTED || !low || !high
        ? "underpowered"
        : low[1] >= high[0] && high[1] >= low[0]
          ? "overlap"
          : "separated"
  return { rows, separation, label, expected }
}

// VS-46a's two v1 labels within `days` of the merge: reverted on the base branch, and fixed on the unfiltered label.
function reverted(pull: LedgerPullV1, days: number) {
  return pull.revertedDays !== undefined && pull.revertedDays <= days
}

function fixed(pull: LedgerPullV1, days: number) {
  return (pull.fixes ?? []).some((fix) => fix.days <= days)
}

// VS-46d's filtered label within `days` of the merge.
function filteredFixed(pull: LedgerPull, days: number) {
  return (pull.fixesFiltered ?? []).some((fix) => fix.days <= days)
}

// A label's share of `group` in each window, with no rate shown under MIN_PULLS PRs.
function windows<T extends LedgerPullV1>(group: readonly T[], test: (pull: T, days: number) => boolean) {
  return Object.fromEntries(
    LABEL_WINDOWS.map((days) => [days, cell(group.filter((pull) => test(pull, days)).length, group.length, MIN_PULLS)]),
  ) as Record<(typeof LABEL_WINDOWS)[number], Proportion>
}

// A band's expected positives (item 1): its PRs times the label's rate pooled over every band's PRs.
function expectedIn<T extends { band?: RiskBand }>(pulls: readonly T[], positive: (pull: T) => boolean) {
  const positives = pulls.filter(positive).length
  const of = (band: RiskBand) => expectedOf(pulls.filter((pull) => pull.band === band).length, positives, pulls.length)
  return { low: of("low"), high: of("high") }
}

// n PRs' expected positives at the rate `positives` over `total`, as n × positives / total so whole counts stay exact.
function expectedOf(n: number, positives: number, total: number) {
  return total ? (n * positives) / total : 0
}

// A matured PR with a band, as VS-46c ranks it.
interface Ranked {
  pull: LedgerPull
  band: RiskBand
  score: number
  lines: number // added plus deleted, as riskFeatures counted them for riskOf
  moved: boolean // its band is not likelyBand(score): a floor or the test-only rule moved it
}

/**
 * VS-46c's measurement (addendum B §1.8 items 1 to 7) under the rule sealed in the ledger, or under MEASUREMENT_RULE
 * for a ledger SF-03's collection sealed without one. Its PRs are the matured ones
 * with a band that no read cut short: in a collected ledger, every matured PR that is not truncated. Each label is
 * measured on its own population:
 * - revert: every such PR, positive when reverted within 90 days;
 * - filtered: those not reverted within 90 days and not marked filteredIncomplete, positive with a fixesFiltered entry
 *   within 90 days (VS-46d's label, primary on schema 2).
 * Reverts decide when both the low and the high band expect at least MIN_EXPECTED reverts; the filtered label decides
 * otherwise. The verdict reads the deciding label's capture at the rule's overhead.
 */
function measurementOf(
  ledger: OutcomeLedger,
  populations: Populations,
  cycleOf: (numbers: Iterable<number>) => Cycle,
): Measurement {
  const rule = ledger.rule ?? MEASUREMENT_RULE
  const labels = {
    revert: labelMeasure(populations.ranked, (entry) => reverted(entry.pull, MATURITY_DAYS), rule, cycleOf),
    filtered: labelMeasure(populations.complete, (entry) => filteredFixed(entry.pull, MATURITY_DAYS), rule, cycleOf),
  }
  const deciding =
    labels.revert.low.expected >= MIN_EXPECTED && labels.revert.high.expected >= MIN_EXPECTED ? "revert" : "filtered"
  const decided = labels[deciding]
  const interval = decided.capture.find((row) => row.overhead === rule.overhead)?.interval ?? null
  const reasons = [
    populations.ranked.length < MIN_MATURED
      ? `fewer than ${MIN_MATURED} matured PRs with a band (${populations.ranked.length})`
      : undefined,
    decided.low.expected < MIN_EXPECTED || decided.high.expected < MIN_EXPECTED
      ? `fewer than ${MIN_EXPECTED} expected positives in the low or the high band`
      : undefined,
    decided.floorMoved.expected < MIN_EXPECTED
      ? `fewer than ${MIN_EXPECTED} expected positives among the PRs a floor or the test-only rule moved`
      : undefined,
    interval ? undefined : "no bootstrap interval: no replicate held a positive",
  ].filter((reason) => reason !== undefined)
  return {
    rule: { ...rule },
    sealed: ledger.rule !== undefined,
    differs: (["margin", "overhead", "seed", "replicates"] as const).some(
      (name) => rule[name] !== MEASUREMENT_RULE[name],
    ),
    base: {
      pulls: populations.ranked.length,
      cycle: cycleOf(populations.ranked.map((entry) => entry.pull.number)),
      subjects: {
        commits: ledger.subjects.commits,
        fix: cell(ledger.subjects.fix, ledger.subjects.commits, MIN_PULLS),
        revert: cell(ledger.subjects.revert, ledger.subjects.commits, MIN_PULLS),
      },
      reverted: windows(
        populations.ranked.map((entry) => entry.pull),
        reverted,
      ),
      fixed: windows(
        populations.kept.map((entry) => entry.pull),
        fixed,
      ),
      filtered: windows(
        populations.complete.map((entry) => entry.pull),
        filteredFixed,
      ),
      filteredIncomplete: populations.kept.length - populations.complete.length,
    },
    labels,
    deciding,
    verdict:
      reasons.length || !interval
        ? "underpowered"
        : interval[0] > 0
          ? "beats-size"
          : interval[1] < rule.margin
            ? "no-better-than-size"
            : "undecided",
    reasons,
  }
}

// The labels' populations, which the measurement, the audit and the label sections share: `ranked` holds the matured PRs
// with a band that no read cut short (the revert label's), `kept` those not reverted within MATURITY_DAYS (the
// unfiltered fix label's), and `complete` those not marked filteredIncomplete either (the filtered label's).
function labelPopulations(ledger: OutcomeLedger) {
  const ranked = ledger.pulls.flatMap((pull): Ranked[] =>
    !pull.truncated && pull.matured && pull.band !== undefined && pull.score !== undefined
      ? [
          {
            pull,
            band: pull.band,
            score: pull.score,
            lines: (pull.added ?? 0) + (pull.deleted ?? 0),
            moved: pull.band !== likelyBand(pull.score),
          },
        ]
      : [],
  )
  const kept = ranked.filter((entry) => !reverted(entry.pull, MATURITY_DAYS))
  const complete = kept.filter((entry) => entry.pull.filteredIncomplete !== true)
  return { ranked, kept, complete }
}

// The band the likelihood score alone gives, as riskOf reads it at the default cutpoints readPull uses: a score exactly
// at a cutpoint takes the lower band. A PR whose final band differs was moved by a floor or by the test-only rule.
export function likelyBand(score: number): RiskBand {
  return score > RISK_CUTPOINTS.high ? "high" : score > RISK_CUTPOINTS.medium ? "medium" : "low"
}

function labelMeasure(
  entries: readonly Ranked[],
  positive: (entry: Ranked) => boolean,
  rule: MeasurementRule,
  cycleOf: (numbers: Iterable<number>) => Cycle,
): LabelMeasure {
  const flags = entries.map(positive)
  const positives = flags.filter(Boolean).length
  const rate = entries.length ? positives / entries.length : null
  const inBand = (band: RiskBand) => entries.filter((entry) => entry.band === band)
  const low = inBand("low")
  const high = inBand("high")
  const moved = entries.filter((entry) => entry.moved)
  const lines = (group: readonly Ranked[]) => group.reduce((sum, entry) => sum + entry.lines, 0)
  const total = lines(entries)
  // Item 4's two orders, as indices into `entries`: the final band, ties broken by score, then PR number; and added
  // plus deleted lines (the order of log(added + deleted)), then PR number.
  const indices = entries.map((_, index) => index)
  const byBand = indices.toSorted(
    (a, b) =>
      RISK_BANDS.indexOf(entries[b].band) - RISK_BANDS.indexOf(entries[a].band) ||
      entries[b].score - entries[a].score ||
      entries[a].pull.number - entries[b].pull.number,
  )
  const bySize = indices.toSorted(
    (a, b) => entries[b].lines - entries[a].lines || entries[a].pull.number - entries[b].pull.number,
  )
  const tops = CAPTURE_OVERHEADS.map((overhead) => topOf(overhead, entries.length))
  const boot = bootstrap([byBand, bySize], flags, tops, rule)
  const side = (order: readonly number[], n: number): CaptureSide => {
    const top = order.slice(0, n).map((index) => entries[index])
    const captured = top.filter(positive).length
    return {
      captured,
      positives: positives ? captured / positives : null,
      lines: total ? lines(top) / total : null,
      cycle: cycleOf(top.map((entry) => entry.pull.number)),
    }
  }
  return {
    pulls: entries.length,
    positives,
    rate,
    low: { pulls: low.length, expected: expectedOf(low.length, positives, entries.length) },
    high: { pulls: high.length, expected: expectedOf(high.length, positives, entries.length) },
    mde: minimumDetectable(rate, [low.length, high.length]),
    floorMoved: {
      pulls: moved.length,
      positives: moved.filter(positive).length,
      expected: expectedOf(moved.length, positives, entries.length),
      mde: minimumDetectable(rate, [moved.length]),
    },
    capture: CAPTURE_OVERHEADS.map((overhead, index) => {
      const n = tops[index]
      const band = side(byBand, n)
      const size = side(bySize, n)
      return {
        overhead,
        pulls: n,
        band,
        size,
        random: entries.length ? n / entries.length : null,
        difference: positives ? (band.captured - size.captured) / positives : null,
        interval: boot.intervals[index],
      }
    }),
    ran: boot.ran,
    replicates: boot.held,
    lowMiss: {
      positives: cell(low.filter(positive).length, positives, MIN_PULLS),
      pulls: entries.length ? low.length / entries.length : null,
      lines: total ? lines(low) / total : null,
    },
  }
}

// The top round(overhead × n) PRs, at least one, of n.
function topOf(overhead: number, n: number) {
  return n ? Math.max(1, Math.round(overhead * n)) : 0
}

// Item 3: the smallest difference in rate that a two-sided test at DEFAULT_CONFIDENCE detects with 80% power, between
// groups of these sizes at this rate (one size: a group against the rate itself), in rate points. Null with nothing to
// detect it with.
function minimumDetectable(rate: number | null, sizes: readonly number[]) {
  if (rate === null || rate <= 0 || rate >= 1 || sizes.some((n) => n <= 0)) return null
  return (Z_ALPHA + Z_POWER) * Math.sqrt(rate * (1 - rate) * sizes.reduce((sum, n) => sum + 1 / n, 0))
}

/**
 * Item 4's seeded paired bootstrap of the band-minus-size difference. Each replicate draws the PRs (indices into
 * `flags`, which says which are positive) with replacement once, and both orders take their top `tops[k]` draws from
 * that same resample, so the pair shares every draw. A replicate's difference is the positives the band order
 * captures less the size order's, over the resample's positives; a replicate with no positive is skipped and counted.
 * With no PR it runs no replicate.
 * Each interval is the percentile interval (type 7) at DEFAULT_CONFIDENCE. The generator starts from the rule's seed on
 * every call, so a rerun gives the same intervals.
 */
function bootstrap(
  orders: readonly [readonly number[], readonly number[]],
  flags: readonly boolean[],
  tops: readonly number[],
  rule: MeasurementRule,
) {
  const n = flags.length
  if (!n) return { intervals: tops.map(() => null), ran: 0, held: 0 }
  const random = seeded(rule.seed)
  const differences = tops.map(() => new Float64Array(rule.replicates))
  const counts = new Uint32Array(n)
  // Loops, not array methods: this body runs replicates × PRs times.
  let held = 0
  for (let replicate = 0; replicate < rule.replicates; replicate++) {
    counts.fill(0)
    for (let draw = 0; draw < n; draw++) {
      const index = Math.floor(random() * n)
      counts[index] = counts[index] + 1
    }
    let positives = 0
    for (let index = 0; index < n; index++) if (flags[index]) positives += counts[index]
    if (!positives) continue
    const band = capturedAt(orders[0], flags, counts, tops)
    const size = capturedAt(orders[1], flags, counts, tops)
    for (let k = 0; k < tops.length; k++) differences[k][held] = (band[k] - size[k]) / positives
    held++
  }
  return {
    intervals: differences.map((values) => percentileInterval(values.subarray(0, held))),
    ran: rule.replicates,
    held,
  }
}

// The positives among an order's first `tops[k]` draws of a resample, where `counts` holds each PR's draws: a PR drawn
// c times fills c places, so a threshold can take only part of them.
function capturedAt(order: readonly number[], flags: readonly boolean[], counts: Uint32Array, tops: readonly number[]) {
  const found = tops.map(() => 0)
  const last = Math.max(0, ...tops)
  let taken = 0
  for (const index of order) {
    if (taken >= last) break
    const count = counts[index]
    if (!count) continue
    if (flags[index]) for (let k = 0; k < tops.length; k++) found[k] += Math.max(0, Math.min(count, tops[k] - taken))
    taken += count
  }
  return found
}

function percentileInterval(values: Float64Array): [number, number] | null {
  if (!values.length) return null
  const sorted = values.toSorted()
  const tail = (1 - DEFAULT_CONFIDENCE) / 2
  const at = (q: number) => {
    const h = (sorted.length - 1) * q
    const below = Math.floor(h)
    const lower = sorted[below]
    return lower + (h - below) * (sorted[Math.min(below + 1, sorted.length - 1)] - lower)
  }
  return [at(tail), at(1 - tail)]
}

// mulberry32: a small seeded generator, so the bootstrap is reproducible with no dependency and no global state.
function seeded(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    const t = Math.imul(state ^ (state >>> 15), state | 1)
    const u = t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))
    return ((u ^ (u >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * VS-46d item 1's sample (addendum B §1.9; SF-05a): the filtered label's population, as the measurement reads it, split
 * into its positives and negatives, each ordered by audit id (then PR number) and cut to its first AUDIT_DRAW. To
 * anyone without the key, ordering by a keyed hash makes each cut a uniform random sample (bottom-k). It is the same on
 * every open, and a PR's id is the same in every ledger of the repository sealed to the same key, so a later ledger's
 * sample keeps each earlier-drawn PR that still ranks within its cut. It never changes the ledger.
 */
export function auditSample(ledger: OutcomeLedger, key: Uint8Array): AuditSample {
  const fixesOf = (fixes: readonly (LedgerFix | LedgerFilteredFix)[] | undefined): AuditFix[] =>
    (fixes ?? [])
      .filter((fix) => fix.days <= MATURITY_DAYS)
      .map((fix) => ({ date: ledger.fixCommits[fix.commit].date, days: fix.days, lines: fix.lines, kind: fix.kind }))
  const complete = labelPopulations(ledger).complete
  const drawn = (label: AuditEntry["label"]) =>
    complete
      .filter((entry) => filteredFixed(entry.pull, MATURITY_DAYS) === (label === "positive"))
      .map(
        (entry): AuditEntry => ({
          id: auditId(ledger.repository, entry.pull.number, key),
          pr: entry.pull.number,
          label,
          filtered: fixesOf(entry.pull.fixesFiltered),
          unfiltered: fixesOf(entry.pull.fixes),
          fixInducing: null,
        }),
      )
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.pr - b.pr))
  const positives = drawn("positive")
  const negatives = drawn("negative")
  return {
    schema: AUDIT_SCHEMA,
    repository: ledger.repository,
    branch: ledger.branch,
    collectedAt: ledger.collectedAt,
    expires: ledger.expires,
    question: AUDIT_QUESTION,
    population: { positives: positives.length, negatives: negatives.length },
    entries: [...positives.slice(0, AUDIT_DRAW), ...negatives.slice(0, AUDIT_DRAW)],
  }
}

/**
 * VS-46d items 1 to 4 (addendum B §1.9; SF-05a) on the labels' populations, as the measurement reads them: the label
 * audit, the untraceable share, the filter's reattribution, and fix-edited lines per kLOC added by band.
 */
function labelQualityOf(
  ledger: OutcomeLedger,
  populations: Populations,
  cycleOf: (numbers: Iterable<number>) => Cycle,
  audit: { sample: AuditSample; labels: AuditLabels } | undefined,
): LabelQuality {
  return {
    audit: auditOf(populations, cycleOf, audit),
    untraceable: untraceableOf(ledger.fixCommits),
    reattribution: reattributionOf(populations, cycleOf),
    density: densityOf(populations, cycleOf),
  }
}

type Populations = ReturnType<typeof labelPopulations>

// Item 1: precision and the miss rate over the answered sampled PRs of each label, and recall weighted by the
// population, because the sample is stratified. Only answers to this ledger's own sample count, so the estimate stays a
// stratified random sample; the rest are counted as ignored.
function auditOf(
  populations: Populations,
  cycleOf: (numbers: Iterable<number>) => Cycle,
  audit: { sample: AuditSample; labels: AuditLabels } | undefined,
): LabelAudit {
  const positives = populations.complete.filter((entry) => filteredFixed(entry.pull, MATURITY_DAYS)).length
  const negatives = populations.complete.length - positives
  const base = {
    population: { positives, negatives, filteredIncomplete: populations.kept.length - populations.complete.length },
    sample: { positives: Math.min(AUDIT_DRAW, positives), negatives: Math.min(AUDIT_DRAW, negatives) },
  }
  if (!audit) return { ...base, audited: false }
  const answered = (label: AuditEntry["label"]) =>
    audit.sample.entries.filter((entry) => entry.label === label && audit.labels.has(entry.id))
  const inducing = (entries: readonly AuditEntry[]) =>
    entries.filter((entry) => audit.labels.get(entry.id) === true).length
  const sampled = new Set(audit.sample.entries.map((entry) => entry.id))
  const yes = answered("positive")
  const no = answered("negative")
  const audited = yes.length >= AUDIT_PER_LABEL && no.length >= AUDIT_PER_LABEL
  return {
    ...base,
    labels: {
      positives: yes.length,
      negatives: no.length,
      precision: cell(inducing(yes), yes.length, AUDIT_PER_LABEL),
      omission: cell(inducing(no), no.length, AUDIT_PER_LABEL),
      recall: recallOf(
        positives,
        negatives,
        { count: inducing(yes), total: yes.length },
        { count: inducing(no), total: no.length },
        audited,
      ),
      ignored: [...audit.labels.keys()].filter((id) => !sampled.has(id)).length,
      cycle: cycleOf([...yes, ...no].map((entry) => entry.pr)),
    },
    audited,
  }
}

// Recall on a stratified sample: P·p / (P·p + N·q), where p is the fix-inducing share of the answered positives, q of
// the answered negatives, and P and N are the population's positives and negatives. Recall rises with p and falls with
// q, so its interval is composed from the two strata's Wilson intervals at 1 − (1 − DEFAULT_CONFIDENCE) / 2: both hold
// at once with at least DEFAULT_CONFIDENCE (Bonferroni), and so does the composed interval. It is not a Wilson
// interval of its own. With no fix-inducing PR anywhere, the lower end is 0 and the upper 1.
function recallOf(
  positives: number,
  negatives: number,
  yes: { count: number; total: number },
  no: { count: number; total: number },
  audited: boolean,
): { value: number | null; interval: [number, number] | null } {
  const confidence = 1 - (1 - DEFAULT_CONFIDENCE) / 2
  const p = wilson(yes.count, yes.total, confidence)
  const q = wilson(no.count, no.total, confidence)
  const recall = (precision: number, missed: number) => {
    const found = positives * precision
    return found + negatives * missed > 0 ? found / (found + negatives * missed) : null
  }
  return {
    value: audited ? recall(yes.count / yes.total, no.count / no.total) : null,
    interval: p && q ? [recall(p[0], q[1]) ?? 0, recall(p[1], q[0]) ?? 1] : null,
  }
}

// Item 2: the fix commits that deleted no line, which the unfiltered label cannot trace to a PR, and those that deleted
// no code line (add-only, or deleting only blank or comment lines), which the filtered label cannot. Over every fix
// commit the scan labelled, from the window's first merge to MATURITY_DAYS after its last.
function untraceableOf(commits: readonly LedgerFixCommit[]) {
  const share = (test: (commit: LedgerFixCommit) => boolean) =>
    cell(commits.filter(test).length, commits.length, MIN_PULLS)
  return {
    commits: commits.length,
    unfiltered: share((commit) => commit.deleted.code + commit.deleted.blank + commit.deleted.comment === 0),
    filtered: share((commit) => commit.deleted.code === 0),
  }
}

// Item 3: the kinds of every line the unfiltered label blamed on the filtered population's PRs within MATURITY_DAYS,
// and the lines the filtered label blames on the same PRs. Every such fix carries its kinds: only a PR marked
// filteredIncomplete may lack them, and none is in this population.
function reattributionOf(populations: Populations, cycleOf: (numbers: Iterable<number>) => Cycle) {
  const pulls = populations.complete.map((entry) => entry.pull)
  const fixes = pulls.flatMap((pull) => (pull.fixes ?? []).filter((fix) => fix.days <= MATURITY_DAYS))
  const kinds = fixes.reduce(
    (sum, fix) => ({
      code: sum.code + (fix.deleted?.code ?? 0),
      blank: sum.blank + (fix.deleted?.blank ?? 0),
      comment: sum.comment + (fix.deleted?.comment ?? 0),
      whitespace: sum.whitespace + (fix.deleted?.whitespace ?? 0),
      moved: sum.moved + (fix.deleted?.moved ?? 0),
    }),
    { code: 0, blank: 0, comment: 0, whitespace: 0, moved: 0 },
  )
  const filtered = pulls
    .flatMap((pull) => (pull.fixesFiltered ?? []).filter((fix) => fix.days <= MATURITY_DAYS))
    .reduce((sum, fix) => sum + fix.lines, 0)
  return {
    pulls: pulls.length,
    filteredIncomplete: populations.kept.length - populations.complete.length,
    lines: fixes.reduce((sum, fix) => sum + fix.lines, 0),
    kinds,
    filtered,
    gained: filtered - kinds.code,
    cycle: cycleOf(pulls.map((pull) => pull.number)),
  }
}

// Item 4: each label's fix-edited lines within MATURITY_DAYS per 1,000 lines added, by band and over every band.
function densityOf(
  populations: Populations,
  cycleOf: (numbers: Iterable<number>) => Cycle,
): Record<RiskBand | "all", DensityRow> {
  const side = (entries: readonly Ranked[], fixes: (pull: LedgerPull) => readonly LedgerFixV1[] | undefined) => {
    const added = entries.reduce((sum, entry) => sum + (entry.pull.added ?? 0), 0)
    const lines = entries
      .flatMap((entry) => (fixes(entry.pull) ?? []).filter((fix) => fix.days <= MATURITY_DAYS))
      .reduce((sum, fix) => sum + fix.lines, 0)
    return { pulls: entries.length, added, lines, perKloc: added ? (lines * 1000) / added : null }
  }
  const row = (test: (entry: Ranked) => boolean): DensityRow => {
    const kept = populations.kept.filter(test)
    return {
      filtered: side(populations.complete.filter(test), (pull) => pull.fixesFiltered),
      unfiltered: side(kept, (pull) => pull.fixes),
      cycle: cycleOf(kept.map((entry) => entry.pull.number)),
    }
  }
  return {
    low: row((entry) => entry.band === "low"),
    medium: row((entry) => entry.band === "medium"),
    high: row((entry) => entry.band === "high"),
    all: row(() => true),
  }
}

/**
 * VS-46d items 5 to 11 (addendum B §1.9; SF-05b) on the labels' populations, as the measurement reads them. Each part
 * reads only this ledger and the latent outcomes it is given.
 */
function cohortsOf(input: {
  ledger: OutcomeLedger
  populations: Populations
  findings: readonly LedgerFinding[] // on PRs no read cut short, every stratum and outcome
  settled: readonly LedgerFinding[] // the settled human-stratum ones
  cycleOf: (numbers: Iterable<number>) => Cycle
  latent: readonly LatentOutcome[] | undefined
}): Cohorts {
  const terciles = tercilesOf(input.populations.ranked)
  return {
    size: { cut: terciles.cut, pulls: tally(TERCILES, input.populations.ranked.map(terciles.of)) },
    verdict: verdictStrataOf(
      input.populations,
      new Set(input.findings.map((finding) => finding.pr)),
      terciles,
      input.cycleOf,
    ),
    dismissals: { reason: NO_DISMISSAL_REASON },
    addressed: addressedOf(input.ledger, input.settled, input.cycleOf),
    humanReview: humanReviewOf(input.ledger, input.cycleOf),
    agent: agentSplitOf(input.populations, terciles, input.cycleOf),
    recurrence: recurrenceOf(input.ledger, input.populations, input.cycleOf),
    latent: latentForecast(input.latent, Date.parse(input.ledger.observedUntil)),
  }
}

// The size terciles of the matured PRs with a band, every stratum: cuts at the ceil(n/3)-th and the ceil(2n/3)-th
// smallest added plus deleted lines, so PRs of one size share a tercile, and ties can leave one short or empty.
function tercilesOf(ranked: readonly Ranked[]) {
  const sorted = ranked.map((entry) => entry.lines).toSorted((a, b) => a - b)
  const cut: [number, number] | null = sorted.length
    ? [sorted[Math.ceil(sorted.length / 3) - 1], sorted[Math.ceil((2 * sorted.length) / 3) - 1]]
    : null
  const of = (entry: Ranked): Tercile =>
    !cut || entry.lines <= cut[0] ? "small" : entry.lines <= cut[1] ? "middle" : "large"
  return { cut, of }
}

type Terciles = ReturnType<typeof tercilesOf>

// Two groups of one stratum on one label. The difference needs MIN_PULLS PRs in each group, so both rates show, and
// MIN_EXPECTED expected positives in each at the two groups' pooled rate in this stratum.
function compared(
  stratum: CohortRow["stratum"],
  a: readonly Ranked[],
  b: readonly Ranked[],
  positive: (entry: Ranked) => boolean,
  cycleOf: (numbers: Iterable<number>) => Cycle,
): CohortRow {
  const side = (group: readonly Ranked[]): CohortSide => {
    const positives = group.filter(positive).length
    return { pulls: group.length, positives, rate: cell(positives, group.length, MIN_PULLS) }
  }
  const first = side(a)
  const second = side(b)
  const pooled = first.positives + second.positives
  const total = first.pulls + second.pulls
  const expected = { a: expectedOf(first.pulls, pooled, total), b: expectedOf(second.pulls, pooled, total) }
  const status =
    !first.pulls || !second.pulls
      ? "empty"
      : Math.min(first.pulls, second.pulls) < MIN_PULLS || Math.min(expected.a, expected.b) < MIN_EXPECTED
        ? "underpowered"
        : "shown"
  return {
    stratum,
    a: first,
    b: second,
    expected,
    status,
    difference:
      status === "shown"
        ? independentDifference(
            { count: first.positives, total: first.pulls },
            { count: second.positives, total: second.pulls },
          )
        : null,
    cycle: cycleOf([...a, ...b].map((entry) => entry.pull.number)),
  }
}

// Item 5: the proxy's clean and findings groups of the human-stratum PRs, on each label's population, within each band,
// within each tercile, and unstratified. The unstratified difference is shown only beside a stratified one.
function verdictStrataOf(
  populations: Populations,
  posted: ReadonlySet<number>,
  terciles: Terciles,
  cycleOf: (numbers: Iterable<number>) => Cycle,
): VerdictStrata {
  const grouped = (entries: readonly Ranked[], group: VerdictProxy) =>
    entries.filter((entry) => entry.pull.stratum === "human" && verdictProxy(entry.pull, posted) === group)
  const label = (entries: readonly Ranked[], positive: (entry: Ranked) => boolean): VerdictLabel => {
    const clean = grouped(entries, "clean")
    const findings = grouped(entries, "findings")
    const row = (stratum: CohortRow["stratum"], test: (entry: Ranked) => boolean) =>
      compared(stratum, clean.filter(test), findings.filter(test), positive, cycleOf)
    const bands = RISK_BANDS.map((band) => row(band, (entry) => entry.band === band))
    const sized = TERCILES.map((tercile) => row(tercile, (entry) => terciles.of(entry) === tercile))
    const raw = row("all", () => true)
    const paired = [...bands, ...sized].some((entry) => entry.status === "shown")
    return {
      bands,
      terciles: sized,
      raw: raw.status === "shown" && !paired ? { ...raw, status: "unpaired", difference: null } : raw,
    }
  }
  const strata = populations.ranked.map((entry) => entry.pull.stratum)
  return {
    proxy: true,
    groups: tally(
      VERDICT_PROXIES,
      populations.ranked.flatMap((entry) => (entry.pull.stratum === "human" ? [verdictProxy(entry.pull, posted)] : [])),
    ),
    excluded: {
      agent: strata.filter((stratum) => stratum === "agent").length,
      "agent-signal": strata.filter((stratum) => stratum === "agent-signal").length,
    },
    filteredIncomplete: [...grouped(populations.kept, "clean"), ...grouped(populations.kept, "findings")].filter(
      (entry) => entry.pull.filteredIncomplete === true,
    ).length,
    labels: {
      revert: label(populations.ranked, (entry) => reverted(entry.pull, MATURITY_DAYS)),
      filtered: label(populations.complete, (entry) => filteredFixed(entry.pull, MATURITY_DAYS)),
    },
  }
}

// Item 5's proxy for the verdict: unreviewed without the job's sticky state or a completed review; with findings when
// the ledger holds a finding on the PR, in any stratum or outcome; otherwise incomplete when the state was pruned, since
// summary findings may then be lost, and clean only when its last run left no file unreviewed, so incomplete when it
// left some or the count is missing.
function verdictProxy(pull: LedgerPull, posted: ReadonlySet<number>): VerdictProxy {
  if (!pull.reviewed || pull.reviews === 0) return "unreviewed"
  if (posted.has(pull.number)) return "findings"
  if (pull.statePruned) return "incomplete"
  return pull.unreviewedFiles === 0 ? "clean" : "incomplete"
}

// Item 7: the confirmed-fix share of settled human-stratum findings, every severity together, and the human-comment
// volume on their PRs.
function addressedOf(
  ledger: OutcomeLedger,
  settled: readonly LedgerFinding[],
  cycleOf: (numbers: Iterable<number>) => Cycle,
): AddressedRate {
  const numbers = new Set(settled.map((finding) => finding.pr))
  const counts = ledger.pulls.flatMap((pull) =>
    numbers.has(pull.number) && pull.humanComments !== undefined ? [pull.humanComments] : [],
  )
  const found = spread(counts)
  return {
    rate: cell(
      settled.filter((finding) => finding.outcome === "fixed-confirmed-by-thread").length,
      settled.length,
      MIN_SETTLED,
    ),
    pulls: numbers.size,
    comments: {
      total: counts.reduce((sum, count) => sum + count, 0),
      p50: found?.p50 ?? null,
      p90: found?.p90 ?? null,
      missing: numbers.size - counts.length,
    },
    cycle: cycleOf(numbers),
  }
}

// Item 8: humanReview by band, over every PR with a band that no read cut short, matured or not, every stratum.
function humanReviewOf(
  ledger: OutcomeLedger,
  cycleOf: (numbers: Iterable<number>) => Cycle,
): Record<RiskBand | "all", HumanReviewRow> {
  const banded = ledger.pulls.filter((pull) => !pull.truncated && pull.band !== undefined)
  const row = (group: readonly LedgerPull[]): HumanReviewRow => ({
    pulls: group.length,
    rate: cell(group.filter((pull) => pull.humanReview).length, group.length, MIN_PULLS),
    cycle: cycleOf(group.map((pull) => pull.number)),
  })
  return Object.fromEntries([
    ...RISK_BANDS.map((band) => [band, row(banded.filter((pull) => pull.band === band))] as const),
    ["all", row(banded)] as const,
  ]) as Record<RiskBand | "all", HumanReviewRow>
}

// Item 9: agent-stratum PRs (the owner's trusted record) against human-stratum ones within each tercile, on each label's
// population. Agent-signal PRs, from untrusted markers, are in neither group. filteredOther removes same-agent
// follow-ups: an agent PR is positive there only through a filtered fix within MATURITY_DAYS whose sameAgent is false,
// and is left out when only fixes with no flag could make it so.
function agentSplitOf(
  populations: Populations,
  terciles: Terciles,
  cycleOf: (numbers: Iterable<number>) => Cycle,
): AgentSplit {
  const of = (entries: readonly Ranked[], stratum: PullStratum) =>
    entries.filter((entry) => entry.pull.stratum === stratum)
  const rows = (entries: readonly Ranked[], positive: (entry: Ranked) => boolean) =>
    TERCILES.map((tercile) => {
      const sized = entries.filter((entry) => terciles.of(entry) === tercile)
      return compared(tercile, of(sized, "agent"), of(sized, "human"), positive, cycleOf)
    })
  const other = (entry: Ranked) => inLabelWindow(entry.pull.fixesFiltered).some((fix) => fix.sameAgent === false)
  const unknown = (entry: Ranked) =>
    entry.pull.stratum === "agent" &&
    !other(entry) &&
    inLabelWindow(entry.pull.fixesFiltered).some((fix) => fix.sameAgent === undefined)
  const share = (
    entries: readonly Ranked[],
    fixes: (pull: LedgerPull) => readonly { days: number; sameAgent?: boolean }[] | undefined,
  ) => {
    const flags = of(entries, "agent").flatMap((entry) => inLabelWindow(fixes(entry.pull)).map((fix) => fix.sameAgent))
    const known = flags.filter((flag) => flag !== undefined)
    return { share: bare(known.filter(Boolean).length, known.length, MIN_PULLS), unknown: flags.length - known.length }
  }
  return {
    excluded: of(populations.ranked, "agent-signal").length,
    labels: {
      revert: rows(populations.ranked, (entry) => reverted(entry.pull, MATURITY_DAYS)),
      filtered: rows(populations.complete, (entry) => filteredFixed(entry.pull, MATURITY_DAYS)),
      filteredOther: rows(
        populations.complete.filter((entry) => !unknown(entry)),
        (entry) => (entry.pull.stratum === "agent" ? other(entry) : filteredFixed(entry.pull, MATURITY_DAYS)),
      ),
    },
    unknown: populations.complete.filter(unknown).length,
    sameAgent: {
      filtered: share(populations.complete, (pull) => pull.fixesFiltered),
      unfiltered: share(populations.kept, (pull) => pull.fixes),
    },
  }
}

// Item 10, descriptive only: each label's fix entries within MATURITY_DAYS with an earlier fix commit, other than their
// own, in the same file (or the same file and function, a funcname on both sides) dated from RECURRENCE_DAYS before the
// PR's merge day up to the day before it. Fix commits keep only their day, so one on the merge day is left out. A
// filtered entry is placed at its own location; an unfiltered one at every location its fix commit edited.
function recurrenceOf(
  ledger: OutcomeLedger,
  populations: Populations,
  cycleOf: (numbers: Iterable<number>) => Cycle,
): Recurrence {
  const day = (time: number) => new Date(time).toISOString().slice(0, 10)
  const earliest = ledger.pulls.length ? Math.min(...ledger.pulls.map((pull) => Date.parse(pull.mergedAt))) : undefined
  const first = earliest === undefined ? null : day(earliest)
  const placed = ledger.fixCommits.flatMap((commit, index) =>
    commit.locations.map((location) => ({ commit: index, date: commit.date, location })),
  )
  const files = Map.groupBy(placed, (entry) => entry.location.path)
  const fns = Map.groupBy(
    placed.filter((entry) => entry.location.fn !== undefined),
    (entry) => `${entry.location.path}\0${entry.location.fn}`,
  )
  type Entry = { pull: LedgerPull; commit: number; locations: readonly LedgerLocation[] }
  const prior = (
    entry: Entry,
    keys: readonly string[],
    index: ReadonlyMap<string, readonly (typeof placed)[number][]>,
  ) => {
    const merged = Date.parse(entry.pull.mergedAt)
    const from = day(merged - RECURRENCE_DAYS * DAY)
    const until = day(merged)
    return keys.some((key) =>
      (index.get(key) ?? []).some((fix) => fix.commit !== entry.commit && fix.date >= from && fix.date < until),
    )
  }
  const side = (entries: readonly Entry[]): RecurrenceSide => ({
    fixes: entries.length,
    file: bare(
      entries.filter((entry) =>
        prior(
          entry,
          entry.locations.map((location) => location.path),
          files,
        ),
      ).length,
      entries.length,
      MIN_PULLS,
    ),
    fn: bare(
      entries.filter((entry) =>
        prior(
          entry,
          entry.locations.flatMap((location) =>
            location.fn === undefined ? [] : [`${location.path}\0${location.fn}`],
          ),
          fns,
        ),
      ).length,
      entries.length,
      MIN_PULLS,
    ),
    cycle: cycleOf(entries.map((entry) => entry.pull.number)),
  })
  const full = (entries: readonly Entry[]) =>
    entries.filter((entry) => first !== null && day(Date.parse(entry.pull.mergedAt) - RECURRENCE_DAYS * DAY) > first)
  const filtered = populations.complete.flatMap((ranked) =>
    inLabelWindow(ranked.pull.fixesFiltered).map((fix) => ({
      pull: ranked.pull,
      commit: fix.commit,
      locations: [fix.location],
    })),
  )
  const unfiltered = populations.kept.flatMap((ranked) =>
    inLabelWindow(ranked.pull.fixes).map((fix) => ({
      pull: ranked.pull,
      commit: fix.commit,
      locations: ledger.fixCommits[fix.commit]?.locations ?? [],
    })),
  )
  return {
    labels: {
      filtered: { ...side(filtered), full: side(full(filtered)) },
      unfiltered: { ...side(unfiltered), full: side(full(unfiltered)) },
    },
    first,
    capped: ledger.fixCommits.filter((commit) => commit.capped === true).length,
  }
}

/**
 * VS-46d item 11's drops in a local eval artifact: `drops`, each with R5's path, base line span, class, base SHA and
 * fingerprint and the time `at` the review dropped it. Every other field is ignored, and an artifact with no `drops`
 * (one written before R5) records none. Provisional: R5's producer (SF-21) owns the record and may change this reader.
 * It returns a reason instead when the artifact is not an object, holds more than MAX_LATENT_DROPS drops, or holds a
 * malformed one. Nothing calls it before the join below exists, so `open` reads no artifact.
 */
export function latentDrops(artifact: unknown): LatentDrop[] | string {
  if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact))
    return "the artifact is not an object"
  const drops = obj(artifact).drops
  if (drops === undefined) return []
  if (Array.isArray(drops) && drops.length > MAX_LATENT_DROPS)
    return `the artifact holds more than ${MAX_LATENT_DROPS} drops`
  const decoded = decodeLatentDrops(drops)
  if (Option.isNone(decoded)) return "the artifact holds a malformed drop"
  return [...decoded.value]
}

/**
 * Item 11's scorer, on drops already joined to later fixes (LatentOutcome). The join is not built: following a drop's
 * base lines through later history is new machinery, which this script's blame does not do, and no package owns it yet.
 * With no outcomes given (`undefined`, as `open` gives) it reads "not-read". Every outcome is checked first, as the
 * ledger's entries are: a drop latentDrops would refuse, or a fixedDays that is not a finite number of days at or above
 * 0, refuses them all, so a producer's fault cannot move the precision. A defect dropped on several reviews counts once,
 * at its earliest drop (ties in input order). A drop is matured once MATURITY_DAYS have passed by observedUntil, and
 * fixed when its first fix came more than 0 and at most MATURITY_DAYS days after it, as the follow-up-fix label counts
 * days. The kill criterion is met when precision is under LATENT_KILL_PRECISION on at least LATENT_MIN_DROPS matured
 * drops; the decision is the owner's.
 */
export function latentForecast(outcomes: readonly LatentOutcome[] | undefined, observedUntil: number): LatentForecast {
  const decoded = outcomes === undefined ? undefined : decodeLatentOutcomes(outcomes)
  if (decoded === undefined || Option.isNone(decoded))
    return {
      status: decoded === undefined ? "not-read" : "refused",
      drops: 0,
      repeated: 0,
      matured: 0,
      precision: bare(0, 0, LATENT_MIN_DROPS),
      byClass: [],
    }
  const distinct = [
    ...Map.groupBy(
      decoded.value.toSorted((a, b) => Date.parse(a.drop.at) - Date.parse(b.drop.at)),
      (outcome) => outcome.drop.fingerprint,
    ).values(),
  ].map((group) => group[0])
  const matured = distinct.filter((outcome) => Date.parse(outcome.drop.at) + MATURITY_DAYS * DAY <= observedUntil)
  const fixed = (outcome: LatentOutcome) =>
    outcome.fixedDays !== undefined && outcome.fixedDays > 0 && outcome.fixedDays <= MATURITY_DAYS
  const hits = matured.filter(fixed).length
  return {
    status: !distinct.length
      ? "no-drops"
      : matured.length < LATENT_MIN_DROPS
        ? "too-few"
        : hits / matured.length < LATENT_KILL_PRECISION
          ? "kill-met"
          : "kill-not-met",
    drops: distinct.length,
    repeated: decoded.value.length - distinct.length,
    matured: matured.length,
    precision: bare(hits, matured.length, LATENT_MIN_DROPS),
    byClass: CATEGORIES.flatMap((category) => {
      const group = matured.filter((outcome) => outcome.drop.class === category)
      return group.length ? [{ class: category, matured: group.length, fixed: group.filter(fixed).length }] : []
    }),
  }
}

// A label's fix entries within MATURITY_DAYS of the merge.
function inLabelWindow<T extends { days: number }>(fixes: readonly T[] | undefined) {
  return (fixes ?? []).filter((fix) => fix.days <= MATURITY_DAYS)
}

// A share over units that cluster (fix entries within PRs and fix commits, drops within reviews): its count and total,
// and its value from `minimum`, with no interval, since a Wilson interval would treat the units as independent.
function bare(count: number, total: number, minimum: number): Proportion {
  return { ...cell(count, total, minimum), interval: null }
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
  const header = [
    "# Outcome ledger report",
    "",
    `Internal measurement: no accuracy or comparative claim (D12). Sealed; expires ${report.expires.slice(0, 10)}.`,
    "",
    `- Repository ${report.repository}, branch ${report.branch}; PRs merged ${report.merged.since.slice(0, 10)} to ${report.merged.until.slice(0, 10)}; collected ${report.collectedAt.slice(0, 10)}; the clone's history ends ${report.observedUntil.slice(0, 10)}.`,
    `- Pull requests: ${report.pulls.total} merged, ${report.pulls.reviewed} reviewed, ${report.pulls.matured} matured (merged at least ${MATURITY_DAYS} days before the clone's history ends), ${report.pulls.truncated} truncated and left out of every count below. By stratum: ${counts(report.pulls.byStratum)}.`,
    `- Findings: ${report.findings.total}. By stratum: ${counts(report.findings.byStratum)}. By outcome: ${counts(report.findings.byOutcome)}.`,
    `- Volume: ${report.volume.settled90} settled human-stratum findings on PRs merged in the ${MATURITY_DAYS} days before collection; ${report.volume.decision === "full" ? "the full report follows" : `fewer than ${MIN_VOLUME}, so only the severity gradient is reported`}.`,
    `- Cycle time (hours, p50 / p90): ${report.cycle ? `${cycle(report.cycle)} over ${report.cycle.n} PRs` : "n/a"}. Every rate below carries its own.`,
  ]
  const lines = [
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
        `A fix rate counts only matured PRs not reverted within ${MATURITY_DAYS} days: a backed-out PR is neither positive nor clean. Separation: ${separationLine(report.bands!)}`,
      ]
    : []
  const measured =
    report.measurement && report.bands
      ? measurementLines(report.measurement, report.bands, cycle, report.labelQuality?.audit)
      : { before: [], after: [] }
  const labelled = report.labelQuality ? labelLines(report.labelQuality, cycle) : []
  const cohorted = report.cohorts ? cohortLines(report.cohorts, cycle, report.labelQuality?.audit.audited === true) : []
  // A schema-1 ledger: each VS-46c and VS-46d section says it is unavailable, whatever the volume decision.
  const unavailable = report.unavailable
  const legacy = unavailable
    ? [...MEASUREMENT_SECTIONS, ...LABEL_SECTIONS, ...COHORT_SECTIONS].flatMap((heading) => [
        "",
        heading,
        "",
        unavailable,
      ])
    : []
  const problems = report.problems.length
    ? ["", "## Problems", "", ...report.problems.map((problem) => `- ${problem}`)]
    : []
  return [
    ...header,
    ...measured.before,
    ...lines,
    ...full,
    ...measured.after,
    ...labelled,
    ...cohorted,
    ...legacy,
    ...problems,
    "",
  ].join("\n")
}

// VS-46c's report sections, in their order. A schema-1 ledger prints each with V1_UNAVAILABLE.
const MEASUREMENT_SECTIONS = [
  "## Outcome base rates",
  "## Minimum detectable effect",
  "## Capture against size",
  "## Measurement verdict",
  "## Depth and reach",
] as const

// VS-46d items 1 to 4's sections (SF-05a), in their order, after VS-46c's. A schema-1 ledger prints each with
// V1_UNAVAILABLE.
const LABEL_SECTIONS = [
  "## Label audit",
  "## Untraceable fixes",
  "## Filter reattribution",
  "## Fix-edited lines per kLOC",
] as const

// VS-46d items 5 to 11's sections (SF-05b), in their order, after SF-05a's. A schema-1 ledger prints each with
// V1_UNAVAILABLE.
const COHORT_SECTIONS = [
  "## Verdict against outcome",
  "## Dismissal reasons by severity",
  "## Addressed rate",
  "## Human review by band",
  "## Agent-authored split",
  "## Recurrence",
  "## Latent forecasts",
] as const

// The band table's separation, read on one v1 label (item 2). The too-few sentence is VS-46a's.
function separationLine(bands: NonNullable<OutcomeReport["bands"]>) {
  if (bands.separation === "too-few")
    return `too-few. Fewer than ${MIN_MATURED} matured PRs with a band, or an empty low or high band.`
  const label = bands.label === "revert" ? "revert" : "unfiltered follow-up-fix (SZZ-based, size-biased, unaudited)"
  const rest = {
    underpowered: ` Fewer than ${MIN_EXPECTED} expected positives in the low or the high band: no verdict, not yet.`,
    overlap: " The low and high bands' intervals overlap. That alone is not a verdict, only not yet.",
    separated: " The low and high bands' intervals do not overlap.",
  }[bands.separation]
  return `${bands.separation}, on the ${label} label.${rest}`
}

/**
 * VS-46c's sections (addendum B §1.8): the base rates and the minimum detectable effect before everything else, and,
 * after the band table, capture against size, the verdict, and depth and reach. Item 7: no sentence here says that
 * anything is ruled out for good; underpowered and undecided read as not yet.
 */
function measurementLines(
  measurement: Measurement,
  bands: NonNullable<OutcomeReport["bands"]>,
  cycle: (value: Cycle) => string,
  audit: LabelAudit | undefined,
) {
  const base = measurement.base
  const labels = measurement.labels
  const rule = measurement.rule
  const name = { revert: "revert", filtered: "filtered follow-up fix" } as const
  // The deciding follow-up-fix label carries its caveat wherever the verdict is read from it, and VS-46d's audit (SF-05a)
  // lifts only the filtered label's mark.
  const audited = audit?.audited === true
  const mark = audited ? "audited" : "unaudited"
  const flag = measurement.deciding === "filtered" ? ` (SZZ-based, size-biased, ${mark})` : ""
  const keys = ["revert", "filtered"] as const
  const byWindow = (record: Record<(typeof LABEL_WINDOWS)[number], Proportion>) =>
    LABEL_WINDOWS.map((days) => `${days} d ${formatCell(record[days])}`).join(", ")
  const expected = (value: { low: number; high: number }) => `${value.low.toFixed(1)} / ${value.high.toFixed(1)}`
  const side = (value: CaptureSide) => `${value.captured} (${share(value.positives)}), ${share(value.lines)}`
  const skipped = (label: LabelMeasure) => (label.ran ? `${label.ran - label.replicates}` : "none run (no PR)")
  const verdictRow = labels[measurement.deciding].capture.find((row) => row.overhead === rule.overhead)
  const tail = (1 - DEFAULT_CONFIDENCE) / 2
  const before = [
    "",
    "## Outcome base rates",
    "",
    `This repository's own rates, before anything is compared, over the ${base.pulls} matured PRs with a band that no read cut short (cycle p50 / p90 ${cycle(base.cycle)} h). A band's expected positives are its PRs times the label's rate, pooled over every band.`,
    "",
    `- Base-branch subjects: ${base.subjects.commits} first-parent commits in the merge window; fix-prefixed ${formatCell(base.subjects.fix)}, revert-prefixed ${formatCell(base.subjects.revert)}.`,
    `- Reverted, over all ${base.pulls}: ${byWindow(base.reverted)}.`,
    `- Unfiltered follow-up fix (VS-46a's label; unaudited), over the ${base.fixed[90].total} not reverted within ${MATURITY_DAYS} days: ${byWindow(base.fixed)}.`,
    `- Filtered follow-up fix (VS-46d's label: blame with -w, -M and -C, code lines only; ${mark}), over the ${base.filtered[90].total} not reverted within ${MATURITY_DAYS} days and not marked filteredIncomplete (${base.filteredIncomplete} marked, left out): ${byWindow(base.filtered)}.`,
    `- Expected positives, low / high band: revert ${expected(bands.expected.revert)}, unfiltered follow-up fix ${expected(bands.expected.unfiltered)}, filtered follow-up fix ${expected({ low: labels.filtered.low.expected, high: labels.filtered.high.expected })}.`,
    measurement.deciding === "revert"
      ? `- Deciding label: revert, which carries no blame-size bias: both the low and the high band expect at least ${MIN_EXPECTED} reverts. Both labels are reported, and the band table's separation reads reverts too.`
      : `- Deciding label: filtered follow-up fix, SZZ-based, size-biased and ${audited ? "audited (VS-46d's audit: see Label audit)" : audit?.labels ? "unaudited (VS-46d's audit has too few answers: see Label audit)" : "unaudited (VS-46d's audit has not run)"}. Reverts decide only when both the low and the high band expect at least ${MIN_EXPECTED} reverts, and here they do not. Both labels are reported. The band table's separation reads only v1 fields, so it uses the unfiltered follow-up-fix label.`,
    "",
    "## Minimum detectable effect",
    "",
    `Printed before any verdict: the smallest difference in positive rate that a two-sided test at ${whole(DEFAULT_CONFIDENCE)} confidence detects with 80% power at these counts, in rate points. The verdict below is in capture-share points instead, and its own interval decides it. Moved PRs are those a floor or the test-only rule put in another band than their score's own. A comparison with fewer than ${MIN_EXPECTED} expected positives in either group is underpowered and gives no verdict.`,
    "",
    "| Label | PRs | Positives | Low / high PRs | MDE low against high (rate points) | Moved PRs | Their expected positives | MDE moved against the label's rate (rate points) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...keys.map((key) => {
      const label = labels[key]
      return `| ${name[key]} | ${label.pulls} | ${label.positives} (${share(label.rate)}) | ${label.low.pulls} / ${label.high.pulls} | ${points(label.mde)} | ${label.floorMoved.pulls} | ${label.floorMoved.expected.toFixed(1)} | ${points(label.floorMoved.mde)} |`
    }),
  ]
  const after = [
    "",
    "## Capture against size",
    "",
    `What this tests: only what the final band adds beyond size. riskOf's likelihood score is log2(1 + added + deleted) plus at most 0.5 from the directory and entropy tie-breakers, so a ranking by score would compare size with itself. PRs are ranked here by the final band, ties broken by score and then by PR number; size ranks them by added plus deleted lines (the order of log(added + deleted)), then by PR number; a random order is shown as its expectation. The band differs from size where a floor raised a PR (a security-sensitive path, or a deletion-heavy code change, to at least medium; the sensitive-with-wide-reach floor cannot fire here, because the band is computed without dependents), where the test-only rule lowered one, and where a tie-breaker reorders PRs of one size or carries one across a cutpoint (compared here, but not counted as moved). ${labels.revert.floorMoved.pulls} of the ${base.pulls} PRs were moved by a floor or the test-only rule: their band is not the one their score gives at the default cutpoints.`,
    ...keys.flatMap((key) => [
      "",
      `${key === "revert" ? "Revert" : `Filtered follow-up fix${flag}`}: ${labels[key].positives} positives among ${labels[key].pulls} PRs. Each side gives the positives its top PRs capture (their share of all positives), then their share of all changed lines.`,
      "",
      "| Top | PRs | Band: positives, lines | Size: positives, lines | Random | Band − size, points [interval] | Cycle p50 / p90 (h), band; size |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...labels[key].capture.map(
        (row) =>
          `| ${whole(row.overhead)} | ${row.pulls} | ${side(row.band)} | ${side(row.size)} | ${share(row.random)} | ${difference(row)} | ${cycle(row.band.cycle)}; ${cycle(row.size.cycle)} |`,
      ),
    ]),
    "",
    `- Bootstrap: ${rule.replicates} replicates, seed ${rule.seed}, each drawing these PRs with replacement and ranking the same draw both ways (paired). Replicates with no positive are skipped: revert ${skipped(labels.revert)}, filtered follow-up fix ${skipped(labels.filtered)}. Each interval runs from the ${(tail * 100).toFixed(1)}th to the ${((1 - tail) * 100).toFixed(1)}th percentile.`,
    `- Low-band miss rate: ${keys
      .map(
        (key) =>
          `${name[key]} ${formatCell(labels[key].lowMiss.positives)} of positives in the low band, which holds ${share(labels[key].lowMiss.pulls)} of PRs and ${share(labels[key].lowMiss.lines)} of changed lines`,
      )
      .join("; ")}.`,
    "- Effort@20% of order(files) inside matured multi-file PRs: unavailable: schema 2 records no per-file fix data.",
    "",
    "## Measurement verdict",
    "",
    `The rule, pre-registered in the report config before any collection${measurement.sealed ? " and sealed into this ledger when it was collected" : ""}: a margin of ${points(rule.margin)} capture-share points, read at the top ${whole(rule.overhead)}, with ${rule.replicates} bootstrap replicates and seed ${rule.seed}.${
      !measurement.sealed
        ? " No rule sealed in this ledger: the report config's rule applies."
        : measurement.differs
          ? ` The report config's rule differs now (margin ${points(MEASUREMENT_RULE.margin)} points, top ${whole(MEASUREMENT_RULE.overhead)}, ${MEASUREMENT_RULE.replicates} replicates, seed ${MEASUREMENT_RULE.seed}): the sealed rule is the one applied.`
          : ""
    }`,
    "",
    `Verdict: ${measurement.verdict}, on the ${name[measurement.deciding]}${flag} label at the top ${whole(rule.overhead)}: band − size ${verdictRow ? difference(verdictRow) : "n/a"} points. ${
      {
        underpowered: `Underpowered: ${measurement.reasons.join("; ")}. Not yet: no verdict at this volume.`,
        "beats-size":
          "The interval lies above 0: the floors and tie-breakers add capture beyond size. That says nothing about history features.",
        "no-better-than-size":
          "The interval lies wholly below the margin: the floors and tie-breakers add no capture detectable at this power, and riskOf is documented as a size, reach and sensitivity heuristic for this repository. Reach is untested here, because the band is computed without dependents. That says nothing about history features.",
        undecided: "The interval neither lies above 0 nor wholly below the margin: not yet.",
      }[measurement.verdict]
    }`,
    "",
    "Underpowered and undecided mean not yet. No verdict decides history risk areas by itself: VS-46 item 6 gates them on a measured separation gain with an interval excluding 0, and that gate stands.",
    "",
    "## Depth and reach",
    "",
    `Post-merge outcomes are a monitor, not a gate, for lens and depth decisions (P3-7). Comparing outcomes across depths needs depth assigned independently of risk (VS-46 item 7), and this ledger records no such assignment, so no depth row is shown. Once one exists, a depth row is suppressed unless each depth compared has at least ${MIN_EXPECTED} expected positives, and a shown row prints its minimum detectable effect: a difference smaller than that is not detectable at this power, which does not mean there is none.`,
    "",
    "Reach is untested: the band here is computed without dependents, so no PR has a reach band, the sensitive-with-wide-reach floor cannot fire, and nothing in this report measures reach.",
  ]
  return { before, after }
}

/**
 * VS-46d items 1 to 4's sections (addendum B §1.9; SF-05a), after VS-46c's: the label audit, untraceable fixes, the
 * filter's reattribution, and fix-edited lines per kLOC. No sentence here says that anything is ruled out for good.
 */
function labelLines(quality: LabelQuality, cycle: (value: Cycle) => string) {
  const audit = quality.audit
  const answers = audit.labels
  const population = audit.population
  const moved = quality.reattribution
  const kinds = moved.kinds
  const mark = audit.audited ? "audited" : "unaudited"
  const bonferroni = 1 - (1 - DEFAULT_CONFIDENCE) / 2
  const small =
    population.positives < AUDIT_PER_LABEL || population.negatives < AUDIT_PER_LABEL
      ? ` This population has ${population.positives} positives and ${population.negatives} negatives, so the audit cannot reach that yet.`
      : ""
  const covered =
    "Every follow-up-fix rate in this report is unaudited, those without a mark of their own included: the filtered label's minimum detectable effect row and capture table, and, on the unfiltered label, the band table's Fixed 30 d and Fixed 90 d columns, the escapes and the later-fixed shares."
  const status = !answers
    ? `Unaudited: no labels file was given (open --labels <file>).${small} ${covered}`
    : audit.audited
      ? `Audited: ${answers.positives} answered positives and ${answers.negatives} answered negatives, at least ${AUDIT_PER_LABEL} of each. The filtered label's rates in this report are audited, its minimum detectable effect row and capture table included, and those with a mark read audited. The unfiltered label (VS-46a's) is not covered by this sample, so its rates stay unaudited, those without a mark of their own included: the band table's Fixed 30 d and Fixed 90 d columns, the escapes and the later-fixed shares.`
      : `Unaudited: the audit needs at least ${AUDIT_PER_LABEL} labelled positives and ${AUDIT_PER_LABEL} labelled negatives; it has ${answers.positives} and ${answers.negatives}.${small} ${covered}`
  const recall = answers?.recall
  const ofLines = (count: number) => `${count} (${share(moved.lines ? count / moved.lines : null)})`
  const kloc = (added: number) => (added / 1000).toFixed(2)
  const perKloc = (value: number | null) => (value === null ? "n/a" : value.toFixed(2))
  const density = (name: string, row: DensityRow) =>
    `| ${name} | ${row.filtered.pulls} | ${kloc(row.filtered.added)} | ${row.filtered.lines} | ${perKloc(row.filtered.perKloc)} | ${row.unfiltered.pulls} | ${kloc(row.unfiltered.added)} | ${row.unfiltered.lines} | ${perKloc(row.unfiltered.perKloc)} | ${cycle(row.cycle)} |`
  return [
    "",
    "## Label audit",
    "",
    `VS-46d item 1: a hand audit of the filtered follow-up-fix label, which is primary on schema 2. Its population is the filtered label's own, as the base rates count it: the ${population.positives + population.negatives} matured PRs with a band not reverted within ${MATURITY_DAYS} days and not marked filteredIncomplete (${population.filteredIncomplete} marked, left out), ${population.positives} positive (a filtered fix within ${MATURITY_DAYS} days) and ${population.negatives} negative. open --audit writes a seeded sample of up to ${AUDIT_DRAW} of each to ${AUDIT_FILE}, ordered by a hash keyed with the owner's private key, for the owner to answer by hand on this machine, and open --labels <file> reads the answers back. Here a sample draws ${audit.sample.positives} positives and ${audit.sample.negatives} negatives. The audit needs at least ${AUDIT_PER_LABEL} answers of each, so up to ${AUDIT_DRAW - AUDIT_PER_LABEL} of each may be skipped.`,
    "",
    status,
    ...(answers && recall
      ? [
          "",
          `- Precision (fix-inducing among the labelled positives): ${formatCell(answers.precision)}.`,
          `- Missed (fix-inducing among the labelled negatives: the label's miss rate): ${formatCell(answers.omission)}.`,
          `- Recall, weighted by this population's ${population.positives} positives and ${population.negatives} negatives: ${share(recall.value)}${recall.interval ? ` [${percent(recall.interval[0])}, ${percent(recall.interval[1])}]` : ""}. The interval is composed from each label's ${(bonferroni * 100).toFixed(1)}% Wilson interval, so both hold at once with at least ${whole(DEFAULT_CONFIDENCE)} confidence (Bonferroni); it is not a Wilson interval of its own. Below ${AUDIT_PER_LABEL} answers of either label only the interval is shown.`,
          `- ${answers.ignored} labels name no PR in this sample and were ignored; a null answer counts as unlabelled.`,
          `- Cycle p50 / p90 over the labelled PRs: ${cycle(answers.cycle)} h.`,
        ]
      : []),
    "",
    "Internal (D12): these rates compare this repository's label with its owner's reading of its own PRs. They are not comparable with published SZZ figures or with any other population.",
    "",
    "## Untraceable fixes",
    "",
    `VS-46d item 2: a fix commit that deletes no line blames no PR, so a label cannot see it. Of the ${quality.untraceable.commits} fix commits the scan labelled (from the window's first merge to ${MATURITY_DAYS} days after its last), those that deleted no line at all, which the unfiltered label cannot trace: ${formatCell(quality.untraceable.unfiltered)}; those that deleted no code line, which the filtered label cannot trace: ${formatCell(quality.untraceable.filtered)}. The filtered count adds the fixes that delete only blank or comment lines to the add-only ones. These count fix commits, not PRs, so they carry no cycle time. Unaudited: the audit samples PRs, not fix commits.`,
    "",
    "## Filter reattribution",
    "",
    `VS-46d item 3: the filtered label (blame with -w, -M and -C, code lines only) is primary on schema 2, and the unfiltered label keeps VS-46a's counts, so the change shows here. Over the ${moved.pulls} PRs of the filtered label's population (${moved.filteredIncomplete} marked filteredIncomplete, left out; cycle p50 / p90 ${cycle(moved.cycle)} h), the unfiltered label blamed ${moved.lines} deleted lines on them within ${MATURITY_DAYS} days.`,
    "",
    `- By kind: code ${ofLines(kinds.code)}, still the PR's under the filter; whitespace ${ofLines(kinds.whitespace)}, put elsewhere by -w; moved ${ofLines(kinds.moved)}, put elsewhere by -M and -C; comment ${ofLines(kinds.comment)} and blank ${ofLines(kinds.blank)}, dropped as comment-only or blank lines.`,
    `- Split into whitespace, comment and move: whitespace ${ofLines(kinds.whitespace)}, comment ${ofLines(kinds.comment)}, move ${ofLines(kinds.moved)}. Blank lines, ${ofLines(kinds.blank)}, are dropped by the blank and comment filter, not put elsewhere by -w, so they stand on their own.`,
    `- Reattributed or dropped: ${ofLines(moved.lines - kinds.code)}.`,
    `- The filtered label blames ${moved.filtered} lines on these PRs: the ${kinds.code} code lines it keeps, and ${moved.gained} gained, lines the unfiltered blame put on other commits.`,
    "",
    "No interval: lines cluster within fix commits. Unaudited: these count the two labels' blamed lines, which the audit does not sample.",
    "",
    "## Fix-edited lines per kLOC",
    "",
    `VS-46d item 4: each label's fix-edited lines within ${MATURITY_DAYS} days per 1,000 lines added, by band, so a band's fix volume is read against its size. Filtered: the filtered label's lines over its population. Unfiltered: VS-46a's label's lines over the matured PRs with a band not reverted within ${MATURITY_DAYS} days. The cycle time is over the unfiltered columns' PRs, which hold the filtered columns'.`,
    "",
    "| Band | Filtered PRs | kLOC added | Filtered fix-edited lines | Per kLOC | Unfiltered PRs | kLOC added | Unfiltered fix-edited lines | Per kLOC | Cycle p50 / p90 (h) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...RISK_BANDS.map((band) => density(band, quality.density[band])),
    density("all", quality.density.all),
    "",
    `Lines added count only a PR's reviewed files, as riskFeatures counts them for the band, while a fix's blamed lines count every file it edited, skipped files such as lockfiles and generated files included, so fixes that edit skipped files read higher here. No interval: lines cluster within fix commits. The filtered columns are ${mark}; the unfiltered columns are unaudited.`,
  ]
}

/**
 * VS-46d items 5 to 11's sections (addendum B §1.9; SF-05b), after SF-05a's. No sentence here says that anything is
 * ruled out for good, and none compares this repository with any other population (D12). `audited` is SF-05a's audit
 * of the filtered label: only then do the filtered rows read audited.
 */
function cohortLines(cohorts: Cohorts, cycle: (value: Cycle) => string, audited: boolean) {
  const verdict = cohorts.verdict
  const groups = verdict.groups
  const size = cohorts.size
  const addressed = cohorts.addressed
  const agent = cohorts.agent
  const recurrence = cohorts.recurrence
  const latent = cohorts.latent
  const mark = `(SZZ-based, size-biased, ${audited ? "audited" : "unaudited"})`
  const bands: readonly string[] = RISK_BANDS
  const name = (stratum: CohortRow["stratum"]) =>
    stratum === "all"
      ? "all PRs, unstratified: confounded by size"
      : bands.includes(stratum)
        ? `band ${stratum}`
        : `tercile ${stratum}`
  const gap = (row: CohortRow) =>
    row.difference
      ? `${signed(row.difference.difference)} [${signed(row.difference.interval[0])}, ${signed(row.difference.interval[1])}]`
      : {
          shown: "n/a",
          empty: "n/a",
          underpowered: "underpowered (not yet)",
          unpaired: "n/a: no stratified difference to set it beside",
        }[row.status]
  const line = (row: CohortRow) =>
    `| ${name(row.stratum)} | ${formatCell(row.a.rate)} | ${formatCell(row.b.rate)} | ${row.expected.a.toFixed(1)} / ${row.expected.b.toFixed(1)} | ${gap(row)} | ${cycle(row.cycle)} |`
  const verdictTable = (title: string, label: VerdictLabel) => [
    "",
    `${title}:`,
    "",
    "| Stratum | Clean, nothing posted (proxy) | With findings (proxy) | Expected positives, clean (proxy) / with findings (proxy) | Clean (proxy) − with findings (proxy), points [interval] | Cycle p50 / p90 (h) |",
    "| --- | --- | --- | --- | --- | --- |",
    ...[...label.bands, ...label.terciles, label.raw].map(line),
  ]
  const agentTable = (title: string, rows: readonly CohortRow[]) => [
    "",
    `${title}:`,
    "",
    "| Stratum | Agent (trusted record) | Human | Expected positives, agent / human | Agent − human, points [interval] | Cycle p50 / p90 (h) |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map(line),
  ]
  const cut = size.cut
    ? `small up to ${size.cut[0]} lines (${size.pulls.small} PRs), middle up to ${size.cut[1]} (${size.pulls.middle}), large above ${size.cut[1]} (${size.pulls.large})`
    : "none, with no matured PR with a band"
  const count = (value: number | null) => (value === null ? "n/a" : value.toFixed(1))
  const status = {
    "not-read": NO_DROPS_READ,
    refused:
      "refused: a latent outcome is malformed (a drop latentDrops would refuse, or a fixedDays that is not a finite number of days at or above 0), so none is scored",
    "no-drops": NO_DROPS,
    "too-few": `too few to read: ${latent.matured} matured drops, fewer than ${LATENT_MIN_DROPS}, so not yet`,
    "kill-met": `kill criterion met (precision under ${whole(LATENT_KILL_PRECISION)} on at least ${LATENT_MIN_DROPS} matured drops); the decision is the owner's`,
    "kill-not-met": `kill criterion not met (precision at least ${whole(LATENT_KILL_PRECISION)} on at least ${LATENT_MIN_DROPS} matured drops); the decision is the owner's`,
  }[latent.status]
  return [
    "",
    "## Verdict against outcome",
    "",
    `VS-46d item 5: revert and filtered follow-up-fix rates within ${MATURITY_DAYS} days for PRs reviewed with nothing posted and complete, against PRs reviewed with findings, within each risk band and within each size tercile. The verdict here is a proxy, labelled as one, because ReviewState records no verdict yet. A PR is clean (proxy) when the review job's sticky state was found with at least one completed review, the ledger holds no finding on it, its state was not pruned, and its last run left no file unreviewed; it is with findings (proxy) when the ledger holds a finding on it, in any stratum or outcome. A pruned state (at its finding cap or near its size limit) may have lost summary findings, so it reads incomplete. The proxy is read from the sticky state and the finding markers. The exact clean-complete value from VS-32a's reviewVerdict replaces it only once SF-39 records the verdict in ReviewState and a later ledger collection field reads it, which is a /3. The ledger keeps no failed-run flag, so a failed last run that left no file unreviewed reads as complete. No depth assignment is recorded (VS-46 item 7), so there is no depth stratum.`,
    "",
    `- Compared: the human-stratum matured PRs with a band that no read cut short, ${groups.clean} clean (proxy) and ${groups.findings} with findings (proxy). Left out: ${groups.unreviewed} unreviewed (no sticky state, or no completed review) and ${groups.incomplete} incomplete (files left unreviewed, no count, or a pruned state); ${verdict.excluded.agent} agent-stratum PRs, which the agent-authored split reports on their own, because same-agent iteration confounds the follow-up-fix label; and ${verdict.excluded["agent-signal"]} agent-signal PRs, whose markers are untrusted, so they only exclude. The filtered rows also leave out the PRs reverted within ${MATURITY_DAYS} days and ${verdict.filteredIncomplete} marked filteredIncomplete.`,
    `- Size terciles, by added plus deleted lines over every matured PR with a band, every stratum: ${cut}. PRs of one size share a tercile, so ties can leave a tercile short or empty. Band rows and tercile rows are two separate stratifications: a band row pools every size, and a tercile row every band.`,
    `- A difference is clean less findings, in rate points, with Newcombe's ${whole(DEFAULT_CONFIDENCE)} interval. It is shown only when each group has at least ${MIN_PULLS} PRs, so both rates show, and at least ${MIN_EXPECTED} expected positives (its PRs times the two groups' pooled rate in that row); otherwise it reads underpowered, which means not yet.`,
    "- Clean verdicts go mostly to small, low-reach PRs, whose fix and revert rates are lower anyway, so a raw difference measures size. The last row of each table pools every compared PR and is confounded by size: it is printed only beside the stratified rows, and its difference is shown only when a stratified row of the same table shows one.",
    ...verdictTable(`Revert within ${MATURITY_DAYS} days`, verdict.labels.revert),
    ...verdictTable(`Filtered follow-up fix within ${MATURITY_DAYS} days ${mark}`, verdict.labels.filtered),
    "",
    "## Dismissal reasons by severity",
    "",
    "VS-46d item 6: each severity's dismissals, by the role that dismissed them, are the dismissed-writer, dismissed-author and dismissed-unattributed counts in the Resolution table above, over the human-stratum findings on PRs that no read cut short; bulk resolutions are split out.",
    "",
    `Reasons: ${NO_DISMISSAL_REASON}. VS-35b's classes (${DISMISSAL_WHY.join(", ")}) come from its classifier, dismissalWhy, which reads a writer's reply text and has no caller until an owner-repository precision sample of at least 0.9 qualifies it; the ledger keeps no reply text. Recording a reason needs a new ledger schema (/3).`,
    "",
    "## Addressed rate",
    "",
    `VS-46d item 7. Definition: a finding is addressed when it was marked fixed and its thread was resolved by a person who is neither a bot nor the PR author (fixed-confirmed-by-thread). The rate is addressed findings over settled ones (${SETTLED.join(", ")}): the severity gradient's confirmed-fix share, every severity together. Population: the ${addressed.rate.total} settled human-stratum findings on ${addressed.pulls} PRs that no read cut short, merged in the window, matured or not; agent, agent-signal and bulk findings are split out.`,
    "",
    `- Addressed: ${formatCell(addressed.rate)} (cycle p50 / p90 ${cycle(addressed.cycle)} h).`,
    `- Human-comment volume on those PRs: ${addressed.comments.total} comments by people other than the PR author and the bots (issue comments, review-thread comments and reviews with a body); per PR, p50 / p90 ${count(addressed.comments.p50)} / ${count(addressed.comments.p90)}; ${addressed.comments.missing} of the PRs carry no count (not reviewed).`,
    "",
    "Internal (D12): this rate is comparable only within this population under this definition, as a paired or A/B comparison on this repository. It is not comparable with any vendor's addressed, acceptance or resolution rate, or with any other population's.",
    "",
    "## Human review by band",
    "",
    "VS-46d item 8: the share of PRs that a person other than the PR author and the bots reviewed or commented on (humanReview), by band, over every PR with a band that no read cut short, matured or not, every stratum. It is a cheap proxy for whether repository rules change scrutiny (P3-2), and evidence for Q28; it shows no cause.",
    "",
    "| Band | PRs | Human review | Cycle p50 / p90 (h) |",
    "| --- | --- | --- | --- |",
    ...([...RISK_BANDS, "all"] as const).map((band) => {
      const row = cohorts.humanReview[band]
      return `| ${band} | ${row.pulls} | ${formatCell(row.rate)} | ${cycle(row.cycle)} |`
    }),
    "",
    "## Agent-authored split",
    "",
    `VS-46d item 9: outcome rates for agent-authored PRs, from the owner's trusted record only (stratum agent), against human-stratum PRs, within the size terciles above, over each label's population as the measurement reads it. Untrusted markers only exclude: the ${agent.excluded} agent-signal PRs enter neither group. There is no unstratified row. Same-agent iteration confounds the follow-up-fix label (P3-11), so the third table removes same-agent follow-ups: an agent PR is positive there only through a filtered fix within ${MATURITY_DAYS} days that the record shows is not the same agent's, and ${agent.unknown} agent PRs are left out, because only fixes whose own PR the call cap left unknown could make them positive. Differences are agent less human, shown under the same rule as above.`,
    "",
    `- Same-agent share of follow-up fixes on agent PRs, per fix entry within ${MATURITY_DAYS} days: filtered label ${formatCell(agent.sameAgent.filtered.share)}, with ${agent.sameAgent.filtered.unknown} unknown and left out; unfiltered label ${formatCell(agent.sameAgent.unfiltered.share)}, with ${agent.sameAgent.unfiltered.unknown} unknown and left out. No interval: fix entries cluster within PRs and fix commits. SZZ-based and unaudited: the audit samples PRs, not fix entries.`,
    ...agentTable(`Revert within ${MATURITY_DAYS} days`, agent.labels.revert),
    ...agentTable(`Filtered follow-up fix within ${MATURITY_DAYS} days ${mark}`, agent.labels.filtered),
    ...agentTable(
      `Filtered follow-up fix within ${MATURITY_DAYS} days, same-agent follow-ups removed ${mark}`,
      agent.labels.filteredOther,
    ),
    "",
    "This is evidence for Q41, which is the owner's; this report decides nothing. On one repository it will most likely stay undecided.",
    "",
    "## Recurrence",
    "",
    `VS-46d item 10, descriptive only: the share of matured follow-up fixes (fix entries within ${MATURITY_DAYS} days of a PR's merge) whose fixed lines fall in a file, or a function, that had an earlier fix within ${RECURRENCE_DAYS} days before the reviewed PR's merge. Filtered: each entry's own location (where most of its lines are), over the filtered label's population. Unfiltered: every location its fix commit edited, over the PRs not reverted within ${MATURITY_DAYS} days. An earlier fix is any fix commit the scan labelled other than the entry's own, dated from ${RECURRENCE_DAYS} days before the merge day to the day before it: fix commits keep only their day, so one on the merge day is left out. A function match needs the same file and a funcname on both sides. It measures hotspot co-location, which round two found does not help ranking, and it cannot show that a prior-fix card helps detection, so it gates nothing; L6 waits on the Q9 ablation alone.`,
    "",
    `- Truncated lookback: the scan keeps fix commits only after the window's first merge (${recurrence.first ?? "none"}), so a PR merged within ${RECURRENCE_DAYS} days of it has a shorter lookback. The full-lookback columns count only the entries whose lookback starts after that day.`,
    `- ${recurrence.capped} fix commits had more than ${MAX_FIX_LOCATIONS} locations and keep only their first ${MAX_FIX_LOCATIONS}, so a later file of theirs is not matched.`,
    "",
    "| Label | Fixes | Earlier fix in file | Earlier fix in function | Full lookback: fixes | In file | In function | Cycle p50 / p90 (h) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...(["filtered", "unfiltered"] as const).map((key) => {
      const side = recurrence.labels[key]
      return `| ${key} | ${side.fixes} | ${formatCell(side.file)} | ${formatCell(side.fn)} | ${side.full.fixes} | ${formatCell(side.full.file)} | ${formatCell(side.full.fn)} | ${cycle(side.cycle)} |`
    }),
    "",
    "No interval: fix entries cluster within PRs and fix commits. Unaudited: the audit samples PRs, not fix entries.",
    "",
    "## Latent forecasts",
    "",
    `VS-46d item 11: when local eval artifacts hold VS-42 pre-existing drops (path, base line span, class, base SHA, fingerprint), each is joined to later fixes of its base lines, and latent-forecast precision is the share of matured drops (recorded at least ${MATURITY_DAYS} days before the clone's history ends) whose base lines a fix edited within ${MATURITY_DAYS} days. A defect dropped on several reviews counts once, at its earliest drop. Kill criterion: precision under ${whole(LATENT_KILL_PRECISION)} on at least ${LATENT_MIN_DROPS} matured drops; the report says whether it is met, and the decision is the owner's. It reads only local eval artifacts, and no GitHub state or markers, which are public.`,
    "",
    `Status: ${status}.`,
    ...(latent.drops
      ? [
          "",
          `- Drops: ${latent.drops} distinct (${latent.repeated} further drops of a fingerprint already counted), ${latent.matured} matured; fixed within ${MATURITY_DAYS} days ${formatCell(latent.precision)}. No interval: drops cluster within reviews and files, and the criterion reads the point estimate only.`,
          ...(latent.byClass.length
            ? [
                "",
                `| Class | Matured drops | Fixed within ${MATURITY_DAYS} days |`,
                "| --- | --- | --- |",
                ...latent.byClass.map((row) => `| ${row.class} | ${row.matured} | ${row.fixed} |`),
              ]
            : []),
        ]
      : []),
    "",
    `Limits: drops exist only when scopeGate: introduced and guardrail: strict are both set, and both are off by default; once wired, the scope prompt clause suppresses most pre-existing findings before they become drops; StrictResult.dropped keeps only counts, so drop locations are new retained data (R5); following base lines through later history is new machinery, because this script's blame returns no base line, and nothing here builds that join yet; on one repository the stream may not reach ${LATENT_MIN_DROPS} matured drops. Drops are not PRs, so this section has no cycle time.`,
  ]
}

// A capture row's band-minus-size difference and its interval, in capture-share points.
function difference(row: CaptureRow) {
  if (row.difference === null) return "n/a"
  return `${signed(row.difference)}${row.interval ? ` [${signed(row.interval[0])}, ${signed(row.interval[1])}]` : ""}`
}

function signed(value: number) {
  return `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}`
}

function points(value: number | null) {
  return value === null ? "n/a" : (value * 100).toFixed(1)
}

function share(value: number | null) {
  return value === null ? "n/a" : percent(value)
}

// An overhead, as a whole percentage.
function whole(value: number) {
  return `${Math.round(value * 100)}%`
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
       bun script/vectorscope-eval/outcomes.ts open <sealed.json> <private-key.pem> <directory> [--ledger] [--audit] [--labels <file>]

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
  --audit                    Also write ${AUDIT_FILE}: a seeded sample of PRs to label by hand (never overwritten)
  --labels <file>            Your answers to that sample, read only; outside every git work tree
  A ${LEDGER_SCHEMA_V1} ledger opens read-only, as v1: its schema-2 sections print as unavailable.
  The audit sample and your answers name PRs: keep them on this machine and delete them when they expire.
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
  audit: { type: "boolean" },
  labels: { type: "string" },
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
  if (command === "open" && rest.length === 3)
    return openCommand(
      rest,
      { ledger: values.ledger === true, audit: values.audit === true, labels: values.labels },
      now,
    )
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
  // Schema 2's rules tie many fields together: a ledger that breaks one is refused here, before it is sealed, and not by
  // `open` after the whole collection.
  const problem = ledgerProblem(ledger, deps.now)
  if (problem)
    return refuse(1, `The collected ledger fails its own check (${problem}): it was not sealed. Nothing was written.`)
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

function openCommand(
  paths: readonly string[],
  options: { ledger: boolean; audit: boolean; labels: string | boolean | undefined },
  now: number,
) {
  const [file = "", keyFile = "", directory = ""] = paths
  const target = realPath(directory)
  if (!outsideRepository(target, realPath(REPO_ROOT)) || insideWorkTree(target))
    return usage("The directory must be outside the VectorScope checkout and every other git work tree.")
  // parseArgs, not strict, reads a bare --labels as true and takes a following option as its value: neither is a path.
  if (
    options.labels !== undefined &&
    (typeof options.labels !== "string" || !options.labels || options.labels.startsWith("-"))
  )
    return usage("Give --labels as the path of your labels file.")
  const labelsFile = typeof options.labels === "string" ? realPath(options.labels) : undefined
  if (labelsFile !== undefined && (!outsideRepository(labelsFile, realPath(REPO_ROOT)) || insideWorkTree(labelsFile)))
    return usage(
      "--labels must be outside the VectorScope checkout and every git work tree, so the owner's answers are never committed.",
    )
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
  // A schema-1 ledger is read as v1, against VS-46a's decoder, and written back with --ledger as it was read: never
  // upgraded or resealed.
  const legacy = obj(decoded.value).schema === LEDGER_SCHEMA_V1
  const problem = legacy ? v1LedgerProblem(decoded.value, now) : ledgerProblem(decoded.value, now)
  if (problem) return refuse(1, `The ledger cannot be opened: ${problem}. Nothing was written.`)
  if (legacy && (options.audit || labelsFile !== undefined))
    return refuse(
      1,
      `--audit and --labels need a ${LEDGER_SCHEMA} ledger: a ${LEDGER_SCHEMA_V1} ledger has no filtered label to audit. Nothing was written.`,
    )
  // ledgerProblem or v1LedgerProblem checked every entry the report reads.
  const ledger = decoded.value as OutcomeLedger | OutcomeLedgerV1
  if (labelsFile !== undefined && (statSync(labelsFile, { throwIfNoEntry: false })?.size ?? 0) > MAX_LABELS_BYTES)
    return refuse(1, `The labels file is too large: more than ${MAX_LABELS_BYTES} bytes. Nothing was written.`)
  const labelsText = labelsFile === undefined ? undefined : readText(labelsFile)
  if (labelsFile !== undefined && labelsText === undefined)
    return refuse(1, `Cannot read the labels file ${labelsFile}. Nothing was written.`)
  const labels = labelsText === undefined ? undefined : auditLabels(labelsText, ledger.repository, now)
  if (typeof labels === "string") return refuse(1, `The labels cannot be read: ${labels}. Nothing was written.`)
  // lstat, not exists: a symbolic link by that name, even a dangling one, is refused too, so the write cannot follow it.
  if (options.audit && lstatSync(join(target, AUDIT_FILE), { throwIfNoEntry: false }))
    return refuse(
      1,
      `${join(target, AUDIT_FILE)} already exists and may hold your answers: it is never overwritten. Nothing was written.`,
    )
  // The audit key exists only here, in memory, for one draw; only a schema-2 ledger gets this far with either option.
  const sample =
    ledger.schema === LEDGER_SCHEMA && (options.audit || labels) ? auditSample(ledger, auditKey(pem)) : undefined
  const report = outcomeReport(ledger, sample && labels ? { sample, labels: labels.answers } : undefined)
  // A new sample keeps the answers it is given, and expires no later than the file they came from.
  const written =
    sample && options.audit
      ? labels
        ? {
            ...sample,
            expires: Date.parse(labels.expires) < Date.parse(sample.expires) ? labels.expires : sample.expires,
            entries: sample.entries.map((entry) => ({ ...entry, fixInducing: labels.answers.get(entry.id) ?? null })),
          }
        : sample
      : undefined
  mkdirSync(target, { recursive: true, mode: 0o700 })
  writePrivate(join(target, REPORT_FILE), renderOutcomes(report))
  if (options.ledger) writePrivate(join(target, OUTCOME_LEDGER_FILE), JSON.stringify(ledger, null, 2) + "\n")
  // "wx" creates the file exclusively (O_EXCL), so neither a file nor a link that appeared after the check is
  // overwritten or followed: the write fails instead.
  if (written) writePrivate(join(target, AUDIT_FILE), JSON.stringify(written, null, 2) + "\n", "wx")
  const wrote = [REPORT_FILE, ...(options.ledger ? [OUTCOME_LEDGER_FILE] : []), ...(written ? [AUDIT_FILE] : [])]
  const gradient = sample !== undefined && report.volume.decision === "gradient-only"
  const dropped =
    written && labels
      ? [...labels.answers.keys()].filter((id) => !written.entries.some((entry) => entry.id === id)).length
      : 0
  return {
    code: 0,
    stdout: `Wrote ${wrote.length > 1 ? `${wrote.slice(0, -1).join(", ")} and ${wrote.at(-1)}` : REPORT_FILE} to ${target}. The ledger expires on ${ledger.expires.slice(0, 10)}: delete these files by then.${legacy ? ` It is a ${LEDGER_SCHEMA_V1} ledger, opened read-only as v1: its schema-2 sections are unavailable.` : ""}${
      written
        ? ` Answer each fixInducing in ${AUDIT_FILE} (at least ${AUDIT_PER_LABEL} of each label) and pass the file back with --labels. It and your answers name PRs: keep them on this machine, and delete them by ${written.expires.slice(0, 10)}.`
        : ""
    }${
      dropped
        ? ` ${dropped} of your answers name no PR in the new sample and were not carried into it; your labels file still holds them.`
        : ""
    }${
      gradient
        ? labels
          ? ` The labels were checked but not used: this report is gradient-only (fewer than ${MIN_VOLUME} settled human-stratum findings on PRs merged in the ${MATURITY_DAYS} days before collection), and the label sections follow the full report's volume rule.`
          : ` This report is gradient-only, so it has no label section yet: the label sections follow the full report's volume rule.`
        : ""
    }\n`,
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
// numbers, which identify people (I-3, I-4). With flag "wx" an existing file, or a link, fails the write instead.
function writePrivate(file: string, text: string, flag = "w") {
  writeFileSync(file, text, { mode: 0o600, flag })
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
