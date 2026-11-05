import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { mkdir, open } from "node:fs/promises"
import path from "node:path"

export const NATIVE_UNIT_SUITES = [
  "runCommandLineTests",
  "runProtocolTests",
  "runServerTests",
  "runLifecycleTests",
  "runPackagedSelfTestTests",
  "runPrivilegedSelfTestTests",
  "runOverlayDriverPolicyTests",
  "runBlocklistTests",
  "runPermissionsTests",
  "runGeometryTests",
  "runCaptureTests",
  "runAccessibilityRegistryTests",
  "runAccessibilityTests",
  "runAccessibilityTextTests",
  "runMenuSafetyTests",
  "runHeldInputTests",
  "runInputTests",
  "runInputKeySafetyTests",
  "runHostOwnershipTests",
  "runProgramLaunchRegistryTests",
  "runAppsTests",
  "runClipboardTests",
  "runEventTapTests",
  "runWatchdogTests",
] as const
const waitCategories = ["dispatch-wait", "mutex-wait", "condition-wait", "pipe-io", "process-wait", "run-loop"] as const
const triggers = ["complete", "wall-deadline", "output-cap", "spawn-failed", "io-error"] as const
const sampleStates = [
  "not-requested",
  "not-started",
  "target-exited",
  "unavailable",
  "sampled",
  "deadline",
  "output-cap",
  "failed",
] as const
type UnitSuite = (typeof NATIVE_UNIT_SUITES)[number]
type WaitCategory = (typeof waitCategories)[number]
export type NativeUnitSample = {
  status: (typeof sampleStates)[number]
  suites: UnitSuite[]
  waits: WaitCategory[]
}
export type NativeUnitProgress = {
  entered: boolean
  passed: number
  active?: UnitSuite
  // The COMPLETE marker is evidence of aggregate progress, never a substitute for actual exit.
  complete: boolean
  invalid: boolean
}
export type NativeCommandDiagnostic = {
  schemaVersion: 1
  trigger: (typeof triggers)[number]
  spawned: boolean
  exitObserved: boolean
  closeObserved: boolean
  signaled: boolean
  stdoutBytes: number
  stderrBytes: number
  elapsedMs: number
  exitAfterMs?: number
  closeAfterMs?: number
  sample: NativeUnitSample
  progress?: NativeUnitProgress
}
export type ObservedNativeCommand = { executable: string; args: readonly string[]; timeoutMs?: number }
export type ObservedNativeResult = {
  code: number | null
  stdout: string
  timedOut?: boolean
  diagnostic: NativeCommandDiagnostic
}
type OwnedUnitProcess = { pid: number; alive: () => boolean; signal: AbortSignal }
export type OwnedUnitSampler = (process: OwnedUnitProcess) => Promise<NativeUnitSample>
type CommandObservations = {
  // Installed only for the already verified unit executable, never for an arbitrary helper operation.
  sampleUnit?: boolean
  observeUnitProgress?: boolean
  sampler?: OwnedUnitSampler
  sampleAfterMs?: number
  outputLimitBytes?: number
}
const outputLimitBytes = 1_048_576
const sampleLimitBytes = 262_144
const emptySample = (status: NativeUnitSample["status"]): NativeUnitSample => ({ status, suites: [], waits: [] })
const count = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)))
const exact = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key))
const progressPrefix = "vector-unit-progress "

/** Accept only an exact ordered protocol; arbitrary stderr never becomes a suite or a report field. */
export function nativeUnitProgress(value: unknown): NativeUnitProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native unit progress.")
  const body = value as Record<string, unknown>
  if (
    !exact(body, ["entered", "passed", "active", "complete", "invalid"]) ||
    ["entered", "complete", "invalid"].some((key) => typeof body[key] !== "boolean") ||
    !Number.isSafeInteger(body.passed) ||
    Number(body.passed) < 0 ||
    Number(body.passed) > NATIVE_UNIT_SUITES.length ||
    (!body.entered && (body.passed !== 0 || body.active !== undefined || body.complete)) ||
    (body.active !== undefined &&
      (!body.entered || body.complete || body.active !== NATIVE_UNIT_SUITES[Number(body.passed)])) ||
    (body.complete && (body.invalid || body.passed !== NATIVE_UNIT_SUITES.length))
  )
    throw new Error("Invalid native unit progress.")
  return {
    entered: body.entered as boolean,
    passed: body.passed as number,
    ...(body.active === undefined ? {} : { active: body.active as UnitSuite }),
    complete: body.complete as boolean,
    invalid: body.invalid as boolean,
  }
}

