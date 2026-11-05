import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFile, chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Hands } from "@vectordevai/schema/hands"
import { generateIdentitySources, readIdentity } from "./computer-helper-identity"
import { APP_IDS } from "./channel-ids"
import { binaryArchitectures } from "./verify-native"

export type HelperArchitecture = "x64" | "arm64"
export type HelperPlatform = "darwin" | "win32"
export type BuildOptions = {
  platform: HelperPlatform
  architectures: HelperArchitecture[]
  channel: "dev" | "beta" | "prod"
  out: string
  checkLock: boolean
  prebuilt: boolean
}
export type HelperManifest = {
  helperVersion: string
  protocol: { min: number; max: number }
  platform: HelperPlatform
  files: Record<string, { sha256: string; arch: HelperArchitecture[] }>
  sourceDigest: string
  toolchain: string
}
export type IdentityLock = {
  enforce: boolean
  helperVersion: string
  sourceDigest: string | null
  toolchain: string | null
  cdhash: Partial<Record<HelperArchitecture, string>>
}
export type NativeCommand = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string }>

const packageDirectory = fileURLToPath(new URL("../", import.meta.url))
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const validArchitecture = (value: unknown): value is HelperArchitecture => value === "x64" || value === "arm64"
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const MAC_TEST_TARGET = Object.freeze({
  bundle: "VectorComputerTestTarget.app",
  executable: "VectorComputerTestTarget",
  bundleId: "ai.vector.computer.test-target",
  name: "Vector Computer Test Target",
  manifest: "computer-helper-tests.json",
})
export const WINDOWS_TEST_ARTIFACTS = Object.freeze({
  caller: "VectorComputerCaller.exe",
  unit: "vector-computer-tests.exe",
  target: "computer-test-target.exe",
  manifest: "computer-helper-tests.json",
})
const windowsTestArtifactNames = [
  WINDOWS_TEST_ARTIFACTS.caller,
  WINDOWS_TEST_ARTIFACTS.unit,
  WINDOWS_TEST_ARTIFACTS.target,
].sort()
const macTestArtifactNames = [
  "VectorComputerTests",
  "VectorComputerCaller",
  `${MAC_TEST_TARGET.bundle}/Contents/Info.plist`,
  `${MAC_TEST_TARGET.bundle}/Contents/MacOS/${MAC_TEST_TARGET.executable}`,
  `${MAC_TEST_TARGET.bundle}/Contents/_CodeSignature/CodeResources`,
].sort()

export class HelperBuildError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message)
    this.name = "HelperBuildError"
  }
}

export function parseBuildOptions(
  argv: readonly string[],
  input: { host?: string; hostArchitecture?: string; directory?: string; prebuilt?: string } = {},
): BuildOptions {
  const values = new Map<string, string>()
  let checkLock = false
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!
    if (argument === "--") continue
    if (argument === "--check-lock") {
      if (checkLock) throw new HelperBuildError("The lock check was provided twice.", 2)
      checkLock = true
      continue
    }
    const equal = argument.indexOf("=")
    const name = equal < 0 ? argument : argument.slice(0, equal)
    if (!["--platform", "--arch", "--out", "--channel"].includes(name) || values.has(name))
      throw new HelperBuildError("Invalid computer helper build arguments.", 2)
    const value = equal < 0 ? argv[++index] : argument.slice(equal + 1)
    if (!value || value.startsWith("--") || value.includes("\0"))
      throw new HelperBuildError("A computer helper build argument needs a value.", 2)
    values.set(name, value)
  }
  const platform = values.get("--platform") ?? input.host ?? process.platform
  if (platform !== "darwin" && platform !== "win32")
    throw new HelperBuildError("Choose --platform darwin or win32 for the computer helper.", 2)
  const hostArchitecture = input.hostArchitecture ?? process.arch
  const architecture =
    values.get("--arch") ??
    (platform === "darwin" ? "universal" : validArchitecture(hostArchitecture) ? hostArchitecture : "x64")
  const parts = architecture === "universal" ? ["x64", "arm64"] : architecture.split(",")
  if (
    (architecture === "universal" && platform !== "darwin") ||
    parts.some((item) => !validArchitecture(item)) ||
    new Set(parts).size !== parts.length
  )
    throw new HelperBuildError("Choose a supported computer helper architecture.", 2)
  const channel = values.get("--channel") ?? "prod"
  if (channel !== "dev" && channel !== "beta" && channel !== "prod")
    throw new HelperBuildError("Choose --channel dev, beta or prod.", 2)
  if (checkLock && (platform !== "darwin" || channel !== "prod"))
    throw new HelperBuildError("The macOS identity lock checks the production helper.", 2)
  if (input.prebuilt !== undefined && input.prebuilt !== "true" && input.prebuilt !== "false")
    throw new HelperBuildError("VECTOR_COMPUTER_HELPER_PREBUILT must be true or false.", 2)
  return {
    platform,
    architectures: (["x64", "arm64"] as const).filter((item) => parts.includes(item)),
    channel,
    out: path.resolve(input.directory ?? packageDirectory, values.get("--out") ?? `native/out/${platform}`),
    checkLock,
    prebuilt: input.prebuilt === "true",
  }
}

export function swiftArguments(input: {
  arch: HelperArchitecture
  sources: readonly string[]
  generated?: string
  moduleName?: string
  output: string
  sourceRoot: string
  sdk: string
}) {
  return [
    "--sdk",
    "macosx",
    "swiftc",
    "-O",
    "-wmo",
    "-target",
    `${input.arch === "x64" ? "x86_64" : "arm64"}-apple-macos14.0`,
    "-sdk",
    input.sdk,
    "-module-name",
    input.moduleName ?? "VectorComputer",
    "-swift-version",
    "5",
    "-file-prefix-map",
    `${input.sourceRoot}=.`,
    ...(input.generated ? ["-file-prefix-map", `${path.dirname(input.generated)}=./generated`] : []),
    "-Xlinker",
    "-dead_strip",
    ...[
      "AppKit",
      "ApplicationServices",
      "Carbon",
      "CoreGraphics",
      "CoreText",
      "CryptoKit",
      "ImageIO",
      "IOKit",
      "ScreenCaptureKit",
      "Security",
    ].flatMap((name) => ["-framework", name]),
    ...[...input.sources].sort(),
    ...(input.generated ? [input.generated] : []),
    "-o",
    input.output,
  ]
}

