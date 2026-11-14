import { describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { browserInputPath } from "./browser-bundle-path"

// Nothing the browser bundles may import a Node or Bun module (script/browser-imports.ts says why). The walk runs in
// a process of its own, away from the test runner's module resolution.

const ROOT = path.resolve(import.meta.dir, "../../..")

describe("the app's browser bundle", () => {
  test("resolves cross-drive Bun input paths without prefixing the checkout drive", () => {
    const directory = "D:\\a\\Vectordev.ai\\Vectordev.ai\\packages\\app"
    expect(browserInputPath("../../../../../../C:/Users/runner/Temp/worker #1%20.ts", directory, path.win32)).toBe(
      "C:\\Users\\runner\\Temp\\worker #1%20.ts",
    )
    expect(browserInputPath("..\\..\\C:\\Temp\\worker.ts", directory, path.win32)).toBe("C:\\Temp\\worker.ts")
    expect(browserInputPath("src/entry.tsx", directory, path.win32)).toBe(`${directory}\\src\\entry.tsx`)
    expect(browserInputPath("C:/Temp/worker.ts", directory, path.win32)).toBe("C:\\Temp\\worker.ts")
    expect(browserInputPath("../../C:/worker.ts", "/repo/packages/app", path.posix)).toBe("/repo/C:/worker.ts")
  })

  test("imports no Node or Bun module, through any package", async () => {
    const result = await walk()
    // The walk reaches both pages, core and the workers, so an empty list means something.
    expect(result.modules).toEqual(
      expect.arrayContaining([
        "packages/app/src/entry.tsx",
        "packages/desktop/src/renderer/index.tsx",
        "packages/core/src/model-plan-status.ts",
        "packages/core/src/local-mode/policy.ts",
        "packages/core/src/local-mode/sources.ts",
        // config.ts reads zdrAttested's attestation objects through it (VS-33).
        "packages/core/src/review/privacy.ts",
        "packages/app/src/workers/local-transcription.worker.ts",
        "packages/session-ui/src/components/markdown-shiki.worker.ts",
      ]),
    )
    expect(result.runtime).toEqual([])
    expect(result.code).toBe(0)
  })

  test("names the file that pulls in a Node module", async () => {
    // Core's egress layer is Node only; reaching it from the app is what broke the 1.99.111 build.
    const result = await walk(path.join(ROOT, "packages/core/src/local-mode/egress.ts"))
    expect(result.runtime).toContain("packages/core/src/local-mode/attribution.ts imports node:async_hooks")
    expect(result.code).toBe(1)
  })

  test("still refuses bare Node, node-prefixed and Bun imports in a worker", async () => {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "vector-browser-guard-")))
    try {
      const entry = path.join(directory, "entry.ts")
      const worker = path.join(directory, "worker.ts")
      await Bun.write(entry, 'new Worker(new URL("./worker.ts", import.meta.url))\n')
      await Bun.write(
        worker,
        'import fs from "fs"; import promises from "node:fs/promises"; import { serve } from "bun"; console.log(fs, promises, serve)\n',
      )
      const result = await walk(entry)
      const name = path.relative(ROOT, worker).replaceAll(path.sep, "/")
      expect(result.modules).toContain(name)
      expect(result.runtime).toEqual([`${name} imports bun`, `${name} imports fs`, `${name} imports node:fs/promises`])
      expect(result.code).toBe(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

async function walk(...entries: string[]) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../script/browser-imports.ts"), ...entries], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(stderr).toBe("")
  const graph: { modules: string[]; runtime: string[] } = JSON.parse(stdout)
  return { ...graph, code }
}
