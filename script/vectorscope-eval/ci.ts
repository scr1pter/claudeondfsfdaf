#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { devNull } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { VARIANT_NAME } from "../../packages/core/src/review/eval"
import type { ReviewPrice } from "../../packages/core/src/review/plan"
import {
  defaultLimits,
  formatSummary,
  Ledger,
  LedgerError,
  limitProblems,
  listPriceWarnings,
  money,
  type Limits,
  type Price,
} from "./budget"
import { loadManifest, manifestProblems, SEED_MANIFEST, untrustedGitEnv, type Manifest } from "./dataset"
import { fixtureProblems, listFixtures, loadFixture } from "./fixture"
import { outsideRepository, REPO_ROOT } from "./paths"
import { PILOT, pilotProblems, pilotRemaining, replayBudget, triagePairProblem, variantRecord } from "./replay"
import {
  cachePriceNote,
  DEFAULT_BASE_URL,
  estimateCases,
  estimateReport,
  EVAL_ENVIRONMENT,
  EVAL_ENVIRONMENT_ENV,
  EVAL_KEY_ENV,
  promptsFor,
} from "./run"
import { OUTCOME_LEDGER_FILE, publicKey, PUBLIC_KEY_ENV, seal, unseal, type Sealed } from "./seal"

// Sealing lives in seal.ts, so the outcome ledger (outcomes.ts) can seal without loading this file's run.ts.
export { PUBLIC_KEY_ENV, SEALED_SCHEMA, seal, unseal, type Sealed } from "./seal"

// The vectorscope eval workflow's entry point (.github/workflows/vectorscope-eval.yml; VectorScope plan, VS-03). The
// workflow hands the dispatch inputs over as environment variables and never writes one into a shell command. This
// script validates them and starts run.ts, or for the replay pipeline the engine's entry point
// (packages/engine/script/vectorscope-replay.ts, VS-21c), with an argument array, so no input is parsed by a shell.
//
// Two pipelines (EVAL_PIPELINE): "smoke", the default, sends the review prompt for each synthetic fixture to each
// model (run.ts); "replay" runs the dataset's cases through the engine's review pipeline, for each registry variant in
// EVAL_VARIANTS (engine and engine:shared-verify when empty). A variant made by its models (VS-29a's
// engine:cross-family) pairs each model with EVAL_TRIAGE_MODEL as its first pass, in dry runs only.
//
//   plan     Validates the inputs and estimates the worst case. Smoke checks the fixtures. Replay projects every
//            seed case, every split, for each variant against a canned model on this computer, which spends nothing,
//            and fails on any projection problem. Sends nothing and needs no key.
//   mirrors  Fetches the local mirrors a replay prepares its checkouts from: anonymous https fetches of the committed
//            seed manifest's repositories at its commits, nothing else.
//   project  For the paid job's replay: projects the development cases it is about to pay for into the output
//            directory, sending nothing and with no key, so the report can measure the estimate error. What it
//            prints goes to a log in that directory, sealed with the paid run's.
//   paid     Runs each model in turn. Every request is admitted by one budget ledger whose journal all the runs
//            share, and is sent with the vectorscope-eval environment's own key (D7). No model starts once the ledger
//            has stopped admitting. A paid replay stays within the D5 pilot's limits.
//   report   Summarises the ledger journal, also after a cancelled or timed-out run.
//   seal     Encrypts the reports, logs and journal to the owner's public key, for the run's artifact.
//   unseal   On the owner's machine: decrypts a sealed artifact with the matching private key.
//
// The repository is public, so its Actions logs, step summaries and artifacts can be read by anyone. Results stay
// internal until a held-out run passes D2 and the owner reviews the aggregate (D12), so a paid run prints only the
// ledger's spend and counts. run.ts's output, with every score and finding, is written to the output directory, and
// the artifact holds that directory only as sealed by the owner's key. A failed run is never retried here: running
// again is the owner's decision, with a new budget.

export const KEY_ENV = EVAL_KEY_ENV
export const MODES = ["dry-run", "paid"] as const
export const PIPELINES = ["smoke", "replay"] as const
// The replay pipeline's variants when none are named: the frozen pipeline and VS-06's shared verify policy.
export const DEFAULT_VARIANTS = ["engine", "engine:shared-verify"]
export const ENGINE_DIR = join(REPO_ROOT, "packages", "engine")
export const REPLAY_ENTRY = join(ENGINE_DIR, "script", "vectorscope-replay.ts")
export const JOURNAL = "ledger.jsonl"
export const SEALED = "vectorscope-eval.sealed.json"
const MAX_TOKENS = 200_000
const RUN = join(import.meta.dir, "run.ts")
// model=input:output, optionally followed by :cacheRead and :cacheWrite (VS-21e), each USD per million tokens.
const MODEL =
  /^([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})=(\d{1,6}(?:\.\d{1,6})?):(\d{1,6}(?:\.\d{1,6})?)(?::(\d{1,6}(?:\.\d{1,6})?)(?::(\d{1,6}(?:\.\d{1,6})?))?)?$/
const AMOUNT = /^\d{1,6}(?:\.\d{1,4})?$/
const FIXTURES = /^[a-z0-9-]+(?:,[a-z0-9-]+)*$/

export type Mode = (typeof MODES)[number]
export type Pipeline = (typeof PIPELINES)[number]

