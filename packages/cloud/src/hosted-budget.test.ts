import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  BUDGET_FACTOR,
  CLI_ENV,
  budgetPlan,
  cycleEnd,
  readBudget,
  readSettings,
  readWorstCase,
  runBudget,
  VECTOR_ORIGIN,
  VERCEL_CLI_VERSION,
  vercelCli,
  type Cli,
  type Settings,
  type Spawn,
} from "./hosted-budget"

// WP A56: the hosted team's budget workflow (M9: the Vercel hosted team's budget is never lowered within a cycle). The
// calculation, the CLI conversation (against a fake CLI, never Vercel) and the workflow file's compliance.

const root = new URL("../../..", import.meta.url).pathname
const read = (path: string) => Bun.file(`${root}/${path}`).text()

const NOW = Date.UTC(2026, 10, 10, 6, 17)
const SETTINGS: Settings = {
  token: "fixture-billing-token",
  team: "team_fixtureHostedTeam1",
  readSecret: "fixture-budget-read-secret-".padEnd(40, "b"),
  billingDay: 14,
  ceiling: 2_000,
}

describe("the budget calculation", () => {
  test("sets max(current, spend + 1.3 × worst case), in whole dollars rounded up", () => {
    expect(BUDGET_FACTOR).toBe(1.3)
    expect(budgetPlan({ current: 100, spend: 63.33, worstCaseUsd: 200, ceiling: 2_000 })).toEqual({
      amount: 324,
      raise: true,
      capped: false,
    })
    // 0.10 × 1.3 = 0.13 exactly: no floating-point dollar is added.
    expect(budgetPlan({ current: 1, spend: 0.87, worstCaseUsd: 0.1, ceiling: 2_000 }).amount).toBe(1)
    expect(budgetPlan({ current: 0, spend: 0, worstCaseUsd: 0, ceiling: 2_000 })).toEqual({
      amount: 0,
      raise: false,
      capped: false,
    })
  })

  test("never lowers the budget, however low spend and the worst case are", () => {
    for (const [spend, worstCaseUsd] of [
      [0, 0],
      [10, 5],
      [499, 0],
      [100, 300],
    ] as const) {
      const plan = budgetPlan({ current: 500, spend, worstCaseUsd, ceiling: 2_000 })
      expect(plan.amount).toBe(500)
      expect(plan.raise).toBe(false)
    }
    // A fractional current budget is kept whole, upwards.
    expect(budgetPlan({ current: 99.5, spend: 0, worstCaseUsd: 0, ceiling: 2_000 }).amount).toBe(100)
  })

  test("never sets above the ceiling, and says so; a budget already above it stays", () => {
    expect(budgetPlan({ current: 100, spend: 900, worstCaseUsd: 1_000, ceiling: 1_500 })).toEqual({
      amount: 1_500,
      raise: true,
      capped: true,
    })
    expect(budgetPlan({ current: 3_000, spend: 2_900, worstCaseUsd: 1_000, ceiling: 1_500 })).toEqual({
      amount: 3_000,
      raise: false,
      capped: true,
    })
    expect(budgetPlan({ current: 3_000, spend: 10, worstCaseUsd: 10, ceiling: 1_500 })).toEqual({
      amount: 3_000,
      raise: false,
      capped: false,
    })
  })

  test("refuses figures that are not numbers", () => {
    expect(() => budgetPlan({ current: Number.NaN, spend: 0, worstCaseUsd: 0, ceiling: 1 })).toThrow()
    expect(() => budgetPlan({ current: 1, spend: -1, worstCaseUsd: 0, ceiling: 1 })).toThrow()
  })

  test("the cycle ends on the owner's billing day, at UTC midnight, always ahead", () => {
    expect(cycleEnd(NOW, 14)).toBe(Date.UTC(2026, 10, 14))
    expect(cycleEnd(NOW, 10)).toBe(Date.UTC(2026, 11, 10))
    expect(cycleEnd(Date.UTC(2026, 10, 10), 10)).toBe(Date.UTC(2026, 11, 10))
    expect(cycleEnd(Date.UTC(2026, 11, 31, 23), 1)).toBe(Date.UTC(2027, 0, 1))
    expect(() => cycleEnd(NOW, 29)).toThrow()
    expect(() => cycleEnd(NOW, 0)).toThrow()
  })
})

