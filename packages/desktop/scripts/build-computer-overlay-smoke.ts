import { createHash } from "node:crypto"
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import {
  createManifest,
  runNativeCommand,
  swiftArguments,
  verifyPrebuiltHelper,
  windowsToolchainSelection,
  type HelperArchitecture,
  type HelperPlatform,
  type NativeCommand,
} from "./build-computer-helper"
import { generateIdentitySources, readIdentity } from "./computer-helper-identity"
import {
  COMPUTER_OVERLAY_ENTRYPOINTS,
  computerOverlaySourceDigest,
  computerOverlaySourceGraph,
  verifyComputerOverlayBundleGraph,
} from "./computer-overlay-smoke-source"
import { computerOverlayStagePaths, verifyComputerOverlayStage } from "./computer-overlay-smoke-stage"
import { binaryArchitectures } from "./verify-native"

type OverlayCompilerPlugin = {
  name: string
  setup(builder: {
    onResolve(options: { filter: RegExp }, resolve: (args: { path: string }) => Promise<{ path: string }>): void
  }): void
}

/** jsonc-parser's UMD factory retains Node require('./impl/*') after bundling. Use its pinned ESM input. */
function computerOverlayJsoncPlugin(directory: string): OverlayCompilerPlugin {
  let entry: Promise<string> | undefined
  return {
    name: "computer-overlay-jsonc-parser-esm",
    setup(builder) {
      builder.onResolve({ filter: /^jsonc-parser$/ }, async () => {
        entry ??= (async () => {
          const require = createRequire(path.join(directory, "package.json"))
          const packageFile = await realpath(require.resolve("jsonc-parser/package.json"))
          const metadata = JSON.parse(await readFile(packageFile, "utf8")) as {
            name?: unknown
            version?: unknown
            module?: unknown
            main?: unknown
          }
          const desktop = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as {
            dependencies?: { "jsonc-parser"?: unknown }
          }
          if (
            metadata.name !== "jsonc-parser" ||
            metadata.version !== "3.3.1" ||
            desktop.dependencies?.["jsonc-parser"] !== "3.3.1" ||
            metadata.module !== "./lib/esm/main.js" ||
            metadata.main !== "./lib/umd/main.js"
          )
            throw new Error("The overlay compiler requires the exact pinned jsonc-parser ESM input.")
          const base = path.dirname(packageFile),
            requested = path.join(base, "lib/esm/main.js")
          const status = await lstat(requested),
            canonical = await realpath(requested)
          if (
            !status.isFile() ||
            status.isSymbolicLink() ||
            status.size < 1 ||
            canonical !== requested ||
            !canonical.startsWith(base + path.sep)
          )
            throw new Error("The pinned overlay parser input is invalid.")
          return canonical
        })()
        return { path: await entry }
      })
    },
  }
}

type OverlayCompileOptions = {
  entrypoints: string[]
  root: string
  target: "node"
  format: "esm" | "cjs"
  external: string[]
  plugins: OverlayCompilerPlugin[]
  allowUnresolved: string[]
  splitting: false
  metafile: true
  define: Record<string, string>
  outdir: string
  naming: string
}
export type OverlayCompiler = {
  version: string
  build(options: OverlayCompileOptions): Promise<{
    success: boolean
    outputs: { path: string }[]
    metafile?: unknown
  }>
}
// Module-local compiler facade: importing this script never augments renderer or Node globals.
declare const Bun: OverlayCompiler

export function computerOverlayBundlePlan(directory: string, output: string, sourceDigest?: string) {
  if (sourceDigest !== undefined && !/^[a-f0-9]{64}$/.test(sourceDigest))
    throw new Error("The overlay compiler source literal is invalid.")
  return COMPUTER_OVERLAY_ENTRYPOINTS.map((entry): { entry: typeof entry; options: OverlayCompileOptions } => ({
    entry,
    options: {
      entrypoints: [path.join(directory, entry.input)],
      root: directory,
      target: "node",
      format: entry.format,
      external: ["electron"],
      plugins: [computerOverlayJsoncPlugin(directory)],
      allowUnresolved: [],
      splitting: false,
      metafile: true,
      define: sourceDigest === undefined ? {} : { VECTOR_COMPUTER_SMOKE_SOURCE_DIGEST: JSON.stringify(sourceDigest) },
      outdir: output,
      naming: entry.output,
    },
  }))
}

