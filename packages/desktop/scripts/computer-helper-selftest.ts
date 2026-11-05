import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Duplex } from "node:stream"
import { clearTimeout, setTimeout } from "node:timers"
import timers from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import {
  frameReader,
  readTranscript,
  replay,
  type Channel,
  type Line,
  type Received,
} from "../test/computer/transcript"
import { APP_IDS } from "./channel-ids"
import {
  runObservedNativeCommand,
  writeNativeUnitDiagnostic,
  type NativeCommandDiagnostic,
} from "./computer-helper-command-diagnostics"
import { readIdentity } from "./computer-helper-identity"
import { MAC_TEST_TARGET, verifyMacTestArtifacts, verifyPrebuiltHelper } from "./build-computer-helper"
import {
  WINDOWS_NATIVE_CHECKS,
  createWindowsVerifiedFixture,
  verifyWindowsNativeFiles,
  windowsNativeSelfTestChecks,
  type VerifiedWindowsArtifacts,
} from "./computer-helper-selftest-windows"

const packageDir = fileURLToPath(new URL("../", import.meta.url))
const privilegedTimeoutMs = 150_000
const nativeSmokeChecks = [
  "strict-cli",
  "partial-frame-round-trip",
  "malformed-envelope-and-eof",
  "oversized-frame-refusal",
] as const
export const MAC_NATIVE_CHECKS = {
  unprivileged: nativeSmokeChecks,
  packaged: [...nativeSmokeChecks, "packaged-bundle-and-signature"],
  targetControl: ["test-target-control-schema"],
  privileged: [
    "privileged-isolated-target",
    "capture-color-patch",
    "capture-overlay-exclusion",
    "ax-counter-increment",
    "ax-value-set-and-readback",
    "secure-field-refusal",
    "tagged-click-increments",
    "stale-capture-refusal",
    "background-ax-without-pointer-or-focus",
    "background-selection-insertion",
    "helper-tagged-escape-ignored",
    "foreign-escape-stops",
    "owned-input-release",
    "isolated-target-cleanup",
  ],
} as const
const nativeChecks = new Set<string>([
  ...Object.values(MAC_NATIVE_CHECKS).flat(),
  ...Object.values(WINDOWS_NATIVE_CHECKS).flat(),
])
const NativeSelfTestReport = Schema.Struct({
  checks: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      ok: Schema.Boolean,
      skipped: Schema.optional(Schema.Boolean),
      detail: Schema.optional(
        Schema.Literals([
          "responsibility_missing",
          "accessibility_denied",
          "screen_denied",
          "post_event_denied",
          "target_post_event_denied",
          "noninteractive_desktop",
          "input_detection_unavailable",
          "physical_takeover",
          "target_unavailable",
          "target_validation_failed",
          "target_spawn_failed",
          "target_handshake_failed",
          "target_process_changed",
          "target_responsibility_missing",
          "target_state_invalid",
          "target_identity_unavailable",
          "target_options_invalid",
          "target_bundle_invalid",
          "target_control_invalid",
          "target_application_failed",
          "target_report_invalid",
          "target_encoding_failed",
          "target_output_failed",
          "target_exited",
          "target_crashed",
          "target_snapshot_invalid",
          "target_not_ready",
          "target_window_geometry_invalid",
          "target_view_geometry_invalid",
          "assertion_failed",
          "native_operation_failed",
          "deadline_exceeded",
          "cleanup_failed",
        ]),
      ),
    }),
  ),
})

/** Fixed catalogs and reason tokens prevent a child from turning omitted checks or private output into evidence. */
export function nativeSelfTestChecks(stdout: string, mode: keyof typeof MAC_NATIVE_CHECKS, code: number | null) {
  if (Buffer.byteLength(stdout) > 32_768) throw new Error("Invalid native self-test report.")
  const value = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(stdout)
  const report = Schema.decodeUnknownSync(NativeSelfTestReport, { onExcessProperty: "error" })(value)
  const expected = MAC_NATIVE_CHECKS[mode]
  if (
    report.checks.length !== expected.length ||
    report.checks.some((entry, index) => entry.name !== expected[index] || (entry.skipped === true && entry.ok))
  )
    throw new Error("Invalid native self-test catalog.")
  const failed = report.checks.some((entry) => !entry.ok && entry.skipped !== true)
  const skipped = report.checks.some((entry) => entry.skipped === true)
  if (code !== (failed ? 1 : skipped ? 77 : 0)) throw new Error("Inconsistent native self-test exit.")
  return report.checks
}
export const CORE_TRANSCRIPTS = [
  "cancel-idle",
  "eof",
  "frame-too-large",
  "heartbeat-loss",
  "hello",
  "malformed-json",
  "permissions",
  "session",
  "shutdown",
  "unsupported-action",
] as const
export type PrivilegedMode = "auto" | "require" | "off"
type Status = "passed" | "failed" | "skipped"
type Check = { name: string; status: Status; reason?: string }
type NativeFailureReason =
  | "supervisor-missing"
  | "supervisor-extra"
  | "worker-missing"
  | "worker-extra"
  | "caller-exit-deadline"
  | "caller-exit-status"
  | `caller-exit-status-${number}`
  | "unexpected-lifecycle-frame"
  | `unexpected-lifecycle-event-${"user_input" | "stop" | "input_detection" | "exit"}`
  | "lifecycle-event-limit"
  | "descendant-exit-deadline"
  | "channel-deadline"
  | "channel-io"
  | "channel-unexpected-stdout"
  | "channel-start-failed"
  | "channel-oversized-output"
  | "channel-receive-limit"
  | "channel-send-limit"
  | "process-inspection-failed"