export class NativeUnitProgressReader {
  private value: NativeUnitProgress = { entered: false, passed: 0, complete: false, invalid: false }
  private line = ""
  private overflow = false
  private ended = false
  private remaining = outputLimitBytes

  private invalid() {
    this.value.invalid = true
    this.value.complete = false
  }
  private accept(line: string) {
    if (!line.startsWith(progressPrefix)) return
    if (line === progressPrefix + "ENTER" && !this.value.entered) {
      this.value.entered = true
      return
    }
    if (this.value.entered && !this.value.complete) {
      const expected = NATIVE_UNIT_SUITES[this.value.passed]
      if (expected && !this.value.active && line === progressPrefix + "BEGIN " + expected) {
        this.value.active = expected
        return
      }
      if (this.value.active && line === progressPrefix + "PASS " + this.value.active) {
        this.value.passed++
        delete this.value.active
        return
      }
      if (!expected && !this.value.active && line === progressPrefix + "COMPLETE") {
        this.value.complete = true
        return
      }
    }
    this.invalid()
  }
  consume(bytes: Uint8Array) {
    if (this.ended || this.value.invalid) return
    const bounded = bytes.subarray(0, this.remaining)
    this.remaining -= bounded.length
    for (const byte of bounded) {
      if (byte === 10) {
        if (this.overflow) {
          if (this.line.startsWith(progressPrefix)) this.invalid()
        } else this.accept(this.line.endsWith("\r") ? this.line.slice(0, -1) : this.line)
        this.line = ""
        this.overflow = false
        if (this.value.invalid) return
      } else if (this.line.length < 128) this.line += String.fromCharCode(byte)
      else this.overflow = true
    }
  }
  snapshot() {
    return nativeUnitProgress(this.value)
  }
  finish() {
    if (!this.ended && this.line.startsWith(progressPrefix)) this.invalid()
    this.ended = true
    this.line = ""
    this.overflow = false
    return this.snapshot()
  }
}

/** Only frame-shaped lines can contribute fixed symbols. The raw sample is never returned or written. */
export function sanitizeNativeUnitSample(raw: string): Pick<NativeUnitSample, "suites" | "waits"> {
  const frames = raw
    .slice(0, sampleLimitBytes)
    .split(/\r?\n/)
    .filter((line) => /^\s*[+!:| ]*\d+\s+/.test(line))
  const suites = NATIVE_UNIT_SUITES.filter((suite) => frames.some((line) => line.includes(suite)))
  const categories: [WaitCategory, RegExp][] = [
    ["dispatch-wait", /(?:_dispatch_semaphore_wait|dispatch_group_wait|__DISPATCH_WAIT_FOR_QUEUE__|dispatch_sync)/],
    ["mutex-wait", /(?:__psynch_mutexwait|pthread_mutex_lock|os_unfair_lock_lock|NSLock\.lock)/],
    ["condition-wait", /(?:__psynch_cvwait|pthread_cond_wait)/],
    ["pipe-io", /(?:\b(?:read|write|poll|select|kevent)\b|__(?:read|write)_nocancel)/],
    ["process-wait", /(?:\bwaitpid\b|__wait4)/],
    ["run-loop", /(?:mach_msg|CFRunLoopRun|RunLoop\.run)/],
  ]
  return {
    suites,
    waits: categories.filter(([, expression]) => frames.some((line) => expression.test(line))).map(([name]) => name),
  }
}

