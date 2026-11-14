import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// The Vector everywhere CI lane (.github/workflows/vector-everywhere.yml, spec VE-00). Work packages run single test
// files on the owner's Mac and this lane runs all of them, so these checks hold its shape and run its two scripts, the
// scope rule and the test picker, against temporary repositories. Nothing here reaches the network.

type Step = {
  name?: string
  id?: string
  uses?: string
  run?: string
  if?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
  "working-directory"?: string
}
type Job = {
  "runs-on"?: string
  needs?: string | string[]
  if?: string
  permissions?: unknown
  environment?: unknown
  outputs?: Record<string, string>
  services?: Record<string, { image?: string; ports?: string[] }>
  strategy?: { matrix?: { include?: Array<Record<string, string>> } }
  steps?: Step[]
}
type Workflow = {
  on: Record<string, unknown>
  permissions?: Record<string, string>
  defaults?: { run?: { shell?: string } }
  jobs: Record<string, Job>
}

const root = path.join(import.meta.dir, "../../..")
const LANE = ".github/workflows/vector-everywhere.yml"
const read = (file: string) => Bun.file(path.join(root, file)).text()
const text = await read(LANE)
const lane = Bun.YAML.parse(text) as Workflow
const step = (job: string, name: string) => lane.jobs[job]?.steps?.find((entry) => entry.name === name)
const paths = (lane.on.pull_request as { paths: string[] }).paths
const matches = (file: string) => paths.some((pattern) => new Bun.Glob(pattern).match(file))

/** The files outside api/_lib/everywhere and api/everywhere that the everywhere server code imports by relative path. */
const serverImports = await (async () => {
  const found = new Set<string>()
  for (const dir of ["api/_lib/everywhere", "api/everywhere"])
    for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: path.join(root, dir) })) {
      const source = await read(path.posix.join(dir, file))
      for (const match of source.matchAll(/from\s+"(\.\.?\/[^"]+)"/g)) {
        const target = path.posix.normalize(path.posix.join(dir, path.posix.dirname(file), match[1]!))
        if (!target.startsWith("api/_lib/everywhere/") && !target.startsWith("api/everywhere/"))
          found.add(target.replace(/\.js$/, ".ts"))
      }
    }
  return [...found].sort()
})()

const SCOPE = step("scope", "Decide whether this run concerns Vector everywhere")?.run ?? ""
const PICKER = step("tests", "Run every Vector everywhere test file")?.run ?? ""

