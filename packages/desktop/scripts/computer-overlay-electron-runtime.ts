import { createHash } from "node:crypto"
import { lstat, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { NativeCommand } from "./build-computer-helper"

const profileDigest = "16b05c93e71cebb2b645afa60a55a0dd29d022702d9c95c7076c7fd51e5d6a5a"
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")

/** Prepare only the caller's separate Electron fixture. The installed source and shipping helper stay read-only. */
export async function prepareComputerOverlayElectronRuntime(input: {
  source: string
  copy: string
  directory: string
  run: NativeCommand
  environment?: NodeJS.ProcessEnv
  write?: (message: string) => void
}) {
  const sourceInfo = await lstat(input.source),
    copyInfo = await lstat(input.copy)
  const source = await realpath(input.source),
    copy = await realpath(input.copy),
    directory = await realpath(input.directory)
  if (
    !sourceInfo.isDirectory() ||
    sourceInfo.isSymbolicLink() ||
    !copyInfo.isDirectory() ||
    copyInfo.isSymbolicLink() ||
    source === copy ||
    source.startsWith(copy + path.sep) ||
    copy.startsWith(source + path.sep)
  )
    throw new Error("The dedicated Electron source and copy must be distinct non-nested regular bundles.")
  const observe = (message: string) => {
    // Reporting is observational: a logger cannot replace or change any admission result.
    try {
      ;(input.write ?? ((value: string) => process.stderr.write(value)))(message)
    } catch {}
  }
  const command = async (step: string, binary: string, args: readonly string[], timeoutMs = 10_000) => {
    const result = await input.run(binary, args, { cwd: directory, env: input.environment ?? process.env, timeoutMs })
    if (result.code !== 0 || result.failureReason) {
      observe(
        `overlay-electron-runtime-failed stage=${step} code=${result.code} reason=${result.failureReason ?? "exit"}\n`,
      )
      observe(
        `overlay-electron-runtime-output-begin\n${bounded(result.diagnostic ?? [result.stdout, result.stderr].filter(Boolean).join("\n"))}\noverlay-electron-runtime-output-end\n`,
      )
      throw new Error(`The dedicated Electron runtime failed at ${step}.`)
    }
    return result
  }
  const metadata = async (step: string) => {
    const result = await command(step, "/usr/bin/codesign", [
      "--display",
      "--verbose=4",
      "--entitlements",
      ":-",
      "--xml",
      copy,
    ])
    const identifier = [...result.stderr.matchAll(/^Identifier=([^\r\n]+)\r?$/gm)]
    const flags = [...result.stderr.matchAll(/^CodeDirectory .* flags=(0x[0-9a-f]+)(?:\([^\r\n]*?\))? /gim)]
    const runtime = [...result.stderr.matchAll(/^Runtime Version=([0-9]+(?:\.[0-9]+){0,3})\r?$/gm)]
    if (
      identifier.length !== 1 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(identifier[0]![1] ?? "") ||
      flags.length !== 1 ||
      runtime.length > 1 ||
      (runtime[0]?.[1]?.length ?? 0) > 40 ||
      Buffer.byteLength(result.stdout) > 16_384
    )
      throw new Error("The dedicated Electron signature metadata is unavailable or ambiguous.")
    const observedFlags = Number.parseInt(flags[0]![1]!, 16)
    if (
      !Number.isSafeInteger(observedFlags) ||
      observedFlags > 0xffffffff ||
      ((observedFlags & 0x10000) !== 0 && runtime.length !== 1)
    )
      throw new Error("The dedicated Electron runtime metadata is unavailable or ambiguous.")
    return {
      value: {
        identifier: identifier[0]![1],
        flags: observedFlags,
        runtime: runtime[0]?.[1] ?? "none",
        entitlements: hash(result.stdout.trim()),
      },
      xml: result.stdout.trim(),
    }
  }
  const sourceBefore = await witness(source),
    copyBefore = await witness(copy)
  if (sourceBefore.all !== copyBefore.all || copyBefore.helpers < 1)
    throw new Error("The dedicated Electron copy does not match its complete installed source.")
  const before = await metadata("template-metadata")
  if (
    before.value.identifier !== "Electron" ||
    before.value.flags !== 0x20002 ||
    before.value.runtime !== "none" ||
    before.value.entitlements !== hash("")
  )
    throw new Error("The dedicated Electron runtime does not have the exact known linker template.")
  for (const [key, expected] of [
    ["CFBundleIdentifier", "com.github.Electron"],
    ["CFBundleShortVersionString", "42.11.4"],
  ]) {
    const result = await command("bundle-metadata", "/usr/bin/plutil", [
      "-extract",
      key!,
      "raw",
      "-o",
      "-",
      path.join(copy, "Contents/Info.plist"),
    ])
    if (result.stdout.trim() !== expected)
      throw new Error("The dedicated Electron bundle metadata differs from the pinned runtime.")
  }
  const profile = path.join(directory, "resources/entitlements.plist"),
    profileInfo = await lstat(profile)
  if (
    !profileInfo.isFile() ||
    profileInfo.isSymbolicLink() ||
    profileInfo.size < 1 ||
    profileInfo.size > 16_384 ||
    (await realpath(profile)) !== profile
  )
    throw new Error("The dedicated Electron entitlement profile must be a bounded regular repository file.")
  const profileSha256 = hash(await readFile(profile))
  if (profileSha256 !== profileDigest)
    throw new Error("The dedicated Electron entitlement profile differs from the fixed C4 profile.")
  // This is C4's independently exercised unsigned Electron command. It changes only this owned fixture.
  await command("c4-deep-sign", "/usr/bin/codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    "--options",
    "runtime",
    "--timestamp=none",
    "--entitlements",
    profile,
    copy,
  ])
  await command("strict-all-architectures", "/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", copy])
  await command("deep-strict", "/usr/bin/codesign", ["--verify", "--deep", "--strict", "--all-architectures", copy])
  const final = await metadata("signed-metadata")
  if (
    final.value.identifier !== "com.github.Electron" ||
    final.value.flags !== 0x10002 ||
    final.value.runtime === "none"
  )
    throw new Error("The dedicated Electron signature did not acquire the required ad-hoc runtime identity.")
  const scratch = await mkdtemp(path.join(tmpdir(), "vector-overlay-runtime-entitlements-"))
  const profileApplied = await (async () => {
    try {
      const exported = path.join(scratch, "entitlements.plist")
      await writeFile(exported, final.xml, { flag: "wx" })
      const wanted = await command("profile-json", "/usr/bin/plutil", ["-convert", "json", "-o", "-", profile])
      const actual = await command("signed-entitlements-json", "/usr/bin/plutil", [
        "-convert",
        "json",
        "-o",
        "-",
        exported,
      ])
      return canonicalEntitlements(wanted.stdout) === canonicalEntitlements(actual.stdout)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })()
  const sourceAfter = await witness(source),
    copyAfter = await witness(copy)
  if (
    !profileApplied ||
    hash(await readFile(profile)) !== profileSha256 ||
    sourceAfter.all !== sourceBefore.all ||
    copyAfter.helpers !== copyBefore.helpers
  )
    throw new Error("The dedicated Electron source, profile or signed entitlement proof changed.")
  const version = await command("owned-version", path.join(copy, "Contents/MacOS/Electron"), ["--version"], 5000)
  if (version.stdout.trim() !== "v42.11.4") throw new Error("The dedicated Electron version differs from 42.11.4.")
  if ((await witness(source)).all !== sourceBefore.all || hash(await readFile(profile)) !== profileSha256)
    throw new Error("The dedicated Electron source or profile changed during version verification.")
  const receipt = {
    mode: "c4-deep-ad-hoc" as const,
    sourceBytesUnchanged: true as const,
    nestedBytePolicy: "re-signed-not-preserved" as const,
    nestedBytesChanged: copyBefore.nested !== copyAfter.nested,
    nestedFiles: copyBefore.nestedFiles,
    helperExecutables: copyBefore.helpers,
    profileSha256,
    profileApplied: true as const,
    finalMetadata: final.value,
    strictVerified: true as const,
    deepVerified: true as const,
    versionVerified: true as const,
  }
  observe(`overlay-electron-runtime-prepared ${JSON.stringify(receipt)}\n`)
  return receipt
}

