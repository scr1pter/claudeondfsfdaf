export * as BackgroundJobStore from "./background-job-store"

import { randomUUID } from "node:crypto"
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { HEARTBEAT, metadataSnapshot, type BackgroundJob } from "./background-job"
import { BackgroundJobTable } from "./background-job.sql"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { Global } from "./global"

/*
 * Durable rows for background jobs, and whether whoever runs them is still alive. A row names the instance lease
 * running the job (`${PROCESS_ID}:${instance}`), that process's pid and boot, and the machine, so a later engine can
 * tell work a crash, update or restart interrupted from work another engine on the same vector.db is still doing.
 */

/** This process. A restarted engine is another process, with other leases. */
export const PROCESS_ID = randomUUID()

/** An instance lease: the process and instance running a job, the boot that process runs in, and its machine. */
export type Owner = { runtime: string; pid: number; boot: number; machine: string }

/** `unknown` means Vector cannot tell, so nothing acts on that owner's work. */
export type Liveness = "alive" | "dead" | "unknown"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
let machineFile: string | undefined
let self: Omit<Owner, "runtime"> | undefined

/** Tests keep the machine id in a temporary file. Call it before anything reads the id. */
export function useMachineFile(file: string) {
  machineFile = file
  self = undefined
}

/**
 * This process: its pid, its boot, and the machine id, a random UUID in `<state>/machine-id` (mode 0600). The machine
 * id stays in the background_job table: session metadata, which guests and exports read, never carries it.
 */
export function current() {
  self ??= {
    pid: process.pid,
    boot: boot(),
    // A state folder Vector cannot write leaves this process an id of its own, so other engines see it as unknown.
    machine: machine(machineFile ?? path.join(Global.Path.state, "machine-id")) ?? randomUUID(),
  }
  return self
}

function machine(file: string) {
  return readMachine(file) ?? createMachine(file)
}

function readMachine(file: string) {
  try {
    const text = readFileSync(file, "utf8").trim()
    return UUID.test(text) ? text : undefined
  } catch {
    return undefined
  }
}

// Written under a temporary name and linked into place, so engines starting together agree on one id and none reads
// a half-written file. A damaged file is replaced the same way.
function createMachine(file: string) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(temporary, randomUUID(), { mode: 0o600 })
    try {
      linkSync(temporary, file)
    } catch {
      if (readMachine(file) === undefined) renameSync(temporary, file)
    }
    return readMachine(file)
  } catch {
    return undefined
  } finally {
    rmSync(temporary, { force: true })
  }
}

// Linux names its boot. Elsewhere the boot time stands in, to the minute, so the same boot reads the same.
function boot() {
  if (process.platform === "linux") {
    try {
      const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").replaceAll("-", "").trim()
      const value = Number.parseInt(id.slice(0, 12), 16)
      if (Number.isSafeInteger(value) && value > 0) return value
    } catch {}
  }
  return Math.round((Date.now() - os.uptime() * 1000) / 60_000) * 60_000
}

// This process's instance leases that are still open.
const leases = new Set<string>()

/** Opens a lease for one instance. Jobs that run under it count as alive until `close`, then as dead. */
export function open(): Owner {
  awakeSince(Date.now())
  const owner = { ...current(), runtime: `${PROCESS_ID}:${randomUUID()}` }
  leases.add(owner.runtime)
  return owner
}

export function close(owner: Pick<Owner, "runtime">) {
  leases.delete(owner.runtime)
}

/**
 * Whether an owner's work may still be running: this process's lease while it is open; never a closed lease or a
 * legacy runtime ID (no ":"); unknown on another machine; otherwise its pid answering signal 0 in the same boot.
 */
export function alive(owner: Owner): Liveness {
  if (owner.runtime.startsWith(`${PROCESS_ID}:`)) return leases.has(owner.runtime) ? "alive" : "dead"
  return host(owner)
}

