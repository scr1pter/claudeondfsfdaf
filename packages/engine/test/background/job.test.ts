import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { BackgroundJob } from "@/background/job"
import { disposing } from "@/effect/instance-registry"
import { InstanceStore } from "@/project/instance-store"
import { requireInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(BackgroundJob.node))
const durable = testEffect(
  LayerNode.compile(LayerNode.group([BackgroundJob.node, BackgroundJobStore.node, Database.node])),
)

// The session a durable job's row belongs to.
const parent = (directory: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(
      sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('prj', ${directory}, 1, 1, '[]')`,
    )
    yield* db.run(
      sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_parent', 'prj', 'parent', ${directory}, 'Parent', 'test', 1, 1)`,
    )
  })

describe("background.job", () => {
  it.instance("tracks started jobs through completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        title: "test job",
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job.id.startsWith("job_")).toBe(true)
      expect(job.status).toBe("running")
      expect(job.title).toBe("test job")

      yield* Deferred.succeed(latch, undefined)
      const done = yield* jobs.wait({ id: job.id })

      expect(done.timedOut).toBe(false)
      expect(done.info?.status).toBe("completed")
      expect(done.info?.output).toBe("done")
      expect((yield* jobs.list()).map((item) => item.id)).toEqual([job.id])
    }),
  )

  it.instance("returns a running snapshot when wait times out", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never,
      })

      const result = yield* jobs.wait({ id: job.id, timeout: 1 })

      expect(result.timedOut).toBe(true)
      expect(result.info?.status).toBe("running")
    }),
  )

  it.instance("deduplicates concurrent starts for a running id", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const started = yield* Deferred.make<void>()
      const id = "job_test"
      const [first, second] = yield* Effect.all(
        [
          jobs.start({
            id,
            type: "test",
            run: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          }),
          jobs.start({
            id,
            type: "test",
            run: Effect.fail(new Error("duplicate started")),
          }),
        ],
        { concurrency: "unbounded" },
      )

      yield* Deferred.await(started)

      expect(first.id).toBe(id)
      expect(second.id).toBe(id)
      expect(first.status).toBe("running")
      expect(second.status).toBe("running")
      expect((yield* jobs.list()).map((item) => item.id)).toEqual([id])

      yield* jobs.cancel(id)
    }),
  )

  it.instance("waits for extensions before completing a running job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const first = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        run: Deferred.await(first).pipe(Effect.as("first")),
      })

      expect(yield* jobs.extend({ id: job.id, run: Deferred.await(second).pipe(Effect.as("second")) })).toBe(true)
      yield* Deferred.succeed(first, undefined)
      expect((yield* jobs.get(job.id))?.status).toBe("running")

      yield* Deferred.succeed(second, undefined)
      const done = yield* jobs.wait({ id: job.id })
      expect(done.info?.status).toBe("completed")
      expect(done.info?.output).toBe("second")
    }),
  )

  it.instance("runs extensions after earlier work completes", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const first = yield* Deferred.make<void>()
      const order: string[] = []
      const job = yield* jobs.start({
        type: "test",
        run: Effect.sync(() => order.push("start")).pipe(Effect.andThen(Deferred.await(first)), Effect.as("first")),
      })

      expect(
        yield* jobs.extend({
          id: job.id,
          run: Effect.sync(() => order.push("extend")).pipe(Effect.as("second")),
        }),
      ).toBe(true)
      yield* Effect.yieldNow
      expect(order).toEqual(["start"])

      yield* Deferred.succeed(first, undefined)
      expect((yield* jobs.wait({ id: job.id })).info?.output).toBe("second")
      expect(order).toEqual(["start", "extend"])
    }),
  )

  it.instance("rejects extensions after a job completes", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({ type: "test", run: Effect.succeed("done") })
      yield* jobs.wait({ id: job.id })

      expect(yield* jobs.extend({ id: job.id, run: Effect.succeed("late") })).toBe(false)
      expect((yield* jobs.get(job.id))?.output).toBe("done")
    }),
  )

  it.instance("records failed jobs", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        run: Effect.fail(new Error("boom")),
      })

      const result = yield* jobs.wait({ id: job.id })

      expect(result.info?.status).toBe("error")
      expect(result.info?.error).toBe("boom")
    }),
  )

  // A job started again under its id waits for its stopped runs to wind down, so the stopped job's settlement can never
  // land on the new one (WP27's same-ID rule: a checkout being retired is never entered by a new run).
  it.instance("a same-ID restart waits for the stopped job's runs, whose settlement never touches the new one", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const interrupted = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const restartedRun = yield* Deferred.make<void>()
      const id = "job_test"
      // A failed run leaves the runs added after it to finish, so a run outliving its job's settlement is one still
      // winding down after a stop.
      yield* jobs.start({ id, type: "test", run: Effect.never })
      yield* jobs.extend({
        id,
        concurrent: true,
        run: Effect.never.pipe(
          Effect.ensuring(Deferred.succeed(interrupted, undefined).pipe(Effect.andThen(Deferred.await(release)))),
        ),
      })

      // The stop waits for the run to wind down, which here waits on release.
      const stopping = yield* jobs.cancel(id).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(interrupted)
      expect((yield* jobs.get(id))?.status).toBe("cancelled")
      const restarting = yield* jobs
        .start({
          id,
          type: "test",
          run: Deferred.succeed(restartedRun, undefined).pipe(Effect.andThen(Effect.never)),
        })
        .pipe(Effect.forkChild({ startImmediately: true }))

      // While the stopped run still winds down, the restart has not begun: its run never started, and the job is the
      // stopped one.
      yield* Effect.sleep("50 millis")
      expect(restarting.pollUnsafe()).toBeUndefined()
      expect(yield* Deferred.isDone(restartedRun)).toBe(false)
      expect((yield* jobs.get(id))?.status).toBe("cancelled")

      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(stopping))?.status).toBe("cancelled")
      expect((yield* Fiber.join(restarting)).status).toBe("running")
      yield* Deferred.await(restartedRun)
      // The stopped job settled before the restart, so nothing late overwrites the running one.
      yield* Effect.sleep("50 millis")
      expect((yield* jobs.get(id))?.status).toBe("running")
      yield* jobs.cancel(id)
    }),
  )

  it.instance("can cancel running jobs", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const interrupted = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })
      yield* jobs.extend({
        id: job.id,
        run: Effect.never,
      })

      const cancelled = yield* jobs.cancel(job.id)

      expect(cancelled?.status).toBe("cancelled")
      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      expect((yield* jobs.get(job.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("promotes running jobs without interrupting them", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const promoted = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        metadata: { parentSessionId: "parent" },
        onPromote: Deferred.succeed(promoted, undefined).pipe(Effect.asVoid),
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      const info = yield* jobs.promote(job.id)

      expect(info?.status).toBe("running")
      expect(info?.metadata?.background).toBe(true)
      yield* Deferred.await(promoted)
      expect((yield* jobs.get(job.id))?.status).toBe("running")

      yield* Deferred.succeed(latch, undefined)
      expect((yield* jobs.wait({ id: job.id })).info?.output).toBe("done")
    }),
  )

  it.instance("returns immutable snapshots", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        metadata: { value: "initial" },
        run: Effect.succeed("done"),
      })

      if (job.metadata) job.metadata.value = "changed"

      expect((yield* jobs.get(job.id))?.metadata?.value).toBe("initial")
    }),
  )
})

