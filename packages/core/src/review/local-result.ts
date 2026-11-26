// Browser-safe decoding of the engine's retained result. This validates the
// shared runner's selection; it never selects findings or grants execution.
import { Option, Schema } from "effect"
import { LABS } from "../model-lab"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { NonNegativeInt, optional, PositiveInt } from "@vectordevai/schema/schema"
import { hash } from "../util/encode"
import { OFFLINE_DIAGNOSTIC_RULES, type DiagnosticRule } from "./diagnostic"
import { BUDGET_REQUEST_CHANGED, strictFindingBody } from "./format"
import { withAlso } from "./select"
import { MAX_FINDING_QUOTES, MAX_TRACE_QUOTES } from "./schema"
import {
  CATEGORIES,
  FAILURE_CLASSES,
  FAILURE_MECHANISMS,
  FINDING_SCOPES,
  HOLDBACK_REASONS,
  REVIEW_LENSES,
  SEVERITIES,
  SKIPPED_FILE_REASONS,
  STRICT_DROPS,
  STRICT_FIX_KINDS,
  VERIFIED_BY,
  type Finding,
  type ReviewConfig,
  type ReviewOutcome,
  type StrictFinding,
} from "./types"
import { REVIEW_VERDICTS, reviewVerdict, unfinishedCauses, type VerdictResult } from "./verdict"

const text = Schema.String.check(Schema.isMaxLength(ReviewRun.RESULT_BYTES))
const amount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const commit = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/))
const side = Schema.Literals(["LEFT", "RIGHT"])
const risk = Schema.Literals(["low", "medium", "high"])
const kind = Schema.Literals(["free", "priced", "plan", "local", "unknown", "codium"])
const pass = Schema.Literals(["review", "security", "verify", "judge", "lens", "repro"])
const many = <S extends Schema.Top>(schema: S) =>
  Schema.mutable(Schema.Array(schema)).check(Schema.isMaxLength(100_000))
