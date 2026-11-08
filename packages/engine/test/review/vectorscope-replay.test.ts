import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  CATALOG,
  catalogModel,
  engineConfig,
  engineEnvironment,
  main,
  PAID_PROVIDER,
  parseReplayArgs,
  PROJECTION_PROVIDER,
  providerKeys,
  replayMode,
  SCENARIOS,
  type ReplayFlags,
} from "../../script/vectorscope-replay"
import { gitEnv, type Manifest } from "../../../../script/vectorscope-eval/dataset"
import { projectedRun, projectionProblems } from "../../../../script/vectorscope-eval/replay"
import type { ProjectionRecord } from "../../src/review/eval"

// VS-21c's entry point (packages/engine/script/vectorscope-replay.ts). Its send decision is tested as a pure function
// only: no test here, or anywhere, runs its paid branch. The dry branch runs as a subprocess against a synthetic mirror,
// inside a complete protected environment with a dummy key, and must send nothing and never see the key.

const root = mkdtempSync(path.join(tmpdir(), "vectorscope-replay-entry-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ENGINE = path.join(import.meta.dir, "..", "..")
const SEED = path.join(ENGINE, "..", "..", "script", "vectorscope-eval", "dataset", "seed.json")
const MODEL = "anthropic/claude-sonnet-4.5"
const PRICE = "3:15"
// A triage model from the committed catalog at its price, for VS-29a's cross-family variant: a fixture pair, not a
// recommendation (the owner chooses the pair, Q5).
const TRIAGE_MODEL = "openai/gpt-5"
const TRIAGE = `${TRIAGE_MODEL}=1.25:10`
const DUMMY_KEY = "vs21c-dummy-eval-key-never-used"
// The protected environment's marks and its key, all of which a dry run must ignore.
const PROTECTED = {
  GITHUB_ACTIONS: "true",
  VECTORSCOPE_EVAL_ENVIRONMENT: "vectorscope-eval",
  VECTORSCOPE_EVAL_API_KEY: DUMMY_KEY,
}

const base = ["--model", `${MODEL}=${PRICE}`, "--mirrors", path.join(root, "mirrors"), "--work", path.join(root, "w")]
const budget = ["--budget-usd", "50", "--case-budget-usd", "0.75"]
const sending = [...budget, "--ledger", path.join(root, "ledger.jsonl"), "--out", path.join(root, "out")]

function flags(argv: string[]): ReplayFlags {
  const parsed = parseReplayArgs(argv)
  if (typeof parsed === "string") throw new Error(parsed)
  return parsed
}

describe("the flags", () => {
  test("need a model with its price, the mirrors and a work directory outside the repository", () => {
    const parsed = flags(base)
    expect(parsed).toMatchObject({
      model: { id: MODEL, price: { input: 3, output: 15 } },
      split: "development",
      variants: [{ name: "engine" }],
      repeat: 1,
      dryRun: false,
    })
    expect(parsed.limits).toBeUndefined()
    expect(parsed.variants[0]!.record).toBeUndefined()
    expect(parseReplayArgs(base.slice(2))).toContain("--model")
    expect(parseReplayArgs([...base.slice(0, 2), "--work", path.join(root, "w")])).toContain("--mirrors")
    expect(parseReplayArgs([...base.slice(0, 4), "--work", "relative"])).toContain("--work")
    expect(parseReplayArgs([...base.slice(0, 4), "--work", ENGINE])).toContain("outside the repository")
    expect(parseReplayArgs([...base, "--out", path.join(ENGINE, "out")])).toContain("--out must be outside")
    expect(parseReplayArgs([...base, "--ledger", path.join(ENGINE, "l.jsonl")])).toContain("--ledger must be outside")
    expect(parseReplayArgs(["--model", `${MODEL}=3`, ...base.slice(2)])).toContain("--model")
    expect(parseReplayArgs([...base, "--unknown"])).toContain("Unknown option")
    expect(parseReplayArgs([...base, "stray"])).toContain("Unexpected argument")
    expect(parseReplayArgs([...base, "--split"])).toContain("Missing value for --split")
    expect(parseReplayArgs([...base, "--split", "test"])).toContain("--split")
    expect(parseReplayArgs([...base, "--repeat", "6"])).toContain("--repeat")
    expect(parseReplayArgs([...base, "--budget-usd", "50"])).toContain("go together")
    expect(parseReplayArgs([...base, "--budget-usd", "50", "--case-budget-usd", "46"])).toContain("Budget")
    expect(flags([...base, "--split", "all"]).split).toBe("all")
  })

  test("refuse a value given to a switch, so --dry-run=true is never read as unset", () => {
    expect(flags([...base, "--dry-run"]).dryRun).toBe(true)
    for (const value of ["true", "1", "false", ""])
      expect(parseReplayArgs([...base, ...sending, `--dry-run=${value}`])).toBe("--dry-run takes no value")
    expect(parseReplayArgs([...base, "--help=x"])).toBe("--help takes no value")
    expect(parseReplayArgs([...base, "--no-dry-run"])).toContain("Unknown option")
  })

  test("take built engine variants only: a pending, desktop, unknown or repeated name is refused", () => {
    expect(flags([...base, "--variant", "engine", "--variant", "engine:shared-verify"]).variants).toEqual([
      { name: "engine" },
      { name: "engine:shared-verify", record: { name: "engine:shared-verify", keys: { verifyPolicy: "shared" } } },
    ])
    expect(parseReplayArgs([...base, "--variant", "engine:privacy-zdr"])).toContain("VS-23c")
    expect(parseReplayArgs([...base, "--variant", "desktop"])).toContain("runs on the desktop runner")
    expect(parseReplayArgs([...base, "--variant", "engine:nothing"])).toContain("not a registered variant")
    expect(parseReplayArgs([...base, "--variant", "Engine"])).toContain("is not a variant name")
    expect(parseReplayArgs([...base, "--variant", "engine", "--variant", "engine"])).toContain("more than once")
    expect(parseReplayArgs([...base, "--variant"])).toContain("Missing value for --variant")
  })

  // VS-29a. Each refusal below has one fault only, so none depends on the order the checks run in.
  test("take a triage model for a variant made by its models alone, other than --model", () => {
    const pair = [...base, "--variant", "engine", "--variant", "engine:cross-family"]
    const parsed = flags([...pair, "--triage-model", TRIAGE])
    expect(parsed.triage).toEqual({ id: TRIAGE_MODEL, price: { input: 1.25, output: 10 } })
    expect(parsed.variants).toEqual([
      { name: "engine" },
      { name: "engine:cross-family", record: { name: "engine:cross-family", keys: {}, models: "triage-pair" } },
    ])
    expect(flags(base)).not.toHaveProperty("triage")
    expect(parseReplayArgs([...pair, "--triage-model"])).toBe("Missing value for --triage-model")
    for (const bad of [TRIAGE_MODEL, `${TRIAGE_MODEL}=1.25`, "=1.25:10", `${TRIAGE_MODEL}=x:y`, `_${TRIAGE}`])
      expect(parseReplayArgs([...pair, "--triage-model", bad])).toBe(
        "--triage-model must be <id>=<in>:<out>, with USD per million input and output tokens, such as openai/gpt-5=1.25:10.",
      )
    const needs =
      "engine:cross-family is made by its models: it needs the review model, then a triage model other than it"
    expect(parseReplayArgs(pair)).toBe(`${needs}, not ${MODEL}. Give --triage-model.`)
    for (const variants of [[], ["--variant", "engine:shared-verify"]])
      expect(parseReplayArgs([...base, ...variants, "--triage-model", TRIAGE])).toBe(
        "--triage-model is for a variant made by its models (engine:cross-family); no --variant is.",
      )
    expect(parseReplayArgs([...pair, "--triage-model", `${MODEL}=${PRICE}`])).toBe(`${needs}, not ${MODEL} + ${MODEL}.`)
  })
})

describe("the send decision", () => {
  const protectedEnv = { ...PROTECTED }

  test("is dry without a budget or with --dry-run, even inside the protected environment with a key", () => {
    expect(replayMode(flags(base), protectedEnv)).toEqual({ mode: "dry" })
    expect(replayMode(flags([...base, ...sending, "--dry-run"]), protectedEnv)).toEqual({ mode: "dry" })
    expect(replayMode(flags([...base, ...sending, "--split", "held-out", "--dry-run"]), protectedEnv)).toEqual({
      mode: "dry",
    })
  })

  test("sends only when every rule holds, and refuses each one that does not", () => {
    expect(replayMode(flags([...base, ...sending]), protectedEnv)).toEqual({ mode: "paid" })
    const refused = (argv: string[], env: Record<string, string | undefined>, reason: string) => {
      const decided = replayMode(flags(argv), env)
      expect(decided).toEqual({ refused: expect.stringContaining(reason) })
    }
    const zero = ["--model", `${MODEL}=0:15`, ...base.slice(2)]
    refused([...zero, ...sending], protectedEnv, "prices above zero")
    refused([...base, ...sending], { ...protectedEnv, GITHUB_ACTIONS: undefined }, "runs only in the vectorscope-eval")
    refused([...base, ...sending], { ...protectedEnv, GITHUB_ACTIONS: "false" }, "runs only in the vectorscope-eval")
    refused(
      [...base, ...sending],
      { ...protectedEnv, VECTORSCOPE_EVAL_ENVIRONMENT: "production" },
      "runs only in the vectorscope-eval",
    )
    refused([...base, ...sending], { ...protectedEnv, VECTORSCOPE_EVAL_API_KEY: "" }, "VECTORSCOPE_EVAL_API_KEY")
    refused([...base, ...budget, "--out", path.join(root, "out")], protectedEnv, "--ledger and --out")
    refused([...base, ...budget, "--ledger", path.join(root, "l.jsonl")], protectedEnv, "--ledger and --out")
    // D5's pilot limits, each its own refusal: the development split, one repetition, $0.75 a case, $50 in all.
    refused([...base, ...sending, "--split", "held-out"], protectedEnv, "development split only")
    refused([...base, ...sending, "--split", "all"], protectedEnv, "development split only")
    refused([...base, ...sending, "--repeat", "2"], protectedEnv, "runs each case once")
    refused([...base, ...sending, "--case-budget-usd", "1"], protectedEnv, "case bound is at most")
    refused(
      [...base, "--budget-usd", "60", "--case-budget-usd", "0.75", ...sending.slice(4)],
      protectedEnv,
      "budget is at most",
    )
  })

  // VS-29a: a paid cross-family replay is not wired, so a triage model keeps a run dry or refuses it.
  test("refuses a run that would send with a triage model, which runs dry only", () => {
    const pair = [...base, "--variant", "engine:cross-family", "--triage-model", TRIAGE]
    const dryOnly = {
      refused:
        "Nothing was sent. A paid cross-family replay is not wired: engine:cross-family and --triage-model run dry only, until the owner chooses the pair (Q5) and funds its ablation (Q9).",
    }
    expect(replayMode(flags([...pair, ...sending]), protectedEnv)).toEqual(dryOnly)
    expect(replayMode(flags([...pair, ...sending, "--dry-run"]), protectedEnv)).toEqual({ mode: "dry" })
    expect(replayMode(flags(pair), protectedEnv)).toEqual({ mode: "dry" })
    // A run that would send names the variant without a triage model, or with one equal to --model: it is refused as
    // dry only, never first asked for a triage model that would then be refused.
    const variant = [...base, "--variant", "engine:cross-family"]
    expect(replayMode(flags([...variant, ...sending]), protectedEnv)).toEqual(dryOnly)
    expect(replayMode(flags([...variant, "--triage-model", `${MODEL}=${PRICE}`, ...sending]), protectedEnv)).toEqual(
      dryOnly,
    )
    // A dry one is still asked for it.
    expect(parseReplayArgs([...variant, ...sending, "--dry-run"])).toContain("Give --triage-model.")
  })

  test("reads three variables of the environment and no other", () => {
    const read = new Set<string>()
    const env = new Proxy(
      { ...protectedEnv, OPENROUTER_API_KEY: "x", HOME: "/home/x" },
      {
        get(target, key, receiver) {
          if (typeof key === "string") read.add(key)
          return Reflect.get(target, key, receiver)
        },
      },
    )
    replayMode(flags([...base, ...sending]), env)
    replayMode(flags(base), env)
    expect([...read].toSorted()).toEqual(
      ["GITHUB_ACTIONS", "VECTORSCOPE_EVAL_API_KEY", "VECTORSCOPE_EVAL_ENVIRONMENT"].toSorted(),
    )
  })

  test("refuses before it creates or loads anything, and leaves --work, --ledger and --out alone", async () => {
    const err: string[] = []
    const work = path.join(root, "refused-work")
    const out = path.join(root, "refused-out")
    const ledger = path.join(root, "refused.jsonl")
    const argv = ["--model", `${MODEL}=${PRICE}`, "--mirrors", root, "--work", work, ...budget]
    const io = (env: Record<string, string | undefined>) => ({
      env,
      out: () => {},
      err: (text: string) => void err.push(text),
    })
    expect(await main([...argv, "--ledger", ledger, "--out", out], io({}))).toBe(2)
    expect(await main([...argv, "--ledger", ledger, "--out", out, "--split", "held-out"], io(PROTECTED))).toBe(2)
    expect(await main([...argv, "--out", out], io(PROTECTED))).toBe(2)
    expect(err.join("")).toContain("Nothing was sent.")
    expect(err.join("")).toContain("runs only in the vectorscope-eval GitHub environment")
    expect(err.join("")).toContain("development split only")
    // Every send rule holds here but the switch has a value: refused as a flag, before the send decision.
    for (const value of ["true", "1"])
      expect(await main([...argv, "--ledger", ledger, "--out", out, `--dry-run=${value}`], io(PROTECTED))).toBe(2)
    expect(err.join("")).toContain("--dry-run takes no value")
    expect(await main(["--help=x"], io(PROTECTED))).toBe(2)
    for (const made of [work, out, ledger]) expect(existsSync(made)).toBe(false)
  })

  test("refuses a triage model the committed catalog does not hold at that price, before it creates anything", async () => {
    const err: string[] = []
    const work = path.join(root, "triage-work")
    const io = { env: PROTECTED, out: () => {}, err: (text: string) => void err.push(text) }
    const argv = ["--model", `${MODEL}=${PRICE}`, "--mirrors", root, "--work", work, "--variant", "engine:cross-family"]
    expect(await main([...argv, "--triage-model", "vendor/no-such-model=1:1"], io)).toBe(2)
    expect(await main([...argv, "--triage-model", `${TRIAGE_MODEL}=1:10`], io)).toBe(2)
    expect(err.join("")).toContain("--triage-model: vendor/no-such-model is not one of the committed catalog's")
    expect(err.join("")).toContain(`--triage-model: ${TRIAGE_MODEL} costs 1.25:10 in the committed catalog`)
    expect(existsSync(work)).toBe(false)
  })

  test("refuses a manifest that is not JSON, and fails a plan with no case, before it creates anything", async () => {
    const err: string[] = []
    const work = path.join(root, "unplanned-work")
    const io = { env: PROTECTED, out: () => {}, err: (text: string) => void err.push(text) }
    const argv = ["--model", `${MODEL}=${PRICE}`, "--mirrors", root, "--work", work]
    const broken = path.join(root, "broken-manifest.json")
    writeFileSync(broken, "{ not json")
    expect(await main([...argv, "--manifest", broken], io)).toBe(2)
    expect(err.join("")).toContain(`Invalid manifest ${broken}: not JSON.`)
    // A manifest whose cases all fall outside --split plans nothing, so a dry run proves nothing and fails.
    const seed = JSON.parse(readFileSync(SEED, "utf8")) as Manifest
    const development = path.join(root, "development-only.json")
    writeFileSync(
      development,
      JSON.stringify({ ...seed, cases: seed.cases.filter((item) => item.id === "pallets-werkzeug-1"), exclusions: [] }),
    )
    expect(await main([...argv, "--manifest", development, "--split", "calibration"], io)).toBe(1)
    expect(err.join("")).toContain(`No case of ${development} was planned for --split calibration.`)
    expect(existsSync(work)).toBe(false)
  })
})

describe("the catalog and the engine's settings", () => {
  const catalog: unknown = JSON.parse(readFileSync(CATALOG, "utf8"))

  test("the price given must be the committed catalog's, which the engine reserves with", () => {
    const chosen = catalogModel(catalog, MODEL, { input: 3, output: 15 })
    if ("problem" in chosen) throw new Error(chosen.problem)
    expect(chosen.entry).toMatchObject({
      tool_call: true,
      limit: { context: expect.any(Number), output: expect.any(Number) },
      cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    })
    expect(catalogModel(catalog, MODEL, { input: 3, output: 14 })).toEqual({
      problem: expect.stringContaining("costs 3:15 in the committed catalog"),
    })
    for (const id of ["vendor/no-such-model", "__proto__", "constructor", "toString"])
      expect(catalogModel(catalog, id, { input: 3, output: 15 })).toEqual({
        problem: expect.stringContaining("is not one of the committed catalog's"),
      })
    const toolless = {
      [PAID_PROVIDER]: {
        models: { "a/b": { tool_call: false, limit: { context: 1, output: 1 }, cost: { input: 1, output: 1 } } },
      },
    }
    expect(catalogModel(toolless, "a/b", { input: 1, output: 1 })).toEqual({
      problem: expect.stringContaining("does not call tools"),
    })
    const free = {
      [PAID_PROVIDER]: {
        models: { "a/b": { tool_call: true, limit: { context: 1, output: 1 }, cost: { input: 0, output: 0 } } },
      },
    }
    expect(catalogModel(free, "a/b", { input: 0, output: 0 })).toEqual({
      problem: expect.stringContaining("no price above zero"),
    })
    expect(catalogModel("not a catalog", MODEL, { input: 3, output: 15 })).toHaveProperty("problem")
  })

  test("the engine's environment holds no key, and every catalog provider key but the eval's is removed", () => {
    const environment = engineEnvironment(path.join(root, "engine"))
    expect(environment).toMatchObject({
      VECTOR_DISABLE_MODELS_FETCH: "1",
      VECTOR_MODELS_PATH: CATALOG,
      VECTOR_PURE: "1",
      VECTOR_DISABLE_PROJECT_CONFIG: "1",
      VECTOR_DISABLE_AUTOUPDATE: "1",
      VECTOR_DISABLE_USAGE: "1",
      VECTOR_BRAIN_EMBED: "off",
    })
    for (const name of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "HOME"])
      expect(environment[name]!.startsWith(path.join(root, "engine"))).toBe(true)
    expect(Object.keys(environment).some((name) => /KEY|TOKEN|SECRET/.test(name))).toBe(false)
    const keys = providerKeys(catalog)
    expect(keys).toContain("OPENROUTER_API_KEY")
    expect(keys).toContain("ANTHROPIC_API_KEY")
    expect(keys).not.toContain("VECTORSCOPE_EVAL_API_KEY")
  })

  test("the dry config points one provider at the fake server with a dummy key; the paid one names the key only by reference", () => {
    const chosen = catalogModel(catalog, MODEL, { input: 3, output: 15 })
    if ("problem" in chosen) throw new Error(chosen.problem)
    const dry = JSON.parse(
      engineConfig({ mode: "dry", server: "http://127.0.0.1:4096/v1", id: MODEL, entry: chosen.entry }),
    )
    expect(dry).toMatchObject({
      lsp: false,
      formatter: false,
      snapshot: false,
      enabled_providers: [PROJECTION_PROVIDER],
    })
    expect(Object.keys(dry.provider)).toEqual([PROJECTION_PROVIDER])
    expect(dry.provider[PROJECTION_PROVIDER]).toMatchObject({
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "projection-dummy-key", baseURL: "http://127.0.0.1:4096/v1" },
    })
    expect(dry.provider[PROJECTION_PROVIDER].models[MODEL].cost).toEqual(chosen.entry.cost)
    const paid = engineConfig({ mode: "paid" })
    expect(JSON.parse(paid)).toMatchObject({
      enabled_providers: [PAID_PROVIDER],
      provider: { [PAID_PROVIDER]: { options: { apiKey: "{env:VECTORSCOPE_EVAL_API_KEY}" } } },
    })
    expect(paid).not.toContain(DUMMY_KEY)
  })

  test("the dry config lists a triage model beside the review model, under the one provider and its dummy key", () => {
    const review = catalogModel(catalog, MODEL, { input: 3, output: 15 })
    const triage = catalogModel(catalog, TRIAGE_MODEL, { input: 1.25, output: 10 })
    if ("problem" in review) throw new Error(review.problem)
    if ("problem" in triage) throw new Error(triage.problem)
    const server = "http://127.0.0.1:4096/v1"
    const alone = JSON.parse(engineConfig({ mode: "dry", server, id: MODEL, entry: review.entry }))
    const dry = JSON.parse(
      engineConfig({
        mode: "dry",
        server,
        id: MODEL,
        entry: review.entry,
        triage: { id: TRIAGE_MODEL, entry: triage.entry },
      }),
    )
    expect(dry.enabled_providers).toEqual([PROJECTION_PROVIDER])
    expect(Object.keys(dry.provider)).toEqual([PROJECTION_PROVIDER])
    const provider = dry.provider[PROJECTION_PROVIDER]
    expect(provider.options).toEqual(alone.provider[PROJECTION_PROVIDER].options)
    expect(provider.options.apiKey).toBe("projection-dummy-key")
    expect(Object.keys(provider.models)).toEqual([MODEL, TRIAGE_MODEL])
    // The review model is listed as it is alone, and the triage model the same way, from its own catalog entry.
    expect(provider.models[MODEL]).toEqual(alone.provider[PROJECTION_PROVIDER].models[MODEL])
    expect(Object.keys(alone.provider[PROJECTION_PROVIDER].models)).toEqual([MODEL])
    expect(provider.models[TRIAGE_MODEL]).toEqual({
      id: TRIAGE_MODEL,
      name: triage.entry.name ?? TRIAGE_MODEL,
      release_date: triage.entry.release_date ?? "2025-01-01",
      attachment: triage.entry.attachment ?? false,
      reasoning: triage.entry.reasoning ?? false,
      temperature: triage.entry.temperature ?? false,
      tool_call: true,
      limit: triage.entry.limit,
      cost: { input: 1.25, output: 10, cache_read: 0.125 },
      options: {},
    })
  })
})

