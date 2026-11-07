// Scores reviews for VectorScope's eval (script/vectorscope-eval). Pure, so saved outputs can be re-scored without
// another model call.
//
// scoreReview is the legacy smoke-test scorer for the synthetic fixtures: a finding near a planted line counts, and an
// empty denominator counts as a perfect 1. The causal scoring below it (VS-04) is what Phase 0 measures the product
// with: a finding counts only when a settled verdict says it identifies the defect's cause, and an empty denominator is
// reported as no value with its counts.

import { fnv1a64 } from "./fingerprint"
import { SEVERITIES, type ReviewConfig, type ReviewOutcome } from "./types"

export interface EvalExpectation {
  id: string
  path: string
  line: number // a head line the diff added
  endLine?: number
  severity: "blocking" | "concern"
  category?: string
  description: string
}

export interface ReviewScore {
  truePositives: number
  falsePositives: number
  falseNegatives: number
  precision: number
  recall: number
  f1: number
  matches: { expected: string; finding: number }[] // finding is an index into the input findings
}

export const DEFAULT_SLACK = 3

// A finding matches an expectation when the paths agree and its line range overlaps the expected range widened by
// `slack` lines on both sides. Matching is one-to-one, closest pairs first, so a second finding about the same defect
// counts as a false positive. Nits are not claims of a defect and are left out unless `countNits`.
export function scoreReview(input: {
  expected: EvalExpectation[]
  findings: { path: string; line: number; endLine?: number; severity: string; title: string }[]
  slack?: number
  countNits?: boolean
}): ReviewScore {
  const slack = input.slack ?? DEFAULT_SLACK
  const counted = input.findings.flatMap((finding, index) =>
    input.countNits || finding.severity !== "nit" ? [{ index, path: cleanPath(finding.path), ...span(finding) }] : [],
  )
  const pairs = input.expected
    .flatMap((expected, which) => {
      const path = cleanPath(expected.path)
      const target = span(expected)
      return counted
        .filter((finding) => finding.path === path)
        .filter((finding) => finding.start <= target.end + slack && finding.end >= target.start - slack)
        .map((finding) => ({
          which,
          index: finding.index,
          gap: Math.max(0, target.start - finding.end, finding.start - target.end),
          offset: Math.abs(finding.start - target.start),
        }))
    })
    .toSorted((a, b) => a.gap - b.gap || a.offset - b.offset || a.which - b.which || a.index - b.index)
  const usedExpected = new Set<number>()
  const usedFindings = new Set<number>()
  const matched = pairs.filter((pair) => {
    if (usedExpected.has(pair.which) || usedFindings.has(pair.index)) return false
    usedExpected.add(pair.which)
    usedFindings.add(pair.index)
    return true
  })
  return {
    ...rates(matched.length, counted.length - matched.length, input.expected.length - matched.length),
    matches: matched
      .toSorted((a, b) => a.which - b.which)
      .map((pair) => ({ expected: input.expected[pair.which].id, finding: pair.index })),
  }
}

// Micro-averaged over every fixture run: the counts are summed before the rates are taken, so a fixture with three
// findings weighs more than one with none.
export function totalScores(scores: ReviewScore[]): Omit<ReviewScore, "matches"> {
  return rates(
    scores.reduce((sum, score) => sum + score.truePositives, 0),
    scores.reduce((sum, score) => sum + score.falsePositives, 0),
    scores.reduce((sum, score) => sum + score.falseNegatives, 0),
  )
}

// No findings is a precise review and nothing to find is a complete one, so each rate is 1 when its denominator is 0.
function rates(truePositives: number, falsePositives: number, falseNegatives: number) {
  const precision = truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives)
  const recall = truePositives + falseNegatives === 0 ? 1 : truePositives / (truePositives + falseNegatives)
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Replay pipeline variants (VS-21a). The eval registry (script/vectorscope-eval/replay.ts, VARIANTS) maps each
// variant's name to the settings it replays; the engine replay (packages/engine/src/review/eval.ts) and the desktop
// adapter (script/vectorscope-eval/desktop.ts) apply them. The two values below are shared by all three, since the
// eval scripts may import only types from the engine.

// A variant's name: its runner, then ":" and a suffix the registry defines, such as "engine:shared-verify"; the runner
// alone is the frozen pipeline. A name never has "=", which separates a variant from its model in report.ts
// --candidate and --baseline, nor "/", whitespace or capitals. Only the registry keeps model ids out: a suffix such as
// "gpt5" fits this grammar.
export const VARIANT_NAME = /^[a-z]+(:[a-z][a-z0-9]*(-[a-z0-9]+)*)?$/

// The settings a variant may set over the base's review.json, per runner. A key joins a runner's list only in the
// package that makes it change what that runner does, with that package's D3 parity test; adding a ReviewConfig key
// alone never adds it. The eval's own limits are never a variant's.
export const VARIANT_KEYS = {
  engine: ["verifyPolicy"],
  desktop: ["verifyPolicy"],
} as const satisfies Record<
  string,
  readonly Exclude<keyof ReviewConfig, "maxCostUsd" | "maxSteps" | "timeoutMinutes">[]
>

// ---------------------------------------------------------------------------------------------------------------------
// Causal judging (VectorScope plan, VS-04; Phase 0 "Metrics and judging").
//
// A run's findings are judged against its case's labelled defects in blinded passes (eval-judge.ts). A verdict is
// settled by a human adjudication, or by two independent judges that agree when at least one of them is a human: a
// model may assist but is never the sole authority, so an agreement of models alone waits for a human. One pass alone
// settles nothing, a model never judges findings it produced, and a pass made under an earlier rubric is stale.
// scoreRun turns one run's settled verdicts into counts, and summarize turns runs into the reported metrics with their
// intervals. A run that failed, was not sent or is missing stays in the denominators, and a rate with nothing to count
// is null, never 1. Adversarial (prompt-injection) cases are separate trust tests: they are left out of every quality
// metric and reported on their own.

// Raised whenever the verdict rules in judging-rubric.md change. Passes made under another version must be redone.
export const RUBRIC_VERSION = 1

// VS-45's proposed importance axis (judging-rubric-importance.md), pending owner question Q29. It is a proposal, never a
// rubric version: a pass made under it records this name beside the rubric whose verdict rules it follows, and counts
// only where the same proposal is asked for, so no adopted RUBRIC_VERSION can ever count it. Adopting the axis (VS-45b)
// means judging again under the new version. The name is revised whenever judging-rubric-importance.md changes, which
// makes earlier proposal passes stale as well. Each match and extra under it gains an importance.
export const IMPORTANCE_PROPOSAL = "vs45-importance-1"
export const IMPORTANCE = ["would-block", "should-fix", "minor"] as const
export type Importance = (typeof IMPORTANCE)[number]
// VS-45's kill rule: the importance axis is dropped when inter-judge kappa on importance, over at least this many
// double-judged findings, is below IMPORTANCE_MIN_KAPPA. This build applies it to every finding together, as VS-45
// states it, and also to matches and extras apart, each part with its own minimum (importanceAgreement).
export const IMPORTANCE_MIN_FINDINGS = 100
export const IMPORTANCE_MIN_KAPPA = 0.4
// A gradient step is flat when its interval rules out a fall of this much or more (severityGradient). This build's
// choice for a monitor that decides nothing; VS-45 names no margin.
export const GRADIENT_MARGIN = 0.1

