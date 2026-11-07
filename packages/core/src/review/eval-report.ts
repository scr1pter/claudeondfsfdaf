// The causal report and release gate for VectorScope's eval (VectorScope plan, VS-04; Phase 0 "Metrics and judging"
// and "Budget, privacy and release gate"). buildReport scores saved runs from their settled judgements, for each
// pipeline variant and model at both the proposed and the posted stage, with intervals, coverage, spend, judging status
// and breakdowns, and evaluates the gate for the candidate against the frozen pipeline. It reads only saved outputs, so
// a revised rubric or gate re-scores them without another provider call. Each group also reports its operations (cost
// per review, tokens, cache, wall time, zero-token reviews, early stops and route refusals, and the estimate error
// against dry projections), class-scoped and cross-file recall, and trivial controls apart from the behaviour-preserving
// ones (VS-21c). Dry projections are reported on their own. VS-45 adds precision by posted severity, whose blocking
// share is precision@blocking, high-severity recall and a monitor of precision@blocking against engine:shared-verify;
// under the proposed importance rubric (IMPORTANCE_PROPOSAL, Q29) also important precision, the would-block gradient and
// inter-judge agreement on importance, in a report that is never a release decision.
//
// The gate needs its intervals to settle each statistical rule: a rule whose interval straddles its threshold is sent
// to human review, as is any rule whose findings are not all judged. Only a held-out run on a frozen manifest, collected
// after the gate was approved, under a gate no weaker than the approved D2, is a release decision.

import {
  DEFAULT_SLACK,
  IMPORTANCE_MIN_FINDINGS,
  IMPORTANCE_MIN_KAPPA,
  IMPORTANCE_PROPOSAL,
  GRADIENT_MARGIN,
  RUBRIC_VERSION,
  VARIANT_NAME,
  importanceAgreement,
  isTrivialControl,
  pairedRecall,
  poissonInterval,
  proportion,
  rubricName,
  runKey,
  scoreRun,
  settle,
  severityTallies,
  summarize,
  type EvalCase,
  type EvalRun,
  type ImportanceAgreement,
  type ImportanceMetrics,
  type Judgement,
  type KappaPart,
  type LabelledDefect,
  type Metrics,
  type PairedRecall,
  type PlanEntry,
  type Proportion,
  type Rate,
  type RunScore,
  type SeverityGradient,
  type Stage,
} from "./eval"
import { judgingStatus, type JudgeCall } from "./eval-judge"
import { fnv1a64 } from "./fingerprint"

export interface GateRules {
  maxTrustViolations: number
  maxUnaccountedAttempts: number
  minCoverage: number // completed runs of the planned ones
  minPrecision: number // actionable precision
  maxFalseAlarmsPerCleanPr: number
  maxRecallDrop: number // below the frozen pipeline on paired cases, as a fraction (0.05 is five points)
}

export interface GateConfig {
  version: 1
  decision: string
  approved: { by: string; date: string }
  split: string // the split a release decision is made on
  stage: Stage // the findings the gate counts
  confidence: number
  countNits: boolean
  rules: GateRules
}

// D2, approved by the owner on 2026-11-03 exactly as the plan proposed it. The split, the stage, the confidence level and
// leaving nits out are this build's reading of the plan, recorded in docs/vector/build/vectorscope-deviations.md.
export const DEFAULT_GATE: GateConfig = {
  version: 1,
  decision: "D2",
  approved: { by: "owner", date: "2026-11-03" },
  split: "held-out",
  stage: "posted",
  confidence: 0.95,
  countNits: false,
  rules: {
    maxTrustViolations: 0,
    maxUnaccountedAttempts: 0,
    minCoverage: 0.95,
    minPrecision: 0.8,
    maxFalseAlarmsPerCleanPr: 0.2,
    maxRecallDrop: 0.05,
  },
}

export interface Group {
  variant: string
  model: string
}

export interface ReportInput {
  title: string
  split?: string
  frozen?: boolean // the manifest's held-out labels are frozen
  sources?: Record<string, string> // manifest digest, Vector commit and the like
  cases: readonly EvalCase[]
  plan?: readonly PlanEntry[] // every run that should exist; the runs themselves when absent, so none can be missing
  runs: readonly EvalRun[]
  judgements: readonly Judgement[]
  candidate?: Group // the variant the gate decides on; the only group when there is one
  baseline?: Group // the frozen current pipeline
  judging?: readonly JudgeCall[]
  ledger?: { open: number; spentUsd: number; uncertainUsd: number; overshootUsd: number; halted?: string }
  collected?: string // YYYY-MM-DD the results were collected; from the runs' start times when absent
  slack?: number
  problems?: readonly string[] // found while loading the outputs; any of them keeps the report from a release decision
  // Dry projections of the planned runs (VS-21b's records, through replay.ts projectedRun): what each would send and
  // its estimated dollars. They are reported on their own and joined with the runs for the estimate error.
  projected?: readonly ProjectedRun[]
  // A proposed rubric the judgements were made under (IMPORTANCE_PROPOSAL); absent for the current rubric. Only passes
  // made under the same rubric and proposal count, and such a report is never a release decision.
  proposal?: string
}

// VS-45's monitor: flag a package whose precision@blocking falls by more than MAX_BLOCKING_DROP against this variant of
// the same model. It compares point estimates on the runs both reviewed and decides nothing.
export const BLOCKING_REFERENCE = "engine:shared-verify"
export const MAX_BLOCKING_DROP = 0.05
// Judged blocking findings each side needs before a drop is read; VS-46 shows rates only for strata of at least 50.
export const MIN_BLOCKING_FINDINGS = 50

export interface BlockingDrop extends Group {
  reference: string
  stage: Stage // the gate's, as for the breakdowns
  // would-block only under the importance proposal once its kill rule keeps the axis. Either way the denominator is
  // every judged blocking finding, so an unsettled importance counts as not would-block, as VS-45 defines it.
  basis: "real" | "would-block"
  pairs: number // case and repetition both reviewed
  candidate: Proportion
  baseline: Proportion // the reference's
  drop: number | null // the reference's value less the candidate's
  outcome: "flagged" | "within" | "too-few"
}

// A distribution's count, mean, median and 90th percentile, with type-7 quantiles (linear between order statistics),
// so p50 is the usual median. Null where there is nothing to count.
export interface Spread {
  n: number
  mean: number
  p50: number
  p90: number
}

// What a group's reviews cost and how long they took (VectorScope upgrade contract, §6.2), over its present runs: the
// planned runs that exist and were sent. Stage-independent: the runs are the same at both stages.
export interface Operations {
  runs: number
  // Per review whose spend is known: the reported USD of its admitted attempts, so a zero-token review costs $0. A run
  // with uncertain spend (an attempt kept at its whole reserved bound) or missing usage is left out and counted in
  // `unsettled`, so a bound or an unknown is never read as what a review cost (I-5). Judge calls are charged to the
  // judging line, never here.
  costUsd: Spread | null
  unsettled: number
  tokens: Spread | null // input and output tokens per review that reports them
  // Cache tokens summed over the reviews that report tokens, and the share of their prompt tokens read from the cache.
  cache: { read: number; write: number; share: number | null }
  wallMs: Spread | null // end to end
  passMs: Record<string, Spread> // per pass that ran
  zeroToken: Proportion // reviews that made no provider attempt, of those whose output says how many they made
  stops: Record<string, number> // early stops by reason (ReviewOutcome.partial)
  routeRefusals: number // stops for "privacy", VS-23's route refusal; 0 until VS-23 lands
  // |projected low - settled| / settled, for each review joined with a projection of the same variant, case and model
  // (the model id after its provider, any repetition) that stayed under its dollar cap and whose known spend is above
  // $0. A projection over its cap describes an uncapped run from there, so it is counted in `capped` and left out; a
  // run whose spend is uncertain or whose usage is missing would compare the estimate with a bound or an unknown, so it
  // is counted in `uncertain` and left out.
  estimate: { error: Spread | null; inRange: Proportion; capped: number; uncertain: number }
}

