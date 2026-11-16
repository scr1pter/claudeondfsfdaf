// Browser-safe decoding of the engine's retained result. This validates the
// shared runner's selection; it never selects findings or grants execution.
import { Option, Schema } from "effect"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { NonNegativeInt, optional, PositiveInt } from "@vectordevai/schema/schema"
import { hash } from "../util/encode"
import {
  CATEGORIES,
  FAILURE_CLASSES,
  FAILURE_MECHANISMS,
  FINDING_SCOPES,
  REVIEW_LENSES,
  SEVERITIES,
  STRICT_DROPS,
  STRICT_FIX_KINDS,
  VERIFIED_BY,
  type ReviewOutcome,
} from "./types"
import { REVIEW_VERDICTS, reviewVerdict, type VerdictResult } from "./verdict"

const text = Schema.String.check(Schema.isMaxLength(ReviewRun.RESULT_BYTES))
const amount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const commit = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/))
const side = Schema.Literals(["LEFT", "RIGHT"])
const risk = Schema.Literals(["low", "medium", "high"])
const kind = Schema.Literals(["free", "priced", "plan", "local", "unknown", "codium"])
const pass = Schema.Literals(["review", "security", "verify", "judge", "lens", "repro"])
const many = <S extends Schema.Top>(schema: S) =>
  Schema.mutable(Schema.Array(schema).check(Schema.isMaxLength(100_000)))
const quote = Schema.Struct({ path: text, line: PositiveInt, side, code: text })
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
const finding = {
  ...findingFields,
  id: text,
  side,
  source: Schema.Literals(["review", "security"]),
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
        verified: optional(Schema.Boolean),
        verifiedBy: optional(Schema.Literals(VERIFIED_BY)),
        also: optional(many(text)),
      }),
    ),
    priorStatus: optional(many(Schema.Struct({ id: text, status: Schema.Literals(["fixed", "open"]), reason: text }))),
  }),
  selection: Schema.Struct({
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
      reason: Schema.Literals([
        "ignored",
        "lockfile",
        "generated",
        "vendored",
        "build-output",
        "binary",
        "deleted",
        "size-limit",
      ]),
      additions: optional(NonNegativeInt),
    }),
  ),
  cost: optional(
    Schema.Struct({
      costUsd: amount,
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
        }),
      ),
      dropped: many(Schema.Struct({ reason: Schema.Literals(STRICT_DROPS), count: NonNegativeInt })),
      fixUnchecked: NonNegativeInt,
    }),
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
  if (result.error !== undefined && (result.outcome || result.exitCode !== 2)) return undefined
  if (result.outcome && result.exitCode === 2) return undefined
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
  const verdict =
    run.status === "completed"
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
