import { access } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { computerHelperSkipRequested } from "./computer-helper-package-node"
import type { ComputerHelperPackageResult } from "./computer-helper-package"

type Channel = "prod" | "beta" | "dev"
type Architecture = "x64" | "arm64"
const packageDirectory = fileURLToPath(new URL("../", import.meta.url))

export function parseComputerHelperHashes(raw: string | undefined): Partial<Record<Architecture, string>> {
  if (!raw) return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.entries(value).some(
        ([arch, hash]) =>
          (arch !== "x64" && arch !== "arm64") || typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash),
      )
    )
      throw new Error()
    return Object.fromEntries(Object.entries(value).map(([arch, hash]) => [arch, String(hash).toLowerCase()]))
  } catch {
    throw new Error("VECTOR_COMPUTER_HELPER_SHA256 must map x64 or arm64 to a SHA-256 hex digest.")
  }
}

export async function computerHelperBuildEnvironment(
  input: {
    channel: Channel
    environment?: NodeJS.ProcessEnv
    directory?: string
  },
  dependencies: {
    platform?: string
    architecture?: string
    exists?: (file: string) => Promise<boolean>
    ensure?: (input: {
      platform: "win32"
      architectures: readonly Architecture[]
      channel: Channel
      directory: string
      environment: NodeJS.ProcessEnv
    }) => Promise<ComputerHelperPackageResult>
  } = {},
) {
  const environment = { ...(input.environment ?? process.env) }
  const supplied = parseComputerHelperHashes(environment.VECTOR_COMPUTER_HELPER_SHA256)
  if (computerHelperSkipRequested(input.channel, environment))
    return { ...environment, VECTOR_COMPUTER_HELPER_SHA256: "{}" }
  const explicit = (["x64", "arm64"] as const).filter((arch) => supplied[arch] !== undefined)
  const platform = dependencies.platform ?? process.platform
  if (platform !== "win32" && explicit.length === 0) return { ...environment, VECTOR_COMPUTER_HELPER_SHA256: "{}" }
  const architecture = dependencies.architecture ?? process.arch
  if (explicit.length === 0 && architecture !== "x64" && architecture !== "arm64")
    throw new Error("The Windows helper build architecture is unsupported.")
  const architectures: Architecture[] = explicit.length ? explicit : [architecture === "arm64" ? "arm64" : "x64"]
  const directory = path.resolve(input.directory ?? packageDirectory)
  const exists =
    dependencies.exists ??
    (async (file) => {
      try {
        await access(file)
        return true
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false
        throw error
      }
    })
  const present = await Promise.all(
    architectures.map((arch) => exists(path.join(directory, `native/out/win32/${arch}/computer-helper.json`))),
  )
  if (present.every((value) => !value) && explicit.length === 0)
    return { ...environment, VECTOR_COMPUTER_HELPER_SHA256: "{}" }
  if (present.some((value) => !value))
    throw new Error("A requested Windows helper manifest is missing before the desktop build.")
  const { ensureComputerHelper } = dependencies.ensure
    ? { ensureComputerHelper: dependencies.ensure }
    : await import("./computer-helper-package")
  const result = await ensureComputerHelper({
    platform: "win32",
    architectures,
    channel: input.channel,
    directory,
    environment: { ...environment, VECTOR_CHANNEL: input.channel, VECTOR_COMPUTER_HELPER_PREBUILT: "true" },
  })
  const hashes = parseComputerHelperHashes(JSON.stringify(result.windowsHashes))
  if (
    result.skipped ||
    architectures.some((arch) => !hashes[arch]) ||
    Object.keys(hashes).length !== architectures.length
  )
    throw new Error("The Windows helper hash map does not cover the desktop build architectures.")
  if (
    environment.VECTOR_COMPUTER_HELPER_SHA256 !== undefined &&
    (Object.keys(supplied).length !== Object.keys(hashes).length ||
      architectures.some((arch) => supplied[arch] !== hashes[arch]))
  )
    throw new Error("The supplied Windows helper hash map differs from the verified final helper bytes.")
  return { ...environment, VECTOR_COMPUTER_HELPER_SHA256: JSON.stringify(hashes) }
}
