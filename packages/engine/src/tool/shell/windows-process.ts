import { spawn } from "node:child_process"
import { access, stat } from "node:fs/promises"
import path from "node:path"
import { ChildProcess } from "effect/unstable/process"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"
import { ProcessIsolation } from "@vectordevai/core/process-isolation"
import { WindowsHolder } from "./windows-holder"
import { carrierDelivery, carrierPhase, windowsHolderCarrier } from "./windows-holder-carrier"
import { prepareWindowsHolderCompanion, windowsHolderCompanion } from "./windows-holder-direct"
import { encodeNativeHolderLaunch } from "./windows-holder-protocol"

export type Result = { exitCode: number; terminated: true }
export type Handle = { pid: number; completion: Promise<Result>; stop(): Promise<Result> }
export type Callbacks = {
  onReady(pid: number): Promise<void>
  onOutput(chunk: Uint8Array): Promise<void>
  /** The background job's lifetime, not the foreground tool turn that handed it off. */
  signal?: AbortSignal
}

export class WindowsProcessError extends Error {
  constructor(
    message: string,
    readonly terminationProven: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "WindowsProcessError"
  }
}

export class WindowsProcessStartupTimeout extends WindowsProcessError {}

const STARTUP_MS = 15_000
const PERSIST_MS = 10_000
const STOP_MS = 2_000
const CLOSE_MS = 3_000

