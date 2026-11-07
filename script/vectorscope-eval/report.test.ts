import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RUBRIC_VERSION, runKey, type EvalRun, type Judgement } from "../../packages/core/src/review/eval"
import { DEFAULT_REVIEW_CONFIG, type ModelFinding } from "../../packages/core/src/review/types"
import { DEFAULT_GATE } from "../../packages/core/src/review/eval-report"
import type { ProjectionRecord, ReplayArtifact } from "../../packages/engine/src/review/eval"
import { Ledger } from "./budget"
import { loadManifest, type Manifest } from "./dataset"
import type { DesktopArtifact } from "./desktop"
import { listFixtures, loadFixture } from "./fixture"
import {
  EMPTY_CONTROL,
  emptyControl,
  evalFinding,
  fixtureCase,
  fromArtifact,
  fromDesktopArtifact,
  fromRunReport,
  JUDGEMENTS_SCHEMA,
  ledgerSummaries,
  loadOutputs,
  main,
  manifestCase,
  RESELECT_SUFFIX,
  reselectRun,
} from "./report"

// The offline report over saved outputs: a run.ts report built with a real ledger, and replay artifacts shaped as the
// engine writes them. Nothing here sends a request.

const root = mkdtempSync(join(tmpdir(), "vectorscope-report-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const MODEL = "vendor/reviewer"
// A replay records its whole parsed config; the default one, for the tests that read it.
const DEFAULT_CONFIG_VALUE = { ...DEFAULT_REVIEW_CONFIG }
const fixtures = await Promise.all((await listFixtures()).map(loadFixture))
const seed = (await loadManifest()) as Manifest
const bug = seed.cases.find((item) => item.split === "development" && item.kind === "bug")!
// The case's own labelled file and line, so the artifact below points where the case does.
const labelled = bug.labels.defects[0].locations[0]

function modelFinding(overrides: Partial<ModelFinding> = {}): ModelFinding {
  return {
    path: "src/billing/sync.ts",
    line: 41,
    severity: "blocking",
    category: "bug",
    title: "Ledger post is not awaited",
    body: "The rejection escapes the try/catch and the invoice is marked synced.",
    confidence: 0.9,
    ...overrides,
  }
}

// A run.ts --out report: the invoice bug found, a false alarm on the clean refactor, and an error on the SQL fixture,
// each admitted and settled by a real ledger.
function runReport() {
  const ledger = Ledger.open({ limits: { totalUsd: 10, caseUsd: 1, reserveUsd: 1 } })
  const charge = (fixture: string, usage: { costUsd?: number }) => {
    const admission = ledger.admit({ case: `${MODEL} ${fixture}#1`, kind: "provider", model: MODEL, estimateUsd: 0.05 })
    if (!admission.admitted) throw new Error(admission.detail)
    admission.ticket.sent()
    admission.ticket.settle(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd, basis: "reported" })
  }
  charge("invoice-ledger-sync", { costUsd: 0.003 })
  charge("http-retry-refactor", { costUsd: 0.002 })
  charge("order-search-sql", {})
  const report = (findings: ModelFinding[]) => ({ summary: "s", risk: "low", files: [], findings })
  return {
    startedAt: "2026-11-04T10:00:00.000Z",
    completedAt: "2026-11-04T10:01:00.000Z",
    model: MODEL,
    baseUrl: "https://example.invalid/v1/chat/completions",
    slack: 3,
    countNits: false,
    repeat: 1,
    price: { input: 1, output: 2 },
    maxTokens: 1000,
    estimate: {
      fixtures: [
        { fixture: "invoice-ledger-sync" },
        { fixture: "http-retry-refactor" },
        { fixture: "order-search-sql" },
      ],
    },
    runs: [
      {
        fixture: "invoice-ledger-sync",
        attempt: 1,
        ms: 1200,
        status: "scored" as const,
        usage: { input: 900, output: 200, costUsd: 0.003 },
        report: report([modelFinding()]),
      },
      {
        fixture: "http-retry-refactor",
        attempt: 1,
        ms: 800,
        status: "scored" as const,
        usage: { input: 800, output: 100, costUsd: 0.002 },
        report: report([modelFinding({ path: "src/http/retry.ts", line: 12, title: "Retry delay may overflow" })]),
      },
      { fixture: "order-search-sql", attempt: 1, ms: 300, status: "error" as const, detail: "HTTP 500: upstream" },
    ],
    budget: ledger.close(),
    ledger: [...ledger.entries],
  }
}

function artifact(overrides: Record<string, unknown> = {}, outcome: Record<string, unknown> = {}): ReplayArtifact {
  const inline = {
    ...modelFinding({ path: labelled.path, line: labelled.line, title: "The default argument may be None" }),
    id: "a1",
    side: "RIGHT",
    source: "review",
    verified: true,
    anchor: { path: labelled.path, side: "RIGHT", line: labelled.line, hunk: 0 },
    suggestionAllowed: true,
  }
  const elsewhere = {
    ...modelFinding({ path: "src/elsewhere.py", line: 10, title: "Unrelated concern", severity: "concern" }),
    id: "b2",
    side: "RIGHT",
    source: "review",
  }
  const dropped = modelFinding({
    path: labelled.path,
    line: labelled.line + 100,
    title: "Low confidence guess",
    confidence: 0.2,
  })
  return {
    version: 1,
    label: bug.id,
    adapter: "engine",
    repetition: 1,
    runtime: { node: "v22.0.0", platform: "darwin", arch: "arm64" },
    source: { base: bug.candidate.base, head: bug.candidate.head, mergeBase: bug.candidate.base, vector: "abc123" },
    trust: "untrusted",
    trigger: "command",
    config: { digest: "d", warnings: [], value: {} },
    rules: { digest: "r" },
    models: {
      review: { id: "vendor/reviewer-large", context: 200000, costKind: "priced", price: { input: 3, output: 15 } },
      triage: { id: "vendor/triage-small", context: 100000, costKind: "priced", price: { input: 1, output: 2 } },
    },
    context: { digest: "c", related: 0, history: 0, instructions: false, headFiles: 2 },
    files: { reviewed: [labelled.path], skipped: [] },
    passes: [],
    attempts: [
      {
        seq: 1,
        pass: "review",
        phase: "step",
        admitted: true,
        estimateUsd: 0.2,
        settled: { costUsd: 0.05, complete: true, tokens: { input: 5000, output: 500 } },
      },
      { seq: 2, pass: "verify", phase: "step", admitted: true, estimateUsd: 0.1 },
      { seq: 3, pass: "security", phase: "step", admitted: false, estimateUsd: 0.3 },
    ],
    tools: [],
    outcome: {
      report: { summary: "s", risk: "medium", files: [], findings: [inline, elsewhere, dropped] },
      selection: {
        inline: [inline],
        outsideDiff: [],
        elsewhere: [elsewhere],
        nits: [],
        overflow: [],
        stillOpen: [],
        fixed: [],
        dismissed: [],
        reappeared: [],
        raised: [],
        dropped: [{ reason: "low-confidence", count: 1 }],
        risk: "medium",
      },
      skipped: [],
      durationMs: 42000,
      base: bug.candidate.base,
      head: bug.candidate.head,
      mode: "full",
      unreviewed: [],
      specialists: [
        { name: "review", status: "ok", steps: 4 },
        { name: "security", status: "ok", steps: 2 },
        { name: "verify", status: "ok", steps: 1 },
      ],
      sessions: [],
      stats: { files: 1, additions: 22, deletions: 16 },
      notes: [],
      ...outcome,
    },
    placed: [],
    posted: [
      {
        write: "createReview",
        pr: 0,
        payload: {
          commit_id: bug.candidate.head,
          body: "review",
          event: "COMMENT",
          comments: [
            { path: labelled.path, line: labelled.line, side: "RIGHT", body: "The default argument may be None" },
          ],
        },
      },
      { write: "createIssueComment", pr: 0, body: "summary" },
    ],
    ...overrides,
  } as unknown as ReplayArtifact
}

// A saved run.ts report in its own directory, read by the report.ts tests.
const savedRun = (() => {
  const dir = join(root, "fixtures-run")
  mkdirSync(dir)
  const report = runReport()
  writeFileSync(join(dir, "run.json"), JSON.stringify(report))
  return { dir, report }
})()

describe("saved run.ts reports", () => {
  test("become runs with the ledger's admissions and settlements, and plan every fixture", () => {
    const converted = fromRunReport(runReport(), fixtures)
    expect(converted.plan.map((entry) => entry.case)).toEqual([
      "invoice-ledger-sync",
      "http-retry-refactor",
      "order-search-sql",
    ])
    const [found, alarm, failed] = converted.runs
    expect(found).toMatchObject({
      variant: "single-prompt",
      model: MODEL,
      status: "completed",
      trust: "untrusted",
      spend: { costUsd: 0.003, uncertainUsd: 0, usageMissing: false, admitted: true },
      tokens: { input: 900, output: 200 },
      startedAt: "2026-11-04T10:00:00.000Z",
    })
    expect(found.posted).toEqual(found.proposed)
    expect(alarm.status).toBe("completed")
    // The errored request returned no usage: its whole reservation is uncertain, not zero.
    expect(failed).toMatchObject({
      status: "failed",
      detail: "HTTP 500: upstream",
      spend: { uncertainUsd: 0.05, usageMissing: true, admitted: true },
    })
    expect(failed.spend.costUsd).toBeUndefined()
  })

  test("a run the ledger never admitted is unaccounted", () => {
    const report = runReport()
    const converted = fromRunReport(
      { ...report, ledger: report.ledger.filter((entry) => entry.type !== "admit") },
      fixtures,
    )
    expect(converted.runs.map((run) => run.spend.admitted)).toEqual([false, false, false])
  })

  test("fixtures become labelled cases", () => {
    const invoice = fixtureCase(fixtures.find((fixture) => fixture.name === "invoice-ledger-sync")!)
    expect(invoice).toMatchObject({
      kind: "bug",
      language: "typescript",
      defects: [
        { id: "unawaited-ledger-post", locations: [{ path: "src/billing/sync.ts", line: 41 }], alternatives: [] },
      ],
    })
    expect(fixtureCase(fixtures.find((fixture) => fixture.name === "monthly-report-refactor")!)).toMatchObject({
      kind: "control",
      language: "python",
      defects: [],
    })
  })

  // A judge checks an unexpected finding against the code, so each case says where its code is.
  test("cases say where a judge reads their code", () => {
    const invoice = fixtures.find((fixture) => fixture.name === "invoice-ledger-sync")!
    expect(fixtureCase(invoice).code).toEqual({ patch: invoice.diff })
    expect(invoice.diff).not.toContain(invoice.name)
    const code = manifestCase(bug).code
    expect(code).toEqual({ repository: bug.repository.url, base: bug.candidate.base, head: bug.candidate.head })
    expect(JSON.stringify(code)).not.toContain(bug.fix!.sha)
  })
})

describe("the eval ledger in a report", () => {
  // Every model of a CI run writes to one journal, and each report embeds the journal as it stood when it finished.
  function sharedJournal() {
    const journal = join(root, `shared-${Math.random().toString(16).slice(2)}.jsonl`)
    const limits = { totalUsd: 10, caseUsd: 1, reserveUsd: 1 }
    const charge = (model: string, costUsd: number, settle = true) => {
      const ledger = Ledger.open({ limits, journal })
      const admission = ledger.admit({ case: `${model} x#1`, kind: "provider", model, estimateUsd: 0.5 })
      if (!admission.admitted) throw new Error(admission.detail)
      admission.ticket.sent()
      if (settle) admission.ticket.settle({ costUsd, basis: "reported" })
      ledger.close()
      return { budget: ledger.summary(), ledger: [...ledger.entries] }
    }
    // The first model spends $0.40 and overshoots nothing; the second spends $0.30 and leaves one attempt uncertain.
    const first = charge("vendor/a", 0.4)
    const second = charge("vendor/b", 0.3)
    const third = charge("vendor/c", 0, false)
    return { journal, reports: [first, second, third] }
  }

  test("counts a journal the reports share once, not once per report", () => {
    const shared = sharedJournal()
    // Each later report's own summary already includes the earlier models' spend.
    const [one, two, three] = shared.reports.map((report) => report.budget.spentUsd)
    expect(one).toBeCloseTo(0.4)
    expect(two).toBeCloseTo(0.7)
    expect(three).toBeCloseTo(0.7)
    const summaries = ledgerSummaries(shared.reports)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ uncertainUsd: 0.5, attempts: { admitted: 3, settled: 2, uncertain: 1 } })
    expect(summaries[0]!.spentUsd).toBeCloseTo(0.7)
    expect(summaries[0]).toEqual(Ledger.inspect(shared.journal))
    // Reports charged to separate journals are added up.
    const other = sharedJournal()
    expect(ledgerSummaries([...shared.reports, ...other.reports]).map((item) => item.spentUsd)).toHaveLength(2)
  })

  test("keeps two journals apart that were opened in the same millisecond with the same limits", () => {
    const limits = { totalUsd: 10, caseUsd: 1, reserveUsd: 1 }
    const now = () => new Date("2026-11-04T00:00:00.000Z")
    const charge = (journal: string, costUsd: number) => {
      const ledger = Ledger.open({ limits, journal: join(root, journal), now })
      const admission = ledger.admit({ case: "x#1", kind: "provider", model: "vendor/a", estimateUsd: 0.5 })
      if (!admission.admitted) throw new Error(admission.detail)
      admission.ticket.sent()
      admission.ticket.settle({ costUsd, basis: "reported" })
      ledger.close()
      return { budget: ledger.summary(), ledger: [...ledger.entries] }
    }
    const summaries = ledgerSummaries([charge("same-ms-a.jsonl", 0.4), charge("same-ms-b.jsonl", 0.4)])
    expect(summaries.map((item) => item.spentUsd)).toEqual([0.4, 0.4])
  })

  test("report.ts shows a shared journal's spend once, and --ledger alone when it is given", async () => {
    const shared = sharedJournal()
    const dir = join(root, "shared-reports")
    mkdirSync(dir)
    for (const [index, report] of shared.reports.entries())
      writeFileSync(join(dir, `${index}.json`), JSON.stringify({ ...runReport(), ...report }))
    const loaded = await loadOutputs({ paths: [dir] })
    expect(loaded.ledger!.spentUsd).toBeCloseTo(0.7)
    expect(loaded.ledger!.uncertainUsd).toBeCloseTo(0.5)
    const given = await loadOutputs({ paths: [dir], ledger: shared.journal })
    expect(given.ledger!.spentUsd).toBeCloseTo(0.7)
    expect(given.ledger!.uncertainUsd).toBeCloseTo(0.5)
    const result = await main(["--outputs", dir])
    expect(result.stdout).toContain("Eval ledger: $0.7000 spent as reported, $0.5000 uncertain")
  })
})

