#!/usr/bin/env bun
import { writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { parseArgs } from "node:util"
import { DEFAULT_SLACK, scoreReview, totalScores, type ReviewScore } from "../../packages/core/src/review/eval"
import { buildReviewPrompt } from "../../packages/core/src/review/prompt"
import { decodeReport, REVIEW_REPORT_JSON_SCHEMA } from "../../packages/core/src/review/schema"
import type { ModelReport } from "../../packages/core/src/review/types"
import {
  CHARS_PER_TOKEN,
  defaultLimits,
  estimateUsd,
  formatSummary,
  Ledger,
  LedgerError,
  limitProblems,
  money,
  parsePrice,
  type Limits,
  type Price,
  type Refusal,
  type Usage as Charge,
} from "./budget"
import { fixtureProblems, fixtureView, listFixtures, loadFixture, promptInput, type Fixture } from "./fixture"

// Sends Vectorscope's review prompt for each fixture to one model, once per repetition, and scores the findings
// against the planted bugs. A run that could not be measured (an HTTP error, a timeout, an answer with no report in
// it) is reported as an error and left out of the totals: it is neither a clean review nor a missed bug.
//
// It is a dry run unless it is given a budget (VectorScope plan, VS-03): the dry run validates the fixtures and, with
// a price, estimates the cost, and sends nothing. With --budget-usd and --case-budget-usd every request, the retry
// without a JSON schema included, is admitted by the budget ledger in budget.ts before it is sent, and settles at the
// cost the provider reported. A request the budget cannot cover is not sent, and its case is reported as not sent.

const REPO_ROOT = join(import.meta.dir, "..", "..")
export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1/chat/completions"
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

const USAGE = `Usage: bun script/vectorscope-eval/run.ts [options]

A dry run unless --budget-usd is given: it validates the fixtures and prints prompt sizes, and with --model, --price
and --max-tokens it estimates the cost. Requests are sent only with a budget, each admitted by the budget ledger.

  --model <id>              Model id sent to the endpoint, such as anthropic/claude-sonnet-4.5 on OpenRouter
  --fixture <names>         Comma-separated fixture names (default: all)
  --repeat <n>              Run each fixture n times, 1-20 (default 1)
  --budget-usd <usd>        Total budget; sends requests. A tenth is held in reserve
  --case-budget-usd <usd>   Bound for one case: one fixture reviewed once, its retry included (needed with a budget)
  --price <in>:<out>        USD per million input and output tokens, for estimates (needed with a budget)
  --max-tokens <n>          max_tokens for each request (needed with a budget; otherwise the provider's default)
  --ledger <path>           Budget journal outside the repository, shared by runs with the same budget
  --base-url <url>          OpenAI-compatible chat completions URL (default ${DEFAULT_BASE_URL})
  --api-key-env <name>      Environment variable that holds the API key (default ${DEFAULT_API_KEY_ENV})
  --slack <lines>           Lines a finding may be away from a planted bug and still match (default ${DEFAULT_SLACK})
  --count-nits              Score nit findings too (default: ignored)
  --timeout <sec>           Per-request timeout (default 300)
  --out <path>              Also write a JSON report there; it must be outside the repository
  --dry-run                 Never send, even with a budget
  --list                    Print the fixtures and exit
  --help                    Print this message
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
  "budget-usd": { type: "string" },
  "case-budget-usd": { type: "string" },
  price: { type: "string" },
  ledger: { type: "string" },
  timeout: { type: "string" },
  out: { type: "string" },
  "dry-run": { type: "boolean" },
  list: { type: "boolean" },
  help: { type: "boolean" },
} as const

type Flags = Exclude<ReturnType<typeof parseFlags>, string>

// A run that sends: everything the budget needs is present.
type Sending = Flags & { model: string; price: Price; maxTokens: number; limits: Limits }

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
  // The budget did not admit the request, so nothing was sent for this case.
  | { status: "not-sent"; reason: Refusal; detail: string }
)

export type Prompt = { fixture: Fixture; prompt: string }

export interface Deps {
  fetch?: typeof fetch
  env?: Record<string, string | undefined>
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

export async function main(argv: string[], deps: Deps = {}): Promise<number> {
  const out = deps.stdout ?? ((text: string) => void process.stdout.write(text))
  const err = deps.stderr ?? ((text: string) => void process.stderr.write(text))
  const env = deps.env ?? process.env
  const flags = parseFlags(argv)
  if (typeof flags === "string") {
    err(`${flags}\n\n${USAGE}`)
    return 2
  }
  if (flags.help) {
    out(USAGE)
    return 0
  }

  const names = await listFixtures()
  const requested = flags.fixture?.split(",").map((name) => name.trim()) ?? names
  const unknown = requested.filter((name) => !names.includes(name))
  if (unknown.length) {
    err(`Unknown fixture(s): ${unknown.join(", ")}. Run with --list to see them.\n`)
    return 2
  }
  const fixtures = await Promise.all(requested.map(loadFixture))
  if (flags.list) {
    out(
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
    err(`Invalid fixtures:\n${invalid.map((line) => `  ${line}`).join("\n")}\n`)
    return 1
  }
  const prompts = promptsFor(fixtures)
  const sending = flags.budgetUsd !== undefined && !flags.dryRun
  if (!sending) {
    out(dryRunReport(prompts) + "\n")
    if (flags.model && flags.price && flags.maxTokens)
      out(
        "\n" +
          estimateReport(
            estimateCases(prompts, { ...flags, model: flags.model, price: flags.price, maxTokens: flags.maxTokens }),
            flags.limits,
          ) +
          "\n",
      )
    if (!flags.dryRun && flags.model)
      out(
        "\nNothing is sent without a budget: add --budget-usd, --case-budget-usd, --price and --max-tokens to send requests.\n",
      )
    return 0
  }

  const missing = [
    ...(flags.model ? [] : ["--model"]),
    ...(flags.price ? [] : ["--price"]),
    ...(flags.maxTokens ? [] : ["--max-tokens"]),
    ...(flags.limits ? [] : ["--case-budget-usd"]),
  ]
  if (missing.length || !flags.model || !flags.price || !flags.maxTokens || !flags.limits) {
    err(`Sending with a budget also needs ${missing.join(", ")}.\n\n${USAGE}`)
    return 2
  }
  const run: Sending = {
    ...flags,
    model: flags.model,
    price: flags.price,
    maxTokens: flags.maxTokens,
    limits: flags.limits,
  }
  const apiKey = env[run.apiKeyEnv]
  if (!apiKey) {
    err(
      `Set ${run.apiKeyEnv} to an API key for ${new URL(run.baseUrl).host}, or name another variable with --api-key-env.\n`,
    )
    return 2
  }

  const estimate = estimateCases(prompts, run)
  let ledger: Ledger
  try {
    ledger = Ledger.open({ limits: run.limits, ...(run.ledger ? { journal: run.ledger } : {}) })
  } catch (error) {
    if (!(error instanceof LedgerError)) throw error
    err(`${error.message}\n`)
    return 2
  }
  // A cancelled run stops admitting at once and aborts the request in flight, which then counts as uncertain spend.
  const interrupt = () => ledger.cancel("interrupted")
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)
  const startedAt = new Date().toISOString()
  const runs: Run[] = []
  try {
    err(estimateReport(estimate, run.limits) + "\n\n")
    err(`Reviewing ${prompts.length} fixture(s) x ${run.repeat} with ${run.model}\n`)
    for (const entry of prompts)
      for (const attempt of Array.from({ length: run.repeat }, (_, index) => index + 1)) {
        const result = await review({ ...entry, attempt, flags: run, apiKey, ledger, fetch: deps.fetch ?? fetch })
        err(
          `  ${label(result, run.repeat)}: ${result.status === "scored" ? scoreLine(result.score) : outcome(result)}\n`,
        )
        runs.push(result)
      }
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
    // Also when something above threw: open attempts are kept as uncertain spend and the journal is unlocked.
    ledger.close()
  }
  const budget = ledger.summary()

  out("\n" + renderReport(runs, prompts, run) + "\n\n" + formatSummary(budget) + "\n")
  if (run.out) {
    const report = {
      startedAt,
      completedAt: new Date().toISOString(),
      model: run.model,
      baseUrl: run.baseUrl,
      slack: run.slack,
      countNits: run.countNits,
      repeat: run.repeat,
      price: run.price,
      maxTokens: run.maxTokens,
      estimate,
      totals: totalScores(scored(runs).map((item) => item.score)),
      runs,
      budget,
      ledger: ledger.entries,
    }
    await writeFile(run.out, JSON.stringify(report, null, 2) + "\n")
    out(`\nJSON report: ${run.out}\n`)
  }
  return runs.some((item) => item.status !== "scored") || budget.halted || budget.cancelled ? 1 : 0
}

// Each fixture's review prompt, built from its label-free view.
export function promptsFor(fixtures: Fixture[]): Prompt[] {
  return fixtures.map((fixture) => ({ fixture, prompt: buildReviewPrompt(promptInput(fixtureView(fixture))) }))
}

// The two requests a fixture may need: with the report's JSON schema, and without it for a provider that rejects the
// format. Estimates are taken from these exact bodies.
export function requestBodies(prompt: string, flags: Pick<Flags, "model" | "maxTokens" | "baseUrl">) {
  const body = {
    model: flags.model,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: prompt },
    ],
    ...(flags.maxTokens ? { max_tokens: flags.maxTokens } : {}),
    // OpenRouter reports the request's cost only when asked; other OpenAI-compatible servers may reject the field.
    ...(new URL(flags.baseUrl).host === "openrouter.ai" ? { usage: { include: true } } : {}),
  }
  return {
    structured: {
      ...body,
      response_format: { type: "json_schema", json_schema: { name: "review", schema: REVIEW_REPORT_JSON_SCHEMA } },
    },
    text: body,
  }
}

async function review(input: {
  fixture: Fixture
  prompt: string
  attempt: number
  flags: Sending
  apiKey: string
  ledger: Ledger
  fetch: typeof fetch
}): Promise<Run> {
  const started = performance.now()
  const run = { fixture: input.fixture.name, attempt: input.attempt }
  const elapsed = () => Math.round(performance.now() - started)
  const bodies = requestBodies(input.prompt, input.flags)
  const key = caseKey(input.flags.model, input.fixture.name, input.attempt)
  const structured = await attempt(input, key, bodies.structured, "json_schema")
  if (!structured.sent)
    return {
      ...run,
      ms: elapsed(),
      format: "json_schema",
      status: "not-sent",
      reason: structured.reason,
      detail: structured.detail,
    }
  let answer = structured.answer
  let format: "json_schema" | "text" = "json_schema"
  if (rejectsFormat(structured.answer)) {
    const retry = await attempt(input, key, bodies.text, "text retry")
    if (!retry.sent)
      return {
        ...run,
        ms: elapsed(),
        format: "text",
        status: "error",
        detail: `the provider rejected the JSON schema, and the request without it was not sent: ${retry.detail}`,
      }
    answer = retry.answer
    format = "text"
  }
  const ms = elapsed()
  if (!answer.ok) return { ...run, ms, format, status: "error", detail: answer.detail }

  const choice = record(list(answer.json.choices)[0])
  const message = record(choice?.message)
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined
  const content = typeof message?.content === "string" ? message.content : ""
  const measured = { ...run, ms, format, finishReason, usage: readUsage(answer.json.usage) }
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

// One provider request through the ledger: admitted against the budget and the case's bound before it is sent, then
// settled at what the provider reported. A request that leaves and never answers keeps its whole reservation.
async function attempt(
  input: { flags: Sending; apiKey: string; ledger: Ledger; fetch: typeof fetch },
  key: string,
  body: object,
  note: string,
) {
  const admission = input.ledger.admit({
    case: key,
    kind: "provider",
    model: input.flags.model,
    note,
    estimateUsd: estimateUsd({
      chars: JSON.stringify(body).length,
      maxTokens: input.flags.maxTokens,
      price: input.flags.price,
    }),
  })
  if (!admission.admitted) return { sent: false as const, reason: admission.reason, detail: admission.detail }
  const ticket = admission.ticket
  ticket.sent()
  let answer: Awaited<ReturnType<typeof post>> | undefined
  try {
    answer = await post(input, body)
  } finally {
    if (!answer) ticket.release()
  }
  ticket.settle(charge(answer, input.flags.price))
  return { sent: true as const, answer }
}

// What a request cost: the provider's reported cost, else its reported tokens at the run's prices, else nothing, which
// the ledger keeps as uncertain spend at the whole reservation. A failed request is not assumed to be free.
function charge(answer: Awaited<ReturnType<typeof post>>, price: Price): Charge {
  const usage = readUsage(answer.json?.usage)
  if (usage?.costUsd !== undefined) return { costUsd: usage.costUsd, basis: "reported" }
  if (usage?.input !== undefined && usage.output !== undefined)
    return { costUsd: (usage.input * price.input + usage.output * price.output) / 1_000_000, basis: "tokens" }
  return {}
}

async function post(input: { flags: Flags; apiKey: string; ledger: Ledger; fetch: typeof fetch }, body: object) {
  const response = await input
    .fetch(input.flags.baseUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(input.flags.timeout * 1000), input.ledger.signal]),
    })
    .catch((error: unknown) => error)
  if (!(response instanceof Response))
    return {
      ok: false as const,
      status: 0,
      raw: "",
      json: undefined,
      detail: clean(input.apiKey, `request failed: ${String(response)}`),
    }
  const json = record(
    await response
      .clone()
      .json()
      .catch(() => undefined),
  )
  const raw = await response.text().catch(() => "")
  // OpenRouter can answer 200 with an error object when the upstream provider fails, and puts the provider's own
  // message in metadata.raw.
  const error = record(json?.error)
  if (!response.ok || !json || error) {
    const said = [error?.message, record(error?.metadata)?.raw].filter((part) => typeof part === "string").join(": ")
    return {
      ok: false as const,
      status: response.status,
      raw,
      json,
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
    if (run.status === "not-sent")
      return [label(run, flags.repeat), String(planted), "not sent", "—", "—", "—", "—", "—", "—", "—", "—", "—"]
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
  const unsent = runs.filter((run) => run.status === "not-sent").length
  const errors = runs.length - done.length - unsent
  const total = totalScores(done.map((run) => run.score))
  // Cases the budget did not admit sent nothing; the rest are what the usage below is about.
  const sent = runs.filter((run) => run.status !== "not-sent")
  const costs = sent.map((run) => run.usage?.costUsd)
  const known = costs.filter((cost) => cost !== undefined)
  const tokens = sent.filter((run) => run.usage?.input !== undefined || run.usage?.output !== undefined)
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
    tokens.length === sent.length
      ? `${compact(sum(tokens.map((run) => (run.usage?.input ?? 0) + (run.usage?.output ?? 0))))} tokens`
      : `tokens reported for ${tokens.length}/${sent.length} runs`,
    known.length === sent.length
      ? `cost $${sum(known).toFixed(4)}`
      : `cost unknown (${known.length}/${sent.length} runs reported one${known.length ? `, $${sum(known).toFixed(4)} between them` : ""})`,
  ].join(" · ")
  const notes = runs.flatMap((run) => {
    if (run.status === "error") return [`  ${label(run, flags.repeat)}: error: ${run.detail}`]
    if (run.status === "not-sent") return [`  ${label(run, flags.repeat)}: ${outcome(run)}`]
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
    `Totals over ${done.length} scored run(s)${errors ? `, ${errors} error(s) left out` : ""}${unsent ? `, ${unsent} not sent within the budget` : ""}: ${headline}`,
    spend,
    ...(notes.length
      ? ["", `Misses, false alarms${unsent ? ", errors and cases not sent" : " and errors"}:`, ...notes]
      : []),
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
  const ledger = text("ledger")
  const amount = (name: keyof typeof OPTIONS) => (text(name) === undefined ? undefined : Number(text(name)))
  const flags = {
    model: text("model"),
    fixture: text("fixture"),
    repeat: Number(text("repeat") ?? 1),
    baseUrl: text("base-url") ?? DEFAULT_BASE_URL,
    apiKeyEnv: text("api-key-env") ?? DEFAULT_API_KEY_ENV,
    slack: Number(text("slack") ?? DEFAULT_SLACK),
    countNits: values["count-nits"] === true,
    maxTokens: text("max-tokens") === undefined ? undefined : Number(text("max-tokens")),
    budgetUsd: amount("budget-usd"),
    caseBudgetUsd: amount("case-budget-usd"),
    price: text("price") === undefined ? undefined : parsePrice(text("price")!),
    timeout: Number(text("timeout") ?? 300),
    out: out === undefined ? undefined : resolve(out),
    ledger: ledger === undefined ? undefined : resolve(ledger),
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
  if (text("price") !== undefined && !flags.price)
    return "--price must be USD per million input and output tokens, such as 3:15."
  if ((flags.budgetUsd === undefined) !== (flags.caseBudgetUsd === undefined))
    return "--budget-usd and --case-budget-usd go together."
  const limits =
    flags.budgetUsd === undefined || flags.caseBudgetUsd === undefined
      ? undefined
      : defaultLimits(flags.budgetUsd, flags.caseBudgetUsd)
  const problems = limits ? limitProblems(limits) : []
  if (problems.length) return `Budget: ${problems.join("; ")}.`
  if (!URL.canParse(flags.baseUrl)) return `--base-url is not a URL: ${flags.baseUrl}`
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(flags.apiKeyEnv)) return "--api-key-env must name an environment variable."
  // Results are kept out of the repository, like the agent eval's: numbers from one session are not a benchmark.
  const inside = flags.out === undefined ? "" : relative(REPO_ROOT, flags.out)
  if (flags.out !== undefined && !inside.startsWith("..") && !isAbsolute(inside))
    return `--out must be outside the repository (${REPO_ROOT}).`
  const journal = flags.ledger === undefined ? "" : relative(REPO_ROOT, flags.ledger)
  if (flags.ledger !== undefined && !journal.startsWith("..") && !isAbsolute(journal))
    return `--ledger must be outside the repository (${REPO_ROOT}).`
  return { ...flags, limits }
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

function outcome(run: Exclude<Run, { status: "scored" }>) {
  return run.status === "not-sent" ? `not sent (${run.reason}): ${run.detail}` : run.detail
}

// One case for the per-case bound: one fixture reviewed once by one model, with its retry.
function caseKey(model: string, fixture: string, attempt: number) {
  return `${model} ${fixture}#${attempt}`
}

