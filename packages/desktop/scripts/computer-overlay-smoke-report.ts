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
