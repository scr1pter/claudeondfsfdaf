import path from "node:path"
import { verifyWindowsHolderBundle, windowsHolderBundlePlugin } from "./windows-holder-bundle"

const { CI, GITHUB_JOB, GITHUB_RUN_ID, GITHUB_SHA, RUNNER_ARCH, RUNNER_ENVIRONMENT, RUNNER_TEMP } = process.env
const { VECTOR_WINDOWS_HOLDER_BUILD_RUN, VECTOR_WINDOWS_HOLDER_REVISION, VECTOR_WINDOWS_HOLDER_MANIFEST_SHA256 } =
  process.env
if (
  process.platform !== "win32" ||
  process.arch !== "x64" ||
  CI !== "true" ||
  (GITHUB_JOB !== "engine-windows" && GITHUB_JOB !== "native") ||
  (process.env.SystemRoot ?? process.env.SYSTEMROOT)?.toLowerCase() !== "c:\\windows" ||
  RUNNER_ARCH !== "X64" ||
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

const architectures = ["x64"] as const
export const assets = await verifyWindowsHolderBundle({
  manifest: path.join(RUNNER_TEMP, "vector-windows-holder-bundle", "manifest.json"),
  pin: VECTOR_WINDOWS_HOLDER_MANIFEST_SHA256,
  checkout: GITHUB_SHA,
  architectures,
})
Bun.plugin(windowsHolderBundlePlugin(assets, architectures))
const { trustedWindowsX64Holder } = await import("../src/tool/shell/windows-holder.asset")
if (!trustedWindowsX64Holder || trustedWindowsX64Holder.sha256 !== assets.x64?.sha256)
  throw new Error("Windows Engine CI could not activate the verified holder bundle.")
