#!/usr/bin/env bun
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import {
  IMPORTANCE,
  IMPORTANCE_PROPOSAL,
  RUBRIC_VERSION,
  rubricName,
  staleAgainst,
  type EvalRun,
  type Importance,
  type Verdict,
} from "../../packages/core/src/review/eval"
import {
  blind,
  disputeTasks,
  judgeRuns,
  recordAdjudications,
  recordPasses,
  type JudgeAdmission,
  type JudgeAnswer,
  type JudgeTask,
  type Matcher,
  type TaskFinding,
} from "../../packages/core/src/review/eval-judge"
import { estimateUsd, type Ledger, type Price } from "./budget"
import { outsideRepository, REPO_ROOT } from "./paths"
import { replayCaseKey } from "./replay"
import {
  JUDGEMENTS_SCHEMA,
  loadOutputs,
  proposalMismatch,
  proposalOption,
  readJudgements,
  type JudgementFile,
} from "./report"

// Blinded judging of saved eval outputs (VectorScope plan, VS-04). A coordinator keeps the judgement file, which holds
// the seed that blinds every worksheet and maps answers back to runs. A judge gets only a worksheet: one task per run,
// with the case's labelled defects and the run's findings under opaque ids, and nothing naming the pipeline, the model
// or whether a finding was posted. judging-rubric.md says how to answer.
//
// This script sends nothing. Worksheets are filled by people. A model judge runs through judgeRuns in
// packages/core/src/review/eval-judge.ts with ledgerAdmission below, so each of its calls is admitted by the eval budget
// ledger (VS-03) and charged to the run it judges; no paid judge is wired to a provider here (D5, D12).
//
// With --proposal importance it judges under VS-45's proposed importance rubric (judging-rubric-importance.md, owner
// question Q29) instead: each match and extra also gets an importance, no severity is shown, and the passes go into a
// judgement file of that proposal's own, never pooled with the current rubric's.

export const WORKSHEET_SCHEMA = "vectorscope-worksheet/1"

export interface WorksheetFinding extends TaskFinding {
  // A disputes worksheet's passes.
  verdicts?: { verdict: Verdict; importance?: Importance; suggestion?: "valid" | "invalid"; note?: string }[]
  answer: Omit<JudgeAnswer, "finding"> | null
}

export interface Worksheet {
  schema: typeof WORKSHEET_SCHEMA
  kind: "judge" | "adjudicate"
  rubric: number
  proposal?: string // the proposed rubric it was written for (--proposal); absent for the current rubric
  instructions: string
  tasks: (Omit<JudgeTask, "findings"> & { findings: WorksheetFinding[] })[]
}

const INSTRUCTIONS = [
  "Judge each finding against the labelled defects, following script/vectorscope-eval/judging-rubric.md.",
  'Set answer to {"verdict": {"kind": "match", "defect": "<defect id>"}} when the finding identifies that defect\'s cause, wherever it points;',
  '{"verdict": {"kind": "extra", "issue": "<short name>"}} when it is a real defect the labels lack (give findings of one task about the same defect the same name);',
  'or {"verdict": {"kind": "false-alarm"}} otherwise, including a different complaint at a labelled line.',
  'Add "suggestion": "valid" or "invalid" when the finding suggests a change, and an optional "note". Leave answer null to skip a finding.',
].join(" ")

// The worksheet's instructions: the current rubric's, and under the importance proposal its importance rule.
function instructions(proposal: string | undefined) {
  if (proposal !== IMPORTANCE_PROPOSAL) return INSTRUCTIONS
  return [
    INSTRUCTIONS,
    `This worksheet is for the proposed importance rubric (script/vectorscope-eval/judging-rubric-importance.md), not the current one.`,
    `Give every match and extra an "importance" of ${IMPORTANCE.map((value) => `"${value}"`).join(", ")}, judged from the code; a false alarm has none.`,
    "Neither the finding's severity nor the label's is shown, on purpose.",
  ].join(" ")
}

