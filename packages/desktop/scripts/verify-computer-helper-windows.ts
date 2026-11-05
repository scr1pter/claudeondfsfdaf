import { createHash } from "node:crypto"
import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseComputerHelperHashes } from "./computer-helper-package-build"
import { generateIdentitySources, readIdentity } from "./computer-helper-identity"
import {
  parseHelperManifest,
  runNativeCommand,
  sourceDigestFor,
  type HelperArchitecture,
  type HelperManifest,
  type NativeCommand,
} from "./build-computer-helper"
import { windowsNativeSelfTestChecks } from "./computer-helper-selftest-windows"
import {
  encodeComputerHelperPins,
  extractComputerHelperPins,
  type ComputerHelperPins,
} from "../src/shared/computer-helper-pins"

type ResourceEntry = { type: string | number; id: string | number; lang: string | number; bin: ArrayBuffer }
type PeReader = {
  NtExecutable: { from(bytes: Uint8Array, options: { ignoreCert: boolean }): unknown }
  NtExecutableResource: { from(image: unknown): { entries: ResourceEntry[] } }
}
type XmlReader = {
  DOMParser: new (options: { errorHandler: { warning(): never; error(): never; fatalError(): never } }) => {
    parseFromString(xml: string, mime: string): Document
  }
}
type AsarReader = {
  listPackage(file: string): string[]
  statFile(file: string, entry: string, followLinks?: boolean): { size?: number; unpacked?: boolean; link?: string }
  extractFile(file: string, entry: string): Buffer
}
const packageDirectory = fileURLToPath(new URL("../", import.meta.url))
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const readers: { value?: Promise<{ pe: PeReader; xml: XmlReader; asar: AsarReader }> } = {}

// Both readers already belong to the pinned packaging toolchain. They parse bytes only and never load a PE.
async function loadReaders() {
  readers.value ??= (async () => {
    const require = createRequire(import.meta.url)
    const builder = createRequire(require.resolve("electron-builder/package.json"))
    const library = createRequire(builder.resolve("app-builder-lib/package.json"))
    const plist = createRequire(library.resolve("plist/package.json"))
    for (const [resolve, name, version] of [
      [library, "resedit", "1.7.2"],
      [plist, "@xmldom/xmldom", "0.8.13"],
      [library, "@electron/asar", "3.4.1"],
    ] as const) {
      const manifest: unknown = JSON.parse(
        await readFile(path.resolve(path.dirname(resolve.resolve(name)), "../package.json"), "utf8"),
      )
      if (!record(manifest) || manifest.name !== name || manifest.version !== version)
        throw new Error("The Windows helper verifier requires its pinned byte/XML readers.")
    }
    const pe: PeReader = await import(pathToFileURL(library.resolve("resedit")).href)
    const xml: XmlReader = await import(pathToFileURL(plist.resolve("@xmldom/xmldom")).href)
    const asar: AsarReader = await import(pathToFileURL(library.resolve("@electron/asar")).href)
    return { pe, xml, asar }
  })()
  return readers.value
}