class NativeCheckFailure extends Error {
  constructor(readonly reason: NativeFailureReason) {
    super(reason)
  }
}

/** Report only a missing or extra process, never PIDs, paths or an unbounded count. */
export function lifecycleTopologyFailure(role: "supervisor" | "worker", count: number) {
  if (count === 1) return
  return `${role}-${count === 0 ? "missing" : "extra"}` as const
}

/** Hello-only fixtures have no task scope. Only global environment notifications may precede process exit. */
export async function waitForLifecycleExit(
  channel: Pick<Channel, "next">,
  deadline: number,
  now: () => number = () => performance.now(),
) {
  let events = 0
  while (true) {
    const started = now()
    const remaining = deadline - started
    if (!Number.isFinite(remaining) || remaining <= 0) throw new NativeCheckFailure("caller-exit-deadline")
    const result = await channel.next(remaining)
    const receivedAt = now()
    if (!result || !Number.isFinite(receivedAt) || receivedAt < started || receivedAt >= deadline) {
      throw new NativeCheckFailure("caller-exit-deadline")
    }
    if (result.kind === "exit") return result
    if (result.bytes.byteLength > 1024) throw new NativeCheckFailure("unexpected-lifecycle-frame")
    const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(Buffer.from(result.bytes).toString("utf8"))
    if (
      parsed._tag === "None" ||
      typeof parsed.value !== "object" ||
      parsed.value === null ||
      Array.isArray(parsed.value)
    ) {
      throw new NativeCheckFailure("unexpected-lifecycle-frame")
    }
    const decoded = Schema.decodeUnknownOption(Computer.HelperEvent)(parsed.value)
    if (decoded._tag === "None") throw new NativeCheckFailure("unexpected-lifecycle-frame")
    const event = decoded.value
    if (event.event !== "locked" && event.event !== "display_change") {
      throw new NativeCheckFailure(`unexpected-lifecycle-event-${event.event}`)
    }
    const keys = Object.keys(parsed.value).sort().join(",")
    if (keys !== (event.event === "locked" ? "event,locked" : "event")) {
      throw new NativeCheckFailure("unexpected-lifecycle-frame")
    }
    if (++events > 16) throw new NativeCheckFailure("lifecycle-event-limit")
  }
}

function boundedExitCode(code: number | null) {
  return code !== null && Number.isInteger(code) && code >= 0 && code <= 255 ? code : undefined
}

