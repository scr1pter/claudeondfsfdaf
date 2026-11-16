// What a review run established about the head it ran on (VectorScope addendum A, VS-32, Now window): a value that
// tells "not finished" apart from "nothing found". The first rule that applies wins, and a review that did not finish
// never reads as a pass. A new SkipReason or SkippedFile reason fails typecheck here until it is classified, and at
// runtime (an outcome decoded from JSON, a replay artifact, an adapter) a value this module does not name fails
// closed: a partial value, specialist status, skipped-file reason, held status or strict flag reads as incomplete, a
// severity as blocking, a skip reason or failure stage as not reviewed, and a stored verdict as a missing one. An input
// whose shape is wrong (a missing list, an unknown kind) throws, and the caller reads that as a failure.
//
// Pure and browser-safe (its imports are types only), and no runner calls it yet; guardrail.ts (VS-27b) reads its
// unfinished causes for strict completeness. After the vector-at-mention merge, and
// only under failOn "blocking-or-incomplete", the GitHub job stores the verdict in ReviewState, writes it to
// $GITHUB_OUTPUT and exits 1 on not-reviewed, incomplete and blocking. It closes unfinished reviews only: it does not
// hold against a same-repository author who edits the workflow, and a job the workflow's `if:` skips never reaches it.

import type { HeldFile } from "./holdback"
import type { SkipReason } from "./skip"
import type { ReviewOutcome, Severity, SkippedFile } from "./types"

// In the order reviewVerdict tests them. They move to types.ts with ReviewState.verdict when the job stores one.
export const REVIEW_VERDICTS = [
  "not-reviewed",
  "policy-skip",
  "incomplete",
  "blocking",
  "findings",
  "clean-complete",
] as const
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]

export interface PostingPlan {
  createReview: boolean
  marker?: "<!-- vectorscope-verdict: incomplete -->"
}

/** Pure posting policy; only trusted verdicts can authorize a review object. */
export function postingPlan(
  verdict: ReviewVerdict,
  inlineCount: number,
  options: { failOn: "never" | "blocking" | "blocking-or-incomplete" },
): PostingPlan {
  if (
    !REVIEW_VERDICTS.includes(verdict) ||
    !["never", "blocking", "blocking-or-incomplete"].includes(options.failOn) ||
    !Number.isSafeInteger(inlineCount) ||
    inlineCount <= 0 ||
    verdict === "not-reviewed" ||
    verdict === "policy-skip"
  )
    return { createReview: false }
  return {
    createReview: true,
    ...(verdict === "incomplete" && options.failOn === "blocking-or-incomplete"
      ? { marker: "<!-- vectorscope-verdict: incomplete -->" as const }
      : {}),
  }
}

// The parts of a ReviewOutcome the verdict reads; a ReviewOutcome is assignable as it is. The rest is ready for values
// other packages add, each absent until a runner produces it:
// - `partial` also takes VS-23's and VS-24's zero-attempt stops, which ReviewOutcome has had since VS-27a;
// - `specialists[].name` also takes the contract's `lens` and `repro` and codium's `judge`, likewise;
// - `trivial` marks VS-24's zero-attempt trivial outcome from Review.run;
// - `strict` is VS-27a's StrictResult, which no runner sets before VS-27c;
// - `held` is VS-34's held-back files.
// The unions repeated below are redundant since VS-27a and harmless; VS-32 wiring may simplify them.
export interface VerdictOutcome {
  partial?: NonNullable<ReviewOutcome["partial"]> | "privacy" | "budget-estimate"
  unreviewed: readonly string[]
  skipped: readonly Pick<SkippedFile, "reason">[]
  specialists: readonly {
    name: ReviewOutcome["specialists"][number]["name"] | "lens" | "repro" | "judge"
    status: ReviewOutcome["specialists"][number]["status"]
  }[]
  selection: Record<VerdictList, readonly { severity: Severity }[]>
  trivial?: true
  strict?: { complete: boolean }
  held?: readonly Pick<HeldFile, "status">[]
}

// What a run covered, without what it found: the parts of a VerdictOutcome that unfinishedCauses reads apart from the
// strict flag. guardrail.ts takes it as StrictInput.coverage.
export type VerdictCoverage = Omit<VerdictOutcome, "selection" | "trivial" | "strict">

// The selection lists a verdict counts: those the job's failOn "blocking" check reads, plus nits.
export type VerdictList = "inline" | "overflow" | "outsideDiff" | "elsewhere" | "nits" | "stillOpen"

