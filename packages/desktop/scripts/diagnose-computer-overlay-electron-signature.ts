import { createHash } from "node:crypto"
import { cp, lstat, mkdtemp, readFile, readdir, readlink, realpath, rm } from "node:fs/promises"
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
  input: { directory?: string; run?: NativeCommand; write?: (message: string) => void; sealOwnedCopy?: boolean } = {},
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
  const owned = await mkdtemp(path.join(tmpdir(), "vector-overlay-electron-signature-"))
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

async function sealOwnedElectronCopy(
  source: string,
  copy: string,
  run: NativeCommand,
  settings: Parameters<NativeCommand>[2],
  write: (message: string) => void,
) {
  const command = async (step: string, binary: string, args: readonly string[], timeoutMs = 10_000) => {
    const result = await run(binary, args, { ...settings, timeoutMs })
    write(
      `electron-signature-trial step=${step} result=${result.code === 0 ? "verified" : "failed"} code=${result.code}\n`,
    )
    if (result.code !== 0) {
      write(
        `electron-signature-trial-output step=${step}\n${boundedDiagnostic(result.diagnostic ?? [result.stdout, result.stderr].filter(Boolean).join("\n"), 8192)}\n`,
      )
      throw new Error(`The owned Electron trial failed at ${step}.`)
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
    if (observed.identifier !== "com.github.Electron")
      throw new Error("The owned Electron trial metadata does not have the expected bundle identifier.")
    return observed
  }
  const sourceBefore = await electronTreeWitness(source)
  const copyBefore = await electronTreeWitness(copy)
  const metadataBefore = await metadata("metadata-before")
  await command("seal-owned-copy", "/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--timestamp=none",
    "--preserve-metadata=identifier,entitlements,flags,runtime",
    copy,
  ])
  await command("strict-all-architectures", "/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", copy])
  await command("deep-strict", "/usr/bin/codesign", ["--verify", "--deep", "--strict", "--all-architectures", copy])
  const metadataAfter = await metadata("metadata-after")
  const sourceAfter = await electronTreeWitness(source)
  const copyAfter = await electronTreeWitness(copy)
  const proof = {
    // CS_ADHOC records the requested signing-kind change; every other original flag remains authoritative.
    metadataPreserved:
      JSON.stringify({ ...metadataBefore, flags: metadataBefore.flags & ~0x2 }) ===
      JSON.stringify({ ...metadataAfter, flags: metadataAfter.flags & ~0x2 }),
    nestedBytesUnchanged:
      copyBefore.nested === copyAfter.nested && copyBefore.helpers > 0 && copyBefore.nestedFiles > 0,
    sourceBytesUnchanged: sourceBefore.all === sourceAfter.all,
    nestedFiles: copyBefore.nestedFiles,
    helperExecutables: copyBefore.helpers,
  }
  write(`electron-signature-trial-preservation ${JSON.stringify({ ...proof, metadataBefore, metadataAfter })}\n`)
  if (!proof.metadataPreserved || !proof.nestedBytesUnchanged || !proof.sourceBytesUnchanged)
    throw new Error("The owned Electron trial did not preserve required metadata or bytes.")
  const version = await command("owned-version", path.join(copy, "Contents/MacOS/Electron"), ["--version"], 5000)
  if (version.stdout.trim() !== "v42.11.4") throw new Error("The owned Electron version did not match 42.11.4.")
  write("electron-signature-trial result=verified version=42.11.4 baseline-unchanged=true no-release-credit=true\n")
  return { ...proof, strictVerified: true, deepVerified: true, versionVerified: true }
}

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")

async function electronTreeWitness(root: string) {
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
      if (link !== undefined && (path.isAbsolute(link) || !(await realpath(file)).startsWith(root + path.sep)))
        throw new Error("The Electron trial requires internal relative bundle links.")
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
