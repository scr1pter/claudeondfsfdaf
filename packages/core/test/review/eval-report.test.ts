import { describe, expect, test } from "bun:test"
import {
  findingKey,
  RUBRIC_VERSION,
  runKey,
  type EvalCase,
  type EvalFinding,
  type EvalRun,
  type Judgement,
  type PlanEntry,
  type Verdict,
} from "@vectordevai/core/review/eval"
import {
  buildReport,
  DEFAULT_GATE,
  gateDigest,
  gateProblems,
  renderReport,
  type GateConfig,
  type ReportInput,
} from "@vectordevai/core/review/eval-report"

// The report and the D2 gate over synthetic saved runs. Large samples settle the statistical rules; small ones leave
// them to a human. Every verdict comes from two agreeing judges.

const CANDIDATE = { variant: "engine-next", model: "vendor/candidate" }
const BASELINE = { variant: "engine", model: "vendor/current" }

function bugCase(index: number): EvalCase {
  return {
    id: `bug-${index}`,
    kind: "bug",
    language: index % 2 ? "python" : "typescript",
    size: { files: 1, additions: index % 3 ? 20 : 400, deletions: 5 },
    defects: [
      {
        id: "defect",
        category: index % 4 ? "correctness" : "security",
        severity: "blocking",
        summary: "A defect.",
        cause: "Why it is wrong.",
        locations: [{ path: "src/app.ts", line: 10 }],
        alternatives: [],
      },
    ],
  }
}

function cleanCase(index: number): EvalCase {
  return {
    id: `clean-${index}`,
    kind: "control",
    language: "go",
    size: { files: 2, additions: 50, deletions: 50 },
    defects: [],
  }
}

function finding(title: string, line = 10): EvalFinding {
  const base = { path: "src/app.ts", line, severity: "blocking", category: "bug", title, body: `${title}.` }
  return { key: findingKey(base), ...base }
}

interface Options {
  bugs?: number
  controls?: number
  misses?: number // candidate bug runs with no finding
  noise?: number // false alarms the candidate adds to each bug run
  cleanAlarms?: number // candidate control runs with one false alarm
  failed?: number // candidate runs that failed
  unjudged?: number // candidate bug runs whose finding has only one pass
  baseline?: boolean
}

// Saved runs and their judgements for the candidate and, unless turned off, the frozen pipeline.
function scenario(options: Options = {}) {
  const cases = [
    ...Array.from({ length: options.bugs ?? 200 }, (_, index) => bugCase(index)),
    ...Array.from({ length: options.controls ?? 100 }, (_, index) => cleanCase(index)),
  ]
  const judgements: Judgement[] = []
  const judge = (run: EvalRun, item: EvalFinding, verdict: Verdict, passes = 2) =>
    judgements.push({
      run: runKey(run),
      finding: item.key,
      passes: [
        { judge: "human:annotator", rubric: RUBRIC_VERSION, verdict },
        { judge: "model:vendor/judge", rubric: RUBRIC_VERSION, verdict },
      ].slice(0, passes),
    })
  const runsFor = (group: typeof CANDIDATE, candidate: boolean) =>
    cases.map((evalCase, index): EvalRun => {
      const bugIndex = evalCase.kind === "bug" ? index : -1
      const controlIndex = evalCase.kind === "control" ? index - (options.bugs ?? 200) : -1
      const failed = candidate && index < (options.failed ?? 0)
      const hit = finding("The defect")
      const noise = candidate
        ? Array.from({ length: options.noise ?? 0 }, (_, at) => finding(`Noise ${at}`, 30 + at))
        : []
      const alarm =
        candidate && controlIndex >= 0 && controlIndex < (options.cleanAlarms ?? 0) ? [finding("False alarm", 5)] : []
      const misses = candidate && bugIndex >= 0 && bugIndex >= (options.bugs ?? 200) - (options.misses ?? 0)
      const findings = failed ? [] : [...(bugIndex >= 0 && !misses ? [hit] : []), ...noise, ...alarm]
      const run: EvalRun = {
        ...group,
        case: evalCase.id,
        repetition: 1,
        trust: "untrusted",
        status: failed ? "failed" : "completed",
        proposed: findings,
        posted: findings.map((item) => ({ ...item, anchored: true })),
        ms: 1000,
        spend: { costUsd: 0.1, uncertainUsd: 0, usageMissing: false, admitted: true },
        tokens: { input: 1000, output: 100 },
        violations: [],
        startedAt: "2026-11-10T12:00:00.000Z",
      }
      for (const item of findings)
        judge(
          run,
          item,
          item === hit ? { kind: "match", defect: "defect" } : { kind: "false-alarm" },
          candidate && item === hit && bugIndex < (options.unjudged ?? 0) ? 1 : 2,
        )
      return run
    })
  const runs = [...runsFor(CANDIDATE, true), ...(options.baseline === false ? [] : runsFor(BASELINE, false))]
  return { cases, runs, judgements }
}