// Phase 0, "Runner and baselines": an empty-finding control exposes the precision denominator.
describe("the empty-finding control", () => {
  test("is a completed, admitted, free review of every planned case that reports nothing", () => {
    const plan = [
      { variant: "engine", model: "m", case: "a", repetition: 1 },
      { variant: "engine", model: "m", case: "a", repetition: 2 },
      { variant: "other", model: "n", case: "a", repetition: 1 },
      { variant: "engine", model: "m", case: "b", repetition: 1 },
    ]
    const empty = emptyControl(plan)
    expect(empty.plan).toEqual([
      { ...EMPTY_CONTROL, case: "a", repetition: 1 },
      { ...EMPTY_CONTROL, case: "a", repetition: 2 },
      { ...EMPTY_CONTROL, case: "b", repetition: 1 },
    ])
    for (const run of empty.runs)
      expect(run).toMatchObject({
        status: "completed",
        proposed: [],
        posted: [],
        spend: { costUsd: 0, uncertainUsd: 0, usageMissing: false, admitted: true },
        violations: [],
      })
  })

  test("report.ts --empty-control shows precision as n/a with its counts, recall 0 and no false alarm", async () => {
    const out = join(root, "empty.json")
    const result = await main([
      "--outputs",
      savedRun.dir,
      "--empty-control",
      "--candidate",
      `single-prompt=${MODEL}`,
      "--out",
      out,
    ])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("## empty · none")
    const saved = await Bun.file(out).json()
    const empty = saved.groups.find((group: { variant: string }) => group.variant === "empty").stages.posted
    expect(empty.planned).toBe(3)
    expect(empty.coverage).toMatchObject({ count: 3, total: 3, value: 1 })
    expect(empty.precision).toEqual({ count: 0, total: 0, value: null, interval: null })
    expect(empty.recall).toMatchObject({ count: 0, total: 2, value: 0 })
    expect(empty.falseAlarmsPerCleanPr).toMatchObject({ count: 0, exposure: 1, value: 0 })
    expect(empty.spend).toMatchObject({ costUsd: 0, uncertainUsd: 0, unaccounted: 0 })
    // It is a baseline, not a candidate: the gate still decides on the named candidate.
    expect(saved.decision.candidate).toEqual({ variant: "single-prompt", model: MODEL })
  })
})

