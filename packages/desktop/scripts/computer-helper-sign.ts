import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Configuration } from "electron-builder"
import { Hands } from "@vectordevai/schema/hands"
import { APP_IDS } from "./channel-ids"
import { computerHelperSkipRequested } from "./computer-helper-package-node"
import { binaryArchitectures } from "./verify-native"
import type { HelperArchitecture, HelperManifest, NativeCommand } from "./build-computer-helper"

type MacSign = Exclude<NonNullable<NonNullable<Configuration["mac"]>["sign"]>, string>
type MacSignOptions = Parameters<MacSign>[0]
type SigningDependencies = {
  directory?: string
  environment?: NodeJS.ProcessEnv
  run?: NativeCommand
  signAsync?: (options: MacSignOptions) => Promise<void>
  wait?: (milliseconds: number) => Promise<void>
}
type HelperSigning = {
  app: string
  channel: Hands.Channel
  identity: string
  keychain?: string
  timestamp?: string
}

const packageDirectory = fileURLToPath(new URL("../", import.meta.url))
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
export type ComputerHelperSigningReceipt = {
  schemaVersion: 1
  channel: Hands.Channel
  sourceManifest: HelperManifest
  sourceCdhash: Partial<Record<HelperArchitecture, string>>
  finalManifestSha256: string
  finalExecutableSha256: string
  signing: "adhoc" | "developer-id"
}
type SigningBaseline = {
  channel: Hands.Channel
  manifest: HelperManifest
  bytes: Buffer
  cdhash: ComputerHelperSigningReceipt["sourceCdhash"]
}
const prepared = new Map<string, SigningBaseline>()
const unsignedFusePackagers = new WeakSet<object>()
const emptyDictionary = (text: string) =>
  /^(?:<dict\s*\/\s*>|<dict>\s*<\/dict>)$/.test(text.match(/<plist\b[^>]*>([\s\S]*?)<\/plist>/)?.[1]?.trim() ?? "")

const nativeCommand: NativeCommand = (command, args, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr })
      },
    )
  })

function command(dependencies: SigningDependencies) {
  const directory = path.resolve(dependencies.directory ?? packageDirectory)
  return async (args: string[], message: string) => {
    const result = await (dependencies.run ?? nativeCommand)("/usr/bin/codesign", args, {
      cwd: directory,
      env: dependencies.environment ?? process.env,
      timeoutMs: 120_000,
    })
    if (result.code !== 0) throw new Error(message)
    return `${result.stdout}\n${result.stderr}`
  }
}

async function helperPaths(app: string, channel: Hands.Channel) {
  if (!Object.hasOwn(APP_IDS, channel)) throw new Error("The computer helper signing channel is unknown.")
  const root = await realpath(app)
  const helper = path.join(root, "Contents/Helpers/VectorComputer.app")
  const status = await lstat(helper)
  if (!status.isDirectory() || status.isSymbolicLink() || !(await realpath(helper)).startsWith(root + path.sep))
    throw new Error("The packaged computer helper must be a directory inside the app.")
  const executable = path.join(helper, "Contents/MacOS/VectorComputer")
  for (const file of [executable, path.join(helper, "Contents/Info.plist")]) {
    const entry = await lstat(file)
    if (!entry.isFile() || entry.isSymbolicLink() || !(await realpath(file)).startsWith(helper + path.sep))
      throw new Error("The packaged computer helper contains an unexpected file path.")
  }
  const info = await readFile(path.join(helper, "Contents/Info.plist"), "utf8")
  if (
    info.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1] !==
      Hands.helperBundleId(APP_IDS[channel]) ||
    info.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)?.[1] !== "VectorComputer"
  )
    throw new Error("The packaged computer helper Info.plist has the wrong channel identity.")
  const architectures = binaryArchitectures(await readFile(executable))
  if (!architectures.length || architectures.some((architecture) => architecture !== "x64" && architecture !== "arm64"))
    throw new Error("The packaged computer helper has an unsupported architecture.")
  return { root, helper, executable, architectures }
}

async function helperFiles(helper: string): Promise<string[]> {
  const entries = await readdir(helper, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const file = path.join(helper, entry.name)
        if (entry.isSymbolicLink()) throw new Error("The computer helper cannot contain linked signing inputs.")
        if (entry.isDirectory()) return helperFiles(file)
        if (!entry.isFile()) throw new Error("The computer helper contains an unexpected signing input.")
        return [file]
      }),
    )
  ).flat()
}

