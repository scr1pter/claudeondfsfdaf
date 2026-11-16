import { createHash } from "node:crypto"
import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Hands } from "@vectordevai/schema/hands"
import { APP_IDS } from "./channel-ids"
import { binaryArchitectures } from "./verify-native"
import type { BuildOptions, HelperArchitecture, HelperManifest, NativeCommand } from "./build-computer-helper"

type Platform = "darwin" | "win32" | "linux"
type Channel = Hands.Channel
type Architecture = HelperArchitecture | "universal"
const packageDirectory = fileURLToPath(new URL("../", import.meta.url))
const bundle = "VectorComputer.app"
const macExecutable = "VectorComputer"
const windowsExecutable = "vector-computer.exe"
const manifestName = "computer-helper.json"
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

export type ComputerHelperPackageResult = {
  skipped: boolean
  manifests: HelperManifest[]
  windowsHashes: Partial<Record<HelperArchitecture, string>>
}

// Paths are inert: loading electron-builder's configuration must not load the native builder or schema codecs.
// Mapping sources are absolute; packaged paths are relative to the .app directory or Windows appOutDir.
export function computerHelperPaths(
  platform: Platform,
  channel: Channel,
  arch?: Architecture,
  directory = packageDirectory,
) {
  validateChannel(channel)
  validatePlatform(platform)
  if (platform === "linux") return undefined
  if (arch !== undefined && arch !== "x64" && arch !== "arm64" && (platform !== "darwin" || arch !== "universal"))
    throw new Error("Choose a supported computer helper architecture.")
  const sourceRoot = path.resolve(
    directory,
    "native/out",
    platform,
    ...(platform === "win32" ? [arch ?? "${arch}"] : []),
  )
  const sourceBundle = platform === "darwin" ? path.join(sourceRoot, bundle) : undefined
  return {
    sourceRoot,
    sourceBundle,
    sourceExecutable: sourceBundle
      ? path.join(sourceBundle, "Contents/MacOS", macExecutable)
      : path.join(sourceRoot, windowsExecutable),
    sourceManifest: path.join(sourceRoot, manifestName),
    extraFiles: sourceBundle ? [{ from: sourceBundle, to: `Helpers/${bundle}` }] : [],
    extraResources: sourceBundle
      ? [{ from: path.join(sourceRoot, manifestName), to: manifestName }]
      : [{ from: sourceRoot, to: "computer", filter: [windowsExecutable, manifestName] }],
    packaged: sourceBundle
      ? {
          bundle: `Contents/Helpers/${bundle}`,
          executable: `Contents/Helpers/${bundle}/Contents/MacOS/${macExecutable}`,
          manifest: `Contents/Resources/${manifestName}`,
        }
      : {
          bundle: undefined,
          executable: `resources/computer/${windowsExecutable}`,
          manifest: `resources/computer/${manifestName}`,
        },
  }
}

type Settings = {
  channel: Channel
  directory?: string
  environment?: NodeJS.ProcessEnv
  run?: NativeCommand
}

