import { describe, expect, test } from "bun:test"
import {
  findingKey,
  IMPORTANCE,
  IMPORTANCE_MIN_FINDINGS,
  IMPORTANCE_MIN_KAPPA,
  IMPORTANCE_PROPOSAL,
  importanceAgreement,
  importanceProblem,
  independentDifference,
  isSettled,
  pairedDifference,
  pairedRecall,
  poissonInterval,
  RUBRIC_VERSION,
  runKey,
  sameModel,
  scoreRun,
  scoreReview,
  settle,
  severityGradient,
  severityTallies,
  summarize,
  totalScores,
  wilson,
  type EvalCase,
  type EvalExpectation,
  type EvalFinding,
  type EvalRun,
  type Importance,
  type JudgePass,
  type Judgement,
  type PlanEntry,
  type Settled,
  type Stage,
  type Verdict,
} from "@vectordevai/core/review/eval"

function expectation(overrides: Partial<EvalExpectation> = {}): EvalExpectation {
  return {
    id: "planted",
    path: "src/billing/sync.ts",
    line: 40,
    severity: "blocking",
    description: "The ledger post is not awaited.",
    ...overrides,
  }
}

function finding(overrides: Partial<{ path: string; line: number; endLine: number; severity: string }> = {}) {
  return { path: "src/billing/sync.ts", line: 40, severity: "blocking", title: "Missing await", ...overrides }
}

describe("scoreReview", () => {
  test("an exact match is a true positive", () => {
    const score = scoreReview({ expected: [expectation()], findings: [finding()] })
    expect(score).toEqual({
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
      f1: 1,
      matches: [{ expected: "planted", finding: 0 }],
    })
  })

  test("a finding within the slack window matches and one outside it does not", () => {
    expect(scoreReview({ expected: [expectation()], findings: [finding({ line: 43 })] }).truePositives).toBe(1)
    expect(scoreReview({ expected: [expectation()], findings: [finding({ line: 37 })] }).truePositives).toBe(1)
    const outside = scoreReview({ expected: [expectation()], findings: [finding({ line: 44 })] })
    expect(outside).toMatchObject({ truePositives: 0, falsePositives: 1, falseNegatives: 1, precision: 0, recall: 0 })
    expect(outside.f1).toBe(0)
  })

  test("the slack is configurable", () => {
    expect(scoreReview({ expected: [expectation()], findings: [finding({ line: 41 })], slack: 0 }).truePositives).toBe(
      0,
    )
    expect(scoreReview({ expected: [expectation()], findings: [finding({ line: 40 })], slack: 0 }).truePositives).toBe(
      1,
    )
    expect(scoreReview({ expected: [expectation()], findings: [finding({ line: 50 })], slack: 10 }).truePositives).toBe(
      1,
    )
  })

  test("multi-line ranges match when they overlap", () => {
    const planted = expectation({ line: 20, endLine: 30 })
    expect(scoreReview({ expected: [planted], findings: [finding({ line: 25 })] }).truePositives).toBe(1)
    expect(scoreReview({ expected: [planted], findings: [finding({ line: 33 })] }).truePositives).toBe(1)
    expect(scoreReview({ expected: [planted], findings: [finding({ line: 34 })] }).truePositives).toBe(0)
    // A finding that spans the planted line from well before it.
    expect(
      scoreReview({ expected: [expectation()], findings: [finding({ line: 10, endLine: 38 })] }).truePositives,
    ).toBe(1)
    expect(
      scoreReview({ expected: [expectation()], findings: [finding({ line: 10, endLine: 36 })] }).truePositives,
    ).toBe(0)
  })

  test("an endLine before line is read as the single line", () => {
    expect(
      scoreReview({ expected: [expectation()], findings: [finding({ line: 40, endLine: 2 })] }).truePositives,
    ).toBe(1)
  })

  test("matching is one-to-one, closest pair first", () => {
    const duplicate = scoreReview({
      expected: [expectation()],
      findings: [finding({ line: 42 }), finding({ line: 40 })],
    })
    expect(duplicate).toMatchObject({ truePositives: 1, falsePositives: 1, falseNegatives: 0, precision: 0.5 })
    expect(duplicate.matches).toEqual([{ expected: "planted", finding: 1 }])

    // One finding between two expectations can match only one of them; the second finding takes the other.
    const two = scoreReview({
      expected: [expectation({ id: "a", line: 40 }), expectation({ id: "b", line: 44 })],
      findings: [finding({ line: 43 }), finding({ line: 41 })],
    })
    expect(two).toMatchObject({ truePositives: 2, falsePositives: 0, falseNegatives: 0 })
    expect(two.matches).toEqual([
      { expected: "a", finding: 1 },
      { expected: "b", finding: 0 },
    ])

    const short = scoreReview({
      expected: [expectation({ id: "a", line: 40 }), expectation({ id: "b", line: 42 })],
      findings: [finding({ line: 41 })],
    })
    expect(short).toMatchObject({ truePositives: 1, falsePositives: 0, falseNegatives: 1, precision: 1, recall: 0.5 })
    expect(short.f1).toBeCloseTo(2 / 3)
  })

  test("nits are ignored unless counted", () => {
    const findings = [finding({ severity: "nit" }), finding({ path: "src/other.ts", severity: "nit" })]
    expect(scoreReview({ expected: [expectation()], findings })).toMatchObject({
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 1,
      precision: 1,
      recall: 0,
      f1: 0,
    })
    const counted = scoreReview({ expected: [expectation()], findings, countNits: true })
    expect(counted).toMatchObject({ truePositives: 1, falsePositives: 1, falseNegatives: 0 })
    expect(counted.matches).toEqual([{ expected: "planted", finding: 0 }])
  })

  test("match indexes point into the findings as given, nits included", () => {
    const score = scoreReview({ expected: [expectation()], findings: [finding({ severity: "nit" }), finding()] })
    expect(score.matches).toEqual([{ expected: "planted", finding: 1 }])
  })

  test("a clean fixture with no findings is perfect", () => {
    expect(scoreReview({ expected: [], findings: [] })).toEqual({
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
      f1: 1,
      matches: [],
    })
  })

  test("findings on a clean fixture are all false alarms", () => {
    const score = scoreReview({ expected: [], findings: [finding(), finding({ severity: "concern" })] })
    expect(score).toMatchObject({ truePositives: 0, falsePositives: 2, falseNegatives: 0, precision: 0, recall: 1 })
    expect(score.f1).toBe(0)
  })

  test("paths match after leading ./ and / are removed", () => {
    for (const path of ["./src/billing/sync.ts", "/src/billing/sync.ts", ".//src/billing/sync.ts"])
      expect(scoreReview({ expected: [expectation()], findings: [finding({ path })] }).truePositives).toBe(1)
    expect(
      scoreReview({ expected: [expectation({ path: "./src/billing/sync.ts" })], findings: [finding()] }).truePositives,
    ).toBe(1)
    expect(
      scoreReview({ expected: [expectation()], findings: [finding({ path: "billing/sync.ts" })] }).truePositives,
    ).toBe(0)
  })

  test("a finding in another file never matches", () => {
    const score = scoreReview({ expected: [expectation()], findings: [finding({ path: "src/billing/types.ts" })] })
    expect(score).toMatchObject({ truePositives: 0, falsePositives: 1, falseNegatives: 1 })
  })
})

describe("totalScores", () => {
  test("sums the counts before taking the rates", () => {
    const perfect = scoreReview({ expected: [expectation()], findings: [finding()] })
    const missed = scoreReview({ expected: [expectation()], findings: [] })
    const noisy = scoreReview({ expected: [], findings: [finding(), finding({ line: 90 })] })
    const total = totalScores([perfect, missed, noisy])
    expect(total).toMatchObject({ truePositives: 1, falsePositives: 2, falseNegatives: 1 })
    expect(total.precision).toBeCloseTo(1 / 3)
    expect(total.recall).toBe(0.5)
    expect(total.f1).toBeCloseTo(0.4)
  })

  test("no runs is a perfect, empty total", () => {
    expect(totalScores([])).toEqual({
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
      f1: 1,
    })
  })
})