/** Called after C3 verifies its Node bundle result, before any outer --deep signing can change the helper. */
export async function prepareComputerHelperMacSigning(
  input: { app: string; channel: Hands.Channel; sourceManifest: HelperManifest },
  dependencies: SigningDependencies = {},
) {
  const paths = await helperPaths(input.app, input.channel)
  if (prepared.has(paths.root)) throw new Error("The computer helper signing baseline was already prepared.")
  const file = path.join(paths.root, "Contents/Resources/computer-helper.json")
  const status = await lstat(file)
  if (!status.isFile() || status.isSymbolicLink() || !(await realpath(file)).startsWith(paths.root + path.sep))
    throw new Error("The packaged computer helper manifest is not a regular app resource.")
  const bytes = await readFile(file)
  const manifest: HelperManifest = JSON.parse(JSON.stringify(input.sourceManifest))
  if (JSON.stringify(JSON.parse(bytes.toString("utf8"))) !== JSON.stringify(manifest) || manifest.platform !== "darwin")
    throw new Error("The copied computer helper manifest differs from the verified C3 source.")
  const base = path.dirname(paths.helper)
  const actual = (await helperFiles(paths.helper))
    .map((item) => path.relative(base, item).split(path.sep).join("/"))
    .sort()
  if (actual.join("\0") !== Object.keys(manifest.files).sort().join("\0"))
    throw new Error("The computer helper file list changed before signing.")
  for (const relative of actual) {
    if (digest(await readFile(path.join(base, ...relative.split("/")))) !== manifest.files[relative]?.sha256)
      throw new Error("A computer helper file changed before signing.")
  }
  const executable = "VectorComputer.app/Contents/MacOS/VectorComputer"
  if (manifest.files[executable]?.arch.slice().sort().join("\0") !== paths.architectures.slice().sort().join("\0"))
    throw new Error("The computer helper signing architecture differs from its manifest.")
  await verifyComputerHelperMacSignature({ app: input.app, channel: input.channel, identity: "-" }, dependencies)
  const run = command(dependencies)
  const cdhash: ComputerHelperSigningReceipt["sourceCdhash"] = {}
  for (const architecture of paths.architectures) {
    const signature = await run(
      ["--display", "--verbose=4", "--arch", architecture === "x64" ? "x86_64" : "arm64", paths.helper],
      "The pre-sign helper cdhash could not be read.",
    )
    const measured = signature.match(/^CDHash=([a-fA-F0-9]{40})\r?$/m)?.[1]?.toLowerCase()
    if (!measured) throw new Error("The pre-sign helper cdhash is missing.")
    cdhash[architecture as HelperArchitecture] = measured
  }
  const lock: unknown = JSON.parse(
    await readFile(
      path.join(dependencies.directory ?? packageDirectory, "native/computer-helper/macos/identity.lock.json"),
      "utf8",
    ),
  )
  if (
    !lock ||
    typeof lock !== "object" ||
    Object.keys(lock).sort().join(",") !== "cdhash,enforce,helperVersion,sourceDigest,toolchain" ||
    !("enforce" in lock) ||
    lock.enforce !== true ||
    !("helperVersion" in lock) ||
    lock.helperVersion !== manifest.helperVersion ||
    !("toolchain" in lock) ||
    lock.toolchain !== manifest.toolchain ||
    !("cdhash" in lock) ||
    !lock.cdhash ||
    typeof lock.cdhash !== "object" ||
    !("sourceDigest" in lock)
  )
    throw new Error("The computer helper signing baseline does not match the enforced identity lock.")
  const lockedHashes = lock.cdhash
  if (
    typeof lock.sourceDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(lock.sourceDigest) ||
    Object.keys(lockedHashes).some((architecture) => architecture !== "x64" && architecture !== "arm64") ||
    !["x64", "arm64"].every((architecture) => {
      const hash: unknown = Reflect.get(lockedHashes, architecture)
      return typeof hash === "string" && /^[a-f0-9]{40}$/.test(hash)
    })
  )
    throw new Error("The computer helper identity lock has no complete measured baseline.")
  if (
    input.channel === "prod" &&
    (lock.sourceDigest !== manifest.sourceDigest ||
      Object.entries(cdhash).some(([architecture, hash]) => Reflect.get(lockedHashes, architecture) !== hash))
  )
    throw new Error("The production computer helper changed from its measured identity lock.")
  prepared.set(paths.root, { channel: input.channel, manifest, bytes, cdhash })
}

