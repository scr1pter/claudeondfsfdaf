export const COMPUTER_SMOKE_MARK = "computer-smoke "
export const COMPUTER_SMOKE_LIMIT_MS = 120_000
export const COMPUTER_SMOKE_CHECKS = [
  "overlay-count",
  "overlay-bounds",
  "overlay-window-properties",
  "overlay-stack-level",
  "overlay-ignore-pointer",
  "overlay-workspaces",
  "overlay-content-protection",
  "overlay-banner-copy",
  "overlay-sandbox",
  "overlay-ipc-rejected",
  "transparent-theme-switch",
  "window-all-closed",
  "focus-preserved",
  "controller-stop-cancels-helper",
  "heartbeat-loss-removes-overlays",
  "helper-crash-removes-overlays",
  "native-os-stop",
  "native-capture-exclusion",
] as const

export type ComputerSmokeName = (typeof COMPUTER_SMOKE_CHECKS)[number]
export type ComputerSmokeReason =
  | "assertion_failed"
  | "runtime_failure"
  | "deadline_exceeded"
  | "linux_properties_only"
  | "not_applicable"
  | "native_harness_unavailable"
  | "native_grants_unavailable"
  | "isolated_desktop_required"
  | "elevated_fixture"
  | "native_target_unavailable"
  | "native_proof_invalid"
  | "native_cleanup_failed"
export type ComputerSmokeCheck = {
  name: ComputerSmokeName
  ok: boolean
  skipped?: true
  reason?: ComputerSmokeReason
}
export type ComputerSmokeReport = {
  protocol: 1
  platform: "darwin" | "win32" | "linux"
  electron: string
  checks: ComputerSmokeCheck[]
}