/** Node's Windows argv quoting, without invoking cross-spawn's private parser. */
export function quoteArgument(value: string) {
  if (value && !/[\s"]/.test(value)) return value
  let result = '"'
  let slashes = 0
  for (const char of value) {
    if (char === "\\") {
      slashes++
      continue
    }
    result += "\\".repeat(char === '"' ? slashes * 2 + 1 : slashes) + char
    slashes = 0
  }
  return result + "\\".repeat(slashes * 2) + '"'
}

/** Pure preparation mirrors Node's shell option; permissions and sandboxing already prepared this command. */
export function normalize(command: ChildProcess.StandardCommand, parent = process.env, cwd = process.cwd()) {
  const options = command.options
  if (options.additionalFds && Object.keys(options.additionalFds).length)
    throw new Error("Background shells cannot inherit additional handles")
  if (options.stdin !== undefined && options.stdin !== "ignore")
    throw new Error("Background shell input must be ignored")
  if ([options.stdout, options.stderr].some((value) => value !== undefined && value !== "pipe"))
    throw new Error("Background shell output must use its owned log")
  const env = untrustedChildEnvironment(options.extendEnv || !options.env ? parent : undefined, options.env)
  // Node keeps the first case-insensitive key in lexicographic order on Windows.
  const names = new Set<string>()
  const entries = Object.keys(env)
    .sort()
    .flatMap((key) => {
      if (names.has(key.toUpperCase())) return []
      names.add(key.toUpperCase())
      return [[key, env[key]] as const]
    })
  const environment = Object.fromEntries(entries)
  const file =
    typeof options.shell === "string"
      ? options.shell
      : options.shell
        ? variable(parent, "COMSPEC") || "cmd.exe"
        : command.command
  const cmd = !!options.shell && /(?:^|[\\/])cmd(?:\.exe)?$/i.test(file)
  const text = [command.command, ...command.args].join(" ")
  const args = options.shell ? (cmd ? ["/d", "/s", "/c", `"${text}"`] : ["-c", text]) : [...command.args]
  if (!file || [file, ...args, options.cwd ?? cwd, ...entries.flat()].some((value) => value.includes("\0")))
    throw new Error("Invalid Windows command or environment")
  if (entries.some(([key]) => !key || key.includes("="))) throw new Error("Invalid Windows environment name")
  if (entries.reduce((size, [key, value]) => size + key.length + value.length + 2, 1) > 65_536)
    throw new Error("Windows shell environment is too large")
  return { file, args, verbatim: cmd, cwd: path.win32.resolve(options.cwd ?? cwd), env: environment }
}

export function commandLine(input: Pick<ReturnType<typeof normalize>, "file" | "args" | "verbatim">) {
  const result = [
    quoteArgument(input.file),
    ...input.args.map((arg) => (input.verbatim ? arg : quoteArgument(arg))),
  ].join(" ")
  if (result.length > 32_766) throw new Error("Windows shell command exceeds the command-line limit")
  return result
}

type Status =
  | { type: "ready"; pid: number }
  | { type: "running"; pid: number }
  | { type: "exit"; exitCode: number; terminationProven: true }
  | { type: "error"; message: string; terminationProven: boolean }

/** Private stderr is a small, engine-authored protocol; payload stdout is never parsed as control. */
export class StatusReader {
  private pending = Buffer.alloc(0)
  private total = 0
  private startupStep: number
  private startupComplete = false

  constructor(
    private readonly onStartupPhase?: (phase: WindowsHolder.StartupPhase) => void,
    private readonly firstStartupStep: 1 | 4 = 1,
  ) {
    this.startupStep = firstStartupStep - 1
  }

  get startupPhase() {
    return this.startupStep < this.firstStartupStep ? "spawn" : WindowsHolder.startupPhases[this.startupStep]!
  }

  get validatedStartupStep() {
    return this.pending.byteLength ? undefined : this.startupStep
  }

  push(chunk: Uint8Array): Status[] {
    this.total += chunk.byteLength
    if (this.total > 16_384) throw new Error("Windows holder status exceeded its bound")
    this.pending = Buffer.concat([this.pending, chunk])
    const result: Status[] = []
    for (;;) {
      const end = this.pending.indexOf(10)
      if (end < 0) return result
      const line = this.pending.subarray(0, end).toString("utf8").replace(/\r$/, "")
      this.pending = this.pending.subarray(end + 1)
      if (!line.startsWith("VECTOR_SHELL/1 ")) throw new Error("Invalid Windows holder status")
      const value: unknown = JSON.parse(line.slice(15))
      if (!value || typeof value !== "object" || !("type" in value)) throw new Error("Invalid Windows holder status")
      // The fixed startup phases add context to timeouts. Readiness and termination still use their own status frames.
      if (value.type === "startup") {
        const next = this.startupStep + 1
        if (
          this.startupComplete ||
          !("step" in value) ||
          Object.keys(value).length !== 2 ||
          value.step !== next ||
          next >= WindowsHolder.startupPhases.length
        )
          throw new Error("Invalid Windows holder startup phase")
        this.startupStep = next
        this.onStartupPhase?.(this.startupPhase)
        continue
      }
      this.startupComplete = true
      if ((value.type === "ready" || value.type === "running") && "pid" in value && whole(value.pid) && value.pid > 0) {
        result.push({ type: value.type, pid: value.pid })
        continue
      }
      if (
        value.type === "exit" &&
        "exitCode" in value &&
        whole(value.exitCode) &&
        "terminationProven" in value &&
        value.terminationProven === true
      ) {
        result.push({ type: "exit", exitCode: value.exitCode, terminationProven: true })
        continue
      }
      if (
        value.type === "error" &&
        "message" in value &&
        typeof value.message === "string" &&
        value.message.length <= 160 &&
        "terminationProven" in value &&
        typeof value.terminationProven === "boolean"
      ) {
        result.push({ type: "error", message: value.message, terminationProven: value.terminationProven })
        continue
      }
      throw new Error("Invalid Windows holder status")
    }
  }
  finish() {
    if (this.pending.byteLength) throw new Error("Truncated Windows holder status")
  }
}

/** Only this live registration owns the native holder. No operation accepts a recovered numeric PID. */
export async function start(command: ChildProcess.StandardCommand, callbacks: Callbacks): Promise<Handle> {
  // Defense in depth: the holder starts directly, never through ProcessIsolation.launch, so it refuses here
  // too when isolation is required. ShellJobs refuses earlier with the user-facing message, before any job row.
  if (ProcessIsolation.required()) throw new WindowsProcessError(ProcessIsolation.REFUSAL, true)
  if (process.platform !== "win32")
    throw new WindowsProcessError("Windows background containment is unavailable on this platform", true)
  if (callbacks.signal?.aborted) throw new WindowsProcessError("Background shell stopped before startup", true)
  const input = preflight(() => normalize(command))
  const root = variable(process.env, "SystemRoot")
  if (!root || !path.win32.isAbsolute(root))
    throw new WindowsProcessError("Windows containment helper is unavailable", true)
  const direct = preflight(() => windowsHolderCompanion(root))
  const holder = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const file = await executable(input.file, input.cwd, input.env)
  const configuration = {
    file,
    commandLine: preflight(() => commandLine({ ...input, file })),
    cwd: input.cwd,
    env: input.env,
  }
  const config = JSON.stringify(configuration) + "\n"
  if (Buffer.byteLength(config) > 262_144)
    throw new WindowsProcessError("Windows shell configuration is too large", true)
  // Project env/preloads never configure the trusted helper. Only its payload gets the prepared, filtered env.
  const helperEnv = Object.fromEntries(
    ["SystemRoot", "WINDIR", "TEMP", "TMP"].flatMap((key) => {
      const value = variable(process.env, key)
      return value ? [[key, value]] : []
    }),
  )
  const launchStarted = performance.now()
  const deadline = launchStarted + STARTUP_MS
  const remaining = () => Math.max(0, Math.ceil(deadline - performance.now()))
  const delivery = WindowsHolder.deliveryTimeline(() => performance.now() - launchStarted)
  const startupTimeout = (phase: string) => {
    delivery.mark("watchdogMs")
    return `Windows containment helper startup timed out (last phase: ${phase})`
  }
  const prepareTimeout = () => {
    const message = startupTimeout("spawn")
    return new WindowsProcessStartupTimeout(
      `${message} (holder startup transport: ${JSON.stringify(delivery.snapshot())})`,
      true,
    )
  }
  const prepareDirect = async () => {
    if (!direct) return
    const pending = prepareWindowsHolderCompanion(direct, deadline, callbacks.signal)
    try {
      return await bounded(pending, remaining(), () => startupTimeout("spawn"))
    } catch {
      void pending.then(
        (verified) => verified?.release(),
        () => {},
      )
      if (callbacks.signal?.aborted) throw new WindowsProcessError("Background shell stopped before startup", true)
      if (!remaining() || delivery.snapshot().watchdogMs !== undefined) throw prepareTimeout()
      throw new WindowsProcessError("The installed Windows containment helper failed verification", true)
    }
  }
  const verified = direct ? await prepareDirect() : undefined
  if (!verified) {
    try {
      await bounded(access(holder), remaining(), () => startupTimeout("spawn"))
    } catch (cause) {
      if (!remaining() || delivery.snapshot().watchdogMs !== undefined) throw prepareTimeout()
      throw new WindowsProcessError("Windows PowerShell containment helper is unavailable", true, { cause })
    }
  }
  const carrier = verified ? undefined : preflight(() => windowsHolderCarrier(root))
  const native = verified !== undefined && direct?.wire === "vsh1"
  const args = verified ? [] : preflight(() => carrier?.args ?? WindowsHolder.argumentsForHolder())
  const { child, wireConfig } = (() => {
    try {
      const wireConfig = native ? preflight(() => encodeNativeHolderLaunch(configuration)) : config
      if (callbacks.signal?.aborted) throw new WindowsProcessError("Background shell stopped before startup", true)
      if (!remaining()) throw prepareTimeout()
      const child = preflight(() =>
        spawn(verified?.executable ?? holder, args, {
          cwd: path.win32.join(root, "System32"),
          env: helperEnv,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        }),
      )
      return { child, wireConfig }
    } finally {
      void verified?.release()
    }
  })()
  delivery.mark("launchReturnedMs")
  child.once("spawn", () => delivery.mark("spawnEventMs"))
  const ready = deferred<number>()
  const running = deferred<void>()
  const closed = deferred<void>()
  const completion = deferred<Result>()
  // Startup may fail before its waiter is installed; these are observed again by the caller below.
  void ready.promise.catch(() => {})
  void running.promise.catch(() => {})
  void completion.promise.catch(() => {})
  const state: {
    pid?: number
    acknowledged: boolean
    running: boolean
    terminal: boolean
    proof: boolean
    drained: boolean
    code?: number
    failure?: Error
    closed: boolean
    stopping: boolean
    finished: boolean
  } = {
    acknowledged: false,
    running: false,
    terminal: false,
    proof: false,
    drained: false,
    closed: false,
    stopping: false,
    finished: false,
  }
  let configurationSent = false
  const sendConfig = () => {
    child.stdin.write(wireConfig, (error) => {
      delivery.mark(error ? "configWriteFailedMs" : "configWrittenMs")
      if (!error || state.terminal) return
      configurationSent = false
      void stop(new Error("Windows containment configuration could not be delivered")).catch(() => {})
    })
    configurationSent = true
  }
  const transport =
    carrier &&
    carrierDelivery(() => {
      child.stdin.write(carrier.bytes, (error) => {
        if (error) void stop(new Error("Windows containment holder bytes could not be delivered")).catch(() => {})
      })
    }, sendConfig)
  const timers: ReturnType<typeof setTimeout>[] = []
  const fail = (cause: unknown) => {
    state.failure ??= cause instanceof Error ? cause : new Error("Windows background containment failed")
    ready.reject(state.failure)
    running.reject(state.failure)
  }
  const finish = () => {
    state.finished = true
    timers.forEach(clearTimeout)
    callbacks.signal?.removeEventListener("abort", abort)
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
  }
  const overdue = (message: string) => {
    if (state.finished) return
    delivery.mark("closeDeadlineMs")
    fail(new Error(message))
    completion.reject(
      new WindowsProcessError(state.failure!.message, state.closed && state.proof && state.drained, {
        cause: state.failure,
      }),
    )
    finish()
  }
  const stop = (cause?: unknown) => {
    if (cause !== undefined) fail(cause)
    if (state.stopping || state.finished) return completion.promise
    state.stopping = true
    if (!state.running) fail(new Error("Background shell stopped before startup"))
    if (!child.stdin.destroyed && child.stdin.writable) {
      // End the pipe before configuration so stop cannot be mistaken for a binary input frame.
      if ((transport || native) && !configurationSent) child.stdin.end()
      else child.stdin.end('{"type":"stop"}\n')
    }
    timers.push(
      setTimeout(() => {
        if (!state.closed) child.kill()
      }, STOP_MS),
    )
    timers.push(
      setTimeout(
        () => overdue("Windows holder did not close and drain within its cleanup deadline"),
        STOP_MS + CLOSE_MS,
      ),
    )
    return completion.promise
  }
  const abort = () => {
    void stop().catch(() => {})
  }
  callbacks.signal?.addEventListener("abort", abort, { once: true })
  child.on("error", (cause) => {
    // A failed native spawn has no holder and therefore cannot have created a payload.
    if (child.pid === undefined) state.proof = true
    void stop(cause).catch(() => {})
  })
  child.stdin.on("error", (cause) => {
    if (!state.terminal) void stop(cause).catch(() => {})
  })
  child.stderr.on("error", (cause) => {
    void stop(cause).catch(() => {})
  })
  child.once("close", () => {
    delivery.mark("closeMs")
    state.closed = true
    closed.resolve()
  })
  // Native exit is distinct from pipe close: a stalled output callback cannot leave completion pending forever.
  child.once("exit", () => {
    delivery.mark("exitMs")
    timers.push(setTimeout(() => overdue("Windows shell output did not close after holder exit"), CLOSE_MS))
  })
  const reader = new StatusReader(delivery.markStartupPhase, verified ? 4 : 1)
  const phase = () => (carrier ? carrierPhase(reader.startupPhase) : reader.startupPhase)
  child.stderr.on("data", (chunk: Buffer) => {
    if (chunk.length) delivery.mark("firstStderrMs")
    try {
      for (const message of reader.push(chunk)) {
        if (state.terminal) throw new Error("Unexpected status after Windows holder termination")
        if (message.type === "ready") {
          if (state.pid !== undefined) throw new Error("Duplicate Windows holder readiness")
          if ((transport || native) && !configurationSent)
            throw new Error("Windows containment holder reported readiness before its configuration")
          if (native && reader.startupPhase !== "payload-created")
            throw new Error("Windows containment holder reported readiness before payload creation")
          if (!remaining()) {
            // Refuse the late PID but keep processing the chunk for a valid native cleanup proof.
            void stop(new Error(startupTimeout(phase()))).catch(() => {})
            continue
          }
          delivery.mark("readyMs")
          state.pid = message.pid
          ready.resolve(message.pid)
          continue
        }
        if (message.type === "running") {
          if (!state.acknowledged || state.running || message.pid !== state.pid)
            throw new Error("Windows holder resumed without durable acknowledgement")
          state.running = true
          running.resolve()
          continue
        }
        if (message.type === "exit" && !state.running)
          throw new Error("Windows holder exited without a running acknowledgement")
        state.terminal = true
        state.proof = message.terminationProven
        if (message.type === "error") fail(new Error(message.message))
        else state.code = message.exitCode
      }
      const active =
        !state.failure &&
        !state.stopping &&
        !state.terminal &&
        !state.closed &&
        !state.finished &&
        !callbacks.signal?.aborted &&
        remaining() > 0
      const step = reader.validatedStartupStep
      transport?.afterStatus(step, active)
      if (native && active && !configurationSent && step !== undefined) {
        if (step > 4) throw new Error("Windows containment holder advanced before its configuration")
        if (step === 4) sendConfig()
      }
    } catch (cause) {
      void stop(cause).catch(() => {})
    }
  })
  const output = (async () => {
    for await (const chunk of child.stdout) {
      if (state.finished) break
      await callbacks.onOutput(new Uint8Array(chunk))
    }
  })()
  void output.then(
    () => {
      state.drained = true
    },
    (cause) => {
      state.drained = true
      void stop(new Error("Background shell output failed", { cause })).catch(() => {})
    },
  )
  void (async () => {
    try {
      await closed.promise
      reader.finish()
      await bounded(output, CLOSE_MS, "Windows shell output did not finish draining")
      if (!state.terminal || !state.proof || state.code === undefined)
        fail(new Error("Windows job termination could not be proven"))
      if (state.failure)
        throw new WindowsProcessError(state.failure.message, state.closed && state.proof && state.drained, {
          cause: state.failure,
        })
      completion.resolve({ exitCode: state.code!, terminated: true })
    } catch (cause) {
      fail(cause)
      completion.reject(
        new WindowsProcessError(state.failure!.message, state.closed && state.proof && state.drained, {
          cause: state.failure,
        }),
      )
    } finally {
      finish()
    }
  })()
  const ensureStartupActive = () => {
    if (state.stopping || state.failure || state.terminal || state.closed || callbacks.signal?.aborted)
      throw state.failure ?? new Error("Background shell stopped during startup")
  }
  try {
    if (!remaining()) throw new Error(startupTimeout(phase()))
    if (transport) transport.begin()
    else if (!native) sendConfig()
    const pid = await bounded(ready.promise, remaining(), () => startupTimeout(phase()))
    ensureStartupActive()
    await bounded(callbacks.onReady(pid), PERSIST_MS, "Saving the background shell PID timed out")
    ensureStartupActive()
    state.acknowledged = true
    child.stdin.write('{"type":"resume"}\n')
    await bounded(running.promise, CLOSE_MS, "Windows holder did not acknowledge execution")
    return { pid, completion: completion.promise, stop: () => stop() }
  } catch (cause) {
    await stop(cause).catch(() => {})
    const message = state.failure?.message ?? "Windows shell startup failed"
    const terminationProven = state.closed && state.proof && state.drained
    const timings = delivery.snapshot()
    if (cause === state.failure && timings.watchdogMs !== undefined)
      throw new WindowsProcessStartupTimeout(
        `${message} (holder startup transport: ${JSON.stringify(timings)})`,
        terminationProven,
        { cause },
      )
    throw new WindowsProcessError(message, terminationProven, { cause })
  }
}

function variable(env: NodeJS.ProcessEnv, key: string) {
  return Object.entries(env).find(([name]) => name.toUpperCase() === key.toUpperCase())?.[1]
}
function preflight<T>(read: () => T) {
  try {
    return read()
  } catch (cause) {
    throw new WindowsProcessError(cause instanceof Error ? cause.message : "Windows shell preparation failed", true, {
      cause,
    })
  }
}
function whole(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (cause?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
async function bounded<T>(promise: Promise<T>, ms: number, message: string | (() => string)) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(typeof message === "function" ? message() : message)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function executable(file: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (/\.(?:cmd|bat)$/i.test(file)) throw new WindowsProcessError("A Windows script must use its prepared shell", true)
  const locations = /[\\/]/.test(file)
    ? [path.win32.resolve(cwd, file)]
    : [cwd, ...(variable(env, "PATH") ?? "").split(";")].map((directory) =>
        path.win32.resolve(cwd, directory.replace(/^"|"$/g, ""), file),
      )
  const candidates = locations.flatMap((name) =>
    path.win32.extname(name) ? [name] : [name + ".exe", name + ".com", name],
  )
  for (const candidate of candidates)
    if (
      await stat(candidate).then(
        (value) => value.isFile(),
        () => false,
      )
    )
      return candidate
  throw new WindowsProcessError("The prepared Windows shell executable is unavailable", true)
}

export * as WindowsProcess from "./windows-process"