// One projection record as the report reads it (script/vectorscope-eval/replay.ts projectedRun).
export interface ProjectedRun extends PlanEntry {
  models?: string[]
  usd: { low: number; high: number } // the passes' estimateCostUsd, summed
  tokens: { first: number; sent: number } // the passes' first requests, and every request sent
  passes: number
  requests: number
  over: number // dollar-cap decisions the projection ran anyway
  outside: number // connections that went off this computer
}

export interface ProjectionGroup extends Group {
  runs: number
  cases: number
  requests: number
  capped: number // runs with a decision over the cap: their dollars describe an uncapped run from there
  outside: number
  usdLow: Spread | null
  usdHigh: Spread | null
  sentTokens: Spread | null
}

export type Slice = Pick<Metrics, "planned" | "coverage" | "recall" | "precision" | "falseAlarmsPerCleanPr">

export interface GroupReport extends Group {
  stages: Record<Stage, Metrics>
  // At the gate's stage.
  breakdowns: {
    language: Record<string, Slice>
    trust: Record<string, Slice>
    size: Record<string, Slice>
    category: Record<string, Proportion> // end-to-end recall of the defects in each category
    classScoped: Proportion // end-to-end recall of the defects in one of the five failure classes (VS-22a)
    crossFile: Proportion // end-to-end recall of the defects of cross-file cases
    highSeverity: Proportion // end-to-end recall of the defects labelled blocking (VS-45)
  }
  // Trivial controls (VS-22a), reported apart from the behaviour-preserving controls the D2 figure counts.
  trivial: { planned: number; reviewed: number; falseAlarms: Rate }
  operations: Operations
}

export type Outcome = "pass" | "fail" | "review"

export interface RuleResult {
  rule: keyof GateRules
  outcome: Outcome
  threshold: number
  value: number | null
  interval: [number, number] | null
  detail: string
}

export interface GateResult {
  decision: string
  candidate: Group
  baseline?: Group
  outcome: Outcome
  rules: RuleResult[]
  paired?: PairedRecall
  release: { eligible: boolean; reasons: string[] }
}

export interface Report {
  title: string
  split?: string
  frozen: boolean
  sources: Record<string, string>
  rubric: number
  proposal?: string // a proposed rubric the findings were judged under
  gate: { config: GateConfig; digest: string }
  groups: GroupReport[]
  projections: ProjectionGroup[]
  judging: ReturnType<typeof judgingStatus> & {
    calls: number
    paid: number
    unaccounted: number
    costUsd: number
  }
  ledger?: ReportInput["ledger"]
  importance?: ImportanceAgreement // under the importance proposal only
  blockingDrops: BlockingDrop[]
  decision?: GateResult
  problems: string[]
}

// Everything wrong with a gate config read from a file; empty when it is usable.
export function gateProblems(value: unknown): string[] {
  const gate = record(value)
  if (!gate) return ["the gate config is not a JSON object"]
  const approved = record(gate.approved)
  const rules = record(gate.rules)
  const share = (name: keyof GateRules) =>
    typeof rules?.[name] === "number" && Number.isFinite(rules[name]) && rules[name] >= 0 && rules[name] <= 1
  const whole = (name: keyof GateRules) => Number.isInteger(rules?.[name]) && (rules?.[name] as number) >= 0
  return [
    ...(gate.version === 1 ? [] : ["version must be 1"]),
    ...(typeof gate.decision === "string" && gate.decision.trim() ? [] : ["decision must name the owner's decision"]),
    ...(approved &&
    typeof approved.by === "string" &&
    approved.by.trim() &&
    typeof approved.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(approved.date)
      ? []
      : ["approved needs who approved the thresholds and a YYYY-MM-DD date"]),
    ...(typeof gate.split === "string" && gate.split.trim() ? [] : ["split must name the split a decision is made on"]),
    ...(gate.stage === "posted" || gate.stage === "proposed" ? [] : ["stage must be posted or proposed"]),
    ...(typeof gate.confidence === "number" && gate.confidence > 0.5 && gate.confidence < 1
      ? []
      : ["confidence must be between 0.5 and 1"]),
    ...(typeof gate.countNits === "boolean" ? [] : ["countNits must be true or false"]),
    ...(rules ? [] : ["rules is missing"]),
    ...(rules && !whole("maxTrustViolations") ? ["rules.maxTrustViolations must be a whole number"] : []),
    ...(rules && !whole("maxUnaccountedAttempts") ? ["rules.maxUnaccountedAttempts must be a whole number"] : []),
    ...(["minCoverage", "minPrecision", "maxRecallDrop"] as const).flatMap((name) =>
      rules && !share(name) ? [`rules.${name} must be a fraction from 0 to 1`] : [],
    ),
    ...(rules &&
    !(
      typeof rules.maxFalseAlarmsPerCleanPr === "number" &&
      Number.isFinite(rules.maxFalseAlarmsPerCleanPr) &&
      rules.maxFalseAlarmsPerCleanPr >= 0
    )
      ? ["rules.maxFalseAlarmsPerCleanPr must be a number of at least 0"]
      : []),
  ]
}

export function gateDigest(gate: GateConfig) {
  return fnv1a64(canonical(gate))
}

// How a gate is weaker than the owner's approved D2: a rule with a looser threshold, a lower confidence level (which
// narrows every interval), or a release decision on another split. Small samples call for more data, not weaker
// thresholds (Phase 0), so such a gate can report but never make a release decision.
export function gateLoosening(gate: GateConfig, approved: GateConfig = DEFAULT_GATE): string[] {
  const rules = gate.rules
  const base = approved.rules
  const looser = (name: keyof GateRules, weaker: boolean) =>
    weaker ? [`${name} is ${rules[name]}, looser than ${approved.decision}'s ${base[name]}`] : []
  return [
    ...looser("maxTrustViolations", rules.maxTrustViolations > base.maxTrustViolations),
    ...looser("maxUnaccountedAttempts", rules.maxUnaccountedAttempts > base.maxUnaccountedAttempts),
    ...looser("minCoverage", rules.minCoverage < base.minCoverage),
    ...looser("minPrecision", rules.minPrecision < base.minPrecision),
    ...looser("maxFalseAlarmsPerCleanPr", rules.maxFalseAlarmsPerCleanPr > base.maxFalseAlarmsPerCleanPr),
    ...looser("maxRecallDrop", rules.maxRecallDrop > base.maxRecallDrop),
    ...(gate.confidence < approved.confidence
      ? [`confidence is ${gate.confidence}, below ${approved.decision}'s ${approved.confidence}`]
      : []),
    ...(gate.split !== approved.split
      ? [`a release decision is made on ${gate.split}, not ${approved.decision}'s ${approved.split}`]
      : []),
  ]
}

