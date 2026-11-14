#!/usr/bin/env bun
// Prompt evolution: prompt variants of Vector's own agents against deterministic offline suites, and against a real
// model only when the owner asks, written up as report.json and report.md. It never edits a prompt; the owner promotes
// a winner by hand as a normal code change (README.md). Every arm runs one after another, never side by side.
//
//   bun script/agent-eval/prompt-evolve/run.ts --variants a,b [--suite scripted,footprint,replay] [--out dir] [--archive]
//     [--tasks t01-slugify] [--scenario solo-fix] [--traces name] [--variants-dir dir] [--dry-run] [--keep]
//   bun script/agent-eval/prompt-evolve/run.ts --variants a --live --yes --max-spend 5 --prices prices.json \
//     --model anthropic/claude-sonnet-4-5 --auth-env ANTHROPIC_API_KEY --allow-remote [--repeat 5] [--live-tasks id,...]

import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, relative, resolve } from "node:path"
import { providerPromptFile } from "../../../packages/engine/src/session/provider-prompt"
import { runArm } from "../compounding/harness"
import { RATES } from "../compounding/measure"
import { createPromptCache, price, type Recorded } from "../prompt-cache"
import { required } from "./contracts"
import { check, live, rates, type LiveOptions } from "./live"
import { decideByClauses, systemText } from "./policy"
import { replay } from "./replay"
import { OFFLINE, archivable, build, markdown, type Arm, type Measure, type Suite } from "./report"
import { list, read, type Trace } from "./traces"
import { AGENT_PROMPTS, DIR, HARNESS_BASE, PROVIDER_PROMPTS, REPO_ROOT, load, render, type Variant } from "./variants"

export type Options = {
  readonly variants: readonly string[]
  readonly variantsDir?: string
  readonly suites: readonly Suite[]
  readonly tasks?: readonly string[]
  readonly scenarios?: readonly string[]
  readonly traces?: readonly string[]
  readonly out: string
  readonly archive: boolean
  readonly dryRun: boolean
  readonly keep: boolean
  readonly live?: LiveOptions
}

const BOOLEAN = ["archive", "dry-run", "keep", "live", "yes", "allow-remote"]
const VALUE = [
  "variants",
  "variants-dir",
  "suite",
  "tasks",
  "scenario",
  "traces",
  "out",
  "max-spend",
  "prices",
  "model",
  "auth-env",
  "base-url",
  "repeat",
  "live-tasks",
]

/** The options a command line asks for, or why it is refused. Nothing runs and nothing is written here. */
export function parse(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): { readonly options: Options } | { readonly error: string } {
  const unknown = argv.filter((token) => token.startsWith("--") && ![...BOOLEAN, ...VALUE].includes(token.slice(2)))
  if (unknown.length) return { error: `Unknown option ${unknown.join(", ")}` }
  const flags: Record<string, string | boolean> = Object.fromEntries(
    argv.flatMap((token, at) =>
      token.startsWith("--") ? [[token.slice(2), BOOLEAN.includes(token.slice(2)) ? true : (argv[at + 1] ?? "")]] : [],
    ),
  )
  const values = (name: string) =>
    typeof flags[name] === "string" ? (flags[name] as string).split(",").filter(Boolean) : undefined
  const suites = (values("suite") ?? [...OFFLINE]) as Suite[]
  const bad = suites.filter((suite) => !OFFLINE.includes(suite))
  if (bad.length) return { error: `Unknown suite ${bad.join(", ")}. Suites: ${OFFLINE.join(", ")}` }
  const out = resolve(
    typeof flags.out === "string"
      ? flags.out
      : join(tmpdir(), `prompt-evolve-${new Date().toISOString().replace(/[:.]/g, "-")}`),
  )
  if (!relative(join(REPO_ROOT, "packages"), out).startsWith(".."))
    return { error: "--out may not be under packages/: the harness never writes there." }
  if (flags.live === true && flags["dry-run"] === true) return { error: "A dry run runs nothing: leave out --live." }
  const liveOptions = flags.live === true ? check(flags, env) : undefined
  if (liveOptions && "refused" in liveOptions) return { error: liveOptions.refused }
  // Every provider-prompt variant, identity included, starts from HARNESS_BASE, while the baseline gets the prompt the
  // model ships with. On a model that gets another, the control is not the shipped prompt and Δpass compares two bases.
  const shipped =
    liveOptions && `${PROVIDER_PROMPTS}/${providerPromptFile(liveOptions.model.split("/").slice(1).join("/"))}`
  if (shipped && shipped !== HARNESS_BASE)
    return {
      error: `--model ${liveOptions!.model} gets ${basename(shipped)}, but the variants start from ${basename(HARNESS_BASE)}: pick a model that gets ${basename(HARNESS_BASE)}, or the live arm compares two different prompts.`,
    }
  if (flags.archive === true) {
    const refused = archivable({ suites, live: flags.live === true })
    if (refused) return { error: refused }
    if (flags["dry-run"] === true)
      return { error: "--archive copies a report into docs/benchmarks, and a dry run writes only under --out." }
  }
  return {
    options: {
      variants: values("variants") ?? [],
      ...(typeof flags["variants-dir"] === "string" ? { variantsDir: resolve(flags["variants-dir"]) } : {}),
      suites,
      ...(values("tasks") ? { tasks: values("tasks") } : {}),
      ...(values("scenario") ? { scenarios: values("scenario") } : {}),
      ...(values("traces") ? { traces: values("traces") } : {}),
      out,
      archive: flags.archive === true,
      dryRun: flags["dry-run"] === true,
      keep: flags.keep === true,
      ...(liveOptions ? { live: liveOptions } : {}),
    },
  }
}

