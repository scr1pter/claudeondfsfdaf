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
export const COMPUTER_SMOKE_CONTROLLER_MARK = "computer-smoke-controller "
export const COMPUTER_SMOKE_GEOMETRY_MARK = "computer-smoke-geometry "
export type ComputerSmokeGeometry = {
  protocol: 1
  window: number
  kind: "top" | "right" | "bottom" | "left" | "banner"
  expected: { x: number; y: number; width: number; height: number }
  actual: { x: number; y: number; width: number; height: number }
  minimum: [number, number]
  maximum: [number, number]
  content: [number, number]
}
/** Failure-only owned-window coordinates; no display identifiers or window content. */
export function parseComputerSmokeGeometry(line: string): ComputerSmokeGeometry {
  if (!line.startsWith(COMPUTER_SMOKE_GEOMETRY_MARK) || line.length > 512)
    throw new Error("The computer smoke geometry receipt is invalid.")
  const value: unknown = JSON.parse(line.slice(COMPUTER_SMOKE_GEOMETRY_MARK.length))
  const rectangle = (value: unknown) =>
    record(value) &&
    exact(value, ["x", "y", "width", "height"]) &&
    Object.keys(value).length === 4 &&
    [value.x, value.y, value.width, value.height].every(
      (number) => typeof number === "number" && Number.isSafeInteger(number) && Math.abs(number) <= 1_000_000,
    ) &&
    Number(value.width) > 0 &&
    Number(value.height) > 0
  const size = (value: unknown): value is [number, number] =>
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(
      (number) => typeof number === "number" && Number.isSafeInteger(number) && number >= 0 && number <= 1_000_000,
    )
  if (
    !record(value) ||
    !exact(value, ["protocol", "window", "kind", "expected", "actual", "minimum", "maximum", "content"]) ||
    Object.keys(value).length !== 8 ||
    value.protocol !== 1 ||
    typeof value.window !== "number" ||
    !Number.isSafeInteger(value.window) ||
    value.window < 0 ||
    value.window > 128 ||
    typeof value.kind !== "string" ||
    !["top", "right", "bottom", "left", "banner"].includes(value.kind) ||
    !rectangle(value.expected) ||
    !rectangle(value.actual) ||
    !size(value.minimum) ||
    !size(value.maximum) ||
    !size(value.content)
  )
    throw new Error("The computer smoke geometry receipt is invalid.")
  const copy = (value: Record<string, unknown>) => ({
    x: Number(value.x),
    y: Number(value.y),
    width: Number(value.width),
    height: Number(value.height),
  })
  return {
    protocol: 1,
    window: value.window,
    kind: value.kind as ComputerSmokeGeometry["kind"],
    expected: copy(value.expected as Record<string, unknown>),
    actual: copy(value.actual as Record<string, unknown>),
    minimum: [value.minimum[0], value.minimum[1]],
    maximum: [value.maximum[0], value.maximum[1]],
    content: [value.content[0], value.content[1]],
  }
}
export const COMPUTER_SMOKE_NATIVE_MARK = "computer-smoke-native "
export const COMPUTER_SMOKE_NATIVE_REASONS = [
  "isolation_required",
  "noninteractive_desktop",
  "elevated_parent",
  "foreground_unavailable",
  "uia_unavailable",
  "guardian_unavailable",
  "physical_input",
  "source_mismatch",
  "parent_invalid",
  "control_invalid",
  "stop_target_invalid",
  "proof_changed",
  "input_post_failed",
  "cleanup_failed",
  "deadline_exceeded",
  "medium_token_unavailable",
  "bootstrap_failed",
  "native_failure",
  "responsibility_missing",
  "accessibility_denied",
  "post_event_denied",
  "screen_denied",
  "capture_unavailable",
  "capture_assertion_failed",
  "artifact_invalid",
  "request_invalid",
  "desktop_unavailable",
  "target_unavailable",
  "window_changed",
  "button_unavailable",
  "capture_failed",
  "assertion_failed",
  "source_unavailable",
] as const
export const COMPUTER_SMOKE_NATIVE_PREREQUISITES: readonly string[] = [
  "isolation_required",
  "noninteractive_desktop",
  "elevated_parent",
  "foreground_unavailable",
  "uia_unavailable",
  "physical_input",
  "medium_token_unavailable",
  "responsibility_missing",
  "accessibility_denied",
  "post_event_denied",
  "screen_denied",
  "desktop_unavailable",
  "target_unavailable",
]

