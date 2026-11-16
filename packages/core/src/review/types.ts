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
  // The strict report schema's fields (VS-27a). Only decodeReport under `guardrail: "strict"` reads them, and no runner
  // asks for that before VS-27c, so legacy output never has them.
  failure?: FailureInfo // asked for on every blocking finding; S2 and S5 enforce that, not the schema
  quotes?: Quote[]
  patch?: string // a unified diff against head
  // Set only by decodeReport under `guardrail: "strict"` when the model's severity names none of SEVERITIES (VS-27b,
  // the round-two amendment). `severity` then reads "concern" as on the legacy path, and S2 drops the finding as
  // `severity-unreadable`, never as a choice of the model's.
  severityUnreadable?: boolean
  // The model's scope label (VS-42): S9 drops a finding labelled "pre-existing" under `scopeGate: "introduced"`. No
  // decoder sets it before VS-42 wiring (with VS-27c), so only callers that build findings themselves can reach it.
  scope?: FindingScope
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
  // Who confirmed it (VS-27a). `verified` stays a boolean, so every `verified === true` check keeps its meaning: a
  // runtime confirmation sets both `verified: true` and `verifiedBy: "runtime"`. No runner sets it before VS-27c or VS-30.
  verifiedBy?: VerifiedBy
  // Other places the same defect was reported in this run, as "path:line". Selection folds them into this finding.
  also?: string[]
}

// VS-27's strict guardrail (contract §1.2). Its types live here, not in guardrail.ts, because ReviewOutcome.strict
// needs them and this file stays import-free; VS-27b's guardrail.ts adds StrictInput and strictSelect. Nothing produces
// any of them before VS-27c.
// The five production-breaking classes. Their definitions wait for VS-27c's prompt (owner questions Q3 and Q4).
export const FAILURE_CLASSES = ["crash", "data-corruption", "leak", "runaway-loop", "auth-bypass"] as const
export type FailureClass = (typeof FAILURE_CLASSES)[number]
export const FAILURE_MECHANISMS = ["logic", "concurrency", "regression", "resource", "access"] as const
export type FailureMechanism = (typeof FAILURE_MECHANISMS)[number]
export interface FailureInfo {
  class: FailureClass
  mechanism: FailureMechanism
  trigger: string // the input or state that makes it fail
  impact: string // what breaks when it does
}
// Code a finding rests on, copied out of a file: the head file on the RIGHT side, the base file on the LEFT side (code
// the change removed). The one quote type: VS-44's verify trace and guards reuse it (VerifyCertificate).
export interface Quote {
  path: string
  line: number // the quote's first line
  side: Side
  code: string
}
export const VERIFIED_BY = ["model", "runtime"] as const
export type VerifiedBy = (typeof VERIFIED_BY)[number]
// VS-42's model label: whether the change introduced the defect, made an older one reachable or worse, or left it as it
// was at the base. It maps onto ReviewBench's scope axis (introduced to introduced-by-pr, exacerbated to
// exacerbated-by-pr, pre-existing to pre-existing; its `unrelated` has no model value). A label can only drop a finding
// (I-2): "pre-existing" drops it under S9, and "introduced" or "exacerbated" never saves one S9's suspect check drops.
export const FINDING_SCOPES = ["introduced", "exacerbated", "pre-existing"] as const
export type FindingScope = (typeof FINDING_SCOPES)[number]
// VS-43's structured rule citation (addendum A). `repository_instructions` and `review_rules` name the prompt's two
// trusted blocks; `paths` names a ReviewConfig.paths entry by its 0-based index as parsed; `scoped` names a VS-48
// nested instruction file, which nothing sends yet. `lines` is carried and never checked. Only schema.ts's
// decodeRuleCitation builds one, and nothing calls it before VS-43 wiring, so ModelFinding gains no field now and
// `rule` stays the quoted text.
export type RuleSource =
  | { kind: "repository_instructions" }
  | { kind: "review_rules" }
  | { kind: "paths"; index: number }
  | { kind: "scoped"; path: string }
