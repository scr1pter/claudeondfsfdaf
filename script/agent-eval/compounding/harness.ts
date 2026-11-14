// Runs the task sequence against the real `vector run`, one arm at a time per directory:
//
// - off:   brain off. No memory tool, and every task runs with its session and brain databases in memory
//          (VECTOR_AGENT_DB=:memory:) and a fresh home, so nothing a task learns reaches the next one and no brain.db
//          is ever opened.
// - on:    brain on. One home for the whole sequence, so brain.db persists; learning is on and what the agent saves is
//          in use from the next request, as Vector ships it (the user can undo it; nobody does here).
// - blind: the mutation control. The brain is on as in `on`, but the fake model server deletes everything the
//          brain added to each request before the scripted model reads it. If `on` wins only through what the brain
//          put in the requests, `blind` must lose that advantage.
//
// Every task starts every arm from the same files (week 0, the reference solutions of the tasks before it, and any
// teammate's commit the sequence makes before it), so the arms differ only in what Vector carried from one task to the
// next.

import { spawn } from "node:child_process"
import { mkdir, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { meterLine, type Meter } from "../meter"
import type { Rates, Recorded } from "../prompt-cache"
import { PACKAGE_MANAGER, REGISTRY } from "./fixture"
import { junit, measure, spend, type TaskMetrics } from "./measure"
import { attachments, decide } from "./policy"
import { serve, type Call } from "./model-server"
import { ACCEPTANCE_PREAMBLE, TASKS, startOf, type Task } from "./tasks"

export const REPO_ROOT = resolve(import.meta.dir, "../../..")
export const MODEL = "claude-sonnet-4-5"
export type Arm = "off" | "on" | "blind"
export const ARMS: readonly Arm[] = ["off", "on", "blind"]

/** How `vector run` reaches a model: the offline fake server, or a live provider the owner configured. */
export type Provider = {
  /** The model as `vector run --model` takes it. */
  readonly model: string
  /** The provider entry for VECTOR_CONFIG_CONTENT. */
  readonly config: Record<string, unknown>
  /** Passed through to `vector run --max-cost`, live only. */
  readonly maxCost?: () => number | undefined
  /** Live: the owner's prices, at which spend is counted from the tokens the provider reports. */
  readonly rates?: Rates
  /** Live: US dollars left under the spend cap; a task is stopped once its own spend reaches it. */
  readonly remaining?: () => number
}

export type TaskRun = TaskMetrics & {
  readonly arm: Arm
  readonly title: string
  readonly exitCode: number
  readonly scriptError?: string
  /** brain databases found in this task's home after the run (brain off must leave none). */
  readonly brainFiles: readonly string[]
  readonly recall: readonly string[]
  readonly wallMs: number
  /** Live: the task was stopped when its spend reached what was left under the cap. */
  readonly capped?: boolean
}

export type ArmOptions = {
  readonly arm: Arm
  /** Where this arm's repository and homes live; removed first. */
  readonly root: string
  readonly tasks?: readonly string[]
  /** Offline: the scripted model answers. Live: undefined, and `provider` points at a real model. */
  readonly provider?: Provider
  readonly engine?: string
  readonly onTask?: (run: TaskRun) => void
  /** Live: stop before the next task once this returns true. */
  readonly stop?: () => boolean
  /** A folder to write every task's requests and event stream into, for reading a run afterwards. */
  readonly dump?: string
  /** Runs in a task's home before the task: the tests plant a brain.db where brain off must not read it. */
  readonly beforeTask?: (input: { readonly home: string; readonly task: Task }) => Promise<void>
  /** Configuration added to VECTOR_CONFIG_CONTENT: prompt evolution sets a variant's `agent.<agent>.prompt` here. */
  readonly config?: Record<string, unknown>
  /** A scripted model in place of policy.ts's; prompt evolution's also reads which clauses the system prompt states. */
  readonly decide?: typeof decide
}

export async function runArm(options: ArmOptions): Promise<TaskRun[]> {
  await rm(resolve(options.root), { recursive: true, force: true })
  await mkdir(join(resolve(options.root), "repo"), { recursive: true })
  // The folder's real path, so every request carries the same repository path however the folder was reached (its
  // length counts in each request's tokens). Before f20739052 it mattered more: under a symlinked folder (macOS's
  // temporary folder is one) Vector never showed a document pointer or guard.
  const base = await realpath(resolve(options.root))
  const dir = join(base, "repo")
  const bin = join(base, "bin")
  const registry = join(base, "registry")
  await installTools(bin, registry)
  await git(dir, ["init", "--quiet", "-b", "main"])
  const engine = options.engine ?? join(REPO_ROOT, "packages", "engine", "src", "index.ts")
  const homeOf = (index: number) => (options.arm === "off" ? join(base, `home-${String(index + 1).padStart(2, "0")}`) : join(base, "home"))
  const selected = TASKS.flatMap((task, index) => (!options.tasks || options.tasks.includes(task.id) ? [{ task, index }] : []))
  const runs: TaskRun[] = []
  const earlier = new Set<string>()
  const uploaded: string[] = []
  for (const { task, index } of selected) {
    if (options.stop?.()) break
    const home = homeOf(index)
    await mkdir(home, { recursive: true })
    await reset(dir, index, task)
    await options.beforeTask?.({ home, task })
    const env = (url?: string) => environment({ arm: options.arm, home, dir, bin, registry, url, provider: options.provider, config: options.config })
    if (options.arm !== "off") {
      // The owner's own steps, before the task: Vector reads no repository docs here (so what it knows came from the
      // sessions and the one document added), and keeps the document the owner adds this week.
      if (runs.length === 0) await cli(engine, dir, env(), ["memory", "repo-docs", "off"])
      for (const file of task.upload ?? []) {
        await cli(engine, dir, env(), ["memory", "doc", "add", file, "--wait", "keyword"])
        uploaded.push(file)
      }
      // Vector links documents to code in the background, at most every ten minutes. Weeks pass between these tasks
      // in seconds here, so the harness asks for the same pass before each one.
      if (uploaded.length > 0) await cli(engine, dir, env(), ["memory", "links", "package.json", "--relink"])
    }
    const start = startOf(index).files
    const documents = new Map<string, string>()
    const errors: string[] = []
    const respond = async (body: Record<string, unknown>): Promise<Call> => {
      for (const data of attachments(body))
        if (!documents.has(data)) documents.set(data, await pdfText(Buffer.from(data, "base64")))
      try {
        return (options.decide ?? decide)(task, start, body, { dir, blind: options.arm === "blind", documents })
      } catch (error) {
        errors.push(String(error))
        return { text: `Stopping: ${String(error)}` }
      }
    }
    const server = options.provider ? undefined : serve(respond)
    const started = performance.now()
    // Live: the task's spend, counted from each step's reported tokens at the owner's prices as the run goes, stops it
    // once it reaches what is left under the cap, whatever Vector's own cost figure says.
    const left = options.provider?.rates ? options.provider.remaining?.() : undefined
    const metered: { meter: Meter } = { meter: {} }
    const watch =
      left === undefined
        ? undefined
        : (line: string) => {
            metered.meter = meterLine(metered.meter, line)
            return metered.meter.tokens !== undefined && spend(metered.meter.tokens, options.provider!.rates!) >= left
          }
    const result = await exec(
      process.execPath,
      [
        "run",
        "--conditions=browser",
        engine,
        "run",
        "--format",
        "json",
        "--model",
        options.provider?.model ?? `anthropic/${MODEL}`,
        "--dangerously-skip-permissions",
        ...(options.provider ? ["--max-steps", "40"] : []),
        ...(options.provider?.maxCost?.() !== undefined ? ["--max-cost", String(options.provider.maxCost())] : []),
        task.prompt,
      ],
      dir,
      env(server?.url),
      watch,
    )
    server?.stop()
    const wallMs = performance.now() - started
    if (options.dump) {
      await mkdir(options.dump, { recursive: true })
      await writeFile(join(options.dump, `${options.arm}-${task.id}.json`), JSON.stringify({ requests: server?.requests ?? [], stdout: result.stdout, output: result.output }, null, 1))
    }
    const acceptance = await accept(dir, task)
    const metrics = measure({
      task,
      requests: server?.requests as Recorded[] | undefined,
      stdout: result.stdout,
      dir,
      acceptance,
      earlier,
      ...(options.provider?.rates ? { rates: options.provider.rates } : {}),
    })
    metrics.read.forEach((file) => earlier.add(file))
    const run: TaskRun = {
      ...metrics,
      arm: options.arm,
      title: task.title,
      exitCode: result.exitCode,
      ...(errors.length ? { scriptError: errors.join("; ") } : {}),
      brainFiles: await brainFiles(home),
      recall: server ? firstRecall(server.requests) : [],
      wallMs: Math.round(wallMs),
      ...(result.stopped ? { capped: true } : {}),
    }
    runs.push(run)
    options.onTask?.(run)
  }
  return runs
}

// The model's first request's recall, as lines: what the brain brought to the task before the model did anything.
function firstRecall(requests: readonly Recorded[]) {
  const first = requests.find((request) => Array.isArray(request.body.tools) && request.body.tools.length > 0)
  const messages = Array.isArray(first?.body.messages) ? first.body.messages : []
  const text = JSON.stringify(messages[0] ?? "").replaceAll("\\n", "\n").replaceAll('\\"', '"')
  const block = /<vector_memory_recall>([\s\S]*?)<\/vector_memory_recall>/.exec(text)?.[1] ?? ""
  return block.split("\n").filter((line) => /^- \[|^\[/.test(line.trim()))
}

async function brainFiles(home: string): Promise<string[]> {
  const found = await Array.fromAsync(new Bun.Glob("**/*.db*").scan({ cwd: home, dot: true, onlyFiles: true })).catch(() => [])
  return found.filter((file) => /brain/.test(file)).toSorted()
}

// The repository as this task starts it, the same in every arm: week 0 plus the reference solutions before it, the
// generated route table, and the dependencies installed. Committed on main with a fixed date, so commits match.
async function reset(dir: string, index: number, task: Task) {
  const start = startOf(index)
  for (const entry of await readdir(dir)) if (entry !== ".git") await rm(join(dir, entry), { recursive: true, force: true })
  await materialize(dir, start.files, start.binary)
  // Week 1 starts on Monday 5 October 2026.
  const day = (task.week - 1) * 7 + ["Mon", "Tue", "Wed", "Thu", "Fri"].indexOf(task.day)
  const date = new Date(Date.UTC(2026, 9, 5 + day, 9)).toISOString()
  await git(dir, ["add", "-A"])
  await git(dir, ["commit", "--quiet", "--allow-empty", "-m", `Before ${task.id}`], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
}

/** Writes a repository state into a folder as CI would check it out: files, the generated route table, dependencies. */
export async function materialize(dir: string, files: Readonly<Record<string, string>>, binary: Readonly<Record<string, Uint8Array>> = {}) {
  for (const [path, content] of [...Object.entries(files), ...Object.entries(binary)]) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  await exec(process.execPath, ["script/gen-routes.ts"], dir, { PATH: process.env.PATH ?? "" })
  const dependencies = Object.keys(JSON.parse(files["package.json"]!).dependencies ?? {})
  for (const name of dependencies)
    for (const [file, content] of Object.entries(REGISTRY[name] ?? {})) {
      await mkdir(join(dir, "node_modules", name), { recursive: true })
      await writeFile(join(dir, "node_modules", name, file), content)
    }
}

// The hidden acceptance tests: written after the agent finished, run, and removed, so the agent never sees them.
export async function accept(dir: string, task: Task) {
  const folder = join(dir, ".acceptance")
  await mkdir(folder, { recursive: true })
  const file = join(folder, `${task.id}.test.ts`)
  const report = join(folder, "report.xml")
  await writeFile(
    file,
    [
      ACCEPTANCE_PREAMBLE,
      'test("suite", () => {',
      '  expect(Bun.spawnSync(["bun", "test", "./test"], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0)',
      "})",
      'test("check", () => {',
      '  expect(Bun.spawnSync(["bun", "script/check.ts"], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0)',
      "})",
      task.acceptance,
      "",
    ].join("\n"),
  )
  await exec(process.execPath, ["test", `./.acceptance/${task.id}.test.ts`, "--reporter=junit", `--reporter-outfile=${report}`], dir, {
    PATH: process.env.PATH ?? "",
  })
  const results = junit(await Bun.file(report).text().catch(() => ""))
  await rm(folder, { recursive: true, force: true })
  return results
}

// npm and pnpm as the agent's shell finds them: stand-ins that install from a local folder and never the network.
async function installTools(bin: string, registry: string) {
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, "pm.ts"), PACKAGE_MANAGER)
  for (const tool of ["npm", "pnpm"]) {
    await writeFile(join(bin, tool), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "pm.ts")}" ${tool} "$@"\n`, { mode: 0o755 })
  }
  // Bun itself, under its own name: the package scripts and the agent run `bun test`.
  await symlink(process.execPath, join(bin, "bun"))
  for (const [name, files] of Object.entries(REGISTRY))
    for (const [file, content] of Object.entries(files)) {
      await mkdir(join(registry, name), { recursive: true })
      await writeFile(join(registry, name, file), content)
    }
}

// Where `vector run` finds everything: an isolated home (one per task with the brain off), the fake server or the
// owner's provider, the stand-in package managers first on a PATH without the machine's own npm, and no network
// downloads. PWD is the repository, since `vector run` takes its directory from it.
export function environment(input: {
  arm: Arm
  home: string
  dir: string
  bin: string
  registry: string
  url?: string
  provider?: Provider
  config?: Record<string, unknown>
}) {
  const offline = {
    anthropic: {
      name: "Anthropic",
      id: "anthropic",
      env: [],
      npm: "@ai-sdk/anthropic",
      models: {
        [MODEL]: {
          id: MODEL,
          name: "Claude Sonnet 4.5",
          attachment: true,
          reasoning: true,
          temperature: true,
          tool_call: true,
          release_date: "2025-09-29",
          limit: { context: 200_000, output: 64_000 },
          cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
          options: {},
        },
      },
      options: { apiKey: "bench", baseURL: `${input.url ?? "http://127.0.0.1:9"}/v1` },
    },
  }
  return {
    PATH: [input.bin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    PWD: input.dir,
    HOME: input.home,
    VECTOR_TEST_HOME: input.home,
    XDG_CONFIG_HOME: join(input.home, ".config"),
    XDG_DATA_HOME: join(input.home, ".local/share"),
    XDG_STATE_HOME: join(input.home, ".local/state"),
    XDG_CACHE_HOME: join(input.home, ".cache"),
    // Brain off has no memory tool, so it pays nothing for one: the brain's whole cost is charged to the brain-on arm.
    // A caller's configuration adds to brain off's permission rules and never lifts its memory deny.
    VECTOR_CONFIG_CONTENT: JSON.stringify({
      formatter: false,
      lsp: false,
      provider: input.provider?.config ?? offline,
      ...input.config,
      ...(input.arm === "off" ? { permission: { ...(input.config?.permission as object | undefined), memory: "deny" } } : {}),
    }),
    VECTOR_DISABLE_PROJECT_CONFIG: "1",
    VECTOR_PURE: "1",
    VECTOR_DISABLE_AUTOUPDATE: "1",
    VECTOR_DISABLE_MODELS_FETCH: "1",
    VECTOR_DISABLE_WEBSOCKETS: "1",
    VECTOR_AUTH_CONTENT: "{}",
    VECTOR_BRAIN_EMBED: "off",
    LEDGER_REGISTRY: input.registry,
    TERM: "dumb",
    ...(input.arm === "off" ? { VECTOR_AGENT_DB: ":memory:" } : {}),
  }
}

export async function cli(engine: string, dir: string, env: Record<string, string>, args: string[]) {
  const result = await exec(process.execPath, ["run", "--conditions=browser", engine, ...args], dir, env)
  if (result.exitCode !== 0) throw new Error(`vector ${args.join(" ")} failed (${result.exitCode}): ${result.output.slice(-600)}`)
  return result.output
}

async function git(dir: string, args: string[], env: Record<string, string> = {}) {
  const result = await exec("git", ["-c", "user.name=Ledger", "-c", "user.email=team@ledger.test", ...args], dir, {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1",
    ...env,
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.output}`)
}

// The model reads an attached PDF with pdf.js (unpdf, a dependency of packages/core), not with Vector's own reader.
async function pdfText(bytes: Uint8Array) {
  const { extractText, getDocumentProxy } = await import(Bun.resolveSync("unpdf", join(REPO_ROOT, "packages", "core")))
  const document = await getDocumentProxy(new Uint8Array(bytes))
  const { text } = await extractText(document, { mergePages: true })
  return text
}

// Starts a process with only the given environment, nothing inherited, and gathers its output. `watch` sees each
// stdout line as it arrives and stops the process by returning true.
export function exec(command: string, args: string[], cwd: string, env: Record<string, string>, watch?: (line: string) => boolean) {
  return new Promise<{ exitCode: number; output: string; stdout: string; stopped: boolean }>((done) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    const output: string[] = []
    const stdout: string[] = []
    const state = { pending: "", stopped: false }
    child.stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString("utf8"))
      stdout.push(chunk.toString("utf8"))
      if (!watch || state.stopped) return
      const lines = `${state.pending}${chunk.toString("utf8")}`.split("\n")
      state.pending = lines.pop() ?? ""
      if (!lines.map(watch).includes(true)) return
      state.stopped = true
      child.kill("SIGTERM")
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref()
    })
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")))
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000)
    child.once("close", (code) => {
      clearTimeout(timer)
      done({ exitCode: code ?? 1, output: output.join(""), stdout: stdout.join(""), stopped: state.stopped })
    })
  })
}