const strictDrops = many(Schema.Struct({ reason: Schema.Literals(STRICT_DROPS), count: NonNegativeInt }))
const quote = Schema.Struct({ path: text, line: PositiveInt, side, code: text })
const rulesSource = Schema.Literals(["base branch", "working tree"])
const ruleCitation = Schema.Struct({
  source: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("repository_instructions") }),
    Schema.Struct({ kind: Schema.Literal("review_rules") }),
    Schema.Struct({ kind: Schema.Literal("paths"), index: NonNegativeInt }),
  ]),
  quote: text,
  lines: optional(Schema.Struct({ start: PositiveInt, end: PositiveInt })),
})
const findingFields = {
  path: text,
  line: PositiveInt,
  endLine: optional(PositiveInt),
  side: optional(side),
  severity: Schema.Literals(SEVERITIES),
  category: Schema.Literals(CATEGORIES),
  title: text,
  body: text,
  suggestion: optional(text),
  confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  evidence: optional(many(text)),
  rule: optional(text),
  citation: optional(ruleCitation),
  rulesSource: optional(rulesSource),
  duplicateOf: optional(text),
  failure: optional(
    Schema.Struct({
      class: Schema.Literals(FAILURE_CLASSES),
      mechanism: Schema.Literals(FAILURE_MECHANISMS),
      trigger: text,
      impact: text,
    }),
  ),
  quotes: optional(many(quote)),
  patch: optional(text),
  severityUnreadable: optional(Schema.Boolean),
  scope: optional(Schema.Literals(FINDING_SCOPES)),
}
// A normalized Finding's offline-diagnostic provenance (Finding.diagnostics, set by withDiagnosticEvidence): data only,
// never a confirmation. Exactly the versioned rules, so an unknown rule or an extra key still refuses the result.
const diagnostics = optional(
  many(
    Schema.Struct({
      source: Schema.Literal("offline-v1"),
      rule: Schema.Literals(Object.keys(OFFLINE_DIAGNOSTIC_RULES) as [DiagnosticRule, ...DiagnosticRule[]]),
    }),
  ),
)
const finding = {
  ...findingFields,
  id: text,
  side,
  source: Schema.Literals(["review", "security"]),
  diagnostics,
  verified: optional(Schema.Boolean),
  verifiedBy: optional(Schema.Literals(VERIFIED_BY)),
  also: optional(many(text)),
}
const prior = Schema.Struct({
  id: text,
  where: Schema.Literals(["inline", "summary"]),
  path: text,
  line: Schema.Union([PositiveInt, Schema.Null]),
  side,
  severity: Schema.Literals(SEVERITIES),
  category: Schema.Literals(CATEGORIES),
  title: text,
  sha: text,
  status: Schema.Literals(["open", "fixed", "dismissed", "outdated"]),
  commentId: optional(NonNegativeInt),
  threadId: optional(text),
  fixedIn: optional(text),
  dismissedBy: optional(text),
  also: optional(many(PositiveInt)),
})
const Outcome = Schema.Struct({
  claimedAuthor: optional(
    many(Schema.Struct({ source: Schema.Literals(["branch", "pr-body", "trailer"]), lab: Schema.Literals(LABS) })),
  ),
  trivial: optional(Schema.Literal(true)),
  report: Schema.Struct({
    summary: text,
    risk,
    files: many(Schema.Struct({ path: text, note: text })),
    // A runner may retain a normalized Finding in its ModelFinding list.
    // Those optional annotations remain data and never replace selection.
    findings: many(
      Schema.Struct({
        ...findingFields,
        id: optional(text),
        source: optional(Schema.Literals(["review", "security"])),
        diagnostics,
        verified: optional(Schema.Boolean),
        verifiedBy: optional(Schema.Literals(VERIFIED_BY)),
        also: optional(many(text)),
      }),
    ),
    priorStatus: optional(many(Schema.Struct({ id: text, status: Schema.Literals(["fixed", "open"]), reason: text }))),
  }),
  selection: Schema.Struct({
    diffIncomplete: optional(Schema.Literal(true)),
    strict: optional(Schema.Struct({ complete: Schema.Boolean, findingCount: NonNegativeInt, dropped: strictDrops })),
    inline: many(
      Schema.Struct({
        ...finding,
        anchor: Schema.Struct({
          path: text,
          side,
          line: PositiveInt,
          startLine: optional(PositiveInt),
          hunk: NonNegativeInt,
        }),
        suggestionAllowed: Schema.Boolean,
      }),
    ),
    outsideDiff: many(
      Schema.Struct({ ...finding, reason: Schema.Literals(["file-not-in-diff", "line-outside-diff", "no-patch"]) }),
    ),
    elsewhere: many(Schema.Struct(finding)),
    nits: many(Schema.Struct(finding)),
    overflow: many(Schema.Struct(finding)),
    stillOpen: many(prior),
    fixed: many(prior),
    dismissed: many(prior),
    reappeared: many(text),
    raised: many(Schema.Struct({ id: text, was: Schema.Literals(SEVERITIES) })),
    dropped: many(
      Schema.Struct({
        reason: Schema.Literals([
          "empty",
          "low-confidence",
          "ignored-path",
          "unknown-path",
          "duplicate",
          "dismissed",
          "rejected-by-verify",
          "rule-unverified",
          "unconfirmed",
          "nit",
        ]),
        count: NonNegativeInt,
      }),
    ),
    risk,
  }),
  skipped: many(
    Schema.Struct({
      path: text,
      reason: Schema.Literals(SKIPPED_FILE_REASONS),
      additions: optional(NonNegativeInt),
    }),
  ),
  cost: optional(
    Schema.Struct({
      costUsd: amount,
      labs: optional(Schema.Literals([2, 3])),
      codium: optional(Schema.Boolean),
      tokensOwnOnly: optional(Schema.Boolean),
      usageMissing: optional(Schema.Boolean),
      partial: optional(Schema.Boolean),
      input: NonNegativeInt,
      output: NonNegativeInt,
      reasoning: NonNegativeInt,
      cacheRead: NonNegativeInt,
      cacheWrite: NonNegativeInt,
      kind,
      model: text,
    }),
  ),
  durationMs: amount,
  base: commit,
  head: commit,
  since: optional(commit),
  mode: Schema.Literals(["full", "incremental", "carry"]),
  forcePushed: optional(Schema.Boolean),
  partial: optional(Schema.Literals(["budget", "steps", "timeout", "model-error", "privacy", "budget-estimate"])),
  unreviewed: many(text),
  specialists: many(
    Schema.Struct({
      name: pass,
      lens: optional(Schema.Literals(REVIEW_LENSES)),
      status: Schema.Literals(["ok", "failed", "timeout", "stopped", "skipped"]),
      steps: NonNegativeInt,
      detail: optional(text),
    }),
  ),
  sessions: many(text),
  stats: Schema.Struct({ files: NonNegativeInt, additions: NonNegativeInt, deletions: NonNegativeInt }),
  notes: many(text),
  passes: optional(
    many(
      Schema.Struct({
        usageMissing: optional(Schema.Boolean),
        costKind: optional(kind),
        name: pass,
        lens: optional(Schema.Literals(REVIEW_LENSES)),
        model: text,
        costUsd: optional(amount),
        input: NonNegativeInt,
        output: NonNegativeInt,
        cacheRead: NonNegativeInt,
      }),
    ),
  ),
  strict: optional(
    Schema.Struct({
      version: Schema.Literal(1),
      head: commit,
      complete: Schema.Boolean,
      incomplete: optional(many(text)),
      findings: many(
        Schema.Struct({
          id: text,
          class: Schema.Literals(FAILURE_CLASSES),
          mechanism: Schema.Literals(FAILURE_MECHANISMS),
          path: text,
          line: PositiveInt,
          endLine: optional(PositiveInt),
          side,
          title: text,
          trigger: text,
          impact: text,
          quotes: many(quote),
          fix: Schema.Struct({ kind: Schema.Literals(STRICT_FIX_KINDS), text }),
          verifiedBy: Schema.Literals(VERIFIED_BY),
          verifier: text,
          linkedRule: optional(Schema.Struct({ source: text, quote: text, rulesSource })),
          certificate: optional(
            Schema.Struct({
              trace: Schema.mutable(Schema.Array(quote)).check(
                Schema.isMinLength(1),
                Schema.isMaxLength(MAX_TRACE_QUOTES),
              ),
              guards: Schema.mutable(Schema.Array(quote)).check(Schema.isMaxLength(MAX_FINDING_QUOTES)),
              reach: Schema.Literals(["caller-shown", "entry-point"]),
            }),
          ),
        }),
      ),
      dropped: strictDrops,
      fixUnchecked: NonNegativeInt,
    }),
  ),
  // VS-34 (SF-13b): the held-back files, so the recomputed verdict keeps a held deletion's note and completeness.
  held: optional(
    many(
      Schema.Struct({
        path: text,
        oldPath: optional(text),
        status: Schema.Literals(["added", "modified", "deleted", "renamed"]),
        reason: Schema.Literals(HOLDBACK_REASONS),
      }),
    ),
  ),
})

