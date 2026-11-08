// The live arm: the baseline, the identity control and each variant against a real model, run only when the owner asks
// for it (`--live --yes`), never in CI. Each run is one agent-eval task (tasks.ts) in a fresh fixture under a
// throwaway home, through agent-eval's runTask with an environment built from scratch: nothing is inherited from the
// owner's, the brain is off and in memory, and the only credentials are the environment variables `--auth-env` names,
// copied by name. The harness reads no credential file. Spend is counted from the tokens each run reports, at the
// owner's prices; no run starts once it reaches `--max-spend` (the run in progress can take it past the cap).

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spend } from "../compounding/measure"
import type { Tokens } from "../meter"
import type { Rates } from "../prompt-cache"
import { runTask } from "../run"
import { TASKS } from "../tasks"
import { REPO_ROOT } from "./variants"

/** Repeats per task and arm: fewer cannot separate a variant from run-to-run noise. */
export const MIN_REPEAT = 5

export type LiveOptions = {
  /** The pinned model, as provider/model. */
  readonly model: string
  readonly baseURL?: string
  readonly auth: readonly string[]
  readonly maxSpend: number
  readonly prices: string
  readonly repeat: number
  readonly tasks: readonly string[]
}

export type LiveRun = {
  readonly task: string
  readonly attempt: number
  /** pass or fail; unavailable and error runs measured nothing and are left out of every comparison. */
  readonly outcome: "pass" | "fail" | "unavailable" | "error"
  readonly tokens?: Tokens
  readonly usd: number
}

type Flags = Readonly<Record<string, string | boolean | undefined>>

/** The live options, or why the live arm refuses to run. */
export function check(
  flags: Flags,
  env: Readonly<Record<string, string | undefined>> = process.env,
): LiveOptions | { readonly refused: string } {
  if (env.CI && !["0", "false"].includes(env.CI.toLowerCase()))
    return { refused: "The live arm never runs in CI: it calls a real model." }
  if (flags.yes !== true)
    return { refused: "Nothing was run. The live arm calls a real model and spends money: add --yes." }
  const maxSpend = Number(flags["max-spend"])
  if (!(maxSpend > 0)) return { refused: "--live needs --max-spend, a positive number of US dollars." }
  if (typeof flags.prices !== "string")
    return {
      refused:
        "--live needs --prices, a JSON file of US dollars per million tokens: input, output, cacheRead, cacheWrite.",
    }
  const model = typeof flags.model === "string" ? flags.model : ""
  if (!/^[\w.-]+\/\S+$/.test(model))
    return { refused: "--live needs --model provider/model: a pinned model, so every arm runs on the same one." }
  const baseURL = typeof flags["base-url"] === "string" ? flags["base-url"] : undefined
  if (!local(baseURL) && flags["allow-remote"] !== true)
    return {
      refused: `${baseURL ?? `${model.split("/")[0]}'s own service`} is not on this computer, so every prompt and file the agent reads goes to it. Add --allow-remote to allow that.`,
    }
  const auth = typeof flags["auth-env"] === "string" ? flags["auth-env"].split(",").filter(Boolean) : []
  const bad = auth.find((name) => !/^[A-Z_][A-Z0-9_]*$/.test(name) || !env[name])
  if (bad) return { refused: `--auth-env ${bad} is not a set environment variable.` }
  const repeat = Number(flags.repeat ?? MIN_REPEAT)
  if (!Number.isInteger(repeat) || repeat < MIN_REPEAT)
    return { refused: `--repeat must be a whole number of at least ${MIN_REPEAT}.` }
  const tasks = typeof flags["live-tasks"] === "string" ? flags["live-tasks"].split(",") : TASKS.map((task) => task.id)
  const unknown = tasks.filter((id) => !TASKS.some((task) => task.id === id))
  if (unknown.length)
    return { refused: `Unknown live task ${unknown.join(", ")}. Tasks: ${TASKS.map((task) => task.id).join(", ")}` }
  return { model, ...(baseURL ? { baseURL } : {}), auth, maxSpend, prices: flags.prices, repeat, tasks }
}

/** Whether a base URL is a model server on this computer: localhost, 127.0.0.1 or [::1]. */
export function local(baseURL: string | undefined) {
  const host = baseURL ? URL.parse(baseURL)?.hostname : undefined
  return ["localhost", "127.0.0.1", "[::1]"].includes(host ?? "")
}