export type Stage = "proposed" | "posted"
export type RunStatus = "completed" | "partial" | "failed" | "not-sent"

export interface DefectLocation {
  path: string
  line: number
  endLine?: number
}

// What a finding must identify to count for a labelled defect: its cause, not only its lines.
export interface LabelledDefect {
  id: string
  category: string
  severity: "blocking" | "concern"
  summary: string
  cause: string
  locations: DefectLocation[]
  alternatives: DefectLocation[]
  // VS-22a's failure class: one of the five classes, or "other", from the dataset defect's failureClass label (absent
  // while unlabelled). Class-scoped recall (eval-report.ts) counts only defects with a class other than "other". Judges'
  // blinded tasks leave it out (eval-judge.ts TaskDefect).
  failureClass?: string
}

// Where a judge can read the code a case changed, so an unexpected finding is checked against the code and not only
// against the labels. It names the case's change, never the pipeline, model or repetition that reviewed it.
export type CodeReference =
  | { repository: string; base: string; head: string } // a dataset case: the candidate change in its public repository
  | { patch: string } // a synthetic fixture: the change itself, as a unified diff with its context lines

export interface EvalCase {
  id: string
  // An adversarial case carries prompt-injection text. It tests trust, not review quality, so it never counts toward
  // recall, precision or false alarms per clean pull request.
  kind: "bug" | "control" | "adversarial"
  language: string
  size?: { files: number; additions: number; deletions: number }
  defects: LabelledDefect[] // empty for a control
  code?: CodeReference
  // The dataset's labels.crossFile (VS-22a): explaining a labelled defect's cause needs code in a second file. Absent
  // while unlabelled. Cross-file recall counts the defects of the cases where it is true.
  crossFile?: boolean
  // A trivial control's kind (whitespace, docs, rename or comment), on a control only: the dataset's "trivial" kind
  // with its labels.trivialKind (VS-22a). Trivial controls are reported on their own and never count toward false
  // alarms per clean pull request (the D2 figure).
  trivialKind?: string
}

export interface EvalFinding {
  key: string // findingKey: a finding has the same key in the proposed and the posted lists
  path: string
  line: number
  endLine?: number
  severity: string
  category: string
  title: string
  body: string
  suggestion?: string
  anchored?: boolean // posted on a diff line rather than only in the summary; absent when that is not known
}

// VS-49 (addendum A): where a proposed finding's evidence falls. "diff": a line the change's diff shows; "slice": a
// block the run's impact slice shows (VS-25b); "read": a file the pass read itself.
export const UTILISATION_PLACES = ["diff", "slice", "read"] as const
export type UtilisationPlace = (typeof UTILISATION_PLACES)[number]

// VS-49's slice utilisation of one engine replay, taken from its passes' session events at zero tokens: what each pass
// called and read, how much of the slice it used, and where its findings' evidence falls. Nothing writes it before the
// VS-49 wiring observer, and script/vectorscope-eval/replay.ts utilisationProblems checks a record against the rest of
// its artifact. Paths are as the artifact's tool records name them, and compare as that check spells them
// (checkoutPath: "/" separators, "." and ".." resolved, no leading "./").
export interface SliceUtilisation {
  // The slice's own locations (ImpactSlice.locations) the passes were measured against, "path:line" each once, every
  // one also in the artifact's context.locations, which quotes the related-code call sites too. Empty when no slice was
  // built (no tier1) or the slice was empty.
  slice: string[]
  passes: PassUtilisation[]
}

export interface PassUtilisation {
  pass: ReviewOutcome["specialists"][number]["name"]
  lens?: string // a "lens" pass's class (VS-28), which every lens entry has and no other entry has
  tools: Record<string, number> // the pass's tool calls by tool name, whatever their status; names with none left out
  // The distinct paths the pass read: inside when a slice location names the path, outside when none does. They hold
  // at least every completed read-tool call's filePath; a read through another tool may add more.
  reads: { inside: string[]; outside: string[] }
  sliceGreps: number // tool calls that searched for a name the slice already shows
  // Each finding the pass proposed, by findingKey, once (only review, security and lens passes propose findings):
  // where its evidence falls, distinct and in UTILISATION_PLACES order, and whether that was worked out from legacy
  // "path:line" evidence strings (ModelFinding.evidence) rather than quotes.
  findings: { key: string; places: UtilisationPlace[]; approximate: boolean }[]
  received?: string[] // a lens pass only: the context.locations its prompt showed it
  cited?: string[] // a lens pass only: the locations its findings' evidence names
}

// One review of one case by one pipeline variant and model, as saved.
export interface EvalRun {
  variant: string // the pipeline, such as "engine" or "single-prompt"
  model: string
  models?: string[] // every model whose output is in the findings, such as the review and triage models; [model] if absent
  case: string
  repetition: number
  trust: "trusted" | "untrusted"
  status: RunStatus
  detail?: string // why the run is partial, failed or not sent
  proposed: EvalFinding[] // what the reviewers reported
  posted: EvalFinding[] // what survived verification and selection and would be posted
  ms?: number
  // The provider attempts the run's admission let through; 0 is a review that spent no token (a zero-token stop).
  // Absent when the output does not say.
  attempts?: number
  stop?: string // why the review stopped early (ReviewOutcome.partial); "privacy" is a route refusal (VS-23)
  passes?: { pass: string; ms: number }[] // wall time of each pass that ran
  spend: {
    costUsd?: number // known spend; absent when none was reported
    uncertainUsd: number // kept for attempts whose cost is not known, never read as zero
    usageMissing: boolean
    admitted: boolean // the eval ledger admitted the run's paid attempts; true when it made none
  }
  // input counts the prompt tokens neither read from nor written to the provider's cache, as the engine reports them.
  tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  violations: string[] // trust or consent checks the run broke
  startedAt?: string
  // VS-49: from an engine replay whose record bears out its own artifact. Absent unless measured; nothing scores it.
  utilisation?: SliceUtilisation
}

export type PlanEntry = Pick<EvalRun, "variant" | "model" | "case" | "repetition">

// A trivial control (VS-22a), which never counts toward false alarms per clean pull request.
export function isTrivialControl(evalCase: Pick<EvalCase, "kind" | "trivialKind">) {
  return evalCase.kind === "control" && evalCase.trivialKind !== undefined
}

export type Verdict =
  | { kind: "match"; defect: string } // identifies the cause of this labelled defect
  | { kind: "extra"; issue: string } // a real defect the labels lack; one run's findings with the same issue are one defect
  | { kind: "false-alarm" } // no real defect in the change, including a different complaint at a labelled line

export type Suggestion = "valid" | "invalid"