// The entry point runs on the eval workflow's Linux runners. Its child here gets a POSIX environment (a path, a home and
// a temporary directory alone): on Windows a process needs more than that to start, and HOME does not move the home
// directory, so these two cases run on Linux and macOS (as test/server/httpapi-pty.test.ts does for its own).
const posix = process.platform === "win32" ? test.skip : test

describe("a dry run, as a subprocess", () => {
  // A seed case whose commits are a synthetic repository's, served from a local mirror, so nothing is fetched.
  const mirrorDir = path.join(root, "mirrors", "pallets", "werkzeug")
  const commits = buildMirror(mirrorDir)
  const seed = JSON.parse(readFileSync(SEED, "utf8")) as Manifest
  const item = seed.cases.find((entry) => entry.id === "pallets-werkzeug-1")!
  const manifest = path.join(root, "manifest.json")
  writeFileSync(
    manifest,
    JSON.stringify({
      ...seed,
      cases: [{ ...item, candidate: { ...item.candidate, base: commits.base, head: commits.head } }],
      exclusions: [],
    }),
  )

  const run = (argv: string[]) => {
    const home = path.join(root, "home")
    const temp = path.join(root, "tmp")
    mkdirSync(home, { recursive: true })
    mkdirSync(temp, { recursive: true })
    const child = Bun.spawnSync([process.execPath, path.join("script", "vectorscope-replay.ts"), ...argv], {
      cwd: ENGINE,
      // The whole environment the child gets: a path, a home, a temporary directory and the protected marks with a
      // dummy key. None of the parent's variables, its egress guard's proxy among them.
      env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: temp, ...PROTECTED },
      stdout: "pipe",
      stderr: "pipe",
    })
    return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
  }

  posix(
    "projects every case for each variant with no connection off this computer, and never sees the key",
    () => {
      const work = path.join(root, "dry-work")
      const out = path.join(root, "dry-out")
      const result = run([
        "--model",
        `${MODEL}=${PRICE}`,
        "--manifest",
        manifest,
        "--mirrors",
        path.join(root, "mirrors"),
        "--work",
        work,
        "--out",
        out,
        "--variant",
        "engine",
        "--variant",
        "engine:shared-verify",
      ])
      expect(result.stderr).toBe("")
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("pallets-werkzeug-1  engine  projected")
      expect(result.stdout).toContain("pallets-werkzeug-1  engine:shared-verify  projected")
      expect(result.stdout).toMatch(
        /The strict egress guard logged [1-9]\d* connection attempts, 0 off this computer\./,
      )
      expect(result.stdout).toContain("Dry run: nothing was sent.")
      const files = readdirSync(out).toSorted()
      expect(files).toEqual([
        "anthropic_claude-sonnet-4.5--pallets-werkzeug-1--engine--r1.projection.json",
        "anthropic_claude-sonnet-4.5--pallets-werkzeug-1--engine_shared-verify--r1.projection.json",
      ])
      for (const file of files) {
        const text = readFileSync(path.join(out, file), "utf8")
        const record = JSON.parse(text)
        expect(projectionProblems(record)).toEqual([])
        expect(record.egress.outside).toBe(0)
        expect(record.cap.maxCostUsd).toBe(0.75)
        // The engine priced the booted model with the catalog's cache rates, which the route check compared.
        expect(record.models.review).toMatchObject({
          id: `${PROJECTION_PROVIDER}/${MODEL}`,
          costKind: "priced",
          price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        })
        expect(record.runtime.isolation).toMatchObject({ pure: true, projectConfig: false })
        expect(text).not.toContain(DUMMY_KEY)
      }
      expect(result.stdout).not.toContain(DUMMY_KEY)
      // What the run created under --work is gone.
      expect(readdirSync(work)).toEqual([])
    },
    120_000,
  )

  // VS-29a and I-1: --triage-model changes nothing for a variant not made by its models. The same variants run with and
  // without it, and their records match field for field, except where the prompts name the run's own temporary
  // directory (and so the digests of those bodies): the two work directories' names have one length, so every count
  // matches too. Two runs, so twice the single run's time.
  posix(
    "projects engine:cross-family on the pair, and leaves every other variant's record as it is without --triage-model",
    () => {
      const project = (name: string, extra: string[]) => {
        const work = path.join(root, `pair-work-${name}`)
        const out = path.join(root, `pair-out-${name}`)
        const result = run([
          "--model",
          `${MODEL}=${PRICE}`,
          "--manifest",
          manifest,
          "--mirrors",
          path.join(root, "mirrors"),
          "--work",
          work,
          "--out",
          out,
          "--variant",
          "engine",
          "--variant",
          "engine:shared-verify",
          ...extra,
        ])
        expect(result.stderr).toBe("")
        expect(result.code).toBe(0)
        expect(result.stdout).toMatch(/connection attempts, 0 off this computer\./)
        expect(result.stdout).not.toContain(DUMMY_KEY)
        const text = (file: string) => {
          const written = readFileSync(path.join(out, file), "utf8")
          expect(written).not.toContain(DUMMY_KEY)
          return written
        }
        // Each record as written, which projectionProblems checks.
        const raw = (file: string) => JSON.parse(text(file))
        // Each record with the run's temporary directory named alike and its request digests left out.
        const read = (file: string) => {
          const escaped = work.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          const record = JSON.parse(text(file).replace(new RegExp(`${escaped}/run-[A-Za-z0-9]{6}`, "g"), "<run>"))
          return {
            ...record,
            passes: record.passes.map((pass: { requests: { digest: string }[] }) => ({
              ...pass,
              requests: pass.requests.map((request) => ({ ...request, digest: undefined })),
            })),
          }
        }
        return { result, out, raw, read }
      }
      const alone = project("a", [])
      const paired = project("b", ["--variant", "engine:cross-family", "--triage-model", TRIAGE])
      const frozen = [
        "anthropic_claude-sonnet-4.5--pallets-werkzeug-1--engine--r1.projection.json",
        "anthropic_claude-sonnet-4.5--pallets-werkzeug-1--engine_shared-verify--r1.projection.json",
      ]
      // The pair's models name its file, joined by "+", which the slug never writes.
      const pairFile =
        "anthropic_claude-sonnet-4.5+openai_gpt-5--pallets-werkzeug-1--engine_cross-family--r1.projection.json"
      expect(readdirSync(alone.out).toSorted()).toEqual(frozen)
      expect(readdirSync(paired.out).toSorted()).toEqual([pairFile, ...frozen])
      expect(paired.result.stdout).toContain(
        `on ${MODEL}, with ${TRIAGE_MODEL} as the first pass of engine:cross-family (the pair's labs unchecked until codium's labOf merges), repetition 1 only`,
      )
      expect(paired.result.stdout).toContain("pallets-werkzeug-1  engine:cross-family  projected")
      for (const variant of ["engine", "engine:shared-verify"]) {
        const line = (text: string) =>
          text.split("\n").find((entry) => entry.startsWith(`pallets-werkzeug-1  ${variant}  `))
        expect(line(paired.result.stdout)).toBe(line(alone.result.stdout))
      }
      for (const file of frozen) {
        expect(projectionProblems(paired.raw(file))).toEqual([])
        const record = paired.read(file)
        expect(record).toEqual(alone.read(file))
        expect(record.models.triage).toBeUndefined()
        expect(record.scope.triage).toBeUndefined()
      }

      // The pair: its first pass on the triage model, the double-check on the review model, and both recorded.
      const pair = paired.raw(pairFile)
      expect(projectionProblems(pair)).toEqual([])
      expect(pair.variant).toEqual({ name: "engine:cross-family", keys: {}, models: "triage-pair" })
      const review = `${PROJECTION_PROVIDER}/${MODEL}`
      const triage = `${PROJECTION_PROVIDER}/${TRIAGE_MODEL}`
      expect(pair.models.review.id).toBe(review)
      expect(pair.models.triage).toMatchObject({
        id: triage,
        costKind: "priced",
        price: { input: 1.25, output: 10, cacheRead: 0.125 },
      })
      expect(pair.scope.triage).toBe(triage)
      const passes: { pass: string; model: string }[] = pair.passes
      expect(passes.map((pass) => pass.pass)).toContain("review")
      expect(passes.map((pass) => pass.pass)).toContain("verify")
      for (const pass of passes) expect(pass.model).toBe(pass.pass === "verify" ? review : triage)
      expect(projectedRun(pair)).toMatchObject({
        variant: "engine:cross-family",
        model: review,
        models: [review, triage],
      })
    },
    240_000,
  )

  posix(
    "fails a case it cannot prepare, naming it, and still sends nothing",
    () => {
      const result = run([
        "--model",
        `${MODEL}=${PRICE}`,
        "--manifest",
        manifest,
        "--mirrors",
        path.join(root, "no-mirrors"),
        "--work",
        path.join(root, "missing-work"),
      ])
      expect(result.code).toBe(1)
      expect(result.stdout).toContain("pallets-werkzeug-1  engine  no mirror")
      expect(result.stdout).toContain("0 off this computer")

      // A mirror that is not a repository: git's several lines of stderr are quoted on the case's line, so none of
      // them can start a line of the log that ci.ts relays.
      const broken = path.join(root, "broken-mirrors")
      mkdirSync(path.join(broken, "pallets", "werkzeug"), { recursive: true })
      const failed = run([
        "--model",
        `${MODEL}=${PRICE}`,
        "--manifest",
        manifest,
        "--mirrors",
        broken,
        "--work",
        path.join(root, "broken-work"),
      ])
      expect(failed.code).toBe(1)
      const lines = failed.stdout.split("\n")
      expect(lines.find((line) => line.startsWith("pallets-werkzeug-1  engine  "))).toMatch(
        /^pallets-werkzeug-1 {2}engine {2}checkout failed: "git .*fetch.* failed: .*"$/,
      )
      expect(lines.some((line) => /^(fatal|error|Please)\b/.test(line))).toBe(false)
      expect(failed.stdout).toContain("0 off this computer")
    },
    120_000,
  )
})

