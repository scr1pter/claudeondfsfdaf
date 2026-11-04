#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { readdirSync, statSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { parseArgs } from "node:util"
import {
  findingKey,
  type EvalCase,
  type EvalFinding,
  type EvalRun,
  type Judgement,
  type PlanEntry,
} from "../../packages/core/src/review/eval"
import type { JudgeCall } from "../../packages/core/src/review/eval-judge"
import {
  buildReport,
  DEFAULT_GATE,
  gateProblems,
  renderReport,
  type GateConfig,
  type Group,
} from "../../packages/core/src/review/eval-report"
import type { Finding, ModelFinding } from "../../packages/core/src/review/types"
import type { ReplayArtifact } from "../../packages/engine/src/review/eval"
import { Ledger, readJournal, type Entry, type Summary } from "./budget"
import { caseView, manifestProblems, SEED_MANIFEST, SPLITS, type Case, type Manifest } from "./dataset"
import { listFixtures, loadFixture, type Fixture } from "./fixture"
import { outsideRepository, REPO_ROOT } from "./paths"
import { replayCharge } from "./replay"

export { outsideRepository }

// The causal report (VectorScope plan, VS-04). It re-scores saved eval outputs (run.ts --out reports and the engine
// replay's artifacts) against the settled verdicts in a judgement file from judge.ts, and evaluates the release gate,
// by default the owner's approved D2 gate. It reads files and sends nothing, so a revised rubric or gate is applied to
// the same outputs without another provider call. With --empty-control it adds Phase 0's empty-finding baseline: a
// completed, admitted, free review of every planned case that reports nothing, which shows how each denominator
// behaves when there is nothing to count.

export const JUDGEMENTS_SCHEMA = "vectorscope-judgements/1"
export const EMPTY_CONTROL = { variant: "empty", model: "none" } as const

// The judge's record of every pass, adjudication and judge call, kept by the coordinator outside the repository. It
// holds the seed that blinds the worksheets, so it is never given to a judge.
export interface JudgementFile {
  schema: typeof JUDGEMENTS_SCHEMA
  seed: string
  judgements: Judgement[]
  calls: JudgeCall[]
}

export interface Outputs {
  cases: EvalCase[]
  runs: EvalRun[]
  plan: PlanEntry[]
  split: string
  frozen: boolean
  sources: Record<string, string>
  ledger?: { open: number; spentUsd: number; uncertainUsd: number; overshootUsd: number; halted?: string }
  problems: string[]
}

// Every saved output under the given paths, as runs with the cases they review and the plan of runs that should exist.
// A directory is read for its .json files. A run.ts report plans each of its fixtures for every repetition; replay
// artifacts plan every case of the split for each model and repetition seen, so a lost artifact shows as missing.
export async function loadOutputs(input: {
  paths: readonly string[]
  manifest?: string
  split?: string
  ledger?: string
}): Promise<Outputs> {
  const files = input.paths.flatMap((path) => jsonFiles(resolve(path)))
  const values = await Promise.all(
    files.map(async (file) => ({ file, value: (await Bun.file(file).json()) as unknown })),
  )
  const reports = values.filter((entry) => isRunReport(entry.value))
  const artifacts = values.filter((entry) => isArtifact(entry.value))
  const unknown = values.filter((entry) => !isRunReport(entry.value) && !isArtifact(entry.value))
  const journal = input.ledger ? readJournal(resolve(input.ledger)) : []
  const fixtures = reports.length ? await Promise.all((await listFixtures()).map(loadFixture)) : []
  const fromReports = reports.map((entry) => fromRunReport(entry.value as RunReport, fixtures))
  const manifestPath = input.manifest ? resolve(input.manifest) : SEED_MANIFEST
  const manifestText = artifacts.length ? await Bun.file(manifestPath).text() : undefined
  const manifestValue: unknown = manifestText === undefined ? undefined : JSON.parse(manifestText)
  const invalid = manifestValue === undefined ? [] : manifestProblems(manifestValue)
  const manifest = manifestValue !== undefined && !invalid.length ? (manifestValue as Manifest) : undefined
  const split = input.split ?? "development"
  const replays = artifacts.map((entry) => fromArtifact(entry.value as ReplayArtifact, manifest, journal))
  const groups = [...new Map(replays.map((run) => [`${run.variant}\n${run.model}`, run])).values()]
  const replayPlan = manifest
    ? manifest.cases
        .filter((item) => item.split === split)
        .flatMap((item) =>
          groups.flatMap((group) =>
            Array.from(
              {
                length: Math.max(
                  ...replays
                    .filter((run) => run.variant === group.variant && run.model === group.model)
                    .map((run) => run.repetition),
                ),
              },
              (_, index) => ({ variant: group.variant, model: group.model, case: item.id, repetition: index + 1 }),
            ),
          ),
        )
    : []
  const summaries = input.ledger
    ? [Ledger.inspect(resolve(input.ledger))]
    : ledgerSummaries(reports.map((entry) => entry.value as RunReport))
  return {
    cases: [...fixtures.map(fixtureCase), ...(manifest ? manifest.cases.map(manifestCase) : [])],
    runs: [...fromReports.flatMap((entry) => entry.runs), ...replays],
    plan: [...fromReports.flatMap((entry) => entry.plan), ...replayPlan],
    split: artifacts.length ? split : "fixtures",
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
      ...(artifacts.length
        ? {
            vector: [
              ...new Set(artifacts.map((entry) => (entry.value as ReplayArtifact).source.vector ?? "unknown")),
            ].join(", "),
          }
        : {}),
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
    problems: [
      ...unknown.map((entry) => `${entry.file} is neither a run.ts report nor a replay artifact, and is left out`),
      ...invalid.map((problem) => `manifest ${manifestPath}: ${problem}`),
      ...(artifacts.length && reports.length ? ["run.ts reports and replay artifacts are reported together"] : []),
    ],
  }
}

