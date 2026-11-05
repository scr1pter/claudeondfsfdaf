#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  COMPUTER_SMOKE_LIMIT_MS,
  COMPUTER_SMOKE_MARK,
  COMPUTER_SMOKE_PHASE_MARK,
  COMPUTER_SMOKE_CONTROLLER_MARK,
  parseComputerSmokeController,
  type ComputerSmokeControllerStep,
  COMPUTER_SMOKE_FAILURE_MARK,
  COMPUTER_SMOKE_LOADER_STARTED,
  computerSmokeBootstrapSource,
  parseComputerSmokeReport,
  parseComputerSmokePhase,
  parseComputerSmokeFailure,
  computerSmokeRuntimeHint,
  type ComputerSmokeLastPhase,
  type ComputerSmokeFailureCause,
  type ComputerSmokeRuntimeHint,
  type ComputerSmokeFailureDiagnostic,
  type ComputerSmokeLoaderModule,
} from "./computer-overlay-smoke-report"
import { parseComputerOverlayBootstrapUnavailable, verifyComputerOverlayStage } from "./computer-overlay-smoke-stage"
import { computerOverlayBundlePlan, type OverlayCompiler } from "./build-computer-overlay-smoke"
import { COMPUTER_SMOKE_SAMPLE_MARK, sampleOwnedComputerSmoke } from "./computer-overlay-smoke-sample"

// Compiler-only module-local type; no Bun globals are added to renderer or Node declarations.
declare const Bun: OverlayCompiler

class ComputerSmokeRunFailure extends Error {
  constructor(readonly diagnostic: ComputerSmokeFailureDiagnostic) {
    super("The bounded computer smoke failed.")
  }
}
function failureDiagnostic(
  cause: ComputerSmokeFailureCause,
  phase: ComputerSmokeLastPhase,
  hint: ComputerSmokeRuntimeHint,
  module?: ComputerSmokeLoaderModule,
): ComputerSmokeFailureDiagnostic {
  return { protocol: 1, cause, phase, hint, ...(module === undefined ? {} : { module }) }
}
function emitFailure(diagnostic: ComputerSmokeFailureDiagnostic) {
  process.stderr.write(COMPUTER_SMOKE_FAILURE_MARK + JSON.stringify(diagnostic) + "\n")
}

