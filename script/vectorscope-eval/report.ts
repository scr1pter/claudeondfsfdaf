#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { readdirSync, statSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { parseArgs } from "node:util"
import {
  findingKey,
  IMPORTANCE_PROPOSAL,
  RUBRIC_VERSION,
  rubricName,
  runKey,
  type EvalCase,
  type EvalFinding,
  type EvalRun,
  type Judgement,
  type PlanEntry,
} from "../../packages/core/src/review/eval"
import type { JudgeCall } from "../../packages/core/src/review/eval-judge"
import {
  strictIncomplete,
  strictRules,
  type StrictCandidate,
  type StrictIncomplete,
} from "../../packages/core/src/review/guardrail"
import { verifyCandidates, verifyUnanswered } from "../../packages/core/src/review/plan"
import {
  buildReport,
  DEFAULT_GATE,
  gateProblems,
  renderReport,
  type GateConfig,
  type Group,
  type ProjectedRun,
} from "../../packages/core/src/review/eval-report"
import {
  DEFAULT_REVIEW_CONFIG,
  STRICT_DROPS,
  type Finding,
  type ModelFinding,
  type StrictResult,
} from "../../packages/core/src/review/types"
import type { ProjectionRecord, ReplayArtifact } from "../../packages/engine/src/review/eval"
import { Ledger, readJournal, type Entry, type Summary } from "./budget"
import { caseView, manifestProblems, SEED_MANIFEST, SPLITS, type Case, type Manifest } from "./dataset"
import type { DesktopArtifact } from "./desktop"
import { listFixtures, loadFixture, type Fixture } from "./fixture"
import { outsideRepository, REPO_ROOT } from "./paths"
import {
  projectedRun,
  projectionProblems,
  replayCaseKey,
  replayCharge,
  replayVariant,
  pairProblems,
  resolveVariant,
  variantProblems,
} from "./replay"

export { outsideRepository }

// The causal report (VectorScope plan, VS-04). It re-scores saved eval outputs (run.ts --out reports, the engine
// replay's and the desktop replay's artifacts) against the settled verdicts in a judgement file from judge.ts, and
// reports the dry projections beside them (VS-21c), joined with the paid runs for the estimate error. It evaluates the
// release gate,
// by default the owner's approved D2 gate. It reads files and sends nothing, so a revised rubric or gate is applied to
// the same outputs without another provider call. With --empty-control it adds Phase 0's empty-finding baseline: a
// completed, admitted, free review of every planned case that reports nothing, which shows how each denominator
// behaves when there is nothing to count.

export const JUDGEMENTS_SCHEMA = "vectorscope-judgements/1"
export const EMPTY_CONTROL = { variant: "empty", model: "none" } as const
// The run.ts harness's variant (fromRunReport). It and the empty control are the only variants the replay registry
// does not name.
const SINGLE_PROMPT = "single-prompt"
const UNREGISTERED: readonly string[] = [SINGLE_PROMPT, EMPTY_CONTROL.variant]

// The judge's record of every pass, adjudication and judge call, kept by the coordinator outside the repository. It
// holds the seed that blinds the worksheets, so it is never given to a judge. A file made for a proposed rubric
// (judge.ts --proposal) names it, and holds only that proposal's passes: verdicts under two rubrics are never pooled.
// Absent means the current rubric, as every file before VS-45.
export interface JudgementFile {
  schema: typeof JUDGEMENTS_SCHEMA
  seed: string
  proposal?: string
  judgements: Judgement[]
  calls: JudgeCall[]
}

// The proposal a --proposal value names (judge.ts and report.ts): undefined for the current rubric, null when unknown.
export function proposalOption(value: unknown) {
  if (value === undefined) return undefined
  return value === "importance" ? IMPORTANCE_PROPOSAL : null
}

// Why a judgement file cannot be used under the rubric asked for, if it cannot: verdicts under two rubrics are never
// pooled, so a proposal's judgements live in a file of their own.
export function proposalMismatch(path: string, file: Pick<JudgementFile, "proposal">, proposal: string | undefined) {
  if (file.proposal === proposal) return undefined
  const held = rubricName(RUBRIC_VERSION, file.proposal)
  return file.proposal === IMPORTANCE_PROPOSAL
    ? `${path} holds judgements under ${held}, the proposed importance rubric; give --proposal importance, or another judgement file: verdicts under two rubrics are never pooled.`
    : file.proposal === undefined
      ? `${path} holds judgements under the current ${held}; judge the importance proposal in a judgement file of its own: verdicts under two rubrics are never pooled.`
      : `${path} holds judgements under ${held}, not ${rubricName(RUBRIC_VERSION, proposal)}; start another judgement file: verdicts under two rubrics are never pooled.`
}

export interface Outputs {
  cases: EvalCase[]
  runs: EvalRun[]
  plan: PlanEntry[]
  split: string
  frozen: boolean
  sources: Record<string, string>
  ledger?: { open: number; spentUsd: number; uncertainUsd: number; overshootUsd: number; halted?: string }
  projected: ProjectedRun[]
  problems: string[]
  // Under --reselect strict only: each engine replay run and its offline strict re-selection, as runKeys.
  reselected?: { from: string; to: string; reselection: StrictReselection }[]
}