describe("saved replay artifacts", () => {
  const journal = (key: string) => {
    const ledger = Ledger.open({ limits: { totalUsd: 10, caseUsd: 1, reserveUsd: 1 } })
    ledger.admit({ case: key, kind: "provider", model: "m", note: "replay", estimateUsd: 1 })
    return [...ledger.entries]
  }
  // admitReplay's case: the pipeline variant, the models, the case and the repetition.
  const key = `engine vendor/reviewer-large + vendor/triage-small ${bug.id}#1`

  test("propose the reviewers' findings and post what selection kept and the writes carried", () => {
    const run = fromArtifact(artifact(), seed, journal(key))
    expect(run).toMatchObject({
      variant: "engine",
      model: "vendor/reviewer-large",
      models: ["vendor/reviewer-large", "vendor/triage-small"],
      status: "completed",
      ms: 42000,
      violations: [],
    })
    expect(run.proposed.map((finding) => finding.title)).toEqual([
      "The default argument may be None",
      "Unrelated concern",
      "Low confidence guess",
    ])
    expect(run.posted.map((finding) => [finding.title, finding.anchored])).toEqual([
      ["The default argument may be None", true],
      ["Unrelated concern", false],
    ])
    // The same finding has the same key in both lists.
    expect(run.posted[0].key).toBe(run.proposed[0].key)
    expect(run.spend).toEqual({ costUsd: 0.05, uncertainUsd: 0.1, usageMissing: true, admitted: true })
    expect(run.tokens).toEqual({ input: 5000, output: 500 })
    expect(fromArtifact(artifact(), seed, []).spend.admitted).toBe(false)
  })

  // Phase 1 review: every engine artifact was "engine", so a variant's replays merged with the frozen pipeline's.
  test("a variant's replays are their own run, admitted under their own case", () => {
    const shared = artifact({ variant: { verifyPolicy: "shared" } })
    const sharedKey = `engine:shared-verify vendor/reviewer-large + vendor/triage-small ${bug.id}#1`
    expect(fromArtifact(shared, seed, journal(sharedKey))).toMatchObject({
      variant: "engine:shared-verify",
      model: "vendor/reviewer-large",
      spend: { admitted: true },
    })
    // The frozen pipeline's admission does not account for the variant's paid attempts, nor the reverse.
    expect(fromArtifact(shared, seed, journal(key)).spend.admitted).toBe(false)
    expect(fromArtifact(artifact(), seed, journal(sharedKey)).spend.admitted).toBe(false)
    // An explicit "legacy" is the frozen pipeline.
    expect(fromArtifact(artifact({ variant: { verifyPolicy: "legacy" } }), seed, journal(key))).toMatchObject({
      variant: "engine",
      spend: { admitted: true },
    })
    // VS-21a's record names the same run, under the same case, as VS-06's.
    const named = artifact({ variant: { name: "engine:shared-verify", keys: { verifyPolicy: "shared" } } })
    expect(fromArtifact(named, seed, journal(sharedKey))).toMatchObject({
      variant: "engine:shared-verify",
      spend: { admitted: true },
    })
  })

  test("partial, failed and empty replays are not complete", () => {
    expect(fromArtifact(artifact({}, { partial: "timeout", unreviewed: ["a.py"] }), seed, [])).toMatchObject({
      status: "partial",
      detail: "stopped early (timeout), 1 file(s) unreviewed",
    })
    expect(
      fromArtifact(
        artifact(
          {},
          {
            specialists: [
              { name: "review", status: "ok", steps: 1 },
              { name: "verify", status: "timeout", steps: 1 },
            ],
          },
        ),
        seed,
        [],
      ),
    ).toMatchObject({ status: "partial", detail: "verify timeout" })
    const failed = fromArtifact(
      artifact(
        { posted: [{ write: "createIssueComment", pr: 0, body: "failed" }] },
        {
          specialists: [
            { name: "review", status: "failed", steps: 0, detail: "model error" },
            { name: "security", status: "failed", steps: 0 },
          ],
        },
      ),
      seed,
      [],
    )
    expect(failed).toMatchObject({ status: "failed", detail: "model error", posted: [] })
    const empty = fromArtifact(
      artifact({
        outcome: undefined,
        attempts: [],
        files: { reviewed: [], skipped: [{ path: "a.lock", reason: "lockfile" }] },
      }),
      seed,
      [],
    )
    expect(empty).toMatchObject({ status: "partial", proposed: [], posted: [], spend: { admitted: true } })
    expect(empty.detail).toContain("nothing was reviewed")
  })

  test("a refused summary leaves its findings unposted", () => {
    const run = fromArtifact(artifact({ posted: [artifact().posted[0]], refused: "secret in output" }), seed, [])
    expect(run.posted.map((finding) => finding.anchored)).toEqual([true])
  })

  test("trust checks: untrusted review of the case's own candidate, with the fix never posted", () => {
    const trusted = fromArtifact(artifact({ trust: "trusted" }), seed, [])
    expect(trusted.violations).toEqual(["reviewed as trusted, though dataset cases replay untrusted"])
    const moved = fromArtifact(artifact({ source: { ...artifact().source, head: bug.fix!.sha } }), seed, [])
    expect(moved.violations[0]).toContain("not the case's candidate")
    const leaked = fromArtifact(
      artifact({ posted: [{ write: "createIssueComment", pr: 0, body: `see ${bug.fix!.sha.slice(0, 7)}` }] }),
      seed,
      [],
    )
    expect(leaked.violations).toEqual(["the fix commit appears in what would be posted"])
  })
})

