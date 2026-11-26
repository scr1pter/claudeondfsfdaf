#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import desktop from "../package.json"
import {
  COMPUTER_SMOKE_CONTROLLER_MARK,
  COMPUTER_SMOKE_FAILURE_MARK,
  COMPUTER_SMOKE_MARK,
  COMPUTER_SMOKE_NATIVE_MARK,
  parseComputerSmokeFailure,
  parseComputerSmokeNativeDiagnostic,
  parseComputerSmokeReport,
  type ComputerSmokeDriverCause,
  type ComputerSmokeDriverStage,
  type ComputerSmokeDriverUiaFailure,
} from "./computer-overlay-smoke-report"
import { COMPUTER_OVERLAY_STAGE_MANIFEST } from "./computer-overlay-smoke-stage"

const UNAVAILABLE = "computer-smoke-unavailable "
const ROW = "computer-smoke-stop-repeat "
const TOTAL = "computer-smoke-stop-repeat-total "
const OUTPUT_LIMIT = 128 * 1024
const NATIVE_PROOF_START = COMPUTER_SMOKE_CONTROLLER_MARK + JSON.stringify({ protocol: 1, step: "native-proof" })
// Leave room for a complete final smoke and cleanup inside the separate 35-minute step.
const START_LIMIT_MS = 30 * 60 * 1000

type SmokeProcess = {
  stdout: string
  stderr: string
  exitCode: number | null
  overflow?: boolean
  nativeProofMs?: number
}
type Observation = {
  status: "passed" | "hf7" | "failed" | "skipped" | "invalid" | "timeout"
  stage: ComputerSmokeDriverStage | null
  uia: ComputerSmokeDriverUiaFailure | null
  cause?: ComputerSmokeDriverCause
  reason?: string
}

export function computerStopRepeatCount(value: string) {
  if (!/^([1-9]|[1-4][0-9]|50)$/.test(value)) throw new Error("stop_repeat must be an integer from 1 to 50.")
  return Number(value)
}

/** Classify only closed smoke receipts. Raw subprocess output never reaches the job log. */
export function observeComputerStop(result: SmokeProcess): Observation {
  const empty = { stage: null, uia: null }
  const invalid = (reason: string): Observation => ({ ...empty, status: "invalid", reason })
  if (result.overflow) return invalid("output_limit")
  const lines = result.stdout.split(/\r?\n/)
  const reportLines = lines.filter((line) => line.startsWith(COMPUTER_SMOKE_MARK))
  const unavailable = lines.filter((line) => line.startsWith(UNAVAILABLE))
  const nativeLines = lines.filter((line) => line.startsWith(COMPUTER_SMOKE_NATIVE_MARK))
  const failures = result.stderr.split(/\r?\n/).filter((line) => line.startsWith(COMPUTER_SMOKE_FAILURE_MARK))
  if (reportLines.length > 1 || unavailable.length > 1 || failures.length > 1 || nativeLines.length > 1)
    return invalid("ambiguous_evidence")
  try {
    if (unavailable[0]) {
      const reason = bootstrapSkip(unavailable[0], result.exitCode)
      if (reportLines.length || nativeLines.length || failures.length || !reason) return invalid("invalid_skip")
      return { ...empty, status: "skipped", reason }
    }
    const diagnostic = nativeLines[0] ? parseComputerSmokeNativeDiagnostic(nativeLines[0], "win32") : undefined
    const failure = failures[0] ? parseComputerSmokeFailure(failures[0]) : undefined
    if (
      result.exitCode === 1 &&
      (failure?.cause === "deadline_exceeded" ||
        (diagnostic?.kind === "boundary" && diagnostic.cause === "deadline_exceeded"))
    )
      return { ...empty, status: "timeout", reason: "deadline_exceeded" }
    if (diagnostic?.kind === "boundary") return invalid(diagnostic.cause)
    if (!reportLines[0]) return invalid(failure?.cause ?? "missing_report")
    if (failure && (result.exitCode !== 1 || failure.cause !== "assertion_failed"))
      return invalid("inconsistent_report")
    const report = parseComputerSmokeReport(reportLines[0], {
      electron: desktop.devDependencies.electron,
      platform: "win32",
      exitCode: result.exitCode,
    })
    if (
      report.checks.some(
        (check) =>
          check.name !== "native-os-stop" && check.name !== "native-capture-exclusion" && !check.ok && !check.skipped,
      )
    )
      return invalid("other_smoke_assertion")
    const check = report.checks.find((entry) => entry.name === "native-os-stop")!
    const capture = report.checks.find((entry) => entry.name === "native-capture-exclusion")!
    // A failed Windows Stop may also mark the unused capture assertion native_proof_invalid.
    // A passed or skipped Stop must instead retain Windows's not-applicable capture row.
    if ((check.ok || check.skipped) && capture.reason !== "not_applicable") return invalid("inconsistent_capture")
    if (!diagnostic) {
      if (check.skipped) return { ...empty, status: "skipped", reason: check.reason }
      return invalid("missing_native_result")
    }
    const stop = diagnostic.stop
    if (
      diagnostic.exitCode !== (stop.ok ? 0 : stop.skipped ? 77 : 1) ||
      check.skipped !== stop.skipped ||
      (check.ok && !stop.ok)
    )
      return invalid("inconsistent_stop")
    if (check.skipped) return { ...empty, status: "skipped", reason: check.reason }
    if (check.ok) return { ...empty, status: "passed" }
    const hf7 =
      (stop.stage === "uia-root-element" ||
        stop.stage === "uia-runtime-id" ||
        stop.stage === "uia-prepare-connection") &&
      stop.cause === "core_failure:no_ui_tree" &&
      stop.uia?.lookup === "first" &&
      stop.uia.call === "root" &&
      stop.uia.actor === "retired"
    return {
      status: hf7 ? "hf7" : "failed",
      stage: stop.stage ?? null,
      uia: stop.uia ?? null,
      ...(stop.cause ? { cause: stop.cause } : {}),
      reason: check.reason,
    }
  } catch {
    return invalid("malformed_evidence")
  }
}