/** Keep only a classified fixture/line and a fixed category; replay errors may contain private response values. */
export function transcriptFailureReason(name: string, error: unknown) {
  if (error instanceof NativeCheckFailure) return error.reason
  if (!(error instanceof Error) || !CORE_TRANSCRIPTS.some((item) => item === name)) return "transcript-failed"
  if (error.message === "The conformance fixture contains a non-isolated operation.") return "fixture-policy"
  if (/:\d+: not a \{send, expect\} line$/.test(error.message)) return "fixture-format"
  const match = /^conformance\.([a-z-]+):(\d+): (.*)$/s.exec(error.message)
  if (!match || match[1] !== name) return "transcript-failed"
  const line = Number(match[2])
  if (!Number.isSafeInteger(line) || line < 1 || line > 1000) return "transcript-failed"
  const text = match[3]!
  const exit = /, got exit (-?\d+|null)$/.exec(text)
  const code = exit ? boundedExitCode(exit[1] === "null" ? null : Number(exit[1])) : undefined
  const category = text.includes("received a frame that does not decode")
    ? "decode"
    : text.includes(", got nothing")
      ? "timeout"
      : exit
        ? `unexpected-exit${code === undefined ? "" : `-${code}`}`
        : text.startsWith("expected ")
          ? "mismatch"
          : "failed"
  return `line-${line}-${category}`
}
export type SelfTestOptions = {
  platform: "darwin" | "win32"
  bin: string
  tests: string
  fixtures: string
  privileged: PrivilegedMode
  report?: string
}
export type Command = { executable: string; args: string[]; timeoutMs?: number }
export type CommandResult = {
  code: number | null
  stdout: string
  timedOut?: boolean
  diagnostic?: NativeCommandDiagnostic
}
export type NativeChannel = Channel & { dispose(): Promise<void> }
export type VerifiedFixture = {
  open(): Promise<NativeChannel>
  probe(): Promise<unknown>
  unverifiedParent(): Promise<boolean>
  eof(): Promise<boolean>
  parentDeath(): Promise<boolean>
  privileged(target: string): Promise<CommandResult>
  close(): Promise<void>
}
export type NativeTestFiles = { unit: string; target?: string; windows?: VerifiedWindowsArtifacts }
export type SelfTestDependencies = {
  platform?: NodeJS.Platform
  command?: (command: Command) => Promise<CommandResult>
  fixture?: (options: SelfTestOptions, files?: NativeTestFiles) => Promise<VerifiedFixture>
  catalog?: (directory: string) => Promise<readonly string[]>
  transcript?: (file: string) => Promise<Line[]>
  files?: (options: SelfTestOptions) => Promise<NativeTestFiles>
  wait?: (ms: number) => Promise<void>
}

export function parseSelfTestArgs(
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
): SelfTestOptions {
  const parsed = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      platform: { type: "string" },
      bin: { type: "string" },
      tests: { type: "string" },
      fixtures: { type: "string" },
      privileged: { type: "string" },
      report: { type: "string" },
    },
  })
  if (
    Object.values(parsed.values).some(
      (value) => typeof value !== "string" || !value || value.length > 16384 || value.includes("\0"),
    )
  )
    throw new Error("Self-test arguments must be non-empty paths or options.")
  const target = parsed.values.platform ?? platform
  if (target !== "darwin" && target !== "win32") throw new Error("Choose darwin or win32 on a matching native host.")
  const privileged = parsed.values.privileged ?? "off"
  if (privileged !== "auto" && privileged !== "require" && privileged !== "off")
    throw new Error("Choose auto, require or off for privileged checks.")
  const base = path.join(
    packageDir,
    "native/out",
    target,
    ...(target === "win32" ? [arch === "arm64" ? "arm64" : "x64"] : []),
  )
  const identity = readIdentity()
  const bin =
    target === "darwin"
      ? path.join(base, identity.mac.bundle, "Contents/MacOS", identity.mac.executable)
      : path.join(base, identity.windows.executable)
  return {
    platform: target,
    bin: path.resolve(parsed.values.bin ?? bin),
    tests: path.resolve(parsed.values.tests ?? path.join(base, "tests")),
    fixtures: path.resolve(parsed.values.fixtures ?? path.join(packageDir, "test/fixtures/computer-protocol")),
    privileged,
    ...(parsed.values.report ? { report: path.resolve(parsed.values.report) } : {}),
  }
}

export function classifySelfTestExit(code: number | null, privileged: PrivilegedMode): Status {
  if (code === 0) return "passed"
  if (code === 77 && privileged !== "require") return "skipped"
  return "failed"
}

/** Even an override fixture directory may not turn grant-free conformance into OS prompts or real input. */
export function validateCoreTranscript(name: string, lines: readonly Line[]) {
  const allowed = new Set([
    "hello",
    "permissions.status",
    "session.begin",
    "session.update",
    "session.end",
    "heartbeat",
    "cancel",
    "shutdown",
    "conformance.unknown",
  ])
  function safe(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return true
    const body = value as Record<string, unknown>
    if (typeof body.$raw === "string") {
      try {
        const parsed: unknown = JSON.parse(body.$raw)
        // Different JSON parsers may choose different duplicate keys or accept extra syntax. Only forward
        // a valid raw body when the exact bytes are the canonical representation that was checked here.
        return JSON.stringify(parsed) === body.$raw && safe(parsed)
      } catch {
        return name === "malformed-json" && body.$raw === "{not json"
      }
    }
    if ("$oversize" in body) return body.$oversize === Computer.LIMITS.helperFrameBytes + 1
    if ("$wait" in body) return typeof body.$wait === "number" && body.$wait >= 0 && body.$wait <= 7000
    if ("$eof" in body) return body.$eof === true
    if (body.op === "input.key")
      return (
        name === "heartbeat-loss" && body.pid === 99999 && body.repeat === 1 && JSON.stringify(body.combo) === '["a"]'
      )
    if (typeof body.op !== "string" || !allowed.has(body.op)) return false
    if (body.op === "session.begin" || body.op === "session.update") {
      if (body.approved !== undefined && (!Array.isArray(body.approved) || body.approved.length !== 0)) return false
    }
    return true
  }
  if (!lines.every((line) => safe(line.send)))
    throw new Error("The conformance fixture contains a non-isolated operation.")
}

