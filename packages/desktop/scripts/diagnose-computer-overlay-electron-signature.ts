import { cp, lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runNativeCommand, type NativeCommand } from "./build-computer-helper"
import { boundedDiagnostic } from "./diagnose-build-computer-overlay-smoke"

/** Read-only CI contrast. No re-signing, native compilation, artifact or release authority. */
export async function probeComputerOverlayElectronSignatures(
  input: { directory?: string; run?: NativeCommand; write?: (message: string) => void } = {},
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
    // These are the measured builder's exact Bun fs.cp options; do not repair or re-sign the copy.
    await cp(distribution, path.join(owned, "electron"), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    })
    const copyResult = await verify("copy", path.join(owned, "electron/Electron.app"))
    return { protocol: 1 as const, electronVersion: installed.version, source: sourceResult, copy: copyResult }
  } finally {
    await rm(owned, { recursive: true, force: true })
  }
}

if (import.meta.main)
  void (async () => {
    if (process.platform !== "darwin" || process.argv.length !== 2)
      throw new Error("Run the fixed Electron signature probe only on actual macOS.")
    const report = await probeComputerOverlayElectronSignatures()
    if (report.source !== "verified" || report.copy !== "verified") process.exitCode = 1
  })().catch((error: unknown) => {
    process.stderr.write(
      `electron-signature-probe-failed cause=${JSON.stringify(boundedDiagnostic(error instanceof Error ? error.message : "Unknown probe failure.", 1024))}\n`,
    )
    process.exitCode = 1
  })