export type ComputerSmokeNativePhase = "artifact" | "button" | "spawn" | "ready" | "result" | "exit" | "cleanup"
export type ComputerSmokeNativeCause =
  | "exception"
  | "stream_invalid"
  | "spawn_error"
  | "stdin_error"
  | "deadline_exceeded"
  | "exit_incomplete"
  | "exit_mismatch"
type ComputerSmokeNativeOutcome = {
  ok: boolean
  skipped?: true
  reason?: (typeof COMPUTER_SMOKE_NATIVE_REASONS)[number]
}
export type ComputerSmokeNativeDiagnostic =
  | { protocol: 1; kind: "boundary"; phase: ComputerSmokeNativePhase; cause: ComputerSmokeNativeCause }
  | {
      protocol: 1
      kind: "result"
      phase: "exit"
      stop: ComputerSmokeNativeOutcome
      capture?: ComputerSmokeNativeOutcome
      exitCode: number | null
    }

/** Observational fixed reasons only; this receipt cannot authorize native action or replace its result. */
export function parseComputerSmokeNativeDiagnostic(line: string): ComputerSmokeNativeDiagnostic {
  if (!line.startsWith(COMPUTER_SMOKE_NATIVE_MARK) || line.length > 512)
    throw new Error("The native smoke diagnostic is invalid.")
  const value: unknown = JSON.parse(line.slice(COMPUTER_SMOKE_NATIVE_MARK.length))
  if (!record(value) || value.protocol !== 1) throw new Error("The native smoke diagnostic is invalid.")
  if (value.kind === "boundary") {
    if (
      !exact(value, ["protocol", "kind", "phase", "cause"]) ||
      Object.keys(value).length !== 4 ||
      typeof value.phase !== "string" ||
      !["artifact", "button", "spawn", "ready", "result", "exit", "cleanup"].includes(value.phase) ||
      typeof value.cause !== "string" ||
      ![
        "exception",
        "stream_invalid",
        "spawn_error",
        "stdin_error",
        "deadline_exceeded",
        "exit_incomplete",
        "exit_mismatch",
      ].includes(value.cause)
    )
      throw new Error("The native smoke diagnostic is invalid.")
    return {
      protocol: 1,
      kind: "boundary",
      phase: value.phase as ComputerSmokeNativePhase,
      cause: value.cause as ComputerSmokeNativeCause,
    }
  }
  const outcome = (value: unknown): ComputerSmokeNativeOutcome => {
    if (
      !record(value) ||
      !exact(value, ["ok", "skipped", "reason"]) ||
      typeof value.ok !== "boolean" ||
      (value.skipped !== undefined && value.skipped !== true) ||
      (value.reason !== undefined &&
        (typeof value.reason !== "string" ||
          !(COMPUTER_SMOKE_NATIVE_REASONS as readonly string[]).includes(value.reason))) ||
      (value.ok && (value.skipped !== undefined || value.reason !== undefined)) ||
      (!value.ok && value.reason === undefined) ||
      (value.skipped === true && !COMPUTER_SMOKE_NATIVE_PREREQUISITES.includes(String(value.reason)))
    )
      throw new Error("The native smoke diagnostic outcome is invalid.")
    return {
      ok: value.ok,
      ...(value.skipped ? { skipped: true } : {}),
      ...(value.reason ? { reason: value.reason as ComputerSmokeNativeOutcome["reason"] } : {}),
    }
  }
  if (
    value.kind !== "result" ||
    value.phase !== "exit" ||
    !exact(value, ["protocol", "kind", "phase", "stop", "capture", "exitCode"]) ||
    (value.exitCode !== null &&
      (typeof value.exitCode !== "number" ||
        !Number.isInteger(value.exitCode) ||
        value.exitCode < 0 ||
        value.exitCode > 255))
  )
    throw new Error("The native smoke diagnostic is invalid.")
  return {
    protocol: 1,
    kind: "result",
    phase: "exit",
    stop: outcome(value.stop),
    ...(value.capture === undefined ? {} : { capture: outcome(value.capture) }),
    exitCode: value.exitCode,
  }
}

