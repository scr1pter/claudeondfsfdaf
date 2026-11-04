#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { existsSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import type { AttemptRecord, ModelRecord, ReplayCase } from "../../packages/engine/src/review/eval"
import {
  defaultLimits,
  limitProblems,
  money,
  type Ledger,
  type Limits,
  type Refusal,
  type Settlement,
  type Ticket,
  type Usage,
} from "./budget"
import {
  caseView,
  gitEnv,
  manifestProblems,
  mirrorLocator,
  SEED_MANIFEST,
  SPLITS,
  type Case,
  type CaseView,
  type Manifest,
  type Split,
} from "./dataset"

// The production replay's driver (VectorScope plan, VS-02). It turns dataset cases into the input of the engine's
// replay, ReviewEval.replay in packages/engine/src/review/eval.ts, from the label-free case view alone, and prepares
// each case's checkout from a local mirror: the candidate head and its history only, so neither the fix nor anything
// after the candidate is in the repository the reviewer reads, with the base checked out, as CI leaves an untrusted
// change. It sends no model request: a replay that spends money is admitted by the eval budget ledger (admitReplay
// below, VS-03) and runs only in the protected vectorscope-eval environment (D5, D7), and nothing can start one yet.

const REPO_ROOT = join(import.meta.dir, "..", "..")
const FULL_SHA = /^[0-9a-f]{40}$/

export const ADAPTERS = {
  engine: {
    ready: true,
    detail: "ReviewEval.replay: the engine review pipeline, with GitHub's writes recorded instead of sent.",
  },
  desktop: {
    ready: false,
    detail:
      "The desktop runner (packages/app/src/features/pull-requests/ai-review.ts) reviews through an injected SDK client, which needs a running engine server, so it cannot be driven headlessly here yet. Its replay comes with moving that runner into the engine (VS-10).",
  },
} as const
export type Adapter = keyof typeof ADAPTERS

export interface PlannedReplay {
  id: string // kept by the driver to join results with labels; the engine uses it only to name the artifact
  split: Split
  mirror?: string
  case: Omit<ReplayCase, "directory">
}

// Each case of one split as the engine's replay input. Only the case view goes in: the repository and the candidate's
// two commits, reviewed untrusted on a writer's request, as a public change from outside would be.
export function replayPlan(
  manifest: Manifest,
  options: { split: Split; locate?: (url: string) => string | undefined },
) {
  return manifest.cases
    .filter((item) => item.split === options.split)
    .map((item) => planned(item, options.locate?.(item.repository.url)))
}

function planned(item: Case, mirror: string | undefined): PlannedReplay {
  const view = caseView(item)
  const [owner = "", repo = ""] = new URL(view.repository).pathname.split("/").filter(Boolean)
  return {
    id: item.id,
    split: item.split,
    ...(mirror ? { mirror } : {}),
    case: {
      label: item.id,
      base: view.base,
      head: view.head,
      trust: "untrusted",
      trigger: "command",
      repository: { owner, repo, url: view.repository },
    },
  }
}

// A replay's admission. Review.run admits each of its provider attempts itself, retries and the finalizer included,
// against the review's maxCostUsd, as long as its models are priced. So the eval ledger reserves the case's whole bound
// before a replay starts and hands Review.run that bound as its cap: every attempt is admitted against money the
// ledger has set aside. A model without a price cannot be bounded, so it is refused and the ledger stops admitting.
export function admitReplay(
  ledger: Ledger,
  input: { id: string; repetition?: number; models: readonly Pick<ModelRecord, "id" | "costKind" | "price">[] },
):
  | {
      admitted: true
      config: { maxCostUsd: number } // the case's cap, applied over the base's review.json
      ticket: Ticket
      // Settles the case from its artifact's attempts; with no artifact (the replay failed), the whole bound is kept.
      settle(artifact?: { attempts: readonly ReplayAttempt[] }): Settlement
    }
  | { admitted: false; reason: Refusal; detail: string } {
  const priced =
    input.models.length > 0 && input.models.every((model) => model.costKind === "priced" && model.price !== undefined)
  const model = input.models.map((item) => item.id).join(" + ")
  const admission = ledger.admit({
    case: `${model} ${input.id}#${input.repetition ?? 1}`,
    kind: "provider",
    model,
    note: "replay",
    estimateUsd: priced ? ledger.limits.caseUsd : Number.NaN,
  })
  if (!admission.admitted) return admission
  const ticket = admission.ticket
  return {
    admitted: true,
    config: { maxCostUsd: ledger.limits.caseUsd },
    ticket,
    settle: (artifact) => (artifact ? ticket.settle(replayCharge(artifact.attempts)) : ticket.settle()),
  }
}

