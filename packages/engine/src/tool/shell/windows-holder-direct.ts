import { createHash } from "node:crypto"
import type { BigIntStats } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import path from "node:path"
import { compiledWindowsHolderArchitecture } from "./windows-holder-carrier"
import { windowsHolderCompanionName } from "./windows-holder-companion-name"
import { trustedWindowsHolderCompanion, type WindowsHolderCompanionBundle } from "./windows-holder.asset"

const maximumBytes = 1_048_576
const verificationFailure = "The installed Windows containment helper failed verification"

export function windowsHolderCompanion(systemRoot: string) {
  const bundle = trustedWindowsHolderCompanion
  if (!bundle) return
  const arch = bundle.wire === "vsh1" ? nativeArchitecture(systemRoot) : compiledWindowsHolderArchitecture(systemRoot)
  if (!arch) return
  const image = bundle.targets[arch]
  if (!image || image.arch !== arch) throw new Error(verificationFailure)
  return { image, placement: bundle.placement, wire: bundle.wire }
}

function samePath(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase()
}

function localPath(value: string) {
  return /^[a-z]:\\/i.test(value) && path.win32.normalize(value) === value
}

function nativeArchitecture(systemRoot: string) {
  if (process.platform === "win32" && localPath(systemRoot) && (process.arch === "x64" || process.arch === "arm64"))
    return process.arch
}

async function installedDirectory(placement: WindowsHolderCompanionBundle["placement"]) {
  const executable = await realpath(process.execPath)
  // Standalone installs allow UNC paths. Use the OS PowerShell holder for that installation type.
  const networkRoot = path.win32.parse(executable).root
  if (placement === "cli" && /^\\\\[^?.\\/][^\\/]*\\[^\\/]+\\$/i.test(networkRoot)) return
  if (!localPath(executable)) throw new Error(verificationFailure)
  const application = path.win32.dirname(executable)
  if (placement === "cli") return application
  const electron = process as NodeJS.Process & { resourcesPath?: string; type?: string }
  const resources = path.win32.join(application, "resources")
  if (
    !electron.versions.electron ||
    electron.type !== "utility" ||
    !electron.resourcesPath ||
    !samePath(electron.resourcesPath, resources)
  )
    throw new Error(verificationFailure)
  return path.win32.join(resources, "engine", "windows-holder")
}

function sameFile(first: BigIntStats, second: BigIntStats) {
  return (
    second.isFile() &&
    second.nlink === 1n &&
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs
  )
}

/** Verifies an installed asset under the same software installation trust as the running executable. */
export async function prepareWindowsHolderCompanion(
  selection: NonNullable<ReturnType<typeof windowsHolderCompanion>>,
  deadline: number,
  signal?: AbortSignal,
) {
  const { image, placement } = selection
  const { arch, size, sha256 } = image
  const basename = windowsHolderCompanionName(arch, sha256)
  if (!Number.isSafeInteger(size) || size < 1 || size > maximumBytes) throw new Error(verificationFailure)
  const directory = await installedDirectory(placement)
  if (!directory) return
  const executable = path.win32.join(directory, basename)
  if (!samePath(await realpath(directory), directory)) throw new Error(verificationFailure)
  const initial = await lstat(executable, { bigint: true })
  if (!initial.isFile() || initial.nlink !== 1n || initial.ino === 0n || initial.size !== BigInt(size))
    throw new Error(verificationFailure)
  signal?.throwIfAborted()
  if (performance.now() >= deadline) throw new Error(verificationFailure)
  const file = await open(executable, "r")
  const release = () => file.close().catch(() => {})
  try {
    if (!sameFile(initial, await file.stat({ bigint: true }))) throw new Error(verificationFailure)
    const contents = Buffer.allocUnsafe(size + 1)
    let offset = 0
    while (offset < contents.length) {
      const { bytesRead } = await file.read(contents, offset, contents.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (
      offset !== size ||
      createHash("sha256").update(contents.subarray(0, size)).digest("hex") !== sha256 ||
      !sameFile(initial, await file.stat({ bigint: true })) ||
      !samePath(await realpath(executable), executable) ||
      !sameFile(initial, await lstat(executable, { bigint: true }))
    )
      throw new Error(verificationFailure)
    signal?.throwIfAborted()
    // The caller closes the verification handle after submitting the direct spawn.
    return { executable, release }
  } catch (error) {
    await release()
    throw error
  }
}
