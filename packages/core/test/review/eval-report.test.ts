import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  findingKey,
  IMPORTANCE,
  IMPORTANCE_PROPOSAL,
  RUBRIC_VERSION,
  runKey,
  type EvalCase,
  type EvalFinding,
  type EvalRun,
  type Importance,
  type Judgement,
  type PlanEntry,
  type Verdict,
} from "@vectordevai/core/review/eval"
import {
  ALL_PASSES,
  BLOCKING_REFERENCE,
  buildReport,
  costSplit,
  DEFAULT_GATE,
  gateDigest,
  gateProblems,
  MIN_BLOCKING_FINDINGS,
  projectionGroups,
  projectionSplit,
  renderProjections,
  renderReport,
  TOKEN_KINDS,
  type ByKind,
  type GateConfig,
  type PassCost,
  type ReportInput,
} from "@vectordevai/core/review/eval-report"
import { estimateCostUsd } from "@vectordevai/core/review/plan"
import type { FailureClass } from "@vectordevai/core/review/types"

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
    const labels = (classOf: (index: number) => FailureClass | "other") =>
      built.cases.map((item, index) => ({
        ...item,
        ...(index < 2 ? { crossFile: true } : {}),
        defects: item.defects.map((defect) => ({ ...defect, failureClass: classOf(index) })),
      }))
    const labelled = buildReport({
      title: "t",
      ...built,
      cases: labels((index) => (index === 0 ? "other" : "crash")),
      candidate: CANDIDATE,
    })
    // bug-3 is the miss: class-scoped counts bug-1 to bug-3, cross-file bug-0 and bug-1.
    expect(labelled.groups[0]!.breakdowns.classScoped).toMatchObject({ count: 2, total: 3 })
    expect(labelled.groups[0]!.breakdowns.crossFile).toMatchObject({ count: 2, total: 2 })
    expect(labelled.groups[0]!.stages.posted.recall).toMatchObject(plain.groups[0]!.stages.posted.recall)
    // A class that is neither one of the five nor "other", as a hand-built case that skipped the dataset's checks might
    // carry, is never counted: bug-1's mistyped class leaves bug-2 and bug-3.
    const mistyped: string = "logic"
    const unchecked = buildReport({
      title: "t",
      ...built,
      cases: labels((index) => (index === 0 ? "other" : index === 1 ? (mistyped as FailureClass) : "crash")),
      candidate: CANDIDATE,
    })
    expect(unchecked.groups[0]!.breakdowns.classScoped).toMatchObject({ count: 1, total: 2 })
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

// Severity calibration (VS-45): precision by posted severity and high-severity recall in every report, the
// precision@blocking monitor against engine:shared-verify, and the proposed importance rubric (Q29), which reports but
// never decides a release.

// The same judgements made under the importance proposal: each real verdict gains an importance from `rate`.
function underProposal(
  judgements: readonly Judgement[],
  rate: (item: Judgement, index: number) => [Importance, Importance] = () => ["would-block", "would-block"],
): Judgement[] {
  return judgements.map((item, index) => ({
    ...item,
    passes: item.passes.map((pass, at) => ({
      ...pass,
      proposal: IMPORTANCE_PROPOSAL,
      ...(pass.verdict.kind === "false-alarm" ? {} : { importance: rate(item, index)[at] }),
    })),
  }))
}

// One run per bug case for a variant, each posting one blocking finding: real (a match) where `real` says so, a false
// alarm otherwise, and a failed run where it says "failed".
function blockingRuns(variant: string, model: string, cases: EvalCase[], real: (index: number) => boolean | "failed") {
  const judgements: Judgement[] = []
  const runs = cases.map((evalCase, index): EvalRun => {
    const outcome = real(index)
    const item = finding("Blocking claim")
    const run: EvalRun = {
      variant,
      model,
      case: evalCase.id,
      repetition: 1,
      trust: "untrusted",
      status: outcome === "failed" ? "failed" : "completed",
      proposed: outcome === "failed" ? [] : [item],
      posted: outcome === "failed" ? [] : [item],
      spend: { costUsd: 0.1, uncertainUsd: 0, usageMissing: false, admitted: true },
      violations: [],
      startedAt: "2026-11-10T12:00:00.000Z",
    }
    if (outcome !== "failed") {
      const verdict: Verdict = outcome ? { kind: "match", defect: "defect" } : { kind: "false-alarm" }
      judgements.push({
        run: runKey(run),
        finding: item.key,
        passes: [
          { judge: "human:annotator", rubric: RUBRIC_VERSION, verdict },
          { judge: "model:vendor/judge", rubric: RUBRIC_VERSION, verdict },
        ],
      })
    }
    return run
  })
  return { runs, judgements }
}