// VS-21e: --cost-split and --scenario, two dry-only flags that are absent unless given.
describe("the cost split and the canned scenario (VS-21e)", () => {
  test("are parsed when given and absent when not, and refuse what would mix a scenario with real records", async () => {
    expect(flags(base)).not.toHaveProperty("costSplit")
    expect(flags(base)).not.toHaveProperty("scenario")
    expect(flags([...base, "--cost-split"]).costSplit).toBe(true)
    expect(flags([...base, "--scenario", "suggestion-untrusted"]).scenario).toBe("suggestion-untrusted")
    expect(parseReplayArgs([...base, "--scenario", "nits"])).toBe(
      '--scenario must be suggestion-untrusted, not "nits".',
    )
    expect(parseReplayArgs([...base, "--scenario"])).toBe("Missing value for --scenario")
    expect(parseReplayArgs([...base, "--scenario", "suggestion-untrusted", "--out", path.join(root, "o")])).toBe(
      "--scenario writes no record: leave out --out, so a canned scenario's projection is never read as a real one.",
    )
    for (const value of ["x", "true", ""])
      expect(parseReplayArgs([...base, `--cost-split=${value}`])).toBe("--cost-split takes no value")
    // The entry point names the canned model's scenarios so that it can refuse one before any engine module loads; the
    // fixture is loaded here, after every in-process test above, to check that the two lists agree.
    const { PROJECTION_SCENARIOS } = await import("../fixture/projection")
    expect([...SCENARIOS]).toEqual([...PROJECTION_SCENARIOS])
  })

  test("are dry only: a run that would send with either is refused, and --dry-run keeps it dry", () => {
    const dryOnly = "--cost-split and --scenario are for dry runs only"
    expect(replayMode(flags([...base, ...sending, "--cost-split"]), PROTECTED)).toEqual({
      refused: expect.stringContaining(dryOnly),
    })
    expect(
      replayMode(
        flags([...base, ...budget, "--ledger", path.join(root, "l.jsonl"), "--scenario", "suggestion-untrusted"]),
        PROTECTED,
      ),
    ).toEqual({ refused: expect.stringContaining(dryOnly) })
    expect(replayMode(flags([...base, ...sending, "--cost-split", "--dry-run"]), PROTECTED)).toEqual({ mode: "dry" })
    expect(replayMode(flags([...base, "--cost-split", "--scenario", "suggestion-untrusted"]), PROTECTED)).toEqual({
      mode: "dry",
    })
    // Without them a run that would send is decided as before.
    expect(replayMode(flags([...base, ...sending]), PROTECTED)).toEqual({ mode: "paid" })
  })

  test("leave --model and --triage-model at two price fields, with their messages as they were", () => {
    expect(parseReplayArgs(["--model", `${MODEL}=3:15:0.3:3.75`, ...base.slice(2)])).toBe(
      "--model must be <id>=<in>:<out>, with USD per million input and output tokens, such as anthropic/claude-sonnet-4.5=3:15.",
    )
    expect(
      parseReplayArgs([...base, "--variant", "engine:cross-family", "--triage-model", `${TRIAGE_MODEL}=1.25:10:0.125`]),
    ).toBe(
      "--triage-model must be <id>=<in>:<out>, with USD per million input and output tokens, such as openai/gpt-5=1.25:10.",
    )
  })
})

