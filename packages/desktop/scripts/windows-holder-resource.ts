import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { maximumExecutableBytes } from "../../engine/script/windows-holder-binary"
import { windowsHolderCompanionName } from "../../engine/src/tool/shell/windows-holder-companion-name"

export async function copyWindowsHolderResource(
  desktop: string,
  resources: string,
  arch: string,
  environment: NodeJS.ProcessEnv,
) {
  const manifestSha256 = environment.VECTOR_WINDOWS_HOLDER_MANIFEST_SHA256
  if (manifestSha256 === undefined && environment.VECTOR_WINDOWS_HOLDER_MANIFEST === undefined) return
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    !environment.VECTOR_WINDOWS_HOLDER_MANIFEST ||
    !manifestSha256 ||
    !/^[a-f0-9]{64}$/.test(manifestSha256) ||
    (arch !== "x64" && arch !== "arm64")
  ) {
    throw new Error("Electron holder packaging requires a pinned build and a supported Windows architecture.")
  }

  const stage = path.resolve(desktop, "../engine/dist/node/windows-holder")
  const receipt: unknown = JSON.parse(
    (await readRegular(path.join(stage, "desktop-build.json"), 4096)).toString("utf8"),
  )
  if (
    !record(receipt) ||
    receipt.version !== 1 ||
    receipt.manifestSha256 !== manifestSha256 ||
    !record(receipt.targets)
  ) {
    throw new Error("The Electron holder build receipt does not match the pinned manifest.")
  }
  const target = receipt.targets[arch]
  if (
    !record(target) ||
    target.arch !== arch ||
    typeof target.sha256 !== "string" ||
    typeof target.size !== "number" ||
    !Number.isSafeInteger(target.size) ||
    target.size < 1 ||
    target.size > maximumExecutableBytes
  ) {
    throw new Error("The Electron holder build receipt has no valid target entry.")
  }
  const filename = windowsHolderCompanionName(arch, target.sha256)
  const bytes = await readRegular(path.join(stage, filename), target.size)
  if (bytes.length !== target.size || createHash("sha256").update(bytes).digest("hex") !== target.sha256)
    throw new Error("The staged Electron holder does not match the verified build bytes.")

  await requireCanonicalDirectory(resources)
  const engine = path.join(resources, "engine")
  await mkdir(engine, { recursive: true })
  await requireCanonicalDirectory(engine)
  const destination = path.join(engine, "windows-holder")
  await mkdir(destination)
  await writeFile(path.join(destination, filename), bytes, { flag: "wx" })
}

async function requireCanonicalDirectory(directory: string) {
  if (!(await lstat(directory)).isDirectory() || path.relative(directory, await realpath(directory)) !== "")
    throw new Error("Invalid Electron holder resource directory.")
}

async function readRegular(file: string, maximum: number) {
  const info = await lstat(file)
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.size < 1 ||
    info.size > maximum ||
    path.relative(file, await realpath(file)) !== ""
  )
    throw new Error("Invalid staged Electron holder file.")
  const bytes = await readFile(file)
  if (bytes.length !== info.size) throw new Error("The staged Electron holder file changed while reading it.")
  return bytes
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
