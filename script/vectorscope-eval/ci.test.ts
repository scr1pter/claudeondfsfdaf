import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Ledger, defaultLimits } from "./budget"
import { JOURNAL, KEY_ENV, main, parseInputs, runArgs, type Child, type Inputs } from "./ci"

// The workflow's entry point and the workflow file itself. Nothing here sends a request or starts run.ts with a key:
// the paid mode is exercised with a stand-in for the child process.

const root = mkdtempSync(join(tmpdir(), "vectorscope-ci-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const WORKFLOW = join(import.meta.dir, "..", "..", ".github", "workflows", "vectorscope-eval.yml")

const DRY = {
  EVAL_MODE: "dry-run",
  EVAL_MODELS: "anthropic/claude-sonnet-4.5=3:15, openai/gpt-5-mini=0.25:2",
  EVAL_BUDGET_USD: "",
  EVAL_CASE_BUDGET_USD: "",
  EVAL_MAX_TOKENS: "16000",
  EVAL_REPEAT: "1",
  EVAL_FIXTURES: "",
}
const PAID = { ...DRY, EVAL_MODE: "paid", EVAL_BUDGET_USD: "50", EVAL_CASE_BUDGET_USD: "0.75" }

function inputs(env: Record<string, string>): Inputs {
  const parsed = parseInputs(env)
  if ("problems" in parsed) throw new Error(parsed.problems.join("\n"))
  return parsed.inputs
}

function problems(env: Record<string, string>): string[] {
  const parsed = parseInputs(env)
  return "problems" in parsed ? parsed.problems : []
}

describe("dispatch inputs", () => {
  test("a dry run needs models and limits but no budget", () => {
    expect(inputs(DRY)).toEqual({
      mode: "dry-run",
      models: [
        { id: "anthropic/claude-sonnet-4.5", price: { input: 3, output: 15 } },
        { id: "openai/gpt-5-mini", price: { input: 0.25, output: 2 } },
      ],
      maxTokens: 16000,
      repeat: 1,
    })
  })

  test("a paid run needs a finite positive budget and a per-case bound it can admit", () => {
    expect(inputs(PAID).limits).toEqual(defaultLimits(50, 0.75))
    expect(problems({ ...PAID, EVAL_BUDGET_USD: "", EVAL_CASE_BUDGET_USD: "" })).toContain(
      "a paid run needs budget_usd and case_budget_usd",
    )
    expect(problems({ ...PAID, EVAL_CASE_BUDGET_USD: "" })).toContain("budget_usd and case_budget_usd go together")
    for (const bad of ["0", "-5", "NaN", "Infinity", "1e3", "5,00", "$50", " ", "50; echo"]) {
      const found = problems({ ...PAID, EVAL_BUDGET_USD: bad })
      expect(found.length).toBeGreaterThan(0)
    }
    expect(problems({ ...PAID, EVAL_CASE_BUDGET_USD: "46" }).join("\n")).toContain("per-case bound")
  })

  test("a paid run's prices must be above zero, so its estimates bound spend", () => {
    expect(problems({ ...PAID, EVAL_MODELS: "some/free-model=0:0" }).join("\n")).toContain("prices above zero")
    expect(problems({ ...DRY, EVAL_MODELS: "some/free-model=0:0" })).toEqual([])
  })

  test("shell, flag and workflow-command text is refused, and quoted when reported", () => {
    for (const models of [
      "a/b=3:15;rm -rf /",
      "$(curl evil)=3:15",
      "`id`=3:15",
      "--out=/tmp/x=3:15",
      "-m=3:15",
      "a/b=3:15\n::add-mask::x",
      "a b=3:15",
      "a/b",
      "a/b=3",
      "a/b=-1:2",
    ]) {
      const found = problems({ ...DRY, EVAL_MODELS: models })
      expect(found.length).toBeGreaterThan(0)
      for (const line of found) expect(line.split("\n")).toHaveLength(1)
    }
    expect(problems({ ...DRY, EVAL_FIXTURES: "a,b;c" }).length).toBe(1)
    expect(problems({ ...DRY, EVAL_FIXTURES: "../x" }).length).toBe(1)
    expect(problems({ ...DRY, EVAL_REPEAT: "6" }).length).toBe(1)
    expect(problems({ ...DRY, EVAL_MAX_TOKENS: "0" }).length).toBe(1)
    expect(problems({ ...DRY, EVAL_MAX_TOKENS: "200001" }).length).toBe(1)
    expect(problems({ ...DRY, EVAL_MODE: "paid; true" }).length).toBeGreaterThan(0)
    expect(problems({ ...DRY, EVAL_MODELS: "a/b=1:1,a/b=2:2" }).join("\n")).toContain("more than once")
  })

  test("run.ts gets an argument array: a dry run without a directory, the eval's own key with one", () => {
    const paid = inputs({ ...PAID, EVAL_FIXTURES: "order-search-sql,digest-frequency" })
    expect(runArgs(paid, 0)).toEqual([
      "--model",
      "anthropic/claude-sonnet-4.5",
      "--price",
      "3:15",
      "--max-tokens",
      "16000",
      "--repeat",
      "1",
      "--fixture",
      "order-search-sql,digest-frequency",
      "--budget-usd",
      "50",
      "--case-budget-usd",
      "0.75",
      "--dry-run",
    ])
    const sending = runArgs(paid, 1, "/runner/tmp/vectorscope-eval")
    expect(sending.slice(-6)).toEqual([
      "--ledger",
      `/runner/tmp/vectorscope-eval/${JOURNAL}`,
      "--out",
      "/runner/tmp/vectorscope-eval/2-openai_gpt-5-mini.json",
      "--api-key-env",
      KEY_ENV,
    ])
    // No input chooses the endpoint the key is sent to.
    expect(sending).not.toContain("--base-url")
  })
})

describe("modes", () => {
  test("plan validates and estimates without a key or any child process", async () => {
    const out: string[] = []
    const summary = join(root, "plan-summary.md")
    const code = await main("plan", {
      env: { ...PAID, EVAL_FIXTURES: "order-search-sql", GITHUB_STEP_SUMMARY: summary },
      stdout: (text) => void out.push(text),
      spawn: () => {
        throw new Error("plan must not start a process")
      },
    })
    expect(code).toBe(0)
    const text = out.join("")
    expect(text).toContain("Estimate for anthropic/claude-sonnet-4.5")
    expect(text).toContain("Estimate for openai/gpt-5-mini")
    expect(text).toContain("the worst case fits")
    expect(text).toContain("waits for the owner's approval")
    expect(readFileSync(summary, "utf8")).toContain("<pre>")
  })

  test("invalid inputs fail the plan", async () => {
    const err: string[] = []
    expect(
      await main("plan", {
        env: { ...DRY, EVAL_MODELS: "nope" },
        stderr: (text) => void err.push(text),
        stdout: () => {},
      }),
    ).toBe(1)
    expect(err.join("")).toContain("not valid")
    expect(
      await main("plan", { env: { ...DRY, EVAL_FIXTURES: "no-such-fixture" }, stderr: () => {}, stdout: () => {} }),
    ).toBe(1)
  })

  test("paid runs each model with only the eval key, one shared journal, and stops once the ledger stops", async () => {
    const dir = join(root, "paid")
    const started: { argv: string[]; env: Record<string, string> }[] = []
    const spawn = (argv: string[], env: Record<string, string>): Child => {
      started.push({ argv, env })
      // The first model's run overshoots its reservation, so the ledger stops admitting.
      const journal = argv[argv.indexOf("--ledger") + 1]!
      const ledger = Ledger.open({ limits: defaultLimits(50, 0.75), journal })
      const admission = ledger.admit({ case: "x", kind: "provider", model: "m", estimateUsd: 0.2 })
      if (admission.admitted) admission.ticket.settle({ costUsd: 0.5 })
      ledger.close()
      return { stdout: Promise.resolve("report\n::set-env name=X::y\n"), exited: Promise.resolve(1), kill: () => {} }
    }
    const out: string[] = []
    const err: string[] = []
    const code = await main("paid", {
      env: {
        ...PAID,
        EVAL_OUT_DIR: dir,
        [KEY_ENV]: "test-key",
        OPENROUTER_API_KEY: "must-not-pass",
        GITHUB_TOKEN: "must-not-pass",
        GITHUB_ACTIONS: "true",
        PATH: "/usr/bin",
      },
      spawn,
      stdout: (text) => void out.push(text),
      stderr: (text) => void err.push(text),
    })
    expect(code).toBe(1)
    expect(started).toHaveLength(1)
    expect(started[0]!.env).toEqual({ PATH: "/usr/bin", [KEY_ENV]: "test-key" })
    expect(started[0]!.argv.join(" ")).not.toContain("test-key")
    expect(err.join("")).toContain("Not starting openai/gpt-5-mini: the ledger stopped admitting")
    // Model output is printed with workflow commands switched off around it.
    const text = out.join("")
    const token = /::stop-commands::(\S+)/.exec(text)?.[1]
    expect(token).toBeDefined()
    expect(text.indexOf("::set-env")).toBeGreaterThan(text.indexOf(`::stop-commands::${token}`))
    expect(text.indexOf(`::${token}::`)).toBeGreaterThan(text.indexOf("::set-env"))
  })

  test("paid refuses without the eval key, in dry-run mode, or with reports inside the repository", async () => {
    const spawn = () => {
      throw new Error("must not start")
    }
    const quiet = { stdout: () => {}, stderr: () => {}, spawn }
    expect(await main("paid", { ...quiet, env: { ...PAID, EVAL_OUT_DIR: join(root, "x") } })).toBe(1)
    expect(
      await main("paid", {
        ...quiet,
        env: { ...PAID, EVAL_OUT_DIR: join(root, "x"), OPENROUTER_API_KEY: "the old key is not the eval's" },
      }),
    ).toBe(1)
    expect(await main("paid", { ...quiet, env: { ...DRY, EVAL_OUT_DIR: join(root, "x"), [KEY_ENV]: "k" } })).toBe(1)
    expect(await main("paid", { ...quiet, env: { ...PAID, EVAL_OUT_DIR: import.meta.dir, [KEY_ENV]: "k" } })).toBe(1)
  })

  test("report summarises the journal, counting an attempt left open at its reservation", async () => {
    const dir = join(root, "report")
    const out: string[] = []
    expect(await main("report", { env: { EVAL_OUT_DIR: dir }, stdout: (text) => void out.push(text) })).toBe(0)
    expect(out.join("")).toContain("no paid attempt was admitted")

    const journal = join(dir, JOURNAL)
    mkdirSync(dir, { recursive: true })
    const ledger = Ledger.open({ limits: defaultLimits(50, 0.75), journal })
    const admission = ledger.admit({ case: "x", kind: "provider", model: "m", estimateUsd: 0.4 })
    if (admission.admitted) admission.ticket.sent()
    // The run was killed here; the lock is left behind and the report still reads the journal.
    out.length = 0
    expect(await main("report", { env: { EVAL_OUT_DIR: dir }, stdout: (text) => void out.push(text) })).toBe(0)
    expect(out.join("")).toContain("$0.4000 uncertain")
    expect(JSON.parse(readFileSync(join(dir, "budget.json"), "utf8")).uncertainUsd).toBeCloseTo(0.4)
    expect(existsSync(`${journal}.lock`)).toBe(true)
  })
})

describe("the workflow", () => {
  const text = readFileSync(WORKFLOW, "utf8")
  const workflow = Bun.YAML.parse(text) as {
    on: Record<string, { inputs: Record<string, { default?: string; required?: boolean; options?: string[] }> }>
    permissions: Record<string, string>
    jobs: Record<
      string,
      {
        if?: string
        needs?: string
        environment?: string
        steps: { name: string; if?: string; run?: string; env?: Record<string, string> }[]
      }
    >
  }

  test("is manual only, with no pull request, push, schedule or other trigger", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"])
  })

  test("has no paid default: the mode defaults to a dry run and the budget to nothing", () => {
    const inputs = workflow.on.workflow_dispatch!.inputs
    expect(inputs.mode).toMatchObject({ default: "dry-run", options: ["dry-run", "paid"] })
    expect(inputs.budget_usd!.default).toBe("")
    expect(inputs.case_budget_usd!.default).toBe("")
    expect(inputs.models!.default).toBeUndefined()
  })

  test("never writes an input or any other expression into a shell command", () => {
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps)
    for (const step of steps) if (step.run) expect(step.run).not.toContain("${{")
    for (const step of steps)
      for (const value of Object.values(step.env ?? {}))
        if (value.includes("inputs.")) expect(value).toMatch(/^\$\{\{ inputs\.[a-z_]+ \}\}$/)
  })

  test("spends only in the protected vectorscope-eval environment, with its own new secret", () => {
    expect(workflow.permissions).toEqual({ contents: "read" })
    const { plan, eval: paid } = workflow.jobs
    expect(plan!.environment).toBeUndefined()
    expect(JSON.stringify(plan)).not.toContain("secrets.")
    expect(paid).toMatchObject({ needs: "plan", if: "inputs.mode == 'paid'", environment: "vectorscope-eval" })
    const secrets = [...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1])
    expect(secrets).toEqual([KEY_ENV])
    expect(text).not.toContain("OPENROUTER_API_KEY")
    // Only the step that runs the models sees the key.
    const holders = paid!.steps.filter((step) => JSON.stringify(step.env ?? {}).includes("secrets."))
    expect(holders.map((step) => step.run)).toEqual(["bun script/vectorscope-eval/ci.ts paid"])
  })

  test("summarises the ledger and keeps the reports even when the run fails or is cancelled", () => {
    const steps = workflow.jobs.eval!.steps
    const report = steps.find((step) => step.run === "bun script/vectorscope-eval/ci.ts report")
    expect(report).toMatchObject({ if: "always()" })
    expect(steps.find((step) => step.name === "Keep the reports and the ledger")).toMatchObject({ if: "always()" })
  })
})