const REASONS: readonly ComputerSmokeReason[] = [
  "assertion_failed",
  "runtime_failure",
  "deadline_exceeded",
  "linux_properties_only",
  "not_applicable",
  "native_harness_unavailable",
  "native_grants_unavailable",
  "isolated_desktop_required",
  "elevated_fixture",
  "native_target_unavailable",
  "native_proof_invalid",
  "native_cleanup_failed",
]
const SKIPS: readonly ComputerSmokeReason[] = [
  "linux_properties_only",
  "not_applicable",
  "native_harness_unavailable",
  "native_grants_unavailable",
  "isolated_desktop_required",
  "elevated_fixture",
  "native_target_unavailable",
]
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const exact = (value: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(value).every((key) => fields.includes(key))

/** Native/window content and arbitrary exception strings never enter CI artifacts. */
export function parseComputerSmokeReport(
  stdout: string,
  input: { electron: string; platform: string; exitCode: number | null; requireNative?: boolean },
): ComputerSmokeReport {
  if (Buffer.byteLength(stdout, "utf8") > 65_536) throw new Error("The computer smoke report exceeded its bound.")
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith(COMPUTER_SMOKE_MARK))
  if (lines.length !== 1) throw new Error("The computer smoke must print exactly one fixed report.")
  const value: unknown = JSON.parse(lines[0]!.slice(COMPUTER_SMOKE_MARK.length))
  if (
    !record(value) ||
    !exact(value, ["protocol", "platform", "electron", "checks"]) ||
    value.protocol !== 1 ||
    value.platform !== input.platform ||
    !["darwin", "win32", "linux"].includes(String(value.platform)) ||
    value.electron !== input.electron ||
    !Array.isArray(value.checks) ||
    value.checks.length !== COMPUTER_SMOKE_CHECKS.length
  )
    throw new Error("The computer smoke returned an invalid envelope.")
  const checks = value.checks.map((entry, index): ComputerSmokeCheck => {
    if (
      !record(entry) ||
      !exact(entry, ["name", "ok", "skipped", "reason"]) ||
      entry.name !== COMPUTER_SMOKE_CHECKS[index] ||
      typeof entry.ok !== "boolean" ||
      (entry.skipped !== undefined && entry.skipped !== true) ||
      (entry.ok && entry.skipped === true) ||
      (entry.reason !== undefined &&
        (typeof entry.reason !== "string" || !REASONS.includes(entry.reason as ComputerSmokeReason))) ||
      (entry.skipped === true &&
        (entry.reason === undefined || !SKIPS.includes(entry.reason as ComputerSmokeReason))) ||
      (!entry.ok && entry.reason === undefined) ||
      (entry.ok && entry.reason !== undefined)
    )
      throw new Error("The computer smoke returned invalid check evidence.")
    if (entry.skipped && entry.reason === "linux_properties_only" && value.platform !== "linux")
      throw new Error("Only Linux may skip compositor checks as unsupported.")
    if (entry.skipped) {
      const name = COMPUTER_SMOKE_CHECKS[index]!
      const linux = [
        "focus-preserved",
        "controller-stop-cancels-helper",
        "heartbeat-loss-removes-overlays",
        "helper-crash-removes-overlays",
        "native-os-stop",
        "native-capture-exclusion",
      ].includes(name)
      const inapplicable =
        (name === "overlay-workspaces" && value.platform !== "darwin") ||
        (name === "overlay-content-protection" && value.platform !== "win32") ||
        (name === "native-capture-exclusion" && value.platform !== "darwin")
      if (
        (entry.reason === "linux_properties_only" && !linux) ||
        (entry.reason === "not_applicable" && !inapplicable) ||
        (entry.reason !== "linux_properties_only" && entry.reason !== "not_applicable" && !name.startsWith("native-"))
      )
        throw new Error("A prerequisite cannot hide a required overlay property failure.")
    }
    return {
      name: COMPUTER_SMOKE_CHECKS[index]!,
      ok: entry.ok,
      ...(entry.skipped ? { skipped: true } : {}),
      ...(entry.reason ? { reason: entry.reason as ComputerSmokeReason } : {}),
    }
  })
  const failed = checks.some((check) => !check.ok && !check.skipped)
  if (input.exitCode !== (failed ? 1 : 0)) throw new Error("The computer smoke exit disagrees with its report.")
  if (
    input.requireNative &&
    checks.some(
      (check) =>
        check.skipped &&
        (check.name === "native-os-stop" || (check.name === "native-capture-exclusion" && value.platform === "darwin")),
    )
  )
    throw new Error("Required native computer smoke evidence is unavailable.")
  return { protocol: 1, platform: value.platform as ComputerSmokeReport["platform"], electron: input.electron, checks }
}

export const COMPUTER_SMOKE_PHASE_MARK = "computer-smoke-phase "
export const COMPUTER_SMOKE_FAILURE_MARK = "computer-smoke-failure "
export const COMPUTER_SMOKE_PHASES = ["boot", "ready", "properties", "controller", "cleanup", "report"] as const
export type ComputerSmokePhase = (typeof COMPUTER_SMOKE_PHASES)[number]
export type ComputerSmokeLastPhase = ComputerSmokePhase | "none"
export type ComputerSmokeFailureCause =
  | "setup_failed"
  | "launch_failed"
  | "deadline_exceeded"
  | "stdout_limit"
  | "stderr_limit"
  | "invalid_progress"
  | "missing_report"
  | "invalid_report"
  | "runtime_failed"
  | "assertion_failed"
  | "required_native_unavailable"
export type ComputerSmokeRuntimeHint =
  | "none"
  | "display_auth"
  | "display_unavailable"
  | "sandbox_unavailable"
  | "loader_failed"
export type ComputerSmokeFailureDiagnostic = {
  protocol: 1
  cause: ComputerSmokeFailureCause
  phase: ComputerSmokeLastPhase
  hint: ComputerSmokeRuntimeHint
}
const FAILURE_CAUSES: readonly ComputerSmokeFailureCause[] = [
  "setup_failed",
  "launch_failed",
  "deadline_exceeded",
  "stdout_limit",
  "stderr_limit",
  "invalid_progress",
  "missing_report",
  "invalid_report",
  "runtime_failed",
  "assertion_failed",
  "required_native_unavailable",
]
const RUNTIME_HINTS: readonly ComputerSmokeRuntimeHint[] = [
  "none",
  "display_auth",
  "display_unavailable",
  "sandbox_unavailable",
  "loader_failed",
]