export interface JudgePass {
  judge: string // "human:<name>" or "model:<provider/model>"
  rubric: number
  proposal?: string // a proposed rubric the pass was made under (IMPORTANCE_PROPOSAL); absent under the current one
  verdict: Verdict
  importance?: Importance // under IMPORTANCE_PROPOSAL only, on a match or an extra; beside the verdict, never in it
  suggestion?: Suggestion // whether the finding's suggested change is correct, when it has one
  note?: string
}

export interface Adjudication {
  by: string // "human:<name>"; a model never adjudicates
  date: string
  rubric: number
  proposal?: string
  verdict: Verdict
  importance?: Importance
  suggestion?: Suggestion
  note?: string
}

export interface Judgement {
  run: string // runKey
  finding: string // EvalFinding.key
  passes: JudgePass[]
  adjudication?: Adjudication
}

// Every settled verdict has a human behind it: an adjudication, or an agreement with a human pass in it. Judges that
// agree with no human among them are "needs-human" until a human judges or adjudicates the finding.
export type Settled =
  | {
      status: "adjudicated" | "agreed"
      verdict: Verdict
      suggestion?: Suggestion
      importance?: Importance
      human: true
      problems: string[]
    }
  | { status: "disagreed" | "needs-human" | "single" | "none"; problems: string[] }

export function runKey(run: PlanEntry) {
  return `${run.variant} ${run.model} ${run.case}#${run.repetition}`
}

// Keyed by place and title, not by body: selection appends an "also at" sentence to the body of a finding it posts.
export function findingKey(finding: Pick<EvalFinding, "path" | "line" | "endLine" | "title">) {
  return fnv1a64(
    [cleanPath(finding.path), finding.line, finding.endLine ?? finding.line, finding.title.trim()].join("\n"),
  ).slice(0, 12)
}

export function isSettled(value: Settled | undefined): value is Extract<Settled, { verdict: Verdict }> {
  return value?.status === "adjudicated" || value?.status === "agreed"
}

// A judgement's verdict, if it has one. A human adjudication settles it. Otherwise at least two judges, each counted
// once at its latest pass, must agree, and at least one of them must be a human; a disagreement waits for
// adjudication, an agreement of models alone waits for a human, and a single pass waits for a second. A pass under
// another rubric version, a malformed pass, and a model judging findings that model produced (`reviewed` lists the
// run's models, compared by sameModel) do not count. An extra defect's issue is prefixed with its judge, so issues named
// by different judges are never merged. A pass counts only under the rubric and the proposal it was made under: one made
// under a proposed rubric (IMPORTANCE_PROPOSAL) is stale under any adopted one, and the reverse. Under the importance
// proposal the verdict settles as it does without it, and its importance settles apart: an adjudication's, or one that
// every counted pass gives, as for a suggestion.
export function settle(
  judgement: Pick<Judgement, "passes" | "adjudication">,
  options: { reviewed: readonly string[]; rubric?: number; proposal?: string },
): Settled {
  const rubric = options.rubric ?? RUBRIC_VERSION
  const proposal = options.proposal
  const checked = judgement.passes.map((pass) => ({
    pass,
    problem: passProblem(pass, { rubric, proposal }, options.reviewed),
  }))
  const adjudication = judgement.adjudication
  const refused = adjudication ? adjudicationProblem(adjudication, { rubric, proposal }) : undefined
  const problems = [
    ...checked.flatMap((entry) => (entry.problem ? [entry.problem] : [])),
    ...(refused ? [refused] : []),
  ]
  if (adjudication && !refused)
    return {
      status: "adjudicated",
      verdict: namespaced(adjudication.verdict, adjudication.by),
      ...(adjudication.suggestion ? { suggestion: adjudication.suggestion } : {}),
      ...(adjudication.importance ? { importance: adjudication.importance } : {}),
      human: true,
      problems,
    }
  const passes = [
    ...new Map(checked.filter((entry) => !entry.problem).map((entry) => [entry.pass.judge, entry.pass])).values(),
  ].toSorted((a, b) => compare(a.judge, b.judge))
  if (passes.length < 2) return { status: passes.length ? "single" : "none", problems }
  if (!passes.every((pass) => sameVerdict(pass.verdict, passes[0].verdict))) return { status: "disagreed", problems }
  // A model may assist with matching but is never the sole authority (Phase 0, "Metrics and judging").
  if (!passes.some((pass) => pass.judge.startsWith("human:"))) return { status: "needs-human", problems }
  const suggestion = passes[0].suggestion
  const importance = passes[0].importance
  return {
    status: "agreed",
    verdict: namespaced(passes[0].verdict, passes[0].judge),
    ...(suggestion && passes.every((pass) => pass.suggestion === suggestion) ? { suggestion } : {}),
    ...(importance && passes.every((pass) => pass.importance === importance) ? { importance } : {}),
    human: true,
    problems,
  }
}

// What is wrong with an entry's importance under a rubric and proposal, as a phrase that follows "the verdict" or "the
// answer": only the importance proposal records one, only on a match or an extra, and there always one of IMPORTANCE.
export function importanceProblem(entry: { verdict: Verdict; importance?: unknown }, proposal?: string) {
  const real = entry.verdict?.kind === "match" || entry.verdict?.kind === "extra"
  if (proposal !== IMPORTANCE_PROPOSAL)
    return entry.importance === undefined
      ? undefined
      : `has an importance, which only the proposed importance rubric (${IMPORTANCE_PROPOSAL}) records`
  if (!real)
    return entry.importance === undefined
      ? undefined
      : "gives an importance to a false alarm; only a match or an extra has one"
  return IMPORTANCE.some((value) => value === entry.importance)
    ? undefined
    : `is a match or an extra without an importance of ${IMPORTANCE.join(", ")}`
}

// The rubric a pass or a report was made under, as the report and the stale-pass problem name it.
export function rubricName(rubric: unknown, proposal?: unknown) {
  return proposal === undefined ? `rubric ${rubric}` : `rubric ${rubric} with the proposal ${String(proposal)}`
}

// The rubric a stale pass, adjudication or worksheet is told it is not (`theirs` is the proposal it was made under): the
// bare version when neither side has a proposal, as these problems read before VS-45, else the rubric named in full.
export function staleAgainst(under: { rubric: number; proposal?: string }, theirs: unknown) {
  return under.proposal === undefined && theirs === undefined
    ? `${under.rubric}`
    : rubricName(under.rubric, under.proposal)
}

// Whether two model ids name the same model, however a route or provider spells it. The engine records
// "<provider>/<model>" (such as "openrouter/anthropic/claude-sonnet-4.5") and the prompt harness the router's own id
// ("anthropic/claude-sonnet-4.5"). Each is reduced to its path segments, lower-cased, with a route suffix (":free",
// "@preset") and a trailing date dropped from the last one and dots read as hyphens; the ids name the same model when
// one's segments end the other's. It errs towards "same", which only ever refuses a judge.
export function sameModel(a: string, b: string) {
  const left = modelSegments(a)
  const right = modelSegments(b)
  if (!left.length || !right.length) return false
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left]
  return shorter.every((segment, index) => segment === longer[longer.length - shorter.length + index])
}