/** Read code from the actual packed Main, not a separate unsigned metadata file or the build environment. */
export async function extractWindowsHelperCompiledPins(app: string): Promise<ComputerHelperPins> {
  const root = await realpath(app)
  const archive = path.join(root, "resources/app.asar")
  const status = await lstat(archive)
  if (!status.isFile() || status.isSymbolicLink() || !(await realpath(archive)).startsWith(root + path.sep))
    throw new Error("The packaged Windows Main archive is missing or invalid.")
  const { asar } = await loadReaders()
  const read = (entry: string, limit: number) => {
    const metadata = asar.statFile(archive, entry, false)
    if (
      metadata.link ||
      metadata.unpacked ||
      !Number.isSafeInteger(metadata.size) ||
      !metadata.size ||
      metadata.size > limit
    )
      throw new Error("The packaged Main pin source must be bounded, packed regular code.")
    return asar.extractFile(archive, entry).toString("utf8")
  }
  const manifest: unknown = JSON.parse(read("package.json", 65_536))
  if (!record(manifest) || (manifest.main !== "./out/main/index.js" && manifest.main !== "out/main/index.js"))
    throw new Error("The packaged Windows app selects an unexpected Main entry point.")
  const listed = asar.listPackage(archive)
  if (listed.length > 65_536) throw new Error("The packaged Main archive has too many entries.")
  const sources = listed
    .filter((entry) => /^\/?out\/main\/.+\.(?:c|m)?js$/.test(entry))
    .map((entry) => entry.replace(/^\//, ""))
  if (
    !sources.includes("out/main/index.js") ||
    sources.length > 256 ||
    sources.some((entry) => entry.split("/").some((part) => part === "." || part === ".."))
  )
    throw new Error("The packaged Main JavaScript files are missing or ambiguous.")
  const documents = sources.map((entry) => read(entry, 64 * 1024 * 1024))
  if (documents.reduce((size, text) => size + Buffer.byteLength(text), 0) > 64 * 1024 * 1024)
    throw new Error("The packaged Main JavaScript exceeds its verification limit.")
  return extractComputerHelperPins(documents)
}

/** Validate the actual embedded execution policy, including namespace and ancestry, before the first launch. */
export async function checkWindowsHelperExecutionManifest(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > 128 * 1024)
    throw new Error("The Windows helper execution manifest is missing or oversized.")
  const data = Buffer.from(bytes)
  const text =
    data.length >= 2 && data.readUInt16LE(0) === 0xfeff
      ? new TextDecoder("utf-16le", { fatal: true }).decode(data)
      : new TextDecoder("utf-8", { fatal: true }).decode(data)
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text))
    throw new Error("The Windows helper execution manifest cannot contain external declarations.")
  const { xml } = await loadReaders()
  const invalid = () => {
    throw new Error("The Windows helper execution manifest is invalid XML.")
  }
  const document = new xml.DOMParser({
    errorHandler: { warning: invalid, error: invalid, fatalError: invalid },
  }).parseFromString(text, "application/xml")
  const root = document.documentElement
  if (!root || root.localName !== "assembly" || root.namespaceURI !== "urn:schemas-microsoft-com:asm.v1") invalid()
  const elements = Array.from(document.getElementsByTagName("*"))
  if (elements.length > 256 || elements.some((element) => element.attributes.length > 32)) invalid()
  for (const element of elements) {
    const ancestry: Node[] = []
    for (const state = { node: element.parentNode }; state.node; state.node = state.node.parentNode) {
      if (ancestry.length >= 32) invalid()
      ancestry.push(state.node)
    }
  }
  const execution = elements.filter((element) => element.localName === "requestedExecutionLevel")
  if (execution.length !== 1) invalid()
  const level = execution[0]!
  if (
    level.namespaceURI !== "urn:schemas-microsoft-com:asm.v3" ||
    level.getAttributeNS(null, "level") !== "asInvoker" ||
    level.getAttributeNS(null, "uiAccess") !== "false"
  )
    throw new Error("The Windows helper must run asInvoker with uiAccess=false.")
  const ancestors = ["requestedPrivileges", "security", "trustInfo"]
  const state = { node: level.parentNode }
  for (const name of ancestors) {
    if (
      !state.node ||
      state.node.nodeType !== 1 ||
      (state.node as Element).localName !== name ||
      (state.node as Element).namespaceURI !== "urn:schemas-microsoft-com:asm.v3"
    )
      invalid()
    state.node = state.node!.parentNode
  }
  if (state.node !== root) invalid()
}