function report(options: Options = {}, input: Partial<ReportInput> = {}, gate?: GateConfig) {
  const built = scenario(options)
  return buildReport(
    {
      title: "VectorScope held-out run",
      split: "held-out",
      frozen: true,
      ...built,
      candidate: CANDIDATE,
      ...(options.baseline === false ? {} : { baseline: BASELINE }),
      ...input,
    },
    gate,
  )
}

function outcomes(built: ReturnType<typeof report>) {
  return Object.fromEntries(built.decision!.rules.map((rule) => [rule.rule, rule.outcome]))
}

describe("the default gate", () => {
  test("is D2 exactly as the owner approved it", () => {
    expect(DEFAULT_GATE.decision).toBe("D2")
    expect(DEFAULT_GATE.approved).toEqual({ by: "owner", date: "2026-11-03" })
    expect(DEFAULT_GATE.rules).toEqual({
      maxTrustViolations: 0,
      maxUnaccountedAttempts: 0,
      minCoverage: 0.95,
      minPrecision: 0.8,
      maxFalseAlarmsPerCleanPr: 0.2,
      maxRecallDrop: 0.05,
    })
    expect(DEFAULT_GATE.split).toBe("held-out")
    expect(DEFAULT_GATE.stage).toBe("posted")
    expect(gateProblems(DEFAULT_GATE)).toEqual([])
    expect(gateDigest(DEFAULT_GATE)).toBe(gateDigest(structuredClone(DEFAULT_GATE)))
  })

  test("a gate file is validated before it is used", () => {
    expect(gateProblems(null)).toEqual(["the gate config is not a JSON object"])
    const problems = gateProblems({
      ...DEFAULT_GATE,
      approved: { by: "owner" },
      stage: "drafted",
      rules: { ...DEFAULT_GATE.rules, minPrecision: 80, maxTrustViolations: 0.5, maxFalseAlarmsPerCleanPr: -1 },
    })
    expect(problems).toEqual([
      "approved needs who approved the thresholds and a YYYY-MM-DD date",
      "stage must be posted or proposed",
      "rules.maxTrustViolations must be a whole number",
      "rules.minPrecision must be a fraction from 0 to 1",
      "rules.maxFalseAlarmsPerCleanPr must be a number of at least 0",
    ])
  })
})