export async function ensureComputerHelper(
  input: Settings & {
    platform: Platform
    architectures: readonly Architecture[]
    checkLock?: boolean
    host?: string
    hostArchitecture?: string
  },
): Promise<ComputerHelperPackageResult> {
  const environment = input.environment ?? process.env
  validateSettings(input.platform, input.channel, environment)
  if (input.checkLock && (input.platform !== "darwin" || input.channel !== "prod"))
    throw new Error("The macOS identity lock checks the production helper.")
  if (input.platform === "linux" || skip(input.platform, input.channel, environment))
    return { skipped: true, manifests: [], windowsHashes: {} }
  const architectures = normalizeArchitectures(input.platform, input.architectures)
  // Optional observations are assertions, never a way to turn a Linux verifier into a macOS signer.
  if (
    (input.host !== undefined && input.host !== process.platform) ||
    (input.hostArchitecture !== undefined && input.hostArchitecture !== process.arch)
  )
    throw new Error("Computer helper verification must use the actual host platform and architecture.")
  const directory = path.resolve(input.directory ?? packageDirectory)
  const { buildComputerHelper, parseBuildOptions } = await import("./build-computer-helper")
  const options = parseBuildOptions(
    [
      "--platform",
      input.platform,
      "--arch",
      architectures.join(","),
      "--channel",
      input.channel,
      "--out",
      path.join(directory, "native/out", input.platform),
      ...(input.checkLock ? ["--check-lock"] : []),
    ],
    { directory, prebuilt: environment.VECTOR_COMPUTER_HELPER_PREBUILT },
  )
  await buildComputerHelper(options, {
    directory,
    environment,
    run: input.run,
    host: process.platform,
    hostArchitecture: process.arch,
  })
  const result: ComputerHelperPackageResult = { skipped: false, manifests: [], windowsHashes: {} }
  for (const selected of input.platform === "darwin" ? [undefined] : architectures) {
    const paths = computerHelperPaths(input.platform, input.channel, selected, directory)!
    const manifest = await verifySource(paths, input.platform, selected ? [selected] : architectures, {
      ...input,
      directory,
      environment,
    })
    result.manifests.push(manifest)
    if (selected) {
      const digest = hash(await regularFile(paths.sourceRoot, windowsExecutable))
      if (digest !== manifest.files[windowsExecutable]!.sha256)
        throw new Error("The Windows computer helper changed before its hash was pinned.")
      result.windowsHashes[selected] = digest
    }
  }
  return result
}

export type ComputerHelperPackContext = {
  electronPlatformName: string
  arch: string | number
  appOutDir: string
  packager: { appInfo: { productFilename: string } }
}

export async function prepareComputerHelper(
  context: ComputerHelperPackContext,
  input: Partial<Settings> = {},
): Promise<ComputerHelperPackageResult> {
  const environment = input.environment ?? process.env
  const channel = input.channel ?? environment.VECTOR_CHANNEL
  validateChannel(channel)
  const platform = context.electronPlatformName
  validatePlatform(platform)
  validateSettings(platform, channel, environment)
  if (platform === "linux" || skip(platform, channel, environment))
    return { skipped: true, manifests: [], windowsHashes: {} }
  const arch =
    typeof context.arch === "number"
      ? ({ 1: "x64", 3: "arm64", 4: "universal" } as const)[context.arch as 1 | 3 | 4]
      : context.arch
  if (arch !== "x64" && arch !== "arm64" && (arch !== "universal" || platform !== "darwin"))
    throw new Error("The packaged computer helper architecture is unsupported.")
  const architectures = normalizeArchitectures(platform, [arch])
  const directory = path.resolve(input.directory ?? packageDirectory)
  const paths = computerHelperPaths(platform, channel, arch, directory)!
  const manifest = await verifySource(paths, platform, architectures, { ...input, channel, directory, environment })
  const name = context.packager.appInfo.productFilename
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name))
    throw new Error("The packaged app name is invalid.")
  const app = platform === "darwin" ? path.join(context.appOutDir, `${name}.app`) : context.appOutDir
  const packagedManifest = await regularFile(app, paths.packaged.manifest)
  if (!packagedManifest.equals(await regularFile(paths.sourceRoot, manifestName)))
    throw new Error("The packaged computer helper manifest differs from the verified source.")
  const packagedRoot = platform === "darwin" ? path.join(app, "Contents/Helpers") : path.join(app, "resources/computer")
  const actual = await filesUnder(platform === "darwin" ? path.join(packagedRoot, bundle) : packagedRoot)
  const expected = Object.keys(manifest.files).sort()
  const relative = actual
    .map((file) => path.relative(packagedRoot, file).split(path.sep).join("/"))
    .filter((file) => platform === "darwin" || file !== manifestName)
    .sort()
  if (relative.join("\0") !== expected.join("\0"))
    throw new Error("The packaged computer helper contains unexpected or missing files.")
  for (const [file, metadata] of Object.entries(manifest.files)) {
    if (
      hash(await regularFile(app, path.relative(app, path.join(packagedRoot, ...file.split("/"))))) !== metadata.sha256
    )
      throw new Error("A packaged computer helper file failed its manifest hash check.")
  }
  const executable = await regularFile(app, paths.packaged.executable)
  const entry = manifest.files[platform === "darwin" ? `${bundle}/Contents/MacOS/${macExecutable}` : windowsExecutable]!
  if (hash(executable) !== entry.sha256) throw new Error("The packaged computer helper changed during verification.")
  verifyBinary(executable, platform, architectures, entry.arch)
  if (platform === "darwin") {
    // C2's layout has its manifest beside the bundle. Verify the immutable copied bundle in place
    // through its own hashes above; never manufacture a sibling manifest or re-sign copied bytes.
    const { runNativeCommand } = await import("./build-computer-helper")
    if (process.platform === "darwin") {
      const checked = await (input.run ?? runNativeCommand)(
        "/usr/bin/codesign",
        ["--verify", "--strict", path.join(packagedRoot, bundle)],
        { cwd: directory, env: environment, timeoutMs: 5000 },
      )
      if (checked.code !== 0) throw new Error("The packaged computer helper signature is invalid.")
    }
  }
  return {
    skipped: false,
    manifests: [manifest],
    windowsHashes: platform === "win32" ? { [arch]: hash(executable) } : {},
  }
}