// One summary per budget journal the reports were charged to. Runs that share a journal (every model of one CI run)
// each embed the journal as it stood when they finished, earlier models' entries included, so adding their summaries
// up would count the first model's spend once for every later model. Reports are grouped by the journal's opening
// entry, and each group's entries are merged without repeats, shortest list first, which keeps the journal's order
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
      variant: "single-prompt",
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
          variant: "single-prompt",
          model: report.model,
          case: name,
          repetition: index + 1,
        })),
      ),
  }
}

// A replay artifact: the engine pipeline on a dataset case. The reviewers' findings are what was proposed; the line
// comments and the findings the summary lists are what would be posted, when those writes got through the posting
// check. Its spend is its attempts' settlements, with unsettled or incomplete ones kept at their estimates, and its paid
// attempts are accounted for only when the eval ledger's journal admitted the replay.
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
  const reviewPosted = artifact.posted.some((write) => write.write === "createReview")
  const summaryPosted = !failed && artifact.posted.some((write) => write.write === "createIssueComment")
  const posted = selection
    ? [
        ...(reviewPosted ? selection.inline.map((finding) => evalFinding(finding, true)) : []),
        ...(summaryPosted
          ? [...selection.overflow, ...selection.outsideDiff, ...selection.elsewhere, ...selection.nits].map(
              (finding) => evalFinding(finding, false),
            )
          : []),
      ]
    : []
  const charge = replayCharge(artifact.attempts)
  const paid = artifact.attempts.some((attempt) => attempt.admitted)
  const caseKey = `${models.join(" + ")} ${artifact.label}#${artifact.repetition}`
  const tokens = artifact.attempts.flatMap((attempt) => (attempt.settled?.tokens ? [attempt.settled.tokens] : []))
  const written = artifact.posted
    .flatMap((write) =>
      write.write === "createReview"
        ? [write.payload.body, ...write.payload.comments.map((comment) => comment.body)]
        : [write.body],
    )
    .join("\n")
  return {
    variant: "engine",
    model: artifact.models.review.id,
    models,
    case: artifact.label,
    repetition: artifact.repetition,
    trust: artifact.trust,
    status,
    ...(detail ? { detail } : {}),
    proposed: (outcome?.report.findings ?? []).map((finding) => evalFinding(finding)),
    posted: failed ? [] : posted,
    ...(outcome ? { ms: outcome.durationMs } : {}),
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
    kind: item.kind,
    language: item.language,
    size: item.candidate.changed,
    code: { repository: view.repository, base: view.base, head: view.head },
    defects: item.labels.defects.map((defect) => ({
      id: defect.id,
      category: defect.category,
      severity: defect.severity,
      summary: defect.summary,
      cause: defect.cause,
      locations: defect.locations,
      alternatives: defect.alternatives,
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
  return { ...value, calls: Array.isArray(value.calls) ? value.calls : [] }
}

const USAGE = `Usage: bun script/vectorscope-eval/report.ts [options]

Re-scores saved eval outputs against settled judgements and evaluates the release gate. Sends nothing.

  --outputs <path>         A run.ts --out report or a replay artifact, or a directory of them (repeatable)
  --judgements <path>      Judgement file from judge.ts (without one, every finding is unjudged)
  --manifest <path>        Dataset manifest for replay artifacts (default: the seed manifest)
  --split <name>           Split the replay artifacts come from: ${SPLITS.join(", ")} (default development)
  --candidate <v>=<model>  Pipeline variant and model the gate decides on (default: the only one)
  --baseline <v>=<model>   The frozen pipeline to compare recall with on paired cases
  --gate <path>            Gate config JSON (default: the owner's approved D2 gate)
  --ledger <path>          Eval ledger journal, which shows what each replay was admitted for; its summary is the
                           report's ledger line, instead of the journals the run.ts reports carry
  --empty-control          Add the empty-finding control: every planned case reviewed with no finding, for free
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
  const candidate = group(text("candidate"))
  const baseline = group(text("baseline"))
  if (candidate === null || baseline === null) return usage("--candidate and --baseline take <variant>=<model>.")
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
  })
  const judgements = text("judgements") ? await readJudgements(resolve(text("judgements")!)) : undefined
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
      judgements: judgements?.judgements ?? [],
      ...(candidate ? { candidate } : {}),
      ...(baseline ? { baseline } : {}),
      judging: judgements?.calls ?? [],
      ...(loaded.ledger ? { ledger: loaded.ledger } : {}),
      problems: loaded.problems,
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

function group(value: string | undefined): Group | undefined | null {
  if (value === undefined) return undefined
  const at = value.indexOf("=")
  if (at < 1 || at === value.length - 1) return null
  return { variant: value.slice(0, at), model: value.slice(at + 1) }
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