describe("the gate", () => {
  test("passes a large, clean held-out result, which is a release decision", () => {
    const built = report()
    expect(built.problems).toEqual([])
    expect(outcomes(built)).toEqual({
      maxTrustViolations: "pass",
      maxUnaccountedAttempts: "pass",
      minCoverage: "pass",
      minPrecision: "pass",
      maxFalseAlarmsPerCleanPr: "pass",
      maxRecallDrop: "pass",
    })
    expect(built.decision!.outcome).toBe("pass")
    expect(built.decision!.release).toEqual({ eligible: true, reasons: [] })
    expect(built.decision!.paired).toMatchObject({ pairs: 200, candidate: 200, baseline: 200, difference: 0 })
  })

  test("only a held-out run on a frozen manifest, collected after approval, is a release decision", () => {
    expect(report({}, { split: "development" }).decision!.release.reasons[0]).toContain("development split")
    expect(report({}, { frozen: false }).decision!.release.reasons).toEqual([
      "the manifest's held-out labels are not frozen",
    ])
    expect(report({}, { collected: "2026-11-01" }).decision!.release.reasons[0]).toContain(
      "after the results were collected",
    )
    const undated = scenario()
    const unknown = buildReport({
      title: "t",
      split: "held-out",
      frozen: true,
      ...undated,
      runs: undated.runs.map((run) => ({ ...run, startedAt: undefined })),
      candidate: CANDIDATE,
      baseline: BASELINE,
    })
    expect(unknown.decision!.release.reasons[0]).toContain("when the results were collected is not recorded")
    expect(unknown.decision!.outcome).toBe("pass")
  })

  test("fails what the intervals show is over a threshold", () => {
    expect(outcomes(report({ noise: 2 }))).toMatchObject({ minPrecision: "fail" })
    expect(outcomes(report({ cleanAlarms: 100 }))).toMatchObject({ maxFalseAlarmsPerCleanPr: "fail" })
    expect(outcomes(report({ misses: 60 }))).toMatchObject({ maxRecallDrop: "fail" })
    const thin = report({ failed: 20 })
    expect(outcomes(thin)).toMatchObject({ minCoverage: "fail" })
    expect(thin.decision!.outcome).toBe("fail")
    expect(thin.decision!.rules.find((rule) => rule.rule === "minCoverage")!.value).toBeCloseTo(280 / 300)
  })

  test("fails any trust violation or unaccounted paid attempt", () => {
    const built = scenario()
    const broken = buildReport({
      title: "t",
      ...built,
      runs: built.runs.map((run, index) =>
        index === 0
          ? { ...run, violations: ["the fix commit appears in what would be posted"] }
          : index === 1
            ? { ...run, spend: { ...run.spend, admitted: false } }
            : run,
      ),
      candidate: CANDIDATE,
      baseline: BASELINE,
    })
    expect(outcomes(broken)).toMatchObject({ maxTrustViolations: "fail", maxUnaccountedAttempts: "fail" })
    expect(broken.decision!.rules.find((rule) => rule.rule === "maxTrustViolations")!.detail).toContain("fix commit")

    const judgeCall = {
      run: runKey(built.runs[0]),
      judge: "model:vendor/judge",
      paid: true,
      admitted: false,
      sent: true,
      answered: true,
    }
    expect(outcomes(report({}, { judging: [judgeCall] }))).toMatchObject({ maxUnaccountedAttempts: "fail" })
    expect(outcomes(report({}, { ledger: { open: 1, spentUsd: 1, uncertainUsd: 0, overshootUsd: 0 } }))).toMatchObject({
      maxUnaccountedAttempts: "fail",
    })
  })

  test("sends to human review what a small sample cannot settle", () => {
    const small = report({ bugs: 5, controls: 2 })
    expect(outcomes(small)).toMatchObject({
      minCoverage: "pass",
      minPrecision: "review",
      maxFalseAlarmsPerCleanPr: "review",
      maxRecallDrop: "review",
    })
    expect(small.decision!.outcome).toBe("review")
    expect(small.decision!.rules.find((rule) => rule.rule === "minPrecision")!.detail).toContain("a human decides")
  })

  test("sends to review while findings are unjudged, or with no frozen pipeline or clean change", () => {
    const pending = report({ unjudged: 3 })
    // Unjudged findings on bug cases leave precision and recall open, but not the clean-change rate.
    expect(outcomes(pending)).toMatchObject({
      minPrecision: "review",
      maxFalseAlarmsPerCleanPr: "pass",
      maxRecallDrop: "review",
    })
    expect(pending.decision!.rules.find((rule) => rule.rule === "minPrecision")!.detail).toBe(
      "3 actionable finding(s) have no settled verdict",
    )
    expect(pending.judging).toMatchObject({ single: 3 })
    const built = scenario({ cleanAlarms: 1 })
    const cleanPending = buildReport({
      title: "t",
      ...built,
      judgements: built.judgements.map((item) =>
        item.run.includes("clean-0") ? { ...item, passes: item.passes.slice(0, 1) } : item,
      ),
      candidate: CANDIDATE,
      baseline: BASELINE,
    })
    expect(outcomes(cleanPending)).toMatchObject({ maxFalseAlarmsPerCleanPr: "review" })
    expect(cleanPending.decision!.rules.find((rule) => rule.rule === "maxFalseAlarmsPerCleanPr")!.detail).toBe(
      "1 actionable finding(s) on clean pull requests have no settled verdict",
    )
    const alone = report({ baseline: false })
    expect(outcomes(alone)).toMatchObject({ maxRecallDrop: "review" })
    expect(alone.decision!.rules.find((rule) => rule.rule === "maxRecallDrop")!.detail).toContain("no frozen pipeline")
    expect(outcomes(report({ controls: 0 }))).toMatchObject({ maxFalseAlarmsPerCleanPr: "review" })
  })
})