function modelSegments(id: string) {
  const segments = id
    .trim()
    .toLowerCase()
    .split("/")
    .filter((segment) => segment.length > 0)
  if (!segments.length) return []
  const last = segments
    .at(-1)!
    .replace(/[:@].*$/, "")
    .replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "")
  return [...segments.slice(0, -1), last].map((segment) => segment.replaceAll(".", "-")).filter(Boolean)
}

export interface RunScore {
  run: string
  case: string
  repetition: number
  status: RunStatus | "missing"
  comments: number // findings at the stage, nits included
  actionable: number // findings that claim a defect; nits only when they are counted
  matched: number // the run's first finding to identify each labelled defect
  extra: number // the run's first finding to identify each real defect the labels lack
  duplicates: number // further findings on a defect the run already reported
  falseAlarms: number
  unjudged: number // actionable findings with no settled verdict
  defects: string[]
  detected: string[]
  severityAgreed: number // matched findings whose severity is the label's
  located: number // matched findings that cite one of the defect's locations or alternatives
  anchored: number
  anchorKnown: number
  suggestions: { valid: number; invalid: number; unjudged: number }
  // VS-45: the judged actionable findings by the severity each was posted with, sorted. Unjudged findings are in none.
  bySeverity: Record<string, SeverityTally>
  problems: string[]
}

export interface SeverityTally {
  judged: number // matched, extra, duplicate and false alarm
  real: number // matched and extra: the first finding on each defect
  wouldBlock: number // real, with a settled importance of would-block (the importance proposal only)
  important: number // real, would-block or should-fix
  unsettled: number // real, with no settled importance; every real finding outside the importance proposal
}

// One planned run scored from its settled verdicts. A run that is missing, failed or was not sent reviewed nothing, so
// it detects nothing. Findings are taken in order: the first to identify a defect counts and later ones on the same
// defect are duplicates. A finding with no settled verdict is unjudged, never assumed right or wrong.
export function scoreRun(input: {
  evalCase: EvalCase
  planned: PlanEntry
  run?: EvalRun
  verdict: (finding: EvalFinding) => Settled | undefined
  stage: Stage
  countNits?: boolean
  slack?: number
}): RunScore {
  const run = input.run
  const findings = run && (run.status === "completed" || run.status === "partial") ? run[input.stage] : []
  const slack = input.slack ?? DEFAULT_SLACK
  const defects = new Map(input.evalCase.defects.map((defect) => [defect.id, defect]))
  const reported = new Set<string>()
  const judged = findings
    .filter((finding) => input.countNits || finding.severity !== "nit")
    .map((finding): Judged => {
      const outcome = input.verdict(finding)
      if (!isSettled(outcome)) return { finding, kind: "unjudged" }
      const verdict = outcome.verdict
      const suggestion = outcome.suggestion
      if (verdict.kind === "false-alarm") return { finding, kind: "false-alarm", suggestion }
      const defect = verdict.kind === "match" ? defects.get(verdict.defect) : undefined
      if (verdict.kind === "match" && !defect)
        return {
          finding,
          kind: "unjudged",
          problem: `${runKey(input.planned)}: finding ${finding.key} is matched to ${verdict.defect}, which case ${input.evalCase.id} does not label`,
        }
      const id = verdict.kind === "match" ? `defect:${verdict.defect}` : `extra:${verdict.issue}`
      if (reported.has(id)) return { finding, kind: "duplicate", suggestion }
      reported.add(id)
      const importance = outcome.importance
      return defect
        ? { finding, kind: "matched", defect, suggestion, importance }
        : { finding, kind: "extra", suggestion, importance }
    })
  const matched = judged.flatMap((entry) => (entry.kind === "matched" ? [entry] : []))
  const count = (kind: Judged["kind"]) => judged.filter((entry) => entry.kind === kind).length
  const suggested = judged.filter((entry) => entry.finding.suggestion?.trim())
  const tallied = judged.filter((entry) => entry.kind !== "unjudged")
  return {
    run: runKey(input.planned),
    case: input.evalCase.id,
    repetition: input.planned.repetition,
    status: run?.status ?? "missing",
    comments: findings.length,
    actionable: judged.length,
    matched: matched.length,
    extra: count("extra"),
    duplicates: count("duplicate"),
    falseAlarms: count("false-alarm"),
    unjudged: count("unjudged"),
    defects: input.evalCase.defects.map((defect) => defect.id),
    detected: matched.map((entry) => entry.defect.id),
    severityAgreed: matched.filter((entry) => entry.finding.severity === entry.defect.severity).length,
    located: matched.filter((entry) =>
      [...entry.defect.locations, ...entry.defect.alternatives].some((location) =>
        near(entry.finding, location, slack),
      ),
    ).length,
    anchored: findings.filter((finding) => finding.anchored === true).length,
    anchorKnown: findings.filter((finding) => finding.anchored !== undefined).length,
    suggestions: {
      valid: suggested.filter((entry) => entry.kind !== "unjudged" && entry.suggestion === "valid").length,
      invalid: suggested.filter((entry) => entry.kind !== "unjudged" && entry.suggestion === "invalid").length,
      unjudged: suggested.filter((entry) => entry.kind === "unjudged" || !entry.suggestion).length,
    },
    bySeverity: Object.fromEntries(
      [...new Set(tallied.map((entry) => entry.finding.severity))].toSorted().map((severity) => {
        const real = tallied.filter(
          (entry) => entry.finding.severity === severity && (entry.kind === "matched" || entry.kind === "extra"),
        )
        return [
          severity,
          {
            judged: tallied.filter((entry) => entry.finding.severity === severity).length,
            real: real.length,
            wouldBlock: real.filter((entry) => entry.importance === "would-block").length,
            important: real.filter((entry) => entry.importance === "would-block" || entry.importance === "should-fix")
              .length,
            unsettled: real.filter((entry) => entry.importance === undefined).length,
          } satisfies SeverityTally,
        ]
      }),
    ),
    problems: judged.flatMap((entry) => (entry.kind === "unjudged" && entry.problem ? [entry.problem] : [])),
  }
}

type Judged =
  | { finding: EvalFinding; kind: "unjudged"; problem?: string; suggestion?: undefined; importance?: undefined }
  | {
      finding: EvalFinding
      kind: "matched"
      defect: LabelledDefect
      suggestion?: Suggestion
      importance?: Importance
    }
  | { finding: EvalFinding; kind: "extra"; suggestion?: Suggestion; importance?: Importance }
  | { finding: EvalFinding; kind: "duplicate" | "false-alarm"; suggestion?: Suggestion; importance?: undefined }

// A proportion with its Wilson score interval; value and interval are null when there is nothing to count.
export interface Proportion {
  count: number
  total: number
  value: number | null
  interval: [number, number] | null
}

// A count per unit of exposure (per reviewed pull request) with its exact Poisson interval; null with no exposure.
export interface Rate {
  count: number
  exposure: number
  value: number | null
  interval: [number, number] | null
}

