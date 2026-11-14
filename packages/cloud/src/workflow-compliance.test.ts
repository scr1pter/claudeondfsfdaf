import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  browserCommand,
  owningDirectory,
  retried,
  selectBrowserSpecs,
  selectHostedTests,
  selectUnitTests,
  unitCommand,
} from "./codium-ci-tests"

const root = fileURLToPath(new URL("../../..", import.meta.url))
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
    expect(workflow.match(/^ +artifact_digest:/gm)).toHaveLength(3)
    const jobs = (
      Bun.YAML.parse(workflow) as {
        jobs: Record<
          string,
          {
            outputs?: Record<string, string>
            needs?: string | string[]
            "runs-on"?: string
            steps?: Array<{ name?: string; env?: Record<string, string>; run?: string }>
          }
        >
      }
    ).jobs
    for (const platform of ["mac", "windows", "linux"])
      expect(jobs[platform]?.outputs?.artifact_digest).toBe("${{ steps.platform-artifact.outputs.artifact-digest }}")
    expect(jobs.windows?.outputs?.helper_arm64_artifact_id).toBe(
      "${{ steps.arm-package.outputs.artifact-id || steps.arm-restore.outputs.artifact_ids }}",
    )
    expect(jobs.windows?.outputs?.helper_arm64_artifact_digest).toBe(
      "${{ steps.arm-package.outputs.artifact-digest || steps.arm-restore.outputs.artifact_digests }}",
    )
    const arm = jobs["windows-arm64-helper"]
    expect(arm?.["runs-on"]).toBe("windows-11-arm")
    expect(arm?.needs).toContain("windows")
    expect(jobs.release?.needs).toContain("windows-arm64-helper")
    const proof = arm?.steps?.find(
      (step) => step.name === "Restore the exact final ARM64 package proof by run, id and digest",
    )
    expect(proof?.env?.PROOF_ID).toBe("${{ needs.windows.outputs.helper_arm64_artifact_id }}")
    expect(proof?.env?.PROOF_DIGEST).toBe("${{ needs.windows.outputs.helper_arm64_artifact_digest }}")
    expect(proof?.run).toContain("--required --expected-id $env:PROOF_ID --expected-digest $env:PROOF_DIGEST")
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
      ".github/workflows/vector-hosted-ci.yml",
      ".github/workflows/vector-hosted-deploy.yml",
      ".github/workflows/vector-hosted-image.yml",
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
    strategy?: { matrix?: { include?: Array<{ mode: string; scenario: string; runtime?: string }> } }
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
    expect(workflow.on.push).toEqual({
      branches: ["main", "vector-at-mention", "build-integrate", "build-github-ui"],
    })
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
        "packages/web/test/account-github-agents.test.ts",
        "packages/web/src/components/marketing/account/GithubAgents.tsx",
        "packages/web/src/components/marketing/account/github-agents.css",
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
    // The journey and atomic binding tests must execute against disposable Redis, not pass through skips.
    const checks = steps(workflow).filter(({ step }) => step.run?.includes("test/cloud-agents-*.test.ts"))
    expect(checks).toHaveLength(1)
    expect(checks[0]?.job).toBe("api")
    expect(checks[0]?.step.env?.VECTOR_TEST_REDIS_URL).toBe("redis://127.0.0.1:6379")
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
        ["packages/web", "test/account-github-agents.test.ts"],
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
      { mode: "codium", scenario: "session-replaced" },
      { mode: "codium", scenario: "success", runtime: "bun" },
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
    expect(app.scripts["test:unit"]).toBe("node --test ./scripts/test-unit.test.mjs && node ./scripts/test-unit.mjs")
    const appUnit = await read("packages/app/scripts/test-unit.mjs")
    expect(appUnit).toContain(
      'const argumentsBeforePath = ["test", "--isolate", "--only-failures", "--preload", "./happydom.ts"]',
    )
    expect(appUnit).toMatch(/run\("bun",\s*\[\.\.\.argumentsBeforePath,\s*file\],\s*\{\s*cwd:\s*root,/)
    expect(app.scripts["test:browser"]).toContain("--conditions=browser")
    expect(app.scripts["test:e2e"]).toBe("playwright test")
    expect(await read("packages/desktop/scripts/test.ts")).toContain('"--no-env-file", "test"')
  })

  test("the picker tries a failed Electron download again and answers the last attempt's status", async () => {
    const attempts = (answers: number[]) => {
      const seen: number[] = []
      const attempt = async () => {
        const status = answers[seen.length]
        seen.push(status)
        return status
      }
      return { seen, attempt }
    }
    const recovered = attempts([1, 0, 1])
    expect(await retried(recovered.attempt, [0, 0])).toBe(0)
    expect(recovered.seen).toEqual([1, 0])
    const down = attempts([1, 1, 2])
    expect(await retried(down.attempt, [0, 0])).toBe(2)
    expect(down.seen).toEqual([1, 1, 2])
    const installed = attempts([0, 1])
    expect(await retried(installed.attempt, [0, 0])).toBe(0)
    expect(installed.seen).toEqual([0])
    // Vector Codium run 42464293147 failed on one 504 from GitHub's release download; the lane now tries three times.
    expect(await read("packages/cloud/src/codium-ci-tests.ts")).toMatch(
      /retried\(\s*\(\) => run\(\[process\.execPath, "--no-env-file", installer\], desktop, "Electron runtime"\),\s*\[15_000, 60_000\],/,
    )
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

// The hosted services' workflows (codium-build-spec WP A58, §6.2). vector-hosted-ci.yml checks the hosted parts on pull
// requests with no secret; vector-hosted-deploy.yml deploys the two Cloudflare Workers and vector-hosted-image.yml builds
// the cloud computer's image and bakes its snapshot, both by dispatch only, from a commit on protected main, with their
// secrets only in the protected hosted-production environment, behind a preflight job that holds none.
describe("Hosted deploy workflows", () => {
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
    name?: string
    if?: string
    uses?: string
    with?: Record<string, unknown>
    environment?: string
    permissions?: Record<string, string>
    needs?: string | string[]
    env?: Record<string, string>
    outputs?: Record<string, string>
    services?: Record<string, { image?: string }>
    strategy?: { matrix?: { include?: Array<Record<string, string>> } }
    "runs-on"?: string
    steps?: Step[]
  }
  type Workflow = {
    on: Record<string, unknown>
    permissions?: Record<string, string>
    concurrency?: { group: string; "cancel-in-progress": boolean }
    jobs: Record<string, Job>
  }
  const HOSTED = [
    ".github/workflows/vector-hosted-ci.yml",
    ".github/workflows/vector-hosted-deploy.yml",
    ".github/workflows/vector-hosted-image.yml",
    ".github/workflows/vector-hosted-budget.yml",
  ]
  const workflow = async (file: string) => Bun.YAML.parse(await read(`.github/workflows/${file}`)) as Workflow
  const step = (job: Job | undefined, name: string) => job?.steps?.find((entry) => entry.name === name)
  const at = (job: Job | undefined, name: string) => job?.steps?.findIndex((entry) => entry.name === name) ?? -1
  const needs = (job: Job | undefined) => [job?.needs].flat().filter((value): value is string => typeof value === "string")
  const checkoutRoot = fileURLToPath(new URL("../../..", import.meta.url))

  // Runs a workflow step's own shell; only GitHub's commands, inputs and output files are substituted.
  const shell = async (script: string, env: Record<string, string>, cwd?: string) => {
    const directory = await mkdtemp(path.join(tmpdir(), "vector-hosted-workflow-"))
    const output = path.join(directory, "output")
    await writeFile(output, "")
    try {
      const child = Bun.spawn(["bash", "-c", script], {
        cwd: cwd ?? directory,
        env: { PATH: process.env.PATH ?? "", HOME: directory, GITHUB_OUTPUT: output, RUNNER_TEMP: directory, ...env },
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

  // A scratch repository with a bare origin: main holds one commit, a side branch one more that main does not.
  const scratchRepository = async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vector-hosted-git-"))
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: directory,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(directory, "gitconfig"),
    }
    await writeFile(env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[commit]\n\tgpgsign = false\n")
    const git = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" })
      if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
      return result.stdout.toString().trim()
    }
    const origin = path.join(directory, "origin.git")
    const work = path.join(directory, "work")
    git(directory, "init", "--quiet", "--bare", "--initial-branch=main", origin)
    git(directory, "init", "--quiet", "--initial-branch=main", work)
    git(work, "remote", "add", "origin", origin)
    git(work, "commit", "--quiet", "--allow-empty", "-m", "on main")
    const onMain = git(work, "rev-parse", "HEAD")
    git(work, "push", "--quiet", "origin", "main")
    git(work, "checkout", "--quiet", "-b", "side")
    git(work, "commit", "--quiet", "--allow-empty", "-m", "not on main")
    const offMain = git(work, "rev-parse", "HEAD")
    return {
      work,
      env,
      onMain,
      offMain,
      checkout: (sha: string) => git(work, "checkout", "--quiet", "--detach", sha),
      [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }),
    }
  }

  test("every hosted workflow pins each action by commit and names its runner", async () => {
    for (const file of HOSTED) {
      const text = await read(file)
      const actions = text
        .split("\n")
        .map((line) => line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/)?.[1])
        .filter((value): value is string => typeof value === "string" && !value.startsWith("./"))
      expect(actions.length).toBeGreaterThan(0)
      expect({ file, unpinned: actions.filter((action) => !/@[a-f0-9]{40}$/.test(action)) }).toEqual({ file, unpinned: [] })
      const parsed = Bun.YAML.parse(text) as Workflow
      for (const [name, job] of Object.entries(parsed.jobs))
        expect({ file, job: name, runner: job["runs-on"] }).toEqual({ file, job: name, runner: "ubuntu-24.04" })
    }
  })

  test("no input or output is pasted into a shell: they reach scripts as environment variables", async () => {
    for (const file of HOSTED) {
      const parsed = Bun.YAML.parse(await read(file)) as Workflow
      for (const [name, job] of Object.entries(parsed.jobs))
        for (const entry of job.steps ?? []) {
          if (!entry.run) continue
          const expressions = entry.run.match(/\$\{\{[^}]*\}\}/g) ?? []
          // The one exception is the typecheck matrix's own fixed command.
          expect({ file, job: name, step: entry.name, expressions: expressions.filter((value) => value !== "${{ matrix.command }}") })
            .toEqual({ file, job: name, step: entry.name, expressions: [] })
        }
    }
  })

  describe("vector-hosted-ci.yml", () => {
    test("runs on pull requests that touch the hosted services, can only read and holds no secret", async () => {
      const text = await read(".github/workflows/vector-hosted-ci.yml")
      const ci = Bun.YAML.parse(text) as Workflow
      expect(Object.keys(ci.on).sort()).toEqual(["pull_request", "workflow_call", "workflow_dispatch"])
      const paths = (ci.on.pull_request as { paths: string[] }).paths
      // The contract's list (§6.2), plus the hosted tests, SQL, scripts, lockfile and the workflows themselves.
      expect(paths).toEqual(
        expect.arrayContaining([
          "api/**",
          "packages/relay/**",
          "packages/ops-worker/**",
          "packages/hosted-computer/**",
          "packages/schema/**",
          "packages/core/src/vault/**",
          "packages/core/src/webauthn/**",
          "packages/desktop/src/main/remote-*",
          "packages/desktop/src/main/vault-*",
          "packages/desktop/src/main/hosted-*",
        ]),
      )
      // Every path names something that exists, so none silently stops matching.
      const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: checkoutRoot, stdout: "pipe", stderr: "ignore" })
      const tracked = listed.stdout.toString().split("\0").filter(Boolean)
      for (const pattern of paths) {
        const glob = new Bun.Glob(pattern)
        expect({ pattern, matches: tracked.some((file) => glob.match(file)) }).toEqual({ pattern, matches: true })
      }
      expect(ci.permissions).toEqual({ contents: "read" })
      expect(text).not.toContain("secrets.")
      expect(text).not.toContain("GH_TOKEN")
      for (const [name, job] of Object.entries(ci.jobs)) {
        expect({ job: name, environment: job.environment ?? null, permissions: job.permissions ?? null }).toEqual({
          job: name,
          environment: null,
          permissions: null,
        })
        const checkout = job.steps?.find((entry) => entry.uses?.startsWith("actions/checkout@"))
        expect({ job: name, persist: checkout?.with?.["persist-credentials"] }).toEqual({ job: name, persist: false })
      }
    })

    test("typechecks every hosted part and runs their tests against Valkey and Postgres pinned by digest", async () => {
      const ci = await workflow("vector-hosted-ci.yml")
      const lane = await workflow("vector-codium.yml")
      const include = ci.jobs.typecheck?.strategy?.matrix?.include ?? []
      expect(include.map((entry) => entry.name).sort()).toEqual(
        ["api", "cloud", "core", "desktop", "hosted-computer", "ops-worker", "relay", "schema"].sort(),
      )
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
      for (const name of ["valkey", "postgres"]) {
        const image = ci.jobs.tests?.services?.[name]?.image
        expect(image).toMatch(/@sha256:[a-f0-9]{64}$/)
        expect(image).toBe(lane.jobs.tests?.services?.[name]?.image)
      }
      const run = step(ci.jobs.tests, "Run the hosted test files")
      expect(run?.run).toBe("GITHUB_ACTIONS=false bun packages/cloud/src/codium-ci-tests.ts --hosted")
      expect(run?.env?.VECTOR_TEST_REDIS_URL).toBe("redis://127.0.0.1:6379")
      expect(run?.env?.VECTOR_TEST_POSTGRES_URL).toStartWith("postgres://vector_fixture:fixture-only@127.0.0.1:5432/")
    })

    test("dry-runs both Workers' deploys, smoke-tests them, and builds and boots the image", async () => {
      const ci = await workflow("vector-hosted-ci.yml")
      for (const [job, directory] of [
        ["relay", "packages/relay"],
        ["ops-worker", "packages/ops-worker"],
      ] as const) {
        const steps = ci.jobs[job]?.steps ?? []
        const runs = steps.filter((entry) => entry.run).map((entry) => [entry["working-directory"], entry.run])
        expect(runs).toEqual([
          [directory, "bun run dry-run"],
          [directory, "bun run smoke"],
        ])
        const manifest = (await Bun.file(`${root}/${directory}/package.json`).json()) as { scripts: Record<string, string> }
        expect(manifest.scripts["dry-run"]).toBe("wrangler deploy --dry-run --outdir dist")
        expect(ci.jobs[job]?.env?.WRANGLER_SEND_METRICS).toBe("false")
      }
      const image = ci.jobs["hosted-image"]
      expect(step(image, "Build the image with a stand-in CLI")?.run).toContain("docker build --platform linux/amd64")
      expect(step(image, "Boot the image and check it from inside")).toMatchObject({
        run: "bun test --timeout 600000 ./test/image.test.ts",
        env: { VECTOR_TEST_HOSTED_IMAGE: "vector-hosted-computer:ci" },
      })
      expect(JSON.stringify(image)).not.toMatch(/docker (?:login|push)/)
    })

    test("the Codium lane runs the Worker and image jobs through it, and only those", async () => {
      const ci = await workflow("vector-hosted-ci.yml")
      const lane = await workflow("vector-codium.yml")
      expect(lane.jobs.hosted).toEqual({
        name: "Hosted services",
        uses: "./.github/workflows/vector-hosted-ci.yml",
        with: { services_only: true },
      })
      expect((ci.on.workflow_call as { inputs: Record<string, { type: string; default: boolean }> }).inputs.services_only).toMatchObject({
        type: "boolean",
        default: false,
      })
      for (const name of ["typecheck", "tests"]) expect(ci.jobs[name]?.if).toBe("${{ !inputs.services_only }}")
      for (const name of ["relay", "ops-worker", "hosted-image"]) expect(ci.jobs[name]?.if).toBeUndefined()
      // No copy of those jobs is left in the lane.
      const others = JSON.stringify(Object.entries(lane.jobs).filter(([name]) => name !== "hosted"))
      for (const command of ["bun run dry-run", "bun run smoke", "docker build", "image.test.ts"])
        expect(others).not.toContain(command)
    })

    test("the picker takes the hosted API suite and the hosted parts' tests, whatever the branch changed", () => {
      const tracked = [
        "test/hosted-ledger.test.ts",
        "test/codium-pool.test.ts",
        "test/hosted-fixture.ts",
        "test/sub/nested.test.ts",
        "packages/relay/test/relay.test.ts",
        "packages/relay/e2e/relay-smoke.ts",
        "packages/ops-worker/test/on-call.test.ts",
        "packages/hosted-computer/test/image.test.ts",
        "packages/schema/test/codium-copy.test.ts",
        "packages/core/test/vault/vault.test.ts",
        "packages/core/test/webauthn/verify.test.ts",
        "packages/core/test/remote/crypto.test.ts",
        "packages/core/test/review/format.test.ts",
        "packages/desktop/src/main/remote-link.test.ts",
        "packages/desktop/src/main/vault-secrets.sign-ins.test.ts",
        "packages/desktop/src/main/hosted-client.test.ts",
        "packages/desktop/src/main/billing-navigation.test.ts",
        "packages/cloud/src/hosted-image.test.ts",
        "packages/cloud/src/workflow-compliance.test.ts",
        "packages/cloud/src/oauth.test.ts",
        "packages/engine/test/cli/vault.test.ts",
        "packages/app/src/phone/remote/client.test.ts",
      ]
      expect(selectHostedTests(tracked)).toEqual([
        "packages/cloud/src/hosted-image.test.ts",
        "packages/cloud/src/workflow-compliance.test.ts",
        "packages/core/test/remote/crypto.test.ts",
        "packages/core/test/vault/vault.test.ts",
        "packages/core/test/webauthn/verify.test.ts",
        "packages/desktop/src/main/hosted-client.test.ts",
        "packages/desktop/src/main/remote-link.test.ts",
        "packages/desktop/src/main/vault-secrets.sign-ins.test.ts",
        "packages/hosted-computer/test/image.test.ts",
        "packages/ops-worker/test/on-call.test.ts",
        "packages/relay/test/relay.test.ts",
        "packages/schema/test/codium-copy.test.ts",
        "test/codium-pool.test.ts",
        "test/hosted-ledger.test.ts",
      ])
      // In this checkout it finds every part's tests, each with a package to run it from.
      const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: checkoutRoot, stdout: "pipe", stderr: "ignore" })
      const files = selectHostedTests(listed.stdout.toString().split("\0").filter(Boolean))
      for (const prefix of [
        "test/",
        "packages/relay/",
        "packages/ops-worker/",
        "packages/hosted-computer/",
        "packages/schema/",
        "packages/core/test/vault/",
        "packages/core/test/webauthn/",
        "packages/desktop/src/main/remote-",
        "packages/desktop/src/main/vault-",
        "packages/desktop/src/main/hosted-",
        "packages/cloud/src/hosted-",
      ])
        expect({ prefix, found: files.some((file) => file.startsWith(prefix)) }).toEqual({ prefix, found: true })
      for (const file of files)
        expect(owningDirectory(file, (relative) => existsSync(path.join(checkoutRoot, relative)))).toMatch(
          /^(?:test|packages\/[^/]+)$/,
        )
    })
  })

  // The preflight scripts of both dispatch workflows, run as written against fixtures.
  for (const file of ["vector-hosted-deploy.yml", "vector-hosted-image.yml"] as const) {
    describe(`${file} preflight`, () => {
      test("holds no secret, can only read, and every job that can see a secret waits for it", async () => {
        const parsed = await workflow(file)
        expect(Object.keys(parsed.on)).toEqual(["workflow_dispatch"])
        expect(parsed.permissions).toEqual({ contents: "read" })
        expect(parsed.concurrency?.["cancel-in-progress"]).toBe(false)
        const preflight = parsed.jobs.preflight
        expect(preflight?.environment).toBeUndefined()
        expect(preflight?.permissions).toEqual({ contents: "read", actions: "read" })
        expect(JSON.stringify(preflight)).not.toContain("secrets.")
        const others = Object.entries(parsed.jobs).filter(([name]) => name !== "preflight")
        expect(others.length).toBeGreaterThan(0)
        for (const [name, job] of others) {
          expect({ job: name, environment: job.environment, needs: needs(job), permissions: job.permissions ?? null }).toEqual({
            job: name,
            environment: "hosted-production",
            needs: ["preflight"],
            permissions: null,
          })
          // The job builds exactly the commit the preflight checked, keeps no credential, and checks it again.
          const checkout = job.steps?.[0]
          expect(checkout?.uses).toStartWith("actions/checkout@")
          expect(checkout?.with).toEqual({
            ref: "${{ needs.preflight.outputs.sha }}",
            "fetch-depth": 0,
            "persist-credentials": false,
          })
          const confirm = job.steps?.[1]
          expect(confirm?.name).toBe("Confirm the commit is still on protected main")
          expect(confirm?.run).toContain('git merge-base --is-ancestor "$VECTOR_')
          // From the lockfile, never from the dependency cache other runs write.
          const text = JSON.stringify(job)
          expect(text).not.toContain("./.github/actions/setup-bun")
          expect(text).not.toContain("actions/cache")
          expect(step(job, "Install the locked dependencies")?.run).toBe("bun install --frozen-lockfile --ignore-scripts")
          // Secrets reach only the steps that need them, never the whole job.
          expect(JSON.stringify(job.env ?? {})).not.toContain("secrets.")
        }
        expect(preflight?.outputs?.sha).toBe("${{ steps.source.outputs.sha }}")
      })

      test("refuses an unprotected or missing hosted-production environment", async () => {
        const script = step((await workflow(file)).jobs.preflight, "Require protected hosted-production environment")?.run
        expect(script).toBeDefined()
        for (const response of ["1", "2", "0", "", "invalid", "missing"]) {
          const { status } = await shell(
            `gh() {
              test "$1" = api && test "$2" = repos/fixture/repo/environments/hosted-production || return 99
              case "$FIXTURE_RESPONSE" in missing) return 1;; esac
              printf '%s\\n' "$FIXTURE_RESPONSE"
            }
            ${script}`,
            { GITHUB_REPOSITORY: "fixture/repo", FIXTURE_RESPONSE: response },
          )
          expect({ response, status }).toEqual({ response, status: ["1", "2"].includes(response) ? 0 : 1 })
        }
      })

      test("refuses a hosted-production environment that would take an unprotected branch", async () => {
        const script = step((await workflow(file)).jobs.preflight, "Require hosted-production to take protected branches only")?.run
        expect(script).toBeDefined()
        for (const response of ["true", "false", "", "null", "missing"]) {
          const { status } = await shell(
            `gh() {
              test "$1" = api && test "$2" = repos/fixture/repo/environments/hosted-production || return 99
              case "$FIXTURE_RESPONSE" in missing) return 1;; esac
              printf '%s\\n' "$FIXTURE_RESPONSE"
            }
            ${script}`,
            { GITHUB_REPOSITORY: "fixture/repo", FIXTURE_RESPONSE: response },
          )
          expect({ response, status }).toEqual({ response, status: response === "true" ? 0 : 1 })
        }
        // It reads the environment's own branch rule, which a workflow file on another branch cannot change.
        expect(script).toContain("--jq '.deployment_branch_policy.protected_branches // false'")
        const steps = (await workflow(file)).jobs.preflight?.steps ?? []
        expect(steps.findIndex((entry) => entry.name === "Require hosted-production to take protected branches only")).toBeLessThan(
          steps.findIndex((entry) => entry.name === "Require a commit on protected main"),
        )
      })

      test("passes only a commit on main, and only while main is protected", async () => {
        const script = step((await workflow(file)).jobs.preflight, "Require a commit on protected main")?.run
        expect(script).toBeDefined()
        await using repository = await scratchRepository()
        const run = async (sha: string, protectedAnswer: string) => {
          repository.checkout(sha)
          return shell(
            `gh() {
              test "$1" = api && test "$2" = repos/fixture/repo/branches/main || return 99
              case "$FIXTURE_PROTECTED" in fail) return 1;; esac
              printf '%s\\n' "$FIXTURE_PROTECTED"
            }
            ${script}`,
            { ...repository.env, GITHUB_REPOSITORY: "fixture/repo", GITHUB_SHA: sha, FIXTURE_PROTECTED: protectedAnswer },
            repository.work,
          )
        }
        const passed = await run(repository.onMain, "true")
        expect({ status: passed.status, output: passed.output.trim() }).toEqual({ status: 0, output: `sha=${repository.onMain}` })
        for (const [sha, answer] of [
          [repository.offMain, "true"],
          [repository.onMain, "false"],
          [repository.onMain, ""],
          [repository.onMain, "fail"],
        ] as const) {
          const refused = await run(sha, answer)
          expect({ sha, answer, status: refused.status, wrote: refused.output.includes("sha=") }).toEqual({
            sha,
            answer,
            status: 1,
            wrote: false,
          })
        }
        // A checkout that is not the dispatched commit is refused too.
        repository.checkout(repository.offMain)
        const moved = await shell(`gh() { printf 'true\\n'; }\n${script}`, {
          ...repository.env,
          GITHUB_REPOSITORY: "fixture/repo",
          GITHUB_SHA: repository.onMain,
        }, repository.work)
        expect(moved.status).toBe(1)
      })
    })
  }

  describe("vector-hosted-deploy.yml", () => {
    test("deploys the relay, the ops Worker or both, each only when picked", async () => {
      const deploy = await workflow("vector-hosted-deploy.yml")
      const target = (deploy.on.workflow_dispatch as { inputs: { target: { type: string; options: string[]; required: boolean } } })
        .inputs.target
      expect(target).toMatchObject({ type: "choice", options: ["relay", "ops", "all"], required: true })
      expect(Object.keys(deploy.jobs).sort()).toEqual(["ops", "preflight", "relay"])
      expect(deploy.jobs.relay?.if).toBe("inputs.target == 'relay' || inputs.target == 'all'")
      expect(deploy.jobs.ops?.if).toBe("inputs.target == 'ops' || inputs.target == 'all'")
      expect(deploy.concurrency?.group).toBe("vector-hosted-deploy")
    })

    test("checks the configuration, dry-runs, requires the owner's secrets, then deploys, in that order", async () => {
      const deploy = await workflow("vector-hosted-deploy.yml")
      for (const [job, target, directory, label] of [
        ["relay", "relay", "packages/relay", "relay"],
        ["ops", "ops", "packages/ops-worker", "ops Worker"],
      ] as const) {
        const entry = deploy.jobs[job]
        const config = at(entry, `Check the ${label}'s committed configuration`)
        const dry = at(entry, `Dry-run the ${label} deploy`)
        const secrets = at(entry, `Require the ${label}'s secrets`)
        const ship = at(entry, `Deploy the ${label}`)
        expect({ job, order: [config, dry, secrets, ship].every((value, index, all) => value > 0 && (index === 0 || value > all[index - 1]!)) })
          .toEqual({ job, order: true })
        expect(entry?.steps?.[config]?.run).toBe(`bun packages/cloud/src/hosted-workers.ts config ${target}`)
        expect(entry?.steps?.[dry]).toMatchObject({ "working-directory": directory, run: "bun run dry-run" })
        expect(entry?.steps?.[secrets]).toMatchObject({ "working-directory": directory })
        expect(entry?.steps?.[secrets]?.run).toContain(`bun run secret-names | bun ../cloud/src/hosted-workers.ts secrets ${target}`)
        expect(entry?.steps?.[ship]).toMatchObject({ "working-directory": directory, run: "bun run deploy" })
        expect(entry?.env?.WRANGLER_SEND_METRICS).toBe("false")
        // Only the secrets check and the deploy see the Cloudflare credentials.
        for (const [index, item] of (entry?.steps ?? []).entries()) {
          const sees = JSON.stringify(item).includes("secrets.")
          expect({ job, step: item.name, sees }).toEqual({ job, step: item.name, sees: index === secrets || index === ship })
        }
        for (const index of [secrets, ship])
          expect(entry?.steps?.[index]?.env).toEqual({
            CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
            CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
          })
        // The scripts it runs are exactly these wrangler commands.
        const manifest = (await Bun.file(`${root}/${directory}/package.json`).json()) as { scripts: Record<string, string> }
        expect(manifest.scripts.deploy).toBe("wrangler deploy")
        expect(manifest.scripts["secret-names"]).toBe("wrangler secret list --format json")
      }
    })

    test("never sets, changes or deletes a Worker secret, and reads only CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID", async () => {
      const text = await read(".github/workflows/vector-hosted-deploy.yml")
      const secrets = [...text.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1])
      expect(new Set(secrets)).toEqual(new Set(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]))
      const writes = /secret\s+(?:put|bulk|delete)|versions\s+secret|kv\s+key\s+put/
      const runs = Object.values((Bun.YAML.parse(text) as Workflow).jobs).flatMap((job) =>
        (job.steps ?? []).flatMap((entry) => (entry.run ? [entry.run] : [])),
      )
      expect(runs.length).toBeGreaterThan(0)
      for (const run of runs) expect({ run, writes: writes.test(run) }).toEqual({ run, writes: false })
      for (const directory of ["packages/relay", "packages/ops-worker"]) {
        const manifest = (await Bun.file(`${root}/${directory}/package.json`).json()) as { scripts: Record<string, string> }
        for (const [name, script] of Object.entries(manifest.scripts))
          expect({ directory, name, writes: writes.test(script) }).toEqual({ directory, name, writes: false })
      }
      // The checks it runs start nothing themselves: they read a file and wrangler's list of names.
      expect(await read("packages/cloud/src/hosted-workers.ts")).not.toMatch(/child_process|Bun\.spawn|\bfetch\(/)
    })
  })

  describe("vector-hosted-image.yml", () => {
    test("takes the generation and an exact CLI release, and checks them before anything is built", async () => {
      const image = await workflow("vector-hosted-image.yml")
      const inputs = (image.on.workflow_dispatch as { inputs: Record<string, { required: boolean; default?: string }> }).inputs
      expect(Object.keys(inputs).sort()).toEqual(["cli_version", "generation", "min_disk_generation"])
      expect(inputs.min_disk_generation?.default).toBe("1")
      const script = step(image.jobs.preflight, "Check the inputs")?.run
      expect(script).toBeDefined()
      const check = (generation: string, minimum: string, version: string) =>
        shell(script!, {
          VECTOR_IMAGE_GENERATION: generation,
          VECTOR_MIN_DISK_GENERATION: minimum,
          VECTOR_HOSTED_CLI_VERSION: version,
        })
      const accepted = await check("7", "3", "1.99.120")
      expect({ status: accepted.status, output: accepted.output }).toEqual({
        status: 0,
        output: "generation=7\nmin_disk_generation=3\ncli_version=1.99.120\n",
      })
      for (const [generation, minimum, version] of [
        ["0", "1", "1.99.120"],
        ["07", "1", "1.99.120"],
        ["", "1", "1.99.120"],
        ["1; echo pwned", "1", "1.99.120"],
        ["1000000", "1", "1.99.120"],
        ["3", "4", "1.99.120"],
        ["3", "0", "1.99.120"],
        ["3", "1", "latest"],
        ["3", "1", "1.99"],
        ["3", "1", "1.99.120-beta.1"],
        ["3", "1", "1.99.120\necho=1"],
      ] as const) {
        const refused = await check(generation, minimum, version)
        expect({ generation, minimum, version, status: refused.status, wrote: refused.output }).toEqual({
          generation,
          minimum,
          version,
          status: 1,
          wrote: "",
        })
      }
      // The image job reads the checked values, never the raw inputs.
      expect(image.jobs.image?.env).toEqual({
        VECTOR_IMAGE_GENERATION: "${{ needs.preflight.outputs.generation }}",
        VECTOR_MIN_DISK_GENERATION: "${{ needs.preflight.outputs.min_disk_generation }}",
      })
      expect(JSON.stringify(image.jobs.image)).not.toContain("inputs.")
    })

    test("builds, checks the image from inside, and only then pushes it and bakes the digest it pushed", async () => {
      const image = await workflow("vector-hosted-image.yml")
      const job = image.jobs.image
      const order = [
        "Build hostd and the viewer proxy for Node",
        "Take the Vector CLI from its published release",
        "Require the CLI's source on protected main",
        "Build the image",
        "Boot the image and check it from inside",
        "Push the image to the hosted team's registry",
        "Bake the base snapshot",
      ].map((name) => at(job, name))
      expect(order.every((value, index) => value > 0 && (index === 0 || value > order[index - 1]!))).toBe(true)
      expect(step(job, "Take the Vector CLI from its published release")).toMatchObject({
        run: "bun packages/cloud/src/hosted-image.ts cli --output packages/hosted-computer/bin/vector",
        env: {
          VECTOR_CLI_BLOB_ORIGIN: "${{ vars.VECTOR_CLI_BLOB_ORIGIN }}",
          VECTOR_HOSTED_CLI_VERSION: "${{ needs.preflight.outputs.cli_version }}",
        },
      })
      expect(step(job, "Require the CLI's source on protected main")?.run).toContain(
        'git merge-base --is-ancestor "$VECTOR_CLI_SOURCE" origin/main',
      )
      expect(step(job, "Build the image")?.run).toContain("docker build --platform linux/amd64 --file image/Dockerfile")
      expect(step(job, "Boot the image and check it from inside")?.run).toContain("bun test --timeout 600000 ./test/image.test.ts")
      const bake = step(job, "Bake the base snapshot")
      expect(bake?.["working-directory"]).toBe("packages/hosted-computer")
      expect(bake?.run).toContain('bun script/bake-snapshot.ts --image "$VECTOR_HOSTED_IMAGE" --generation "$VECTOR_IMAGE_GENERATION"')
      expect(bake?.env?.VECTOR_HOSTED_IMAGE).toBe("${{ steps.push.outputs.image }}")
      expect(bake?.run).toContain("GITHUB_STEP_SUMMARY")
    })

    test("the hosted team's token reaches only the push and the bake; the registry sign-in is thrown away", async () => {
      const text = await read(".github/workflows/vector-hosted-image.yml")
      const job = (await workflow("vector-hosted-image.yml")).jobs.image
      const secrets = [...text.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1])
      expect(new Set(secrets)).toEqual(new Set(["VECTOR_HOSTED_VERCEL_TOKEN"]))
      for (const item of job?.steps ?? [])
        expect({ step: item.name, sees: JSON.stringify(item).includes("secrets.") }).toEqual({
          step: item.name,
          sees: item.name === "Push the image to the hosted team's registry" || item.name === "Bake the base snapshot",
        })
      const push = step(job, "Push the image to the hosted team's registry")
      expect(push?.env?.DOCKER_CONFIG).toBe("${{ runner.temp }}/vector-registry-auth")
      expect(push?.run).toContain(`trap 'rm -rf "$DOCKER_CONFIG"' EXIT`)
      expect(push?.run).toContain("bun packages/cloud/src/hosted-image.ts login")
      // No password on a command line, and no sign-in to any other registry.
      expect(text).not.toMatch(/docker login|--password|-p "\$/)
      expect(text).not.toContain("ghcr.io")
    })

    test("refuses a generation the registry already has, or a lookup it cannot read, and hands the bake the pushed digest", async () => {
      const script = step((await workflow("vector-hosted-image.yml")).jobs.image, "Push the image to the hosted team's registry")?.run
      expect(script).toBeDefined()
      const repository = "vcr.vercel.com/vector-hosted/computers/vector-computer"
      const digest = `${repository}@sha256:${"e".repeat(64)}`
      // Stand-ins for bun (the checked helpers) and docker; the script itself runs as written.
      const stubs = `
        bun() {
          test "$1" = packages/cloud/src/hosted-image.ts || return 99
          case "$2" in
            tag) printf '%s:g%s\\n' "$VECTOR_HOSTED_IMAGE_REPOSITORY" "$VECTOR_IMAGE_GENERATION";;
            login) echo login >> "$FIXTURE_LOG";;
            digest) grep -F "$VECTOR_HOSTED_IMAGE_REPOSITORY@sha256:" | head -n 1;;
            *) return 98;;
          esac
        }
        docker() {
          echo "docker $*" >> "$FIXTURE_LOG"
          case "$1 $2" in
            "manifest inspect") case "$FIXTURE_REGISTRY" in present) return 0;; absent) echo "manifest unknown" >&2; return 1;; *) echo "unauthorized" >&2; return 1;; esac;;
            "inspect --format") printf '%s\\n' "$FIXTURE_DIGEST";;
          esac
        }`
      const run = async (registry: string) => {
        const directory = await mkdtemp(path.join(tmpdir(), "vector-hosted-push-"))
        const log = path.join(directory, "log")
        await writeFile(log, "")
        try {
          const result = await shell(`${stubs}\n${script}`, {
            VECTOR_HOSTED_IMAGE_REPOSITORY: repository,
            VECTOR_IMAGE_GENERATION: "7",
            DOCKER_CONFIG: path.join(directory, "auth"),
            FIXTURE_LOG: log,
            FIXTURE_REGISTRY: registry,
            FIXTURE_DIGEST: digest,
          })
          return { ...result, log: await readFile(log, "utf8") }
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      }
      const pushed = await run("absent")
      expect({ status: pushed.status, output: pushed.output }).toEqual({ status: 0, output: `image=${digest}\n` })
      expect(pushed.log).toContain(`docker push ${repository}:g7`)
      expect(pushed.log.indexOf("login")).toBeLessThan(pushed.log.indexOf("docker manifest inspect"))
      for (const registry of ["present", "unreadable"]) {
        const refused = await run(registry)
        expect({ registry, status: refused.status, pushed: refused.log.includes("docker push"), output: refused.output }).toEqual({
          registry,
          status: 1,
          pushed: false,
          output: "",
        })
      }
    })
  })
})