function validateChannel(value: unknown): asserts value is Channel {
  if (value !== "dev" && value !== "beta" && value !== "prod")
    throw new Error("Computer helper packaging requires an explicit dev, beta or prod channel.")
}
function validatePlatform(value: unknown): asserts value is Platform {
  if (value !== "darwin" && value !== "win32" && value !== "linux")
    throw new Error("The computer helper package platform is unsupported.")
}
function validateSettings(platform: Platform, channel: Channel, environment: NodeJS.ProcessEnv) {
  validatePlatform(platform)
  validateChannel(channel)
  if (environment.VECTOR_CHANNEL !== undefined && environment.VECTOR_CHANNEL !== channel)
    throw new Error("The computer helper package channel differs from VECTOR_CHANNEL.")
  if (environment.VECTOR_COMPUTER_HELPER !== undefined && environment.VECTOR_COMPUTER_HELPER !== "skip")
    throw new Error("VECTOR_COMPUTER_HELPER only accepts the explicit dev-only skip option.")
  if (environment.VECTOR_COMPUTER_HELPER === "skip" && channel !== "dev")
    throw new Error("Only an explicit dev build may skip the computer helper.")
  if (
    environment.VECTOR_COMPUTER_HELPER_PREBUILT !== undefined &&
    !["true", "false"].includes(environment.VECTOR_COMPUTER_HELPER_PREBUILT)
  )
    throw new Error("VECTOR_COMPUTER_HELPER_PREBUILT must be true or false.")
}
function skip(platform: Platform, channel: Channel, environment: NodeJS.ProcessEnv) {
  return platform === "linux" || (channel === "dev" && environment.VECTOR_COMPUTER_HELPER === "skip")
}
function normalizeArchitectures(platform: Platform, values: readonly Architecture[]): HelperArchitecture[] {
  if (
    !values.length ||
    new Set(values).size !== values.length ||
    values.some((value) => value !== "x64" && value !== "arm64" && (platform !== "darwin" || value !== "universal")) ||
    (values.includes("universal") && values.length !== 1)
  )
    throw new Error("Choose unambiguous supported computer helper architectures.")
  return (["x64", "arm64"] as const).filter((arch) => values.includes(arch) || values.includes("universal"))
}

