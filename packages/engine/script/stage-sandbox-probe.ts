import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { sandboxProbeTarget } from "./sandbox-probe-target"
import { sandboxBunUndici } from "./sandbox-bun-undici"

// CI-only packaging: include the actual ShellTool and its runtime assets in the immutable disposable probe.
const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
process.chdir(engine)
const output = path.join(process.env.RUNNER_TEMP!, "vector-probe-tools")
if (!process.env.RUNNER_TEMP || !path.isAbsolute(output)) throw new Error("Missing probe output directory")
const runtime = process.argv[2] ?? "node"
if (runtime !== "node" && runtime !== "bun") throw new Error("Unsupported probe runtime")
const undici = runtime === "bun" ? await sandboxBunUndici(engine) : undefined
// Different targets run in separate Bun invocations; a runtime's resolver/file cache cannot select the other's adapter.
const result = await Bun.build({
  ...sandboxProbeTarget(runtime),
  entrypoints: [path.join(engine, "test/fixture/sandbox-probe.ts")],
  outdir: output,
  tsconfig: path.join(engine, "tsconfig.json"),
  format: "esm",
  plugins: [
    ...(undici ? [undici.plugin] : []),
    {
      name: "installed-jsonc-esm",
      setup(build) {
        // jsonc-parser's UMD factory passes require as an argument, hiding its relative imports from the bundler.
        // Resolve the same installed package's equivalent ESM entry, preserving its actual parser implementation.
        build.onResolve({ filter: /^jsonc-parser$/ }, (args) => ({
          path: Bun.resolveSync("jsonc-parser/lib/esm/main.js", args.resolveDir || engine),
        }))
      },
    },
  ],
  files: {
    // Brain is not part of this tool-process test; requesting its omitted worker must not start inference.
    "brain-worker.gen.ts": "export default undefined",
    "vector-web-ui.gen.ts": "export default {}",
  },
  define: {
    VECTOR_MODEL_CATALOG: "{}",
    VECTOR_VERSION: JSON.stringify("0.0.0-sandbox-probe"),
    VECTOR_CHANNEL: JSON.stringify("dev"),
    VECTOR_PLUGIN_VERSION: JSON.stringify("0.0.0-sandbox-probe"),
  },
})
if (!result.success) throw new AggregateError(result.logs, `The actual ${runtime} tool probe did not build`)
const artifacts = result.outputs.map((item) => path.relative(output, item.path))
if (undici) {
  await Bun.write(path.join(output, undici.asset), undici.contents)
  artifacts.push(undici.asset)
}
if (runtime === "node") {
  const guard = await Bun.build({
    target: "node",
    entrypoints: [path.join(engine, "src/cli/cmd/github.secrets.ts")],
    outdir: output,
    naming: { entry: "inspector-guard.mjs" },
    format: "esm",
  })
  if (!guard.success) throw new AggregateError(guard.logs, "The private-channel inspector guard did not build")
}
await fs.writeFile(
  path.join(output, runtime === "bun" ? "tool-probe-outputs-bun.json" : "tool-probe-outputs.json"),
  JSON.stringify([...new Set(artifacts)].sort()),
)
console.log(`Built actual ${runtime} ShellTool probe with ${new Set(artifacts).size} runtime files`)
