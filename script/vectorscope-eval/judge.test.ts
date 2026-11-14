import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { IMPORTANCE_PROPOSAL, RUBRIC_VERSION } from "../../packages/core/src/review/eval"
import { judgeRuns, type Matcher } from "../../packages/core/src/review/eval-judge"
import { Ledger } from "./budget"
import { ledgerAdmission, ledgerCase, main, type Worksheet } from "./judge"
import { loadOutputs, main as report, readJudgements } from "./report"

// Blinded judging end to end with people's worksheets, and a fake model judge admitted by a real ledger. Nothing here
// sends a request.

const root = mkdtempSync(join(tmpdir(), "vectorscope-judge-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const MODEL = "vendor/reviewer"

// A saved run.ts report: the invoice bug found plus a second finding, and a finding on a clean refactor.
const outputs = (() => {
  const dir = join(root, "outputs")
  mkdirSync(dir)
  const ledger = Ledger.open({ limits: { totalUsd: 10, caseUsd: 1, reserveUsd: 1 } })
  for (const fixture of ["invoice-ledger-sync", "http-retry-refactor"]) {
    const admission = ledger.admit({ case: `${MODEL} ${fixture}#1`, kind: "provider", model: MODEL, estimateUsd: 0.05 })
    if (!admission.admitted) throw new Error(admission.detail)
    admission.ticket.sent()
    admission.ticket.settle({ costUsd: 0.002, basis: "reported" })
  }
  const finding = (path: string, line: number, title: string) => ({
    path,
    line,
    severity: "blocking",
    category: "bug",
    title,
    body: `${title}.`,
    confidence: 0.9,
  })
  const run = (fixture: string, findings: ReturnType<typeof finding>[]) => ({
    fixture,
    attempt: 1,
    ms: 1000,
    status: "scored",
    usage: { input: 100, output: 10, costUsd: 0.002 },
    report: { summary: "s", risk: "low", files: [], findings },
  })
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify({
      startedAt: "2026-11-04T10:00:00.000Z",
      model: MODEL,
      baseUrl: "https://example.invalid/v1/chat/completions",
      repeat: 1,
      estimate: { fixtures: [{ fixture: "invoice-ledger-sync" }, { fixture: "http-retry-refactor" }] },
      runs: [
        run("invoice-ledger-sync", [
          finding("src/billing/sync.ts", 41, "Ledger post is not awaited"),
          finding("src/billing/sync.ts", 60, "Failures are never retried"),
        ]),
        run("http-retry-refactor", [finding("src/http/retry.ts", 12, "Retry delay may overflow")]),
      ],
      budget: ledger.close(),
      ledger: [...ledger.entries],
    }),
  )
  return dir
})()

const judgements = join(root, "judgements.json")
const sheet = (name: string) => join(root, `${name}.json`)
const args = (command: string, ...rest: string[]) => [
  command,
  "--outputs",
  outputs,
  "--judgements",
  judgements,
  ...rest,
]

// Fills a worksheet: the finding that names the cause matches; the rest get `other`.
async function fill(path: string, other: (title: string) => Record<string, unknown>) {
  const worksheet = (await Bun.file(path).json()) as Worksheet
  for (const task of worksheet.tasks)
    for (const finding of task.findings)
      finding.answer = (
        finding.title.includes("not awaited")
          ? { verdict: { kind: "match", defect: task.defects[0].id }, suggestion: undefined }
          : other(finding.title)
      ) as Worksheet["tasks"][number]["findings"][number]["answer"]
  writeFileSync(path, JSON.stringify(worksheet))
  return worksheet
}

describe("judge.ts", () => {
  test("two blinded judges, a dispute and an adjudication settle every finding", async () => {
    const tasks = await main(args("tasks", "--judge", "human:alice", "--worksheet", sheet("alice")))
    expect(tasks.stderr).toBe("")
    expect(tasks.stdout).toContain("Wrote 2 task(s) with 3 finding(s) for human:alice")
    expect(tasks.stdout).toContain("Nothing was sent.")
    const text = await Bun.file(sheet("alice")).text()
    for (const hidden of [MODEL, "single-prompt", "invoice-ledger-sync", "http-retry-refactor", "anchored"])
      expect(text).not.toContain(hidden)
    // The worksheet does not carry the seed; the judgement file does.
    const file = await readJudgements(judgements)
    expect(text).not.toContain(file.seed)

    await fill(sheet("alice"), () => ({ verdict: { kind: "false-alarm" } }))
    const imported = await main(args("import", "--judge", "human:alice", "--worksheet", sheet("alice")))
    expect(imported).toMatchObject({ code: 0, stderr: "" })
    expect(imported.stdout).toContain("Recorded 3 pass(es) by human:alice")

    // Alice has nothing left to judge; Bob has everything.
    expect((await main(args("tasks", "--judge", "human:alice", "--worksheet", sheet("alice-again")))).stdout).toContain(
      "Wrote 0 task(s) with 0 finding(s)",
    )
    await main(args("tasks", "--judge", "human:bob", "--worksheet", sheet("bob")))
    await fill(sheet("bob"), (title) =>
      title.includes("retried")
        ? { verdict: { kind: "extra", issue: "no-retry" } }
        : { verdict: { kind: "false-alarm" } },
    )
    expect((await main(args("import", "--judge", "human:bob", "--worksheet", sheet("bob")))).code).toBe(0)

    // One disagreement: Alice called the retry finding a false alarm, Bob a real extra defect.
    const disputes = await main(args("disputes", "--worksheet", sheet("disputes")))
    expect(disputes.stdout).toContain("Wrote 1 disagreement(s) to adjudicate")
    const disputed = (await Bun.file(sheet("disputes")).json()) as Worksheet
    const item = disputed.tasks[0].findings[0]
    expect(item.title).toBe("Failures are never retried")
    expect(item.verdicts?.map((entry) => entry.verdict.kind).toSorted()).toEqual(["extra", "false-alarm"])
    expect(JSON.stringify(disputed)).not.toContain("alice")
    item.answer = { verdict: { kind: "extra", issue: "no-retry" } }
    writeFileSync(sheet("disputes"), JSON.stringify(disputed))
    const adjudicated = await main(
      args("adjudicate", "--worksheet", sheet("disputes"), "--by", "human:owner", "--date", "2026-11-04"),
    )
    expect(adjudicated.stdout).toContain("Recorded 1 adjudication(s) by human:owner")

    const scored = await report(["--outputs", outputs, "--judgements", judgements])
    expect(scored.stdout).toContain(
      "Adjudicated 1, agreed 2, agreed by models only (waiting for a human) 0, disagreed 0, one pass 0, none 0.",
    )
    expect(scored.stdout).toContain("| Actionable precision | 66.7% (2/3) [")
    expect(scored.stdout).toContain(
      "| Findings: matched / extra / duplicate / false alarm / unjudged | 1 / 1 / 0 / 1 / 0 |",
    )
  })

  test("worksheets cannot record a model judge, and stay outside the repository", async () => {
    const model = await main(args("tasks", "--judge", "model:vendor/judge", "--worksheet", sheet("model")))
    expect(model.code).toBe(2)
    expect(model.stderr).toContain("never from a worksheet")
    const inside = await main(
      args("tasks", "--judge", "human:alice", "--worksheet", join(import.meta.dir, "sheet.json")),
    )
    expect(inside.code).toBe(2)
    expect(existsSync(join(import.meta.dir, "sheet.json"))).toBe(false)
    expect((await main(args("adjudicate", "--worksheet", sheet("disputes"), "--by", "human:owner"))).code).toBe(2)
    expect((await main(args("import", "--judge", "human:carol", "--worksheet", sheet("disputes")))).stderr).toContain(
      "is for adjudication, not for import",
    )
  })
})

describe("a model judge", () => {
  test("is admitted by the eval ledger as a judge attempt charged to the run it judges", async () => {
    const loaded = await loadOutputs({ paths: [outputs] })
    const ledger = Ledger.open({ limits: { totalUsd: 1, caseUsd: 0.01, reserveUsd: 0.1 } })
    const asked: string[] = []
    const fake: Matcher = {
      judge: "model:vendor/judge",
      match: async (task) => {
        asked.push(task.task)
        return {
          answers: task.findings.map((item) => ({ finding: item.id, verdict: { kind: "false-alarm" as const } })),
          usage: { costUsd: 0.001 },
        }
      },
    }
    const result = await judgeRuns({
      runs: loaded.runs,
      cases: loaded.cases,
      seed: "seed",
      matcher: fake,
      admit: ledgerAdmission(ledger, { model: "vendor/judge", price: { input: 1, output: 2 }, maxTokens: 1000 }),
    })
    expect(asked).toHaveLength(2)
    expect(
      result.passes.every((entry) => entry.pass.judge === "model:vendor/judge" && entry.pass.rubric === RUBRIC_VERSION),
    ).toBe(true)
    const admits = ledger.entries.filter((entry) => entry.type === "admit")
    expect(admits.map((entry) => entry.type === "admit" && [entry.kind, entry.case, entry.note]).toSorted()).toEqual(
      loaded.runs.map((run) => ["judge", ledgerCase(run), "judge"]).toSorted(),
    )
    expect(ledger.summary()).toMatchObject({ spentUsd: 0.002, attempts: { admitted: 2, settled: 2 } })
    expect(result.calls.every((call) => call.paid && call.admitted && call.answered)).toBe(true)
  })

  test("is refused when the case bound has no room, and stops when its price cannot bound a call", async () => {
    const loaded = await loadOutputs({ paths: [outputs] })
    const fake: Matcher = { judge: "model:vendor/judge", match: async () => ({ answers: [] }) }
    const tight = Ledger.open({ limits: { totalUsd: 1, caseUsd: 0.000001, reserveUsd: 0.1 } })
    const refused = await judgeRuns({
      runs: loaded.runs,
      cases: loaded.cases,
      seed: "seed",
      matcher: fake,
      admit: ledgerAdmission(tight, { model: "vendor/judge", price: { input: 1, output: 2 }, maxTokens: 1000 }),
    })
    expect(refused.calls.map((call) => [call.admitted, call.sent, call.reason?.split(":")[0]])).toEqual([
      [false, false, "case"],
      [false, false, "case"],
    ])
    const unpriced = Ledger.open({ limits: { totalUsd: 1, caseUsd: 0.5, reserveUsd: 0.1 } })
    await judgeRuns({
      runs: loaded.runs,
      cases: loaded.cases,
      seed: "seed",
      matcher: fake,
      admit: ledgerAdmission(unpriced, {
        model: "vendor/judge",
        price: { input: Number.NaN, output: 2 },
        maxTokens: 1000,
      }),
    })
    expect(unpriced.summary().halted).toContain("cannot bound")
  })

  test("a call that fails after it was sent keeps its reservation as uncertain spend", async () => {
    const loaded = await loadOutputs({ paths: [outputs] })
    const ledger = Ledger.open({ limits: { totalUsd: 1, caseUsd: 0.5, reserveUsd: 0.1 } })
    const broken: Matcher = { judge: "model:vendor/judge", match: async () => Promise.reject(new Error("timeout")) }
    const result = await judgeRuns({
      runs: loaded.runs,
      cases: loaded.cases,
      seed: "seed",
      matcher: broken,
      admit: ledgerAdmission(ledger, { model: "vendor/judge", price: { input: 1, output: 2 }, maxTokens: 1000 }),
    })
    expect(result.passes).toEqual([])
    const summary = ledger.summary()
    expect(summary.spentUsd).toBe(0)
    expect(summary.uncertainUsd).toBeGreaterThan(0)
    expect(summary.attempts).toMatchObject({ admitted: 2, uncertain: 2, open: 0 })
  })

  test("never judges the reviewer's own findings", async () => {
    const loaded = await loadOutputs({ paths: [outputs] })
    const ledger = Ledger.open({ limits: { totalUsd: 1, caseUsd: 0.5, reserveUsd: 0.1 } })
    await expect(
      judgeRuns({
        runs: loaded.runs,
        cases: loaded.cases,
        seed: "seed",
        matcher: { judge: `model:${MODEL}`, match: async () => ({ answers: [] }) },
        admit: ledgerAdmission(ledger, { model: MODEL, price: { input: 1, output: 2 }, maxTokens: 1000 }),
      }),
    ).rejects.toThrow("never judges findings it produced")
    expect(ledger.entries.filter((entry) => entry.type === "admit")).toHaveLength(0)
  })
})

// VS-45: judging under the proposed importance rubric (Q29) in a judgement file of its own.
describe("judge.ts --proposal importance", () => {
  const file = join(root, "importance.json")
  const proposalArgs = (command: string, ...rest: string[]) => [
    command,
    "--outputs",
    outputs,
    "--judgements",
    file,
    "--proposal",
    "importance",
    ...rest,
  ]
  // The cause gets `cause`; the retry finding an extra with `retry` (or none); the rest are false alarms.
  async function rate(path: string, cause: string, retry?: string) {
    const worksheet = (await Bun.file(path).json()) as Worksheet
    for (const task of worksheet.tasks)
      for (const finding of task.findings)
        finding.answer = (
          finding.title.includes("not awaited")
            ? { verdict: { kind: "match", defect: task.defects[0].id }, importance: cause }
            : finding.title.includes("retried")
              ? { verdict: { kind: "extra", issue: "no-retry" }, ...(retry ? { importance: retry } : {}) }
              : { verdict: { kind: "false-alarm" } }
        ) as Worksheet["tasks"][number]["findings"][number]["answer"]
    writeFileSync(path, JSON.stringify(worksheet))
  }

  test("writes worksheets with no severity into a judgement file of the proposal's own, and records importances", async () => {
    const tasks = await main(proposalArgs("tasks", "--judge", "human:alice", "--worksheet", sheet("imp-alice")))
    expect(tasks).toMatchObject({ code: 0, stderr: "" })
    expect(tasks.stdout).toContain("Wrote 2 task(s) with 3 finding(s) for human:alice")
    const created = await readJudgements(file)
    expect(created.proposal).toBe(IMPORTANCE_PROPOSAL)
    const worksheet = (await Bun.file(sheet("imp-alice")).json()) as Worksheet
    expect(worksheet).toMatchObject({ kind: "judge", rubric: RUBRIC_VERSION, proposal: IMPORTANCE_PROPOSAL })
    expect(worksheet.instructions).toContain('Give every match and extra an "importance"')
    expect(worksheet.instructions).toContain("judging-rubric-importance.md")
    for (const task of worksheet.tasks) {
      for (const finding of task.findings) expect(finding).not.toHaveProperty("severity")
      for (const defect of task.defects) expect(defect).not.toHaveProperty("severity")
    }

    // Alice gives the retry extra no importance, so that answer is left out.
    await rate(sheet("imp-alice"), "would-block")
    const imported = await main(proposalArgs("import", "--judge", "human:alice", "--worksheet", sheet("imp-alice")))
    expect(imported.code).toBe(1)
    expect(imported.stdout).toContain("Recorded 2 pass(es) by human:alice")
    expect(imported.stderr).toContain("is a match or an extra without an importance")
    const passes = (await readJudgements(file)).judgements.flatMap((item) => item.passes)
    expect(passes.every((pass) => pass.proposal === IMPORTANCE_PROPOSAL && pass.rubric === RUBRIC_VERSION)).toBe(true)
    expect(passes.find((pass) => pass.verdict.kind === "match")!.importance).toBe("would-block")

    // Bob agrees on every verdict but rates the cause should-fix: an importance dispute, adjudicated with importance.
    await main(proposalArgs("tasks", "--judge", "human:bob", "--worksheet", sheet("imp-bob")))
    await rate(sheet("imp-bob"), "should-fix", "minor")
    expect((await main(proposalArgs("import", "--judge", "human:bob", "--worksheet", sheet("imp-bob")))).code).toBe(0)
    const disputes = await main(proposalArgs("disputes", "--worksheet", sheet("imp-disputes")))
    expect(disputes.stdout).toContain("Wrote 1 disagreement(s) to adjudicate")
    const disputed = (await Bun.file(sheet("imp-disputes")).json()) as Worksheet
    expect(disputed.proposal).toBe(IMPORTANCE_PROPOSAL)
    const item = disputed.tasks[0].findings[0]
    expect(item.title).toBe("Ledger post is not awaited")
    expect(item.verdicts?.map((entry) => entry.importance).toSorted()).toEqual(["should-fix", "would-block"])
    item.answer = { verdict: { kind: "match", defect: disputed.tasks[0].defects[0].id }, importance: "should-fix" }
    writeFileSync(sheet("imp-disputes"), JSON.stringify(disputed))
    const adjudicated = await main(
      proposalArgs("adjudicate", "--worksheet", sheet("imp-disputes"), "--by", "human:owner", "--date", "2026-11-07"),
    )
    expect(adjudicated).toMatchObject({ code: 0, stderr: "" })
    const settledFile = await readJudgements(file)
    expect(settledFile.judgements.find((entry) => entry.adjudication)!.adjudication).toMatchObject({
      by: "human:owner",
      proposal: IMPORTANCE_PROPOSAL,
      importance: "should-fix",
    })

    const scored = await report(["--outputs", outputs, "--judgements", file, "--proposal", "importance"])
    expect(scored.code).toBe(0)
    expect(scored.stdout).toContain(
      "Adjudicated 1, agreed 1, agreed by models only (waiting for a human) 0, disagreed 0, one pass 1, none 0. Importance disagreed",
    )
    expect(scored.stdout).toContain("| Important precision (would-block or should-fix), unvalidated")
  })

  test("never pools the two rubrics' worksheets or files, and takes only a known proposal", async () => {
    const current = join(root, "current-only.json")
    const plain = await main([
      "tasks",
      "--outputs",
      outputs,
      "--judgements",
      current,
      "--judge",
      "human:carol",
      "--worksheet",
      sheet("carol"),
    ])
    expect(plain.code).toBe(0)
    // The current rubric's files and worksheets are as before VS-45: no proposal key, the same instructions.
    expect(Object.keys(await Bun.file(current).json())).toEqual(["schema", "seed", "judgements", "calls"])
    const worksheet = (await Bun.file(sheet("carol")).json()) as Worksheet
    expect(Object.keys(worksheet)).toEqual(["schema", "kind", "rubric", "instructions", "tasks"])
    expect(worksheet.instructions).not.toContain("importance")
    expect(worksheet.tasks[0].findings[0].severity).toBe("blocking")

    // A proposal worksheet read into the current rubric's file is refused, and so is the reverse.
    const crossed = await main([
      "import",
      "--outputs",
      outputs,
      "--judgements",
      current,
      "--judge",
      "human:alice",
      "--worksheet",
      sheet("imp-alice"),
    ])
    expect(crossed.code).toBe(1)
    expect(crossed.stderr).toContain(`was written for rubric 1 with the proposal ${IMPORTANCE_PROPOSAL}, not rubric 1`)
    // With no proposal on either side, a worksheet for another rubric is refused as before VS-45.
    writeFileSync(sheet("carol-2"), JSON.stringify({ ...worksheet, rubric: 2 }))
    const other = await main([
      "import",
      "--outputs",
      outputs,
      "--judgements",
      current,
      "--judge",
      "human:carol",
      "--worksheet",
      sheet("carol-2"),
    ])
    expect(other.code).toBe(1)
    expect(other.stderr).toBe(`${sheet("carol-2")} was written for rubric 2, not 1.\n`)
    const reverse = await main([
      "tasks",
      "--outputs",
      outputs,
      "--judgements",
      current,
      "--judge",
      "human:carol",
      "--worksheet",
      sheet("carol-imp"),
      "--proposal",
      "importance",
    ])
    expect(reverse.code).toBe(1)
    expect(reverse.stderr).toContain("holds judgements under the current rubric 1")
    expect(existsSync(sheet("carol-imp"))).toBe(false)
    // The proposal's file without --proposal is refused too.
    const unasked = await main([
      "tasks",
      "--outputs",
      outputs,
      "--judgements",
      join(root, "importance.json"),
      "--judge",
      "human:carol",
      "--worksheet",
      sheet("x"),
    ])
    expect(unasked.code).toBe(1)
    expect(unasked.stderr).toContain("give --proposal importance")
    const unknown = await main(args("tasks", "--judge", "human:carol", "--worksheet", sheet("y"), "--proposal", "2"))
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain("--proposal takes importance.")
  })
})