const Result = Schema.Struct({
  exitCode: Schema.Literals([0, 1, 2]),
  error: optional(text),
  target: optional(
    Schema.Struct({
      kind: Schema.Literals(["branch", "uncommitted", "staged", "pr"]),
      label: text,
      baseRef: text,
      mergeBase: commit,
      head: commit,
      branch: optional(text),
      pr: optional(PositiveInt),
    }),
  ),
  outcome: optional(Outcome),
  verdict: Schema.Struct({ verdict: Schema.Literals(REVIEW_VERDICTS), causes: many(text), notes: many(text) }),
})

export interface LocalResult {
  exitCode: 0 | 1 | 2
  error?: string
  target?: {
    kind: "branch" | "uncommitted" | "staged" | "pr"
    label: string
    baseRef: string
    mergeBase: string
    head: string
    branch?: string
    pr?: number
  }
  outcome?: ReviewOutcome
  verdict: VerdictResult
}

function sameVerdict(
  stored: { verdict: string; causes: readonly string[]; notes: readonly string[] },
  canonical: VerdictResult,
) {
  return (
    stored.verdict === canonical.verdict &&
    JSON.stringify(stored.causes) === JSON.stringify(canonical.causes) &&
    JSON.stringify(stored.notes) === JSON.stringify(canonical.notes)
  )
}