describe("severity calibration (VS-45)", () => {
  test("every report has precision by posted severity and high-severity recall, and no importance", () => {
    const built = scenario({ bugs: 4, controls: 0, misses: 1, baseline: false })
    // bug-3, the miss, is labelled a concern, so high-severity recall counts the other three.
    const cases = built.cases.map((item) =>
      item.id === "bug-3"
        ? { ...item, defects: item.defects.map((defect) => ({ ...defect, severity: "concern" as const })) }
        : item,
    )
    const result = buildReport({ title: "t", ...built, cases, candidate: CANDIDATE })
    const group = result.groups[0]!
    expect(group.breakdowns.highSeverity).toMatchObject({ count: 3, total: 3 })
    expect(group.stages.posted.recall).toMatchObject({ count: 3, total: 4 })
    expect(group.stages.posted.severityPrecision.blocking).toMatchObject({ count: 3, total: 3 })
    expect(Object.keys(group.stages.posted.severityPrecision)).toEqual(["blocking", "concern", "nit"])
    expect(group.stages.posted.importance).toBeUndefined()
    expect(result.importance).toBeUndefined()
    expect(result).not.toHaveProperty("proposal")
    expect(result.judging).not.toHaveProperty("importanceDisagreed")
    expect(result.blockingDrops).toEqual([])
    const text = renderReport(result)
    expect(text).toContain("| Precision@blocking (real of judged blocking) | 100.0% (3/3) [")
    expect(text).toContain(
      "Real share by posted severity (posted; precision@blocking is its blocking share): blocking 100.0% (3/3) [",
    )
    expect(text).toContain("concern n/a (0 of 0), nit excluded (the gate does not count nits).")
    expect(text).toContain("Recall, high severity (defects labelled blocking): 100.0% (3/3) [")
    expect(text).toContain("rubric 1 · gate D2")
    for (const absent of [
      "Importance agreement",
      "Importance disagreed",
      "Important precision",
      "(real and would-block)",
      "Would-block share",
      "; gradient ",
      "## Precision@blocking against",
    ])
      expect(text).not.toContain(absent)
  })

  test("flags a variant whose precision@blocking falls more than five points below engine:shared-verify", () => {
    const model = "vendor/candidate"
    const cases = Array.from({ length: 100 }, (_, index) => bugCase(index))
    const groups = [
      blockingRuns(BLOCKING_REFERENCE, model, cases, (index) => index < 80),
      blockingRuns("engine:impact-graph", model, cases, (index) => index < 72),
      blockingRuns("engine:depth-auto", model, cases, (index) => index < 76),
      // Exactly five points down is not more than five.
      blockingRuns("engine:guardrail-strict", model, cases, (index) => index < 75),
      // Lost the runs where the reference was right; on the cases both reviewed it is the same.
      blockingRuns("engine:lenses-high", model, cases, (index) => (index < 30 ? "failed" : index < 80)),
      blockingRuns("engine:trivial-skip", model, cases, (index) => (index < 40 ? true : "failed")),
      // Not packages, or with no reference on their model: never compared.
      blockingRuns("engine", model, cases, (index) => index < 10),
      blockingRuns("engine:cards-brain", "vendor/other", cases, (index) => index < 10),
    ]
    const result = buildReport({
      title: "t",
      cases,
      runs: groups.flatMap((group) => group.runs),
      judgements: groups.flatMap((group) => group.judgements),
    })
    const drops = Object.fromEntries(result.blockingDrops.map((drop) => [drop.variant, drop]))
    expect(Object.keys(drops)).toEqual([
      "engine:impact-graph",
      "engine:depth-auto",
      "engine:guardrail-strict",
      "engine:lenses-high",
      "engine:trivial-skip",
    ])
    expect(drops["engine:impact-graph"]).toMatchObject({
      model,
      reference: BLOCKING_REFERENCE,
      stage: "posted",
      basis: "real",
      pairs: 100,
      candidate: { count: 72, total: 100 },
      baseline: { count: 80, total: 100 },
      outcome: "flagged",
    })
    expect(drops["engine:impact-graph"].drop).toBeCloseTo(0.08)
    expect(drops["engine:depth-auto"]).toMatchObject({ outcome: "within" })
    expect(drops["engine:depth-auto"].drop).toBeCloseTo(0.04)
    expect(drops["engine:guardrail-strict"]).toMatchObject({ candidate: { count: 75 }, outcome: "within" })
    // Compared on the 70 cases both reviewed, it is level; on all of the reference's it would read 8.6 points down.
    expect(drops["engine:lenses-high"]).toMatchObject({
      pairs: 70,
      candidate: { count: 50, total: 70 },
      baseline: { count: 50, total: 70 },
      drop: 0,
      outcome: "within",
    })
    expect(drops["engine:trivial-skip"]).toMatchObject({ pairs: 40, outcome: "too-few" })
    expect(drops["engine:trivial-skip"].candidate.total).toBeLessThan(MIN_BLOCKING_FINDINGS)
    const text = renderReport(result)
    expect(text).toContain(`## Precision@blocking against ${BLOCKING_REFERENCE}`)
    expect(text).toContain(`| engine:impact-graph · ${model} | real | 100 | 72.0% (72/100) [`)
    expect(text).toContain("| 8.0 points | flagged |")
    expect(text).toContain("It decides nothing.")
    // With no reference there is nothing to compare.
    const alone = buildReport({ title: "t", cases, runs: groups[1].runs, judgements: groups[1].judgements })
    expect(alone.blockingDrops).toEqual([])
    expect(renderReport(alone)).not.toContain("## Precision@blocking against")
  })

  test("the importance proposal changes no gate rule, threshold or gate digest", () => {
    const built = scenario()
    const input = { title: "t", split: "held-out", frozen: true, ...built, candidate: CANDIDATE, baseline: BASELINE }
    const current = buildReport(input)
    const proposal = buildReport({
      ...input,
      judgements: underProposal(built.judgements),
      proposal: IMPORTANCE_PROPOSAL,
    })
    expect(proposal.decision!.rules).toEqual(current.decision!.rules)
    expect(proposal.decision!.outcome).toBe(current.decision!.outcome)
    expect(proposal.groups[0]!.stages.posted.precision).toEqual(current.groups[0]!.stages.posted.precision)
    expect(proposal.gate).toEqual(current.gate)
    expect(gateDigest(DEFAULT_GATE)).toBe("8a4fa86e5ea88c1d")
    const looser: GateConfig = {
      ...DEFAULT_GATE,
      decision: "relaxed",
      rules: { ...DEFAULT_GATE.rules, minPrecision: 0.5 },
    }
    const weak = buildReport(
      { ...input, judgements: underProposal(built.judgements), proposal: IMPORTANCE_PROPOSAL },
      looser,
    )
    expect(weak.decision!.release.reasons).toContain(
      "the gate is weaker than the approved D2: minPrecision is 0.5, looser than D2's 0.8",
    )
  })

  test("a clean held-out run judged under the proposal passes but is never a release decision", () => {
    const built = scenario()
    const input = { title: "t", split: "held-out", frozen: true, ...built, candidate: CANDIDATE, baseline: BASELINE }
    expect(buildReport(input).decision!.release).toEqual({ eligible: true, reasons: [] })
    const proposal = buildReport({
      ...input,
      judgements: underProposal(built.judgements),
      proposal: IMPORTANCE_PROPOSAL,
    })
    expect(proposal.problems).toEqual([])
    expect(proposal.decision!.outcome).toBe("pass")
    expect(proposal.decision!.release).toEqual({
      eligible: false,
      reasons: [
        `the findings are judged under rubric 1 with the proposal ${IMPORTANCE_PROPOSAL}, a proposed rubric, and only the current rubric 1 makes a release decision`,
      ],
    })
    expect(proposal.proposal).toBe(IMPORTANCE_PROPOSAL)
    expect(renderReport(proposal)).toContain(
      `rubric 1 with the proposal ${IMPORTANCE_PROPOSAL} (proposed, not the current rubric; never a release decision)`,
    )
  })

  test("under the proposal the report adds importance rows, the would-block gradient and agreement", () => {
    const built = scenario({ bugs: 8, controls: 2, baseline: false })
    const judgements = underProposal(built.judgements, (_, index) =>
      index % 4 === 3
        ? ["would-block", "should-fix"]
        : index % 2
          ? ["should-fix", "should-fix"]
          : ["would-block", "would-block"],
    )
    const result = buildReport({
      title: "t",
      ...built,
      judgements,
      candidate: CANDIDATE,
      proposal: IMPORTANCE_PROPOSAL,
    })
    const metrics = result.groups[0]!.stages.posted
    // Eight matches: indexes 0, 2, 4, 6 would-block, 1 and 5 should-fix, 3 and 7 unsettled.
    expect(metrics.importance!.important).toMatchObject({ count: 6, total: 6 })
    expect(metrics.importance!.blocking).toMatchObject({ count: 4, total: 8 })
    expect(metrics.importance!.wouldBlock.shares.blocking).toMatchObject({ count: 4, total: 6 })
    expect(metrics.importance!.unsettled).toBe(2)
    expect(result.importance!.match).toMatchObject({ findings: 8, observed: 0.75, decision: "too-few" })
    expect(result.importance!.all).toEqual(result.importance!.match)
    expect(result.importance!.decision).toBe("too-few")
    expect(result.judging).toMatchObject({ importanceDisagreed: 2 })
    const text = renderReport(result)
    expect(text).toContain(
      "| Important precision (would-block or should-fix), unvalidated: matches 8 and extras 0 of 100 double-judged | 100.0% (6/6) [",
    )
    // VS-45's precision@blocking counts the two unsettled findings as not would-block; the next row leaves them out.
    expect(text).toContain(
      "| Precision@blocking (real and would-block), unvalidated: matches 8 and extras 0 of 100 double-judged | 50.0% (4/8) [",
    )
    expect(text).toContain(
      "| Precision@blocking (real and would-block, unsettled left out), unvalidated: matches 8 and extras 0 of 100 double-judged | 66.7% (4/6) [",
    )
    expect(text).toContain("Would-block share by posted severity, unvalidated:")
    expect(text).toContain("gradient n/a (fewer than two severities with settled findings)")
    expect(text).toContain("2 real finding(s) with no settled importance are left out.")
    expect(text).toContain("Importance agreement, Fleiss' kappa: matches")
    expect(text).toContain(
      "; all 0.47 over 8 double-judged finding(s) (observed agreement 75.0%; too-few). Kill rule (100 findings and kappa 0.4, over all and per part): too-few.",
    )
    expect(text).toContain("Importance disagreed (an agreed real verdict with no one importance, sent to disputes): 2.")
    expect(text).toContain("A gradient step falls when its Newcombe interval")
  })

  test("when the kill rule drops the axis its rows are left out, and the monitor uses real findings", () => {
    const model = "vendor/candidate"
    const cases = Array.from({ length: 200 }, (_, index) => bugCase(index))
    const reference = blockingRuns(BLOCKING_REFERENCE, model, cases, () => true)
    const variant = blockingRuns("engine:impact-graph", model, cases, () => true)
    // Judges agree on would-block versus should-fix no better than chance: kappa 0.1667 over 400 matches.
    const rate = (_: Judgement, index: number): [Importance, Importance] =>
      index % 5 < 2
        ? ["would-block", "would-block"]
        : index % 5 === 2
          ? ["should-fix", "should-fix"]
          : ["would-block", "should-fix"]
    const dropped = buildReport({
      title: "t",
      cases,
      runs: [...reference.runs, ...variant.runs],
      judgements: underProposal([...reference.judgements, ...variant.judgements], rate),
      proposal: IMPORTANCE_PROPOSAL,
    })
    expect(dropped.importance!.match.findings).toBe(400)
    expect(dropped.importance!.match.kappa).toBeCloseTo(0.1667, 4)
    expect(dropped.importance!.decision).toBe("drop")
    expect(dropped.blockingDrops[0]).toMatchObject({ basis: "real", candidate: { count: 200, total: 200 } })
    const text = renderReport(dropped)
    expect(text).not.toContain("| Important precision")
    expect(text).not.toContain("Would-block share")
    expect(text).toContain("The importance rows are left out: inter-judge kappa on importance is below 0.4")
    expect(text).toContain("| Precision@blocking (real of judged blocking) |")

    // Once both parts keep the axis, the monitor reads would-block findings. Every variant finding is a would-block
    // match, but for 20 whose importance is disputed, and every reference finding a minor one; the extras are a second
    // finding per run.
    const extra = (group: ReturnType<typeof blockingRuns>) => {
      const added = { ...finding("Real extra", 30), severity: "concern" }
      return {
        runs: group.runs.map((run) => ({ ...run, proposed: [...run.proposed, added], posted: [...run.posted, added] })),
        judgements: [
          ...group.judgements,
          ...group.runs.map(
            (run): Judgement => ({
              run: runKey(run),
              finding: added.key,
              passes: [
                { judge: "human:annotator", rubric: RUBRIC_VERSION, verdict: { kind: "extra", issue: "x" } },
                { judge: "model:vendor/judge", rubric: RUBRIC_VERSION, verdict: { kind: "extra", issue: "x" } },
              ],
            }),
          ),
        ],
      }
    }
    const withExtras = [extra(reference), extra(variant)]
    const kept = buildReport({
      title: "t",
      cases,
      runs: withExtras.flatMap((group) => group.runs),
      judgements: underProposal(
        withExtras.flatMap((group) => group.judgements),
        (item, index): [Importance, Importance] => {
          const value = IMPORTANCE[index % 3]
          return item.run.startsWith(BLOCKING_REFERENCE) && item.finding === finding("Blocking claim").key
            ? ["minor", "minor"]
            : item.finding === finding("Blocking claim").key
              ? index < 420
                ? ["would-block", "should-fix"]
                : ["would-block", "would-block"]
              : [value, value]
        },
      ),
      proposal: IMPORTANCE_PROPOSAL,
    })
    expect(kept.importance!.decision).toBe("keep")
    // VS-45's precision@blocking: a disputed importance counts as not would-block, so it stays in the denominator.
    expect(kept.blockingDrops[0]).toMatchObject({
      basis: "would-block",
      candidate: { count: 180, total: 200 },
      baseline: { count: 0, total: 200 },
      outcome: "within",
    })
  })

  test("VS-45's kill rule over every finding drops the axis though neither part has 100 on its own", () => {
    const model = "vendor/candidate"
    const cases = Array.from({ length: 100 }, (_, index) => bugCase(index))
    const built = blockingRuns("engine:impact-graph", model, cases, () => true)
    // 60 matches and 40 extras, each judged would-block by one judge and should-fix by the other: kappa -1 over 100.
    const judgements = underProposal(
      built.judgements.map((item, index) =>
        index < 60
          ? item
          : {
              ...item,
              passes: item.passes.map((pass) => ({ ...pass, verdict: { kind: "extra" as const, issue: "x" } })),
            },
      ),
      () => ["would-block", "should-fix"],
    )
    const result = buildReport({ title: "t", cases, runs: built.runs, judgements, proposal: IMPORTANCE_PROPOSAL })
    expect(result.importance!.match).toMatchObject({ findings: 60, decision: "too-few" })
    expect(result.importance!.extra).toMatchObject({ findings: 40, decision: "too-few" })
    expect(result.importance!.all).toMatchObject({ findings: 100, observed: 0, decision: "drop" })
    expect(result.importance!.decision).toBe("drop")
    expect(result.groups[0]!.stages.posted.importance).toBeDefined()
    const text = renderReport(result)
    expect(text).toContain("all -1.00 over 100 double-judged finding(s) (observed agreement 0.0%; drop)")
    expect(text).toContain("The importance rows are left out: inter-judge kappa on importance is below 0.4")
    for (const absent of [
      "| Important precision",
      "| Precision@blocking (real and would-block",
      "Would-block share",
      ", unvalidated:",
    ])
      expect(text).not.toContain(absent)
    expect(text).toContain("| Precision@blocking (real of judged blocking) |")
  })

  test("agreement counts each judgement once, and leaves out adversarial cases as the metrics do", () => {
    const model = "vendor/candidate"
    const cases = Array.from({ length: 10 }, (_, index) => bugCase(index))
    const adversarial = Array.from(
      { length: 4 },
      (_, index): EvalCase => ({
        ...bugCase(index),
        id: `injection-${index}`,
        kind: "adversarial",
      }),
    )
    const built = blockingRuns("engine:impact-graph", model, [...cases, ...adversarial], () => true)
    // An offline copy of each run under a "+" variant, scored on its original's judgements, as report.ts re-selects.
    const copies = built.runs.map((run) => ({ ...run, variant: `${run.variant}+reselect-strict` }))
    const copied = built.judgements.map((item, index) => ({ ...item, run: runKey(copies[index]) }))
    const input = { title: "t", cases: [...cases, ...adversarial], proposal: IMPORTANCE_PROPOSAL }
    const original = buildReport({ ...input, runs: built.runs, judgements: underProposal(built.judgements) })
    const withCopies = buildReport({
      ...input,
      runs: [...built.runs, ...copies],
      judgements: underProposal([...built.judgements, ...copied]),
    })
    expect(original.importance!.match.findings).toBe(10)
    expect(original.groups[0]!.stages.posted.findings.matched).toBe(10)
    expect(withCopies.importance).toEqual(original.importance)
    expect(withCopies.groups.map((group) => group.variant)).toEqual([
      "engine:impact-graph",
      "engine:impact-graph+reselect-strict",
    ])
  })

  test("a report under one rubric counts no pass made under the other", () => {
    const built = scenario({ bugs: 4, controls: 1, baseline: false })
    const atProposal = buildReport({ title: "t", ...built, candidate: CANDIDATE, proposal: IMPORTANCE_PROPOSAL })
    expect(atProposal.groups[0]!.stages.posted.findings.unjudged).toBe(4)
    expect(atProposal.judging).toMatchObject({ findings: 4, agreed: 0, none: 4, importanceDisagreed: 0 })
    expect(atProposal.judging.problems[0]).toBe(
      `human:annotator judged under rubric 1, not rubric 1 with the proposal ${IMPORTANCE_PROPOSAL}: the pass is stale`,
    )
    const atCurrent = buildReport({
      title: "t",
      ...built,
      judgements: underProposal(built.judgements),
      candidate: CANDIDATE,
    })
    expect(atCurrent.groups[0]!.stages.posted.findings.unjudged).toBe(4)
    expect(atCurrent.judging).toMatchObject({ findings: 4, agreed: 0, none: 4 })
    expect(atCurrent.judging.problems[0]).toContain(
      `with the proposal ${IMPORTANCE_PROPOSAL}, not rubric 1: the pass is stale`,
    )
  })
})