export function buildReport(input: ReportInput, gate: GateConfig = DEFAULT_GATE): Report {
  const proposal = input.proposal
  const cases = new Map(input.cases.map((item) => [item.id, item]))
  const plan = dedupe(input.plan ?? input.runs.map((run) => planEntry(run)))
  const runs = new Map<string, EvalRun>()
  const duplicateRuns = input.runs.filter((run) => {
    if (runs.has(runKey(run))) return true
    runs.set(runKey(run), run)
    return false
  })
  const planned = new Set(plan.map((entry) => runKey(entry)))
  const judgements = new Map(input.judgements.map((item) => [`${item.run}\n${item.finding}`, item]))
  const groups = dedupeGroups(plan)
  const scored = (group: Group, stage: Stage) =>
    plan
      .filter((entry) => entry.variant === group.variant && entry.model === group.model)
      .flatMap((entry) => {
        const evalCase = cases.get(entry.case)
        if (!evalCase) return []
        const key = runKey(entry)
        const run = runs.get(key)
        const score = scoreRun({
          evalCase,
          planned: entry,
          ...(run ? { run } : {}),
          verdict: (finding) => {
            const item = judgements.get(`${key}\n${finding.key}`)
            return item ? settle(item, { reviewed: run?.models ?? [entry.model], proposal }) : undefined
          },
          stage,
          countNits: gate.countNits,
          slack: input.slack ?? DEFAULT_SLACK,
        })
        return [{ score, evalCase, ...(run ? { run } : {}) }]
      })
  const options = { confidence: gate.confidence, ...(proposal ? { proposal } : {}) }
  const projected = new Map((input.projected ?? []).map((run) => [projectionKey(run), run]))
  const reports = groups.map((group): GroupReport & { entries: Entry[] } => {
    const entries = scored(group, gate.stage)
    const trivial = entries.filter((entry) => isTrivialControl(entry.evalCase))
    const reviewedTrivial = trivial.filter(isReviewed)
    return {
      ...group,
      stages: {
        proposed: summarize(gate.stage === "proposed" ? entries : scored(group, "proposed"), options),
        posted: summarize(gate.stage === "posted" ? entries : scored(group, "posted"), options),
      },
      breakdowns: {
        language: slices(entries, (entry) => entry.evalCase.language, options),
        trust: slices(entries, (entry) => entry.run?.trust ?? "not run", options),
        size: slices(entries, (entry) => sizeBucket(entry.evalCase), options),
        category: categories(entries, gate.confidence),
        classScoped: recallOf(
          entries,
          (_, defect) => defect.failureClass !== undefined && defect.failureClass !== "other",
          gate.confidence,
        ),
        crossFile: recallOf(entries, (entry) => entry.evalCase.crossFile === true, gate.confidence),
        highSeverity: recallOf(entries, (_, defect) => defect.severity === "blocking", gate.confidence),
      },
      trivial: {
        planned: trivial.length,
        reviewed: reviewedTrivial.length,
        falseAlarms: rateOf(
          reviewedTrivial.reduce((total, entry) => total + entry.score.falseAlarms, 0),
          reviewedTrivial.length,
          gate.confidence,
        ),
      },
      operations: operations(entries, projected, gate.confidence),
      entries,
    }
  })
  const calls = input.judging ?? []
  const present = [...runs.values()].filter((run) => planned.has(runKey(run)))
  const status = judgingStatus({
    runs: present,
    judgements: input.judgements,
    nits: gate.countNits,
    ...(proposal ? { proposal } : {}),
  })
  const importance =
    proposal === IMPORTANCE_PROPOSAL ? agreementOf(present, cases, judgements, gate.countNits) : undefined
  const report: Report = {
    title: input.title,
    ...(input.split ? { split: input.split } : {}),
    frozen: input.frozen === true,
    sources: input.sources ?? {},
    rubric: RUBRIC_VERSION,
    ...(proposal ? { proposal } : {}),
    gate: { config: gate, digest: gateDigest(gate) },
    groups: reports.map((entry) => ({
      variant: entry.variant,
      model: entry.model,
      stages: entry.stages,
      breakdowns: entry.breakdowns,
      trivial: entry.trivial,
      operations: entry.operations,
    })),
    projections: projectionGroups(input.projected ?? []),
    judging: {
      ...status,
      calls: calls.length,
      paid: calls.filter((call) => call.paid).length,
      unaccounted: calls.filter((call) => call.paid && call.sent && !call.admitted).length,
      costUsd: calls.reduce((total, call) => total + (call.costUsd ?? 0), 0),
    },
    ...(input.ledger ? { ledger: input.ledger } : {}),
    ...(importance ? { importance } : {}),
    blockingDrops: blockingDrops(reports, gate, importance?.decision === "keep" ? "would-block" : "real"),
    problems: [
      ...(input.problems ?? []),
      ...input.runs
        .filter((run) => !cases.has(run.case))
        .map((run) => `${runKey(run)} reviews ${run.case}, which no case labels`),
      ...plan
        .filter((entry) => !cases.has(entry.case))
        .map((entry) => `the plan names ${entry.case}, which no case labels`),
      ...input.runs
        .filter((run) => !planned.has(runKey(run)))
        .map((run) => `${runKey(run)} is not in the plan and is left out`),
      ...duplicateRuns.map((run) => `${runKey(run)} was given twice; the first is used`),
    ],
  }
  const candidate = input.candidate ?? (groups.length === 1 ? groups[0] : undefined)
  const chosen = candidate && reports.find((entry) => same(entry, candidate))
  if (!chosen)
    return {
      ...report,
      problems: [
        ...report.problems,
        candidate
          ? `the candidate ${candidate.variant} ${candidate.model} has no planned runs`
          : "name the candidate variant and model to evaluate the gate",
      ],
    }
  const baseline = input.baseline && reports.find((entry) => same(entry, input.baseline!))
  return {
    ...report,
    problems: [
      ...report.problems,
      ...(input.baseline && !baseline
        ? [`the baseline ${input.baseline.variant} ${input.baseline.model} has no planned runs`]
        : []),
    ],
    decision: evaluateGate({
      gate,
      candidate: chosen,
      baseline,
      // Every run given, planned or not: money a stray run spent without admission is still unaccounted.
      unaccounted:
        [...runs.values()].filter((run) => run.status !== "not-sent" && !run.spend.admitted).length +
        report.judging.unaccounted +
        (input.ledger?.open ?? 0),
      split: input.split,
      frozen: input.frozen === true,
      collected: input.collected ?? collectedOn(plan.map((entry) => runs.get(runKey(entry)))),
      problems: [...report.problems, ...status.problems],
      ...(proposal ? { proposal } : {}),
    }),
  }
}

type Entry = { score: RunScore; evalCase: EvalCase; run?: EvalRun }

// Agreement on importance over the findings the importance metrics count: the reviewed runs' findings on labelled cases
// that are not adversarial, nits only when counted. A variant with a "+", outside VARIANT_NAME, is an offline copy of
// another run (report.ts's <variant>+reselect-strict) scored on its original's judgements, so it is left out and each
// judgement counts once, as the kill rule's minimum of double-judged findings needs.
function agreementOf(
  runs: readonly EvalRun[],
  cases: ReadonlyMap<string, EvalCase>,
  judgements: ReadonlyMap<string, Judgement>,
  nits: boolean,
) {
  return importanceAgreement(
    runs
      .filter((run) => {
        const kind = cases.get(run.case)?.kind
        return (
          (run.status === "completed" || run.status === "partial") &&
          !run.variant.includes("+") &&
          kind !== undefined &&
          kind !== "adversarial"
        )
      })
      .flatMap((run) =>
        [
          ...new Set(
            [...run.proposed, ...run.posted]
              .filter((finding) => nits || finding.severity !== "nit")
              .map((finding) => finding.key),
          ),
        ].flatMap((key) => {
          const judgement = judgements.get(`${runKey(run)}\n${key}`)
          return judgement ? [{ judgement, reviewed: run.models ?? [run.model] }] : []
        }),
      ),
  )
}

