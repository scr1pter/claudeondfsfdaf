import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

test("local transcription URL assets bypass dependency optimization on a cold Vite server", async () => {
  const { createServer } = await import("vite")
  // Stop the same service Vite loaded, even when another workspace resolves a different esbuild version.
  const viteRequire = createRequire(import.meta.resolve("vite"))
  const esbuild: { stop(): void | Promise<void> } = viteRequire("esbuild")
  const root = fileURLToPath(new URL("../../", import.meta.url))
  const cacheDir = await mkdtemp(path.join(tmpdir(), "vector-vite-assets-"))
  const server = await createServer({
    root,
    cacheDir,
    server: { middlewareMode: true, watch: null },
    optimizeDeps: { entries: [] },
  })
  try {
    const client = server.environments.client
    const worker = path.join(root, "src/workers/local-transcription.worker.ts")
    for (const extension of ["wasm", "mjs"]) {
      const resolved = await client.pluginContainer.resolveId(
        `onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.${extension}?url`,
        worker,
      )
      expect(resolved?.id).toEndWith(`.asyncify.${extension}?url`)
      const result = await server.transformRequest(resolved!.id)
      expect(result?.code).toContain("export default")
      expect(result?.code).toContain(`/ort-wasm-simd-threaded.asyncify.${extension}`)
      expect(result?.code).not.toContain("cdn.jsdelivr.net")
      expect(result?.code).not.toContain("/deps/")
    }
    const library = await client.pluginContainer.resolveId("@huggingface/transformers", worker)
    expect(library?.id).toContain("/deps/@huggingface_transformers.js")
  } finally {
    try {
      await server.close()
    } finally {
      try {
        // Bun on Windows can retain this service after a passing test and a closed middleware server.
        await esbuild.stop()
      } finally {
        await rm(cacheDir, { recursive: true, force: true })
      }
    }
  }
}, 10_000)