/** Closed output schema: arbitrary exceptions, argv, paths, PIDs, child text and stack lines cannot serialize. */
export function nativeCommandDiagnostic(value: unknown): NativeCommandDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid native command diagnostics.")
  const body = value as Record<string, unknown>
  if (
    !exact(body, [
      "schemaVersion",
      "trigger",
      "spawned",
      "exitObserved",
      "closeObserved",
      "signaled",
      "stdoutBytes",
      "stderrBytes",
      "elapsedMs",
      "exitAfterMs",
      "closeAfterMs",
      "sample",
      "progress",
    ]) ||
    body.schemaVersion !== 1 ||
    !triggers.includes(body.trigger as NativeCommandDiagnostic["trigger"]) ||
    ["spawned", "exitObserved", "closeObserved", "signaled"].some((key) => typeof body[key] !== "boolean") ||
    ["stdoutBytes", "stderrBytes", "elapsedMs"].some(
      (key) => !Number.isSafeInteger(body[key]) || Number(body[key]) < 0,
    ) ||
    ["exitAfterMs", "closeAfterMs"].some(
      (key) => body[key] !== undefined && (!Number.isSafeInteger(body[key]) || Number(body[key]) < 0),
    ) ||
    !body.sample ||
    typeof body.sample !== "object" ||
    Array.isArray(body.sample)
  )
    throw new Error("Invalid native command diagnostics.")
  const sample = body.sample as Record<string, unknown>
  if (
    !exact(sample, ["status", "suites", "waits"]) ||
    !sampleStates.includes(sample.status as NativeUnitSample["status"]) ||
    !Array.isArray(sample.suites) ||
    sample.suites.length > NATIVE_UNIT_SUITES.length ||
    new Set(sample.suites).size !== sample.suites.length ||
    sample.suites.some((value) => !NATIVE_UNIT_SUITES.includes(value as UnitSuite)) ||
    !Array.isArray(sample.waits) ||
    sample.waits.length > waitCategories.length ||
    new Set(sample.waits).size !== sample.waits.length ||
    sample.waits.some((value) => !waitCategories.includes(value as WaitCategory)) ||
    (sample.status !== "sampled" && (sample.suites.length !== 0 || sample.waits.length !== 0)) ||
    (body.closeObserved && !body.exitObserved && body.trigger !== "spawn-failed") ||
    (!body.spawned && (body.exitObserved || body.signaled)) ||
    body.exitObserved !== (body.exitAfterMs !== undefined) ||
    body.closeObserved !== (body.closeAfterMs !== undefined)
  )
    throw new Error("Invalid native command diagnostics.")
  return {
    schemaVersion: 1,
    trigger: body.trigger as NativeCommandDiagnostic["trigger"],
    spawned: body.spawned as boolean,
    exitObserved: body.exitObserved as boolean,
    closeObserved: body.closeObserved as boolean,
    signaled: body.signaled as boolean,
    stdoutBytes: body.stdoutBytes as number,
    stderrBytes: body.stderrBytes as number,
    elapsedMs: body.elapsedMs as number,
    ...(body.exitAfterMs === undefined ? {} : { exitAfterMs: body.exitAfterMs as number }),
    ...(body.closeAfterMs === undefined ? {} : { closeAfterMs: body.closeAfterMs as number }),
    sample: {
      status: sample.status as NativeUnitSample["status"],
      suites: NATIVE_UNIT_SUITES.filter((suite) => sample.suites instanceof Array && sample.suites.includes(suite)),
      waits: waitCategories.filter((wait) => sample.waits instanceof Array && sample.waits.includes(wait)),
    },
    ...(body.progress === undefined ? {} : { progress: nativeUnitProgress(body.progress) }),
  }
}