describe("reading the answers", () => {
  test("the CLI's budget, leniently, in dollars; cents fields are divided; no budget is said so", () => {
    expect(readBudget(JSON.stringify({ scope: "team", amount: 200, spent: 63.33, status: "active", pause: false }))).toEqual({
      amount: 200,
      spent: 63.33,
    })
    expect(readBudget(JSON.stringify({ budget: { amount: 200 }, currentSpend: 12 }))).toEqual({ amount: 200, spent: 12 })
    expect(readBudget(JSON.stringify({ budgets: [{ scope: "team", amountInCents: 20_000, spentInCents: 6_333 }] }))).toEqual({
      amount: 200,
      spent: 63.33,
    })
    expect(readBudget(JSON.stringify({ amount: "$200", spent: "$63.33" }))).toEqual({ amount: 200, spent: 63.33 })
    expect(readBudget(JSON.stringify({ budgets: [] }))).toEqual({ none: true })
    expect(readBudget(JSON.stringify({ budget: null, spent: 63.33 }))).toEqual({ none: true })
  })

  test("anything else is unreadable, so nothing is changed", () => {
    for (const output of [
      "",
      "not json",
      "[]",
      JSON.stringify({ amount: 200 }),
      JSON.stringify({ amount: -1, spent: 1 }),
      JSON.stringify({ amount: { value: 200 }, spent: 1 }),
      JSON.stringify({ budgets: [{ scope: "team", amount: 1, spent: 1 }, { scope: "team", amount: 2, spent: 1 }] }),
    ])
      expect(readBudget(output)).toBeUndefined()
  })

  test("Vector's worst case must answer the cycle asked for", () => {
    expect(readWorstCase({ cycleEnd: 5, worstCaseUsd: 12.5 }, 5)).toBe(12.5)
    expect(readWorstCase({ cycleEnd: 6, worstCaseUsd: 12.5 }, 5)).toBeUndefined()
    expect(readWorstCase({ cycleEnd: 5, worstCaseUsd: "12" }, 5)).toBeUndefined()
    expect(readWorstCase({ cycleEnd: 5, worstCaseUsd: -1 }, 5)).toBeUndefined()
  })

  test("settings: the hosted team, the read secret, the billing day and a ceiling are all required", () => {
    const env = {
      VERCEL_TOKEN: SETTINGS.token,
      VECTOR_HOSTED_VERCEL_TEAM_ID: SETTINGS.team,
      VECTOR_HOSTED_BUDGET_READ_SECRET: SETTINGS.readSecret,
      VECTOR_HOSTED_BILLING_DAY: "14",
      VECTOR_HOSTED_BUDGET_MAX_USD: "2000",
    }
    expect(readSettings(env)).toEqual(SETTINGS)
    for (const name of Object.keys(env)) expect(readSettings({ ...env, [name]: undefined })).toHaveProperty("problem")
    expect(readSettings({ ...env, VECTOR_HOSTED_BILLING_DAY: "31" })).toHaveProperty("problem")
    expect(readSettings({ ...env, VECTOR_HOSTED_BUDGET_MAX_USD: "12.5" })).toHaveProperty("problem")
    expect(readSettings({ ...env, VECTOR_HOSTED_VERCEL_TEAM_ID: "my-team" })).toHaveProperty("problem")
  })
})

type World = {
  calls: string[][]
  fetches: { url: string; authorization: string | null; redirect?: string }[]
  budget: { amount: number; spent: number } | undefined
}

function world(input: {
  budget?: { amount: number; spent: number }
  worst?: number
  vector?: (cycle: number) => Response
  legacy?: boolean
  refuseSet?: boolean
  ignoreSet?: boolean
}) {
  const state: World = { calls: [], fetches: [], budget: input.budget }
  const cli: Cli = async (args) => {
    state.calls.push(args)
    const form = input.legacy ? ["budgets"] : ["billing", "budgets"]
    if (!form.every((word, index) => args[index] === word)) return { code: 2, stdout: "" }
    const rest = args.slice(form.length)
    if (rest[0] === "set") {
      if (input.refuseSet) return { code: 1, stdout: "" }
      const amount = Number(rest[rest.indexOf("--amount") + 1])
      if (state.budget && !input.ignoreSet) state.budget = { ...state.budget, amount }
      return { code: 0, stdout: `> Success! Budget updated. $${amount}` }
    }
    if (rest[0] === "inspect" || rest[0] === "--json")
      return {
        code: 0,
        stdout: JSON.stringify(state.budget ? { scope: "team", ...state.budget, pause: false } : { budget: null, spent: 1 }),
      }
    return { code: 2, stdout: "" }
  }
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url)
    state.fetches.push({
      url: target,
      authorization: new Headers(init?.headers).get("authorization"),
      ...(init?.redirect ? { redirect: init.redirect } : {}),
    })
    const cycle = Number(new URL(target).searchParams.get("cycleEnd"))
    if (input.vector) return input.vector(cycle)
    return Response.json({ computedAt: NOW, cycleEnd: cycle, accounts: 3, minutes: 1, computers: 1, worstCaseUsd: input.worst ?? 0 })
  }) as typeof fetch
  return { state, run: () => runBudget({ settings: SETTINGS, cli, fetch: fetcher, now: NOW }) }
}

