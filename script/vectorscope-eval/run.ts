#!/usr/bin/env bun
import { writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { parseArgs } from "node:util"
import { DEFAULT_SLACK, scoreReview, totalScores, type ReviewScore } from "../../packages/core/src/review/eval"
import { buildReviewPrompt } from "../../packages/core/src/review/prompt"
import { decodeReport, REVIEW_REPORT_JSON_SCHEMA } from "../../packages/core/src/review/schema"
import type { ModelReport } from "../../packages/core/src/review/types"
import { fixtureProblems, fixtureView, listFixtures, loadFixture, promptInput, type Fixture } from "./fixture"

// Sends Vectorscope's review prompt for each fixture to one model, once per repetition, and scores the findings
// against the planted bugs. A run that could not be measured (an HTTP error, a timeout, an answer with no report in
// it) is reported as an error and left out of the totals: it is neither a clean review nor a missed bug.

const REPO_ROOT = join(import.meta.dir, "..", "..")
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1/chat/completions"
const DEFAULT_API_KEY_ENV = "OPENROUTER_API_KEY"
const ERROR_CHARS = 300

// The review prompt is written for an agent with read-only tools and a StructuredOutput tool. This run has neither,
// so the model is told what it can see and to answer with the report itself.
const SYSTEM = [
  "This is an offline evaluation run of a code review prompt. No tools are available: you cannot read, grep, glob or list files, and you cannot call StructuredOutput.",
  "Everything there is to see is in the user message. The changed files are inlined in full in `<untrusted_pr_file>` blocks; files the change does not touch are not available.",
  "Answer with only the JSON object you would pass to StructuredOutput. It must match this JSON Schema:",
  JSON.stringify(REVIEW_REPORT_JSON_SCHEMA),
].join("\n")

const USAGE = `Usage: bun script/vectorscope-eval/run.ts --model <id> [options]

  --model <id>          Model id sent to the endpoint, such as anthropic/claude-sonnet-4.5 on OpenRouter
  --fixture <names>     Comma-separated fixture names (default: all)
  --repeat <n>          Run each fixture n times, 1-20 (default 1)
  --base-url <url>      OpenAI-compatible chat completions URL (default ${DEFAULT_BASE_URL})
  --api-key-env <name>  Environment variable that holds the API key (default ${DEFAULT_API_KEY_ENV})
  --slack <lines>       Lines a finding may be away from a planted bug and still match (default ${DEFAULT_SLACK})
  --count-nits          Score nit findings too (default: ignored)
  --max-tokens <n>      max_tokens for each request (default: the provider's)
  --timeout <sec>       Per-request timeout (default 300)
  --out <path>          Also write a JSON report there; it must be outside the repository
  --dry-run             Validate the fixtures and print prompt sizes without any network call
  --list                Print the fixtures and exit
  --help                Print this message
`

const OPTIONS = {
  model: { type: "string" },
  fixture: { type: "string" },
  repeat: { type: "string" },
  "base-url": { type: "string" },
  "api-key-env": { type: "string" },
  slack: { type: "string" },
  "count-nits": { type: "boolean" },
  "max-tokens": { type: "string" },
  timeout: { type: "string" },
  out: { type: "string" },
  "dry-run": { type: "boolean" },
  list: { type: "boolean" },
  help: { type: "boolean" },
} as const

type Flags = Exclude<ReturnType<typeof parseFlags>, string>

type Usage = { input?: number; output?: number; cached?: number; reasoning?: number; costUsd?: number }

type Run = {
  fixture: string
  attempt: number
  ms: number
  format?: "json_schema" | "text"
  finishReason?: string
  usage?: Usage
} & (
  | { status: "scored"; report: ModelReport; score: ReviewScore }
  | { status: "error"; detail: string; content?: string }
)

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  if (typeof flags === "string") {
    process.stderr.write(`${flags}\n\n${USAGE}`)
    return 2
  }
  if (flags.help) {
    process.stdout.write(USAGE)
    return 0
  }

  const names = await listFixtures()
  const requested = flags.fixture?.split(",").map((name) => name.trim()) ?? names
  const unknown = requested.filter((name) => !names.includes(name))
  if (unknown.length) {
    process.stderr.write(`Unknown fixture(s): ${unknown.join(", ")}. Run with --list to see them.\n`)
    return 2
  }
  const fixtures = await Promise.all(requested.map(loadFixture))
  if (flags.list) {
    process.stdout.write(
      formatTable([
        ["FIXTURE", "FILES", "CHANGED", "PLANTED", "TITLE"],
        ...fixtures.map((fixture) => [
          fixture.name,
          String(fixture.files.length),
          `+${sum(fixture.files.map((file) => file.additions))} -${sum(fixture.files.map((file) => file.deletions))}`,
          fixture.expected.map((expectation) => expectation.id).join(", ") || "none (clean)",
          fixture.pr.title,
        ]),
      ]) + "\n",
    )
    return 0
  }

  const invalid = fixtures.flatMap((fixture) =>
    fixtureProblems(fixture).map((problem) => `${fixture.name}: ${problem}`),
  )
  if (invalid.length) {
    process.stderr.write(`Invalid fixtures:\n${invalid.map((line) => `  ${line}`).join("\n")}\n`)
    return 1
  }
  const prompts = fixtures.map((fixture) => ({ fixture, prompt: buildReviewPrompt(promptInput(fixtureView(fixture))) }))
  if (flags.dryRun) {
    process.stdout.write(dryRunReport(prompts) + "\n")
    return 0
  }

  if (!flags.model) {
    process.stderr.write(`--model is required unless --dry-run or --list is given.\n\n${USAGE}`)
    return 2
  }
  const apiKey = process.env[flags.apiKeyEnv]
  if (!apiKey) {
    process.stderr.write(
      `Set ${flags.apiKeyEnv} to an API key for ${new URL(flags.baseUrl).host}, or name another variable with --api-key-env.\n`,
    )
    return 2
  }

  const startedAt = new Date().toISOString()
  process.stderr.write(`Reviewing ${prompts.length} fixture(s) x ${flags.repeat} with ${flags.model}\n`)
  const runs: Run[] = []
  for (const entry of prompts)
    for (const attempt of Array.from({ length: flags.repeat }, (_, index) => index + 1)) {
      const run = await review({ ...entry, attempt, flags, apiKey })
      process.stderr.write(
        `  ${label(run, flags.repeat)}: ${run.status === "scored" ? scoreLine(run.score) : run.detail}\n`,
      )
      runs.push(run)
    }

  process.stdout.write("\n" + renderReport(runs, prompts, flags) + "\n")
  if (flags.out) {
    const report = {
      startedAt,
      completedAt: new Date().toISOString(),
      model: flags.model,
      baseUrl: flags.baseUrl,
      slack: flags.slack,
      countNits: flags.countNits,
      repeat: flags.repeat,
      totals: totalScores(scored(runs).map((run) => run.score)),
      runs,
    }
    await writeFile(flags.out, JSON.stringify(report, null, 2) + "\n")
    process.stdout.write(`\nJSON report: ${flags.out}\n`)
  }
  return runs.some((run) => run.status === "error") ? 1 : 0
}