/** /usr/bin/sample observes only the same still-live child retained by the collector. No raw file is created. */
export async function sampleOwnedNativeUnit(target: OwnedUnitProcess): Promise<NativeUnitSample> {
  if (process.platform !== "darwin") return emptySample("unavailable")
  if (!Number.isSafeInteger(target.pid) || target.pid <= 1 || !target.alive() || target.signal.aborted)
    return emptySample("target-exited")
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/sample", [String(target.pid), "1", "10", "-file", "/dev/stdout"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    const chunks: Buffer[] = []
    let size = 0,
      ended = false
    const kill = () => {
      try {
        child.kill("SIGKILL")
      } catch {}
    }
    const finish = (sample: NativeUnitSample) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      target.signal.removeEventListener("abort", abort)
      kill()
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
      resolve(sample)
    }
    const abort = () => finish(emptySample("target-exited"))
    const timer = setTimeout(() => finish(emptySample("deadline")), 2000)
    target.signal.addEventListener("abort", abort, { once: true })
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > sampleLimitBytes) finish(emptySample("output-cap"))
      else chunks.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > sampleLimitBytes) finish(emptySample("output-cap"))
    })
    child.stdout.once("error", () => finish(emptySample("failed")))
    child.stderr.once("error", () => finish(emptySample("failed")))
    child.once("error", () => finish(emptySample("unavailable")))
    child.once("close", (code) =>
      finish(
        code === 0
          ? { status: "sampled", ...sanitizeNativeUnitSample(Buffer.concat(chunks).toString("utf8")) }
          : emptySample("failed"),
      ),
    )
    if (!target.alive() || target.signal.aborted) abort()
  })
}