export interface Metrics {
  planned: number
  status: Record<RunStatus | "missing", number>
  coverage: Proportion // completed runs of the planned ones
  recall: Proportion // end to end: the labelled defects of every planned run, so a run that reviewed nothing finds none
  conditionalRecall: Proportion // the labelled defects of completed runs only
  macroRecall: number | null // the mean of each bug case's end-to-end recall
  precision: Proportion // matched and extra findings among the judged actionable ones
  macroPrecision: number | null // the mean precision of the runs with judged actionable findings
  f1: number | null // from precision and end-to-end recall
  falseAlarmsPerCleanPr: Rate // false alarms on the controls a run reviewed, per reviewed control
  falseAlarmsPerPr: Rate
  commentsPerPr: Rate
  duplicatesPerPr: Rate
  severityAgreement: Proportion
  // VS-45: matched and extra findings of the judged actionable ones, by the severity each was posted with (SEVERITIES
  // first, then any other, sorted). Duplicates count in the denominator, as for actionable precision. Its blocking share
  // is precision@blocking on the current rubric. A table only: under the current rubric a real concern is as real as a
  // real blocking finding, so no gradient is read from it.
  severityPrecision: Record<string, Proportion>
  // Under the importance proposal only (IMPORTANCE_PROPOSAL, Q29).
  importance?: ImportanceMetrics
  location: Proportion
  anchors: Proportion
  suggestions: Proportion
  findings: {
    comments: number
    actionable: number
    matched: number
    extra: number
    duplicates: number
    falseAlarms: number
    unjudged: number
  }
  spend: {
    costUsd: number // known spend
    uncertainUsd: number
    usageMissing: number // runs with an attempt whose usage was not reported
    unaccounted: number // runs that sent paid attempts the eval ledger did not admit
    tokens: { input: number; output: number }
    tokensMissing: number // reviewed runs that reported no tokens
  }
  wallMs: { total: number; median: number | null; runs: number }
  violations: string[] // every run's, the adversarial cases' included
  // Prompt-injection cases, kept out of every rate above. A trust or consent check one of them broke is in violations.
  adversarial: { planned: number; reviewed: number; violated: number }
  problems: string[]
}

// VS-45's metrics on the importance axis. A real finding whose importance is not settled is left out of the
// denominators of `important` and `wouldBlock` and counted in `unsettled`; a duplicate or a false alarm stays in them,
// as in actionable precision. `blocking` is precision@blocking as VS-45 defines it, over every judged blocking finding,
// an unsettled one counted as not would-block; `wouldBlock`'s blocking share is the same with unsettled ones left out,
// the basis its gradient needs, so an open importance dispute lowers the first and leaves the second unmoved.
export interface ImportanceMetrics {
  important: Proportion // real and would-block or should-fix
  blocking: Proportion // real and would-block, of judged blocking findings
  wouldBlock: SeverityGradient // real and would-block, by posted severity, of settled ones
  unsettled: number
}

export const DEFAULT_CONFIDENCE = 0.95

// The reported metrics over scored runs, micro-averaged unless named macro. "Reviewed" means completed or partial: a
// partial run's findings are real and count, but only a completed run counts toward coverage and conditional recall.
// Adversarial cases count only toward spend, wall time and trust violations; their findings are not review quality.
export function summarize(
  all: readonly { score: RunScore; evalCase: EvalCase; run?: EvalRun }[],
  options: { confidence?: number; proposal?: string } = {},
): Metrics {
  const confidence = options.confidence ?? DEFAULT_CONFIDENCE
  const adversarial = all.filter((entry) => entry.evalCase.kind === "adversarial")
  const entries = all.filter((entry) => entry.evalCase.kind !== "adversarial")
  const scores = entries.map((entry) => entry.score)
  const reviewed = entries.filter((entry) => entry.score.status === "completed" || entry.score.status === "partial")
  const completed = scores.filter((score) => score.status === "completed")
  // Behaviour-preserving controls only: a trivial one is reported on its own (eval-report.ts).
  const controls = reviewed.filter((entry) => entry.evalCase.kind === "control" && !isTrivialControl(entry.evalCase))
  const judgedOf = (score: RunScore) => score.matched + score.extra + score.duplicates + score.falseAlarms
  const found = sum(scores.map((score) => score.matched + score.extra))
  const judged = sum(scores.map(judgedOf))
  const recall = proportion(
    sum(scores.map((score) => score.detected.length)),
    sum(scores.map((score) => score.defects.length)),
    confidence,
  )
  const precision = proportion(found, judged, confidence)
  const labelled = scores.filter((score) => score.defects.length > 0)
  const byCase = [...new Set(labelled.map((score) => score.case))].map((id) => {
    const group = labelled.filter((score) => score.case === id)
    return sum(group.map((score) => score.detected.length)) / sum(group.map((score) => score.defects.length))
  })
  const precise = scores
    .filter((score) => judgedOf(score) > 0)
    .map((score) => (score.matched + score.extra) / judgedOf(score))
  const runs = all.flatMap((entry) => (entry.run ? [entry.run] : []))
  const isReviewed = (entry: { score: RunScore }) =>
    entry.score.status === "completed" || entry.score.status === "partial"
  const timed = runs.flatMap((run) => (run.ms === undefined ? [] : [run.ms])).toSorted((a, b) => a - b)
  const tallies = severityTallies(scores)
  const settled = (tally: SeverityTally) => tally.judged - tally.unsettled
  return {
    planned: scores.length,
    status: {
      completed: completed.length,
      partial: scores.filter((score) => score.status === "partial").length,
      failed: scores.filter((score) => score.status === "failed").length,
      "not-sent": scores.filter((score) => score.status === "not-sent").length,
      missing: scores.filter((score) => score.status === "missing").length,
    },
    coverage: proportion(completed.length, scores.length, confidence),
    recall,
    conditionalRecall: proportion(
      sum(completed.map((score) => score.detected.length)),
      sum(completed.map((score) => score.defects.length)),
      confidence,
    ),
    macroRecall: byCase.length ? sum(byCase) / byCase.length : null,
    precision,
    macroPrecision: precise.length ? sum(precise) / precise.length : null,
    f1:
      precision.value === null || recall.value === null
        ? null
        : precision.value + recall.value === 0
          ? 0
          : (2 * precision.value * recall.value) / (precision.value + recall.value),
    falseAlarmsPerCleanPr: rate(sum(controls.map((entry) => entry.score.falseAlarms)), controls.length, confidence),
    falseAlarmsPerPr: rate(sum(reviewed.map((entry) => entry.score.falseAlarms)), reviewed.length, confidence),
    commentsPerPr: rate(sum(reviewed.map((entry) => entry.score.comments)), reviewed.length, confidence),
    duplicatesPerPr: rate(sum(reviewed.map((entry) => entry.score.duplicates)), reviewed.length, confidence),
    severityAgreement: proportion(
      sum(scores.map((score) => score.severityAgreed)),
      sum(scores.map((score) => score.matched)),
      confidence,
    ),
    severityPrecision: Object.fromEntries(
      Object.entries(tallies).map(([severity, tally]) => [severity, proportion(tally.real, tally.judged, confidence)]),
    ),
    ...(options.proposal === IMPORTANCE_PROPOSAL
      ? {
          importance: {
            important: proportion(
              sum(Object.values(tallies).map((tally) => tally.important)),
              sum(Object.values(tallies).map(settled)),
              confidence,
            ),
            blocking: proportion(tallies.blocking.wouldBlock, tallies.blocking.judged, confidence),
            wouldBlock: severityGradient(
              Object.fromEntries(
                Object.entries(tallies).map(([severity, tally]) => [
                  severity,
                  { count: tally.wouldBlock, total: settled(tally) },
                ]),
              ),
              { confidence },
            ),
            unsettled: sum(Object.values(tallies).map((tally) => tally.unsettled)),
          },
        }
      : {}),
    location: proportion(
      sum(scores.map((score) => score.located)),
      sum(scores.map((score) => score.matched)),
      confidence,
    ),
    anchors: proportion(
      sum(scores.map((score) => score.anchored)),
      sum(scores.map((score) => score.anchorKnown)),
      confidence,
    ),
    suggestions: proportion(
      sum(scores.map((score) => score.suggestions.valid)),
      sum(scores.map((score) => score.suggestions.valid + score.suggestions.invalid)),
      confidence,
    ),
    findings: {
      comments: sum(scores.map((score) => score.comments)),
      actionable: sum(scores.map((score) => score.actionable)),
      matched: sum(scores.map((score) => score.matched)),
      extra: sum(scores.map((score) => score.extra)),
      duplicates: sum(scores.map((score) => score.duplicates)),
      falseAlarms: sum(scores.map((score) => score.falseAlarms)),
      unjudged: sum(scores.map((score) => score.unjudged)),
    },
    spend: {
      costUsd: sum(runs.map((run) => run.spend.costUsd ?? 0)),
      uncertainUsd: sum(runs.map((run) => run.spend.uncertainUsd)),
      usageMissing: runs.filter((run) => run.spend.usageMissing).length,
      unaccounted: runs.filter((run) => run.status !== "not-sent" && !run.spend.admitted).length,
      tokens: {
        input: sum(runs.map((run) => run.tokens?.input ?? 0)),
        output: sum(runs.map((run) => run.tokens?.output ?? 0)),
      },
      tokensMissing: all.filter((entry) => isReviewed(entry) && !entry.run?.tokens).length,
    },
    wallMs: {
      total: sum(timed),
      median: timed.length
        ? timed.length % 2
          ? timed[(timed.length - 1) / 2]
          : (timed[timed.length / 2 - 1] + timed[timed.length / 2]) / 2
        : null,
      runs: timed.length,
    },
    violations: runs.flatMap((run) => run.violations.map((violation) => `${runKey(run)}: ${violation}`)),
    adversarial: {
      planned: adversarial.length,
      reviewed: adversarial.filter(isReviewed).length,
      violated: adversarial.filter((entry) => (entry.run?.violations.length ?? 0) > 0).length,
    },
    problems: all.flatMap((entry) => entry.score.problems),
  }
}

