import { afterAll, describe, expect } from "bun:test"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Context, Effect, Layer, Scope } from "effect"
import type { BackgroundJob } from "@vectordevai/core/background-job"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { Database } from "@vectordevai/core/database/database"
import { it } from "./lib/effect"

// Before anything reads the machine id, so the test never writes the user's state folder.
const temporary = mkdtempSync(path.join(os.tmpdir(), "vector-core-test-"))
afterAll(() => rmSync(temporary, { recursive: true, force: true }))
const machineFile = path.join(temporary, "machine-id")
BackgroundJobStore.useMachineFile(machineFile)

const directory = path.join(temporary, "repo")
const elsewhere = path.join(temporary, "other")

// A pid that existed and is gone: a child that ran and exited.
const exitedPid = () => {
  const child = process.platform === "win32" ? spawnSync("cmd", ["/c", "exit"]) : spawnSync("true")
  if (!child.pid) throw new Error("could not start a child process")
  return child.pid
}

// An owner in another process on this machine and boot, with the given pid.
const foreign = (pid: number): BackgroundJobStore.Owner => ({
  ...BackgroundJobStore.current(),
  runtime: `${randomUUID()}:${randomUUID()}`,
  pid,
})

const withStore = <A, E>(
  body: (store: BackgroundJobStore.Interface) => Effect.Effect<A, E, Database.Service>,
  file = ":memory:",
) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* parents(db)
    return yield* body(BackgroundJobStore.make(db))
  }).pipe(Effect.provide(Database.layerFromPath(file)))

const parents = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    yield* db.run(
      sql`INSERT OR IGNORE INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('prj', ${directory}, 1, 1, '[]')`,
    )
    yield* db.run(
      sql`INSERT OR IGNORE INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_parent', 'prj', 'parent', ${directory}, 'Parent', 'test', 1, 1)`,
    )
  })

const row = (input: Partial<BackgroundJob.Started> & { owner: BackgroundJobStore.Owner }): BackgroundJob.Started => ({
  id: `job_${randomUUID()}`,
  type: "task",
  parentSessionID: "ses_parent",
  directory,
  background: false,
  startedAt: 1_000,
  attempt: 1,
  ...input,
})