// The eval ledger's admission for a model judge's calls: a "judge" attempt charged to the run it judges, estimated from
// the blinded task at the judge's price and output limit, as run.ts estimates a request.
export function ledgerAdmission(
  ledger: Ledger,
  input: { model: string; price: Price; maxTokens: number; overheadChars?: number },
) {
  return (run: EvalRun, task: JudgeTask): JudgeAdmission => {
    const admission = ledger.admit({
      case: ledgerCase(run),
      kind: "judge",
      model: input.model,
      note: "judge",
      estimateUsd: estimateUsd({
        chars: JSON.stringify(task).length + (input.overheadChars ?? 0),
        maxTokens: input.maxTokens,
        price: input.price,
      }),
    })
    if (!admission.admitted) return { admitted: false, reason: `${admission.reason}: ${admission.detail}` }
    const ticket = admission.ticket
    return {
      admitted: true,
      sent: () => ticket.sent(),
      settle: (usage) =>
        void ticket.settle(usage?.costUsd === undefined ? {} : { costUsd: usage.costUsd, basis: "reported" }),
      release: () => void ticket.release(),
    }
  }
}

// The case a run is charged to in the eval ledger, named as run.ts and admitReplay name it: a replay's variant is part
// of its case, so judging one variant's replay never takes from another variant's bound.
export function ledgerCase(run: EvalRun) {
  return run.variant === "single-prompt"
    ? `${run.model} ${run.case}#${run.repetition}`
    : replayCaseKey({
        variant: run.variant,
        models: run.models ?? [run.model],
        id: run.case,
        repetition: run.repetition,
      })
}

// A filled worksheet as a judge: its answers, by task.
export function worksheetMatcher(judge: string, sheet: Worksheet): Matcher {
  const tasks = new Map(sheet.tasks.map((task) => [task.task, task]))
  return {
    judge,
    match: async (task) => ({
      answers: (tasks.get(task.task)?.findings ?? []).flatMap((finding) =>
        finding.answer ? [{ ...finding.answer, finding: finding.id }] : [],
      ),
    }),
  }
}

const USAGE = `Usage: bun script/vectorscope-eval/judge.ts <command> [options]

Blinded judging of saved eval outputs. Sends nothing.

Commands:
  tasks        Write a blinded worksheet of the findings a judge has not judged yet
  import       Read a judge's filled worksheet into the judgement file as that judge's passes
  disputes     Write a blinded worksheet of the disagreements, for a human to adjudicate
  adjudicate   Read a filled disputes worksheet into the judgement file as adjudications

Options:
  --outputs <path>      A run.ts --out report or a replay artifact, or a directory of them (repeatable)
  --manifest <path>     Dataset manifest for replay artifacts (default: the seed manifest)
  --split <name>        Split the replay artifacts come from (default development)
  --judgements <path>   Judgement file, outside the repository; tasks creates it with a new seed
  --worksheet <path>    Worksheet to write (tasks, disputes) or read (import, adjudicate), outside the repository
  --judge <id>          human:<name>, the judge filling the worksheet (tasks, import)
  --by <id>             human:<name>, who adjudicated (adjudicate)
  --date <YYYY-MM-DD>   When they adjudicated (adjudicate)
  --proposal importance Judge under the proposed importance rubric (judging-rubric-importance.md, VS-45, pending
                        Q29) instead of the current one: every match and extra also gets an importance, and no
                        severity is shown. It needs a judgement file of its own; the default is the current rubric
  --nits                Judge nit findings too
  --help                Print this message
`

const OPTIONS = {
  outputs: { type: "string", multiple: true },
  manifest: { type: "string" },
  split: { type: "string" },
  judgements: { type: "string" },
  worksheet: { type: "string" },
  judge: { type: "string" },
  by: { type: "string" },
  date: { type: "string" },
  proposal: { type: "string" },
  nits: { type: "boolean" },
  help: { type: "boolean" },
} as const