async function verifySource(
  paths: NonNullable<ReturnType<typeof computerHelperPaths>>,
  platform: BuildOptions["platform"],
  architectures: HelperArchitecture[],
  input: Settings & { directory: string; environment: NodeJS.ProcessEnv },
) {
  const { verifyPrebuiltHelper, renderHelperPlist, parseHelperManifest } = await import("./build-computer-helper")
  const { readIdentity } = await import("./computer-helper-identity")
  const { Hands } = await import("@vectordevai/schema/hands")
  const identity = readIdentity(path.join(input.directory, "native/computer-helper/identity.json"))
  if (
    identity.mac.bundle !== bundle ||
    identity.mac.executable !== macExecutable ||
    identity.windows.executable !== windowsExecutable
  )
    throw new Error("The computer helper identity differs from its fixed package paths.")
  const manifest = await verifyPrebuiltHelper(paths.sourceRoot, platform, architectures, {
    ...input,
    host: process.platform,
    hostArchitecture: process.arch,
  })
  const current = parseHelperManifest(JSON.parse((await regularFile(paths.sourceRoot, manifestName)).toString("utf8")))
  if (JSON.stringify(current) !== JSON.stringify(manifest))
    throw new Error("The computer helper manifest changed during verification.")
  const executableName = platform === "darwin" ? `${bundle}/Contents/MacOS/${macExecutable}` : windowsExecutable
  if (platform === "win32" && Object.keys(manifest.files).join("\0") !== windowsExecutable)
    throw new Error("The Windows shipping helper manifest must contain only its executable.")
  const bytes = await regularFile(paths.sourceRoot, executableName)
  verifyBinary(bytes, platform, architectures, manifest.files[executableName]!.arch)
  if (hash(bytes) !== manifest.files[executableName]!.sha256)
    throw new Error("The computer helper executable changed during verification.")
  if (platform === "darwin") {
    const expected = renderHelperPlist(
      await readFile(path.join(input.directory, "native/computer-helper/macos/Info.plist.template"), "utf8"),
      {
        HELPER_BUNDLE_ID: Hands.helperBundleId(APP_IDS[input.channel]),
        HELPER_EXECUTABLE: identity.mac.executable,
        HELPER_NAME: Hands.helperName(input.channel),
        HELPER_VERSION: identity.helperVersion,
        MINIMUM_SYSTEM_VERSION: identity.mac.minimumSystemVersion,
        SOURCE_DIGEST: manifest.sourceDigest,
      },
    )
    if ((await regularFile(paths.sourceRoot, `${bundle}/Contents/Info.plist`)).toString("utf8") !== expected)
      throw new Error("The computer helper Info.plist does not match the source channel identity and name.")
    if (
      !(await regularFile(paths.sourceRoot, `${bundle}/Contents/Resources/AppIcon.icns`)).equals(
        await readFile(path.join(input.directory, `icons/${input.channel}/icon.icns`)),
      )
    )
      throw new Error("The computer helper icon does not match the source channel.")
  }
  return manifest
}

