import { execFileSync } from "node:child_process"
import { Effect } from "effect"

export * as PtyProcess from "./process"

/**
 * Whether a terminal library's pid may be signalled or probed. The pid comes from the library unchecked (bun-pty reports
 * -1 until it has one), and `process.kill` reads 0 or less as a process group or every process: 0 would probe and then
 * kill the engine's own group, -1 every process the user may signal.
 */
export function usable(pid: number) {
  return Number.isInteger(pid) && pid > 0
}

/** Whether the process still runs. Signal 0 sends nothing; EPERM means it runs as someone else. */
export function alive(pid: number) {
  if (!usable(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Sends a signal to a terminal's program and its process group: a terminal's program leads a session of its own, so
 * the group holds what it started (a dev server's workers, a watcher). Falls back to the program alone. Nothing on
 * Windows, where closing the terminal ends its console's processes, and nothing for a pid that is not usable.
 * Returns whether a signal was sent.
 */
export function signal(pid: number, name: "SIGINT" | "SIGTERM" | "SIGKILL") {
  if (process.platform === "win32" || !usable(pid)) return false
  try {
    process.kill(-pid, name)
    return true
  } catch {
    try {
      process.kill(pid, name)
      return true
    } catch {
      return false
    }
  }
}

/**
 * The terminal's foreground process group: the job an interactive shell runs right now (its own group, apart from the
 * shell's), or the program's own group when nothing else holds the terminal. Read with `ps -o tpgid=`, on macOS and
 * Linux alike; the program's pid when that cannot be read. Never on Windows.
 */
export function foreground(pid: number) {
  if (process.platform === "win32" || !usable(pid)) return pid
  try {
    const group = Number(execFileSync("ps", ["-o", "tpgid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim())
    return usable(group) ? group : pid
  } catch {
    return pid
  }
}

/** Waits up to `polls` × 20 ms for the program to end. */
export const exited = (pid: number, polls: number) =>
  Effect.gen(function* () {
    for (let poll = 0; poll < polls; poll++) {
      if (!alive(pid)) return true
      yield* Effect.sleep("20 millis")
    }
    return !alive(pid)
  })

/**
 * After a terminal is closed: the close sent its program the terminal library's hangup or terminate. One that ignores
 * it is killed, with its process group, after a second; on Windows the close already ends the console's processes.
 * Returns whether the program is gone.
 */
export const ended = Effect.fn("PtyProcess.ended")(function* (pid: number) {
  if (!usable(pid)) {
    yield* Effect.logWarning("a closed terminal reported no usable pid; its program was not waited for", { pid })
    return false
  }
  if (yield* exited(pid, 50)) return true
  signal(pid, "SIGKILL")
  if (yield* exited(pid, 100)) return true
  yield* Effect.logWarning("a closed terminal's program is still running", { pid })
  return false
})