export interface RuleCitation {
  source: RuleSource
  quote: string
  lines?: { start: number; end: number }
}
// VS-44's verify certificate (addendum A): the verifier's verdict on one finding, with the code that shows it. Produced
// only under `verifyEvidence: "certificate"` with `guardrail: "strict"`, by schema.ts decodeVerifyCertificates, and
// checked by guardrail.ts certified(); nothing produces or checks one before VS-44 wiring (with VS-27c).
export const CERTIFICATE_VERDICTS = ["confirmed", "rejected", "unsure"] as const
export type CertificateVerdict = (typeof CERTIFICATE_VERDICTS)[number]
// How the failing path is reached, as the verifier says. Nothing checks the label, so it can only veto (I-2): "assumed"
// never certifies a finding, and the other two only let one through.
export const CERTIFICATE_REACH = ["caller-shown", "entry-point", "assumed"] as const
export type CertificateReach = (typeof CERTIFICATE_REACH)[number]
export interface VerifyCertificate {
  id: string
  verdict: CertificateVerdict
  reason: string
  // 1 to 6 quotes from the trigger to the failure, kept whole or not at all. A quote with path "" is the finding's file.
  trace?: Quote[]
  // Set by the decoder when the model sent a trace it could not keep (a quote that did not decode, more than 6, or a
  // value that is not a list and not blank), so a format failure is counted apart from a missing trace. Read only when
  // `trace` is absent.
  traceUnreadable?: true
  guards: Quote[] // the checks on the path that could stop the failure; they never veto a certificate
  noGuards?: string // where the verifier looked for a guard, when it found none
  reach?: CertificateReach // absent when it could not be read, which certified() reads as "assumed"
}
// What certified() leaves to attach to a certified finding's StrictFinding [GP3]: its trace and the guards that
// matched, at the paths they were read from, and its reach. No StrictFinding carries it before VS-44 wiring.
export interface CertificateEvidence {
  trace: Quote[]
  guards: Quote[]
  reach: Exclude<CertificateReach, "assumed">
}
// "unchecked": no committable suggestion and no patch that applies, so the fix is shown as a plain diff block (S6).
export const STRICT_FIX_KINDS = ["suggestion", "patch", "unchecked"] as const
// Why strictSelect dropped a candidate, in the order its rules are checked (S1 to S5, S9, then S6 to S8). The
// contract's base list: a later package's drop (VS-42, VS-44) joins this list with its package, and the result schema
// only under that package's key. VS-27b added `severity-unreadable` (the round-two amendment, addendum §3 VS-27, [GP3])
// and checks S2's severity half before its class half: an unreadable severity, then a severity other than blocking,
// then no class of the five. The strict prompt asks for a failure block only on blocking findings, so a concern without
// one is `not-blocking`, not `out-of-scope`. A failure block whose class is valid but whose mechanism is not decodes as
// none (schema.ts), so it reads as `out-of-scope`. VS-42 added `pre-existing` (S9, the introduced-by-change check): it
// is checked after S5 and before S6, so a finding it drops never has its patch applied or parsed, is produced only
// under `guardrail: "strict"` with `scopeGate: "introduced"`, and joins the result schema's enum only under that key.
// VS-44's `verdict-unsure` and `certificate-mismatch` (S1's certificate check) join after `verdict-unreadable` with VS-44
// wiring, not before: no rule produces them yet (guardrail.ts CertificateDrop).
export const STRICT_DROPS = [
  "unverified",
  "verdict-unreadable",
  "severity-unreadable",
  "not-blocking",
  "out-of-scope",
  "anchor",
  "quote-mismatch",
  "no-impact",
  "pre-existing",
  "no-fix",
  "duplicate",
  "cap",
] as const
export type StrictDrop = (typeof STRICT_DROPS)[number]
export interface StrictFinding {
  id: string
  class: FailureClass
  mechanism: FailureMechanism
  path: string
  line: number
  endLine?: number
  side: Side
  title: string
  trigger: string
  impact: string
  quotes: Quote[]
  fix: { kind: (typeof STRICT_FIX_KINDS)[number]; text: string }
  verifiedBy: VerifiedBy
  verifier: string // the "provider/model" or the runtime check that confirmed it
}
export interface StrictResult {
  version: 1
  head: string
  complete: boolean // false when a stage did not finish, coverage is partial or a verdict could not be read
  // Reason codes, not text (D14): guardrail.ts's StrictIncomplete, which are verdict.ts's unfinished causes followed by
  // `verdict-unreadable` and `blob-unreadable`.
  incomplete?: string[]
  findings: StrictFinding[]
  dropped: { reason: StrictDrop; count: number }[] // only reasons with a count of 1 or more
  fixUnchecked: number // findings kept with their fix shown as an unchecked diff (S6)
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
  codiumReviews?: number
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
  // How many labs' models checked the reported findings (WP A35): 2 after a first pass checked by a model from another
  // lab, 3 when the panel's judge from a third lab finished too. Set by the review runner; absent otherwise.
  labs?: 2 | 3
  // Codium activity can accompany any own-provider cost kind.
  codium?: boolean
  // Set only by fresh per-message reducers that positively attribute all reported tokens to own usage.
  // Cached or serialized aggregate figures cannot grant this proof.
  tokensOwnOnly?: boolean
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
  // "privacy" and "budget-estimate" are VS-23's and VS-24's zero-attempt stops, which no runner makes before VS-23b
  // and VS-24 wiring.
  partial?: "budget" | "steps" | "timeout" | "model-error" | "privacy" | "budget-estimate"
  unreviewed: string[]
  specialists: {
    name: "review" | "security" | "verify" | "judge" | "lens" | "repro" // judge: codium's; lens, repro: VS-28, VS-30
    lens?: ReviewLens // the single class a "lens" pass looked for (VS-28)
    status: "ok" | "failed" | "timeout" | "stopped" | "skipped"
    steps: number
    detail?: string
  }[]
  sessions: string[]
  stats: { files: number; additions: number; deletions: number }
  notes: string[] // deterministic summary notes (generated header, moved comments, superseded)
  // What each pass spent, from its session's recorded usage. Absent when no pass reported usage.
  passes?: ReviewPass[]
  // The strict guardrail's result, set only under `guardrail: "strict"` (VS-27c).
  strict?: StrictResult
}

