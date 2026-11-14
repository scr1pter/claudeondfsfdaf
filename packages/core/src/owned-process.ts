import type { ChildProcess } from "node:child_process"
import { execFile } from "node:child_process"
import { setTimeout } from "node:timers/promises"
import { make } from "effect/unstable/process/ChildProcess"
import type { StandardCommand } from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { untrustedChildEnvironment } from "./child-environment"

export type Exit = { code: number | null; signal: NodeJS.Signals | null }
export type Result = {
  terminated: boolean
  drained: boolean
  exit?: Exit
  error?: string
}
export type Options = { grace?: number; kill?: number; drain?: number }
export type Control = {
  readonly pid: number
  readonly exited: Promise<Exit>
  readonly done: Promise<Result>
  readonly stop: () => Promise<Result>
}

// Engine-created commands/handles only. No serialized option or recovered PID can acquire process ownership.
const commands = new WeakMap<StandardCommand, Options>()
const handles = new WeakMap<ChildProcessHandle, Control>()

export function command(value: StandardCommand, options: Options = {}) {
  if (process.platform === "win32" || value.options.detached === false)
    throw new Error("Owned POSIX commands require a detached process group")
  if (
    Object.values(options).some(
      (value) => value !== undefined && (!Number.isFinite(value) || value < 0 || value > 30_000),
    )
  )
    throw new Error("Owned process cleanup bounds must be between zero and 30000 milliseconds")
  const owned = make(value.command, value.args, value.options)
  commands.set(owned, { ...options })
  return owned
}

export function options(value: StandardCommand) {
  return commands.get(value)
}

export function bind(handle: ChildProcessHandle, control: Control) {
  handles.set(handle, control)
}

export function get(handle: ChildProcessHandle) {
  return handles.get(handle)
}

function groupExists(pid: number) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined
  }
}

function signal(pid: number, value: NodeJS.Signals) {
  try {
    process.kill(-pid, value)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false
  }
  return true
}

// A reparented zombie is already dead but may retain its process group until the OS reaps it. Do not mistake it for
// executable work, or release a reservation merely because the original shell (rather than its descendants) exited.
async function groupEmpty(pid: number, leaderExited: boolean) {
  const exists = groupExists(pid)
  if (exists === false) return true
  if (exists === undefined || !leaderExited) return false
  return new Promise<boolean>((resolve) => {
    execFile(
      "/bin/ps",
      ["-A", "-o", "pgid=,stat="],
      { env: untrustedChildEnvironment(), timeout: 400, killSignal: "SIGKILL", maxBuffer: 65_536 },
      (error, stdout) => {
        if (error) return resolve(false)
        const rows = stdout.trim().split(/\r?\n/)
        if (rows.some((row) => row.trim() && !/^\s*\d+\s+\S+\s*$/.test(row))) return resolve(false)
        resolve(
          !rows.some((row) => {
            const [group, state] = row.trim().split(/\s+/)
            return Number(group) === pid && !state?.startsWith("Z")
          }),
        )
      },
    )
  })
}

async function within<T>(work: Promise<T>, milliseconds: number) {
  const cancel = new AbortController()
  const expired = setTimeout(milliseconds, undefined, { signal: cancel.signal }).then(
    () => ({ done: false as const }),
    () => ({ done: false as const }),
  )
  try {
    return await Promise.race([work.then((value) => ({ done: true as const, value })), expired])
  } finally {
    cancel.abort()
  }
}

/** Called synchronously after spawning, before native events can be lost. Scope cleanup and exit share one stop. */
export function track(proc: ChildProcess, disposeOutput: () => void, settings: Options = {}): Control {
  const pid = proc.pid
  if (process.platform === "win32" || !pid || pid <= 1) throw new Error("Missing owned POSIX process identity")
  const native = Promise.withResolvers<Exit>()
  const close = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<Result>()
  let exit: Exit | undefined
  let stopping: Promise<Result> | undefined
  const untilEmpty = async (duration: number) => {
    const deadline = performance.now() + duration
    do {
      if (await groupEmpty(pid, exit !== undefined)) return true
      await setTimeout(Math.min(50, Math.max(1, deadline - performance.now())))
    } while (performance.now() < deadline)
    return false
  }
  const stop = () =>
    (stopping ??= (async (): Promise<Result> => {
      signal(pid, "SIGTERM")
      let terminated = await untilEmpty(settings.grace ?? 3_000)
      if (!terminated) {
        signal(pid, "SIGKILL")
        terminated = await untilEmpty(settings.kill ?? 3_000)
      }
      const drained = await within(close.promise, settings.drain ?? 3_000)
      // Never let an escaped/open pipe keep a scope finalizer alive after the actual process-control deadline.
      if (!drained.done) {
        disposeOutput()
        await within(close.promise, 200)
      }
      const result: Result = {
        terminated: terminated && exit !== undefined && drained.done,
        drained: drained.done,
        ...(exit ? { exit } : {}),
        ...(!terminated || !exit
          ? { error: "The command process group could not be confirmed stopped within the cleanup deadline." }
          : !drained.done
            ? { error: "The command stopped, but its output did not finish draining within the cleanup deadline." }
            : {}),
      }
      finished.resolve(result)
      return result
    })())
  proc.once("close", () => close.resolve())
  proc.once("exit", (code, reason) => {
    exit = { code, signal: reason }
    native.resolve(exit)
    // A successful shell can leave a child running with or without an inherited output pipe.
    void stop()
  })
  return { pid, exited: native.promise, done: finished.promise, stop }
}

export * as OwnedProcess from "./owned-process"
