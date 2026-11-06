// Blinded judging for VectorScope's eval (VectorScope plan, VS-04; Phase 0 "Metrics and judging"). A judge, human or
// model, sees one run's findings at a time beside its case's labelled defects and where to read the case's code, and
// nothing that names the pipeline, the model, the repetition, the case id or whether a finding was posted. Each task and
// finding has an opaque id derived from a seed the coordinator keeps, and tasks and findings are ordered by those ids
// alone, so neither the order nor the ids say which model wrote what. Answers are mapped back to run and finding keys
// and become passes for settle() in eval.ts, where two agreeing passes with a human among them, or a human
// adjudication, settle a verdict.
//
// A model judge is a Matcher like any other, so tests use a fake. Its calls are paid attempts: judgeRuns refuses to call
// one without an admission (the eval budget ledger), and refuses a judge model that reviewed any run being judged under
// any spelling of its id (sameModel), because a blinded judge cannot tell which findings are its own.

import {
  RUBRIC_VERSION,
  runKey,
  sameModel,
  settle,
  type Adjudication,
  type CodeReference,
  type EvalCase,
  type EvalFinding,
  type EvalRun,
  type JudgePass,
  type Judgement,
  type LabelledDefect,
  type Suggestion,
  type Verdict,
} from "./eval"
import { fnv1a64 } from "./fingerprint"

export interface TaskFinding {
  id: string // opaque
  path: string
  line: number
  endLine?: number
  severity: string
  category: string
  title: string
  body: string
  suggestion?: string
}

// What a judge sees of a labelled defect: what a verdict is given against. Annotators' failureClass is left out: no
// verdict rule reads it, and a class shown beside the cause could sway a match.
export type TaskDefect = Pick<
  LabelledDefect,
  "id" | "category" | "severity" | "summary" | "cause" | "locations" | "alternatives"
>

export interface JudgeTask {
  task: string // opaque
  defects: TaskDefect[] // the case's labels; empty for a control
  code?: CodeReference // where to read the change, to tell a real extra defect from a false alarm
  findings: TaskFinding[]
}

export interface JudgeAnswer {
  finding: string // a TaskFinding id
  verdict: Verdict
  suggestion?: Suggestion
  note?: string
}

export interface Matcher {
  judge: string // "human:<name>" or "model:<provider/model>"
  match(task: JudgeTask): Promise<{ answers: JudgeAnswer[]; usage?: { costUsd?: number } }>
}

// A paid judge call's admission by the eval ledger, charged to the run it judges and estimated from its blinded task.
export type JudgeAdmission =
  | { admitted: false; reason: string }
  | { admitted: true; sent(): void; settle(usage?: { costUsd?: number }): void; release(): void }

export interface JudgeCall {
  run: string
  judge: string
  paid: boolean // a model judge, which needs an admission
  admitted: boolean
  sent: boolean
  answered: boolean
  costUsd?: number // as the matcher reported it; the ledger holds the settled amount
  reason?: string // why it was not admitted or not answered
}

export interface RecordedPass {
  run: string
  finding: string
  pass: JudgePass
}

// One task per reviewed run with findings to judge (nits only with `nits`, and only findings `only` keeps), and the key
// that maps each opaque id back. The key stays with the coordinator; only the tasks go to a judge.
export function blind(input: {
  runs: readonly EvalRun[]
  cases: readonly EvalCase[]
  seed: string
  nits?: boolean
  only?: (run: string, finding: string) => boolean
}) {
  const cases = new Map(input.cases.map((item) => [item.id, item]))
  const entries = input.runs
    .flatMap((run) => {
      const evalCase = cases.get(run.case)
      if (!evalCase || (run.status !== "completed" && run.status !== "partial")) return []
      const key = runKey(run)
      // The proposed text wins over the posted one, whose body selection may have added to.
      const findings = [...new Map([...run.posted, ...run.proposed].map((finding) => [finding.key, finding])).values()]
        .filter((finding) => input.nits || finding.severity !== "nit")
        .filter((finding) => !input.only || input.only(key, finding.key))
        .map((finding) => ({ id: fnv1a64(`${input.seed}\nfinding\n${key}\n${finding.key}`).slice(0, 12), finding }))
        .toSorted((a, b) => compare(a.id, b.id))
      if (!findings.length) return []
      return [
        {
          task: {
            task: fnv1a64(`${input.seed}\ntask\n${key}`),
            defects: evalCase.defects.map(shownDefect),
            ...(evalCase.code ? { code: evalCase.code } : {}),
            findings: findings.map((entry) => shown(entry.id, entry.finding)),
          } satisfies JudgeTask,
          run,
          findings: new Map(findings.map((entry) => [entry.id, entry.finding.key])),
        },
      ]
    })
    .toSorted((a, b) => compare(a.task.task, b.task.task))
  return {
    tasks: entries.map((entry) => entry.task),
    keys: new Map(entries.map((entry) => [entry.task.task, { run: entry.run, findings: entry.findings }])),
  }
}