describe("what the gate will not accept", () => {
  // Phase 0: a model may assist with matching but is never the sole authority.
  test("verdicts that only models agreed on settle nothing, so the gate cannot pass on them", () => {
    const built = scenario()
    const modelsOnly = built.judgements.map((item) => ({
      ...item,
      passes: item.passes.map((pass) =>
        pass.judge.startsWith("human:") ? { ...pass, judge: "model:vendor/second-judge" } : pass,
      ),
    }))
    const result = buildReport({
      title: "t",
      split: "held-out",
      frozen: true,
      ...built,
      judgements: modelsOnly,
      candidate: CANDIDATE,
      baseline: BASELINE,
    })
    expect(outcomes(result)).toMatchObject({
      minPrecision: "review",
      maxFalseAlarmsPerCleanPr: "pass",
      maxRecallDrop: "review",
    })
    expect(result.decision!.outcome).not.toBe("pass")
    expect(result.judging).toMatchObject({ agreed: 0, needsHuman: result.judging.findings })
    expect(result.groups[0].stages.posted.findings.unjudged).toBe(200)
    expect(renderReport(result)).toContain("agreed by models only (waiting for a human)")
  })

  // Small held-out samples may require more data, not weaker thresholds.
  test("a gate weaker than the approved D2 is never a release decision", () => {
    const looser: GateConfig = {
      ...DEFAULT_GATE,
      decision: "relaxed",
      rules: { ...DEFAULT_GATE.rules, minPrecision: 0.5, maxFalseAlarmsPerCleanPr: 0.5 },
    }
    expect(gateProblems(looser)).toEqual([])
    const weak = report({}, {}, looser)
    expect(weak.decision!.outcome).toBe("pass")
    expect(weak.decision!.release.eligible).toBe(false)
    expect(weak.decision!.release.reasons).toEqual([
      "the gate is weaker than the approved D2: minPrecision is 0.5, looser than D2's 0.8",
      "the gate is weaker than the approved D2: maxFalseAlarmsPerCleanPr is 0.5, looser than D2's 0.2",
    ])
    const narrow = report({}, {}, { ...DEFAULT_GATE, decision: "narrow", confidence: 0.8 })
    expect(narrow.decision!.release.reasons).toEqual([
      "the gate is weaker than the approved D2: confidence is 0.8, below D2's 0.95",
    ])
    const elsewhere = report({}, { split: "development" }, { ...DEFAULT_GATE, decision: "dev", split: "development" })
    expect(elsewhere.decision!.release.reasons).toEqual([
      "the gate is weaker than the approved D2: a release decision is made on development, not D2's held-out",
    ])
    // A copy that still calls itself D2 cannot speak for D2 once it differs, even when it is stricter.
    const renamed = report({}, {}, { ...DEFAULT_GATE, rules: { ...DEFAULT_GATE.rules, minPrecision: 0.5 } })
    expect(renamed.decision!.release.reasons.join("\n")).toContain("is not the approved D2 config")
    const stricter = report(
      {},
      {},
      { ...DEFAULT_GATE, decision: "D2-strict", rules: { ...DEFAULT_GATE.rules, minCoverage: 0.97 } },
    )
    expect(stricter.decision!.release).toEqual({ eligible: true, reasons: [] })
  })
})

