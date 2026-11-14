import { createHash } from "node:crypto"
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { generateIdentitySources, readIdentity } from "./computer-helper-identity"
import {
  parseHelperManifest,
  runNativeCommand,
  sourceDigestFor,
  type HelperArchitecture,
  type HelperManifest,
  type NativeCommand,
} from "./build-computer-helper"
import {
  checkWindowsHelperAuthenticode,
  checkWindowsHelperFinalVersion,
  inspectWindowsHelperPe,
  observeWindowsHelperAuthenticode,
  windowsHelperPowerShellHost,
} from "./verify-computer-helper-windows"

const packageDirectory = fileURLToPath(new URL("../", import.meta.url))
const architectures = ["x64", "arm64"] as const
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** Preserve every tested PE byte except CheckSum, the certificate directory and appended signature/padding. */
export function windowsHelperSigningDigest(input: Uint8Array) {
  const bytes = Buffer.from(input)
  if (bytes.length < 64 || bytes.length > 64 * 1024 * 1024 || bytes.readUInt16LE(0) !== 0x5a4d)
    throw new Error("The Windows helper signing image is invalid.")
  const offset = bytes.readUInt32LE(0x3c)
  if (
    offset < 64 ||
    offset > 1_048_576 ||
    offset + 24 + 240 > bytes.length ||
    bytes.readUInt32LE(offset) !== 0x4550 ||
    bytes.readUInt16LE(offset + 24) !== 0x20b ||
    bytes.readUInt16LE(offset + 20) < 240 ||
    bytes.readUInt32LE(offset + 24 + 108) < 5
  )
    throw new Error("The Windows helper signing PE headers are invalid.")
  const checksum = offset + 24 + 64
  const security = offset + 24 + 112 + 4 * 8
  const certificate = bytes.readUInt32LE(security)
  const size = bytes.readUInt32LE(security + 4)
  if (
    (certificate === 0) !== (size === 0) ||
    (certificate !== 0 &&
      (certificate % 8 !== 0 || certificate < offset + 24 + 240 || size < 8 || certificate + size !== bytes.length))
  )
    throw new Error("The Windows helper certificate table is invalid.")
  const end = certificate || bytes.length
  return createHash("sha256")
    .update(bytes.subarray(0, checksum))
    .update(bytes.subarray(checksum + 4, security))
    .update(bytes.subarray(security + 8, end))
    .update(Buffer.alloc((8 - (end % 8)) % 8))
    .digest("hex")
}

type Dependencies = {
  directory?: string
  environment?: NodeJS.ProcessEnv
  run?: NativeCommand
  inspect?: typeof inspectWindowsHelperPe
  expectedSourceDigest?: (manifest: HelperManifest, channel: "prod" | "beta" | "dev") => Promise<string>
}