/** Rewrites only the packaged copy. The outer signature subsequently seals these exact final bytes and provenance. */
export async function finalizeComputerHelperMacSigning(
  input: { app: string; channel: Hands.Channel; signing: ComputerHelperSigningReceipt["signing"] },
  dependencies: SigningDependencies = {},
) {
  const paths = await helperPaths(input.app, input.channel)
  const baseline = prepared.get(paths.root)
  if (!baseline || baseline.channel !== input.channel)
    throw new Error("The verified pre-sign computer helper baseline is missing.")
  if (input.signing !== "adhoc" && input.signing !== "developer-id")
    throw new Error("The final computer helper signing kind is invalid.")
  await verifyComputerHelperMacSignature(
    { app: input.app, channel: input.channel, identity: input.signing === "adhoc" ? "-" : "certificate" },
    dependencies,
  )
  if (input.signing === "adhoc") {
    const run = command(dependencies)
    for (const architecture of paths.architectures) {
      const signature = await run(
        ["--display", "--verbose=4", "--arch", architecture === "x64" ? "x86_64" : "arm64", paths.helper],
        "The final ad-hoc helper cdhash could not be read.",
      )
      if (
        signature.match(/^CDHash=([a-fA-F0-9]{40})\r?$/m)?.[1]?.toLowerCase() !==
        baseline.cdhash[architecture as HelperArchitecture]
      )
        throw new Error("Ad-hoc signing changed the measured computer helper identity.")
    }
  }
  const file = path.join(paths.root, "Contents/Resources/computer-helper.json")
  const status = await lstat(file)
  if (!status.isFile() || status.isSymbolicLink() || !(await realpath(file)).startsWith(paths.root + path.sep))
    throw new Error("The packaged computer helper manifest is not a regular app resource.")
  if (!(await readFile(file)).equals(baseline.bytes))
    throw new Error("The computer helper manifest changed during signing.")
  const base = path.dirname(paths.helper)
  const actual = (await helperFiles(paths.helper))
    .map((item) => path.relative(base, item).split(path.sep).join("/"))
    .sort()
  if (actual.join("\0") !== Object.keys(baseline.manifest.files).sort().join("\0"))
    throw new Error("The computer helper file list changed during signing.")
  const executable = "VectorComputer.app/Contents/MacOS/VectorComputer"
  const files = Object.fromEntries(
    await Promise.all(
      actual.map(async (relative) => {
        const sha256 = digest(await readFile(path.join(base, ...relative.split("/"))))
        if (
          relative !== executable &&
          relative !== "VectorComputer.app/Contents/_CodeSignature/CodeResources" &&
          sha256 !== baseline.manifest.files[relative]?.sha256
        )
          throw new Error("Signing changed a computer helper resource outside its signature.")
        return [relative, { ...baseline.manifest.files[relative]!, sha256 }]
      }),
    ),
  )
  const final: HelperManifest = { ...baseline.manifest, files }
  const bytes = Buffer.from(JSON.stringify(final, null, 2) + "\n")
  const receipt: ComputerHelperSigningReceipt = {
    schemaVersion: 1,
    channel: input.channel,
    sourceManifest: baseline.manifest,
    sourceCdhash: baseline.cdhash,
    finalManifestSha256: digest(bytes),
    finalExecutableSha256: files[executable]!.sha256,
    signing: input.signing,
  }
  await writeFile(file, bytes)
  await writeFile(
    path.join(paths.root, "Contents/Resources/computer-helper-signing.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx" },
  )
  prepared.delete(paths.root)
  return receipt
}

/** Signing changes the executable and its cdhash. The measured ad-hoc lock is checked before this step. */
export async function signComputerHelperMac(input: HelperSigning, dependencies: SigningDependencies = {}) {
  if (!input.identity.trim()) throw new Error("A computer helper signing identity is required.")
  const paths = await helperPaths(input.app, input.channel)
  const entitlements = path.resolve(
    dependencies.directory ?? packageDirectory,
    "native/computer-helper/macos/entitlements.plist",
  )
  if (!emptyDictionary(await readFile(entitlements, "utf8")))
    throw new Error("The computer helper signing entitlements must be an empty dictionary.")
  const adhoc = input.identity === "-"
  if (!adhoc && input.timestamp === "none")
    throw new Error("Certificate-signed computer helpers require a secure timestamp.")
  await command(dependencies)(
    [
      "--force",
      "--sign",
      input.identity,
      "--options",
      "runtime",
      adhoc ? "--timestamp=none" : input.timestamp ? `--timestamp=${input.timestamp}` : "--timestamp",
      ...(!adhoc && input.keychain ? ["--keychain", input.keychain] : []),
      "--entitlements",
      entitlements,
      "--identifier",
      Hands.helperBundleId(APP_IDS[input.channel]),
      paths.helper,
    ],
    "Computer helper signing failed.",
  )
  await verifyComputerHelperMacSignature(input, dependencies)
  return paths.helper
}

