// The hosted team's budget workflow (contract WP A56, §6.2 `vector-hosted-budget.yml`). Once a day, and when the owner
// dispatches it, it raises the Vercel `vector-hosted` team's Spend Management budget as subscribers grow:
//
//   new budget = max(current budget, ceil(spend this cycle + 1.3 × worst case for the rest of the cycle))
//
// The worst case comes from Vector's own API (`GET /api/hosted/admin/budget?cycleEnd=<ms>`, read with
// VECTOR_HOSTED_BUDGET_READ_SECRET): every Max and Ultra account's cloud computer hours left this period, the full hours
// of every period that starts before the cycle ends, each day's egress at the plan's fair-use cap, and every computer's
// disk (kept ones of ended plans too), at the provider's worst-case rates.
// The current budget and the cycle's spend come from the Vercel CLI (`vercel billing budgets inspect --json`), run
// with a token from a member with the Billing role, scoped to the hosted team.
//
// Rules this file keeps (M9):
// - it never lowers the budget: the result is at least the current amount, always;
// - it never sets above the owner's ceiling (VECTOR_HOSTED_BUDGET_MAX_USD); a capped run raises to the ceiling and
//   fails, so the owner sees it;
// - it only ever passes the amount: never the flag that pauses the team's projects when the budget is reached (that
//   would take the hosted project down), and never a webhook flag, so the owner's spend webhook stays as it is;
// - it refuses to create a budget: the owner creates it with its webhook first (owner-actions/hosted-computer.md);
// - it prints no amount. The repository is public, so its Actions logs are too: the log says raised, unchanged or
//   capped, nothing else. The CLI's own output is read, never echoed.
// Anything it cannot read fails the run without changing anything.

import { spawn } from "node:child_process"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/** The Vercel CLI the workflow runs, exactly (published 26 Oct 2026). */
export const VERCEL_CLI_VERSION = "65.3.1"
/** Where the worst case is read. Fixed, so the read secret is never sent anywhere else. */
export const VECTOR_ORIGIN = "https://vectordev.ai"
/** The margin over the worst case (contract A56), and the same in tenths for whole-cent arithmetic. */
export const BUDGET_FACTOR = 1.3
const FACTOR_TENTHS = 13

const DAY = 86_400_000

export type BudgetPlan = {
  /** The budget to have, in whole dollars: never below the current one. */
  amount: number
  /** Whether that is above the current budget (a `set` is needed). */
  raise: boolean
  /** Whether the owner's ceiling held the budget below what the formula asked for. */
  capped: boolean
}

/** max(current, ceil(spend + 1.3 × worst case)), never above the ceiling unless the budget already is. */
export function budgetPlan(input: { current: number; spend: number; worstCaseUsd: number; ceiling: number }): BudgetPlan {
  const { current, spend, worstCaseUsd, ceiling } = input
  for (const value of [current, spend, worstCaseUsd, ceiling])
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("budget figures must be numbers")
  // Whole cents and tenths, so 1.3 × $0.10 is 13 cents exactly and never rounds a dollar up by accident.
  const wantedCents = Math.round(spend * 100) + Math.ceil((FACTOR_TENTHS * Math.round(worstCaseUsd * 100)) / 10)
  const wanted = Math.ceil(wantedCents / 100)
  const floor = Math.ceil(current)
  const limit = Math.floor(ceiling)
  const amount = Math.max(floor, Math.min(wanted, limit))
  return { amount, raise: amount > floor, capped: wanted > limit && wanted > floor }
}

/**
 * When the hosted team's billing cycle ends: the next `day` of a month (UTC midnight) after `now`. Vercel bills a Pro
 * team monthly from the day its subscription started; the owner names that day (1–28) in VECTOR_HOSTED_BILLING_DAY.
 */
export function cycleEnd(now: number, day: number) {
  if (!Number.isSafeInteger(day) || day < 1 || day > 28) throw new Error("the billing day must be 1 to 28")
  const date = new Date(now)
  const thisMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), day)
  return thisMonth > now ? thisMonth : Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, day)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