export interface ReviewPass {
  usageMissing?: boolean
  costKind?: CostKind
  name: "review" | "security" | "verify" | "judge" | "lens" | "repro" // as ReviewOutcome.specialists[].name
  lens?: ReviewLens // as ReviewOutcome.specialists[].lens
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

// VS-28's single-class lenses (contract §4 VS-28 items 2 and 3): on the high band of `depth: "auto"` with
// `lenses: "high"`, one pass per class on the review model. Here so plan.ts and prompt.ts share them without importing
// each other. ReviewOutcome.specialists[].lens names the class a lens pass looked for.
export const REVIEW_LENSES = Object.freeze(["concurrency", "resource", "access", "data-integrity"] as const)
export type ReviewLens = (typeof REVIEW_LENSES)[number]
// A lens pass's bounds (VS-28 item 3): at most 5 steps and 4 findings, and at most 3 lenses at once. Before VS-28
// wiring only the lens prompt reads one of them (`findings`); the wiring applies `steps` and `parallel` in Review.run.
export const LENS_LIMITS = Object.freeze({ steps: 5, findings: 4, parallel: 3 })

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
  // VS-27's opt-in (D3, Q3, Q15). Under "strict", the strict guardrail (VS-27b's strictSelect) will keep only verified,
  // blocking findings in the five failure classes, each anchored, quoted, with its impact and a fix, and report them as
  // a StrictResult. Absent means "off" (OPTIONAL_REVIEW_DEFAULTS), and DEFAULT_REVIEW_CONFIG leaves it out, so every
  // config and its digest stay as they were. Parsed, and read by no runner until VS-27c (UNAPPLIED_REVIEW_KEYS), so the
  // parser warns that "strict" is not applied.
  guardrail?: "off" | "strict"
  // VS-42's opt-in (Q18). Under "introduced", the strict guardrail drops a finding the model labels pre-existing, or
  // whose quoted code is all unchanged since the base (S9, guardrail.ts preExistingSuspect). It acts inside
  // strictSelect, so it is effective only with `guardrail: "strict"`; set without it, it is ignored with a parser note.
  // Absent means "off" (OPTIONAL_REVIEW_DEFAULTS), and DEFAULT_REVIEW_CONFIG leaves it out, so every config and its
  // digest stay as they were. No environment variable reads it. Parsed, and read by no runner until VS-42 wiring
  // (UNAPPLIED_REVIEW_KEYS), so the parser warns that "introduced" is not applied.
  scopeGate?: "off" | "introduced"
  // VS-44's opt-in (Q18). Under "certificate", the verifier answers with a certificate (schema.ts
  // verifyCertJsonSchema), and the strict guardrail counts a confirmed finding as verified only when certified() holds:
  // its trace matches the code, touches the change or the anchor, and its reach is not assumed. It acts inside
  // strictSelect, so it is effective only with `guardrail: "strict"`; set without it, it is ignored with a parser note.
  // Absent means "off" (OPTIONAL_REVIEW_DEFAULTS), and DEFAULT_REVIEW_CONFIG leaves it out, so every config and its
  // digest stay as they were. No environment variable reads it. Parsed, and read by no runner until VS-44 wiring
  // (UNAPPLIED_REVIEW_KEYS), so the parser warns that "certificate" is not applied.
  verifyEvidence?: "off" | "certificate"
  // VS-28's opt-in (D3, Q15), as amended by VS-39 (Q18). Under "auto", Review.run will compute the change's risk band
  // (risk.ts riskOf) and plan its passes by band (plan.ts planDepth): low runs the review, and security only on a
  // sensitive path; medium adds security; high adds security and, with `lenses: "high"`, four single-class lenses.
  // "fixed" runs today's passes. Absent means "fixed" (OPTIONAL_REVIEW_DEFAULTS), and DEFAULT_REVIEW_CONFIG leaves it
  // out, so every config and its digest stay as they were. Parsed, and read by no runner until VS-28 wiring
  // (UNAPPLIED_REVIEW_KEYS), so the parser warns that "auto" is not applied.
  depth?: "fixed" | "auto"
  // VS-28's lens opt-in. Under "high", the high band of an automatic depth adds the lenses (REVIEW_LENSES). It is
  // effective only with `depth: "auto"`; set without it, it is ignored with a parser note. Absent means "off"
  // (OPTIONAL_REVIEW_DEFAULTS), and DEFAULT_REVIEW_CONFIG leaves it out. Parsed, and read by no runner until VS-28
  // wiring (UNAPPLIED_REVIEW_KEYS), so the parser warns that "high" is not applied.
  lenses?: "off" | "high"
  // VS-23's opt-in (D3, Q1): "zdr" sends code only on zero data retention routes (privacy.ts). Raise-only: any source
  // may set it and none may lower it. Absent means "standard", and DEFAULT_REVIEW_CONFIG leaves it out, so every
  // config and its digest stay as they were. Only mergeReviewConfig reads it, and no runner calls that before VS-23b.
  privacy?: "standard" | "zdr"
  // The routes the owner attests are zero data retention (Q2): provider IDs, `openrouter` for an OpenRouter account,
  // and model server hosts. A text entry is the legacy form and keeps its meaning; an attestation object (VS-33) adds
  // what the owner attests beyond the ID. Read only from a trusted source (mergeReviewConfig); absent means none.
  zdrAttested?: ZdrAttestedEntry[]
  // VS-30's opt-in (D10), as proposed: contract §1.1 and §4 VS-30, with owner question Q8 open. Under "ask", a trusted
  // local review would ask, per operation and through `--checks`, before running the project's tests, coverage and
  // reproducers on the head and base commits in isolation (runtime.ts holds the evidence contract). Read only from a
  // trusted source (mergeReviewConfig), never from the working tree or the environment. Absent means "off"
  // (OPTIONAL_REVIEW_DEFAULTS), and DEFAULT_REVIEW_CONFIG leaves it out, so every config and its digest stay as they
  // were. Read by no runner until the VS-30 executor (UNAPPLIED_REVIEW_KEYS), so mergeReviewConfig warns that "ask" is
  // not applied.
  runtime?: "off" | "ask"
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
  // The review panel (WP A35): a first pass, a check and a judge, each from a different lab. The judge makes the final
  // call on each finding the check looked at. Off by default; it needs triageModel and model from two labs (on Vector
  // Codium, the plan's review pair) and a judge from a third.
  panel: boolean
  // The panel's judge, "provider/model". On Vector Codium the plan's panel judge is used when this is not set.
  judgeModel?: string
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
  panel: false,
  nits: false,
  paths: [],
}