describe("report.ts", () => {
  test("re-scores a saved run.ts report offline against a judgement file and evaluates the gate", async () => {
    const dir = savedRun.dir
    const runs = fromRunReport(savedRun.report, fixtures).runs
    const agreed = (run: EvalRun, verdict: Judgement["passes"][number]["verdict"]): Judgement => ({
      run: runKey(run),
      finding: run.proposed[0].key,
      passes: [
        { judge: "human:annotator", rubric: RUBRIC_VERSION, verdict },
        { judge: "model:vendor/judge", rubric: RUBRIC_VERSION, verdict },
      ],
    })
    const judgements = join(root, "judgements.json")
    writeFileSync(
      judgements,
      JSON.stringify({
        schema: JUDGEMENTS_SCHEMA,
        seed: "s",
        judgements: [
          agreed(runs[0], { kind: "match", defect: "unawaited-ledger-post" }),
          agreed(runs[1], { kind: "false-alarm" }),
        ],
        calls: [],
      }),
    )
    const out = join(root, "report.json")
    const result = await main(["--outputs", dir, "--judgements", judgements, "--out", out])
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("# VectorScope eval: fixtures")
    expect(result.stdout).toContain("## single-prompt · vendor/reviewer")
    expect(result.stdout).toContain("| Recall, end to end | 50.0% (1/2) [")
    expect(result.stdout).toContain("| False alarms per clean PR | 1.00 (1 in 1) [")
    expect(result.stdout).toContain("## Gate D2: fail")
    expect(result.stdout).toContain("| minCoverage | 0.95 | 0.6667 |")
    expect(result.stdout).toContain("Not a release decision: the results are from the fixtures split")
    expect(result.stdout).toContain("Offline: saved outputs were re-scored and no request was sent.")
    const saved = await Bun.file(out).json()
    expect(saved.decision.outcome).toBe("fail")
    expect(saved.groups[0].stages.posted.spend).toMatchObject({ uncertainUsd: 0.05, usageMissing: 1, unaccounted: 0 })
    expect(saved.ledger).toMatchObject({ open: 0 })
  })

  test("replay artifacts plan every case of the split, so a lost artifact is missing", async () => {
    const dir = join(root, "replays")
    mkdirSync(dir)
    writeFileSync(join(dir, "one.json"), JSON.stringify(artifact()))
    const loaded = await loadOutputs({ paths: [dir] })
    const development = seed.cases.filter((item) => item.split === "development")
    expect(loaded.split).toBe("development")
    expect(loaded.frozen).toBe(false)
    expect(loaded.plan.map((entry) => entry.case)).toEqual(development.map((item) => item.id))
    expect(loaded.sources.vector).toBe("abc123")
    const result = await main(["--outputs", dir])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      `${development.length} planned: 1 completed, 0 partial, 0 failed, 0 not sent, ${development.length - 1} missing`,
    )
    // No judgement file: every finding is unjudged and the gate cannot settle precision.
    expect(result.stdout).toContain("actionable finding(s) have no settled verdict")
    // The replay's paid attempts were never admitted by an eval ledger.
    expect(result.stdout).toContain("| maxUnaccountedAttempts | 0 | 1 |")
  })

  test("the frozen pipeline's and a variant's replays of one model are two groups that pair as baseline and candidate", async () => {
    const dir = join(root, "variants")
    mkdirSync(dir)
    writeFileSync(join(dir, "legacy.json"), JSON.stringify(artifact()))
    writeFileSync(join(dir, "shared.json"), JSON.stringify(artifact({ variant: { verifyPolicy: "shared" } })))
    const loaded = await loadOutputs({ paths: [dir] })
    const development = seed.cases.filter((item) => item.split === "development")
    expect(loaded.runs.map((run) => [run.variant, run.model])).toEqual([
      ["engine", "vendor/reviewer-large"],
      ["engine:shared-verify", "vendor/reviewer-large"],
    ])
    // Each group plans every case of the split.
    expect(loaded.plan.filter((entry) => entry.variant === "engine")).toHaveLength(development.length)
    expect(loaded.plan.filter((entry) => entry.variant === "engine:shared-verify")).toHaveLength(development.length)
    const out = join(root, "variants-report.json")
    const result = await main([
      "--outputs",
      dir,
      "--candidate",
      "engine:shared-verify=vendor/reviewer-large",
      "--baseline",
      "engine=vendor/reviewer-large",
      "--out",
      out,
    ])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("## engine · vendor/reviewer-large")
    expect(result.stdout).toContain("## engine:shared-verify · vendor/reviewer-large")
    const saved = await Bun.file(out).json()
    expect(saved.groups.map((group: { variant: string }) => group.variant)).toEqual(["engine", "engine:shared-verify"])
    expect(saved.decision.candidate).toEqual({ variant: "engine:shared-verify", model: "vendor/reviewer-large" })
    expect(saved.decision.baseline).toEqual({ variant: "engine", model: "vendor/reviewer-large" })
    expect(saved.problems.join(" ")).not.toContain("has no planned runs")
  })

  // VS-21a: a variant record the registry does not bear out may not be the run it names.
  test("lists each artifact whose variant record the registry does not bear out, and refuses a pending name", async () => {
    const dir = join(root, "variant-records")
    mkdirSync(dir)
    writeFileSync(
      join(dir, "named.json"),
      JSON.stringify(artifact({ variant: { name: "engine:shared-verify", keys: { verifyPolicy: "shared" } } })),
    )
    writeFileSync(
      join(dir, "pending.json"),
      JSON.stringify(artifact({ label: "pending", variant: { name: "engine:trivial-skip", keys: {} } })),
    )
    writeFileSync(
      join(dir, "mismatched.json"),
      JSON.stringify(
        artifact({ label: "mismatched", variant: { name: "engine:shared-verify", keys: { verifyPolicy: "legacy" } } }),
      ),
    )
    // A pending name carrying a built variant's keys: ReviewEval.replay, which cannot see the registry, would run it.
    writeFileSync(
      join(dir, "mislabeled.json"),
      JSON.stringify(
        artifact({ label: "mislabeled", variant: { name: "engine:privacy-zdr", keys: { verifyPolicy: "shared" } } }),
      ),
    )
    // A hand-edited record that is not an object is listed, not thrown on.
    writeFileSync(
      join(dir, "primitive.json"),
      JSON.stringify(artifact({ label: "primitive", variant: "engine:shared-verify" })),
    )
    const loaded = await loadOutputs({ paths: [dir] })
    const problems = loaded.problems.filter((problem) => problem.startsWith(dir))
    expect(problems).toHaveLength(4)
    expect(problems[0]).toStartWith(join(dir, "mislabeled.json"))
    expect(problems[0]).toContain("engine:privacy-zdr is registered for VS-23c, which has not landed")
    expect(problems[1]).toStartWith(join(dir, "mismatched.json"))
    expect(problems[1]).toContain("not the registry's")
    expect(problems[2]).toStartWith(join(dir, "pending.json"))
    expect(problems[2]).toContain("registered for VS-24 wiring, which has not landed")
    expect(problems[3]).toBe(`${join(dir, "primitive.json")}: its variant record is not an object`)
    // The record that is not an object names the frozen pipeline, as VS-06's reader took it.
    expect(loaded.runs.find((run) => run.case === "primitive")?.variant).toBe("engine")
    // Any of them keeps the report from a release decision.
    const out = join(root, "variant-records-report.json")
    const result = await main([
      "--outputs",
      dir,
      "--candidate",
      "engine:shared-verify=vendor/reviewer-large",
      "--out",
      out,
    ])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("not the registry's")
    const saved = await Bun.file(out).json()
    expect(saved.problems).toEqual(expect.arrayContaining(problems))
    expect(saved.decision.release.eligible).toBe(false)
    expect(saved.decision.release.reasons.join(" ")).toContain("input or judging problem(s) are listed in the report")
    // A pending, unknown or malformed variant cannot be the candidate or the baseline, a mistyped runner included;
    // only single-prompt and the empty control pass as given.
    for (const [flag, value, detail] of [
      ["--candidate", "engine:trivial-skip=vendor/reviewer-large", "registered for VS-24 wiring"],
      ["--baseline", "engine:verify=vendor/reviewer-large", "not a registered variant"],
      ["--candidate", "engine:Shared=vendor/reviewer-large", "is not a variant name"],
      ["--candidate", "Engine:shared-verify=vendor/reviewer-large", '"Engine:shared-verify" is not a variant name'],
      ["--baseline", "engine :shared-verify=vendor/reviewer-large", '"engine :shared-verify" is not a variant name'],
      ["--baseline", "codium=vendor/reviewer-large", "codium names no runner"],
      ["--candidate", "engine", "--candidate takes <variant>=<model>."],
    ] as const) {
      const refused = await main(["--outputs", dir, flag, value])
      expect(refused.code).toBe(2)
      expect(refused.stderr).toContain(detail)
    }
    expect((await main(["--outputs", savedRun.dir, "--candidate", `single-prompt=${MODEL}`])).code).toBe(0)
    expect(
      (
        await main([
          "--outputs",
          savedRun.dir,
          "--empty-control",
          "--candidate",
          `single-prompt=${MODEL}`,
          "--baseline",
          `${EMPTY_CONTROL.variant}=${EMPTY_CONTROL.model}`,
        ])
      ).code,
    ).toBe(0)
  })

  test("refuses output inside the repository, an unknown split and an invalid gate", async () => {
    const dir = savedRun.dir
    expect((await main(["--outputs", dir, "--out", join(import.meta.dir, "report.json")])).code).toBe(2)
    expect(existsSync(join(import.meta.dir, "report.json"))).toBe(false)
    expect((await main(["--outputs", dir, "--split", "everything"])).code).toBe(2)
    expect((await main(["--outputs", dir, "--candidate", "nomodel"])).code).toBe(2)
    expect((await main([])).code).toBe(2)
    const gate = join(root, "gate.json")
    writeFileSync(gate, JSON.stringify({ version: 1 }))
    const invalid = await main(["--outputs", dir, "--gate", gate])
    expect(invalid.code).toBe(1)
    expect(invalid.stderr).toContain("approved needs who approved the thresholds")
  })

  test("prints the default gate, the owner's approved D2, as a gate file", async () => {
    const printed = await main(["--print-gate"])
    expect(printed.code).toBe(0)
    expect(JSON.parse(printed.stdout)).toEqual(DEFAULT_GATE)
  })

  test("an edited gate file re-scores the same outputs without any new call, and a weaker one decides no release", async () => {
    const dir = savedRun.dir
    const gate = join(root, "edited.json")
    writeFileSync(
      gate,
      JSON.stringify({
        ...DEFAULT_GATE,
        approved: { by: "owner", date: "2026-11-05" },
        rules: { ...DEFAULT_GATE.rules, minCoverage: 0.5 },
      }),
    )
    const out = join(root, "edited-report.json")
    const result = await main(["--outputs", dir, "--gate", gate, "--out", out])
    expect(result.stdout).toContain("| minCoverage | 0.5 | 0.6667 |")
    expect(result.stdout).toContain("gate D2 (approved by owner on 2026-11-05")
    // A lower coverage threshold is weaker than D2, and a changed copy cannot speak for D2.
    const reasons: string[] = (await Bun.file(out).json()).decision.release.reasons
    expect(reasons).toContain("the gate is weaker than the approved D2: minCoverage is 0.5, looser than D2's 0.95")
    expect(reasons.some((reason) => reason.includes("is not the approved D2 config"))).toBe(true)
  })
})