function canonicalEntitlements(text: string) {
  if (Buffer.byteLength(text) > 16_384) throw new Error("The dedicated Electron entitlement JSON exceeded its bound.")
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The dedicated Electron entitlement dictionary is invalid.")
  const entries = Object.entries(value)
  if (
    entries.length > 32 ||
    entries.some(([key, field]) => !/^[A-Za-z0-9.-]{1,128}$/.test(key) || typeof field !== "boolean")
  )
    throw new Error("The dedicated Electron entitlement dictionary is unsupported.")
  return JSON.stringify(entries.sort(([left], [right]) => left.localeCompare(right)))
}

async function witness(root: string) {
  const entries: { file: string; digest: string }[] = []
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entries.length >= 16_384) throw new Error("The dedicated Electron witness exceeded its file bound.")
      const file = path.join(directory, entry.name),
        status = await lstat(file)
      if (status.isDirectory()) {
        await visit(file)
        continue
      }
      if (!status.isSymbolicLink() && (!status.isFile() || status.size > 512 * 1024 * 1024))
        throw new Error("The dedicated Electron witness encountered an unsupported file.")
      const link = status.isSymbolicLink() ? await readlink(file) : undefined
      if (link !== undefined && (path.isAbsolute(link) || !(await realpath(file)).startsWith(root + path.sep)))
        throw new Error("The dedicated Electron runtime requires internal relative bundle links.")
      entries.push({
        file: path.relative(root, file).split(path.sep).join("/"),
        digest: link === undefined ? hash(await readFile(file)) : `link:${link}`,
      })
    }
  }
  await visit(root)
  entries.sort((left, right) => left.file.localeCompare(right.file))
  const nested = entries.filter((entry) => entry.file.startsWith("Contents/Frameworks/"))
  return {
    all: hash(JSON.stringify(entries)),
    nested: hash(JSON.stringify(nested)),
    nestedFiles: nested.length,
    helpers: nested.filter((entry) => /\.app\/Contents\/MacOS\//.test(entry.file) && !entry.digest.startsWith("link:"))
      .length,
  }
}

function bounded(value: string) {
  const bytes = Buffer.from(value),
    marker = "\n[Electron runtime output truncated]\n"
  if (bytes.byteLength <= 8192) return value
  const side = Math.floor((8192 - Buffer.byteLength(marker)) / 2)
  return (
    bytes
      .subarray(0, side)
      .toString("utf8")
      .replace(/\uFFFD$/, "") +
    marker +
    bytes
      .subarray(-side)
      .toString("utf8")
      .replace(/^\uFFFD+/, "")
  )
}