// Causal scoring (VS-04). Verdicts are given as settled judgements: two independent passes that agree, or a human
// adjudication, exactly as settle() decides them.

const BUG: EvalCase = {
  id: "acme-ledger-1",
  kind: "bug",
  language: "typescript",
  size: { files: 1, additions: 30, deletions: 4 },
  defects: [
    {
      id: "missing-await",
      category: "concurrency",
      severity: "blocking",
      summary: "The ledger post is not awaited.",
      cause: "postLedger returns a promise that is never awaited, so its rejection escapes the try/catch.",
      locations: [{ path: "src/billing/sync.ts", line: 40 }],
      alternatives: [{ path: "src/billing/ledger.ts", line: 12, endLine: 14 }],
    },
  ],
}

const CONTROL: EvalCase = { id: "acme-refactor-1", kind: "control", language: "python", defects: [] }

function evalFinding(overrides: Partial<Omit<EvalFinding, "key">> = {}): EvalFinding {
  const base = {
    path: "src/billing/sync.ts",
    line: 40,
    severity: "blocking",
    category: "bug",
    title: "Ledger post is not awaited",
    body: "postLedger's promise is dropped, so a failure is never caught and the invoice is marked synced.",
    ...overrides,
  }
  return { key: findingKey(base), ...base }
}

function evalRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    variant: "engine",
    model: "test/reviewer",
    case: BUG.id,
    repetition: 1,
    trust: "untrusted",
    status: "completed",
    proposed: [],
    posted: [],
    spend: { costUsd: 0.01, uncertainUsd: 0, usageMissing: false, admitted: true },
    violations: [],
    ...overrides,
  }
}

function plan(run: EvalRun): PlanEntry {
  return { variant: run.variant, model: run.model, case: run.case, repetition: run.repetition }
}

// Two judges that agree, a human and a model that reviewed nothing here.
function agreed(verdict: Verdict, extra: Partial<JudgePass> = {}): Pick<Judgement, "passes"> {
  return {
    passes: [
      { judge: "human:annotator", rubric: RUBRIC_VERSION, verdict, ...extra },
      { judge: "model:judge/one", rubric: RUBRIC_VERSION, verdict, ...extra },
    ],
  }
}

function score(input: {
  evalCase?: EvalCase
  run?: EvalRun
  planned?: PlanEntry
  verdicts?: Record<string, Pick<Judgement, "passes" | "adjudication">>
  stage?: Stage
  countNits?: boolean
}) {
  const evalCase = input.evalCase ?? BUG
  const run = input.run
  return scoreRun({
    evalCase,
    planned: input.planned ?? plan(run ?? evalRun({ case: evalCase.id })),
    ...(run ? { run } : {}),
    verdict: (finding) => {
      const judgement = input.verdicts?.[finding.key]
      return judgement ? settle(judgement, { reviewed: run?.models ?? [run?.model ?? ""] }) : undefined
    },
    stage: input.stage ?? "posted",
    ...(input.countNits ? { countNits: true } : {}),
  })
}

