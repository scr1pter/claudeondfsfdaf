import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { browserCommand, owningDirectory, selectBrowserSpecs, selectUnitTests, unitCommand } from "./codium-ci-tests"

const root = new URL("../../..", import.meta.url).pathname
const read = (path: string) => Bun.file(`${root}/${path}`).text()

describe("release workflow supply-chain policy", () => {
  for (const [file, guard] of [
    ["vector-cli-release.yml", "validate"],
    ["vector-desktop-release.yml", "prepare"],
  ] as const) {
    test(`${file} rejects unprotected environments before any environment-bound job`, async () => {
      const workflow = Bun.YAML.parse(await read(`.github/workflows/${file}`)) as {
        jobs: Record<
          string,
          {
            environment?: string
            permissions?: Record<string, string>
            needs?: string | string[]
            steps?: Array<{ name: string; run?: string }>
          }
        >
      }
      const preflight = workflow.jobs[guard]
      expect(preflight?.environment).toBeUndefined()
      expect(preflight?.permissions).toEqual({ contents: "read", actions: "read" })
      const ancestors = (name: string): string[] => {
        const needs = workflow.jobs[name]?.needs
        return [needs]
          .flat()
          .filter((value): value is string => typeof value === "string")
          .flatMap((value) => [value, ...ancestors(value)])
      }
      for (const [name, job] of Object.entries(workflow.jobs)) {
        if (job.environment === "production-release") expect(ancestors(name)).toContain(guard)
      }
      const script = preflight?.steps?.find((step) => step.name === "Require protected release environment")?.run
      expect(script).toBeDefined()
      // Run the actual workflow shell; only the remote GitHub response is substituted.
      for (const response of ["1", "2", "0", "", "invalid", "missing", "forbidden"]) {
        const command = `gh() {
          test "$1" = api && test "$2" = repos/fixture/repo/environments/production-release || return 99
          case "$FIXTURE_RESPONSE" in missing|forbidden) return 1;; esac
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
  }

  test("CLI publication requires protected-main ancestry and production approval", async () => {
    const workflow = await read(".github/workflows/vector-cli-release.yml")
    expect(workflow.match(/environment: production-release/g)?.length).toBeGreaterThanOrEqual(2)
    expect(workflow.match(/git merge-base --is-ancestor "\$VECTOR_SOURCE_REVISION" origin\/main/g)?.length).toBe(2)
    expect(workflow).toContain("fetch-depth: 0")
    expect(workflow).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02")
  })

  test("desktop publication consumes immutable workflow artifacts rather than draft assets", async () => {
    const workflow = await read(".github/workflows/vector-desktop-release.yml")
    expect(workflow).toContain("environment: production-release")
    expect(workflow).toContain('git merge-base --is-ancestor "$source_commit" origin/main')
    expect(workflow).not.toContain("gh release download")
    expect(workflow.match(/id: platform-artifact/g)).toHaveLength(3)
    expect(workflow.match(/artifact_digest:/g)).toHaveLength(3)
    expect(
      workflow.match(/actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/g)?.length,
    ).toBeGreaterThanOrEqual(4)
  })

  test("the desktop release publishes no GitHub release and writes nothing to the repository", async () => {
    // Downloads and updates come from Vector's own download store; a GitHub release on the source repository was a second,
    // public copy of every installer, and its draft edit was refused with HTTP 403 in the 1.99.111 run.
    const text = await read(".github/workflows/vector-desktop-release.yml")
    const workflow = Bun.YAML.parse(text) as {
      permissions?: Record<string, string>
      jobs: Record<string, { permissions?: Record<string, string>; steps?: Array<{ run?: string }> }>
    }
    const writesRelease = /gh release (upload|create|edit|delete)/
    expect(writesRelease.test(text)).toBe(false)
    expect(Object.keys(workflow.jobs)).not.toContain("draft")
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect({ job: name, contents: (job.permissions ?? workflow.permissions)?.contents }).not.toEqual({
        job: name,
        contents: "write",
      })
      for (const run of (job.steps ?? []).flatMap((step) => (step.run ? [step.run] : []))) {
        for (const script of run.match(/\bpackages\/[\w./-]+\.ts\b/g) ?? []) {
          expect({ job: name, script, writes: writesRelease.test(await read(script)) }).toEqual({
            job: name,
            script,
            writes: false,
          })
        }
      }
    }
  })

  test("release actions and runner images are commit/version pinned", async () => {
    for (const path of [
      ".github/workflows/vector-cli-release.yml",
      ".github/workflows/vector-codium.yml",
      ".github/workflows/vector-codium-e2e.yml",
      ".github/workflows/vector-container-release.yml",
      ".github/workflows/vector-desktop-release.yml",
      ".github/workflows/vector-site-smoke.yml",
      ".github/workflows/vector-standalone-installers.yml",
      ".github/workflows/verify.yml",
    ]) {
      const workflow = await read(path)
      expect(workflow).not.toMatch(/runs-on: (?:ubuntu|macos|windows)-latest/)
      const actions = workflow
        .split("\n")
        .map((line) => line.match(/^\s*uses:\s*([^\s#]+)/)?.[1])
        .filter((value): value is string => typeof value === "string" && !value.startsWith("./"))
      expect(actions.filter((action) => !/@[a-f0-9]{40}$/.test(action))).toEqual([])
    }
  })

  test("desktop publishing selects an exact Vercel CLI version", async () => {
    const source = await read("packages/desktop/src/main/publish.ts")
    expect(source).toMatch(/VERCEL_CLI_VERSION = "\d+\.\d+\.\d+"/)
    expect(source).toContain("vercel@${VERCEL_CLI_VERSION}")
    expect(source).not.toContain('"vercel@latest"')
    expect(await Bun.file(`${root}/script/deploy-cloud.sh`).exists()).toBe(false)
  })
})

// The @vector build's CI lane (vector-at-mention-spec V00). test.yml and typecheck.yml run only on main and on pull
// requests, so this lane is the only CI the build branch's pushes get, and each work package cites its result.
describe("@vector CI lane", () => {
  type Step = {
    id?: string
    if?: string
    shell?: string
    "continue-on-error"?: boolean
    uses?: string
    run?: string
    env?: Record<string, string>
    with?: Record<string, unknown>
    "working-directory"?: string
  }
  type Job = {
    "runs-on"?: string
    strategy?: { matrix?: { include?: Array<{ mode: string; scenario: string }> } }
    environment?: unknown
    permissions?: unknown
    services?: Record<string, { image?: string; ports?: unknown[] }>
    steps?: Step[]
  }
  type Workflow = {
    on: Record<string, unknown>
    concurrency?: { group?: string }
    permissions?: unknown
    jobs: Record<string, Job>
  }
  const lane = async () => Bun.YAML.parse(await read(".github/workflows/vector-at-mention.yml")) as Workflow
  const steps = (workflow: Workflow) =>
    Object.entries(workflow.jobs).flatMap(([job, entry]) => (entry.steps ?? []).map((step) => ({ job, step })))

  test("the lane runs on every push to its branch with read-only access and no secrets", async () => {
    const workflow = await lane()
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"])
    // A path filter or an ignore list here would leave a package's commit with no CI at all.
    expect(workflow.on.push).toEqual({ branches: ["vector-at-mention"] })
    // No other workflow runs the web GitHub tests, so every hosted API module they load (http, abuse, persistent-store
    // as well as github-*), the lockfile that pins jose and the Bun version in package.json start the lane on a pull
    // request. api/** takes in the contract's four api/ entries.
    expect((workflow.on.pull_request as { paths?: string[] }).paths).toEqual(
      expect.arrayContaining([
        "api/**",
        "bun.lock",
        "package.json",
        "packages/core/src/review/**",
        "packages/core/src/github-agents.ts",
        "packages/engine/src/cli/cmd/github*.ts",
        // The engine files the agent phase's own-key seam, its pinned policy and its posting check live in, and the
        // research runtime its tests run on (V18b).
        "packages/engine/src/provider/provider.ts",
        "packages/engine/src/session/llm/request.ts",
        "packages/engine/src/session/posting.ts",
        "packages/engine/test/lib/research.ts",
        // The session retry module, where a Codium run's 2.9.2 gateway rule is pinned, and its test (V18c).
        "packages/engine/src/session/retry.ts",
        "packages/engine/test/session/retry.test.ts",
        "packages/desktop/src/main/github-*.ts",
        ".github/workflows/vector-at-mention.yml",
      ]),
    )
    // GitHub keeps one pending run per concurrency group and drops it when a newer one queues, so a group shared by
    // pushes would lose the result of a commit pushed while another run was still going.
    expect(workflow.concurrency?.group).toContain("github.run_id")
    expect(workflow.permissions).toEqual({ contents: "read" })
    // Expressions reach a context by index and whole as well as by property (secrets['X'], toJSON(secrets),
    // github['token'], toJSON(github)), so the check names the context, not one access form, and ignores case. It reads
    // every key and value of the parsed workflow, which leaves comments free to say what the lane does not hold.
    const strings = (value: unknown): string[] =>
      typeof value === "string"
        ? [value]
        : typeof value === "object" && value !== null
          ? Object.entries(value).flatMap(([key, entry]) => [key, ...strings(entry)])
          : []
    expect(
      strings(workflow).filter((value) =>
        /\bsecrets\b|\bgithub\s*(?:\.\s*token\b|\[)|\btoJSON\s*\(\s*github\s*\)/i.test(value),
      ),
    ).toEqual([])
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect({ job: name, environment: job.environment ?? null, permissions: job.permissions ?? null }).toEqual({
        job: name,
        environment: null,
        permissions: null,
      })
    }
    const checkouts = steps(workflow).filter((entry) => entry.step.uses?.startsWith("actions/checkout@"))
    expect(checkouts.map((entry) => entry.job).sort()).toEqual(Object.keys(workflow.jobs).sort())
    for (const entry of checkouts) {
      expect({ job: entry.job, persist: entry.step.with?.["persist-credentials"] }).toEqual({
        job: entry.job,
        persist: false,
      })
    }
    const unpinned = steps(workflow).flatMap((entry) =>
      entry.step.uses && !entry.step.uses.startsWith("./") && !/@[a-f0-9]{40}$/.test(entry.step.uses)
        ? [{ job: entry.job, uses: entry.step.uses }]
        : [],
    )
    expect(unpinned).toEqual([])
  })

  test("Valkey is pinned by the free-models integration's digest", async () => {
    const workflow = await lane()
    const free = Bun.YAML.parse(await read(".github/workflows/vector-free-models.yml")) as Workflow
    const image = workflow.jobs.api?.services?.valkey?.image
    expect(image).toMatch(/@sha256:[a-f0-9]{64}$/)
    expect(image).toBe(free.jobs.integration?.services?.valkey?.image)
  })

  test("the lane keeps every check the contract names", async () => {
    const workflow = await lane()
    const commands = steps(workflow).flatMap((entry) =>
      entry.step.run ? [{ directory: entry.step["working-directory"] ?? ".", words: entry.step.run.split(/\s+/) }] : [],
    )
    const missing = (
      [
        ["packages/engine", "../../tsconfig.json"],
        ["packages/web", "test/github-oidc.test.ts"],
        ["packages/web", "test/github-app.test.ts"],
        ["packages/web", "test/github-app-api.test.ts"],
        ["packages/web", "test/cloud-agents-*.test.ts"],
        ["packages/engine", "test/cli/github*.test.ts"],
        ["packages/engine", "test/tool/registry*.test.ts"],
        ["packages/engine", "test/session/retry.test.ts"],
        ["packages/core", "test/github-agents.test.ts"],
        ["packages/core", "test/review/*.test.ts"],
        ["packages/core", "test/child-environment.test.ts"],
        ["packages/core", "test/free-model-route.test.ts"],
        ["packages/core", "test/public-session-share.test.ts"],
        ["test", "api-module-loading.test.ts"],
        ["test", "cli-token.test.ts"],
        ["packages/engine", "script/build-node.ts"],
        ["packages/engine", "script/smoke-node-bundle.ts"],
      ] as const
    ).filter(([directory, word]) =>
      commands.every((command) => command.directory !== directory || !command.words.includes(word)),
    )
    expect(missing).toEqual([])
  })

  // bun test exits 1 when no filter matches a file, but silently drops a filter that matches nothing while another one
  // matches, and bash passes an unmatched glob on literally. A mistyped or not-yet-created file would then leave a
  // green step that never ran it, so every pattern a test step names must match a file in its working directory.
  test("every test step runs named files that exist, outside Actions mode", async () => {
    const workflow = await lane()
    const runs = steps(workflow).flatMap((entry) =>
      entry.step.run && /\bbun (?:--no-env-file )?test\b/.test(entry.step.run)
        ? [
            {
              job: entry.job,
              run: entry.step.run,
              directory: entry.step["working-directory"] ?? ".",
              patterns: entry.step.run.split(/\s+/).filter((word) => /\.test\.tsx?$/.test(word)),
            },
          ]
        : [],
    )
    expect(runs.length).toBeGreaterThan(0)
    // Several packages switch behaviour when GITHUB_ACTIONS=true, and a test step that names no file runs a whole suite.
    expect(
      runs.map((entry) => ({
        job: entry.job,
        outside: entry.run.startsWith("GITHUB_ACTIONS=false "),
        named: entry.patterns.length > 0,
      })),
    ).toEqual(runs.map((entry) => ({ job: entry.job, outside: true, named: true })))
    const unmatched = runs.flatMap((entry) =>
      entry.patterns.flatMap((pattern) =>
        new Bun.Glob(pattern).scanSync({ cwd: `${root}/${entry.directory}` }).next().done
          ? [{ job: entry.job, directory: entry.directory, pattern }]
          : [],
      ),
    )
    expect(unmatched).toEqual([])
  })

  // Without VECTOR_TEST_REDIS_URL, github-app-api.test.ts registers one skipped test and the step still passes.
  test("the GitHub API tests run against the lane's Valkey", async () => {
    const workflow = await lane()
    const api = workflow.jobs.api
    const step = api?.steps?.find((entry) => entry.run?.split(/\s+/).includes("test/github-app-api.test.ts"))
    expect(step?.["working-directory"]).toBe("packages/web")
    expect(step?.env?.VECTOR_TEST_REDIS_URL).toBe("redis://127.0.0.1:6379")
    expect(api?.services?.valkey?.ports).toEqual(["6379:6379"])
  })

  test("the hosted sandbox probe covers both credential domains and refuses upload after cleanup failure", async () => {
    const job = (await lane()).jobs["sandbox-probe"]
    expect(job?.["runs-on"]).toBe("ubuntu-24.04")
    expect(job?.strategy?.matrix?.include).toEqual([
      { mode: "codium", scenario: "success" },
      { mode: "own-key", scenario: "success" },
      { mode: "codium", scenario: "bundle-refusal" },
      { mode: "codium", scenario: "cancelled" },
      { mode: "codium", scenario: "seal-refusal" },
    ])
    const steps = job?.steps ?? []
    expect(steps.some((step) => step.uses?.startsWith("./"))).toBe(false)
    expect(steps.some((step) => step.uses === "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6")).toBe(true)
    const agent = steps.findIndex((step) => step.id === "agent")
    const finish = steps.findIndex((step) => step.id === "sandbox_finish")
    const boundary = steps.findIndex((step) => step.id === "artifact_boundary")
    expect(agent).toBeGreaterThan(steps.findIndex((step) => step.run === "vector github sandbox prepare"))
    expect(steps[agent]?.shell).toBe(
      "env -u ACTIONS_ID_TOKEN_REQUEST_URL -u ACTIONS_ID_TOKEN_REQUEST_TOKEN bash --noprofile --norc -eo pipefail {0}",
    )
    expect(finish).toBeGreaterThan(agent)
    expect(steps[finish]).toMatchObject({
      if: "always()",
      run: "vector github sandbox finish",
      "continue-on-error": true,
    })
    expect(boundary).toBeGreaterThan(finish)
    expect(steps[boundary]?.if).toBe(
      "always() && steps.agent.outcome != 'skipped' && steps.sandbox_finish.outcome == 'success'",
    )
    expect(steps.at(-1)).toMatchObject({
      if: "always()",
      run: "node /opt/vector-sandbox-probe.mjs --assert",
      "working-directory": "${{ runner.temp }}",
    })
  })
})

// GitHub moves ubuntu-latest to new Ubuntu releases before tools such as Playwright support them, so a check that
// passed yesterday fails while installing. Vector's own workflows name the Ubuntu they were checked on.
test("Vector's workflows pin their Ubuntu runner", async () => {
  const files = [...new Bun.Glob("*.yml").scanSync(`${root}/.github/workflows`)]
  expect(files.length).toBeGreaterThan(0)
  const floating = (
    await Promise.all(
      files.map(async (file) => ((await read(`.github/workflows/${file}`)).includes("ubuntu-latest") ? [file] : [])),
    )
  ).flat()
  expect(floating).toEqual([])
})

// The release's package tests run on the Node the test workflow and Electron 42 use: the desktop guard smoke calls
// http.setGlobalProxyFromEnv, which the runner image's older Node lacks.
test("the release's package tests set up Node 24 before they run", async () => {
  const workflow = Bun.YAML.parse(await read(".github/workflows/vector-desktop-release.yml")) as {
    jobs: { test: { steps: Array<{ name?: string; uses?: string; if?: string; with?: { "node-version"?: string } }> } }
  }
  const steps = workflow.jobs.test.steps
  const node = steps.findIndex((step) => step.uses?.startsWith("actions/setup-node@"))
  expect(node).toBeGreaterThanOrEqual(0)
  expect(steps[node]).toMatchObject({ with: { "node-version": "24" } })
  expect(steps[node]?.if).toBeUndefined()
  expect(node).toBeLessThan(steps.findIndex((step) => step.name === "Run package tests"))
})

// The engine suite runs whole on Linux: 22 minutes in the test workflow and past 30 four tests at a time in the
// release on 24 October 2026. Its limits leave it room to finish, so a cut-off run is a hang, not a slow day.
test("the engine suite has room to finish in the test and release workflows", async () => {
  const release = Bun.YAML.parse(await read(".github/workflows/vector-desktop-release.yml")) as {
    jobs: { test: { "timeout-minutes": number } }
  }
  expect(release.jobs.test["timeout-minutes"]).toBeGreaterThanOrEqual(45)
  const tests = Bun.YAML.parse(await read(".github/workflows/test.yml")) as {
    jobs: { unit: { steps: Array<{ name?: string; "timeout-minutes"?: number }> } }
  }
  expect(
    tests.jobs.unit.steps.find((step) => step.name === "Run unit tests")?.["timeout-minutes"],
  ).toBeGreaterThanOrEqual(45)
})

// One Bun process for the whole engine suite crashed twice in the 1.99.111 release (Bun 1.3.14 segmentation faults).
// The release runs it in shards, each with ripgrep, that together cover every test file.
test("the release runs the engine suite in shards that cover it all", async () => {
  const workflow = Bun.YAML.parse(await read(".github/workflows/vector-desktop-release.yml")) as {
    jobs: {
      test: {
        strategy: { matrix: { include: Array<{ name: string; directory: string; command: string }> } }
        steps: Array<{ name?: string; if?: string }>
      }
    }
  }
  const engine = workflow.jobs.test.strategy.matrix.include.filter((entry) => entry.directory === "packages/engine")
  const shards = engine.map((entry) =>
    entry.command
      .match(/--shard=(\d+)\/(\d+)/)
      ?.slice(1)
      .map(Number),
  )
  expect(engine.length).toBeGreaterThanOrEqual(2)
  expect(shards.every((shard) => shard !== undefined && shard[1] === engine.length)).toBe(true)
  expect(shards.map((shard) => shard?.[0]).sort()).toEqual(engine.map((_, index) => index + 1))
  expect(engine.every((entry) => entry.name.startsWith("vector"))).toBe(true)
  expect(workflow.jobs.test.steps.find((step) => step.name === "Install ripgrep")?.if).toBe(
    "startsWith(matrix.name, 'vector')",
  )
})

// The test workflow runs the engine suite only in shards, on Linux as on Windows: one Bun process for the whole suite
// crashed in Bun 1.3.14 on 25 October 2026.
test("the test workflow runs the engine suite only in shards, on Linux and Windows", async () => {
  const workflow = Bun.YAML.parse(await read(".github/workflows/test.yml")) as {
    jobs: Record<
      string,
      { "runs-on": string; strategy?: { matrix?: { shard?: number[] } }; steps: Array<{ name?: string; run?: string }> }
    >
  }
  const unit = workflow.jobs.unit.steps.find((step) => step.name === "Run unit tests")?.run ?? ""
  expect(unit).toContain("--filter='!@vectordevai/engine'")
  expect(unit).not.toContain("else")
  for (const [job, host] of [
    ["engine-linux", "ubuntu-24.04"],
    ["engine-windows", "windows-latest"],
  ] as const) {
    const shards = workflow.jobs[job]?.strategy?.matrix?.shard ?? []
    expect(workflow.jobs[job]?.["runs-on"]).toBe(host)
    expect(shards).toEqual(shards.map((_, index) => index + 1))
    expect(shards.length).toBeGreaterThanOrEqual(4)
    const run = workflow.jobs[job]?.steps.find((step) => step.name === "Run Engine shard")?.run ?? ""
    expect(run).toContain(`--shard=\${{ matrix.shard }}/${shards.length}`)
  }
})

// The Codium build's CI lane (codium-build-spec WP A00). Work packages run single test files on the owner's Mac, so
// typechecks, suites with real services and browser specs run in vector-codium.yml, with no secrets. Stripe test mode
// runs only in vector-codium-e2e.yml, by dispatch, behind the owner-approved codium-test environment.
describe("Codium CI lane", () => {
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
    environment?: string
    permissions?: Record<string, string>
    needs?: string | string[]
    env?: Record<string, string>
    outputs?: Record<string, string>
    services?: Record<string, { image?: string }>
    strategy?: { matrix?: { include?: Array<Record<string, string>> } }
    steps?: Step[]
  }
  type Workflow = { on: Record<string, unknown>; permissions?: Record<string, string>; jobs: Record<string, Job> }

  const workflow = async (file: string) => Bun.YAML.parse(await read(`.github/workflows/${file}`)) as Workflow
  const step = (job: Job | undefined, name: string) => job?.steps?.find((entry) => entry.name === name)
  const checkout = (job: Job | undefined) => job?.steps?.find((entry) => entry.uses?.startsWith("actions/checkout@"))
  const checkoutRoot = fileURLToPath(new URL("../../..", import.meta.url))
  const exists = (relative: string) => existsSync(path.join(checkoutRoot, relative))
  // Runs a workflow step's own shell; only the inputs and GitHub's output file are substituted.
  const shell = async (script: string, env: Record<string, string>) => {
    const directory = await mkdtemp(path.join(tmpdir(), "vector-workflow-"))
    const file = path.join(directory, "output")
    // Actions supplies a regular file. Linux cannot reopen Bun's socket-backed stdout via /dev/stdout.
    await writeFile(file, "")
    try {
      const child = Bun.spawn(["bash", "-c", script], {
        env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: file, ...env },
        stdout: "pipe",
        stderr: "ignore",
      })
      const [status, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
      return { status, output: output + (await readFile(file, "utf8")) }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  test("the lane runs on the Codium branches with read-only access and no secrets", async () => {
    const text = await read(".github/workflows/vector-codium.yml")
    const lane = Bun.YAML.parse(text) as Workflow
    expect(Object.keys(lane.on).sort()).toEqual(["push", "workflow_dispatch"])
    expect((lane.on.push as { branches?: string[] }).branches).toEqual(
      expect.arrayContaining(["codium", "codium/**", "codium-113", "codium-113/**"]),
    )
    expect(lane.permissions).toEqual({ contents: "read" })
    expect(text).not.toContain("secrets.")
    expect(text).not.toContain("GH_TOKEN")
    for (const [name, job] of Object.entries(lane.jobs)) {
      expect({ job: name, environment: job.environment ?? null, permissions: job.permissions ?? null }).toEqual({
        job: name,
        environment: null,
        permissions: null,
      })
    }
  })

  test("the lane typechecks the hosted API and every package Codium changes", async () => {
    const lane = await workflow("vector-codium.yml")
    const include = lane.jobs.typecheck?.strategy?.matrix?.include ?? []
    const names = include.map((entry) => entry.name)
    expect(names).toEqual(expect.arrayContaining(["api", "schema", "core", "engine", "app", "desktop", "web"]))
    expect(new Set(names).size).toBe(names.length)
    // api/ is checked against the root tsconfig.json, which includes only api/**.
    expect(include.find((entry) => entry.name === "api")).toEqual({
      name: "api",
      directory: "packages/engine",
      command: "bun typecheck --project ../../tsconfig.json",
    })
    for (const entry of include.filter((entry) => entry.name !== "api")) {
      expect(entry).toEqual({ name: entry.name!, directory: `packages/${entry.name}`, command: "bun typecheck" })
      const manifest = (await Bun.file(`${root}/packages/${entry.name}/package.json`).json()) as {
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

  test("the Codium tests run against Valkey and Postgres pinned by digest, as the sharing integration does", async () => {
    const lane = await workflow("vector-codium.yml")
    const sharing = await workflow("vector-sharing.yml")
    const tests = lane.jobs.tests
    for (const name of ["valkey", "postgres"]) {
      const image = tests?.services?.[name]?.image
      expect(image).toMatch(/@sha256:[a-f0-9]{64}$/)
      expect(image).toBe(sharing.jobs.integration?.services?.[name]?.image)
    }
    const run = step(tests, "Run the Codium test files")
    expect(run?.run).toBe("GITHUB_ACTIONS=false bun packages/cloud/src/codium-ci-tests.ts")
    expect(run?.env?.VECTOR_TEST_REDIS_URL).toBe("redis://127.0.0.1:6379")
    expect(run?.env?.VECTOR_TEST_POSTGRES_URL).toStartWith("postgres://vector_fixture:fixture-only@127.0.0.1:5432/")
    expect(step(tests, "Run HttpApi exerciser gates")).toMatchObject({ run: "bun run test:httpapi" })
    expect(step(tests, "Check generated client")).toMatchObject({ run: "bun run check:generated" })
    expect(step(lane.jobs.browser, "Run the Codium browser specs")?.run).toBe(
      "bun packages/cloud/src/codium-ci-tests.ts --browser",
    )
    // The picker compares the branch with main, so both jobs that run it check out the whole history.
    for (const job of [tests, lane.jobs.browser]) expect(checkout(job)?.with).toEqual({ "fetch-depth": 0 })
  })

  test("the picker takes the hosted API suite, every test that names Codium and every test the branch changed", () => {
    const tracked = [
      "test/account-delete.test.ts",
      "test/codium-plan-names.test.ts",
      "packages/web/test/model-plans-api.test.ts",
      "packages/web/test/model-topups-api.test.ts",
      "packages/web/src/components/marketing/account/ModelPlans.test.ts",
      "packages/web/src/components/marketing/codium/CodiumPricing.test.ts",
      "packages/web/e2e/codium/checkout.test.ts",
      "packages/web/test/fixture/codium-fakes.ts",
      "packages/core/test/fixture/codium-gateway.test.ts",
      "packages/engine/test/session/retry.test.ts",
      "packages/engine/test/session/prompt.test.ts",
      "packages/desktop/src/main/billing-navigation.test.ts",
      "packages/app/e2e/regression/codium-image-routing.spec.ts",
      "packages/cloud/src/oauth.test.ts",
      "docs/benchmarks/codium/extra-behavior.test.ts",
    ]
    const changed = [
      "packages/engine/test/session/retry.test.ts",
      "packages/desktop/src/main/billing-navigation.test.ts",
      "docs/benchmarks/codium/extra-behavior.test.ts",
      "packages/schema/test/removed.test.ts",
      "api/_lib/codium-pool.ts",
    ]
    expect(selectUnitTests(tracked, changed)).toEqual([
      "packages/desktop/src/main/billing-navigation.test.ts",
      "packages/engine/test/session/retry.test.ts",
      "packages/web/src/components/marketing/account/ModelPlans.test.ts",
      "packages/web/src/components/marketing/codium/CodiumPricing.test.ts",
      "packages/web/test/model-plans-api.test.ts",
      "packages/web/test/model-topups-api.test.ts",
      "test/account-delete.test.ts",
      "test/codium-plan-names.test.ts",
    ])
    expect(
      selectBrowserSpecs(
        [
          ...tracked,
          "packages/app/e2e/regression/account-settings.spec.ts",
          "packages/app/e2e/smoke.spec.ts",
          "packages/app/e2e/performance/codium-timeline.spec.ts",
          "packages/app/e2e/regression/public-share-viewer.spec.ts",
        ],
        [
          "packages/app/e2e/regression/account-settings.spec.ts",
          "packages/app/e2e/regression/public-share-viewer.spec.ts",
        ],
      ),
    ).toEqual([
      "packages/app/e2e/regression/account-settings.spec.ts",
      "packages/app/e2e/regression/codium-image-routing.spec.ts",
    ])
  })

  test("each picked file runs from the package that owns it, as that package's test script runs it", async () => {
    const owned = new Set(["test/bunfig.toml", "packages/web/package.json", "packages/sdk/js/package.json"])
    expect(owningDirectory("test/codium-plan-names.test.ts", (file) => owned.has(file))).toBe("test")
    expect(owningDirectory("packages/web/src/lib/model-plans.test.ts", (file) => owned.has(file))).toBe("packages/web")
    expect(owningDirectory("packages/sdk/js/test/client.test.ts", (file) => owned.has(file))).toBe("packages/sdk/js")
    expect(() => owningDirectory("loose.test.ts", () => false)).toThrow()

    expect(unitCommand("test/codium-plan-names.test.ts", "test")).toEqual([
      "test",
      "--timeout",
      "30000",
      "./codium-plan-names.test.ts",
    ])
    expect(unitCommand("packages/desktop/src/main/vector-account.test.ts", "packages/desktop")).toEqual([
      "--no-env-file",
      "test",
      "--timeout",
      "30000",
      "./src/main/vector-account.test.ts",
    ])
    expect(unitCommand("packages/app/src/components/codium-error.test.ts", "packages/app")).toEqual([
      "test",
      "--timeout",
      "30000",
      "--isolate",
      "./src/components/codium-error.test.ts",
    ])
    expect(unitCommand("packages/app/test-browser/codium.test.ts", "packages/app")).toContain("--conditions=browser")
    expect(browserCommand(["packages/app/e2e/regression/codium-image-routing.spec.ts"])).toEqual([
      "run",
      "test:e2e",
      "e2e/regression/codium-image-routing.spec.ts",
    ])
    // The flags above mirror the packages' own scripts; a change there must reach the picker too.
    const app = (await Bun.file(`${root}/packages/app/package.json`).json()) as { scripts: Record<string, string> }
    expect(app.scripts["test:unit"]).toContain("--isolate")
    expect(app.scripts["test:browser"]).toContain("--conditions=browser")
    expect(app.scripts["test:e2e"]).toBe("playwright test")
    expect(await read("packages/desktop/scripts/test.ts")).toContain('"--no-env-file", "test"')
  })

  test("in this checkout the picker finds the hosted API suite and the Codium tests, each with an owner", () => {
    const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: checkoutRoot, stdout: "pipe", stderr: "ignore" })
    expect(listed.exitCode).toBe(0)
    const tracked = listed.stdout.toString().split("\0").filter(Boolean)
    const files = selectUnitTests(tracked, [])
    expect(files).toEqual(expect.arrayContaining(tracked.filter((file) => /^test\/[^/]+\.test\.ts$/.test(file))))
    expect(files.filter((file) => file.startsWith("packages/web/")).length).toBeGreaterThan(0)
    expect(files.filter((file) => file.split("/").includes("e2e"))).toEqual([])
    for (const file of files)
      expect(owningDirectory(file, exists)).toMatch(/^(?:test|packages\/[^/]+|packages\/sdk\/js)$/)
  })

  test("the end-to-end workflow is dispatch-only and only the codium-test environment sees secrets", async () => {
    const text = await read(".github/workflows/vector-codium-e2e.yml")
    const e2e = Bun.YAML.parse(text) as Workflow
    expect(Object.keys(e2e.on)).toEqual(["workflow_dispatch"])
    expect(e2e.permissions).toEqual({ contents: "read" })
    const guard = e2e.jobs.guard
    expect(guard?.environment).toBeUndefined()
    expect(guard?.permissions).toEqual({ contents: "read", actions: "read" })
    expect(JSON.stringify(guard)).not.toContain("secrets.")
    const ancestors = (name: string): string[] =>
      [e2e.jobs[name]?.needs]
        .flat()
        .filter((value): value is string => typeof value === "string")
        .flatMap((value) => [value, ...ancestors(value)])
    const others = Object.entries(e2e.jobs).filter(([name]) => name !== "guard")
    expect(others.length).toBeGreaterThan(0)
    for (const [name, job] of others) {
      expect({ job: name, environment: job.environment ?? null, permissions: job.permissions ?? null }).toEqual({
        job: name,
        environment: "codium-test",
        permissions: null,
      })
      expect(ancestors(name)).toContain("guard")
      // Every check reads the target the guard validated, never the raw input.
      expect(job.env?.CODIUM_E2E_TARGET).toBe("${{ needs.guard.outputs.target }}")
    }
    expect(guard?.outputs?.target).toBe("${{ steps.target.outputs.target }}")
    // Browser traces would carry the bypass header and test credentials, and the repository is public.
    expect(text).not.toContain("actions/upload-artifact")
  })

  test("the end-to-end workflow refuses an unprotected codium-test environment", async () => {
    const script = step(
      (await workflow("vector-codium-e2e.yml")).jobs.guard,
      "Require protected codium-test environment",
    )?.run
    expect(script).toBeDefined()
    for (const response of ["1", "2", "0", "", "invalid", "missing", "forbidden"]) {
      const { status } = await shell(
        `gh() {
          test "$1" = api && test "$2" = repos/fixture/repo/environments/codium-test || return 99
          case "$FIXTURE_RESPONSE" in missing|forbidden) return 1;; esac
          printf '%s\\n' "$FIXTURE_RESPONSE"
        }
        ${script}`,
        { GITHUB_REPOSITORY: "fixture/repo", FIXTURE_RESPONSE: response },
      )
      expect({ response, status }).toEqual({ response, status: ["1", "2"].includes(response) ? 0 : 1 })
    }
  })

  test("the end-to-end workflow runs only against a preview origin, never vectordev.ai", async () => {
    const script = step((await workflow("vector-codium-e2e.yml")).jobs.guard, "Refuse production targets")?.run
    expect(script).toBeDefined()
    for (const [target, expected] of [
      ["https://vector-git-codium-fixture.vercel.app", "https://vector-git-codium-fixture.vercel.app"],
      ["HTTPS://Vector-Preview-Fixture.vercel.app/", "https://vector-preview-fixture.vercel.app"],
    ]) {
      const { status, output } = await shell(script!, { CODIUM_E2E_TARGET: target! })
      expect({ target, status, output: output.trim() }).toEqual({ target, status: 0, output: `target=${expected}` })
    }
    for (const target of [
      "",
      "vector-preview-fixture.vercel.app",
      "http://vector-preview-fixture.vercel.app",
      "https://vectordev.ai",
      "https://www.vectordev.ai/",
      "https://VECTORDEV.AI",
      "https://vectordev.ai.",
      "https://remote.vectordev.ai",
      "https://fixture:fixture@vector-preview-fixture.vercel.app",
      "https://vector-preview-fixture.vercel.app/codium",
      "https://vector-preview-fixture.vercel.app:8443",
      "https://vector-preview-fixture.vercel.app/?next=https://vectordev.ai",
      "https://",
    ]) {
      const { status, output } = await shell(script!, { CODIUM_E2E_TARGET: target })
      expect({ target, status, wroteTarget: output.includes("target=") }).toEqual({
        target,
        status: 1,
        wroteTarget: false,
      })
    }
  })

  test("the end-to-end workflow refuses live Stripe keys and a missing test store", async () => {
    const job = (await workflow("vector-codium-e2e.yml")).jobs.e2e
    const guard = step(job, "Require Stripe test mode and the test store")
    expect(guard?.run).toBeDefined()
    // The guard runs before any step that hands the secrets to a check.
    const steps = job?.steps ?? []
    const first = steps.findIndex((entry) =>
      Object.keys(entry.env ?? {}).some((name) => name.startsWith("CODIUM_E2E_")),
    )
    expect(steps[first]).toBe(guard!)
    const store = { CODIUM_E2E_KV_REST_API_URL: "https://fixture.upstash.io", CODIUM_E2E_KV_REST_API_TOKEN: "fixture" }
    for (const [env, accepted] of [
      [{ ...store, CODIUM_E2E_STRIPE_SECRET_KEY: "sk_test_fixture" }, true],
      [{ ...store, CODIUM_E2E_STRIPE_SECRET_KEY: "rk_test_fixture" }, true],
      [{ ...store, CODIUM_E2E_STRIPE_SECRET_KEY: "sk_live_fixture" }, false],
      [{ ...store, CODIUM_E2E_STRIPE_SECRET_KEY: "rk_live_fixture" }, false],
      [{ ...store, CODIUM_E2E_STRIPE_SECRET_KEY: "pk_test_fixture" }, false],
      [{ ...store, CODIUM_E2E_STRIPE_SECRET_KEY: "sk_test_" }, false],
      [{ ...store, CODIUM_E2E_STRIPE_SECRET_KEY: "" }, false],
      [{ ...store }, false],
      [
        { ...store, CODIUM_E2E_STRIPE_SECRET_KEY: "sk_test_fixture", CODIUM_E2E_KV_REST_API_URL: "http://fixture" },
        false,
      ],
      [{ ...store, CODIUM_E2E_STRIPE_SECRET_KEY: "sk_test_fixture", CODIUM_E2E_KV_REST_API_URL: "" }, false],
      [{ ...store, CODIUM_E2E_STRIPE_SECRET_KEY: "sk_test_fixture", CODIUM_E2E_KV_REST_API_TOKEN: "" }, false],
    ] as const) {
      const { status, output } = await shell(guard!.run!, env)
      expect({ env, status }).toEqual({ env, status: accepted ? 0 : 1 })
      // The guard never prints a key.
      expect(output).not.toContain("_fixture")
    }
  })
})
