import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { APP_IDS } from "./channel-ids"
import { Hands } from "@vectordevai/schema/hands"
import type { PackageCheck } from "./verify-package"
import { binaryArchitectures } from "./verify-native"
import {
  checkIdentityLock,
  parseHelperManifest,
  runNativeCommand,
  sourceDigestFor,
  type HelperManifest,
  type IdentityLock,
  type NativeCommand,
} from "./build-computer-helper"
import { generateIdentitySources, readIdentity } from "./computer-helper-identity"
import type { ComputerHelperSigningReceipt } from "./computer-helper-sign"

export type MacCodeSignature = {
  identifier: string
  cdhash: string
  runtime: boolean
  signing: "adhoc" | "developer-id" | "certificate"
  authorities: string[]
  teamID?: string
  timestamp?: string
}

/** Read one explicitly selected architecture, never a native-slice summary of a universal binary. */
export function parseMacCodeSignature(text: string): MacCodeSignature {
  if (Buffer.byteLength(text) > 65_536) throw new Error("The code signature report exceeds its limit.")
  const one = (name: string, required = true) => {
    const values = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith(`${name}=`))
      .map((line) => line.slice(name.length + 1))
    if (values.length > 1 || (required && (values.length !== 1 || !values[0]?.trim())))
      throw new Error("The code signature report is incomplete or ambiguous.")
    return values[0]
  }
  const identifier = one("Identifier")!
  const cdhash = one("CDHash")!
  const flags = Array.from(text.matchAll(/\bflags=0x([a-f0-9]+)\([^)]*\)/gi))
  if (
    flags.length !== 1 ||
    flags[0]![1]!.length > 8 ||
    !/^[a-f0-9]{40}$/i.test(cdhash) ||
    !/^[a-zA-Z0-9.-]+$/.test(identifier)
  )
    throw new Error("The code signature report has invalid identity or flags.")
  const authorities = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Authority="))
    .map((line) => line.slice(10))
  const signature = one("Signature", false)
  if ((signature !== undefined && signature !== "adhoc") || (signature === "adhoc" && authorities.length))
    throw new Error("The code signature report has conflicting signing identities.")
  const teamID = one("TeamIdentifier", false)
  const timestamp = one("Timestamp", false)
  return {
    identifier,
    cdhash: cdhash.toLowerCase(),
    runtime: (Number.parseInt(flags[0]![1]!, 16) & 0x10000) !== 0,
    signing:
      signature === "adhoc"
        ? "adhoc"
        : authorities[0]?.startsWith("Developer ID Application:")
          ? "developer-id"
          : "certificate",
    authorities,
    ...(teamID && teamID !== "not set" ? { teamID } : {}),
    ...(timestamp ? { timestamp } : {}),
  }
}

export type ComputerHelperCheckInput = {
  bundleID?: string
  helperBundleID?: string
  helperVersion?: string
  expectedHelperVersion?: string
  manifest?: HelperManifest
  architectures?: readonly string[]
  entitlements?: readonly unknown[]
  signatureText?: readonly string[]
  expectSigning: "adhoc" | "developer-id"
  appTeamID?: string
  asarStrings?: readonly string[]
}