async function review(input: {
  fixture: Fixture
  prompt: string
  attempt: number
  flags: Flags
  apiKey: string
}): Promise<Run> {
  const started = performance.now()
  const run = { fixture: input.fixture.name, attempt: input.attempt }
  const body = {
    model: input.flags.model,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: input.prompt },
    ],
    ...(input.flags.maxTokens ? { max_tokens: input.flags.maxTokens } : {}),
    // OpenRouter reports the request's cost only when asked; other OpenAI-compatible servers may reject the field.
    ...(new URL(input.flags.baseUrl).host === "openrouter.ai" ? { usage: { include: true } } : {}),
  }
  const structured = await post(input, {
    ...body,
    response_format: { type: "json_schema", json_schema: { name: "review", schema: REVIEW_REPORT_JSON_SCHEMA } },
  })
  const answer = rejectsFormat(structured)
    ? { ...(await post(input, body)), format: "text" as const }
    : { ...structured, format: "json_schema" as const }
  const ms = Math.round(performance.now() - started)
  if (!answer.ok) return { ...run, ms, format: answer.format, status: "error", detail: answer.detail }

  const choice = record(list(answer.json.choices)[0])
  const message = record(choice?.message)
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined
  const content = typeof message?.content === "string" ? message.content : ""
  const measured = { ...run, ms, format: answer.format, finishReason, usage: readUsage(answer.json.usage) }
  const report = content ? decodeReport(content) : undefined
  if (!report)
    return {
      ...measured,
      status: "error",
      detail: content
        ? `no review report in the answer${finishReason === "length" ? " (it was cut off at max_tokens)" : ""}`
        : `empty answer (finish_reason ${finishReason ?? "missing"})`,
      content,
    }
  return {
    ...measured,
    status: "scored",
    report,
    score: scoreReview({
      expected: input.fixture.expected,
      findings: report.findings,
      slack: input.flags.slack,
      countNits: input.flags.countNits,
    }),
  }
}