const strictLocation = (finding: Pick<Finding, "path" | "line" | "side" | "title">) =>
  JSON.stringify([finding.path, finding.line, finding.side, finding.title])

// The selected row has no verifier model name. Compare the evidence both records carry, including the
// unchecked fix which postableStrict puts only in the body. Selection can append its own "also at" sentence.
function sameStrictEvidence(finding: Finding, kept: StrictFinding) {
  const citation = finding.citation
  const linked = kept.linkedRule
  if (linked || citation || finding.rulesSource || finding.rule) {
    if (!linked || !citation) return false
    const source = citation.source.kind === "paths" ? `paths[${citation.source.index}]` : citation.source.kind
    if (
      source === "scoped" ||
      source !== linked.source ||
      citation.quote !== linked.quote ||
      finding.rule !== linked.quote ||
      finding.rulesSource !== linked.rulesSource
    )
      return false
  }
  const body = strictFindingBody(kept)
  return (
    strictLocation(finding) === strictLocation(kept) &&
    finding.endLine === kept.endLine &&
    finding.severity === "blocking" &&
    finding.verified === true &&
    finding.verifiedBy === kept.verifiedBy &&
    finding.failure?.class === kept.class &&
    finding.failure.mechanism === kept.mechanism &&
    finding.failure.trigger === kept.trigger &&
    finding.failure.impact === kept.impact &&
    JSON.stringify(finding.quotes) === JSON.stringify(kept.quotes) &&
    finding.suggestion === (kept.fix.kind === "suggestion" ? kept.fix.text : undefined) &&
    finding.patch === (kept.fix.kind === "patch" ? kept.fix.text : undefined) &&
    finding.body === (finding.also?.length ? withAlso(body, finding.also) : body)
  )
}

