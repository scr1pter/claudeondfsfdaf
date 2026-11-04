import { describe, expect, test } from "bun:test"
import {
  findingKey,
  RUBRIC_VERSION,
  runKey,
  scoreRun,
  settle,
  type EvalCase,
  type EvalFinding,
  type EvalRun,
} from "@vectordevai/core/review/eval"
import {
  blind,
  disputeTasks,
  judgeRuns,
  judgingStatus,
  recordAdjudications,
  recordPasses,
  type JudgeAdmission,
  type JudgeAnswer,
  type JudgeTask,
  type Matcher,
} from "@vectordevai/core/review/eval-judge"

// Blinded judging with fake judges: no model is called. A fake matcher answers from what a task shows it, which is all
// a real judge would see.

const CASE: EvalCase = {
  id: "acme-ledger-1",
  kind: "bug",
  language: "typescript",
  defects: [
    {
      id: "missing-await",
      category: "concurrency",
      severity: "blocking",
      summary: "The ledger post is not awaited.",
      cause: "postLedger's promise is never awaited, so its rejection escapes the try/catch.",
      locations: [{ path: "src/billing/sync.ts", line: 40 }],
      alternatives: [],
    },
  ],
}

function finding(title: string, overrides: Partial<Omit<EvalFinding, "key" | "title">> = {}): EvalFinding {
  const base = {
    path: "src/billing/sync.ts",
    line: 40,
    severity: "blocking",
    category: "bug",
    title,
    body: `${title}.`,
    ...overrides,
  }
  return { key: findingKey(base), ...base }
}

const CAUSE = finding("Ledger post is not awaited")
const STYLE = finding("Magic number", { line: 44, severity: "concern" })
const NIT = finding("Prefer const", { line: 45, severity: "nit" })

function run(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    variant: "engine",
    model: "vendor/reviewer-large",
    case: CASE.id,
    repetition: 1,
    trust: "untrusted",
    status: "completed",
    proposed: [CAUSE, STYLE, NIT],
    posted: [{ ...CAUSE, anchored: true, body: "Ledger post is not awaited. The same problem is also at line 41." }],
    spend: { costUsd: 0.01, uncertainUsd: 0, usageMissing: false, admitted: true },
    violations: [],
    ...overrides,
  }
}

const RUNS = [
  run(),
  run({
    model: "vendor/reviewer-small",
    models: ["vendor/reviewer-small", "vendor/triage"],
    proposed: [STYLE],
    posted: [],
  }),
  run({ repetition: 2, status: "failed", proposed: [], posted: [] }),
]

// Answers by reading the task: the finding whose title names the cause matches, everything else is a false alarm.
function reader(judge: string, calls: JudgeTask[] = []): Matcher {
  return {
    judge,
    match: async (task) => {
      calls.push(task)
      return {
        answers: task.findings.map(
          (item): JudgeAnswer =>
            item.title.includes("not awaited")
              ? { finding: item.id, verdict: { kind: "match", defect: task.defects[0].id }, note: " awaits nothing " }
              : { finding: item.id, verdict: { kind: "false-alarm" } },
        ),
        usage: { costUsd: 0.002 },
      }
    },
  }
}