export const COMPUTER_SMOKE_CONTROLLER_STEPS = [
  "underlay",
  "stop-acquire",
  "stop-check",
  "stop-close",
  "heartbeat-acquire",
  "heartbeat-check",
  "heartbeat-close",
  "crash-acquire",
  "crash-check",
  "crash-close",
  "native-acquire",
  "native-pause",
  "native-ready",
  "native-listener",
  "native-proof",
  "native-close",
] as const
export type ComputerSmokeControllerStep = (typeof COMPUTER_SMOKE_CONTROLLER_STEPS)[number]

/** Fixed milestones locate an owned fixture await; they establish no assertion or native-input evidence. */
export function parseComputerSmokeController(
  line: string,
  previous?: ComputerSmokeControllerStep,
): ComputerSmokeControllerStep {
  if (!line.startsWith(COMPUTER_SMOKE_CONTROLLER_MARK) || line.length > 160)
    throw new Error("The computer smoke controller receipt is invalid.")
  const value: unknown = JSON.parse(line.slice(COMPUTER_SMOKE_CONTROLLER_MARK.length))
  if (!record(value) || !exact(value, ["protocol", "step"]) || value.protocol !== 1 || typeof value.step !== "string")
    throw new Error("The computer smoke controller receipt is invalid.")
  const next = (COMPUTER_SMOKE_CONTROLLER_STEPS as readonly string[]).indexOf(value.step)
  if (next < 0 || (previous === undefined ? next !== 0 : next <= COMPUTER_SMOKE_CONTROLLER_STEPS.indexOf(previous)))
    throw new Error("The computer smoke controller receipt is stale or unknown.")
  return value.step as ComputerSmokeControllerStep
}
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
  | "loader_pending"
  | "loader_failed"
  | "loader_module_not_found"
  | "loader_require_esm"
  | "loader_require_async"
  | "loader_bun_undefined"
  | "loader_require_undefined"
  | "loader_dirname_undefined"
  | "loader_filename_undefined"
  | "loader_named_export"
  | "loader_app_not_ready"
  | "loader_extension"
  | "loader_reference_error"
  | "loader_type_error"
  | "loader_syntax_error"
export type ComputerSmokeLoaderModule =
  | "electron"
  | "jsonc-parser"
  | "node_builtin"
  | "workspace"
  | "relative_main"
  | "relative_other"
  | "absolute"
  | "other"
const LOADER_MODULES: readonly ComputerSmokeLoaderModule[] = [
  "electron",
  "jsonc-parser",
  "node_builtin",
  "workspace",
  "relative_main",
  "relative_other",
  "absolute",
  "other",
]
export type ComputerSmokeFailureDiagnostic = {
  protocol: 1
  cause: ComputerSmokeFailureCause
  phase: ComputerSmokeLastPhase
  hint: ComputerSmokeRuntimeHint
  module?: ComputerSmokeLoaderModule
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
  "loader_pending",
  "loader_failed",
  "loader_module_not_found",
  "loader_require_esm",
  "loader_require_async",
  "loader_bun_undefined",
  "loader_require_undefined",
  "loader_dirname_undefined",
  "loader_filename_undefined",
  "loader_named_export",
  "loader_app_not_ready",
  "loader_extension",
  "loader_reference_error",
  "loader_type_error",
  "loader_syntax_error",
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
    !exact(value, ["protocol", "cause", "phase", "hint", "module"]) ||
    value.protocol !== 1 ||
    !FAILURE_CAUSES.includes(value.cause as ComputerSmokeFailureCause) ||
    !(value.phase === "none" || (COMPUTER_SMOKE_PHASES as readonly unknown[]).includes(value.phase)) ||
    !RUNTIME_HINTS.includes(value.hint as ComputerSmokeRuntimeHint) ||
    (value.module !== undefined && !LOADER_MODULES.includes(value.module as ComputerSmokeLoaderModule))
  )
    throw new Error("The computer smoke failure receipt is invalid.")
  return {
    protocol: 1,
    cause: value.cause as ComputerSmokeFailureCause,
    phase: value.phase as ComputerSmokeLastPhase,
    hint: value.hint as ComputerSmokeRuntimeHint,
    ...(value.module === undefined ? {} : { module: value.module as ComputerSmokeLoaderModule }),
  }
}

