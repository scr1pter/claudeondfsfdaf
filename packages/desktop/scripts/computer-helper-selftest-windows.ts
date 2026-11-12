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
import {
  WindowsCheckFailure,
  WindowsDiagnosticReader,
  windowsCommandReason,
  type WindowsDiagnostic,
} from "./computer-helper-windows-diagnostics"
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
  privileged: [
    "privileged-isolated-target",
    "apps-running-target",
    "apps-installed-target",
    "capture-color-patch",
    "capture-affinity-exclusion",
    "uia-counter-increment",
    "uia-value-set-and-readback",
    "secure-field-refusal",
    "tagged-click-increments",
    "unicode-type-readback",
    "stale-capture-refusal",
    "owned-input-release",
    "input-detection-probe",
    "hardware-user-input-pauses",
    "isolated-target-cleanup",
    "capture-isolated-window-worker",
  ],
  targetControl: ["windows-test-target-control-schema"],
  eof: ["caller-eof"],
  parentDeath: ["caller-parent-death"],
} as const
export const WINDOWS_NATIVE_REASONS = [
  "isolation_required",
  "elevated_helper",
  "noninteractive_desktop",
  "capture_blocked",
  "input_detection_unavailable",
  "foreground_unavailable",
  "affinity_unavailable",
  "target_not_installed",
  "hardware_input_required",
  "target_unavailable",
  "target_validation_failed",
  "target_spawn_failed",
  "target_state_invalid",
  "target_control_invalid",
  "target_token_invalid",
  "target_manifest_invalid",
  "target_window_failed",
  "target_report_failed",
  "target_control_failed",
  "target_exited",
  "target_not_ready",
  "assertion_failed",
  "native_operation_failed",
  "deadline_exceeded",
  "cleanup_failed",
  "dependency_failed",
  "physical_takeover",
] as const
export const WINDOWS_NATIVE_STAGES = [
  "installed-list-reply",
  "installed-list-native",
  "installed-seal",
  "window-capture-reply",
  "window-capture-receipt",
  "png-decode",
  "affinity-show",
  "affinity-hide",
  "display-capture-reply",
  "display-capture-receipt",
  "capture-service",
  "capture-native",
  "authority-completion",
  "authority-delivery",
  "capture-inventory-initial",
  "capture-inventory-refresh",
  "capture-native-read",
  "capture-commit-current",
  "capture-structural-identity",
  "capture-structural-bounds",
  "capture-structural-cloak",
  "capture-structural-class",
  "capture-structural-style",
  "capture-enumeration-cap",
  "capture-enumeration-deadline",
  "capture-enumeration-context",
  "capture-enumeration-api",
  "capture-structural-exception",
  "installed-apps-folder",
  "installed-apps-bind",
  "installed-apps-next",
  "installed-apps-com-current",
  "installed-apps-count",
  "installed-apps-shape",
  "installed-apps-title",
  "installed-apps-icon",
  "capture-bounds-read",
  "capture-bounds-empty",
  "capture-bounds-negative",
  "capture-bounds-range",
  "capture-empty-cloaked",
  "capture-empty-visible",
  "capture-empty-minimized",
  "capture-empty-hidden",
  "capture-empty-unknown",
  "installed-folder-start-uninitialized",
  "installed-folder-start-cancellation",
  "installed-folder-start-timer",
  "installed-folder-start-expired",
  "installed-folder-after-uninitialized",
  "installed-folder-after-cancellation",
  "installed-folder-after-timer",
  "installed-folder-after-expired",
  "installed-bind-after-uninitialized",
  "installed-bind-after-cancellation",
  "installed-bind-after-timer",
  "installed-bind-after-expired",
  "installed-next-start-uninitialized",
  "installed-next-start-cancellation",
  "installed-next-start-timer",
  "installed-next-start-expired",
  "installed-next-after-uninitialized",
  "installed-next-after-cancellation",
  "installed-next-after-timer",
  "installed-next-after-expired",
  "capture-empty-frame-unknown",
  "capture-empty-frame-geometry",
  "capture-read-surface-before",
  "capture-read-context-before",
  "capture-screen-bounds",
  "capture-screen-dc",
  "capture-screen-memory-dc",
  "capture-screen-dib",
  "capture-screen-select",
  "capture-screen-blit",
  "capture-screen-flush",
  "capture-screen-copy",
  "capture-window-supported",
  "capture-window-frame",
  "capture-window-device",
  "capture-window-interop",
  "capture-window-factory-ticket",
  "capture-window-factory",
  "capture-window-factory-current",
  "capture-window-factory-context",
  "capture-window-factory-retired",
  "capture-window-item-ticket",
  "capture-window-item-create",
  "capture-window-item-expired-cancelled",
  "capture-window-item-full-cancelled-setup-lt25-rpc-lt25",
  "capture-window-item-full-cancelled-setup-lt25-rpc-from25to49",
  "capture-window-item-full-cancelled-setup-lt25-rpc-ge50",
  "capture-window-item-full-cancelled-setup-ge25-rpc-lt25",
  "capture-window-item-full-cancelled-setup-ge25-rpc-from25to49",
  "capture-window-item-full-cancelled-setup-ge25-rpc-ge50",
  "capture-window-item-expired-denied",
  "capture-window-item-expired-other",
  "capture-window-item-current-cancelled",
  "capture-window-item-current-denied",
  "capture-window-item-current-other",
  "capture-window-item-current",
  "capture-window-item-acquisition-expired",
  "capture-window-item-full-ticket-expired",
  "capture-window-item-full-expired-setup-lt25-rpc-lt25",
  "capture-window-item-full-expired-setup-lt25-rpc-from25to49",
  "capture-window-item-full-expired-setup-lt25-rpc-ge50",
  "capture-window-item-full-expired-setup-ge25-rpc-lt25",
  "capture-window-item-full-expired-setup-ge25-rpc-from25to49",
  "capture-window-item-full-expired-setup-ge25-rpc-ge50",
  "capture-window-item-truncated-ticket-expired",
  "capture-window-item-context",
  "capture-window-item-retired",
  "capture-window-item-size",
  "capture-window-pool",
  "capture-window-session",
  "capture-window-start-ticket",
  "capture-window-start",
  "capture-window-start-current",
  "capture-window-first-frame",
  "capture-window-content-size",
  "capture-window-texture",
  "capture-window-description",
  "capture-window-staging",
  "capture-window-copy",
  "capture-window-map",
  "capture-window-crop",
  "capture-window-current",
  "capture-read-surface-after",
  "capture-read-context-after",
  "capture-window-worker-prepare",
  "capture-window-worker-start",
  "capture-window-worker-wait",
  "capture-window-worker-exit",
  "capture-window-worker-reply",
  "capture-window-worker-cleanup",
  "capture-window-worker-deadline",
  "capture-window-worker-auth",
  "capture-window-worker-target",
  "capture-window-worker-read",
  "capture-color-location-screen",
  "capture-color-location-window",
  "capture-color-location-unknown",
  "capture-color-masked-screen",
  "capture-color-masked-window",
  "capture-color-masked-unknown",
  "capture-color-unmasked-screen",
  "capture-color-unmasked-window",
  "capture-color-unmasked-unknown",
  "capture-color-mask-unknown-screen",
  "capture-color-mask-unknown-window",
  "capture-color-mask-unknown-unknown",
  "affinity-sample-plan",
  "affinity-fixture-current",
  "affinity-native-sample-missing",
  "affinity-native-sample-mismatch",
  "affinity-display-proof",
] as const
export const WINDOWS_NATIVE_CODES = [...Computer.ComputerErrorCode.literals, "unknown"] as const
export type WindowsNativeStage = (typeof WINDOWS_NATIVE_STAGES)[number]
export type WindowsNativeCode = (typeof WINDOWS_NATIVE_CODES)[number]
const windowsReasons = new Set<string>(WINDOWS_NATIVE_REASONS)
const windowsSkipReasons = new Set<string>([
  "isolation_required",
  "elevated_helper",
  "noninteractive_desktop",
  "capture_blocked",
  "input_detection_unavailable",
  "foreground_unavailable",
  "affinity_unavailable",
  "target_not_installed",
  "hardware_input_required",
  "physical_takeover",
])
const WindowsNativeReport = Schema.Struct({
  checks: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      ok: Schema.Boolean,
      skipped: Schema.optional(Schema.Boolean),
      detail: Schema.optional(Schema.String),
      stage: Schema.optional(Schema.Literals(WINDOWS_NATIVE_STAGES)),
      nativeCode: Schema.optional(Schema.Literals(WINDOWS_NATIVE_CODES)),
    }),
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
    report.checks.some(
      (entry, index) =>
        entry.name !== expected[index] ||
        (entry.ok && entry.skipped === true) ||
        (entry.skipped === true && (!entry.detail || !windowsSkipReasons.has(entry.detail))) ||
        (entry.detail !== undefined && (mode !== "privileged" || !windowsReasons.has(entry.detail))) ||
        ((entry.stage !== undefined || entry.nativeCode !== undefined) &&
          (entry.stage === undefined ||
            entry.nativeCode === undefined ||
            mode !== "privileged" ||
            entry.ok ||
            entry.skipped === true ||
            !entry.detail)),
    )
  )
    throw new Error("Invalid Windows native catalog.")
  const failed = report.checks.some((entry) => !entry.ok && entry.skipped !== true)
  const skipped = report.checks.some((entry) => entry.skipped === true)
  if (code !== (failed ? 1 : skipped ? 77 : 0) || (mode !== "privileged" && skipped))
    throw new Error("Inconsistent Windows native exit.")
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
  channel?: (executable: string, args: string[]) => NativeChannel & { startupDiagnostic?: () => WindowsDiagnostic }
  temporary?: () => Promise<string>
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
  const created = await (dependencies.temporary ?? (() => mkdtemp(path.join(tmpdir(), "vector-computer-win32-"))))()
  const open = dependencies.channel ?? windowsNativeChannel
  let closed = false
  const requireOpen = () => {
    if (closed) throw new Error("The verified Windows fixture is closed.")
  }
  try {
    const status = await lstat(created)
    if (!status.isDirectory() || status.isSymbolicLink())
      throw new Error("The Windows fixture directory is not owned regular storage.")
    // TEMP may use a short-name or ancestor junction spelling. Launch from the actual owned
    // directory, matching native FixtureFiles; Caller still checks and holds every real ancestor.
    const temporary = await realpath(created)
    const helper = path.join(temporary, "resources/computer", path.basename(files.bin))
    const target = path.join(path.dirname(helper), "tests", WINDOWS_TEST_ARTIFACTS.target)
    const caller = path.join(temporary, `${EXECUTABLE_NAMES[files.channel]}.exe`)
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(files.bin, helper)
    await copyFile(files.caller, caller)
    await copyFile(files.target, target)
    for (const [file, expected] of [
      [helper, files.helperManifest.files[path.basename(files.bin)]?.sha256],
      [caller, files.testManifest.files[WINDOWS_TEST_ARTIFACTS.caller]?.sha256],
      [target, files.testManifest.files[WINDOWS_TEST_ARTIFACTS.target]?.sha256],
    ] as const) {
      const info = await lstat(file)
      if (!expected || !info.isFile() || info.isSymbolicLink() || digest(await readFile(file)) !== expected)
        throw new Error("Copying changed a verified Windows executable.")
    }
    for (const [source, destination, expected] of [
      [
        path.join(path.dirname(files.bin), "computer-helper.json"),
        path.join(path.dirname(helper), "computer-helper.json"),
        files.helperManifest,
      ],
      [
        path.join(path.dirname(files.target), "computer-helper-tests.json"),
        path.join(path.dirname(target), "computer-helper-tests.json"),
        files.testManifest,
      ],
    ] as const) {
      const original = await lstat(source)
      if (!original.isFile() || original.isSymbolicLink() || original.size > 65_536)
        throw new Error("The verified Windows manifest changed.")
      await copyFile(source, destination)
      const copied = await lstat(destination)
      if (
        !copied.isFile() ||
        copied.isSymbolicLink() ||
        copied.size > 65_536 ||
        JSON.stringify(parseHelperManifest(JSON.parse(await readFile(destination, "utf8")))) !==
          JSON.stringify(expected)
      )
        throw new Error("Copying changed a verified Windows manifest.")
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
        const channel = open(caller, ["--stdio"])
        let received = false
        return {
          ...channel,
          async next(timeoutMs: number) {
            const result = await channel.next(timeoutMs).catch((error) => {
              const observed = channel.startupDiagnostic?.()
              if (!received && (observed?.caller || observed?.helper))
                throw new WindowsCheckFailure(
                  windowsCommandReason({ code: null, diagnostic: { windows: observed } }, "channel"),
                )
              throw error
            })
            if (!received && result?.kind === "exit")
              throw new WindowsCheckFailure(
                windowsCommandReason(
                  { code: result.code, diagnostic: { windows: channel.startupDiagnostic?.() } },
                  "channel",
                ),
              )
            if (!received && !result) throw new WindowsCheckFailure("windows-channel-no-frame")
            if (result?.kind === "frame") received = true
            return result
          },
        }
      },
      async probe() {
        requireOpen()
        const result = await dependencies.command({
          executable: caller,
          args: ["--probe", "--json"],
          timeoutMs: 15_000,
          windowsDiagnostic: "caller",
        })
        if (result.code !== 0 || result.timedOut) throw new WindowsCheckFailure(windowsCommandReason(result, "probe"))
        if (Buffer.byteLength(result.stdout) > 32_768) throw new WindowsCheckFailure("windows-probe-output-limit")
        let probe: unknown
        try {
          probe = JSON.parse(result.stdout)
        } catch {
          throw new WindowsCheckFailure("windows-probe-invalid-json")
        }
        if (!probe || typeof probe !== "object" || Array.isArray(probe))
          throw new WindowsCheckFailure("windows-probe-invalid-json")
        const value = probe as Record<string, unknown>
        const permissions = value.permissions
        if (
          !permissions ||
          typeof permissions !== "object" ||
          Array.isArray(permissions) ||
          (permissions as Record<string, unknown>).screen !== "n/a" ||
          (permissions as Record<string, unknown>).accessibility !== "n/a"
        )
          throw new WindowsCheckFailure("windows-probe-invalid-permissions")
        if (value.responsible !== true) throw new WindowsCheckFailure("windows-probe-invalid-responsible")
        if (value.elevated !== false) throw new WindowsCheckFailure("windows-probe-invalid-elevated")
        if (typeof value.captureBlocked !== "boolean")
          throw new WindowsCheckFailure("windows-probe-invalid-capture-blocked")
        return probe
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
      async privileged(selected) {
        requireOpen()
        if (selected !== files.target) throw new Error("The isolated Windows target changed.")
        // The finite Caller derives only its fixed source-bound sibling target and observes its
        // actual medium token, including the high -> medium bootstrap on hosted Windows runners.
        return dependencies.command({
          executable: caller,
          args: ["--self-test=privileged"],
          timeoutMs: 150_000,
        })
      },
      async close() {
        if (closed) return
        closed = true
        // Windows may still be releasing an owned child's executable after termination.
        // Retry only transient filesystem removal; capture/input are never replayed.
        await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      },
    }
  } catch (error) {
    await rm(created, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    throw error
  }
}

/** Windows protocol bytes use stdin/stdout. ChildProcess.kill targets Node's owned process handle. */
export function windowsNativeChannel(
  executable: string,
  args: string[],
  launch: typeof spawn = spawn,
): NativeChannel & { startupDiagnostic: () => WindowsDiagnostic } {
  const child = launch(executable, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  const inbox: Received[] = []
  const startup = new WindowsDiagnosticReader("caller")
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
    startup.consume(bytes, "stderr")
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
    startupDiagnostic: () => startup.finish(),
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