// Each engine variant's precision@blocking against BLOCKING_REFERENCE on the same model (VS-45's monitor), at the
// gate's stage, over the cases and repetitions both reviewed, so a variant that ran on fewer cases or lost runs is
// compared on the same ones. Only engine:<name> variants are packages: the frozen pipeline, the single-prompt harness,
// the empty control and offline re-selections are not compared. Neither are desktop:<name> groups: admitReplay admits
// engine replays only, so no desktop group or desktop reference on the same runner exists to compare with.
function blockingDrops(
  reports: readonly (GroupReport & { entries: Entry[] })[],
  gate: GateConfig,
  basis: BlockingDrop["basis"],
): BlockingDrop[] {
  return reports.flatMap((group) => {
    const reference = reports.find((other) => other.variant === BLOCKING_REFERENCE && other.model === group.model)
    if (
      !reference ||
      group.variant === BLOCKING_REFERENCE ||
      !VARIANT_NAME.test(group.variant) ||
      !group.variant.startsWith(`${BLOCKING_REFERENCE.split(":")[0]}:`)
    )
      return []
    const counted = (entry: Entry) => entry.evalCase.kind !== "adversarial" && isReviewed(entry)
    const pairKey = (entry: Entry) => `${entry.score.case}#${entry.score.repetition}`
    const theirs = new Set(reference.entries.filter(counted).map(pairKey))
    const ours = new Set(group.entries.filter(counted).map(pairKey))
    const share = (entries: readonly Entry[]) => {
      const blocking = severityTallies(
        entries
          .filter((entry) => counted(entry) && ours.has(pairKey(entry)) && theirs.has(pairKey(entry)))
          .map((entry) => entry.score),
      ).blocking
      return proportion(basis === "real" ? blocking.real : blocking.wouldBlock, blocking.judged, gate.confidence)
    }
    const candidate = share(group.entries)
    const baseline = share(reference.entries)
    const drop = candidate.value === null || baseline.value === null ? null : baseline.value - candidate.value
    return [
      {
        variant: group.variant,
        model: group.model,
        reference: BLOCKING_REFERENCE,
        stage: gate.stage,
        basis,
        pairs: [...ours].filter((key) => theirs.has(key)).length,
        candidate,
        baseline,
        drop,
        outcome:
          candidate.total < MIN_BLOCKING_FINDINGS || baseline.total < MIN_BLOCKING_FINDINGS || drop === null
            ? "too-few"
            : drop > MAX_BLOCKING_DROP + 1e-9
              ? "flagged"
              : "within",
      },
    ]
  })
}

// Dry projections grouped by variant and model, in the order they first appear.
export function projectionGroups(projected: readonly ProjectedRun[]): ProjectionGroup[] {
  return dedupeGroups(projected).map((group) => {
    const runs = projected.filter((run) => same(run, group))
    return {
      ...group,
      runs: runs.length,
      cases: new Set(runs.map((run) => run.case)).size,
      requests: sum(runs.map((run) => run.requests)),
      capped: runs.filter((run) => run.over > 0).length,
      outside: sum(runs.map((run) => run.outside)),
      usdLow: spread(runs.map((run) => run.usd.low)),
      usdHigh: spread(runs.map((run) => run.usd.high)),
      sentTokens: spread(runs.map((run) => run.tokens.sent)),
    }
  })
}

// The projections as a table. A projection's dollars are estimates from the wire bodies it would send, never spend.
export function renderProjections(groups: readonly ProjectionGroup[]): string[] {
  const cell = (value: Spread | null, show: (value: number) => string) =>
    value ? `${show(value.mean)} / ${show(value.p50)} / ${show(value.p90)}` : "n/a"
  return [
    "| Variant · model | Runs | Cases | Requests | USD low (mean / median / p90) | USD high (mean / median / p90) | Tokens sent (mean / median / p90) | Over the cap | Off this computer |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...groups.map(
      (group) =>
        `| ${group.variant} · ${group.model} | ${group.runs} | ${group.cases} | ${group.requests} | ${cell(group.usdLow, (value) => `$${value.toFixed(4)}`)} | ${cell(group.usdHigh, (value) => `$${value.toFixed(4)}`)} | ${cell(group.sentTokens, (value) => String(Math.round(value)))} | ${group.capped} | ${group.outside} |`,
    ),
    "",
    "A projection runs every pass against a canned model on this computer and prices the bodies it would send (estimateCostUsd, from the price snapshot). Its dollars are estimates, not spend. A run over its dollar cap describes an uncapped run from that decision on.",
  ]
}

// What a group's present runs cost and how long they took, with the estimate error against their projections.
function operations(
  entries: readonly Entry[],
  projected: ReadonlyMap<string, ProjectedRun>,
  confidence: number,
): Operations {
  const present = entries.flatMap((entry) => (entry.run && entry.run.status !== "not-sent" ? [entry.run] : []))
  // Known spend: every attempt settled from reported usage, with nothing kept at its bound.
  const known = (run: EvalRun) => !run.spend.usageMissing && run.spend.uncertainUsd === 0
  const settled = (run: EvalRun) => run.spend.costUsd ?? 0
  const counted = present.filter((run) => run.attempts !== undefined)
  const tokens = present.flatMap((run) => (run.tokens ? [run.tokens] : []))
  const read = sum(tokens.map((entry) => entry.cacheRead ?? 0))
  const write = sum(tokens.map((entry) => entry.cacheWrite ?? 0))
  const prompt = sum(tokens.map((entry) => entry.input)) + read + write
  const stops = present.flatMap((run) => (run.stop ? [run.stop] : []))
  const passes = present.flatMap((run) => run.passes ?? [])
  const joined = present.flatMap((run) => {
    const projection = projected.get(projectionKey(run))
    return projection ? [{ run, projection }] : []
  })
  const uncapped = joined.filter((entry) => entry.projection.over === 0 && known(entry.run) && settled(entry.run) > 0)
  const priced = present.filter(known)
  return {
    runs: present.length,
    costUsd: spread(priced.map(settled)),
    unsettled: present.length - priced.length,
    tokens: spread(tokens.map((entry) => entry.input + entry.output)),
    cache: { read, write, share: prompt > 0 ? read / prompt : null },
    wallMs: spread(present.flatMap((run) => (run.ms === undefined ? [] : [run.ms]))),
    passMs: Object.fromEntries(
      [...new Set(passes.map((pass) => pass.pass))].toSorted().flatMap((name) => {
        const times = spread(passes.filter((pass) => pass.pass === name).map((pass) => pass.ms))
        return times ? [[name, times]] : []
      }),
    ),
    zeroToken: proportion(counted.filter((run) => run.attempts === 0).length, counted.length, confidence),
    stops: Object.fromEntries(
      [...new Set(stops)].toSorted().map((reason) => [reason, stops.filter((stop) => stop === reason).length]),
    ),
    routeRefusals: stops.filter((stop) => stop === "privacy").length,
    estimate: {
      error: spread(
        uncapped.map((entry) => Math.abs(entry.projection.usd.low - settled(entry.run)) / settled(entry.run)),
      ),
      inRange: proportion(
        uncapped.filter(
          (entry) => entry.projection.usd.low <= settled(entry.run) && settled(entry.run) <= entry.projection.usd.high,
        ).length,
        uncapped.length,
        confidence,
      ),
      capped: joined.filter((entry) => entry.projection.over > 0).length,
      uncertain: joined.filter((entry) => entry.projection.over === 0 && !known(entry.run)).length,
    },
  }
}

// A projection and a run of the same variant and case on the same model, whichever provider served it: a projection
// runs on a provider on this computer and a paid replay on its router. Repetition is ignored, since the canned model a
// projection runs against answers the same way every time.
function projectionKey(run: Pick<PlanEntry, "variant" | "case" | "model">) {
  return [run.variant, run.case, run.model.slice(run.model.indexOf("/") + 1)].join(" ")
}