export async function inspectWindowsHelperPe(bytes: Uint8Array, architecture: HelperArchitecture) {
  const data = Buffer.from(bytes)
  if (data.length < 64 || data.length > 64 * 1024 * 1024 || data.readUInt16LE(0) !== 0x5a4d)
    throw new Error("The packaged Windows helper is not a bounded PE executable.")
  const offset = data.readUInt32LE(0x3c)
  if (offset < 64 || offset > 1_048_576 || offset + 24 + 240 > data.length || data.readUInt32LE(offset) !== 0x4550)
    throw new Error("The packaged Windows helper PE headers are invalid.")
  const machine = architecture === "x64" ? 0x8664 : architecture === "arm64" ? 0xaa64 : 0
  const characteristics = data.readUInt16LE(offset + 22)
  if (
    !machine ||
    data.readUInt16LE(offset + 4) !== machine ||
    data.readUInt16LE(offset + 20) < 240 ||
    (characteristics & 0x2) === 0 ||
    (characteristics & 0x2000) !== 0 ||
    data.readUInt16LE(offset + 24) !== 0x20b ||
    data.readUInt16LE(offset + 24 + 68) !== 2
  )
    throw new Error("The Windows helper PE machine, executable kind or subsystem does not match its package.")
  const { pe } = await loadReaders()
  const resources = pe.NtExecutableResource.from(pe.NtExecutable.from(data, { ignoreCert: true })).entries
  if (!resources.length || resources.length > 512)
    throw new Error("The Windows helper PE resources are missing or excessive.")
  const manifests = resources.filter((entry) => entry.type === 24)
  if (
    !manifests.length ||
    manifests.length > 16 ||
    manifests.some(
      (entry) =>
        entry.id !== 1 ||
        typeof entry.lang !== "number" ||
        !Number.isSafeInteger(entry.lang) ||
        entry.lang < 0 ||
        entry.lang > 0xffff,
    ) ||
    new Set(manifests.map((entry) => entry.lang)).size !== manifests.length
  )
    throw new Error("The Windows helper execution manifest resource is missing or ambiguous.")
  for (const manifest of manifests) await checkWindowsHelperExecutionManifest(new Uint8Array(manifest.bin))
  return { architecture, manifestLanguages: manifests.map((entry) => entry.lang) }
}

export type WindowsHelperAuthenticode = {
  status: "Valid" | "NotSigned"
  publisher: string | null
  thumbprint: string | null
}

export function parseWindowsHelperAuthenticode(value: unknown): WindowsHelperAuthenticode {
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !== "publisher,status,thumbprint" ||
    (value.status !== "Valid" && value.status !== "NotSigned") ||
    (value.publisher !== null &&
      (typeof value.publisher !== "string" ||
        !value.publisher.trim() ||
        value.publisher.length > 512 ||
        /[\p{C}]/u.test(value.publisher))) ||
    (value.thumbprint !== null && (typeof value.thumbprint !== "string" || !/^[a-f0-9]{40}$/i.test(value.thumbprint)))
  )
    throw new Error("The Windows helper Authenticode observation is invalid.")
  if (
    value.status === "Valid"
      ? value.publisher === null || value.thumbprint === null
      : value.publisher !== null || value.thumbprint !== null
  )
    throw new Error("The Windows helper Authenticode observation is inconsistent.")
  return {
    status: value.status,
    publisher: value.publisher,
    thumbprint: typeof value.thumbprint === "string" ? value.thumbprint.toLowerCase() : null,
  }
}

export function checkWindowsHelperAuthenticode(
  observed: WindowsHelperAuthenticode,
  expectSigning: "unsigned" | "authenticode",
  publisher?: string,
) {
  if (expectSigning === "unsigned") {
    if (observed.status !== "NotSigned" || observed.publisher !== null || observed.thumbprint !== null)
      throw new Error("This release requires an explicitly unsigned computer helper.")
    return
  }
  if (
    expectSigning !== "authenticode" ||
    !publisher?.trim() ||
    publisher.length > 512 ||
    /[\p{C}]/u.test(publisher) ||
    observed.status !== "Valid" ||
    observed.publisher !== publisher ||
    !observed.thumbprint
  )
    throw new Error("The Windows computer helper must have a valid signature from the configured publisher.")
}