/** Receipts establish progress only. They can never replace the complete assertion catalog. */
export function parseComputerSmokePhase(line: string, previous: ComputerSmokeLastPhase = "none"): ComputerSmokePhase {
  if (!line.startsWith(COMPUTER_SMOKE_PHASE_MARK) || line.length > 160)
    throw new Error("The computer smoke phase receipt is invalid.")
  const value: unknown = JSON.parse(line.slice(COMPUTER_SMOKE_PHASE_MARK.length))
  if (
    !record(value) ||
    !exact(value, ["protocol", "phase"]) ||
    value.protocol !== 1 ||
    typeof value.phase !== "string" ||
    !(COMPUTER_SMOKE_PHASES as readonly string[]).includes(value.phase)
  )
    throw new Error("The computer smoke phase receipt is invalid.")
  const phase = value.phase as ComputerSmokePhase
  const next: Record<ComputerSmokeLastPhase, readonly ComputerSmokePhase[]> = {
    none: ["boot"],
    boot: ["ready"],
    ready: ["properties"],
    properties: ["controller", "cleanup"],
    controller: ["cleanup"],
    cleanup: ["report"],
    report: [],
  }
  if (!next[previous].includes(phase)) throw new Error("The computer smoke phase receipt is stale.")
  return phase
}

export function parseComputerSmokeFailure(line: string): ComputerSmokeFailureDiagnostic {
  if (!line.startsWith(COMPUTER_SMOKE_FAILURE_MARK) || line.length > 240)
    throw new Error("The computer smoke failure receipt is invalid.")
  const value: unknown = JSON.parse(line.slice(COMPUTER_SMOKE_FAILURE_MARK.length))
  if (
    !record(value) ||
    !exact(value, ["protocol", "cause", "phase", "hint"]) ||
    value.protocol !== 1 ||
    !FAILURE_CAUSES.includes(value.cause as ComputerSmokeFailureCause) ||
    !(value.phase === "none" || (COMPUTER_SMOKE_PHASES as readonly unknown[]).includes(value.phase)) ||
    !RUNTIME_HINTS.includes(value.hint as ComputerSmokeRuntimeHint)
  )
    throw new Error("The computer smoke failure receipt is invalid.")
  return {
    protocol: 1,
    cause: value.cause as ComputerSmokeFailureCause,
    phase: value.phase as ComputerSmokeLastPhase,
    hint: value.hint as ComputerSmokeRuntimeHint,
  }
}

/** Recognize only known runtime errors. No stderr text, path, nonce or arbitrary exception is returned. */
export function computerSmokeRuntimeHint(text: string): ComputerSmokeRuntimeHint {
  const bounded = text.slice(-8192)
  if (
    /Authorization required, but no authorization protocol specified|Invalid MIT-MAGIC-COOKIE-1 key|X11 connection rejected because of wrong authentication/i.test(
      bounded,
    )
  )
    return "display_auth"
  if (
    /No usable sandbox|Running as root without --no-sandbox|Failed to move to new namespace|The SUID sandbox helper binary was found|InitializeSandbox.*failed/i.test(
      bounded,
    )
  )
    return "sandbox_unavailable"
  if (
    /ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|Cannot find module|Unable to find Electron app|A JavaScript error occurred in the main process|Dynamic require of .* is not supported/i.test(
      bounded,
    )
  )
    return "loader_failed"
  if (
    /Missing X server or \$DISPLAY|The platform failed to initialize|cannot open display|Unable to open X display|Failed to connect to (?:the )?X server/i.test(
      bounded,
    )
  )
    return "display_unavailable"
  return "none"
}
