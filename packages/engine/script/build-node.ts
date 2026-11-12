#!/usr/bin/env bun

import { Script } from "@vectordevai/script"
import { prepareGitLab } from "../../../script/prepare-gitlab"
import { linuxIsolationBuildPlugin, linuxIsolationCIMode } from "../../../script/linux-isolation-asset"
import { unguardedBunReferences } from "./node-bundle-guard"
import { brainWorkerModule } from "./brain-worker-module"
import { bundleBrainWorker } from "./brain-worker"
import desktop from "../../desktop/package.json"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

await prepareGitLab()

// Keep the worker build identity and the base64 transport used by Electron.
const brainWorker = await bundleBrainWorker({ version: Script.version, channel: Script.channel })
const isolation = await linuxIsolationBuildPlugin(linuxIsolationCIMode(process.argv, process.env.GITHUB_ACTIONS))

const result = await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser", "@lydell/node-pty"],
  plugins: [isolation],
  define: {
    VECTOR_MODEL_CATALOG: generated.modelsData,
    VECTOR_CHANNEL: `'${Script.channel}'`,
    VECTOR_VERSION: `'${Script.version}'`,
    // The desktop installs the plugin SDK published with the CLI it requires, not one at its own version: a desktop
    // release can ship without an npm publication, and local builds carry a 0.0.0 preview version npm never has.
    VECTOR_PLUGIN_VERSION: JSON.stringify(
      process.env.VECTOR_PLUGIN_VERSION ?? process.env.VECTOR_REQUIRED_CLI_VERSION ?? desktop.vectorRequiredCliVersion,
    ),
  },
  files: {
    "vector-web-ui.gen.ts": "",
    // The brain's background reader, started from this string as an eval worker inside Electron's utility process.
    "brain-worker.gen.ts": brainWorkerModule(brainWorker),
  },
})

// The desktop app runs this bundle on Node.js, where any Bun API it reaches throws "Bun is not defined".
for (const output of result.outputs.filter((item) => item.path.endsWith(".js"))) {
  const unguarded = unguardedBunReferences(await output.text())
  if (!unguarded.length) continue
  throw new Error(
    [
      `${path.relative(dir, output.path)} uses Bun-only APIs that throw on Node.js. Use a Node API, guard the reference with typeof Bun on the same line, or add a commented entry to script/node-bundle-guard.ts:`,
      ...unguarded.map((item) => `  ${item.module || "(unknown module)"}: ${item.api} (bundle line ${item.line})`),
    ].join("\n"),
  )
}

console.log("Build complete")