// decideSkip's reasons, VS-24's trivial skip, and the job's other no-review exits on a pull request event: a month
// spend that could not be read while a month cap is set, and a rebase carry.
export type VerdictSkip = SkipReason | "trivial" | "spend-unreadable" | "carry"
// The skips that keep an earlier review: `stored` is ReviewState's verdict, when it has one.
export type StoredSkip = "already-reviewed" | "carry"

export type VerdictInput =
  | { kind: "outcome"; outcome: VerdictOutcome }
  | { kind: "skip"; reason: Exclude<VerdictSkip, StoredSkip> }
  | { kind: "skip"; reason: StoredSkip; stored?: ReviewVerdict }
  | { kind: "failure"; stage: VerdictFailure }

// "config": the job cannot run as configured (a model that cannot start, GitHub 401, 403 or 404, a checkout that is not
// the expected tree, a command-level setup failure). "start": GitHub or git failed before the review started.
// "review": a model or tool failure caught after it started.
export type VerdictFailure = "config" | "start" | "review"

export type VerdictCause =
  | VerdictSkip
  | NonNullable<VerdictOutcome["partial"]>
  | "no-stored-verdict"
  | "config-error"
  | "start-error"
  | "review-error"
  | "failure-unknown"
  | "skip-unknown"
  | UnfinishedCause
  | "blocking"
  | "findings"

// The causes unfinishedCauses returns.
export type UnfinishedCause =
  | NonNullable<VerdictOutcome["partial"]>
  | "unreviewed"
  | "size-limit"
  | "skipped-unknown"
  | "held-back"
  | "strict-incomplete"
  | "specialist"
  | "no-reviewer"

// Codes, not text (D14): format.ts words them when the job is wired.
export type VerdictNote = "held-back-deletion" | "review-full"

export interface VerdictResult {
  verdict: ReviewVerdict
  causes: VerdictCause[]
  notes: VerdictNote[]
}

export function reviewVerdict(input: VerdictInput): VerdictResult {
  if (input.kind === "failure") {
    const failure = Object.hasOwn(FAILURES, input.stage) ? FAILURES[input.stage] : UNKNOWN_FAILURE
    return { verdict: failure.verdict, causes: [failure.cause], notes: [] }
  }
  if (input.kind === "skip") {
    if (input.reason === "already-reviewed" || input.reason === "carry")
      return storedVerdict(input.reason, input.stored)
    if (!Object.hasOwn(SKIP_VERDICTS, input.reason))
      return { verdict: "not-reviewed", causes: ["skip-unknown"], notes: [] }
    return { verdict: SKIP_VERDICTS[input.reason], causes: [input.reason], notes: [] }
  }
  const outcome = input.outcome
  const notes: VerdictNote[] = outcome.held?.some((file) => file.status === "deleted") ? ["held-back-deletion"] : []
  if (outcome.partial === "privacy" || outcome.partial === "budget-estimate")
    return { verdict: "not-reviewed", causes: [outcome.partial], notes }
  const unfinished = unfinishedCauses(outcome)
  const listed = LISTED.flatMap((list) => outcome.selection[list])
  // A trivial outcome attempts nothing, so it stands in for the missing reviewer and nothing else. Anything else
  // unfinished, or a pass that ran, means the marker does not describe the outcome, and the verdict reads the outcome
  // instead. What it lists (an earlier finding still open) is read as on any other outcome, so a trivial commit never
  // passes a still-open blocking finding that failOn "blocking" fails on.
  const trivial =
    outcome.trivial === true && !outcome.specialists.length && unfinished.every((cause) => cause === "no-reviewer")
  if (trivial && !listed.length) return { verdict: "policy-skip", causes: ["trivial"], notes }
  if (unfinished.length && !trivial) return { verdict: "incomplete", causes: unfinished, notes }
  // A severity this module does not name reads as blocking.
  if (listed.some((finding) => finding.severity !== "concern" && finding.severity !== "nit"))
    return { verdict: "blocking", causes: ["blocking"], notes }
  if (listed.length) return { verdict: "findings", causes: ["findings"], notes }
  return { verdict: "clean-complete", causes: [], notes }
}

const LISTED: readonly VerdictList[] = ["inline", "overflow", "outsideDiff", "elsewhere", "nits", "stillOpen"]

const FAILURES: Record<VerdictFailure, { verdict: ReviewVerdict; cause: VerdictCause }> = {
  config: { verdict: "not-reviewed", cause: "config-error" },
  start: { verdict: "not-reviewed", cause: "start-error" },
  review: { verdict: "incomplete", cause: "review-error" },
}
// A stage this module does not name: nothing shows the review started.
const UNKNOWN_FAILURE = { verdict: "not-reviewed", cause: "failure-unknown" } as const