type ReplayAttempt = Pick<AttemptRecord, "admitted" | "estimateUsd" | "settled">

// What a replay cost, from the attempts its artifact lists: each settled attempt at its reported cost, and the estimate
// of an admitted attempt that never settled, or settled without complete usage, as uncertain spend. A refused attempt
// was never sent.
export function replayCharge(attempts: readonly ReplayAttempt[]): Usage {
  let costUsd = 0
  let uncertainUsd = 0
  for (const attempt of attempts) {
    if (!attempt.admitted) continue
    if (!attempt.settled) {
      uncertainUsd += attempt.estimateUsd
      continue
    }
    costUsd += attempt.settled.costUsd
    if (!attempt.settled.complete) uncertainUsd += Math.max(0, attempt.estimateUsd - attempt.settled.costUsd)
  }
  return { costUsd, uncertainUsd, basis: "replay" }
}

// The most a split's replays could reserve: each case reserves its whole bound before it starts.
export function replayBudget(cases: number, limits: Limits) {
  const admissible = limits.totalUsd - limits.reserveUsd
  const fit = Math.min(cases, Math.floor((admissible + 1e-9) / limits.caseUsd))
  return {
    worstUsd: cases * limits.caseUsd,
    admissibleUsd: admissible,
    fit,
    text: `Budget $${money(limits.totalUsd, 2)} admits $${money(admissible)} after its $${money(limits.reserveUsd)} reserve. Each case reserves its $${money(limits.caseUsd)} bound before it starts, so ${fit} of ${cases} case(s) fit (at most $${money(cases * limits.caseUsd)} for all).`,
  }
}