function dollars(value: unknown, cents = false) {
  const number = typeof value === "string" && /^\$?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value.trim().replace("$", "")) : value
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0) return undefined
  return cents ? number / 100 : number
}

function field(record: Record<string, unknown>, names: readonly string[]) {
  for (const name of names) {
    if (name in record) return dollars(record[name], false)
    const cents = `${name}Cents`
    if (cents in record) return dollars(record[cents], true)
    const inCents = `${name}InCents`
    if (inCents in record) return dollars(record[inCents], true)
  }
  return undefined
}

const AMOUNT = ["amount", "budgetAmount", "budget"] as const
const SPENT = ["spent", "spend", "currentSpend"] as const

/**
 * The team budget's amount and this cycle's spend, in dollars, from `vercel billing budgets inspect --json`. The
 * documented columns are scope, amount, spent, used, status, pause and webhook; their JSON names are read leniently
 * (also nested under `budget`, or the `team` entry of `budgets`). `{none: true}` when no budget is set; undefined when
 * the answer cannot be read, so nothing is changed.
 */
export function readBudget(output: string): { amount: number; spent: number } | { none: true } | undefined {
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  const candidates: Record<string, unknown>[] = []
  const team = Array.isArray(value.budgets)
    ? value.budgets.filter((item) => isRecord(item) && (item.scope === undefined || item.scope === "team"))
    : []
  if (Array.isArray(value.budgets) && team.length === 0 && value.budgets.length === 0) return { none: true }
  if (team.length > 1) return undefined
  if (isRecord(team[0])) candidates.push({ ...value, ...team[0] })
  if (isRecord(value.budget)) candidates.push({ ...value, ...value.budget })
  candidates.push(value)
  for (const candidate of candidates) {
    const amount = isRecord(candidate.amount) ? undefined : field(candidate, AMOUNT)
    const spent = field(candidate, SPENT)
    if (amount !== undefined && spent !== undefined) return { amount, spent }
  }
  if (value.budget === null && field(value, SPENT) !== undefined) return { none: true }
  return undefined
}

/** The worst case from Vector's answer, in dollars, or undefined when it is not one. */
export function readWorstCase(body: unknown, cycle: number) {
  if (!isRecord(body) || body.cycleEnd !== cycle) return undefined
  const worst = body.worstCaseUsd
  return typeof worst === "number" && Number.isFinite(worst) && worst >= 0 ? worst : undefined
}

export type Settings = {
  token: string
  team: string
  readSecret: string
  billingDay: number
  ceiling: number
}

/** The workflow's settings from its environment, or the first thing that is missing. */
export function readSettings(env: Record<string, string | undefined>): Settings | { problem: string } {
  const token = env.VERCEL_TOKEN?.trim() ?? ""
  const team = env.VECTOR_HOSTED_VERCEL_TEAM_ID?.trim() ?? ""
  const readSecret = env.VECTOR_HOSTED_BUDGET_READ_SECRET?.trim() ?? ""
  const billingDay = Number(env.VECTOR_HOSTED_BILLING_DAY?.trim())
  const ceiling = Number(env.VECTOR_HOSTED_BUDGET_MAX_USD?.trim())
  if (!token) return { problem: "Set the Billing-role token VECTOR_HOSTED_BUDGET_VERCEL_TOKEN in hosted-production." }
  if (!/^team_[A-Za-z0-9]{8,64}$/.test(team))
    return { problem: "Set VECTOR_HOSTED_VERCEL_TEAM_ID (team_…) to the hosted team, never the main team." }
  if (readSecret.length < 32) return { problem: "Set VECTOR_HOSTED_BUDGET_READ_SECRET in hosted-production." }
  if (!Number.isSafeInteger(billingDay) || billingDay < 1 || billingDay > 28)
    return { problem: "Set VECTOR_HOSTED_BILLING_DAY to the day of the month the hosted team's cycle starts (1–28)." }
  if (!Number.isSafeInteger(ceiling) || ceiling < 1)
    return { problem: "Set VECTOR_HOSTED_BUDGET_MAX_USD, the most this workflow may raise the budget to, in whole dollars." }
  return { token, team, readSecret, billingDay, ceiling }
}

