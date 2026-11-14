import { readdir, readFile } from "node:fs/promises"

/*
 * The agent's processes, as hostd sees them in /proc (contract WP A54). hostd pauses every one of them while the person
 * holds control and while git holds a GitHub token, and when a tool call ends it kills what the call left running: the
 * call's process group, and anything started during the call that slipped out of the agent's process tree (a daemon, a
 * double fork). Processes are matched by pid and start time, so a reused pid is never mistaken for another.
 */

export type Proc = { pid: number; ppid: number; pgid: number; uid: number; start: number; state: string }

export interface ProcTable {
  list(): Promise<Proc[]>
  signal(pid: number, signal: NodeJS.Signals): void
}

/** Reads one /proc/<pid>/stat line: fields after the command name, which may itself hold spaces and parentheses. */
export function parseStat(text: string) {
  const close = text.lastIndexOf(")")
  if (close < 0) return undefined
  const fields = text.slice(close + 2).trim().split(/\s+/)
  // After "pid (comm) ": state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime
  // priority nice threads itrealvalue starttime …
  const state = fields[0] ?? ""
  const ppid = Number(fields[1])
  const pgid = Number(fields[2])
  const start = Number(fields[19])
  if (![ppid, pgid, start].every(Number.isSafeInteger)) return undefined
  return { state, ppid, pgid, start }
}

/** Reads the real uid from /proc/<pid>/status. */
export function parseUid(text: string) {
  const match = /^Uid:\s+(\d+)/m.exec(text)
  return match ? Number(match[1]) : undefined
}

/** The process table on Linux. */
export const linuxProcs: ProcTable = {
  async list() {
    const entries = await readdir("/proc").catch(() => [] as string[])
    const found: Proc[] = []
    await Promise.all(
      entries
        .filter((entry) => /^\d+$/.test(entry))
        .map(async (entry) => {
          try {
            const [stat, status] = await Promise.all([
              readFile(`/proc/${entry}/stat`, "utf8"),
              readFile(`/proc/${entry}/status`, "utf8"),
            ])
            const parsed = parseStat(stat)
            const uid = parseUid(status)
            if (parsed && uid !== undefined) found.push({ pid: Number(entry), uid, ...parsed })
          } catch {
            // The process ended while it was being read.
          }
        }),
    )
    return found
  },
  signal(pid, signal) {
    try {
      process.kill(pid, signal)
    } catch {}
  },
}

const PASSES = 6

/**
 * Sends `signal` to every process of `uid`, again and again until a pass finds none it has not signalled yet, so a
 * process forked between passes is caught too. Answers the processes signalled.
 */
export async function signalAll(table: ProcTable, uid: number, signal: NodeJS.Signals) {
  const done = new Set<string>()
  for (let pass = 0; pass < PASSES; pass++) {
    const fresh = (await table.list()).filter((proc) => proc.uid === uid && !done.has(key(proc)))
    if (!fresh.length) break
    for (const proc of fresh) {
      table.signal(proc.pid, signal)
      done.add(key(proc))
    }
  }
  return done.size
}

/** Pauses every process of `uid`; a stopped process can read nothing, not even another process's environment. */
export const stopAll = (table: ProcTable, uid: number) => signalAll(table, uid, "SIGSTOP")
export const continueAll = (table: ProcTable, uid: number) => signalAll(table, uid, "SIGCONT")
export const killAll = (table: ProcTable, uid: number) => signalAll(table, uid, "SIGKILL")

function key(proc: Pick<Proc, "pid" | "start">) {
  return `${proc.pid}:${proc.start}`
}

/** Whether `proc` descends from `root` (by pid) in `table`. */
function descends(proc: Proc, root: number, byPid: Map<number, Proc>) {
  let current: Proc | undefined = proc
  for (let depth = 0; current && depth < 256; depth++) {
    if (current.pid === root) return true
    if (current.ppid <= 1) return false
    current = byPid.get(current.ppid)
  }
  return false
}

/**
 * Tool-call bookkeeping. `begin` notes the agent's processes; `end` kills, among processes started since, those in the
 * call's process group and those no longer under the agent's main process. The agent itself and what it keeps under
 * it (its language servers, say) are left alone.
 */
export class ToolCalls {
  private readonly open = new Map<string, { before: Set<string>; pgid?: number }>()

  constructor(
    private readonly table: ProcTable,
    private readonly uid: number,
    private readonly root: () => number | undefined,
  ) {}

  async begin(id: string, pgid?: number) {
    if (this.open.size >= 64) this.open.delete(this.open.keys().next().value!)
    const before = new Set((await this.table.list()).filter((proc) => proc.uid === this.uid).map(key))
    this.open.set(id, { before, ...(pgid !== undefined ? { pgid } : {}) })
  }

  /** Ends a call; answers how many processes it killed. */
  async end(id: string) {
    const call = this.open.get(id)
    if (!call) return 0
    this.open.delete(id)
    const root = this.root()
    const procs = await this.table.list()
    const byPid = new Map(procs.map((proc) => [proc.pid, proc]))
    let killed = 0
    for (const proc of procs) {
      if (proc.uid !== this.uid || call.before.has(key(proc)) || proc.pid === root) continue
      const inGroup = call.pgid !== undefined && proc.pgid === call.pgid
      const escaped = root === undefined || !descends(proc, root, byPid)
      if (inGroup || escaped) {
        this.table.signal(proc.pid, "SIGKILL")
        killed++
      }
    }
    return killed
  }
}
