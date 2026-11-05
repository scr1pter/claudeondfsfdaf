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