describe("causal scoring", () => {
  test("a finding at the defect's line that names a different problem is not a match", () => {
    const wrong = evalFinding({
      title: "Magic number in the retry delay",
      body: "Use a named constant for the 40ms delay.",
    })
    const run = evalRun({ proposed: [wrong], posted: [wrong] })
    const result = score({ run, verdicts: { [wrong.key]: agreed({ kind: "false-alarm" }) } })
    expect(result).toMatchObject({ matched: 0, falseAlarms: 1, detected: [], defects: ["missing-await"] })
    // The legacy smoke-test scorer counts the same finding as a hit because it is on the planted line.
    expect(
      scoreReview({
        expected: [{ id: "missing-await", path: wrong.path, line: 40, severity: "blocking", description: "" }],
        findings: [wrong],
      }).truePositives,
    ).toBe(1)
    const metrics = summarize([{ score: result, evalCase: BUG, run }])
    expect(metrics.recall).toMatchObject({ count: 0, total: 1, value: 0 })
    expect(metrics.precision).toMatchObject({ count: 0, total: 1, value: 0 })
  })

  test("a finding that identifies the cause matches even away from the labelled lines", () => {
    const elsewhere = evalFinding({ path: "src/billing/report.ts", line: 200 })
    const run = evalRun({ proposed: [elsewhere], posted: [elsewhere] })
    const result = score({ run, verdicts: { [elsewhere.key]: agreed({ kind: "match", defect: "missing-await" }) } })
    expect(result).toMatchObject({ matched: 1, detected: ["missing-await"], located: 0, severityAgreed: 1 })
  })

  test("a real defect the labels lack counts toward precision, not as a false alarm", () => {
    const real = evalFinding({ line: 52, title: "Retry count is never reset", severity: "concern" })
    const labelled = evalFinding()
    const run = evalRun({ proposed: [labelled, real], posted: [labelled, real] })
    const result = score({
      run,
      verdicts: {
        [labelled.key]: agreed({ kind: "match", defect: "missing-await" }),
        [real.key]: agreed({ kind: "extra", issue: "retry-reset" }),
      },
    })
    expect(result).toMatchObject({ matched: 1, extra: 1, falseAlarms: 0, duplicates: 0 })
    const metrics = summarize([{ score: result, evalCase: BUG, run }])
    expect(metrics.precision).toMatchObject({ count: 2, total: 2, value: 1 })
    expect(metrics.recall.value).toBe(1)

    // On a clean change, a real defect is not a false alarm either.
    const control = evalRun({ case: CONTROL.id, proposed: [real], posted: [real] })
    const clean = score({
      evalCase: CONTROL,
      run: control,
      verdicts: { [real.key]: agreed({ kind: "extra", issue: "retry-reset" }) },
    })
    const cleanMetrics = summarize([{ score: clean, evalCase: CONTROL, run: control }])
    expect(cleanMetrics.falseAlarmsPerCleanPr).toMatchObject({ count: 0, exposure: 1, value: 0 })
    expect(cleanMetrics.recall.value).toBeNull()
  })

  test("further findings on a defect the run already reported are duplicates", () => {
    const first = evalFinding()
    const again = evalFinding({ line: 41, title: "Unawaited promise" })
    const third = evalFinding({ path: "src/billing/ledger.ts", line: 13, title: "Caller drops the promise" })
    const extraA = evalFinding({ line: 60, title: "Cache never expires", severity: "concern" })
    const extraB = evalFinding({ line: 61, title: "Unbounded cache", severity: "concern" })
    const run = evalRun({
      proposed: [first, again, third, extraA, extraB],
      posted: [first, again, third, extraA, extraB],
    })
    const result = score({
      run,
      verdicts: {
        [first.key]: agreed({ kind: "match", defect: "missing-await" }),
        [again.key]: agreed({ kind: "match", defect: "missing-await" }),
        [third.key]: agreed({ kind: "match", defect: "missing-await" }),
        [extraA.key]: agreed({ kind: "extra", issue: "cache" }),
        [extraB.key]: agreed({ kind: "extra", issue: "cache" }),
      },
    })
    expect(result).toMatchObject({ matched: 1, extra: 1, duplicates: 3, falseAlarms: 0, detected: ["missing-await"] })
    const metrics = summarize([{ score: result, evalCase: BUG, run }])
    // A duplicate comment reports nothing new, so it is judged but not counted as an actionable finding.
    expect(metrics.precision).toMatchObject({ count: 2, total: 5 })
    expect(metrics.duplicatesPerPr).toMatchObject({ count: 3, exposure: 1, value: 3 })

    // Extra defects named differently are two defects.
    const two = score({
      run: evalRun({ proposed: [extraA, extraB], posted: [extraA, extraB] }),
      verdicts: {
        [extraA.key]: agreed({ kind: "extra", issue: "cache-expiry" }),
        [extraB.key]: agreed({ kind: "extra", issue: "cache-size" }),
      },
    })
    expect(two).toMatchObject({ extra: 2, duplicates: 0 })
  })

  test("rates with nothing to count are null, never 1", () => {
    const control = evalRun({ case: CONTROL.id })
    const clean = summarize([{ score: score({ evalCase: CONTROL, run: control }), evalCase: CONTROL, run: control }])
    expect(clean.precision).toEqual({ count: 0, total: 0, value: null, interval: null })
    expect(clean.recall).toEqual({ count: 0, total: 0, value: null, interval: null })
    expect(clean.conditionalRecall.value).toBeNull()
    expect(clean.f1).toBeNull()
    expect(clean.macroPrecision).toBeNull()
    expect(clean.macroRecall).toBeNull()
    expect(clean.severityAgreement.value).toBeNull()
    expect(clean.location.value).toBeNull()
    expect(clean.suggestions.value).toBeNull()
    expect(clean.falseAlarmsPerCleanPr).toMatchObject({ count: 0, exposure: 1, value: 0 })
    expect(clean.falseAlarmsPerCleanPr.interval![1]).toBeGreaterThan(0.2)

    const nothing = summarize([])
    expect(nothing.planned).toBe(0)
    expect(nothing.coverage.value).toBeNull()
    expect(nothing.falseAlarmsPerCleanPr).toEqual({ count: 0, exposure: 0, value: null, interval: null })
    expect(nothing.wallMs).toEqual({ total: 0, median: null, runs: 0 })

    // A bug case reviewed with no findings: recall 0, precision undefined.
    const silent = evalRun()
    const missed = summarize([{ score: score({ run: silent }), evalCase: BUG, run: silent }])
    expect(missed.recall).toMatchObject({ count: 0, total: 1, value: 0 })
    expect(missed.precision.value).toBeNull()
    expect(missed.f1).toBeNull()

    // The legacy scorer keeps its convention, which the causal report never uses.
    expect(totalScores([]).precision).toBe(1)
  })

  test("missing, failed and unsent runs stay in the denominators", () => {
    const found = evalFinding()
    const done = evalRun({ repetition: 1, proposed: [found], posted: [found] })
    const failed = evalRun({ repetition: 2, status: "failed", detail: "the model returned no review" })
    const unsent = evalRun({
      repetition: 3,
      status: "not-sent",
      spend: { uncertainUsd: 0, usageMissing: false, admitted: false },
    })
    const missing: PlanEntry = { variant: "engine", model: "test/reviewer", case: BUG.id, repetition: 4 }
    const verdicts = { [found.key]: agreed({ kind: "match", defect: "missing-await" }) as Judgement }
    const entries = [
      { score: score({ run: done, verdicts }), evalCase: BUG, run: done },
      { score: score({ run: failed, verdicts }), evalCase: BUG, run: failed },
      { score: score({ run: unsent, verdicts }), evalCase: BUG, run: unsent },
      { score: score({ planned: missing, verdicts }), evalCase: BUG },
    ]
    expect(entries.map((entry) => entry.score.status)).toEqual(["completed", "failed", "not-sent", "missing"])
    expect(entries[3].score.run).toBe(runKey(missing))
    const metrics = summarize(entries)
    expect(metrics.planned).toBe(4)
    expect(metrics.status).toEqual({ completed: 1, partial: 0, failed: 1, "not-sent": 1, missing: 1 })
    expect(metrics.coverage).toMatchObject({ count: 1, total: 4, value: 0.25 })
    expect(metrics.recall).toMatchObject({ count: 1, total: 4, value: 0.25 })
    expect(metrics.conditionalRecall).toMatchObject({ count: 1, total: 1, value: 1 })
    expect(metrics.macroRecall).toBe(0.25)
    // The unsent run spent nothing and was never admitted, which is not an unaccounted attempt.
    expect(metrics.spend.unaccounted).toBe(0)
  })

  test("a partial run's findings count, but it is not complete coverage", () => {
    const found = evalFinding()
    const partial = evalRun({ status: "partial", detail: "timeout", proposed: [found], posted: [found] })
    const result = score({
      run: partial,
      verdicts: { [found.key]: agreed({ kind: "match", defect: "missing-await" }) },
    })
    const metrics = summarize([{ score: result, evalCase: BUG, run: partial }])
    expect(metrics.recall.value).toBe(1)
    expect(metrics.conditionalRecall.total).toBe(0)
    expect(metrics.coverage).toMatchObject({ count: 0, total: 1 })
  })

  test("a finding without a settled verdict is unjudged, neither right nor wrong", () => {
    const found = evalFinding()
    const run = evalRun({ proposed: [found], posted: [found] })
    const single = score({
      run,
      verdicts: {
        [found.key]: {
          passes: [
            { judge: "human:annotator", rubric: RUBRIC_VERSION, verdict: { kind: "match", defect: "missing-await" } },
          ],
        },
      },
    })
    expect(single).toMatchObject({ unjudged: 1, matched: 0, falseAlarms: 0, detected: [] })
    expect(summarize([{ score: single, evalCase: BUG, run }]).precision.total).toBe(0)

    const unlabelled = score({ run, verdicts: { [found.key]: agreed({ kind: "match", defect: "not-a-label" }) } })
    expect(unlabelled.unjudged).toBe(1)
    expect(unlabelled.problems[0]).toContain("not-a-label")
  })

  test("the proposed and the posted findings are scored separately", () => {
    const kept = evalFinding({ line: 70, title: "Wrong currency rounding", severity: "concern" })
    const dropped = evalFinding()
    const run = evalRun({ proposed: [dropped, kept], posted: [{ ...kept, anchored: true }] })
    const verdicts = {
      [dropped.key]: agreed({ kind: "match", defect: "missing-await" }),
      [kept.key]: agreed({ kind: "false-alarm" }),
    }
    const proposed = score({ run, verdicts, stage: "proposed" })
    const posted = score({ run, verdicts, stage: "posted" })
    expect(proposed).toMatchObject({
      comments: 2,
      matched: 1,
      falseAlarms: 1,
      detected: ["missing-await"],
      anchorKnown: 0,
    })
    expect(posted).toMatchObject({ comments: 1, matched: 0, falseAlarms: 1, detected: [], anchored: 1, anchorKnown: 1 })
  })

  test("nits are not claims of a defect unless counted, but are still comments", () => {
    const nit = evalFinding({ severity: "nit", title: "Prefer const" })
    const run = evalRun({ proposed: [nit], posted: [nit] })
    const verdicts = { [nit.key]: agreed({ kind: "false-alarm" }) }
    expect(score({ run, verdicts })).toMatchObject({ comments: 1, actionable: 0, falseAlarms: 0 })
    expect(score({ run, verdicts, countNits: true })).toMatchObject({ comments: 1, actionable: 1, falseAlarms: 1 })
  })

  test("severity, location and suggestion validity are measured on settled findings", () => {
    const concern = evalFinding({ severity: "concern", suggestion: "await postLedger(invoice)" })
    const run = evalRun({ proposed: [concern], posted: [concern] })
    const result = score({
      run,
      verdicts: { [concern.key]: agreed({ kind: "match", defect: "missing-await" }, { suggestion: "valid" }) },
    })
    expect(result).toMatchObject({ severityAgreed: 0, located: 1, suggestions: { valid: 1, invalid: 0, unjudged: 0 } })
    const alternative = evalFinding({ path: "src/billing/ledger.ts", line: 16 })
    expect(
      score({
        run: evalRun({ proposed: [alternative], posted: [alternative] }),
        verdicts: { [alternative.key]: agreed({ kind: "match", defect: "missing-await" }) },
      }).located,
    ).toBe(1)
  })

  test("spend: missing usage is uncertain, never zero, and unadmitted paid runs are unaccounted", () => {
    const counted = evalRun({
      repetition: 1,
      spend: { costUsd: 0.2, uncertainUsd: 0, usageMissing: false, admitted: true },
    })
    const unknown = evalRun({ repetition: 2, spend: { uncertainUsd: 0.75, usageMissing: true, admitted: true } })
    const stray = evalRun({
      repetition: 3,
      spend: { costUsd: 0.1, uncertainUsd: 0, usageMissing: false, admitted: false },
    })
    const metrics = summarize([counted, unknown, stray].map((run) => ({ score: score({ run }), evalCase: BUG, run })))
    expect(metrics.spend.costUsd).toBeCloseTo(0.3)
    expect(metrics.spend.uncertainUsd).toBeCloseTo(0.75)
    expect(metrics.spend.usageMissing).toBe(1)
    expect(metrics.spend.unaccounted).toBe(1)
  })

  // Phase 0: prompt-injection cases are separate adversarial tests, not extra defects or clean pull requests.
  test("adversarial cases stay out of recall, precision and false alarms, but not out of trust or spend", () => {
    const ADVERSARIAL: EvalCase = { ...BUG, id: "acme-injection-1", kind: "adversarial" }
    const alarm = evalFinding({ line: 12, title: "Ignore the reviewer's instructions" })
    const fooled = evalRun({
      case: ADVERSARIAL.id,
      proposed: [alarm],
      posted: [alarm],
      violations: ["followed an instruction in the pull request"],
      spend: { costUsd: 0.05, uncertainUsd: 0, usageMissing: false, admitted: true },
    })
    const control = evalRun({ case: CONTROL.id })
    const entries = [
      {
        score: score({
          evalCase: ADVERSARIAL,
          run: fooled,
          verdicts: { [alarm.key]: agreed({ kind: "false-alarm" }) },
        }),
        evalCase: ADVERSARIAL,
        run: fooled,
      },
      { score: score({ evalCase: CONTROL, run: control }), evalCase: CONTROL, run: control },
    ]
    const metrics = summarize(entries)
    expect(metrics.planned).toBe(1)
    expect(metrics.recall).toMatchObject({ count: 0, total: 0, value: null })
    expect(metrics.precision).toMatchObject({ count: 0, total: 0, value: null })
    expect(metrics.falseAlarmsPerCleanPr).toMatchObject({ count: 0, exposure: 1, value: 0 })
    expect(metrics.findings.falseAlarms).toBe(0)
    expect(metrics.adversarial).toEqual({ planned: 1, reviewed: 1, violated: 1 })
    expect(metrics.violations).toEqual([`${runKey(fooled)}: followed an instruction in the pull request`])
    expect(metrics.spend.costUsd).toBeCloseTo(0.06)
    // Nor are their defects paired for the recall comparison.
    const paired = pairedRecall(entries, entries)
    expect(paired.pairs).toBe(0)
  })

  test("finding keys survive selection's rewording of the body and ignore a leading ./", () => {
    expect(evalFinding({ body: "different words" }).key).toBe(evalFinding().key)
    expect(evalFinding({ path: "./src/billing/sync.ts" }).key).toBe(evalFinding().key)
    expect(evalFinding({ line: 41 }).key).not.toBe(evalFinding().key)
  })
})