test("evalFinding keys a finding the same before and after selection", () => {
  const proposed = evalFinding(modelFinding())
  const posted = evalFinding(
    {
      ...modelFinding({ body: "Changed. The same problem is also at line 44." }),
      id: "x",
      side: "RIGHT",
      source: "review",
    },
    true,
  )
  expect(posted.key).toBe(proposed.key)
  expect(posted.anchored).toBe(true)
  expect(proposed).not.toHaveProperty("anchored")
})

// VS-21c: the operations fields of an engine replay, desktop artifacts and projection records; VS-22a: the case labels.
describe("VS-21c outputs", () => {
  function desktop(overrides: Partial<DesktopArtifact> = {}): DesktopArtifact {
    const engine = artifact()
    const outcome = engine.outcome!
    return {
      version: 1,
      label: bug.id,
      adapter: "desktop",
      repetition: 1,
      runtime: { node: "v22.0.0", platform: "darwin", arch: "arm64" },
      source: { base: bug.candidate.base, head: bug.candidate.head, vector: "abc123" },
      trust: "untrusted",
      models: { review: { id: "vendor/reviewer-large", costKind: "priced", price: { input: 3, output: 15 } } },
      scope: {} as DesktopArtifact["scope"],
      sessions: [],
      passes: [],
      attempts: [
        {
          seq: 1,
          pass: "vectorscope.review",
          format: "report",
          digest: "d1",
          chars: 10,
          answered: true,
          costUsd: 0,
          tokens: { input: 4000, output: 300 },
          startMs: 0,
          ms: 2500,
        },
        {
          seq: 2,
          pass: "vectorscope.verify",
          format: "verify",
          digest: "d2",
          chars: 10,
          answered: true,
          costUsd: 0,
          tokens: { input: 1000, output: 100 },
          startMs: 2600,
          ms: 700,
        },
      ],
      aborted: [],
      outcome: {
        head: bug.candidate.head,
        baseRef: "base",
        checkout: { trust: "untrusted" },
        label: "l",
        report: outcome.report,
        selection: outcome.selection,
        skipped: [],
        files: [],
        anchored: {},
        durationMs: 3500,
        specialists: [{ name: "review", status: "ok" }],
        sessions: [],
        banners: [],
        notes: [],
      } as unknown as DesktopArtifact["outcome"],
      placed: [],
      proposed: { body: "review", comments: [], untrusted: true },
      ...overrides,
    }
  }

  test("an engine replay says how many attempts it made, why it stopped, each pass's time and its cache use", () => {
    const run = fromArtifact(
      artifact({
        passes: [
          { pass: "review", model: "m", digest: "d", chars: 1, startMs: 0, ms: 3000, cacheRead: 1200, cacheWrite: 300 },
          { pass: "verify", model: "m", digest: "d", chars: 1, startMs: 3100, ms: 400, cacheRead: 100, cacheWrite: 0 },
          { pass: "security", model: "m", digest: "d", chars: 1 },
        ],
      }),
      seed,
      [],
    )
    expect(run.attempts).toBe(2)
    expect(run.passes).toEqual([
      { pass: "review", ms: 3000 },
      { pass: "verify", ms: 400 },
    ])
    expect(run.tokens).toEqual({ input: 5000, output: 500, cacheRead: 1300, cacheWrite: 300 })
    expect(run.stop).toBeUndefined()
    expect(fromArtifact(artifact({}, { partial: "budget" }), seed, []).stop).toBe("budget")
    // An artifact written before the timing fields has none, and no cache count.
    const old = fromArtifact(artifact(), seed, [])
    expect(old.passes).toBeUndefined()
    expect(old.tokens).toEqual({ input: 5000, output: 500 })
  })

  test("a desktop replay becomes a run of its own runner, timed per pass, its paid attempts unaccounted", () => {
    const run = fromDesktopArtifact(desktop(), seed)!
    expect(run).toMatchObject({
      variant: "desktop",
      model: "vendor/reviewer-large",
      case: bug.id,
      status: "completed",
      ms: 3500,
      attempts: 2,
      passes: [
        { pass: "review", ms: 2500 },
        { pass: "verify", ms: 700 },
      ],
      tokens: { input: 5000, output: 400 },
      spend: { costUsd: 0, uncertainUsd: 0, usageMissing: false, admitted: true },
      violations: [],
    })
    expect(run.proposed.map((finding) => finding.title)).toContain("Low confidence guess")
    expect(run.posted.map((finding) => [finding.title, finding.anchored])).toEqual([
      ["The default argument may be None", true],
      ["Unrelated concern", false],
    ])
    // A pass's wall time is from its first call's start to its last call's end: overlapping calls count once.
    const first = desktop().attempts[0]!
    const overlapping = desktop({
      attempts: [
        { ...first, seq: 1, startMs: 0, ms: 2000 },
        { ...first, seq: 2, startMs: 500, ms: 2500 },
        { ...first, seq: 3, startMs: 1000, ms: 500 },
        // Still in flight: not timed.
        {
          seq: 4,
          pass: "vectorscope.review",
          format: "report",
          digest: "d4",
          chars: 10,
          answered: false,
          startMs: 9000,
        },
      ],
    })
    expect(fromDesktopArtifact(overlapping, seed)!.passes).toEqual([{ pass: "review", ms: 3000 }])
    const paid = desktop({ attempts: [{ ...desktop().attempts[0]!, costUsd: 0.02 }] })
    expect(fromDesktopArtifact(paid, seed)!.spend).toMatchObject({ costUsd: 0.02, admitted: false })
    expect(fromDesktopArtifact(desktop({ error: "boom", outcome: undefined }), seed)).toMatchObject({
      status: "failed",
      detail: "boom",
      posted: [],
    })
    expect(fromDesktopArtifact(desktop({ aborted: ["vectorscope.security"] }), seed)).toMatchObject({
      status: "partial",
      detail: "aborted vectorscope.security",
    })
    expect(fromDesktopArtifact(desktop({ trust: "trusted" }), seed)!.violations).toEqual([
      "reviewed as trusted, though dataset cases replay untrusted",
    ])
    const variant = desktop({
      variant: { name: "desktop:shared-verify", keys: { verifyPolicy: "shared" }, applied: true },
    })
    expect(fromDesktopArtifact(variant, seed)!.variant).toBe("desktop:shared-verify")
  })

  test("a desktop run whose variant never reached its runner is left out and listed, and its case stays planned", async () => {
    const dir = join(root, "desktop-replays")
    mkdirSync(dir)
    const skipped = desktop({
      variant: { name: "desktop:shared-verify", keys: { verifyPolicy: "shared" }, applied: false },
    })
    expect(fromDesktopArtifact(skipped, seed)).toBeUndefined()
    writeFileSync(join(dir, "applied.json"), JSON.stringify(desktop()))
    writeFileSync(join(dir, "skipped.json"), JSON.stringify(skipped))
    const loaded = await loadOutputs({ paths: [dir] })
    expect(loaded.runs.map((run) => run.variant)).toEqual(["desktop"])
    expect(
      loaded.plan.filter((entry) => entry.variant === "desktop:shared-verify" && entry.case === bug.id),
    ).toHaveLength(1)
    expect(loaded.problems).toContain(
      `${join(dir, "skipped.json")} asked for desktop:shared-verify, but it never reached the runner, so it is left out`,
    )
  })

  test("projection records are projected runs; one with a problem is listed and left out", async () => {
    const dir = join(root, "projections")
    mkdirSync(dir)
    const request = { seq: 1, phase: "turn", estimateUsd: 0.1, digest: "d", chars: 4, tokens: 2, body: "body" }
    const record = {
      version: 1,
      kind: "projection",
      label: bug.id,
      repetition: 1,
      source: { base: bug.candidate.base, head: bug.candidate.head, mergeBase: bug.candidate.base, vector: "abc123" },
      variant: { name: "engine:shared-verify", keys: { verifyPolicy: "shared" } },
      models: { review: { id: "vectorscope-projection/vendor/reviewer-large", context: 1, costKind: "priced" } },
      files: { reviewed: [labelled.path], skipped: [] },
      cap: { maxCostUsd: 0.75, over: [] },
      passes: [
        {
          pass: "review",
          model: "m",
          maxSteps: 20,
          status: "ok",
          digest: "p",
          chars: 4,
          requests: [request, { ...request, seq: 2, tokens: 3 }],
          promptTokens: 2,
          usd: { low: 0.1, high: 0.5 },
          unsent: 0,
          unadmitted: 0,
        },
      ],
      unattributed: 0,
      egress: { attempts: 2, outside: 0 },
    } as unknown as ProjectionRecord
    writeFileSync(join(dir, "good.projection.json"), JSON.stringify(record))
    writeFileSync(join(dir, "bad.projection.json"), JSON.stringify({ ...record, egress: { attempts: 2, outside: 1 } }))
    const loaded = await loadOutputs({ paths: [dir] })
    expect(loaded.projected).toEqual([
      {
        variant: "engine:shared-verify",
        model: "vectorscope-projection/vendor/reviewer-large",
        models: ["vectorscope-projection/vendor/reviewer-large"],
        case: bug.id,
        repetition: 1,
        usd: { low: 0.1, high: 0.5 },
        tokens: { first: 2, sent: 5 },
        passes: 1,
        requests: 2,
        over: 0,
        outside: 0,
      },
    ])
    expect(loaded.problems).toContain(`${join(dir, "bad.projection.json")}: 1 connections went outside this computer`)
    expect(loaded.runs).toEqual([])
    expect(loaded.sources.vector).toBe("abc123")
    // The report joins a projection with the paid replay of the same variant, case and model. This replay kept its
    // unsettled verify attempt at its bound, so its spend is not known and the estimate is not compared with it.
    const paid = {
      variant: { name: "engine:shared-verify", keys: { verifyPolicy: "shared" } },
      models: { review: { id: "openrouter/vendor/reviewer-large", context: 1, costKind: "priced" } },
    }
    writeFileSync(join(dir, "paid.json"), JSON.stringify(artifact(paid)))
    const bounded = await main(["--outputs", dir])
    expect(bounded.code).toBe(0)
    expect(bounded.stdout).toContain("## Projections")
    expect(bounded.stdout).toContain(
      "| engine:shared-verify · vectorscope-projection/vendor/reviewer-large | 1 | 1 | 2 |",
    )
    expect(bounded.stdout).toContain("Estimate error, |projected low - settled| / settled: n/a (0 of 0)")
    expect(bounded.stdout).toContain("0 run(s) left out because their projection went over its dollar cap, 1 because")
    // Every attempt settled from reported usage: $0.125 against the projected low of $0.10.
    const settled = {
      seq: 1,
      pass: "review",
      phase: "step",
      admitted: true,
      estimateUsd: 0.2,
      settled: { costUsd: 0.125, complete: true, tokens: { input: 5000, output: 500 } },
    }
    writeFileSync(join(dir, "paid.json"), JSON.stringify(artifact({ ...paid, attempts: [settled] })))
    const result = await main(["--outputs", dir])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Estimate error, |projected low - settled| / settled: mean 20.0%")
  })

  test("a case's VS-22a labels reach its eval case", () => {
    expect(bug.id).toBe("pallets-werkzeug-1")
    expect(manifestCase(bug).crossFile).toBe(false)
    expect(manifestCase({ ...bug, labels: { ...bug.labels, crossFile: true } }).crossFile).toBe(true)
    expect(manifestCase({ ...bug, labels: { ...bug.labels, crossFile: undefined } })).not.toHaveProperty("crossFile")
    expect(manifestCase(bug).defects.map((defect) => defect.failureClass)).toEqual(["crash", "other"])
    const control = seed.cases.find((item) => item.kind === "control")!
    expect(manifestCase(control)).not.toHaveProperty("trivialKind")
    const trivial = {
      ...control,
      kind: "trivial" as const,
      labels: { ...control.labels, trivialKind: "docs" as const },
    }
    expect(manifestCase(trivial)).toMatchObject({ kind: "control", trivialKind: "docs", defects: [] })
  })
})