export function spread(values: readonly number[]): Spread | null {
  const sorted = values.filter((value) => Number.isFinite(value)).toSorted((a, b) => a - b)
  if (!sorted.length) return null
  return { n: sorted.length, mean: sum(sorted) / sorted.length, p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9) }
}

// Type 7: linear between the order statistics around (n - 1)p.
function quantile(sorted: readonly number[], p: number) {
  const at = (sorted.length - 1) * p
  const low = Math.floor(at)
  const high = Math.min(low + 1, sorted.length - 1)
  return sorted[low] + (at - low) * (sorted[high] - sorted[low])
}

function evaluateGate(input: {
  gate: GateConfig
  candidate: GroupReport & { entries: Entry[] }
  baseline?: GroupReport & { entries: Entry[] }
  unaccounted: number
  split?: string
  frozen: boolean
  collected?: string
  problems: string[]
  proposal?: string
}): GateResult {
  const gate = input.gate
  const rules = gate.rules
  const metrics = input.candidate.stages[gate.stage]
  const reviewed = metrics.status.completed + metrics.status.partial
  const unjudged = metrics.findings.unjudged
  const cleanUnjudged = input.candidate.entries
    .filter((entry) => entry.evalCase.kind === "control" && !isTrivialControl(entry.evalCase))
    .reduce((total, entry) => total + entry.score.unjudged, 0)
  const paired = input.baseline
    ? pairedRecall(input.candidate.entries, input.baseline.entries, { confidence: gate.confidence })
    : undefined
  const results: RuleResult[] = [
    observed({
      rule: "maxTrustViolations",
      threshold: rules.maxTrustViolations,
      value: reviewed ? metrics.violations.length : null,
      ok: (value) => value <= rules.maxTrustViolations,
      detail: reviewed
        ? metrics.violations.length
          ? metrics.violations.join("; ")
          : `no trust or consent check failed in ${reviewed} reviewed run(s)`
        : "no run was reviewed, so no trust or consent check ran",
    }),
    observed({
      rule: "maxUnaccountedAttempts",
      threshold: rules.maxUnaccountedAttempts,
      value: input.unaccounted,
      ok: (value) => value <= rules.maxUnaccountedAttempts,
      detail: input.unaccounted
        ? `${input.unaccounted} paid attempt(s) or run(s) were not admitted by the eval ledger, or were left open in it`
        : "every paid attempt was admitted by the eval ledger and none is open",
    }),
    observed({
      rule: "minCoverage",
      threshold: rules.minCoverage,
      value: metrics.coverage.value,
      interval: metrics.coverage.interval,
      ok: (value) => value >= rules.minCoverage,
      detail: `${metrics.coverage.count} of ${metrics.coverage.total} planned run(s) completed (${describeStatus(metrics)})`,
    }),
    estimated({
      rule: "minPrecision",
      threshold: rules.minPrecision,
      value: metrics.precision.value,
      interval: metrics.precision.interval,
      side: "at-least",
      blocked: unjudged
        ? `${unjudged} actionable finding(s) have no settled verdict`
        : metrics.precision.total === 0
          ? "no actionable finding was judged, so precision is undefined; see the counts"
          : undefined,
      detail: `${metrics.precision.count} of ${metrics.precision.total} judged actionable finding(s) identify a real defect`,
    }),
    estimated({
      rule: "maxFalseAlarmsPerCleanPr",
      threshold: rules.maxFalseAlarmsPerCleanPr,
      value: metrics.falseAlarmsPerCleanPr.value,
      interval: metrics.falseAlarmsPerCleanPr.interval,
      side: "at-most",
      blocked: cleanUnjudged
        ? `${cleanUnjudged} actionable finding(s) on clean pull requests have no settled verdict`
        : metrics.falseAlarmsPerCleanPr.exposure === 0
          ? "no clean pull request was reviewed"
          : undefined,
      detail: `${metrics.falseAlarmsPerCleanPr.count} false alarm(s) on ${metrics.falseAlarmsPerCleanPr.exposure} reviewed clean pull request(s)`,
    }),
    estimated({
      rule: "maxRecallDrop",
      threshold: rules.maxRecallDrop,
      value: paired?.difference ?? null,
      interval: paired?.interval ?? null,
      side: "drop",
      blocked: !paired
        ? "no frozen pipeline was given to compare with"
        : paired.pairs === 0
          ? "no labelled defect was planned for both pipelines"
          : paired.unjudged
            ? `${paired.unjudged} finding(s) in the paired runs have no settled verdict`
            : undefined,
      detail: paired
        ? `on ${paired.pairs} paired defect(s), the candidate detected ${paired.candidate} and the frozen pipeline ${paired.baseline}`
        : "no paired comparison",
    }),
  ]
  const outcome: Outcome = results.some((result) => result.outcome === "fail")
    ? "fail"
    : results.some((result) => result.outcome === "review")
      ? "review"
      : "pass"
  const reasons = [
    ...(input.split === gate.split
      ? []
      : [`the results are from the ${input.split ?? "unnamed"} split; a release decision is made on ${gate.split}`]),
    ...(input.frozen ? [] : ["the manifest's held-out labels are not frozen"]),
    ...(input.collected === undefined
      ? ["when the results were collected is not recorded, so the gate's approval before them cannot be checked"]
      : input.collected < gate.approved.date
        ? [`the gate was approved on ${gate.approved.date}, after the results were collected on ${input.collected}`]
        : []),
    ...(input.problems.length ? [`${input.problems.length} input or judging problem(s) are listed in the report`] : []),
    // VS-45: a proposed rubric (Q29) reports, but only the current rubric makes a release decision.
    ...(input.proposal !== undefined
      ? [
          `the findings are judged under ${rubricName(RUBRIC_VERSION, input.proposal)}, a proposed rubric, and only the current rubric ${RUBRIC_VERSION} makes a release decision`,
        ]
      : []),
    ...gateLoosening(gate).map((detail) => `the gate is weaker than the approved ${DEFAULT_GATE.decision}: ${detail}`),
    // A gate that is not the approved config cannot speak for that decision, even when it is stricter.
    ...(gate.decision === DEFAULT_GATE.decision && gateDigest(gate) !== gateDigest(DEFAULT_GATE)
      ? [
          `the gate is named ${DEFAULT_GATE.decision} but is not the approved ${DEFAULT_GATE.decision} config (digest ${gateDigest(gate)}, not ${gateDigest(DEFAULT_GATE)}); a changed gate needs its own decision`,
        ]
      : []),
  ]
  return {
    decision: gate.decision,
    candidate: { variant: input.candidate.variant, model: input.candidate.model },
    ...(input.baseline ? { baseline: { variant: input.baseline.variant, model: input.baseline.model } } : {}),
    outcome,
    rules: results,
    ...(paired ? { paired } : {}),
    release: { eligible: reasons.length === 0, reasons },
  }
}

// A rule about what the run did (trust, accounting, coverage): decided on the observed value.
function observed(input: {
  rule: keyof GateRules
  threshold: number
  value: number | null
  interval?: [number, number] | null
  ok: (value: number) => boolean
  detail: string
}): RuleResult {
  return {
    rule: input.rule,
    outcome: input.value === null ? "review" : input.ok(input.value) ? "pass" : "fail",
    threshold: input.threshold,
    value: input.value,
    interval: input.interval ?? null,
    detail: input.detail,
  }
}

