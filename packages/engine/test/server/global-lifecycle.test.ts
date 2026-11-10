import { describe, expect } from "bun:test"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Deferred, Effect } from "effect"
import { BackgroundJob } from "@/background/job"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([BackgroundJob.node, SessionStatus.node])))

// A reload disposes the instance's state, so a job it knew about is gone afterwards.
const reloaded = (jobs: BackgroundJob.Interface, id: string) =>
  pollWithTimeout(
    jobs.get(id).pipe(Effect.map((info) => (info === undefined ? true : undefined))),
    "the instance never reloaded",
    "5 seconds",
  )

describe("global reload", () => {
  it.instance("waits for a running background subagent instead of stopping it, then reloads", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const release = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "task",
        metadata: { background: true },
        run: Deferred.await(release).pipe(Effect.as("found it")),
      })

      // What a provider key change in Settings does.
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      expect((yield* jobs.get(job.id))?.status).toBe("running")

      yield* Deferred.succeed(release, undefined)
      expect((yield* jobs.wait({ id: job.id })).info).toMatchObject({ status: "completed", output: "found it" })
      yield* reloaded(jobs, job.id)
    }),
  )

  it.instance("waits for a busy session before reloading its instance", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const statuses = yield* SessionStatus.Service
      const session = SessionID.make("ses_global_reload_busy")
      const marker = yield* jobs.start({ type: "marker", run: Effect.succeed("done") })
      yield* jobs.wait({ id: marker.id })
      yield* statuses.set(session, { type: "busy" })

      yield* disposeAllInstancesAndEmitGlobalDisposed()
      expect((yield* jobs.get(marker.id))?.status).toBe("completed")
      expect((yield* statuses.get(session)).type).toBe("busy")

      yield* statuses.set(session, { type: "idle" })
      yield* reloaded(jobs, marker.id)
    }),
  )

  it.instance("waits for the report of a background subagent that just finished to reach its parent", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({ type: "task", metadata: { background: true }, run: Effect.succeed("found it") })
      yield* jobs.wait({ id: job.id })

      yield* disposeAllInstancesAndEmitGlobalDisposed()
      // The report is batched and admitted to the parent after the job settles, so the instance is kept meanwhile.
      expect((yield* jobs.get(job.id))?.status).toBe("completed")
      yield* reloaded(jobs, job.id)
    }),
  )

  it.instance("does not wait for a session that is only retrying a provider call", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const statuses = yield* SessionStatus.Service
      const marker = yield* jobs.start({ type: "marker", run: Effect.succeed("done") })
      yield* jobs.wait({ id: marker.id })
      // A session stuck retrying on a key the user just replaced in Settings.
      yield* statuses.set(SessionID.make("ses_global_reload_retry"), {
        type: "retry",
        attempt: 3,
        message: "Rate limited",
        next: Date.now() + 60_000,
      })

      yield* disposeAllInstancesAndEmitGlobalDisposed()

      expect(yield* jobs.get(marker.id)).toBeUndefined()
    }),
  )

  // A dev server has no end, so waiting for it would keep the old settings, spend ceiling included, indefinitely (5.H).
  it.instance("does not wait for a running background command, and the reload stops it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "shell",
        metadata: { background: true, command: "bun run dev" },
        run: Effect.never,
      })
      expect((yield* jobs.get(job.id))?.status).toBe("running")

      yield* disposeAllInstancesAndEmitGlobalDisposed()

      expect(yield* jobs.get(job.id)).toBeUndefined()
    }),
  )

  it.instance("still waits for a background subagent while a background command runs beside it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const release = yield* Deferred.make<void>()
      yield* jobs.start({ type: "shell", metadata: { background: true, command: "bun run dev" }, run: Effect.never })
      const task = yield* jobs.start({
        type: "task",
        metadata: { background: true },
        run: Deferred.await(release).pipe(Effect.as("found it")),
      })

      yield* disposeAllInstancesAndEmitGlobalDisposed()
      expect((yield* jobs.get(task.id))?.status).toBe("running")

      yield* Deferred.succeed(release, undefined)
      yield* reloaded(jobs, task.id)
    }),
  )

  it.instance("reloads an idle instance right away", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const marker = yield* jobs.start({ type: "marker", run: Effect.succeed("done") })
      yield* jobs.wait({ id: marker.id })

      yield* disposeAllInstancesAndEmitGlobalDisposed()

      expect(yield* jobs.get(marker.id)).toBeUndefined()
    }),
  )
})