describe("the report", () => {
  test("keeps missing runs in the plan and reports runs it cannot place", () => {
    const built = scenario({ bugs: 3, controls: 1, baseline: false })
    const plan: PlanEntry[] = [
      ...built.cases.map((item) => ({ ...CANDIDATE, case: item.id, repetition: 1 })),
      { ...CANDIDATE, case: "bug-0", repetition: 2 },
    ]
    const result = buildReport({
      title: "t",
      ...built,
      plan,
      runs: [
        ...built.runs,
        built.runs[0],
        { ...built.runs[0], repetition: 3 },
        { ...built.runs[0], case: "unknown-case" },
      ],
      candidate: CANDIDATE,
    })
    const metrics = result.groups[0].stages.posted
    expect(metrics.status).toMatchObject({ completed: 4, missing: 1 })
    expect(metrics.coverage).toMatchObject({ count: 4, total: 5 })
    expect(metrics.recall).toMatchObject({ count: 3, total: 4 })
    expect(result.problems).toEqual([
      `${runKey({ ...CANDIDATE, case: "unknown-case", repetition: 1 })} reviews unknown-case, which no case labels`,
      `${runKey({ ...CANDIDATE, case: "bug-0", repetition: 3 })} is not in the plan and is left out`,
      `${runKey({ ...CANDIDATE, case: "unknown-case", repetition: 1 })} is not in the plan and is left out`,
      `${runKey(built.runs[0])} was given twice; the first is used`,
    ])
  })

  test("reports both stages for every group, with breakdowns at the gate's stage", () => {
    const built = report({ bugs: 8, controls: 4 })
    expect(built.groups.map((group) => `${group.variant} ${group.model}`)).toEqual([
      "engine-next vendor/candidate",
      "engine vendor/current",
    ])
    const group = built.groups[0]
    expect(group.stages.proposed.recall.value).toBe(1)
    expect(group.stages.posted.anchors).toMatchObject({ count: 8, total: 8 })
    expect(group.stages.proposed.anchors.value).toBeNull()
    expect(Object.keys(group.breakdowns.language)).toEqual(["go", "python", "typescript"])
    expect(group.breakdowns.language.go.recall.value).toBeNull()
    expect(Object.keys(group.breakdowns.size)).toEqual(["medium", "small"])
    expect(group.breakdowns.trust.untrusted.planned).toBe(12)
    expect(group.breakdowns.category).toMatchObject({
      correctness: { count: 6, total: 6 },
      security: { count: 2, total: 2 },
    })
    expect(built.judging).toMatchObject({ findings: 16, agreed: 16, needsHuman: 0 })
  })

  test("without a candidate it reports and asks for one", () => {
    const built = scenario({ bugs: 2, controls: 1 })
    const result = buildReport({ title: "t", ...built })
    expect(result.decision).toBeUndefined()
    expect(result.problems).toContain("name the candidate variant and model to evaluate the gate")
  })

  test("renders intervals, coverage, spend, counts for empty denominators and the gate", () => {
    const text = renderReport(report({ bugs: 4, controls: 2 }, { split: "development", frozen: false }))
    expect(text).toContain("# VectorScope held-out run")
    expect(text).toContain("gate D2 (approved by owner on 2026-11-03")
    expect(text).toContain("| Coverage (completed of planned) | 100.0% (6/6) [")
    expect(text).toContain("| Actionable precision | 100.0% (4/4) [")
    expect(text).toContain("| Valid suggestions | n/a (0 of 0) | n/a (0 of 0) |")
    expect(text).toContain("| False alarms per clean PR | 0.00 (0 in 2) [0.00, 1.84]")
    expect(text).toContain("Spend: $0.6000 reported, $0.0000 uncertain")
    expect(text).toContain("## Gate D2: review")
    expect(text).toContain("| minPrecision | 0.8 | 1 |")
    expect(text).toContain("Not a release decision: the results are from the development split")
    expect(text).toContain("Judging is blinded")
  })
})