describe("blind", () => {
  test("a task shows the labels and the findings, and nothing that names the run", () => {
    const blinded = blind({ runs: RUNS, cases: [CASE], seed: "seed-1" })
    expect(blinded.tasks).toHaveLength(2)
    const text = JSON.stringify(blinded.tasks)
    for (const hidden of [
      "vendor/reviewer",
      "vendor/triage",
      "engine",
      CASE.id,
      "anchored",
      "posted",
      "proposed",
      CAUSE.key,
    ])
      expect(text).not.toContain(hidden)
    for (const task of blinded.tasks) {
      expect(Object.keys(task).toSorted()).toEqual(["defects", "findings", "task"])
      expect(task.defects).toEqual(CASE.defects)
      for (const item of task.findings) expect(item.id).toMatch(/^[0-9a-f]{12}$/)
    }
    // The model's own text is shown, not the body selection added to.
    const large = blinded.tasks.find((task) => task.findings.length === 2)!
    expect(large.findings.find((item) => item.title === CAUSE.title)!.body).toBe(CAUSE.body)
  })

  test("a task says where to read the case's code, and that names nothing about the run", () => {
    const code = {
      repository: "https://github.com/acme/ledger",
      base: "a".repeat(40),
      head: "b".repeat(40),
    }
    const blinded = blind({ runs: RUNS, cases: [{ ...CASE, code }], seed: "seed-1" })
    expect(blinded.tasks).toHaveLength(2)
    for (const task of blinded.tasks) {
      expect(Object.keys(task).toSorted()).toEqual(["code", "defects", "findings", "task"])
      expect(task.code).toEqual(code)
    }
    const text = JSON.stringify(blinded.tasks)
    for (const hidden of ["vendor/reviewer", "vendor/triage", "engine", CASE.id, "posted", "proposed", "#1", "#2"])
      expect(text).not.toContain(hidden)
    // A synthetic fixture is read from its files in this repository.
    const fixture = { patch: "diff --git a/src/billing/sync.ts b/src/billing/sync.ts\n" }
    expect(blind({ runs: RUNS, cases: [{ ...CASE, code: fixture }], seed: "seed-1" }).tasks[0].code).toEqual(fixture)
  })

  test("leaves out failed runs and nits, unless nits are asked for", () => {
    const blinded = blind({ runs: RUNS, cases: [CASE], seed: "seed-1" })
    expect(
      blinded.tasks
        .flatMap((task) => task.findings)
        .map((item) => item.title)
        .toSorted(),
    ).toEqual([CAUSE.title, STYLE.title, STYLE.title])
    const withNits = blind({ runs: RUNS, cases: [CASE], seed: "seed-1", nits: true })
    expect(withNits.tasks.flatMap((task) => task.findings).some((item) => item.title === NIT.title)).toBe(true)
  })

  test("ids and order depend on the seed alone, not on the order of the runs", () => {
    const one = blind({ runs: RUNS, cases: [CASE], seed: "seed-1" })
    const again = blind({ runs: RUNS.toReversed(), cases: [CASE], seed: "seed-1" })
    expect(again.tasks).toEqual(one.tasks)
    const other = blind({ runs: RUNS, cases: [CASE], seed: "seed-2" })
    expect(other.tasks.map((task) => task.task)).not.toEqual(one.tasks.map((task) => task.task))
    // The same finding in two runs has unrelated ids.
    const ids = one.tasks.flatMap((task) =>
      task.findings.filter((item) => item.title === STYLE.title).map((item) => item.id),
    )
    expect(new Set(ids).size).toBe(2)
    // The key maps each opaque id back.
    const key = one.keys.get(one.tasks[0].task)!
    expect(RUNS.map(runKey)).toContain(runKey(key.run))
    expect([...key.findings.values()].every((value) => [CAUSE.key, STYLE.key].includes(value))).toBe(true)
  })
})