/** The original native artifact remains read-only; only a separate output copy is signed or restored. */
export async function prepareWindowsComputerHelpers(
  input: {
    source: string
    output: string
    channel: "prod" | "beta" | "dev"
    expectSigning: "unsigned" | "authenticode"
    publisher?: string
    restored?: boolean
  },
  dependencies: Dependencies = {},
) {
  if (process.platform !== "win32" && !dependencies.run)
    throw new Error("Prepare Windows helper signatures on Windows.")
  if (!["prod", "beta", "dev"].includes(input.channel) || !["unsigned", "authenticode"].includes(input.expectSigning))
    throw new Error("The Windows helper signing request is invalid.")
  const directory = path.resolve(dependencies.directory ?? packageDirectory)
  const environment = dependencies.environment ?? process.env
  if (input.expectSigning === "unsigned" && environment.VECTOR_ALLOW_UNSIGNED_RELEASE !== "true")
    throw new Error("Unsigned Windows helpers require the explicit unsigned release policy.")
  if (
    input.expectSigning === "authenticode" &&
    (!input.publisher?.trim() || environment.VECTOR_ALLOW_UNSIGNED_RELEASE === "true")
  )
    throw new Error("Windows helper signing requires a publisher and cannot override unsigned policy.")
  const source = await realpath(input.source)
  await mkdir(input.output, { recursive: true })
  const output = await realpath(input.output)
  if (source === output || source.startsWith(output + path.sep) || output.startsWith(source + path.sep))
    throw new Error("The Windows helper output must be separate from the tested native artifact.")
  if (
    (await readdir(source)).toSorted().join("\0") !== "arm64\0x64" ||
    (!input.restored && (await readdir(output)).length)
  )
    throw new Error("The Windows helper input/output directories contain unexpected or stale files.")
  const identity = readIdentity(path.join(directory, "native/computer-helper/identity.json"))
  const run = dependencies.run ?? runNativeCommand
  const observations = Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        !/^(?:AZURE_|CSC_|WIN_CSC_|APPLE_|BLOB_|SENTRY_)|(?:^|_)(?:TOKEN|SECRET|PASSWORD|KEY)(?:_|$)/i.test(name),
    ),
  )
  const command = async (
    executable: string,
    args: readonly string[],
    message: string,
    extra: NodeJS.ProcessEnv = {},
    timeoutMs = 10_000,
    signing = false,
  ) => {
    const result = await run(executable, args, {
      cwd: directory,
      env: { ...(signing ? environment : observations), ...extra },
      timeoutMs,
    })
    if (result.code !== 0 || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 1024 * 1024)
      throw new Error(message)
    return result.stdout.replace(/^\uFEFF/, "")
  }
  const signature = (file: string) =>
    observeWindowsHelperAuthenticode(file, { directory, environment: observations, timeoutMs: 10000, run })
  const regular = async (root: string, relative: string, limit: number) => {
    const file = path.join(root, relative)
    const status = await lstat(file)
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.size > limit ||
      !(await realpath(file)).startsWith(root + path.sep)
    )
      throw new Error("The Windows helper signing input is not a bounded regular file.")
    return { file, bytes: await readFile(file) }
  }
  const original: {
    architecture: HelperArchitecture
    manifest: HelperManifest
    manifestBytes: Buffer
    bytes: Buffer
    image: string
    target: string
  }[] = []
  for (const architecture of architectures) {
    const root = path.join(source, architecture)
    const folder = await lstat(root)
    if (
      !folder.isDirectory() ||
      folder.isSymbolicLink() ||
      (await readdir(root)).toSorted().join("\0") !== "computer-helper.json\0vector-computer.exe"
    )
      throw new Error("A Windows native helper directory has unexpected files.")
    const file = await regular(root, "vector-computer.exe", 64 * 1024 * 1024)
    const metadata = await regular(root, "computer-helper.json", 65_536)
    const manifest = parseHelperManifest(JSON.parse(metadata.bytes.toString("utf8")))
    if (
      manifest.platform !== "win32" ||
      manifest.helperVersion !== identity.helperVersion ||
      manifest.protocol.min !== identity.protocol.min ||
      manifest.protocol.max !== identity.protocol.max ||
      Object.keys(manifest.files).join("\0") !== "vector-computer.exe" ||
      manifest.files["vector-computer.exe"]?.arch.join("\0") !== architecture ||
      manifest.files["vector-computer.exe"]?.sha256 !== hash(file.bytes)
    )
      throw new Error("The native Windows helper manifest does not match its tested bytes or source identity.")
    const expected = dependencies.expectedSourceDigest
      ? await dependencies.expectedSourceDigest(manifest, input.channel)
      : await sourceDigestFor(
          directory,
          "win32",
          input.channel,
          manifest.toolchain,
          generateIdentitySources(path.join(directory, "native/build/computer-helper-signing-win32/generated"), {
            identity: path.join(directory, "native/computer-helper/identity.json"),
            blocklist: path.join(directory, "native/computer-helper/blocklist.json"),
          }).find((file) => file.endsWith("Identity.swift"))!,
        )
    if (manifest.sourceDigest !== expected)
      throw new Error("The native Windows helper source digest differs from this release.")
    await (dependencies.inspect ?? inspectWindowsHelperPe)(file.bytes, architecture)
    checkWindowsHelperAuthenticode(await signature(file.file), "unsigned")
    const target = path.join(output, architecture)
    if (!input.restored) {
      await mkdir(target, { recursive: true })
      await copyFile(file.file, path.join(target, "vector-computer.exe"))
      await copyFile(metadata.file, path.join(target, "computer-helper.json"))
    }
    original.push({
      architecture,
      manifest,
      manifestBytes: metadata.bytes,
      bytes: file.bytes,
      image: windowsHelperSigningDigest(file.bytes),
      target,
    })
  }
  if (
    original[0]!.manifest.sourceDigest !== original[1]!.manifest.sourceDigest ||
    original[0]!.manifest.toolchain !== original[1]!.manifest.toolchain
  )
    throw new Error("The two Windows native helpers do not share one tested source/toolchain.")
  if ((await readdir(output)).toSorted().join("\0") !== "arm64\0x64")
    throw new Error("The final Windows helper root contains unexpected directories.")
  if (!input.restored && input.expectSigning === "authenticode") {
    const required = [
      "AZURE_TRUSTED_SIGNING_ENDPOINT",
      "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
      "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE",
      "AZURE_CLIENT_ID",
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_SECRET",
    ]
    if (environment.GITHUB_ACTIONS !== "true" || required.some((name) => !environment[name]?.trim()))
      throw new Error("The required Windows helper signing credentials are not configured.")
    await command(
      windowsHelperPowerShellHost(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve(directory, "../../script/sign-windows.ps1"),
        ...original.map((file) => path.join(file.target, "vector-computer.exe")),
      ],
      "Windows helper signing failed.",
      { VECTOR_CHANNEL: input.channel, VECTOR_REQUIRE_WINDOWS_SIGNING: "true", VECTOR_ALLOW_UNSIGNED_RELEASE: "false" },
      300_000,
      true,
    )
  }
  const pins: Partial<Record<HelperArchitecture, string>> = {}
  for (const item of original) {
    if ((await readdir(item.target)).toSorted().join("\0") !== "computer-helper.json\0vector-computer.exe")
      throw new Error("The final Windows helper contains unexpected files.")
    const file = await regular(item.target, "vector-computer.exe", 64 * 1024 * 1024)
    const metadata = await regular(item.target, "computer-helper.json", 65_536)
    const final = parseHelperManifest(JSON.parse(metadata.bytes.toString("utf8")))
    if (
      windowsHelperSigningDigest(file.bytes) !== item.image ||
      Object.keys(final.files).join("\0") !== "vector-computer.exe" ||
      final.files["vector-computer.exe"]?.arch.join("\0") !== item.architecture ||
      (!input.restored && !metadata.bytes.equals(item.manifestBytes)) ||
      JSON.stringify({ ...final, files: item.manifest.files }) !== JSON.stringify(item.manifest)
    )
      throw new Error("Windows helper signing changed tested code or immutable manifest metadata.")
    await (dependencies.inspect ?? inspectWindowsHelperPe)(file.bytes, item.architecture)
    checkWindowsHelperAuthenticode(await signature(file.file), input.expectSigning, input.publisher)
    const sha256 = hash(file.bytes)
    if (input.restored && final.files["vector-computer.exe"]?.sha256 !== sha256)
      throw new Error("The restored final Windows helper does not match its immutable manifest.")
    if (input.expectSigning === "unsigned" && sha256 !== hash(item.bytes))
      throw new Error("An unsigned Windows helper changed from the tested native artifact.")
    const manifest = { ...item.manifest, files: { "vector-computer.exe": { sha256, arch: [item.architecture] } } }
    if (!input.restored && sha256 !== item.manifest.files["vector-computer.exe"]!.sha256)
      await writeFile(metadata.file, JSON.stringify(manifest, null, 2) + "\n")
    if (process.arch === item.architecture) {
      const version = await command(
        file.file,
        ["--version", "--json"],
        "The final Windows helper version could not be read.",
      )
      checkWindowsHelperFinalVersion(JSON.parse(version), manifest, item.architecture)
    }
    // The signer receives output paths only; the tested input artifact must remain byte-for-byte unchanged.
    if (
      !(await readFile(path.join(source, item.architecture, "vector-computer.exe"))).equals(item.bytes) ||
      !(await readFile(path.join(source, item.architecture, "computer-helper.json"))).equals(item.manifestBytes)
    )
      throw new Error("The tested native Windows helper artifact changed during signing.")
    pins[item.architecture] = sha256
  }
  return pins
}

if (import.meta.main) {
  const parsed = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      source: { type: "string" },
      output: { type: "string" },
      channel: { type: "string" },
      "expect-signing": { type: "string" },
      publisher: { type: "string" },
      restored: { type: "boolean", default: false },
    },
  })
  if (
    !parsed.values.source ||
    !parsed.values.output ||
    !["prod", "beta", "dev"].includes(parsed.values.channel ?? "") ||
    !["unsigned", "authenticode"].includes(parsed.values["expect-signing"] ?? "")
  )
    throw new Error(
      "Usage: --source <tested-helper-root> --output <final-helper-root> --channel prod|beta|dev --expect-signing unsigned|authenticode [--publisher <name>] [--restored]",
    )
  console.log(
    JSON.stringify(
      await prepareWindowsComputerHelpers({
        source: path.resolve(parsed.values.source),
        output: path.resolve(parsed.values.output),
        channel: parsed.values.channel as "prod" | "beta" | "dev",
        expectSigning: parsed.values["expect-signing"] as "unsigned" | "authenticode",
        publisher: parsed.values.publisher,
        restored: parsed.values.restored,
      }),
    ),
  )
}