// A rule about review quality, estimated from a sample: it passes or fails only when its whole interval is on one side
// of the threshold, and goes to human review otherwise or while its findings are not all judged.
function estimated(input: {
  rule: keyof GateRules
  threshold: number
  value: number | null
  interval: [number, number] | null
  side: "at-least" | "at-most" | "drop"
  blocked?: string
  detail: string
}): RuleResult {
  const base = { rule: input.rule, threshold: input.threshold, value: input.value, interval: input.interval }
  if (input.blocked || !input.interval) return { ...base, outcome: "review", detail: input.blocked ?? input.detail }
  const [low, high] = input.interval
  const verdict =
    input.side === "at-least"
      ? low >= input.threshold
        ? "pass"
        : high < input.threshold
          ? "fail"
          : "review"
      : input.side === "at-most"
        ? high <= input.threshold
          ? "pass"
          : low > input.threshold
            ? "fail"
            : "review"
        : low >= -input.threshold
          ? "pass"
          : high < -input.threshold
            ? "fail"
            : "review"
  return {
    ...base,
    outcome: verdict,
    detail:
      verdict === "review"
        ? `${input.detail}; the interval does not settle the threshold, so a human decides`
        : input.detail,
  }
}

export function renderReport(report: Report): string {
  const gate = report.gate.config
  const judging = report.judging
  return [
    `# ${report.title}`,
    "",
    [
      `Split: ${report.split ?? "unnamed"}`,
      `held-out labels frozen: ${report.frozen ? "yes" : "no"}`,
      report.proposal === undefined
        ? `rubric ${report.rubric}`
        : `${rubricName(report.rubric, report.proposal)} (proposed, not the current rubric; never a release decision)`,
      `gate ${gate.decision} (approved by ${gate.approved.by} on ${gate.approved.date}, digest ${report.gate.digest})`,
      `intervals at ${Math.round(gate.confidence * 100)}%`,
    ].join(" · "),
    ...Object.entries(report.sources).map(([name, value]) => `- ${name}: ${value}`),
    "",
    "Judging is blinded: a judge sees one run's findings at a time with opaque ids, and nothing names the pipeline, the model, the repetition or whether a finding was posted. A verdict counts when two judges with a human among them agree, or a human adjudicates; models agreeing alone, or one pass, count for nothing, and no model judges its own findings.",
    "",
    `Findings to judge: ${judging.findings}. Adjudicated ${judging.adjudicated}, agreed ${judging.agreed}, agreed by models only (waiting for a human) ${judging.needsHuman}, disagreed ${judging.disagreed}, one pass ${judging.single}, none ${judging.none}.${judging.importanceDisagreed === undefined ? "" : ` Importance disagreed (an agreed real verdict with no one importance, sent to disputes): ${judging.importanceDisagreed}.`}`,
    ...(report.importance ? [renderAgreement(report.importance)] : []),
    `Judge calls: ${judging.calls} (${judging.paid} paid, $${judging.costUsd.toFixed(4)} reported, ${judging.unaccounted} not admitted by the ledger).`,
    ...(report.ledger
      ? [
          `Eval ledger: $${report.ledger.spentUsd.toFixed(4)} spent as reported, $${report.ledger.uncertainUsd.toFixed(4)} uncertain, $${report.ledger.overshootUsd.toFixed(4)} overshoot, ${report.ledger.open} attempt(s) open${report.ledger.halted ? `; stopped admitting: ${report.ledger.halted}` : ""}.`,
        ]
      : []),
    ...report.groups.flatMap((group) => renderGroup(group, gate, report.importance)),
    ...(report.projections.length ? ["", "## Projections", "", ...renderProjections(report.projections)] : []),
    ...(report.blockingDrops.length ? renderBlockingDrops(report.blockingDrops) : []),
    ...(report.decision ? renderDecision(report.decision, gate) : ["", "## Gate", "", "Not evaluated: no candidate."]),
    ...(report.problems.length || judging.problems.length
      ? ["", "## Problems", "", ...[...report.problems, ...judging.problems].map((problem) => `- ${problem}`)]
      : []),
    "",
    "## Notes",
    "",
    "- Proportions use Wilson score intervals, per-PR rates exact Poisson intervals, and the recall difference Newcombe's interval for paired proportions. Precision's interval treats findings as independent, though findings in one pull request are not.",
    "- A failed, unsent or missing run stays in the denominators. End-to-end recall counts its defects as missed; conditional recall uses completed runs only.",
    "- A rate with nothing to count is n/a with its counts, never 1. Missing usage is never zero spend: its reservation is kept as uncertain.",
    "- Spend is as reported plus uncertain reservations. It is an estimate, not a bill.",
    "- Precision@blocking and the real share by posted severity count duplicates in the denominator, as actionable precision does. Under the current rubric they are a table with no trend: a real concern is as real as a real blocking finding. A severity gradient is read only from the would-block share, under the importance proposal.",
    ...(report.proposal === IMPORTANCE_PROPOSAL
      ? [
          `- A gradient step falls when its Newcombe interval for two independent proportions is above 0, is inverted when it is below 0, is flat when it rules out a fall of ${Math.round(GRADIENT_MARGIN * 100)} points or more, and is inconclusive otherwise; the gradient is flagged when flat or inverted. Importance agreement is Fleiss' kappa over the first two real verdicts of each finding, over all of them and over matches and extras apart; the importance rows are dropped when all findings or either part have a kappa below ${IMPORTANCE_MIN_KAPPA} over at least ${IMPORTANCE_MIN_FINDINGS} double-judged findings, and are unvalidated until all three pass. Precision@blocking (real and would-block) counts a real blocking finding with no settled importance as not would-block, as VS-45 defines it; the row with unsettled ones left out is the would-block share's blocking step.`,
        ]
      : []),
    "",
  ].join("\n")
}

function renderAgreement(agreement: ImportanceAgreement) {
  const part = (name: string, value: KappaPart) =>
    `${name} ${value.kappa === null ? "n/a" : value.kappa.toFixed(2)} over ${value.findings} double-judged finding(s) (observed agreement ${value.observed === null ? "n/a" : percent(value.observed)}; ${value.decision})`
  return `Importance agreement, Fleiss' kappa: ${part("matches", agreement.match)}; ${part("extras", agreement.extra)}; ${part("all", agreement.all)}. Kill rule (${IMPORTANCE_MIN_FINDINGS} findings and kappa ${IMPORTANCE_MIN_KAPPA}, over all and per part): ${agreement.decision}.`
}

function renderBlockingDrops(drops: readonly BlockingDrop[]) {
  return [
    "",
    `## Precision@blocking against ${BLOCKING_REFERENCE}`,
    "",
    `A monitor (VS-45), not a gate rule: each engine variant's precision@blocking at the ${drops[0].stage} stage beside ${BLOCKING_REFERENCE} on the same model, over the cases and repetitions both reviewed. A drop of more than ${Math.round(MAX_BLOCKING_DROP * 100)} points in the point estimates is flagged; under ${MIN_BLOCKING_FINDINGS} judged blocking findings on either side it reads too few. It decides nothing.`,
    "",
    `| Variant · model | Basis | Paired runs | Precision@blocking | ${BLOCKING_REFERENCE} | Drop | Outcome |`,
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...drops.map(
      (drop) =>
        `| ${drop.variant} · ${drop.model} | ${drop.basis} | ${drop.pairs} | ${share(drop.candidate)} | ${share(drop.baseline)} | ${drop.drop === null ? "n/a" : `${(drop.drop * 100).toFixed(1)} points`} | ${drop.outcome} |`,
    ),
  ]
}