/** Runs the Vercel CLI with these arguments; the token travels in the environment, never on the command line. */
export type Cli = (args: string[]) => Promise<{ code: number; stdout: string }>

/** The only flags this workflow ever passes to the CLI. */
const ALLOWED_FLAGS = new Set(["--json", "--amount", "--scope", "--non-interactive"])

function guarded(cli: Cli): Cli {
  return (args) => {
    if (args.some((arg) => arg.startsWith("-") && !ALLOWED_FLAGS.has(arg)))
      throw new Error("the budget workflow passes only --amount, --json, --scope and --non-interactive")
    return cli(args)
  }
}

// The command moved from `vercel budgets` (23 Oct 2026) to `vercel billing budgets`; both forms are tried, and a
// usage error (exit 2) moves to the next one. Any other failure stops the run.
const FORMS = [["billing", "budgets"], ["budgets"]] as const

type Inspected =
  | { error: string }
  | { form: readonly string[]; budget: { amount: number; spent: number } | { none: true } }

async function inspect(cli: Cli, team: string): Promise<Inspected> {
  for (const form of FORMS) {
    for (const args of [[...form, "inspect", "--json"], [...form, "--json"]]) {
      const result = await cli([...args, "--scope", team, "--non-interactive"])
      if (result.code === 2) continue
      if (result.code !== 0) return { error: "The Vercel CLI could not read the hosted team's budget." }
      const budget = readBudget(result.stdout)
      if (!budget) return { error: "The Vercel CLI's budget answer could not be read; nothing was changed." }
      return { form, budget }
    }
  }
  return { error: "This Vercel CLI has no budgets command; nothing was changed." }
}

export type Outcome = { status: "raised" | "unchanged" | "capped" | "failed"; message: string }

