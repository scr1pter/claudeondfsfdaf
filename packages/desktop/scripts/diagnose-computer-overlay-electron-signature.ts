import { createHash } from "node:crypto"
import { cp, lstat, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runNativeCommand, type NativeCommand } from "./build-computer-helper"
import { boundedDiagnostic } from "./diagnose-build-computer-overlay-smoke"

export function parseElectronSignatureProbeOptions(args: readonly string[]) {
  if (args.length === 0) return { sealOwnedCopy: false }
  if (args.length === 1 && args[0] === "--seal-owned-copy") return { sealOwnedCopy: true }
  throw new Error("The signature probe accepts only the fixed --seal-owned-copy trial.")
}

/** CI contrast with an explicit disposable-copy trial. No source mutation or release authority. */
export async function probeComputerOverlayElectronSignatures(
  input: {
    directory?: string
    temporaryDirectory?: string
    run?: NativeCommand
    write?: (message: string) => void
    sealOwnedCopy?: boolean
  } = {},
) {
  const directory = path.resolve(input.directory ?? fileURLToPath(new URL("../", import.meta.url)))
  const require = createRequire(path.join(directory, "package.json"))
  const metadata = await realpath(require.resolve("electron/package.json"))
  const installed = JSON.parse(await readFile(metadata, "utf8")) as { version?: unknown }
  const desktop = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as {
    devDependencies?: { electron?: unknown }
  }
  if (installed.version !== "42.11.4" || desktop.devDependencies?.electron !== installed.version)
    throw new Error("The signature probe requires the exact pinned Electron 42.11.4.")
  const distribution = await realpath(path.join(path.dirname(metadata), "dist"))
  const relative = (await readFile(path.join(path.dirname(metadata), "path.txt"), "utf8")).trim()
  const source = path.join(distribution, "Electron.app")
  const status = await lstat(source)
  if (
    relative !== "Electron.app/Contents/MacOS/Electron" ||
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (await realpath(source)) !== source ||
    !(await realpath(path.join(distribution, relative))).startsWith(source + path.sep)
  )
    throw new Error("The signature probe requires the installed macOS Electron bundle.")
  const write = input.write ?? ((message: string) => process.stdout.write(message))
  const settings = { cwd: directory, env: process.env, timeoutMs: 30_000 }
  async function verify(role: "source" | "copy", bundle: string) {
    const result = await (input.run ?? runNativeCommand)(
      "/usr/bin/codesign",
      ["--verify", "--strict", "--all-architectures", bundle],
      settings,
    )
    const outcome = result.code === 0 ? "verified" : "failed"
    write(
      `electron-signature-probe role=${role} result=${outcome} code=${result.code} reason=${result.failureReason ?? "exit"}\n`,
    )
    if (result.code !== 0)
      write(
        `electron-signature-output-begin role=${role}\n${boundedDiagnostic(result.diagnostic ?? [result.stdout, result.stderr].filter(Boolean).join("\n"), 8192)}\nelectron-signature-output-end role=${role}\n`,
      )
    return outcome
  }
  // macOS exposes temp paths through /var aliases; compare every held bundle under its canonical root.
  const owned = await realpath(
    await mkdtemp(path.join(input.temporaryDirectory ?? tmpdir(), "vector-overlay-electron-signature-")),
  )
  try {
    const sourceResult = await verify("source", source)
    // Preserve the measured builder's baseline copy before any explicitly requested trial.
    await cp(distribution, path.join(owned, "electron"), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    })
    const copy = path.join(owned, "electron/Electron.app")
    const copyResult = await verify("copy", copy)
    const trial = input.sealOwnedCopy
      ? await sealOwnedElectronCopy(source, copy, input.run ?? runNativeCommand, settings, write)
      : undefined
    return {
      protocol: 1 as const,
      electronVersion: installed.version,
      source: sourceResult,
      copy: copyResult,
      ...(trial ? { trial } : {}),
    }
  } finally {
    await rm(owned, { recursive: true, force: true })
  }
}

class ElectronTrialCommandError extends Error {
  constructor(
    step: string,
    readonly missingNestedSeal: boolean,
  ) {
    super(`The owned Electron trial failed at ${step}.`)
  }
}