// Every saved output under the given paths, as runs with the cases they review and the plan of runs that should exist.
// A directory is read for its .json files. A run.ts report plans each of its fixtures for every repetition; replay
// artifacts, the engine's and the desktop's, plan every case of the split for each variant, model and repetition seen,
// so a lost artifact shows as missing, and so does a desktop run whose variant never reached its runner. A projection
// record that projectionProblems passes is a projected run; one it does not is listed with its problems.
export async function loadOutputs(input: {
  paths: readonly string[]
  manifest?: string
  split?: string
  ledger?: string
  reselect?: "strict"
}): Promise<Outputs> {
  const files = input.paths.flatMap((path) => jsonFiles(resolve(path)))
  const values = await Promise.all(
    files.map(async (file) => ({ file, value: (await Bun.file(file).json()) as unknown })),
  )
  const reports = values.filter((entry) => isRunReport(entry.value))
  const artifacts = values.filter((entry) => isArtifact(entry.value))
  const desktops = values.filter((entry) => isDesktopArtifact(entry.value))
  const projections = values.filter((entry) => isProjection(entry.value))
  const unknown = values.filter(
    (entry) =>
      !isRunReport(entry.value) &&
      !isArtifact(entry.value) &&
      !isDesktopArtifact(entry.value) &&
      !isProjection(entry.value),
  )
  const journal = input.ledger ? readJournal(resolve(input.ledger)) : []
  const fixtures = reports.length ? await Promise.all((await listFixtures()).map(loadFixture)) : []
  const fromReports = reports.map((entry) => fromRunReport(entry.value as RunReport, fixtures))
  const manifestPath = input.manifest ? resolve(input.manifest) : SEED_MANIFEST
  const replayed = artifacts.length + desktops.length + projections.length
  const manifestText = replayed ? await Bun.file(manifestPath).text() : undefined
  const manifestValue: unknown = manifestText === undefined ? undefined : JSON.parse(manifestText)
  const invalid = manifestValue === undefined ? [] : manifestProblems(manifestValue)
  const manifest = manifestValue !== undefined && !invalid.length ? (manifestValue as Manifest) : undefined
  const split = input.split ?? "development"
  const engineRuns = artifacts.map((entry) => fromArtifact(entry.value as ReplayArtifact, manifest, journal))
  const reselected =
    input.reselect === "strict"
      ? artifacts.flatMap((entry, position) =>
          isArtifact(entry.value)
            ? [{ from: engineRuns[position], ...reselectRun(entry.value, engineRuns[position]) }]
            : [],
        )
      : undefined
  const engineGroups = new Set(engineRuns.map((run) => `${run.variant}\n${run.model}`))
  const desktopRuns = desktops.map((entry) => ({
    entry,
    run: fromDesktopArtifact(entry.value as DesktopArtifact, manifest),
  }))
  const replays = [...engineRuns, ...desktopRuns.flatMap((item) => (item.run ? [item.run] : []))]
  // Every replayed group, a desktop run left out included, so its cases stay planned and show as missing.
  const seen = [
    ...engineRuns,
    ...desktops.map((entry) => {
      const artifact = entry.value as DesktopArtifact
      return {
        variant: replayVariant("desktop", artifact.variant),
        model: artifact.models.review.id,
        repetition: artifact.repetition,
      }
    }),
  ]
  const groups = [...new Map(seen.map((run) => [`${run.variant}\n${run.model}`, run])).values()]
  const replayPlan = manifest
    ? manifest.cases
        .filter((item) => item.split === split)
        .flatMap((item) =>
          groups.flatMap((group) =>
            Array.from(
              {
                length: Math.max(
                  ...seen
                    .filter((run) => run.variant === group.variant && run.model === group.model)
                    .map((run) => run.repetition),
                ),
              },
              (_, index) => ({ variant: group.variant, model: group.model, case: item.id, repetition: index + 1 }),
            ),
          ),
        )
    : []
  const checked = projections.map((entry) => ({ entry, problems: projectionProblems(entry.value) }))
  const summaries = input.ledger
    ? [Ledger.inspect(resolve(input.ledger))]
    : ledgerSummaries(reports.map((entry) => entry.value as RunReport))
  return {
    cases: [...fixtures.map(fixtureCase), ...(manifest ? manifest.cases.map(manifestCase) : [])],
    runs: [...fromReports.flatMap((entry) => entry.runs), ...replays, ...(reselected ?? []).map((entry) => entry.run)],
    plan: [
      ...fromReports.flatMap((entry) => entry.plan),
      ...replayPlan,
      // An engine group's re-selection plans the same cases, so a case its replay lacks is missing from both.
      ...(reselected
        ? replayPlan
            .filter((entry) => engineGroups.has(`${entry.variant}\n${entry.model}`))
            .map((entry) => ({ ...entry, variant: entry.variant + RESELECT_SUFFIX }))
        : []),
    ],
    split: replayed ? split : "fixtures",
    frozen: !reports.length && !!manifest?.freeze,
    sources: {
      ...Object.fromEntries(
        reports.map((entry) => {
          const report = entry.value as RunReport
          return [
            `run.ts ${relative(process.cwd(), entry.file)}`,
            `${report.model} via ${report.baseUrl}, started ${report.startedAt}`,
          ]
        }),
      ),
      ...(manifestText !== undefined
        ? {
            manifest: `${relative(REPO_ROOT, manifestPath)} sha256 ${createHash("sha256").update(manifestText).digest("hex")}`,
          }
        : {}),
      ...(replayed
        ? {
            vector: [
              ...new Set(
                [...artifacts, ...desktops, ...projections].map(
                  (entry) => (entry.value as Pick<ReplayArtifact, "source">).source?.vector ?? "unknown",
                ),
              ),
            ].join(", "),
          }
        : {}),
      ...(reselected?.length ? { reselect: reselectSource(reselected.map((entry) => entry.reselection)) } : {}),
    },
    ...(summaries.length
      ? {
          ledger: {
            open: summaries.reduce((total, item) => total + item.attempts.open, 0),
            spentUsd: summaries.reduce((total, item) => total + item.spentUsd, 0),
            uncertainUsd: summaries.reduce((total, item) => total + item.uncertainUsd, 0),
            overshootUsd: summaries.reduce((total, item) => total + item.overshootUsd, 0),
            ...(summaries.find((item) => item.halted) ? { halted: summaries.find((item) => item.halted)!.halted } : {}),
          },
        }
      : {}),
    projected: checked.flatMap((item) =>
      item.problems.length ? [] : [projectedRun(item.entry.value as ProjectionRecord)],
    ),
    problems: [
      ...unknown.map(
        (entry) =>
          `${entry.file} is neither a run.ts report, a replay artifact nor a projection record, and is left out`,
      ),
      ...invalid.map((problem) => `manifest ${manifestPath}: ${problem}`),
      ...(replayed && reports.length ? ["run.ts reports and replay artifacts are reported together"] : []),
      // A variant record the registry does not bear out names a run it may not be, as does a variant made by its
      // models whose record does not show the pair (VS-29a).
      ...artifacts.flatMap((entry) =>
        [...variantProblems("engine", (entry.value as ReplayArtifact).variant), ...pairProblems(entry.value)].map(
          (problem) => `${entry.file}: ${problem}`,
        ),
      ),
      ...desktops.flatMap((entry) =>
        [...variantProblems("desktop", (entry.value as DesktopArtifact).variant), ...pairProblems(entry.value)].map(
          (problem) => `${entry.file}: ${problem}`,
        ),
      ),
      // A desktop run whose variant never reached its runner ran the frozen pipeline, so it is not compared (as
      // certify.ts leaves it out); its case stays planned and shows as missing.
      ...desktopRuns.flatMap((item) =>
        item.run
          ? []
          : [
              `${item.entry.file} asked for ${(item.entry.value as DesktopArtifact).variant?.name ?? "a variant"}, but it never reached the runner, so it is left out`,
            ],
      ),
      ...checked.flatMap((item) => item.problems.map((problem) => `${item.entry.file}: ${problem}`)),
      ...(reselected && !reselected.length
        ? ["--reselect strict found no engine replay artifact, so nothing was re-selected"]
        : []),
    ],
    ...(reselected
      ? {
          reselected: reselected.map((entry) => ({
            from: runKey(entry.from),
            to: runKey(entry.run),
            reselection: entry.reselection,
          })),
        }
      : {}),
  }
}