export function computeSourceDigest(entries: readonly { path: string; bytes: Uint8Array }[], toolchain: string) {
  if (!toolchain.trim()) throw new HelperBuildError("The native toolchain version was not measured.")
  const digest = createHash("sha256")
  digest.update("vector-computer-source-v1\0")
  digest.update(Buffer.byteLength(toolchain).toString()).update("\0").update(toolchain).update("\0")
  const names = new Set<string>()
  for (const entry of [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )) {
    if (!safeRelativePath(entry.path) || names.has(entry.path))
      throw new HelperBuildError("A source digest input path is invalid or duplicated.")
    names.add(entry.path)
    digest
      .update(entry.path)
      .update("\0")
      .update(String(entry.bytes.byteLength))
      .update("\0")
      .update(entry.bytes)
      .update("\0")
  }
  return digest.digest("hex")
}

export function createManifest(input: HelperManifest): HelperManifest {
  const value = {
    helperVersion: input.helperVersion,
    protocol: { min: input.protocol.min, max: input.protocol.max },
    platform: input.platform,
    files: Object.fromEntries(
      Object.keys(input.files)
        .sort()
        .map((file) => [
          file,
          {
            sha256: input.files[file]!.sha256,
            arch: (["x64", "arm64"] as const).filter((arch) => input.files[file]!.arch.includes(arch)),
          },
        ]),
    ),
    sourceDigest: input.sourceDigest,
    toolchain: input.toolchain,
  }
  return parseHelperManifest(value)
}

export function parseHelperManifest(value: unknown): HelperManifest {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) => !["helperVersion", "protocol", "platform", "files", "sourceDigest", "toolchain"].includes(key),
    ) ||
    typeof value.helperVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(value.helperVersion) ||
    !record(value.protocol) ||
    Object.keys(value.protocol).sort().join(",") !== "max,min" ||
    !Number.isSafeInteger(value.protocol.min) ||
    !Number.isSafeInteger(value.protocol.max) ||
    (value.protocol.min as number) < 1 ||
    (value.protocol.min as number) > (value.protocol.max as number) ||
    (value.platform !== "darwin" && value.platform !== "win32") ||
    !validHash(value.sourceDigest) ||
    typeof value.toolchain !== "string" ||
    !value.toolchain.trim() ||
    value.toolchain.length > 65_536 ||
    !record(value.files) ||
    !Object.keys(value.files).length
  )
    throw new HelperBuildError("The computer helper manifest is invalid.")
  const names = new Set<string>()
  for (const [file, metadata] of Object.entries(value.files)) {
    const name = value.platform === "win32" ? file.toLowerCase() : file
    if (
      !safeRelativePath(file) ||
      names.has(name) ||
      !record(metadata) ||
      Object.keys(metadata).sort().join(",") !== "arch,sha256" ||
      !validHash(metadata.sha256) ||
      !Array.isArray(metadata.arch) ||
      !metadata.arch.length ||
      metadata.arch.some((arch) => !validArchitecture(arch)) ||
      new Set(metadata.arch).size !== metadata.arch.length
    )
      throw new HelperBuildError("The computer helper manifest has an invalid file entry.")
    names.add(name)
  }
  return value as HelperManifest
}

export function checkIdentityLock(lock: unknown, candidate: IdentityLock) {
  const problems: string[] = []
  if (
    !record(lock) ||
    Object.keys(lock).sort().join(",") !== "cdhash,enforce,helperVersion,sourceDigest,toolchain" ||
    typeof lock.enforce !== "boolean" ||
    typeof lock.helperVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(lock.helperVersion) ||
    !record(lock.cdhash) ||
    Object.keys(lock.cdhash).some((key) => !validArchitecture(key))
  )
    return { ok: false, enforced: true, problems: ["The macOS helper identity lock is invalid."] }
  const hashes = lock.cdhash
  if (
    !validHash(lock.sourceDigest) ||
    typeof lock.toolchain !== "string" ||
    !lock.toolchain.trim() ||
    !["x64", "arm64"].every((arch) => typeof hashes[arch] === "string" && /^[a-f0-9]{40}$/.test(hashes[arch] as string))
  )
    return { ok: false, enforced: true, problems: ["The macOS helper identity lock has no measured native baseline."] }
  if (
    !validHash(candidate.sourceDigest) ||
    !candidate.toolchain ||
    !Object.keys(candidate.cdhash).length ||
    Object.values(candidate.cdhash).some((value) => !/^[a-f0-9]{40}$/.test(value ?? ""))
  )
    return { ok: false, enforced: true, problems: ["The candidate macOS helper identity was not measured."] }
  if (lock.helperVersion !== candidate.helperVersion)
    problems.push("The helper version changed; review and commit the measured identity lock.")
  if (lock.sourceDigest !== candidate.sourceDigest)
    problems.push(
      lock.helperVersion === candidate.helperVersion
        ? "Helper sources or toolchain changed without a helperVersion bump."
        : "The helper source digest changed; review and commit the measured identity lock.",
    )
  if (lock.toolchain !== candidate.toolchain) problems.push("The measured helper toolchain changed.")
  for (const arch of Object.keys(candidate.cdhash) as HelperArchitecture[])
    if (lock.cdhash[arch] !== candidate.cdhash[arch])
      problems.push(`The ${arch} helper cdhash changed; review and commit the measured identity lock.`)
  return { ok: problems.length === 0 || !lock.enforce, enforced: lock.enforce, problems }
}

export async function runNativeCommand(
  command: string,
  args: readonly string[],
  options: Parameters<NativeCommand>[2],
) {
  return new Promise<Awaited<ReturnType<NativeCommand>>>((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    })
    const output = { stdout: "", stderr: "", bytes: 0, done: false }
    const stop = () => {
      if (!child.pid) return
      if (process.platform === "win32") {
        child.kill("SIGKILL")
        return
      }
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    }
    const timer = setTimeout(stop, options.timeoutMs)
    const finish = (code: number) => {
      if (output.done) return
      output.done = true
      clearTimeout(timer)
      resolve({ code, stdout: output.stdout, stderr: output.stderr })
    }
    for (const stream of ["stdout", "stderr"] as const)
      child[stream].on("data", (chunk: Buffer) => {
        output.bytes += chunk.byteLength
        if (output.bytes > 4 * 1024 * 1024) {
          stop()
          return
        }
        output[stream] += chunk.toString("utf8")
      })
    child.once("error", () => finish(1))
    child.once("close", (code) => finish(code ?? 1))
  })
}