/** The owner's prices, per million tokens. Only a model on this computer may run at $0. */
export async function rates(options: LiveOptions): Promise<Rates> {
  const value = (await Bun.file(options.prices).json()) as Record<string, unknown>
  const price = (key: string) => (typeof value[key] === "number" && value[key] >= 0 ? value[key] : undefined)
  const input = price("input")
  const output = price("output")
  if (input === undefined || output === undefined)
    throw new Error(`${options.prices} must give input and output as US dollars per million tokens`)
  if (!local(options.baseURL) && !(input > 0 && output > 0))
    throw new Error(
      "Only a model on this computer may run at $0: a paid model needs input and output prices above $0, or the spend cap never stops it.",
    )
  return { input, output, cacheRead: price("cacheRead") ?? input, cacheWrite: price("cacheWrite") ?? input }
}

/** `vector run`'s environment, built from scratch. */
export function environment(input: {
  readonly home: string
  readonly auth: readonly string[]
  readonly config: Record<string, unknown>
  readonly source?: Readonly<Record<string, string | undefined>>
}): Record<string, string> {
  const source = input.source ?? process.env
  return {
    PATH: [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    HOME: input.home,
    VECTOR_TEST_HOME: input.home,
    XDG_CONFIG_HOME: join(input.home, ".config"),
    XDG_DATA_HOME: join(input.home, ".local/share"),
    XDG_STATE_HOME: join(input.home, ".local/state"),
    XDG_CACHE_HOME: join(input.home, ".cache"),
    TERM: "dumb",
    VECTOR_CONFIG_CONTENT: JSON.stringify({
      formatter: false,
      lsp: false,
      ...input.config,
      permission: { ...(input.config.permission as object | undefined), memory: "deny" },
    }),
    VECTOR_PURE: "1",
    VECTOR_AGENT_DB: ":memory:",
    VECTOR_DISABLE_AUTOUPDATE: "1",
    VECTOR_DISABLE_USAGE: "1",
    VECTOR_DISABLE_PROJECT_CONFIG: "1",
    ...Object.fromEntries(input.auth.map((name) => [name, source[name] ?? ""])),
  }
}

/** Every arm's runs, task by task and repeat by repeat, arms interleaved so drift in the provider hits them alike. */
export async function live(input: {
  readonly arms: readonly { readonly id: string; readonly config: Record<string, unknown> }[]
  readonly options: LiveOptions
  readonly rates: Rates
  readonly engine?: string
}) {
  const engine = input.engine ?? join(REPO_ROOT, "packages", "engine", "src", "index.ts")
  const launcher = {
    command: process.execPath,
    prefix: ["run", "--conditions=browser", engine],
    label: `bun run ${engine}`,
  }
  const provider = input.options.model.split("/")[0]!
  const runs: Record<string, LiveRun[]> = Object.fromEntries(input.arms.map((arm) => [arm.id, []]))
  const state = { spent: 0, stopped: false }
  const plan = input.options.tasks.flatMap((id) =>
    Array.from({ length: input.options.repeat }, (_, at) => at + 1).flatMap((attempt) =>
      input.arms.map((arm) => ({ id, attempt, arm })),
    ),
  )
  for (const item of plan) {
    if (state.spent >= input.options.maxSpend) {
      state.stopped = true
      break
    }
    const home = await mkdtemp(join(tmpdir(), "vector-prompt-evolve-live-"))
    const config = input.options.baseURL
      ? { ...item.arm.config, provider: { [provider]: { options: { baseURL: input.options.baseURL } } } }
      : item.arm.config
    const report = await runTask({
      runtime: "vector",
      launcher,
      task: TASKS.find((task) => task.id === item.id)!,
      root: join(home, "work"),
      model: input.options.model,
      attempt: item.attempt,
      repetitions: input.options.repeat,
      env: environment({ home, auth: input.options.auth, config }),
    }).finally(() => rm(home, { recursive: true, force: true }))
    const usd = report.run.status === "ran" && report.run.tokens ? spend(report.run.tokens, input.rates) : 0
    state.spent += usd
    runs[item.arm.id]!.push({
      task: item.id,
      attempt: item.attempt,
      outcome: report.score.outcome,
      ...(report.run.status === "ran" && report.run.tokens ? { tokens: report.run.tokens } : {}),
      usd,
    })
    process.stderr.write(
      `  live ${item.arm.id} ${item.id} #${item.attempt}: ${report.score.outcome}, spent $${state.spent.toFixed(4)} of $${input.options.maxSpend}\n`,
    )
  }
  return { runs, spent: state.spent, stopped: state.stopped }
}