// A model and its price. `projectionPrice`, set only when the entry gave cache prices (VS-21e), is the projection-only
// price: run.ts and the replay entry point are always handed the two-field `price`, which is all their estimates,
// admission and settlement read.
export interface PricedModel {
  id: string
  price: Price
  projectionPrice?: ReviewPrice
}

export interface Inputs {
  mode: Mode
  pipeline: Pipeline
  models: PricedModel[]
  limits?: Limits
  maxTokens: number // the smoke pipeline's output limit; a replay runs under the engine's own
  repeat: number
  fixtures?: string[]
  variants: string[] // registry names for the replay pipeline; empty for smoke
  pilotSpentUsd?: number // replay only: what the pilot's earlier dispatches settled; absent when none was given
  // Replay dry runs only: the first pass the variants made by their models pair each model with (VS-29a); absent when
  // none was given.
  triageModel?: PricedModel
}

type Env = Record<string, string | undefined>

// The dispatch inputs, checked as text before any is used. A problem quotes the input as JSON, so input text can never
// start a line of the log, where the runner would read it as a workflow command.
export function parseInputs(env: Env): { inputs: Inputs } | { problems: string[] } {
  const problems: string[] = []
  const mode = env.EVAL_MODE ?? ""
  if (!MODES.includes(mode as Mode)) problems.push(`mode must be ${MODES.join(" or ")}, not ${JSON.stringify(mode)}`)

  const entries = (env.EVAL_MODELS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (!entries.length) problems.push("models must list at least one model=input:output entry")
  const models = entries.flatMap((entry) => {
    const match = MODEL.exec(entry)
    if (!match) {
      problems.push(
        `models entry ${JSON.stringify(entry)} must be model=input:output, with USD per million tokens, such as anthropic/claude-sonnet-4.5=3:15`,
      )
      return []
    }
    return [pricedModel(match)]
  })
  const ids = models.map((model) => model.id)
  const repeated = ids.filter((id, index) => ids.indexOf(id) !== index)
  if (repeated.length) problems.push(`models lists ${[...new Set(repeated)].join(", ")} more than once`)

  const amount = (name: string, value: string | undefined) => {
    if (!value?.trim()) return undefined
    if (!AMOUNT.test(value.trim()) || !(Number(value) > 0)) {
      problems.push(`${name} must be a positive USD amount such as 0.75, not ${JSON.stringify(value)}`)
      return Number.NaN
    }
    return Number(value)
  }
  const total = amount("budget_usd", env.EVAL_BUDGET_USD)
  const perCase = amount("case_budget_usd", env.EVAL_CASE_BUDGET_USD)
  let limits: Limits | undefined
  if ((total === undefined) !== (perCase === undefined)) problems.push("budget_usd and case_budget_usd go together")
  else if (total !== undefined && perCase !== undefined && Number.isFinite(total) && Number.isFinite(perCase)) {
    limits = defaultLimits(total, perCase)
    problems.push(...limitProblems(limits))
  }
  if (mode === "paid") {
    if (total === undefined) problems.push("a paid run needs budget_usd and case_budget_usd")
    // A price of zero would let every estimate through; a paid run's prices must bound what it can spend.
    const free = models.filter((model) => !(model.price.input > 0 && model.price.output > 0))
    if (free.length)
      problems.push(
        `a paid run needs input and output prices above zero, so its estimates bound spend: ${free.map((model) => model.id).join(", ")}`,
      )
  }

  const maxTokens = env.EVAL_MAX_TOKENS?.trim() ?? ""
  if (!/^\d{1,6}$/.test(maxTokens) || Number(maxTokens) < 1 || Number(maxTokens) > MAX_TOKENS)
    problems.push(`max_tokens must be a whole number from 1 to ${MAX_TOKENS}, not ${JSON.stringify(maxTokens)}`)
  const repeat = env.EVAL_REPEAT?.trim() ?? ""
  if (!/^[1-5]$/.test(repeat)) problems.push(`repeat must be 1 to 5, not ${JSON.stringify(repeat)}`)
  const fixtures = env.EVAL_FIXTURES?.trim() ?? ""
  if (fixtures && !FIXTURES.test(fixtures))
    problems.push(`fixtures must be comma-separated fixture names, not ${JSON.stringify(fixtures)}`)

  const pipeline = env.EVAL_PIPELINE?.trim() || "smoke"
  if (!PIPELINES.includes(pipeline as Pipeline))
    problems.push(`pipeline must be ${PIPELINES.join(" or ")}, not ${JSON.stringify(env.EVAL_PIPELINE)}`)
  const named = (env.EVAL_VARIANTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (pipeline === "smoke" && named.length)
    problems.push("variants name replay pipelines: leave them empty for the smoke pipeline")
  if (pipeline === "replay") {
    // A malformed entry gets a fixed message with the entry quoted, so its text can never start a line of the log; a
    // well-formed one holds only lowercase letters, digits, "-" and ":", and resolveVariant's detail adds registry text.
    problems.push(
      ...named.flatMap((entry) => {
        if (!VARIANT_NAME.test(entry))
          return [
            `variants entry ${JSON.stringify(entry)} is not a variant name: a runner, then optionally ":" and a registered suffix, such as engine:shared-verify`,
          ]
        const resolved = variantRecord(entry)
        return resolved.ok ? [] : [`variants entry ${JSON.stringify(entry)}: ${resolved.detail}`]
      }),
    )
    const twice = named.filter((entry, index) => named.indexOf(entry) !== index)
    if (twice.length)
      problems.push(
        `variants lists ${[...new Set(twice)].map((entry) => JSON.stringify(entry)).join(", ")} more than once`,
      )
    if (fixtures) problems.push("fixtures belong to the smoke pipeline: a replay runs the dataset's cases")
  }
  // What the pilot's earlier dispatches settled, from their sealed ledgers: one pilot's dispatches share D5's $50.
  const spent = env.EVAL_PILOT_SPENT_USD?.trim() ?? ""
  if (spent && !AMOUNT.test(spent))
    problems.push(
      `pilot_spent_usd must be a USD amount such as 12.40, or empty for none, not ${JSON.stringify(env.EVAL_PILOT_SPENT_USD)}`,
    )
  if (spent && pipeline !== "replay")
    problems.push("pilot_spent_usd belongs to the replay pipeline's pilot: leave it empty for the smoke pipeline")
  const spentUsd = spent && AMOUNT.test(spent) ? Number(spent) : undefined
  // D5: a paid replay is the pilot, within its limits and what its earlier dispatches left. Checked here, where the
  // earlier spend is given, so the dry run fails before the owner is asked to approve; the entry point holds each
  // dispatch to the whole $50 and refuses the other limits itself.
  if (pipeline === "replay" && mode === "paid" && limits)
    problems.push(
      ...pilotProblems({
        limits,
        repeat: Number(repeat),
        split: "development",
        ...(spentUsd !== undefined ? { spentUsd } : {}),
      }),
    )
  // VS-29a: the triage model of the variants made by their models, which need one, for no other variant. Once
  // engine:cross-family is built, a dry dispatch naming it without one would fail the entry point on every model, so it
  // is refused here first, as is a triage model equal to a review model. A paid dispatch is refused for the pair
  // outright, whatever its models, so it is never asked for a triage model that would then be refused as dry only.
  const triageText = env.EVAL_TRIAGE_MODEL?.trim() ?? ""
  const triageMatch = MODEL.exec(triageText)
  const triageModel = triageMatch ? pricedModel(triageMatch) : undefined
  if (triageText && !triageMatch)
    problems.push(
      `triage_model ${JSON.stringify(triageText)} must be model=input:output, with USD per million tokens, such as openai/gpt-5=1.25:10, or empty for none`,
    )
  if (triageText && pipeline !== "replay")
    problems.push("triage_model belongs to the replay pipeline: leave it empty for the smoke pipeline")
  if (pipeline === "replay") {
    const paired = pairedVariants(named.length ? named : DEFAULT_VARIANTS)
    if (triageModel && !paired.length)
      problems.push("triage_model is for a variant made by its models (engine:cross-family); variants names none")
    if (mode === "paid" && (paired.length || triageText))
      problems.push(
        `${paired.length ? paired.join(", ") : "triage_model"} runs in dry runs only: a paid cross-family replay is not wired until the owner chooses the pair (Q5) and funds its ablation (Q9)`,
      )
    if (mode !== "paid" && (!triageText || triageModel))
      problems.push(
        ...paired.flatMap((name) =>
          models.flatMap((model) => {
            const problem = triagePairProblem(name, [model.id, ...(triageModel ? [triageModel.id] : [])])
            if (!problem) return []
            return [triageModel ? problem : `${problem} Set triage_model.`]
          }),
        ),
      )
  }

  if (problems.length) return { problems }
  return {
    inputs: {
      mode: mode as Mode,
      pipeline: pipeline as Pipeline,
      models,
      ...(limits ? { limits } : {}),
      maxTokens: Number(maxTokens),
      repeat: Number(repeat),
      ...(fixtures ? { fixtures: fixtures.split(",") } : {}),
      variants: pipeline === "replay" ? (named.length ? named : [...DEFAULT_VARIANTS]) : [],
      ...(spentUsd !== undefined ? { pilotSpentUsd: spentUsd } : {}),
      ...(triageModel ? { triageModel } : {}),
    },
  }
}

// A models or triage_model entry MODEL matched: its two-field price, and the projection-only price when it gave cache
// prices.
function pricedModel(match: RegExpExecArray): PricedModel {
  const price = { input: Number(match[2]), output: Number(match[3]) }
  return {
    id: match[1],
    price,
    ...(match[4] === undefined
      ? {}
      : {
          projectionPrice: {
            ...price,
            cacheRead: Number(match[4]),
            ...(match[5] === undefined ? {} : { cacheWrite: Number(match[5]) }),
          },
        }),
  }
}

// What a model's prices add to a plan or a replay plan (VS-21e): the plan's note on the cache prices it gave, and the D6
// check of each price against its list price. Nothing for a two-field price at its list price, or for a model the
// table does not list.
function priceNotes(models: readonly PricedModel[], note: (id: string, price: ReviewPrice) => string) {
  return models.flatMap((model) => [
    ...(model.projectionPrice ? [note(model.id, model.projectionPrice)] : []),
    ...listPriceWarnings(model.id, model.projectionPrice ?? model.price),
  ])
}

// The registry names among these that are variants made by their models (VS-29a), which take the triage model.
function pairedVariants(names: readonly string[]) {
  return names.filter((entry) => {
    const resolved = variantRecord(entry)
    return resolved.ok && resolved.record?.models === "triage-pair"
  })
}

// run.ts's arguments for one model. Without an output directory it is a dry run. With one, it sends with the eval's
// own key, to the default endpoint, which no input can change, and charges the ledger journal every model shares.
export function runArgs(inputs: Inputs, index: number, outDir?: string): string[] {
  const model = inputs.models[index]!
  return [
    "--model",
    model.id,
    "--price",
    `${model.price.input}:${model.price.output}`,
    "--max-tokens",
    String(inputs.maxTokens),
    "--repeat",
    String(inputs.repeat),
    ...(inputs.fixtures ? ["--fixture", inputs.fixtures.join(",")] : []),
    ...(inputs.limits
      ? ["--budget-usd", String(inputs.limits.totalUsd), "--case-budget-usd", String(inputs.limits.caseUsd)]
      : []),
    ...(outDir
      ? [
          "--ledger",
          join(outDir, JOURNAL),
          "--out",
          join(outDir, `${runName(inputs, index)}.json`),
          "--api-key-env",
          KEY_ENV,
        ]
      : ["--dry-run"]),
  ]
}

// The engine entry point's arguments for one model (packages/engine/script/vectorscope-replay.ts). Without a target it is
// the plan's dry projection of every seed case, every split, writing nothing. With one that does not send, it projects
// the development cases into the output directory (the paid job's projections, for the estimate error). With one that
// sends, it replays the development cases with the eval's own key, charging the ledger journal every model shares.
// The entry point decides for itself whether it may send (its replayMode), and refuses outside the protected
// environment; these arguments never name a key, an endpoint or a manifest other than the committed seed.
export function replayArgs(
  inputs: Inputs,
  index: number,
  dirs: { mirrors: string; work: string },
  target?: { outDir: string; send: boolean },
): string[] {
  const model = inputs.models[index]!
  const triage = inputs.triageModel
  return [
    "--model",
    `${model.id}=${model.price.input}:${model.price.output}`,
    ...(triage ? ["--triage-model", `${triage.id}=${triage.price.input}:${triage.price.output}`] : []),
    "--manifest",
    SEED_MANIFEST,
    "--mirrors",
    dirs.mirrors,
    "--work",
    dirs.work,
    ...inputs.variants.flatMap((variant) => ["--variant", variant]),
    "--repeat",
    String(inputs.repeat),
    ...(inputs.limits
      ? ["--budget-usd", String(inputs.limits.totalUsd), "--case-budget-usd", String(inputs.limits.caseUsd)]
      : []),
    ...(!target
      ? ["--split", "all", "--dry-run"]
      : target.send
        ? ["--split", "development", "--ledger", join(target.outDir, JOURNAL), "--out", target.outDir]
        : ["--split", "development", "--dry-run", "--out", target.outDir]),
  ]
}

// The local mirrors a replay's checkouts are prepared from (replay.ts prepareCheckout): one bare repository per
// repository of the manifest, at <owner>/<name>.git (where dataset.ts mirrorLocator finds it), with the heads and bases
// of its cases. Each commit is fetched into its own ref so that a later gc keeps it.
export function mirrorPlan(manifest: Pick<Manifest, "cases">) {
  return Object.entries(Object.groupBy(manifest.cases, (item) => item.repository.url)).map(([url, cases]) => {
    const [owner = "", name = ""] = new URL(url).pathname.split("/").filter(Boolean)
    return {
      url,
      dir: join(owner, `${name}.git`),
      // A multi-commit sequence's pushes too (VS-22c), so its object checks and a later sequence replay find each one.
      shas: [
        ...new Set(
          (cases ?? []).flatMap((item) => [
            item.candidate.head,
            item.candidate.base,
            ...(item.candidate.commits ?? []).map((push) => push.sha),
          ]),
        ),
      ],
    }
  })
}

// Git for the mirror fetch: none of the user's or the system's config (untrustedGitEnv), no hooks or fsmonitor, and https
// alone of the remote transports, so a fetch reaches GitHub's https endpoint and nothing else.
export const MIRROR_GIT = [
  "-c",
  `core.hooksPath=${devNull}`,
  "-c",
  "core.fsmonitor=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
] as const

function runName(inputs: Inputs, index: number) {
  return `${index + 1}-${inputs.models[index]!.id.replace(/[^A-Za-z0-9._-]/g, "_")}`
}

export interface Child {
  stdout: Promise<string>
  stderr?: Promise<string>
  exited: Promise<number>
  kill(signal: NodeJS.Signals): void
}

export interface Deps {
  env?: Env
  spawn?: (argv: string[], env: Record<string, string>, cwd?: string) => Child
  // Runs git with these arguments (after "git") for the mirror fetch.
  git?: (argv: string[], env: Record<string, string | undefined>) => { code: number; stderr: string }
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

export async function main(command: string | undefined, deps: Deps = {}, args: string[] = []): Promise<number> {
  const env = deps.env ?? process.env
  const out = deps.stdout ?? ((text: string) => void process.stdout.write(text))
  const err = deps.stderr ?? ((text: string) => void process.stderr.write(text))
  const summary = (text: string) => {
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text)
  }
  if (command === "report") return report({ env, out, summary })
  if (command === "seal") return sealCommand({ env, out, err })
  if (command === "unseal") return unsealCommand(args, { out, err })
  if (command === "mirrors") return fetchMirrors({ env, out, err, git: deps.git ?? git })
  if (command !== "plan" && command !== "paid" && command !== "project") {
    err(
      "Usage: bun script/vectorscope-eval/ci.ts plan|mirrors|project|paid|report|seal (inputs come from EVAL_* environment variables)\n" +
        "       bun script/vectorscope-eval/ci.ts unseal <sealed.json> <private-key.pem> <directory>\n",
    )
    return 2
  }
  const parsed = parseInputs(env)
  if ("problems" in parsed) {
    err(`The dispatch inputs are not valid:\n${parsed.problems.map((line) => `  ${line}`).join("\n")}\n`)
    summary(`### Inputs not valid\n\n${parsed.problems.map((line) => `- ${escape(line)}`).join("\n")}\n\n`)
    return 1
  }
  const inputs = parsed.inputs
  if (command === "plan")
    return inputs.pipeline === "replay"
      ? planReplay(inputs, { env, out, err, summary, spawn: deps.spawn ?? spawn })
      : plan(inputs, { out, err, summary })
  if (command === "project") return project(inputs, { env, out, err, spawn: deps.spawn ?? spawn })
  if (inputs.mode !== "paid") {
    err("The paid job runs only when mode is paid.\n")
    return 1
  }
  return paid(inputs, { env, out, err, summary, spawn: deps.spawn ?? spawn })
}

async function plan(
  inputs: Inputs,
  io: { out: (text: string) => void; err: (text: string) => void; summary: (text: string) => void },
) {
  const names = await listFixtures()
  const unknown = (inputs.fixtures ?? []).filter((name) => !names.includes(name))
  if (unknown.length) {
    io.err(`Unknown fixture(s): ${unknown.join(", ")}\n`)
    return 1
  }
  const fixtures = await Promise.all((inputs.fixtures ?? names).map(loadFixture))
  const invalid = fixtures.flatMap((fixture) =>
    fixtureProblems(fixture).map((problem) => `${fixture.name}: ${problem}`),
  )
  if (invalid.length) {
    io.err(`Invalid fixtures:\n${invalid.map((line) => `  ${line}`).join("\n")}\n`)
    return 1
  }
  const prompts = promptsFor(fixtures)
  const estimates = inputs.models.map((model) =>
    estimateCases(prompts, {
      model: model.id,
      price: model.price,
      maxTokens: inputs.maxTokens,
      repeat: inputs.repeat,
      baseUrl: DEFAULT_BASE_URL,
    }),
  )
  const once = estimates.reduce((total, item) => total + item.onceUsd, 0)
  const worst = estimates.reduce((total, item) => total + item.worstUsd, 0)
  const admissible = inputs.limits ? inputs.limits.totalUsd - inputs.limits.reserveUsd : undefined
  const notes = priceNotes(inputs.models, cachePriceNote)
  const text = [
    `Mode ${inputs.mode}. ${fixtures.length} fixture(s) x ${inputs.repeat} for each of ${inputs.models.length} model(s).`,
    "",
    ...estimates.flatMap((estimate) => [estimateReport(estimate, inputs.limits), ""]),
    ...(notes.length ? [...notes, ""] : []),
    `All models: at most $${money(once)} with each case asked once, $${money(worst)} at worst.`,
    admissible === undefined
      ? "No budget was given, so a paid run could not start."
      : `The budget admits $${money(admissible)} after its reserve: ${worst <= admissible ? "the worst case fits" : once <= admissible ? "every case asked once fits, but not every retry" : "not every case fits; those the budget cannot admit are reported as not sent"}.`,
    inputs.mode === "paid"
      ? "The paid job waits for the owner's approval in the vectorscope-eval environment."
      : "Dry run: nothing was sent, and no key was used.",
  ].join("\n")
  io.out(text + "\n")
  io.summary(block("Dry run", text))
  return 0
}

// The replay pipeline's dry run: the engine entry point projects every seed case for each variant against a canned
// model on this computer, under the strict egress guard, and fails on any projection problem. Its child gets a path, a
// home and a temporary directory, and no key, whatever the job's environment holds.
async function planReplay(
  inputs: Inputs,
  io: {
    env: Env
    out: (text: string) => void
    err: (text: string) => void
    summary: (text: string) => void
    spawn: NonNullable<Deps["spawn"]>
  },
) {
  const dirs = replayDirs(io.env)
  if (typeof dirs === "string") {
    io.err(`${dirs}\n`)
    return 1
  }
  const value = await loadManifest(SEED_MANIFEST)
  const invalid = manifestProblems(value)
  if (invalid.length) {
    io.err(`The seed manifest is not valid:\n${invalid.map((line) => `  ${line}`).join("\n")}\n`)
    return 1
  }
  // VS-21e: the entry point is handed each two-field price and prices projections with the committed catalog's cache
  // rates, so a cache price given here is not used; the D6 check still reads it.
  const notes = priceNotes(
    [...inputs.models, ...(inputs.triageModel ? [inputs.triageModel] : [])],
    (id) =>
      `${id}: replay projections take cache rates from the committed catalog; the cache prices given are not used.`,
  )
  if (notes.length) {
    io.out(`${notes.join("\n")}\n`)
    io.summary(block("Prices", notes.join("\n")))
  }
  const codes = []
  for (const [index, model] of inputs.models.entries()) {
    const child = io.spawn(
      [process.execPath, REPLAY_ENTRY, ...replayArgs(inputs, index, dirs)],
      plainEnv(io.env),
      ENGINE_DIR,
    )
    const [text, errors, code] = await Promise.all([child.stdout, child.stderr ?? Promise.resolve(""), child.exited])
    if (errors) io.err(errors.endsWith("\n") ? errors : `${errors}\n`)
    io.out(`${text}${text.endsWith("\n") ? "" : "\n"}`)
    io.summary(block(`Dry projection: ${model.id}`, text))
    codes.push(code)
  }
  const development = (value as Manifest).cases.filter((item) => item.split === "development").length
  const spent = inputs.pilotSpentUsd ?? 0
  const triage = inputs.triageModel
  const paired = pairedVariants(inputs.variants)
  const text = [
    `Mode ${inputs.mode}, replay pipeline. ${inputs.variants.length} variant(s) (${inputs.variants.join(", ")}) for each of ${inputs.models.length} model(s); max_tokens applies to the smoke pipeline only.`,
    ...(triage
      ? [
          `${paired.join(", ")} pair${paired.length > 1 ? "" : "s"} each model with ${triage.id} as its first pass (triage_model); nothing checks the pair's labs or tier until codium's labOf merges and the owner chooses the pair (Q5).`,
        ]
      : []),
    ...(inputs.limits
      ? [
          `A paid replay runs the ${development} development case(s) x ${inputs.variants.length} variant(s) x ${inputs.repeat} x ${inputs.models.length} model(s). ${replayBudget(development * inputs.variants.length * inputs.repeat * inputs.models.length, inputs.limits).text}`,
        ]
      : ["No budget was given, so a paid run could not start."]),
    `The D5 pilot's $${money(PILOT.totalUsd, 2)} is shared by all its dispatches: $${money(spent, 2)} settled by earlier ones (pilot_spent_usd), so $${money(pilotRemaining(spent), 2)} is left for this one. Split a pilot's dispatches by variants and models, never repeating a case, variant and model.`,
    inputs.mode === "paid"
      ? "The paid job waits for the owner's approval in the vectorscope-eval environment."
      : "Dry run: nothing was sent, and no key was used.",
  ].join("\n")
  io.out(text + "\n")
  io.summary(block("Dry run", text))
  return codes.every((code) => code === 0) ? 0 : 1
}

// The paid job's projections of the development cases it is about to replay, into the output directory beside the
// paid artifacts, so the sealed report can join each paid run with its projection. It sends nothing and holds no key.
// It runs in the paid job, so its output goes where the paid step's does: to a log only the sealed artifact carries,
// with the public log given each model's exit code alone (D12).
async function project(
  inputs: Inputs,
  io: { env: Env; out: (text: string) => void; err: (text: string) => void; spawn: NonNullable<Deps["spawn"]> },
) {
  if (inputs.pipeline !== "replay") {
    io.err("Projections run for the replay pipeline only.\n")
    return 1
  }
  const outDir = outputDir(io.env)
  if (typeof outDir !== "string") {
    io.err(`${outDir.problem}\n`)
    return 1
  }
  const dirs = replayDirs(io.env)
  if (typeof dirs === "string") {
    io.err(`${dirs}\n`)
    return 1
  }
  mkdirSync(outDir, { recursive: true })
  const codes = []
  for (const [index, model] of inputs.models.entries()) {
    const child = io.spawn(
      [process.execPath, REPLAY_ENTRY, ...replayArgs(inputs, index, dirs, { outDir, send: false })],
      plainEnv(io.env),
      ENGINE_DIR,
    )
    const [text, errors, code] = await Promise.all([child.stdout, child.stderr ?? Promise.resolve(""), child.exited])
    writeFileSync(
      join(outDir, `${runName(inputs, index)}-projection.log`),
      `${errors}${errors && text ? "\n" : ""}${text}`,
    )
    io.out(`${model.id}: the projection exited with ${code}. Its log is in the sealed artifact.\n`)
    codes.push(code)
  }
  return codes.every((code) => code === 0) ? 0 : 1
}

// Fetches each seed repository's commits into a bare mirror under EVAL_MIRRORS_DIR. Every URL comes from the committed
// seed manifest, never from an input, and git runs with no user or system config and https as its only transport.
async function fetchMirrors(io: {
  env: Env
  out: (text: string) => void
  err: (text: string) => void
  git: NonNullable<Deps["git"]>
}) {
  const root = outputDir(io.env, "EVAL_MIRRORS_DIR")
  if (typeof root !== "string") {
    io.err(`${root.problem}\n`)
    return 1
  }
  const value = await loadManifest(SEED_MANIFEST)
  const invalid = manifestProblems(value)
  if (invalid.length) {
    io.err(`The seed manifest is not valid:\n${invalid.map((line) => `  ${line}`).join("\n")}\n`)
    return 1
  }
  const failed = mirrorPlan(value as Manifest).filter((entry) => {
    const target = join(root, entry.dir)
    mkdirSync(dirname(target), { recursive: true })
    const steps = [
      ["init", "--bare", "--quiet", target],
      [
        "-C",
        target,
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-recurse-submodules",
        entry.url,
        ...entry.shas.map((sha) => `${sha}:refs/vectorscope/${sha}`),
      ],
      ...entry.shas.map((sha) => ["-C", target, "cat-file", "-e", `${sha}^{commit}`]),
    ]
    const broken = steps.find((step) => {
      const result = io.git([...MIRROR_GIT, ...step], untrustedGitEnv())
      if (result.code === 0) return false
      io.err(
        `${entry.url}: git ${step[0] === "-C" ? step[2] : step[0]} failed: ${JSON.stringify(result.stderr.trim())}\n`,
      )
      return true
    })
    if (!broken) io.out(`${entry.url}: ${entry.shas.length} commit(s) in ${target}\n`)
    return broken !== undefined
  })
  return failed.length ? 1 : 0
}

async function paid(
  inputs: Inputs,
  io: {
    env: Env
    out: (text: string) => void
    err: (text: string) => void
    summary: (text: string) => void
    spawn: NonNullable<Deps["spawn"]>
  },
) {
  if (io.env.GITHUB_ACTIONS !== "true" || io.env.EVAL_ENVIRONMENT !== EVAL_ENVIRONMENT) {
    io.err(
      `The paid run starts only in the ${EVAL_ENVIRONMENT} environment of .github/workflows/vectorscope-eval.yml.\n`,
    )
    return 1
  }
  const key = io.env[KEY_ENV]
  if (!key) {
    io.err(
      `${KEY_ENV} is not set. Add it as a secret of the vectorscope-eval environment, not of the repository, and run again.\n`,
    )
    return 1
  }
  const sealing = publicKey(io.env[PUBLIC_KEY_ENV])
  if (typeof sealing === "string") {
    io.err(`${sealing}\n`)
    return 1
  }
  const outDir = outputDir(io.env)
  if (typeof outDir !== "string") {
    io.err(`${outDir.problem}\n`)
    return 1
  }
  const dirs = inputs.pipeline === "replay" ? replayDirs(io.env) : undefined
  if (typeof dirs === "string") {
    io.err(`${dirs}\n`)
    return 1
  }
  mkdirSync(outDir, { recursive: true })
  const journal = join(outDir, JOURNAL)
  // Only what run.ts needs: the eval key, a path and the environment's mark, none of the runner's other variables.
  const childEnv = Object.fromEntries(
    Object.entries({
      PATH: io.env.PATH,
      HOME: io.env.HOME,
      TMPDIR: io.env.TMPDIR,
      GITHUB_ACTIONS: "true",
      [EVAL_ENVIRONMENT_ENV]: EVAL_ENVIRONMENT,
      [KEY_ENV]: key,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  let cancelled = false
  let child: Child | undefined
  const interrupt = (signal: NodeJS.Signals) => {
    cancelled = true
    child?.kill(signal)
  }
  const onInt = () => interrupt("SIGINT")
  const onTerm = () => interrupt("SIGTERM")
  process.on("SIGINT", onInt)
  process.on("SIGTERM", onTerm)
  let status = 0
  try {
    for (const [index, model] of inputs.models.entries()) {
      if (cancelled) break
      const stopped = existsSync(journal) ? stoppedReason(journal) : undefined
      if (stopped) {
        io.err(`Not starting ${model.id}: the ledger stopped admitting (${stopped}).\n`)
        status = 1
        break
      }
      // run.ts's output, and the replay's, hold scores, findings and model text. It goes to a log beside its report,
      // which only the sealed artifact carries; the public log and summary get the ledger's spend and counts alone (D12).
      child = dirs
        ? io.spawn(
            [process.execPath, REPLAY_ENTRY, ...replayArgs(inputs, index, dirs, { outDir, send: true })],
            childEnv,
            ENGINE_DIR,
          )
        : io.spawn([process.execPath, RUN, ...runArgs(inputs, index, outDir)], childEnv)
      const [text, errors, code] = await Promise.all([child.stdout, child.stderr ?? Promise.resolve(""), child.exited])
      child = undefined
      writeFileSync(join(outDir, `${runName(inputs, index)}.log`), `${errors}${errors && text ? "\n" : ""}${text}`)
      const spend = existsSync(journal) ? ledgerText(journal) : "No ledger journal: no paid attempt was admitted."
      const line = `${model.id}: ${dirs ? "the replay" : "run.ts"} exited with ${code}. Its report and log are in the sealed artifact.`
      io.out(`${line}\n${spend}\n`)
      io.summary(block(model.id, `${line}\n${spend}`))
      if (code !== 0) status = 1
    }
  } finally {
    process.off("SIGINT", onInt)
    process.off("SIGTERM", onTerm)
  }
  return cancelled ? 1 : status
}

function report(io: { env: Env; out: (text: string) => void; summary: (text: string) => void }) {
  const outDir = outputDir(io.env)
  if (typeof outDir !== "string") {
    io.out(`${outDir.problem}\n`)
    return 1
  }
  const journal = join(outDir, JOURNAL)
  if (!existsSync(journal)) {
    const text = "No ledger journal: no paid attempt was admitted."
    io.out(text + "\n")
    io.summary(block("Budget", text))
    return 0
  }
  try {
    const summary = Ledger.inspect(journal)
    writeFileSync(join(outDir, "budget.json"), JSON.stringify(summary, null, 2) + "\n")
    const text = [
      formatSummary(summary),
      "An attempt admitted and never settled, such as one in flight when the run was stopped, counts at its whole reservation.",
    ].join("\n")
    io.out(text + "\n")
    io.summary(block("Budget", text))
    return 0
  } catch (error) {
    if (!(error instanceof LedgerError)) throw error
    io.out(`${error.message}\n`)
    return 1
  }
}

function ledgerText(journal: string) {
  try {
    return formatSummary(Ledger.inspect(journal))
  } catch (error) {
    if (error instanceof LedgerError) return error.message
    throw error
  }
}

// Seals every file of the output directory into EVAL_SEALED_DIR, the only directory the workflow uploads.
function sealCommand(io: { env: Env; out: (text: string) => void; err: (text: string) => void }) {
  const outDir = outputDir(io.env)
  if (typeof outDir !== "string") {
    io.err(`${outDir.problem}\n`)
    return 1
  }
  const sealedDir = outputDir(io.env, "EVAL_SEALED_DIR")
  if (typeof sealedDir !== "string") {
    io.err(`${sealedDir.problem}\n`)
    return 1
  }
  const names = existsSync(outDir)
    ? readdirSync(outDir)
        .filter((name) => statSync(join(outDir, name)).isFile())
        .toSorted()
    : []
  if (!names.length) {
    io.out("Nothing to seal: the run wrote no report, log or journal.\n")
    return 0
  }
  const key = publicKey(io.env[PUBLIC_KEY_ENV])
  if (typeof key === "string") {
    io.err(`${key}\nNothing was sealed or kept.\n`)
    return 1
  }
  mkdirSync(sealedDir, { recursive: true })
  const files = Object.fromEntries(names.map((name) => [name, readFileSync(join(outDir, name))]))
  writeFileSync(join(sealedDir, SEALED), JSON.stringify(seal(files, key)) + "\n")
  io.out(
    `Sealed ${names.length} file(s) to the owner's key. Open them with: bun script/vectorscope-eval/ci.ts unseal.\n`,
  )
  return 0
}

function unsealCommand(args: string[], io: { out: (text: string) => void; err: (text: string) => void }) {
  const [file, keyFile, directory] = args
  if (!file || !keyFile || !directory) {
    io.err("Usage: bun script/vectorscope-eval/ci.ts unseal <sealed.json> <private-key.pem> <directory>\n")
    return 2
  }
  const target = resolve(directory)
  if (!outsideRepository(target)) {
    io.err(`The directory must be outside the repository (${REPO_ROOT}).\n`)
    return 2
  }
  const files = unseal(
    JSON.parse(readFileSync(resolve(file), "utf8")) as Sealed,
    readFileSync(resolve(keyFile), "utf8"),
  )
  // An outcome ledger carries its expiry inside the sealed payload, which only outcomes.ts open checks (VS-46a).
  if (Object.hasOwn(files, OUTCOME_LEDGER_FILE)) {
    io.err(
      "This is an outcome ledger, which expires 180 days after collection: open it with bun script/vectorscope-eval/outcomes.ts open, which checks that. Nothing was written.\n",
    )
    return 1
  }
  mkdirSync(target, { recursive: true })
  for (const [name, data] of Object.entries(files)) writeFileSync(join(target, basename(name)), data)
  io.out(`Wrote ${Object.keys(files).length} file(s) to ${target}.\n`)
  return 0
}

function stoppedReason(journal: string) {
  try {
    const summary = Ledger.inspect(journal)
    return summary.cancelled ? `cancelled: ${summary.cancelled}` : summary.halted
  } catch (error) {
    if (error instanceof LedgerError) return error.message
    throw error
  }
}

// A replay's mirrors and its working directory, both outside the repository, or why not.
function replayDirs(env: Env): { mirrors: string; work: string } | string {
  const mirrors = outputDir(env, "EVAL_MIRRORS_DIR")
  if (typeof mirrors !== "string") return mirrors.problem
  const work = outputDir(env, "EVAL_WORK_DIR")
  if (typeof work !== "string") return work.problem
  return { mirrors, work }
}

// What a child that sends nothing gets of the job's environment: a path, a home and a temporary directory. No key.
function plainEnv(env: Env) {
  return Object.fromEntries(
    Object.entries({ PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

// Reports and the journal live in the runner's temporary directory, never in the repository.
function outputDir(env: Env, name = "EVAL_OUT_DIR"): string | { problem: string } {
  const dir = env[name]
  if (!dir || !isAbsolute(dir)) return { problem: `${name} must be an absolute directory outside the repository.` }
  if (!outsideRepository(dir)) return { problem: `${name} must be outside the repository (${REPO_ROOT}).` }
  return dir
}

function spawn(argv: string[], env: Record<string, string>, cwd?: string): Child {
  const child = Bun.spawn(argv, { env, ...(cwd ? { cwd } : {}), stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  return {
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
    exited: child.exited,
    kill: (signal) => child.kill(signal),
  }
}

function git(argv: string[], env: Record<string, string | undefined>) {
  const result = Bun.spawnSync(["git", ...argv], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  return { code: result.exitCode, stderr: result.stderr.toString() }
}

// A step summary section. The text is escaped inside <pre>, so model output in it cannot become markup or links.
function block(title: string, text: string) {
  return `### ${escape(title)}\n\n<pre>${escape(text.trimEnd())}</pre>\n\n`
}

function escape(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

if (import.meta.main) process.exit(await main(process.argv[2], {}, process.argv.slice(3)))
