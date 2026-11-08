#!/usr/bin/env bun
// VectorScope's replay entry point (VS-21c, docs/vector/build/vectorscope-upgrade.md §4). It runs dataset cases through
// the engine's review pipeline in this process, as the engine tests boot it: VECTOR_PURE, VECTOR_DISABLE_PROJECT_CONFIG,
// fresh XDG roots and home, the provider from VECTOR_CONFIG_CONTENT, and each case's checkout prepared from a local
// mirror (script/vectorscope-eval/replay.ts prepareCheckout). It is not a user-facing command (D14): ci.ts starts it,
// from packages/engine, for the replay pipeline of .github/workflows/vectorscope-eval.yml.
//
// It is dry unless every send rule holds (replayMode, the rules of script/vectorscope-eval/run.ts with no loopback
// exception): a budget, prices above zero, a ledger and an output directory, the D5 pilot's limits, and the protected
// vectorscope-eval GitHub environment with its own key. A dry run projects each case (ReviewEval.project) against a
// canned model on a fake server on this computer, under the strict egress guard, and sends nothing; it never has the
// eval key, which is removed from its environment with every other provider key the catalog names. A refusal is
// decided before anything is created or any engine module loads.
//
// A variant made by its models (VS-29a's engine:cross-family) takes its triage model from --triage-model, which the
// eval config supplies and a variant name never holds. It applies to that variant alone, and only in a dry run: a paid
// cross-family replay waits for the owner's choice of pair (Q5) and a funded ablation (Q9).
//
// Load order matters. Static imports are node builtins, effect, the eval scripts' pure modules and types only: none
// loads core flag.ts, which reads VECTOR_DISABLE_MODELS_FETCH once, or touches the network. main sets the engine's
// environment first; a dry run then installs the strict egress guard before the first engine module loads, and a paid
// run imports the backstop first, as every Vector entry point does. Every engine module is a dynamic import in the
// branch that needs it.
//
// The dry branch imports the fake server (test/lib/llm-server, TestLLMServer.loopback) and the canned model
// (test/fixture/projection) from the test tree on purpose (the deviation log, 2026-11-06 VS-21c): its safety rests on
// the strict guard, ReviewEval.project's own refusals and the egress count below, never on them, and the paid branch
// never loads them.
//
// VS-21e adds two dry-only flags, each off unless given: --cost-split adds each pass's projected cost by token kind,
// cached and uncached side by side, with the D6 check of the catalog prices; --scenario suggestion-untrusted runs the
// canned model's opt-in scenario under `verify: "all"` and writes no record. Without them a dry run is as it was.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import type { ProjectionRecord, ReplayArtifact, VariantRecord } from "@/review/eval"
import type { ResolvedModel } from "@/review/model"
import type { ProjectionScenario } from "../test/fixture/projection"
import {
  defaultLimits,
  formatSummary,
  Ledger,
  LedgerError,
  limitProblems,
  listPriceWarnings,
  parsePrice,
  type Limits,
  type Price,
} from "../../../script/vectorscope-eval/budget"
import {
  gitEnv,
  manifestProblems,
  mirrorLocator,
  SEED_MANIFEST,
  SPLITS,
  untrustedGitEnv,
  UNTRUSTED_GIT,
  type Manifest,
  type Split,
} from "../../../script/vectorscope-eval/dataset"
import { outsideRepository, REPO_ROOT } from "../../../script/vectorscope-eval/paths"
import {
  admitReplay,
  checkoutDirectory,
  PILOT,
  pilotProblems,
  prepareCheckout,
  projectedPassCosts,
  projectedRun,
  projectionProblems,
  replayPlan,
  triagePairProblem,
  variantRecord,
  type PlannedReplay,
} from "../../../script/vectorscope-eval/replay"
import { EVAL_ENVIRONMENT, EVAL_ENVIRONMENT_ENV, EVAL_KEY_ENV } from "../../../script/vectorscope-eval/run"

// The provider a dry run registers for the fake server, and the router a paid replay sends through.
export const PROJECTION_PROVIDER = "vectorscope-projection"
export const PAID_PROVIDER = "openrouter"
// The committed model catalog both branches boot with (VECTOR_MODELS_PATH), so the price the engine reserves with is
// the one the operator typed and the catalog holds, and nothing is fetched.
export const CATALOG = join(REPO_ROOT, "packages", "web", "public", "models", "api.json")
// VS-21e: the canned model's opt-in scenarios (test/fixture/projection.ts PROJECTION_SCENARIOS), named here so that a
// refusal is decided before any of it loads.
export const SCENARIOS = ["suggestion-untrusted"] as const satisfies readonly ProjectionScenario[]