/** Safe after an outer re-seal or fuse reset; checks each actual slice, never a pre-sign executable hash. */
export async function verifyComputerHelperMacSignature(input: HelperSigning, dependencies: SigningDependencies = {}) {
  const paths = await helperPaths(input.app, input.channel)
  const run = command(dependencies)
  await run(["--verify", "--strict", "--all-architectures", paths.helper], "The computer helper signature is invalid.")
  for (const architecture of paths.architectures) {
    const arch = architecture === "x64" ? "x86_64" : "arm64"
    const signature = await run(
      ["--display", "--verbose=4", "--arch", arch, paths.helper],
      "The computer helper signature could not be read.",
    )
    const flags = signature.match(/\bflags=0x([0-9a-f]{1,8})(?:\(|\s|$)/i)?.[1]
    if (
      !signature.split(/\r?\n/).includes(`Identifier=${Hands.helperBundleId(APP_IDS[input.channel])}`) ||
      !flags ||
      (Number.parseInt(flags, 16) & 0x10000) === 0 ||
      (input.identity === "-"
        ? !/^Signature=adhoc\r?$/m.test(signature)
        : /^Signature=adhoc\r?$/m.test(signature) || !/^Authority=.+/m.test(signature))
    )
      throw new Error("The computer helper must retain its own channel identifier, signing kind and hardened runtime.")
    const entitlements = await run(
      ["--display", "--arch", arch, "--entitlements", ":-", "--xml", paths.helper],
      "The computer helper entitlements could not be read.",
    )
    if (!emptyDictionary(entitlements))
      throw new Error("The signed computer helper entitlements must be an empty dictionary.")
  }
}

/** Called after the actual fuse operation. Its trusted receipt came from this process's finalizer. */
export async function verifyComputerHelperMacSigningArtifacts(
  input: HelperSigning & { receipt: ComputerHelperSigningReceipt },
  dependencies: SigningDependencies = {},
) {
  const paths = await helperPaths(input.app, input.channel)
  if (
    input.receipt.channel !== input.channel ||
    input.receipt.signing !== (input.identity === "-" ? "adhoc" : "developer-id")
  )
    throw new Error("The final computer helper signing receipt has a different authority.")
  const bytes = await readFile(path.join(paths.root, "Contents/Resources/computer-helper.json"))
  if (
    digest(bytes) !== input.receipt.finalManifestSha256 ||
    digest(await readFile(paths.executable)) !== input.receipt.finalExecutableSha256
  )
    throw new Error("The computer helper changed after its final signing receipt.")
  const stored = await readFile(path.join(paths.root, "Contents/Resources/computer-helper-signing.json"), "utf8")
  if (JSON.stringify(JSON.parse(stored)) !== JSON.stringify(input.receipt))
    throw new Error("The sealed computer helper signing receipt changed.")
  // This manifest's exact serialized bytes were produced by the private finalizer and matched above.
  const manifest: HelperManifest = JSON.parse(bytes.toString("utf8"))
  const base = path.dirname(paths.helper)
  const actual = (await helperFiles(paths.helper))
    .map((file) => path.relative(base, file).split(path.sep).join("/"))
    .sort()
  if (actual.join("\0") !== Object.keys(manifest.files).sort().join("\0"))
    throw new Error("The final computer helper file list changed.")
  for (const file of actual)
    if (digest(await readFile(path.join(base, ...file.split("/")))) !== manifest.files[file]?.sha256)
      throw new Error("A final computer helper resource changed, including its signature resources.")
  await verifyComputerHelperMacSignature(input, dependencies)
  await command(dependencies)(
    ["--verify", "--deep", "--strict", paths.root],
    "The final desktop app signature did not verify.",
  )
}

/** The unsigned production path avoids certificate/keychain discovery and restores the helper after --deep. */
export async function signUnsignedMacWithComputerHelper(
  input: { app: string; channel: Hands.Channel },
  dependencies: SigningDependencies = {},
) {
  const paths = await helperPaths(input.app, input.channel)
  const baseline = prepared.get(paths.root)
  if (!baseline || baseline.channel !== input.channel)
    throw new Error("The verified pre-sign computer helper baseline is missing.")
  const mainEntitlements = path.resolve(dependencies.directory ?? packageDirectory, "resources/entitlements.plist")
  const run = command(dependencies)
  await run(
    [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--options",
      "runtime",
      "--timestamp=none",
      "--entitlements",
      mainEntitlements,
      paths.root,
    ],
    "Unsigned desktop app signing failed.",
  )
  await signComputerHelperMac({ ...input, identity: "-" }, dependencies)
  const receipt = await finalizeComputerHelperMacSigning({ ...input, signing: "adhoc" }, dependencies)
  await run(
    [
      "--force",
      "--sign",
      "-",
      "--options",
      "runtime",
      "--timestamp=none",
      "--entitlements",
      mainEntitlements,
      paths.root,
    ],
    "The unsigned desktop app could not be re-sealed.",
  )
  await verifyComputerHelperMacSigningArtifacts({ ...input, identity: "-", receipt }, dependencies)
  return receipt
}

/**
 * Builder 26.15.2 calls this public method after afterPack and only for final fuse targets.
 * Universal temporary apps have fuses disabled; unsigned identity:null never invokes afterSign.
 */
export async function installUnsignedMacComputerHelperFuses<
  Context extends {
    appOutDir: string
    electronPlatformName: string
    packager: { appInfo: { productFilename: string } }
  },
  Fuses extends { resetAdHocDarwinSignature?: boolean },
>(
  packager: { addElectronFuses(context: Context, fuses: Fuses): Promise<number> },
  input: {
    channel: Hands.Channel
    signUnsignedMac: (app: string) => Promise<ComputerHelperSigningReceipt | undefined>
  },
  dependencies: SigningDependencies = {},
) {
  if (unsignedFusePackagers.has(packager)) return
  const require = createRequire(import.meta.url)
  const builder = createRequire(require.resolve("electron-builder/package.json"))
  const manifest: unknown = JSON.parse(await readFile(builder.resolve("app-builder-lib/package.json"), "utf8"))
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("version" in manifest) ||
    manifest.version !== "26.15.2" ||
    typeof packager.addElectronFuses !== "function" ||
    packager.addElectronFuses.length !== 2
  )
    throw new Error("The unsigned computer helper requires the pinned builder fuse hook.")
  const original = packager.addElectronFuses
  packager.addElectronFuses = async function (context, fuses) {
    if (this !== packager || context.electronPlatformName !== "darwin" || fuses.resetAdHocDarwinSignature !== true)
      throw new Error("The unsigned computer helper fuse authority changed.")
    const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
    const receipt = await input.signUnsignedMac(app)
    if (!receipt) throw new Error("Unsigned app signing did not return a computer helper receipt.")
    const result = await original.call(this, context, fuses)
    // Deep preserve-metadata signing is not assumed to preserve bytes. Every final hash is checked.
    await verifyComputerHelperMacSigningArtifacts({ app, channel: input.channel, identity: "-", receipt }, dependencies)
    return result
  }
  unsignedFusePackagers.add(packager)
}