export function checkWindowsHelperFinalBytes(input: {
  bytes: Uint8Array
  manifest: HelperManifest
  architecture: HelperArchitecture
  compiledHashes: Partial<Record<HelperArchitecture, string>>
}) {
  const manifest = input.manifest
  const compiled = parseComputerHelperHashes(JSON.stringify(input.compiledHashes))
  const entry = manifest.files["vector-computer.exe"]
  if (
    manifest.platform !== "win32" ||
    Object.keys(manifest.files).join("\0") !== "vector-computer.exe" ||
    !entry ||
    entry.arch.length !== 1 ||
    entry.arch[0] !== input.architecture ||
    entry.sha256 !== hash(input.bytes) ||
    compiled[input.architecture] !== entry.sha256
  )
    throw new Error(
      "The final Windows helper bytes, manifest and compiled Main hash pin must agree for its architecture.",
    )
}

export function checkWindowsHelperFinalVersion(
  value: unknown,
  manifest: HelperManifest,
  architecture: HelperArchitecture,
) {
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !== "arch,helperVersion,platform,protocol,sourceDigest" ||
    value.arch !== architecture ||
    value.helperVersion !== manifest.helperVersion ||
    value.platform !== "win32" ||
    value.sourceDigest !== manifest.sourceDigest ||
    !record(value.protocol) ||
    Object.keys(value.protocol).sort().join(",") !== "max,min" ||
    value.protocol.min !== manifest.protocol.min ||
    value.protocol.max !== manifest.protocol.max
  )
    throw new Error("The final Windows helper version does not match its manifest and package architecture.")
}