// VS-21e: each pass's projected cost by token kind, cached and uncached side by side; settled cost by pass; and
// high-severity recall per repetition and model pair. None of it changes a report that does not ask for it.
describe("cost fidelity (VS-21e)", () => {
  const PRICES = [
    { input: 3, output: 15 },
    { input: 3, output: 15, cacheRead: 0.3 },
    { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    { input: 1.25, output: 10, cacheRead: 0.125 },
  ]
  const total = (kinds: ByKind) => TOKEN_KINDS.reduce((sum, kind) => sum + kinds[kind], 0)
  const sha = (text: string) => createHash("sha256").update(text).digest("hex")

  test("projectionSplit's kinds add up to estimateCostUsd's bands exactly: cached is the low band, uncached the high", () => {
    for (const promptTokens of [0, 1, 1234, 100_000])
      for (const maxSteps of [1, 3, 5, 30])
        for (const price of PRICES) {
          const bands = estimateCostUsd({ promptTokens, maxSteps, price })
          const split = projectionSplit({ promptTokens, maxSteps, price })
          expect(total(split.cached)).toBe(bands.low)
          expect(total(split.uncached)).toBe(bands.high)
          // Neither band models cache writes, and the high band reads nothing from the cache.
          expect(split.cached.cacheWrite).toBe(0)
          expect(split.uncached.cacheWrite).toBe(0)
          expect(split.uncached.cacheRead).toBe(0)
          if (price.cacheRead === undefined) expect(split.cached.cacheRead).toBe(0)
          // At catalog-shaped prices, a cache read no dearer than input, the cached figure is at most the uncached.
          expect(total(split.cached)).toBeLessThanOrEqual(total(split.uncached))
        }
    // The low band reads (S−1)·P at the cache-read rate: 4 of 5 prompt copies at 5 steps.
    expect(projectionSplit({ promptTokens: 1000, maxSteps: 5, price: PRICES[1] }).cached.cacheRead).toBeCloseTo(
      (4 * 1000 * 0.3) / 1_000_000,
      15,
    )
  })

  const projected = (variant: string, label: string, pass: string, promptTokens: number): PassCost => ({
    variant,
    model: "loopback/vendor/model",
    case: label,
    repetition: 1,
    pass,
    basis: "projected",
    ...projectionSplit({ promptTokens, maxSteps: 30, price: PRICES[2] }),
  })
  const PASSES = [
    projected("engine", "a", "review", 4000),
    projected("engine", "a", "security", 3000),
    projected("engine", "a", "verify", 2500),
    // Case b ran no security pass.
    projected("engine", "b", "review", 6000),
    projected("engine", "b", "verify", 3100),
    projected("engine:shared-verify", "a", "review", 4000),
    projected("engine:shared-verify", "a", "verify", 2600),
  ]

  test("costSplit sums each group's runs per pass and band, and its pass rows add up to its all-passes row", () => {
    const rows = costSplit(PASSES)
    expect(rows.map((row) => [row.variant, row.pass, row.basis, row.runs])).toEqual([
      ["engine", "review", "cached", 2],
      ["engine", "review", "uncached", 2],
      ["engine", "security", "cached", 1],
      ["engine", "security", "uncached", 1],
      ["engine", "verify", "cached", 2],
      ["engine", "verify", "uncached", 2],
      ["engine", ALL_PASSES, "cached", 2],
      ["engine", ALL_PASSES, "uncached", 2],
      ["engine:shared-verify", "review", "cached", 1],
      ["engine:shared-verify", "review", "uncached", 1],
      ["engine:shared-verify", "verify", "cached", 1],
      ["engine:shared-verify", "verify", "uncached", 1],
      ["engine:shared-verify", ALL_PASSES, "cached", 1],
      ["engine:shared-verify", ALL_PASSES, "uncached", 1],
    ])
    for (const variant of ["engine", "engine:shared-verify"])
      for (const basis of ["cached", "uncached"] as const) {
        const mine = rows.filter((row) => row.variant === variant && row.basis === basis)
        const all = mine.find((row) => row.pass === ALL_PASSES)!
        // Sums over passes and runs reorder the additions, so they agree to rounding, not bit for bit.
        for (const kind of TOKEN_KINDS)
          expect(
            mine.filter((row) => row.pass !== ALL_PASSES).reduce((sum, row) => sum + row.usd![kind], 0),
          ).toBeCloseTo(all.usd![kind], 12)
        const source = PASSES.filter((entry) => entry.variant === variant && entry.basis === "projected")
        expect(total(all.usd!)).toBeCloseTo(
          source.reduce((sum, entry) => sum + (entry.basis === "projected" ? total(entry[basis]) : 0), 0),
          12,
        )
      }
    // Settled rows: a pass with no price snapshot leaves its row with no dollars; reasoning sums where reported.
    const settled = (label: string, pass: string, extra: Partial<Extract<PassCost, { basis: "settled" }>>) =>
      ({
        variant: "engine",
        model: "router/vendor/model",
        case: label,
        repetition: 1,
        pass,
        basis: "settled",
        tokens: { input: 1000, cacheRead: 500, cacheWrite: 100, output: 200 },
        ...extra,
      }) satisfies PassCost
    const usd = { input: 0.003, cacheRead: 0.00015, cacheWrite: 0.000375, output: 0.003 }
    const paid = costSplit([
      settled("a", "review", { usd, reportedUsd: 0.0065, reasoning: 40 }),
      settled("b", "review", { usd, reportedUsd: 0.0064 }),
      settled("a", "verify", { reportedUsd: 0.002 }),
    ])
    expect(paid.map((row) => [row.pass, row.basis, row.runs])).toEqual([
      ["review", "settled", 2],
      ["verify", "settled", 1],
      [ALL_PASSES, "settled", 2],
    ])
    expect(paid[0]).toMatchObject({ tokens: { input: 2000, cacheRead: 1000, cacheWrite: 200, output: 400 } })
    expect(paid[0].usd!.input).toBeCloseTo(0.006, 12)
    expect(paid[0].reportedUsd).toBeCloseTo(0.0129, 12)
    expect(paid[0].reasoning).toBe(40)
    expect(paid[1]).not.toHaveProperty("usd")
    expect(paid[1]).not.toHaveProperty("reasoning")
    expect(paid[2]).not.toHaveProperty("usd")
    expect(paid[2].reasoning).toBe(40)
  })

  test("renderProjections with no split returns exactly the lines it returned before VS-21e", () => {
    const input = goldenInput()
    // Captured at 26d3e756, before VS-21e.
    expect(renderProjections(projectionGroups(input.projected))).toEqual([
      "| Variant · model | Runs | Cases | Requests | USD low (mean / median / p90) | USD high (mean / median / p90) | Tokens sent (mean / median / p90) | Over the cap | Off this computer |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      "| engine-next · loopback/vendor/candidate | 6 | 6 | 18 | $0.3500 / $0.3500 / $0.5500 | $1.7500 / $1.7500 / $2.7500 | 3003 / 3003 / 3005 | 1 | 0 |",
      "",
      "A projection runs every pass against a canned model on this computer and prices the bodies it would send (estimateCostUsd, from the price snapshot). Its dollars are estimates, not spend. A run over its dollar cap describes an uncapped run from that decision on.",
    ])
    expect(renderProjections(projectionGroups(input.projected), [])).toEqual(
      renderProjections(projectionGroups(input.projected)),
    )
  })

  test("renderProjections with a split puts each pass's cached and uncached rows side by side, then defines them", () => {
    const groups = projectionGroups([])
    const lines = renderProjections(groups, costSplit(PASSES))
    expect(lines.slice(0, renderProjections(groups).length)).toEqual(renderProjections(groups))
    const table = lines.filter((line) => line.startsWith("| engine · "))
    expect(table.map((line) => line.split(" | ").slice(1, 3).join(" "))).toEqual([
      "review cached",
      "review uncached",
      "security cached",
      "security uncached",
      "verify cached",
      "verify uncached",
      `${ALL_PASSES} cached`,
      `${ALL_PASSES} uncached`,
    ])
    expect(table.every((line) => line.includes("| not modelled |"))).toBe(true)
    expect(table.at(-1)!.endsWith("| 100.0% |")).toBe(true)
    expect(lines).toContain(
      "| Variant · model | Pass | Band | Runs | Input | Cache read | Cache write | Output | Total | Mean per run | Share of the band |",
    )
    expect(lines.at(-1)).toContain("Cached is estimateCostUsd's low band")
    expect(lines.at(-1)).toContain("the gap between them is not a caching saving")
    expect(lines.at(-1)).toContain("These are estimates, not spend.")
  })

  // Repetition 1 reviews bug-0 and finds its defect; repetition 2 reviews bug-1 to bug-3 and finds bug-1's alone; a
  // planned repetition 4 of bug-0 has no run.
  function repeated() {
    const built = scenario({ bugs: 4, controls: 0, baseline: false })
    const again = (run: EvalRun, found: boolean): EvalRun =>
      found ? { ...run, repetition: 2 } : { ...run, repetition: 2, proposed: [], posted: [] }
    const runs = [built.runs[0], again(built.runs[1], true), again(built.runs[2], false), again(built.runs[3], false)]
    const judgements = [
      ...built.judgements.filter((item) => item.run === runKey(built.runs[0])),
      ...built.judgements
        .filter((item) => item.run === runKey(built.runs[1]))
        .map((item) => ({ ...item, run: runKey(runs[1]) })),
    ]
    const plan: PlanEntry[] = [
      ...runs.map((run) => ({ variant: run.variant, model: run.model, case: run.case, repetition: run.repetition })),
      { ...CANDIDATE, case: "bug-0", repetition: 4 },
    ]
    return { ...built, runs, judgements, plan, candidate: CANDIDATE }
  }

  test("high-severity recall per repetition averages the repetitions and pools them as breakdowns.highSeverity does", () => {
    const result = buildReport({ title: "t", ...repeated(), severityRepeats: true })
    expect(result.severityRepeats).toHaveLength(1)
    const row = result.severityRepeats![0]
    expect(row.pair).toEqual([CANDIDATE.model])
    expect(row.repetitions.map((entry) => [entry.repetition, entry.recall.count, entry.recall.total])).toEqual([
      [1, 1, 1],
      [2, 1, 3],
      [4, 0, 1],
    ])
    expect(row.mean).toBeCloseTo((1 + 1 / 3 + 0) / 3, 12)
    expect(row.pooled).toEqual(result.groups[0].breakdowns.highSeverity)
    expect(row.pooled).toMatchObject({ count: 2, total: 5 })
    expect(row.repetitions[0].recall.interval).not.toBeNull()
    const text = renderReport(result)
    expect(text).toContain("## High-severity recall by repetition")
    expect(text).toContain(`| ${CANDIDATE.variant} · ${CANDIDATE.model} | #1 100.0% (1/1) [`)
    expect(text).toContain("; #2 33.3% (1/3) [")
    expect(text).toContain("| 44.4% | 40.0% (2/5) [")
    expect(text).toContain("A pair is the models a run recorded, not their labs (I-10)")
  })

  test("a second model pair in the same group gets its own row, and a pair is the run's recorded models", () => {
    const input = repeated()
    const triaged = input.runs.map((run, index) =>
      index === 0 ? { ...run, repetition: 3, models: [run.model, "vendor/triage"] } : run,
    )
    const judgements = [
      ...input.judgements,
      ...input.judgements
        .filter((item) => item.run === runKey(input.runs[0]))
        .map((item) => ({ ...item, run: runKey(triaged[0]) })),
    ]
    const result = buildReport({
      title: "t",
      ...input,
      runs: [input.runs[0], ...triaged],
      judgements,
      plan: [...input.plan, { ...CANDIDATE, case: "bug-0", repetition: 3 }],
      severityRepeats: true,
    })
    expect(
      result.severityRepeats!.map((row) => [row.pair, row.missing, row.repetitions.map((entry) => entry.repetition)]),
    ).toEqual([
      [[CANDIDATE.model], undefined, [1, 2]],
      [[CANDIDATE.model, "vendor/triage"], undefined, [3]],
      // Two recorded pairs: the missing repetition 4 belongs to neither, so it has a row of its own.
      [[CANDIDATE.model], true, [4]],
    ])
    expect(result.severityRepeats![1].pooled).toMatchObject({ count: 1, total: 1 })
    expect(result.severityRepeats![2].pooled).toMatchObject({ count: 0, total: 1 })
    expect(renderReport(result)).toContain(
      `| ${CANDIDATE.variant} · missing runs (planned ${CANDIDATE.model}) | #4 0.0% (0/1) [`,
    )
  })

  test("a missing run counts against its group's one recorded pair, so a cross-family pair keeps its misses", () => {
    const input = repeated()
    const result = buildReport({
      title: "t",
      ...input,
      runs: input.runs.map((run) => ({ ...run, models: [run.model, "vendor/triage"] })),
      severityRepeats: true,
    })
    expect(result.severityRepeats).toHaveLength(1)
    const row = result.severityRepeats![0]
    expect(row.pair).toEqual([CANDIDATE.model, "vendor/triage"])
    expect(row).not.toHaveProperty("missing")
    expect(row.repetitions.map((entry) => [entry.repetition, entry.recall.count, entry.recall.total])).toEqual([
      [1, 1, 1],
      [2, 1, 3],
      [4, 0, 1],
    ])
    expect(row.pooled).toEqual(result.groups[0].breakdowns.highSeverity)
    expect(row.pooled).toMatchObject({ count: 2, total: 5 })
  })

  test("a report that asks for neither is byte for byte the report it was before VS-21e", () => {
    const result = buildReport(goldenInput())
    expect(result).not.toHaveProperty("costs")
    expect(result).not.toHaveProperty("severityRepeats")
    // Captured at 26d3e756, before VS-21e.
    expect(sha(renderReport(result))).toBe("535a49fc6f8bcd38396cbb37a231a5590f2e8fbb5b1c238ed4201f9185789102")
    expect(sha(JSON.stringify(result))).toBe("048a8e0738b108465002e94cf9a6661a15e17644687f9432091de489f3c52f91")
    // Asked for, the sections follow the projections; costs alone add no recall section, and the reverse.
    const withCosts = buildReport({ ...goldenInput(), costs: PASSES })
    expect(withCosts.costs).toEqual(costSplit(PASSES))
    expect(withCosts).not.toHaveProperty("severityRepeats")
    const text = renderReport(withCosts)
    expect(text).toContain("Projected cost by pass and token kind (VS-21e)")
    expect(text).not.toContain("## Settled cost by pass and token kind")
    expect(text).not.toContain("## High-severity recall by repetition")
    expect(text.indexOf("Projected cost by pass")).toBeLessThan(text.indexOf("## Gate"))
  })
})

// The golden input of VS-21e's unset byte-identity test: four bug cases and two controls in one group, each run with a
// projection. The digests above were taken from this input at 26d3e756.
function goldenInput() {
  const built = scenario({ bugs: 4, controls: 2, baseline: false })
  const projected = built.runs.map((run, index) => ({
    variant: run.variant,
    model: "loopback/vendor/candidate",
    case: run.case,
    repetition: 1,
    usd: { low: 0.1 * (index + 1), high: 0.5 * (index + 1) },
    tokens: { first: 1000 + index, sent: 3000 + index },
    passes: 2,
    requests: 3,
    over: index === 2 ? 1 : 0,
    outside: 0,
  }))
  return { title: "golden", ...built, projected, candidate: CANDIDATE }
}
