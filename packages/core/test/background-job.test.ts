import { describe, expect } from "bun:test"
import { BackgroundJob } from "@vectordevai/core/background-job"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { it } from "./lib/effect"

const jobsLayer = LayerNode.compile(BackgroundJob.node)

describe("BackgroundJob", () => {
  it.live("completion seals all joined runs and holds waiting and same-id reuse outside the registry lock", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const first = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const waited = yield* Deferred.make<void>()
      const reused = yield* Deferred.make<void>()
      let calls = 0
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      const job = yield* jobs.start({
        id: "completion-reuse",
        type: "test",
        run: Deferred.await(first).pipe(Effect.as("first")),
        onComplete: (info) =>
          Effect.gen(function* () {
            calls++
            expect(info.outputs).toEqual(["first", "second"])
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }),
      })
      expect(yield* jobs.extend({ id: job.id, run: Deferred.await(second).pipe(Effect.as("second")) })).toBe(true)
      yield* Deferred.succeed(first, undefined)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(entered)).toBe(false)
      yield* Deferred.succeed(second, undefined)
      yield* Deferred.await(entered)
      expect(yield* jobs.extend({ id: job.id, run: Effect.die("must not enter a retired checkout") })).toBe(false)
      const waiter = yield* jobs.wait({ id: job.id }).pipe(
        Effect.tap(() => Deferred.succeed(waited, undefined)),
        Effect.forkScoped,
      )
      const next = yield* jobs
        .start({
          id: job.id,
          type: "test",
          run: Deferred.succeed(reused, undefined).pipe(Effect.as("next")),
        })
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(waited)).toBe(false)
      expect(yield* Deferred.isDone(reused)).toBe(false)
      // Registry operations remain available while saving work; completion itself holds no registry lock.
      expect((yield* jobs.list()).some((entry) => entry.id === job.id)).toBe(true)
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(waiter)).info?.output).toBe("second")
      yield* Fiber.join(next)
      expect((yield* jobs.wait({ id: job.id })).info?.output).toBe("next")
      expect(calls).toBe(1)
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("a failed completion callback cannot strand waiting or same-id reuse", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        id: "failed-completion",
        type: "test",
        run: Effect.succeed("saved result"),
        onComplete: () => Effect.die("completion failed"),
      })
      expect((yield* jobs.wait({ id: job.id })).info?.output).toBe("saved result")
      yield* jobs.start({ id: job.id, type: "test", run: Effect.succeed("reused") })
      expect((yield* jobs.wait({ id: job.id })).info?.output).toBe("reused")
    }).pipe(Effect.provide(jobsLayer)),
  )

  // A normal end's completion callback is a task's save, which may run Git. A Stop that arrives meanwhile (the parent's
  // Stop releasing a foreground child that has just returned, say) must not wait for it, since nothing can interrupt it.
  it.live("cancelling a job that already ended returns without waiting for its completion callback", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      const job = yield* jobs.start({
        id: "ended-saving",
        type: "test",
        run: Effect.succeed("report"),
        onComplete: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      })
      yield* Deferred.await(entered)
      // The job keeps its own outcome; it was not stopped.
      expect((yield* jobs.cancel(job.id).pipe(Effect.timeout("2 seconds")))?.status).toBe("completed")
      // Its waiters and a same-ID start still wait for the callback.
      expect((yield* jobs.wait({ id: job.id, timeout: 0 })).timedOut).toBe(true)
      const next = yield* jobs.start({ id: job.id, type: "test", run: Effect.succeed("next") }).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      expect((yield* jobs.get(job.id))?.output).toBe("report")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(next)
      expect((yield* jobs.wait({ id: job.id })).info?.output).toBe("next")
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("cancellation completion observes final writes before releasing its waiters", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const wrote = yield* Deferred.make<void>()
      let status: string | undefined
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(wrote, undefined))),
        onComplete: (info) =>
          Effect.gen(function* () {
            expect(yield* Deferred.isDone(wrote)).toBe(true)
            status = info.status
          }),
      })
      yield* jobs.cancel(job.id)
      expect(status).toBe("cancelled")
      expect((yield* jobs.wait({ id: job.id })).info?.status).toBe("cancelled")
    }).pipe(Effect.provide(jobsLayer)),
  )

  // The run completes a Deferred whose waiter stops the job in the same synchronous step. Interrupting the job's fiber
  // there re-entrantly handed the run's own `true` to the callback's first step and shifted every later result by one.
  it.live("a Stop issued inside the job's own step leaves its completion callback's results its own", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const go = yield* Deferred.make<void>()
      const running = yield* Deferred.make<void>()
      const done = yield* Deferred.make<readonly unknown[]>()
      yield* jobs.start({
        id: "sync-stop",
        type: "test",
        run: Deferred.await(go).pipe(
          Effect.andThen(Deferred.succeed(running, undefined)),
          Effect.andThen(Effect.never),
        ),
        onComplete: () =>
          Effect.gen(function* () {
            const first = yield* Effect.promise(async () => "first")
            const second = yield* Effect.promise(async () => "second")
            yield* Deferred.succeed(done, [first, second])
          }),
      })
      const stopper = yield* Deferred.await(running).pipe(Effect.andThen(jobs.cancel("sync-stop")), Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Deferred.succeed(go, undefined)
      expect((yield* Fiber.join(stopper))?.status).toBe("cancelled")
      expect(yield* Deferred.await(done).pipe(Effect.timeout("2 seconds"))).toEqual(["first", "second"])
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("duplicate cancellation and wait join final writes before releasing the job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const closed = yield* Deferred.make<void>()
      const duplicateDone = yield* Deferred.make<void>()
      const waiterDone = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(
          Effect.ensuring(
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Deferred.succeed(closed, undefined)),
              Effect.uninterruptible,
            ),
          ),
        ),
      })
      const first = yield* jobs.cancel(job.id).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      const duplicate = yield* jobs.cancel(job.id).pipe(
        Effect.tap(() => Deferred.succeed(duplicateDone, undefined)),
        Effect.forkScoped,
      )
      const waiter = yield* jobs.wait({ id: job.id }).pipe(
        Effect.tap(() => Deferred.succeed(waiterDone, undefined)),
        Effect.forkScoped,
      )
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(duplicateDone)).toBe(false)
      expect(yield* Deferred.isDone(waiterDone)).toBe(false)
      expect((yield* jobs.wait({ id: job.id, timeout: 0 })).timedOut).toBe(true)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(duplicate)
      expect((yield* Fiber.join(waiter)).info?.status).toBe("cancelled")
      expect(yield* Deferred.isDone(closed)).toBe(true)
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("reusing a cancelled id waits for the previous run's closing scope", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const nextStarted = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      const first = yield* jobs.start({
        id: "closing-reuse",
        type: "test",
        run: Effect.never.pipe(
          Effect.ensuring(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.uninterruptible),
          ),
        ),
      })
      const cancel = yield* jobs.cancel(first.id).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      const next = yield* jobs
        .start({ id: first.id, type: "test", run: Deferred.succeed(nextStarted, undefined).pipe(Effect.as("next")) })
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(nextStarted)).toBe(false)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(cancel)
      yield* Fiber.join(next)
      expect((yield* jobs.wait({ id: first.id })).info?.output).toBe("next")
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("a failing finalizer does not strand completion waiters or a duplicate cancellation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const ready = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        run: Deferred.succeed(ready, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.die("fixture finalizer")),
        ),
      })
      yield* Deferred.await(ready)
      yield* jobs.cancel(job.id).pipe(Effect.exit)
      expect((yield* jobs.wait({ id: job.id })).timedOut).toBe(false)
      yield* jobs.cancel(job.id).pipe(Effect.exit)
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("interrupting a canceller cannot abandon its closing job or strand another waiter", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(
          Effect.ensuring(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.uninterruptible),
          ),
        ),
      })
      const cancel = yield* jobs.cancel(job.id).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      const interrupt = yield* Fiber.interrupt(cancel).pipe(Effect.forkScoped)
      expect((yield* jobs.wait({ id: job.id, timeout: 0 })).timedOut).toBe(true)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interrupt)
      expect((yield* jobs.wait({ id: job.id })).info?.status).toBe("cancelled")
      expect((yield* jobs.cancel(job.id))?.status).toBe("cancelled")
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("a closing registry refuses extensions before executing any new work", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const jobs = yield* BackgroundJob.make.pipe(Scope.provide(scope))
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(
          Effect.ensuring(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.uninterruptible),
          ),
        ),
      })
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      expect(
        yield* jobs.extend({ id: job.id, run: Deferred.succeed(started, undefined).pipe(Effect.as("must not run")) }),
      ).toBe(false)
      expect(yield* Deferred.isDone(started)).toBe(false)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(closing)
      expect((yield* jobs.wait({ id: job.id })).timedOut).toBe(false)
    }),
  )

  it.live("refuses promotion without changing a foreground-only job and preserves default promotion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      let promoted = 0
      const fixed = yield* jobs.start({
        type: "test",
        promotable: false,
        run: Effect.never,
        onPromote: Effect.sync(() => {
          promoted += 1
        }),
      })
      expect(yield* jobs.promote(fixed.id)).toBeUndefined()
      expect(yield* jobs.get(fixed.id)).toEqual(fixed)
      expect(promoted).toBe(0)
      const ordinary = yield* jobs.start({
        type: "test",
        run: Effect.never,
        onPromote: Effect.sync(() => {
          promoted += 1
        }),
      })
      expect(yield* jobs.promote(ordinary.id)).toMatchObject({ metadata: { background: true } })
      expect(promoted).toBe(1)
      yield* jobs.promote(ordinary.id)
      expect(promoted).toBe(1)
    }).pipe(Effect.provide(jobsLayer)),
  )
  it.live("tracks process-local work through explicit observation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        metadata: { durable: false },
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job).toMatchObject({ type: "test", status: "running", metadata: { durable: false } })
      expect(yield* jobs.wait({ id: job.id, timeout: 0 })).toMatchObject({
        timedOut: true,
        info: { status: "running" },
      })

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("a run that fails with output settles as an error and keeps what it wrote", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        run: Effect.fail(new BackgroundJob.RunFailed({ message: "rate limited", output: "partial notes" })),
      })

      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "error", error: "rate limited", output: "partial notes" },
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("settles a running job as cancelled when its service shuts down", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const jobs = Context.get(yield* Layer.buildWithScope(jobsLayer, scope), BackgroundJob.Service)
      const job = yield* jobs.start({ type: "test", run: Effect.never })
      const waiter = yield* jobs.wait({ id: job.id }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Scope.close(scope, Exit.void)
      const settled = yield* Fiber.join(waiter).pipe(Effect.timeout("1 second"))
      expect(settled.info).toMatchObject({ id: job.id, status: "cancelled" })
    }),
  )

  it.live("publishes jobs before starting immediately settling work", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) => {
        const id = `job_immediate_start_${index}`
        return Effect.gen(function* () {
          const job = yield* jobs.start({
            id,
            type: "test",
            run: jobs
              .get(id)
              .pipe(
                Effect.flatMap((info) =>
                  info?.status === "running"
                    ? Effect.succeed(`done-${index}`)
                    : Effect.fail("job started before publish"),
                ),
              ),
          })

          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `done-${index}` },
          })
        })
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("increments pending work before starting immediately settling extensions", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) =>
        Effect.gen(function* () {
          const first = yield* Deferred.make<void>()
          const job = yield* jobs.start({
            type: "test",
            run: Deferred.await(first).pipe(Effect.as(`first-${index}`)),
          })

          expect(yield* jobs.extend({ id: job.id, run: Effect.succeed(`second-${index}`) })).toBe(true)
          expect((yield* jobs.get(job.id))?.status).toBe("running")

          yield* Deferred.succeed(first, undefined)
          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `second-${index}` },
          })
        }),
      )
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("keeps what every run wrote when a job is extended, not just the last", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const first = yield* Deferred.make<void>()
      const job = yield* jobs.start({ type: "test", run: Deferred.await(first).pipe(Effect.as("first report")) })
      yield* jobs.extend({ id: job.id, run: Effect.succeed("second report") })

      yield* Deferred.succeed(first, undefined)
      expect((yield* jobs.wait({ id: job.id })).info).toMatchObject({
        status: "completed",
        output: "second report",
        outputs: ["first report", "second report"],
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("a concurrent extension starts alongside the running run and the job settles after both", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const first = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      const job = yield* jobs.start({ type: "test", run: Deferred.await(first).pipe(Effect.as("first report")) })
      yield* jobs.extend({
        id: job.id,
        concurrent: true,
        run: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(second)),
          Effect.as("second report"),
        ),
      })

      // It started while the first run is still going.
      yield* Deferred.await(started).pipe(Effect.timeout("1 second"))
      yield* Deferred.succeed(first, undefined)
      expect((yield* jobs.wait({ id: job.id, timeout: 50 })).info?.status).toBe("running")

      yield* Deferred.succeed(second, undefined)
      expect((yield* jobs.wait({ id: job.id })).info).toMatchObject({
        status: "completed",
        outputs: ["first report", "second report"],
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("a failed run leaves the runs added after it, or alongside it, to finish", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const failing = yield* Deferred.make<void>()
      const queued = yield* jobs.start({
        type: "test",
        run: Deferred.await(failing).pipe(
          Effect.andThen(
            Effect.fail(new BackgroundJob.RunFailed({ message: "rate limited", output: "partial notes" })),
          ),
        ),
      })
      yield* jobs.extend({ id: queued.id, run: Effect.succeed("follow-up report") })
      yield* Deferred.succeed(failing, undefined)
      expect((yield* jobs.wait({ id: queued.id })).info).toMatchObject({
        status: "completed",
        output: "follow-up report",
        outputs: ["partial notes", "follow-up report"],
      })

      // A run added alongside that fails does not stop the run already going; the job ends as that latest run did.
      const first = yield* Deferred.make<void>()
      const running = yield* jobs.start({ type: "test", run: Deferred.await(first).pipe(Effect.as("first report")) })
      yield* jobs.extend({ id: running.id, concurrent: true, run: Effect.fail(new Error("could not deliver")) })
      expect((yield* jobs.wait({ id: running.id, timeout: 50 })).info?.status).toBe("running")
      yield* Deferred.succeed(first, undefined)
      expect((yield* jobs.wait({ id: running.id })).info).toMatchObject({
        status: "error",
        error: "could not deliver",
        output: "first report",
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("an extension racing the job's completion is either refused or runs before the job settles", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 200 }), (_, index) =>
        Effect.gen(function* () {
          const first = yield* Deferred.make<void>()
          let extensionRan = false
          const job = yield* jobs.start({
            type: "test",
            run: Deferred.await(first).pipe(Effect.as(`first-${index}`)),
          })

          // Release the first run and extend at the same moment, so settle and extend contend for the registry.
          const [, extended] = yield* Effect.all(
            [
              Deferred.succeed(first, undefined),
              jobs.extend({
                id: job.id,
                run: Effect.sync(() => {
                  extensionRan = true
                  return `second-${index}`
                }),
              }),
            ],
            { concurrency: "unbounded" },
          )

          // The pending count is raised atomically with the status check, so the job cannot settle without the
          // extension it accepted, and a refused extension never runs.
          const settled = yield* jobs.wait({ id: job.id }).pipe(Effect.timeout("2 seconds"))
          expect(settled.info?.status).toBe("completed")
          expect(extensionRan).toBe(extended)
          expect(settled.info?.output).toBe(extended ? `second-${index}` : `first-${index}`)
        }),
      )
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("interrupts live work and settles it as cancelled when the owning process-local scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const interrupted = yield* Deferred.make<void>()
      const jobs = yield* BackgroundJob.make.pipe(Scope.provide(scope))
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })

      yield* Scope.close(scope, Exit.void)

      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      // Waiters, such as the task that reports a background subagent, are told the job was stopped.
      expect((yield* jobs.get(job.id))?.status).toBe("cancelled")
    }),
  )
})