const packageDirectory = fileURLToPath(new URL("../", import.meta.url))
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const swiftString = (value: string) => JSON.stringify(value)
export type OverlayBuildOptions = {
  platform: HelperPlatform
  out: string
  helper: string
  channel: "prod" | "beta" | "dev"
}
export function parseComputerOverlayBuildOptions(
  args: readonly string[],
  host: string = process.platform,
): OverlayBuildOptions {
  const parsed = parseArgs({
    args: [...args],
    strict: true,
    tokens: true,
    allowPositionals: false,
    options: {
      platform: { type: "string" },
      out: { type: "string" },
      helper: { type: "string" },
      "helper-channel": { type: "string" },
    },
  })
  const supplied = new Set<string>()
  for (const token of parsed.tokens)
    if (token.kind === "option") {
      if (supplied.has(token.name)) throw new Error("The overlay build received a duplicate argument.")
      supplied.add(token.name)
    }
  const platform = parsed.values.platform ?? host
  const channel = parsed.values["helper-channel"] ?? process.env.VECTOR_CHANNEL ?? "prod"
  if (channel !== "prod" && channel !== "beta" && channel !== "dev")
    throw new Error("The overlay helper channel must match the validated build channel.")
  if (
    (platform !== "darwin" && platform !== "win32") ||
    !parsed.values.out ||
    !parsed.values.helper ||
    [parsed.values.out, parsed.values.helper].some((value) => value.includes("\0"))
  )
    throw new Error("Choose the actual native platform, output and verified production helper for the overlay build.")
  return { platform, out: path.resolve(parsed.values.out), helper: path.resolve(parsed.values.helper), channel }
}

export function computerOverlayPinValues(input: {
  sourceDigest: string
  electronVersion: string
  electron: Uint8Array
  main: Uint8Array
  preload: Uint8Array
  fakeHelper: Uint8Array
  defaultApp: Uint8Array
}) {
  if (
    !/^[a-f0-9]{64}$/.test(input.sourceDigest) ||
    !/^\d+\.\d+\.\d+$/.test(input.electronVersion) ||
    [input.electron, input.main, input.preload, input.fakeHelper, input.defaultApp].some(
      (bytes) => bytes.byteLength < 1 || bytes.byteLength > 512 * 1024 * 1024,
    )
  )
    throw new Error("The overlay driver pins require actual bounded generated bytes.")
  return {
    sourceDigest: input.sourceDigest,
    electronVersion: input.electronVersion,
    electronSha256: sha(input.electron),
    mainSha256: sha(input.main),
    preloadSha256: sha(input.preload),
    fakeHelperSha256: sha(input.fakeHelper),
    defaultAppSha256: sha(input.defaultApp),
  }
}
export function computerOverlaySwiftIdentity(pins: ReturnType<typeof computerOverlayPinValues>) {
  return (
    "// Generated from exact C2 overlay stage bytes. Never supplied at runtime.\nenum OverlayDriverIdentity {\n" +
    Object.entries(pins)
      .map(([key, value]) => `    static let ${key} = ${swiftString(value)}\n`)
      .join("") +
    "}\n"
  )
}
export function computerOverlayCmakePins(pins: ReturnType<typeof computerOverlayPinValues>) {
  return [
    "-DVECTOR_COMPUTER_OVERLAY_DRIVER=ON",
    `-DVECTOR_COMPUTER_SOURCE_DIGEST=${pins.sourceDigest}`,
    `-DVECTOR_OVERLAY_ELECTRON_VERSION=${pins.electronVersion}`,
    ...(
      [
        ["ELECTRON", "electronSha256"],
        ["MAIN", "mainSha256"],
        ["PRELOAD", "preloadSha256"],
        ["FAKE_HELPER", "fakeHelperSha256"],
        ["DEFAULT_APP", "defaultAppSha256"],
      ] as const
    ).map(([key, field]) => `-DVECTOR_OVERLAY_${key}_SHA256=${pins[field]}`),
  ]
}