describe("judgeRuns", () => {
  test("maps a judge's answers back to run and finding keys as passes", async () => {
    const seen: JudgeTask[] = []
    const result = await judgeRuns({
      runs: RUNS,
      cases: [CASE],
      seed: "seed-1",
      matcher: reader("human:annotator", seen),
    })
    expect(seen).toHaveLength(2)
    expect(result.problems).toEqual([])
    expect(result.calls.every((call) => call.answered && !call.paid)).toBe(true)
    const large = runKey(RUNS[0])
    expect(result.passes.filter((entry) => entry.run === large)).toEqual([
      {
        run: large,
        finding: expect.any(String),
        pass: expect.objectContaining({ judge: "human:annotator", rubric: RUBRIC_VERSION }),
      },
      expect.anything(),
    ])
    expect(result.passes.find((entry) => entry.run === large && entry.finding === CAUSE.key)!.pass).toEqual({
      judge: "human:annotator",
      rubric: RUBRIC_VERSION,
      verdict: { kind: "match", defect: "missing-await" },
      note: "awaits nothing",
    })
  })

  test("drops answers that name no finding of the task, a defect it does not label, or a finding twice", async () => {
    const sloppy: Matcher = {
      judge: "human:annotator",
      match: async (task) => ({
        answers: [
          { finding: "000000000000", verdict: { kind: "false-alarm" } },
          { finding: task.findings[0].id, verdict: { kind: "match", defect: "invented" } },
          { finding: task.findings[0].id, verdict: { kind: "false-alarm" } },
          { finding: task.findings[0].id, verdict: { kind: "false-alarm" } },
          { finding: task.findings.at(-1)!.id, verdict: { kind: "extra", issue: "" } },
        ],
      }),
    }
    const result = await judgeRuns({ runs: [RUNS[0]], cases: [CASE], seed: "seed-1", matcher: sloppy })
    expect(result.passes).toHaveLength(1)
    expect(result.problems).toHaveLength(4)
  })

  test("a model judge is refused without the ledger's admission, or when it reviewed a run", async () => {
    await expect(
      judgeRuns({ runs: RUNS, cases: [CASE], seed: "s", matcher: reader("model:judge/one") }),
    ).rejects.toThrow("admission")
    for (const model of ["vendor/reviewer-large", "vendor/triage"])
      await expect(
        judgeRuns({ runs: RUNS, cases: [CASE], seed: "s", matcher: reader(`model:${model}`), admit: () => open([]) }),
      ).rejects.toThrow("never judges findings it produced")
    await expect(judgeRuns({ runs: RUNS, cases: [CASE], seed: "s", matcher: reader("annotator") })).rejects.toThrow(
      "not a human: or model: judge",
    )
  })

  test("a model judge is recognised as a reviewer under another provider prefix or route suffix", async () => {
    // A replay records <provider>/<model>; a judge named by the router's own id is the same model.
    const replayed = [run({ model: "openrouter/vendor/reviewer-large", models: ["openrouter/vendor/reviewer-large"] })]
    for (const judge of ["model:vendor/reviewer-large", "model:vendor/reviewer-large:free", "model:reviewer-large"])
      await expect(
        judgeRuns({ runs: replayed, cases: [CASE], seed: "s", matcher: reader(judge), admit: () => open([]) }),
      ).rejects.toThrow("never judges findings it produced")
    // And the other way round: a run.ts report records the router's id, the judge the engine's.
    await expect(
      judgeRuns({
        runs: [run()],
        cases: [CASE],
        seed: "s",
        matcher: reader("model:openrouter/vendor/reviewer-large"),
        admit: () => open([]),
      }),
    ).rejects.toThrow("never judges findings it produced")
    const other = await judgeRuns({
      runs: replayed,
      cases: [CASE],
      seed: "s",
      matcher: reader("model:vendor/judge"),
      admit: () => open([]),
    })
    expect(other.passes.length).toBeGreaterThan(0)
  })

  test("each model call is admitted for the run it judges, sent, then settled at what it reported", async () => {
    const events: string[] = []
    const asked: JudgeTask[] = []
    const result = await judgeRuns({
      runs: RUNS,
      cases: [CASE],
      seed: "seed-1",
      matcher: reader("model:judge/one", asked),
      admit: (judged) => {
        events.push(`admit ${runKey(judged)}`)
        return judged.model === "vendor/reviewer-small" ? { admitted: false, reason: "case" } : open(events)
      },
    })
    expect(asked).toHaveLength(1)
    expect(events).toEqual(
      expect.arrayContaining([`admit ${runKey(RUNS[0])}`, `admit ${runKey(RUNS[1])}`, "sent", "settle 0.002"]),
    )
    expect(events.indexOf("sent")).toBeLessThan(events.indexOf("settle 0.002"))
    expect(result.calls.toSorted((a, b) => (a.run < b.run ? -1 : 1))).toEqual([
      {
        run: runKey(RUNS[0]),
        judge: "model:judge/one",
        paid: true,
        admitted: true,
        sent: true,
        answered: true,
        costUsd: 0.002,
      },
      {
        run: runKey(RUNS[1]),
        judge: "model:judge/one",
        paid: true,
        admitted: false,
        sent: false,
        answered: false,
        reason: "case",
      },
    ])
  })

  test("a call that fails after it was sent is released, so the ledger keeps it as uncertain", async () => {
    const events: string[] = []
    const broken: Matcher = { judge: "model:judge/one", match: async () => Promise.reject(new Error("upstream 502")) }
    const result = await judgeRuns({
      runs: [RUNS[0]],
      cases: [CASE],
      seed: "s",
      matcher: broken,
      admit: () => open(events),
    })
    expect(events).toEqual(["sent", "release"])
    expect(result.passes).toEqual([])
    expect(result.calls[0]).toMatchObject({ admitted: true, sent: true, answered: false, reason: "upstream 502" })
    expect(result.problems[0]).toContain("upstream 502")
  })
})