describe("a dry run with the cost split and the scenario, as a subprocess (VS-21e)", () => {
  const mirrorDir = path.join(root, "mirrors-21e", "pallets", "werkzeug")
  const commits = buildMirror(mirrorDir)
  const seed = JSON.parse(readFileSync(SEED, "utf8")) as Manifest
  const item = seed.cases.find((entry) => entry.id === "pallets-werkzeug-1")!
  const manifest = path.join(root, "manifest-21e.json")
  writeFileSync(
    manifest,
    JSON.stringify({
      ...seed,
      cases: [{ ...item, candidate: { ...item.candidate, base: commits.base, head: commits.head } }],
      exclusions: [],
    }),
  )
  const run = (name: string, extra: string[]) => {
    const home = path.join(root, `home-21e-${name}`)
    const temp = path.join(root, `tmp-21e-${name}`)
    mkdirSync(home, { recursive: true })
    mkdirSync(temp, { recursive: true })
    const child = Bun.spawnSync(
      [
        process.execPath,
        path.join("script", "vectorscope-replay.ts"),
        "--model",
        `${MODEL}=${PRICE}`,
        "--manifest",
        manifest,
        "--mirrors",
        path.join(root, "mirrors-21e"),
        "--work",
        path.join(root, `work-21e-${name}`),
        "--variant",
        "engine",
        "--variant",
        "engine:shared-verify",
        ...extra,
      ],
      {
        cwd: ENGINE,
        env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: temp, ...PROTECTED },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
  }

  posix(
    "shows N and N+1 verify candidates, the cached and uncached split, and leaves the unflagged lines as they were",
    async () => {
      const flagged = run("a", ["--scenario", "suggestion-untrusted", "--cost-split"])
      expect(flagged.stderr).toBe("")
      expect(flagged.code).toBe(0)
      const lines = flagged.stdout.split("\n")
      const count = (variant: string) =>
        Number(
          /, (\d+) verify candidate\(s\)$/.exec(
            lines.find((line) => line.startsWith(`pallets-werkzeug-1  ${variant}  projected, `)) ?? "",
          )?.[1],
        )
      expect(count("engine")).toBeGreaterThan(0)
      expect(count("engine:shared-verify")).toBe(count("engine") + 1)
      expect(flagged.stdout).toContain("Scenario suggestion-untrusted (VS-21e)")
      for (const variant of ["engine", "engine:shared-verify"])
        for (const pass of ["review", "verify", "all passes"])
          for (const band of ["cached", "uncached"])
            expect(
              lines.some((line) =>
                line.startsWith(`| ${variant} · ${PROJECTION_PROVIDER}/${MODEL} | ${pass} | ${band} |`),
              ),
            ).toBe(true)
      expect(flagged.stdout).toContain("the gap between them is not a caching saving")
      // The catalog's Sonnet 4.5 prices are its list prices, so the D6 check prints nothing.
      expect(flagged.stdout).not.toContain("Price check")
      expect(flagged.stdout).toMatch(/connection attempts, 0 off this computer\./)
      expect(flagged.stdout).not.toContain(DUMMY_KEY)
      expect(readdirSync(path.join(root, "work-21e-a"))).toEqual([])

      // Without either flag the case lines and the table are as they were: no count, no split.
      const out = path.join(root, "out-21e-b")
      const plain = run("b", ["--out", out])
      expect(plain.code).toBe(0)
      for (const variant of ["engine", "engine:shared-verify"])
        expect(plain.stdout.split("\n").find((line) => line.startsWith(`pallets-werkzeug-1  ${variant}  `))).toMatch(
          new RegExp(`^pallets-werkzeug-1 {2}${variant} {2}projected, \\d+ request\\(s\\)$`),
        )
      expect(plain.stdout).not.toContain("verify candidate")
      expect(plain.stdout).not.toContain("Projected cost by pass")
      expect(plain.stdout).not.toContain("Scenario")
      // Nor does the scenario reach the unflagged bodies: its records' verify passes were asked about the same
      // candidates under both variants, engine's flagged count. The bodies themselves name the work directory, the
      // platform and today's date, so no digest of them is pinned here (the deviation log, VS-21e).
      const { firstUserText } = await import("../fixture/projection")
      const records = readdirSync(out).map(
        (name) => JSON.parse(readFileSync(path.join(out, name), "utf8")) as ProjectionRecord,
      )
      const asked = (variant: string) => {
        const body = records
          .find((record) => projectedRun(record).variant === variant)
          ?.passes.find((pass) => pass.pass === "verify")?.requests[0]?.body
        return body ? [...firstUserText(JSON.parse(body)).matchAll(/<untrusted_candidate id="/g)].length : undefined
      }
      expect(records).toHaveLength(2)
      expect(asked("engine")).toBe(count("engine"))
      expect(asked("engine:shared-verify")).toBe(count("engine"))
    },
    240_000,
  )
})

function buildMirror(dir: string) {
  mkdirSync(dir, { recursive: true })
  const env = {
    ...gitEnv(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  }
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", dir, ...args], { env, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
    return result.stdout.toString().trim()
  }
  const commit = (message: string, files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
      writeFileSync(path.join(dir, file), text)
    }
    git("add", "--all")
    git("commit", "--quiet", "-m", message)
    return git("rev-parse", "HEAD")
  }
  git("init", "--quiet", "--initial-branch=main")
  const baseCommit = commit("base", { "src/app.py": "def total(items):\n    return sum(items)\n" })
  const head = commit("candidate", { "src/app.py": "def total(items):\n    return sum(items[1:])\n" })
  return { base: baseCommit, head }
}
