// The shared review contract. Types and constants only, with no imports, so the engine, the CLI and the
// desktop renderer can all use it.

export const SEVERITIES = ["blocking", "concern", "nit"] as const
export type Severity = (typeof SEVERITIES)[number]
export const CATEGORIES = [
  "bug",
  "security",
  "reliability",
  "performance",
  "tests",
  "maintainability",
  "style",
  "docs",
] as const
export type Category = (typeof CATEGORIES)[number]
export type Side = "RIGHT" | "LEFT"
export type Risk = "low" | "medium" | "high"
export type Trust = "trusted" | "untrusted"
export type Trigger = "auto" | "command" | "local" | "desktop"
// "codium" is billed to the account's Vector Codium plan and never priced locally.
export type CostKind = "free" | "priced" | "plan" | "local" | "unknown" | "codium"

export interface ModelFinding {
  path: string
  line: number
  endLine?: number
  side?: Side
  severity: Severity
  category: Category
  title: string
  body: string
  suggestion?: string
  confidence: number // 0..1
  evidence?: string[] // "path:line" references it read
  rule?: string // the quoted rule sentence
  duplicateOf?: string // id of an open earlier finding this repeats
}

export interface ModelReport {
  summary: string
  risk: Risk
  files: { path: string; note: string }[]
  findings: ModelFinding[]
  priorStatus?: { id: string; status: "fixed" | "open"; reason: string }[]
}

export interface Finding extends ModelFinding {
  id: string
  side: Side
  source: "review" | "security"
  verified?: boolean
  // Other places the same defect was reported in this run, as "path:line". Selection folds them into this finding.
  also?: string[]
}

export type AnchorFailure = "file-not-in-diff" | "line-outside-diff" | "no-patch"

export interface Anchor {
  path: string
  side: Side
  line: number
  startLine?: number
  hunk: number
}

export interface PlacedFinding extends Finding {
  anchor: Anchor
  suggestionAllowed: boolean
}

// A range of head lines.
export interface FocusHunk {
  path: string
  start: number
  end: number
}

export type DropReason =
  | "empty"
  | "low-confidence"
  | "ignored-path"
  | "unknown-path"
  | "duplicate"
  | "dismissed"
  | "rejected-by-verify"
  | "unconfirmed" // after a triage pass, the review model did not confirm it
  | "nit" // a nit or a style finding, while nits are off

export interface PriorFinding {
  id: string
  where: "inline" | "summary"
  path: string
  line: number | null // current head line; null = GitHub marks the thread outdated
  side: Side
  severity: Severity
  category: Category
  title: string
  sha: string
  status: "open" | "fixed" | "dismissed" | "outdated"
  commentId?: number
  threadId?: string
  fixedIn?: string
  dismissedBy?: string
  // The other lines of this file its comment or listing names as the same defect, at the current head.
  also?: number[]
}

export interface Selection {
  inline: PlacedFinding[]
  outsideDiff: (Finding & { reason: AnchorFailure })[]
  elsewhere: Finding[]
  nits: Finding[]
  overflow: Finding[]
  stillOpen: PriorFinding[]
  fixed: PriorFinding[]
  dismissed: PriorFinding[]
  reappeared: string[]
  raised: { id: string; was: Severity }[]
  dropped: { reason: DropReason; count: number }[]
  risk: Risk
}

// Findings that exist only in the summary: outside the diff, elsewhere, nits and overflow.
export interface SummaryFinding {
  id: string
  path: string
  line: number
  side: Side
  severity: Severity
  category: Category
  title: string // at most 60 characters
  sha: string
  status: PriorFinding["status"]
  fixedIn?: string
  also?: number[] // the other lines of this file it names as the same defect
}

export interface ReviewState {
  v: 1
  // Full SHAs of the last completed review.
  head?: string
  base?: string
  reviews: number
  costUsd: number
  tokens: [input: number, output: number]
  month?: { key: string; costUsd: number } // key is "2026-09"
  unreviewed: string[] // files a partial run did not cover; added to the next focus
  failed?: boolean
  notedHead?: string
  inlinePosted: number
  inflight?: { run: string; head: string; at: number; costUsd: number }
  findings: SummaryFinding[] // inline findings live in their own comment markers
}