// VS-21c: operations, the estimate error against dry projections, class-scoped and cross-file recall, and trivial
// controls apart from the behaviour-preserving ones. No seed case sets the new labels, so figures from inputs without
// them must not move.
describe("operations and the new breakdowns", () => {
  const timed = (run: EvalRun, index: number): EvalRun => ({
    ...run,
    ms: 1000 * (index + 1),
    attempts: index === 0 ? 0 : 3,
    ...(index === 1 ? { stop: "budget" } : index === 2 ? { stop: "privacy" } : {}),
    passes: [
      { pass: "review", ms: 100 * (index + 1) },
      { pass: "verify", ms: 10 },
    ],
    spend: {
      costUsd: index === 0 ? 0 : 0.1 * index,
      uncertainUsd: index === 3 ? 0.05 : 0,
      usageMissing: index === 2,
      admitted: true,
    },
    tokens: { input: 1000, output: 100, cacheRead: 500, cacheWrite: 100 },
  })

  test("cost, tokens, cache, wall time, zero-token reviews, stops and route refusals over the present runs", () => {
    const built = scenario({ bugs: 4, controls: 0, baseline: false })
    const runs = [
      ...built.runs.map(timed),
      { ...built.runs[0]!, case: "bug-0", repetition: 2, status: "not-sent" as const },
    ]
    const result = buildReport({ title: "t", ...built, runs, candidate: CANDIDATE })
    const operations = result.groups[0]!.operations
    expect(operations.runs).toBe(4)
    // $0 and $0.1, with type-7 quantiles, so the median is the usual one. bug-2's usage is missing and bug-3 kept
    // $0.05 at its bound: neither is what a review cost, so both are counted apart and left out.
    expect(operations.costUsd!.n).toBe(2)
    expect(operations.costUsd!.mean).toBeCloseTo(0.05)
    expect(operations.costUsd!.p50).toBeCloseTo(0.05)
    expect(operations.costUsd!.p90).toBeCloseTo(0.09)
    expect(operations.unsettled).toBe(2)
    expect(operations.tokens).toMatchObject({ n: 4, mean: 1100, p50: 1100 })
    expect(operations.cache).toEqual({ read: 2000, write: 400, share: 2000 / (4000 + 2000 + 400) })
    expect(operations.wallMs).toMatchObject({ n: 4, mean: 2500, p50: 2500 })
    expect(Object.keys(operations.passMs)).toEqual(["review", "verify"])
    expect(operations.passMs.review).toMatchObject({ n: 4, p50: 250 })
    expect(operations.zeroToken).toMatchObject({ count: 1, total: 4 })
    expect(operations.stops).toEqual({ budget: 1, privacy: 1 })
    expect(operations.routeRefusals).toBe(1)
    const text = renderReport(result)
    expect(text).toContain("| Cost per review (known spend) | 2 | $0.0500 | $0.0500 | $0.0900 |")
    expect(text).toContain("Cost per review leaves out 2 run(s) whose spend is uncertain or whose usage is missing")
    expect(text).toContain("| Wall time, review | 4 |")
    expect(text).toContain("Zero-token reviews: 25.0% (1/4)")
    expect(text).toContain("Early stops: budget 1, privacy 1. Route refusals: 1.")
  })

  test("joins projections by variant, case and the model after its provider, and leaves capped and unknown ones out", () => {
    const built = scenario({ bugs: 4, controls: 0, baseline: false })
    const runs = built.runs.map((run, index) => ({
      ...run,
      model: "router/vendor/candidate",
      // bug-3's replay failed, so its whole bound is kept as uncertain spend, with no usage reported.
      spend:
        index === 3
          ? { uncertainUsd: 0.75, usageMissing: true, admitted: true }
          : { costUsd: 0.1 * (index + 1), uncertainUsd: 0, usageMissing: false, admitted: true },
    }))
    const projected = runs.map((run, index) => ({
      variant: run.variant,
      model: "loopback/vendor/candidate",
      case: run.case,
      repetition: 1,
      usd: { low: 0.1, high: 0.15 },
      tokens: { first: 1000, sent: 3000 },
      passes: 2,
      requests: 3,
      over: index === 2 ? 1 : 0,
      outside: 0,
    }))
    const result = buildReport({
      title: "t",
      ...built,
      runs,
      projected,
      candidate: { variant: CANDIDATE.variant, model: "router/vendor/candidate" },
    })
    const estimate = result.groups[0]!.operations.estimate
    // bug-0 settled at the low estimate, bug-1 twice it; bug-2's projection went over its cap; bug-3's spend is its
    // bound, not what it spent, so the estimate is not compared with it.
    expect(estimate.error!.n).toBe(2)
    expect(estimate.error!.mean).toBeCloseTo(0.25)
    expect(estimate.inRange).toMatchObject({ count: 1, total: 2 })
    expect(estimate.capped).toBe(1)
    expect(estimate.uncertain).toBe(1)
    expect(result.groups[0]!.operations.unsettled).toBe(1)
    expect(result.projections).toEqual([
      expect.objectContaining({
        variant: CANDIDATE.variant,
        model: "loopback/vendor/candidate",
        runs: 4,
        cases: 4,
        requests: 12,
        capped: 1,
        outside: 0,
      }),
    ])
    const text = renderReport(result)
    expect(text).toContain("## Projections")
    expect(text).toContain(
      `| ${CANDIDATE.variant} · loopback/vendor/candidate | 4 | 4 | 12 | $0.1000 / $0.1000 / $0.1000 |`,
    )
    expect(text).toContain(
      "1 run(s) left out because their projection went over its dollar cap, 1 because their spend is uncertain or their usage is missing.",
    )
    // Without projections there is no section and the estimate reads n/a.
    const plain = buildReport({ title: "t", ...built, candidate: CANDIDATE })
    expect(plain.projections).toEqual([])
    expect(plain.groups[0]!.operations.estimate.error).toBeNull()
    expect(renderReport(plain)).not.toContain("## Projections")
  })

  test("class-scoped and cross-file recall count only their defects, and read n/a until the labels exist", () => {
    const built = scenario({ bugs: 4, controls: 0, misses: 1, baseline: false })
    const plain = buildReport({ title: "t", ...built, candidate: CANDIDATE })
    expect(plain.groups[0]!.breakdowns.classScoped).toMatchObject({ count: 0, total: 0, value: null })
    expect(plain.groups[0]!.breakdowns.crossFile).toMatchObject({ count: 0, total: 0, value: null })
    expect(renderReport(plain)).toContain("Recall, class-scoped (defects in the five failure classes): n/a (0 of 0)")
    const cases = built.cases.map((item, index) => ({
      ...item,
      ...(index < 2 ? { crossFile: true } : {}),
      defects: item.defects.map((defect) => ({ ...defect, failureClass: index === 0 ? "other" : "logic" })),
    }))
    const labelled = buildReport({ title: "t", ...built, cases, candidate: CANDIDATE })
    // bug-3 is the miss: class-scoped counts bug-1 to bug-3, cross-file bug-0 and bug-1.
    expect(labelled.groups[0]!.breakdowns.classScoped).toMatchObject({ count: 2, total: 3 })
    expect(labelled.groups[0]!.breakdowns.crossFile).toMatchObject({ count: 2, total: 2 })
    expect(labelled.groups[0]!.stages.posted.recall).toMatchObject(plain.groups[0]!.stages.posted.recall)
  })

  test("trivial controls are reported apart and never count toward false alarms per clean PR or the gate", () => {
    const options = { bugs: 2, controls: 4, cleanAlarms: 2, baseline: false }
    const plain = report(options)
    const built = scenario(options)
    // clean-0 and clean-1 raise the false alarms; marking them trivial takes them out of the D2 figure.
    const cases = built.cases.map((item) =>
      item.id === "clean-0" || item.id === "clean-1" ? { ...item, trivialKind: "whitespace" } : item,
    )
    const marked = report(options, { cases })
    expect(plain.groups[0]!.stages.posted.falseAlarmsPerCleanPr).toMatchObject({ count: 2, exposure: 4 })
    expect(plain.groups[0]!.trivial).toMatchObject({ planned: 0, reviewed: 0 })
    expect(marked.groups[0]!.stages.posted.falseAlarmsPerCleanPr).toMatchObject({ count: 0, exposure: 2 })
    expect(marked.groups[0]!.trivial).toMatchObject({ planned: 2, reviewed: 2, falseAlarms: { count: 2, exposure: 2 } })
    // Every other figure is unchanged.
    expect(marked.groups[0]!.stages.posted.falseAlarmsPerPr).toEqual(plain.groups[0]!.stages.posted.falseAlarmsPerPr)
    expect(marked.groups[0]!.stages.posted.recall).toEqual(plain.groups[0]!.stages.posted.recall)
    expect(renderReport(marked)).toContain(
      "Trivial controls, apart from the behaviour-preserving controls above: 2 planned, 2 reviewed",
    )
  })

  test("an unjudged finding on a trivial control does not hold the clean-PR rule for review", () => {
    const built = scenario({ bugs: 2, controls: 4, baseline: false })
    const alarm = finding("Unjudged", 7)
    const runs = built.runs.map((run) =>
      run.case === "clean-0" ? { ...run, posted: [alarm], proposed: [alarm] } : run,
    )
    const rule = (cases: EvalCase[]) =>
      buildReport({
        title: "t",
        split: "held-out",
        frozen: true,
        ...built,
        cases,
        runs,
        candidate: CANDIDATE,
      }).decision!.rules.find((entry) => entry.rule === "maxFalseAlarmsPerCleanPr")!
    expect(rule(built.cases).detail).toContain("on clean pull requests have no settled verdict")
    const marked = built.cases.map((item) => (item.id === "clean-0" ? { ...item, trivialKind: "docs" } : item))
    expect(rule(marked).detail).not.toContain("have no settled verdict")
  })
})