export async function main(options: Options) {
  const variants = await choose(options)
  const rendered = await Promise.all(variants.map((variant) => render(variant, { explore: true })))
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  const arms = [
    { id: "baseline", config: { permission: { memory: "deny" } } },
    ...variants.map((variant, at) => ({
      id: variant.id,
      config: { agent: { [variant.agent]: { prompt: rendered[at]! } }, permission: { memory: "deny" } },
      rendered: rendered[at]!,
    })),
  ]
  const results = options.dryRun ? arms.map((): Arm => ({ suites: {} })) : await offline(arms, options)
  const lived = options.live ? await live({ arms, options: options.live, rates: await rates(options.live) }) : undefined
  const meta = {
    date,
    revision:
      Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim() || "unknown",
    command: ["bun script/agent-eval/prompt-evolve/run.ts", ...process.argv.slice(2)].join(" "),
    suites: options.suites,
    live: options.live !== undefined,
    dryRun: options.dryRun,
    ...(options.live && lived
      ? {
          liveRun: {
            model: options.live.model,
            tasks: options.live.tasks,
            repeat: options.live.repeat,
            maxSpend: options.live.maxSpend,
            spent: lived.spent,
            stopped: lived.stopped,
          },
        }
      : {}),
  }
  const report = await build({
    meta,
    baseline: { ...results[0]!, ...(lived ? { live: lived.runs.baseline } : {}) },
    variants: variants.map((variant, at) => ({
      variant,
      rendered: rendered[at]!,
      arm: { ...results[at + 1]!, ...(lived ? { live: lived.runs[variant.id] } : {}) },
    })),
  })
  await mkdir(options.out, { recursive: true })
  await writeFile(join(options.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(join(options.out, "report.md"), markdown(report))
  if (options.archive) {
    const target = join(REPO_ROOT, "docs", "benchmarks", `prompt-evolve-${date}`)
    await mkdir(target, { recursive: true })
    for (const file of ["report.json", "report.md"]) await cp(join(options.out, file), join(target, file))
  }
  for (const variant of report.variants)
    process.stdout.write(
      `${variant.id.padEnd(16)} ${variant.promotable ? "promotable" : variant.candidate ? "candidate" : "not a candidate"}${variant.reasons.length ? `: ${variant.reasons.join("; ")}` : ""}\n`,
    )
  process.stdout.write(
    `${report.status}${report.invalid.length ? `: ${report.invalid.join("; ")}` : ""}\nReport: ${join(options.out, "report.md")}\n`,
  )
  return report.status === "invalid" ? 1 : 0
}

// The identity control and the variants asked for, each measured against the prompt the harness's model gets.
async function choose(options: Options) {
  const known = [...(await load(DIR)), ...(options.variantsDir ? await load(options.variantsDir) : [])]
  const missing = options.variants.filter((id) => !known.some((variant) => variant.id === id))
  if (missing.length)
    throw new Error(`Unknown variant ${missing.join(", ")}. Variants: ${known.map((variant) => variant.id).join(", ")}`)
  const variants = known.filter((variant) => variant.id === "identity" || options.variants.includes(variant.id))
  for (const variant of variants) {
    const expected = variant.base.startsWith(`${PROVIDER_PROMPTS}/`)
      ? HARNESS_BASE
      : `${AGENT_PROMPTS}/${variant.agent}.txt`
    if (variant.base !== expected)
      throw new Error(
        `Variant ${variant.id} starts from ${variant.base}, but agent ${variant.agent} gets ${expected} in the harness.`,
      )
  }
  return variants
}

// Every offline suite asked for, arm by arm. A suite that fails for an arm leaves it unmeasured there, and the report
// says so; it is never counted as zero.
async function offline(
  arms: readonly { readonly id: string; readonly config: Record<string, unknown>; readonly rendered?: string }[],
  options: Options,
) {
  const work = await mkdtemp(join(tmpdir(), "vector-prompt-evolve-"))
  const recorded = options.suites.includes("replay")
    ? await Promise.all((options.traces ?? (await list())).map(async (name) => ({ name, trace: await read(name) })))
    : []
  for (const item of recorded.filter((item) => !item.trace.repo))
    process.stderr.write(
      `Trace ${item.name} names no repository to clone; record it again with --repo. It is skipped.\n`,
    )
  const traces = recorded.flatMap((item) => (item.trace.repo ? [item.trace] : []))
  if (options.suites.includes("replay") && traces.length === 0)
    process.stderr.write("No traces to replay: record one with traces.ts. The replay suite does not run.\n")
  const results: Arm[] = []
  for (const [at, arm] of arms.entries()) {
    // Folders of one length, since every request carries the repository's path.
    const dir = join(work, `arm-${String(at).padStart(2, "0")}`)
    const suites: Partial<Record<Suite, Measure>> = {}
    for (const suite of options.suites) {
      process.stderr.write(`${arm.id}: ${suite}\n`)
      const measured =
        suite === "scripted"
          ? await scripted(arm.config, join(dir, "scripted"), options.tasks, arm.rendered)
          : suite === "footprint"
            ? await footprint(arm.config, join(dir, "footprint"), options.scenarios, arm.rendered)
            : traces.length
              ? await replayed(arm.config, traces, arm.rendered)
              : undefined
      if (typeof measured === "string") {
        process.stderr.write(`  ${arm.id} ${suite} failed: ${measured}\n`)
        continue
      }
      if (measured) suites[suite] = measured
    }
    results.push({ suites })
  }
  if (!options.keep) await rm(work, { recursive: true, force: true })
  return results
}

async function scripted(
  config: Record<string, unknown>,
  root: string,
  tasks: readonly string[] | undefined,
  rendered: string | undefined,
) {
  const dump = `${root}-dump`
  const clauses = required(HARNESS_BASE)
  const runs = await runArm({
    arm: "off",
    root,
    ...(tasks ? { tasks } : {}),
    dump,
    config,
    decide: (task, start, body, options) => decideByClauses(task, start, body, { ...options, clauses }),
  })
  const broken = runs.filter((run) => run.scriptError || run.exitCode !== 0)
  if (broken.length) return broken.map((run) => `${run.task}: ${run.scriptError ?? `exit ${run.exitCode}`}`).join("; ")
  const requests = await Promise.all(
    runs.map(async (run) => (await Bun.file(join(dump, `off-${run.task}.json`)).json()).requests as Recorded[]),
  )
  return (
    unseen(requests, rendered) ?? {
      runs: runs.length,
      passed: runs.filter((run) => run.success).length,
      ...priced(requests),
    }
  )
}

async function footprint(
  config: Record<string, unknown>,
  dir: string,
  scenarios: readonly string[] | undefined,
  rendered: string | undefined,
) {
  await mkdir(dir, { recursive: true })
  const ran = []
  for (const [at, scenario] of (scenarios ?? [undefined]).entries()) {
    const out = join(dir, `report-${at}.json`)
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "..", "footprint.ts"),
        "--runtime",
        "vector",
        ...(scenario ? ["--scenario", scenario] : []),
        "--config-content",
        JSON.stringify(config),
        "--out",
        out,
        "--dump",
        join(dir, "dump"),
      ],
      { cwd: REPO_ROOT, stdout: "ignore", stderr: "pipe" },
    )
    const stderr = await new Response(child.stderr).text()
    ran.push({ exitCode: await child.exited, stderr, out })
  }
  const failed = ran.find((item) => item.exitCode !== 0)
  if (failed) return `footprint exited ${failed.exitCode}: ${failed.stderr.slice(-600)}`
  const reports = await Promise.all(
    ran.map(async (item) => (await Bun.file(item.out).json()).scenarios as { scenario: string; session: number }[]),
  )
  const requests = await Promise.all(
    reports
      .flat()
      .map(
        async (item) =>
          (await Bun.file(join(dir, "dump", `vector-${item.scenario}-${item.session}.json`)).json()) as Recorded[],
      ),
  )
  return unseen(requests, rendered) ?? { runs: requests.length, ...priced(requests) }
}