describe("background.job durable rows", () => {
  durable.instance("disposing an instance with a running durable job leaves the row interrupted", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const store = yield* BackgroundJobStore.Service
      const ctx = yield* requireInstance
      yield* parent(ctx.directory)
      const job = yield* jobs.start({
        id: "ses_child",
        type: "task",
        title: "Survey",
        run: Effect.never,
        durable: { parentSessionID: "ses_parent", sessionID: "ses_child", directory: ctx.directory, attempt: 1 },
      })
      const lease = yield* jobs.lease()
      expect(lease).toBeDefined()
      expect(job).toMatchObject({ durable: true, owner: lease!.runtime })
      expect(yield* store.forParent("ses_parent")).toEqual([
        expect.objectContaining({ id: "ses_child", status: "running", owner: lease, attempt: 1 }),
      ])
      expect(BackgroundJobStore.alive(lease!)).toBe("alive")
      const waiter = yield* jobs.wait({ id: job.id }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* InstanceStore.Service.use((instances) => instances.dispose(ctx))

      expect((yield* Fiber.join(waiter)).info?.status).toBe("interrupted")
      const [row] = yield* store.forParent("ses_parent")
      expect(row).toMatchObject({ id: "ses_child", status: "interrupted", owner: lease })
      expect(row.completedAt).toBeNumber()
      // The instance's lease closed after its jobs settled, and the directory is no longer disposing.
      expect(BackgroundJobStore.alive(lease!)).toBe("dead")
      expect(disposing(ctx.directory)).toBe(false)
    }),
  )

  durable.instance("a running durable job's row is interrupted when the service itself shuts down", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* BackgroundJobStore.Service
      const ctx = yield* requireInstance
      yield* parent(ctx.directory)
      // A second service over the same database, built apart as a server listener builds its own.
      const scope = yield* Scope.make()
      const jobs = Context.get(
        yield* Layer.buildWithMemoMap(
          LayerNode.compile(BackgroundJob.node, [[Database.node, Layer.succeed(Database.Service, database)]]),
          Layer.makeMemoMapUnsafe(),
          scope,
        ),
        BackgroundJob.Service,
      )
      yield* jobs.start({
        id: "ses_child",
        type: "task",
        run: Effect.never,
        durable: { parentSessionID: "ses_parent", directory: ctx.directory },
      })

      yield* Scope.close(scope, Exit.void)

      expect(yield* store.forParent("ses_parent")).toEqual([
        expect.objectContaining({ id: "ses_child", status: "interrupted" }),
      ])
      expect(disposing(ctx.directory)).toBe(false)
    }),
  )
})
