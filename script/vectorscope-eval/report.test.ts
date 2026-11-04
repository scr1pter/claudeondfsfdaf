import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RUBRIC_VERSION, runKey, type EvalRun, type Judgement } from "../../packages/core/src/review/eval"
import type { ModelFinding } from "../../packages/core/src/review/types"
import { DEFAULT_GATE } from "../../packages/core/src/review/eval-report"
import type { ReplayArtifact } from "../../packages/engine/src/review/eval"
import { Ledger } from "./budget"
import { loadManifest, type Manifest } from "./dataset"
import { listFixtures, loadFixture } from "./fixture"
import { evalFinding, fixtureCase, fromArtifact, fromRunReport, JUDGEMENTS_SCHEMA, loadOutputs, main } from "./report"

// The offline report over saved outputs: a run.ts report built with a real ledger, and replay artifacts shaped as the
// engine writes them. Nothing here sends a request.

const root = mkdtempSync(join(tmpdir(), "vectorscope-report-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const MODEL = "vendor/reviewer"
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
})

describe("saved replay artifacts", () => {
  const journal = (key: string) => {
    const ledger = Ledger.open({ limits: { totalUsd: 10, caseUsd: 1, reserveUsd: 1 } })
    ledger.admit({ case: key, kind: "provider", model: "m", note: "replay", estimateUsd: 1 })
    return [...ledger.entries]
  }
  const key = `vendor/reviewer-large + vendor/triage-small ${bug.id}#1`

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

  test("a stricter gate file re-scores the same outputs without any new call", async () => {
    const dir = savedRun.dir
    const gate = join(root, "strict.json")
    writeFileSync(
      gate,
      JSON.stringify({
        ...DEFAULT_GATE,
        approved: { by: "owner", date: "2026-11-05" },
        rules: { ...DEFAULT_GATE.rules, minCoverage: 0.5 },
      }),
    )
    const result = await main(["--outputs", dir, "--gate", gate])
    expect(result.stdout).toContain("| minCoverage | 0.5 | 0.6667 |")
    expect(result.stdout).toContain("gate D2 (approved by owner on 2026-11-05")
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
