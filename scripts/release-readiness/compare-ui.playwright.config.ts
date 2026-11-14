import config from "../../packages/app/e2e/performance/playwright.config"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = process.env.VECTOR_BENCHMARK_BUILD_ROOT
const output = process.env.VECTOR_BENCHMARK_OUTPUT
if (!root || !output) throw new Error("Set VECTOR_BENCHMARK_BUILD_ROOT and VECTOR_BENCHMARK_OUTPUT explicitly")
const app = resolve(root, "packages/app")
if (!existsSync(resolve(app, "package.json"))) throw new Error("Benchmark build root must contain packages/app")

// Both arms use this checkout's pinned harness; only the production build changes.
export default {
  ...config,
  testDir: fileURLToPath(new URL("../../packages/app/e2e/performance", import.meta.url)),
  outputDir: resolve(output, "test-results"),
  reporter: [["line"]],
  webServer: {
    ...config.webServer,
    cwd: app,
  },
}