describe("BackgroundJob durable rows", () => {
  const owner = { runtime: "process:instance", pid: 4242, boot: 1_700_000_000_000, machine: "machine" }
  const durable = { parentSessionID: "ses_parent", sessionID: "ses_child", directory: "/repo", attempt: 2 }

  type Call =
    | { kind: "started"; row: BackgroundJob.Started }
    | { kind: "settled"; id: string; p: BackgroundJob.Settled }
    | { kind: "promoted"; id: string; p: BackgroundJob.Holder }

  // A store that records each call, then behaves as `act` says: write, fail, die or never answer.
  const recorder = (act: (call: Call) => Effect.Effect<void, unknown> = () => Effect.void) => {
    const calls: Call[] = []
    const record = (call: Call) => Effect.suspend(() => (calls.push(call), act(call)))
    const store: BackgroundJob.Store = {
      started: (row) => record({ kind: "started", row }),
      settled: (id, p) => record({ kind: "settled", id, p }),
      promoted: (id, p) => record({ kind: "promoted", id, p }),
    }
    return { calls, store }
  }

  const registry = (store: BackgroundJob.Store, disposing: () => boolean = () => false) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const jobs = yield* BackgroundJob.makeWith({ store, owner, disposing }).pipe(Scope.provide(scope))
      return { scope, jobs }
    })

  const until = (check: () => boolean) =>
    Effect.gen(function* () {
      while (!check()) yield* Effect.sleep("5 millis")
    }).pipe(Effect.timeout("2 seconds"))

  it.live("cancel() while not disposing records cancelled", () =>
    Effect.gen(function* () {
      const { calls, store } = recorder()
      const { scope, jobs } = yield* registry(store)
      const job = yield* jobs.start({ type: "task", durable, run: Effect.never })

      expect((yield* jobs.cancel(job.id))?.status).toBe("cancelled")
      yield* until(() => calls.some((call) => call.kind === "settled"))
      expect(calls.find((call) => call.kind === "settled")).toMatchObject({
        id: job.id,
        p: { owner: owner.runtime, attempt: 2, status: "cancelled" },
      })
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.live("while disposing, cancel() and closing the registry record interrupted", () =>
    Effect.gen(function* () {
      const { calls, store } = recorder()
      let disposing = false
      const { scope, jobs } = yield* registry(store, () => disposing)
      const cancelled = yield* jobs.start({ type: "task", durable, run: Effect.never })
      const closed = yield* jobs.start({ type: "task", durable, run: Effect.never })
      const waiter = yield* jobs.wait({ id: closed.id }).pipe(Effect.forkChild({ startImmediately: true }))

      disposing = true
      expect((yield* jobs.cancel(cancelled.id))?.status).toBe("interrupted")
      // Closing waits for the row: the instance is gone only once its jobs' rows say they were interrupted.
      yield* Scope.close(scope, Exit.void)
      expect((yield* Fiber.join(waiter)).info?.status).toBe("interrupted")
      expect(calls.filter((call) => call.kind === "settled" && call.id === closed.id)).toEqual([
        {
          kind: "settled",
          id: closed.id,
          p: expect.objectContaining({ owner: owner.runtime, attempt: 2, status: "interrupted" }),
        },
      ])
      yield* until(() => calls.some((call) => call.kind === "settled" && call.id === cancelled.id))
      expect(calls.find((call) => call.kind === "settled" && call.id === cancelled.id)).toMatchObject({
        p: { status: "interrupted" },
      })
    }),
  )

  it.live("durable jobs call the store: started, promoted, then settled, in that order", () =>
    Effect.gen(function* () {
      const { calls, store } = recorder()
      const { scope, jobs } = yield* registry(store)
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        id: "ses_child",
        type: "task",
        title: "Survey",
        metadata: { parentSessionId: "ses_parent" },
        durable: { ...durable, metadata: { agent: "explore" } },
        run: Deferred.await(latch).pipe(Effect.as("report")),
      })
      expect(job).toMatchObject({ owner: owner.runtime, durable: true })
      expect(yield* jobs.lease()).toEqual(owner)

      yield* jobs.promote(job.id)
      yield* Deferred.succeed(latch, undefined)
      expect((yield* jobs.wait({ id: job.id })).info?.status).toBe("completed")
      yield* until(() => calls.length === 3)
      expect(calls).toEqual([
        {
          kind: "started",
          row: {
            ...durable,
            metadata: { agent: "explore" },
            id: "ses_child",
            type: "task",
            title: "Survey",
            background: false,
            startedAt: job.started_at,
            owner,
          },
        },
        { kind: "promoted", id: "ses_child", p: { owner: owner.runtime, attempt: 2 } },
        {
          kind: "settled",
          id: "ses_child",
          p: { owner: owner.runtime, attempt: 2, status: "completed", completedAt: expect.any(Number) },
        },
      ])
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.live(
    "a failing or slow store never fails or blocks a job",
    () =>
      Effect.gen(function* () {
        for (const act of [
          () => Effect.fail(new Error("disk full")),
          () => Effect.die(new Error("database closed")),
          () => Effect.never,
        ]) {
          const { calls, store } = recorder(act)
          const { scope, jobs } = yield* registry(store)
          const begin = Date.now()
          const done = yield* jobs.start({ type: "task", durable, run: Effect.succeed("report") })
          const failed = yield* jobs.start({ type: "task", durable, run: Effect.fail(new Error("boom")) })
          const stopped = yield* jobs.start({
            type: "task",
            durable,
            metadata: { background: false },
            run: Effect.never,
          })
          yield* jobs.promote(stopped.id)
          expect((yield* jobs.cancel(stopped.id))?.status).toBe("cancelled")
          expect((yield* jobs.wait({ id: done.id })).info).toMatchObject({ status: "completed", output: "report" })
          expect((yield* jobs.wait({ id: failed.id })).info).toMatchObject({ status: "error", error: "boom" })
          // Well inside the store's 2 s allowance: nothing waited on it.
          expect(Date.now() - begin).toBeLessThan(1_000)
          expect(calls.length).toBeGreaterThan(0)
          yield* Scope.close(scope, Exit.void)
        }
      }),
    20_000,
  )

  it.effect("a registry refreshes its lease's heartbeat every minute while a durable job runs", () =>
    Effect.gen(function* () {
      const beats: string[] = []
      const { store } = recorder()
      const { scope, jobs } = yield* registry({
        ...store,
        heartbeat: (runtime) => Effect.sync(() => void beats.push(runtime)),
      })
      yield* TestClock.adjust("1 minute")
      // Nothing durable runs yet: no heartbeat.
      expect(beats).toEqual([])
      const job = yield* jobs.start({ type: "task", durable, run: Effect.never })
      yield* TestClock.adjust("1 minute")
      expect(beats).toEqual([owner.runtime])
      yield* jobs.cancel(job.id)
      yield* TestClock.adjust("1 minute")
      expect(beats).toEqual([owner.runtime])
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.live("non-durable jobs never touch the store", () =>
    Effect.gen(function* () {
      const { calls, store } = recorder()
      const { scope, jobs } = yield* registry(store)
      const done = yield* jobs.start({ type: "task", run: Effect.succeed("report") })
      const stopped = yield* jobs.start({ type: "task", run: Effect.never })
      yield* jobs.promote(stopped.id)
      yield* jobs.cancel(stopped.id)
      expect((yield* jobs.wait({ id: done.id })).info?.status).toBe("completed")
      expect(done.durable).toBeUndefined()
      expect(done.owner).toBeUndefined()
      yield* Scope.close(scope, Exit.void)
      expect(calls).toEqual([])
    }),
  )
})
