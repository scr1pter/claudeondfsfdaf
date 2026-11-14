import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

test("an isolation planning refusal is a typed spawn error and never launches the payload", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vector-isolation-spawn-"))
  try {
    const marker = path.join(directory, "payload-started")
    const child = Bun.spawn([
      process.execPath,
      "--no-env-file",
      fileURLToPath(new URL("../fixture/process-isolation-spawn.ts", import.meta.url)),
      marker,
    ], { stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(JSON.parse(stdout)).toMatchObject({ refused: true })
    expect(JSON.parse(stdout).message).toContain("native loader environment")
    expect(await Bun.file(marker).exists()).toBe(false)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 15_000)