export async function buildComputerHelper(
  options: BuildOptions,
  input: {
    run?: NativeCommand
    host?: string
    hostArchitecture?: string
    directory?: string
    environment?: NodeJS.ProcessEnv
  } = {},
) {
  const directory = path.resolve(input.directory ?? packageDirectory)
  const host = input.host ?? process.platform
  if (options.checkLock && host !== "darwin") throw new HelperBuildError("Read macOS cdhash values on macOS.", 2)
  const environment = { ...(input.environment ?? process.env), ZERO_AR_DATE: "1" }
  const run = input.run ?? runNativeCommand
  const identity = readIdentity(path.join(directory, "native/computer-helper/identity.json"))
  const command: NativeCommand = async (executable, args, settings) => {
    const result = await run(executable, args, settings)
    if (result.code !== 0) {
      // Compiler diagnostics contain repository source locations, never protocol payloads or environment values.
      // MSBuild and MSVC report many errors on stdout rather than stderr.
      if (["cmake", "cl", "xcrun"].includes(path.basename(executable)) && result.stdout)
        console.error(result.stdout.slice(0, 32_768))
      if (result.stderr) console.error(result.stderr.slice(0, 32_768))
      throw new HelperBuildError(`The native helper command failed: ${path.basename(executable)}.`)
    }
    return result
  }
  const settings = { cwd: directory, env: environment, timeoutMs: 300_000 }
  if (options.prebuilt) {
    const manifests: HelperManifest[] = []
    for (const arch of options.platform === "darwin" ? [undefined] : options.architectures) {
      const root = arch ? path.join(options.out, arch) : options.out
      manifests.push(
        await verifyPrebuiltHelper(root, options.platform, arch ? [arch] : options.architectures, {
          directory,
          channel: options.channel,
          host,
          hostArchitecture: input.hostArchitecture,
          run: command,
          environment,
        }),
      )
    }
    if (options.checkLock)
      await checkMacLock(directory, options.out, manifests[0]!, options.architectures, command, settings)
    return manifests
  }
  if (host !== options.platform)
    throw new HelperBuildError(
      options.platform === "win32"
        ? "build the Windows helper on Windows or pass VECTOR_COMPUTER_HELPER_PREBUILT"
        : "build the macOS helper on macOS or pass VECTOR_COMPUTER_HELPER_PREBUILT",
      2,
    )
  if (options.platform === "win32")
    return buildWindows(options, directory, identity, command, settings, input.hostArchitecture ?? process.arch)
  const native = path.join(directory, "native/computer-helper/macos")
  const build = path.join(directory, "native/build/computer-helper-darwin")
  const generatedDirectory = path.join(build, "generated")
  const generated = generateIdentitySources(generatedDirectory, {
    identity: path.join(directory, "native/computer-helper/identity.json"),
    blocklist: path.join(directory, "native/computer-helper/blocklist.json"),
  }).find((file) => file.endsWith("Identity.swift"))!
  const swift = (await command("xcrun", ["--sdk", "macosx", "swiftc", "--version"], settings)).stdout.trim()
  const sdkVersion = (await command("xcrun", ["--sdk", "macosx", "--show-sdk-version"], settings)).stdout.trim()
  const xcode = (await command("xcodebuild", ["-version"], settings)).stdout.trim()
  const sdk = (await command("xcrun", ["--sdk", "macosx", "--show-sdk-path"], settings)).stdout.trim()
  if (!swift || !sdkVersion || !xcode || !path.isAbsolute(sdk))
    throw new HelperBuildError("The macOS toolchain could not be measured.")
  const toolchain = `swift:\n${swift}\nsdk:${sdkVersion}\nxcode:\n${xcode}`
  const digest = await sourceDigestFor(directory, "darwin", options.channel, toolchain, generated)
  const helperSources = (await filesUnder(path.join(native, "Sources"))).filter((file) => file.endsWith(".swift"))
  const unitSources = [
    ...helperSources.filter((file) => path.basename(file) !== "main.swift"),
    ...(await filesUnder(path.join(native, "Tests"))).filter((file) => file.endsWith(".swift")),
  ]
  const callerSources = [path.join(native, "TestSupport/Caller/main.swift")]
  const targetSources = (await filesUnder(path.join(native, "TestTarget"))).filter((file) => file.endsWith(".swift"))
  if (!targetSources.length) throw new HelperBuildError("The native test target sources are missing.")
  const bundle = path.join(options.out, identity.mac.bundle)
  const executable = path.join(bundle, "Contents/MacOS", identity.mac.executable)
  const tests = path.join(options.out, "tests")
  const testTarget = path.join(tests, MAC_TEST_TARGET.bundle)
  // Regenerate only this build's owned bundle; stale signed resources must never become new shipping inputs.
  await rm(bundle, { recursive: true, force: true })
  await rm(testTarget, { recursive: true, force: true })
  await mkdir(path.dirname(executable), { recursive: true })
  await mkdir(path.join(bundle, "Contents/Resources"), { recursive: true })
  await mkdir(tests, { recursive: true })
  await mkdir(path.join(testTarget, "Contents/MacOS"), { recursive: true })
  await writeFile(
    path.join(testTarget, "Contents/Info.plist"),
    renderHelperPlist(await readFile(path.join(native, "TestTarget/Info.plist.template"), "utf8"), {
      HELPER_BUNDLE_ID: MAC_TEST_TARGET.bundleId,
      HELPER_EXECUTABLE: MAC_TEST_TARGET.executable,
      HELPER_NAME: MAC_TEST_TARGET.name,
      HELPER_VERSION: identity.helperVersion,
      MINIMUM_SYSTEM_VERSION: identity.mac.minimumSystemVersion,
      SOURCE_DIGEST: digest,
    }),
  )
  await writeFile(
    path.join(bundle, "Contents/Info.plist"),
    renderHelperPlist(await readFile(path.join(native, "Info.plist.template"), "utf8"), {
      HELPER_BUNDLE_ID: Hands.helperBundleId(APP_IDS[options.channel]),
      HELPER_EXECUTABLE: identity.mac.executable,
      HELPER_NAME: Hands.helperName(options.channel),
      HELPER_VERSION: identity.helperVersion,
      MINIMUM_SYSTEM_VERSION: identity.mac.minimumSystemVersion,
      SOURCE_DIGEST: digest,
    }),
  )
  await copyFile(
    path.join(directory, `icons/${options.channel}/icon.icns`),
    path.join(bundle, "Contents/Resources/AppIcon.icns"),
  )
  for (const target of [
    { name: "helper", sources: helperSources, output: executable },
    { name: "unit", sources: unitSources, output: path.join(tests, "VectorComputerTests") },
    { name: "caller", sources: callerSources, output: path.join(tests, "VectorComputerCaller") },
    {
      name: "test-target",
      sources: targetSources,
      output: path.join(testTarget, "Contents/MacOS", MAC_TEST_TARGET.executable),
    },
  ]) {
    const slices: string[] = []
    for (const arch of options.architectures) {
      const slice = path.join(build, arch, target.name)
      await mkdir(path.dirname(slice), { recursive: true })
      await command(
        "xcrun",
        swiftArguments({
          arch,
          sources: target.sources,
          ...(target.name === "test-target" ? { moduleName: MAC_TEST_TARGET.executable } : { generated }),
          output: slice,
          sourceRoot: directory,
          sdk,
        }),
        settings,
      )
      slices.push(slice)
    }
    if (slices.length > 1) await command("xcrun", ["lipo", "-create", ...slices, "-output", target.output], settings)
    else await copyFile(slices[0]!, target.output)
    await chmod(target.output, 0o755)
  }
  const identifier = Hands.helperBundleId(APP_IDS[options.channel])
  await command(
    "/usr/bin/codesign",
    [
      "--force",
      "--sign",
      "-",
      "--options",
      "runtime",
      "--timestamp=none",
      "--entitlements",
      path.join(native, "entitlements.plist"),
      "--identifier",
      identifier,
      bundle,
    ],
    settings,
  )
  await command("/usr/bin/codesign", ["--verify", "--strict", bundle], settings)
  await command(
    "/usr/bin/codesign",
    [
      "--force",
      "--sign",
      "-",
      "--options",
      "runtime",
      "--timestamp=none",
      "--entitlements",
      path.join(native, "entitlements.plist"),
      "--identifier",
      MAC_TEST_TARGET.bundleId,
      testTarget,
    ],
    settings,
  )
  const builtArchitectures = binaryArchitectures(await readFile(executable))
  if (!options.architectures.every((arch) => builtArchitectures.includes(arch)))
    throw new HelperBuildError("The built macOS helper has the wrong architecture.")
  if ((await sourceDigestFor(directory, "darwin", options.channel, toolchain, generated)) !== digest)
    throw new HelperBuildError("The native helper inputs changed during compilation.")
  const manifest = createManifest({
    helperVersion: identity.helperVersion,
    protocol: identity.protocol,
    platform: "darwin",
    sourceDigest: digest,
    toolchain,
    files: await manifestFiles(options.out, await filesUnder(bundle), options.architectures),
  })
  await writeFile(path.join(options.out, "computer-helper.json"), json(manifest))
  const testManifest = createManifest({
    helperVersion: identity.helperVersion,
    protocol: identity.protocol,
    platform: "darwin",
    sourceDigest: digest,
    toolchain,
    files: await manifestFiles(
      tests,
      [
        path.join(tests, "VectorComputerTests"),
        path.join(tests, "VectorComputerCaller"),
        ...(await filesUnder(testTarget)),
      ],
      options.architectures,
    ),
  })
  await writeFile(path.join(tests, MAC_TEST_TARGET.manifest), json(testManifest))
  await verifyMacTestArtifacts(tests, options.architectures, {
    directory,
    channel: options.channel,
    host,
    run: command,
    environment,
    helperManifest: manifest,
  })
  if (builtArchitectures.includes(input.hostArchitecture ?? process.arch))
    await verifyVersion(executable, manifest, command, settings)
  if (options.checkLock) await checkMacLock(directory, options.out, manifest, options.architectures, command, settings)
  return [manifest]
}