// Exhaustive, so a new SkipReason fails typecheck until someone classifies it. A skip that bounds the review (a budget,
// a size limit, a spend that could not be read) leaves the head not reviewed; a skip the repository's policy asks for
// is a policy skip. A reason it does not name at runtime leaves the head not reviewed.
const SKIP_VERDICTS: Record<Exclude<VerdictSkip, StoredSkip>, "not-reviewed" | "policy-skip"> = {
  "month-budget": "not-reviewed",
  "pr-budget": "not-reviewed",
  "too-large": "not-reviewed",
  "spend-unreadable": "not-reviewed",
  label: "policy-skip",
  draft: "policy-skip",
  author: "policy-skip",
  branch: "policy-skip",
  fork: "policy-skip",
  "nothing-to-review": "policy-skip",
  trivial: "policy-skip",
}

// What a skipped file leaves unfinished, or null when skipping it is part of a complete review. Exhaustive, so a new
// SkippedFile reason (VS-34 wiring's `held-back`) fails typecheck here until it is classified; until then, a file that
// arrives with it at runtime reads as `skipped-unknown`.
const SKIPPED_FILE_CAUSES: Record<SkippedFile["reason"], UnfinishedCause | null> = {
  ignored: null,
  lockfile: null,
  generated: null,
  vendored: null,
  "build-output": null,
  binary: null,
  deleted: null,
  "size-limit": "size-limit",
}

// The verdicts a gate fails on, which an earlier review can hand on unchanged.
const FAILING: Record<ReviewVerdict, boolean> = {
  "not-reviewed": true,
  "policy-skip": false,
  incomplete: true,
  blocking: true,
  findings: false,
  "clean-complete": false,
}

// already-reviewed is for the head the stored verdict was computed on, so it carries that verdict. A carry moves the
// review to a rebased head: it hands on a failing verdict, but never a passing one, which belongs to the old head (the
// conservative default; the Q18 answer may let a passing verdict carry). A stored value this module does not name reads
// as a missing one. Whenever the result leaves the head not reviewed or incomplete, the note asks for a full review:
// decideSkip keeps skipping that head until one runs.
function storedVerdict(reason: StoredSkip, stored: ReviewVerdict | undefined): VerdictResult {
  if (!stored || !Object.hasOwn(FAILING, stored))
    return { verdict: "not-reviewed", causes: [reason, "no-stored-verdict"], notes: ["review-full"] }
  if (reason === "carry" && !FAILING[stored])
    return { verdict: "not-reviewed", causes: [reason], notes: ["review-full"] }
  return {
    verdict: stored,
    causes: [reason],
    notes: stored === "not-reviewed" || stored === "incomplete" ? ["review-full"] : [],
  }
}

// Every reason the run is unfinished, in a fixed order. guardrail.ts reads the same causes for StrictResult.complete
// (VS-27b), so strict completeness and VS-32's verdict cannot disagree about what finished.
export function unfinishedCauses(outcome: VerdictCoverage & Pick<VerdictOutcome, "strict">): UnfinishedCause[] {
  return [
    ...(outcome.partial ? [outcome.partial] : []),
    ...(outcome.unreviewed.length ? ["unreviewed" as const] : []),
    ...new Set(
      outcome.skipped.flatMap((file) =>
        Object.hasOwn(SKIPPED_FILE_CAUSES, file.reason) ? (SKIPPED_FILE_CAUSES[file.reason] ?? []) : [],
      ),
    ),
    ...(outcome.skipped.some((file) => !Object.hasOwn(SKIPPED_FILE_CAUSES, file.reason))
      ? ["skipped-unknown" as const]
      : []),
    ...(outcome.held?.some((file) => file.status !== "deleted") ? ["held-back" as const] : []),
    // oxlint-disable-next-line no-unnecessary-boolean-literal-compare -- a decoded strict result can carry a non-boolean
    ...(outcome.strict && outcome.strict.complete !== true ? ["strict-incomplete" as const] : []),
    ...(outcome.specialists.some((entry) => entry.status !== "ok") ? ["specialist" as const] : []),
    // Only a review or security pass reviews the change; verify re-checks findings, and passes later packages add do
    // not stand in for a reviewer.
    ...(outcome.specialists.some((entry) => entry.name === "review" || entry.name === "security")
      ? []
      : ["no-reviewer" as const]),
  ]
}