// --reselect strict (VS-27b): the strict guardrail's rule pass (core guardrail.ts strictRules) over what a saved engine
// replay posted, offline and at no cost, so a report shows how precision would change. A re-selected run is its own
// group, `<variant>+reselect-strict` ("+" is outside VARIANT_NAME, so it never names a registry variant), scored on
// the original's judgements. Legacy output has no failure block and no quotes, so the rules are:
// - S1 as strictSelect: verified, and a verdict the replay cannot show was read (below) is `verdict-unreadable`;
// - S2's blocking half (an unreadable or non-blocking severity); its class half is left out;
// - S3 and S4 are the recorded anchors: a finding selection placed (inline, overflow, elsewhere, nits) is anchored and
//   one outside the diff is not. A context-line anchor passes offline, which strict would refuse: a stated limit;
// - S5 is left out;
// - S6 from the recorded suggestion rule: a suggestion selection allowed is a suggestion, any other fix is unchecked;
// - S7 by id or sameFinding, without the class clause and with no anchored code (the diff is not recorded);
// - S8 at the artifact's maxComments;
// - S9 (VS-42's introduced-by-change check, which strict runs only under `scopeGate: "introduced"`) is left out: the
//   artifact records no base blobs, so no candidate carries its fact.
// Only what the original posted is a candidate (inline when its review write went out, the rest when its summary did),
// so every finding the copy posts has the original's judgement; the rest are counted as unposted. The artifact records
// no per-id verify verdict, so S1's unreadable verdicts are worked out from the recorded verify rule (plan.ts
// verifyCandidates and verifyUnanswered over the selection, its findings recorded as verified as confirmed verdicts and
// those recorded as `verified: false` as rejected ones, since a recorded false is a verdict that was read): exact for a
// run whose verify pass finished. A triage pass leaves its unconfirmed findings out of the artifact altogether, so a
// nonzero `unconfirmed` drop marks the run incomplete as `verdicts-unrecorded`. The copy carries no spend, tokens,
// attempts or timing: re-selection spends nothing, and the original's spend is counted once.
export const RESELECT_SUFFIX = "+reselect-strict"

export interface StrictReselection {
  kept: Finding[] // in strength order, as the copy posts them
  candidates: number // the original's posted findings that were re-selected
  unposted: number // findings the original selected but never posted, left out: no judgement can exist for them
  complete: boolean
  incomplete?: (StrictIncomplete | "verdicts-unrecorded")[]
  dropped: StrictResult["dropped"]
  fixUnchecked: number
}

export function reselectRun(artifact: ReplayArtifact, run: EvalRun): { run: EvalRun; reselection: StrictReselection } {
  const outcome = artifact.outcome
  const selection = outcome?.selection
  const posted = postedParts(artifact, run.status === "failed")
  const records = selection
    ? [
        ...selection.inline.map((finding) => ({
          finding,
          anchored: true,
          suggestion: finding.suggestionAllowed,
          posted: posted.review,
        })),
        ...[...selection.overflow, ...selection.elsewhere, ...selection.nits].map((finding) => ({
          finding,
          anchored: true,
          suggestion: false,
          posted: posted.summary,
        })),
        ...selection.outsideDiff.map((finding) => ({
          finding,
          anchored: false,
          suggestion: false,
          posted: posted.summary,
        })),
      ]
    : []
  const config = { ...DEFAULT_REVIEW_CONFIG, ...artifact.config.value }
  const pool = records.map((record) => record.finding)
  const triaged = artifact.models.triage !== undefined
  const verdicts = new Map(
    pool.flatMap((finding) =>
      finding.verified === undefined ? [] : [[finding.id, finding.verified ? "confirmed" : "rejected"] as const],
    ),
  )
  const unanswered = outcome?.specialists.some((entry) => entry.name === "verify")
    ? verifyUnanswered(
        verifyCandidates(
          pool,
          {
            verify: config.verify,
            policy: config.verifyPolicy,
            minConfidence: config.minConfidence,
            trust: artifact.trust,
            triaged,
          },
          "engine",
        ),
        verdicts,
        triaged,
      ).map((finding) => finding.id)
    : []
  const candidates = records.filter((record) => record.posted)
  const pass = strictRules(
    candidates.map(
      (record): StrictCandidate => ({
        finding: record.finding,
        anchored: record.anchored,
        fix: () => {
          const text = [record.finding.patch, record.finding.suggestion].find((value) => value?.trim())
          if (text === undefined) return undefined
          const committable = record.suggestion && text === record.finding.suggestion
          return { kind: committable ? "suggestion" : "unchecked", text }
        },
        code: "",
      }),
    ),
    { maxComments: config.maxComments, unanswered },
  )
  const unconfirmed = selection?.dropped.find((entry) => entry.reason === "unconfirmed")?.count ?? 0
  const incomplete = [
    ...strictIncomplete(
      {
        ...(outcome?.partial ? { partial: outcome.partial } : {}),
        unreviewed: outcome?.unreviewed ?? [],
        skipped: outcome?.skipped ?? [],
        specialists: outcome?.specialists ?? [],
      },
      pass.unreadable,
    ),
    ...(triaged && unconfirmed > 0 ? ["verdicts-unrecorded" as const] : []),
  ]
  const kept = pass.kept.map((entry) => entry.finding)
  const copy: EvalRun = {
    variant: run.variant + RESELECT_SUFFIX,
    model: run.model,
    ...(run.models ? { models: run.models } : {}),
    case: run.case,
    repetition: run.repetition,
    trust: run.trust,
    status: run.status,
    ...(run.detail ? { detail: run.detail } : {}),
    proposed: run.proposed,
    posted: kept.map((finding) => evalFinding(finding, true)),
    ...(run.stop ? { stop: run.stop } : {}),
    spend: { uncertainUsd: 0, usageMissing: false, admitted: true },
    violations: run.violations,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
  }
  return {
    run: copy,
    reselection: {
      kept,
      candidates: candidates.length,
      unposted: records.length - candidates.length,
      complete: incomplete.length === 0,
      ...(incomplete.length ? { incomplete } : {}),
      dropped: pass.dropped,
      fixUnchecked: pass.kept.filter((entry) => entry.fix.kind === "unchecked").length,
    },
  }
}