export function renderHelperPlist(template: string, values: Record<string, string>) {
  const tokens = new Set([
    "HELPER_BUNDLE_ID",
    "HELPER_EXECUTABLE",
    "HELPER_NAME",
    "HELPER_VERSION",
    "MINIMUM_SYSTEM_VERSION",
    "SOURCE_DIGEST",
  ])
  if (
    Object.keys(values).length !== tokens.size ||
    Object.keys(values).some((key) => !tokens.has(key)) ||
    !validHash(values.SOURCE_DIGEST)
  )
    throw new HelperBuildError("The helper bundle metadata is incomplete.")
  const used = new Set<string>()
  const result = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, token: string) => {
    if (!tokens.has(token)) throw new HelperBuildError("The helper bundle template has an unknown token.")
    used.add(token)
    return values[token]!.replace(
      /[&<>"']/g,
      (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!,
    )
  })
  if (used.size !== tokens.size || result.includes("{{") || result.includes("}}"))
    throw new HelperBuildError("The helper bundle template is incomplete.")
  return result
}

/** Test artifacts have their own manifest and never become shipping helper resources. This never launches them. */
export async function verifyMacTestArtifacts(
  root: string,
  architectures: readonly HelperArchitecture[],
  input: {
    directory?: string
    channel?: BuildOptions["channel"]
    host?: string
    run?: NativeCommand
    environment?: NodeJS.ProcessEnv
    helperManifest?: HelperManifest
  } = {},
) {
  const directory = input.directory ?? packageDirectory
  const identity = readIdentity(path.join(directory, "native/computer-helper/identity.json"))
  const base = await realpath(root)
  const manifestFile = path.join(base, MAC_TEST_TARGET.manifest)
  const manifestStatus = await lstat(manifestFile)
  if (!manifestStatus.isFile() || manifestStatus.isSymbolicLink() || manifestStatus.size > 64 * 1024)
    throw new HelperBuildError("The macOS test artifact manifest is not a bounded regular file.")
  const manifest = parseHelperManifest(JSON.parse(await readFile(manifestFile, "utf8")))
  if (
    manifest.platform !== "darwin" ||
    manifest.helperVersion !== identity.helperVersion ||
    manifest.protocol.min !== identity.protocol.min ||
    manifest.protocol.max !== identity.protocol.max ||
    Object.keys(manifest.files).sort().join("\0") !== macTestArtifactNames.join("\0") ||
    (input.helperManifest &&
      (input.helperManifest.platform !== "darwin" ||
        input.helperManifest.helperVersion !== manifest.helperVersion ||
        input.helperManifest.sourceDigest !== manifest.sourceDigest ||
        input.helperManifest.toolchain !== manifest.toolchain ||
        input.helperManifest.protocol.min !== manifest.protocol.min ||
        input.helperManifest.protocol.max !== manifest.protocol.max))
  )
    throw new HelperBuildError("The macOS test artifact manifest does not match the helper or expected layout.")
  const actual = (await filesUnder(base))
    .map((file) => path.relative(base, file).split(path.sep).join("/"))
    .filter((file) => file !== MAC_TEST_TARGET.manifest)
    .sort()
  if (actual.join("\0") !== macTestArtifactNames.join("\0"))
    throw new HelperBuildError("The macOS test artifact directory contains files outside its manifest.")
  const declared = manifest.files.VectorComputerTests!.arch
  if (!architectures.length || !architectures.every((arch) => declared.includes(arch)))
    throw new HelperBuildError("The macOS test artifacts do not contain every requested architecture.")
  for (const [relative, metadata] of Object.entries(manifest.files)) {
    const file = path.join(base, ...relative.split("/"))
    const status = await lstat(file),
      resolved = await realpath(file)
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      !resolved.startsWith(base + path.sep) ||
      sha256(await readFile(file)) !== metadata.sha256 ||
      metadata.arch.length !== declared.length ||
      !metadata.arch.every((arch) => declared.includes(arch))
    )
      throw new HelperBuildError("A macOS test artifact failed its manifest hash or architecture check.")
  }
  for (const relative of [
    "VectorComputerTests",
    "VectorComputerCaller",
    `${MAC_TEST_TARGET.bundle}/Contents/MacOS/${MAC_TEST_TARGET.executable}`,
  ]) {
    const bytes = await readFile(path.join(base, ...relative.split("/")))
    const thin = bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf
    const universal =
      bytes.length >= 8 &&
      bytes.readUInt32BE(0) === 0xcafebabe &&
      bytes.readUInt32BE(4) === declared.length &&
      bytes.length >= 8 + declared.length * 20
    if (!thin && !universal) throw new HelperBuildError("A macOS test artifact is not a supported Mach-O binary.")
    const found = binaryArchitectures(bytes)
    if (found.length !== declared.length || !declared.every((arch) => found.includes(arch)))
      throw new HelperBuildError("A macOS test artifact binary has the wrong architecture.")
  }
  const generated = path.join(directory, "native/build/computer-helper-tests-prebuilt/generated")
  const identitySource = generateIdentitySources(generated, {
    identity: path.join(directory, "native/computer-helper/identity.json"),
    blocklist: path.join(directory, "native/computer-helper/blocklist.json"),
  }).find((file) => file.endsWith("Identity.swift"))!
  if (
    manifest.sourceDigest !==
    (await sourceDigestFor(directory, "darwin", input.channel ?? "prod", manifest.toolchain, identitySource))
  )
    throw new HelperBuildError("The macOS test artifact source digest does not match this source tree.")
  const target = path.join(base, MAC_TEST_TARGET.bundle)
  const expected = renderHelperPlist(
    await readFile(path.join(directory, "native/computer-helper/macos/TestTarget/Info.plist.template"), "utf8"),
    {
      HELPER_BUNDLE_ID: MAC_TEST_TARGET.bundleId,
      HELPER_EXECUTABLE: MAC_TEST_TARGET.executable,
      HELPER_NAME: MAC_TEST_TARGET.name,
      HELPER_VERSION: identity.helperVersion,
      MINIMUM_SYSTEM_VERSION: identity.mac.minimumSystemVersion,
      SOURCE_DIGEST: manifest.sourceDigest,
    },
  )
  if ((await readFile(path.join(target, "Contents/Info.plist"), "utf8")) !== expected)
    throw new HelperBuildError("The macOS test target metadata does not match its source template.")
  if ((input.host ?? process.platform) === "darwin") {
    const run = input.run ?? runNativeCommand
    const settings = { cwd: directory, env: input.environment ?? process.env, timeoutMs: 5000 }
    if ((await run("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", target], settings)).code !== 0)
      throw new HelperBuildError("The macOS test target signature is invalid.")
    for (const arch of declared) {
      const architecture = arch === "x64" ? "x86_64" : "arm64"
      const signature = await run(
        "/usr/bin/codesign",
        ["--display", "--verbose=4", "--arch", architecture, target],
        settings,
      )
      const details = `${signature.stdout}\n${signature.stderr}`
      if (
        signature.code !== 0 ||
        !details.split(/\r?\n/).includes(`Identifier=${MAC_TEST_TARGET.bundleId}`) ||
        !/^Signature=adhoc\r?$/m.test(details) ||
        !/\bflags=0x[0-9a-f]+\([^)]*\bruntime\b[^)]*\)/i.test(details)
      )
        throw new HelperBuildError("The macOS test target must have its own hardened ad-hoc signature.")
      const entitlements = await run(
        "/usr/bin/codesign",
        ["--display", "--arch", architecture, "--entitlements", ":-", target],
        settings,
      )
      const body = `${entitlements.stdout}\n${entitlements.stderr}`
        .match(/<plist\b[^>]*>([\s\S]*?)<\/plist>/)?.[1]
        ?.trim()
      if (entitlements.code !== 0 || !body || !/^(?:<dict\s*\/\s*>|<dict>\s*<\/dict>)$/.test(body))
        throw new HelperBuildError("The macOS test target entitlements must be an empty dictionary.")
    }
  }
  return manifest
}