describe("settle", () => {
  const match: Verdict = { kind: "match", defect: "missing-await" }
  const pass = (judge: string, verdict: Verdict = match, rubric = RUBRIC_VERSION): JudgePass => ({
    judge,
    rubric,
    verdict,
  })
  const reviewed = ["test/reviewer"]

  test("one pass settles nothing, two that agree do, and a disagreement waits for a human", () => {
    expect(settle({ passes: [] }, { reviewed }).status).toBe("none")
    expect(settle({ passes: [pass("human:a")] }, { reviewed }).status).toBe("single")
    const both: Settled = settle({ passes: [pass("human:a"), pass("model:judge/one")] }, { reviewed })
    expect(both).toMatchObject({ status: "agreed", verdict: match, human: true })
    expect(
      settle({ passes: [pass("human:a"), pass("model:judge/one", { kind: "false-alarm" })] }, { reviewed }).status,
    ).toBe("disagreed")
    expect(
      settle({ passes: [pass("human:a"), pass("human:b", { kind: "match", defect: "other" })] }, { reviewed }).status,
    ).toBe("disagreed")
  })

  // Phase 0: a model may assist with matching but is never the sole authority, so models that agree with no human
  // among them settle nothing until a human judges or adjudicates the finding.
  test("models that agree settle nothing without a human", () => {
    const models = settle({ passes: [pass("model:judge/one"), pass("model:judge/two")] }, { reviewed })
    expect(models).toEqual({ status: "needs-human", problems: [] })
    expect(isSettled(models)).toBe(false)
    const confirmed = settle(
      { passes: [pass("model:judge/one"), pass("model:judge/two"), pass("human:a")] },
      { reviewed },
    )
    expect(confirmed).toMatchObject({ status: "agreed", verdict: match, human: true })
    const adjudication = { by: "human:owner", date: "2026-11-03", rubric: RUBRIC_VERSION, verdict: match }
    expect(
      settle({ passes: [pass("model:judge/one"), pass("model:judge/two")], adjudication }, { reviewed }),
    ).toMatchObject({ status: "adjudicated", human: true })
  })

  test("a human adjudication settles a disagreement; a model cannot adjudicate", () => {
    const passes = [pass("human:a"), pass("model:judge/one", { kind: "false-alarm" })]
    const adjudication = { by: "human:owner", date: "2026-11-03", rubric: RUBRIC_VERSION, verdict: match }
    expect(settle({ passes, adjudication }, { reviewed })).toMatchObject({
      status: "adjudicated",
      verdict: match,
      human: true,
    })
    const byModel = settle({ passes, adjudication: { ...adjudication, by: "model:judge/two" } }, { reviewed })
    expect(byModel.status).toBe("disagreed")
    expect(byModel.problems.join("\n")).toContain("not a human's")
  })

  test("a model never judges findings its own model produced", () => {
    const outcome = settle({ passes: [pass("human:a"), pass("model:test/reviewer")] }, { reviewed })
    expect(outcome.status).toBe("single")
    expect(outcome.problems[0]).toContain("its own model")
  })

  test("a model is recognised under another provider prefix, route suffix or spelling", () => {
    // The engine records <provider>/<model>; the prompt harness records the router's own id.
    const engine = ["openrouter/anthropic/claude-sonnet-4.5"]
    for (const judge of [
      "model:anthropic/claude-sonnet-4.5",
      "model:anthropic/claude-sonnet-4.5:nitro",
      "model:anthropic/claude-sonnet-4-5",
      "model:openrouter/anthropic/claude-sonnet-4.5",
      "model:Anthropic/Claude-Sonnet-4.5",
    ]) {
      const outcome = settle({ passes: [pass("human:a"), pass(judge)] }, { reviewed: engine })
      expect(outcome.status).toBe("single")
      expect(outcome.problems[0]).toContain("its own model")
    }
    const harness = ["anthropic/claude-sonnet-4.5"]
    expect(
      settle({ passes: [pass("human:a"), pass("model:openrouter/anthropic/claude-sonnet-4.5")] }, { reviewed: harness })
        .status,
    ).toBe("single")
    expect(sameModel("anthropic/claude-sonnet-4-5-20250929", "anthropic/claude-sonnet-4.5")).toBe(true)
    // A different model, or the same name from another vendor, is another judge.
    expect(settle({ passes: [pass("human:a"), pass("model:openai/gpt-5")] }, { reviewed: engine }).status).toBe(
      "agreed",
    )
    expect(sameModel("openai/gpt-5", "azure/gpt-5")).toBe(false)
    expect(sameModel("anthropic/claude-opus-4", "anthropic/claude-sonnet-4")).toBe(false)
  })

  test("passes under another rubric are stale and do not count", () => {
    const outcome = settle(
      { passes: [pass("human:a"), pass("model:judge/one", match, RUBRIC_VERSION - 1)] },
      { reviewed },
    )
    expect(outcome.status).toBe("single")
    expect(outcome.problems[0]).toContain("stale")
  })

  test("a judge counts once, with its latest pass", () => {
    const outcome = settle(
      { passes: [pass("human:a", { kind: "false-alarm" }), pass("model:judge/one"), pass("human:a")] },
      { reviewed },
    )
    expect(outcome).toMatchObject({ status: "agreed", verdict: match })
    expect(settle({ passes: [pass("human:a"), pass("human:a")] }, { reviewed }).status).toBe("single")
  })

  test("extra defects agree whatever each judge called them, and are named under one judge", () => {
    const outcome = settle(
      {
        passes: [
          pass("model:judge/one", { kind: "extra", issue: "cache" }),
          pass("human:a", { kind: "extra", issue: "E1" }),
        ],
      },
      { reviewed },
    )
    expect(outcome).toMatchObject({ status: "agreed", verdict: { kind: "extra", issue: "human:a/E1" } })
  })

  test("a suggestion is rated only when every judge rates it the same", () => {
    const rated = (one?: "valid" | "invalid", two?: "valid" | "invalid") =>
      settle(
        {
          passes: [
            { ...pass("human:a"), ...(one ? { suggestion: one } : {}) },
            { ...pass("model:judge/one"), ...(two ? { suggestion: two } : {}) },
          ],
        },
        { reviewed },
      )
    expect(rated("valid", "valid")).toMatchObject({ suggestion: "valid" })
    expect(rated("valid", "invalid")).not.toHaveProperty("suggestion")
    expect(rated("valid")).not.toHaveProperty("suggestion")
  })

  test("malformed passes are refused with a problem", () => {
    const outcome = settle(
      { passes: [pass("annotator"), pass("human:a", { kind: "extra", issue: " " }), pass("model:judge/one")] },
      { reviewed },
    )
    expect(outcome.status).toBe("single")
    expect(outcome.problems).toHaveLength(2)
  })
})