export const USAGE = `Usage (from packages/engine): bun script/vectorscope-replay.ts --model <id>=<in>:<out> --mirrors <dir> --work <dir> [options]

Runs dataset cases through the engine's review pipeline in this process. A dry run unless every send rule below holds:
it projects each case against a canned model on this computer, under the strict egress guard, and sends nothing.

  --model <id>=<in>:<out>  An ${PAID_PROVIDER} model id and its price in the committed catalog, USD per million input
                           and output tokens, such as anthropic/claude-sonnet-4.5=3:15
  --manifest <path>        Dataset manifest (default: the seed manifest)
  --mirrors <dir>          Local mirrors at <dir>/<owner>/<name>[.git] (bun script/vectorscope-eval/ci.ts mirrors)
  --work <dir>             An absolute directory outside the repository for the checkouts and the engine's state;
                           what this run creates there is removed when it ends
  --split <name>           development (default), calibration, held-out or all; a paid replay runs development only
  --variant <name>         A registry variant built for the engine, such as engine:shared-verify (repeatable;
                           default engine)
  --triage-model <id>=<in>:<out>
                           For a variant made by its models (engine:cross-family): its first-pass model, an
                           ${PAID_PROVIDER} model other than --model at its committed catalog price, which --model
                           double-checks. Dry runs only; other variants run on --model alone
  --repeat <n>             Repetitions, 1 to 5 (default 1). A dry run projects repetition 1 only; a paid one runs once
  --budget-usd <usd>       With --case-budget-usd, the ledger's limits; a paid replay stays within D5's $${PILOT.totalUsd}
  --case-budget-usd <usd>  The per-case bound, at most $${PILOT.caseUsd}; also a dry run's dollar cap (default $${PILOT.caseUsd})
  --ledger <path>          The budget journal, outside the repository (needed to send)
  --out <dir>              Where each projection record or replay artifact is written, outside the repository
                           (needed to send)
  --dry-run                Never send, even with a budget
  --cost-split             A dry run only: add each pass's projected cost by token kind, cached and uncached side by
                           side, and check the catalog's prices against D6's dated list prices (VS-21e)
  --scenario <name>        A dry run only, writing no record: run the canned model's ${SCENARIOS.join(", ")}
                           scenario, an untrusted case's nit with a suggestion under verify: all (VS-21e)
  --help                   Print this message

It sends only with a budget, prices above zero, --ledger and --out, the development split and one repetition, in the
protected ${EVAL_ENVIRONMENT} GitHub environment: GITHUB_ACTIONS=true, ${EVAL_ENVIRONMENT_ENV}=${EVAL_ENVIRONMENT} and
${EVAL_KEY_ENV}.
`

export interface ReplayFlags {
  model: { id: string; price: Price }
  manifest: string
  mirrors: string
  work: string
  split: Split | "all"
  variants: { name: string; record?: Omit<VariantRecord, "applied"> }[] // registry names, each built for the engine
  // The first pass of the variants made by their models (VS-29a), and of no other; absent when none is named.
  triage?: { id: string; price: Price }
  repeat: number
  limits?: Limits
  ledger?: string
  out?: string
  dryRun: boolean
  costSplit?: true // VS-21e, dry runs only
  scenario?: ProjectionScenario // VS-21e, dry runs only, with no --out
}

const OPTIONS = {
  model: { type: "string" },
  manifest: { type: "string" },
  mirrors: { type: "string" },
  work: { type: "string" },
  split: { type: "string" },
  variant: { type: "string", multiple: true },
  "triage-model": { type: "string" },
  repeat: { type: "string" },
  "budget-usd": { type: "string" },
  "case-budget-usd": { type: "string" },
  ledger: { type: "string" },
  out: { type: "string" },
  "dry-run": { type: "boolean" },
  "cost-split": { type: "boolean" },
  scenario: { type: "string" },
  help: { type: "boolean" },
} as const

const MODEL = /^([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})=(.+)$/