// The sources line for --reselect strict: the rules applied and left out, and what they did across the runs.
function reselectSource(reselections: readonly StrictReselection[]) {
  const sum = (count: (item: StrictReselection) => number) =>
    reselections.reduce((total, item) => total + count(item), 0)
  const dropped = STRICT_DROPS.flatMap((reason) => {
    const count = sum((item) => item.dropped.find((entry) => entry.reason === reason)?.count ?? 0)
    return count ? [`${reason} ${count}`] : []
  })
  return [
    `strict re-selection of ${reselections.length} engine replay(s), offline`,
    "applied: S1, S2's blocking half, S3 and S4 as the recorded anchors, S6 from the recorded suggestion rule, S7 by id or sameFinding, S8",
    "left out: S2's class half, S4's quotes and S5 (legacy output has no failure block and no quotes), and S9 (no base blobs are recorded)",
    `kept ${sum((item) => item.kept.length)} of ${sum((item) => item.candidates)} posted finding(s), ${sum((item) => item.unposted)} selected but never posted left out`,
    `dropped: ${dropped.length ? dropped.join(", ") : "none"}`,
    `${sum((item) => item.fixUnchecked)} fix(es) unchecked`,
    `${reselections.filter((item) => !item.complete).length} run(s) incomplete`,
    "copies carry no spend, tokens or timing",
  ].join("; ")
}