/** Windows fixtures are executable artifacts too; their independent manifest binds them to the shipped source. */
export async function verifyWindowsTestArtifacts(
  root: string,
  architecture: HelperArchitecture,
  input: { directory?: string; channel?: BuildOptions["channel"]; helperManifest: HelperManifest },
) {
  const directory = input.directory ?? packageDirectory
  const identity = readIdentity(path.join(directory, "native/computer-helper/identity.json"))
  const base = await realpath(root)
  const manifestFile = path.join(base, WINDOWS_TEST_ARTIFACTS.manifest)
  const status = await lstat(manifestFile)
  if (!status.isFile() || status.isSymbolicLink() || status.size > 65_536)
    throw new HelperBuildError("The Windows test manifest is not a bounded regular file.")
  const manifest = parseHelperManifest(JSON.parse(await readFile(manifestFile, "utf8")))
  const helper = input.helperManifest
  if (
    manifest.platform !== "win32" ||
    helper.platform !== "win32" ||
    manifest.helperVersion !== identity.helperVersion ||
    manifest.protocol.min !== identity.protocol.min ||
    manifest.protocol.max !== identity.protocol.max ||
    manifest.helperVersion !== helper.helperVersion ||
    manifest.sourceDigest !== helper.sourceDigest ||
    manifest.toolchain !== helper.toolchain ||
    manifest.protocol.min !== helper.protocol.min ||
    manifest.protocol.max !== helper.protocol.max ||
    Object.keys(manifest.files).sort().join("\0") !== windowsTestArtifactNames.join("\0")
  )
    throw new HelperBuildError("The Windows test manifest does not match the helper or expected layout.")
  const actual = (await filesUnder(base))
    .map((file) => path.relative(base, file).split(path.sep).join("/"))
    .filter((file) => file !== WINDOWS_TEST_ARTIFACTS.manifest)
    .sort()
  if (actual.join("\0") !== windowsTestArtifactNames.join("\0"))
    throw new HelperBuildError("The Windows test directory contains files outside its manifest.")
  for (const name of windowsTestArtifactNames) {
    const file = path.join(base, name)
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size < 128 || info.size > 64 * 1024 * 1024)
      throw new HelperBuildError("A Windows test artifact is not a bounded regular executable.")
    const bytes = await readFile(file)
    const metadata = manifest.files[name]!
    const offset = bytes.readUInt16LE(0) === 0x5a4d ? bytes.readUInt32LE(0x3c) : 0
    if (
      metadata.sha256 !== sha256(bytes) ||
      metadata.arch.length !== 1 ||
      metadata.arch[0] !== architecture ||
      offset < 64 ||
      offset > bytes.length - 26 ||
      bytes.readUInt32LE(offset) !== 0x4550 ||
      bytes.readUInt16LE(offset + 24) !== 0x20b ||
      !binaryArchitectures(bytes).includes(architecture)
    )
      throw new HelperBuildError("A Windows test artifact failed its hash, PE or architecture check.")
  }
  const generated = path.join(directory, "native/build/computer-helper-tests-win32/generated")
  const identitySource = generateIdentitySources(generated, {
    identity: path.join(directory, "native/computer-helper/identity.json"),
    blocklist: path.join(directory, "native/computer-helper/blocklist.json"),
  }).find((file) => file.endsWith("Identity.swift"))!
  if (
    manifest.sourceDigest !==
    (await sourceDigestFor(directory, "win32", input.channel ?? "prod", manifest.toolchain, identitySource))
  )
    throw new HelperBuildError("The Windows test artifact source digest does not match this source tree.")
  return manifest
}