// Asks one judge about every blinded task, in task order, and returns its answers as passes. A model judge's calls are
// each admitted first and settled at what it reports; a call that fails after it was sent is released, which the
// ledger keeps as uncertain spend. Answers that name no finding of the task, or a defect the case does not label, are
// reported as problems and dropped.
export async function judgeRuns(input: {
  runs: readonly EvalRun[]
  cases: readonly EvalCase[]
  seed: string
  matcher: Matcher
  rubric?: number
  nits?: boolean
  only?: (run: string, finding: string) => boolean
  admit?: (run: EvalRun, task: JudgeTask) => JudgeAdmission
}) {
  const judge = input.matcher.judge
  const model = judge.startsWith("model:") ? judge.slice("model:".length) : undefined
  if (!/^(human|model):\S/.test(judge)) throw new Error(`${judge} is not a human: or model: judge`)
  if (model && input.runs.some((run) => (run.models ?? [run.model]).some((id) => sameModel(id, model))))
    throw new Error(`${judge} reviewed runs being judged, and a model never judges findings it produced`)
  if (model && !input.admit) throw new Error(`${judge} makes paid calls, so each needs the eval ledger's admission`)
  const blinded = blind(input)
  const rubric = input.rubric ?? RUBRIC_VERSION
  const passes: RecordedPass[] = []
  const calls: JudgeCall[] = []
  const problems: string[] = []
  for (const task of blinded.tasks) {
    const key = blinded.keys.get(task.task)!
    const run = runKey(key.run)
    const admission = model ? input.admit!(key.run, task) : undefined
    if (admission && !admission.admitted) {
      calls.push({ run, judge, paid: true, admitted: false, sent: false, answered: false, reason: admission.reason })
      continue
    }
    if (admission) admission.sent()
    const reply = await input.matcher
      .match(task)
      .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
    if (reply instanceof Error) {
      if (admission) admission.release()
      calls.push({
        run,
        judge,
        paid: !!model,
        admitted: !!admission,
        sent: true,
        answered: false,
        reason: reply.message,
      })
      problems.push(`${judge} failed on task ${task.task}: ${reply.message}`)
      continue
    }
    if (admission) admission.settle(reply.usage)
    calls.push({
      run,
      judge,
      paid: !!model,
      admitted: !!admission,
      sent: true,
      answered: true,
      ...(reply.usage?.costUsd !== undefined ? { costUsd: reply.usage.costUsd } : {}),
    })
    const seen = new Set<string>()
    for (const answer of Array.isArray(reply.answers) ? reply.answers : []) {
      const finding = typeof answer?.finding === "string" ? key.findings.get(answer.finding) : undefined
      const problem = !finding
        ? `${judge} answered ${String(answer?.finding)}, which task ${task.task} does not have`
        : seen.has(answer.finding)
          ? `${judge} answered ${answer.finding} of task ${task.task} twice; the first answer stands`
          : answerProblem(answer, task)
      if (problem) {
        problems.push(problem)
        continue
      }
      seen.add(answer.finding)
      passes.push({
        run,
        finding: finding!,
        pass: {
          judge,
          rubric,
          verdict: answer.verdict,
          ...(answer.suggestion ? { suggestion: answer.suggestion } : {}),
          ...(typeof answer.note === "string" && answer.note.trim() ? { note: answer.note.trim() } : {}),
        },
      })
    }
  }
  return { passes, calls, problems }
}

// Adds passes to judgements: a judge's new pass on a finding replaces its earlier one in place.
export function recordPasses(judgements: readonly Judgement[], passes: readonly RecordedPass[]): Judgement[] {
  return passes.reduce(
    (all, entry) => {
      const index = all.findIndex((item) => item.run === entry.run && item.finding === entry.finding)
      if (index < 0) return [...all, { run: entry.run, finding: entry.finding, passes: [entry.pass] }]
      const item = all[index]
      const updated = {
        ...item,
        passes: item.passes.some((pass) => pass.judge === entry.pass.judge)
          ? item.passes.map((pass) => (pass.judge === entry.pass.judge ? entry.pass : pass))
          : [...item.passes, entry.pass],
      }
      return all.map((existing, at) => (at === index ? updated : existing))
    },
    [...judgements],
  )
}

// Records an adjudication on each finding, replacing an earlier one.
export function recordAdjudications(
  judgements: readonly Judgement[],
  adjudications: readonly { run: string; finding: string; adjudication: Adjudication }[],
): Judgement[] {
  return adjudications.reduce(
    (all, entry) => {
      const index = all.findIndex((item) => item.run === entry.run && item.finding === entry.finding)
      if (index < 0)
        return [...all, { run: entry.run, finding: entry.finding, passes: [], adjudication: entry.adjudication }]
      return all.map((existing, at) => (at === index ? { ...existing, adjudication: entry.adjudication } : existing))
    },
    [...judgements],
  )
}