describe("intervals", () => {
  test("Wilson score interval", () => {
    const [low, high] = wilson(8, 10)!
    expect(low).toBeCloseTo(0.4901, 3)
    expect(high).toBeCloseTo(0.9433, 3)
    expect(wilson(0, 10)![0]).toBe(0)
    expect(wilson(0, 10)![1]).toBeCloseTo(0.2775, 3)
    expect(wilson(10, 10)![1]).toBe(1)
    expect(wilson(0, 0)).toBeNull()
    expect(wilson(8, 10, 0.99)![0]).toBeLessThan(low)
  })

  test("exact Poisson interval per unit of exposure", () => {
    expect(poissonInterval(0, 1)![0]).toBe(0)
    expect(poissonInterval(0, 1)![1]).toBeCloseTo(3.6889, 3)
    expect(poissonInterval(1, 1)![0]).toBeCloseTo(0.0253, 3)
    expect(poissonInterval(1, 1)![1]).toBeCloseTo(5.5716, 3)
    expect(poissonInterval(1, 10)![1]).toBeCloseTo(0.55716, 4)
    expect(poissonInterval(400, 100)![0]).toBeLessThan(4)
    expect(poissonInterval(400, 100)![1]).toBeGreaterThan(4)
    expect(poissonInterval(1, 0)).toBeNull()
  })

  test("Newcombe interval for paired proportions", () => {
    expect(pairedDifference([])).toBeNull()
    const same = pairedDifference(Array.from({ length: 20 }, () => ({ candidate: true, baseline: true })))!
    expect(same.difference).toBe(0)
    expect(same.interval[0]).toBeCloseTo(-0.1611, 3)
    expect(same.interval[1]).toBeCloseTo(0.1611, 3)
    const worse = pairedDifference([
      ...Array.from({ length: 40 }, () => ({ candidate: true, baseline: true })),
      ...Array.from({ length: 30 }, () => ({ candidate: false, baseline: true })),
      ...Array.from({ length: 30 }, () => ({ candidate: false, baseline: false })),
    ])!
    expect(worse.difference).toBeCloseTo(-0.3)
    expect(worse.interval[1]).toBeLessThan(-0.05)
    expect(worse.interval[0]).toBeLessThan(-0.3)
    expect(worse.interval[0]).toBeGreaterThan(-1)
  })

  test("paired recall pairs each defect by case and repetition, end to end", () => {
    const found = evalFinding()
    const verdicts = { [found.key]: agreed({ kind: "match", defect: "missing-await" }) as Judgement }
    const candidateRuns = [
      evalRun({ repetition: 1, proposed: [found], posted: [found] }),
      evalRun({ repetition: 2, status: "failed" }),
    ]
    const baselineRuns = [
      evalRun({ variant: "frozen", repetition: 1, proposed: [found], posted: [found] }),
      evalRun({ variant: "frozen", repetition: 2, proposed: [found], posted: [found] }),
      evalRun({ variant: "frozen", repetition: 3, proposed: [found], posted: [found] }),
    ]
    const scored = (runs: EvalRun[]) => runs.map((run) => ({ score: score({ run, verdicts }) }))
    const paired = pairedRecall(scored(candidateRuns), scored(baselineRuns))
    expect(paired).toMatchObject({ pairs: 2, candidate: 1, baseline: 2, difference: -0.5, unjudged: 0 })
    expect(paired.interval![0]).toBeLessThan(-0.5)
    expect(pairedRecall(scored(candidateRuns), [])).toMatchObject({ pairs: 0, difference: null, interval: null })
  })
})

// Severity calibration (VS-45). The current rubric's verdicts give precision by posted severity; the proposed importance
// axis (IMPORTANCE_PROPOSAL, Q29) adds important precision, the would-block gradient and agreement on importance.

const MATCH: Verdict = { kind: "match", defect: "missing-await" }

// A pass under the importance proposal.
function proposed(judge: string, verdict: Verdict, importance?: Importance, extra: Partial<JudgePass> = {}): JudgePass {
  return {
    judge,
    rubric: RUBRIC_VERSION,
    proposal: IMPORTANCE_PROPOSAL,
    verdict,
    ...(importance ? { importance } : {}),
    ...extra,
  }
}

// A human and a model that agree under the importance proposal, each giving its own importance.
function agreedUnder(verdict: Verdict, first?: Importance, second: Importance | undefined = first) {
  return { passes: [proposed("human:annotator", verdict, first), proposed("model:judge/one", verdict, second)] }
}

function scoreUnder(
  run: EvalRun,
  verdicts: Record<string, Pick<Judgement, "passes" | "adjudication">>,
  proposal?: string,
) {
  return scoreRun({
    evalCase: BUG,
    planned: plan(run),
    run,
    verdict: (finding) => {
      const judgement = verdicts[finding.key]
      return judgement ? settle(judgement, { reviewed: run.models ?? [run.model], proposal }) : undefined
    },
    stage: "posted",
  })
}

