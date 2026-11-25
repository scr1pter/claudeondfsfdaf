import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { assets } from "./windows-holder-ci"
import { windowsHolderBundlePlugin } from "./windows-holder-bundle"

const temporary = process.env.RUNNER_TEMP!
const directory = await mkdtemp(path.join(temporary, "vector-holder-build-check-"))
const entry = fileURLToPath(new URL("../test/fixture/windows-holder-bundle.ts", import.meta.url))
const plugins = [windowsHolderBundlePlugin(assets, ["x64"])]
const node = Bun.which("node")
if (!node) throw new Error("Node is required to verify the Windows Desktop engine bundle.")
const run = promisify(execFile)
const env = {
  CI: "true",
  GITHUB_JOB: process.env.GITHUB_JOB,
  RUNNER_ENVIRONMENT: process.env.RUNNER_ENVIRONMENT,
  SystemRoot: "C:\\Windows",
  WINDIR: "C:\\Windows",
  TEMP: directory,
  TMP: directory,
  VECTOR_WINDOWS_HOLDER_BUNDLE_CHECK: "1",
}
try {
  const nodeBundle = await Bun.build({
    entrypoints: [entry],
    target: "node",
    format: "esm",
    naming: "holder-node.mjs",
    outdir: directory,
    plugins,
  })
  if (!nodeBundle.success || nodeBundle.outputs.length !== 1) throw new Error("Could not build the Node holder check.")
  await run(node, [nodeBundle.outputs[0]!.path], { env, windowsHide: true, timeout: 30_000, maxBuffer: 4096 })

  const outfile = path.join(directory, "holder-bun.exe")
  const bunBundle = await Bun.build({
    entrypoints: [entry],
    plugins,
    compile: { target: "bun-windows-x64", outfile, autoloadDotenv: false, autoloadBunfig: false },
  })
  if (!bunBundle.success) throw new Error("Could not build the standalone holder check.")
  await run(outfile, [], { env, windowsHide: true, timeout: 30_000, maxBuffer: 4096 })
  console.log("The verified Windows holder ran through both the Node and standalone Bun bundles.")
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 })
}
