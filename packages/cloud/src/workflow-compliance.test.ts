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