const LOADER_CODES: Readonly<Record<string, ComputerSmokeRuntimeHint>> = Object.freeze({
  ERR_MODULE_NOT_FOUND: "loader_module_not_found",
  MODULE_NOT_FOUND: "loader_module_not_found",
  ERR_REQUIRE_ESM: "loader_require_esm",
  ERR_REQUIRE_ASYNC_MODULE: "loader_require_async",
  ERR_UNKNOWN_FILE_EXTENSION: "loader_extension",
})
const LOADER_MESSAGES: readonly (readonly [string, ComputerSmokeRuntimeHint])[] = [
  ["\\bBun is not defined\\b", "loader_bun_undefined"],
  ["\\brequire is not defined\\b|Dynamic require of .* is not supported", "loader_require_undefined"],
  ["\\b__dirname is not defined\\b", "loader_dirname_undefined"],
  ["\\b__filename is not defined\\b", "loader_filename_undefined"],
  ["does not provide an export named|Named export .* not found", "loader_named_export"],
  [
    "(?:screen|session|nativeTheme).*(?:before|until|after).*ready|(?:screen|session|nativeTheme).*can(?:not|'t).*ready",
    "loader_app_not_ready",
  ],
]
const LOADER_NAMES: Readonly<Record<string, ComputerSmokeRuntimeHint>> = Object.freeze({
  ReferenceError: "loader_reference_error",
  TypeError: "loader_type_error",
  SyntaxError: "loader_syntax_error",
})

