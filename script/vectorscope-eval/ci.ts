#!/usr/bin/env bun
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, isAbsolute, join, resolve } from "node:path"
import {
  defaultLimits,
  formatSummary,
  Ledger,
  LedgerError,
  limitProblems,
  money,
  type Limits,
  type Price,
} from "./budget"
import { fixtureProblems, listFixtures, loadFixture } from "./fixture"
import { outsideRepository, REPO_ROOT } from "./paths"
import {
  DEFAULT_BASE_URL,
  estimateCases,
  estimateReport,
  EVAL_ENVIRONMENT,
  EVAL_ENVIRONMENT_ENV,
  EVAL_KEY_ENV,
  promptsFor,
} from "./run"

// The vectorscope eval workflow's entry point (.github/workflows/vectorscope-eval.yml; VectorScope plan, VS-03). The
// workflow hands the dispatch inputs over as environment variables and never writes one into a shell command. This
// script validates them and starts run.ts with an argument array, so no input is parsed by a shell.
//
//   plan    Validates the inputs and the fixtures and estimates the worst case. Sends nothing and needs no key.
//   paid    Runs each model in turn. Every request is admitted by one budget ledger whose journal all the runs
//           share, and is sent with the vectorscope-eval environment's own key (D7). No model starts once the ledger
//           has stopped admitting.
//   report  Summarises the ledger journal, also after a cancelled or timed-out run.
//   seal    Encrypts the reports, logs and journal to the owner's public key, for the run's artifact.
//   unseal  On the owner's machine: decrypts a sealed artifact with the matching private key.
//
// The repository is public, so its Actions logs, step summaries and artifacts can be read by anyone. Results stay
// internal until a held-out run passes D2 and the owner reviews the aggregate (D12), so a paid run prints only the
// ledger's spend and counts. run.ts's output, with every score and finding, is written to the output directory, and
// the artifact holds that directory only as sealed by the owner's key. A failed run is never retried here: running
// again is the owner's decision, with a new budget.

export const KEY_ENV = EVAL_KEY_ENV
// A vectorscope-eval environment variable (not a secret): the owner's RSA public key in PEM form. Paid mode refuses
// to start without it, so no result can reach the artifact unsealed.
export const PUBLIC_KEY_ENV = "VECTORSCOPE_EVAL_PUBLIC_KEY"
export const MODES = ["dry-run", "paid"] as const
export const JOURNAL = "ledger.jsonl"
export const SEALED = "vectorscope-eval.sealed.json"
export const SEALED_SCHEMA = "vectorscope-sealed/1"
const MAX_TOKENS = 200_000
const MIN_KEY_BITS = 3072
const RUN = join(import.meta.dir, "run.ts")
const MODEL = /^([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})=(\d{1,6}(?:\.\d{1,6})?):(\d{1,6}(?:\.\d{1,6})?)$/
const AMOUNT = /^\d{1,6}(?:\.\d{1,4})?$/
const FIXTURES = /^[a-z0-9-]+(?:,[a-z0-9-]+)*$/

export type Mode = (typeof MODES)[number]

export interface Inputs {
  mode: Mode
  models: { id: string; price: Price }[]
  limits?: Limits
  maxTokens: number
  repeat: number
  fixtures?: string[]
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
    return [{ id: match[1]!, price: { input: Number(match[2]), output: Number(match[3]) } }]
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

