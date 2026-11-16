import path from "node:path"
import type { BunPlugin } from "bun"

// The brain's background reader as one module of source: core's worker/entry.ts bundled for Node, carried as the
// virtual module brain-worker.gen.ts and started as an eval worker. ESM, because pdf.js inside it uses import.meta and
// Node runs an eval worker with module syntax as a module. It carries the build's version and channel like the rest of
// the build, so the egress guard inside it knows it runs in a build of Vector and ignores the test variables
// (EgressGuard.strictFromEnvironment), which whatever starts Vector could set. build.ts, build-node.ts and the brain worker
// smoke all bundle it here.
export async function bundleBrainWorker(
  build: { readonly version: string; readonly channel: string },
  isolation: BunPlugin,
) {
  const bundled = await Bun.build({
    entrypoints: [path.join(import.meta.dirname, "../../core/src/brain/worker/entry.ts")],
    target: "node",
    format: "esm",
    minify: true,
    plugins: [isolation],
    define: { VECTOR_VERSION: JSON.stringify(build.version), VECTOR_CHANNEL: JSON.stringify(build.channel) },
  })
  if (!bundled.success) throw new AggregateError(bundled.logs, "The brain worker bundle failed to build")
  return bundled.outputs[0]!.text()
}