// The flags, or what is wrong with them. Strict: an unknown option, a missing value, a value given to a switch or a
// stray argument is refused. parseArgs runs unstrict so each refusal has its own message, and unstrict it reads
// `--dry-run=true` as the string "true", so a switch counts only as exactly true: anything else would read as unset,
// and --dry-run is the one flag that keeps a budgeted run from sending.
export function parseReplayArgs(argv: readonly string[]): ReplayFlags | string {
  const parsed = parseArgs({ args: [...argv], options: OPTIONS, strict: false, allowPositionals: true })
  const values = parsed.values
  const unknown = Object.keys(values).filter((name) => !Object.hasOwn(OPTIONS, name))
  if (unknown.length) return `Unknown option(s): ${unknown.map((name) => `--${name}`).join(", ")}`
  if (parsed.positionals.length) return `Unexpected argument(s): ${parsed.positionals.join(" ")}`
  const valued = (Object.keys(OPTIONS) as (keyof typeof OPTIONS)[]).filter(
    (name) => OPTIONS[name].type === "boolean" && values[name] !== undefined && values[name] !== true,
  )
  if (valued.length)
    return `${valued.map((name) => `--${name}`).join(" and ")} take${valued.length > 1 ? "" : "s"} no value`
  const text = (name: Exclude<keyof typeof OPTIONS, "variant" | "dry-run" | "cost-split" | "help">) => {
    const value = values[name]
    return typeof value === "string" ? value : undefined
  }
  const valueless = (Object.keys(OPTIONS) as (keyof typeof OPTIONS)[]).filter(
    (name) =>
      name !== "variant" &&
      OPTIONS[name].type === "string" &&
      values[name] !== undefined &&
      typeof values[name] !== "string",
  )
  if (valueless.length) return `Missing value for ${valueless.map((name) => `--${name}`).join(", ")}`
  const named = (Array.isArray(values.variant) ? values.variant : []).map((entry) =>
    typeof entry === "string" ? entry : "",
  )
  if (named.some((entry) => entry === "")) return "Missing value for --variant"

  const model = MODEL.exec(text("model") ?? "")
  const price = model ? parsePrice(model[2]!) : undefined
  if (!model || !price)
    return "--model must be <id>=<in>:<out>, with USD per million input and output tokens, such as anthropic/claude-sonnet-4.5=3:15."
  const triageText = text("triage-model")
  const triageModel = triageText === undefined ? undefined : MODEL.exec(triageText)
  const triagePrice = triageModel ? parsePrice(triageModel[2]) : undefined
  if (triageText !== undefined && (!triageModel || !triagePrice))
    return "--triage-model must be <id>=<in>:<out>, with USD per million input and output tokens, such as openai/gpt-5=1.25:10."
  const mirrors = text("mirrors")
  if (!mirrors)
    return "--mirrors is needed: the directory of local mirrors (bun script/vectorscope-eval/ci.ts mirrors)."
  const work = text("work")
  if (!work || !isAbsolute(work) || !outsideRepository(work))
    return `--work must be an absolute directory outside the repository (${REPO_ROOT}).`
  const split = text("split") ?? "development"
  if (split !== "all" && !SPLITS.includes(split as Split))
    return `--split must be ${SPLITS.join(", ")} or all, not ${JSON.stringify(split)}.`
  const repeat = text("repeat") ?? "1"
  if (!/^[1-5]$/.test(repeat)) return `--repeat must be 1 to 5, not ${JSON.stringify(repeat)}.`
  const budget = text("budget-usd")
  const perCase = text("case-budget-usd")
  if ((budget === undefined) !== (perCase === undefined)) return "--budget-usd and --case-budget-usd go together."
  const limits =
    budget !== undefined && perCase !== undefined ? defaultLimits(Number(budget), Number(perCase)) : undefined
  const limitIssues = limits ? limitProblems(limits) : []
  if (limitIssues.length) return `Budget: ${limitIssues.join("; ")}.`
  const ledger = text("ledger") === undefined ? undefined : resolve(text("ledger")!)
  const out = text("out") === undefined ? undefined : resolve(text("out")!)
  if (ledger !== undefined && !outsideRepository(ledger))
    return `--ledger must be outside the repository (${REPO_ROOT}).`
  if (out !== undefined && !outsideRepository(out)) return `--out must be outside the repository (${REPO_ROOT}).`
  // VS-21e: a canned scenario is a dry run's demonstration, so its records are never written beside real projections,
  // where report.ts would join them with paid runs for the estimate error.
  const scenario = text("scenario")
  if (scenario !== undefined && !SCENARIOS.some((name) => name === scenario))
    return `--scenario must be ${SCENARIOS.join(" or ")}, not ${JSON.stringify(scenario)}.`
  if (scenario !== undefined && out !== undefined)
    return "--scenario writes no record: leave out --out, so a canned scenario's projection is never read as a real one."

  const asked = named.length ? named : ["engine"]
  const twice = asked.filter((entry, index) => asked.indexOf(entry) !== index)
  if (twice.length) return `--variant names ${[...new Set(twice)].join(", ")} more than once.`
  const resolved = asked.map(variantRecord)
  const refused = resolved.flatMap((entry) => (entry.ok ? [] : [entry.detail]))
  if (refused.length) return refused.join("\n")
  const variants = resolved.flatMap((entry) =>
    entry.ok ? [{ name: entry.name, ...(entry.record ? { record: entry.record } : {}) }] : [],
  )
  // VS-29a: the triage model belongs to the variants made by their models, which need it, and to no other.
  const triage = triageModel && triagePrice ? { id: triageModel[1], price: triagePrice } : undefined
  const paired = variants.filter((entry) => entry.record?.models === "triage-pair")
  if (triage && !paired.length)
    return "--triage-model is for a variant made by its models (engine:cross-family); no --variant is."
  const unpaired = paired.flatMap(
    (entry) => triagePairProblem(entry.name, [model[1], ...(triage ? [triage.id] : [])]) ?? [],
  )
  // A run that would send (replayMode's rule) is refused for the pair there, whatever its models, so it is not first
  // asked for a triage model that would then be refused as dry only (Q5, Q9).
  const sends = limits !== undefined && values["dry-run"] !== true
  if (unpaired.length && !sends) return `${unpaired.join("\n")}${triage ? "" : " Give --triage-model."}`
  return {
    model: { id: model[1]!, price },
    manifest: text("manifest") ? resolve(text("manifest")!) : SEED_MANIFEST,
    mirrors: resolve(mirrors),
    work,
    split: split as Split | "all",
    variants,
    ...(triage ? { triage } : {}),
    repeat: Number(repeat),
    ...(limits ? { limits } : {}),
    ...(ledger ? { ledger } : {}),
    ...(out ? { out } : {}),
    dryRun: values["dry-run"] === true,
    ...(values["cost-split"] === true ? { costSplit: true as const } : {}),
    ...(scenario === "suggestion-untrusted" ? { scenario } : {}),
  }
}

export type ReplayMode = { mode: "dry" } | { mode: "paid" } | { refused: string }

// Whether this run sends. Dry without a budget or with --dry-run. Otherwise it sends only when every rule holds, and is
// refused when one does not: prices above zero, so estimates bound spend; the protected environment's two marks and its
// own key; a ledger and an output directory; and the D5 pilot's limits. A paid replay always goes to OpenRouter, so
// there is no loopback exception. A variant made by its models and a triage model (VS-29a) run dry only, so a budgeted
// run with either is refused, whatever its models. It reads these three variables of the environment and no other.
export function replayMode(flags: ReplayFlags, env: Readonly<Record<string, string | undefined>>): ReplayMode {
  if (!flags.limits || flags.dryRun) return { mode: "dry" }
  const price = flags.model.price
  const refusals = [
    ...(flags.costSplit || flags.scenario
      ? ["--cost-split and --scenario are for dry runs only: they project, and never shape what a paid replay sends."]
      : []),
    ...(flags.triage || flags.variants.some((variant) => variant.record?.models === "triage-pair")
      ? [
          "A paid cross-family replay is not wired: engine:cross-family and --triage-model run dry only, until the owner chooses the pair (Q5) and funds its ablation (Q9).",
        ]
      : []),
    ...(price.input > 0 && price.output > 0
      ? []
      : ["A paid replay needs input and output prices above zero, so its estimates bound what it can spend."]),
    ...(env.GITHUB_ACTIONS === "true" && env[EVAL_ENVIRONMENT_ENV] === EVAL_ENVIRONMENT
      ? []
      : [
          `A paid replay runs only in the ${EVAL_ENVIRONMENT} GitHub environment (.github/workflows/vectorscope-eval.yml, through ci.ts paid).`,
        ]),
    ...(env[EVAL_KEY_ENV] ? [] : [`A paid replay sends with ${EVAL_KEY_ENV}, the eval environment's own key.`]),
    ...(flags.ledger && flags.out
      ? []
      : ["A paid replay needs --ledger and --out, so every attempt is journalled and every artifact kept."]),
    ...pilotProblems({ limits: flags.limits, repeat: flags.repeat, split: flags.split }).map(
      (problem) => `${problem[0]!.toUpperCase()}${problem.slice(1)}.`,
    ),
  ]
  if (refusals.length) return { refused: `Nothing was sent. ${refusals.join(" ")}` }
  return { mode: "paid" }
}