/** Final package facts, observed after signing and fuse changes. Source-lock provenance is checked separately. */
export function checkComputerHelper(input: ComputerHelperCheckInput): PackageCheck {
  const channel = (Object.keys(APP_IDS) as (keyof typeof APP_IDS)[]).find((value) => APP_IDS[value] === input.bundleID)
  if (!input.bundleID || !channel) return { ok: false, problem: "The desktop app has an unknown channel identity." }
  if (
    !input.helperBundleID ||
    input.helperBundleID !== Hands.helperBundleId(input.bundleID) ||
    input.helperBundleID.startsWith(`${input.bundleID}.helper`)
  )
    return { ok: false, problem: "The packaged computer helper has the wrong channel bundle identifier." }
  const manifest = input.manifest
  if (!manifest || manifest.platform !== "darwin" || !manifest.files || !/^[a-f0-9]{64}$/.test(manifest.sourceDigest))
    return { ok: false, problem: "The packaged computer helper manifest is missing or invalid." }
  if (
    !input.helperVersion ||
    !/^\d+\.\d+\.\d+$/.test(input.helperVersion) ||
    input.helperVersion !== manifest.helperVersion ||
    (input.expectedHelperVersion !== undefined && input.helperVersion !== input.expectedHelperVersion)
  )
    return {
      ok: false,
      problem: "The packaged computer helper version does not match its manifest or source identity.",
    }
  const architectures = input.architectures
  const executable = manifest.files["VectorComputer.app/Contents/MacOS/VectorComputer"]
  if (
    !architectures ||
    architectures.length !== 2 ||
    new Set(architectures).size !== 2 ||
    !["x64", "arm64"].every((arch) => architectures.includes(arch)) ||
    !executable ||
    executable.arch.length !== 2 ||
    !architectures.every((arch) => executable.arch.includes(arch as "x64" | "arm64"))
  )
    return { ok: false, problem: "The packaged computer helper must contain both supported architecture slices." }
  if (
    !input.entitlements ||
    input.entitlements.length !== architectures.length ||
    input.entitlements.some(
      (value) => !value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 0,
    )
  )
    return { ok: false, problem: "Every computer helper slice must have its own empty entitlements dictionary." }
  if (!input.signatureText || input.signatureText.length !== architectures.length)
    return { ok: false, problem: "Every computer helper architecture needs an observed code signature." }
  try {
    const signatures = input.signatureText.map(parseMacCodeSignature)
    if (
      signatures.some(
        (signature) =>
          signature.identifier !== input.helperBundleID ||
          !signature.runtime ||
          signature.signing !== input.expectSigning,
      )
    )
      return {
        ok: false,
        problem: "The computer helper has the wrong signing identity, kind or hardened runtime flags.",
      }
    if (
      input.expectSigning === "developer-id" &&
      (!/^[A-Z0-9]{10}$/.test(input.appTeamID ?? "") ||
        signatures.some((signature) => signature.teamID !== input.appTeamID || !signature.timestamp))
    )
      return {
        ok: false,
        problem: "The Developer ID computer helper must match the desktop team and have a secure timestamp.",
      }
  } catch {
    return { ok: false, problem: "The packaged computer helper signature metadata is invalid." }
  }
  if (
    channel !== "dev" &&
    (!input.asarStrings ||
      input.asarStrings.some((text) => text.includes("VECTOR_COMPUTER_HELPER_COMMAND") || text.includes("__vectorE2E")))
  )
    return {
      ok: false,
      problem: "The release app archive is missing its audit or contains a development helper or test fixture marker.",
    }
  return { ok: true }
}

const packageDirectory = fileURLToPath(new URL("../", import.meta.url))
const executableName = "VectorComputer.app/Contents/MacOS/VectorComputer"
const signatureResource = "VectorComputer.app/Contents/_CodeSignature/CodeResources"
const architectures = ["x64", "arm64"] as const
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const keys = (value: Record<string, unknown>) => Object.keys(value).sort().join(",")

/** This record is useful as provenance only after the containing app's outer seal has verified. */
export function parseComputerHelperSigningReceipt(value: unknown): ComputerHelperSigningReceipt {
  const sourceCdhash = record(value) && record(value.sourceCdhash) ? value.sourceCdhash : undefined
  if (
    !record(value) ||
    keys(value) !==
      "channel,finalExecutableSha256,finalManifestSha256,schemaVersion,signing,sourceCdhash,sourceManifest" ||
    value.schemaVersion !== 1 ||
    (value.channel !== "prod" && value.channel !== "beta" && value.channel !== "dev") ||
    (value.signing !== "adhoc" && value.signing !== "developer-id") ||
    typeof value.finalManifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.finalManifestSha256) ||
    typeof value.finalExecutableSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.finalExecutableSha256) ||
    !sourceCdhash ||
    keys(sourceCdhash) !== "arm64,x64" ||
    !architectures.every((arch) => typeof sourceCdhash[arch] === "string" && /^[a-f0-9]{40}$/.test(sourceCdhash[arch]))
  )
    throw new Error("The computer helper signing receipt is invalid.")
  const sourceManifest = parseHelperManifest(value.sourceManifest)
  if (sourceManifest.platform !== "darwin")
    throw new Error("The computer helper signing receipt has the wrong platform.")
  return { ...value, sourceManifest } as ComputerHelperSigningReceipt
}

