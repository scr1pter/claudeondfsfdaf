import { spawn } from "node:child_process"
import { BINARIES } from "./limits"

/*
 * Running other programs from hostd (contract WP A54). Arguments always go as a list (no shell), secrets only through a
 * child's environment or stdin (the command line is readable by other processes), output is capped, and every run has
 * a deadline after which the child is killed.
 */

export type RunOptions = {
  uid?: number
  gid?: number
  cwd?: string
  env?: Record<string, string>
  stdin?: string | Uint8Array
  timeoutMs: number
  /** The most stdout kept; more fails the run. */
  maxOutput?: number
}

export type RunResult = { code: number; stdout: Buffer; stderr: string }

/** What hostd uses to run a program; tests pass a fake. */
export type Runner = (file: string, args: readonly string[], options: RunOptions) => Promise<RunResult>

export class RunError extends Error {
  constructor(
    message: string,
    readonly result?: RunResult,
  ) {
    super(message)
  }
}

const MINIMAL_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

/** Runs one program to completion. Its environment is exactly `env` plus a fixed PATH; nothing of hostd's leaks in. */
export const runProgram: Runner = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      cwd: options.cwd ?? "/",
      env: { PATH: MINIMAL_PATH, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.uid !== undefined ? { uid: options.uid } : {}),
      ...(options.gid !== undefined ? { gid: options.gid } : {}),
      windowsHide: true,
    })
    const max = options.maxOutput ?? 32 * 1024 * 1024
    const chunks: Buffer[] = []
    let size = 0
    let stderr = ""
    let failed: Error | undefined
    const timer = setTimeout(() => {
      failed = new RunError(`${file} timed out`)
      child.kill("SIGKILL")
    }, options.timeoutMs)
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > max) {
        failed = new RunError(`${file} wrote too much`)
        child.kill("SIGKILL")
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 16 * 1024) stderr += chunk.toString("utf8")
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(new RunError(`${file} could not start: ${error.message}`))
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      const result = { code: code ?? -1, stdout: Buffer.concat(chunks), stderr: stderr.slice(0, 16 * 1024) }
      if (failed) reject(new RunError(failed.message, result))
      else resolve(result)
    })
    child.stdin.on("error", () => {})
    child.stdin.end(options.stdin ?? "")
  })

/** Runs a program and fails unless it exits 0. */
export async function runChecked(runner: Runner, file: string, args: readonly string[], options: RunOptions) {
  const result = await runner(file, args, options)
  if (result.code !== 0) throw new RunError(`${file} ${args[0] ?? ""} failed (${result.code})`, result)
  return result
}

/**
 * The argument list that starts `command` as an unprivileged user with no way back up: its own uid and gid, only the
 * listed supplementary groups, no new privileges (setuid binaries do nothing), no capabilities, and a clean
 * environment (the caller passes the one it gets).
 */
export function dropTo(uid: number, gid: number, groups: readonly number[], command: readonly string[]) {
  return [
    BINARIES.setpriv,
    `--reuid=${uid}`,
    `--regid=${gid}`,
    groups.length ? `--groups=${groups.join(",")}` : "--clear-groups",
    "--no-new-privs",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--bounding-set=-all",
    "--",
    ...command,
  ]
}