// Git in the temporary repositories reads none of the developer's or the runner's configuration (no signing, no hooks).
const gitEnv = { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "user.name=Vector", "-c", "user.email=bot@vectordev.ai", ...args], {
    cwd,
    env: gitEnv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`)
  return result.stdout.toString().trim()
}

async function repository(files: Record<string, string>) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "everywhere-lane-")))
  git(directory, "init", "-q", "-b", "main")
  await commit(directory, files)
  return directory
}

async function commit(directory: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
    await writeFile(path.join(directory, file), content)
  }
  git(directory, "add", "-A")
  git(directory, "commit", "-q", "--no-verify", "-m", "fixture")
  return git(directory, "rev-parse", "HEAD")
}

// GitHub runs a step's script as `bash --noprofile --norc -eo pipefail {0}`, with GITHUB_OUTPUT a regular file.
async function runStep(script: string, cwd: string, env: Record<string, string>) {
  const directory = await mkdtemp(path.join(tmpdir(), "everywhere-lane-step-"))
  const file = path.join(directory, "step.sh")
  const output = path.join(directory, "output")
  await writeFile(file, script)
  await writeFile(output, "")
  try {
    const child = Bun.spawn(["bash", "--noprofile", "--norc", "-eo", "pipefail", file], {
      cwd,
      env: { ...gitEnv, GITHUB_OUTPUT: output, ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { status, stdout, stderr, output: await readFile(output, "utf8") }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

// A stand-in for bun that records where and how the picker started it. It drains its input, so a picker that let a
// test read the rest of its file list would lose files.
async function fakeBun() {
  const directory = await mkdtemp(path.join(tmpdir(), "everywhere-lane-bin-"))
  const log = path.join(directory, "runs.log")
  await writeFile(
    path.join(directory, "bun"),
    [
      "#!/bin/sh",
      "cat >/dev/null",
      `printf '%s|%s\\n' "$(pwd -P)" "$*" >> '${log}'`,
      'if [ -n "${EVERYWHERE_LANE_FAIL:-}" ]; then case "$*" in *"$EVERYWHERE_LANE_FAIL"*) exit 1 ;; esac; fi',
      "exit 0",
      "",
    ].join("\n"),
  )
  await chmod(path.join(directory, "bun"), 0o755)
  return {
    path: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
    runs: async (base: string) =>
      (existsSync(log) ? await readFile(log, "utf8") : "")
        .split("\n")
        .filter(Boolean)
        .map((line) => (line.startsWith(`${base}/`) ? line.slice(base.length + 1) : line)),
    [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }),
  }
}

describe("the lane's shape", () => {
  test("it runs on the branch, on pull requests that touch its paths, on pushes to main and by hand", () => {
    expect(Object.keys(lane.on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"])
    // Pushes to main are filtered by the scope job, so the push trigger itself carries no path filter.
    expect(lane.on.push).toEqual({ branches: ["vector-everywhere", "main"] })
    expect(Object.keys(lane.on.pull_request as object)).toEqual(["paths"])
    expect(text).not.toContain("pull_request_target")
  })

  test("it is read-only, holds no secrets and names no environment", () => {
    expect(lane.permissions).toEqual({ contents: "read" })
    for (const needle of ["secrets.", "GH_TOKEN", "github.token", "GITHUB_TOKEN"]) expect(text).not.toContain(needle)
    for (const [name, job] of Object.entries(lane.jobs))
      expect({ job: name, permissions: job.permissions ?? null, environment: job.environment ?? null }).toEqual({
        job: name,
        permissions: null,
        environment: null,
      })
  })

  test("every job runs on a named Ubuntu and every action is pinned to a commit", async () => {
    expect(text).not.toMatch(/-latest\b/)
    for (const [name, job] of Object.entries(lane.jobs))
      expect({ job: name, runner: job["runs-on"] }).toEqual({ job: name, runner: "ubuntu-24.04" })
    const actions = text
      .split("\n")
      .map((line) => line.match(/^\s*(?:-\s+)?uses:\s*([^\s#]+)/)?.[1])
      .filter((value): value is string => typeof value === "string")
    expect(actions.length).toBeGreaterThan(0)
    expect(actions.filter((action) => !action.startsWith("./") && !/@[a-f0-9]{40}$/.test(action))).toEqual([])
    // The scope job sets up Bun alone with the same pinned action the repository's setup-bun uses.
    const composite = await read(".github/actions/setup-bun/action.yml")
    const pinned = composite.match(/uses:\s*(oven-sh\/setup-bun@[a-f0-9]{40})/)?.[1]
    expect(pinned).toBeDefined()
    expect(lane.jobs.scope?.steps?.find((entry) => entry.uses?.startsWith("oven-sh/setup-bun@"))?.uses).toBe(pinned)
    // Both scripts are bash: arrays, $'\n' and the -o pipefail GitHub adds for an explicit bash shell.
    expect(lane.defaults?.run?.shell).toBe("bash")
  })

  test("every other job waits for the scope job's answer", () => {
    expect(lane.jobs.scope?.outputs).toEqual({ run: "${{ steps.scope.outputs.run }}" })
    expect(step("scope", "Decide whether this run concerns Vector everywhere")?.id).toBe("scope")
    const others = Object.entries(lane.jobs).filter(([name]) => name !== "scope")
    expect(others.map(([name]) => name).sort()).toEqual(["tests", "typecheck"])
    for (const [name, job] of others)
      expect({ job: name, needs: job.needs, if: job.if }).toEqual({
        job: name,
        needs: "scope",
        if: "needs.scope.outputs.run == 'true'",
      })
    // The scope compares the pushed commits, so it needs main's history.
    const checkout = lane.jobs.scope?.steps?.find((entry) => entry.uses?.startsWith("actions/checkout@"))
    expect(checkout?.with?.["fetch-depth"]).toBe(0)
  })

  test("it typechecks the hosted API and every package the build touches", async () => {
    const include = lane.jobs.typecheck?.strategy?.matrix?.include ?? []
    expect(include.map((entry) => entry.name)).toEqual(["api", "schema", "core", "engine", "desktop", "web", "app"])
    // api/ is checked against the root tsconfig.json, which includes only api/**.
    expect(include[0]).toEqual({
      name: "api",
      directory: "packages/engine",
      command: "bun typecheck --project ../../tsconfig.json",
    })
    for (const entry of include.slice(1)) {
      expect(entry).toEqual({ name: entry.name!, directory: `packages/${entry.name}`, command: "bun typecheck" })
      const manifest = (await Bun.file(path.join(root, `packages/${entry.name}/package.json`)).json()) as {
        scripts?: Record<string, string>
      }
      expect({ package: entry.name, typecheck: typeof manifest.scripts?.typecheck }).toEqual({
        package: entry.name!,
        typecheck: "string",
      })
    }
    const run = lane.jobs.typecheck?.steps?.find((entry) => entry.run === "${{ matrix.command }}")
    expect(run?.["working-directory"]).toBe("${{ matrix.directory }}")
  })

  test("the store tests get a real Redis pinned by digest, the image the sharing integration uses", async () => {
    const sharing = Bun.YAML.parse(await read(".github/workflows/vector-sharing.yml")) as Workflow
    const image = lane.jobs.tests?.services?.valkey?.image
    expect(image).toMatch(/@sha256:[a-f0-9]{64}$/)
    expect(image).toBe(sharing.jobs.integration?.services?.valkey?.image)
    expect(lane.jobs.tests?.services?.valkey?.ports).toEqual(["6379:6379"])
    expect(step("tests", "Run every Vector everywhere test file")?.env?.VECTOR_TEST_REDIS_URL).toBe(
      "redis://127.0.0.1:6379",
    )
  })

  test("it checks the repository's workflow rules on the branch too", () => {
    expect(step("tests", "Check the repository's workflow rules")).toMatchObject({
      if: "${{ !cancelled() }}",
      "working-directory": "packages/cloud",
      run: "bun test --timeout 30000 src/workflow-compliance.test.ts",
    })
    expect(existsSync(path.join(root, "packages/cloud/src/workflow-compliance.test.ts"))).toBe(true)
  })

  test("the paths cover every everywhere zone and the main helpers that code imports", () => {
    // The scope job matches pushes to main with Bun's globs and GitHub filters pull requests with its own, so the
    // patterns use only * and **, which mean the same to both.
    expect(paths.filter((pattern) => /[{}?+![\]]/.test(pattern))).toEqual([])
    expect(new Set(paths).size).toBe(paths.length)
    const zones = [
      "api/_lib/everywhere/store.ts",
      "api/_lib/everywhere/slack/adapter.ts",
      "api/everywhere/jobs/claim.ts",
      "api/everywhere/jobs/[jid]/body.ts",
      "api/slack/events.ts",
      "api/linear/webhook.ts",
      "api/jira/a2a.ts",
      "packages/schema/src/everywhere.ts",
      "packages/schema/src/everywhere-policy.ts",
      "packages/core/src/everywhere/frame.ts",
      "packages/core/src/v1/config/everywhere.ts",
      "packages/desktop/src/main/everywhere-runner.ts",
      "packages/desktop/src/main/everywhere-runner.test.ts",
      "packages/app/src/components/settings-v2/everywhere.tsx",
      "packages/app/src/components/settings-v2/everywhere-model.ts",
      "packages/app/src/components/settings-v2/everywhere-model.test.ts",
      "packages/web/src/pages/everywhere.astro",
      "packages/web/src/pages/everywhere/link.astro",
      "packages/web/src/pages/docs/everywhere.astro",
      "packages/web/src/components/everywhere/Installs.tsx",
      "packages/web/src/components/marketing/everywhere/SignIn.tsx",
      "integrations/slack/manifest.json",
      "integrations/jira-forge/manifest.yml",
      "packages/web/test/everywhere-router.test.ts",
      "packages/web/test/everywhere-lane.test.ts",
      "packages/web/test/lib/everywhere-fetch-guard.ts",
      "packages/schema/test/everywhere-policy.test.ts",
      "packages/core/test/everywhere/frame.test.ts",
      "packages/engine/test/everywhere/unattended-session.test.ts",
      "docs/vector/build/vector-everywhere-spec.md",
      "docs/vector/build/vector-everywhere-deviations.md",
      "docs/vector/owner-actions/vector-everywhere-slack.md",
      LANE,
    ]
    expect(zones.filter((file) => !matches(file))).toEqual([])
    const helpers = [
      "api/_lib/http.ts",
      "api/_lib/abuse.ts",
      "api/_lib/persistent-store.ts",
      "api/_lib/account.ts",
      "api/_lib/cli-token.ts",
      "api/_lib/revocation.ts",
      "api/_lib/codium-switches.ts",
      "packages/desktop/src/main/github-auth.ts",
      "packages/desktop/src/main/github-api.ts",
    ]
    expect(helpers.filter((file) => !matches(file))).toEqual([])
    // A helper that moves on main would silently stop starting the lane.
    expect(helpers.filter((file) => !existsSync(path.join(root, file)))).toEqual([])
    // Worked out from the code too: every file outside the everywhere zones that the server code imports.
    expect(serverImports.length).toBeGreaterThan(0)
    expect(serverImports.filter((file) => !matches(file))).toEqual([])
    expect(serverImports.filter((file) => !existsSync(path.join(root, file)))).toEqual([])
    const unrelated = [
      "README.md",
      "api/_lib/usage.ts",
      "api/_lib/codium-entitlements.ts",
      "packages/engine/src/session/prompt.ts",
      "packages/web/test/teams-api.test.ts",
      "packages/desktop/src/main/github-pr.ts",
      "packages/web/src/pages/workspaces.astro",
      "docs/vector/build/codium-build-spec.md",
      ".github/workflows/test.yml",
    ]
    expect(unrelated.filter(matches)).toEqual([])
  })
})

describe("the scope job", () => {
  test("runs the lane on the branch, pull requests and manual runs, and on pushes to main that touch its paths", async () => {
    const directory = await repository({ [LANE]: text, "README.md": "one\n" })
    try {
      const a = git(directory, "rev-parse", "HEAD")
      const b = await commit(directory, { "README.md": "two\n" })
      const c = await commit(directory, { "api/_lib/everywhere/store.ts": "export {}\n" })
      const d = await commit(directory, { "api/_lib/http.ts": "export {}\n" })
      const e = await commit(directory, { "packages/web/test/teams-api.test.ts": "export {}\n" })
      const bun = path.dirname(process.execPath)
      const scope = async (EVENT: string, REF: string, BEFORE: string, AFTER: string) => {
        const result = await runStep(SCOPE, directory, {
          PATH: `${bun}${path.delimiter}${gitEnv.PATH}`,
          EVENT,
          REF,
          BEFORE,
          AFTER,
        })
        expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" })
        return result.output.trim()
      }
      expect(SCOPE).not.toBe("")
      // The branch always runs, even for a change outside the paths.
      expect(await scope("push", "refs/heads/vector-everywhere", a, b)).toBe("run=true")
      // GitHub has already filtered pull requests by path; manual runs always run.
      expect(await scope("pull_request", "refs/pull/7/merge", "", e)).toBe("run=true")
      expect(await scope("workflow_dispatch", "refs/heads/main", "", e)).toBe("run=true")
      // Pushes to main run only when a changed file matches the pull_request paths.
      expect(await scope("push", "refs/heads/main", a, b)).toBe("run=false")
      expect(await scope("push", "refs/heads/main", d, e)).toBe("run=false")
      expect(await scope("push", "refs/heads/main", b, c)).toBe("run=true")
      expect(await scope("push", "refs/heads/main", c, d)).toBe("run=true")
      expect(await scope("push", "refs/heads/main", a, e)).toBe("run=true")
      // A change that cannot be listed (a new ref, or a history GitHub no longer has) runs the lane.
      expect(await scope("push", "refs/heads/main", "0".repeat(40), b)).toBe("run=true")
      expect(await scope("push", "refs/heads/main", "1234567890abcdef1234567890abcdef12345678", b)).toBe("run=true")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("the test picker", () => {
  const PACKAGES = ["web", "schema", "core", "engine", "desktop", "app"]
  const manifests = Object.fromEntries(PACKAGES.map((name) => [`packages/${name}/package.json`, "{}\n"]))

  test("runs every everywhere test file, one Bun process each, from the package that owns it", async () => {
    await using bun = await fakeBun()
    const directory = await repository({
      ...manifests,
      "packages/engine/bunfig.toml": "",
      "packages/web/test/everywhere-router.test.ts": "",
      "packages/web/test/teams-api.test.ts": "",
      "packages/web/test/works-everywhere.test.ts": "",
      "packages/web/test/lib/everywhere-fetch-guard.ts": "",
      "packages/web/test/fixture/everywhere-fakes.test.ts": "",
      "packages/web/e2e/everywhere/journey.test.ts": "",
      "packages/schema/test/everywhere.test.ts": "",
      "packages/core/test/everywhere/frame.test.ts": "",
      "packages/engine/test/everywhere/unattended-session.test.ts": "",
      "packages/desktop/src/main/everywhere-runner.test.ts": "",
      "packages/desktop/src/main/github-pr.test.ts": "",
      "packages/app/src/components/settings-v2/everywhere-model.test.ts": "",
      "packages/app/test-browser/everywhere-page.test.tsx": "",
      "docs/everywhere.test.ts": "",
    })
    try {
      // Only tracked files count.
      await writeFile(path.join(directory, "packages/web/test/everywhere-untracked.test.ts"), "")
      const result = await runStep(PICKER, directory, { PATH: bun.path })
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" })
      expect(await bun.runs(directory)).toEqual([
        "packages/app|test --timeout 30000 --isolate ./src/components/settings-v2/everywhere-model.test.ts",
        "packages/app|test --timeout 30000 --isolate --conditions=browser ./test-browser/everywhere-page.test.tsx",
        "packages/core|test --timeout 30000 ./test/everywhere/frame.test.ts",
        "packages/desktop|--no-env-file test --timeout 30000 ./src/main/everywhere-runner.test.ts",
        "packages/engine|test --timeout 30000 ./test/everywhere/unattended-session.test.ts",
        "packages/schema|test --timeout 30000 ./test/everywhere.test.ts",
        "packages/web|test --timeout 30000 ./test/everywhere-router.test.ts",
      ])
      expect(result.stdout).toContain("Vector everywhere: 7/7 test files passed")
      expect(result.stdout).toContain("::group::packages/core/test/everywhere/frame.test.ts")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("a failing file fails the step after every other file has run", async () => {
    await using bun = await fakeBun()
    const directory = await repository({
      ...manifests,
      "packages/core/test/everywhere/frame.test.ts": "",
      "packages/core/test/everywhere/publish.test.ts": "",
      "packages/web/test/everywhere-config.test.ts": "",
    })
    try {
      const result = await runStep(PICKER, directory, { PATH: bun.path, EVERYWHERE_LANE_FAIL: "frame.test.ts" })
      expect(result.status).toBe(1)
      expect(await bun.runs(directory)).toHaveLength(3)
      expect(result.stdout).toContain("Vector everywhere: 2/3 test files passed")
      expect(result.stdout).toContain(
        "::error title=Vector everywhere test failed::packages/core/test/everywhere/frame.test.ts",
      )
      expect(result.stderr).toBe("Failed test files:\npackages/core/test/everywhere/frame.test.ts\n")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("a tree with no everywhere test file fails rather than passing empty", async () => {
    await using bun = await fakeBun()
    const directory = await repository({ ...manifests, "packages/web/test/teams-api.test.ts": "" })
    try {
      const result = await runStep(PICKER, directory, { PATH: bun.path })
      expect(result.status).not.toBe(0)
      expect(result.stdout).toContain("No everywhere test files found")
      expect(await bun.runs(directory)).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("in this checkout it finds the lane's own test and gives every file a package", async () => {
    await using bun = await fakeBun()
    const checkout = await realpath(root)
    const result = await runStep(PICKER, checkout, { PATH: bun.path })
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" })
    const runs = await bun.runs(checkout)
    expect(runs).toContain("packages/web|test --timeout 30000 ./test/everywhere-lane.test.ts")
    for (const run of runs) expect(run).toMatch(/^(?:test|packages\/[^/|]+)\|/)
  })
})
