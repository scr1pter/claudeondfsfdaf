import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { assets } from "./windows-holder-ci"
import { emitWindowsHolderCompanion, windowsHolderBundlePlugin } from "./windows-holder-bundle"
import { windowsHolderCompanionName } from "../src/tool/shell/windows-holder-companion-name"

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

  const asset = assets.x64
  if (!asset) throw new Error("The Windows bundle check is missing its x64 companion.")
  const companion = await emitWindowsHolderCompanion(directory, asset)
  const outfile = path.join(directory, "holder-bun.exe")
  const bunBundle = await Bun.build({
    entrypoints: [entry],
    plugins: [windowsHolderBundlePlugin(assets, ["x64"], { placement: "cli", targets: { x64: companion } })],
    compile: { target: "bun-windows-x64", outfile, autoloadDotenv: false, autoloadBunfig: false },
  })
  if (!bunBundle.success) throw new Error("Could not build the standalone holder check.")
  const runStandalone = () =>
    run(outfile, [], {
      env: { ...env, VECTOR_WINDOWS_HOLDER_BUNDLE_CHECK: "direct" },
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 4096,
    })
  await runStandalone()
  const companionFile = path.join(directory, windowsHolderCompanionName(companion.arch, companion.sha256))
  await rm(companionFile)
  await requireRejection(runStandalone())
  await writeFile(companionFile, Buffer.alloc(companion.size), { flag: "wx" })
  await requireRejection(runStandalone())
  console.log("The verified Windows holder ran through the Node carrier and the standalone Bun companion.")
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 })
}

async function requireRejection(result: Promise<unknown>) {
  try {
    await result
  } catch (error) {
    if (
      error instanceof Error &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      error.stderr.includes("The installed Windows containment helper failed verification")
    ) {
      return
    }
    throw error
  }
  throw new Error("The standalone engine ran with a missing or changed Windows holder.")
}