async function replayed(config: Record<string, unknown>, traces: readonly Trace[], rendered: string | undefined) {
  const runs = []
  for (const item of traces) {
    const run = await replay(item, { config }).catch((error: Error) => error.message)
    if (typeof run === "string") return run
    runs.push(run)
  }
  const failed = runs.find((run) => run.exitCodes.some((code) => code !== 0))
  if (failed) return `vector run exited ${failed.exitCodes.join(", ")}: ${failed.output.slice(-600)}`
  const requests = runs.map((run) => run.requests)
  return unseen(requests, rendered) ?? { runs: runs.length, ...priced(requests) }
}

/**
 * Why a suite measured an arm's prompt as some other prompt: none of its requests carried the arm's rendered text in its
 * system prompt. If the harness, footprint or replay stopped passing a variant's config on, every variant would run the
 * shipped prompt and report its numbers as their own; the suite is left unmeasured instead, never counted.
 */
export function unseen(runs: readonly (readonly Recorded[])[], rendered: string | undefined) {
  if (rendered === undefined) return undefined
  const text = rendered.trim()
  return runs.flat().some((request) => systemText(request.body).includes(text))
    ? undefined
    : "no request carried the variant's prompt, so the suite measured some other prompt"
}

// Each run priced on its own cache at the offline rates. The test runner prints how long it took, which moves a request
// by a token from one run to the next, so durations are masked first: the same requests always cost the same.
function priced(runs: readonly (readonly Recorded[])[]) {
  const steady = (request: Recorded): Recorded => ({
    ...request,
    body: JSON.parse(JSON.stringify(request.body).replace(/\d+(?:\.\d+)?(?:ms|s)\b/g, "0ms")),
  })
  const costs = runs.flatMap((requests) => price(requests.map(steady), createPromptCache(), RATES))
  const sum = (pick: (cost: (typeof costs)[number]) => number) => costs.reduce((total, cost) => total + pick(cost), 0)
  return {
    inputTokens: sum((cost) => cost.inputTokens),
    outputTokens: sum((cost) => cost.outputTokens),
    cacheRead: sum((cost) => cost.cacheRead),
    usd: Math.round(sum((cost) => cost.costUsd) * 1e6) / 1e6,
  }
}

if (import.meta.main) {
  const parsed = parse(process.argv.slice(2))
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`)
    process.exit(2)
  }
  process.exitCode = await main(parsed.options).catch((error: Error) => {
    process.stderr.write(`${error.message}\n`)
    return 2
  })
}
