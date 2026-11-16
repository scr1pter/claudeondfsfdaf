import { afterAll, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Ledger, defaultLimits } from "./budget"
import {
  DEFAULT_VARIANTS,
  ENGINE_DIR,
  JOURNAL,
  KEY_ENV,
  main,
  MIRROR_GIT,
  mirrorPlan,
  parseInputs,
  PUBLIC_KEY_ENV,
  REPLAY_ENTRY,
  replayArgs,
  runArgs,
  SEALED,
  seal,
  unseal,
  type Child,
  type Inputs,
} from "./ci"
import { loadManifest, SEED_MANIFEST, type Manifest } from "./dataset"
import { outsideRepository, REPO_ROOT } from "./paths"
import { OUTCOME_LEDGER_FILE } from "./seal"

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

// The owner's key pair; only the public half is ever given to the workflow.
const OWNER = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
})
// What the paid job's step has: the Actions runner, its environment's name, and the owner's public key.
const JOB = { GITHUB_ACTIONS: "true", EVAL_ENVIRONMENT: "vectorscope-eval", [PUBLIC_KEY_ENV]: OWNER.publicKey }
// What run.ts prints and logs: scores, misses and false alarms, which a public log must never show (D12).
const SCORES = [
  "audit-log-pagination  1  2  1  1  0  0.50  1.00  0.67",
  "Totals over 2 scored run(s): TP 1 · FP 1 · FN 0 · precision 0.50 · recall 1.00 · F1 0.67",
  "missed off-by-one (src/pagination.ts:12)",
  "false alarm src/app.ts:3 [blocking] Unused import",
]

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
  test("a dry run needs models and limits but no budget, and runs the smoke pipeline by default", () => {
    expect(inputs(DRY)).toEqual({
      mode: "dry-run",
      pipeline: "smoke",
      models: [
        { id: "anthropic/claude-sonnet-4.5", price: { input: 3, output: 15 } },
        { id: "openai/gpt-5-mini", price: { input: 0.25, output: 2 } },
      ],
      maxTokens: 16000,
      repeat: 1,
      variants: [],
    })
    expect(inputs({ ...DRY, EVAL_PIPELINE: "" })).toEqual(inputs(DRY))
    expect(inputs({ ...DRY, EVAL_PIPELINE: "smoke" })).toEqual(inputs(DRY))
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
    const summaryFile = join(root, "paid-summary.md")
    const started: { argv: string[]; env: Record<string, string> }[] = []
    const spawn = (argv: string[], env: Record<string, string>): Child => {
      started.push({ argv, env })
      // The first model's run overshoots its reservation, so the ledger stops admitting.
      const journal = argv[argv.indexOf("--ledger") + 1]!
      const ledger = Ledger.open({ limits: defaultLimits(50, 0.75), journal })
      const admission = ledger.admit({ case: "x", kind: "provider", model: "m", estimateUsd: 0.2 })
      if (admission.admitted) admission.ticket.settle({ costUsd: 0.5 })
      ledger.close()
      return {
        stdout: Promise.resolve(`${SCORES.join("\n")}\n::set-env name=X::y\n`),
        stderr: Promise.resolve(`  audit-log-pagination: TP 1 FP 1 FN 0\n`),
        exited: Promise.resolve(1),
        kill: () => {},
      }
    }
    const out: string[] = []
    const err: string[] = []
    const code = await main("paid", {
      env: {
        ...PAID,
        ...JOB,
        EVAL_OUT_DIR: dir,
        GITHUB_STEP_SUMMARY: summaryFile,
        [KEY_ENV]: "test-key",
        OPENROUTER_API_KEY: "must-not-pass",
        GITHUB_TOKEN: "must-not-pass",
        PATH: "/usr/bin",
      },
      spawn,
      stdout: (text) => void out.push(text),
      stderr: (text) => void err.push(text),
    })
    expect(code).toBe(1)
    expect(started).toHaveLength(1)
    expect(started[0]!.env).toEqual({
      PATH: "/usr/bin",
      GITHUB_ACTIONS: "true",
      VECTORSCOPE_EVAL_ENVIRONMENT: "vectorscope-eval",
      [KEY_ENV]: "test-key",
    })
    expect(started[0]!.argv.join(" ")).not.toContain("test-key")
    expect(err.join("")).toContain("Not starting openai/gpt-5-mini: the ledger stopped admitting")
    // The public log and step summary get the ledger's spend and counts, and no score, finding or model text (D12).
    const text = out.join("")
    const summary = readFileSync(summaryFile, "utf8")
    expect(text).toContain("anthropic/claude-sonnet-4.5: run.ts exited with 1")
    expect(text).toContain("Spent $0.5000 as reported")
    expect(summary).toContain("Spent $0.5000 as reported")
    for (const published of [text, summary, err.join("")]) {
      for (const line of [...SCORES, "TP 1 FP 1 FN 0", "::set-env"]) expect(published).not.toContain(line)
      expect(published).not.toMatch(/precision|recall|false alarm|missed /i)
    }
    // run.ts's output is kept beside its report, for the sealed artifact only.
    const log = readFileSync(join(dir, "1-anthropic_claude-sonnet-4.5.log"), "utf8")
    for (const line of SCORES) expect(log).toContain(line)
    expect(log).toContain("TP 1 FP 1 FN 0")
  })

  test("paid refuses outside the eval environment, without its key or the owner's public key, in dry-run mode, or with reports inside the repository", async () => {
    const spawn = () => {
      throw new Error("must not start")
    }
    const err: string[] = []
    const quiet = { stdout: () => {}, stderr: (text: string) => void err.push(text), spawn }
    const out = join(root, "x")
    const refused = async (env: Record<string, string>, reason: string) => {
      err.length = 0
      expect(await main("paid", { ...quiet, env })).toBe(1)
      expect(err.join("")).toContain(reason)
    }
    await refused({ ...PAID, ...JOB, EVAL_OUT_DIR: out }, `${KEY_ENV} is not set`)
    await refused(
      { ...PAID, ...JOB, EVAL_OUT_DIR: out, OPENROUTER_API_KEY: "the old key is not the eval's" },
      `${KEY_ENV} is not set`,
    )
    await refused({ ...PAID, EVAL_OUT_DIR: out, [KEY_ENV]: "k", [PUBLIC_KEY_ENV]: OWNER.publicKey }, "starts only in")
    await refused(
      { ...PAID, ...JOB, EVAL_ENVIRONMENT: "production", EVAL_OUT_DIR: out, [KEY_ENV]: "k" },
      "starts only in",
    )
    await refused({ ...PAID, ...JOB, [PUBLIC_KEY_ENV]: "", EVAL_OUT_DIR: out, [KEY_ENV]: "k" }, PUBLIC_KEY_ENV)
    await refused({ ...PAID, ...JOB, [PUBLIC_KEY_ENV]: "not a key", EVAL_OUT_DIR: out, [KEY_ENV]: "k" }, PUBLIC_KEY_ENV)
    const small = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "pem" })
    await refused({ ...PAID, ...JOB, [PUBLIC_KEY_ENV]: String(small), EVAL_OUT_DIR: out, [KEY_ENV]: "k" }, "3072")
    expect(await main("paid", { ...quiet, env: { ...DRY, ...JOB, EVAL_OUT_DIR: out, [KEY_ENV]: "k" } })).toBe(1)
    await refused({ ...PAID, ...JOB, EVAL_OUT_DIR: import.meta.dir, [KEY_ENV]: "k" }, "outside the repository")
    await refused({ ...PAID, ...JOB, EVAL_OUT_DIR: join(REPO_ROOT, "..reports"), [KEY_ENV]: "k" }, "outside")
    expect(existsSync(out)).toBe(false)
  })

  test("seal encrypts every output file to the owner's key, and only the private key opens it", async () => {
    const dir = join(root, "to-seal")
    const sealedDir = join(root, "sealed")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "1-model.json"), JSON.stringify({ totals: { precision: 0.5 } }))
    writeFileSync(join(dir, "1-model.log"), SCORES.join("\n"))
    writeFileSync(join(dir, JOURNAL), '{"type":"open"}\n')
    const out: string[] = []
    const env = { EVAL_OUT_DIR: dir, EVAL_SEALED_DIR: sealedDir, [PUBLIC_KEY_ENV]: OWNER.publicKey }
    expect(await main("seal", { env, stdout: (text) => void out.push(text) })).toBe(0)
    expect(out.join("")).toContain("Sealed 3 file(s)")
    expect(readdirSync(sealedDir)).toEqual([SEALED])
    const sealedText = readFileSync(join(sealedDir, SEALED), "utf8")
    for (const line of [...SCORES, "precision", "1-model", JOURNAL]) expect(sealedText).not.toContain(line)

    const keyFile = join(root, "owner.pem")
    writeFileSync(keyFile, OWNER.privateKey)
    const opened = join(root, "opened")
    expect(await main("unseal", { stdout: () => {} }, [join(sealedDir, SEALED), keyFile, opened])).toBe(0)
    expect(readFileSync(join(opened, "1-model.log"), "utf8")).toBe(SCORES.join("\n"))
    expect(readdirSync(opened).toSorted()).toEqual(["1-model.json", "1-model.log", JOURNAL].toSorted())
    expect(await main("unseal", { stderr: () => {} }, [join(sealedDir, SEALED), keyFile, REPO_ROOT])).toBe(2)

    // Another key cannot open it, and a tampered file is refused.
    const other = generateKeyPairSync("rsa", { modulusLength: 3072 }).privateKey.export({
      type: "pkcs8",
      format: "pem",
    })
    const sealed = JSON.parse(sealedText)
    expect(() => unseal(sealed, String(other))).toThrow()
    expect(() => unseal({ ...sealed, data: Buffer.from("x").toString("base64") }, OWNER.privateKey)).toThrow()
    expect(unseal(seal({ a: Buffer.from("b") }, OWNER.publicKey), OWNER.privateKey).a!.toString()).toBe("b")
  })

  test("unseal refuses an outcome ledger, whose expiry only outcomes.ts open checks, and writes nothing", async () => {
    const file = join(root, "outcomes.sealed.json")
    writeFileSync(file, JSON.stringify(seal({ [OUTCOME_LEDGER_FILE]: Buffer.from("{}") }, OWNER.publicKey)))
    const keyFile = join(root, "owner-outcomes.pem")
    writeFileSync(keyFile, OWNER.privateKey)
    const opened = join(root, "opened-outcomes")
    const errors: string[] = []
    expect(await main("unseal", { stderr: (text) => void errors.push(text) }, [file, keyFile, opened])).toBe(1)
    expect(errors.join("")).toContain("outcomes.ts open")
    expect(existsSync(opened)).toBe(false)
  })

  test("seal writes nothing without the owner's key, and has nothing to do without outputs", async () => {
    const dir = join(root, "unsealed")
    const sealedDir = join(root, "unsealed-out")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "1-model.json"), "{}")
    const quiet = { stdout: () => {}, stderr: () => {} }
    expect(await main("seal", { ...quiet, env: { EVAL_OUT_DIR: dir, EVAL_SEALED_DIR: sealedDir } })).toBe(1)
    expect(existsSync(sealedDir)).toBe(false)
    const out: string[] = []
    expect(
      await main("seal", {
        stdout: (text) => void out.push(text),
        env: { EVAL_OUT_DIR: join(root, "none"), EVAL_SEALED_DIR: sealedDir },
      }),
    ).toBe(0)
    expect(out.join("")).toContain("Nothing to seal")
  })

  test("a path is outside the repository only when it really leaves it", () => {
    expect(outsideRepository(join(REPO_ROOT, "..reports", "x.json"))).toBe(false)
    expect(outsideRepository(join(REPO_ROOT, "script", "x.json"))).toBe(false)
    expect(outsideRepository(REPO_ROOT)).toBe(false)
    expect(outsideRepository(join(REPO_ROOT, "..", "elsewhere", "x.json"))).toBe(true)
    expect(outsideRepository(join(REPO_ROOT, ".."))).toBe(true)
    expect(outsideRepository(root)).toBe(true)
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

// VS-21c: the replay pipeline. The engine entry point is never started here: every child is a stand-in that records
// how it was started. The entry point's own refusals are tested from packages/engine.
describe("the replay pipeline", () => {
  const REPLAY = { ...DRY, EVAL_PIPELINE: "replay" }
  const PAID_REPLAY = { ...PAID, EVAL_PIPELINE: "replay" }
  const dirs = { EVAL_MIRRORS_DIR: join(root, "mirrors"), EVAL_WORK_DIR: join(root, "work") }

  test("takes the default variants, or registry names built for the engine, and refuses everything else", () => {
    expect(inputs(REPLAY)).toMatchObject({ pipeline: "replay", variants: DEFAULT_VARIANTS })
    expect(inputs({ ...REPLAY, EVAL_VARIANTS: " engine:shared-verify " }).variants).toEqual(["engine:shared-verify"])
    expect(problems({ ...REPLAY, EVAL_VARIANTS: "engine:privacy-zdr" }).join("\n")).toContain("VS-23c")
    expect(problems({ ...REPLAY, EVAL_VARIANTS: "desktop" }).join("\n")).toContain("runs on the desktop runner")
    expect(problems({ ...REPLAY, EVAL_VARIANTS: "engine:nothing" }).join("\n")).toContain("not a registered variant")
    expect(problems({ ...REPLAY, EVAL_VARIANTS: "engine,engine" }).join("\n")).toContain("more than once")
    expect(problems({ ...DRY, EVAL_VARIANTS: "engine" })).toEqual([
      "variants name replay pipelines: leave them empty for the smoke pipeline",
    ])
    expect(problems({ ...REPLAY, EVAL_FIXTURES: "order-search-sql" }).join("\n")).toContain("smoke pipeline")
    expect(problems({ ...DRY, EVAL_PIPELINE: "nightly" })).toEqual(['pipeline must be smoke or replay, not "nightly"'])
  })

  test("quotes what it refuses, so no input text can start a line of the log as a workflow command", () => {
    for (const env of [
      { ...REPLAY, EVAL_VARIANTS: "engine\n::warning::x" },
      { ...REPLAY, EVAL_VARIANTS: "engine:x\n::add-mask::y" },
      { ...REPLAY, EVAL_VARIANTS: "Engine;rm -rf" },
      { ...DRY, EVAL_PIPELINE: "replay\n::set-env name=X::y" },
    ]) {
      const found = problems(env)
      expect(found.length).toBeGreaterThan(0)
      for (const line of found) {
        expect(line.split("\n")).toHaveLength(1)
        expect(line.startsWith("::")).toBe(false)
      }
    }
  })

  test("a paid replay stays within the D5 pilot's limits, and the dry run says so before approval", () => {
    expect(inputs(PAID_REPLAY).limits).toEqual(defaultLimits(50, 0.75))
    expect(problems({ ...PAID_REPLAY, EVAL_REPEAT: "2" }).join("\n")).toContain("runs each case once")
    expect(problems({ ...PAID_REPLAY, EVAL_CASE_BUDGET_USD: "1" }).join("\n")).toContain("case bound is at most")
    expect(problems({ ...PAID_REPLAY, EVAL_BUDGET_USD: "60" }).join("\n")).toContain("budget is at most")
    // The smoke pipeline keeps its own limits.
    expect(problems({ ...PAID, EVAL_REPEAT: "2" })).toEqual([])
  })

  test("a pilot's dispatches share its $50: a budget above what the earlier ones left is refused", () => {
    expect(inputs(PAID_REPLAY)).not.toHaveProperty("pilotSpentUsd")
    expect(inputs({ ...PAID_REPLAY, EVAL_PILOT_SPENT_USD: "" })).not.toHaveProperty("pilotSpentUsd")
    expect(inputs({ ...PAID_REPLAY, EVAL_BUDGET_USD: "30", EVAL_PILOT_SPENT_USD: " 20 " }).pilotSpentUsd).toBe(20)
    expect(inputs({ ...PAID_REPLAY, EVAL_PILOT_SPENT_USD: "0" }).pilotSpentUsd).toBe(0)
    expect(problems({ ...PAID_REPLAY, EVAL_BUDGET_USD: "30", EVAL_PILOT_SPENT_USD: "20.01" })).toEqual([
      "a paid replay's budget is at most what is left of the D5 pilot's $50 after the $20.01 its earlier dispatches settled, $29.99, not $30",
    ])
    expect(problems({ ...PAID_REPLAY, EVAL_PILOT_SPENT_USD: "50" }).join("\n")).toContain("$0, not $50")
    // A dry run takes it too, to say what is left, and refuses nothing for it.
    expect(inputs({ ...REPLAY, EVAL_PILOT_SPENT_USD: "61.5" }).pilotSpentUsd).toBe(61.5)
    for (const bad of ["-1", "1e3", "$5", "5,00", "NaN", "12.345678", "1\n::warning::x"]) {
      const found = problems({ ...PAID_REPLAY, EVAL_PILOT_SPENT_USD: bad })
      expect(found).toEqual([
        `pilot_spent_usd must be a USD amount such as 12.40, or empty for none, not ${JSON.stringify(bad)}`,
      ])
    }
    expect(problems({ ...PAID, EVAL_PILOT_SPENT_USD: "5" })).toEqual([
      "pilot_spent_usd belongs to the replay pipeline's pilot: leave it empty for the smoke pipeline",
    ])
  })

  test("the entry point gets an argument array with the committed manifest: dry, projecting, or sending", () => {
    const replay = inputs({ ...PAID_REPLAY, EVAL_VARIANTS: "engine,engine:shared-verify" })
    const where = { mirrors: "/runner/tmp/mirrors", work: "/runner/tmp/work" }
    const common = [
      "--model",
      "anthropic/claude-sonnet-4.5=3:15",
      "--manifest",
      SEED_MANIFEST,
      "--mirrors",
      "/runner/tmp/mirrors",
      "--work",
      "/runner/tmp/work",
      "--variant",
      "engine",
      "--variant",
      "engine:shared-verify",
      "--repeat",
      "1",
      "--budget-usd",
      "50",
      "--case-budget-usd",
      "0.75",
    ]
    expect(replayArgs(replay, 0, where)).toEqual([...common, "--split", "all", "--dry-run"])
    expect(replayArgs(replay, 0, where, { outDir: "/runner/tmp/out", send: false })).toEqual([
      ...common,
      "--split",
      "development",
      "--dry-run",
      "--out",
      "/runner/tmp/out",
    ])
    expect(replayArgs(replay, 0, where, { outDir: "/runner/tmp/out", send: true })).toEqual([
      ...common,
      "--split",
      "development",
      "--ledger",
      `/runner/tmp/out/${JOURNAL}`,
      "--out",
      "/runner/tmp/out",
    ])
    expect(replayArgs(replay, 1, where)[1]).toBe("openai/gpt-5-mini=0.25:2")
    // A dry plan without a budget passes none, so its cap is the D5 case bound.
    expect(replayArgs(inputs(REPLAY), 0, where)).not.toContain("--budget-usd")
  })

  // VS-29a: the cross-family variant's triage model comes from the dispatch, for that variant, in a dry run.
  const PAIR = {
    ...REPLAY,
    EVAL_VARIANTS: "engine,engine:cross-family",
    EVAL_TRIAGE_MODEL: " google/gemini-2.5-pro=1.25:10 ",
  }
  const PAIR_PROBLEM =
    "engine:cross-family is made by its models: it needs the review model, then a triage model other than it"

  test("takes a triage model only for a variant made by its models, in a dry run (VS-29a)", () => {
    expect(inputs(PAIR).triageModel).toEqual({ id: "google/gemini-2.5-pro", price: { input: 1.25, output: 10 } })
    expect(inputs(PAIR).variants).toEqual(["engine", "engine:cross-family"])
    expect(inputs(REPLAY)).not.toHaveProperty("triageModel")
    expect(inputs({ ...REPLAY, EVAL_TRIAGE_MODEL: "  " })).not.toHaveProperty("triageModel")
    expect(problems({ ...DRY, EVAL_TRIAGE_MODEL: "google/gemini-2.5-pro=1.25:10" })).toEqual([
      "triage_model belongs to the replay pipeline: leave it empty for the smoke pipeline",
    ])
    // The default variants are not made by their models, so they take no triage model.
    expect(problems({ ...REPLAY, EVAL_TRIAGE_MODEL: "google/gemini-2.5-pro=1.25:10" })).toEqual([
      "triage_model is for a variant made by its models (engine:cross-family); variants names none",
    ])
    // The cross-family variant without one would fail the entry point on every model, so it is refused here, per model.
    expect(problems({ ...REPLAY, EVAL_VARIANTS: "engine:cross-family" })).toEqual([
      `${PAIR_PROBLEM}, not anthropic/claude-sonnet-4.5. Set triage_model.`,
      `${PAIR_PROBLEM}, not openai/gpt-5-mini. Set triage_model.`,
    ])
    // A triage model that is one of the review models is no pair for that model.
    expect(problems({ ...PAIR, EVAL_TRIAGE_MODEL: "openai/gpt-5-mini=0.25:2" })).toEqual([
      `${PAIR_PROBLEM}, not openai/gpt-5-mini + openai/gpt-5-mini.`,
    ])
    // A paid cross-family replay is not wired, so a paid dispatch naming the variant is refused as dry only, whatever
    // its triage model: it is never first asked for one that would then be refused.
    const DRY_ONLY =
      "runs in dry runs only: a paid cross-family replay is not wired until the owner chooses the pair (Q5) and funds its ablation (Q9)"
    expect(problems({ ...PAIR, ...PAID_REPLAY, EVAL_VARIANTS: PAIR.EVAL_VARIANTS })).toEqual([
      `engine:cross-family ${DRY_ONLY}`,
    ])
    expect(problems({ ...PAID_REPLAY, EVAL_VARIANTS: "engine:cross-family" })).toEqual([
      `engine:cross-family ${DRY_ONLY}`,
    ])
    expect(
      problems({ ...PAID_REPLAY, EVAL_VARIANTS: "engine:cross-family", EVAL_TRIAGE_MODEL: "openai/gpt-5-mini=0.25:2" }),
    ).toEqual([`engine:cross-family ${DRY_ONLY}`])
    expect(problems({ ...PAID_REPLAY, EVAL_TRIAGE_MODEL: "google/gemini-2.5-pro=1.25:10" })).toEqual([
      "triage_model is for a variant made by its models (engine:cross-family); variants names none",
      `triage_model ${DRY_ONLY}`,
    ])
    // Malformed text is quoted on one line, never read as a workflow command.
    for (const bad of ["a/b=1:1\n::warning::x", "a/b", "a/b=x:y", "--x=1:1", "a/b=1:1,c/d=1:1"]) {
      const found = problems({ ...PAIR, EVAL_TRIAGE_MODEL: bad })
      expect(found).toEqual([
        `triage_model ${JSON.stringify(bad)} must be model=input:output, with USD per million tokens, such as openai/gpt-5=1.25:10, or empty for none`,
      ])
      for (const line of found) {
        expect(line.split("\n")).toHaveLength(1)
        expect(line.startsWith("::")).toBe(false)
      }
    }
  })

  test("hands the entry point --triage-model after --model, and changes no argument array without it", async () => {
    const where = { mirrors: "/runner/tmp/mirrors", work: "/runner/tmp/work" }
    const paired = inputs(PAIR)
    const unpaired = { ...paired, triageModel: undefined }
    for (const index of [0, 1]) {
      const without = replayArgs(unpaired, index, where)
      expect(replayArgs(paired, index, where)).toEqual([
        ...without.slice(0, 2),
        "--triage-model",
        "google/gemini-2.5-pro=1.25:10",
        ...without.slice(2),
      ])
      expect(without).not.toContain("--triage-model")
    }
    // The plan names the pair and says what is not checked.
    const started: string[][] = []
    const out: string[] = []
    expect(
      await main("plan", {
        env: { ...PAIR, ...dirs },
        spawn: (argv) => {
          started.push(argv)
          return { stdout: Promise.resolve(""), exited: Promise.resolve(0), kill: () => {} }
        },
        stdout: (text) => void out.push(text),
        stderr: () => {},
      }),
    ).toBe(0)
    expect(started.map((argv) => argv.slice(2, 6))).toEqual([
      ["--model", "anthropic/claude-sonnet-4.5=3:15", "--triage-model", "google/gemini-2.5-pro=1.25:10"],
      ["--model", "openai/gpt-5-mini=0.25:2", "--triage-model", "google/gemini-2.5-pro=1.25:10"],
    ])
    expect(out.join("")).toContain(
      "engine:cross-family pairs each model with google/gemini-2.5-pro as its first pass (triage_model); nothing checks the pair's labs or tier until codium's labOf merges and the owner chooses the pair (Q5).",
    )
    const plain: string[] = []
    await main("plan", {
      env: { ...REPLAY, ...dirs },
      spawn: () => ({ stdout: Promise.resolve(""), exited: Promise.resolve(0), kill: () => {} }),
      stdout: (text) => void plain.push(text),
      stderr: () => {},
    })
    expect(plain.join("")).not.toContain("triage_model")
  })

  test("the mirror plan is one bare mirror per seed repository, with its cases' heads and bases", async () => {
    const seed = (await loadManifest()) as Manifest
    const plan = mirrorPlan(seed)
    expect(plan).toHaveLength(new Set(seed.cases.map((item) => item.repository.url)).size)
    for (const entry of plan) {
      expect(entry.url).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+$/)
      expect(entry.dir).toBe(`${entry.url.split("/")[3]}/${entry.url.split("/")[4]}.git`)
      const cases = seed.cases.filter((item) => item.repository.url === entry.url)
      expect(entry.shas.toSorted()).toEqual(
        [...new Set(cases.flatMap((item) => [item.candidate.head, item.candidate.base]))].toSorted(),
      )
    }
  })

  // VS-22c: every push of a multi-commit sequence, once each, after the head and the base.
  test("the mirror plan covers every push of a multi-commit sequence", async () => {
    const seed = (await loadManifest()) as Manifest
    const first = seed.cases[0]!
    const earlier = "f".repeat(40)
    const sequenced = {
      ...first,
      candidate: {
        ...first.candidate,
        commits: [
          { sha: earlier, date: "2000-01-01T00:00:00Z" },
          { sha: first.candidate.head, date: first.candidate.date },
        ],
      },
    }
    const plan = mirrorPlan({ cases: [sequenced] })
    expect(plan).toEqual([
      {
        url: first.repository.url,
        dir: `${first.repository.url.split("/")[3]}/${first.repository.url.split("/")[4]}.git`,
        shas: [first.candidate.head, first.candidate.base, earlier],
      },
    ])
    expect(mirrorPlan({ cases: [first] })[0]!.shas).toEqual([first.candidate.head, first.candidate.base])
  })

  test("mirrors fetches the committed manifest's commits with hooks off, https only, into refs, and fails on any error", async () => {
    const calls: { argv: string[]; env: Record<string, string | undefined> }[] = []
    const out: string[] = []
    const err: string[] = []
    const mirrors = join(root, "fetched-mirrors")
    const code = await main("mirrors", {
      env: { EVAL_MIRRORS_DIR: mirrors },
      git: (argv, env) => (calls.push({ argv, env }), { code: 0, stderr: "" }),
      stdout: (text) => void out.push(text),
      stderr: (text) => void err.push(text),
    })
    expect(code).toBe(0)
    const plan = mirrorPlan((await loadManifest()) as Manifest)
    const first = plan[0]!
    const target = join(mirrors, first.dir)
    expect(calls.slice(0, 2 + first.shas.length).map((call) => call.argv)).toEqual([
      [...MIRROR_GIT, "init", "--bare", "--quiet", target],
      [
        ...MIRROR_GIT,
        "-C",
        target,
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-recurse-submodules",
        first.url,
        ...first.shas.map((sha) => `${sha}:refs/vectorscope/${sha}`),
      ],
      ...first.shas.map((sha) => [...MIRROR_GIT, "-C", target, "cat-file", "-e", `${sha}^{commit}`]),
    ])
    expect(MIRROR_GIT).toContain("protocol.allow=never")
    expect(MIRROR_GIT).toContain("protocol.https.allow=always")
    // Every URL fetched is one of the committed manifest's, and git reads none of the user's config.
    const fetched = calls
      .filter((call) => call.argv.includes("fetch"))
      .map((call) => call.argv[call.argv.indexOf("--no-recurse-submodules") + 1])
    expect(fetched).toEqual(plan.map((entry) => entry.url))
    for (const call of calls) expect(call.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" })
    expect(out.join("")).toContain(`${first.url}: ${first.shas.length} commit(s)`)

    const failing = await main("mirrors", {
      env: { EVAL_MIRRORS_DIR: join(root, "failing-mirrors") },
      git: (argv) =>
        argv.includes("fetch") ? { code: 128, stderr: "fatal: unreachable\n::warning::x" } : { code: 0, stderr: "" },
      stdout: () => {},
      stderr: (text) => void err.push(text),
    })
    expect(failing).toBe(1)
    expect(err.join("")).toContain('git fetch failed: "fatal: unreachable\\n::warning::x"')
    expect(
      err
        .join("")
        .split("\n")
        .some((line) => line.startsWith("::")),
    ).toBe(false)
    const inside = await main("mirrors", { env: { EVAL_MIRRORS_DIR: join(REPO_ROOT, "mirrors") }, stderr: () => {} })
    expect(inside).toBe(1)
  })

  test("plan projects with the entry point from packages/engine, with no key, and relays what it printed", async () => {
    const started: { argv: string[]; env: Record<string, string>; cwd?: string }[] = []
    const out: string[] = []
    const summary = join(root, "replay-plan-summary.md")
    const code = await main("plan", {
      env: {
        ...REPLAY,
        ...dirs,
        PATH: "/usr/bin",
        [KEY_ENV]: "must-not-pass",
        OPENROUTER_API_KEY: "must-not-pass",
        GITHUB_STEP_SUMMARY: summary,
      },
      spawn: (argv, env, cwd) => {
        started.push({ argv, env, ...(cwd ? { cwd } : {}) })
        return {
          stdout: Promise.resolve(
            "Dry run: nothing was sent. The strict egress guard logged 4 connection attempts, 0 off this computer.\n",
          ),
          stderr: Promise.resolve(""),
          exited: Promise.resolve(0),
          kill: () => {},
        }
      },
      stdout: (text) => void out.push(text),
      stderr: () => {},
    })
    expect(code).toBe(0)
    expect(started).toHaveLength(2)
    for (const [index, child] of started.entries()) {
      expect(child.argv).toEqual([
        process.execPath,
        REPLAY_ENTRY,
        ...replayArgs(inputs(REPLAY), index, { mirrors: dirs.EVAL_MIRRORS_DIR, work: dirs.EVAL_WORK_DIR }),
      ])
      expect(child.cwd).toBe(ENGINE_DIR)
      expect(child.env).toEqual({ PATH: "/usr/bin" })
    }
    expect(out.join("")).toContain("0 off this computer")
    expect(out.join("")).toContain("Dry run: nothing was sent, and no key was used.")
    expect(out.join("")).toContain(
      "The D5 pilot's $50.00 is shared by all its dispatches: $0.00 settled by earlier ones (pilot_spent_usd), so $50.00 is left for this one.",
    )
    expect(readFileSync(summary, "utf8")).toContain("Dry projection: anthropic/claude-sonnet-4.5")
    const later: string[] = []
    expect(
      await main("plan", {
        env: { ...REPLAY, ...dirs, EVAL_PILOT_SPENT_USD: "12.5" },
        spawn: () => ({ stdout: Promise.resolve(""), exited: Promise.resolve(0), kill: () => {} }),
        stdout: (text) => void later.push(text),
        stderr: () => {},
      }),
    ).toBe(0)
    expect(later.join("")).toContain(
      "$12.50 settled by earlier ones (pilot_spent_usd), so $37.50 is left for this one.",
    )

    // A projection problem fails the plan, and a replay plan needs both directories outside the repository.
    const failed = await main("plan", {
      env: { ...REPLAY, ...dirs },
      spawn: () => ({ stdout: Promise.resolve(""), exited: Promise.resolve(1), kill: () => {} }),
      stdout: () => {},
      stderr: () => {},
    })
    expect(failed).toBe(1)
    const err: string[] = []
    const quiet = { stdout: () => {}, stderr: (text: string) => void err.push(text) }
    const spawn = () => {
      throw new Error("must not start")
    }
    expect(await main("plan", { ...quiet, spawn, env: { ...REPLAY, EVAL_WORK_DIR: dirs.EVAL_WORK_DIR } })).toBe(1)
    expect(
      await main("plan", { ...quiet, spawn, env: { ...REPLAY, ...dirs, EVAL_WORK_DIR: join(REPO_ROOT, "work") } }),
    ).toBe(1)
    expect(err.join("")).toContain("EVAL_MIRRORS_DIR must be an absolute directory outside the repository")
    expect(err.join("")).toContain("EVAL_WORK_DIR must be outside the repository")
  })

  test("project writes the paid cases' projections to the output directory with no key, for the replay pipeline only", async () => {
    const started: { argv: string[]; env: Record<string, string>; cwd?: string }[] = []
    const outDir = join(root, "projected")
    const printed = "pallets-werkzeug-1  engine  projected, 2 request(s)\n| engine · m | 1 | 1 | 2 | $0.2500 |\n"
    const spawn = (argv: string[], env: Record<string, string>, cwd?: string): Child => {
      started.push({ argv, env, ...(cwd ? { cwd } : {}) })
      return {
        stdout: Promise.resolve(printed),
        stderr: Promise.resolve("a warning\n"),
        exited: Promise.resolve(0),
        kill: () => {},
      }
    }
    const env = { ...PAID_REPLAY, ...JOB, ...dirs, EVAL_OUT_DIR: outDir, PATH: "/usr/bin", [KEY_ENV]: "must-not-pass" }
    const out: string[] = []
    const err: string[] = []
    expect(
      await main("project", {
        env,
        spawn,
        stdout: (text) => void out.push(text),
        stderr: (text) => void err.push(text),
      }),
    ).toBe(0)
    expect(started.map((child) => child.argv.slice(-5))).toEqual([
      ["--split", "development", "--dry-run", "--out", outDir],
      ["--split", "development", "--dry-run", "--out", outDir],
    ])
    expect(
      started.every((child) => child.cwd === ENGINE_DIR && !JSON.stringify(child.env).includes("must-not-pass")),
    ).toBe(true)
    // It runs in the paid job: what the projection printed goes to a log that is sealed with the rest, and the public
    // log gets each model's exit code alone (D12).
    expect(out.join("")).toBe(
      "anthropic/claude-sonnet-4.5: the projection exited with 0. Its log is in the sealed artifact.\n" +
        "openai/gpt-5-mini: the projection exited with 0. Its log is in the sealed artifact.\n",
    )
    expect(err).toEqual([])
    expect(readFileSync(join(outDir, "1-anthropic_claude-sonnet-4.5-projection.log"), "utf8")).toBe(
      `a warning\n\n${printed}`,
    )
    expect(existsSync(join(outDir, "2-openai_gpt-5-mini-projection.log"))).toBe(true)
    const refused: string[] = []
    expect(
      await main("project", {
        env: { ...env, EVAL_PIPELINE: "smoke" },
        spawn,
        stdout: () => {},
        stderr: (text) => void refused.push(text),
      }),
    ).toBe(1)
    expect(refused.join("")).toContain("replay pipeline only")
  })

  test("paid replays each model through the entry point with only the eval key and the shared journal", async () => {
    const started: { argv: string[]; env: Record<string, string>; cwd?: string }[] = []
    const dir = join(root, "paid-replay")
    const code = await main("paid", {
      env: {
        ...PAID_REPLAY,
        ...JOB,
        ...dirs,
        EVAL_OUT_DIR: dir,
        [KEY_ENV]: "test-key",
        OPENROUTER_API_KEY: "must-not-pass",
        PATH: "/usr/bin",
      },
      spawn: (argv, env, cwd) => {
        started.push({ argv, env, ...(cwd ? { cwd } : {}) })
        return {
          stdout: Promise.resolve("pallets-werkzeug-1  engine  r1  replayed: 3 admitted attempt(s)\n"),
          exited: Promise.resolve(0),
          kill: () => {},
        }
      },
      stdout: () => {},
      stderr: () => {},
    })
    expect(code).toBe(0)
    expect(started).toHaveLength(2)
    expect(started[0]!.argv).toEqual([
      process.execPath,
      REPLAY_ENTRY,
      ...replayArgs(
        inputs(PAID_REPLAY),
        0,
        { mirrors: dirs.EVAL_MIRRORS_DIR, work: dirs.EVAL_WORK_DIR },
        { outDir: dir, send: true },
      ),
    ])
    expect(started[0]!.cwd).toBe(ENGINE_DIR)
    expect(started[0]!.env).toEqual({
      PATH: "/usr/bin",
      GITHUB_ACTIONS: "true",
      VECTORSCOPE_EVAL_ENVIRONMENT: "vectorscope-eval",
      [KEY_ENV]: "test-key",
    })
    expect(started[0]!.argv.join(" ")).not.toContain("test-key")
    // The replay's output goes to the sealed log only.
    expect(readFileSync(join(dir, "1-anthropic_claude-sonnet-4.5.log"), "utf8")).toContain("replayed")
    const err: string[] = []
    expect(
      await main("paid", {
        env: { ...PAID_REPLAY, ...JOB, EVAL_OUT_DIR: dir, [KEY_ENV]: "k" },
        spawn: () => {
          throw new Error("must not start")
        },
        stdout: () => {},
        stderr: (text) => void err.push(text),
      }),
    ).toBe(1)
    expect(err.join("")).toContain("EVAL_MIRRORS_DIR")
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

  test("summarises the ledger and keeps the reports, sealed, even when the run fails or is cancelled", () => {
    const steps = workflow.jobs.eval!.steps
    const report = steps.find((step) => step.run === "bun script/vectorscope-eval/ci.ts report")
    expect(report).toMatchObject({ if: "always()" })
    const sealing = steps.find((step) => step.run === "bun script/vectorscope-eval/ci.ts seal")
    expect(sealing).toMatchObject({ if: "always()" })
    expect(sealing!.env).toMatchObject({
      EVAL_OUT_DIR: "${{ runner.temp }}/vectorscope-eval",
      EVAL_SEALED_DIR: "${{ runner.temp }}/vectorscope-eval-sealed",
      [PUBLIC_KEY_ENV]: `\${{ vars.${PUBLIC_KEY_ENV} }}`,
    })
    const keep = steps.find((step) => step.name === "Keep the sealed reports and ledger") as
      | { if?: string; with?: Record<string, unknown> }
      | undefined
    expect(keep).toMatchObject({ if: "always()" })
    // This repository is public: only the sealed directory is uploaded, and not for long.
    expect(keep!.with!.path).toBe("${{ runner.temp }}/vectorscope-eval-sealed/")
    expect(Number(keep!.with!["retention-days"])).toBeLessThanOrEqual(7)
    expect(steps.findIndex((step) => step === sealing)).toBeLessThan(steps.findIndex((step) => step === keep))
    // The paid step names its own environment, which run.ts checks before it sends to a hosted endpoint.
    const paid = steps.find((step) => step.run === "bun script/vectorscope-eval/ci.ts paid")
    expect(paid!.env).toMatchObject({
      EVAL_ENVIRONMENT: workflow.jobs.eval!.environment,
      [PUBLIC_KEY_ENV]: `\${{ vars.${PUBLIC_KEY_ENV} }}`,
    })
  })

  type Step = {
    name: string
    if?: string
    run?: string
    env?: Record<string, string>
    "timeout-minutes"?: string | number
  }

  test("adds the replay pipeline off by default: smoke and no variants unless chosen, with the old timeouts", () => {
    const inputs = workflow.on.workflow_dispatch!.inputs
    expect(inputs.pipeline).toMatchObject({ default: "smoke", options: ["smoke", "replay"], required: true })
    expect(inputs.variants!.default).toBe("")
    expect(inputs.pilot_spent_usd).toMatchObject({ default: "", required: false })
    const jobs = workflow.jobs as Record<string, { "timeout-minutes"?: string | number; steps: Step[] }>
    // Every step that validates the inputs gets what the pilot's earlier dispatches settled.
    const validating = Object.values(jobs).flatMap((job) =>
      job.steps.filter((step) => /ci\.ts (plan|project|paid)$/.test(step.run ?? "")),
    )
    expect(validating).toHaveLength(3)
    for (const step of validating)
      expect(step.env).toMatchObject({ EVAL_PILOT_SPENT_USD: "${{ inputs.pilot_spent_usd }}" })
    expect(jobs.plan!["timeout-minutes"]).toBe("${{ inputs.pipeline == 'replay' && 45 || 15 }}")
    expect(jobs.eval!["timeout-minutes"]).toBe("${{ inputs.pipeline == 'replay' && 360 || 75 }}")
    const paidStep = jobs.eval!.steps.find((step) => step.run === "bun script/vectorscope-eval/ci.ts paid")
    expect(paidStep!["timeout-minutes"]).toBe("${{ inputs.pipeline == 'replay' && 300 || 60 }}")
    // Every step the replay pipeline added runs only for it.
    const added = ["Install ripgrep", "Fetch the dataset mirrors", "Project the paid cases, sending nothing"]
    for (const job of Object.values(jobs))
      for (const step of job.steps.filter((entry) => added.includes(entry.name)))
        expect(step.if).toBe("inputs.pipeline == 'replay'")
  })

  // VS-29a. GitHub raised workflow_dispatch's input limit from 10 to 25 on 2025-12-04 (its changelog); an input past
  // the limit would break every dispatch, so the count is pinned here and a later addition fails loudly.
  test("takes the cross-family triage model as an optional input, empty by default, in every validating step", () => {
    const inputs = workflow.on.workflow_dispatch.inputs
    expect(inputs.triage_model).toMatchObject({ default: "", required: false })
    expect(Object.keys(inputs)).toHaveLength(11)
    expect(Object.keys(inputs).length).toBeLessThanOrEqual(25)
    const jobs = workflow.jobs as Record<string, { steps: Step[] }>
    const validating = Object.values(jobs).flatMap((job) =>
      job.steps.filter((step) => /ci\.ts (plan|project|paid)$/.test(step.run ?? "")),
    )
    expect(validating).toHaveLength(3)
    for (const step of validating) expect(step.env).toMatchObject({ EVAL_TRIAGE_MODEL: "${{ inputs.triage_model }}" })
  })

  test("fetches the mirrors in both jobs without a secret, and projects the paid cases before paying, with no key", () => {
    const jobs = workflow.jobs as Record<string, { steps: Step[] }>
    for (const name of ["plan", "eval"]) {
      const steps = jobs[name]!.steps
      const mirrors = steps.find((step) => step.run === "bun script/vectorscope-eval/ci.ts mirrors")
      expect(mirrors!.env).toEqual({ EVAL_MIRRORS_DIR: "${{ runner.temp }}/vectorscope-mirrors" })
      const runner = steps.find((step) => step.run?.includes("ci.ts plan") || step.run?.includes("ci.ts paid"))
      expect(steps.indexOf(mirrors!)).toBeLessThan(steps.indexOf(runner!))
    }
    const steps = jobs.eval!.steps
    const projection = steps.find((step) => step.run === "bun script/vectorscope-eval/ci.ts project")
    const paidStep = steps.find((step) => step.run === "bun script/vectorscope-eval/ci.ts paid")
    expect(JSON.stringify(projection)).not.toContain("secrets.")
    expect(projection!.env).toMatchObject({
      EVAL_PIPELINE: "${{ inputs.pipeline }}",
      EVAL_OUT_DIR: "${{ runner.temp }}/vectorscope-eval",
      EVAL_MIRRORS_DIR: "${{ runner.temp }}/vectorscope-mirrors",
    })
    expect(steps.indexOf(projection!)).toBeLessThan(steps.indexOf(paidStep!))
    expect(paidStep!.env).toMatchObject({
      EVAL_PIPELINE: "${{ inputs.pipeline }}",
      EVAL_VARIANTS: "${{ inputs.variants }}",
      EVAL_MIRRORS_DIR: "${{ runner.temp }}/vectorscope-mirrors",
      EVAL_WORK_DIR: "${{ runner.temp }}/vectorscope-work",
    })
    // The plan job uploads nothing: its projections are written nowhere.
    expect(JSON.stringify(jobs.plan)).not.toContain("upload-artifact")
    const plan = jobs.plan!.steps.find((step) => step.run === "bun script/vectorscope-eval/ci.ts plan")
    expect(plan!.env).not.toHaveProperty("EVAL_OUT_DIR")
  })
})

// VS-21e: models and triage_model take cache prices, for the plan's notes and the D6 check alone. run.ts and the replay
// entry point are always handed the two-field price.
describe("cache-aware price strings (VS-21e)", () => {
  const REPLAY = { ...DRY, EVAL_PIPELINE: "replay" }
  const dirs = { EVAL_MIRRORS_DIR: join(root, "mirrors-21e"), EVAL_WORK_DIR: join(root, "work-21e") }
  const FOUR = { ...DRY, EVAL_MODELS: "anthropic/claude-sonnet-4.5=3:15:0.3:3.75, openai/gpt-5-mini=0.25:2:0.025" }
  const PAIR = {
    ...REPLAY,
    EVAL_VARIANTS: "engine,engine:cross-family",
    EVAL_TRIAGE_MODEL: "google/gemini-2.5-pro=1.25:10",
  }
  const PAIR_FOUR = {
    ...PAIR,
    EVAL_MODELS: FOUR.EVAL_MODELS,
    EVAL_TRIAGE_MODEL: "google/gemini-2.5-pro=1.25:10:0.31:1.625",
  }
  const where = { mirrors: "/runner/tmp/mirrors", work: "/runner/tmp/work" }
  const NOTE =
    "anthropic/claude-sonnet-4.5: cache read $0.3 and cache write $3.75 per million tokens are for projections and reports only; estimates, admission and settlement use $3 input and $15 output, uncached."

  test("models and triage_model take two to four price fields, and no argument array changes", () => {
    expect(inputs(FOUR).models).toEqual([
      {
        id: "anthropic/claude-sonnet-4.5",
        price: { input: 3, output: 15 },
        projectionPrice: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      },
      {
        id: "openai/gpt-5-mini",
        price: { input: 0.25, output: 2 },
        projectionPrice: { input: 0.25, output: 2, cacheRead: 0.025 },
      },
    ])
    for (const model of inputs(DRY).models) expect(model).not.toHaveProperty("projectionPrice")
    expect(inputs(PAIR_FOUR).triageModel).toEqual({
      id: "google/gemini-2.5-pro",
      price: { input: 1.25, output: 10 },
      projectionPrice: { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 1.625 },
    })
    expect(inputs(PAIR).triageModel).toEqual({ id: "google/gemini-2.5-pro", price: { input: 1.25, output: 10 } })
    for (const index of [0, 1]) {
      expect(runArgs(inputs(FOUR), index)).toEqual(runArgs(inputs(DRY), index))
      expect(runArgs(inputs({ ...FOUR, ...PAID, EVAL_MODELS: FOUR.EVAL_MODELS }), index, "/runner/out")).toEqual(
        runArgs(inputs(PAID), index, "/runner/out"),
      )
      expect(replayArgs(inputs(PAIR_FOUR), index, where)).toEqual(replayArgs(inputs(PAIR), index, where))
      expect(replayArgs(inputs(PAIR_FOUR), index, where, { outDir: "/runner/out", send: false })).toEqual(
        replayArgs(inputs(PAIR), index, where, { outDir: "/runner/out", send: false }),
      )
      expect(runArgs(inputs(FOUR), index)[3]).toMatch(/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/)
    }
  })

  test("malformed cache fields are refused with the models and triage_model messages, each on one line", () => {
    for (const bad of ["a/b=1:1:", "a/b=1:1:x", "a/b=1:1:1:1:1", "a/b=1:1:-1", "a/b=1:1::1", "a/b=1:1:1:1\n::x"]) {
      const found = problems({ ...DRY, EVAL_MODELS: bad })
      expect(found).toEqual([
        `models entry ${JSON.stringify(bad)} must be model=input:output, with USD per million tokens, such as anthropic/claude-sonnet-4.5=3:15`,
      ])
      const triage = problems({ ...PAIR, EVAL_TRIAGE_MODEL: bad })
      expect(triage).toEqual([
        `triage_model ${JSON.stringify(bad)} must be model=input:output, with USD per million tokens, such as openai/gpt-5=1.25:10, or empty for none`,
      ])
      for (const line of [...found, ...triage]) expect(line.split("\n")).toHaveLength(1)
    }
  })

  test("plan notes which prices are projection only and checks each against D6, and a two-field plan neither", async () => {
    const plan = async (env: Record<string, string>, name: string) => {
      const out: string[] = []
      const summary = join(root, `plan-21e-${name}.md`)
      expect(
        await main("plan", {
          env: { ...env, EVAL_FIXTURES: "order-search-sql", GITHUB_STEP_SUMMARY: summary },
          stdout: (text) => void out.push(text),
          spawn: () => {
            throw new Error("plan must not start a process")
          },
        }),
      ).toBe(0)
      return { text: out.join(""), summary: readFileSync(summary, "utf8") }
    }
    const four = await plan(FOUR, "four")
    expect(four.text).toContain(NOTE)
    expect(four.summary).toContain(NOTE)
    expect(four.text).toContain("openai/gpt-5-mini: cache read $0.025 per million tokens is for projections")
    expect(four.text).not.toContain("Price check")
    const off = await plan({ ...DRY, EVAL_MODELS: "anthropic/claude-sonnet-4.5=3:15:0.2" }, "off")
    expect(off.text).toContain(
      "Price check (D6): anthropic/claude-sonnet-4.5 is given at $3 input, $15 output, $0.2 cache read, but its list price read 2026-11-07 is",
    )
    const two = await plan(DRY, "two")
    expect(two.text).not.toContain("per million tokens are for projections")
    expect(two.text).not.toContain("is for projections")
    expect(two.text).not.toContain("Price check")
    // A two-field price that differs from its list price prints one D6 line, by design (item 6), and no cache note.
    const twoOff = await plan(
      { ...DRY, EVAL_MODELS: "anthropic/claude-sonnet-4.5=3:16, openai/gpt-5-mini=0.25:2" },
      "two-off",
    )
    const d6 = twoOff.text.split("\n").filter((line) => line.startsWith("Price check (D6): "))
    expect(d6).toHaveLength(1)
    expect(d6[0]).toStartWith(
      "Price check (D6): anthropic/claude-sonnet-4.5 is given at $3 input, $16 output, but its list price read 2026-11-07 is $3 input, $15 output, $0.3 cache read, $3.75 cache write (",
    )
    expect(twoOff.text).not.toContain("is for projections")
    expect(twoOff.summary).toContain("Price check (D6): anthropic/claude-sonnet-4.5 is given at $3 input, $16 output")
    // The estimates are the two-field plan's, line for line.
    expect(
      four.text
        .replace(`${NOTE}\n`, "")
        .replace(/openai\/gpt-5-mini: cache read[^\n]*\n/, "")
        .replace("\n\nAll", "\nAll"),
    ).toBe(two.text)
  })

  test("a replay plan says the catalog's cache rates are used, warns on a list-price mismatch, and hands two fields", async () => {
    const started: string[][] = []
    const out: string[] = []
    const summary = join(root, "replay-plan-21e.md")
    expect(
      await main("plan", {
        env: {
          ...PAIR_FOUR,
          ...dirs,
          EVAL_MODELS: "anthropic/claude-sonnet-4.5=3:16:0.3",
          GITHUB_STEP_SUMMARY: summary,
        },
        spawn: (argv) => {
          started.push(argv)
          return { stdout: Promise.resolve(""), exited: Promise.resolve(0), kill: () => {} }
        },
        stdout: (text) => void out.push(text),
        stderr: () => {},
      }),
    ).toBe(0)
    const text = out.join("")
    expect(text).toContain(
      "anthropic/claude-sonnet-4.5: replay projections take cache rates from the committed catalog; the cache prices given are not used.",
    )
    expect(text).toContain(
      "google/gemini-2.5-pro: replay projections take cache rates from the committed catalog; the cache prices given are not used.",
    )
    expect(text).toContain("Price check (D6): anthropic/claude-sonnet-4.5 is given at $3 input, $16 output")
    expect(readFileSync(summary, "utf8")).toContain("### Prices")
    expect(started.map((argv) => argv.slice(2, 6))).toEqual([
      ["--model", "anthropic/claude-sonnet-4.5=3:16", "--triage-model", "google/gemini-2.5-pro=1.25:10"],
    ])
    const plain: string[] = []
    await main("plan", {
      env: { ...REPLAY, ...dirs },
      spawn: () => ({ stdout: Promise.resolve(""), exited: Promise.resolve(0), kill: () => {} }),
      stdout: (line) => void plain.push(line),
      stderr: () => {},
    })
    expect(plain.join("")).not.toContain("committed catalog")
    expect(plain.join("")).not.toContain("Price check")
  })
})