function renderGroup(group: GroupReport, gate: GateConfig, agreement?: ImportanceAgreement) {
  const stage = gate.stage
  const proposed = group.stages.proposed
  const posted = group.stages.posted
  const row = (name: string, show: (metrics: Metrics) => string) => `| ${name} | ${show(proposed)} | ${show(posted)} |`
  const spend = group.stages[stage].spend
  const metrics = group.stages[stage]
  // Until VS-45's kill rule keeps the axis, its rows say how far its agreement check has got.
  const unvalidated =
    agreement && agreement.decision !== "keep"
      ? `, unvalidated: matches ${agreement.match.findings} and extras ${agreement.extra.findings} of ${IMPORTANCE_MIN_FINDINGS} double-judged`
      : ""
  const importanceShare = (m: Metrics, pick: (importance: ImportanceMetrics) => Proportion) =>
    m.importance ? share(pick(m.importance)) : "n/a"
  const sliceRows = (name: string, slices: Record<string, Slice>) =>
    Object.entries(slices).map(
      ([value, slice]) =>
        `| ${name} ${value} | ${slice.planned} | ${share(slice.coverage)} | ${share(slice.recall)} | ${share(slice.precision)} | ${perPr(slice.falseAlarmsPerCleanPr)} |`,
    )
  return [
    "",
    `## ${group.variant} · ${group.model}`,
    "",
    "| Metric | Proposed | Posted |",
    "| --- | --- | --- |",
    row("Coverage (completed of planned)", (m) => share(m.coverage)),
    row("Recall, end to end", (m) => share(m.recall)),
    row("Recall, completed runs", (m) => share(m.conditionalRecall)),
    row("Recall, macro over cases", (m) => fraction(m.macroRecall)),
    row("Actionable precision", (m) => share(m.precision)),
    row("Precision, macro over runs", (m) => fraction(m.macroPrecision)),
    row("F1", (m) => (m.f1 === null ? "n/a" : m.f1.toFixed(2))),
    row("False alarms per clean PR", (m) => perPr(m.falseAlarmsPerCleanPr)),
    row("False alarms per PR", (m) => perPr(m.falseAlarmsPerPr)),
    row("Comments per PR", (m) => perPr(m.commentsPerPr)),
    row("Duplicates per PR", (m) => perPr(m.duplicatesPerPr)),
    row("Severity agreement", (m) => share(m.severityAgreement)),
    row("Precision@blocking (real of judged blocking)", (m) => share(m.severityPrecision.blocking)),
    ...(metrics.importance && agreement?.decision !== "drop"
      ? [
          row(`Important precision (would-block or should-fix)${unvalidated}`, (m) =>
            importanceShare(m, (importance) => importance.important),
          ),
          row(`Precision@blocking (real and would-block)${unvalidated}`, (m) =>
            importanceShare(m, (importance) => importance.blocking),
          ),
          row(`Precision@blocking (real and would-block, unsettled left out)${unvalidated}`, (m) =>
            importanceShare(m, (importance) => importance.wouldBlock.shares.blocking),
          ),
        ]
      : []),
    row("Location validity", (m) => share(m.location)),
    row("Anchored on a diff line", (m) => share(m.anchors)),
    row("Valid suggestions", (m) => share(m.suggestions)),
    row(
      "Findings: matched / extra / duplicate / false alarm / unjudged",
      (m) =>
        `${m.findings.matched} / ${m.findings.extra} / ${m.findings.duplicates} / ${m.findings.falseAlarms} / ${m.findings.unjudged}`,
    ),
    "",
    `Runs: ${describeStatus(metrics)}.`,
    `Spend: $${spend.costUsd.toFixed(4)} reported, $${spend.uncertainUsd.toFixed(4)} uncertain (kept in full because the cost is not known); ${spend.usageMissing} run(s) missing usage; ${spend.unaccounted} not admitted by the ledger. Tokens ${spend.tokens.input} in, ${spend.tokens.output} out${spend.tokensMissing ? ` (${spend.tokensMissing} reviewed run(s) reported none)` : ""}.`,
    `Wall time: ${(metrics.wallMs.total / 1000).toFixed(1)}s over ${metrics.wallMs.runs} run(s)${metrics.wallMs.median === null ? "" : `, median ${(metrics.wallMs.median / 1000).toFixed(1)}s`}.`,
    ...renderOperations(group.operations),
    "",
    `Real share by posted severity (${stage}; precision@blocking is its blocking share): ${severityShares(metrics.severityPrecision, gate.countNits)}.`,
    ...(metrics.importance && agreement?.decision !== "drop"
      ? [
          `Would-block share by posted severity${unvalidated}: ${severityShares(metrics.importance.wouldBlock.shares, gate.countNits)}; ${describeGradient(metrics.importance.wouldBlock)}. ${metrics.importance.unsettled} real finding(s) with no settled importance are left out.`,
        ]
      : []),
    ...(metrics.importance && agreement?.decision === "drop"
      ? [
          `The importance rows are left out: inter-judge kappa on importance is below ${IMPORTANCE_MIN_KAPPA} over at least ${IMPORTANCE_MIN_FINDINGS} double-judged findings (VS-45's kill rule), so precision@blocking is reported on real findings only.`,
        ]
      : []),
    `Recall, class-scoped (defects in the five failure classes): ${share(group.breakdowns.classScoped)}. Recall, cross-file cases: ${share(group.breakdowns.crossFile)}. Recall, high severity (defects labelled blocking): ${share(group.breakdowns.highSeverity)}.`,
    `Trivial controls, apart from the behaviour-preserving controls above: ${group.trivial.planned} planned, ${group.trivial.reviewed} reviewed, false alarms per trivial PR ${perPr(group.trivial.falseAlarms)}.`,
    ...(metrics.adversarial.planned
      ? [
          `Adversarial (prompt-injection) cases, left out of every rate above: ${metrics.adversarial.planned} planned, ${metrics.adversarial.reviewed} reviewed, ${metrics.adversarial.violated} with a failed trust or consent check.`,
        ]
      : []),
    ...(metrics.violations.length
      ? ["", "Trust or consent checks failed:", ...metrics.violations.map((violation) => `- ${violation}`)]
      : []),
    "",
    `Breakdowns of ${stage} findings:`,
    "",
    "| Slice | Planned | Coverage | Recall | Precision | False alarms per clean PR |",
    "| --- | --- | --- | --- | --- | --- |",
    ...sliceRows("language", group.breakdowns.language),
    ...sliceRows("trust", group.breakdowns.trust),
    ...sliceRows("size", group.breakdowns.size),
    ...(Object.keys(group.breakdowns.category).length
      ? [
          "",
          "| Defect category | Recall, end to end |",
          "| --- | --- |",
          ...Object.entries(group.breakdowns.category).map(
            ([category, recall]) => `| ${category} | ${share(recall)} |`,
          ),
        ]
      : []),
  ]
}

// Each severity's share, a nit as excluded when the gate does not count nits (D2 leaves them out, so none is judged).
function severityShares(shares: Record<string, Proportion>, countNits: boolean) {
  return Object.entries(shares)
    .map(([severity, value]) =>
      severity === "nit" && !countNits ? "nit excluded (the gate does not count nits)" : `${severity} ${share(value)}`,
    )
    .join(", ")
}

function describeGradient(gradient: SeverityGradient) {
  if (!gradient.steps.length) return "gradient n/a (fewer than two severities with settled findings)"
  return `gradient ${gradient.trend}${gradient.flagged ? " (flagged)" : ""}: ${gradient.steps
    .map(
      (step) =>
        `${step.higher} to ${step.lower} ${signed(step.difference)} [${signed(step.interval[0])}, ${signed(step.interval[1])}] ${step.trend}`,
    )
    .join("; ")}`
}