/** A single unchanged command deadline. Exit and pipe closure are observed separately, including after kill. */
export async function runObservedNativeCommand(
  command: ObservedNativeCommand,
  options: CommandObservations = {},
): Promise<ObservedNativeResult> {
  if (/^(?:bun|bun\.exe)$/i.test(path.basename(command.executable)))
    throw new Error("Nested Bun processes are unavailable.")
  const timeout = command.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000)
    throw new Error("Invalid native command deadline.")
  const limit = options.outputLimitBytes ?? outputLimitBytes
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > outputLimitBytes)
    throw new Error("Invalid native command output bound.")
  const began = performance.now()
  return new Promise((resolve) => {
    const diagnostic: NativeCommandDiagnostic = {
      schemaVersion: 1,
      trigger: "complete",
      spawned: false,
      exitObserved: false,
      closeObserved: false,
      signaled: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      elapsedMs: 0,
      sample: emptySample(options.sampleUnit ? "not-started" : "not-requested"),
    }
    const child = spawn(command.executable, [...command.args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    })
    const chunks: Buffer[] = []
    const progress = options.sampleUnit || options.observeUnitProgress ? new NativeUnitProgressReader() : undefined
    const sampleAbort = new AbortController()
    let code: number | null = null,
      ended = false,
      sampled = false
    let sampling: ReturnType<typeof setTimeout> | undefined, sampleBudget: ReturnType<typeof setTimeout> | undefined
    const elapsed = () => count(performance.now() - began)
    const kill = () => {
      // Never retarget a recycled group leader after observing this child exit. A retained pipe is
      // diagnosed separately, then closed locally; it does not prove ownership of any later PID.
      if (diagnostic.exitObserved) return
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch {}
    }
    const finish = () => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      if (sampling) clearTimeout(sampling)
      if (sampleBudget) clearTimeout(sampleBudget)
      sampleAbort.abort()
      diagnostic.elapsedMs = elapsed()
      if (progress) diagnostic.progress = progress.finish()
      // The promise cannot wait forever for a descendant to retain an inherited pipe after exit.
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
      resolve({
        code: diagnostic.trigger === "io-error" ? null : code,
        stdout: Buffer.concat(chunks).toString("utf8"),
        ...(diagnostic.trigger === "wall-deadline" || diagnostic.trigger === "output-cap" ? { timedOut: true } : {}),
        diagnostic: nativeCommandDiagnostic(diagnostic),
      })
    }
    const stop = (trigger: NativeCommandDiagnostic["trigger"]) => {
      if (ended) return
      if (diagnostic.trigger === "complete") diagnostic.trigger = trigger
      kill()
      finish()
    }
    const timer = setTimeout(() => stop("wall-deadline"), Math.max(0, timeout - elapsed()))
    const capture = (chunk: Buffer, stdout: boolean) => {
      if (ended) return
      const remaining = Math.max(0, limit - diagnostic.stdoutBytes - diagnostic.stderrBytes)
      if (stdout) diagnostic.stdoutBytes = count(diagnostic.stdoutBytes + chunk.length)
      else diagnostic.stderrBytes = count(diagnostic.stderrBytes + chunk.length)
      if (!stdout) progress?.consume(chunk.subarray(0, remaining))
      if (diagnostic.stdoutBytes + diagnostic.stderrBytes > limit) {
        stop("output-cap")
        return
      }
      if (stdout) chunks.push(chunk)
    }
    child.stdout.on("data", (chunk: Buffer) => capture(chunk, true))
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, false))
    child.stdout.once("error", () => stop("io-error"))
    child.stderr.once("error", () => stop("io-error"))
    child.once("spawn", () => {
      diagnostic.spawned = true
      if (!options.sampleUnit || !child.pid) return
      const after = options.sampleAfterMs ?? Math.max(0, timeout - 2500)
      if (!Number.isSafeInteger(after) || after < 0 || after >= timeout) return
      sampling = setTimeout(
        () => {
          if (ended || diagnostic.exitObserved || !child.pid) return
          sampled = true
          diagnostic.sample = emptySample("deadline")
          const sampler = options.sampler ?? sampleOwnedNativeUnit
          sampleBudget = setTimeout(() => sampleAbort.abort(), Math.min(2000, Math.max(1, timeout - elapsed())))
          Promise.resolve()
            .then(() =>
              sampler({
                pid: child.pid!,
                alive: () => !ended && !diagnostic.exitObserved && child.exitCode === null && child.signalCode === null,
                signal: sampleAbort.signal,
              }),
            )
            .then(
              (value) => {
                if (ended || sampleAbort.signal.aborted) return
                try {
                  diagnostic.sample = nativeCommandDiagnostic({ ...diagnostic, sample: value }).sample
                } catch {
                  diagnostic.sample = emptySample("failed")
                }
              },
              () => {
                if (!ended) diagnostic.sample = emptySample("failed")
              },
            )
            .finally(() => {
              if (sampleBudget) clearTimeout(sampleBudget)
            })
        },
        Math.max(0, after - elapsed()),
      )
    })
    child.once("error", () => {
      if (ended) return
      diagnostic.trigger = "spawn-failed"
      finish()
    })
    child.once("exit", (result, signal) => {
      if (ended) return
      code = result
      diagnostic.exitObserved = true
      diagnostic.exitAfterMs = elapsed()
      diagnostic.signaled = signal !== null
      if (!sampled && options.sampleUnit) diagnostic.sample = emptySample("target-exited")
      sampleAbort.abort()
    })
    child.once("close", (result, signal) => {
      if (ended) return
      code = result
      diagnostic.closeObserved = true
      diagnostic.closeAfterMs = elapsed()
      diagnostic.signaled = diagnostic.signaled || signal !== null
      finish()
    })
  })
}

/** The explicit report path selects the directory; the sidecar contains no command or observed payload. */
export async function writeNativeUnitDiagnostic(report: string, diagnostic: NativeCommandDiagnostic) {
  if (
    !path.isAbsolute(report) ||
    path.normalize(report) !== report ||
    report.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(report)
  )
    throw new Error("Invalid native diagnostic report path.")
  const value = nativeCommandDiagnostic(diagnostic)
  await mkdir(path.dirname(report), { recursive: true })
  const file = await open(
    report + ".unit-diagnostic.json",
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  )
  try {
    const status = await file.stat()
    if (!status.isFile() || status.nlink !== 1) throw new Error("Invalid native diagnostic report file.")
    await file.truncate(0)
    await file.writeFile(JSON.stringify(value, null, 2) + "\n")
  } finally {
    await file.close()
  }
}