/** The source lock measures the pre-sign ad-hoc helper, not a newly issued Developer ID CodeDirectory. */
export function checkComputerHelperSigningProvenance(input: {
  receipt: ComputerHelperSigningReceipt
  manifest: HelperManifest
  manifestBytes: Uint8Array
  executableBytes: Uint8Array
  channel: "prod" | "beta" | "dev"
  expectSigning: "adhoc" | "developer-id"
  expectedSourceDigest: string
  lock: unknown
}) {
  const receipt = input.receipt
  const source = receipt.sourceManifest
  const final = input.manifest
  if (
    receipt.channel !== input.channel ||
    receipt.signing !== input.expectSigning ||
    receipt.finalManifestSha256 !== hash(input.manifestBytes) ||
    receipt.finalExecutableSha256 !== hash(input.executableBytes)
  )
    throw new Error("The computer helper signing receipt does not bind the final package bytes.")
  if (
    source.platform !== "darwin" ||
    final.platform !== "darwin" ||
    source.helperVersion !== final.helperVersion ||
    source.sourceDigest !== final.sourceDigest ||
    source.sourceDigest !== input.expectedSourceDigest ||
    source.toolchain !== final.toolchain ||
    source.protocol.min !== final.protocol.min ||
    source.protocol.max !== final.protocol.max ||
    Object.keys(source.files).sort().join("\0") !== Object.keys(final.files).sort().join("\0")
  )
    throw new Error("The signed computer helper differs from its verified source provenance.")
  for (const [file, entry] of Object.entries(source.files)) {
    const actual = final.files[file]!
    if (
      entry.arch.toSorted().join(",") !== actual.arch.toSorted().join(",") ||
      (file !== executableName && file !== signatureResource && entry.sha256 !== actual.sha256)
    )
      throw new Error("Signing changed an immutable computer helper resource or architecture.")
  }
  const baseline = checkIdentityLock(input.lock, input.lock as IdentityLock)
  if (!baseline.ok) throw new Error(baseline.problems.join(" "))
  const lock = input.lock as IdentityLock
  const verdict =
    input.channel === "prod"
      ? checkIdentityLock(lock, {
          enforce: true,
          helperVersion: source.helperVersion,
          sourceDigest: source.sourceDigest,
          toolchain: source.toolchain,
          cdhash: receipt.sourceCdhash,
        })
      : {
          ok: !lock.enforce || (lock.helperVersion === source.helperVersion && lock.toolchain === source.toolchain),
          problems: [
            ...(lock.helperVersion === source.helperVersion
              ? []
              : ["The helper version differs from its measured source baseline."]),
            ...(lock.toolchain === source.toolchain
              ? []
              : ["The helper toolchain differs from its measured source baseline."]),
          ],
        }
  if (!verdict.ok) throw new Error(verdict.problems.join(" "))
  // Beta/dev use a different helper identifier, plist and source digest. Their actual channel-specific
  // source digest is recomputed above; no production cdhash is invented for an unmeasured channel.
  return verdict.problems
}

export function checkComputerHelperVersion(value: unknown, manifest: HelperManifest) {
  if (
    !record(value) ||
    keys(value) !== "arch,helperVersion,platform,protocol,sourceDigest" ||
    value.helperVersion !== manifest.helperVersion ||
    value.platform !== "darwin" ||
    value.sourceDigest !== manifest.sourceDigest ||
    !record(value.protocol) ||
    keys(value.protocol) !== "max,min" ||
    value.protocol.min !== manifest.protocol.min ||
    value.protocol.max !== manifest.protocol.max ||
    !architectures.includes(value.arch as "x64" | "arm64") ||
    !manifest.files[executableName]?.arch.includes(value.arch as "x64" | "arm64")
  )
    throw new Error("The packaged computer helper version does not match its final manifest.")
}

export function emptyComputerHelperEntitlements(text: string) {
  if (Buffer.byteLength(text) > 32_768) return false
  const xml = text
    .trim()
    .replace(/^<\?xml[^?]*\?>\s*/, "")
    .replace(
      /^<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "https?:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">\s*/,
      "",
    )
  return /^<plist(?:\s+version="1\.0")?\s*>\s*(?:<dict\s*\/\s*>|<dict>\s*<\/dict>)\s*<\/plist>$/.test(xml)
}

async function regularFile(root: string, relative: string, limit = 512 * 1024) {
  const file = path.join(root, ...relative.split("/"))
  const info = await lstat(file)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > limit ||
    !(await realpath(file)).startsWith(root + path.sep)
  )
    throw new Error("The packaged computer helper has an invalid file path or size.")
  return readFile(file)
}