// The disagreements a human must adjudicate, blinded like any task. Each finding lists the verdicts given, without the
// judges' names, in an order that depends only on the seed.
export function disputeTasks(input: {
  runs: readonly EvalRun[]
  cases: readonly EvalCase[]
  judgements: readonly Judgement[]
  seed: string
  rubric?: number
  nits?: boolean
}) {
  const index = new Map(input.judgements.map((item) => [`${item.run}\n${item.finding}`, item]))
  const models = new Map(input.runs.map((run) => [runKey(run), run.models ?? [run.model]]))
  const disputed = (run: string, finding: string) => {
    const item = index.get(`${run}\n${finding}`)
    return !!item && settle(item, { reviewed: models.get(run) ?? [], rubric: input.rubric }).status === "disagreed"
  }
  const blinded = blind({ ...input, only: disputed })
  return {
    tasks: blinded.tasks.map((task) => {
      const key = blinded.keys.get(task.task)!
      const run = runKey(key.run)
      return {
        ...task,
        findings: task.findings.map((finding) => {
          const item = index.get(`${run}\n${key.findings.get(finding.id)}`)!
          const verdicts = item.passes
            .filter((pass) => pass.rubric === (input.rubric ?? RUBRIC_VERSION))
            .map((pass) => ({ order: fnv1a64(`${input.seed}\nverdict\n${finding.id}\n${pass.judge}`), pass }))
            .toSorted((a, b) => compare(a.order, b.order))
            .map((entry) => ({
              verdict: entry.pass.verdict,
              ...(entry.pass.suggestion ? { suggestion: entry.pass.suggestion } : {}),
              ...(entry.pass.note ? { note: entry.pass.note } : {}),
            }))
          return { ...finding, verdicts }
        }),
      }
    }),
    keys: blinded.keys,
    disputed,
  }
}

// Whether each judgement of these runs is settled, and how: the judging status a report shows.
export function judgingStatus(input: {
  runs: readonly EvalRun[]
  judgements: readonly Judgement[]
  rubric?: number
  nits?: boolean
}) {
  const index = new Map(input.judgements.map((item) => [`${item.run}\n${item.finding}`, item]))
  const outcomes = input.runs
    .filter((run) => run.status === "completed" || run.status === "partial")
    .flatMap((run) => {
      const key = runKey(run)
      const keys = [
        ...new Set(
          [...run.proposed, ...run.posted].filter((f) => input.nits || f.severity !== "nit").map((f) => f.key),
        ),
      ]
      return keys.map((finding) => {
        const item = index.get(`${key}\n${finding}`)
        return item
          ? settle(item, { reviewed: run.models ?? [run.model], rubric: input.rubric })
          : { status: "none" as const, problems: [] }
      })
    })
  return {
    findings: outcomes.length,
    adjudicated: outcomes.filter((outcome) => outcome.status === "adjudicated").length,
    agreed: outcomes.filter((outcome) => outcome.status === "agreed").length,
    // Judges agreed with no human among them, so the verdict does not count until a human judges or adjudicates it.
    needsHuman: outcomes.filter((outcome) => outcome.status === "needs-human").length,
    disagreed: outcomes.filter((outcome) => outcome.status === "disagreed").length,
    single: outcomes.filter((outcome) => outcome.status === "single").length,
    none: outcomes.filter((outcome) => outcome.status === "none").length,
    problems: [...new Set(outcomes.flatMap((outcome) => outcome.problems))],
  }
}

function shown(id: string, finding: EvalFinding): TaskFinding {
  return {
    id,
    path: finding.path,
    line: finding.line,
    ...(finding.endLine !== undefined ? { endLine: finding.endLine } : {}),
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    body: finding.body,
    ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
  }
}

function shownDefect(defect: LabelledDefect): TaskDefect {
  return {
    id: defect.id,
    category: defect.category,
    severity: defect.severity,
    summary: defect.summary,
    cause: defect.cause,
    locations: defect.locations,
    alternatives: defect.alternatives,
  }
}

function answerProblem(answer: JudgeAnswer, task: JudgeTask) {
  const verdict = answer.verdict
  const kind = verdict?.kind
  if (kind === "match" && !task.defects.some((defect) => defect.id === verdict.defect))
    return `the answer for ${answer.finding} matches ${String(verdict.defect)}, which task ${task.task} does not label`
  if (kind === "extra" && !(typeof verdict.issue === "string" && verdict.issue.trim()))
    return `the answer for ${answer.finding} is an extra defect with no issue name`
  if (kind !== "match" && kind !== "extra" && kind !== "false-alarm")
    return `the answer for ${answer.finding} is not a match, an extra or a false-alarm`
  if (answer.suggestion !== undefined && answer.suggestion !== "valid" && answer.suggestion !== "invalid")
    return `the answer for ${answer.finding} rates its suggestion ${String(answer.suggestion)}, not valid or invalid`
  return undefined
}

function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}
