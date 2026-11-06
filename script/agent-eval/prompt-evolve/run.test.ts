import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { exec } from "../compounding/harness"
import { parse, unseen } from "./run"
import { save } from "./traces"
import { SAFETY } from "./contracts"
import { HARNESS_BASE, REPO_ROOT } from "./variants"

const root = await mkdtemp(join(tmpdir(), "prompt-evolve-run-"))
afterAll(() => rm(root, { recursive: true, force: true }))

const RUN = join(import.meta.dir, "run.ts")
const LIVE = [
  "--live",
  "--yes",
  "--max-spend",
  "1",
  "--prices",
  "p.json",
  "--model",
  "anthropic/claude-sonnet-4-5",
  "--allow-remote",
]
const error = (argv: string[], env: Record<string, string | undefined> = {}) => {
  const result = parse(argv, env)
  return "error" in result ? result.error : undefined
}

// Every file under a folder, with its size and modification time.
const files = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted()
const state = async (dir: string) =>
  Promise.all(
    (await files(dir)).map(async (file) => `${file} ${(await stat(file)).size} ${(await stat(file)).mtimeMs}`),
  )

describe("run.ts", () => {
  test("refuses before running anything: --archive with live or replay, an unknown suite, --out under packages/, a live run it may not start", () => {
    expect(error(["--archive", "--suite", "scripted,replay"])).toContain("replay")
    expect(error(["--archive"])).toContain("replay")
    expect(error(["--archive", "--suite", "scripted", ...LIVE])).toContain("live")
    expect(error(["--archive", "--suite", "scripted,footprint", "--dry-run"])).toContain("dry run")
    expect(error(["--archive", "--suite", "scripted,footprint"])).toBeUndefined()
    expect(error(["--suite", "scripted,vibes"])).toContain("Unknown suite vibes")
    expect(error(["--out", join(REPO_ROOT, "packages", "engine", "report")])).toContain("packages/")
    expect(error(["--live"])).toContain("--yes")
    expect(error([...LIVE, "--dry-run"])).toContain("dry run")
    expect(error(LIVE, { CI: "1" })).toContain("CI")
    expect(error(["--variants", "a", "--bogus"])).toContain("Unknown option --bogus")
    expect(
      parse([
        "--variants",
        "a,b",
        "--suite",
        "footprint",
        "--scenario",
        "solo-fix",
        "--dry-run",
        "--out",
        join(root, "x"),
      ]),
    ).toEqual({
      options: {
        variants: ["a", "b"],
        suites: ["footprint"],
        scenarios: ["solo-fix"],
        out: join(root, "x"),
        archive: false,
        dryRun: true,
        keep: false,
      },
    })
  })

  test("refuses a live model that gets another provider prompt than the variants start from", () => {
    const model = (name: string) => LIVE.map((item) => (item === "anthropic/claude-sonnet-4-5" ? name : item))
    expect(error(model("local/qwen"))).toContain("gets default.txt, but the variants start from anthropic.txt")
    expect(error(model("openai/gpt-5"))).toContain("gets gpt.txt")
    expect(error(model("anthropic/claude-opus-4-1"))).toBeUndefined()
  })

  test("a suite whose requests never carried the variant's prompt is left unmeasured", () => {
    const request = (system: string) => ({
      body: { system: [{ type: "text", text: system }] },
      output: "",
      sentBytes: 0,
    })
    expect(
      unseen([[request("You are Vector.\nA marker sentence.\n\nEnvironment")]], "A marker sentence.\n"),
    ).toBeUndefined()
    expect(unseen([[request("You are Vector.")]], "A marker sentence.")).toContain("no request carried")
    // The baseline has no rendered prompt of its own to look for.
    expect(unseen([[request("You are Vector.")]], undefined)).toBeUndefined()
  })

  test("--dry-run writes only under --out", async () => {
    const sandbox = join(root, "sandbox")
    for (const name of ["home", "tmp", "state", "cache", "cwd"]) await mkdir(join(sandbox, name), { recursive: true })
    const watched = [join(REPO_ROOT, "script", "agent-eval", "prompt-evolve"), join(REPO_ROOT, "docs", "benchmarks")]
    const before = await Promise.all(watched.map(state))
    const result = await exec(
      process.execPath,
      [RUN, "--variants", "identity", "--dry-run", "--out", join(sandbox, "out")],
      join(sandbox, "cwd"),
      {
        PATH: process.env.PATH ?? "",
        HOME: join(sandbox, "home"),
        TMPDIR: join(sandbox, "tmp"),
        XDG_STATE_HOME: join(sandbox, "state"),
        XDG_CACHE_HOME: join(sandbox, "cache"),
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      },
    )
    expect(result.exitCode).toBe(0)
    expect(await files(sandbox)).toEqual([join(sandbox, "out", "report.json"), join(sandbox, "out", "report.md")])
    expect(await Promise.all(watched.map(state))).toEqual(before)
    const report = await Bun.file(join(sandbox, "out", "report.json")).json()
    expect(report.status).toBe("dry-run")
    expect(report.variants.map((item: { id: string }) => item.id)).toEqual(["identity"])
  })

  test("identity gives zero deltas on the scripted, footprint and replay suites", async () => {
    // One task, one scenario and one small trace, against the fake model server: six short runs, one at a time.
    const repo = join(root, "repo")
    await mkdir(join(repo, "src"), { recursive: true })
    await writeFile(join(repo, "src", "a.ts"), "export const a = 1\n")
    const git = (...args: string[]) =>
      exec("git", ["-c", "user.name=Owner", "-c", "user.email=owner@example.test", ...args], repo, {
        PATH: process.env.PATH ?? "",
        HOME: root,
      })
    await git("init", "--quiet", "-b", "main")
    await git("add", "-A")
    await git("commit", "--quiet", "-m", "Start")
    const env = { XDG_STATE_HOME: join(root, "state") }
    await save(
      {
        repo,
        prompts: ["Bump the constant."],
        calls: [
          { tool: "read", input: { filePath: join(repo, "src", "a.ts") }, output: "1: export const a = 1", prompt: 0 },
          {
            tool: "edit",
            input: { filePath: join(repo, "src", "a.ts"), oldString: "a = 1", newString: "a = 2" },
            output: "Edited",
            prompt: 0,
          },
          {
            tool: "bash",
            input: { command: "bun test", description: "Run the tests" },
            output: "0 pass\n0 fail\nRan 0 tests. [12.00ms]",
            prompt: 0,
          },
        ],
      },
      "bump",
      env,
    )
    const out = join(root, "out")
    const result = await exec(
      process.execPath,
      [
        RUN,
        "--suite",
        "scripted,footprint,replay",
        "--tasks",
        "t01-slugify",
        "--scenario",
        "solo-fix",
        "--traces",
        "bump",
        "--out",
        out,
      ],
      REPO_ROOT,
      {
        ...(Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ) as Record<string, string>),
        ...env,
      },
    )
    expect({ exitCode: result.exitCode, output: result.exitCode === 0 ? "" : result.output.slice(-2_000) }).toEqual({
      exitCode: 0,
      output: "",
    })
    const report = await Bun.file(join(out, "report.json")).json()
    expect(report.status).toBe("valid")
    const identity = report.variants.find((item: { id: string }) => item.id === "identity")
    for (const suite of ["scripted", "footprint", "replay"]) {
      expect(report.baseline.suites[suite].inputTokens).toBeGreaterThan(0)
      expect(Object.values(identity.suites[suite].delta).every((value) => value === 0)).toBe(true)
    }
    expect(report.baseline.suites.scripted).toMatchObject({ runs: 1, passed: 1 })
  }, 240_000)

  test("a variant's text reaches the model it is measured on: a marker sentence is in its requests, and dropping its verification changes what it does", async () => {
    // A variant of its own: the shipped prompt with a sentence no other prompt has, and without its verification policy.
    const dir = join(root, "marked-variants")
    await mkdir(dir, { recursive: true })
    const marker = "Name the zebra-quartz-17 file nowhere."
    await writeFile(
      join(dir, "marked.json"),
      JSON.stringify({
        id: "marked",
        description: "The shipped prompt with a marker, without its verification sentences.",
        agent: "build",
        base: HARNESS_BASE,
        patches: [
          { find: "# Doing tasks", replace: `# Doing tasks\n${marker}` },
          ...SAFETY.filter((item) => item.source === HARNESS_BASE && item.clause.startsWith("verify.")).map((item) => ({
            find: item.sentence,
            replace: "",
          })),
        ],
      }),
    )
    const out = join(root, "marked-out")
    const work = join(root, "marked-tmp")
    await mkdir(work, { recursive: true })
    const result = await exec(
      process.execPath,
      [
        RUN,
        "--variants",
        "marked",
        "--variants-dir",
        dir,
        "--suite",
        "scripted",
        "--tasks",
        "t01-slugify",
        "--out",
        out,
        "--keep",
      ],
      REPO_ROOT,
      {
        ...(Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ) as Record<string, string>),
        TMPDIR: work,
      },
    )
    expect({ exitCode: result.exitCode, output: result.exitCode === 0 ? "" : result.output.slice(-2_000) }).toEqual({
      exitCode: 0,
      output: "",
    })
    const report = await Bun.file(join(out, "report.json")).json()
    const marked = report.variants.find((item: { id: string }) => item.id === "marked")
    // Measured, so the guard found its text in the requests; and not the shipped prompt's numbers.
    expect(marked.suites.scripted).toBeDefined()
    expect(marked.suites.scripted.delta.inputTokens).not.toBe(0)
    // The kept dump: the variant's requests carry the marker, the baseline's do not, and it ran fewer commands.
    const [kept] = (await readdir(work)).filter((name) => name.startsWith("vector-prompt-evolve-"))
    const dump = async (arm: string) =>
      (await Bun.file(join(work, kept!, arm, "scripted-dump", "off-t01-slugify.json")).json()).requests as {
        body: Record<string, unknown>
      }[]
    const bashes = (requests: { body: Record<string, unknown> }[]) =>
      JSON.stringify(requests.at(-1)?.body.messages ?? []).split('"name":"bash"').length
    const baseline = await dump("arm-00")
    const variant = await dump("arm-02")
    expect(JSON.stringify(baseline)).not.toContain(marker)
    expect(variant.some((request) => JSON.stringify(request.body.system).includes(marker))).toBe(true)
    expect(bashes(variant)).toBeLessThan(bashes(baseline))
  }, 240_000)
})