export interface PairedRecall {
  pairs: number // labelled defects reviewed by both, one per case, repetition and defect
  candidate: number // of them, detected by the candidate
  baseline: number // detected by the baseline
  difference: number | null // candidate recall less baseline recall
  interval: [number, number] | null
  unjudged: number // findings with no settled verdict in the paired runs, which could change either side
}

// Recall on paired cases: each labelled defect of a case and repetition both pipelines were planned on, detected end
// to end (a run that reviewed nothing detects nothing), compared with Newcombe's interval for paired proportions.
// Adversarial cases are left out, as they are of recall itself.
export function pairedRecall(
  candidate: readonly { score: RunScore; evalCase?: Pick<EvalCase, "kind"> }[],
  baseline: readonly { score: RunScore; evalCase?: Pick<EvalCase, "kind"> }[],
  options: { confidence?: number } = {},
): PairedRecall {
  const counted = (entry: { evalCase?: Pick<EvalCase, "kind"> }) => entry.evalCase?.kind !== "adversarial"
  const base = new Map(
    baseline.filter(counted).map((entry) => [`${entry.score.case}#${entry.score.repetition}`, entry.score]),
  )
  const paired = candidate.filter(counted).flatMap((entry) => {
    const other = base.get(`${entry.score.case}#${entry.score.repetition}`)
    return other ? [{ candidate: entry.score, baseline: other }] : []
  })
  const pairs = paired.flatMap((pair) =>
    pair.candidate.defects.map((defect) => ({
      candidate: pair.candidate.detected.includes(defect),
      baseline: pair.baseline.detected.includes(defect),
    })),
  )
  const difference = pairedDifference(pairs, options.confidence ?? DEFAULT_CONFIDENCE)
  return {
    pairs: pairs.length,
    candidate: pairs.filter((pair) => pair.candidate).length,
    baseline: pairs.filter((pair) => pair.baseline).length,
    difference: difference?.difference ?? null,
    interval: difference?.interval ?? null,
    unjudged: sum(paired.map((pair) => pair.candidate.unjudged + pair.baseline.unjudged)),
  }
}

// Wilson score interval for count successes in total trials.
export function wilson(count: number, total: number, confidence = DEFAULT_CONFIDENCE): [number, number] | null {
  if (total <= 0) return null
  const z = normalQuantile(1 - (1 - confidence) / 2)
  const p = count / total
  const scale = 1 + (z * z) / total
  const center = (p + (z * z) / (2 * total)) / scale
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / scale
  return [Math.max(0, center - half), Math.min(1, center + half)]
}

// Exact (Garwood) interval for a Poisson count over an exposure, as a rate per unit of exposure.
export function poissonInterval(
  count: number,
  exposure: number,
  confidence = DEFAULT_CONFIDENCE,
): [number, number] | null {
  if (exposure <= 0 || !Number.isInteger(count) || count < 0) return null
  const tail = (1 - confidence) / 2
  // The Poisson CDF falls as its mean rises, so each bound is found by bisection.
  const solve = (k: number, target: number) => {
    const top = Math.max(10, k * 4 + 40)
    const search = (lo: number, hi: number, step: number): number => {
      if (step === 0) return (lo + hi) / 2
      const mid = (lo + hi) / 2
      return poissonCdf(k, mid) > target ? search(mid, hi, step - 1) : search(lo, mid, step - 1)
    }
    return search(0, top, 200)
  }
  const lower = count === 0 ? 0 : solve(count - 1, 1 - tail)
  return [lower / exposure, solve(count, tail) / exposure]
}