// A new repository at `directory` holding the candidate head and its history, fetched from a local mirror with git
// alone, and the base checked out. Nothing after the head is fetched, so the fix stays out. Returns what went wrong;
// empty when the checkout is ready.
export function prepareCheckout(input: { mirror: string; view: CaseView; directory: string }): string[] {
  const shas = [input.view.base, input.view.head].filter((sha) => !FULL_SHA.test(sha))
  if (shas.length) return [`not full commit SHAs: ${shas.join(", ")}`]
  if (input.mirror.startsWith("-") || input.mirror.includes("://") || !isDirectory(input.mirror))
    return [`${input.mirror} is not a local mirror directory`]
  if (existsSync(input.directory)) return [`${input.directory} already exists`]
  const steps = [
    ["init", "--quiet", input.directory],
    ["-C", input.directory, "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", input.mirror, input.view.head],
    ["-C", input.directory, "checkout", "--quiet", "--detach", input.view.base],
  ]
  for (const step of steps) {
    const result = Bun.spawnSync(["git", ...step], {
      env: { ...gitEnv(), GIT_TERMINAL_PROMPT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) return [`git ${step.join(" ")} failed: ${result.stderr.toString().trim()}`]
  }
  return []
}

const USAGE = `Usage: bun script/vectorscope-eval/replay.ts [options]

Plans a replay of dataset cases through the production review pipeline. Sends no model request.

  --manifest <path>   Dataset manifest (default: the seed manifest)
  --split <name>      ${SPLITS.join(", ")} (default: development)
  --mirrors <dir>     Local clones at <dir>/<owner>/<name>[.git]
  --adapter <name>    engine (default) or desktop
  --prepare <dir>     Also prepare each mirrored case's checkout at <dir>/<case id>, with local git only
  --budget-usd <usd>  With --case-budget-usd, show how many cases the budget could admit
  --case-budget-usd <usd>
  --help              Print this message
`

const OPTIONS = {
  manifest: { type: "string" },
  split: { type: "string" },
  mirrors: { type: "string" },
  adapter: { type: "string" },
  prepare: { type: "string" },
  "budget-usd": { type: "string" },
  "case-budget-usd": { type: "string" },
  help: { type: "boolean" },
} as const

export async function main(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const parsed = parseArgs({ args: argv, options: OPTIONS, strict: false, allowPositionals: true })
  const values = parsed.values
  const text = (name: keyof typeof OPTIONS) => (typeof values[name] === "string" ? values[name] : undefined)
  const unknown = Object.keys(values).filter((name) => !Object.hasOwn(OPTIONS, name))
  const valueless = Object.entries(OPTIONS)
    .filter(
      ([name, option]) =>
        option.type === "string" && values[name] !== undefined && text(name as keyof typeof OPTIONS) === undefined,
    )
    .map(([name]) => name)
  if (unknown.length || valueless.length || parsed.positionals.length) return { code: 2, stdout: "", stderr: USAGE }
  if (values.help) return { code: 0, stdout: USAGE, stderr: "" }
  const split = text("split") ?? "development"
  const adapter = text("adapter") ?? "engine"
  if (!SPLITS.includes(split as Split)) return { code: 2, stdout: "", stderr: `Unknown split ${split}.\n\n${USAGE}` }
  if (!Object.hasOwn(ADAPTERS, adapter))
    return { code: 2, stdout: "", stderr: `Unknown adapter ${adapter}.\n\n${USAGE}` }
  const budgetText = text("budget-usd")
  const caseText = text("case-budget-usd")
  if ((budgetText === undefined) !== (caseText === undefined))
    return { code: 2, stdout: "", stderr: `--budget-usd and --case-budget-usd go together.\n\n${USAGE}` }
  const limits = budgetText && caseText ? defaultLimits(Number(budgetText), Number(caseText)) : undefined
  const limitIssues = limits ? limitProblems(limits) : []
  if (limitIssues.length) return { code: 2, stdout: "", stderr: `Budget: ${limitIssues.join("; ")}.\n` }
  if (!ADAPTERS[adapter as Adapter].ready)
    return {
      code: 2,
      stdout: "",
      stderr: `The ${adapter} adapter is not available: ${ADAPTERS[adapter as Adapter].detail}\n`,
    }

  const path = text("manifest") ? resolve(text("manifest")!) : SEED_MANIFEST
  const raw = await Bun.file(path).text()
  const value: unknown = JSON.parse(raw)
  const problems = manifestProblems(value)
  if (problems.length)
    return {
      code: 1,
      stdout: "",
      stderr: `Invalid manifest ${path}:\n${problems.map((line) => `  ${line}`).join("\n")}\n`,
    }
  const manifest = value as Manifest
  // Held-out labels are frozen before any prompt tuning, so held-out cases are replayed only from a frozen manifest.
  if (split === "held-out" && !manifest.freeze)
    return {
      code: 1,
      stdout: "",
      stderr: "Held-out cases replay only from a frozen manifest, and this one is not frozen.\n",
    }
  const mirrors = text("mirrors")
  const plan = replayPlan(manifest, {
    split: split as Split,
    ...(mirrors ? { locate: mirrorLocator(resolve(mirrors)) } : {}),
  })
  const prepare = text("prepare")
  const prepared = plan.map((entry) =>
    prepare && entry.mirror
      ? {
          entry,
          problems: prepareCheckout({
            mirror: entry.mirror,
            view: { repository: entry.case.repository?.url ?? "", base: entry.case.base, head: entry.case.head },
            directory: join(resolve(prepare), entry.id),
          }),
        }
      : { entry, problems: [] },
  )
  const failures = prepared.flatMap((item) => item.problems.map((problem) => `${item.entry.id}: ${problem}`))
  const vector = Bun.spawnSync(["git", "-C", REPO_ROOT, "rev-parse", "HEAD"], { env: gitEnv(), stdout: "pipe" })
  const rows = prepared.map((item) => [
    item.entry.id,
    item.entry.case.repository?.url?.replace("https://github.com/", "") ?? "",
    item.entry.case.base.slice(0, 12),
    item.entry.case.head.slice(0, 12),
    !item.entry.mirror ? "no mirror" : !prepare ? "mirror" : item.problems.length ? "failed" : "prepared",
  ])
  const stdout = [
    `${plan.length} ${split} case(s) from ${path}`,
    formatTable([["CASE", "REPOSITORY", "BASE", "HEAD", "CHECKOUT"], ...rows]),
    "",
    `Manifest sha256 ${createHash("sha256").update(raw).digest("hex")}`,
    `Vector ${vector.exitCode === 0 ? vector.stdout.toString().trim() : "unknown"}`,
    `Adapter ${adapter}: ${ADAPTERS[adapter as Adapter].detail}`,
    "Each case replays untrusted on a writer's request, with its base checked out and its change in the prompt.",
    ...(limits ? [replayBudget(plan.length, limits).text] : []),
    "",
    "Dry run: no model request was sent. A replay that spends money is admitted by the eval budget ledger and runs only in the protected vectorscope-eval environment (D5, D7).",
  ].join("\n")
  if (failures.length)
    return {
      code: 1,
      stdout: stdout + "\n",
      stderr: `Checkout problems:\n${failures.map((line) => `  ${line}`).join("\n")}\n`,
    }
  return { code: 0, stdout: stdout + "\n", stderr: "" }
}

function isDirectory(path: string) {
  return existsSync(path) && statSync(path).isDirectory()
}

function formatTable(rows: string[][]) {
  const widths = (rows[0] ?? []).map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)))
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n")
}

if (import.meta.main) {
  const result = await main(process.argv.slice(2))
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exit(result.code)
}