export interface FixtureEstimate {
  fixture: string
  requestUsd: number // the request with the JSON schema
  worstUsd: number // and the retry without it, for a provider that rejects the schema
}

export interface Estimate {
  model: string
  price: Price
  maxTokens: number
  repeat: number
  cases: number
  fixtures: FixtureEstimate[]
  onceUsd: number // every case asked once
  worstUsd: number // every case asked twice
  maxCaseUsd: number
}

// What a run would cost at most, from the exact request bodies it would send: no network.
export function estimateCases(
  prompts: Prompt[],
  flags: Pick<Flags, "repeat" | "baseUrl"> & { model: string; price: Price; maxTokens: number },
): Estimate {
  const fixtures = prompts.map((entry) => {
    const bodies = requestBodies(entry.prompt, flags)
    const price = (body: object) =>
      estimateUsd({ chars: JSON.stringify(body).length, maxTokens: flags.maxTokens, price: flags.price })
    const requestUsd = price(bodies.structured)
    return { fixture: entry.fixture.name, requestUsd, worstUsd: requestUsd + price(bodies.text) }
  })
  return {
    model: flags.model,
    price: flags.price,
    maxTokens: flags.maxTokens,
    repeat: flags.repeat,
    cases: fixtures.length * flags.repeat,
    fixtures,
    onceUsd: sum(fixtures.map((item) => item.requestUsd)) * flags.repeat,
    worstUsd: sum(fixtures.map((item) => item.worstUsd)) * flags.repeat,
    maxCaseUsd: Math.max(0, ...fixtures.map((item) => item.worstUsd)),
  }
}

