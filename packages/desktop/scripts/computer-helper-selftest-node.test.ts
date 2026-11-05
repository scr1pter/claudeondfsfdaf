import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { buildNodeSelfTest } from "./computer-helper-selftest-node"

const packageDir = fileURLToPath(new URL("../", import.meta.url))

test("the actual Node bundle preserves source roots, rejects unsupported usage, and leaves C1 inputs unchanged", async () => {
  const fixtures = path.join(packageDir, "test/fixtures/computer-protocol")
  const files = [
    "native/computer-helper/identity.json",
    "native/computer-helper/blocklist.json",
    ...(await readdir(fixtures))
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => `test/fixtures/computer-protocol/${name}`),
  ]
  const before = await Promise.all(files.map((file) => readFile(path.join(packageDir, file), "utf8")))
  const base = path.join(packageDir, "native/build")
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(path.join(base, "selftest-node-test-"))
  try {
    const bootstrap = await buildNodeSelfTest(directory)
    const imported = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        'const driver = await import(process.argv[1]); console.log(JSON.stringify(driver.parseSelfTestArgs([], "darwin", "arm64")))',
        pathToFileURL(path.join(directory, "driver.mjs")).href,
      ],
      { encoding: "utf8", timeout: 10_000 },
    )
    expect(imported.error).toBeUndefined()
    expect(imported.status, imported.stderr).toBe(0)
    const defaults = JSON.parse(imported.stdout)
    expect(defaults.bin).toBe(
      path.join(packageDir, "native/out/darwin/VectorComputer.app/Contents/MacOS/VectorComputer"),
    )
    expect(defaults.tests).toBe(path.join(packageDir, "native/out/darwin/tests"))
    expect(defaults.fixtures).toBe(fixtures)
    expect(defaults.privileged).toBe("off")
    const usage = spawnSync("node", [bootstrap, "--platform", "unsupported"], { encoding: "utf8", timeout: 10_000 })
    expect(usage.error).toBeUndefined()
    expect(usage.status).toBe(2)
    expect(usage.stdout).toBe("")
    expect(usage.stderr).toBe(
      "Computer helper self-test could not run. Check native host, build outputs and arguments.\n",
    )
    expect(await Promise.all(files.map((file) => readFile(path.join(packageDir, file), "utf8")))).toEqual(before)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
