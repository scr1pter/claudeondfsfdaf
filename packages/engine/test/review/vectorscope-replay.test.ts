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
  type ReplayFlags,
} from "../../script/vectorscope-replay"
import { gitEnv, type Manifest } from "../../../../script/vectorscope-eval/dataset"
import { projectionProblems } from "../../../../script/vectorscope-eval/replay"

// VS-21c's entry point (packages/engine/script/vectorscope-replay.ts). Its send decision is tested as a pure function
// only: no test here, or anywhere, runs its paid branch. The dry branch runs as a subprocess against a synthetic mirror,
// inside a complete protected environment with a dummy key, and must send nothing and never see the key.

const root = mkdtempSync(path.join(tmpdir(), "vectorscope-replay-entry-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ENGINE = path.join(import.meta.dir, "..", "..")
const SEED = path.join(ENGINE, "..", "..", "script", "vectorscope-eval", "dataset", "seed.json")
const MODEL = "anthropic/claude-sonnet-4.5"
const PRICE = "3:15"
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