// Whether the owner's process is alive, whatever became of its instance.
function host(owner: Owner): Liveness {
  if (owner.runtime.startsWith(`${PROCESS_ID}:`)) return "alive"
  if (!owner.runtime.includes(":")) return "dead"
  const here = current()
  if (owner.machine !== here.machine) return "unknown"
  const state = probe(owner.pid)
  if (state === "dead") return "dead"
  // A pid answering in what reads as another boot may belong to another process now: Vector cannot tell.
  return state === "alive" && owner.boot === here.boot ? "alive" : "unknown"
}

const PROBE_TTL = 5_000
const probes = new Map<number, { at: number; state: "alive" | "dead" | undefined }>()

/** Whether no process holds `pid` any more (signal 0 answers ESRCH). */
export function exited(pid: number) {
  return probe(pid) === "dead"
}

function probe(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  const now = Date.now()
  const cached = probes.get(pid)
  if (cached && now - cached.at < PROBE_TTL) return cached.state
  if (probes.size >= 256) probes.clear()
  const state = signal(pid)
  probes.set(pid, { at: now, state })
  return state
}

function signal(pid: number): "alive" | "dead" | undefined {
  try {
    process.kill(pid, 0)
    return "alive"
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined
    if (code === "EPERM") return "alive"
    if (code === "ESRCH") return "dead"
    return undefined
  }
}

/** How long a running row may go without its owner's heartbeat (BackgroundJob.HEARTBEAT) before that owner is gone. */
export const STALE = 5 * HEARTBEAT

// When this process last woke: a gap in its own minute ticks means the machine slept, and every engine on it slept too.
// Their heartbeats are judged only once this process has been awake for STALE again, so they have time to beat.
let awake = { since: Date.now(), last: Date.now() }
let ticker: ReturnType<typeof setInterval> | undefined

function awakeSince(now: number) {
  if (!ticker) {
    ticker = setInterval(() => tick(Date.now()), HEARTBEAT)
    ticker.unref?.()
  }
  tick(now)
  return awake.since
}

function tick(now: number) {
  if (now - awake.last > 3 * HEARTBEAT) awake.since = now
  awake.last = Math.max(awake.last, now)
}

/** Tests: this process has been awake since `since`. */
export function useAwakeSince(since: number) {
  awake = { since, last: Date.now() }
}

/**
 * `alive` for a row: besides its owner, a running row whose owner on this machine stopped its heartbeat for STALE is
 * dead, whatever answers its pid now.
 */
export function liveness(row: Pick<Row, "owner" | "status" | "heartbeatAt">, now = Date.now()): Liveness {
  const owner = alive(row.owner)
  if (owner === "dead" || row.status !== "running" || row.owner.runtime.startsWith(`${PROCESS_ID}:`)) return owner
  if (row.owner.machine !== current().machine) return owner
  return now - row.heartbeatAt > STALE && now - awakeSince(now) >= STALE ? "dead" : owner
}

export type Row = {
  id: string
  type: string
  title?: string
  parentSessionID: string
  sessionID?: string
  directory: string
  status: BackgroundJob.Status
  background: boolean
  attempt?: number
  owner: Owner
  error?: string
  startedAt: number
  completedAt?: number
  reportedAt?: number
  /** The owner's last heartbeat while the row runs: its last write otherwise. */
  heartbeatAt: number
  metadata?: Record<string, unknown>
}

/** Why a row's work stopped: its engine died (`crash`), shut down (`shutdown`), or disposed the instance (`disposed`). */
export type Candidate = Row & { cause: "crash" | "shutdown" | "disposed" }

/** A helper an older Vector left running, recorded under its legacy runtime ID. */
export type Legacy = Omit<Row, "status" | "owner" | "error" | "completedAt" | "reportedAt" | "heartbeatAt"> & {
  runtime: string
  at: number
}