// What an optional key reads as when a config leaves it out. DEFAULT_REVIEW_CONFIG leaves these out, so configs and
// their digests made before the key existed stay as they were.
export const OPTIONAL_REVIEW_DEFAULTS = {
  trivial: "review",
  maxInputTokens: 0,
  impact: "grep",
  guardrail: "off",
  scopeGate: "off",
  verifyEvidence: "off",
  depth: "fixed",
  lenses: "off",
  runtime: "off",
} as const satisfies Partial<ReviewConfig>

// The same, read by any ReviewConfig key, for lookups that do not know which keys have an entry.
export const OPTIONAL_REVIEW_DEFAULT_OF: Partial<Record<keyof ReviewConfig, unknown>> = OPTIONAL_REVIEW_DEFAULTS

// Keys config.ts parses that no runner applies yet, each optional with a default above. The parser warns when one would
// change a review, policyDigest reads them as absent whatever their value, so no evidence scope claims a policy its
// review did not run under, and the eval replay neither takes nor records them. VS-24, VS-25b, VS-27c, VS-42, VS-44 or
// VS-28 wiring, or the VS-30 executor, takes a key off this list when a runner applies it.
export const UNAPPLIED_REVIEW_KEYS = [
  "trivial",
  "maxInputTokens",
  "impact",
  "guardrail",
  "scopeGate",
  "verifyEvidence",
  "depth",
  "lenses",
  "runtime",
] as const satisfies readonly (keyof typeof OPTIONAL_REVIEW_DEFAULTS)[]

