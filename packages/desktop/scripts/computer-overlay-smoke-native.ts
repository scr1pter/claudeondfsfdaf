import { spawn } from "node:child_process"
import { lstat } from "node:fs/promises"
import path from "node:path"
import { screen, type BrowserWindow } from "electron"
import { nativeId } from "../src/main/computer-overlay"
import identity from "../native/computer-helper/identity.json"
import {
  ComputerSmokeNativeArtifactFailure,
  verifyComputerSmokeNativeCatalog,
} from "./computer-overlay-smoke-native-catalog"
import {
  COMPUTER_SMOKE_NATIVE_MARK,
  COMPUTER_SMOKE_NATIVE_REASONS,
  COMPUTER_SMOKE_NATIVE_PREREQUISITES,
  parseComputerSmokeNativeDiagnostic,
  type ComputerSmokeReason,
  type ComputerSmokeNativePhase,
  type ComputerSmokeNativeCause,
  type ComputerSmokeNativeRole,
} from "./computer-overlay-smoke-report"

// C2 supplies this literal in the exact source-bound prebuilt smoke bundle, before compiling the
// native driver's immutable bundle pins. A generic properties-only bundle has no native authority.
declare const VECTOR_COMPUTER_SMOKE_SOURCE_DIGEST: string | undefined
const sourceDigest =
  typeof VECTOR_COMPUTER_SMOKE_SOURCE_DIGEST === "string" ? VECTOR_COMPUTER_SMOKE_SOURCE_DIGEST : undefined
type Outcome =
  | { ok: boolean; skipped?: false; reason?: ComputerSmokeReason }
  | { ok: false; skipped: true; reason: ComputerSmokeReason }
type Proof = { stop: Outcome; capture: Outcome }
type Rect = { x: number; y: number; w: number; h: number }
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key))
const hex = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
const unavailable = (reason: ComputerSmokeReason): Proof => ({
  stop: { ok: false, skipped: true, reason },
  capture: { ok: false, skipped: true, reason: process.platform === "win32" ? "not_applicable" : reason },
})

function outcome(value: unknown): Outcome {
  if (
    !record(value) ||
    !exact(value, ["ok", "skipped", "reason"]) ||
    typeof value.ok !== "boolean" ||
    (value.skipped !== undefined && value.skipped !== true) ||
    (value.ok && (value.skipped || value.reason !== undefined)) ||
    (!value.ok &&
      (typeof value.reason !== "string" ||
        !(COMPUTER_SMOKE_NATIVE_REASONS as readonly string[]).includes(value.reason))) ||
    (value.skipped && !COMPUTER_SMOKE_NATIVE_PREREQUISITES.includes(String(value.reason)))
  )
    throw new Error("The finite native driver returned invalid evidence.")
  const reason: ComputerSmokeReason =
    value.reason === "cleanup_failed"
      ? "native_cleanup_failed"
      : value.reason === "isolation_required"
        ? "isolated_desktop_required"
        : value.reason === "elevated_parent" || value.reason === "medium_token_unavailable"
          ? "elevated_fixture"
          : ["responsibility_missing", "accessibility_denied", "post_event_denied", "screen_denied"].includes(
                String(value.reason),
              )
            ? "native_grants_unavailable"
            : value.skipped
              ? "native_target_unavailable"
              : "native_proof_invalid"
  return value.ok ? { ok: true } : value.skipped ? { ok: false, skipped: true, reason } : { ok: false, reason }
}
function nativeRect(window: BrowserWindow, value: Electron.Rectangle): Rect {
  const native = process.platform === "win32" ? screen.dipToScreenRect(window, value) : value
  return { x: native.x, y: native.y, w: native.width, h: native.height }
}