function verifyBinary(
  bytes: Buffer,
  platform: BuildOptions["platform"],
  requested: readonly HelperArchitecture[],
  declared: readonly HelperArchitecture[],
) {
  const found = binaryArchitectures(bytes)
  if (!requested.every((arch) => found.includes(arch)) || [...found].sort().join() !== [...declared].sort().join())
    throw new Error("The computer helper header disagrees with the requested and manifest architectures.")
  if (platform === "win32") {
    const offset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : 0
    if (
      bytes.length < 64 ||
      bytes.readUInt16LE(0) !== 0x5a4d ||
      offset < 64 ||
      offset > bytes.length - 24 ||
      bytes.readUInt32LE(offset) !== 0x4550
    )
      throw new Error("The Windows computer helper is not a PE executable.")
    const optional = offset + 24,
      size = bytes.readUInt16LE(offset + 20),
      sections = bytes.readUInt16LE(offset + 6),
      flags = bytes.readUInt16LE(offset + 22)
    if (
      size < 112 ||
      optional + size > bytes.length ||
      sections === 0 ||
      sections > 96 ||
      optional + size + sections * 40 > bytes.length ||
      bytes.readUInt16LE(optional) !== 0x20b ||
      (flags & 2) === 0 ||
      (flags & 0x2000) !== 0 ||
      bytes.readUInt16LE(optional + 68) !== 2
    )
      throw new Error("The Windows computer helper is not a 64-bit GUI PE executable.")
    return
  }
  const thin = (offset: number, size: number, cpu?: number) => {
    if (
      size < 32 ||
      offset < 0 ||
      offset > bytes.length - size ||
      bytes.readUInt32LE(offset) !== 0xfeedfacf ||
      bytes.readUInt32LE(offset + 12) !== 2 ||
      (cpu !== undefined && bytes.readUInt32LE(offset + 4) !== cpu)
    )
      throw new Error("The macOS computer helper is not a Mach-O executable.")
    const commands = bytes.readUInt32LE(offset + 16),
      length = bytes.readUInt32LE(offset + 20)
    if (commands === 0 || commands > 4096 || length > size - 32)
      throw new Error("The macOS computer helper load commands are invalid.")
    let cursor = offset + 32
    for (let index = 0; index < commands; index++) {
      if (cursor > offset + 32 + length - 8) throw new Error("The macOS computer helper load commands are truncated.")
      const count = bytes.readUInt32LE(cursor + 4)
      if (count < 8 || count % 8 || count > offset + 32 + length - cursor)
        throw new Error("The macOS computer helper load commands are invalid.")
      cursor += count
    }
    if (cursor !== offset + 32 + length) throw new Error("The macOS computer helper load commands are invalid.")
  }
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0xcafebabe) {
    const count = bytes.readUInt32BE(4)
    if (count < 1 || count > 2 || bytes.length < 8 + count * 20)
      throw new Error("The universal computer helper header is invalid.")
    const ranges: { offset: number; size: number }[] = []
    for (let index = 0; index < count; index++) {
      const entry = 8 + index * 20,
        offset = bytes.readUInt32BE(entry + 8),
        size = bytes.readUInt32BE(entry + 12),
        alignment = bytes.readUInt32BE(entry + 16)
      if (
        offset < 8 + count * 20 ||
        alignment > 30 ||
        offset % 2 ** alignment ||
        ranges.some((range) => offset < range.offset + range.size && range.offset < offset + size)
      )
        throw new Error("The universal computer helper slices are invalid.")
      thin(offset, size, bytes.readUInt32BE(entry))
      ranges.push({ offset, size })
    }
  } else thin(0, bytes.length)
}

async function regularFile(root: string, relative: string) {
  const base = await realpath(root)
  const rootStatus = await lstat(root)
  if (
    !rootStatus.isDirectory() ||
    rootStatus.isSymbolicLink() ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Computer helper package paths must stay inside regular directories.")
  const parts = relative.split(/[\\/]/)
  let file = base
  for (let index = 0; index < parts.length; index++) {
    file = path.join(file, parts[index]!)
    const status = await lstat(file)
    if (status.isSymbolicLink() || (index + 1 < parts.length ? !status.isDirectory() : !status.isFile()))
      throw new Error("Computer helper package paths cannot contain symbolic links or special files.")
  }
  const resolved = await realpath(file)
  if (!resolved.startsWith(base + path.sep)) throw new Error("The computer helper package path escapes its app.")
  return readFile(file)
}
async function filesUnder(root: string): Promise<string[]> {
  const status = await lstat(root)
  if (!status.isDirectory() || status.isSymbolicLink())
    throw new Error("The computer helper bundle must be a regular directory.")
  const files: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error("The packaged computer helper cannot contain symbolic links.")
    if (entry.isDirectory()) files.push(...(await filesUnder(file)))
    else if (entry.isFile()) files.push(file)
    else throw new Error("The packaged computer helper contains a special file.")
    if (files.length > 4096) throw new Error("The packaged computer helper contains too many files.")
  }
  return files.sort()
}