describe("BackgroundJobStore", () => {
  it.live("the store's write and read paths round-trip", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const owner = BackgroundJobStore.open()
        const started = row({
          id: "ses_child",
          title: "Survey",
          sessionID: "ses_child",
          owner,
          metadata: { agent: "explore" },
        })
        yield* store.started(started)
        expect(yield* store.forParent("ses_parent")).toEqual([
          {
            id: "ses_child",
            type: "task",
            title: "Survey",
            parentSessionID: "ses_parent",
            sessionID: "ses_child",
            directory,
            status: "running",
            background: false,
            attempt: 1,
            owner,
            startedAt: 1_000,
            heartbeatAt: expect.any(Number),
            metadata: { agent: "explore" },
          },
        ])

        yield* store.promoted("ses_child", { owner: owner.runtime, attempt: 1 })
        yield* store.settled("ses_child", {
          owner: owner.runtime,
          attempt: 1,
          status: "error",
          completedAt: 2_000,
          error: "x".repeat(5_000),
        })
        const [settled] = yield* store.forParent("ses_parent")
        expect(settled).toMatchObject({ status: "error", background: true, completedAt: 2_000 })
        expect(settled.error?.length).toBe(2_000)

        // A resume starts the job again under its id: the row is taken over by the new lease and attempt.
        const next = BackgroundJobStore.open()
        yield* store.started({
          ...started,
          owner: next,
          attempt: 2,
          startedAt: 3_000,
          metadata: { big: "x".repeat(5_000) },
        })
        const [resumed] = yield* store.forParent("ses_parent")
        expect(resumed).toMatchObject({
          status: "running",
          attempt: 2,
          owner: next,
          startedAt: 3_000,
          background: false,
        })
        expect(resumed.completedAt).toBeUndefined()
        expect(resumed.error).toBeUndefined()
        // Metadata past 4 KiB is not kept.
        expect(resumed.metadata).toBeUndefined()

        const legacy = {
          id: "ses_legacy",
          type: "task",
          parentSessionID: "ses_parent",
          directory,
          background: true,
          startedAt: 500,
          runtime: randomUUID(),
          at: 4_000,
        }
        expect(yield* store.insertLegacy(legacy)).toBe(true)
        expect(yield* store.insertLegacy(legacy)).toBe(false)
        expect((yield* store.forParent("ses_parent")).map((item) => [item.id, item.status, item.reportedAt])).toEqual([
          ["ses_legacy", "interrupted", 4_000],
          ["ses_child", "running", undefined],
        ])
        BackgroundJobStore.close(owner)
        BackgroundJobStore.close(next)
      }),
    ),
  )

  it.live("candidates are this directory's unreported rows whose work stopped, with the cause", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const live = BackgroundJobStore.open()
        const closed = BackgroundJobStore.open()
        BackgroundJobStore.close(closed)
        const dead = foreign(exitedPid())
        const remote = { ...foreign(process.ppid), machine: "another-machine" }
        const crashed = row({ owner: dead })
        const lost = row({ owner: closed })
        const shutdown = row({ owner: dead })
        const disposed = row({ owner: closed })
        for (const item of [
          crashed,
          lost,
          shutdown,
          disposed,
          row({ owner: live }),
          row({ owner: remote }),
          row({ owner: dead, directory: elsewhere }),
        ])
          yield* store.started(item)
        for (const item of [shutdown, disposed])
          yield* store.settled(item.id, {
            owner: item.owner.runtime,
            attempt: item.attempt,
            status: "interrupted",
            completedAt: 1_500,
          })
        const reported = row({ owner: dead })
        yield* store.started(reported)
        expect(yield* store.claim(reported, 1_600)).toBe(true)

        const found = yield* store.candidates(directory)
        expect(Object.fromEntries(found.map((item) => [item.id, item.cause]))).toEqual({
          [crashed.id]: "crash",
          [lost.id]: "crash",
          [shutdown.id]: "shutdown",
          // Its engine (this process) is still running: only the instance was disposed.
          [disposed.id]: "disposed",
        })
        BackgroundJobStore.close(live)
      }),
    ),
  )

  it.live("two concurrent claims return true once", () =>
    Effect.gen(function* () {
      const file = path.join(temporary, `claims-${randomUUID()}.db`)
      const job = row({ owner: foreign(exitedPid()) })
      yield* withStore((store) => store.started(job), file)
      // Two engines on one vector.db, each with its own connection.
      const connect = Effect.gen(function* () {
        const layer = Database.layerFromPath(file)
        const context = yield* Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), yield* Scope.Scope)
        return Context.get(context, Database.Service).db
      })
      const first = yield* connect
      const second = yield* connect
      expect(first).not.toBe(second)
      const claims = yield* Effect.all(
        [BackgroundJobStore.make(first).claim(job, 2_000), BackgroundJobStore.make(second).claim(job, 2_001)],
        { concurrency: "unbounded" },
      )
      expect(claims.toSorted()).toEqual([false, true])
      const [claimed] = yield* withStore((store) => store.forParent("ses_parent"), file)
      expect(claimed).toMatchObject({ id: job.id, status: "interrupted" })
      expect([2_000, 2_001]).toContain(claimed.reportedAt!)
    }),
  )

  // A background command's exit note waits in its engine's memory; its row keeps how it ended until the note is out.
  it.live("an ended command's note is undelivered until marked once, and only a gone owner's is offered", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const live = BackgroundJobStore.open()
        const gone = foreign(exitedPid())
        const shell = (owner: BackgroundJobStore.Owner) =>
          row({ type: "shell", owner, metadata: { command: "bun run build", outputPath: "/tmp/shell.log" } })
        const ended = shell(gone)
        const held = shell(live)
        const silent = shell(gone)
        for (const job of [ended, held, silent]) {
          yield* store.started(job)
          yield* store.settled(job.id, { owner: job.owner.runtime, attempt: 1, status: "error", completedAt: 2_000 })
        }
        // A row that recorded no end (an older engine, or a metadata write that failed) is not offered.
        for (const job of [ended, held]) yield* store.ended(job.id, { state: "failed", bytes: 12, exitCode: 2 })
        const offered = yield* store.undelivered(directory)
        expect(offered.map((item) => item.id)).toEqual([ended.id])
        expect(offered[0]?.metadata).toEqual({
          command: "bun run build",
          outputPath: "/tmp/shell.log",
          ended: { state: "failed", bytes: 12, exitCode: 2 },
        })
        expect(yield* store.undelivered(elsewhere)).toEqual([])
        // Marked once, across engines; then it is no longer offered, and a late end no longer changes the row.
        expect(yield* store.delivered(ended.id, 3_000)).toBe(true)
        expect(yield* store.delivered(ended.id, 3_001)).toBe(false)
        expect(yield* store.undelivered(directory)).toEqual([])
        yield* store.ended(ended.id, { state: "completed", bytes: 1 })
        const rows = yield* store.forParent("ses_parent")
        expect(rows.find((item) => item.id === ended.id)).toMatchObject({
          reportedAt: 3_000,
          metadata: { ended: { state: "failed" } },
        })
        // An interrupted row is restart recovery's to claim, never marked here.
        const interrupted = row({ type: "shell", owner: gone })
        yield* store.started(interrupted)
        yield* store.settled(interrupted.id, {
          owner: gone.runtime,
          attempt: 1,
          status: "interrupted",
          completedAt: 2_000,
        })
        expect(yield* store.delivered(interrupted.id, 3_000)).toBe(false)
        BackgroundJobStore.close(live)
      }),
    ),
  )

  it.live("a stale owner or attempt is a no-op", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const owner = foreign(exitedPid())
        const job = row({ owner, attempt: 3 })
        yield* store.started(job)
        for (const stale of [
          { owner: `${randomUUID()}:${randomUUID()}`, attempt: 3 },
          { owner: owner.runtime, attempt: 2 },
          { owner: owner.runtime, attempt: undefined },
        ]) {
          yield* store.settled(job.id, { ...stale, status: "completed", completedAt: 2_000 })
          yield* store.promoted(job.id, stale)
          expect(
            yield* store.claim(
              { id: job.id, owner: { ...owner, runtime: stale.owner }, attempt: stale.attempt },
              2_000,
            ),
          ).toBe(false)
        }
        expect(yield* store.forParent("ses_parent")).toEqual([
          expect.objectContaining({ id: job.id, status: "running", background: false, attempt: 3 }),
        ])
        const [unchanged] = yield* store.forParent("ses_parent")
        expect(unchanged.reportedAt).toBeUndefined()
        expect(unchanged.completedAt).toBeUndefined()
      }),
    ),
  )

  it.live("a heartbeat refreshes only its lease's running rows", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const owner = foreign(process.ppid)
        const running = row({ owner })
        const ended = row({ owner })
        const other = row({ owner: foreign(process.ppid) })
        for (const job of [running, ended, other]) yield* store.started(job)
        yield* store.settled(ended.id, { owner: owner.runtime, attempt: 1, status: "completed", completedAt: 2_000 })
        const { db } = yield* Database.Service
        yield* db.run(sql`UPDATE background_job SET time_updated = 5`)
        yield* store.heartbeat(owner.runtime, 9_000)
        const rows = yield* store.forParent("ses_parent")
        expect(Object.fromEntries(rows.map((item) => [item.id, item.heartbeatAt]))).toEqual({
          [running.id]: 9_000,
          [ended.id]: 5,
          [other.id]: 5,
        })
      }),
    ),
  )

  it.live("prune deletes old ended rows, keeping running and unreported interrupted ones", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const owner = foreign(exitedPid())
        const settle = (job: BackgroundJob.Started, status: BackgroundJob.Settled["status"], completedAt: number) =>
          store.settled(job.id, { owner: job.owner.runtime, attempt: job.attempt, status, completedAt })
        const old = row({ owner })
        const recent = row({ owner })
        const running = row({ owner })
        const unreported = row({ owner })
        const reported = row({ owner })
        for (const job of [old, recent, running, unreported, reported]) yield* store.started(job)
        yield* settle(old, "completed", 2_000)
        yield* settle(recent, "cancelled", 9_000)
        yield* settle(unreported, "interrupted", 2_000)
        yield* settle(reported, "interrupted", 2_000)
        expect(yield* store.claim(reported, 3_000)).toBe(true)

        expect(yield* store.prune(5_000)).toBe(2)
        expect((yield* store.forParent("ses_parent")).map((item) => item.id).toSorted()).toEqual(
          [recent.id, running.id, unreported.id].toSorted(),
        )
      }),
    ),
  )
})