// A catalog model as the engine is given it: what the dry branch's config copies, and what the paid branch's price
// must match.
export interface CatalogEntry {
  name?: string
  release_date?: string
  attachment?: boolean
  reasoning?: boolean
  temperature?: boolean
  tool_call: true
  limit: { context: number; output: number }
  cost: {
    input: number
    output: number
    cache_read?: number
    cache_write?: number
    context_over_200k?: { input: number; output: number; cache_read?: number; cache_write?: number }
  }
}

// The model's entry in the committed catalog's OpenRouter models, read as untrusted JSON, or why it cannot be used: it
// is missing, calls no tools, has no price above zero, or is priced other than the price given. The engine reserves at
// the catalog's price, so the operator's price must be that price (input and output; the cache rates come with it).
export function catalogModel(
  catalog: unknown,
  id: string,
  price: Price,
): { entry: CatalogEntry } | { problem: string } {
  const models = record(record(record(catalog)?.[PAID_PROVIDER])?.models)
  const value = models && Object.hasOwn(models, id) ? record(models[id]) : undefined
  if (!value) return { problem: `${id} is not one of the committed catalog's ${PAID_PROVIDER} models (${CATALOG}).` }
  const limit = record(value.limit)
  const cost = record(value.cost)
  const context = limit?.context
  const output = limit?.output
  const input = cost?.input
  const out = cost?.output
  if (!finite(context) || !finite(output) || !finite(input) || !finite(out))
    return { problem: `${id} has no context limit or price in the committed catalog.` }
  if (value.tool_call !== true) return { problem: `${id} does not call tools, which a review needs.` }
  if (!(input > 0 && out > 0)) return { problem: `${id} has no price above zero in the committed catalog.` }
  if (input !== price.input || out !== price.output)
    return {
      problem: `${id} costs ${input}:${out} in the committed catalog, which is what the engine reserves with; give that price, not ${price.input}:${price.output}.`,
    }
  const long = record(cost?.context_over_200k)
  const rate = (from: Record<string, unknown> | undefined, key: "cache_read" | "cache_write") => {
    const value = from?.[key]
    return finite(value) ? { [key]: value } : {}
  }
  return {
    entry: {
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(typeof value.release_date === "string" ? { release_date: value.release_date } : {}),
      ...(typeof value.attachment === "boolean" ? { attachment: value.attachment } : {}),
      ...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
      ...(typeof value.temperature === "boolean" ? { temperature: value.temperature } : {}),
      tool_call: true,
      limit: { context, output },
      cost: {
        input,
        output: out,
        ...rate(cost, "cache_read"),
        ...rate(cost, "cache_write"),
        ...(long && finite(long.input) && finite(long.output)
          ? {
              context_over_200k: {
                input: long.input,
                output: long.output,
                ...rate(long, "cache_read"),
                ...rate(long, "cache_write"),
              },
            }
          : {}),
      },
    },
  }
}

// Every environment variable a catalog provider reads, the eval key aside: removed before the engine loads, so the
// engine finds no provider key of the machine's. The dry branch removes the eval key too.
export function providerKeys(catalog: unknown): string[] {
  const providers = record(catalog)
  return [
    ...new Set(
      Object.values(providers ?? {}).flatMap((provider) => {
        const env = record(provider)?.env
        return Array.isArray(env) ? env.filter((name): name is string => typeof name === "string") : []
      }),
    ),
  ].filter((name) => name !== EVAL_KEY_ENV)
}