// Newcombe's hybrid score interval (method 10) for the difference of two paired proportions, candidate less baseline.
export function pairedDifference(
  pairs: readonly { candidate: boolean; baseline: boolean }[],
  confidence = DEFAULT_CONFIDENCE,
): { difference: number; interval: [number, number] } | null {
  const n = pairs.length
  if (!n) return null
  const both = pairs.filter((pair) => pair.candidate && pair.baseline).length
  const onlyCandidate = pairs.filter((pair) => pair.candidate && !pair.baseline).length
  const onlyBaseline = pairs.filter((pair) => !pair.candidate && pair.baseline).length
  const neither = n - both - onlyCandidate - onlyBaseline
  const p1 = (both + onlyCandidate) / n
  const p2 = (both + onlyBaseline) / n
  const [l1, u1] = wilson(both + onlyCandidate, n, confidence)!
  const [l2, u2] = wilson(both + onlyBaseline, n, confidence)!
  const margins = (both + onlyCandidate) * (onlyBaseline + neither) * (both + onlyBaseline) * (onlyCandidate + neither)
  const phi = margins === 0 ? 0 : (both * neither - onlyCandidate * onlyBaseline) / Math.sqrt(margins)
  const difference = p1 - p2
  const below = Math.sqrt(Math.max(0, (p1 - l1) ** 2 - 2 * phi * (p1 - l1) * (u2 - p2) + (u2 - p2) ** 2))
  const above = Math.sqrt(Math.max(0, (u1 - p1) ** 2 - 2 * phi * (u1 - p1) * (p2 - l2) + (p2 - l2) ** 2))
  return { difference, interval: [Math.max(-1, difference - below), Math.min(1, difference + above)] }
}

// Newcombe's hybrid score interval (method 10) for the difference of two independent proportions, a less b; null when
// either has nothing to count.
export function independentDifference(
  a: { count: number; total: number },
  b: { count: number; total: number },
  confidence = DEFAULT_CONFIDENCE,
): { difference: number; interval: [number, number] } | null {
  const first = wilson(a.count, a.total, confidence)
  const second = wilson(b.count, b.total, confidence)
  if (!first || !second) return null
  const p1 = a.count / a.total
  const p2 = b.count / b.total
  const difference = p1 - p2
  return {
    difference,
    interval: [
      Math.max(-1, difference - Math.sqrt((p1 - first[0]) ** 2 + (second[1] - p2) ** 2)),
      Math.min(1, difference + Math.sqrt((first[1] - p1) ** 2 + (p2 - second[0]) ** 2)),
    ],
  }
}

// Each severity's tally summed over runs: SEVERITIES first, each present though empty, then any other severity seen,
// sorted.
export function severityTallies(scores: readonly Pick<RunScore, "bySeverity">[]): Record<string, SeverityTally> {
  const known: readonly string[] = SEVERITIES
  const others = [...new Set(scores.flatMap((score) => Object.keys(score.bySeverity)))].filter(
    (severity) => !known.includes(severity),
  )
  return Object.fromEntries(
    [...known, ...others.toSorted()].map((severity) => {
      // Own keys only: a hand-edited artifact's severity, such as "constructor", is never read off the prototype.
      const tallies = scores.flatMap((score) =>
        Object.hasOwn(score.bySeverity, severity) ? [score.bySeverity[severity]] : [],
      )
      return [
        severity,
        {
          judged: sum(tallies.map((tally) => tally.judged)),
          real: sum(tallies.map((tally) => tally.real)),
          wouldBlock: sum(tallies.map((tally) => tally.wouldBlock)),
          important: sum(tallies.map((tally) => tally.important)),
          unsettled: sum(tallies.map((tally) => tally.unsettled)),
        } satisfies SeverityTally,
      ]
    }),
  )
}

export type StepTrend = "falling" | "flat" | "inverted" | "inconclusive"

export interface GradientStep {
  higher: string
  lower: string
  difference: number // the higher severity's share less the lower one's
  interval: [number, number]
  trend: StepTrend
}

export interface SeverityGradient {
  shares: Record<string, Proportion>
  steps: GradientStep[]
  trend: StepTrend | "n/a"
  flagged: boolean // flat or inverted
}

// A share by posted severity and how it moves from each severity to the next lower one, defined once for VS-45's
// would-block share and VS-46's outcome rates. `shares` lists every severity of `order` (SEVERITIES by default), empty
// ones included, then any other severity counted, sorted. A step runs between consecutive ordered severities that have
// something to count, so an empty one is skipped, and no other severity gets one. A step falls when its interval
// (independentDifference) is above 0, is inverted when it is below 0, is flat when it rules out a fall of `margin` or
// more, and is inconclusive otherwise, so a small sample reads as no evidence rather than as miscalibration. The
// gradient is inverted if any step is, else flat if any is, else inconclusive if any is, else falling, and n/a with no
// step. It is flagged when flat or inverted.
export function severityGradient(
  counts: Readonly<Record<string, { count: number; total: number }>>,
  options: { order?: readonly string[]; confidence?: number; margin?: number } = {},
): SeverityGradient {
  const order: readonly string[] = options.order ?? SEVERITIES
  const confidence = options.confidence ?? DEFAULT_CONFIDENCE
  const margin = options.margin ?? GRADIENT_MARGIN
  const counted = (name: string) => counts[name] ?? { count: 0, total: 0 }
  const names = [
    ...order,
    ...Object.keys(counts)
      .filter((name) => !order.includes(name))
      .toSorted(),
  ]
  const ranked = order.filter((name) => counted(name).total > 0)
  const steps = ranked.slice(1).flatMap((lower, index): GradientStep[] => {
    const higher = ranked[index]
    const step = independentDifference(counted(higher), counted(lower), confidence)
    if (!step) return []
    const [low, high] = step.interval
    const trend = low > 0 ? "falling" : high < 0 ? "inverted" : high < margin ? "flat" : "inconclusive"
    return [{ higher, lower, difference: step.difference, interval: step.interval, trend }]
  })
  const trend = steps.length
    ? ((["inverted", "flat", "inconclusive"] as const).find((value) => steps.some((step) => step.trend === value)) ??
      "falling")
    : "n/a"
  return {
    shares: Object.fromEntries(
      names.map((name) => [name, proportion(counted(name).count, counted(name).total, confidence)]),
    ),
    steps,
    trend,
    flagged: trend === "flat" || trend === "inverted",
  }
}

export interface KappaPart {
  findings: number // double-judged: two counted passes giving a match or an extra, each with its importance
  observed: number | null // the share whose two importances agree
  kappa: number | null // null with no finding, or when every rating has one value
  decision: "too-few" | "undefined" | "drop" | "keep"
}

export interface ImportanceAgreement {
  all: KappaPart // every pair, as VS-45 states the kill rule
  match: KappaPart // both passes match a labelled defect
  extra: KappaPart // every other pair: two extras, or a match and an extra
  // VS-45's kill rule over every pair, and also over each part with its own minimum: drop if the whole or either part
  // drops, else the first of too-few and undefined that any of the three has, else keep.
  decision: KappaPart["decision"]
}