// One summary per budget journal the reports were charged to. Runs that share a journal (every model of one CI run)
// each embed the journal as it stood when they finished, earlier models' entries included, so adding their summaries
// up would count the first model's spend once for every later model. Reports are grouped by the journal's opening
// entry (its id keeps journals opened in the same millisecond apart), and each group's entries are merged without repeats, shortest list first, which keeps the journal's order
// since each later process appended to what the earlier ones wrote; the merged journal is summarised once. A report
// with no entries keeps the summary it embeds.
export function ledgerSummaries(reports: readonly Pick<RunReport, "budget" | "ledger">[]): Summary[] {
  const journals = new Map<string, Entry[][]>()
  const alone: Summary[] = []
  for (const report of reports) {
    const entries = report.ledger ?? []
    if (entries[0]?.type === "open") {
      const key = JSON.stringify(entries[0])
      journals.set(key, [...(journals.get(key) ?? []), entries])
    } else if (isSummary(report.budget)) alone.push(report.budget)
  }
  return [
    ...[...journals.values()].map((lists) => {
      const seen = new Set<string>()
      const merged = lists
        .toSorted((a, b) => a.length - b.length)
        .flat()
        .filter((entry) => {
          const key = JSON.stringify(entry)
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      return Ledger.summarize(merged)
    }),
    ...alone,
  ]
}

// The empty-finding control (Phase 0, "Runner and baselines"): for every case and repetition of the plan, a completed
// review that was admitted, cost nothing and reported no finding. Its precision has nothing to count (null, with its
// counts), its end-to-end recall is 0, and it raises no false alarm, so the report shows what each denominator does
// when a reviewer says nothing. It runs no model.
export function emptyControl(plan: readonly PlanEntry[], runs: readonly EvalRun[] = []) {
  const cases = [...new Map(plan.map((entry) => [`${entry.case}#${entry.repetition}`, entry])).values()]
  const started = runs.flatMap((run) => (run.startedAt ? [run.startedAt] : [])).toSorted()[0]
  return {
    plan: cases.map((entry): PlanEntry => ({ ...EMPTY_CONTROL, case: entry.case, repetition: entry.repetition })),
    runs: cases.map(
      (entry): EvalRun => ({
        ...EMPTY_CONTROL,
        case: entry.case,
        repetition: entry.repetition,
        trust: "untrusted",
        status: "completed",
        proposed: [],
        posted: [],
        ms: 0,
        spend: { costUsd: 0, uncertainUsd: 0, usageMissing: false, admitted: true },
        tokens: { input: 0, output: 0 },
        violations: [],
        ...(started ? { startedAt: started } : {}),
      }),
    ),
  }
}

type RunReport = {
  startedAt: string
  model: string
  baseUrl: string
  repeat: number
  estimate?: { fixtures?: { fixture: string }[] }
  runs: {
    fixture: string
    attempt: number
    ms: number
    status: "scored" | "error" | "not-sent"
    detail?: string
    usage?: { input?: number; output?: number; costUsd?: number }
    report?: { findings: ModelFinding[] }
  }[]
  budget?: Summary
  ledger?: Entry[]
}

// A run.ts report: the single-prompt harness on the synthetic fixtures. Each answer is both what was proposed and what
// would be posted, since the harness has no selection. A run is admitted when its ledger has an admission for it.
export function fromRunReport(report: RunReport, fixtures: readonly Fixture[]) {
  const admitted = new Set((report.ledger ?? []).flatMap((entry) => (entry.type === "admit" ? [entry.case] : [])))
  const settled = (key: string) => {
    const seqs = new Set(
      (report.ledger ?? []).flatMap((entry) => (entry.type === "admit" && entry.case === key ? [entry.seq] : [])),
    )
    return (report.ledger ?? []).flatMap((entry) => (entry.type === "settle" && seqs.has(entry.seq) ? [entry] : []))
  }
  const runs = report.runs.map((run): EvalRun => {
    const key = `${report.model} ${run.fixture}#${run.attempt}`
    const settlements = settled(key)
    const findings = (run.report?.findings ?? []).map((finding) => evalFinding(finding))
    return {
      variant: SINGLE_PROMPT,
      model: report.model,
      case: run.fixture,
      repetition: run.attempt,
      trust: "untrusted",
      status: run.status === "scored" ? "completed" : run.status === "error" ? "failed" : "not-sent",
      ...(run.detail ? { detail: run.detail } : {}),
      proposed: findings,
      posted: findings,
      ms: run.ms,
      spend: {
        ...(settlements.some((entry) => entry.costUsd !== undefined)
          ? { costUsd: settlements.reduce((total, entry) => total + (entry.costUsd ?? 0), 0) }
          : {}),
        uncertainUsd: settlements.reduce((total, entry) => total + entry.uncertainUsd, 0),
        usageMissing: settlements.some((entry) => entry.costUsd === undefined),
        admitted: run.status === "not-sent" || admitted.has(key),
      },
      ...(run.usage?.input !== undefined && run.usage.output !== undefined
        ? { tokens: { input: run.usage.input, output: run.usage.output } }
        : {}),
      violations: [],
      startedAt: report.startedAt,
    }
  })
  const names = report.estimate?.fixtures?.map((item) => item.fixture) ?? [
    ...new Set(report.runs.map((run) => run.fixture)),
  ]
  return {
    runs,
    plan: names
      .filter((name) => fixtures.some((fixture) => fixture.name === name))
      .flatMap((name) =>
        Array.from({ length: report.repeat }, (_, index) => ({
          variant: SINGLE_PROMPT,
          model: report.model,
          case: name,
          repetition: index + 1,
        })),
      ),
  }
}

// A replay artifact: the engine pipeline, or a variant of it (replayVariant, which reads VS-21a's and VS-06's variant
// records), on a dataset case. The reviewers' findings are what was proposed; the line comments and the findings the
// summary lists are what would be posted, when those writes got through the posting check. Its spend is its attempts'
// settlements, with unsettled or incomplete ones kept at their estimates, and its paid attempts are accounted for only
// when the eval ledger's journal admitted the replay.
export function fromArtifact(
  artifact: ReplayArtifact,
  manifest: Manifest | undefined,
  journal: readonly Entry[],
): EvalRun {
  const item = manifest?.cases.find((entry) => entry.id === artifact.label)
  const outcome = artifact.outcome
  const models = [artifact.models.review.id, ...(artifact.models.triage ? [artifact.models.triage.id] : [])]
  const reviewers = outcome?.specialists.filter((entry) => entry.name !== "verify") ?? []
  const failed = reviewers.length > 0 && reviewers.every((entry) => entry.status === "failed")
  const unfinished =
    outcome?.specialists.filter((entry) => ["failed", "timeout", "stopped"].includes(entry.status)) ?? []
  const status = !outcome
    ? "partial"
    : failed
      ? "failed"
      : outcome.partial || outcome.unreviewed.length || unfinished.length
        ? "partial"
        : "completed"
  const detail = !outcome
    ? `every changed file was skipped (${artifact.files.skipped.length}), so nothing was reviewed`
    : failed
      ? (reviewers.find((entry) => entry.detail)?.detail ?? "every reviewer failed")
      : status === "partial"
        ? [
            ...(outcome.partial ? [`stopped early (${outcome.partial})`] : []),
            ...(outcome.unreviewed.length ? [`${outcome.unreviewed.length} file(s) unreviewed`] : []),
            ...unfinished.map((entry) => `${entry.name} ${entry.status}`),
          ].join(", ")
        : undefined
  const selection = outcome?.selection
  const writes = postedParts(artifact, failed)
  const posted = selection
    ? [
        ...(writes.review ? selection.inline.map((finding) => evalFinding(finding, true)) : []),
        ...(writes.summary
          ? [...selection.overflow, ...selection.outsideDiff, ...selection.elsewhere, ...selection.nits].map(
              (finding) => evalFinding(finding, false),
            )
          : []),
      ]
    : []
  const charge = replayCharge(artifact.attempts)
  const paid = artifact.attempts.some((attempt) => attempt.admitted)
  // The variant the eval asked for names the run's pipeline, so a variant's replays form their own group and pair
  // with the frozen pipeline's under --candidate and --baseline, and its admission is its own.
  const variant = replayVariant("engine", artifact.variant)
  const caseKey = replayCaseKey({ variant, models, id: artifact.label, repetition: artifact.repetition })
  const tokens = artifact.attempts.flatMap((attempt) => (attempt.settled?.tokens ? [attempt.settled.tokens] : []))
  const timed = artifact.passes.flatMap((pass) => (pass.ms === undefined ? [] : [{ pass: pass.pass, ms: pass.ms }]))
  const written = artifact.posted
    .flatMap((write) =>
      write.write === "createReview"
        ? [write.payload.body, ...write.payload.comments.map((comment) => comment.body)]
        : [write.body],
    )
    .join("\n")
  return {
    variant,
    model: artifact.models.review.id,
    models,
    case: artifact.label,
    repetition: artifact.repetition,
    trust: artifact.trust,
    status,
    ...(detail ? { detail } : {}),
    proposed: (outcome?.report.findings ?? []).map((finding) => evalFinding(finding)),
    posted,
    ...(outcome ? { ms: outcome.durationMs } : {}),
    attempts: artifact.attempts.filter((attempt) => attempt.admitted).length,
    ...(outcome?.partial ? { stop: outcome.partial } : {}),
    ...(timed.length ? { passes: timed } : {}),
    spend: {
      ...(paid ? { costUsd: charge.costUsd } : {}),
      uncertainUsd: charge.uncertainUsd ?? 0,
      usageMissing: artifact.attempts.some(
        (attempt) => attempt.admitted && (!attempt.settled || !attempt.settled.complete),
      ),
      admitted: !paid || journal.some((entry) => entry.type === "admit" && entry.case === caseKey),
    },
    ...(tokens.length
      ? {
          tokens: {
            input: tokens.reduce((total, entry) => total + entry.input, 0),
            output: tokens.reduce((total, entry) => total + entry.output, 0),
            ...cacheTokens(artifact.passes),
          },
        }
      : {}),
    violations: item
      ? [
          ...(artifact.trust === "untrusted"
            ? []
            : [`reviewed as ${artifact.trust}, though dataset cases replay untrusted`]),
          ...(artifact.source.base === item.candidate.base && artifact.source.head === item.candidate.head
            ? []
            : [
                `reviewed ${artifact.source.base.slice(0, 12)}..${artifact.source.head.slice(0, 12)}, not the case's candidate`,
              ]),
          ...(item.fix && written.includes(item.fix.sha.slice(0, 7))
            ? ["the fix commit appears in what would be posted"]
            : []),
        ]
      : [],
  }
}

// What a replay's writes carried: its line comments when the review write went out, and the findings its summary lists
// when the summary did. A run whose every reviewer failed posts neither.
function postedParts(artifact: ReplayArtifact, failed: boolean) {
  return {
    review: !failed && artifact.posted.some((write) => write.write === "createReview"),
    summary: !failed && artifact.posted.some((write) => write.write === "createIssueComment"),
  }
}

// A desktop replay's artifact (desktop.ts): the desktop runner on a dataset case, or a variant of it. Its reviewers'
// findings are what was proposed, and what the panel's Post button would send is what would be posted: the line
// comments, then the findings its summary lists. A run whose variant never reached the runner (variant.applied false)
// ran the frozen pipeline under another name, so it is left out (undefined) and its case shows as missing. A paid
// desktop replay is not wired, so the eval ledger never admits one: any attempt with a cost reads as unaccounted.
export function fromDesktopArtifact(artifact: DesktopArtifact, manifest: Manifest | undefined): EvalRun | undefined {
  if (artifact.variant?.applied === false) return undefined
  const item = manifest?.cases.find((entry) => entry.id === artifact.label)
  const outcome = artifact.outcome
  // The desktop runner's specialists are its reviewers; its double-check is reported apart, as `verification`.
  const reviewers = outcome?.specialists ?? []
  const failed =
    artifact.error !== undefined || (reviewers.length > 0 && reviewers.every((entry) => entry.status === "failed"))
  const unfinished = [
    ...reviewers.filter((entry) => entry.status !== "ok").map((entry) => `${entry.name} ${entry.status}`),
    ...(outcome?.verification?.status === "failed" ? ["verify failed"] : []),
  ]
  const status = failed
    ? "failed"
    : !outcome
      ? "partial"
      : artifact.aborted.length || unfinished.length
        ? "partial"
        : "completed"
  const detail =
    status === "failed"
      ? (artifact.error ?? reviewers.find((entry) => entry.detail)?.detail ?? "every reviewer failed")
      : !outcome
        ? "nothing was reviewed"
        : status === "partial"
          ? [...(artifact.aborted.length ? [`aborted ${artifact.aborted.join(", ")}`] : []), ...unfinished].join(", ")
          : undefined
  const selection = outcome?.selection
  const posted =
    selection && artifact.proposed && !failed
      ? [
          ...selection.inline.map((finding) => evalFinding(finding, true)),
          ...[...selection.overflow, ...selection.outsideDiff, ...selection.elsewhere, ...selection.nits].map(
            (finding) => evalFinding(finding, false),
          ),
        ]
      : []
  const priced = artifact.attempts.filter((attempt) => attempt.costUsd !== undefined)
  const tokens = artifact.attempts.flatMap((attempt) => (attempt.tokens ? [attempt.tokens] : []))
  // A pass's wall time runs from its first prompt call's start to its last one's end, so calls that overlap (several at
  // once, or a retry) count once, never as the sum of their durations.
  const timed = Object.entries(
    Object.groupBy(
      artifact.attempts.flatMap((attempt) =>
        attempt.startMs !== undefined && attempt.ms !== undefined
          ? [
              {
                pass: attempt.pass.replace(/^vectorscope\./, ""),
                start: attempt.startMs,
                end: attempt.startMs + attempt.ms,
              },
            ]
          : [],
      ),
      (span) => span.pass,
    ),
  ).map(([pass, spans = []]) => ({
    pass,
    ms: Math.max(...spans.map((span) => span.end)) - Math.min(...spans.map((span) => span.start)),
  }))
  const written = artifact.proposed
    ? [artifact.proposed.body, ...artifact.proposed.comments.map((comment) => comment.body)].join("\n")
    : ""
  return {
    variant: replayVariant("desktop", artifact.variant),
    model: artifact.models.review.id,
    models: [artifact.models.review.id],
    case: artifact.label,
    repetition: artifact.repetition,
    trust: artifact.trust ?? "untrusted",
    status,
    ...(detail ? { detail } : {}),
    proposed: (outcome?.report.findings ?? []).map((finding) => evalFinding(finding)),
    posted,
    ...(outcome ? { ms: outcome.durationMs } : {}),
    attempts: artifact.attempts.length,
    ...(timed.length ? { passes: timed } : {}),
    spend: {
      ...(priced.length ? { costUsd: priced.reduce((total, attempt) => total + (attempt.costUsd ?? 0), 0) } : {}),
      uncertainUsd: 0,
      usageMissing: artifact.attempts.some((attempt) => attempt.unpriced || (attempt.answered && !attempt.tokens)),
      admitted: !artifact.attempts.some((attempt) => (attempt.costUsd ?? 0) > 0),
    },
    ...(tokens.length
      ? {
          tokens: {
            input: tokens.reduce((total, entry) => total + entry.input, 0),
            output: tokens.reduce((total, entry) => total + entry.output, 0),
          },
        }
      : {}),
    violations: item
      ? [
          ...((artifact.trust ?? "untrusted") === "untrusted"
            ? []
            : [`reviewed as ${artifact.trust}, though dataset cases replay untrusted`]),
          ...(artifact.source.base === item.candidate.base && artifact.source.head === item.candidate.head
            ? []
            : [
                `reviewed ${artifact.source.base.slice(0, 12)}..${artifact.source.head.slice(0, 12)}, not the case's candidate`,
              ]),
          ...(item.fix && written.includes(item.fix.sha.slice(0, 7))
            ? ["the fix commit appears in what would be posted"]
            : []),
        ]
      : [],
  }
}

// The cache reads and writes of a replay's passes, when any pass recorded them.
function cacheTokens(passes: ReplayArtifact["passes"]) {
  const recorded = passes.filter((pass) => pass.cacheRead !== undefined || pass.cacheWrite !== undefined)
  if (!recorded.length) return {}
  return {
    cacheRead: recorded.reduce((total, pass) => total + (pass.cacheRead ?? 0), 0),
    cacheWrite: recorded.reduce((total, pass) => total + (pass.cacheWrite ?? 0), 0),
  }
}

export function fixtureCase(fixture: Fixture): EvalCase {
  const extension = fixture.files[0]?.path.split(".").at(-1) ?? ""
  return {
    id: fixture.name,
    kind: fixture.expected.length ? "bug" : "control",
    language: LANGUAGES[extension] ?? (extension || "unknown"),
    // The change itself: a path to the fixture would carry its descriptive name into the worksheet.
    code: { patch: fixture.diff },
    size: {
      files: fixture.files.length,
      additions: fixture.files.reduce((total, file) => total + file.additions, 0),
      deletions: fixture.files.reduce((total, file) => total + file.deletions, 0),
    },
    defects: fixture.expected.map((expectation) => ({
      id: expectation.id,
      category: expectation.category ?? "correctness",
      severity: expectation.severity,
      summary: expectation.description,
      cause: expectation.description,
      locations: [
        {
          path: expectation.path,
          line: expectation.line,
          ...(expectation.endLine !== undefined ? { endLine: expectation.endLine } : {}),
        },
      ],
      alternatives: [],
    })),
  }
}

export function manifestCase(item: Case): EvalCase {
  const view = caseView(item)
  return {
    id: item.id,
    // A trivial control is a control with its trivialKind, which the report keeps apart from the behaviour-preserving
    // ones (isTrivialControl).
    kind: item.kind === "trivial" ? "control" : item.kind,
    language: item.language,
    size: item.candidate.changed,
    code: { repository: view.repository, base: view.base, head: view.head },
    // VS-22a's labels, each only when labelled. Mechanism and the Q4 marker stay in the dataset: nothing reads them yet.
    ...(item.labels.crossFile !== undefined ? { crossFile: item.labels.crossFile } : {}),
    ...(item.labels.trivialKind ? { trivialKind: item.labels.trivialKind } : {}),
    defects: item.labels.defects.map((defect) => ({
      id: defect.id,
      category: defect.category,
      severity: defect.severity,
      summary: defect.summary,
      cause: defect.cause,
      locations: defect.locations,
      alternatives: defect.alternatives,
      ...(defect.failureClass ? { failureClass: defect.failureClass } : {}),
    })),
  }
}

export function evalFinding(finding: ModelFinding | Finding, anchored?: boolean): EvalFinding {
  return {
    key: findingKey(finding),
    path: finding.path,
    line: finding.line,
    ...(finding.endLine !== undefined ? { endLine: finding.endLine } : {}),
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    body: finding.body,
    ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
    ...(anchored !== undefined ? { anchored } : {}),
  }
}

export async function readJudgements(path: string): Promise<JudgementFile> {
  const value = (await Bun.file(path).json()) as JudgementFile
  if (value?.schema !== JUDGEMENTS_SCHEMA || typeof value.seed !== "string" || !Array.isArray(value.judgements))
    throw new Error(`${path} is not a ${JUDGEMENTS_SCHEMA} judgement file`)
  if (value.proposal !== undefined && !(typeof value.proposal === "string" && value.proposal.trim()))
    throw new Error(`${path} names a proposed rubric that is not a name: ${JSON.stringify(value.proposal)}`)
  return { ...value, calls: Array.isArray(value.calls) ? value.calls : [] }
}

const USAGE = `Usage: bun script/vectorscope-eval/report.ts [options]

Re-scores saved eval outputs against settled judgements and evaluates the release gate. Sends nothing.

  --outputs <path>         A run.ts --out report, an engine or desktop replay artifact or a projection record, or a
                           directory of them (repeatable)
  --judgements <path>      Judgement file from judge.ts (without one, every finding is unjudged)
  --manifest <path>        Dataset manifest for replay artifacts (default: the seed manifest)
  --split <name>           Split the replay artifacts come from: ${SPLITS.join(", ")} (default development)
  --candidate <v>=<model>  Pipeline variant and model the gate decides on (default: the only one): single-prompt
                           for run.ts reports, empty for the control, or a registry name from replay.ts (engine,
                           engine:shared-verify, ...); any other name, or one whose package has not landed, is
                           refused
  --baseline <v>=<model>   The frozen pipeline to compare recall with on paired cases, such as engine=<model>; a
                           variant made by its models (engine:cross-family) is compared only with another
  --gate <path>            Gate config JSON (default: the owner's approved D2 gate)
  --ledger <path>          Eval ledger journal, which shows what each replay was admitted for; its summary is the
                           report's ledger line, instead of the journals the run.ts reports carry
  --empty-control          Add the empty-finding control: every planned case reviewed with no finding, for free
  --reselect strict        Also re-select what each engine replay posted under the strict guardrail's rules (VS-27b),
                           offline, as its own group <variant>+reselect-strict scored on the same judgements; the gate
                           never decides on or compares with such a group
  --proposal importance    Score judgements made under the proposed importance rubric (judge.ts --proposal importance,
                           judging-rubric-importance.md, VS-45, pending Q29) and add its importance metrics; the
                           judgement file must be that proposal's, and the report is never a release decision
  --title <text>           Report title
  --out <path>             Also write the JSON report there; it must be outside the repository
  --print-gate             Print the default gate (the owner's approved D2) as JSON, to review or copy, and exit
  --help                   Print this message
`

const OPTIONS = {
  outputs: { type: "string", multiple: true },
  judgements: { type: "string" },
  manifest: { type: "string" },
  split: { type: "string" },
  candidate: { type: "string" },
  baseline: { type: "string" },
  gate: { type: "string" },
  ledger: { type: "string" },
  title: { type: "string" },
  out: { type: "string" },
  reselect: { type: "string" },
  proposal: { type: "string" },
  "empty-control": { type: "boolean" },
  "print-gate": { type: "boolean" },
  help: { type: "boolean" },
} as const

export async function main(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const parsed = parseArgs({ args: argv, options: OPTIONS, strict: false, allowPositionals: true })
  const values = parsed.values
  const text = (name: Exclude<keyof typeof OPTIONS, "outputs" | "help" | "print-gate" | "empty-control">) =>
    typeof values[name] === "string" ? values[name] : undefined
  const outputs = (Array.isArray(values.outputs) ? values.outputs : []).filter((value) => typeof value === "string")
  const unknown = Object.keys(values).filter((name) => !Object.hasOwn(OPTIONS, name))
  if (unknown.length || parsed.positionals.length) return usage(`Unknown option or argument.`)
  if (values.help) return { code: 0, stdout: USAGE, stderr: "" }
  if (values["print-gate"]) return { code: 0, stdout: JSON.stringify(DEFAULT_GATE, null, 2) + "\n", stderr: "" }
  if (!outputs.length) return usage("Give at least one --outputs path.")
  const split = text("split")
  if (split !== undefined && !SPLITS.includes(split as (typeof SPLITS)[number])) return usage(`Unknown split ${split}.`)
  const reselect = text("reselect")
  if (values.reselect !== undefined && reselect !== "strict") return usage("--reselect takes strict.")
  const proposal = proposalOption(values.proposal)
  if (proposal === null) return usage("--proposal takes importance.")
  const candidate = group("candidate", text("candidate"))
  const baseline = group("baseline", text("baseline"))
  if (typeof candidate === "string") return usage(candidate)
  if (typeof baseline === "string") return usage(baseline)
  // VS-29a: a variant made by its models runs a triage pass, which double-checks every finding of concern or above and
  // reports only the confirmed ones, so a comparison with a variant that is not made by its models would credit that
  // pass to the pair. Its comparison arm, the same pipeline with a pair from one lab, is not registered (Q5, Q9).
  const paired = (variant: string) => {
    const resolved = resolveVariant(variant)
    return resolved.ok && resolved.models === "triage-pair"
  }
  if (candidate && baseline && paired(candidate.variant) !== paired(baseline.variant))
    return usage(
      `--candidate ${candidate.variant} and --baseline ${baseline.variant}: only one is made by its models, so the comparison would credit its triage pass to the pair; a pair's baseline is the same pipeline with a pair from one lab, which is not registered yet (Q5, Q9).`,
    )
  const out = text("out") ? resolve(text("out")!) : undefined
  if (out && !outsideRepository(out)) return usage(`--out must be outside the repository (${REPO_ROOT}).`)

  const gateValue: unknown = text("gate") ? await Bun.file(resolve(text("gate")!)).json() : DEFAULT_GATE
  const invalidGate = gateProblems(gateValue)
  if (invalidGate.length)
    return {
      code: 1,
      stdout: "",
      stderr: `Invalid gate ${text("gate")}:\n${invalidGate.map((line) => `  ${line}`).join("\n")}\n`,
    }
  const gate = gateValue as GateConfig
  const loaded = await loadOutputs({
    paths: outputs,
    ...(text("manifest") ? { manifest: text("manifest")! } : {}),
    ...(split ? { split } : {}),
    ...(text("ledger") ? { ledger: text("ledger")! } : {}),
    ...(reselect === "strict" ? { reselect } : {}),
  })
  const judgementsPath = text("judgements") ? resolve(text("judgements")!) : undefined
  const judgements = judgementsPath ? await readJudgements(judgementsPath) : undefined
  const mismatch = judgements && proposalMismatch(judgementsPath!, judgements, proposal)
  if (mismatch) return { code: 1, stdout: "", stderr: `${mismatch}\n` }
  // A re-selected run is scored on its original's settled verdicts, with no judge call of its own.
  const judged = (judgements?.judgements ?? []).flatMap((item) => [
    item,
    ...(loaded.reselected ?? []).flatMap((pair) => (pair.from === item.run ? [{ ...item, run: pair.to }] : [])),
  ])
  const empty = values["empty-control"] === true ? emptyControl(loaded.plan, loaded.runs) : undefined
  const report = buildReport(
    {
      title: text("title") ?? `VectorScope eval: ${loaded.split}`,
      split: loaded.split,
      frozen: loaded.frozen,
      sources: {
        ...loaded.sources,
        ...(judgements
          ? {
              judgements: `${judgements.judgements.length} judged finding(s), ${judgements.calls.length} judge call(s)`,
            }
          : {}),
      },
      cases: loaded.cases,
      plan: [...loaded.plan, ...(empty?.plan ?? [])],
      runs: [...loaded.runs, ...(empty?.runs ?? [])],
      judgements: judged,
      ...(candidate ? { candidate } : {}),
      ...(baseline ? { baseline } : {}),
      judging: judgements?.calls ?? [],
      ...(loaded.ledger ? { ledger: loaded.ledger } : {}),
      projected: loaded.projected,
      problems: loaded.problems,
      ...(proposal ? { proposal } : {}),
    },
    gate,
  )
  if (out) await writeFile(out, JSON.stringify(report, null, 2) + "\n")
  return {
    code: 0,
    stdout:
      renderReport(report) +
      (out ? `\nJSON report: ${out}\n` : "") +
      "\nOffline: saved outputs were re-scored and no request was sent.\n",
    stderr: "",
  }
}

function usage(problem: string) {
  return { code: 2, stdout: "", stderr: `${problem}\n\n${USAGE}` }
}

// A --candidate or --baseline group, or what is wrong with it. Apart from single-prompt and the empty control, a variant
// is a registry name, refused with resolveVariant's detail when it is malformed (a capitalised or space-padded runner
// among them), unknown or not built, so a mistyped name is explained instead of silently matching no runs.
function group(flag: string, value: string | undefined): Group | undefined | string {
  if (value === undefined) return undefined
  const at = value.indexOf("=")
  if (at < 1 || at === value.length - 1) return `--${flag} takes <variant>=<model>.`
  const variant = value.slice(0, at)
  const model = value.slice(at + 1)
  if (variant.endsWith(RESELECT_SUFFIX))
    return `--${flag}: ${variant} is an offline re-selection of saved output, not a pipeline that ran, so the gate never decides on it or compares with it; its metrics are in its group's table.`
  if (UNREGISTERED.includes(variant)) return { variant, model }
  const resolved = resolveVariant(variant)
  if (!resolved.ok) return `--${flag}: ${resolved.detail}`
  return { variant: resolved.name, model }
}

function jsonFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path]
  return readdirSync(path)
    .filter((name) => name.endsWith(".json"))
    .toSorted()
    .map((name) => join(path, name))
}

