import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PtyProcess } from "../../src/pty/process"

// F8: a terminal's foreground group is read with the fixed /bin/ps, never a `ps` found on PATH, which a repository's
// folder may lead with. POSIX only, as foreground() is.
describe.skipIf(process.platform === "win32")("PtyProcess.foreground", () => {
  test("reads a positive group for a running pid with /bin/ps, never a ps found on PATH", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vector-pty-process-"))
    try {
      const marker = path.join(dir, "ran")
      await fs.writeFile(path.join(dir, "ps"), `#!/bin/sh\ntouch "${marker}"\necho 1\n`, { mode: 0o755 })
      // A child of its own, started with the fake first on PATH: the runtime resolves a bare name from the PATH it
      // started with, so changing this process's PATH would not reach it.
      const child = spawnSync(
        process.execPath,
        [
          "-e",
          `const { PtyProcess } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/pty/process.ts"))}); console.log(PtyProcess.foreground(process.pid))`,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
          timeout: 10_000,
        },
      )
      expect(child.status).toBe(0)
      const group = Number(child.stdout.trim())
      expect(Number.isInteger(group) && group > 0).toBe(true)
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("returns a pid that is not usable unchanged", () => {
    expect(PtyProcess.foreground(-1)).toBe(-1)
    expect(PtyProcess.foreground(0)).toBe(0)
  })
})