/** A branch cache may serve a completed strict result only for the head and coverage that produced it. */
export function completeStrictReview(input: unknown, head: string, evidence?: ReviewConfig["verifyEvidence"]): boolean {
  const decoded = Schema.decodeUnknownOption(Outcome, { onExcessProperty: "error" })(input)
  if (Option.isNone(decoded)) return false
  const outcome = decoded.value
  const strict = outcome.strict
  const summary = outcome.selection.strict
  if (!strict || (evidence === "certificate" && strict.findings.some((finding) => !finding.certificate))) return false
  const selected = [
    ...outcome.selection.inline,
    ...outcome.selection.outsideDiff,
    ...outcome.selection.elsewhere,
    ...outcome.selection.overflow,
    ...outcome.selection.nits,
  ]
  const verified = new Map(strict.findings.map((finding) => [finding.id, finding]))
  const locations = new Map(strict.findings.map((finding) => [strictLocation(finding), finding]))
  const places = new Set(strict.findings.map((finding) => `${finding.path}:${finding.line}`))
  // An inline finding that reappeared or rose to blocking takes its prior comment's ID in selectFindings.
  // Its StrictFinding retains the verifier's original ID. No other selected row can use this substitution.
  const continued = new Set([...outcome.selection.reappeared, ...outcome.selection.raised.map((row) => row.id)])
  const used = new Set<string>()
  const matches = selected.every((finding, index) => {
    const inline = outcome.selection.inline[index]
    const kept = inline && continued.has(finding.id) ? locations.get(strictLocation(finding)) : verified.get(finding.id)
    if (!kept || used.has(kept.id) || !sameStrictEvidence(finding, kept)) return false
    if (finding.also?.some((place) => !places.has(place) || place.slice(0, place.lastIndexOf(":")) !== finding.path))
      return false
    if (
      inline &&
      (inline.anchor.path !== kept.path ||
        inline.anchor.side !== kept.side ||
        inline.anchor.line < kept.line ||
        inline.anchor.line > (kept.endLine ?? kept.line) ||
        (inline.anchor.startLine !== undefined && inline.anchor.startLine !== kept.line) ||
        (inline.suggestionAllowed && kept.fix.kind !== "suggestion"))
    )
      return false
    used.add(kept.id)
    return true
  })
  return (
    outcome.head === head &&
    strict.head === head &&
    strict.complete &&
    !strict.incomplete?.length &&
    summary?.complete === true &&
    summary.findingCount === strict.findings.length &&
    verified.size === strict.findings.length &&
    matches &&
    JSON.stringify(summary.dropped) === JSON.stringify(strict.dropped) &&
    strict.fixUnchecked === strict.findings.filter((finding) => finding.fix.kind === "unchecked").length &&
    !outcome.selection.diffIncomplete &&
    !outcome.trivial &&
    !unfinishedCauses(outcome).length
  )
}