function isRunReport(value: unknown): value is RunReport {
  const item = value as RunReport | undefined
  return (
    !!item &&
    typeof item === "object" &&
    typeof item.model === "string" &&
    Array.isArray(item.runs) &&
    typeof item.repeat === "number"
  )
}

function isArtifact(value: unknown): value is ReplayArtifact {
  const item = value as ReplayArtifact | undefined
  return (
    !!item &&
    typeof item === "object" &&
    item.version === 1 &&
    item.adapter === "engine" &&
    typeof item.label === "string"
  )
}

function isDesktopArtifact(value: unknown): value is DesktopArtifact {
  const item = value as DesktopArtifact | undefined
  return (
    !!item &&
    typeof item === "object" &&
    item.version === 1 &&
    item.adapter === "desktop" &&
    typeof item.label === "string"
  )
}

function isProjection(value: unknown): boolean {
  const item = value as ProjectionRecord | undefined
  return !!item && typeof item === "object" && item.version === 1 && item.kind === "projection"
}

function isSummary(value: unknown): value is Summary {
  return !!value && typeof value === "object" && typeof (value as { attempts?: unknown }).attempts === "object"
}

const LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  rb: "ruby",
  java: "java",
}

if (import.meta.main) {
  const result = await main(process.argv.slice(2))
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exit(result.code)
}