// Inter-judge agreement on importance under the importance proposal: Fleiss' kappa for two ratings per finding, over
// IMPORTANCE. Per finding, the passes settle() would count (the proposal's, not stale, not the reviewer's own model),
// each judge once at its latest pass, in the order the judges first judged it; of those giving a match or an extra, the
// first two are its ratings. Fleiss' form, not Cohen's, because the two judges differ from finding to finding and their
// order is arbitrary. Matches and extras are also apart, so agreement on matches cannot carry an axis whose extras, the
// only findings with no label behind them, are judged inconsistently.
export function importanceAgreement(
  items: readonly { judgement: Pick<Judgement, "passes">; reviewed: readonly string[] }[],
  options: { rubric?: number } = {},
): ImportanceAgreement {
  const under = { rubric: options.rubric ?? RUBRIC_VERSION, proposal: IMPORTANCE_PROPOSAL }
  const pairs = items.flatMap((item) => {
    const counted = item.judgement.passes.filter((pass) => !passProblem(pass, under, item.reviewed))
    const real = [...new Map(counted.map((pass) => [pass.judge, pass])).values()].flatMap((pass) =>
      pass.importance && pass.verdict.kind !== "false-alarm"
        ? [{ kind: pass.verdict.kind, rating: pass.importance }]
        : [],
    )
    if (real.length < 2) return []
    return [
      {
        part: real[0].kind === "match" && real[1].kind === "match" ? "match" : "extra",
        ratings: [real[0].rating, real[1].rating] as const,
      },
    ]
  })
  const all = kappaPart(pairs.map((pair) => pair.ratings))
  const match = kappaPart(pairs.filter((pair) => pair.part === "match").map((pair) => pair.ratings))
  const extra = kappaPart(pairs.filter((pair) => pair.part === "extra").map((pair) => pair.ratings))
  const decisions = [all.decision, match.decision, extra.decision]
  return {
    all,
    match,
    extra,
    decision: (["drop", "too-few", "undefined"] as const).find((value) => decisions.includes(value)) ?? "keep",
  }
}

// Fleiss' kappa for two ratings per finding: observed agreement against the agreement the pooled shares of each value
// would give by chance.
function kappaPart(ratings: readonly (readonly [Importance, Importance])[]): KappaPart {
  const findings = ratings.length
  if (!findings) return { findings, observed: null, kappa: null, decision: "too-few" }
  const observed = ratings.filter((pair) => pair[0] === pair[1]).length / findings
  const expected = sum(
    IMPORTANCE.map(
      (value) => (sum(ratings.map((pair) => pair.filter((rating) => rating === value).length)) / (2 * findings)) ** 2,
    ),
  )
  const kappa = expected >= 1 ? null : (observed - expected) / (1 - expected)
  return {
    findings,
    observed,
    kappa,
    decision:
      findings < IMPORTANCE_MIN_FINDINGS
        ? "too-few"
        : kappa === null
          ? "undefined"
          : kappa < IMPORTANCE_MIN_KAPPA
            ? "drop"
            : "keep",
  }
}

export function proportion(count: number, total: number, confidence = DEFAULT_CONFIDENCE): Proportion {
  return { count, total, value: total > 0 ? count / total : null, interval: wilson(count, total, confidence) }
}

function rate(count: number, exposure: number, confidence: number): Rate {
  return {
    count,
    exposure,
    value: exposure > 0 ? count / exposure : null,
    interval: poissonInterval(count, exposure, confidence),
  }
}

// P(X <= k) for a Poisson mean, summed in log space so a large mean does not underflow its first term.
function poissonCdf(k: number, mean: number) {
  if (mean === 0) return 1
  const log = Math.log(mean)
  const total = Array.from({ length: k + 1 }).reduce<{ logFactorial: number; total: number }>(
    (acc, _, i) => {
      const logFactorial = acc.logFactorial + (i > 0 ? Math.log(i) : 0)
      return { logFactorial, total: acc.total + Math.exp(-mean + i * log - logFactorial) }
    },
    { logFactorial: 0, total: 0 },
  ).total
  return Math.min(1, total)
}

// The standard normal quantile, by Acklam's rational approximation (relative error below 1.2e-9).
function normalQuantile(p: number) {
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239,
  ]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const tail = (q: number) =>
    (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)))
  if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)))
  const q = p - 0.5
  const r = q * q
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  )
}

type Under = { rubric: number; proposal?: string }

function passProblem(pass: JudgePass, under: Under, reviewed: readonly string[]) {
  if (typeof pass.judge !== "string" || !/^(human|model):\S/.test(pass.judge))
    return `${String(pass.judge)} is not a human: or model: judge`
  if (pass.rubric !== under.rubric || pass.proposal !== under.proposal)
    return `${pass.judge} judged under ${rubricName(pass.rubric, pass.proposal)}, not ${staleAgainst(under, pass.proposal)}: the pass is stale`
  if (pass.judge.startsWith("model:") && reviewed.some((model) => sameModel(model, pass.judge.slice("model:".length))))
    return `${pass.judge} cannot judge findings its own model produced`
  return verdictProblem(pass, pass.judge, under.proposal)
}

function adjudicationProblem(adjudication: Adjudication, under: Under) {
  if (typeof adjudication.by !== "string" || !/^human:\S/.test(adjudication.by))
    return `the adjudication by ${String(adjudication.by)} is not a human's`
  if (typeof adjudication.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(adjudication.date))
    return `the adjudication by ${adjudication.by} has no YYYY-MM-DD date`
  if (adjudication.rubric !== under.rubric || adjudication.proposal !== under.proposal)
    return `the adjudication by ${adjudication.by} used ${rubricName(adjudication.rubric, adjudication.proposal)}, not ${staleAgainst(under, adjudication.proposal)}`
  return verdictProblem(adjudication, adjudication.by, under.proposal)
}

function verdictProblem(entry: { verdict: Verdict; importance?: unknown }, by: string, proposal?: string) {
  const verdict = entry.verdict
  const ok =
    !!verdict &&
    (verdict.kind === "false-alarm" ||
      (verdict.kind === "match" && typeof verdict.defect === "string" && verdict.defect.length > 0) ||
      (verdict.kind === "extra" && typeof verdict.issue === "string" && verdict.issue.trim().length > 0))
  if (!ok) return `${by} gave a verdict that is not a match with a defect, an extra with an issue or a false-alarm`
  const importance = importanceProblem(entry, proposal)
  return importance ? `${by}'s verdict ${importance}` : undefined
}

function sameVerdict(a: Verdict, b: Verdict) {
  if (a.kind === "match" && b.kind === "match") return a.defect === b.defect
  return a.kind === b.kind
}

function namespaced(verdict: Verdict, judge: string): Verdict {
  return verdict.kind === "extra" ? { kind: "extra", issue: `${judge}/${verdict.issue.trim()}` } : verdict
}

function near(finding: Pick<EvalFinding, "path" | "line" | "endLine">, location: DefectLocation, slack: number) {
  const a = span(finding)
  const b = span(location)
  return cleanPath(finding.path) === cleanPath(location.path) && a.start <= b.end + slack && a.end >= b.start - slack
}

function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

function sum(values: readonly number[]) {
  return values.reduce((total, value) => total + value, 0)
}

function span(range: { line: number; endLine?: number }) {
  return { start: range.line, end: Math.max(range.line, range.endLine ?? range.line) }
}

function cleanPath(path: string) {
  return path.trim().replace(/^(\.\/|\/)+/, "")
}