// The verify setting a review gets under verifyPolicy "shared" when neither review.json nor REVIEW_VERIFY sets one:
// the plan's proposed default. Today's default stays DEFAULT_REVIEW_CONFIG.verify while the policy is "legacy".
export const SHARED_VERIFY_DEFAULT: ReviewConfig["verify"] = "all"

// VS-47's observation contract only. No runner populates it and ReviewOutcome has no receipt field yet.
export type ReceiptUnavailable =
  | "not-recorded"
  | "unsupported"
  | "not-applicable"
  | "observer-failed"
  | "limit"
  | "upstream-not-reported"
export type ReceiptFact<T> =
  | { readonly state: "observed"; readonly value: T }
  | { readonly state: "unavailable"; readonly reason: ReceiptUnavailable }
export type ReceiptObservation<T, S extends string> =
  | { readonly state: "observed"; readonly runID: string; readonly head: string; readonly source: S; readonly value: T }
  | { readonly state: "unavailable"; readonly reason: ReceiptUnavailable }
export interface ReceiptRoute {
  readonly requestID: string
  readonly requestKind: "openai-chat" | "openai-responses" | "anthropic-messages" | "google-generate" | "other"
  readonly provider: string
  readonly operator:
    | "openai"
    | "anthropic"
    | "google"
    | "openrouter"
    | "loopback"
    | "vector-codium"
    | "vector-free"
    | "upstream-not-reported"
  readonly decision:
    | {
        readonly allowed: true
        readonly kind: "standard" | "loopback" | "openrouter-attested" | "attested-provider" | "attested-host"
      }
    | { readonly allowed: false; readonly refusal: string }
  readonly sent: boolean
  readonly transport: "sync" | "not-sent"
  readonly cacheTtls: ReceiptFact<readonly ("5m" | "1h" | "24h")[]>
  readonly store: ReceiptFact<boolean>
  readonly zdr: ReceiptFact<boolean>
  readonly account: "byok" | "loopback" | "vector-codium" | "vector-free" | "unreported"
  readonly vendorStore: "none" | "vector-codium" | "vector-free" | "upstream-not-reported"
  // A wire flag does not establish the upstream provider's retention behavior.
  readonly upstreamRetention: "not-reported"
}
export interface ReceiptContext {
  readonly source:
    | "diff"
    | "head"
    | "base-instructions"
    | "scoped-instructions"
    | "impact"
    | "history"
    | "cards"
    | "requirements"
  readonly state: "used" | "fallback" | "missing" | "off" | "incomplete"
  readonly paths: readonly string[]
}
export type ReceiptCheck = {
  readonly status: "completed"
  readonly files: readonly string[]
} & (
  | { readonly kind: "pass"; readonly name: "review" | "security" | "verify" | "judge" | "repro" }
  | { readonly kind: "lens"; readonly name: ReviewLens }
  | { readonly kind: "strict-rule"; readonly name: "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8" | "S9" }
)
export interface ReviewReceipt {
  readonly version: 1
  readonly runID: string
  readonly head: string
  readonly references: readonly ["skipped", "unreviewed", "specialists", "passes"]
  readonly routes: ReceiptObservation<readonly ReceiptRoute[], "transport-observer">
  readonly context: ReceiptObservation<readonly ReceiptContext[], "context-collector">
  readonly checked: ReceiptObservation<readonly ReceiptCheck[], "run-observer">
  readonly holdback: ReceiptObservation<
    {
      readonly redactions: readonly { readonly path: string; readonly diff: number; readonly head: number }[]
      readonly ignoredCommitted: readonly string[]
    },
    "holdback-collector"
  >
  readonly suppression: ReceiptObservation<
    {
      readonly baseProtection: "confirmed" | "unavailable"
      readonly root: "applied" | "not-applied"
      readonly nested: "not-applied"
    },
    "trusted-base-policy"
  >
  readonly verdict: "not-reviewed" | "policy-skip" | "incomplete" | "blocking" | "findings" | "clean-complete"
}