async function helperFiles(root: string, prefix = "", state = { count: 0 }, depth = 0): Promise<string[]> {
  if (depth > 8) throw new Error("The packaged computer helper directory is too deeply nested.")
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true })
  if (entries.length > 256) throw new Error("The packaged computer helper contains too many files.")
  return (
    await Promise.all(
      entries.map(async (entry) => {
        if (++state.count > 256) throw new Error("The packaged computer helper contains too many filesystem entries.")
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
          throw new Error("The packaged computer helper contains an unexpected filesystem entry.")
        return entry.isDirectory() ? helperFiles(root, relative, state, depth + 1) : [relative]
      }),
    )
  ).flat()
}

/** ASAR file bodies are uncompressed. Stream the whole archive and retain only fixed-marker matches. */
async function asarMarkers(file: string) {
  const markers = ["VECTOR_COMPUTER_HELPER_COMMAND", "__vectorE2E"]
  const found = new Set<string>()
  const state = { tail: "" }
  for await (const chunk of createReadStream(file, { highWaterMark: 65_536 })) {
    const text = state.tail + (chunk as Buffer).toString("latin1")
    for (const marker of markers) if (text.includes(marker)) found.add(marker)
    state.tail = text.slice(-Math.max(...markers.map((marker) => marker.length)))
  }
  return [...found]
}