export async function runComputerHelperSelfTest(options: SelfTestOptions, dependencies: SelfTestDependencies = {}) {
  if ((dependencies.platform ?? process.platform) !== options.platform)
    throw new Error("Run native self-tests on the matching platform.")
  const command = dependencies.command ?? runNativeCommand
  const wait =
    dependencies.wait ??
    (async (ms: number) => {
      await timers.setTimeout(ms)
    })
  const checks: Check[] = [
    "catalog",
    "unit",
    "unprivileged",
    "packaged",
    "target-control",
    "probe.first",
    "probe.fresh",
    "responsible",
    "unverified-parent",
    "channel-eof",
    "parent-death",
    ...CORE_TRANSCRIPTS.map((name) => `conformance.${name}`),
    "privileged",
  ].map((name) => ({ name, status: "skipped", reason: "not-run" }))
  const set = (name: string, status: Status, reason?: string) => {
    const check = checks.find((item) => item.name === name)!
    check.status = status
    if (reason) check.reason = reason
    else delete check.reason
  }
  const report = () => ({
    schemaVersion: 1 as const,
    platform: options.platform,
    privileged: options.privileged,
    checks,
    code: checks.some((check) => check.status === "failed") ? 1 : 0,
  })
  try {
    const catalog = await (dependencies.catalog ?? (async (directory) => readdir(directory, { recursive: true })))(
      options.fixtures,
    )
    const actual = catalog.filter((name) => name.toLowerCase().endsWith(".jsonl")).toSorted()
    const expected = CORE_TRANSCRIPTS.map((name) => `${name}.jsonl`).toSorted()
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index]))
      throw new Error("The fixture catalog has unclassified or missing transcripts.")
    set("catalog", "passed")
  } catch {
    set("catalog", "failed", "unclassified-fixture-catalog")
    for (const check of checks) if (check.reason === "not-run") check.reason = "catalog-unavailable"
    return report()
  }
  async function child(
    name: string,
    executable: string,
    args: string[],
    mode: PrivilegedMode = name === "privileged" ? options.privileged : "require",
    run?: () => Promise<CommandResult>,
  ) {
    try {
      const result = await (run
        ? run()
        : command({ executable, args, timeoutMs: name === "privileged" ? privilegedTimeoutMs : 30_000 }))
      let diagnosticWriteFailed = false
      if (name === "unit" && options.platform === "darwin" && options.report && result.diagnostic) {
        try {
          await writeNativeUnitDiagnostic(options.report, result.diagnostic)
        } catch {
          diagnosticWriteFailed = true
        }
      }
      const status =
        result.timedOut || (result.diagnostic && result.diagnostic.trigger !== "complete")
          ? "failed"
          : classifySelfTestExit(result.code, mode)
      set(
        name,
        status,
        result.diagnostic && result.diagnostic.trigger !== "complete"
          ? result.diagnostic.trigger
          : result.timedOut
            ? "deadline"
            : status === "skipped"
              ? "native-skip"
              : status === "failed"
                ? "native-check-failed"
                : undefined,
      )
      // Diagnostic failure cannot hide an existing native failure or turn a failed unit into a pass.
      if (diagnosticWriteFailed && status !== "failed") set(name, "failed", "diagnostic-write-failed")
      if (name !== "privileged" && result.code === 77) {
        set(name, "failed", "unexpected-core-skip")
        return
      }
      if (name === "unit") return
      if (result.timedOut || (result.code !== 0 && result.code !== 1 && result.code !== 77)) return
      const report: unknown =
        options.platform === "darwin"
          ? {
              checks: nativeSelfTestChecks(
                result.stdout,
                name === "privileged"
                  ? "privileged"
                  : name === "packaged"
                    ? "packaged"
                    : name === "target-control"
                      ? "targetControl"
                      : "unprivileged",
                result.code,
              ),
            }
          : {
              checks: windowsNativeSelfTestChecks(
                result.stdout,
                name === "privileged"
                  ? "privileged"
                  : name === "packaged"
                    ? "packaged"
                    : name === "target-control"
                      ? "targetControl"
                      : "unprivileged",
                result.code,
              ),
            }
      if (
        !report ||
        typeof report !== "object" ||
        !("checks" in report) ||
        !Array.isArray(report.checks) ||
        report.checks.length === 0 ||
        report.checks.length > 1000
      )
        throw new Error("Invalid native self-test report.")
      for (const [index, entry] of report.checks.entries()) {
        if (
          !entry ||
          typeof entry !== "object" ||
          typeof entry.name !== "string" ||
          !/^[a-z0-9.-]{1,128}$/.test(entry.name) ||
          typeof entry.ok !== "boolean"
        )
          throw new Error("Invalid native self-test check.")
        const skipped = entry.skipped === true
        const state = skipped ? (mode === "require" ? "failed" : "skipped") : entry.ok ? "passed" : "failed"
        const reason =
          typeof entry.detail === "string"
            ? entry.detail
            : skipped
              ? "native-skip"
              : state === "failed"
                ? "native-check-failed"
                : undefined
        checks.push({
          name: `${name}.${nativeChecks.has(entry.name) ? entry.name : `check-${index + 1}`}`,
          status: state,
          ...(reason ? { reason } : {}),
        })
        if (state === "failed") set(name, "failed", "native-check-failed")
      }
    } catch {
      set(name, "failed", "invalid-native-result")
    }
  }
  let files: NativeTestFiles | undefined
  try {
    files = await (dependencies.files ?? nativeTestFiles)(options)
  } catch {
    set("unit", "failed", "unverified-native-artifacts")
    for (const check of checks) {
      if (check.reason !== "not-run") continue
      check.status = "failed"
      check.reason = "unverified-native-artifacts"
    }
    if (options.privileged === "off") set("privileged", "skipped", "disabled")
    return report()
  }
  if (files)
    await child(
      "unit",
      files.unit,
      [],
      "require",
      dependencies.command
        ? undefined
        : () =>
            runObservedNativeCommand(
              { executable: files!.unit, args: [], timeoutMs: 30_000 },
              {
                // Only this exact verified unit executable is eligible; never a helper operation or model PID.
                sampleUnit: options.platform === "darwin" && options.report !== undefined,
              },
            ),
    )
  await child("unprivileged", options.bin, ["--self-test=unprivileged"])
  await child("packaged", options.bin, ["--self-test=packaged"])
  if (files?.target)
    await child(
      "target-control",
      options.platform === "darwin"
        ? path.join(files.target, "Contents/MacOS", MAC_TEST_TARGET.executable)
        : files.target,
      ["--self-test=control"],
    )
  else set("target-control", "skipped", "isolated-target-unavailable")
  let fixture: VerifiedFixture | undefined
  try {
    fixture = await (dependencies.fixture ?? createVerifiedFixture)(options, files)
    for (const name of ["probe.first", "probe.fresh"]) {
      try {
        // Each call starts a separate verified native caller and one-shot helper. Never reuse a prior process's
        // permission cache, and never include observed grant values or raw probe output in the report.
        const probeSchema: Schema.Decoder<unknown> =
          options.platform === "win32"
            ? Schema.Struct({
                permissions: Schema.Struct({ screen: Schema.Literal("n/a"), accessibility: Schema.Literal("n/a") }),
                responsible: Schema.Literal(true),
                elevated: Schema.Literal(false),
                captureBlocked: Schema.Boolean,
              })
            : Schema.Struct({
                permissions: Computer.PermissionsStatus,
                responsible: Schema.Literal(true),
                elevated: Schema.Literal(false),
              })
        Schema.decodeUnknownSync(probeSchema)(await fixture.probe())
        set(name, "passed")
      } catch {
        set(name, "failed", "native-probe-failed")
      }
    }
    const channel = await fixture.open()
    let hello: Computer.HelperHello
    try {
      const result = await replay(
        channel,
        [
          {
            send: { id: 1, op: "hello", protocol: { min: Computer.PROTOCOL, max: Computer.PROTOCOL } },
            expect: { id: 1, ok: true, responsible: true },
          },
        ],
        { wait },
      )
      hello = Schema.decodeUnknownSync(Computer.HelperHello)(result.messages[0])
      if (hello.helper.platform !== (options.platform === "darwin" ? "macos" : "windows"))
        throw new Error("The verified helper returned the wrong platform.")
      set("responsible", "passed")
    } finally {
      await channel.dispose()
    }
    for (const name of CORE_TRANSCRIPTS) {
      if (name === "heartbeat-loss" && hello.features["input.keyboard"] !== true) {
        set(`conformance.${name}`, "skipped", "requires-input.keyboard")
        continue
      }
      const channel = await fixture.open()
      try {
        const file = path.join(options.fixtures, `${name}.jsonl`)
        const lines = await (dependencies.transcript ?? (async (file) => readTranscript(file)))(file)
        validateCoreTranscript(name, lines)
        await replay(channel, lines, { wait, name: `conformance.${name}` })
        set(`conformance.${name}`, "passed")
      } catch (error) {
        set(`conformance.${name}`, "failed", transcriptFailureReason(name, error))
      } finally {
        await channel.dispose()
      }
    }
    for (const [name, run] of [
      ["unverified-parent", () => fixture!.unverifiedParent()],
      ["channel-eof", () => fixture!.eof()],
      ["parent-death", () => fixture!.parentDeath()],
    ] as const) {
      try {
        set(name, (await run()) ? "passed" : "failed", undefined)
      } catch (error) {
        set(name, "failed", error instanceof NativeCheckFailure ? error.reason : "lifecycle-check-failed")
      }
    }
  } catch {
    if (checks.find((item) => item.name === "responsible")?.status !== "passed")
      set("responsible", "failed", "verified-caller-unavailable")
    for (const check of checks)
      if (check.reason === "not-run" && check.name !== "privileged") {
        check.status = "failed"
        check.reason = "verified-caller-unavailable"
      }
  } finally {
    if (options.privileged === "off") set("privileged", "skipped", "disabled")
    else if (!files?.target)
      set("privileged", options.privileged === "require" ? "failed" : "skipped", "isolated-target-unavailable")
    else if (!fixture || checks.some((check) => check.status === "failed"))
      set("privileged", "failed", "required-core-check-failed")
    else {
      const target = files.target
      await child("privileged", options.bin, [], options.privileged, () => fixture!.privileged(target))
    }
    try {
      await fixture?.close()
    } catch {
      checks.push({ name: "fixture-cleanup", status: "failed", reason: "cleanup-failed" })
    }
  }
  return report()
}