export interface Interface extends BackgroundJob.Store {
  readonly heartbeat: (owner: string, at: number) => Effect.Effect<void>
  /** This directory's unreported rows whose work stopped: running under a dead owner, or interrupted. */
  readonly candidates: (directory: string) => Effect.Effect<Candidate[]>
  /** Marks the row interrupted and reported, once: false when another engine, lease or attempt got there first. */
  readonly claim: (row: Pick<Row, "id" | "owner" | "attempt">, at: number) => Effect.Effect<boolean>
  /** Records a legacy helper as interrupted and reported: false when its job already has a row. */
  readonly insertLegacy: (row: Legacy) => Effect.Effect<boolean>
  readonly forParent: (parentSessionID: string) => Effect.Effect<Row[]>
  /**
   * Records on a background command's settled row how it ended (`metadata.ended`), so restart recovery can still tell
   * its session when the engine holding its exit note went away before the note was out.
   */
  readonly ended: (id: string, ended: Record<string, unknown>) => Effect.Effect<void>
  /** Marks an ended row's note as out, once: false when another engine, or an earlier delivery, got there first. */
  readonly delivered: (id: string, at: number) => Effect.Effect<boolean>
  /** This directory's ended background commands, recorded with `ended`, whose note never went out and whose owner is gone. */
  readonly undelivered: (directory: string) => Effect.Effect<Row[]>
  /** Deletes ended rows last touched before `before`. An interrupted row stays until it was reported. */
  readonly prune: (before: number) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@vector/BackgroundJobStore") {}

// The statuses of a job that ended on its own or was stopped, as opposed to one its engine's going away interrupted.
const ENDED: BackgroundJob.Status[] = ["completed", "error", "cancelled"]

const METADATA_MAX = 4 * 1024
const ERROR_MAX = 2_000

function bounded(metadata: Record<string, unknown> | undefined) {
  if (!metadata) return null
  try {
    return Buffer.byteLength(JSON.stringify(metadata)) <= METADATA_MAX ? metadata : null
  } catch {
    return null
  }
}

const attemptIs = (attempt: number | undefined) =>
  attempt === undefined ? isNull(BackgroundJobTable.attempt) : eq(BackgroundJobTable.attempt, attempt)

const held = (id: string, p: BackgroundJob.Holder) =>
  and(eq(BackgroundJobTable.id, id), eq(BackgroundJobTable.owner_runtime, p.owner), attemptIs(p.attempt))

function decode(row: typeof BackgroundJobTable.$inferSelect): Row {
  return {
    id: row.id,
    type: row.type,
    ...(row.title === null ? {} : { title: row.title }),
    parentSessionID: row.parent_session_id,
    ...(row.session_id === null ? {} : { sessionID: row.session_id }),
    directory: row.directory,
    status: row.status,
    background: row.background,
    ...(row.attempt === null ? {} : { attempt: row.attempt }),
    owner: { runtime: row.owner_runtime, pid: row.owner_pid, boot: row.owner_boot, machine: row.owner_machine },
    ...(row.error === null ? {} : { error: row.error }),
    startedAt: row.started_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.reported_at === null ? {} : { reportedAt: row.reported_at }),
    heartbeatAt: row.time_updated,
    ...(row.metadata === null ? {} : { metadata: row.metadata }),
  }
}