/** Unknown fields/statuses are not silently discarded into a clean result. */
export function decodeLocalResult(input: unknown, expected: ReviewRun.Start["target"]): LocalResult | undefined {
  const decoded = Schema.decodeUnknownOption(Result, { onExcessProperty: "error" })(input)
  if (Option.isNone(decoded)) return undefined
  const result = decoded.value
  if (
    result.target &&
    (result.target.head !== expected.head ||
      result.target.kind !== (expected.kind === "working-tree" ? "uncommitted" : "staged"))
  )
    return undefined
  if (
    result.outcome &&
    (!result.target ||
      result.outcome.head !== expected.head ||
      (result.outcome.strict && result.outcome.strict.head !== expected.head))
  )
    return undefined
  const outcome = result.outcome
  const summary = outcome?.selection.strict
  if (
    summary &&
    (!outcome?.strict ||
      summary.complete !== outcome.strict.complete ||
      summary.findingCount !== outcome.strict.findings.length ||
      JSON.stringify(summary.dropped) !== JSON.stringify(outcome.strict.dropped))
  )
    return undefined
  const budgetStop = outcome?.partial === "budget-estimate"
  // A materialized request can outgrow its plan after an empty helper session is created.
  // Preserve its zero-step refusal while rejecting a session that actually performed model work.
  const stoppedAtSend = budgetStop && outcome.notes[0] === BUDGET_REQUEST_CHANGED
  if (
    stoppedAtSend &&
    (!outcome.specialists.length ||
      outcome.sessions.length !== outcome.specialists.length ||
      new Set(outcome.sessions).size !== outcome.sessions.length ||
      outcome.specialists.some(
        (entry) =>
          (entry.name !== "review" && entry.name !== "security" && !(entry.name === "lens" && entry.lens)) ||
          entry.status !== "skipped" ||
          entry.steps !== 0 ||
          entry.detail !== "first-request-changed",
      ))
  )
    return undefined
  if (
    outcome &&
    (outcome.trivial || budgetStop) &&
    (outcome.cost ||
      (outcome.strict &&
        (outcome.strict.complete ||
          JSON.stringify(outcome.strict.incomplete) !==
            JSON.stringify(unfinishedCauses({ ...outcome, strict: undefined })) ||
          outcome.strict.findings.length ||
          outcome.strict.dropped.length ||
          outcome.strict.fixUnchecked)) ||
      (!stoppedAtSend && (outcome.sessions.length || outcome.specialists.length)) ||
      outcome.passes?.length ||
      outcome.report.findings.length ||
      outcome.report.files.length ||
      outcome.selection.inline.length ||
      outcome.selection.overflow.length ||
      outcome.selection.outsideDiff.length ||
      outcome.selection.elsewhere.length ||
      outcome.selection.nits.length)
  )
    return undefined
  if (
    outcome?.trivial &&
    (outcome.partial || outcome.held?.length || outcome.unreviewed.length || outcome.skipped.length)
  )
    return undefined
  if (budgetStop) {
    // The local service retains this refusal with its target and error. All the changed files remain due,
    // including any which were already classified as skipped before the budget check.
    const due = new Set(outcome.unreviewed)
    if (
      result.exitCode !== 2 ||
      !result.error?.trim() ||
      due.size !== outcome.unreviewed.length ||
      due.size < outcome.stats.files ||
      outcome.skipped.some((file) => !due.has(file.path)) ||
      outcome.held?.some((file) => !due.has(file.path)) ||
      outcome.report.priorStatus?.length ||
      outcome.selection.raised.length ||
      outcome.selection.reappeared.length
    )
      return undefined
  } else if (outcome && result.exitCode === 2) {
    // These are retained service failures, not successful reviews with an error attached.
    // Match the service's stop classes without using its display text as authority or losing actual spend.
    const noCurrentEvidence =
      !outcome.report.findings.length &&
      !outcome.report.files.length &&
      !outcome.report.priorStatus?.length &&
      !outcome.selection.inline.length &&
      !outcome.selection.overflow.length &&
      !outcome.selection.outsideDiff.length &&
      !outcome.selection.elsewhere.length &&
      !outcome.selection.nits.length &&
      !outcome.selection.raised.length &&
      !outcome.selection.reappeared.length &&
      !outcome.selection.dropped.length &&
      !outcome.strict?.findings.length &&
      !outcome.strict?.dropped.length &&
      !outcome.strict?.fixUnchecked
    const noAttempt =
      noCurrentEvidence &&
      !outcome.specialists.length &&
      !outcome.sessions.length &&
      !outcome.passes?.length &&
      (!outcome.cost ||
        [
          outcome.cost.costUsd,
          outcome.cost.input,
          outcome.cost.output,
          outcome.cost.reasoning,
          outcome.cost.cacheRead,
          outcome.cost.cacheWrite,
        ].every((value) => value === 0))
    const heldPaths = new Set(outcome.held?.map((file) => file.path))
    const held =
      noAttempt &&
      !!outcome.held?.length &&
      heldPaths.size === outcome.held.length &&
      outcome.held.every((file) =>
        outcome.skipped.some((skip) => skip.reason === "held-back" && skip.path === file.path),
      ) &&
      outcome.skipped.filter((file) => file.reason === "held-back").every((file) => heldPaths.has(file.path))
    const batch = noAttempt && outcome.selection.diffIncomplete === true && outcome.unreviewed.length > 0
    const privacy = outcome.partial === "privacy" && noCurrentEvidence
    // An already-complete batch cursor can select no files and reach the service's empty-reviewer failure.
    const noReviewer =
      noAttempt &&
      outcome.partial === undefined &&
      !outcome.held?.length &&
      !outcome.unreviewed.length &&
      !outcome.selection.diffIncomplete &&
      outcome.skipped.every(
        (file) =>
          file.reason === "ignored" ||
          file.reason === "lockfile" ||
          file.reason === "generated" ||
          file.reason === "vendored" ||
          file.reason === "build-output" ||
          file.reason === "binary" ||
          file.reason === "deleted",
      )
    const reviewers = outcome.specialists.filter((entry) => entry.name !== "verify" && entry.name !== "judge")
    const failed = reviewers.length > 0 && reviewers.every((entry) => entry.status === "failed")
    if (
      !result.error?.trim() ||
      outcome.trivial ||
      outcome.base !== result.target?.mergeBase ||
      outcome.strict?.complete ||
      !(privacy || held || batch || failed || noReviewer)
    )
      return undefined
  } else {
    if (result.error !== undefined && (result.outcome || result.exitCode !== 2)) return undefined
    if (result.outcome && result.exitCode === 2) return undefined
  }
  const verdict = result.outcome
    ? reviewVerdict({ kind: "outcome", outcome: result.outcome })
    : result.error !== undefined
      ? // The service can refuse configuration or stop before model admission.
        // Recognize only the core's exact non-clean failure results; text never
        // upgrades a failure or manufactures completed coverage.
        (["config", "start", "review"] as const)
          .map((stage) => reviewVerdict({ kind: "failure", stage }))
          .find((canonical) => sameVerdict(result.verdict, canonical))
      : reviewVerdict({ kind: "failure", stage: "start" })
  if (!verdict || !sameVerdict(result.verdict, verdict)) return undefined
  if (result.exitCode === 1 && verdict.verdict === "clean-complete") return undefined
  return {
    ...result,
    // Retained aggregates cannot reissue the fresh per-message attribution
    // proof. Exact raw bytes remain in the artifact; presentation keeps all
    // amounts while withholding that proof after deserialization.
    ...(result.outcome?.cost?.tokensOwnOnly === true
      ? { outcome: { ...result.outcome, cost: { ...result.outcome.cost, tokensOwnOnly: false } } }
      : {}),
    verdict,
  }
}