export async function verifyPrebuiltHelper(
  root: string,
  platform: HelperPlatform,
  architectures: readonly HelperArchitecture[],
  input: {
    directory?: string
    channel?: "prod" | "beta" | "dev"
    host?: string
    hostArchitecture?: string
    run?: NativeCommand
    environment?: NodeJS.ProcessEnv
  } = {},
) {
  const directory = input.directory ?? packageDirectory
  const identity = readIdentity(path.join(directory, "native/computer-helper/identity.json"))
  const manifest = parseHelperManifest(JSON.parse(await readFile(path.join(root, "computer-helper.json"), "utf8")))
  if (
    manifest.platform !== platform ||
    manifest.helperVersion !== identity.helperVersion ||
    manifest.protocol.min !== identity.protocol.min ||
    manifest.protocol.max !== identity.protocol.max
  )
    throw new HelperBuildError("The prebuilt helper version or platform does not match this source tree.")
  const executableName =
    platform === "darwin"
      ? `${identity.mac.bundle}/Contents/MacOS/${identity.mac.executable}`
      : identity.windows.executable
  if (
    !manifest.files[executableName] ||
    !architectures.every((arch) => manifest.files[executableName]!.arch.includes(arch))
  )
    throw new HelperBuildError("The prebuilt helper does not contain every requested architecture.")
  const base = await realpath(root)
  for (const [relative, metadata] of Object.entries(manifest.files)) {
    const file = path.join(base, ...relative.split("/"))
    const status = await lstat(file)
    const resolved = await realpath(file)
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      !resolved.startsWith(base + path.sep) ||
      sha256(await readFile(file)) !== metadata.sha256
    )
      throw new HelperBuildError("A prebuilt helper file failed its manifest hash check.")
  }
  const executable = path.join(base, ...executableName.split("/"))
  const found = binaryArchitectures(await readFile(executable))
  if (!architectures.every((arch) => found.includes(arch)))
    throw new HelperBuildError("The prebuilt helper binary has the wrong architecture.")
  if (platform === "darwin") {
    const actual = (await filesUnder(path.join(base, identity.mac.bundle)))
      .map((file) => path.relative(base, file).split(path.sep).join("/"))
      .sort()
    if (actual.join("\0") !== Object.keys(manifest.files).sort().join("\0"))
      throw new HelperBuildError("The prebuilt helper bundle contains files outside its manifest.")
  }
  const generated = path.join(directory, "native/build/computer-helper-prebuilt/generated")
  const identitySource = generateIdentitySources(generated, {
    identity: path.join(directory, "native/computer-helper/identity.json"),
    blocklist: path.join(directory, "native/computer-helper/blocklist.json"),
  }).find((file) => file.endsWith("Identity.swift"))!
  if (
    manifest.sourceDigest !==
    (await sourceDigestFor(directory, platform, input.channel ?? "prod", manifest.toolchain, identitySource))
  )
    throw new HelperBuildError("The prebuilt helper source digest does not match this source tree.")
  if ((input.host ?? process.platform) === platform) {
    const run = input.run ?? runNativeCommand
    const settings = { cwd: directory, env: input.environment ?? process.env, timeoutMs: 5000 }
    if (platform === "darwin") {
      const verified = await run(
        "/usr/bin/codesign",
        ["--verify", "--strict", path.join(base, identity.mac.bundle)],
        settings,
      )
      if (verified.code !== 0) throw new HelperBuildError("The prebuilt helper signature is invalid.")
    }
    // Platform agreement does not make an ARM64 executable runnable on an x64 host (or the reverse).
    // Hash/source/header checks above and macOS signature verification remain mandatory for every slice.
    if (found.includes(input.hostArchitecture ?? process.arch)) await verifyVersion(executable, manifest, run, settings)
  }
  return manifest
}