/** Fixed enums only: arbitrary error codes, names, messages and stack traces never leave this boundary. */
export function computerSmokeLoaderHint(error: unknown): ComputerSmokeRuntimeHint {
  try {
    if (!error || typeof error !== "object") return "loader_failed"
    const value = error as { code?: unknown; name?: unknown; message?: unknown }
    const code = value.code,
      rawMessage = value.message,
      name = value.name
    if (typeof code === "string" && Object.hasOwn(LOADER_CODES, code)) return LOADER_CODES[code]!
    const message = typeof rawMessage === "string" ? rawMessage.slice(0, 8192) : ""
    for (const [pattern, hint] of LOADER_MESSAGES) if (new RegExp(pattern, "i").test(message)) return hint
    return typeof name === "string" && Object.hasOwn(LOADER_NAMES, name) ? LOADER_NAMES[name]! : "loader_failed"
  } catch {
    return "loader_failed"
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
  for (const [code, hint] of Object.entries(LOADER_CODES)) if (bounded.includes(code)) return hint
  const specific = computerSmokeLoaderHint({ message: bounded })
  if (specific !== "loader_failed") return specific
  if (/Cannot find module|Unable to find Electron app|A JavaScript error occurred in the main process/i.test(bounded))
    return "loader_failed"
  if (
    /Missing X server or \$DISPLAY|The platform failed to initialize|cannot open display|Unable to open X display|Failed to connect to (?:the )?X server/i.test(
      bounded,
    )
  )
    return "display_unavailable"
  return "none"
}

const LOADER_MODULE_REQUEST = String.raw`Cannot find (?:package|module) ['"]([^'"\r\n]{1,2048})['"]`
const LOADER_RELATIVE_PREFIX = String.raw`^\.\.?(?:[\\/]|$)`
const LOADER_ABSOLUTE_PREFIX = String.raw`^(?:/|[A-Za-z]:[\\/]|\\\\|file:)`
const LOADER_BUILTINS = [
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]
/** Known package ids or closed path classes only. The requested module string is never returned. */
export function computerSmokeLoaderModule(error: unknown, mainURL?: string): ComputerSmokeLoaderModule {
  try {
    if (!error || typeof error !== "object") return "other"
    const value = error as { moduleName?: unknown; message?: unknown; url?: unknown; path?: unknown }
    const moduleName = value.moduleName,
      message = value.message,
      url = value.url,
      filename = value.path
    let request = typeof moduleName === "string" ? moduleName.slice(0, 2048) : ""
    if (!request && typeof message === "string")
      request = new RegExp(LOADER_MODULE_REQUEST, "i").exec(message.slice(0, 8192))?.[1] ?? ""
    if (request === "electron" || request === "jsonc-parser") return request
    if (!request && mainURL && url === mainURL) return "relative_main"
    if (!request)
      request =
        typeof url === "string" ? url.slice(0, 2048) : typeof filename === "string" ? filename.slice(0, 2048) : ""
    if (request === "./computer-overlay-smoke-electron.mjs" || request === "computer-overlay-smoke-electron.mjs")
      return "relative_main"
    if (request.startsWith("node:") || LOADER_BUILTINS.includes(request.split("/")[0]!)) return "node_builtin"
    if (request.startsWith("@vectordevai/")) return "workspace"
    if (new RegExp(LOADER_RELATIVE_PREFIX).test(request)) return "relative_other"
    return new RegExp(LOADER_ABSOLUTE_PREFIX, "i").test(request) ? "absolute" : "other"
  } catch {
    return "other"
  }
}

export const COMPUTER_SMOKE_LOADER_STARTED = "computer-smoke-loader-started"
/** Generic properties only. The native stage keeps its exact admitted main argv and immutable pins. */
export function computerSmokeBootstrapSource(): string {
  return `"use strict";
const { app } = require("electron");
const path = require("node:path");
const { mkdirSync } = require("node:fs");
const { pathToFileURL } = require("node:url");
const mainURL = pathToFileURL(path.join(__dirname, "computer-overlay-smoke-electron.mjs")).href;
const codes = ${JSON.stringify(LOADER_CODES)};
const messages = ${JSON.stringify(LOADER_MESSAGES)};
const names = ${JSON.stringify(LOADER_NAMES)};
const builtins = ${JSON.stringify(LOADER_BUILTINS)};
const requestPattern = ${JSON.stringify(LOADER_MODULE_REQUEST)};
const relativePattern = ${JSON.stringify(LOADER_RELATIVE_PREFIX)};
const absolutePattern = ${JSON.stringify(LOADER_ABSOLUTE_PREFIX)};
function hint(error) {
  try {
    if (!error || typeof error !== "object") return "loader_failed";
    const code = error.code, message = error.message, name = error.name;
    if (typeof code === "string" && Object.hasOwn(codes, code)) return codes[code];
    const text = typeof message === "string" ? message.slice(0, 8192) : "";
    for (const [pattern, value] of messages) if (new RegExp(pattern, "i").test(text)) return value;
    return typeof name === "string" && Object.hasOwn(names, name) ? names[name] : "loader_failed";
  } catch { return "loader_failed"; }
}
function moduleKind(error, expectedMain) {
  try {
    if (!error || typeof error !== "object") return "other";
    const moduleName = error.moduleName, message = error.message, url = error.url, filename = error.path;
    let request = typeof moduleName === "string" ? moduleName.slice(0, 2048) : "";
    if (!request && typeof message === "string") request = new RegExp(requestPattern, "i").exec(message.slice(0, 8192))?.[1] || "";
    if (request === "electron" || request === "jsonc-parser") return request;
    if (!request && expectedMain && url === expectedMain) return "relative_main";
    if (!request) request = typeof url === "string" ? url.slice(0, 2048) : typeof filename === "string" ? filename.slice(0, 2048) : "";
    if (request === "./computer-overlay-smoke-electron.mjs" || request === "computer-overlay-smoke-electron.mjs") return "relative_main";
    if (request.startsWith("node:") || builtins.includes(request.split("/")[0])) return "node_builtin";
    if (request.startsWith("@vectordevai/")) return "workspace";
    if (new RegExp(relativePattern).test(request)) return "relative_other";
    return new RegExp(absolutePattern, "i").test(request) ? "absolute" : "other";
  } catch { return "other"; }
}
function failed(error) {
  const value = { protocol: 1, cause: "runtime_failed", phase: "none", hint: hint(error), module: moduleKind(error, mainURL) };
  process.stdout.write(${JSON.stringify(COMPUTER_SMOKE_FAILURE_MARK)} + JSON.stringify(value) + "\\n", () => app.exit(1));
}
process.stdout.write(${JSON.stringify(COMPUTER_SMOKE_LOADER_STARTED + "\n")});
try {
  const profile = path.resolve(__dirname, "..", "profile");
  mkdirSync(path.join(profile, "session"), { recursive: true });
  app.setPath("userData", profile); app.setPath("sessionData", path.join(profile, "session")); app.setPath("home", profile);
  import(mainURL).catch(failed);
} catch (error) { failed(error); }
`
}

/** Fixed banner copy and the state delivered over IPC occupy different page fields. */
export function computerSmokeBannerProbe(title: string, line: string): string {
  return `(() => {
    const stop = document.querySelector('button[data-action="stop"]');
    return document.querySelector('.title')?.textContent === ${JSON.stringify(title)} &&
      document.querySelector('.line')?.textContent === ${JSON.stringify(line)} &&
      !!stop && stop.textContent === 'Stop' && stop.disabled === false;
  })()`
}

/** Electron's native getter is RGB-only; renderer styles independently expose page alpha. */
export const COMPUTER_SMOKE_TRANSPARENCY_PROBE = `(() =>
  [document.documentElement, document.body].every(element =>
    !!element && getComputedStyle(element).backgroundColor === 'rgba(0, 0, 0, 0)'
  )
)()`
export function computerSmokeTransparentBackground(
  config: { transparent?: boolean; backgroundColor?: string },
  nativeColor: string,
  pageTransparent: unknown,
): boolean {
  return (
    config.transparent === true &&
    config.backgroundColor === "#00000000" &&
    nativeColor.toLowerCase() === "#000000" &&
    pageTransparent === true
  )
}

/** Loss checks start only after a real indicator exists for the same acquired lease. */
export async function computerSmokeControllerReady(
  ready: Promise<void>,
  current: () => boolean,
  windows: () => readonly { isDestroyed(): boolean; isVisible(): boolean }[],
): Promise<void> {
  await ready
  if (!current()) throw new Error("The controlled smoke lease changed before its indicator was ready.")
  const owned = windows()
  if (!owned.length || owned.some((window) => window.isDestroyed() || !window.isVisible()))
    throw new Error("The controlled smoke indicator is not visible.")
}

export const COMPUTER_SMOKE_EXCEPTION_MARK = "computer-smoke-exception "
const EXCEPTION_NAMES = [
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "other",
] as const
const EXCEPTION_CODES = [
  "EPIPE",
  "ECONNRESET",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
  "ERR_INVALID_STATE",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_ARG_VALUE",
  "ERR_UNHANDLED_ERROR",
  "ERR_ASSERTION",
  "ABORT_ERR",
  "ERR_IPC_CHANNEL_CLOSED",
  "ERR_IPC_DISCONNECTED",
  "stopped",
  "none",
] as const
const EXCEPTION_FUNCTIONS = [
  "main",
  "controllerChecks",
  "controllerFixture",
  "until",
  "window",
  "close",
  "lost",
  "finish",
  "fail",
  "request",
  "recover",
  "answer",
  "capture",
  "helperEvent",
  "retire",
  "detach",
  "halt",
  "inhibit",
  "pause",
  "stop",
  "endNative",
  "publish",
  "snapshot",
  "paint",
  "render",
  "destroy",
  "emit",
  "abort",
  "onExit",
  "onData",
  "requireRun",
  "_onTimeout",
  "other",
  "anonymous",
] as const
export type ComputerSmokeException = {
  protocol: 1
  origin: "uncaughtException" | "unhandledRejection"
  name: (typeof EXCEPTION_NAMES)[number]
  code: (typeof EXCEPTION_CODES)[number]
  at?: { fn: (typeof EXCEPTION_FUNCTIONS)[number]; line: number; column: number }
}

// V8 may expose its lazy stack as an accessor. Match only the actual built-in getter captured here.
const nativeExceptionStackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get
type ExceptionData = { value: unknown }
function exceptionData(value: unknown, key: string): ExceptionData | undefined {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return { value: undefined }
  let item: object | null = value as object
  for (let depth = 0; item && depth < 8; depth++, item = Object.getPrototypeOf(item)) {
    const descriptor = Object.getOwnPropertyDescriptor(item, key)
    if (descriptor) return Object.hasOwn(descriptor, "value") ? { value: descriptor.value } : undefined
  }
  return item ? undefined : { value: undefined }
}
function exceptionStack(reason: unknown): string | undefined {
  if ((typeof reason !== "object" || reason === null) && typeof reason !== "function") return
  // Inspect formatting inputs first: some engines materialize a lazy stack during descriptor lookup.
  const name = exceptionData(reason, "name"),
    message = exceptionData(reason, "message")
  if (
    !name ||
    !message ||
    [name.value, message.value].some((value) => value !== undefined && typeof value !== "string")
  )
    return
  const descriptor = Object.getOwnPropertyDescriptor(reason, "stack")
  if (!descriptor) return
  if (Object.hasOwn(descriptor, "value")) return typeof descriptor.value === "string" ? descriptor.value : undefined
  if (!nativeExceptionStackGetter || descriptor.get !== nativeExceptionStackGetter) return
  // Default formatting can consult name/message or Error.prepareStackTrace. Do not invoke custom accessors/formatters.
  const formatter = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace")
  if (
    !name ||
    !message ||
    (formatter && (!Object.hasOwn(formatter, "value") || formatter.value !== undefined)) ||
    [name.value, message.value].some((value) => value !== undefined && typeof value !== "string")
  )
    return
  const stack: unknown = nativeExceptionStackGetter.call(reason)
  return typeof stack === "string" ? stack : undefined
}
const exceptionCoordinate = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 10_000_000
function exceptionLocation(stack: string | undefined, bundleURL: string): ComputerSmokeException["at"] {
  if (!stack || bundleURL.length > 4096 || !bundleURL.endsWith("/computer-overlay-smoke-electron.mjs")) return
  const url = new URL(bundleURL)
  if (url.protocol !== "file:" || url.href !== bundleURL || url.search || url.hash) return
  const bounded = Buffer.from(stack.slice(0, 8192), "utf8").subarray(0, 8192).toString("utf8")
  for (const line of bounded.split(/\r?\n/).slice(0, 32)) {
    const frame = /^\s*at\s+(.+?)\s*$/.exec(line)
    if (!frame) continue
    let location = frame[1]!,
      functionName = "anonymous"
    if (location.endsWith(")")) {
      const opening = location.lastIndexOf(" (")
      if (opening < 0) continue
      functionName = location.slice(0, opening).replace(/^async\s+/, "")
      location = location.slice(opening + 2, -1)
    }
    if (!location.startsWith(bundleURL + ":")) continue
    const coordinates = /^([1-9]\d{0,7}):([1-9]\d{0,7})$/.exec(location.slice(bundleURL.length + 1))
    if (!coordinates) continue
    const lineNumber = Number(coordinates[1]),
      column = Number(coordinates[2])
    if (!exceptionCoordinate(lineNumber) || !exceptionCoordinate(column)) continue
    const last = functionName
      .split(".")
      .at(-1)!
      .replace(/[$_]?\d+$/, "")
    const fn =
      last === "<anonymous>"
        ? "anonymous"
        : (EXCEPTION_FUNCTIONS as readonly string[]).includes(last)
          ? (last as NonNullable<ComputerSmokeException["at"]>["fn"])
          : "other"
    return { fn, line: lineNumber, column }
  }
}

/** Exceptions may carry native/user text; return only a closed category and an exact owned-bundle location. */
export function computerSmokeException(
  origin: ComputerSmokeException["origin"],
  reason: unknown,
  bundleURL: string,
): ComputerSmokeException {
  const result: ComputerSmokeException = {
    protocol: 1,
    origin: origin === "unhandledRejection" ? origin : "uncaughtException",
    name: "other",
    code: "none",
  }
  try {
    const name = exceptionData(reason, "name")?.value,
      code = exceptionData(reason, "code")?.value
    if (typeof name === "string" && (EXCEPTION_NAMES as readonly string[]).includes(name))
      result.name = name as ComputerSmokeException["name"]
    if (typeof code === "string" && (EXCEPTION_CODES as readonly string[]).includes(code))
      result.code = code as ComputerSmokeException["code"]
    const at = exceptionLocation(exceptionStack(reason), bundleURL)
    if (at) result.at = at
  } catch {
    /* Unknown descriptors, proxies and stack failures contribute no arbitrary diagnostic data. */
  }
  return result
}

export function parseComputerSmokeException(line: string): ComputerSmokeException {
  if (!line.startsWith(COMPUTER_SMOKE_EXCEPTION_MARK) || line.length > 512)
    throw new Error("The computer smoke exception receipt is invalid.")
  const value: unknown = JSON.parse(line.slice(COMPUTER_SMOKE_EXCEPTION_MARK.length))
  if (
    !record(value) ||
    !exact(value, ["protocol", "origin", "name", "code", "at"]) ||
    value.protocol !== 1 ||
    (value.origin !== "uncaughtException" && value.origin !== "unhandledRejection") ||
    !(EXCEPTION_NAMES as readonly unknown[]).includes(value.name) ||
    !(EXCEPTION_CODES as readonly unknown[]).includes(value.code)
  )
    throw new Error("The computer smoke exception receipt is invalid.")
  if (
    value.at !== undefined &&
    (!record(value.at) ||
      !exact(value.at, ["fn", "line", "column"]) ||
      !(EXCEPTION_FUNCTIONS as readonly unknown[]).includes(value.at.fn) ||
      !exceptionCoordinate(value.at.line) ||
      !exceptionCoordinate(value.at.column))
  )
    throw new Error("The computer smoke exception location is invalid.")
  return {
    protocol: 1,
    origin: value.origin,
    name: value.name as ComputerSmokeException["name"],
    code: value.code as ComputerSmokeException["code"],
    ...(value.at === undefined
      ? {}
      : {
          at: {
            fn: value.at.fn as NonNullable<ComputerSmokeException["at"]>["fn"],
            line: value.at.line as number,
            column: value.at.column as number,
          },
        }),
  }
}

/** A second uncaughtException listener suppresses Electron's synchronous default native error dialog. */
export function installComputerSmokeExceptionHooks(
  events: { on(name: ComputerSmokeException["origin"], handler: (reason: unknown) => void): unknown },
  bundleURL: string,
  fail: (receipt: ComputerSmokeException) => void,
) {
  let failed = false
  for (const origin of ["uncaughtException", "unhandledRejection"] as const)
    events.on(origin, (reason) => {
      if (failed) return
      failed = true
      fail(computerSmokeException(origin, reason, bundleURL))
    })
}

/** Timer callbacks can outlive their lease; synchronous heartbeat refusals must become handled rejections too. */
export async function computerSmokeHeartbeat(heartbeat: () => unknown, current: () => boolean): Promise<void> {
  try {
    await Promise.resolve().then(heartbeat)
  } catch (error) {
    const code = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined
    if (!current() && code === "stopped") return
    throw error
  }
}
