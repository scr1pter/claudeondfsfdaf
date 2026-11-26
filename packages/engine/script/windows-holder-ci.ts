import { realpath } from "node:fs/promises"
import path from "node:path"
import {
  emitWindowsHolderCompanion,
  verifyWindowsHolderBundle,
  windowsHolderBundlePlugin,
} from "./windows-holder-bundle"

const { CI, GITHUB_JOB, GITHUB_RUN_ID, GITHUB_SHA, RUNNER_ARCH, RUNNER_ENVIRONMENT, RUNNER_TEMP } = process.env
const { VECTOR_WINDOWS_HOLDER_BUILD_RUN, VECTOR_WINDOWS_HOLDER_REVISION, VECTOR_WINDOWS_HOLDER_MANIFEST_SHA256 } =
  process.env
const arch = GITHUB_JOB === "engine-windows" ? "x64" : process.env.VECTOR_WINDOWS_HOLDER_ARCH
if (
  process.platform !== "win32" ||
  (arch !== "x64" && arch !== "arm64") ||
  process.arch !== arch ||
  CI !== "true" ||
  (GITHUB_JOB !== "engine-windows" && GITHUB_JOB !== "native") ||
  (process.env.SystemRoot ?? process.env.SYSTEMROOT)?.toLowerCase() !== "c:\\windows" ||
  RUNNER_ARCH !== arch.toUpperCase() ||
  RUNNER_ENVIRONMENT !== "github-hosted" ||
  !RUNNER_TEMP ||
  !/^[a-z]:\\/i.test(RUNNER_TEMP) ||
  path.win32.normalize(RUNNER_TEMP) !== RUNNER_TEMP ||
  !/^[1-9][0-9]{0,29}$/.test(GITHUB_RUN_ID ?? "") ||
  VECTOR_WINDOWS_HOLDER_BUILD_RUN !== GITHUB_RUN_ID ||
  !GITHUB_SHA ||
  VECTOR_WINDOWS_HOLDER_REVISION !== GITHUB_SHA ||
  !VECTOR_WINDOWS_HOLDER_MANIFEST_SHA256 ||
  !/^[a-f0-9]{64}$/.test(VECTOR_WINDOWS_HOLDER_MANIFEST_SHA256)
) {
  throw new Error("Windows Engine CI requires the verified holder bundle from its own build.")
}

const architectures = [arch] as const
export const assets = await verifyWindowsHolderBundle({
  manifest: path.join(RUNNER_TEMP, "vector-windows-holder-bundle", "manifest.json"),
  pin: VECTOR_WINDOWS_HOLDER_MANIFEST_SHA256,
  checkout: GITHUB_SHA,
  architectures,
  expectedWire: "vsh1",
})
const asset = assets[arch]
if (!asset) throw new Error("The hosted Windows holder asset is missing.")
const image = await emitWindowsHolderCompanion(path.dirname(await realpath(process.execPath)), asset).catch((error) => {
  // The dedicated job runs three separate Bun processes on the same disposable runner.
  if (error?.code !== "EEXIST") throw error
  return { arch, size: Buffer.byteLength(asset.base64, "base64"), sha256: asset.sha256 }
})
Bun.plugin(windowsHolderBundlePlugin(assets, architectures, { placement: "cli", targets: { [arch]: image } }))
const { windowsHolderCompanion } = await import("../src/tool/shell/windows-holder-direct")
const selected = windowsHolderCompanion("C:\\Windows")
if (selected?.wire !== "vsh1" || selected.image.arch !== arch || selected.image.sha256 !== asset.sha256)
  throw new Error("Windows Engine CI requires the exact native direct holder for its architecture.")