/** Actual Node collection retains the original deadline and never stores stderr in diagnostics. */
export async function runNativeCommand(command: Command): Promise<CommandResult> {
  const result = await runObservedNativeCommand(command)
  if (result.diagnostic.trigger === "spawn-failed") throw new Error("The native check could not start.")
  return result
}

async function nativeTestFiles(options: SelfTestOptions): Promise<NativeTestFiles> {
  if (options.platform === "win32") {
    const windows = await verifyWindowsNativeFiles(options, packageDir)
    return { unit: windows.unit, target: windows.target, windows }
  }
  const supplied = await stat(options.tests)
  const directory = supplied.isDirectory() ? options.tests : path.dirname(options.tests)
  const unit = supplied.isDirectory()
    ? path.join(directory, options.platform === "darwin" ? "VectorComputerTests" : "vector-computer-tests.exe")
    : options.tests
  if (!(await stat(unit)).isFile()) throw new Error("Missing native unit executable.")
  if (options.platform === "darwin") {
    if (process.arch !== "x64" && process.arch !== "arm64") throw new Error("Unsupported native test architecture.")
    const bundle = path.dirname(path.dirname(path.dirname(await realpath(options.bin))))
    const identity = readIdentity()
    if (
      path.basename(bundle) !== identity.mac.bundle ||
      path.join(bundle, "Contents/MacOS", identity.mac.executable) !== (await realpath(options.bin))
    )
      throw new Error("The helper is not in its generated bundle location.")
    const info = await runNativeCommand({
      executable: "/usr/bin/plutil",
      args: ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(bundle, "Contents/Info.plist")],
      timeoutMs: 5000,
    })
    const channel = Hands.CHANNELS.find((channel) => Hands.helperBundleId(APP_IDS[channel]) === info.stdout.trim())
    if (info.code !== 0 || !channel) throw new Error("The native test helper channel is unknown.")
    const helperManifest = await verifyPrebuiltHelper(path.dirname(bundle), "darwin", [process.arch], {
      directory: packageDir,
      channel,
    })
    await verifyMacTestArtifacts(directory, [process.arch], { directory: packageDir, channel, helperManifest })
    const base = await realpath(directory)
    return { unit: path.join(base, "VectorComputerTests"), target: path.join(base, MAC_TEST_TARGET.bundle) }
  }
  throw new Error("The native test platform is unavailable.")
}