async function post(input: { flags: Flags; apiKey: string }, body: object) {
  const response = await fetch(input.flags.baseUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(input.flags.timeout * 1000),
  }).catch((error: unknown) => error)
  if (!(response instanceof Response))
    return {
      ok: false as const,
      status: 0,
      raw: "",
      detail: clean(input.apiKey, `request failed: ${String(response)}`),
    }
  const json = record(
    await response
      .clone()
      .json()
      .catch(() => undefined),
  )
  const raw = await response.text()
  // OpenRouter can answer 200 with an error object when the upstream provider fails, and puts the provider's own
  // message in metadata.raw.
  const error = record(json?.error)
  if (!response.ok || !json || error) {
    const said = [error?.message, record(error?.metadata)?.raw].filter((part) => typeof part === "string").join(": ")
    return {
      ok: false as const,
      status: response.status,
      raw,
      detail: clean(input.apiKey, `HTTP ${response.status}: ${said || raw}`),
    }
  }
  return { ok: true as const, status: response.status, json }
}

// Providers that cannot force a JSON schema say so with a 4xx that names the parameter. Anything else is a real
// failure and is not retried, so a bad key or model is not billed for twice.
function rejectsFormat(answer: Awaited<ReturnType<typeof post>>) {
  return (
    !answer.ok &&
    [400, 404, 415, 422].includes(answer.status) &&
    /response_format|json_schema|structured output|schema|no endpoints found/i.test(answer.raw)
  )
}

function readUsage(value: unknown): Usage | undefined {
  const usage = record(value)
  if (!usage) return undefined
  const result = {
    input: count(usage.prompt_tokens),
    output: count(usage.completion_tokens),
    cached: count(record(usage.prompt_tokens_details)?.cached_tokens),
    reasoning: count(record(usage.completion_tokens_details)?.reasoning_tokens),
    costUsd: count(usage.cost),
  }
  return Object.values(result).some((entry) => entry !== undefined) ? result : undefined
}

function dryRunReport(prompts: { fixture: Fixture; prompt: string }[]) {
  const rows = prompts.map((entry) => [
    entry.fixture.name,
    String(entry.fixture.files.length),
    `+${sum(entry.fixture.files.map((file) => file.additions))} -${sum(entry.fixture.files.map((file) => file.deletions))}`,
    String(entry.fixture.expected.length),
    String(entry.prompt.length + SYSTEM.length),
    `~${compact(Math.ceil((entry.prompt.length + SYSTEM.length) / 4))}`,
  ])
  const chars = sum(prompts.map((entry) => entry.prompt.length + SYSTEM.length))
  return [
    formatTable([["FIXTURE", "FILES", "CHANGED", "PLANTED", "PROMPT CHARS", "TOKENS"], ...rows]),
    "",
    `${prompts.length} fixture(s) valid. ${chars} prompt characters in all, about ${compact(Math.ceil(chars / 4))} input tokens per repetition (characters / 4).`,
    "Dry run: no requests were sent.",
  ].join("\n")
}