/** Dedicated CI build. It never installs over a shipping helper or launches Electron/input/capture. */
export async function buildComputerOverlaySmoke(
  options: OverlayBuildOptions,
  input: {
    directory?: string
    run?: NativeCommand
    environment?: NodeJS.ProcessEnv
    host?: string
    architecture?: string
  } = {},
) {
  const directory = path.resolve(input.directory ?? packageDirectory),
    host = input.host ?? process.platform,
    observedArchitecture = input.architecture ?? process.arch
  if (host !== options.platform || (observedArchitecture !== "x64" && observedArchitecture !== "arm64"))
    throw new Error("Build the overlay native driver only on its actual supported host.")
  const architecture: HelperArchitecture = observedArchitecture
  if (typeof Bun === "undefined" || typeof Bun.build !== "function")
    throw new Error("Bun is required only as the pinned overlay compiler.")
  const environment = { ...(input.environment ?? process.env), ZERO_AR_DATE: "1" }
  const run = input.run ?? runNativeCommand
  const settings = { cwd: directory, env: environment, timeoutMs: 300_000 }
  const command: NativeCommand = async (binary, args, context) => {
    const result = await run(binary, args, context)
    if (result.code !== 0) throw new Error("The dedicated overlay native build command failed.")
    return result
  }
  const graph = await computerOverlaySourceGraph(directory)
  if (Bun.version !== graph.bunVersion)
    throw new Error("The overlay build requires the repository's exact pinned Bun compiler.")
  const native = await verifyPrebuiltHelper(options.helper, options.platform, [architecture], {
    directory,
    channel: options.channel,
    run: command,
    environment,
  })
  const sourceDigest = computerOverlaySourceDigest(native.sourceDigest, graph)
  const target = path.resolve(options.out)
  const canonicalParent = await realpath(path.dirname(target))
  if (
    path.dirname(target) !== canonicalParent ||
    target === options.helper ||
    target.startsWith(options.helper + path.sep) ||
    target === directory ||
    target === graph.repository
  )
    throw new Error("The overlay stage output must be an isolated new directory.")
  const previous = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return
    throw error
  })
  if (previous) throw new Error("The overlay stage output already exists; stale test artifacts cannot be reused.")
  await mkdir(target)
  const build = await mkdtemp(path.join(tmpdir(), "vector-computer-overlay-build-"))
  try {
    const require = createRequire(path.join(directory, "package.json"))
    const electronPackage = require.resolve("electron/package.json"),
      installed = JSON.parse(await readFile(electronPackage, "utf8")) as { version?: unknown }
    const desktop = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as {
      devDependencies?: { electron?: unknown }
    }
    if (
      typeof installed.version !== "string" ||
      installed.version !== desktop.devDependencies?.electron ||
      installed.version !== "42.11.4"
    )
      throw new Error("The overlay stage requires the exact pinned installed Electron.")
    const distribution = await realpath(path.join(path.dirname(electronPackage), "dist"))
    const relativeElectron = (await readFile(path.join(path.dirname(electronPackage), "path.txt"), "utf8")).trim()
    const installedExecutable = await realpath(path.join(distribution, relativeElectron))
    if (!installedExecutable.startsWith(distribution + path.sep))
      throw new Error("The installed Electron escaped its distribution.")
    const paths = computerOverlayStagePaths(options.platform)
    await cp(distribution, path.join(target, "electron"), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    })
    await mkdir(path.join(target, "smoke"))
    for (const { entry, options: compile } of computerOverlayBundlePlan(
      directory,
      path.join(target, "smoke"),
      sourceDigest,
    )) {
      const result = await Bun.build(compile)
      if (!result.success || result.outputs.length !== 1)
        throw new Error("The overlay smoke compiler did not emit exactly its fixed bundle.")
      await verifyComputerOverlayBundleGraph(result.metafile, directory, graph, entry.input)
      const emitted = await realpath(result.outputs[0]!.path)
      if (emitted !== (await realpath(path.join(target, "smoke", entry.output))))
        throw new Error("The overlay compiler emitted an unexpected bundle path.")
    }
    if (
      !(await readFile(path.join(target, "smoke/computer-overlay-smoke-electron.mjs"))).includes(
        Buffer.from(sourceDigest),
      )
    )
      throw new Error("The native overlay main has no exact compiled source literal.")
    const driver = path.join(target, ...paths.driver.split("/")),
      electron = path.join(target, ...paths.electron.split("/"))
    if (!binaryArchitectures(await readFile(electron)).includes(architecture))
      throw new Error("The pinned Electron has the wrong host architecture.")
    const pins = computerOverlayPinValues({
      sourceDigest,
      electronVersion: installed.version,
      electron: await readFile(electron),
      main: await readFile(path.join(target, "smoke/computer-overlay-smoke-electron.mjs")),
      preload: await readFile(path.join(target, "smoke/computer-overlay-smoke-preload.cjs")),
      fakeHelper: await readFile(path.join(target, "smoke/computer-fake-helper.mjs")),
      defaultApp: await readFile(path.join(target, ...paths.defaultApp.split("/"))),
    })
    const generated = path.join(build, "generated")
    const identitySource = generateIdentitySources(generated, {
      identity: path.join(directory, "native/computer-helper/identity.json"),
      blocklist: path.join(directory, "native/computer-helper/blocklist.json"),
    }).find((file) => file.endsWith("Identity.swift"))!
    await mkdir(path.dirname(driver), { recursive: true })
    if (options.platform === "darwin") {
      const swift = (await command("xcrun", ["--sdk", "macosx", "swiftc", "--version"], settings)).stdout.trim()
      const sdkVersion = (await command("xcrun", ["--sdk", "macosx", "--show-sdk-version"], settings)).stdout.trim()
      const xcode = (await command("xcodebuild", ["-version"], settings)).stdout.trim()
      const sdk = (await command("xcrun", ["--sdk", "macosx", "--show-sdk-path"], settings)).stdout.trim()
      if (
        !swift ||
        !sdkVersion ||
        !xcode ||
        !path.isAbsolute(sdk) ||
        `swift:\n${swift}\nsdk:${sdkVersion}\nxcode:\n${xcode}` !== native.toolchain
      )
        throw new Error("The overlay native compiler differs from its measured C2 toolchain.")
      const nativeRoot = path.join(directory, "native/computer-helper/macos"),
        identity = readIdentity(path.join(directory, "native/computer-helper/identity.json"))
      const overlayIdentity = path.join(generated, "OverlayDriverIdentity.swift")
      await writeFile(overlayIdentity, computerOverlaySwiftIdentity(pins), { flag: "wx" })
      const sourceFiles = (await readdir(path.join(nativeRoot, "Sources")))
        .filter((name) => name.endsWith(".swift") && name !== "main.swift")
        .map((name) => path.join(nativeRoot, "Sources", name))
      const plist = (await readFile(path.join(nativeRoot, "TestOverlayDriver/Info.plist.template"), "utf8"))
        .replaceAll("{{HELPER_VERSION}}", identity.helperVersion)
        .replaceAll("{{MINIMUM_SYSTEM_VERSION}}", identity.mac.minimumSystemVersion)
        .replaceAll("{{SOURCE_DIGEST}}", sourceDigest)
      if (/\{\{[A-Z_]+\}\}/.test(plist))
        throw new Error("The dedicated overlay driver metadata has an unresolved field.")
      const bundle = path.resolve(path.dirname(driver), "../..")
      await writeFile(path.join(bundle, "Contents/Info.plist"), plist, { flag: "wx" })
      await command(
        "xcrun",
        swiftArguments({
          arch: architecture,
          sources: [
            ...sourceFiles,
            path.join(nativeRoot, "TestOverlayDriver/Policy.swift"),
            path.join(nativeRoot, "TestOverlayDriver/main.swift"),
            overlayIdentity,
          ],
          generated: identitySource,
          moduleName: "VectorComputerOverlayDriver",
          output: driver,
          sourceRoot: directory,
          sdk,
        }),
        settings,
      )
      await chmod(driver, 0o755)
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
          path.join(nativeRoot, "TestOverlayDriver/entitlements.plist"),
          "--identifier",
          "ai.vector.computer.test-overlay-driver",
          bundle,
        ],
        settings,
      )
      await command("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", bundle], settings)
      await command(
        "/usr/bin/codesign",
        ["--verify", "--strict", "--all-architectures", path.join(target, "electron/Electron.app")],
        settings,
      )
    } else {
      const selected = windowsToolchainSelection(environment),
        cmake = (await command("cmake", ["--version"], settings)).stdout.split(/\r?\n/)[0]?.trim()
      await writeFile(path.join(build, "version.cpp"), "int vector_computer_toolchain_probe() { return 0; }\n")
      const compiler = await command(
        "cl",
        ["/Bv", "/c", path.join(build, "version.cpp"), `/Fo${path.join(build, "version.obj")}`],
        settings,
      )
      const version = `${compiler.stdout}\n${compiler.stderr}`.match(/Compiler Version ([0-9.]+) /)?.[1]
      if (
        !cmake ||
        !version ||
        `${cmake}\nmsvc:${version}\nvc-tools:${selected.toolset}\nwindows-sdk:${selected.sdk}` !== native.toolchain
      )
        throw new Error("The overlay native compiler differs from its measured C2 toolchain.")
      const nativeBuild = path.join(build, "native")
      await command(
        "cmake",
        [
          "-S",
          path.join(directory, "native/computer-helper/windows"),
          "-B",
          nativeBuild,
          "-A",
          `${architecture === "x64" ? "x64" : "ARM64"},version=${selected.sdk}`,
          "-T",
          `version=${selected.toolset}`,
          "--fresh",
          `-DVECTOR_COMPUTER_GENERATED_DIR=${generated}`,
          ...computerOverlayCmakePins(pins),
        ],
        settings,
      )
      await command(
        "cmake",
        ["--build", nativeBuild, "--config", "Release", "--target", "computer-overlay-driver"],
        settings,
      )
      await copyFile(path.join(nativeBuild, "Release/VectorComputerOverlayDriver.exe"), driver)
    }
    if (!binaryArchitectures(await readFile(driver)).includes(architecture))
      throw new Error("The dedicated overlay driver has the wrong host architecture.")
    if (computerOverlaySourceDigest(native.sourceDigest, await computerOverlaySourceGraph(directory)) !== sourceDigest)
      throw new Error("The overlay source graph changed during compilation.")
    const files: Record<string, { sha256: string; arch: HelperArchitecture[] }> = {}
    async function catalog(current: string) {
      for (const item of await readdir(current, { withFileTypes: true })) {
        const file = path.join(current, item.name)
        if (item.isDirectory()) {
          await catalog(file)
          continue
        }
        if (item.isSymbolicLink()) continue // Verified narrowly by the stage admission pass below.
        const status = await lstat(file)
        if (!status.isFile() || status.size < 1 || status.size > 512 * 1024 * 1024)
          throw new Error("The overlay stage contains an invalid regular file.")
        files[path.relative(target, file).split(path.sep).join("/")] = {
          sha256: sha(await readFile(file)),
          arch: [architecture],
        }
      }
    }
    await catalog(target)
    const identity = readIdentity(path.join(directory, "native/computer-helper/identity.json"))
    const manifest = createManifest({
      helperVersion: identity.helperVersion,
      protocol: identity.protocol,
      platform: options.platform,
      sourceDigest,
      toolchain: native.toolchain,
      files,
    })
    await writeFile(path.join(target, "computer-overlay-smoke.json"), JSON.stringify(manifest, null, 2) + "\n", {
      flag: "wx",
    })
    await verifyComputerOverlayStage(target, {
      platform: options.platform,
      architecture,
      directory,
      channel: options.channel,
    })
    return manifest
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  } finally {
    await rm(build, { recursive: true, force: true })
  }
}

if (import.meta.main)
  void buildComputerOverlaySmoke(parseComputerOverlayBuildOptions(process.argv.slice(2))).then(
    () => {
      process.stdout.write("Built and verified the separate source-bound computer overlay stage.\n")
    },
    () => {
      process.stderr.write("The dedicated computer overlay build failed.\n")
      process.exitCode = 1
    },
  )