export interface DecodedRun {
  run: ReviewRun.Info
  result?: LocalResult
  /** Presentation verdict also accounts for the engine-owned lifecycle. */
  verdict: VerdictResult
}

export interface ExpectedRun {
  parentID: string
  request: ReviewRun.Start
  runID?: string
}

export async function decodeLocalRun(input: unknown, expected: ExpectedRun): Promise<DecodedRun | undefined> {
  const decoded = Schema.decodeUnknownOption(ReviewRun.Info, { onExcessProperty: "error" })(input)
  if (Option.isNone(decoded)) return undefined
  const run = decoded.value
  if (
    run.parentID !== expected.parentID ||
    (expected.runID !== undefined && run.runID !== expected.runID) ||
    run.request.requestID !== expected.request.requestID ||
    run.request.target.kind !== expected.request.target.kind ||
    run.request.target.head !== expected.request.target.head ||
    run.request.maxCost !== expected.request.maxCost
  )
    return undefined
  if (!run.artifact)
    return { run, verdict: reviewVerdict({ kind: "failure", stage: run.status === "failed" ? "review" : "start" }) }
  if (new TextEncoder().encode(run.artifact.json).byteLength !== run.artifact.bytes) return undefined
  // WebCrypto keeps larger result hashing off the browser's synchronous path.
  // An unavailable verifier refuses the result rather than trusting its label.
  const digest = await hash(run.artifact.json).catch(() => undefined)
  if (digest !== run.artifact.sha256) return undefined
  const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(run.artifact.json)
  if (Option.isNone(json)) return undefined
  const result = decodeLocalResult(json.value, run.request.target)
  if (!result) return undefined
  // A retained service stop (exit 2 with its error) already carries the canonical non-clean verdict decodeLocalResult
  // checked against its outcome, and the engine marks every such run failed. Re-deriving it here would add a
  // model-error cause to a held-back or empty-reviewer stop in which no model ran.
  const retainedStop =
    run.status === "failed" &&
    result.exitCode === 2 &&
    result.error !== undefined &&
    result.verdict.verdict !== "clean-complete"
  const verdict =
    run.status === "completed" || retainedStop
      ? result.verdict
      : result.outcome
        ? reviewVerdict({
            kind: "outcome",
            outcome: {
              ...result.outcome,
              partial: result.outcome.partial ?? (run.status === "failed" ? "model-error" : "timeout"),
            },
          })
        : result.verdict
  return { run, result, verdict }
}