function renderReport(runs: Run[], prompts: { fixture: Fixture }[], flags: Flags) {
  const rows = runs.map((run) => {
    const planted = prompts.find((entry) => entry.fixture.name === run.fixture)?.fixture.expected.length ?? 0
    const usage = [
      run.usage?.input === undefined && run.usage?.output === undefined
        ? "—"
        : compact((run.usage?.input ?? 0) + (run.usage?.output ?? 0)),
      run.usage?.costUsd === undefined ? "unknown" : `$${run.usage.costUsd.toFixed(4)}`,
      `${(run.ms / 1000).toFixed(1)}s`,
    ]
    if (run.status === "error")
      return [label(run, flags.repeat), String(planted), "error", "—", "—", "—", "—", "—", "—", ...usage]
    return [
      label(run, flags.repeat),
      String(planted),
      String(run.report.findings.length),
      String(run.score.truePositives),
      String(run.score.falsePositives),
      String(run.score.falseNegatives),
      run.score.precision.toFixed(2),
      run.score.recall.toFixed(2),
      run.score.f1.toFixed(2),
      ...usage,
    ]
  })
  const table = formatTable([
    ["FIXTURE", "PLANTED", "FINDINGS", "TP", "FP", "FN", "PRECISION", "RECALL", "F1", "TOKENS", "COST", "TIME"],
    ...rows,
  ])
  const done = scored(runs)
  const errors = runs.length - done.length
  const total = totalScores(done.map((run) => run.score))
  const costs = runs.map((run) => run.usage?.costUsd)
  const known = costs.filter((cost) => cost !== undefined)
  const tokens = runs.filter((run) => run.usage?.input !== undefined || run.usage?.output !== undefined)
  const headline = done.length
    ? [
        `TP ${total.truePositives}`,
        `FP ${total.falsePositives}`,
        `FN ${total.falseNegatives}`,
        `precision ${total.precision.toFixed(2)}`,
        `recall ${total.recall.toFixed(2)}`,
        `F1 ${total.f1.toFixed(2)}`,
      ].join(" · ")
    : "no runs were scored"
  const spend = [
    tokens.length === runs.length
      ? `${compact(sum(tokens.map((run) => (run.usage?.input ?? 0) + (run.usage?.output ?? 0))))} tokens`
      : `tokens reported for ${tokens.length}/${runs.length} runs`,
    known.length === runs.length
      ? `cost $${sum(known).toFixed(4)}`
      : `cost unknown (${known.length}/${runs.length} runs reported one${known.length ? `, $${sum(known).toFixed(4)} between them` : ""})`,
  ].join(" · ")
  const notes = runs.flatMap((run) => {
    if (run.status === "error") return [`  ${label(run, flags.repeat)}: error: ${run.detail}`]
    const expected = prompts.find((entry) => entry.fixture.name === run.fixture)?.fixture.expected ?? []
    const matched = new Set(run.score.matches.map((match) => match.finding))
    const missed = expected.filter(
      (expectation) => !run.score.matches.some((match) => match.expected === expectation.id),
    )
    const alarms = run.report.findings.flatMap((finding, index) =>
      matched.has(index) || (finding.severity === "nit" && !flags.countNits)
        ? []
        : [`false alarm ${finding.path}:${finding.line} [${finding.severity}] ${finding.title}`],
    )
    return [
      ...missed.map((expectation) => `missed ${expectation.id} (${expectation.path}:${expectation.line})`),
      ...alarms,
    ].map((note) => `  ${label(run, flags.repeat)}: ${note}`)
  })
  return [
    `${flags.model} via ${new URL(flags.baseUrl).host} · slack ${flags.slack} · nits ${flags.countNits ? "counted" : "ignored"}`,
    table,
    "",
    `Totals over ${done.length} scored run(s)${errors ? `, ${errors} error(s) left out` : ""}: ${headline}`,
    spend,
    ...(notes.length ? ["", "Misses, false alarms and errors:", ...notes] : []),
  ].join("\n")
}