export async function verifyComputerHelperMac(
  input: {
    app: string
    expectSigning: "adhoc" | "developer-id"
    channel?: "prod" | "beta" | "dev"
  },
  dependencies: {
    directory?: string
    run?: NativeCommand
    expectedSourceDigest?: (manifest: HelperManifest, channel: "prod" | "beta" | "dev") => Promise<string>
  } = {},
) {
  if (process.platform !== "darwin" && !dependencies.run) throw new Error("Verify the packaged macOS helper on macOS.")
  if (input.expectSigning !== "adhoc" && input.expectSigning !== "developer-id")
    throw new Error("Choose adhoc or developer-id signing verification.")
  const root = await realpath(input.app)
  const directory = path.resolve(dependencies.directory ?? packageDirectory)
  const run = dependencies.run ?? runNativeCommand
  const settings = { cwd: directory, env: process.env, timeoutMs: 5000 }
  const command = async (executable: string, args: readonly string[], message: string, timeoutMs = 5000) => {
    const result = await run(executable, args, { ...settings, timeoutMs })
    if (result.code !== 0 || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 65_536)
      throw new Error(message)
    return result
  }
  await regularFile(root, "Contents/Info.plist")
  const plist = async (file: string, key: string) =>
    (
      await command(
        "/usr/bin/plutil",
        ["-extract", key, "raw", "-o", "-", file],
        "The packaged helper metadata could not be read.",
      )
    ).stdout.trim()
  const bundleID = await plist(path.join(root, "Contents/Info.plist"), "CFBundleIdentifier")
  const channel = (Object.keys(APP_IDS) as (keyof typeof APP_IDS)[]).find((value) => APP_IDS[value] === bundleID)
  if (!channel) throw new Error("The packaged desktop has an unknown channel identifier.")
  if (input.channel !== undefined && input.channel !== channel)
    throw new Error("The packaged desktop channel differs from the requested verification channel.")
  const helper = path.join(root, "Contents/Helpers/VectorComputer.app")
  const helperInfo = await lstat(helper)
  if (!helperInfo.isDirectory() || helperInfo.isSymbolicLink() || !(await realpath(helper)).startsWith(root + path.sep))
    throw new Error("The packaged computer helper bundle is missing or invalid.")
  const bytes = await regularFile(root, "Contents/Resources/computer-helper.json")
  const manifest = parseHelperManifest(JSON.parse(bytes.toString("utf8")))
  const receipt = parseComputerHelperSigningReceipt(
    JSON.parse((await regularFile(root, "Contents/Resources/computer-helper-signing.json")).toString("utf8")),
  )
  const executable = await regularFile(root, `Contents/Helpers/${executableName}`, 64 * 1024 * 1024)
  const actualFiles = (await helperFiles(helper)).map((file) => `VectorComputer.app/${file}`).sort()
  if (actualFiles.join("\0") !== Object.keys(manifest.files).sort().join("\0"))
    throw new Error("The final computer helper contains missing or unexpected files.")
  for (const [file, metadata] of Object.entries(manifest.files)) {
    if (
      !file.startsWith("VectorComputer.app/") ||
      hash(await regularFile(root, `Contents/Helpers/${file}`, 64 * 1024 * 1024)) !== metadata.sha256
    )
      throw new Error("A final computer helper file failed its manifest hash check.")
  }
  // The receipt is part of this outer seal. A loose, self-asserted receipt never supplies source proof.
  await command(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--all-architectures", root],
    "The desktop signature does not seal its helper provenance.",
  )
  await command(
    "/usr/bin/codesign",
    ["--verify", "--strict", "--all-architectures", helper],
    "The packaged computer helper signature is invalid.",
  )
  const outerResult = await command(
    "/usr/bin/codesign",
    ["--display", "--verbose=4", root],
    "The desktop signature metadata could not be read.",
  )
  const outer = parseMacCodeSignature(`${outerResult.stdout}\n${outerResult.stderr}`)
  if (outer.signing !== input.expectSigning || outer.identifier !== bundleID)
    throw new Error("The desktop signature does not match the requested signing kind.")
  const signatures: string[] = [],
    entitlements: unknown[] = []
  for (const architecture of architectures) {
    const arch = architecture === "x64" ? "x86_64" : "arm64"
    const signature = await command(
      "/usr/bin/codesign",
      ["--display", "--verbose=4", "--arch", arch, helper],
      "A packaged helper slice has no readable signature.",
    )
    const text = `${signature.stdout}\n${signature.stderr}`
    signatures.push(text)
    const actual = parseMacCodeSignature(text)
    if (input.expectSigning === "adhoc" && actual.cdhash !== receipt.sourceCdhash[architecture])
      throw new Error("The ad-hoc helper identity changed after its measured signing baseline.")
    const entitlement = await command(
      "/usr/bin/codesign",
      ["--display", "--arch", arch, "--entitlements", ":-", "--xml", helper],
      "A packaged helper slice has no readable entitlements.",
    )
    entitlements.push(emptyComputerHelperEntitlements(entitlement.stdout) ? {} : null)
  }
  if (input.expectSigning === "developer-id") {
    if (!/^[A-Z0-9]{10}$/.test(outer.teamID ?? "")) throw new Error("The desktop Developer ID team is missing.")
    const requirement = `anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[subject.OU] = "${outer.teamID}"`
    for (const target of [root, helper])
      await command(
        "/usr/bin/codesign",
        ["--verify", "--strict", "--all-architectures", "-R", requirement, target],
        "The packaged app and helper must satisfy the same Apple Developer ID requirement.",
      )
  }
  const asar = path.join(root, "Contents/Resources/app.asar")
  const asarInfo = await lstat(asar)
  if (!asarInfo.isFile() || asarInfo.isSymbolicLink() || !(await realpath(asar)).startsWith(root + path.sep))
    throw new Error("The packaged app archive is missing or invalid.")
  const identity = readIdentity(path.join(directory, "native/computer-helper/identity.json"))
  if (manifest.protocol.min !== identity.protocol.min || manifest.protocol.max !== identity.protocol.max)
    throw new Error("The packaged computer helper protocol differs from the current source identity.")
  const checked = checkComputerHelper({
    bundleID,
    helperBundleID: await plist(path.join(helper, "Contents/Info.plist"), "CFBundleIdentifier"),
    helperVersion: await plist(path.join(helper, "Contents/Info.plist"), "CFBundleShortVersionString"),
    expectedHelperVersion: identity.helperVersion,
    manifest,
    architectures: binaryArchitectures(executable),
    signatureText: signatures,
    entitlements,
    expectSigning: input.expectSigning,
    appTeamID: outer.teamID,
    asarStrings: await asarMarkers(asar),
  })
  if (!checked.ok) throw new Error(checked.problem)
  if ((await plist(path.join(helper, "Contents/Info.plist"), "VectorComputerSourceDigest")) !== manifest.sourceDigest)
    throw new Error("The helper's source metadata differs from its final manifest.")
  const expectedSourceDigest = dependencies.expectedSourceDigest
    ? await dependencies.expectedSourceDigest(manifest, channel)
    : await sourceDigestFor(
        directory,
        "darwin",
        channel,
        manifest.toolchain,
        generateIdentitySources(path.join(directory, "native/build/computer-helper-release-check/generated"), {
          identity: path.join(directory, "native/computer-helper/identity.json"),
          blocklist: path.join(directory, "native/computer-helper/blocklist.json"),
        }).find((file) => file.endsWith("Identity.swift"))!,
      )
  const warnings = checkComputerHelperSigningProvenance({
    receipt,
    manifest,
    manifestBytes: bytes,
    executableBytes: executable,
    channel,
    expectSigning: input.expectSigning,
    expectedSourceDigest,
    lock: JSON.parse(await readFile(path.join(directory, "native/computer-helper/macos/identity.lock.json"), "utf8")),
  })
  const version = await command(
    path.join(helper, "Contents/MacOS/VectorComputer"),
    ["--version", "--json"],
    "The final-location computer helper version check failed.",
  )
  checkComputerHelperVersion(JSON.parse(version.stdout), manifest)
  const packaged = await command(
    path.join(helper, "Contents/MacOS/VectorComputer"),
    ["--self-test=packaged"],
    "The final-location computer helper packaged self-test failed.",
    10_000,
  )
  const { nativeSelfTestChecks } = await import("./computer-helper-selftest")
  if (nativeSelfTestChecks(packaged.stdout, "packaged", packaged.code).some((check) => !check.ok || check.skipped))
    throw new Error("The final-location computer helper packaged self-test did not pass every check.")
  return { manifest, receipt, warnings }
}

