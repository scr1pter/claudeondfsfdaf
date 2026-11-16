import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

test("the hosted account gateway bundles and imports under actual Node without Bun globals", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vector-workspaces-node-"))
  try {
    const result = await Bun.build({
      entrypoints: [path.resolve(import.meta.dirname, "../api/cloud-workspaces.ts")],
      target: "node",
      format: "esm",
      outdir: directory,
      naming: "gateway.mjs",
    })
    expect(result.success).toBe(true)
    const child = Bun.spawn(
      [
        "node",
        "--input-type=module",
        "--eval",
        `const module = await import(${JSON.stringify(pathToFileURL(path.join(directory, "gateway.mjs")).href)}); if (typeof module.default !== 'function') throw new Error('No handler'); console.log('workspace-node-import-ok')`,
      ],
      {
        env: { ...process.env, NODE_OPTIONS: "", NODE_ENV: "test" },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout.trim()).toBe("workspace-node-import-ok")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test("the dedicated cloud worker refuses startup before importing an engine without a supervisor credential", async () => {
  const child = Bun.spawn(
    ["node", path.resolve(import.meta.dirname, "../packages/cloud-workspaces/worker/entry.mjs")],
    {
      env: { ...process.env, VECTOR_CLOUD_WORKSPACE_WORKER: "", VECTOR_SERVER_PASSWORD: "", NODE_OPTIONS: "" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(code).not.toBe(0)
  expect(stderr).toContain("requires its workspace supervisor")
  expect(stderr).not.toContain("ERR_MODULE_NOT_FOUND")
})
