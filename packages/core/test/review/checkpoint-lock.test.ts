import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { ReviewCheckpointLock } from "../../src/review/checkpoint-lock"

const linux = test.skipIf(process.platform !== "linux")
let temporary: string
let nodeWorker: string
let nodeRaces: string
const originalWorker = path.resolve(import.meta.dir, "../fixture/review-checkpoint-writer.ts")
beforeAll(async () => {
  if (process.platform !== "linux") return
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sf28-checkpoint-tests-"))
  nodeWorker = path.join(temporary, "node-worker.mjs")
  nodeRaces = path.join(temporary, "node-races.mjs")
  const built = await Bun.build({
    entrypoints: [originalWorker, path.resolve(import.meta.dir, "../fixture/review-checkpoint-races.ts")],
    target: "node",
    format: "esm",
  })
  if (!built.success || built.outputs.length !== 2) throw new Error(String(built.logs))
  for (const output of built.outputs) {
    const source = await output.text()
    expect(source).toContain('from "node:sqlite"')
    expect(source).not.toContain('from "bun:sqlite"')
    const destination = path.basename(output.path) === "review-checkpoint-writer.js" ? nodeWorker : nodeRaces
    await fs.writeFile(destination, source, { mode: 0o600 })
  }
})
afterAll(async () => {
  if (temporary) await fs.rm(temporary, { recursive: true, force: true })
})

linux("aborted same-process fd aliases never close the Bun holder's locked inode", async () => {
  const directory = await fs.mkdtemp(path.join(temporary, "aliases-"))
  const first = await ReviewCheckpointLock.acquire("feature.json", { dir: directory })
  try {
    await expect(
      ReviewCheckpointLock.acquire("feature.json", { dir: first.directory, signal: AbortSignal.timeout(80) }),
    ).rejects.toBeDefined()
    const contender = Bun.spawnSync(["node", nodeWorker, directory, "300"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    })
    expect(contender.exitCode).toBe(0)
    const events = contender.stdout
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(events).toEqual([
      { event: "waiting", runtime: "node", pid: expect.any(Number) },
      { event: "aborted", runtime: "node", pid: expect.any(Number) },
    ])
  } finally {
    await first.release()
  }
})

for (const scenario of ["crash", "suspend", "drain"])
  linux(`real Node/Bun checkpoint writers: ${scenario}`, async () => {
    const directory = await fs.mkdtemp(path.join(temporary, `${scenario}-`))
    const parent = scenario === "drain" ? "node" : "python"
    const command =
      scenario === "drain"
        ? ["node", nodeRaces, scenario, directory, process.execPath, originalWorker, nodeWorker]
        : [
            "python3",
            path.resolve(import.meta.dir, "../fixture/review-checkpoint-races.py"),
            scenario,
            directory,
            process.execPath,
            originalWorker,
            nodeWorker,
            "node",
          ]
    const result = Bun.spawnSync(command, {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 12000,
    })
    expect(result.stderr.toString()).toBe("")
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual({ scenario, passed: true, parent, drivers: ["node", "bun"] })
  })