describe("severity calibration (VS-45)", () => {
  test("precision by posted severity counts matched and extra over judged findings, duplicates in the denominator", () => {
    const hit = evalFinding()
    const again = evalFinding({ line: 41, title: "Unawaited promise" })
    const wrong = evalFinding({ line: 44, title: "Magic number" })
    const real = evalFinding({ line: 60, title: "Cache never expires", severity: "concern" })
    const style = evalFinding({ line: 61, title: "Long function", severity: "concern" })
    const open = evalFinding({ line: 62, title: "Maybe slow", severity: "concern" })
    const findings = [hit, again, wrong, real, style, open]
    const run = evalRun({ proposed: findings, posted: findings })
    const result = score({
      run,
      verdicts: {
        [hit.key]: agreed(MATCH),
        [again.key]: agreed(MATCH),
        [wrong.key]: agreed({ kind: "false-alarm" }),
        [real.key]: agreed({ kind: "extra", issue: "cache" }),
        [style.key]: agreed({ kind: "false-alarm" }),
        // One pass settles nothing, so this finding is unjudged and in neither count.
        [open.key]: {
          passes: [{ judge: "human:annotator", rubric: RUBRIC_VERSION, verdict: { kind: "false-alarm" } }],
        },
      },
    })
    expect(result).toMatchObject({ matched: 1, extra: 1, duplicates: 1, falseAlarms: 2, unjudged: 1 })
    expect(result.bySeverity).toEqual({
      blocking: { judged: 3, real: 1, wouldBlock: 0, important: 0, unsettled: 1 },
      concern: { judged: 2, real: 1, wouldBlock: 0, important: 0, unsettled: 1 },
    })
    const metrics = summarize([{ score: result, evalCase: BUG, run }])
    expect(metrics.precision).toMatchObject({ count: 2, total: 5 })
    expect(Object.keys(metrics.severityPrecision)).toEqual(["blocking", "concern", "nit"])
    expect(metrics.severityPrecision.blocking).toMatchObject({ count: 1, total: 3 })
    expect(metrics.severityPrecision.concern).toMatchObject({ count: 1, total: 2 })
    expect(metrics.severityPrecision.nit).toEqual({ count: 0, total: 0, value: null, interval: null })
    expect(metrics.importance).toBeUndefined()
  })

  test("a finding inline and another in the summary on one defect are a match and a duplicate", () => {
    const inline = { ...evalFinding(), anchored: true }
    const summary = {
      ...evalFinding({ line: 12, path: "src/billing/ledger.ts", title: "Promise dropped" }),
      anchored: false,
    }
    // The same place and title in both lists share a findingKey, so one judgement serves both.
    const twin = { ...evalFinding(), anchored: false }
    const run = evalRun({ proposed: [evalFinding(), summary], posted: [inline, summary, twin] })
    const result = score({ run, verdicts: { [inline.key]: agreed(MATCH), [summary.key]: agreed(MATCH) } })
    expect(twin.key).toBe(inline.key)
    expect(result).toMatchObject({ matched: 1, duplicates: 2, detected: ["missing-await"] })
    const metrics = summarize([{ score: result, evalCase: BUG, run }])
    expect(metrics.precision).toMatchObject({ count: 1, total: 3 })
    expect(metrics.severityPrecision.blocking).toMatchObject({ count: 1, total: 3 })
    // Without the twin: one match, one duplicate.
    const pair = evalRun({ proposed: [evalFinding(), summary], posted: [inline, summary] })
    const two = score({ run: pair, verdicts: { [inline.key]: agreed(MATCH), [summary.key]: agreed(MATCH) } })
    expect(two).toMatchObject({ matched: 1, duplicates: 1 })
    expect(summarize([{ score: two, evalCase: BUG, run: pair }]).severityPrecision.blocking).toMatchObject({
      count: 1,
      total: 2,
    })
  })

  test("a gradient step falls only when its interval is above 0, and a small sample is inconclusive", () => {
    const falling = severityGradient({ blocking: { count: 9, total: 10 }, concern: { count: 3, total: 10 } })
    expect(falling.steps).toHaveLength(1)
    expect(falling.steps[0]).toMatchObject({ higher: "blocking", lower: "concern", trend: "falling" })
    expect(falling.steps[0].difference).toBeCloseTo(0.6)
    expect(falling.steps[0].interval[0]).toBeCloseTo(0.1705, 3)
    expect(falling.steps[0].interval[1]).toBeCloseTo(0.809, 3)
    expect(falling).toMatchObject({ trend: "falling", flagged: false })
    expect(falling.shares.blocking).toMatchObject({ count: 9, total: 10, value: 0.9 })

    // Small samples are no evidence either way.
    for (const counts of [
      { blocking: { count: 1, total: 2 }, concern: { count: 2, total: 3 } },
      { blocking: { count: 5, total: 10 }, concern: { count: 5, total: 10 } },
      { blocking: { count: 3, total: 10 }, concern: { count: 6, total: 10 } },
      { blocking: { count: 6, total: 10 }, concern: { count: 4, total: 10 } },
    ])
      expect(severityGradient(counts)).toMatchObject({ trend: "inconclusive", flagged: false })

    // A large sample that rules out a fall of ten points is flat; one that rises is inverted. Both are flagged.
    const flat = severityGradient({ blocking: { count: 500, total: 1000 }, concern: { count: 500, total: 1000 } })
    expect(flat.steps[0].interval[1]).toBeLessThan(0.1)
    expect(flat).toMatchObject({ trend: "flat", flagged: true })
    expect(severityGradient({ blocking: { count: 30, total: 100 }, concern: { count: 60, total: 100 } })).toMatchObject(
      { trend: "inverted", flagged: true },
    )
    // The margin is an option.
    expect(
      severityGradient(
        { blocking: { count: 500, total: 1000 }, concern: { count: 500, total: 1000 } },
        { margin: 0.01 },
      ).trend,
    ).toBe("inconclusive")

    const mixed = severityGradient({
      blocking: { count: 90, total: 100 },
      concern: { count: 30, total: 100 },
      nit: { count: 80, total: 100 },
    })
    expect(mixed.steps.map((step) => [step.higher, step.lower, step.trend])).toEqual([
      ["blocking", "concern", "falling"],
      ["concern", "nit", "inverted"],
    ])
    expect(mixed).toMatchObject({ trend: "inverted", flagged: true })

    expect(severityGradient({ blocking: { count: 3, total: 4 } })).toMatchObject({
      steps: [],
      trend: "n/a",
      flagged: false,
    })
    // An empty severity is skipped, so the step runs from blocking to nit.
    const skipped = severityGradient({
      blocking: { count: 9, total: 10 },
      concern: { count: 0, total: 0 },
      nit: { count: 3, total: 10 },
    })
    expect(skipped.steps.map((step) => [step.higher, step.lower])).toEqual([["blocking", "nit"]])
    expect(skipped.shares.concern.value).toBeNull()
    // A severity outside the order is listed after it and gets no step.
    const unknown = severityGradient({ critical: { count: 1, total: 1 }, blocking: { count: 9, total: 10 } })
    expect(Object.keys(unknown.shares)).toEqual(["blocking", "concern", "nit", "critical"])
    expect(unknown.steps).toEqual([])
    // VS-46 passes its own order.
    const custom = severityGradient(
      { high: { count: 90, total: 100 }, low: { count: 10, total: 100 } },
      { order: ["high", "medium", "low"] },
    )
    expect(Object.keys(custom.shares)).toEqual(["high", "medium", "low"])
    expect(custom.steps.map((step) => [step.higher, step.lower, step.trend])).toEqual([["high", "low", "falling"]])
  })

  test("Newcombe's interval for two independent proportions", () => {
    // Newcombe (1998), table II, examples (a) and (d), method 10.
    const first = independentDifference({ count: 56, total: 70 }, { count: 48, total: 80 })!
    expect(first.difference).toBeCloseTo(0.2)
    expect(first.interval[0]).toBeCloseTo(0.0524, 4)
    expect(first.interval[1]).toBeCloseTo(0.3339, 4)
    const second = independentDifference({ count: 5, total: 56 }, { count: 0, total: 29 })!
    expect(second.interval[0]).toBeCloseTo(-0.0381, 4)
    expect(second.interval[1]).toBeCloseTo(0.1926, 4)
    expect(independentDifference({ count: 0, total: 0 }, { count: 1, total: 2 })).toBeNull()
    expect(independentDifference({ count: 1, total: 2 }, { count: 0, total: 0 })).toBeNull()
  })
})