/** One run: read, decide, raise if needed and confirm. Prints nothing itself; the outcome's message has no amount. */
export async function runBudget(input: {
  settings: Settings
  cli: Cli
  fetch: typeof fetch
  now: number
}): Promise<Outcome> {
  const { settings } = input
  const cli = guarded(input.cli)
  const cycle = cycleEnd(input.now, settings.billingDay)
  // Vector refuses a cycle end more than 40 days ahead; a 28th-of-the-month cycle is at most 31 days.
  if (cycle - input.now > 40 * DAY) return { status: "failed", message: "The billing cycle's end is too far ahead." }
  const answer = await input
    .fetch(`${VECTOR_ORIGIN}/api/hosted/admin/budget?cycleEnd=${cycle}`, {
      headers: { accept: "application/json", authorization: `Bearer ${settings.readSecret}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    })
    .catch(() => undefined)
  if (!answer?.ok) return { status: "failed", message: "Vector's worst-case figure could not be read; nothing was changed." }
  const worstCaseUsd = readWorstCase(await answer.json().catch(() => undefined), cycle)
  if (worstCaseUsd === undefined)
    return { status: "failed", message: "Vector's worst-case figure could not be read; nothing was changed." }
  const read = await inspect(cli, settings.team)
  if ("error" in read) return { status: "failed", message: read.error }
  if ("none" in read.budget)
    return {
      status: "failed",
      message: "The hosted team has no budget. Create it with its spend webhook first (owner-actions/hosted-computer.md).",
    }
  const plan = budgetPlan({
    current: read.budget.amount,
    spend: read.budget.spent,
    worstCaseUsd,
    ceiling: settings.ceiling,
  })
  if (!plan.raise)
    return plan.capped
      ? { status: "capped", message: "The budget is at or above the ceiling and was left as it is. Raise the ceiling or the budget." }
      : { status: "unchanged", message: "The hosted team's budget already covers the worst case." }
  const set = await cli([...read.form, "set", "--amount", String(plan.amount), "--scope", settings.team, "--non-interactive"])
  if (set.code !== 0) return { status: "failed", message: "The Vercel CLI could not set the budget." }
  const check = await inspect(cli, settings.team)
  if ("error" in check || "none" in check.budget || check.budget.amount !== plan.amount)
    return { status: "failed", message: "The new budget could not be confirmed. Check it in the hosted team's settings." }
  return plan.capped
    ? { status: "capped", message: "The budget was raised to the ceiling, which is below the worst case. Raise the ceiling." }
    : { status: "raised", message: "The hosted team's budget was raised to cover the worst case." }
}

/** A process run: its exit code and its output (capped), the error stream discarded. */
export type Spawn = (command: string, args: string[], env: Record<string, string>) => Promise<{ code: number; stdout: string }>

const realSpawn: Spawn = (command, args, env) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString("utf8")
    })
    child.stderr.resume()
    child.on("error", () => resolve({ code: 1, stdout: "" }))
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }))
  })

/** What the CLI may see of the job's environment besides its token: the image job's project link and Docker's folder. */
export const CLI_ENV = ["PATH", "HOME", "TMPDIR", "DOCKER_CONFIG", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"] as const
/** What npm may see while it installs the CLI: no token, no secret. */
export const INSTALL_ENV = ["PATH", "HOME", "TMPDIR"] as const

function pick(env: Record<string, string | undefined>, names: readonly string[]) {
  const picked: Record<string, string> = {}
  for (const name of names) if (typeof env[name] === "string") picked[name] = env[name]!
  return picked
}

/**
 * The real CLI (P8 review: no `npx`, whose install would run its dependencies' install scripts with the token in their
 * environment). `vercel@<version>` is installed once per run into a new temporary folder by npm, with install scripts
 * off and only PATH, HOME and TMPDIR in npm's environment, and must report the pinned version; then each call runs that
 * install's `vercel` with the token and only `CLI_ENV`. Its output is captured and never echoed.
 */
export function vercelCli(
  token: string,
  deps: { spawn?: Spawn; dir?: string; env?: Record<string, string | undefined> } = {},
): Cli {
  const run = deps.spawn ?? realSpawn
  const env = deps.env ?? process.env
  let installed: Promise<string | undefined> | undefined
  const install = async () => {
    const dir = deps.dir ?? (await mkdtemp(path.join(env.RUNNER_TEMP || tmpdir(), "vector-vercel-cli-")))
    const result = await run(
      "npm",
      [
        "install",
        "--prefix",
        dir,
        "--ignore-scripts",
        "--no-save",
        "--no-audit",
        "--no-fund",
        "--omit=dev",
        "--loglevel=error",
        `vercel@${VERCEL_CLI_VERSION}`,
      ],
      {
        ...pick(env, INSTALL_ENV),
        npm_config_ignore_scripts: "true",
        npm_config_cache: path.join(dir, ".npm-cache"),
        npm_config_userconfig: path.join(dir, ".npmrc"),
        npm_config_update_notifier: "false",
      },
    )
    if (result.code !== 0) return undefined
    const manifest = await readFile(path.join(dir, "node_modules", "vercel", "package.json"), "utf8")
      .then((text) => JSON.parse(text) as { version?: unknown })
      .catch(() => undefined)
    return manifest?.version === VERCEL_CLI_VERSION ? path.join(dir, "node_modules", ".bin", "vercel") : undefined
  }
  return async (args) => {
    const bin = await (installed ??= install())
    if (!bin) return { code: 1, stdout: "" }
    return run(bin, args, { ...pick(env, CLI_ENV), VERCEL_TOKEN: token, NO_COLOR: "1", CI: "1" })
  }
}

if (import.meta.main) {
  const settings = readSettings(process.env)
  if ("problem" in settings) {
    console.error(settings.problem)
    process.exit(1)
  }
  const outcome = await runBudget({ settings, cli: vercelCli(settings.token), fetch, now: Date.now() }).catch(
    (): Outcome => ({ status: "failed", message: "The budget run failed; nothing was confirmed." }),
  )
  console.log(`Hosted budget: ${outcome.status}. ${outcome.message}`)
  process.exit(outcome.status === "raised" || outcome.status === "unchanged" ? 0 : 1)
}