type NativeProofInput = {
  root: string
  nonce: string
  banner: BrowserWindow
  underlay: BrowserWindow
  glow: readonly BrowserWindow[]
}
type NativeDiagnosticState = {
  phase: ComputerSmokeNativePhase
  failure?: {
    phase: ComputerSmokeNativePhase
    cause: ComputerSmokeNativeCause
    role?: ComputerSmokeNativeRole
    ordinal?: number
    architecture?: "x64" | "arm64"
  }
}
function emitNativeDiagnostic(value: unknown) {
  try {
    const receipt = parseComputerSmokeNativeDiagnostic(COMPUTER_SMOKE_NATIVE_MARK + JSON.stringify(value))
    process.stdout.write(COMPUTER_SMOKE_NATIVE_MARK + JSON.stringify(receipt) + "\n")
  } catch {
    // Diagnostics cannot replace the original native proof, refusal, exit or cleanup path.
  }
}
export async function runComputerNativeOverlayProof(input: NativeProofInput): Promise<Proof> {
  const diagnostic: NativeDiagnosticState = { phase: "artifact" }
  try {
    return await nativeProof(input, diagnostic)
  } catch (error) {
    if (error instanceof ComputerSmokeNativeArtifactFailure) diagnostic.failure ??= error.diagnostic
    if (hex(sourceDigest))
      emitNativeDiagnostic({
        protocol: 1,
        kind: "boundary",
        ...(diagnostic.failure ?? { phase: diagnostic.phase, cause: "exception" }),
      })
    throw error
  }
}
async function nativeProof(input: NativeProofInput, diagnostic: NativeDiagnosticState): Promise<Proof> {
  if (process.platform !== "darwin" && process.platform !== "win32") return unavailable("linux_properties_only")
  if (!hex(sourceDigest)) {
    const manifest = await lstat(path.join(input.root, "computer-overlay-smoke.json")).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return
        throw error
      },
    )
    if (manifest) throw new Error("A staged native smoke bundle has no compiled source admission.")
    return unavailable("native_harness_unavailable")
  }
  const executable = await verifyComputerSmokeNativeCatalog(input.root, {
    platform: process.platform,
    architecture: process.arch,
    helperVersion: identity.helperVersion,
    sourceDigest,
    protocol: identity.protocol,
  })
  if (!executable) return unavailable("native_harness_unavailable")
  if (process.env.VECTOR_COMPUTER_TEST_ISOLATED !== "1") return unavailable("isolated_desktop_required")
  if (!hex(input.nonce)) {
    diagnostic.failure = { phase: "artifact", cause: "target_nonce" }
    throw new Error("The finite native target is invalid.")
  }
  if (input.banner.isDestroyed()) {
    diagnostic.failure = { phase: "artifact", cause: "target_banner" }
    throw new Error("The finite native target is invalid.")
  }
  if (input.underlay.isDestroyed()) {
    diagnostic.failure = { phase: "artifact", cause: "target_underlay" }
    throw new Error("The finite native target is invalid.")
  }
  diagnostic.phase = "button"
  const rect: unknown = await input.banner.webContents.executeJavaScript(
    "(() => { const button = document.querySelector('button[data-action=stop]'); if (!button || button.textContent !== 'Stop' || button.disabled) return null; const box = button.getBoundingClientRect(); return {x:box.x,y:box.y,w:box.width,h:box.height} })()",
  )
  if (
    !record(rect) ||
    ![rect.x, rect.y, rect.w, rect.h].every((value) => typeof value === "number" && Number.isFinite(value)) ||
    Number(rect.w) <= 0 ||
    Number(rect.h) <= 0
  )
    throw new Error("The actual native Stop button is unavailable.")
  const bounds = input.banner.getBounds()
  const stopBounds = nativeRect(input.banner, {
    x: bounds.x + Number(rect.x),
    y: bounds.y + Number(rect.y),
    width: Number(rect.w),
    height: Number(rect.h),
  })
  diagnostic.phase = "spawn"
  const child = spawn(executable, ["--overlay-stop", "--parent-pid", String(process.pid), "--nonce", input.nonce], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      PATH: process.env.PATH ?? "",
      VECTOR_COMPUTER_TEST_ISOLATED: "1",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    },
  })
  let buffer = Buffer.alloc(0),
    ready = false,
    final: Record<string, unknown> | undefined,
    failed = false,
    diagnostics = 0
  diagnostic.phase = "ready"
  const kill = (cause: ComputerSmokeNativeCause) => {
    diagnostic.failure ??= { phase: diagnostic.phase, cause }
    failed = true
    child.kill("SIGKILL")
  }
  const timer = setTimeout(() => kill("deadline_exceeded"), 20_000)
  child.stderr.on("data", (bytes: Buffer) => {
    diagnostics += bytes.length
    if (diagnostics > 65_536) kill("stream_invalid")
  })
  child.stdin.on("error", () => kill("stdin_error"))
  child.stdout.on("data", (bytes: Buffer) => {
    try {
      if (buffer.length + bytes.length > 16_384) throw new Error("The native frame bound was exceeded.")
      buffer = Buffer.concat([buffer, bytes])
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0)
        if (!size || size > 8192) throw new Error("The native frame length is invalid.")
        if (buffer.length < size + 4) return
        const value: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(4, size + 4)),
        )
        buffer = buffer.subarray(size + 4)
        if (!record(value) || value.protocol !== 1 || final) throw new Error("The finite native response is invalid.")
        if (value.id === 0) {
          diagnostic.phase = "ready"
          if (
            ready ||
            !exact(value, [
              "id",
              "ok",
              "protocol",
              "ready",
              "nonce",
              "parentPID",
              "parentCreationTime",
              "sourceDigest",
            ]) ||
            value.ok !== true ||
            value.ready !== true ||
            value.nonce !== input.nonce ||
            value.parentPID !== process.pid ||
            typeof value.parentCreationTime !== "string" ||
            !/^[0-9]{1,20}(?::[0-9]{1,6})?$/.test(value.parentCreationTime) ||
            value.sourceDigest !== sourceDigest
          )
            throw new Error("The native parent's actual ready receipt is invalid.")
          ready = true
          const request = {
            protocol: 1,
            nonce: input.nonce,
            parentPID: process.pid,
            parentCreationTime: value.parentCreationTime,
            sourceDigest,
            bannerWindowId: nativeId(input.banner, process.platform),
            bannerBounds: nativeRect(input.banner, bounds),
            stopBounds,
            bannerTitle: `Vector computer smoke ${input.nonce}`,
            ...(process.platform === "darwin"
              ? { glowWindowIds: input.glow.map((window) => nativeId(window, process.platform)) }
              : {}),
          }
          const body = Buffer.from(
              JSON.stringify(process.platform === "win32" ? { id: 1, ok: true, stop: request } : request),
            ),
            header = Buffer.alloc(4)
          if (body.length > 8192) throw new Error("The native request exceeded its bound.")
          header.writeUInt32BE(body.length)
          child.stdin.write(Buffer.concat([header, body]))
          continue
        }
        diagnostic.phase = "result"
        if (
          value.id !== 1 ||
          value.check !== "native-os-stop" ||
          !exact(value, ["id", "ok", "protocol", "check", "skipped", "reason", "capture"])
        )
          throw new Error("The finite native result is invalid.")
        outcome({
          ok: value.ok,
          ...(value.skipped === undefined ? {} : { skipped: value.skipped }),
          ...(value.reason === undefined ? {} : { reason: value.reason }),
        })
        if (value.ok && !ready) throw new Error("A native result cannot skip parent admission.")
        final = value
      }
    } catch {
      kill("stream_invalid")
    }
  })
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", (error) => {
        diagnostic.failure ??= { phase: "spawn", cause: "spawn_error" }
        reject(error)
      })
      child.once("close", (code) => resolve(code))
    })
    diagnostic.phase = "exit"
    if (failed || buffer.length || !final) {
      diagnostic.failure ??= { phase: "exit", cause: "exit_incomplete" }
      throw new Error("The finite native driver did not finish cleanly.")
    }
    const result = final as Record<string, unknown>
    const stop = outcome({
      ok: result.ok,
      ...(result.skipped === undefined ? {} : { skipped: result.skipped }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    })
    const capture: Outcome =
      process.platform === "win32"
        ? { ok: false, skipped: true, reason: "not_applicable" }
        : result.capture !== undefined
          ? outcome(result.capture)
          : stop.skipped
            ? { ...stop }
            : { ok: false, reason: "native_proof_invalid" }
    const receiptOutcome = (value: Record<string, unknown>) => ({
      ok: value.ok,
      ...(value.skipped === undefined ? {} : { skipped: value.skipped }),
      ...(value.reason === undefined ? {} : { reason: value.reason }),
    })
    emitNativeDiagnostic({
      protocol: 1,
      kind: "result",
      phase: "exit",
      stop: receiptOutcome(result),
      ...(record(result.capture) ? { capture: receiptOutcome(result.capture) } : {}),
      exitCode: status,
    })
    const expected =
      (!stop.ok && !stop.skipped) || (!capture.ok && !capture.skipped) ? 1 : stop.skipped || capture.skipped ? 77 : 0
    // Windows's non-applicable capture is a parent-only catalog entry, not an extra driver skip.
    if (status !== (process.platform === "win32" ? (stop.ok ? 0 : stop.skipped ? 77 : 1) : expected)) {
      diagnostic.failure ??= { phase: "exit", cause: "exit_mismatch" }
      throw new Error("The native result disagrees with its process exit.")
    }
    return { stop, capture }
  } catch (error) {
    diagnostic.failure ??= { phase: diagnostic.phase, cause: "exception" }
    throw error
  } finally {
    diagnostic.phase = "cleanup"
    clearTimeout(timer)
    child.stdin.destroy()
    if (child.exitCode === null) child.kill("SIGKILL")
  }
}