async function sealOwnedElectronCopy(
  source: string,
  copy: string,
  run: NativeCommand,
  settings: Parameters<NativeCommand>[2],
  write: (message: string) => void,
) {
  const entitlementXML = new Map<string, string>()
  const command = async (step: string, binary: string, args: readonly string[], timeoutMs = 10_000) => {
    const result = await run(binary, args, { ...settings, timeoutMs })
    write(
      `electron-signature-trial step=${step} result=${result.code === 0 ? "verified" : "failed"} code=${result.code}\n`,
    )
    if (result.code !== 0) {
      write(
        `electron-signature-trial-output step=${step}\n${boundedDiagnostic(result.diagnostic ?? [result.stdout, result.stderr].filter(Boolean).join("\n"), 8192)}\n`,
      )
      const detail = result.diagnostic ?? `${result.stdout}\n${result.stderr}`
      const component = /^In subcomponent: ([^\r\n]+)\r?$/m.exec(detail)?.[1]
      const prefix = path.join(copy, "Contents/Frameworks") + path.sep
      const candidate = component && path.isAbsolute(component) ? path.resolve(component) : undefined
      const contained = candidate?.startsWith(prefix) ? await realpath(candidate).catch(() => undefined) : undefined
      throw new ElectronTrialCommandError(
        step,
        binary === "/usr/bin/codesign" &&
          !result.failureReason &&
          ["seal-owned-copy", "strict-all-architectures", "deep-strict"].includes(step) &&
          /code object is not signed at all|code has no resources but signature indicates they must be present/.test(
            detail,
          ) &&
          contained?.startsWith(prefix) === true,
      )
    }
    return result
  }
  const metadata = async (step: string, bundle = copy) => {
    const result = await command(step, "/usr/bin/codesign", [
      "--display",
      "--verbose=4",
      "--entitlements",
      ":-",
      "--xml",
      bundle,
    ])
    const identifier = [...result.stderr.matchAll(/^Identifier=([^\r\n]+)\r?$/gm)]
    const flags = [...result.stderr.matchAll(/^CodeDirectory .* flags=(0x[0-9a-f]+)(?:\([^\r\n]*?\))? /gim)]
    const runtime = [...result.stderr.matchAll(/^Runtime Version=([0-9]+(?:\.[0-9]+){0,3})\r?$/gm)]
    if (Buffer.byteLength(result.stdout) > 16_384)
      throw new Error("The owned Electron entitlement metadata exceeded its bound.")
    entitlementXML.set(step, result.stdout.trim())
    if (
      identifier.length !== 1 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(identifier[0]![1] ?? "") ||
      flags.length !== 1 ||
      runtime.length > 1 ||
      (runtime[0]?.[1]?.length ?? 0) > 40
    )
      throw new Error("The owned Electron signature metadata is unavailable or ambiguous.")
    const observedFlags = Number.parseInt(flags[0]![1]!, 16)
    if (
      !Number.isSafeInteger(observedFlags) ||
      observedFlags > 0xffffffff ||
      ((observedFlags & 0x10000) !== 0 && runtime.length !== 1)
    )
      throw new Error("The owned Electron runtime metadata is unavailable or ambiguous.")
    const observed = {
      identifier: identifier[0]![1],
      flags: observedFlags,
      runtime: runtime[0]?.[1] ?? "none",
      entitlements: hash(result.stdout.trim()),
    }
    write(`electron-signature-trial-metadata step=${step} ${JSON.stringify(observed)}\n`)
    return observed
  }
  const metadataBefore = await metadata("metadata-before")
  const witnesses = await Promise.allSettled([
    electronTreeWitness(source, "source", write),
    electronTreeWitness(copy, "copy", write),
  ])
  if (witnesses[0]!.status === "rejected") throw witnesses[0]!.reason
  if (witnesses[1]!.status === "rejected") throw witnesses[1]!.reason
  const sourceBefore = witnesses[0]!.value
  const copyBefore = witnesses[1]!.value
  if (sourceBefore.all !== copyBefore.all)
    throw new Error("The owned Electron copy differs from the original before signing.")
  const linkerTemplate =
    metadataBefore.identifier === "Electron" &&
    metadataBefore.flags === 0x20002 &&
    metadataBefore.runtime === "none" &&
    metadataBefore.entitlements === hash("")
  if (!linkerTemplate && metadataBefore.identifier !== "com.github.Electron")
    throw new Error("The owned Electron trial metadata does not have the expected bundle identifier.")
  const bundleIdentifier = await command("bundle-identifier", "/usr/bin/plutil", [
    "-extract",
    "CFBundleIdentifier",
    "raw",
    "-o",
    "-",
    path.join(copy, "Contents/Info.plist"),
  ])
  if (bundleIdentifier.stdout.trim() !== "com.github.Electron")
    throw new Error("The owned Electron CFBundleIdentifier is invalid.")
  const mode = linkerTemplate ? "fresh-linker-template-bundle" : "preserved-bundle-metadata"
  write(`electron-signature-trial-classification mode=${mode}\n`)
  try {
    await command("seal-owned-copy", "/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--timestamp=none",
      ...(linkerTemplate
        ? ["--identifier", "com.github.Electron"]
        : ["--preserve-metadata=identifier,entitlements,flags,runtime"]),
      copy,
    ])
    await command("strict-all-architectures", "/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--all-architectures",
      copy,
    ])
    await command("deep-strict", "/usr/bin/codesign", ["--verify", "--deep", "--strict", "--all-architectures", copy])
    const metadataAfter = await metadata("metadata-after")
    const sourceAfter = await electronTreeWitness(source, "source", write)
    const copyAfter = await electronTreeWitness(copy, "copy", write)
    const proof = {
      // CS_ADHOC records the requested signing-kind change; every other original flag remains authoritative.
      metadataPreserved:
        !linkerTemplate &&
        JSON.stringify({ ...metadataBefore, flags: metadataBefore.flags & ~0x2 }) ===
          JSON.stringify({ ...metadataAfter, flags: metadataAfter.flags & ~0x2 }),
      freshBundleTransitionVerified:
        linkerTemplate &&
        metadataAfter.identifier === "com.github.Electron" &&
        metadataAfter.flags === 0x2 &&
        metadataAfter.runtime === "none" &&
        metadataAfter.entitlements === hash(""),
      nestedBytesUnchanged:
        copyBefore.nested === copyAfter.nested && copyBefore.helpers > 0 && copyBefore.nestedFiles > 0,
      sourceBytesUnchanged: sourceBefore.all === sourceAfter.all,
      nestedFiles: copyBefore.nestedFiles,
      helperExecutables: copyBefore.helpers,
    }
    write(`electron-signature-trial-preservation ${JSON.stringify({ ...proof, metadataBefore, metadataAfter })}\n`)
    if (
      (!proof.metadataPreserved && !proof.freshBundleTransitionVerified) ||
      !proof.nestedBytesUnchanged ||
      !proof.sourceBytesUnchanged
    )
      throw new Error("The owned Electron trial did not preserve required metadata or bytes.")
    const version = await command("owned-version", path.join(copy, "Contents/MacOS/Electron"), ["--version"], 5000)
    if (version.stdout.trim() !== "v42.11.4") throw new Error("The owned Electron version did not match 42.11.4.")
    write("electron-signature-trial result=verified version=42.11.4 baseline-unchanged=true no-release-credit=true\n")
    return { mode, ...proof, strictVerified: true, deepVerified: true, versionVerified: true }
  } catch (error) {
    if (!linkerTemplate || !(error instanceof ElectronTrialCommandError) || !error.missingNestedSeal) throw error
    write("electron-signature-trial-fallback mode=c4-deep-ad-hoc reason=missing-nested-seal root-only-result=failed\n")
    if ((await electronTreeWitness(source, "source", write)).all !== sourceBefore.all)
      throw new Error("The original Electron changed before the second owned-copy trial.")
    const second = path.join(path.dirname(path.dirname(copy)), "electron-deep")
    await cp(path.dirname(source), second, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    })
    const deepCopy = path.join(second, "Electron.app")
    const before = await electronTreeWitness(deepCopy, "copy", write)
    if (before.all !== sourceBefore.all) throw new Error("The second owned Electron copy differs from the original.")
    const profile = path.join(settings.cwd, "resources/entitlements.plist")
    const profileInfo = await lstat(profile)
    if (!profileInfo.isFile() || profileInfo.isSymbolicLink() || profileInfo.size > 16_384)
      throw new Error("The fixed C4 Electron entitlement profile is invalid.")
    const profileSha256 = hash(await readFile(profile))
    write(`electron-signature-trial-profile mode=c4-deep-ad-hoc sha256=${profileSha256}\n`)
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
      deepCopy,
    ])
    await command("c4-strict-all-architectures", "/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--all-architectures",
      deepCopy,
    ])
    await command("c4-deep-strict", "/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--all-architectures",
      deepCopy,
    ])
    const finalMetadata = await metadata("c4-metadata-after", deepCopy)
    const exported = path.join(second, "observed-entitlements.plist")
    await writeFile(exported, entitlementXML.get("c4-metadata-after") ?? "", { flag: "wx" })
    const inputEntitlements = await command("c4-profile-json", "/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      profile,
    ])
    const signedEntitlements = await command("c4-signed-entitlements-json", "/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      exported,
    ])
    const profileApplied =
      canonicalEntitlements(inputEntitlements.stdout) === canonicalEntitlements(signedEntitlements.stdout)
    const after = await electronTreeWitness(deepCopy, "copy", write)
    const sourceUnchanged = (await electronTreeWitness(source, "source", write)).all === sourceBefore.all
    if (
      !sourceUnchanged ||
      !profileApplied ||
      hash(await readFile(profile)) !== profileSha256 ||
      finalMetadata.identifier !== "com.github.Electron" ||
      finalMetadata.flags !== 0x10002 ||
      finalMetadata.runtime === "none" ||
      before.helpers < 1
    )
      throw new Error("The second owned-copy trial failed its source/profile/metadata proof.")
    const version = await command(
      "c4-owned-version",
      path.join(deepCopy, "Contents/MacOS/Electron"),
      ["--version"],
      5000,
    )
    if (version.stdout.trim() !== "v42.11.4")
      throw new Error("The second owned Electron version did not match 42.11.4.")
    const proof = {
      mode: "c4-deep-ad-hoc",
      sourceBytesUnchanged: true,
      nestedBytePolicy: "re-signed-not-preserved",
      nestedBytesChanged: before.nested !== after.nested,
      profileSha256,
      profileApplied,
      finalMetadata,
      strictVerified: true,
      deepVerified: true,
      versionVerified: true,
    }
    write(
      `electron-signature-trial-second-owned-copy ${JSON.stringify(proof)} baseline-unchanged=true no-release-credit=true\n`,
    )
    return proof
  }
}

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")