export function estimateReport(estimate: Estimate, limits?: Limits) {
  const tooBig = limits ? estimate.fixtures.filter((item) => item.requestUsd > limits.caseUsd) : []
  const noRetry = limits
    ? estimate.fixtures.filter((item) => item.requestUsd <= limits.caseUsd && item.worstUsd > limits.caseUsd)
    : []
  const admissible = limits ? limits.totalUsd - limits.reserveUsd : 0
  return [
    `Estimate for ${estimate.model} at $${estimate.price.input} input and $${estimate.price.output} output per million tokens, max_tokens ${estimate.maxTokens}, input counted at ${CHARS_PER_TOKEN} characters per token:`,
    formatTable([
      ["FIXTURE", "REQUEST", "WITH RETRY"],
      ...estimate.fixtures.map((item) => [item.fixture, `$${money(item.requestUsd)}`, `$${money(item.worstUsd)}`]),
    ]),
    `${estimate.cases} case(s): at most $${money(estimate.onceUsd)} if each is asked once, $${money(estimate.worstUsd)} if the provider rejects the JSON schema and each is asked again without it.`,
    ...(limits
      ? [
          `Per-case bound $${money(limits.caseUsd)}: ${
            tooBig.length
              ? `${tooBig.map((item) => item.fixture).join(", ")} cannot be sent within it`
              : noRetry.length
                ? `${noRetry.map((item) => item.fixture).join(", ")} cannot be retried within it`
                : "every case fits, retry included"
          }.`,
          `Budget $${money(limits.totalUsd, 2)} admits $${money(admissible)} after its $${money(limits.reserveUsd)} reserve: ${
            estimate.worstUsd <= admissible
              ? "the worst case fits"
              : estimate.onceUsd <= admissible
                ? "every case asked once fits, but not every retry"
                : "not every case fits, and those the budget cannot admit are reported as not sent"
          }.`,
        ]
      : []),
    "These are estimates; reported usage can exceed them.",
  ].join("\n")
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

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