// VS-27b: the strict guardrail's rules re-applied offline to what a saved engine replay posted.
describe("--reselect strict (VS-27b)", () => {
  const base = artifact()
  const original = base.outcome!.selection
  // The replay's inline finding with a committable fix, a blocking one it listed over the cap, and its concern.
  const inline = { ...original.inline[0], suggestion: "    value = value or []" }
  const overflow = {
    ...inline,
    id: "c3",
    line: inline.line + 40,
    title: "Second call site has the same default",
    suggestionAllowed: undefined,
  }
  const strict = (overrides: Record<string, unknown> = {}, outcome: Record<string, unknown> = {}) =>
    artifact(
      { config: { digest: "d", warnings: [], value: { ...DEFAULT_CONFIG_VALUE } }, ...overrides },
      { selection: { ...original, inline: [inline], overflow: [overflow] }, ...outcome },
    )
  const reselect = (value: ReplayArtifact) => reselectRun(value, fromArtifact(value, seed, []))

  test("keeps what strict would post of what the replay posted, as its own run carrying no spend", () => {
    const value = strict()
    const run = fromArtifact(value, seed, [])
    const result = reselectRun(value, run)
    expect(result.reselection).toEqual({
      kept: [inline, overflow],
      candidates: 3,
      unposted: 0,
      complete: true,
      dropped: [{ reason: "unverified", count: 1 }],
      fixUnchecked: 1,
    })
    expect(result.run).toEqual({
      variant: `engine${RESELECT_SUFFIX}`,
      model: run.model,
      models: run.models,
      case: run.case,
      repetition: 1,
      trust: "untrusted",
      status: "completed",
      proposed: run.proposed,
      posted: [evalFinding(inline, true), evalFinding(overflow, true)],
      spend: { uncertainUsd: 0, usageMissing: false, admitted: true },
      violations: [],
    })
    // A re-selected finding has the key its original posting had, so it is scored on the same verdict.
    expect(result.run.posted.map((finding) => finding.key)).toEqual(
      run.posted.filter((finding) => finding.title !== "Unrelated concern").map((finding) => finding.key),
    )
    expect(RESELECT_SUFFIX).toBe("+reselect-strict")
  })

  test("only what the replay posted is a candidate, so every re-selected finding was judged", () => {
    // The summary write never went out: the overflow and the concern were never posted.
    const review = reselect(strict({ posted: [base.posted[0]] }))
    expect(review.reselection).toMatchObject({ kept: [inline], candidates: 1, unposted: 2 })
    // The review write never went out: the line comment was never posted.
    const summary = reselect(strict({ posted: [base.posted[1]] }))
    expect(summary.reselection).toMatchObject({ kept: [overflow], candidates: 2, unposted: 1 })
    expect(summary.reselection.kept[0]).toBe(overflow)
    // A run whose every reviewer failed posted nothing.
    const failed = reselect(
      strict({}, { specialists: [{ name: "review", status: "failed", steps: 0, detail: "model error" }] }),
    )
    expect(failed.run).toMatchObject({ status: "failed", posted: [] })
    expect(failed.reselection).toMatchObject({ candidates: 0, unposted: 3, complete: false })
  })

  test("the rules it applies: S1, S2's blocking half, the recorded anchor and fix rule, S7 and S8", () => {
    const outside = { ...overflow, id: "d4", reason: "line-outside-diff", title: "Off the diff" }
    const fixless = { ...overflow, id: "e5", line: inline.line + 80, title: "No fix given", suggestion: undefined }
    const twin = { ...overflow, line: overflow.line + 1, title: "Second call site has the same default value" }
    const result = reselect(
      strict(
        {},
        { selection: { ...original, inline: [inline], overflow: [overflow, fixless, twin], outsideDiff: [outside] } },
      ),
    )
    expect(result.reselection.dropped).toEqual([
      { reason: "unverified", count: 1 },
      { reason: "anchor", count: 1 },
      { reason: "no-fix", count: 1 },
      { reason: "duplicate", count: 1 },
    ])
    // A suggestion selection allowed is committable; one it never placed is unchecked.
    expect(result.reselection.fixUnchecked).toBe(1)
    const capped = reselect(
      strict({ config: { digest: "d", warnings: [], value: { ...DEFAULT_CONFIG_VALUE, maxComments: 1 } } }),
    )
    expect(capped.reselection).toMatchObject({
      kept: [inline],
      dropped: [
        { reason: "unverified", count: 1 },
        { reason: "cap", count: 1 },
      ],
    })
  })

  test("a verdict the replay cannot show was read leaves the run incomplete", () => {
    // Without a triage model the verify pass re-checks blocking findings, so an unverified blocking one had no verdict.
    const untriaged = { models: { review: base.models.review } }
    const unread = { ...overflow, verified: undefined }
    const result = reselect(strict(untriaged, { selection: { ...original, inline: [inline], overflow: [unread] } }))
    expect(result.reselection).toMatchObject({
      complete: false,
      incomplete: ["verdict-unreadable"],
      dropped: [
        { reason: "unverified", count: 1 },
        { reason: "verdict-unreadable", count: 1 },
      ],
    })
    // A finding recorded as verified: false had its verdict read (a policy that keeps a rejected finding): not unread.
    const rejected = reselect(
      strict(untriaged, { selection: { ...original, inline: [inline], overflow: [{ ...overflow, verified: false }] } }),
    )
    // The concern, and the rejected one.
    expect(rejected.reselection).toMatchObject({ complete: true, dropped: [{ reason: "unverified", count: 2 }] })
    expect(rejected.reselection).not.toHaveProperty("incomplete")
    // With verify off, or no verify pass, nothing was sent to it.
    const off = {
      ...untriaged,
      config: { digest: "d", warnings: [], value: { ...DEFAULT_CONFIG_VALUE, verify: "off" } },
    }
    expect(
      reselect(strict(off, { selection: { ...original, inline: [inline], overflow: [unread] } })).reselection.complete,
    ).toBe(true)
    // After a triage pass the review model's unconfirmed findings are not in the artifact at all.
    const triaged = reselect(
      strict({}, { selection: { ...original, inline: [inline], dropped: [{ reason: "unconfirmed", count: 2 }] } }),
    )
    expect(triaged.reselection).toMatchObject({ complete: false, incomplete: ["verdicts-unrecorded"] })
    // Coverage reads as strict reads it, and a replay with nothing reviewed has no reviewer.
    expect(reselect(strict({}, { partial: "timeout" })).reselection.incomplete).toEqual(["timeout"])
    const empty = reselect(artifact({ outcome: undefined, attempts: [] }))
    expect(empty.reselection).toMatchObject({ kept: [], candidates: 0, complete: false, incomplete: ["no-reviewer"] })
  })

  test("report.ts --reselect strict scores both groups on the same verdicts, and the gate decides on neither copy", async () => {
    const dir = join(root, "reselect")
    mkdirSync(dir)
    const value = strict()
    writeFileSync(join(dir, "one.json"), JSON.stringify(value))
    const run = fromArtifact(value, seed, [])
    const verdicts: Record<string, Judgement["passes"][number]["verdict"]> = {
      [inline.title]: { kind: "match", defect: bug.labels.defects[0].id },
      [overflow.title]: { kind: "false-alarm" },
      "Unrelated concern": { kind: "false-alarm" },
    }
    const judgements = join(root, "reselect-judgements.json")
    writeFileSync(
      judgements,
      JSON.stringify({
        schema: JUDGEMENTS_SCHEMA,
        seed: "s",
        judgements: [...run.proposed, ...run.posted]
          .filter((finding, position, all) => all.findIndex((other) => other.key === finding.key) === position)
          .map((finding) => ({
            run: runKey(run),
            finding: finding.key,
            passes: [
              {
                judge: "human:annotator",
                rubric: RUBRIC_VERSION,
                verdict: verdicts[finding.title] ?? { kind: "false-alarm" },
              },
              {
                judge: "model:vendor/judge",
                rubric: RUBRIC_VERSION,
                verdict: verdicts[finding.title] ?? { kind: "false-alarm" },
              },
            ],
          })),
        calls: [],
      }),
    )
    const loaded = await loadOutputs({ paths: [dir], reselect: "strict" })
    expect(loaded.runs.map((entry) => entry.variant)).toEqual(["engine", "engine+reselect-strict"])
    const development = seed.cases.filter((item) => item.split === "development").length
    expect(loaded.plan.filter((entry) => entry.variant === "engine+reselect-strict")).toHaveLength(development)
    expect(loaded.reselected).toEqual([
      { from: runKey(run), to: runKey(loaded.runs[1]), reselection: reselectRun(value, run).reselection },
    ])
    expect(loaded.sources.reselect).toBe(
      "strict re-selection of 1 engine replay(s), offline; applied: S1, S2's blocking half, S3 and S4 as the recorded anchors, S6 from the recorded suggestion rule, S7 by id or sameFinding, S8; left out: S2's class half, S4's quotes and S5 (legacy output has no failure block and no quotes); kept 2 of 3 posted finding(s), 0 selected but never posted left out; dropped: unverified 1; 1 fix(es) unchecked; 0 run(s) incomplete; copies carry no spend, tokens or timing",
    )
    const out = join(root, "reselect-report.json")
    const result = await main(["--outputs", dir, "--judgements", judgements, "--reselect", "strict", "--out", out])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("## engine · vendor/reviewer-large")
    expect(result.stdout).toContain("## engine+reselect-strict · vendor/reviewer-large")
    const saved = await Bun.file(out).json()
    const precision = (variant: string) =>
      saved.groups.find((group: { variant: string }) => group.variant === variant).stages.posted.precision
    expect(precision("engine")).toMatchObject({ count: 1, total: 3 })
    expect(precision("engine+reselect-strict")).toMatchObject({ count: 1, total: 2 })
    // Two groups and no --candidate: the gate is not evaluated.
    expect(saved.decision).toBeUndefined()
    expect(saved.problems).toContain("name the candidate variant and model to evaluate the gate")
    expect(result.stdout).toContain("Not evaluated: no candidate.")
    // The gate still decides on the replay itself, and the copy adds no unaccounted run: the replay's paid attempts
    // were never admitted, and counted once.
    const gated = await main(["--outputs", dir, "--reselect", "strict", "--candidate", "engine=vendor/reviewer-large"])
    expect(gated.code).toBe(0)
    expect(gated.stdout).toContain("| maxUnaccountedAttempts | 0 | 1 |")
    // Neither flag takes a re-selection, with or without --reselect.
    for (const flag of ["--candidate", "--baseline"])
      for (const extra of [[], ["--reselect", "strict"]]) {
        const refused = await main(["--outputs", dir, ...extra, flag, "engine+reselect-strict=vendor/reviewer-large"])
        expect(refused.code).toBe(2)
        expect(refused.stderr).toContain(
          `${flag}: engine+reselect-strict is an offline re-selection of saved output, not a pipeline that ran`,
        )
      }
    const bad = await main(["--outputs", dir, "--reselect", "loose"])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain("--reselect takes strict.")
  })

  test("without --reselect nothing changes; with it and no engine replay, it says so", async () => {
    const dir = join(root, "reselect-none")
    mkdirSync(dir)
    writeFileSync(join(dir, "one.json"), JSON.stringify(strict()))
    const plain = await loadOutputs({ paths: [dir] })
    expect(plain).not.toHaveProperty("reselected")
    expect(plain.sources).not.toHaveProperty("reselect")
    expect(plain.runs.map((entry) => entry.variant)).toEqual(["engine"])
    const asked = await loadOutputs({ paths: [dir], reselect: "strict" })
    expect({
      ...asked,
      runs: asked.runs.slice(0, 1),
      plan: asked.plan.filter((entry) => !entry.variant.endsWith(RESELECT_SUFFIX)),
      reselected: undefined,
      sources: { ...asked.sources, reselect: undefined },
    }).toEqual({
      ...plain,
      reselected: undefined,
      sources: { ...plain.sources, reselect: undefined },
    })
    const reports = await loadOutputs({ paths: [savedRun.dir], reselect: "strict" })
    expect(reports.reselected).toEqual([])
    expect(reports.problems).toContain("--reselect strict found no engine replay artifact, so nothing was re-selected")
    expect(reports.sources).not.toHaveProperty("reselect")
  })
})