const COMMANDS = ["tasks", "import", "disputes", "adjudicate"] as const

export async function main(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const parsed = parseArgs({ args: argv, options: OPTIONS, strict: false, allowPositionals: true })
  const values = parsed.values
  if (values.help) return { code: 0, stdout: USAGE, stderr: "" }
  const text = (name: Exclude<keyof typeof OPTIONS, "outputs" | "nits" | "help">) =>
    typeof values[name] === "string" ? values[name] : undefined
  const command = parsed.positionals[0] as (typeof COMMANDS)[number] | undefined
  const outputs = (Array.isArray(values.outputs) ? values.outputs : []).filter((value) => typeof value === "string")
  const unknown = Object.keys(values).filter((name) => !Object.hasOwn(OPTIONS, name))
  if (unknown.length || parsed.positionals.length !== 1 || !command || !COMMANDS.includes(command))
    return usage("Name one command and known options.")
  const judgementsPath = text("judgements") ? resolve(text("judgements")!) : undefined
  const worksheetPath = text("worksheet") ? resolve(text("worksheet")!) : undefined
  if (!outputs.length || !judgementsPath || !worksheetPath)
    return usage("Give --outputs, --judgements and --worksheet.")
  if (!outsideRepository(judgementsPath) || !outsideRepository(worksheetPath))
    return usage(`The judgement file and worksheets must be outside the repository (${REPO_ROOT}).`)
  const judge = text("judge")
  const by = text("by")
  if ((command === "tasks" || command === "import") && !/^human:\S/.test(judge ?? ""))
    return usage(
      "--judge must be human:<name>. A model judge's calls are paid, so it runs through judgeRuns with the eval ledger, never from a worksheet.",
    )
  if (command === "adjudicate" && (!/^human:\S/.test(by ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(text("date") ?? "")))
    return usage("adjudicate needs --by human:<name> and --date YYYY-MM-DD.")
  const proposal = proposalOption(values.proposal)
  if (proposal === null) return usage("--proposal takes importance.")

  const loaded = await loadOutputs({
    paths: outputs,
    ...(text("manifest") ? { manifest: text("manifest")! } : {}),
    ...(text("split") ? { split: text("split")! } : {}),
  })
  if (!existsSync(judgementsPath) && command !== "tasks")
    return { code: 1, stdout: "", stderr: `${judgementsPath} does not exist; run tasks first.\n` }
  const nits = values.nits === true
  const file: JudgementFile = existsSync(judgementsPath)
    ? await readJudgements(judgementsPath)
    : {
        schema: JUDGEMENTS_SCHEMA,
        seed: randomBytes(16).toString("hex"),
        ...(proposal ? { proposal } : {}),
        judgements: [],
        calls: [],
      }
  const mismatch = proposalMismatch(judgementsPath, file, proposal)
  if (mismatch) return { code: 1, stdout: "", stderr: `${mismatch}\n` }
  const base = { runs: loaded.runs, cases: loaded.cases, seed: file.seed, nits, ...(proposal ? { proposal } : {}) }
  const header = { rubric: RUBRIC_VERSION, ...(proposal ? { proposal } : {}), instructions: instructions(proposal) }

  if (command === "tasks") {
    const judged = (run: string, finding: string) =>
      file.judgements.some(
        (item) =>
          item.run === run &&
          item.finding === finding &&
          (item.adjudication !== undefined ||
            item.passes.some(
              (pass) => pass.judge === judge && pass.rubric === RUBRIC_VERSION && pass.proposal === proposal,
            )),
      )
    const blinded = blind({ ...base, only: (run, finding) => !judged(run, finding) })
    const sheet: Worksheet = {
      schema: WORKSHEET_SCHEMA,
      kind: "judge",
      ...header,
      tasks: blinded.tasks.map((task) => ({
        ...task,
        findings: task.findings.map((finding) => ({ ...finding, answer: null })),
      })),
    }
    if (!existsSync(judgementsPath)) await writeJudgements(judgementsPath, file)
    await writeFile(worksheetPath, JSON.stringify(sheet, null, 2) + "\n")
    return wrote(
      `Wrote ${sheet.tasks.length} task(s) with ${sheet.tasks.reduce((total, task) => total + task.findings.length, 0)} finding(s) for ${judge} to ${worksheetPath}.`,
    )
  }

  if (command === "disputes") {
    const disputes = disputeTasks({ ...base, judgements: file.judgements })
    const sheet: Worksheet = {
      schema: WORKSHEET_SCHEMA,
      kind: "adjudicate",
      ...header,
      instructions: `${header.instructions} Each finding lists the verdicts the judges gave, in no particular order and without their names.`,
      tasks: disputes.tasks.map((task) => ({
        ...task,
        findings: task.findings.map((finding) => ({ ...finding, answer: null })),
      })),
    }
    await writeFile(worksheetPath, JSON.stringify(sheet, null, 2) + "\n")
    return wrote(
      `Wrote ${sheet.tasks.reduce((total, task) => total + task.findings.length, 0)} disagreement(s) to adjudicate to ${worksheetPath}.`,
    )
  }

  const sheet = (await Bun.file(worksheetPath).json()) as Worksheet
  if (sheet?.schema !== WORKSHEET_SCHEMA || !Array.isArray(sheet.tasks))
    return { code: 1, stdout: "", stderr: `${worksheetPath} is not a ${WORKSHEET_SCHEMA} worksheet.\n` }
  if (sheet.kind !== (command === "import" ? "judge" : "adjudicate"))
    return {
      code: 1,
      stdout: "",
      stderr: `${worksheetPath} is for ${sheet.kind === "judge" ? "judging" : "adjudication"}, not for ${command}.\n`,
    }
  if (sheet.rubric !== RUBRIC_VERSION || sheet.proposal !== proposal)
    return {
      code: 1,
      stdout: "",
      stderr: `${worksheetPath} was written for ${rubricName(sheet.rubric, sheet.proposal)}, not ${staleAgainst(header, sheet.proposal)}.\n`,
    }
  const answered = await judgeRuns({ ...base, matcher: worksheetMatcher(command === "import" ? judge! : by!, sheet) })
  const judgements =
    command === "import"
      ? recordPasses(file.judgements, answered.passes)
      : recordAdjudications(
          file.judgements,
          answered.passes.map((entry) => ({
            run: entry.run,
            finding: entry.finding,
            adjudication: {
              by: by!,
              date: text("date")!,
              rubric: entry.pass.rubric,
              ...(entry.pass.proposal ? { proposal: entry.pass.proposal } : {}),
              verdict: entry.pass.verdict,
              ...(entry.pass.importance ? { importance: entry.pass.importance } : {}),
              ...(entry.pass.suggestion ? { suggestion: entry.pass.suggestion } : {}),
              ...(entry.pass.note ? { note: entry.pass.note } : {}),
            },
          })),
        )
  await writeJudgements(judgementsPath, { ...file, judgements })
  return {
    code: answered.problems.length ? 1 : 0,
    stdout: `Recorded ${answered.passes.length} ${command === "import" ? `pass(es) by ${judge}` : `adjudication(s) by ${by}`} in ${judgementsPath}.\n`,
    stderr: answered.problems.length
      ? `Answers left out:\n${answered.problems.map((line) => `  ${line}`).join("\n")}\n`
      : "",
  }
}

async function writeJudgements(path: string, file: JudgementFile) {
  await writeFile(path, JSON.stringify(file, null, 2) + "\n")
}

function usage(problem: string) {
  return { code: 2, stdout: "", stderr: `${problem}\n\n${USAGE}` }
}

function wrote(line: string) {
  return { code: 0, stdout: `${line}\nNothing was sent.\n`, stderr: "" }
}

if (import.meta.main) {
  const result = await main(process.argv.slice(2))
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exit(result.code)
}
