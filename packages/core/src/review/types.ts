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
export type CostKind = "free" | "priced" | "plan" | "local" | "unknown"

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

// VS-33 (addendum A; Q2, Q20, Q21): one `zdrAttested` entry with what the owner attests beyond its ID. `id` is read as
// a text entry is, as a provider ID and as a host. `operator` (required) is the platform operator that processes the
// data, such as "aws" for Claude on Bedrock or "anthropic" for the Claude API. `project` is the cloud project or account
// it covers. `region` pins an OpenRouter account to eu.openrouter.ai or us.openrouter.ai and attests nothing else.
// `extendedCache` accepts OpenAI's 24-hour extended prompt caching (gpt-5.5 and later). `verify: "api"` asks admission
// to check the account itself; absent means "attest". Nothing checks it yet: until a verifier exists (Q20), VS-23b's
// admission must refuse a route whose decision lists an attestation with `verify: "api"`, and must refuse an OpenAI
// one unless Q20 approves an admin credential.
export interface ZdrAttestation {
  id: string
  operator: string
  project?: string
  region?: "eu" | "us"
  extendedCache?: boolean
  verify?: "attest" | "api"
}
export type ZdrAttestedEntry = string | ZdrAttestation

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
  // Which findings a second pass re-checks before they are posted; it drops the ones it rejects. The verify policy,
  // `verifyCandidates` in plan.ts, documents the rules: "blocking" re-checks blocking findings, "all" every finding
  // above a nit, "off" none, and an untrusted review or a triage model adds to what this names.
  verify: "blocking" | "all" | "off"
  // VS-06's off-by-default opt-in (D3). "shared" applies that one verify policy on every surface, and a config that
  // does not set `verify` then gets SHARED_VERIFY_DEFAULT ("all") instead of "blocking". "legacy" keeps each surface's
  // rule as it was before the policy existed. It stays "legacy" until the D2 gate has measured the change.
  verifyPolicy: "legacy" | "shared"
  // VS-07's off-by-default opt-in (D3). "warn" adds notes on what VectorScope's evaluation says about the review's models
  // (model-evidence.ts): unvetted, expired, retired or rerouted models, and free models whose providers may train on
  // the code. It never changes which model runs. "off" keeps today's review.
  modelEvidence: "off" | "warn"
  // VS-24's opt-in (D3): "skip" ends a review whose every changed file is trivial (trivial.ts: whitespace, docs, rename
  // or comment-only under strict rules) with zero attempts and a note. Absent means "review" (OPTIONAL_REVIEW_DEFAULTS),
  // and DEFAULT_REVIEW_CONFIG leaves it out, so every config and its digest stay as they were. Parsed, and read by no
  // runner until VS-24 wiring (UNAPPLIED_REVIEW_KEYS), so the parser warns that "skip" is not applied; the GitHub skip
  // waits for the @vector merge.
  trivial?: "review" | "skip"
  // VS-25's opt-in (D3, Q15). Under "graph", Review.run will build the Tier 1 impact slice (impact.ts) and send it as
  // <untrusted_impact>. Absent means "grep" (OPTIONAL_REVIEW_DEFAULTS), and DEFAULT_REVIEW_CONFIG leaves it out, so every
  // config and its digest stay as they were. Parsed, and read by no runner until VS-25b wiring (UNAPPLIED_REVIEW_KEYS),
  // so the parser warns that "graph" is not applied.
  impact?: "grep" | "graph"
  // VS-23's opt-in (D3, Q1): "zdr" sends code only on zero data retention routes (privacy.ts). Raise-only: any source
  // may set it and none may lower it. Absent means "standard", and DEFAULT_REVIEW_CONFIG leaves it out, so every
  // config and its digest stay as they were. Only mergeReviewConfig reads it, and no runner calls that before VS-23b.
  privacy?: "standard" | "zdr"
  // The routes the owner attests are zero data retention (Q2): provider IDs, `openrouter` for an OpenRouter account,
  // and model server hosts. A text entry is the legacy form and keeps its meaning; an attestation object (VS-33) adds
  // what the owner attests beyond the ID. Read only from a trusted source (mergeReviewConfig); absent means none.
  zdrAttested?: ZdrAttestedEntry[]
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
  // VS-24: a cap on the first-turn input tokens of a review's planned passes, summed (dispatch.ts, decideDispatch); it
  // counts free, plan and local models too. Absent or 0 means none. A budget, not a policy key, and an estimate: admission
  // and the dollar caps stay the real bounds. Parsed, and read by no runner until VS-24 wiring (UNAPPLIED_REVIEW_KEYS),
  // so the parser warns that a cap is not applied.
  maxInputTokens?: number
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
  verifyPolicy: "legacy",
  modelEvidence: "off",
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

// What an optional key reads as when a config leaves it out. DEFAULT_REVIEW_CONFIG leaves these out, so configs and
// their digests made before the key existed stay as they were.
export const OPTIONAL_REVIEW_DEFAULTS = {
  trivial: "review",
  maxInputTokens: 0,
  impact: "grep",
} as const satisfies Partial<ReviewConfig>

// The same, read by any ReviewConfig key, for lookups that do not know which keys have an entry.
export const OPTIONAL_REVIEW_DEFAULT_OF: Partial<Record<keyof ReviewConfig, unknown>> = OPTIONAL_REVIEW_DEFAULTS

// Keys config.ts parses that no runner applies yet, each optional with a default above. The parser warns when one would
// change a review, policyDigest reads them as absent whatever their value, so no evidence scope claims a policy its
// review did not run under, and the eval replay neither takes nor records them. VS-24 or VS-25b wiring takes a key off
// this list when a runner applies it.
export const UNAPPLIED_REVIEW_KEYS = [
  "trivial",
  "maxInputTokens",
  "impact",
] as const satisfies readonly (keyof typeof OPTIONAL_REVIEW_DEFAULTS)[]

// The verify setting a review gets under verifyPolicy "shared" when neither review.json nor REVIEW_VERIFY sets one:
// the plan's proposed default. Today's default stays DEFAULT_REVIEW_CONFIG.verify while the policy is "legacy".
export const SHARED_VERIFY_DEFAULT: ReviewConfig["verify"] = "all"
