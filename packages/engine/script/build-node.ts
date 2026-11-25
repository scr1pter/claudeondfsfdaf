#!/usr/bin/env bun

import { Script } from "@vectordevai/script"
import { prepareGitLab } from "../../../script/prepare-gitlab"
import { linuxIsolationBuildPlugin, linuxIsolationCIMode } from "../../../script/linux-isolation-asset"
import { unguardedBunReferences } from "./node-bundle-guard"
import { brainWorkerModule } from "./brain-worker-module"
import { bundleBrainWorker } from "./brain-worker"
import {
  emitWindowsHolderCompanion,
  prepareWindowsHolderBundle,
  windowsHolderBundlePlugin,
} from "./windows-holder-bundle"
import desktop from "../../desktop/package.json"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const windowsHolderArchitectures = ["x64", "arm64"] as const
const windowsHolderDirectory = path.join(dir, "dist/node/windows-holder")
await rm(windowsHolderDirectory, { recursive: true, force: true })
const manifestSha256 = process.env.VECTOR_WINDOWS_HOLDER_MANIFEST_SHA256
const windowsHolderAssets = await prepareWindowsHolderBundle({
  argv: process.argv,
  githubActions: process.env.GITHUB_ACTIONS,
  declaredRevision: process.env.VECTOR_SOURCE_REVISION,
  architectures: windowsHolderArchitectures,
  manifestPath: process.env.VECTOR_WINDOWS_HOLDER_MANIFEST,
  manifestDigest: manifestSha256,
  expectedWire: "vsh1",
})
const windowsHolderCompanion =
  windowsHolderAssets && process.argv.includes("--windows-holder-electron")
    ? await stageWindowsHolderCompanion(windowsHolderAssets)
    : undefined

const generated = await import("./generate.ts")

await prepareGitLab()

// Keep the worker build identity and the base64 transport used by Electron.
const isolation = await linuxIsolationBuildPlugin(linuxIsolationCIMode(process.argv, process.env.GITHUB_ACTIONS))
const brainWorker = await bundleBrainWorker({ version: Script.version, channel: Script.channel }, isolation)

const result = await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser", "@lydell/node-pty"],
  plugins: [
    isolation,
    ...(windowsHolderAssets
      ? [windowsHolderBundlePlugin(windowsHolderAssets, windowsHolderArchitectures, windowsHolderCompanion)]
      : []),
  ],
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

if (windowsHolderCompanion) {
  await writeFile(
    path.join(windowsHolderDirectory, "desktop-build.json"),
    JSON.stringify({ version: 1, manifestSha256, targets: windowsHolderCompanion.targets }),
    { flag: "wx" },
  )
}

console.log("Build complete")

async function stageWindowsHolderCompanion(assets: NonNullable<typeof windowsHolderAssets>) {
  if (!manifestSha256) throw new Error("Electron holder packaging requires the pinned build manifest.")
  await mkdir(windowsHolderDirectory, { recursive: true })
  const targets = await Promise.all(
    windowsHolderArchitectures.map(async (arch) => {
      const asset = assets[arch]
      if (!asset) throw new Error("A required Electron holder architecture is missing.")
      return [arch, await emitWindowsHolderCompanion(windowsHolderDirectory, asset)] as const
    }),
  )
  return { placement: "electron" as const, targets: Object.fromEntries(targets) }
}