// The engine's environment, all under `root` except the committed catalog: fresh XDG roots and home, no catalog fetch,
// the GitHub review job's isolation (VECTOR_PURE, no project config), no update check or usage report, no search
// model, and the session database in memory. It holds no key.
export function engineEnvironment(root: string): Record<string, string> {
  return {
    XDG_DATA_HOME: join(root, "share"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    HOME: join(root, "home"),
    VECTOR_DISABLE_MODELS_FETCH: "1",
    VECTOR_MODELS_PATH: CATALOG,
    VECTOR_PURE: "1",
    VECTOR_DISABLE_PROJECT_CONFIG: "1",
    VECTOR_DISABLE_AUTOUPDATE: "1",
    VECTOR_DISABLE_USAGE: "1",
    VECTOR_BRAIN_EMBED: "off",
    VECTOR_AGENT_DB: ":memory:",
  }
}

// VECTOR_CONFIG_CONTENT: lsp, formatter and snapshot off, as the GitHub review job sets them, and one provider only.
// Dry: the catalog model under PROJECTION_PROVIDER at the fake server, with a dummy key. Its long-context rate comes as
// context_over_200k, the config's only form; the catalog's exact tiers are not carried, and seed prompts are far below
// them. A dry run with a triage model (VS-29a) lists it beside the review model, under the same provider and key.
// Paid: OpenRouter from the catalog, with its key as the literal {env:...} reference the engine fills in, so the key's
// value never enters this text.
export function engineConfig(
  input:
    | { mode: "dry"; server: string; id: string; entry: CatalogEntry; triage?: { id: string; entry: CatalogEntry } }
    | { mode: "paid" },
): string {
  const base = { $schema: "https://vectordev.ai/config.json", lsp: false, formatter: false, snapshot: false }
  if (input.mode === "paid")
    return JSON.stringify({
      ...base,
      enabled_providers: [PAID_PROVIDER],
      provider: { [PAID_PROVIDER]: { options: { apiKey: `{env:${EVAL_KEY_ENV}}` } } },
    })
  return JSON.stringify({
    ...base,
    enabled_providers: [PROJECTION_PROVIDER],
    provider: {
      [PROJECTION_PROVIDER]: {
        id: PROJECTION_PROVIDER,
        name: "VectorScope projection",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        // The fake server answers any number of requests at once (test/lib/test-provider.ts says why it is set).
        options: { apiKey: "projection-dummy-key", baseURL: input.server, concurrency: 64 },
        models: {
          [input.id]: dryModel(input.id, input.entry),
          ...(input.triage ? { [input.triage.id]: dryModel(input.triage.id, input.triage.entry) } : {}),
        },
      },
    },
  })
}

// A catalog model as the dry provider lists it.
function dryModel(id: string, entry: CatalogEntry) {
  return {
    id,
    name: entry.name ?? id,
    release_date: entry.release_date ?? "2025-01-01",
    attachment: entry.attachment ?? false,
    reasoning: entry.reasoning ?? false,
    temperature: entry.temperature ?? false,
    tool_call: true,
    limit: entry.limit,
    cost: entry.cost,
    options: {},
  }
}

// The dry branch's model, as the engine booted it under PROJECTION_PROVIDER: priced as the engine prices it,
// SpendGuard.priceOf of the loaded cost with its cache rates, which is what resolveReviewModel gives the paid model and
// what ReviewEval.project's route check compares. resolveReviewModel itself would call a model on this computer local.
export const projectionModel = (id: string) =>
  Effect.gen(function* () {
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    const { ProviderV2 } = yield* Effect.promise(() => import("@vectordevai/core/provider"))
    const { ModelV2 } = yield* Effect.promise(() => import("@vectordevai/core/model"))
    const { SpendGuard } = yield* Effect.promise(() => import("@vectordevai/core/spend-guard"))
    const provider = yield* Provider.Service
    const loaded = yield* provider.getModel(ProviderV2.ID.make(PROJECTION_PROVIDER), ModelV2.ID.make(id))
    const price = SpendGuard.priceOf(loaded.cost)
    return {
      providerID: loaded.providerID,
      modelID: loaded.id,
      context: loaded.limit.context,
      costKind: "priced",
      ...(price ? { price } : {}),
    } satisfies ResolvedModel
  })

export interface Io {
  env: Record<string, string | undefined>
  out(text: string): void
  err(text: string): void
}

export async function main(argv: string[], io: Io): Promise<number> {
  if (argv.includes("--help")) {
    io.out(USAGE)
    return 0
  }
  const flags = parseReplayArgs(argv)
  if (typeof flags === "string") {
    io.err(`${flags}\n\n${USAGE}`)
    return 2
  }
  // Before anything is created or loaded: a refusal leaves --work, --ledger and --out as they were.
  const decided = replayMode(flags, io.env)
  if ("refused" in decided) {
    io.err(`${decided.refused}\n`)
    return 2
  }
  if (!existsSync(flags.manifest)) {
    io.err(`No manifest at ${flags.manifest}.\n`)
    return 2
  }
  const manifestText = await Bun.file(flags.manifest).text()
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(manifestText)
  if (Option.isNone(parsed)) {
    io.err(`Invalid manifest ${flags.manifest}: not JSON.\n`)
    return 2
  }
  const value = parsed.value
  const invalid = manifestProblems(value)
  if (invalid.length) {
    io.err(`Invalid manifest ${flags.manifest}:\n${invalid.map((line) => `  ${line}`).join("\n")}\n`)
    return 2
  }
  // A paid replay runs the development split alone (replayMode); only a dry one plans any other split, the held-out
  // cases included, since a projection reads no label and scores nothing.
  const splits: readonly Split[] =
    decided.mode === "paid" ? ["development"] : flags.split === "all" ? SPLITS : [flags.split]
  const locate = mirrorLocator(flags.mirrors)
  const planned = splits.flatMap((split) => replayPlan(value as Manifest, { split, locate }))
  // A run with nothing to do proves nothing, so it fails: a dry plan that projected no case must not pass.
  if (!planned.length) {
    io.err(`No case of ${flags.manifest} was planned for --split ${flags.split}.\n`)
    return 1
  }
  const catalog: unknown = await Bun.file(CATALOG).json()
  const chosen = catalogModel(catalog, flags.model.id, flags.model.price)
  if ("problem" in chosen) {
    io.err(`${chosen.problem}\n`)
    return 2
  }
  // The triage model is booted from the catalog as the review model is, so its price must be the catalog's too.
  const triaged = flags.triage ? catalogModel(catalog, flags.triage.id, flags.triage.price) : undefined
  if (triaged && "problem" in triaged) {
    io.err(`--triage-model: ${triaged.problem}\n`)
    return 2
  }

  mkdirSync(flags.work, { recursive: true })
  const root = mkdtempSync(join(flags.work, "run-"))
  try {
    const engine = join(root, "engine")
    const environment = engineEnvironment(engine)
    for (const directory of [environment.HOME, environment.XDG_CONFIG_HOME, join(root, "cases")])
      mkdirSync(directory, { recursive: true })
    Object.assign(process.env, environment)
    for (const name of providerKeys(catalog)) delete process.env[name]
    if (decided.mode === "dry") delete process.env[EVAL_KEY_ENV]
    const vector = Bun.spawnSync(["git", "-C", REPO_ROOT, "rev-parse", "HEAD"], { env: gitEnv(), stdout: "pipe" })
    const source = {
      ...(vector.exitCode === 0 ? { vector: vector.stdout.toString().trim() } : {}),
      manifest: createHash("sha256").update(manifestText).digest("hex"),
    }
    const run = {
      flags,
      planned,
      entry: chosen.entry,
      ...(flags.triage && triaged ? { triage: { id: flags.triage.id, entry: triaged.entry } } : {}),
      cases: join(root, "cases"),
      source,
      io,
    }
    if (decided.mode === "dry") return await projectDry(run)
    return await replayPaid({ ...run, key: io.env[EVAL_KEY_ENV] ?? "" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

interface Run {
  flags: ReplayFlags
  planned: PlannedReplay[]
  entry: CatalogEntry
  triage?: { id: string; entry: CatalogEntry } // --triage-model's catalog entry (VS-29a); a dry run's only
  cases: string // where each case's checkout is prepared
  source: { vector?: string; manifest: string }
  io: Io
}

// What became of one case and variant in the dry branch: its record, or the line that says why there is none.
interface Projected {
  item: PlannedReplay
  variant: ReplayFlags["variants"][number]
  record?: ProjectionRecord
  line?: string
}

// The dry branch: each planned case, repetition 1 only (the canned model answers the same way every time), for each
// variant, through ReviewEval.project against the fake server, under the strict egress guard installed before any
// engine module loads. A case that cannot be projected is a line naming it, never a throw. Exit 0 only when every case
// and variant was projected with no problem and no connection left this computer.
async function projectDry(run: Run): Promise<number> {
  const { EgressGuard } = await import("@vectordevai/core/local-mode/guard")
  const guard = EgressGuard.installStrict()
  const { LocalPolicy } = await import("@vectordevai/core/local-mode/policy")
  const { AppRuntime } = await import("@/effect/app-runtime")
  const { InstanceStore } = await import("@/project/instance-store")
  const { InstanceRef } = await import("@/effect/instance-ref")
  const { ReviewEval } = await import("@/review/eval")
  const { ReviewSource } = await import("@/review/source")
  const { costSplit, projectionGroups, renderProjections } = await import("@vectordevai/core/review/eval-report")
  const { TestLLMServer } = await import("../test/lib/llm-server")
  const { firstUserText, projectionReplies, received } = await import("../test/fixture/projection")
  const flags = run.flags
  const cap = flags.limits?.caseUsd ?? PILOT.caseUsd
  // A variant's models, the review model first: a variant made by its models (VS-29a) adds the triage model, and every
  // other variant runs on the review model alone, as it does without --triage-model.
  const modelsOf = (variant: ReplayFlags["variants"][number]) => [
    flags.model.id,
    ...(variant.record?.models === "triage-pair" && run.triage ? [run.triage.id] : []),
  ]

  const program = Effect.gen(function* () {
    const llm = yield* TestLLMServer
    // Before the first instance loads its config.
    process.env.VECTOR_CONFIG_CONTENT = engineConfig({
      mode: "dry",
      server: llm.url,
      id: flags.model.id,
      entry: run.entry,
      ...(run.triage ? { triage: run.triage } : {}),
    })
    const store = yield* InstanceStore.Service
    const one = Effect.fnUntraced(function* (item: PlannedReplay, variant: ReplayFlags["variants"][number]) {
      const directory = checkoutDirectory(run.cases, `${item.id}#${variant.name}#1`)
      const ready = checkout(item, directory)
      if (ready) return { item, variant, line: ready }
      const paired = modelsOf(variant)[1]
      // The instance loads inside the exit, so a case whose instance cannot load is a line too.
      const exit = yield* Effect.acquireUseRelease(
        store.load({ directory }),
        (ctx) =>
          Effect.gen(function* () {
            const model = yield* projectionModel(flags.model.id)
            const triage = paired ? yield* projectionModel(paired) : undefined
            const files = yield* ReviewSource.prDiff({ directory, mergeBase: item.case.base, head: item.case.head })
            yield* llm.reset
            yield* llm.respond(projectionReplies({ files, ...(flags.scenario ? { scenario: flags.scenario } : {}) }))
            return yield* ReviewEval.project({
              case: { ...item.case, directory },
              model,
              ...(triage ? { triage } : {}),
              // VS-21e: the scenario's two variants differ only under verify: all (core plan.ts verifyCandidates).
              config: { maxCostUsd: cap, ...(flags.scenario ? { verify: "all" as const } : {}) },
              ...(variant.record ? { variant: variant.record } : {}),
              server: llm.url,
              received: received(llm),
              egress: guard.attempts,
              repetition: 1,
              source: run.source,
            })
          }).pipe(Effect.provideService(InstanceRef, ctx)),
        (ctx) => store.dispose(ctx),
      ).pipe(Effect.exit)
      rmSync(directory, { recursive: true, force: true })
      if (Exit.isFailure(exit)) return { item, variant, line: `not projected: ${failure(exit.cause)}` }
      return { item, variant, record: exit.value }
    })
    return yield* Effect.forEach(
      run.planned.flatMap((item) => flags.variants.map((variant) => ({ item, variant }))),
      (entry) => one(entry.item, entry.variant),
    )
  }).pipe(Effect.provide(TestLLMServer.loopback))

  const results = await AppRuntime.runPromise(program).finally(() => AppRuntime.dispose())
  const checked = results.map((result: Projected) => ({
    ...result,
    problems: result.record ? projectionProblems(result.record) : [],
  }))
  if (flags.out) {
    mkdirSync(flags.out, { recursive: true })
    for (const result of checked)
      if (result.record)
        writeFileSync(
          join(
            flags.out,
            `${outputName(modelsOf(result.variant), result.item.id, result.variant.name, 1)}.projection.json`,
          ),
          JSON.stringify(result.record, null, 2) + "\n",
        )
  }
  const projected = checked.flatMap((result) =>
    result.record && !result.problems.length ? [projectedRun(result.record)] : [],
  )
  const attempts = guard.attempts()
  const outside = attempts.filter((attempt) => !attempt.allowed || !LocalPolicy.loopback(attempt.host)).length
  // VS-21e, under --cost-split or --scenario only: how many candidates each case's verify pass was asked about, read
  // from its first request's decoded prompt (fixed claims are not candidates); 0 when no verify request was sent, and
  // n/a when that body is not a JSON object, so the run still reaches its summary and egress lines.
  const counted = flags.costSplit !== undefined || flags.scenario !== undefined
  const candidates = (record: ProjectionRecord | undefined) => {
    const body = record?.passes.find((pass) => pass.pass === "verify")?.requests[0]?.body
    if (!body) return 0
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
      body,
    )
    if (Option.isNone(decoded)) return "n/a"
    return [...firstUserText(decoded.value).matchAll(/<untrusted_candidate id="/g)].length
  }
  // The D6 check of the catalog prices the projections were priced with, under --cost-split only.
  const catalogPrice = (entry: CatalogEntry) => ({
    input: entry.cost.input,
    output: entry.cost.output,
    ...(entry.cost.cache_read === undefined ? {} : { cacheRead: entry.cost.cache_read }),
    ...(entry.cost.cache_write === undefined ? {} : { cacheWrite: entry.cost.cache_write }),
  })
  const warnings = flags.costSplit
    ? [
        ...listPriceWarnings(flags.model.id, catalogPrice(run.entry)),
        ...(run.triage ? listPriceWarnings(run.triage.id, catalogPrice(run.triage.entry)) : []),
      ]
    : []
  run.io.out(
    [
      `Dry projection of ${run.planned.length} case(s) x ${flags.variants.length} variant(s) on ${flags.model.id}${
        run.triage
          ? `, with ${run.triage.id} as the first pass of ${flags.variants
              .filter((variant) => modelsOf(variant).length > 1)
              .map((variant) => variant.name)
              .join(", ")} (the pair's labs unchecked until codium's labOf merges)`
          : ""
      }, repetition 1 only: the canned model answers the same way every time.`,
      ...(flags.scenario
        ? [
            `Scenario ${flags.scenario} (VS-21e): each case's canned review adds a nit with a suggestion, every variant runs under verify: all, and no record is written. Under engine:shared-verify an untrusted case's verify pass gets one more candidate than under engine.`,
          ]
        : []),
      ...checked.map(
        (result) =>
          `${result.item.id}  ${result.variant.name}  ${
            result.line ??
            (result.problems.length
              ? `problems: ${result.problems.join("; ")}`
              : `projected, ${requestsOf(result.record)} request(s)${counted ? `, ${candidates(result.record)} verify candidate(s)` : ""}`)
          }`,
      ),
      "",
      ...renderProjections(
        projectionGroups(projected),
        flags.costSplit
          ? costSplit(
              checked.flatMap((result) =>
                result.record && !result.problems.length ? projectedPassCosts(result.record) : [],
              ),
            )
          : undefined,
      ),
      ...(warnings.length ? ["", ...warnings] : []),
      "",
      `Dry run: nothing was sent. The strict egress guard logged ${attempts.length} connection attempts, ${outside} off this computer.`,
      "",
    ].join("\n"),
  )
  const clean = checked.every((result) => result.record && !result.problems.length)
  return clean && outside === 0 ? 0 : 1
}

// The paid branch: each development case, for each variant and repetition, through ReviewEval.replay with the eval's
// own key, every case admitted by the eval ledger first (admitReplay) and settled from its artifact, or at its whole
// bound when the replay failed. It stops at the first case the ledger refuses, and on SIGINT or SIGTERM. No test runs it.
// Its isolation is VECTOR_PURE, no project config, fresh roots, one provider and the protected environment; an egress
// allowlist for OpenRouter alone is not built yet and is a precondition for D7 (the deviation log).
async function replayPaid(run: Run & { key: string }): Promise<number> {
  await import("@vectordevai/core/local-mode/backstop")
  const { AppRuntime } = await import("@/effect/app-runtime")
  const { InstanceStore } = await import("@/project/instance-store")
  const { InstanceRef } = await import("@/effect/instance-ref")
  const { EffectBridge } = await import("@/effect/bridge")
  const { ReviewEval } = await import("@/review/eval")
  const { resolveReviewModel } = await import("@/review/model")
  const { SessionPosting } = await import("@/session/posting")
  const flags = run.flags
  const price = flags.model.price
  if (!flags.limits || !flags.out) return 2
  const out = flags.out
  process.env.VECTOR_CONFIG_CONTENT = engineConfig({ mode: "paid" })
  const opened = openLedger(flags.limits, flags.ledger)
  if (typeof opened === "string") {
    run.io.err(`${opened}\n`)
    return 2
  }
  const ledger = opened
  mkdirSync(out, { recursive: true })
  const abort = new AbortController()
  const interrupt = () => {
    ledger.cancel("interrupted")
    abort.abort()
  }
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)
  const lines: string[] = []
  const failed: string[] = []
  const queue = run.planned.flatMap((item) =>
    flags.variants.flatMap((variant) =>
      Array.from({ length: flags.repeat }, (_, index) => ({ item, variant, repetition: index + 1 })),
    ),
  )
  try {
    for (const entry of queue) {
      const stopped = ledger.summary()
      if (stopped.halted || stopped.cancelled) break
      const label = `${entry.item.id}  ${entry.variant.name}  r${entry.repetition}`
      const directory = checkoutDirectory(run.cases, `${entry.item.id}#${entry.variant.name}#${entry.repetition}`)
      const ready = checkout(entry.item, directory)
      if (ready) {
        lines.push(`${label}  ${ready}`)
        failed.push(label)
        continue
      }
      const exit = await AppRuntime.runPromiseExit(
        Effect.gen(function* () {
          const store = yield* InstanceStore.Service
          const ctx = yield* store.load({ directory })
          return yield* Effect.gen(function* () {
            const model = yield* resolveReviewModel({
              trigger: "command",
              env: { MODEL: `${PAID_PROVIDER}/${flags.model.id}` },
            })
            if (
              model.costKind !== "priced" ||
              model.price?.input !== price.input ||
              model.price.output !== price.output
            )
              return { refused: `${model.providerID}/${model.modelID} is not priced at ${price.input}:${price.output}` }
            const admission = admitReplay(ledger, {
              id: entry.item.id,
              repetition: entry.repetition,
              models: [{ id: `${model.providerID}/${model.modelID}`, costKind: model.costKind, price: model.price }],
              variant: entry.variant.name,
            })
            if (!admission.admitted) return { stopped: `${admission.reason}: ${admission.detail}` }
            const bridge = yield* EffectBridge.make()
            const artifact = yield* ReviewEval.replay({
              case: { ...entry.item.case, directory },
              model,
              config: admission.config,
              ...(admission.variant ? { variant: admission.variant } : {}),
              posting: ReviewEval.recordingPosting(),
              // The CLI's posting check (review.ts), headless: what overlaps the owner's memory is dropped.
              check: (call) =>
                bridge.run(
                  SessionPosting.headless({
                    parts: [...call.parts],
                    typed: false,
                    sessionIDs: call.sessionIDs,
                    untrusted: call.untrusted,
                    log: () => {},
                  }),
                ),
              secrets: [run.key],
              repetition: entry.repetition,
              source: run.source,
            }).pipe(
              // A failed replay keeps its whole bound as uncertain spend.
              Effect.onExit((done) =>
                Effect.sync(() => (Exit.isSuccess(done) ? admission.settle(done.value) : admission.settle())),
              ),
            )
            return { artifact }
          }).pipe(Effect.provideService(InstanceRef, ctx), Effect.ensuring(store.dispose(ctx)))
        }),
        { signal: abort.signal },
      )
      rmSync(directory, { recursive: true, force: true })
      if (Exit.isFailure(exit)) {
        lines.push(`${label}  failed: ${failure(exit.cause)}`)
        failed.push(label)
        continue
      }
      const result: { artifact?: ReplayArtifact; refused?: string; stopped?: string } = exit.value
      if (result.stopped) {
        lines.push(`${label}  not admitted (${result.stopped}); no later case starts`)
        failed.push(label)
        break
      }
      if (!result.artifact) {
        lines.push(`${label}  refused: ${result.refused ?? "no artifact"}`)
        failed.push(label)
        continue
      }
      // Directly in --out: ci.ts seal seals the top-level files only.
      writeFileSync(
        join(out, `${outputName([flags.model.id], entry.item.id, entry.variant.name, entry.repetition)}.json`),
        JSON.stringify(result.artifact, null, 2) + "\n",
      )
      lines.push(
        `${label}  replayed: ${result.artifact.attempts.filter((attempt) => attempt.admitted).length} admitted attempt(s)`,
      )
    }
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
    ledger.close()
    await AppRuntime.dispose()
  }
  const summary = ledger.summary()
  run.io.out([...lines, "", formatSummary(summary), ""].join("\n"))
  return failed.length || summary.halted || summary.cancelled ? 1 : 0
}

// Prepares a case's checkout, fresh for each case, variant and repetition, so nothing one run leaves in its directory
// reaches another, and checks it: a clean tree with the base checked out. Returns what is wrong, or undefined.
function checkout(item: PlannedReplay, directory: string): string | undefined {
  if (!item.mirror) return "no mirror"
  const problems = prepareCheckout({
    mirror: item.mirror,
    view: { repository: item.case.repository?.url ?? "", base: item.case.base, head: item.case.head },
    directory,
  })
  // Quoted on one line, as the mirror command quotes git's stderr: ci.ts relays this to the public log, where a line
  // of git's output that starts with "::" would be read as a workflow command.
  if (problems.length) return `checkout failed: ${JSON.stringify(problems.join("; "))}`
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...UNTRUSTED_GIT, "-C", directory, ...args], {
      env: untrustedGitEnv(),
      stdout: "pipe",
      stderr: "pipe",
    })
      .stdout.toString()
      .trim()
  if (git("status", "--porcelain") !== "") return "checkout failed: its tree is not clean"
  if (git("rev-parse", "HEAD") !== item.case.base) return "checkout failed: its base is not checked out"
  return undefined
}

function openLedger(limits: Limits, journal: string | undefined): Ledger | string {
  try {
    return Ledger.open({ limits, ...(journal ? { journal } : {}) })
  } catch (error) {
    if (error instanceof LedgerError) return error.message
    throw error
  }
}

// An output's name: the models, the case, the variant and the repetition, so two models sharing --out never overwrite
// each other. A pair's models (VS-29a), the review model first, are joined by "+" outside the slug, which never writes
// one, so one pair's name is never another's.
function outputName(models: readonly string[], id: string, variant: string, repetition: number) {
  const slug = (text: string) => text.replace(/[^A-Za-z0-9._-]/g, "_")
  return `${models.map(slug).join("+")}--${slug(id)}--${slug(variant)}--r${repetition}`
}

// The first line of a failure's first error, short: errors name case ids, commits and settings, never bodies.
function failure(cause: Cause.Cause<unknown>) {
  const message = Cause.prettyErrors(cause)[0]?.message ?? "the replay failed"
  return message.split("\n")[0]!.slice(0, 300)
}

function requestsOf(record: ProjectionRecord | undefined) {
  return record ? record.passes.reduce((total, pass) => total + pass.requests.length, 0) : 0
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

if (import.meta.main)
  process.exit(
    await main(process.argv.slice(2), {
      env: process.env,
      out: (text) => void process.stdout.write(text),
      err: (text) => void process.stderr.write(text),
    }),
  )
