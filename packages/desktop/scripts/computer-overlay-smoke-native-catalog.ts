import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import type { ComputerSmokeNativeCause, ComputerSmokeNativeRole } from "./computer-overlay-smoke-report"

type Expected = {
  platform: "darwin" | "win32"
  architecture: string
  helperVersion: string
  sourceDigest: string | undefined
  protocol: { min: number; max: number }
}
type ArtifactFact = { role?: ComputerSmokeNativeRole; ordinal?: number; architecture?: "x64" | "arm64" }
export class ComputerSmokeNativeArtifactFailure extends Error {
  constructor(readonly diagnostic: { phase: "artifact"; cause: ComputerSmokeNativeCause } & ArtifactFact) {
    super("The native smoke artifact could not be admitted.")
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const hex = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
function role(relative: string): ComputerSmokeNativeRole {
  if (relative === "smoke/computer-overlay-smoke-electron.mjs") return "main"
  if (relative === "smoke/computer-overlay-smoke-preload.cjs") return "preload"
  if (relative === "smoke/computer-fake-helper.mjs") return "fake"
  if (relative.startsWith("resources/computer/")) return "driver"
  return relative.startsWith("electron/") ? "runtime" : "resource"
}

/** Repeat the admitted stage's exact regular-file checks without starting Electron or native code. */
export async function verifyComputerSmokeNativeCatalog(root: string, expected: Expected) {
  const architecture =
    expected.architecture === "x64" || expected.architecture === "arm64" ? expected.architecture : undefined
  function fail(cause: ComputerSmokeNativeCause, fact: ArtifactFact = {}): never {
    throw new ComputerSmokeNativeArtifactFailure({
      phase: "artifact",
      cause,
      ...(architecture ? { architecture } : {}),
      ...fact,
    })
  }
  const io = async <T>(cause: ComputerSmokeNativeCause, body: () => Promise<T>, fact: ArtifactFact = {}) => {
    try {
      return await body()
    } catch {
      return fail(cause, fact)
    }
  }
  const canonical = await io("artifact_root_io", () => realpath(root))
  const manifestFile = path.join(canonical, "computer-overlay-smoke.json")
  const status = await lstat(manifestFile).catch((error: NodeJS.ErrnoException) => {
    // Preserve the original unavailable-harness result when no manifest exists.
    if (error.code === "ENOENT") return
    return fail("manifest_io")
  })
  if (!status) return undefined
  if (!status.isFile() || status.isSymbolicLink()) fail("manifest_type")
  if (status.size > 1024 * 1024) fail("manifest_size")
  if (!hex(expected.sourceDigest)) fail("identity_source")
  const bytes = await io("manifest_io", () => readFile(manifestFile, "utf8"))
  let manifest: unknown
  try {
    manifest = JSON.parse(bytes)
  } catch {
    return fail("manifest_json")
  }
  if (!record(manifest)) fail("identity_shape")
  if (manifest.platform !== expected.platform) fail("identity_platform")
  if (manifest.helperVersion !== expected.helperVersion) fail("identity_version")
  if (manifest.sourceDigest !== expected.sourceDigest) fail("identity_source")
  if (
    !record(manifest.protocol) ||
    manifest.protocol.min !== expected.protocol.min ||
    manifest.protocol.max !== expected.protocol.max
  )
    fail("identity_protocol")
  if (!record(manifest.files)) fail("catalog_shape")
  for (const [ordinal, [relative, metadata]] of Object.entries(manifest.files).entries()) {
    // Ordinals beyond the diagnostic bound stay unreported; admission still checks every entry.
    const fact = { role: role(relative), ...(ordinal <= 8191 ? { ordinal } : {}) }
    if (!record(metadata)) fail("catalog_shape", fact)
    if (!hex(metadata.sha256)) fail("catalog_sha", fact)
    if (!Array.isArray(metadata.arch) || !metadata.arch.includes(expected.architecture)) fail("catalog_arch", fact)
    if (
      relative.includes("\\") ||
      relative.startsWith("/") ||
      relative.split("/").some((part) => !part || part === "." || part === "..")
    )
      fail("catalog_path", fact)
    const file = path.join(canonical, ...relative.split("/"))
    const info = await io("file_io", () => lstat(file), fact)
    if (!info.isFile() || info.isSymbolicLink()) fail("file_kind", fact)
    if (info.size < 1 || info.size > 512 * 1024 * 1024) fail("file_size", fact)
    if (!(await io("file_io", () => realpath(file), fact)).startsWith(canonical + path.sep))
      fail("file_containment", fact)
    if (
      createHash("sha256")
        .update(await io("file_io", () => readFile(file), fact))
        .digest("hex") !== metadata.sha256
    )
      fail("file_hash", fact)
  }
  const relative =
    expected.platform === "win32"
      ? "resources/computer/vector-computer.exe"
      : "resources/computer/VectorComputerOverlayDriver.app/Contents/MacOS/VectorComputerOverlayDriver"
  for (const mandatory of [
    relative,
    "smoke/computer-overlay-smoke-electron.mjs",
    "smoke/computer-overlay-smoke-preload.cjs",
    "smoke/computer-fake-helper.mjs",
  ])
    if (!Object.hasOwn(manifest.files, mandatory)) fail("mandatory_file", { role: role(mandatory) })
  return path.join(canonical, ...relative.split("/"))
}
