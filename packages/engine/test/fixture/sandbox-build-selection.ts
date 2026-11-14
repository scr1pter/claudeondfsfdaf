import path from "node:path"
import { fileURLToPath } from "node:url"
import { sandboxProbeTarget } from "../../script/sandbox-probe-target"

const runtime = process.argv[2]
if (runtime !== "node" && runtime !== "bun") throw new Error("Unsupported fixture build runtime")
const output = process.argv[3]
if (!output || !path.isAbsolute(output)) throw new Error("Missing private fixture output")
// Compile actual Core imports only. The output and every native/helper entry remain unexecuted.
const build = await Bun.build({
  ...sandboxProbeTarget(runtime),
  entrypoints: [fileURLToPath(new URL("../../../core/src/database/database.ts", import.meta.url))],
  outdir: output,
  format: "esm",
})
if (!build.success) throw new AggregateError(build.logs, "The matching Core database fixture did not build")
const entry = build.outputs.find((value) => value.kind === "entry-point")
if (!entry) throw new Error("Missing Core fixture entry")
const text = await entry.text()
console.log(
  JSON.stringify({
    runtime,
    file: path.basename(entry.path),
    nodeSqlite: text.includes("node:sqlite"),
    bunSqlite: text.includes("bun:sqlite"),
  }),
)