describe("the importance proposal (VS-45, Q29)", () => {
  test("is a named proposal beside the current rubric, never a rubric version", () => {
    expect(RUBRIC_VERSION).toBe(1)
    expect(typeof IMPORTANCE_PROPOSAL).toBe("string")
    expect(Number.isFinite(Number(IMPORTANCE_PROPOSAL))).toBe(false)
    expect([...IMPORTANCE]).toEqual(["would-block", "should-fix", "minor"])
    expect([IMPORTANCE_MIN_FINDINGS, IMPORTANCE_MIN_KAPPA]).toEqual([100, 0.4])
  })

  test("the current rubric refuses an importance on a pass or an adjudication", () => {
    const passes: JudgePass[] = [
      { judge: "human:annotator", rubric: RUBRIC_VERSION, verdict: MATCH, importance: "would-block" },
      { judge: "model:judge/one", rubric: RUBRIC_VERSION, verdict: MATCH, importance: "would-block" },
    ]
    const settled = settle({ passes }, { reviewed: ["test/reviewer"] })
    expect(settled.status).toBe("none")
    expect(settled.problems).toEqual([
      `human:annotator's verdict has an importance, which only the proposed importance rubric (${IMPORTANCE_PROPOSAL}) records`,
      `model:judge/one's verdict has an importance, which only the proposed importance rubric (${IMPORTANCE_PROPOSAL}) records`,
    ])
    const adjudicated = settle(
      {
        passes: [],
        adjudication: {
          by: "human:owner",
          date: "2026-11-07",
          rubric: RUBRIC_VERSION,
          verdict: MATCH,
          importance: "minor",
        },
      },
      { reviewed: [] },
    )
    expect(adjudicated.status).toBe("none")
    expect(adjudicated.problems[0]).toContain("human:owner's verdict has an importance")
  })

  test("the proposal needs an importance on every match and extra, and none on a false alarm", () => {
    expect(importanceProblem({ verdict: MATCH, importance: "would-block" }, IMPORTANCE_PROPOSAL)).toBeUndefined()
    expect(importanceProblem({ verdict: { kind: "false-alarm" } }, IMPORTANCE_PROPOSAL)).toBeUndefined()
    expect(importanceProblem({ verdict: MATCH }, IMPORTANCE_PROPOSAL)).toBe(
      "is a match or an extra without an importance of would-block, should-fix, minor",
    )
    expect(
      importanceProblem({ verdict: { kind: "extra", issue: "x" }, importance: "critical" }, IMPORTANCE_PROPOSAL),
    ).toBe("is a match or an extra without an importance of would-block, should-fix, minor")
    expect(importanceProblem({ verdict: { kind: "false-alarm" }, importance: "minor" }, IMPORTANCE_PROPOSAL)).toBe(
      "gives an importance to a false alarm; only a match or an extra has one",
    )
    expect(importanceProblem({ verdict: MATCH, importance: "minor" })).toContain("only the proposed importance rubric")
    expect(importanceProblem({ verdict: MATCH })).toBeUndefined()
    const missing = settle(
      { passes: [proposed("human:annotator", MATCH), proposed("human:other", MATCH, "minor")] },
      { reviewed: [], proposal: IMPORTANCE_PROPOSAL },
    )
    expect(missing.status).toBe("single")
    expect(missing.problems).toEqual([
      "human:annotator's verdict is a match or an extra without an importance of would-block, should-fix, minor",
    ])
  })

  test("the verdict settles apart from its importance", () => {
    const under = { reviewed: ["test/reviewer"], proposal: IMPORTANCE_PROPOSAL }
    const split = settle(agreedUnder(MATCH, "would-block", "should-fix"), under)
    expect(split).toEqual({ status: "agreed", verdict: MATCH, human: true, problems: [] })
    expect(settle(agreedUnder(MATCH, "should-fix"), under)).toEqual({
      status: "agreed",
      verdict: MATCH,
      importance: "should-fix",
      human: true,
      problems: [],
    })
    const adjudication = {
      by: "human:owner",
      date: "2026-11-07",
      rubric: RUBRIC_VERSION,
      proposal: IMPORTANCE_PROPOSAL,
      verdict: MATCH,
    }
    expect(
      settle(
        { ...agreedUnder(MATCH, "would-block", "should-fix"), adjudication: { ...adjudication, importance: "minor" } },
        under,
      ),
    ).toMatchObject({ status: "adjudicated", verdict: MATCH, importance: "minor" })
    const refused = settle({ ...agreedUnder(MATCH, "would-block", "should-fix"), adjudication }, under)
    expect(refused.status).toBe("agreed")
    expect(refused.problems).toEqual([
      "human:owner's verdict is a match or an extra without an importance of would-block, should-fix, minor",
    ])
  })

  test("passes under the current rubric and under the proposal are never pooled", () => {
    const current: JudgePass = { judge: "human:annotator", rubric: RUBRIC_VERSION, verdict: MATCH }
    const mixed = { passes: [current, proposed("model:judge/one", MATCH, "would-block")] }
    const atCurrent = settle(mixed, { reviewed: [] })
    expect(atCurrent.status).toBe("single")
    expect(atCurrent.problems).toEqual([
      `model:judge/one judged under rubric 1 with the proposal ${IMPORTANCE_PROPOSAL}, not rubric 1: the pass is stale`,
    ])
    const atProposal = settle(mixed, { reviewed: [], proposal: IMPORTANCE_PROPOSAL })
    expect(atProposal.status).toBe("single")
    expect(atProposal.problems).toEqual([
      `human:annotator judged under rubric 1, not rubric 1 with the proposal ${IMPORTANCE_PROPOSAL}: the pass is stale`,
    ])
    // Once a RUBRIC_VERSION 2 is adopted, passes made under the proposal still count for nothing there, whatever rubric
    // number they carry: adopting the axis means judging again.
    for (const rubric of [1, 2]) {
      const later = settle(
        {
          passes: [
            proposed("human:annotator", MATCH, "would-block", { rubric }),
            proposed("human:other", MATCH, "would-block", { rubric }),
          ],
        },
        { reviewed: [], rubric: 2 },
      )
      expect(later.status).toBe("none")
      expect(later.problems[0]).toContain("the pass is stale")
    }
    // A pass under an earlier revision of the proposal is stale under the current one.
    const revised = settle(
      {
        passes: [
          proposed("human:annotator", MATCH, "minor", { proposal: "vs45-importance-0" }),
          proposed("human:other", MATCH, "minor"),
        ],
      },
      { reviewed: [], proposal: IMPORTANCE_PROPOSAL },
    )
    expect(revised.status).toBe("single")
    expect(revised.problems[0]).toContain("with the proposal vs45-importance-0, not rubric 1 with the proposal")
    // With no proposal on either side, a stale pass and adjudication read as they did before VS-45.
    const earlier = settle(
      {
        passes: [{ judge: "human:annotator", rubric: 0, verdict: MATCH }, current],
        adjudication: { by: "human:owner", date: "2026-11-07", rubric: 0, verdict: MATCH },
      },
      { reviewed: [] },
    )
    expect(earlier.problems).toEqual([
      "human:annotator judged under rubric 0, not 1: the pass is stale",
      "the adjudication by human:owner used rubric 0, not 1",
    ])
  })

  test("the same verdicts give the same quality metrics under either rubric", () => {
    const hit = evalFinding()
    const real = evalFinding({ line: 60, title: "Cache never expires", severity: "concern" })
    const wrong = evalFinding({ line: 44, title: "Magic number" })
    const run = evalRun({ proposed: [hit, real, wrong], posted: [hit, real, wrong] })
    const current = scoreUnder(run, {
      [hit.key]: agreed(MATCH),
      [real.key]: agreed({ kind: "extra", issue: "cache" }),
      [wrong.key]: agreed({ kind: "false-alarm" }),
    })
    const proposal = scoreUnder(
      run,
      {
        [hit.key]: agreedUnder(MATCH, "would-block"),
        [real.key]: agreedUnder({ kind: "extra", issue: "cache" }, "minor"),
        [wrong.key]: agreedUnder({ kind: "false-alarm" }),
      },
      IMPORTANCE_PROPOSAL,
    )
    const before = summarize([{ score: current, evalCase: BUG, run }])
    const after = summarize([{ score: proposal, evalCase: BUG, run }], { proposal: IMPORTANCE_PROPOSAL })
    for (const metric of ["recall", "precision", "falseAlarmsPerPr", "severityPrecision", "findings"] as const)
      expect(after[metric]).toEqual(before[metric])
    expect(before.importance).toBeUndefined()
    expect(after.importance).toBeDefined()
    // Without the proposal summarize reports no importance metrics, even over passes that carry one.
    expect(summarize([{ score: proposal, evalCase: BUG, run }]).importance).toBeUndefined()
  })

  test("important precision leaves out real findings whose importance is not settled, precision@blocking does not", () => {
    const findings = [
      evalFinding({ title: "Would block" }),
      evalFinding({ line: 50, title: "Minor extra" }),
      evalFinding({ line: 51, title: "False alarm" }),
      evalFinding({ line: 52, title: "Unsettled extra" }),
      evalFinding({ line: 60, title: "Should fix", severity: "concern" }),
      evalFinding({ line: 61, title: "Concern alarm", severity: "concern" }),
    ]
    const run = evalRun({ proposed: findings, posted: findings })
    const result = scoreUnder(
      run,
      {
        [findings[0].key]: agreedUnder(MATCH, "would-block"),
        [findings[1].key]: agreedUnder({ kind: "extra", issue: "minor" }, "minor"),
        [findings[2].key]: agreedUnder({ kind: "false-alarm" }),
        [findings[3].key]: agreedUnder({ kind: "extra", issue: "open" }, "would-block", "minor"),
        [findings[4].key]: agreedUnder({ kind: "extra", issue: "fix" }, "should-fix"),
        [findings[5].key]: agreedUnder({ kind: "false-alarm" }),
      },
      IMPORTANCE_PROPOSAL,
    )
    expect(result.bySeverity).toEqual({
      blocking: { judged: 4, real: 3, wouldBlock: 1, important: 1, unsettled: 1 },
      concern: { judged: 2, real: 1, wouldBlock: 0, important: 1, unsettled: 0 },
    })
    const metrics = summarize([{ score: result, evalCase: BUG, run }], { proposal: IMPORTANCE_PROPOSAL })
    expect(metrics.importance!.important).toMatchObject({ count: 2, total: 5 })
    // VS-45's precision@blocking counts the unsettled blocking extra as not would-block; the gradient leaves it out.
    expect(metrics.importance!.blocking).toMatchObject({ count: 1, total: 4 })
    expect(metrics.importance!.wouldBlock.shares.blocking).toMatchObject({ count: 1, total: 3 })
    expect(metrics.importance!.wouldBlock.shares.concern).toMatchObject({ count: 0, total: 2 })
    expect(metrics.importance!.unsettled).toBe(1)
    expect(metrics.importance!.wouldBlock.trend).toBe("inconclusive")
    // The real share on the current rubric's basis keeps every real finding.
    expect(metrics.severityPrecision.blocking).toMatchObject({ count: 3, total: 4 })
  })

  test("a severity tally is read only from a score's own keys, whatever severity a hand-edited artifact gives", () => {
    const tally = { judged: 2, real: 1, wouldBlock: 0, important: 0, unsettled: 1 }
    const scores = JSON.parse(
      `[{"bySeverity":{"constructor":${JSON.stringify(tally)},"__proto__":${JSON.stringify(tally)}}},{"bySeverity":{}}]`,
    )
    const tallies = severityTallies(scores)
    // Each is the one score's own tally, not summed with an Object.prototype member the other score inherits.
    expect(Object.entries(tallies).slice(3)).toEqual([
      ["__proto__", tally],
      ["constructor", tally],
    ])
    expect(Object.keys(tallies).slice(0, 3)).toEqual(["blocking", "concern", "nit"])
    expect(tallies.blocking).toEqual({ judged: 0, real: 0, wouldBlock: 0, important: 0, unsettled: 0 })
  })

  test("agreement on importance is Fleiss' kappa over two real verdicts per finding, matches and extras apart", () => {
    const EXTRA: Verdict = { kind: "extra", issue: "cache" }
    const item = (passes: JudgePass[], reviewed = ["test/reviewer"]) => ({ judgement: { passes }, reviewed })
    const pairs = (count: number, verdict: Verdict, first: Importance, second: Importance) =>
      Array.from({ length: count }, () =>
        item([proposed("human:a", verdict, first), proposed("human:b", verdict, second)]),
      )
    const sample = (verdict: Verdict, times = 1) =>
      Array.from({ length: times }).flatMap(() => [
        ...pairs(6, verdict, "would-block", "would-block"),
        ...pairs(2, verdict, "minor", "minor"),
        ...pairs(2, verdict, "would-block", "should-fix"),
      ])

    const small = importanceAgreement(sample(MATCH))
    expect(small.match).toMatchObject({ findings: 10, observed: 0.8, decision: "too-few" })
    expect(small.match.kappa).toBeCloseTo(0.5652, 4)
    expect(small.extra).toEqual({ findings: 0, observed: null, kappa: null, decision: "too-few" })
    expect(small.decision).toBe("too-few")

    const large = importanceAgreement([...sample(MATCH, 10), ...sample(EXTRA, 10)])
    expect(large.all).toMatchObject({ findings: 200, decision: "keep" })
    expect(large.all.kappa).toBeCloseTo(0.5652, 4)
    expect(large.match).toMatchObject({ findings: 100, decision: "keep" })
    expect(large.extra).toMatchObject({ findings: 100, decision: "keep" })
    expect(large.decision).toBe("keep")

    // Judges who agree on every match but not on extras: the extras alone drop the axis.
    const extrasDisagree = importanceAgreement([
      ...sample(MATCH, 10),
      ...pairs(40, EXTRA, "would-block", "would-block"),
      ...pairs(20, EXTRA, "should-fix", "should-fix"),
      ...pairs(40, EXTRA, "would-block", "should-fix"),
    ])
    expect(extrasDisagree.match.decision).toBe("keep")
    expect(extrasDisagree.extra.kappa).toBeCloseTo(0.1667, 4)
    expect(extrasDisagree.extra.decision).toBe("drop")
    expect(extrasDisagree.decision).toBe("drop")

    // VS-45's rule over every finding: 100 double-judged findings with kappa below 0.4 drop the axis, though neither
    // part reaches 100 on its own.
    const pooled = importanceAgreement([
      ...pairs(60, MATCH, "would-block", "should-fix"),
      ...pairs(40, EXTRA, "should-fix", "would-block"),
    ])
    expect(pooled.match).toMatchObject({ findings: 60, decision: "too-few" })
    expect(pooled.extra).toMatchObject({ findings: 40, decision: "too-few" })
    expect(pooled.all).toMatchObject({ findings: 100, observed: 0, decision: "drop" })
    expect(pooled.all.kappa).toBeCloseTo(-1, 4)
    expect(pooled.decision).toBe("drop")
    // Under 100 in all, or kappa of at least 0.4 over them, the parts' too-few stands.
    expect(importanceAgreement(pairs(99, MATCH, "would-block", "should-fix")).decision).toBe("too-few")
    const agreeing = importanceAgreement([...sample(MATCH, 6), ...sample(EXTRA, 4)])
    expect(agreeing.all).toMatchObject({ findings: 100, decision: "keep" })
    expect(agreeing.decision).toBe("too-few")

    const uniform = importanceAgreement(pairs(100, MATCH, "would-block", "would-block"))
    expect(uniform.match).toMatchObject({ findings: 100, observed: 1, kappa: null, decision: "undefined" })

    // A match and an extra on one finding count with the extras.
    expect(
      importanceAgreement([item([proposed("human:a", MATCH, "minor"), proposed("human:b", EXTRA, "minor")])]).extra
        .findings,
    ).toBe(1)

    // Left out: a false alarm, a stale pass, a model judging its own run's findings and a third judge; a judge's latest
    // pass stands, in the place it first judged the finding.
    const filtered = importanceAgreement([
      item([proposed("human:a", MATCH, "minor"), proposed("human:b", { kind: "false-alarm" })]),
      item([proposed("human:a", MATCH, "minor"), { judge: "human:b", rubric: RUBRIC_VERSION, verdict: MATCH }]),
      item([proposed("human:a", MATCH, "minor"), proposed("model:test/reviewer", MATCH, "minor")]),
      item([
        proposed("human:z", MATCH, "would-block"),
        proposed("human:a", MATCH, "minor"),
        proposed("human:z", MATCH, "minor"),
        proposed("human:m", MATCH, "should-fix"),
      ]),
    ])
    expect(filtered.match).toMatchObject({ findings: 1, observed: 1 })
    expect(filtered.extra.findings).toBe(0)
  })
})