describe("BackgroundJobStore.alive", () => {
  it.live("a live instance is alive and a closed one is dead", () =>
    Effect.sync(() => {
      const lease = BackgroundJobStore.open()
      expect(lease.runtime.startsWith(`${BackgroundJobStore.PROCESS_ID}:`)).toBe(true)
      expect(BackgroundJobStore.alive(lease)).toBe("alive")
      BackgroundJobStore.close(lease)
      expect(BackgroundJobStore.alive(lease)).toBe("dead")
    }),
  )

  it.live("a legacy runtime ID is dead", () =>
    Effect.sync(() => {
      expect(BackgroundJobStore.alive({ ...foreign(process.ppid), runtime: randomUUID() })).toBe("dead")
    }),
  )

  it.live("an exited child's pid is dead, and process.ppid is alive", () =>
    Effect.sync(() => {
      expect(BackgroundJobStore.alive(foreign(exitedPid()))).toBe("dead")
      expect(BackgroundJobStore.alive(foreign(process.ppid))).toBe("alive")
    }),
  )

  it.live("a live pid in another boot is unknown, and so is another machine", () =>
    Effect.sync(() => {
      const parent = foreign(process.ppid)
      expect(BackgroundJobStore.alive({ ...parent, boot: parent.boot + 60_000 })).toBe("unknown")
      expect(BackgroundJobStore.alive({ ...parent, machine: "another-machine" })).toBe("unknown")
      expect(BackgroundJobStore.alive({ ...foreign(exitedPid()), machine: "another-machine" })).toBe("unknown")
    }),
  )

  it.live(
    "a running row whose owner stopped its heartbeat is dead whatever its pid answers, once awake long enough",
    () =>
      Effect.sync(() => {
        const now = Date.now()
        const live = { owner: foreign(process.ppid), status: "running" as const }
        const stale = { ...live, heartbeatAt: now - BackgroundJobStore.STALE - 1_000 }
        BackgroundJobStore.useAwakeSince(now - BackgroundJobStore.STALE - 1_000)
        expect(BackgroundJobStore.liveness({ ...live, heartbeatAt: now })).toBe("alive")
        expect(BackgroundJobStore.liveness(stale)).toBe("dead")
        // Only running rows have a heartbeat, and another machine's clock is not this one's.
        expect(BackgroundJobStore.liveness({ ...stale, status: "interrupted" })).toBe("alive")
        expect(BackgroundJobStore.liveness({ ...stale, owner: { ...stale.owner, machine: "another-machine" } })).toBe(
          "unknown",
        )
        // Just after a wake (or a start), every engine here gets time to beat again.
        BackgroundJobStore.useAwakeSince(now)
        expect(BackgroundJobStore.liveness(stale)).toBe("alive")
      }),
  )

  it.live("the machine id is a private file every engine of this state folder shares", () =>
    Effect.sync(() => {
      const id = BackgroundJobStore.current().machine
      expect(readFileSync(machineFile, "utf8")).toBe(id)
      if (process.platform !== "win32") expect(statSync(machineFile).mode & 0o777).toBe(0o600)
      // Read again, as another engine starting later would.
      BackgroundJobStore.useMachineFile(machineFile)
      expect(BackgroundJobStore.current().machine).toBe(id)
      // A different state folder is a different machine id.
      BackgroundJobStore.useMachineFile(path.join(temporary, "elsewhere", "machine-id"))
      expect(BackgroundJobStore.current().machine).not.toBe(id)
      BackgroundJobStore.useMachineFile(machineFile)
      expect(BackgroundJobStore.current().machine).toBe(id)
    }),
  )
})