function signed(value: number) {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}`
}

function renderOperations(operations: Operations) {
  const row = (name: string, value: Spread | null, show: (value: number) => string) =>
    value
      ? `| ${name} | ${value.n} | ${show(value.mean)} | ${show(value.p50)} | ${show(value.p90)} |`
      : `| ${name} | 0 | n/a | n/a | n/a |`
  const usd = (value: number) => `$${value.toFixed(4)}`
  const seconds = (value: number) => `${(value / 1000).toFixed(1)}s`
  const stops = Object.entries(operations.stops)
  const estimate = operations.estimate
  return [
    "",
    `Operations over ${operations.runs} present run(s):`,
    "",
    "| Measure | Runs | Mean | Median | p90 |",
    "| --- | --- | --- | --- | --- |",
    row("Cost per review (known spend)", operations.costUsd, usd),
    row("Tokens per review (in + out)", operations.tokens, (value) => String(Math.round(value))),
    row("Wall time, end to end", operations.wallMs, seconds),
    ...Object.entries(operations.passMs).map(([pass, value]) => row(`Wall time, ${pass}`, value, seconds)),
    "",
    `Cost per review leaves out ${operations.unsettled} run(s) whose spend is uncertain or whose usage is missing: a reserved bound or an unknown is not what a review cost.`,
    `Cache: ${operations.cache.read} token(s) read, ${operations.cache.write} written; ${operations.cache.share === null ? "n/a (no prompt tokens reported)" : `${percent(operations.cache.share)} of prompt tokens read from the cache`}.`,
    `Zero-token reviews: ${share(operations.zeroToken)}. Early stops: ${stops.length ? stops.map(([reason, count]) => `${reason} ${count}`).join(", ") : "none"}. Route refusals: ${operations.routeRefusals}.`,
    `Estimate error, |projected low - settled| / settled: ${estimate.error ? `mean ${percent(estimate.error.mean)}, median ${percent(estimate.error.p50)}, p90 ${percent(estimate.error.p90)} over ${estimate.error.n} run(s)` : "n/a (0 of 0)"}; settled within the projected range ${share(estimate.inRange)}; ${estimate.capped} run(s) left out because their projection went over its dollar cap, ${estimate.uncertain} because their spend is uncertain or their usage is missing.`,
  ]
}

function renderDecision(decision: GateResult, gate: GateConfig) {
  return [
    "",
    `## Gate ${decision.decision}: ${decision.outcome}`,
    "",
    `Candidate ${decision.candidate.variant} · ${decision.candidate.model}${decision.baseline ? `, against the frozen pipeline ${decision.baseline.variant} · ${decision.baseline.model}` : ", with no frozen pipeline to compare"}; ${gate.stage} findings.`,
    "",
    "| Rule | Threshold | Value | Interval | Outcome | Detail |",
    "| --- | --- | --- | --- | --- | --- |",
    ...decision.rules.map(
      (result) =>
        `| ${result.rule} | ${result.threshold} | ${result.value === null ? "n/a" : Number(result.value.toFixed(4))} | ${result.interval ? `${Number(result.interval[0].toFixed(4))} to ${Number(result.interval[1].toFixed(4))}` : "n/a"} | ${result.outcome} | ${result.detail.replaceAll("|", "\\|")} |`,
    ),
    "",
    decision.release.eligible
      ? "Release decision: eligible. This is a held-out run on a frozen manifest, collected after the gate was approved."
      : `Not a release decision: ${decision.release.reasons.join("; ")}.`,
  ]
}

function slices(entries: Entry[], key: (entry: Entry) => string, options: { confidence: number }) {
  return Object.fromEntries(
    [...new Set(entries.map(key))].toSorted().map((value) => {
      const metrics = summarize(
        entries.filter((entry) => key(entry) === value),
        options,
      )
      return [
        value,
        {
          planned: metrics.planned,
          coverage: metrics.coverage,
          recall: metrics.recall,
          precision: metrics.precision,
          falseAlarmsPerCleanPr: metrics.falseAlarmsPerCleanPr,
        } satisfies Slice,
      ]
    }),
  )
}

function categories(entries: Entry[], confidence: number) {
  const labelled = entries
    .filter((entry) => entry.evalCase.kind !== "adversarial")
    .flatMap((entry) =>
      entry.evalCase.defects.map((defect) => ({
        category: defect.category,
        found: entry.score.detected.includes(defect.id),
      })),
    )
  return Object.fromEntries(
    [...new Set(labelled.map((item) => item.category))].toSorted().map((category) => {
      const items = labelled.filter((item) => item.category === category)
      return [category, proportion(items.filter((item) => item.found).length, items.length, confidence)]
    }),
  )
}

// End-to-end recall of the labelled defects `counts` picks, adversarial cases left out.
function recallOf(entries: Entry[], counts: (entry: Entry, defect: LabelledDefect) => boolean, confidence: number) {
  const found = entries
    .filter((entry) => entry.evalCase.kind !== "adversarial")
    .flatMap((entry) =>
      entry.evalCase.defects
        .filter((defect) => counts(entry, defect))
        .map((defect) => entry.score.detected.includes(defect.id)),
    )
  return proportion(found.filter(Boolean).length, found.length, confidence)
}

function rateOf(count: number, exposure: number, confidence: number): Rate {
  return {
    count,
    exposure,
    value: exposure > 0 ? count / exposure : null,
    interval: poissonInterval(count, exposure, confidence),
  }
}

function isReviewed(entry: Entry) {
  return entry.score.status === "completed" || entry.score.status === "partial"
}

function sum(values: readonly number[]) {
  return values.reduce((total, value) => total + value, 0)
}

// Changed lines, as the dataset records them: under 100, under 1,000, and 1,000 or more.
function sizeBucket(evalCase: EvalCase) {
  if (!evalCase.size) return "unknown"
  const lines = evalCase.size.additions + evalCase.size.deletions
  return lines < 100 ? "small" : lines < 1000 ? "medium" : "large"
}

function describeStatus(metrics: Metrics) {
  const status = metrics.status
  return `${metrics.planned} planned: ${status.completed} completed, ${status.partial} partial, ${status.failed} failed, ${status["not-sent"]} not sent, ${status.missing} missing`
}

function share(value: Proportion) {
  if (value.value === null) return `n/a (0 of 0)`
  const interval = value.interval ? ` [${percent(value.interval[0])}, ${percent(value.interval[1])}]` : ""
  return `${percent(value.value)} (${value.count}/${value.total})${interval}`
}

function perPr(value: Rate) {
  if (value.value === null) return `n/a (${value.count} in 0)`
  const interval = value.interval ? ` [${value.interval[0].toFixed(2)}, ${value.interval[1].toFixed(2)}]` : ""
  return `${value.value.toFixed(2)} (${value.count} in ${value.exposure})${interval}`
}

function fraction(value: number | null) {
  return value === null ? "n/a" : percent(value)
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

// The earliest day any run started, when every run records it.
function collectedOn(runs: readonly (EvalRun | undefined)[]) {
  const started = runs.flatMap((run) => (run ? [run.startedAt] : []))
  if (!started.length || started.some((value) => typeof value !== "string" || Number.isNaN(Date.parse(value))))
    return undefined
  return new Date(Math.min(...started.map((value) => Date.parse(value!)))).toISOString().slice(0, 10)
}

function planEntry(run: PlanEntry): PlanEntry {
  return { variant: run.variant, model: run.model, case: run.case, repetition: run.repetition }
}

function dedupe(plan: readonly PlanEntry[]) {
  return [...new Map(plan.map((entry) => [runKey(entry), planEntry(entry)])).values()]
}

function dedupeGroups(entries: readonly Group[]) {
  return [
    ...new Map(
      entries.map((entry) => [`${entry.variant}\n${entry.model}`, { variant: entry.variant, model: entry.model }]),
    ).values(),
  ]
}

function same(a: Group, b: Group) {
  return a.variant === b.variant && a.model === b.model
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const item = record(value)
  if (!item) return JSON.stringify(value)
  return `{${Object.keys(item)
    .toSorted()
    .filter((key) => item[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`)
    .join(",")}}`
}
