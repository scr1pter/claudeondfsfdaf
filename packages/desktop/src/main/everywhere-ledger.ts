import { JOB_ID_PATTERN, RANDOM_ID_PATTERN, decodeSettle, type Settle } from "@vectordevai/schema/everywhere"
import { constants } from "node:fs"
import { mkdir, open, rename, rm } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"

export type InFlight = { readonly jid: string; readonly startedAt: number; readonly lease?: string; readonly sessionID?: string }
export type RunnerLedger = { readonly day: string; readonly count: number; readonly jobs: readonly InFlight[]; readonly offers: Readonly<Record<string, number>>; readonly pending?: readonly Settle[] }

/** Storage is outside every job worktree. VE-21 supplies the private atomic file adapter. */
export function createLedger(input: {
  readonly read: () => Promise<unknown>
  readonly write: (state: RunnerLedger) => Promise<void>
  readonly now: () => number
}) {
  let tail = Promise.resolve()
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work)
    tail = result.then(() => undefined, () => undefined)
    return result
  }
  async function load(): Promise<RunnerLedger & { readonly pending: readonly Settle[] }> {
    const day = new Date(input.now()).toISOString().slice(0, 10)
    const raw = await input.read()
    if (raw === undefined) return { day, count: 0, jobs: [], offers: {}, pending: [] }
    if (typeof raw !== "object" || raw === null) throw new Error("Everywhere ledger is unavailable")
    const state = raw as Partial<RunnerLedger>
    if (typeof state.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(state.day) || !Number.isSafeInteger(state.count) || state.count! < 0 || !Array.isArray(state.jobs) || typeof state.offers !== "object" || state.offers === null) throw new Error("Everywhere ledger is invalid")
    if (state.jobs.some((job) => !JOB_ID_PATTERN.test(job.jid) || !Number.isSafeInteger(job.startedAt) || job.startedAt < 0 || (job.lease !== undefined && !RANDOM_ID_PATTERN.test(job.lease)) || (job.sessionID !== undefined && !/^ses[A-Za-z0-9_]+$/.test(job.sessionID)))) throw new Error("Everywhere ledger is invalid")
    if (state.pending !== undefined && (!Array.isArray(state.pending) || state.pending.length > 32 || state.pending.some((result) => !decodeSettle(result).ok) || new Set(state.pending.map((result) => result.jid)).size !== state.pending.length)) throw new Error("Everywhere ledger is invalid")
    const offers = Object.fromEntries(Object.entries(state.offers).filter(([id, expires]) => RANDOM_ID_PATTERN.test(id) && Number.isSafeInteger(expires) && expires > input.now()))
    return { day, count: state.day === day ? state.count! : 0, jobs: state.jobs, offers, pending: state.pending ?? [] }
  }
  return {
    inspect: () => serial(load),
    reserve: (jid: string, caps: { atOnce: number; perDay: number }) => serial(async () => {
      if (!JOB_ID_PATTERN.test(jid)) return false
      const state = await load()
      if (!Number.isInteger(caps.atOnce) || caps.atOnce < 1 || !Number.isInteger(caps.perDay) || caps.perDay < 1 || state.jobs.length >= caps.atOnce || state.count >= caps.perDay || state.jobs.some((job) => job.jid === jid) || state.pending.length >= 32 || state.pending.some((result) => result.jid === jid)) return false
      await input.write({ ...state, count: state.count + 1, jobs: [...state.jobs, { jid, startedAt: input.now() }] })
      return true
    }),
    update: (job: InFlight) => serial(async () => {
      const state = await load()
      if (!state.jobs.some((item) => item.jid === job.jid)) throw new Error("Everywhere job has no reservation")
      await input.write({ ...state, jobs: state.jobs.map((item) => item.jid === job.jid ? job : item) })
    }),
    release: (jid: string) => serial(async () => {
      const state = await load()
      await input.write({ ...state, jobs: state.jobs.filter((job) => job.jid !== jid) })
    }),
    remember: (result: Settle) => serial(async () => {
      const checked = decodeSettle(result)
      if (!checked.ok) throw new Error("Invalid Everywhere result")
      const state = await load()
      const previous = state.pending.find((item) => item.jid === result.jid)
      if (!state.jobs.some((job) => job.jid === result.jid && job.lease === result.lease) || (previous && previous.lease !== result.lease) || (!previous && state.pending.length >= 32)) throw new Error("Everywhere result has no reservation")
      await input.write({ ...state, pending: [...state.pending.filter((item) => item.jid !== result.jid), checked.value] })
    }),
    acknowledge: (result: Settle) => serial(async () => {
      const state = await load()
      await input.write({ ...state, pending: state.pending.filter((item) => item.jid !== result.jid || item.lease !== result.lease) })
    }),
    useOnce: (id: string, expiresAt: number) => serial(async () => {
      const state = await load()
      if (!RANDOM_ID_PATTERN.test(id) || !Number.isSafeInteger(expiresAt) || expiresAt <= input.now() || state.offers[id] !== undefined || Object.keys(state.offers).length >= 4096) return false
      await input.write({ ...state, offers: { ...state.offers, [id]: expiresAt } })
      return true
    }),
  }
}

export type JobLedger = ReturnType<typeof createLedger>

/** The private user-data path is supplied by VE-21, never by a job or a repository. */
export function ledgerFile(file: string) {
  if (!path.isAbsolute(file)) throw new Error("Everywhere ledger requires a private absolute path")
  return {
    async read(): Promise<unknown> {
      let handle
      try {
        handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        const info = await handle.stat()
        if (!info.isFile() || info.size > 256 * 1024) throw new Error("Everywhere ledger is invalid")
        return JSON.parse(await handle.readFile("utf8")) as unknown
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw new Error("Everywhere ledger could not be read")
      } finally { await handle?.close() }
    },
    async write(state: RunnerLedger) {
      const directory = path.dirname(file)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = `${file}.${randomBytes(16).toString("hex")}.tmp`
      const handle = await open(temporary, "wx", 0o600)
      try {
        try {
          await handle.writeFile(JSON.stringify(state), "utf8")
          await handle.sync()
        } finally { await handle.close() }
        await rename(temporary, file)
      } finally { await rm(temporary, { force: true }) }
    },
  }
}