// Fixed code only. The literal path is supplied through a private child environment value, never interpolated
// into PowerShell source or appended to a -Command string where it could become syntax.
const signatureScript = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$signature = Get-AuthenticodeSignature -LiteralPath $env:VECTOR_VERIFY_COMPUTER_HELPER_PATH
$publisher = $null
$thumbprint = $null
if ($null -ne $signature.SignerCertificate) {
  $publisher = $signature.SignerCertificate.Subject
  $thumbprint = $signature.SignerCertificate.Thumbprint
}
@{status=$signature.Status.ToString(); publisher=$publisher; thumbprint=$thumbprint} | ConvertTo-Json -Compress
`

/** Extracts the pins actually decoded by packaged Main. An optional supplied map is only an extra assertion. */
export async function verifyComputerHelperWindows(
  input: {
    app: string
    architecture: HelperArchitecture
    channel: "prod" | "beta" | "dev"
    expectSigning: "unsigned" | "authenticode"
    publisher?: string
    compiledHashes?: Partial<Record<HelperArchitecture, string>>
  },
  dependencies: {
    directory?: string
    run?: NativeCommand
    expectedSourceDigest?: (manifest: HelperManifest, channel: "prod" | "beta" | "dev") => Promise<string>
  } = {},
) {
  if (process.platform !== "win32" && !dependencies.run)
    throw new Error("Verify the packaged Windows helper on Windows.")
  if (
    (input.architecture !== "x64" && input.architecture !== "arm64") ||
    !["prod", "beta", "dev"].includes(input.channel)
  )
    throw new Error("The Windows helper package architecture or channel is invalid.")
  const root = await realpath(input.app)
  const directory = path.resolve(dependencies.directory ?? packageDirectory)
  const helperRoot = path.join(root, "resources/computer")
  const helper = path.join(helperRoot, "vector-computer.exe")
  const manifestFile = path.join(helperRoot, "computer-helper.json")
  const status = await lstat(helperRoot)
  if (!status.isDirectory() || status.isSymbolicLink() || !(await realpath(helperRoot)).startsWith(root + path.sep))
    throw new Error("The packaged Windows helper directory is missing or invalid.")
  const names = await readdir(helperRoot)
  if (names.toSorted().join("\0") !== "computer-helper.json\0vector-computer.exe")
    throw new Error("The Windows shipping helper directory contains missing or unexpected files.")
  for (const file of [helper, manifestFile]) {
    const observed = await lstat(file)
    if (
      !observed.isFile() ||
      observed.isSymbolicLink() ||
      observed.size > (file === helper ? 64 * 1024 * 1024 : 65_536) ||
      !(await realpath(file)).startsWith(helperRoot + path.sep)
    )
      throw new Error("The packaged Windows helper has an invalid file or size.")
  }
  const manifest = parseHelperManifest(JSON.parse(await readFile(manifestFile, "utf8")))
  const bytes = await readFile(helper)
  const compiledHashes = await extractWindowsHelperCompiledPins(root)
  if (
    input.compiledHashes !== undefined &&
    encodeComputerHelperPins(parseComputerHelperHashes(JSON.stringify(input.compiledHashes))) !==
      encodeComputerHelperPins(compiledHashes)
  )
    throw new Error("The supplied hash assertion differs from the actual compiled Main pins.")
  checkWindowsHelperFinalBytes({ bytes, manifest, architecture: input.architecture, compiledHashes })
  await inspectWindowsHelperPe(bytes, input.architecture)
  const identity = readIdentity(path.join(directory, "native/computer-helper/identity.json"))
  if (
    identity.helperVersion !== manifest.helperVersion ||
    identity.protocol.min !== manifest.protocol.min ||
    identity.protocol.max !== manifest.protocol.max
  )
    throw new Error("The Windows helper manifest differs from the current source identity.")
  const expectedSourceDigest = dependencies.expectedSourceDigest
    ? await dependencies.expectedSourceDigest(manifest, input.channel)
    : await sourceDigestFor(
        directory,
        "win32",
        input.channel,
        manifest.toolchain,
        generateIdentitySources(path.join(directory, "native/build/computer-helper-release-win32/generated"), {
          identity: path.join(directory, "native/computer-helper/identity.json"),
          blocklist: path.join(directory, "native/computer-helper/blocklist.json"),
        }).find((file) => file.endsWith("Identity.swift"))!,
      )
  if (manifest.sourceDigest !== expectedSourceDigest)
    throw new Error("The Windows helper source digest differs from the verified channel source.")
  const run = dependencies.run ?? runNativeCommand
  const command = async (
    executable: string,
    args: readonly string[],
    message: string,
    extraEnvironment: NodeJS.ProcessEnv = {},
    timeoutMs = 5000,
  ) => {
    const result = await run(executable, args, {
      cwd: directory,
      env: { ...process.env, ...extraEnvironment },
      timeoutMs,
    })
    if (result.code !== 0 || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 65_536)
      throw new Error(message)
    return result
  }
  const powershell = path.win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  )
  const observed = await command(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(signatureScript, "utf16le").toString("base64"),
    ],
    "The Windows helper Authenticode status could not be observed.",
    { VECTOR_VERIFY_COMPUTER_HELPER_PATH: helper },
  )
  const signature = parseWindowsHelperAuthenticode(JSON.parse(observed.stdout.replace(/^\uFEFF/, "")))
  checkWindowsHelperAuthenticode(signature, input.expectSigning, input.publisher)
  const version = await command(
    helper,
    ["--version", "--json"],
    "The final-location Windows helper version check failed.",
  )
  checkWindowsHelperFinalVersion(JSON.parse(version.stdout), manifest, input.architecture)
  const packaged = await command(
    helper,
    ["--self-test=packaged"],
    "The final-location Windows helper packaged self-test failed.",
    {},
    10_000,
  )
  if (
    windowsNativeSelfTestChecks(packaged.stdout, "packaged", packaged.code).some((check) => !check.ok || check.skipped)
  )
    throw new Error("The final-location Windows helper packaged self-test did not pass every check.")
  return { manifest, signature }
}