async function checkMacLock(
  directory: string,
  output: string,
  manifest: HelperManifest,
  architectures: readonly HelperArchitecture[],
  run: NativeCommand,
  settings: Parameters<NativeCommand>[2],
) {
  const cdhash: IdentityLock["cdhash"] = {}
  for (const arch of architectures) {
    const result = await run(
      "/usr/bin/codesign",
      ["-dvvv", "--arch", arch === "x64" ? "x86_64" : "arm64", path.join(output, "VectorComputer.app")],
      settings,
    )
    const value = `${result.stdout}\n${result.stderr}`.match(/^CDHash=([a-fA-F0-9]{40})\r?$/m)?.[1]
    if (result.code !== 0 || !value) throw new HelperBuildError("The helper slice cdhash could not be measured.")
    cdhash[arch] = value.toLowerCase()
  }
  const candidate: IdentityLock = {
    enforce: true,
    helperVersion: manifest.helperVersion,
    sourceDigest: manifest.sourceDigest,
    toolchain: manifest.toolchain,
    cdhash,
  }
  const verdict = checkIdentityLock(
    JSON.parse(await readFile(path.join(directory, "native/computer-helper/macos/identity.lock.json"), "utf8")),
    candidate,
  )
  if (!verdict.problems.length) return
  const file = path.join(output, "identity.lock.computed.json")
  await writeFile(file, json(candidate))
  if (settings.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      settings.env.GITHUB_STEP_SUMMARY,
      `\nComputer helper identity requires review. Candidate artifact: identity.lock.computed.json\n\n\`\`\`json\n${json(candidate)}\`\`\`\n`,
    )
  if (!verdict.ok) throw new HelperBuildError(verdict.problems.join(" "))
  console.warn(verdict.problems.join(" "))
}

async function verifyVersion(
  executable: string,
  manifest: HelperManifest,
  run: NativeCommand,
  settings: Parameters<NativeCommand>[2],
) {
  const result = await run(executable, ["--version", "--json"], { ...settings, timeoutMs: 5000 })
  const value: unknown = JSON.parse(result.stdout)
  if (
    result.code !== 0 ||
    !record(value) ||
    value.helperVersion !== manifest.helperVersion ||
    value.sourceDigest !== manifest.sourceDigest ||
    value.platform !== manifest.platform ||
    !record(value.protocol) ||
    value.protocol.min !== manifest.protocol.min ||
    value.protocol.max !== manifest.protocol.max ||
    !validArchitecture(value.arch) ||
    !Object.values(manifest.files).some((file) => file.arch.includes(value.arch as HelperArchitecture))
  )
    throw new HelperBuildError("The built helper version does not match its manifest.")
}

