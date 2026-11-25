import { $ } from "bun"
import type { BunPlugin } from "bun"
import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { TrustedWindowsHolderAsset } from "../src/tool/shell/windows-holder.asset"
import { compiledSource, maximumExecutableBytes, validateExecutable } from "./windows-holder-binary"

type Architecture = TrustedWindowsHolderAsset["arch"]
type Assets = Readonly<Partial<Record<Architecture, TrustedWindowsHolderAsset>>>
const source = new URL("../src/tool/shell/windows-holder.ts", import.meta.url)
const modulePath = fileURLToPath(new URL("../src/tool/shell/windows-holder.asset.ts", import.meta.url))
const digest = /^[a-f0-9]{64}$/
const revision = /^[a-f0-9]{40}$/

export async function prepareWindowsHolderBundle(input: {
  argv: readonly string[]
  githubActions: string | undefined
  declaredRevision: string | undefined
  architectures: readonly Architecture[]
  manifestPath?: string
  manifestDigest?: string
}) {
  const manifestFlag = flag(input.argv, "--windows-holder-manifest")
  const digestFlag = flag(input.argv, "--windows-holder-manifest-sha256")
  if ((manifestFlag || digestFlag) && (input.manifestPath || input.manifestDigest))
    throw new Error("Choose one source for Windows holder build inputs.")
  const manifest = manifestFlag ?? input.manifestPath
  const pin = digestFlag ?? input.manifestDigest
  if (!manifest && !pin) return
  if (
    input.githubActions !== "true" ||
    !manifest ||
    !path.isAbsolute(manifest) ||
    path.basename(manifest) !== "manifest.json" ||
    !pin ||
    !digest.test(pin) ||
    !input.architectures.length
  ) {
    throw new Error("A Windows holder bundle requires explicit verified hosted build inputs and a Windows target.")
  }
  const checkout = (
    await $`git rev-parse --verify HEAD`.cwd(fileURLToPath(new URL("..", import.meta.url))).text()
  ).trim()
  if (!revision.test(checkout) || (input.declaredRevision !== undefined && input.declaredRevision !== checkout))
    throw new Error("The Windows holder bundle revision does not match the checkout.")
  return verifyWindowsHolderBundle({ manifest, pin, checkout, architectures: input.architectures })
}

export async function verifyWindowsHolderBundle(input: {
  manifest: string
  pin: string
  checkout: string
  architectures: readonly Architecture[]
}): Promise<Assets> {
  const manifestPath = path.resolve(input.manifest)
  const directory = path.dirname(manifestPath)
  if (!samePath(await realpath(directory), directory))
    throw new Error("Noncanonical Windows holder artifact directory.")
  const manifestBytes = await boundedFile(manifestPath, 4096)
  if (sha256(manifestBytes) !== input.pin) throw new Error("The Windows holder manifest SHA-256 does not match.")
  const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"))
  if (
    !record(manifest) ||
    Object.keys(manifest).sort().join("|") !== "revision|targets|version" ||
    manifest.version !== 1 ||
    !revision.test(input.checkout) ||
    manifest.revision !== input.checkout ||
    !record(manifest.targets)
  ) {
    throw new Error("Invalid Windows holder artifact manifest or source revision.")
  }

  const maintainedSource = await boundedFile(fileURLToPath(source), 65_536)
  const assets: Partial<Record<Architecture, TrustedWindowsHolderAsset>> = {}
  for (const [arch, entry] of Object.entries(manifest.targets)) {
    if (arch !== "x64" && arch !== "arm64") throw new Error("Invalid Windows holder artifact architecture.")
    if (
      !record(entry) ||
      Object.keys(entry).sort().join("|") !== "executableSha256|size|sourceSha256" ||
      typeof entry.executableSha256 !== "string" ||
      !digest.test(entry.executableSha256) ||
      typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 1 ||
      entry.size > maximumExecutableBytes ||
      entry.sourceSha256 !== sha256(compiledSource(maintainedSource, arch))
    ) {
      throw new Error("The Windows holder artifact does not match its canonical C# source.")
    }
    const bytes = await boundedFile(path.join(directory, `holder-${arch}.exe`), maximumExecutableBytes)
    if (bytes.length !== entry.size || sha256(bytes) !== entry.executableSha256)
      throw new Error("The Windows holder executable does not match the verified manifest.")
    validateExecutable(bytes, arch)
    assets[arch] = Object.freeze({ arch, sha256: entry.executableSha256, base64: bytes.toString("base64") })
  }
  if (input.architectures.some((arch) => assets[arch] === undefined))
    throw new Error("A required Windows holder architecture is missing from the verified artifact.")
  return Object.freeze(assets)
}

export function windowsHolderBundlePlugin(assets: Assets, architectures: readonly Architecture[]): BunPlugin {
  const literal = (arch: Architecture) => {
    const asset = assets[arch]
    if (!architectures.includes(arch)) return "undefined"
    if (!asset) throw new Error("A required Windows holder architecture is unavailable for bundling.")
    return `Object.freeze(${JSON.stringify(asset)})`
  }
  const contents = [
    `export const trustedWindowsX64Holder = ${literal("x64")}`,
    `export const trustedWindowsArm64Holder = ${literal("arm64")}`,
  ].join("\n")
  return {
    name: "vector-windows-holder-asset",
    setup(build) {
      build.onLoad({ filter: /[/\\]windows-holder\.asset\.ts$/ }, (args) => {
        if (samePath(path.normalize(args.path), modulePath)) return { contents, loader: "ts" }
      })
    },
  }
}

function flag(argv: readonly string[], name: string) {
  const prefix = `${name}=`
  const values = argv.filter((arg) => arg === name || arg.startsWith(prefix))
  if (!values.length) return
  if (values.length !== 1 || !values[0].startsWith(prefix) || values[0].length === prefix.length)
    throw new Error("Malformed or repeated Windows holder build activation flag.")
  return values[0].slice(prefix.length)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function samePath(a: string, b: string) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

async function boundedFile(file: string, maximum: number) {
  const info = await lstat(file)
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.size < 1 ||
    info.size > maximum ||
    !samePath(await realpath(file), file)
  )
    throw new Error("Invalid Windows holder artifact file.")
  const bytes = await readFile(file)
  if (bytes.length !== info.size) throw new Error("The Windows holder artifact changed while reading it.")
  return bytes
}

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex")
}