  if (problems.length) return { problems }
  return {
    inputs: {
      mode: mode as Mode,
      models,
      ...(limits ? { limits } : {}),
      maxTokens: Number(maxTokens),
      repeat: Number(repeat),
      ...(fixtures ? { fixtures: fixtures.split(",") } : {}),
    },
  }
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
  spawn?: (argv: string[], env: Record<string, string>) => Child
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
  if (command !== "plan" && command !== "paid") {
    err(
      "Usage: bun script/vectorscope-eval/ci.ts plan|paid|report|seal (inputs come from EVAL_* environment variables)\n" +
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
  if (command === "plan") return plan(inputs, { out, err, summary })
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
  const text = [
    `Mode ${inputs.mode}. ${fixtures.length} fixture(s) x ${inputs.repeat} for each of ${inputs.models.length} model(s).`,
    "",
    ...estimates.flatMap((estimate) => [estimateReport(estimate, inputs.limits), ""]),
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
      // run.ts's output holds scores, findings and model text. It goes to a log beside its report, which only the
      // sealed artifact carries; the public log and summary get the ledger's spend and counts alone (D12).
      child = io.spawn([process.execPath, RUN, ...runArgs(inputs, index, outDir)], childEnv)
      const [text, errors, code] = await Promise.all([child.stdout, child.stderr ?? Promise.resolve(""), child.exited])
      child = undefined
      writeFileSync(join(outDir, `${runName(inputs, index)}.log`), `${errors}${errors && text ? "\n" : ""}${text}`)
      const spend = existsSync(journal) ? ledgerText(journal) : "No ledger journal: no paid attempt was admitted."
      const line = `${model.id}: run.ts exited with ${code}. Its report and log are in the sealed artifact.`
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

// The owner's public key, or why it cannot seal: RSA of at least MIN_KEY_BITS bits, in PEM form.
function publicKey(pem: string | undefined): KeyObject | string {
  const missing = `${PUBLIC_KEY_ENV} must be the owner's RSA public key (PEM, at least ${MIN_KEY_BITS} bits), set as a variable of the vectorscope-eval environment. The repository is public, so results are uploaded only sealed to it.`
  if (!pem?.trim()) return missing
  try {
    const key = createPublicKey(pem)
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
    return key.asymmetricKeyType === "rsa" && bits >= MIN_KEY_BITS ? key : missing
  } catch {
    return missing
  }
}

export interface Sealed {
  schema: typeof SEALED_SCHEMA
  algorithm: "RSA-OAEP-256 + AES-256-GCM"
  key: string // the content key, encrypted to the owner's public key, base64
  iv: string
  tag: string
  data: string // the files as JSON, encrypted with the content key, base64
}

// Encrypts files (name to content) to an RSA public key: a fresh AES-256-GCM key for the content, wrapped with
// RSA-OAEP over SHA-256. Only the matching private key opens it.
export function seal(files: Record<string, Buffer>, pem: string | KeyObject): Sealed {
  const key = typeof pem === "string" ? createPublicKey(pem) : pem
  const content = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", content, iv)
  const plain = Buffer.from(
    JSON.stringify(Object.fromEntries(Object.entries(files).map(([name, data]) => [name, data.toString("base64")]))),
  )
  const data = Buffer.concat([cipher.update(plain), cipher.final()])
  return {
    schema: SEALED_SCHEMA,
    algorithm: "RSA-OAEP-256 + AES-256-GCM",
    key: publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, content).toString(
      "base64",
    ),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  }
}

export function unseal(sealed: Sealed, pem: string): Record<string, Buffer> {
  if (sealed?.schema !== SEALED_SCHEMA) throw new Error(`not a ${SEALED_SCHEMA} file`)
  const content = privateDecrypt(
    { key: createPrivateKey(pem), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(sealed.key, "base64"),
  )
  const decipher = createDecipheriv("aes-256-gcm", content, Buffer.from(sealed.iv, "base64"))
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"))
  const plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()])
  const files = JSON.parse(plain.toString("utf8")) as Record<string, string>
  return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, Buffer.from(data, "base64")]))
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

// Reports and the journal live in the runner's temporary directory, never in the repository.
function outputDir(env: Env, name = "EVAL_OUT_DIR"): string | { problem: string } {
  const dir = env[name]
  if (!dir || !isAbsolute(dir)) return { problem: `${name} must be an absolute directory outside the repository.` }
  if (!outsideRepository(dir)) return { problem: `${name} must be outside the repository (${REPO_ROOT}).` }
  return dir
}

function spawn(argv: string[], env: Record<string, string>): Child {
  const child = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  return {
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
    exited: child.exited,
    kill: (signal) => child.kill(signal),
  }
}

// A step summary section. The text is escaped inside <pre>, so model output in it cannot become markup or links.
function block(title: string, text: string) {
  return `### ${escape(title)}\n\n<pre>${escape(text.trimEnd())}</pre>\n\n`
}

function escape(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

if (import.meta.main) process.exit(await main(process.argv[2], {}, process.argv.slice(3)))