export function parseVerifyComputerHelperArgs(args: readonly string[]) {
  const parsed = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      app: { type: "string" },
      win: { type: "string" },
      arch: { type: "string" },
      channel: { type: "string" },
      "expect-signing": { type: "string" },
      publisher: { type: "string" },
    },
  })
  for (const name of Object.keys(parsed.values))
    if (args.filter((value) => value === `--${name}` || value.startsWith(`--${name}=`)).length !== 1)
      throw new Error("Verification arguments must be supplied exactly once.")
  const channel = parsed.values.channel
  if (channel !== undefined && channel !== "prod" && channel !== "beta" && channel !== "dev")
    throw new Error("The verification channel must be prod, beta or dev.")
  if (parsed.values.app !== undefined) {
    if (
      !parsed.values.app ||
      parsed.values.win !== undefined ||
      parsed.values.arch !== undefined ||
      parsed.values.publisher !== undefined ||
      (parsed.values["expect-signing"] !== "adhoc" && parsed.values["expect-signing"] !== "developer-id")
    )
      throw new Error("Usage: --app <Vector.app> [--channel prod|beta|dev] --expect-signing adhoc|developer-id")
    return {
      platform: "darwin" as const,
      app: path.resolve(parsed.values.app),
      expectSigning: parsed.values["expect-signing"],
      ...(channel !== undefined ? { channel } as const : {}),
    } as const
  }
  const architecture = parsed.values.arch
  const expectSigning = parsed.values["expect-signing"]
  const publisher = parsed.values.publisher
  if (
    !parsed.values.win ||
    (architecture !== "x64" && architecture !== "arm64") ||
    channel === undefined ||
    (expectSigning !== "unsigned" && expectSigning !== "authenticode") ||
    (expectSigning === "unsigned" && publisher !== undefined) ||
    (expectSigning === "authenticode" && (!publisher?.trim() || publisher.length > 512 || /[\p{C}]/u.test(publisher)))
  )
    throw new Error(
      "Usage: --win <unpacked-dir> --arch x64|arm64 --channel prod|beta|dev --expect-signing unsigned|authenticode [--publisher <exact certificate Subject>]",
    )
  return {
    platform: "win32" as const,
    app: path.resolve(parsed.values.win),
    architecture,
    channel,
    expectSigning,
    ...(publisher !== undefined ? { publisher } : {}),
  } as const
}

if (import.meta.main) {
  const input = parseVerifyComputerHelperArgs(process.argv.slice(2))
  if (input.platform === "win32") {
    const { verifyComputerHelperWindows } = await import("./verify-computer-helper-windows")
    await verifyComputerHelperWindows(input)
  } else {
    const result = await verifyComputerHelperMac(input)
    for (const warning of result.warnings) console.warn(warning)
  }
  console.log("Verified the final computer helper identity, signatures, provenance and packaged self-test.")
}
