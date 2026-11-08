import { describe, expect, test } from "bun:test"

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