function parseFlags(argv: string[]) {
  const parsed = parseArgs({ args: argv, options: OPTIONS, strict: false, allowPositionals: true })
  const known = new Set(Object.keys(OPTIONS))
  const unknown = Object.keys(parsed.values).filter((name) => !known.has(name))
  if (unknown.length) return `Unknown option(s): ${unknown.map((name) => `--${name}`).join(", ")}`
  if (parsed.positionals.length) return `Unexpected argument(s): ${parsed.positionals.join(" ")}`
  const values = parsed.values
  const valueless = Object.entries(OPTIONS)
    .filter(
      ([name, option]) => option.type === "string" && values[name] !== undefined && typeof values[name] !== "string",
    )
    .map(([name]) => `--${name}`)
  if (valueless.length) return `Missing value for ${valueless.join(", ")}`
  const text = (name: keyof typeof OPTIONS) => (typeof values[name] === "string" ? values[name] : undefined)
  const out = text("out")
  const flags = {
    model: text("model"),
    fixture: text("fixture"),
    repeat: Number(text("repeat") ?? 1),
    baseUrl: text("base-url") ?? DEFAULT_BASE_URL,
    apiKeyEnv: text("api-key-env") ?? DEFAULT_API_KEY_ENV,
    slack: Number(text("slack") ?? DEFAULT_SLACK),
    countNits: values["count-nits"] === true,
    maxTokens: text("max-tokens") === undefined ? undefined : Number(text("max-tokens")),
    timeout: Number(text("timeout") ?? 300),
    out: out === undefined ? undefined : resolve(out),
    dryRun: values["dry-run"] === true,
    list: values.list === true,
    help: values.help === true,
  }
  if (!Number.isInteger(flags.repeat) || flags.repeat < 1 || flags.repeat > 20)
    return "--repeat must be an integer from 1 to 20."
  if (!Number.isInteger(flags.slack) || flags.slack < 0) return "--slack must be a whole number of lines."
  if (flags.maxTokens !== undefined && (!Number.isInteger(flags.maxTokens) || flags.maxTokens < 1))
    return "--max-tokens must be a positive integer."
  if (!Number.isFinite(flags.timeout) || flags.timeout <= 0) return "--timeout must be a positive number of seconds."
  if (!URL.canParse(flags.baseUrl)) return `--base-url is not a URL: ${flags.baseUrl}`
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(flags.apiKeyEnv)) return "--api-key-env must name an environment variable."
  // Results are kept out of the repository, like the agent eval's: numbers from one session are not a benchmark.
  const inside = flags.out === undefined ? "" : relative(REPO_ROOT, flags.out)
  if (flags.out !== undefined && !inside.startsWith("..") && !isAbsolute(inside))
    return `--out must be outside the repository (${REPO_ROOT}).`
  return flags
}

function scored(runs: Run[]) {
  return runs.flatMap((run) => (run.status === "scored" ? [run] : []))
}

function label(run: { fixture: string; attempt: number }, repeat: number) {
  return repeat > 1 ? `${run.fixture}#${run.attempt}` : run.fixture
}

function scoreLine(score: ReviewScore) {
  return `TP ${score.truePositives} FP ${score.falsePositives} FN ${score.falseNegatives}`
}

// Provider errors sometimes quote the request; the key must never reach the terminal or the report.
function clean(apiKey: string, text: string) {
  const flat = text.replaceAll(apiKey, "[redacted]").replace(/\s+/g, " ").trim()
  return flat.length > ERROR_CHARS ? flat.slice(0, ERROR_CHARS) + "…" : flat
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0)
}

function compact(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
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

process.exit(await main())