/** CI only: Bun compiles; Electron and its embedded actual Node own every child runtime. */
export async function runComputerOverlaySmoke(args = process.argv.slice(2)) {
  let nativeStage: string | undefined
  const flags = new Set<string>()
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    if (argument === "--native-stage") {
      const value = args[++index]
      if (nativeStage || !value || value.startsWith("--") || value.includes("\0"))
        throw new Error("The computer smoke native stage argument is invalid.")
      nativeStage = path.resolve(value)
    } else if (["--require-native", "--no-sandbox"].includes(argument) && !flags.has(argument)) flags.add(argument)
    else throw new Error("The computer overlay smoke received unsupported arguments.")
  }
  if (nativeStage && (process.platform === "linux" || flags.has("--no-sandbox")))
    throw new Error("A native computer smoke stage requires its actual sandboxed host.")
  if (process.env.CI !== "true" && process.env.VECTOR_COMPUTER_TEST_ISOLATED !== "1")
    throw new Error("The computer overlay smoke requires an explicitly isolated test environment.")
  if (!["darwin", "win32", "linux"].includes(process.platform))
    throw new Error("The computer overlay smoke platform is unsupported.")
  const require = createRequire(import.meta.url)
  const packageFile = require.resolve("electron/package.json")
  const electronDirectory = path.dirname(packageFile)
  const installed: unknown = JSON.parse(await readFile(packageFile, "utf8"))
  const desktop: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  if (
    !installed ||
    typeof installed !== "object" ||
    !("version" in installed) ||
    !desktop ||
    typeof desktop !== "object" ||
    !("devDependencies" in desktop) ||
    !desktop.devDependencies ||
    typeof desktop.devDependencies !== "object" ||
    !("electron" in desktop.devDependencies) ||
    typeof installed.version !== "string" ||
    installed.version !== desktop.devDependencies.electron
  )
    throw new Error("The computer smoke requires the repository's exact pinned Electron.")
  const recorded = path.join(electronDirectory, "path.txt")
  if (!existsSync(recorded)) throw new Error("The pinned Electron executable is not installed.")
  const binary = await realpath(path.join(electronDirectory, "dist", readFileSync(recorded, "utf8").trim()))
  const distribution = await realpath(path.join(electronDirectory, "dist"))
  if (!binary.startsWith(distribution + path.sep))
    throw new Error("The pinned Electron executable escaped its distribution.")
  const directory = await mkdtemp(path.join(tmpdir(), "vector-computer-overlay-smoke-"))
  try {
    let stage: Awaited<ReturnType<typeof verifyComputerOverlayStage>> | undefined
    if (nativeStage) {
      if (
        (process.platform !== "darwin" && process.platform !== "win32") ||
        (process.arch !== "x64" && process.arch !== "arm64")
      )
        throw new Error("The native computer smoke host is unsupported.")
      await verifyComputerOverlayStage(nativeStage, { platform: process.platform, architecture: process.arch })
      await cp(nativeStage, directory, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true })
      stage = await verifyComputerOverlayStage(directory, { platform: process.platform, architecture: process.arch })
    } else {
      await mkdir(path.join(directory, "smoke"), { recursive: true })
      if (typeof Bun === "undefined" || typeof Bun.build !== "function")
        throw new Error("The computer smoke requires its Bun compiler.")
      for (const { entry, options } of computerOverlayBundlePlan(
        fileURLToPath(new URL("../", import.meta.url)),
        path.join(directory, "smoke"),
      )) {
        const built = await Bun.build(options)
        if (!built.success || built.outputs.length !== 1)
          throw new Error("The computer overlay smoke did not compile exactly its fixed bundle.")
        if ((await realpath(built.outputs[0]!.path)) !== (await realpath(path.join(directory, "smoke", entry.output))))
          throw new Error("The computer overlay smoke emitted an unexpected bundle path.")
      }
    }
    const genericEntry = path.join(directory, "smoke", "computer-overlay-smoke-bootstrap.cjs")
    if (!stage) await writeFile(genericEntry, computerSmokeBootstrapSource(), { flag: "wx" })
    await mkdir(path.join(directory, "profile", "session"), { recursive: true })
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      DISPLAY: process.env.DISPLAY ?? "",
      ...(process.platform === "linux" && process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
      ...(process.platform === "linux" && process.env.XDG_RUNTIME_DIR
        ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }
        : {}),
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      VECTOR_COMPUTER_SMOKE_PROFILE: path.join(directory, "profile"),
      VECTOR_COMPUTER_SMOKE_REQUIRE_NATIVE: flags.has("--require-native") ? "1" : "0",
      VECTOR_COMPUTER_TEST_ISOLATED: process.env.VECTOR_COMPUTER_TEST_ISOLATED === "1" ? "1" : "0",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
      ...(process.env.TEMP ? { TEMP: directory, TMP: directory } : {}),
    }
    const bootstrapStage = process.platform === "win32" ? stage : undefined
    const bootstrap = bootstrapStage !== undefined
    const nonce = randomBytes(32).toString("hex")
    const executable = bootstrapStage?.driver ?? stage?.electron ?? binary
    const childArgs = bootstrapStage
      ? ["--launch-electron", "--nonce", nonce]
      : [
          stage?.main ?? genericEntry,
          `--user-data-dir=${path.join(directory, "profile")}`,
          ...(flags.has("--no-sandbox") ? ["--no-sandbox"] : []),
        ]
    const child = spawn(executable, childArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
      windowsHide: true,
    })
    const output: Buffer[] = []
    let outputBytes = 0,
      stdout = "",
      pendingLine = "",
      stderrTail = "",
      stderrBytes = 0
    let lastPhase: ComputerSmokeLastPhase = "none",
      hint: ComputerSmokeRuntimeHint = "none"
    let lastController: ComputerSmokeControllerStep | undefined
    let forcedCause: ComputerSmokeFailureCause | undefined
    const streamState: { childFailure?: ComputerSmokeFailureDiagnostic; loaderStarted: boolean } = {
      loaderStarted: false,
    }
    let childRunning = true
    let sampleTimer: ReturnType<typeof setTimeout> | undefined
    let sampleArmed = false
    const sampleAbort = new AbortController()
    const cancelSample = () => {
      if (sampleTimer) clearTimeout(sampleTimer)
      sampleTimer = undefined
      sampleAbort.abort()
    }
    const sampleHeartbeatStall = () => {
      if (process.platform !== "darwin") return
      sampleArmed = true
      // A healthy/failed five-second loss check has already advanced by this point.
      sampleTimer = setTimeout(() => {
        sampleTimer = undefined
        if (!childRunning || !child.pid || sampleAbort.signal.aborted) return
        void sampleOwnedComputerSmoke({
          pid: child.pid,
          alive: () => childRunning && child.exitCode === null && child.signalCode === null,
          signal: sampleAbort.signal,
        }).then(
          (report) => process.stdout.write(COMPUTER_SMOKE_SAMPLE_MARK + JSON.stringify(report) + "\n"),
          () =>
            process.stdout.write(
              COMPUTER_SMOKE_SAMPLE_MARK +
                JSON.stringify({
                  protocol: 1,
                  step: "heartbeat-check",
                  status: "failed",
                  mainThread: false,
                  frames: [],
                }) +
                "\n",
            ),
        )
      }, 7000)
    }
    child.once("exit", () => {
      childRunning = false
      cancelSample()
    })
    child.once("error", () => {
      childRunning = false
      cancelSample()
    })
    const fail = (cause: ComputerSmokeFailureCause) => {
      forcedCause ??= cause
      cancelSample()
      child.kill("SIGKILL")
    }
    const hintPriority = (value: ComputerSmokeRuntimeHint) =>
      value === "none"
        ? 0
        : value === "loader_pending"
          ? 1
          : value === "display_unavailable"
            ? 2
            : value === "loader_failed"
              ? 3
              : value === "sandbox_unavailable"
                ? 5
                : value === "display_auth"
                  ? 6
                  : 4
    child.stdout.on("data", (bytes: Buffer) => {
      if (outputBytes + bytes.length > 65_536) return fail("stdout_limit")
      output.push(bytes)
      outputBytes += bytes.length
      const text = bytes.toString("utf8")
      stdout += text
      pendingLine += text
      let newline: number
      while ((newline = pendingLine.indexOf("\n")) >= 0) {
        const line = pendingLine.slice(0, newline).replace(/\r$/, "")
        pendingLine = pendingLine.slice(newline + 1)
        try {
          if (line.startsWith(COMPUTER_SMOKE_LOADER_STARTED)) {
            if (
              line !== COMPUTER_SMOKE_LOADER_STARTED ||
              stage ||
              streamState.loaderStarted ||
              streamState.childFailure ||
              lastPhase !== "none"
            )
              throw new Error("The generic loader receipt is invalid.")
            streamState.loaderStarted = true
            if (hint === "none") hint = "loader_pending"
            process.stdout.write(COMPUTER_SMOKE_LOADER_STARTED + "\n")
          } else if (line.startsWith(COMPUTER_SMOKE_PHASE_MARK)) {
            if (streamState.childFailure) throw new Error("A terminal computer smoke receipt cannot advance.")
            lastPhase = parseComputerSmokePhase(line, lastPhase)
            if (lastPhase === "cleanup" || lastPhase === "report") cancelSample()
            if (hint === "loader_pending") hint = "none"
            process.stdout.write(COMPUTER_SMOKE_PHASE_MARK + JSON.stringify({ protocol: 1, phase: lastPhase }) + "\n")
          } else if (line.startsWith(COMPUTER_SMOKE_CONTROLLER_MARK)) {
            if (lastPhase !== "controller" || streamState.childFailure)
              throw new Error("The controller receipt is out of phase.")
            lastController = parseComputerSmokeController(line, lastController)
            if (lastController === "heartbeat-check") sampleHeartbeatStall()
            else if (sampleArmed) cancelSample()
            process.stdout.write(
              COMPUTER_SMOKE_CONTROLLER_MARK + JSON.stringify({ protocol: 1, step: lastController }) + "\n",
            )
          } else if (line.startsWith(COMPUTER_SMOKE_FAILURE_MARK)) {
            const received = parseComputerSmokeFailure(line)
            const bootstrapFailure =
              !stage &&
              streamState.loaderStarted &&
              received.phase === "none" &&
              received.cause === "runtime_failed" &&
              received.hint.startsWith("loader_") &&
              received.hint !== "loader_pending"
            const entryFailure =
              received.phase === lastPhase &&
              received.hint === "none" &&
              received.module === undefined &&
              ["deadline_exceeded", "runtime_failed"].includes(received.cause)
            if (streamState.childFailure || !(bootstrapFailure || entryFailure))
              throw new Error("The child failure receipt is invalid.")
            if (hintPriority(received.hint) > hintPriority(hint)) hint = received.hint
            streamState.childFailure = received
            cancelSample()
          }
        } catch {
          return fail("invalid_progress")
        }
      }
    })
    child.stderr.on("data", (bytes: Buffer) => {
      stderrBytes += bytes.length
      stderrTail = (stderrTail + bytes.toString("utf8")).slice(-8192)
      const observed = computerSmokeRuntimeHint(stderrTail)
      if (hintPriority(observed) > hintPriority(hint)) hint = observed
      if (stderrBytes > 1024 * 1024) fail("stderr_limit")
    })
    child.stdout.on("error", () => fail("runtime_failed"))
    child.stderr.on("error", () => fail("runtime_failed"))
    const timer = setTimeout(() => fail("deadline_exceeded"), COMPUTER_SMOKE_LIMIT_MS)
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", () =>
        reject(new ComputerSmokeRunFailure(failureDiagnostic("launch_failed", lastPhase, hint))),
      )
      child.once("close", (code) => resolve(code))
    }).finally(() => {
      clearTimeout(timer)
      cancelSample()
    })
    stderrTail = ""
    if (forcedCause) throw new ComputerSmokeRunFailure(failureDiagnostic(forcedCause, lastPhase, hint))
    if (streamState.childFailure)
      throw new ComputerSmokeRunFailure(
        failureDiagnostic(streamState.childFailure.cause, lastPhase, hint, streamState.childFailure.module),
      )
    if (
      pendingLine.startsWith(COMPUTER_SMOKE_PHASE_MARK) ||
      pendingLine.startsWith(COMPUTER_SMOKE_CONTROLLER_MARK) ||
      pendingLine.startsWith(COMPUTER_SMOKE_FAILURE_MARK) ||
      pendingLine.startsWith(COMPUTER_SMOKE_LOADER_STARTED)
    )
      throw new ComputerSmokeRunFailure(failureDiagnostic("invalid_progress", lastPhase, hint))
    const unavailable = bootstrap ? parseComputerOverlayBootstrapUnavailable(Buffer.concat(output), exit) : undefined
    if (unavailable) {
      // No Electron property assertion ran. This distinct bounded prerequisite report must never
      // be interpreted as a complete successful computer-smoke catalog.
      process.stdout.write("computer-smoke-unavailable " + JSON.stringify(unavailable) + "\n")
      return flags.has("--require-native") ? 1 : 77
    }
    let report: ReturnType<typeof parseComputerSmokeReport>
    try {
      report = parseComputerSmokeReport(stdout, {
        electron: installed.version,
        platform: process.platform,
        exitCode: exit,
      })
    } catch {
      const cause = stdout.split(/\r?\n/).some((line) => line.startsWith(COMPUTER_SMOKE_MARK))
        ? "invalid_report"
        : "missing_report"
      throw new ComputerSmokeRunFailure(failureDiagnostic(cause, lastPhase, hint))
    }
    process.stdout.write(COMPUTER_SMOKE_MARK + JSON.stringify(report) + "\n")
    const failed = report.checks.some((check) => !check.ok && !check.skipped)
    const missingNative =
      flags.has("--require-native") &&
      report.checks.some(
        (check) =>
          check.skipped &&
          (check.name === "native-os-stop" ||
            (check.name === "native-capture-exclusion" && report.platform === "darwin")),
      )
    if (failed || missingNative)
      emitFailure(failureDiagnostic(failed ? "assertion_failed" : "required_native_unavailable", lastPhase, hint))
    return failed || missingNative ? 1 : 0
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void runComputerOverlaySmoke().then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      emitFailure(
        error instanceof ComputerSmokeRunFailure ? error.diagnostic : failureDiagnostic("setup_failed", "none", "none"),
      )
      process.exitCode = 1
    },
  )