function bootstrapSkip(line: string, exitCode: number | null) {
  if (exitCode !== 77 || line.length > 256) return
  const value: unknown = JSON.parse(line.slice(UNAVAILABLE.length))
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const receipt = value as Record<string, unknown>
  if (
    Object.keys(receipt).sort().join(",") !== "platform,protocol,reason,skipped" ||
    receipt.protocol !== 1 ||
    receipt.platform !== "win32" ||
    receipt.skipped !== true
  )
    return
  if (
    receipt.reason === "elevated_fixture" ||
    receipt.reason === "isolated_desktop_required" ||
    receipt.reason === "native_target_unavailable"
  )
    return receipt.reason
}

export async function measureComputerStop(
  count: string,
  run: () => Promise<SmokeProcess>,
  write: (line: string) => void,
  options: { stageAvailable: boolean; now?: () => number },
) {
  const requested = computerStopRepeatCount(count)
  if (requested === 1) return 0
  const now = options.now ?? (() => performance.now())
  const start = now()
  const counts = { passed: 0, hf7: 0, failed: 0, skipped: 0, invalid: 0, timeout: 0 }
  let completed = 0
  while (completed < requested && options.stageAvailable && now() - start < START_LIMIT_MS) {
    const started = now()
    const result = await run().catch(() => undefined)
    const outcome: Observation = result
      ? observeComputerStop(result)
      : { status: "invalid", stage: null, uia: null, reason: "spawn_error" }
    counts[outcome.status]++
    completed++
    write(
      ROW +
        JSON.stringify({
          sample: completed,
          elapsedMs: Math.round(now() - started),
          ...outcome,
          ...(outcome.status !== "invalid" && result?.nativeProofMs !== undefined
            ? { nativeProofMs: result.nativeProofMs }
            : {}),
        }),
    )
  }
  const usable = counts.passed + counts.hf7 + counts.failed
  write(
    TOTAL +
      JSON.stringify({
        requested,
        completed,
        usable,
        ...counts,
        elapsedMs: Math.round(now() - start),
        ...(completed !== requested
          ? { incomplete: options.stageAvailable ? "step_budget" : "stage_unavailable" }
          : {}),
      }),
  )
  return usable === requested ? 0 : 1
}

const stage = new URL("../native/out/overlay-win32/", import.meta.url)

function runFreshSmoke(): Promise<SmokeProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--no-env-file",
        fileURLToPath(new URL("./computer-overlay-smoke.ts", import.meta.url)),
        "--native-stage",
        fileURLToPath(stage),
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: { ...process.env, VECTOR_COMPUTER_SMOKE_MOVE_PROBE: "0" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    )
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let pending = ""
    let nativeStart: number | undefined
    let nativeProofMs: number | undefined
    const capture = (chunks: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes <= OUTPUT_LIMIT) chunks.push(chunk)
    }
    const captureStdout = capture(stdout)
    child.stdout.on("data", (chunk: Buffer) => {
      captureStdout(chunk)
      if (bytes > OUTPUT_LIMIT) return
      // These ASCII milestones are printed by the already-validated smoke collector.
      // Measure their arrival in the same stream; chunk coalescing can give a value of zero.
      const lines = (pending + chunk.toString("utf8")).split(/\r?\n/)
      pending = lines.pop()!
      const arrived = performance.now()
      for (const line of lines) {
        if (line === NATIVE_PROOF_START) nativeStart ??= arrived
        if (nativeStart !== undefined && line.startsWith(COMPUTER_SMOKE_NATIVE_MARK))
          nativeProofMs ??= Math.round(arrived - nativeStart)
      }
    })
    child.stderr.on("data", capture(stderr))
    child.on("error", reject)
    child.on("close", (exitCode) =>
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        overflow: bytes > OUTPUT_LIMIT,
        nativeProofMs,
      }),
    )
  })
}

if (import.meta.main) {
  if (
    process.platform !== "win32" ||
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    process.env.VECTOR_COMPUTER_TEST_ISOLATED !== "1" ||
    process.argv.length !== 3
  )
    throw new Error("The Stop repeat measurement requires one count and an isolated Windows CI runner.")
  process.exitCode = await measureComputerStop(process.argv[2]!, runFreshSmoke, (line) => console.log(line), {
    stageAvailable: existsSync(new URL(COMPUTER_OVERLAY_STAGE_MANIFEST, stage)),
  })
}