export interface SkippedFile {
  path: string
  reason: "ignored" | "lockfile" | "generated" | "vendored" | "build-output" | "binary" | "deleted" | "size-limit"
  additions?: number
}

export interface ReviewCost {
  costUsd: number
  usageMissing?: boolean
  // A reply stopped or failed before it reported usage, so costUsd is only what the rest of the review cost.
  partial?: boolean
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  kind: CostKind
  model: string
}

export interface ReviewOutcome {
  report: ModelReport
  selection: Selection
  skipped: SkippedFile[]
  cost?: ReviewCost
  durationMs: number
  base: string
  head: string
  since?: string
  mode: "full" | "incremental" | "carry"
  forcePushed?: boolean
  partial?: "budget" | "steps" | "timeout" | "model-error"
  unreviewed: string[]
  specialists: {
    name: "review" | "security" | "verify"
    status: "ok" | "failed" | "timeout" | "stopped" | "skipped"
    steps: number
    detail?: string
  }[]
  sessions: string[]
  stats: { files: number; additions: number; deletions: number }
  notes: string[] // deterministic summary notes (generated header, moved comments, superseded)
  // What each pass spent, from its session's recorded usage. Absent when no pass reported usage.
  passes?: ReviewPass[]
}

export interface ReviewPass {
  name: "review" | "security" | "verify"
  model: string // "provider/model"
  costUsd?: number // absent when the pass's usage carried no price
  input: number // cache reads and writes included
  output: number
  cacheRead: number
}

// `.vector/review.json`. Environment variables override it, and it overrides DEFAULT_REVIEW_CONFIG.
export interface ReviewConfig {
  incremental: boolean
  minSeverity: Severity // the lowest severity posted on a line
  minConfidence: number
  maxComments: number // inline comments per review, clamped to 0..50
  maxCommentsPerPr: number // inline comments across all reviews of one PR
  suggestions: boolean
  replyOnFix: boolean
  security: "auto" | "always" | "off" // "auto": runs when sensitive paths change
  // "blocking": a second pass re-checks blocking findings (and, when untrusted, every suggestion).
  verify: "blocking" | "all" | "off"
  failOn: "never" | "blocking" // "blocking" fails the job while blocking findings are open
  ignore: string[] // added to the defaults
  ignoreDefaults: boolean
  skipAuthors: string[]
  skipLabels: string[] // vector:paused is always honoured
  skipBranches: string[]
  maxFiles: number
  maxChangedLines: number // after ignores
  maxDiffChars: number // inlined per review session
  maxSteps: number // for review; security gets ceil(2/3 of it), verify 10
  maxCostUsd: number // per review; 0 = no dollar cap
  maxCostUsdPerPr: number // across automatic reviews of one PR; 0 = none
  maxCostUsdPerMonth: number // 0 = none; install writes REVIEW_MAX_COST_USD_PER_MONTH=50 for paid models
  timeoutMinutes: number
  model?: string // "provider/model"
  // A cheaper "provider/model" for the first pass. The review and security reviewers run on it, and every finding
  // above a nit is then double-checked on `model`; only the ones it confirmed are reported, and `verify` cannot be off.
  triageModel?: string
  // Style nits are left out unless this is true or minSeverity is "nit".
  nits: boolean
  paths: { path: string; instructions: string }[] // JSON alternative to review.md sections
}

export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  incremental: true,
  minSeverity: "concern",
  minConfidence: 0.7,
  maxComments: 10,
  maxCommentsPerPr: 25,
  suggestions: true,
  replyOnFix: false,
  security: "auto",
  verify: "blocking",
  failOn: "never",
  ignore: [],
  ignoreDefaults: true,
  skipAuthors: ["dependabot[bot]", "renovate[bot]"],
  skipLabels: ["vector:skip", "no-review"],
  skipBranches: [],
  maxFiles: 300,
  maxChangedLines: 5_000,
  maxDiffChars: 120_000,
  maxSteps: 30,
  maxCostUsd: 2,
  maxCostUsdPerPr: 10,
  maxCostUsdPerMonth: 0,
  timeoutMinutes: 12,
  nits: false,
  paths: [],
}