async function bundleDigest(directory: string) {
  const hash = createHash("sha256")
  async function visit(relative: string): Promise<void> {
    const file = path.join(directory, relative)
    const info = await lstat(file)
    hash.update(JSON.stringify([relative, info.mode & 0o777]))
    if (info.isSymbolicLink()) {
      hash.update(await readlink(file))
      return
    }
    if (info.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await visit(path.join(relative, name))
      return
    }
    if (!info.isFile()) throw new Error("Unexpected bundle entry.")
    for await (const chunk of createReadStream(file)) hash.update(chunk)
  }
  await visit("")
  return hash.digest("hex")
}

async function createVerifiedFixture(options: SelfTestOptions, files?: NativeTestFiles): Promise<VerifiedFixture> {
  if (options.platform === "win32")
    return createWindowsVerifiedFixture(options, packageDir, files?.windows, { command: runNativeCommand })
  const identity = readIdentity()
  const bundle = path.dirname(path.dirname(path.dirname(await realpath(options.bin))))
  if (
    path.basename(bundle) !== identity.mac.bundle ||
    path.join(bundle, "Contents/MacOS", identity.mac.executable) !== (await realpath(options.bin))
  )
    throw new Error("The helper is not in its generated bundle location.")
  const inspect = await runNativeCommand({
    executable: "/usr/bin/plutil",
    args: ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(bundle, "Contents/Info.plist")],
  })
  const channel = Hands.CHANNELS.find((channel) => Hands.helperBundleId(APP_IDS[channel]) === inspect.stdout.trim())
  if (inspect.code !== 0 || !channel) throw new Error("The helper channel is unknown.")
  const directory = (await stat(options.tests)).isDirectory() ? options.tests : path.dirname(options.tests)
  const caller = path.join(directory, "VectorComputerCaller")
  if (!(await stat(caller)).isFile()) throw new Error("The native verified caller is unavailable.")
  const temporary = await mkdtemp(path.join(tmpdir(), "vector-computer-selftest-"))
  const app = path.join(temporary, "Vector.app")
  const destination = path.join(app, "Contents/Helpers", identity.mac.bundle)
  const executable = path.join(app, "Contents/MacOS/VectorComputerCaller")
  try {
    await mkdir(path.dirname(executable), { recursive: true })
    await mkdir(path.dirname(destination), { recursive: true })
    await cp(bundle, destination, {
      recursive: true,
      preserveTimestamps: true,
      dereference: false,
      verbatimSymlinks: true,
    })
    await copyFile(caller, executable)
    await chmod(executable, 0o755)
    await writeFile(
      path.join(app, "Contents/Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${APP_IDS[channel]}</string><key>CFBundleExecutable</key><string>VectorComputerCaller</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
    )
    for (const command of [
      { executable: "/usr/bin/codesign", args: ["--verify", "--strict", "--all-architectures", destination] },
      {
        executable: "/usr/bin/codesign",
        args: [
          "--force",
          "--sign",
          "-",
          "--options",
          "runtime",
          "--timestamp=none",
          "--identifier",
          APP_IDS[channel],
          app,
        ],
      },
      { executable: "/usr/bin/codesign", args: ["--verify", "--strict", app] },
    ])
      if ((await runNativeCommand(command)).code !== 0) throw new Error("The fixture signature did not verify.")
    if ((await bundleDigest(bundle)) !== (await bundleDigest(destination)))
      throw new Error("Copying or signing changed the shipped helper.")
    const open = async () => nativeChannel(executable, ["--stdio"])
    const alive = async (pid: number) => {
      try {
        process.kill(pid, 0)
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH"
      }
      const result = await runNativeCommand({
        executable: "/bin/ps",
        args: ["-p", String(pid), "-o", "stat="],
        timeoutMs: 500,
      })
      return result.code === 0 && !/^\s*Z/.test(result.stdout)
    }
    const descendants = async (pid: number) => {
      const result = await runNativeCommand({ executable: "/usr/bin/pgrep", args: ["-P", String(pid)], timeoutMs: 500 })
      if (result.code === 1) return []
      if (result.code !== 0 || !/^\s*(?:\d+\s*)*$/.test(result.stdout))
        throw new NativeCheckFailure("process-inspection-failed")
      return result.stdout.trim().split(/\s+/).filter(Boolean).map(Number)
    }
    const lifetime = async (parentDeath: boolean) => {
      const running = nativeChannel(executable, ["--stdio"])
      try {
        await replay(
          running,
          [
            {
              send: { id: 1, op: "hello", protocol: { min: 1, max: 1 } },
              expect: { id: 1, ok: true, responsible: true },
            },
          ],
          {
            wait: async (ms) => {
              await timers.setTimeout(ms)
            },
          },
        )
        const supervisors = await descendants(running.pid)
        const supervisorFailure = lifecycleTopologyFailure("supervisor", supervisors.length)
        if (supervisorFailure) throw new NativeCheckFailure(supervisorFailure)
        const workers = await descendants(supervisors[0]!)
        const workerFailure = lifecycleTopologyFailure("worker", workers.length)
        if (workerFailure) throw new NativeCheckFailure(workerFailure)
        const deadline = performance.now() + 1000
        if (parentDeath) running.killParent()
        else running.end()
        const result = await waitForLifecycleExit(running, deadline)
        if (!parentDeath && result.code !== 0) {
          const code = boundedExitCode(result.code)
          throw new NativeCheckFailure(code === undefined ? "caller-exit-status" : `caller-exit-status-${code}`)
        }
        while (performance.now() < deadline) {
          if (!(await alive(supervisors[0]!)) && !(await alive(workers[0]!))) {
            if (performance.now() > deadline) throw new NativeCheckFailure("descendant-exit-deadline")
            return true
          }
          await timers.setTimeout(10)
        }
        throw new NativeCheckFailure("descendant-exit-deadline")
      } finally {
        await running.dispose()
      }
    }
    return {
      open,
      privileged: (target) =>
        runNativeCommand({
          executable,
          args: ["--self-test=privileged", "--target", target],
          timeoutMs: privilegedTimeoutMs,
        }),
      async probe() {
        const result = await runNativeCommand({ executable, args: ["--probe", "--json"], timeoutMs: 5000 })
        if (result.code !== 0 || result.timedOut) throw new Error("The verified native probe failed.")
        return JSON.parse(result.stdout) as unknown
      },
      async unverifiedParent() {
        const running = nativeChannel(path.join(destination, "Contents/MacOS", identity.mac.executable), [
          "--stdio",
          "--parent-pid",
          String(process.pid),
        ])
        try {
          const result = await running.next(5000)
          return result?.kind === "exit" && typeof result.code === "number" && result.code > 0
        } finally {
          await running.dispose()
        }
      },
      eof: () => lifetime(false),
      parentDeath: () => lifetime(true),
      close: () => rm(temporary, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

function nativeChannel(executable: string, args: string[]) {
  const child = spawn(executable, args, {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    detached: true,
    windowsHide: true,
  })
  const pipe = child.stdio[3] as Duplex
  const inbox: Received[] = []
  const listeners = new Set<() => void>()
  let buffered = 0
  let error: Error | undefined
  const wake = () => {
    for (const notify of listeners) notify()
  }
  const kill = () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL")
    } catch {}
  }
  const fail = (reason: NativeFailureReason) => {
    if (error) return
    error = new NativeCheckFailure(reason)
    kill()
    wake()
  }
  const reader = frameReader({
    maxBytes: Computer.LIMITS.helperFrameBytes,
    onOversize: () => fail("channel-oversized-output"),
    onFrame(bytes) {
      buffered += bytes.byteLength
      if (buffered > 32 * 1024 * 1024 || inbox.length >= 1000) return fail("channel-receive-limit")
      inbox.push({ kind: "frame", bytes })
      wake()
    },
  })
  const deadline = setTimeout(() => fail("channel-deadline"), 30_000)
  pipe.on("data", (bytes: Buffer) => reader.push(bytes))
  pipe.on("error", () => fail("channel-io"))
  child.stdout?.on("data", () => fail("channel-unexpected-stdout"))
  child.stderr?.on("data", () => {})
  child.once("error", () => fail("channel-start-failed"))
  child.once("close", (code) => {
    clearTimeout(deadline)
    inbox.push({ kind: "exit", code })
    wake()
  })
  return {
    get pid() {
      if (!child.pid) throw new Error("The native caller did not start.")
      return child.pid
    },
    write(bytes: Uint8Array) {
      if (error) throw error
      if (pipe.writableLength + bytes.byteLength > 32 * 1024 * 1024) throw new NativeCheckFailure("channel-send-limit")
      pipe.write(bytes)
    },
    end: () => pipe.end(),
    killParent: () => child.kill("SIGKILL"),
    async next(timeoutMs: number): Promise<Received | undefined> {
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
      pipe.destroy()
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        const done = () => {
          clearTimeout(timer)
          child.removeListener("close", done)
          resolve()
        }
        const timer = setTimeout(done, 1000)
        child.once("close", done)
      })
    },
  }
}

export async function runSelfTestCLI(argv: readonly string[]) {
  try {
    const options = parseSelfTestArgs(argv)
    const result = await runComputerHelperSelfTest(options)
    const report =
      options.report ?? path.join(await mkdtemp(path.join(tmpdir(), "vector-computer-report-")), "report.json")
    await mkdir(path.dirname(report), { recursive: true })
    await writeFile(report, `${JSON.stringify(result, null, 2)}\n`)
    process.stdout.write(
      `Computer helper checks: ${result.checks.filter((check) => check.status === "passed").length} passed, ${result.checks.filter((check) => check.status === "skipped").length} skipped, ${result.checks.filter((check) => check.status === "failed").length} failed. Report: ${report}\n`,
    )
    process.exitCode = result.code
  } catch {
    process.stderr.write("Computer helper self-test could not run. Check native host, build outputs and arguments.\n")
    process.exitCode = 2
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runSelfTestCLI(process.argv.slice(2))
}