/** osx-sign must skip both the helper bundle and everything inside it, while preserving the caller's ignores. */
export function computerHelperSigningIgnore(helper: string, previous: MacSignOptions["ignore"]) {
  const root = path.resolve(helper)
  const ignored =
    typeof previous === "function"
      ? previous
      : (file: string) =>
          (Array.isArray(previous) ? previous : previous === undefined ? [] : [previous]).some(
            (pattern) => file.match(pattern) !== null,
          )
  return (file: string) =>
    path.resolve(file) === root || path.resolve(file).startsWith(root + path.sep) || ignored(file)
}

/** The custom hook receives builder's selected identity/keychain and keeps Electron's signing options. */
export async function signMacWithComputerHelper(
  options: MacSignOptions,
  packager: { appInfo: { id: string }; projectDir: string },
  dependencies: SigningDependencies = {},
) {
  const channel = (Object.keys(APP_IDS) as Hands.Channel[]).find(
    (candidate) => APP_IDS[candidate] === packager.appInfo.id,
  )
  if (!channel) throw new Error("The app being signed has an unknown Vector channel identity.")
  if (!options.identity?.trim()) throw new Error("The desktop signing identity was not selected.")
  const directory = dependencies.directory ?? packager.projectDir
  const settings = { ...dependencies, directory }
  const skip = computerHelperSkipRequested(channel, dependencies.environment ?? process.env)
  if (!skip && !prepared.has(await realpath(options.app)))
    throw new Error("The verified pre-sign computer helper baseline is missing.")
  const helperInput = {
    app: options.app,
    channel,
    identity: options.identity,
    keychain: options.keychain,
    timestamp: options.optionsForFile?.(path.join(options.app, "Contents/Helpers/VectorComputer.app"))?.timestamp,
  }
  const helper = skip ? undefined : await signComputerHelperMac(helperInput, settings)
  const before = helper ? digest(await readFile(path.join(helper, "Contents/MacOS/VectorComputer"))) : undefined
  if (helper)
    await finalizeComputerHelperMacSigning(
      {
        app: options.app,
        channel,
        signing: options.identity === "-" ? "adhoc" : "developer-id",
      },
      settings,
    )
  const previous = options.optionsForFile
  const signing: MacSignOptions = {
    ...options,
    keychain: options.identity === "-" ? undefined : options.keychain,
    ...(helper ? { ignore: computerHelperSigningIgnore(helper, options.ignore) } : {}),
    optionsForFile: (file) => {
      const rules = previous?.(file) ?? {}
      if (rules.additionalArguments?.includes("--deep"))
        throw new Error("Outer app signing must not recursively re-sign the computer helper.")
      return { ...rules, ...(options.identity === "-" ? { timestamp: "none" } : {}) }
    },
  }
  const signAsync = dependencies.signAsync ?? (await loadSigner())
  await retrySigning(
    () => signAsync(signing),
    dependencies.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  )
  if (!helper) return
  if (digest(await readFile(path.join(helper, "Contents/MacOS/VectorComputer"))) !== before)
    throw new Error("Outer app signing changed the separately signed computer helper.")
  await verifyComputerHelperMacSignature(helperInput, settings)
  const run = command(settings)
  await run(["--verify", "--deep", "--strict", options.app], "The signed desktop app did not verify.")
  if (options.identity !== "-") {
    const outer = await run(["--display", "--verbose=4", options.app], "The desktop signature could not be read.")
    const authority = (text: string) => text.match(/^Authority=(.+)\r?$/m)?.[1]?.trim()
    const team = (text: string) => text.match(/^TeamIdentifier=(.+)\r?$/m)?.[1]?.trim()
    const paths = await helperPaths(options.app, channel)
    for (const architecture of paths.architectures) {
      const inner = await run(
        ["--display", "--verbose=4", "--arch", architecture === "x64" ? "x86_64" : "arm64", helper],
        "The computer helper signature could not be read.",
      )
      if (
        !authority(outer) ||
        authority(outer) !== authority(inner) ||
        team(outer) !== team(inner) ||
        (/^Developer ID Application:/.test(authority(outer)!) && !/^[A-Z0-9]{10}$/.test(team(outer) ?? ""))
      )
        throw new Error("The computer helper and desktop app must use the same signing certificate and team.")
    }
  }
}

async function loadSigner() {
  const require = createRequire(import.meta.url)
  const builder = createRequire(require.resolve("electron-builder/package.json"))
  const library = createRequire(builder.resolve("app-builder-lib/package.json"))
  const manifest: unknown = JSON.parse(await readFile(library.resolve("@electron/osx-sign/package.json"), "utf8"))
  if (!manifest || typeof manifest !== "object" || !("version" in manifest) || manifest.version !== "1.3.3")
    throw new Error("The computer helper requires the pinned macOS signing implementation.")
  const signer: { signAsync: (options: MacSignOptions) => Promise<void> } = await import(
    pathToFileURL(library.resolve("@electron/osx-sign")).href
  )
  return signer.signAsync
}

async function retrySigning(
  sign: () => Promise<void>,
  wait: (milliseconds: number) => Promise<void>,
  attempt = 0,
): Promise<void> {
  try {
    await sign()
  } catch (error) {
    if (attempt >= 3) throw error
    await wait(5000 + attempt * 5000)
    return retrySigning(sign, wait, attempt + 1)
  }
}