export function make(db: Database.Interface["db"]): Interface {
  const started = Effect.fn("BackgroundJobStore.started")(function* (row: BackgroundJob.Started) {
    const values = {
      type: row.type,
      title: row.title ?? null,
      parent_session_id: row.parentSessionID,
      session_id: row.sessionID ?? null,
      directory: row.directory,
      status: "running" as const,
      background: row.background,
      attempt: row.attempt ?? null,
      owner_runtime: row.owner.runtime,
      owner_pid: row.owner.pid,
      owner_boot: row.owner.boot,
      owner_machine: row.owner.machine,
      error: null,
      started_at: row.startedAt,
      completed_at: null,
      reported_at: null,
      metadata: bounded(row.metadata),
    }
    // A job started again under its id, as a resumed subagent is, takes its row over with its new lease and attempt.
    yield* db
      .insert(BackgroundJobTable)
      .values({ id: row.id, ...values })
      .onConflictDoUpdate({ target: BackgroundJobTable.id, set: { ...values, time_updated: Date.now() } })
      .run()
      .pipe(Effect.orDie)
  })

  const settled = Effect.fn("BackgroundJobStore.settled")(function* (id: string, p: BackgroundJob.Settled) {
    yield* db
      .update(BackgroundJobTable)
      .set({ status: p.status, completed_at: p.completedAt, error: p.error?.slice(0, ERROR_MAX) ?? null })
      .where(held(id, p))
      .run()
      .pipe(Effect.orDie)
  })

  const promoted = Effect.fn("BackgroundJobStore.promoted")(function* (id: string, p: BackgroundJob.Holder) {
    yield* db.update(BackgroundJobTable).set({ background: true }).where(held(id, p)).run().pipe(Effect.orDie)
  })

  const metadataUpdated = Effect.fn("BackgroundJobStore.metadataUpdated")(function* (
    id: string,
    p: BackgroundJob.MetadataUpdated,
    publish: Effect.Effect<void> = Effect.void,
  ) {
    const metadata = metadataSnapshot(p.metadata)
    if (!metadata) return false
    const query = db
      .update(BackgroundJobTable)
      .set({ metadata })
      .where(held(id, p))
      .returning({ id: BackgroundJobTable.id })
      .toSQL()
    return yield* Effect.scoped(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // Connection admission remains interruptible. The reserved native statement has no asynchronous result
          // mapping/acknowledgement between SQLite autocommit and the registry's short, database-free publication.
          const connection = yield* restore(db.$client.reserve)
          const rows = yield* connection.executeUnprepared(query.sql, query.params, undefined).pipe(Effect.orDie)
          if (!rows.length) return false
          yield* publish
          return true
        }),
      ),
    )
  })

  const heartbeat = Effect.fn("BackgroundJobStore.heartbeat")(function* (owner: string, at: number) {
    yield* db
      .update(BackgroundJobTable)
      .set({ time_updated: at })
      .where(and(eq(BackgroundJobTable.owner_runtime, owner), eq(BackgroundJobTable.status, "running")))
      .run()
      .pipe(Effect.orDie)
  })

  const candidates = Effect.fn("BackgroundJobStore.candidates")(function* (directory: string) {
    const rows = yield* db
      .select()
      .from(BackgroundJobTable)
      .where(
        and(
          inArray(BackgroundJobTable.status, ["running", "interrupted"]),
          eq(BackgroundJobTable.directory, directory),
          isNull(BackgroundJobTable.reported_at),
        ),
      )
      .orderBy(asc(BackgroundJobTable.started_at), asc(BackgroundJobTable.id))
      .all()
      .pipe(Effect.orDie)
    return rows.flatMap((item): Candidate[] => {
      const row = decode(item)
      if (row.status === "running") return liveness(row) === "dead" ? [{ ...row, cause: "crash" }] : []
      return [{ ...row, cause: host(row.owner) === "alive" ? "disposed" : "shutdown" }]
    })
  })

  const claim = Effect.fn("BackgroundJobStore.claim")(function* (
    row: Pick<Row, "id" | "owner" | "attempt">,
    at: number,
  ) {
    const claimed = yield* db
      .update(BackgroundJobTable)
      .set({ status: "interrupted", reported_at: at })
      .where(
        and(held(row.id, { owner: row.owner.runtime, attempt: row.attempt }), isNull(BackgroundJobTable.reported_at)),
      )
      .returning({ id: BackgroundJobTable.id })
      .get()
      .pipe(Effect.orDie)
    return claimed !== undefined
  })

  const insertLegacy = Effect.fn("BackgroundJobStore.insertLegacy")(function* (row: Legacy) {
    const inserted = yield* db
      .insert(BackgroundJobTable)
      .values({
        id: row.id,
        type: row.type,
        title: row.title ?? null,
        parent_session_id: row.parentSessionID,
        session_id: row.sessionID ?? null,
        directory: row.directory,
        status: "interrupted",
        background: row.background,
        attempt: row.attempt ?? null,
        owner_runtime: row.runtime,
        owner_pid: 0,
        owner_boot: 0,
        owner_machine: "",
        started_at: row.startedAt,
        reported_at: row.at,
        metadata: bounded(row.metadata),
      })
      .onConflictDoNothing()
      .returning({ id: BackgroundJobTable.id })
      .get()
      .pipe(Effect.orDie)
    return inserted !== undefined
  })

  const forParent = Effect.fn("BackgroundJobStore.forParent")(function* (parentSessionID: string) {
    const rows = yield* db
      .select()
      .from(BackgroundJobTable)
      .where(eq(BackgroundJobTable.parent_session_id, parentSessionID))
      .orderBy(asc(BackgroundJobTable.started_at), asc(BackgroundJobTable.id))
      .all()
      .pipe(Effect.orDie)
    return rows.map(decode)
  })

  const prune = Effect.fn("BackgroundJobStore.prune")(function* (before: number) {
    const removed = yield* db
      .delete(BackgroundJobTable)
      .where(
        and(
          ne(BackgroundJobTable.status, "running"),
          or(ne(BackgroundJobTable.status, "interrupted"), isNotNull(BackgroundJobTable.reported_at)),
          lt(
            sql`coalesce(${BackgroundJobTable.reported_at}, ${BackgroundJobTable.completed_at}, ${BackgroundJobTable.started_at})`,
            before,
          ),
        ),
      )
      .returning({ id: BackgroundJobTable.id })
      .all()
      .pipe(Effect.orDie)
    return removed.length
  })

  const ended = Effect.fn("BackgroundJobStore.ended")(function* (id: string, value: Record<string, unknown>) {
    const row = yield* db
      .select({ metadata: BackgroundJobTable.metadata })
      .from(BackgroundJobTable)
      .where(eq(BackgroundJobTable.id, id))
      .get()
      .pipe(Effect.orDie)
    // Metadata past its bound is not written: the row keeps what it had, and the note lives in memory as before.
    const metadata = row && bounded({ ...(row.metadata ?? {}), ended: value })
    if (!metadata) return
    yield* db
      .update(BackgroundJobTable)
      .set({ metadata })
      .where(and(eq(BackgroundJobTable.id, id), isNull(BackgroundJobTable.reported_at)))
      .run()
      .pipe(Effect.orDie)
  })

  const delivered = Effect.fn("BackgroundJobStore.delivered")(function* (id: string, at: number) {
    const marked = yield* db
      .update(BackgroundJobTable)
      .set({ reported_at: at })
      // The row's settlement is written apart from the job's completion, so it may still read running here. An
      // interrupted row is restart recovery's, which claims it.
      .where(
        and(
          eq(BackgroundJobTable.id, id),
          ne(BackgroundJobTable.status, "interrupted"),
          isNull(BackgroundJobTable.reported_at),
        ),
      )
      .returning({ id: BackgroundJobTable.id })
      .get()
      .pipe(Effect.orDie)
    return marked !== undefined
  })

  const undelivered = Effect.fn("BackgroundJobStore.undelivered")(function* (directory: string) {
    const rows = yield* db
      .select()
      .from(BackgroundJobTable)
      .where(
        and(
          eq(BackgroundJobTable.type, "shell"),
          inArray(BackgroundJobTable.status, ENDED),
          eq(BackgroundJobTable.directory, directory),
          isNull(BackgroundJobTable.reported_at),
        ),
      )
      .orderBy(asc(BackgroundJobTable.started_at), asc(BackgroundJobTable.id))
      .all()
      .pipe(Effect.orDie)
    return rows
      .map(decode)
      .filter(
        (row) => typeof row.metadata?.ended === "object" && row.metadata.ended !== null && alive(row.owner) === "dead",
      )
  })

  return {
    started,
    settled,
    promoted,
    metadataUpdated,
    heartbeat,
    candidates,
    claim,
    insertLegacy,
    forParent,
    ended,
    delivered,
    undelivered,
    prune,
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of(make((yield* Database.Service).db))
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
