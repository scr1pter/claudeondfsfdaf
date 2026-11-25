import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdtemp, readFile, realpath, rm, rmdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

export type HolderAsset = Readonly<{ arch: "x64" | "arm64"; sha256: string; base64: string }>
type StagedHolder = { executable: string; release(): Promise<void> }
const run = promisify(execFile)
const maximumBytes = 1_048_576
// Match the installed Windows system-tool trust boundary used by Core managed policy.
const systemRoot = "C:\\Windows"

export class HolderStagingDeadline extends Error {}

/** The caller includes this operation and the resulting process readiness in one absolute deadline. */
export async function stageWindowsHolder(asset: HolderAsset, deadline: number) {
  if (process.platform !== "win32" || process.arch !== asset.arch)
    throw new Error("The Windows holder does not match this host")
  const remaining = deadline - performance.now()
  if (remaining <= 0) throw new HolderStagingDeadline()
  const controller = new AbortController()
  const pending = materialize(asset, controller.signal)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const holder = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new HolderStagingDeadline())
          controller.abort()
        }, Math.max(0, Math.ceil(deadline - performance.now())))
      }),
    ])
    if (performance.now() >= deadline) throw new HolderStagingDeadline()
    return holder
  } catch (error) {
    void pending.then((holder) => holder.release(), () => {})
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function materialize(asset: HolderAsset, signal: AbortSignal): Promise<StagedHolder> {
  const bytes = verifiedHolderBytes(asset)
  const sid = parseCurrentSid(await nativeUtility("whoami.exe", ["/user", "/fo", "csv", "/nh"], signal))
  const profileKey = `HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\${sid}`
  const profile = await nativeUtility("reg.exe", ["query", profileKey, "/v", "ProfileImagePath", "/reg:64"], signal)
  const root = localProfileDirectory(profile, systemRoot)
  await canonicalDirectory(root)
  signal.throwIfAborted()
  const directory = await mkdtemp(path.win32.join(root, "vector-holder-"))
  const executable = path.win32.join(directory, "holder.exe")
  const initial = await canonicalDirectory(directory)
  const release = async () => {
    const current = await canonicalDirectory(directory).catch(() => undefined)
    if (!current || !sameDirectory(initial, current)) return
    await rm(executable, { force: true }).catch(() => {})
    await rmdir(directory).catch(() => {})
  }
  try {
    signal.throwIfAborted()
    const trustedSids = Array.from(new Set([sid, "S-1-5-18", "S-1-5-32-544"]))
    await nativeUtility(
      "icacls.exe",
      [directory, "/inheritance:r", "/grant:r", ...trustedSids.map((value) => `*${value}:(OI)(CI)F`)],
      signal,
    )
    if (!sameDirectory(initial, await canonicalDirectory(directory))) throw new Error("The holder staging directory changed")
    signal.throwIfAborted()
    await writeFile(executable, bytes, { flag: "wx" })
    const staged = await lstat(executable)
    if (!staged.isFile() || staged.nlink !== 1 || staged.size !== bytes.length)
      throw new Error("The staged Windows holder is invalid")
    if (
      hash(await readFile(executable, { signal })) !== asset.sha256 ||
      !sameDirectory(initial, await canonicalDirectory(directory))
    )
      throw new Error("The staged Windows holder changed")
    return { executable, release }
  } catch (error) {
    await release()
    throw error
  }
}

export function localProfileDirectory(output: string, systemRoot: string) {
  const matches = [...output.matchAll(/^[ \t]*ProfileImagePath[ \t]+REG_(EXPAND_)?SZ[ \t]+([^\r\n]+)\r?$/gim)]
  if (matches.length !== 1) throw new Error("The registered Windows profile is unavailable")
  const [, expandable, registered] = matches[0]!
  const profile = expandable && /^[a-z]:\\/i.test(systemRoot)
    ? registered!.replace(/^%SystemDrive%/i, systemRoot.slice(0, 2))
    : registered!
  if (
    !/^[a-z]:\\/i.test(profile) ||
    profile.length <= 3 ||
    /[%:*?"<>|\u0000-\u001f]/.test(profile.slice(2)) ||
    path.win32.normalize(profile) !== profile
  )
    throw new Error("The Windows user profile is unavailable")
  return path.win32.join(profile, "AppData", "Local")
}

async function canonicalDirectory(directory: string) {
  const info = await lstat(directory, { bigint: true })
  if (!info.isDirectory() || info.ino === 0n || (await realpath(directory)).toLowerCase() !== directory.toLowerCase())
    throw new Error("A canonical local Windows holder directory is required")
  return info
}

function sameDirectory(before: { ino: bigint; dev: bigint }, after: { ino: bigint; dev: bigint }) {
  return before.ino === after.ino && before.dev === after.dev
}

export function parseCurrentSid(output: string) {
  const match = /^"[^"\r\n]{1,256}","(S-1-\d{1,12}(?:-\d{1,10}){1,15})"\r?\n?$/.exec(output)
  if (!match) throw new Error("The current Windows user could not be identified")
  return match[1]!
}

async function nativeUtility(
  name: "whoami.exe" | "reg.exe" | "icacls.exe",
  args: string[],
  signal: AbortSignal,
) {
  const system = path.win32.join(systemRoot, "System32")
  try {
    return (await run(path.win32.join(system, name), args, {
      cwd: system,
      env: { SystemRoot: systemRoot, WINDIR: systemRoot },
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16_384,
      signal,
    })).stdout
  } catch {
    throw new Error("Windows could not secure the containment helper")
  }
}

export function verifiedHolderBytes(asset: HolderAsset) {
  if (!/^[a-f0-9]{64}$/.test(asset.sha256) || asset.base64.length > Math.ceil(maximumBytes / 3) * 4)
    throw new Error("The Windows holder asset is invalid")
  const bytes = Buffer.from(asset.base64, "base64")
  if (bytes.length < 1 || bytes.length > maximumBytes || hash(bytes) !== asset.sha256)
    throw new Error("The Windows holder integrity check failed")
  return bytes
}

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}