async function buildWindows(
  options: BuildOptions,
  directory: string,
  identity: ReturnType<typeof readIdentity>,
  run: NativeCommand,
  settings: Parameters<NativeCommand>[2],
  hostArchitecture: string,
) {
  const native = path.join(directory, "native/computer-helper/windows")
  if (!(await lstat(path.join(native, "CMakeLists.txt")).catch(() => undefined))?.isFile())
    throw new HelperBuildError("The Windows helper target is not implemented yet.", 2)
  const selected = windowsToolchainSelection(settings.env)
  const cmake = (await run("cmake", ["--version"], settings)).stdout.split(/\r?\n/)[0]?.trim()
  const cmakeVersion = cmake?.match(/^cmake version (\d+)\.(\d+)\.\d+(?:[-+][^\s]+)?$/)
  if (!cmakeVersion || Number(cmakeVersion[1]) < 3 || (Number(cmakeVersion[1]) === 3 && Number(cmakeVersion[2]) < 27))
    throw new HelperBuildError("CMake 3.27 or newer is required to select the exact Windows SDK.", 2)
  const probe = path.join(directory, "native/build/computer-helper-win32/toolchain")
  await mkdir(probe, { recursive: true })
  await writeFile(path.join(probe, "version.cpp"), "int vector_computer_toolchain_probe() { return 0; }\n")
  const compiler = await run(
    "cl",
    ["/Bv", "/c", path.join(probe, "version.cpp"), `/Fo${path.join(probe, "version.obj")}`],
    settings,
  )
  const version = `${compiler.stdout}\n${compiler.stderr}`.match(/Compiler Version ([0-9.]+) /)?.[1]
  if (!cmake || !version) throw new HelperBuildError("The Windows native toolchain could not be measured.")
  const toolchain = `${cmake}\nmsvc:${version}\nvc-tools:${selected.toolset}\nwindows-sdk:${selected.sdk}`
  const generated = path.join(directory, "native/build/computer-helper-win32/generated")
  generateIdentitySources(generated, {
    identity: path.join(directory, "native/computer-helper/identity.json"),
    blocklist: path.join(directory, "native/computer-helper/blocklist.json"),
  })
  const digest = await sourceDigestFor(
    directory,
    "win32",
    options.channel,
    toolchain,
    path.join(generated, "Identity.swift"),
  )
  const manifests: HelperManifest[] = []
  for (const arch of options.architectures) {
    const build = path.join(directory, `native/build/win32-${arch}`)
    const output = path.join(options.out, arch)
    await run(
      "cmake",
      [
        "-S",
        native,
        "-B",
        build,
        "-A",
        `${arch === "x64" ? "x64" : "ARM64"},version=${selected.sdk}`,
        "-T",
        `version=${selected.toolset}`,
        "--fresh",
        `-DVECTOR_COMPUTER_GENERATED_DIR=${generated}`,
        `-DVECTOR_COMPUTER_SOURCE_DIGEST=${digest}`,
      ],
      settings,
    )
    await run("cmake", ["--build", build, "--config", "Release"], settings)
    await mkdir(path.join(output, "tests"), { recursive: true })
    await copyFile(
      path.join(build, "Release", identity.windows.executable),
      path.join(output, identity.windows.executable),
    )
    for (const file of windowsTestArtifactNames)
      await copyFile(path.join(build, "Release", file), path.join(output, "tests", file))
    if (
      (await sourceDigestFor(
        directory,
        "win32",
        options.channel,
        toolchain,
        path.join(generated, "Identity.swift"),
      )) !== digest
    )
      throw new HelperBuildError("The native helper inputs changed during compilation.")
    const manifest = createManifest({
      helperVersion: identity.helperVersion,
      protocol: identity.protocol,
      platform: "win32",
      sourceDigest: digest,
      toolchain,
      files: await manifestFiles(output, [path.join(output, identity.windows.executable)], [arch]),
    })
    await writeFile(path.join(output, "computer-helper.json"), json(manifest))
    const testManifest = createManifest({
      ...manifest,
      files: await manifestFiles(
        path.join(output, "tests"),
        windowsTestArtifactNames.map((name) => path.join(output, "tests", name)),
        [arch],
      ),
    })
    await writeFile(path.join(output, "tests", WINDOWS_TEST_ARTIFACTS.manifest), json(testManifest))
    await verifyWindowsTestArtifacts(path.join(output, "tests"), arch, {
      directory,
      channel: options.channel,
      helperManifest: manifest,
    })
    // An ARM64 binary cannot be executed on an x64 build host; its PE header still must match its output directory.
    if (!binaryArchitectures(await readFile(path.join(output, identity.windows.executable))).includes(arch))
      throw new HelperBuildError("The built Windows helper has the wrong architecture.")
    if (arch === hostArchitecture)
      await verifyVersion(path.join(output, identity.windows.executable), manifest, run, settings)
    manifests.push(manifest)
  }
  return manifests
}

/** The values come from the selected MSVC developer environment; neither CMake's latest SDK nor a guessed
 * compiler-to-toolset mapping is a reproducible substitute. CMake documents these exact version selectors in
 * Help/variable/CMAKE_GENERATOR_PLATFORM.rst (SDK, since 3.27) and CMAKE_GENERATOR_TOOLSET.rst (MSVC).
 */
export function windowsToolchainSelection(environment: NodeJS.ProcessEnv) {
  const toolset = environment.VCToolsVersion?.trim()
  const sdk = environment.WindowsSDKVersion?.trim().replace(/[\\/]$/, "")
  if (!toolset || !sdk)
    throw new HelperBuildError(
      "The Windows helper build requires VCToolsVersion and WindowsSDKVersion from the MSVC developer environment.",
      2,
    )
  if (!/^\d+\.\d+\.\d+$/.test(toolset) || !/^10\.0\.\d+\.\d+$/.test(sdk))
    throw new HelperBuildError("The MSVC developer environment has an invalid VCToolsVersion or WindowsSDKVersion.", 2)
  return { toolset, sdk }
}

export async function sourceDigestFor(
  directory: string,
  platform: HelperPlatform,
  channel: BuildOptions["channel"],
  toolchain: string,
  generated: string,
) {
  const root = path.join(directory, `native/computer-helper/${platform === "darwin" ? "macos" : "windows"}`)
  const files = (await filesUnder(root)).filter((file) => path.basename(file) !== "identity.lock.json")
  files.push(
    ...[
      "native/computer-helper/identity.json",
      "native/computer-helper/blocklist.json",
      "scripts/build-computer-helper.ts",
      "scripts/computer-helper-identity.ts",
      "scripts/channel-ids.ts",
      `icons/${channel}/${platform === "darwin" ? "icon.icns" : "icon.ico"}`,
    ].map((file) => path.join(directory, file)),
  )
  const entries = await Promise.all(
    files.map(async (file) => ({
      path: path.relative(directory, file).split(path.sep).join("/"),
      bytes: await readFile(file),
    })),
  )
  const generatedInputs =
    platform === "darwin"
      ? [generated]
      : ["identity.h", "blocklist.h"].map((file) => path.join(path.dirname(generated), file))
  entries.push(
    ...(await Promise.all(
      generatedInputs.map(async (file) => ({
        path: `generated/${path.basename(file)}`,
        bytes: await readFile(file),
      })),
    )),
  )
  return computeSourceDigest(entries, toolchain)
}

async function manifestFiles(root: string, files: readonly string[], architectures: readonly HelperArchitecture[]) {
  return Object.fromEntries(
    await Promise.all(
      [...files]
        .sort()
        .map(async (file) => [
          path.relative(root, file).split(path.sep).join("/"),
          { sha256: sha256(await readFile(file)), arch: [...architectures] },
        ]),
    ),
  )
}

async function filesUnder(directory: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink())
      throw new HelperBuildError("Native helper inputs and outputs cannot contain symbolic links.")
    if (entry.isDirectory()) result.push(...(await filesUnder(file)))
    else if (entry.isFile()) result.push(file)
    else throw new HelperBuildError("Native helper inputs and outputs must be regular files.")
  }
  return result
}

function safeRelativePath(value: string) {
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !value.includes(":") &&
    !value.startsWith("/") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  )
}

function json(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await buildComputerHelper(
      parseBuildOptions(process.argv.slice(2), { prebuilt: process.env.VECTOR_COMPUTER_HELPER_PREBUILT }),
    )
  } catch (error) {
    console.error(error instanceof HelperBuildError ? error.message : "The computer helper build failed.")
    process.exitCode = error instanceof HelperBuildError ? error.exitCode : 1
  }
}
