import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../../..")

test.skipIf(process.platform === "win32")("desktop preparation refuses missing matching npm packages", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(path.join(root, ".github/workflows/vector-desktop-release.yml")).text(),
  ) as {
    jobs: { prepare: { steps: { name: string; run?: string }[] } }
  }
  const script = workflow.jobs.prepare.steps.find(
    (step) => step.name === "Require published CLI and plugin packages",
  )?.run
  expect(script).toBeString()
  const directory = await mkdtemp(path.join(os.tmpdir(), "vector-release-prerequisites-"))
  try {
    await Bun.write(
      path.join(directory, "packages/desktop/package.json"),
      '{"version":"1.2.3","vectorRequiredCliVersion":"4.5.6"}',
    )
    const npm = path.join(directory, "bin/npm")
    await Bun.write(
      npm,
      `#!/usr/bin/env node
const fs = require("node:fs")
fs.appendFileSync(${JSON.stringify(path.join(directory, "requests"))}, process.argv[3] + "\\n")
if (process.argv[3] === process.env.MISSING_PACKAGE) process.exit(1)
console.log(JSON.stringify(process.argv[3].slice(process.argv[3].lastIndexOf("@") + 1)))
`,
    )
    await chmod(npm, 0o755)
    for (const missing of ["", "@vectordevai/plugin@4.5.6", "@vectordevai/cli-linux-arm64@4.5.6"]) {
      const child = Bun.spawn(["bash", "-c", script!], {
        cwd: directory,
        env: { PATH: path.dirname(npm) + path.delimiter + process.env.PATH, HOME: directory, MISSING_PACKAGE: missing },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, stderr).toBe(missing ? 1 : 0)
      if (missing) expect(stdout).toContain(`Publish ${missing} before starting the desktop release.`)
    }
    const requested = await Bun.file(path.join(directory, "requests")).text()
    // The plugin SDK publishes with the CLI, so the desktop requires it at the CLI version, not its own.
    expect(requested).toContain("@vectordevai/plugin@4.5.6")
    expect(requested).not.toContain("@1.2.3")
    expect(requested).toContain("@vectordevai/cli-windows-x64@4.5.6")
    expect(requested).toContain("@vectordevai/cli-windows-arm64@4.5.6")
    expect(requested).not.toContain("@null")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("the prototype CLI cannot collide with the public CLI package", async () => {
  const manifest = await Bun.file(path.join(root, "packages/cli/package.json")).json()
  expect(manifest.private).toBe(true)
  expect(manifest.name).toBe("@vectordevai/cli-dev")
  expect(await Bun.file(path.join(root, "packages/cli/script/publish.ts")).exists()).toBe(false)
})

test("the desktop release installs ripgrep before it runs the engine suite", async () => {
  // test/preload.ts runs the suite under the strict network guard, which refuses Vector's own ripgrep download, so the
  // tests that search files need rg on PATH, and GitHub's Ubuntu image has none.
  const workflow = Bun.YAML.parse(
    await Bun.file(path.join(root, ".github/workflows/vector-desktop-release.yml")).text(),
  ) as {
    jobs: {
      test: {
        strategy: { matrix: { include: { name: string; directory: string }[] } }
        steps: { name: string; if?: string; run?: string }[]
      }
    }
  }
  const job = workflow.jobs.test
  // The engine suite may run in shards; the install's condition has to cover every one of them.
  const engine = job.strategy.matrix.include.filter((entry) => entry.directory === "packages/engine")
  expect(engine.length).toBeGreaterThan(0)
  const install = job.steps.findIndex((step) => /apt-get install\b.*\bripgrep\b/.test(step.run ?? ""))
  expect(install).toBeGreaterThan(-1)
  expect(install).toBeLessThan(job.steps.findIndex((step) => step.name === "Run package tests"))
  const condition = job.steps[install].if
  const prefix = condition?.match(/^startsWith\(matrix\.name, '([^']+)'\)$/)?.[1]
  const exact = condition?.match(/^matrix\.name == '([^']+)'$/)?.[1]
  expect(condition === undefined || prefix !== undefined || exact !== undefined).toBe(true)
  for (const entry of engine)
    expect(condition === undefined || entry.name.startsWith(prefix ?? "\0") || entry.name === exact).toBe(true)
})