describe("recording, disputes and status", () => {
  test("two agreeing judges settle, a disagreement is disputed blind, and an adjudication settles it", async () => {
    const human = await judgeRuns({ runs: RUNS, cases: [CASE], seed: "seed-1", matcher: reader("human:annotator") })
    const contrary: Matcher = {
      judge: "model:judge/one",
      match: async (task) => ({
        answers: task.findings.map((item) => ({
          finding: item.id,
          verdict:
            item.title === STYLE.title ? { kind: "extra" as const, issue: "E1" } : { kind: "false-alarm" as const },
        })),
      }),
    }
    const model = await judgeRuns({
      runs: RUNS,
      cases: [CASE],
      seed: "seed-1",
      matcher: contrary,
      admit: () => open([]),
    })
    const judgements = recordPasses(recordPasses([], human.passes), model.passes)
    expect(judgements).toHaveLength(3)
    // A new pass by the same judge replaces its earlier one.
    expect(recordPasses(judgements, human.passes)).toEqual(judgements)

    const status = judgingStatus({ runs: RUNS, judgements })
    expect(status).toMatchObject({ findings: 3, agreed: 0, needsHuman: 0, disagreed: 3, single: 0, none: 0 })

    const disputes = disputeTasks({ runs: RUNS, cases: [CASE], judgements, seed: "seed-1" })
    expect(disputes.tasks.flatMap((task) => task.findings)).toHaveLength(3)
    const text = JSON.stringify(disputes.tasks)
    expect(text).not.toContain("human:annotator")
    expect(text).not.toContain("judge/one")
    expect(text).not.toContain("vendor/")
    for (const item of disputes.tasks.flatMap((task) => task.findings)) expect(item.verdicts).toHaveLength(2)

    const large = runKey(RUNS[0])
    const adjudicated = recordAdjudications(judgements, [
      {
        run: large,
        finding: CAUSE.key,
        adjudication: {
          by: "human:owner",
          date: "2026-11-03",
          rubric: RUBRIC_VERSION,
          verdict: { kind: "match", defect: "missing-await" },
        },
      },
    ])
    const item = adjudicated.find((entry) => entry.run === large && entry.finding === CAUSE.key)!
    expect(settle(item, { reviewed: [RUNS[0].model] })).toMatchObject({ status: "adjudicated" })
    expect(judgingStatus({ runs: RUNS, judgements: adjudicated })).toMatchObject({ adjudicated: 1, disagreed: 2 })
    expect(
      scoreRun({
        evalCase: CASE,
        planned: RUNS[0],
        run: RUNS[0],
        verdict: (shown) => {
          const entry = adjudicated.find((candidate) => candidate.run === large && candidate.finding === shown.key)
          return entry ? settle(entry, { reviewed: [RUNS[0].model] }) : undefined
        },
        stage: "posted",
      }),
    ).toMatchObject({ matched: 1, detected: ["missing-await"] })
  })
})

function open(events: string[]): JudgeAdmission {
  return {
    admitted: true,
    sent: () => void events.push("sent"),
    settle: (usage) => void events.push(`settle ${usage?.costUsd}`),
    release: () => void events.push("release"),
  }
}