describe("a run", () => {
  test("reads Vector's worst case with the read secret, raises the budget with --amount only, and confirms it", async () => {
    const { state, run } = world({ budget: { amount: 100, spent: 63.33 }, worst: 200 })
    const outcome = await run()
    expect(outcome.status).toBe("raised")
    expect(state.fetches).toEqual([
      {
        url: `${VECTOR_ORIGIN}/api/hosted/admin/budget?cycleEnd=${Date.UTC(2026, 10, 14)}`,
        authorization: `Bearer ${SETTINGS.readSecret}`,
        redirect: "error",
      },
    ])
    expect(state.calls).toEqual([
      ["billing", "budgets", "inspect", "--json", "--scope", SETTINGS.team, "--non-interactive"],
      ["billing", "budgets", "set", "--amount", "324", "--scope", SETTINGS.team, "--non-interactive"],
      ["billing", "budgets", "inspect", "--json", "--scope", SETTINGS.team, "--non-interactive"],
    ])
    expect(state.budget?.amount).toBe(324)
  })

  test("never passes --pause, a webhook flag or the token on the command line", async () => {
    const { state, run } = world({ budget: { amount: 100, spent: 900 }, worst: 1_000 })
    await run()
    const flags = state.calls.flat().filter((arg) => arg.startsWith("-"))
    expect(new Set(flags)).toEqual(new Set(["--json", "--scope", "--non-interactive", "--amount"]))
    expect(state.calls.flat().join(" ")).not.toContain(SETTINGS.token)
    expect(await read("packages/cloud/src/hosted-budget.ts")).not.toMatch(/["'`]--(?:no-)?(?:pause|webhook)["'`]/)
  })

  test("a budget that already covers the worst case is left alone", async () => {
    const { state, run } = world({ budget: { amount: 900, spent: 100 }, worst: 300 })
    expect((await run()).status).toBe("unchanged")
    expect(state.calls.filter((args) => args.includes("set"))).toEqual([])
    expect(state.budget?.amount).toBe(900)
  })

  test("the ceiling holds: raised only to it, and the run fails so the owner sees it", async () => {
    const { state, run } = world({ budget: { amount: 100, spent: 1_500 }, worst: 1_000 })
    const outcome = await run()
    expect(outcome.status).toBe("capped")
    expect(state.budget?.amount).toBe(2_000)
  })

  test("the older `vercel budgets` form works too", async () => {
    const { state, run } = world({ budget: { amount: 100, spent: 0 }, worst: 200, legacy: true })
    expect((await run()).status).toBe("raised")
    expect(state.calls.find((args) => args.includes("set"))?.slice(0, 2)).toEqual(["budgets", "set"])
  })

  test("nothing is changed when anything cannot be read, and a missing budget is never created", async () => {
    for (const vector of [
      () => new Response("{}", { status: 401 }),
      () => Response.json({ cycleEnd: 1, worstCaseUsd: 5 }),
      () => new Response("not json"),
    ]) {
      const { state, run } = world({ budget: { amount: 100, spent: 0 }, vector })
      expect((await run()).status).toBe("failed")
      expect(state.calls).toEqual([])
    }
    const missing = world({ worst: 50 })
    expect((await missing.run()).status).toBe("failed")
    expect(missing.state.calls.filter((args) => args.includes("set"))).toEqual([])
  })

  test("a refused or unconfirmed set fails the run", async () => {
    expect((await world({ budget: { amount: 100, spent: 0 }, worst: 200, refuseSet: true }).run()).status).toBe("failed")
    expect((await world({ budget: { amount: 100, spent: 0 }, worst: 200, ignoreSet: true }).run()).status).toBe("failed")
  })

  test("no outcome carries an amount (the repository's Actions logs are public)", async () => {
    const outcomes = await Promise.all([
      world({ budget: { amount: 100, spent: 63.33 }, worst: 200 }).run(),
      world({ budget: { amount: 900, spent: 100 }, worst: 300 }).run(),
      world({ budget: { amount: 100, spent: 1_500 }, worst: 1_000 }).run(),
      world({ worst: 50 }).run(),
    ])
    for (const outcome of outcomes) expect(outcome.message).not.toMatch(/\d|\$/)
  })
})

describe("the workflow", () => {
  type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }
  type Job = {
    if?: string
    environment?: string
    permissions?: Record<string, string>
    needs?: string | string[]
    "runs-on"?: string
    steps?: Step[]
  }
  type Workflow = { on: Record<string, unknown>; permissions?: Record<string, string>; jobs: Record<string, Job> }
  const file = ".github/workflows/vector-hosted-budget.yml"
  const workflow = async () => Bun.YAML.parse(await read(file)) as Workflow

  test("runs daily and on dispatch, only when the owner turned it on, and only from the default branch", async () => {
    const parsed = await workflow()
    expect(Object.keys(parsed.on).sort()).toEqual(["schedule", "workflow_dispatch"])
    expect((parsed.on.schedule as { cron: string }[]).length).toBe(1)
    for (const job of Object.values(parsed.jobs)) {
      expect(job.if).toContain("vars.VECTOR_HOSTED_BUDGET_AUTOMATION == 'true'")
      expect(job.if).toContain("github.ref == format('refs/heads/{0}', github.event.repository.default_branch)")
    }
  })

  test("its secrets reach only the hosted-production job, after the environment check", async () => {
    const text = await read(file)
    const parsed = await workflow()
    expect(parsed.permissions).toEqual({ contents: "read" })
    expect(parsed.jobs.guard?.environment).toBeUndefined()
    expect(parsed.jobs.guard?.permissions).toEqual({ contents: "read", actions: "read" })
    const environments = Object.entries(parsed.jobs).filter(([, job]) => job.environment)
    expect(environments.map(([name, job]) => [name, job.environment])).toEqual([["budget", "hosted-production"]])
    expect(parsed.jobs.budget?.needs).toBe("guard")
    expect(parsed.jobs.budget?.permissions).toBeUndefined()
    const secrets = [...text.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1])
    expect(new Set(secrets)).toEqual(new Set(["VECTOR_HOSTED_BUDGET_VERCEL_TOKEN", "VECTOR_HOSTED_BUDGET_READ_SECRET"]))
    const run = parsed.jobs.budget?.steps?.find((step) => step.name === "Raise the budget")
    expect(run?.run).toBe("bun packages/cloud/src/hosted-budget.ts")
    expect(Object.keys(run?.env ?? {}).sort()).toEqual([
      "VECTOR_HOSTED_BILLING_DAY",
      "VECTOR_HOSTED_BUDGET_MAX_USD",
      "VECTOR_HOSTED_BUDGET_READ_SECRET",
      "VECTOR_HOSTED_VERCEL_TEAM_ID",
      "VERCEL_TOKEN",
    ])
    // No other step sees a secret, and the checkout keeps no credential.
    for (const step of parsed.jobs.budget?.steps ?? [])
      if (step !== run) expect(JSON.stringify(step)).not.toContain("secrets.")
    expect(parsed.jobs.budget?.steps?.[0]?.with).toEqual({ "persist-credentials": false })
  })

  test("never pauses, pins every action by commit and its runner, and names an exact CLI", async () => {
    const text = await read(file)
    expect(text).not.toMatch(/--(?:no-)?pause\b/)
    expect(text).not.toMatch(/runs-on: (?:ubuntu|macos|windows)-latest/)
    for (const job of Object.values((await workflow()).jobs)) expect(job["runs-on"]).toBe("ubuntu-24.04")
    const actions = text
      .split("\n")
      .map((line) => line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/)?.[1])
      .filter((value): value is string => typeof value === "string")
    expect(actions.length).toBeGreaterThan(0)
    expect(actions.filter((action) => !/@[a-f0-9]{40}$/.test(action))).toEqual([])
    expect(VERCEL_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test("the CLI is installed once with no install scripts and no secret, then run with the token alone (P8 review)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vector-cli-test-"))
    try {
      const calls: { command: string; args: string[]; env: Record<string, string> }[] = []
      let version = VERCEL_CLI_VERSION
      const spawn: Spawn = async (command, args, env) => {
        calls.push({ command, args, env })
        if (command === "npm") {
          mkdirSync(path.join(dir, "node_modules", "vercel"), { recursive: true })
          writeFileSync(path.join(dir, "node_modules", "vercel", "package.json"), JSON.stringify({ version }))
          return { code: 0, stdout: "" }
        }
        return { code: 0, stdout: "{}" }
      }
      const env = {
        PATH: "/usr/bin",
        HOME: "/home/runner",
        VERCEL_TOKEN: "fixture-billing-token",
        VECTOR_HOSTED_VERCEL_TOKEN: "fixture-hosted-token",
        VECTOR_HOSTED_BUDGET_READ_SECRET: "fixture-read-secret",
        VERCEL_ORG_ID: "team_fixture",
        DOCKER_CONFIG: "/tmp/docker",
        GITHUB_TOKEN: "fixture-github-token",
      }
      const cli = vercelCli("fixture-billing-token", { spawn, dir, env })
      expect(await cli(["billing", "budgets", "inspect", "--json"])).toEqual({ code: 0, stdout: "{}" })
      expect(await cli(["whoami"])).toEqual({ code: 0, stdout: "{}" })
      const [install, ...runs] = calls
      expect(install!.command).toBe("npm")
      expect(install!.args).toContain("--ignore-scripts")
      expect(install!.args).toContain(`vercel@${VERCEL_CLI_VERSION}`)
      expect(install!.args.join(" ")).not.toMatch(/npx|--yes/)
      expect(install!.env.npm_config_ignore_scripts).toBe("true")
      // npm never sees a token or secret: only where to find programs and its own folders.
      expect(Object.keys(install!.env).sort()).toEqual([
        "HOME",
        "PATH",
        "npm_config_cache",
        "npm_config_ignore_scripts",
        "npm_config_update_notifier",
        "npm_config_userconfig",
      ])
      expect(JSON.stringify(install!.env)).not.toContain("fixture-")
      // Installed once; each call runs that install's CLI with the token and the names it needs, nothing else.
      expect(runs.map((run) => run.command)).toEqual([path.join(dir, "node_modules", ".bin", "vercel"), path.join(dir, "node_modules", ".bin", "vercel")])
      for (const run of runs) {
        expect(run.env.VERCEL_TOKEN).toBe("fixture-billing-token")
        for (const name of Object.keys(run.env)) expect([...CLI_ENV, "VERCEL_TOKEN", "NO_COLOR", "CI"]).toContain(name)
        expect(JSON.stringify(run.env)).not.toMatch(/fixture-(?:hosted-token|read-secret|github-token)/)
      }
      // An install that does not report the pinned version runs nothing.
      version = "0.0.1"
      calls.length = 0
      const wrong = vercelCli("fixture-billing-token", { spawn, dir, env })
      expect(await wrong(["whoami"])).toEqual({ code: 1, stdout: "" })
      expect(calls.map((call) => call.command)).toEqual(["npm"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the environment check refuses an unprotected or missing hosted-production", async () => {
    const script = (await workflow()).jobs.guard?.steps?.find(
      (step) => step.name === "Require protected hosted-production environment",
    )?.run
    expect(script).toBeDefined()
    for (const response of ["1", "2", "0", "", "invalid", "missing"]) {
      const command = `gh() {
        test "$1" = api && test "$2" = repos/fixture/repo/environments/hosted-production || return 99
        case "$FIXTURE_RESPONSE" in missing) return 1;; esac
        printf '%s\\n' "$FIXTURE_RESPONSE"
      }
      ${script}`
      const child = Bun.spawn(["bash", "-c", command], {
        env: { PATH: process.env.PATH ?? "", GITHUB_REPOSITORY: "fixture/repo", FIXTURE_RESPONSE: response },
        stdout: "ignore",
        stderr: "ignore",
      })
      expect(await child.exited).toBe(["1", "2"].includes(response) ? 0 : 1)
    }
  })
})