function canonicalEntitlements(text: string) {
  if (Buffer.byteLength(text) > 16_384) throw new Error("The fixed C4 entitlement JSON exceeded its bound.")
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The fixed C4 entitlement dictionary is invalid.")
  const entries = Object.entries(value)
  if (
    entries.length > 32 ||
    entries.some(([key, field]) => !/^[A-Za-z0-9.-]{1,128}$/.test(key) || typeof field !== "boolean")
  )
    throw new Error("The fixed C4 entitlement dictionary is unsupported.")
  return JSON.stringify(entries.sort(([left], [right]) => left.localeCompare(right)))
}

async function electronTreeWitness(root: string, role: "source" | "copy", write: (message: string) => void) {
  const entries: { file: string; digest: string }[] = []
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entries.length >= 16_384) throw new Error("The Electron witness exceeded its fixed file bound.")
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(file)
        continue
      }
      const status = await lstat(file)
      if (!status.isSymbolicLink() && (!status.isFile() || status.size > 512 * 1024 * 1024))
        throw new Error("The Electron witness encountered an unsupported file.")
      const link = status.isSymbolicLink() ? await readlink(file) : undefined
      if (link !== undefined) {
        const resolved = await realpath(file).catch(() => undefined)
        const scope = path.isAbsolute(link)
          ? "absolute"
          : resolved === root
            ? "bundle-root"
            : resolved?.startsWith(root + path.sep)
              ? "internal"
              : resolved
                ? "external"
                : "unresolved"
        if (scope !== "internal") {
          write(
            `electron-signature-trial-link ${JSON.stringify({ role, file: boundedDiagnostic(path.relative(root, file).split(path.sep).join("/"), 512), target: boundedDiagnostic(link, 1024), scope })}\n`,
          )
          throw new Error("The Electron trial requires internal relative bundle links.")
        }
      }
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

if (import.meta.main)
  void (async () => {
    const options = parseElectronSignatureProbeOptions(process.argv.slice(2))
    if (process.platform !== "darwin") throw new Error("Run the fixed Electron signature probe only on actual macOS.")
    const report = await probeComputerOverlayElectronSignatures(options)
    // The trial never converts the original invalid baseline into a successful source/copy claim.
    if (report.source !== "verified" || report.copy !== "verified") process.exitCode = 1
  })().catch((error: unknown) => {
    process.stderr.write(
      `electron-signature-probe-failed cause=${JSON.stringify(boundedDiagnostic(error instanceof Error ? error.message : "Unknown probe failure.", 1024))}\n`,
    )
    process.exitCode = 1
  })
