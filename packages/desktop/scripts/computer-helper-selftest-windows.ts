import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { clearTimeout, setTimeout } from "node:timers"
import { Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { frameReader, type Received } from "../test/computer/transcript"
import {
  WINDOWS_TEST_ARTIFACTS,
  parseHelperManifest,
  sourceDigestFor,
  verifyPrebuiltHelper,
  verifyWindowsTestArtifacts,
  type HelperArchitecture,
  type HelperManifest,
} from "./build-computer-helper"
import { EXECUTABLE_NAMES } from "./channel-ids"
import { generateIdentitySources, readIdentity } from "./computer-helper-identity"
import type {
  Command,
  CommandResult,
  NativeChannel,
  SelfTestOptions,
  VerifiedFixture,
} from "./computer-helper-selftest"

const windowsSmokeChecks = ["wire-codec", "packaged-pe", "packaged-manifest", "packaged-version"] as const
export const WINDOWS_NATIVE_CHECKS = {
  unprivileged: windowsSmokeChecks,
  packaged: windowsSmokeChecks,
  privileged: ["windows-privileged-target-pending"],
  eof: ["caller-eof"],
  parentDeath: ["caller-parent-death"],
} as const
const WindowsNativeReport = Schema.Struct({
  checks: Schema.Array(
    Schema.Struct({ name: Schema.String, ok: Schema.Boolean, skipped: Schema.optional(Schema.Boolean) }),
  ),
})

export function windowsNativeSelfTestChecks(
  stdout: string,
  mode: keyof typeof WINDOWS_NATIVE_CHECKS,
  code: number | null,
) {
  if (Buffer.byteLength(stdout) > 32_768) throw new Error("Invalid Windows native report.")
  const report = Schema.decodeUnknownSync(WindowsNativeReport, { onExcessProperty: "error" })(
    Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(stdout),
  )
  const expected = WINDOWS_NATIVE_CHECKS[mode]
  if (
    report.checks.length !== expected.length ||
    report.checks.some((entry, index) => entry.name !== expected[index] || (entry.ok && entry.skipped === true))
  )
    throw new Error("Invalid Windows native catalog.")
  const failed = report.checks.some((entry) => !entry.ok && entry.skipped !== true)
  const skipped = report.checks.some((entry) => entry.skipped === true)
  if (code !== (failed ? 1 : skipped ? 77 : 0) || (mode !== "privileged" && skipped))
    throw new Error("Inconsistent Windows native exit.")
  // W11 has not supplied native privileged scenarios yet. A pending scenario is always an explicit skip.
  if (mode === "privileged" && report.checks.some((entry) => entry.ok || entry.skipped !== true))
    throw new Error("Unimplemented Windows scenarios cannot pass.")
  return report.checks
}

export type VerifiedWindowsArtifacts = {
  bin: string
  unit: string
  target: string
  caller: string
  channel: (typeof Hands.CHANNELS)[number]
  helperManifest: HelperManifest
  testManifest: HelperManifest
}
type ArtifactVerification = {
  helper?: typeof verifyPrebuiltHelper
  tests?: typeof verifyWindowsTestArtifacts
  source?: typeof sourceDigestFor
}

/** No executable runs here: source/icon channel inference and all PE/hash/manifest checks precede launch. */
export async function verifyWindowsNativeFiles(
  options: SelfTestOptions,
  directory: string,
  architecture: string = process.arch,
  verification: ArtifactVerification = {},
): Promise<VerifiedWindowsArtifacts> {
  if (options.platform !== "win32" || (architecture !== "x64" && architecture !== "arm64"))
    throw new Error("Unsupported Windows native architecture.")
  const identity = readIdentity(path.join(directory, "native/computer-helper/identity.json"))
  const binStatus = await lstat(options.bin)
  const bin = await realpath(options.bin)
  if (!binStatus.isFile() || binStatus.isSymbolicLink() || path.basename(bin) !== identity.windows.executable)
    throw new Error("The Windows helper has an invalid artifact location.")
  const supplied = await lstat(options.tests)
  if (supplied.isSymbolicLink() || (!supplied.isDirectory() && !supplied.isFile()))
    throw new Error("The Windows test artifacts have an invalid location.")
  const tests = await realpath(supplied.isDirectory() ? options.tests : path.dirname(options.tests))
  const unit = path.join(tests, WINDOWS_TEST_ARTIFACTS.unit)
  if (!supplied.isDirectory() && (await realpath(options.tests)) !== unit)
    throw new Error("Only the manifested Windows unit executable can be selected.")
  const manifestPath = path.join(path.dirname(bin), "computer-helper.json")
  const manifestStatus = await lstat(manifestPath)
  if (!manifestStatus.isFile() || manifestStatus.isSymbolicLink() || manifestStatus.size > 65_536)
    throw new Error("The Windows helper manifest is not a bounded regular file.")
  const rawManifest = parseHelperManifest(JSON.parse(await readFile(manifestPath, "utf8")))
  if (rawManifest.platform !== "win32") throw new Error("The Windows helper manifest has the wrong platform.")
  const generated = generateIdentitySources(
    path.join(directory, "native/build/computer-helper-selftest-win32/generated"),
    {
      identity: path.join(directory, "native/computer-helper/identity.json"),
      blocklist: path.join(directory, "native/computer-helper/blocklist.json"),
    },
  ).find((file) => file.endsWith("Identity.swift"))!
  const matches: VerifiedWindowsArtifacts["channel"][] = []
  for (const channel of Hands.CHANNELS) {
    // Each channel's actual icon bytes participate in sourceDigestFor. Friendly PE labels confer no identity.
    if (
      (await (verification.source ?? sourceDigestFor)(
        directory,
        "win32",
        channel,
        rawManifest.toolchain,
        generated,
      )) === rawManifest.sourceDigest
    )
      matches.push(channel)
  }
  if (matches.length !== 1) throw new Error("The Windows artifact channel is missing or ambiguous.")
  const channel = matches[0]!
  const testManifest = await (verification.tests ?? verifyWindowsTestArtifacts)(tests, architecture, {
    directory,
    channel,
    helperManifest: rawManifest,
  })
  // Default verification checks the shipping PE/hash/source before its final inert --version. At
  // that first launch the entire test artifact set has already passed its own manifest verification.
  const helperManifest = await (verification.helper ?? verifyPrebuiltHelper)(
    path.dirname(bin),
    "win32",
    [architecture],
    {
      directory,
      channel,
      hostArchitecture: architecture,
    },
  )
  return {
    bin,
    unit,
    target: path.join(tests, WINDOWS_TEST_ARTIFACTS.target),
    caller: path.join(tests, WINDOWS_TEST_ARTIFACTS.caller),
    channel,
    helperManifest,
    testManifest,
  }
}

type WindowsFixtureDependencies = {
  command: (command: Command) => Promise<CommandResult>
  channel?: (executable: string, args: string[]) => NativeChannel
  architecture?: HelperArchitecture
  verify?: (options: SelfTestOptions, directory: string, architecture?: string) => Promise<VerifiedWindowsArtifacts>
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** The copied Caller keeps the real immediate-parent relationship, including its validated medium-token bootstrap. */
export async function createWindowsVerifiedFixture(
  options: SelfTestOptions,
  directory: string,
  verified: VerifiedWindowsArtifacts | undefined,
  dependencies: WindowsFixtureDependencies,
): Promise<VerifiedFixture> {
  const files =
    verified ?? (await (dependencies.verify ?? verifyWindowsNativeFiles)(options, directory, dependencies.architecture))
  if (files.bin !== (await realpath(options.bin))) throw new Error("The verified helper selection changed.")
  const temporary = await mkdtemp(path.join(tmpdir(), "vector-computer-win32-"))
  const helper = path.join(temporary, "resources/computer", path.basename(files.bin))
  const caller = path.join(temporary, `${EXECUTABLE_NAMES[files.channel]}.exe`)
  const open = dependencies.channel ?? windowsNativeChannel
  let closed = false
  const requireOpen = () => {
    if (closed) throw new Error("The verified Windows fixture is closed.")
  }
  try {
    await mkdir(path.dirname(helper), { recursive: true })
    await copyFile(files.bin, helper)
    await copyFile(files.caller, caller)
    for (const [file, expected] of [
      [helper, files.helperManifest.files[path.basename(files.bin)]?.sha256],
      [caller, files.testManifest.files[WINDOWS_TEST_ARTIFACTS.caller]?.sha256],
    ] as const) {
      const info = await lstat(file)
      if (!expected || !info.isFile() || info.isSymbolicLink() || digest(await readFile(file)) !== expected)
        throw new Error("Copying changed a verified Windows executable.")
    }
    const lifecycle = async (mode: "eof" | "parentDeath") => {
      requireOpen()
      // The source-bound unit executable holds actual kernel process handles before starting the
      // one-second measurement. No process enumeration, shell startup or PID-only kill enters that interval.
      const result = await dependencies.command({
        executable: files.unit,
        args: [mode === "eof" ? "--self-test=lifecycle-eof" : "--self-test=lifecycle-parent-death"],
        timeoutMs: 30_000,
      })
      if (result.timedOut) throw new Error("The Windows lifecycle check timed out.")
      return windowsNativeSelfTestChecks(result.stdout, mode, result.code).every((entry) => entry.ok)
    }
    return {
      async open() {
        requireOpen()
        return open(caller, ["--stdio"])
      },
      async probe() {
        requireOpen()
        const result = await dependencies.command({
          executable: caller,
          args: ["--probe", "--json"],
          timeoutMs: 15_000,
        })
        if (result.code !== 0 || result.timedOut || Buffer.byteLength(result.stdout) > 32_768)
          throw new Error("The verified Windows probe failed.")
        return JSON.parse(result.stdout) as unknown
      },
      async unverifiedParent() {
        requireOpen()
        const child = open(helper, ["--stdio", "--parent-pid", String(process.pid)])
        try {
          const result = await child.next(5000)
          return result?.kind === "exit" && typeof result.code === "number" && result.code > 0
        } finally {
          await child.dispose()
        }
      },
      eof: () => lifecycle("eof"),
      parentDeath: () => lifecycle("parentDeath"),
      async privileged(target) {
        requireOpen()
        if (target !== files.target) throw new Error("The isolated Windows target changed.")
        // W2's exact native catalog reports the unimplemented W11 layer as a skip without OS actions.
        return dependencies.command({
          executable: files.bin,
          args: ["--self-test=privileged", "--target", target],
          timeoutMs: 30_000,
        })
      },
      async close() {
        if (closed) return
        closed = true
        await rm(temporary, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

/** Windows protocol bytes use stdin/stdout. ChildProcess.kill targets Node's owned process handle. */
export function windowsNativeChannel(executable: string, args: string[], launch: typeof spawn = spawn): NativeChannel {
  const child = launch(executable, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  const inbox: Received[] = []
  const listeners = new Set<() => void>()
  let buffered = 0
  let error: Error | undefined
  const wake = () => {
    for (const notify of listeners) notify()
  }
  const kill = () => {
    try {
      child.kill("SIGKILL")
    } catch {}
  }
  const fail = () => {
    if (error) return
    error = new Error("The Windows native protocol channel failed.")
    kill()
    wake()
  }
  const reader = frameReader({
    maxBytes: Computer.LIMITS.helperFrameBytes,
    onOversize: fail,
    onFrame(bytes) {
      buffered += bytes.byteLength
      if (buffered > 32 * 1024 * 1024 || inbox.length >= 1000) return fail()
      inbox.push({ kind: "frame", bytes })
      wake()
    },
  })
  const deadline = setTimeout(fail, 30_000)
  child.stdout.on("data", (bytes: Buffer) => reader.push(bytes))
  child.stdout.on("error", fail)
  child.stdin.on("error", fail)
  // Native diagnostics are drained but never retained or mixed into protocol bytes/reports.
  let diagnostics = 0
  child.stderr.on("data", (bytes: Buffer) => {
    diagnostics += bytes.byteLength
    if (diagnostics > 65_536) fail()
  })
  child.once("error", fail)
  child.once("close", (code) => {
    clearTimeout(deadline)
    inbox.push({ kind: "exit", code })
    wake()
  })
  return {
    write(bytes) {
      if (error) throw error
      if (child.stdin.writableLength + bytes.byteLength > 32 * 1024 * 1024)
        throw new Error("The Windows native send limit was exceeded.")
      child.stdin.write(bytes)
    },
    end() {
      child.stdin.end()
    },
    async next(timeoutMs) {
      if (error) throw error
      if (!inbox.length)
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            listeners.delete(done)
            resolve()
          }
          const timer = setTimeout(done, timeoutMs)
          listeners.add(done)
        })
      if (error) throw error
      const item = inbox.shift()
      if (item?.kind === "frame") buffered -= item.bytes.byteLength
      return item
    },
    async dispose() {
      clearTimeout(deadline)
      kill()
      child.stdin.destroy()
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        const done = () => {
          clearTimeout(timer)
          child.removeListener("close", done)
          resolve()
        }
        const timer = setTimeout(done, 2000)
        child.once("close", done)
      })
    },
  }
}
