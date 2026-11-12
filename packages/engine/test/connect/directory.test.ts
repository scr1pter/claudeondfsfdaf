import { afterEach, beforeEach, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { Database } from "@vectordevai/core/database/database"
import { BackgroundJobTable } from "@vectordevai/core/background-job.sql"
import { eq } from "drizzle-orm"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { Global } from "@vectordevai/core/global"
import { Npm } from "@vectordevai/core/npm"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { Connect } from "@vectordevai/schema/connect"
import { BackgroundJob } from "@/background/job"
import type { ConnectAdapter } from "@/connect/adapter"
import { ConnectDirectory } from "@/connect/directory"
import { ConnectHub } from "@/connect/hub"
import { ConnectOwner } from "@/connect/owner"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { NpmTest } from "../fake/npm"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { pollWithTimeout, testEffect } from "../lib/effect"

const script: { calls: number; gate?: Deferred.Deferred<void>; oversized: boolean; verdict: "clean" | "incomplete" } = {
  calls: 0,
  oversized: false,
  verdict: "clean",
}
beforeEach(() => {
  script.calls = 0
  script.oversized = false
  script.verdict = "clean"
  delete script.gate
})
afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const adapter: ConnectAdapter.Adapter = {
  id: "vectorscope",
  owner: "vectorscope",
  describe: () =>
    Effect.succeed({
      id: "vectorscope",
      owner: "vectorscope",
      kind: "agent",
      title: "VectorScope",
      summary: "Directory receipt fixture",
      place: "local",
      sendsTo: "provider:fixture",
      state: "ready",
      reach: "connect",
      actions: [{ id: "review", title: "Review", effects: ["read"], background: true, result: "review" }],
    }),
  handle: (request, context) =>
    Effect.gen(function* () {
      yield* context.ask({
        permission: "connect_model",
        patterns: ["fixture/priced"],
        always: ["fixture/priced"],
        message: "Send this diff to the priced fixture review model, capped at $0.50.",
        model: "fixture/priced",
        sendsTo: "provider:fixture",
        maxCostUsd: 0.5,
      })
      script.calls++
      if (context.working) yield* context.working({ maxCostUsd: 0.5 })
      if (script.gate) yield* Deferred.await(script.gate)
      return {
        state: "completed",
        verdict: script.oversized ? "findings" : script.verdict,
        summary: "The selected directory was reviewed.",
        findings: script.oversized
          ? Array.from({ length: Connect.MAX_FINDINGS }, (_, i) => ({
              id: `finding_${i}`,
              path: `src/file-${i}.ts`,
              line: 1,
              side: "RIGHT" as const,
              severity: "concern" as const,
              category: "bug" as const,
              title: "A bounded claim",
              body: "b".repeat(Connect.MAX_BODY),
              suggestion: "s".repeat(Connect.MAX_BODY),
              source: "review" as const,
              bucket: "inline" as const,
              status: "open" as const,
            }))
          : [],
        sessions: [],
        notes: [],
        target: request.action === "review" ? request.target : undefined,
        cost: { kind: "priced", usd: 0.12 },
        sendsTo: "provider:fixture",
      } satisfies Connect.Result
    }),
}

const graph = (enabled: boolean) =>
  AppNodeBuilder.build(
    LayerNode.group([
      ConnectOwner.node,
      ConnectHub.node,
      Session.node,
      Permission.node,
      SessionAudience.node,
      BackgroundJobStore.node,
      BackgroundJob.node,
      Database.node,
      EventV2Bridge.node,
      InstanceStore.node,
    ]),
    [
      [ConnectHub.node, ConnectHub.nodeWith([adapter])],
      [SessionPrompt.node, Layer.mock(SessionPrompt.Service)({})],
      [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
      [Npm.node, NpmTest.noop],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalConnect: enabled, experimentalEventSystem: true })],
    ],
  )
const it = testEffect(graph(true))
const off = testEffect(graph(false))
const options = { config: { permission: { connect: "allow" as const, connect_model: "ask" as const } } }

const fixture = Effect.gen(function* () {
  const owner = yield* ConnectOwner.Service
  const sessions = yield* Session.Service
  const permission = yield* Permission.Service
  const store = yield* InstanceStore.Service
  const jobs = yield* BackgroundJobStore.Service
  const background = yield* BackgroundJob.Service
  const current = yield* InstanceState.context
  const scope = { projectID: current.project.id, directory: current.directory }
  yield* Effect.addFinalizer(() =>
    Effect.promise(() =>
      fs.rm(path.join(Global.Path.data, "storage", ...ConnectDirectory.prefix(scope)), {
        recursive: true,
        force: true,
      }),
    ),
  )
  const pending = (id: string) =>
    pollWithTimeout(
      permission.list().pipe(Effect.map((rows) => rows.find((row) => row.metadata.runID === id))),
      "No directory consent was published",
    )
  const ended = (id: string) =>
    pollWithTimeout(
      owner.get(id).pipe(Effect.map((row) => (row.status === "done" ? row : undefined))),
      "The directory review did not settle",
    )
  const reload = (id: string, anchor: SessionID) =>
    Effect.gen(function* () {
      const completion = yield* background.wait({ id, timeout: 5_000 })
      if (completion.timedOut) throw new Error("The actual directory completion callback did not finish")
      yield* pollWithTimeout(
        jobs
          .forParent(anchor)
          .pipe(Effect.map((rows) => rows.find((row) => row.id === id && row.status !== "running"))),
        "The durable directory job did not settle",
      )
      return yield* store.reload({ directory: current.directory, worktree: current.worktree, project: current.project })
    })
  const approve = (id: string) =>
    Effect.gen(function* () {
      const ask = yield* pending(id)
      yield* permission.reply({ requestID: ask.id, reply: "once" })
      return ask
    })
  return { owner, sessions, permission, current, scope, jobs, background, store, pending, ended, approve, reload }
})

it.instance(
  "directory review queues a genuine durable job and asks the private owner without a conversation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const events = yield* EventV2Bridge.Service
      const envelopes: { sessionID?: string; run: Connect.Run }[] = []
      const unsubscribe = yield* events.listen((event) => {
        if (event.type !== Connect.Event.RunUpdated.type) return Effect.void
        const decoded = Schema.decodeUnknownOption(Connect.Event.RunUpdated.data)(event.data)
        if (Option.isSome(decoded)) envelopes.push(decoded.value)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)
      const queued = yield* f.owner.directoryReview({ background: true })
      expect(queued.status).not.toBe("done")
      expect(queued.request.requester).toEqual({ kind: "user", agent: "build" })
      const ask = yield* f.pending(queued.id)
      expect(script.calls).toBe(0)
      expect(ask.permission).toBe("connect_model")
      expect(ask.metadata).toMatchObject({ directoryReview: true, directory: f.current.directory, runID: queued.id })
      const anchor = yield* f.sessions.get(ask.sessionID)
      expect(anchor.internal).toBe(ConnectDirectory.INTERNAL)
      expect(anchor.parentID).toBeUndefined()
      const audience = yield* SessionAudience.Service
      expect(yield* audience.isPrivate(anchor.id)).toBe(true)
      expect(yield* f.sessions.list()).toEqual([])
      expect(yield* f.sessions.messages({ sessionID: anchor.id })).toEqual([])
      expect((yield* f.jobs.forParent(anchor.id)).find((row) => row.id === queued.id)).toMatchObject({
        id: queued.id,
        type: "connect",
        status: "running",
        directory: f.current.directory,
      })
      expect(yield* ConnectDirectory.load(f.scope, queued.id)).toMatchObject({
        anchor: anchor.id,
        run: { id: queued.id },
      })
      expect(envelopes.length).toBeGreaterThan(0)
      expect(
        envelopes.every(
          (event) => event.sessionID === anchor.id && event.run.request.requester.sessionID === undefined,
        ),
      ).toBe(true)
      yield* f.permission.reply({ requestID: ask.id, reply: "once" })
      const done = yield* f.ended(queued.id)
      expect(done.result?.verdict).toBe("clean")
      expect(script.calls).toBe(1)
      expect(yield* f.sessions.messages({ sessionID: anchor.id })).toEqual([])
    }),
  options,
)

it.instance(
  "directory GET stays nonterminal until the actual bounded receipt writer finishes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const hub = yield* ConnectHub.Service
      const audience = yield* SessionAudience.Service
      const anchor = yield* f.sessions.create({ internal: ConnectDirectory.INTERNAL })
      yield* audience.fenceIsolation({ sessionID: anchor.id, actor: "owner" })
      const token = yield* ConnectDirectory.issue({ sessionID: anchor.id, ...f.scope })
      const writing = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid))
      const queued = yield* hub.run({
        request: {
          to: "vectorscope",
          action: "review",
          requester: { kind: "user", agent: "build" },
          directory: f.current.directory,
          target: { kind: "uncommitted" },
          background: true,
        },
        call: {
          directory: {
            token,
            complete: (run) =>
              Effect.gen(function* () {
                if (run.status === "done") {
                  yield* Deferred.succeed(writing, undefined)
                  yield* Deferred.await(release)
                }
                return yield* ConnectDirectory.write(token, run)
              }),
          },
          promptOps: {
            cancel: () => Effect.void,
            resolvePromptParts: () => Effect.succeed([]),
            prompt: () => Effect.die("The writer ordering fixture must not prompt a helper"),
          },
        },
      })
      yield* f.approve(queued.id)
      yield* Deferred.await(writing)
      expect((yield* f.owner.get(queued.id)).status).not.toBe("done")
      expect((yield* ConnectDirectory.load(f.scope, queued.id))?.run.status).not.toBe("done")
      // The model work has finished; an owner stop must not claim it cancelled the already accepted result.
      const cancellation = yield* f.owner.cancel(queued.id).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(cancellation)).toBe(false)
      const done = yield* f.ended(queued.id)
      expect(done.result?.state).toBe("completed")
      expect((yield* ConnectDirectory.load(f.scope, queued.id))?.run.result).toEqual(done.result)
    }),
  options,
)

it.instance(
  "a completed directory receipt survives instance reload with its actual cost and sessionless identity",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const queued = yield* f.owner.directoryReview({})
      const ask = yield* f.approve(queued.id)
      const done = yield* f.ended(queued.id)
      const next = yield* f.reload(queued.id, ask.sessionID)
      const restored = yield* f.owner.get(queued.id).pipe(Effect.provideService(InstanceRef, next))
      expect(restored).toEqual(done)
      expect(restored.result?.cost).toEqual({ kind: "priced", usd: 0.12 })
      expect(restored.request.requester.sessionID).toBeUndefined()
      const rows = yield* f.owner.runs().pipe(Effect.provideService(InstanceRef, next))
      expect(rows.map((run) => run.id)).toEqual([done.id])
      expect(script.calls).toBe(1)
    }),
  options,
)

it.instance(
  "canceling pending directory consent withdraws it and reload never starts the model",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const queued = yield* f.owner.directoryReview({})
      const ask = yield* f.pending(queued.id)
      expect(yield* f.owner.cancel(queued.id)).toBe(true)
      const done = yield* f.ended(queued.id)
      expect(done.result?.state).toBe("cancelled")
      expect(yield* f.permission.list()).toEqual([])
      expect(script.calls).toBe(0)
      const next = yield* f.reload(queued.id, ask.sessionID)
      expect((yield* f.owner.get(queued.id).pipe(Effect.provideService(InstanceRef, next))).result?.state).toBe(
        "cancelled",
      )
      expect(script.calls).toBe(0)
    }),
  options,
)

it.instance(
  "canceling an admitted directory worker joins its effect and persists a nonclean result",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      script.gate = yield* Deferred.make<void>()
      const queued = yield* f.owner.directoryReview({})
      const ask = yield* f.approve(queued.id)
      yield* pollWithTimeout(
        Effect.sync(() => (script.calls === 1 ? true : undefined)),
        "The admitted directory worker did not start",
      )
      expect(yield* f.owner.cancel(queued.id)).toBe(true)
      expect((yield* f.ended(queued.id)).result?.state).toBe("cancelled")
      const next = yield* f.reload(queued.id, ask.sessionID)
      expect((yield* f.owner.get(queued.id).pipe(Effect.provideService(InstanceRef, next))).result?.verdict).toBe(
        "not-reviewed",
      )
    }),
  options,
)

it.instance(
  "a foreign directory cannot read or stop the original directory's receipt",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const queued = yield* f.owner.directoryReview({})
      yield* f.approve(queued.id)
      yield* f.ended(queued.id)
      const other = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const next = yield* f.store.load({ directory: other.path, worktree: other.path, project: f.current.project })
      expect(yield* f.owner.runs().pipe(Effect.provideService(InstanceRef, next))).toEqual([])
      expect(
        Exit.isFailure(yield* f.owner.get(queued.id).pipe(Effect.provideService(InstanceRef, next), Effect.exit)),
      ).toBe(true)
      expect(yield* f.owner.cancel(queued.id).pipe(Effect.provideService(InstanceRef, next))).toBe(false)
    }),
  options,
)

it.instance(
  "tampered receipt anchor and run identity never supply a clean verdict after reload",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      script.verdict = "incomplete"
      const queued = yield* f.owner.directoryReview({})
      const ask = yield* f.approve(queued.id)
      yield* f.ended(queued.id)
      const receipt = yield* ConnectDirectory.load(f.scope, queued.id)
      if (!receipt) throw new Error("Actual receipt missing")
      if (!receipt.run.result) throw new Error("Actual terminal result missing")
      const foreign = yield* f.sessions.create({ internal: ConnectDirectory.INTERNAL })
      const file = path.join(Global.Path.data, "storage", ...ConnectDirectory.prefix(f.scope), `${queued.id}.json`)
      const next = yield* f.reload(queued.id, ask.sessionID)
      yield* Effect.promise(() =>
        fs.writeFile(
          file,
          JSON.stringify({
            version: receipt.version,
            anchor: receipt.anchor,
            projectID: receipt.projectID,
            directory: receipt.directory,
            canonical: receipt.canonical,
            identity: receipt.identity,
            run: { ...receipt.run, result: { ...receipt.run.result, verdict: "clean" } },
          }),
        ),
      )
      expect(
        Exit.isFailure(yield* f.owner.get(queued.id).pipe(Effect.provideService(InstanceRef, next), Effect.exit)),
      ).toBe(true)
      yield* Effect.promise(() => fs.writeFile(file, JSON.stringify({ ...receipt, anchor: foreign.id })))
      expect(
        Exit.isFailure(yield* f.owner.get(queued.id).pipe(Effect.provideService(InstanceRef, next), Effect.exit)),
      ).toBe(true)
      yield* Effect.promise(() =>
        fs.writeFile(file, JSON.stringify({ ...receipt, run: { ...receipt.run, id: Connect.RunID.create() } })),
      )
      expect(
        Exit.isFailure(yield* f.owner.get(queued.id).pipe(Effect.provideService(InstanceRef, next), Effect.exit)),
      ).toBe(true)
      yield* Effect.promise(() => fs.writeFile(file, " ".repeat(ConnectDirectory.MAX_BYTES + 1)))
      expect(
        Exit.isFailure(yield* f.owner.get(queued.id).pipe(Effect.provideService(InstanceRef, next), Effect.exit)),
      ).toBe(true)
      expect(script.calls).toBe(1)
    }),
  options,
)

it.instance(
  "a removed private anchor or durable job cannot leave cached clean directory evidence",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const first = yield* f.owner.directoryReview({})
      const ask = yield* f.approve(first.id)
      yield* f.ended(first.id)
      expect((yield* f.background.wait({ id: first.id, timeout: 5_000 })).timedOut).toBe(false)
      const database = yield* Database.Service
      yield* database.db.delete(BackgroundJobTable).where(eq(BackgroundJobTable.id, first.id)).run().pipe(Effect.orDie)
      expect(Exit.isFailure(yield* f.owner.get(first.id).pipe(Effect.exit))).toBe(true)
      expect((yield* f.owner.runs()).map((run) => run.id)).not.toContain(first.id)
      const second = yield* f.owner.directoryReview({})
      const nextAsk = yield* f.approve(second.id)
      yield* f.ended(second.id)
      expect((yield* f.background.wait({ id: second.id, timeout: 5_000 })).timedOut).toBe(false)
      yield* f.sessions.remove(nextAsk.sessionID)
      expect(Exit.isFailure(yield* f.owner.get(second.id).pipe(Effect.exit))).toBe(true)
      expect((yield* f.owner.runs()).map((run) => run.id)).not.toContain(second.id)
      expect(ask.sessionID).not.toBe(nextAsk.sessionID)
    }),
  options,
)

it.instance(
  "deleting the private directory anchor during consent cancels admission without a model call",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const queued = yield* f.owner.directoryReview({})
      const ask = yield* f.pending(queued.id)
      yield* f.sessions.remove(ask.sessionID)
      expect(script.calls).toBe(0)
      expect(yield* f.permission.list()).toEqual([])
      expect(Exit.isFailure(yield* f.owner.get(queued.id).pipe(Effect.exit))).toBe(true)
    }),
  options,
)

it.instance(
  "receipt basenames reject a schema-valid traversal before reading an otherwise valid outside receipt",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const queued = yield* f.owner.directoryReview({})
      const ask = yield* f.approve(queued.id)
      const done = yield* f.ended(queued.id)
      const receipt = yield* ConnectDirectory.load(f.scope, queued.id)
      if (!receipt) throw new Error("The actual directory receipt is missing")
      const id = Connect.RunID.make(`cr_/../../outside_${queued.id}`)
      const folder = path.join(Global.Path.data, "storage", ...ConnectDirectory.prefix(f.scope))
      const outside = path.join(folder, `${id}.json`)
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(outside, { force: true })))
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(folder, "cr_"), { recursive: true })
        await fs.writeFile(
          outside,
          JSON.stringify({
            ...receipt,
            anchor: ask.sessionID,
            run: { ...done, id, request: { ...done.request, id } },
          }),
        )
      })
      expect(yield* ConnectDirectory.load(f.scope, id)).toBeUndefined()
      expect(yield* ConnectDirectory.load(f.scope, `cr_%2f..%2foutside_${queued.id}`)).toBeUndefined()
      expect(script.calls).toBe(1)
    }),
  options,
)

it.instance(
  "concurrent progress cannot replace terminal receipt bytes and retired writers cannot mutate them",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const queued = yield* f.owner.directoryReview({})
      const ask = yield* f.approve(queued.id)
      const done = yield* f.ended(queued.id)
      if (!done.result) throw new Error("Actual result missing")
      const id = Connect.RunID.create()
      const pending: Connect.Run = { ...queued, id, request: { ...queued.request, id, requestID: id } }
      const terminal: Connect.Run = {
        ...pending,
        status: "done",
        result: done.result,
        time: done.time,
      }
      const token = yield* ConnectDirectory.issue({ sessionID: ask.sessionID, ...f.scope })
      yield* Effect.all(
        [
          ...Array.from({ length: 20 }, () => ConnectDirectory.write(token, pending).pipe(Effect.exit)),
          ConnectDirectory.write(token, terminal).pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      )
      expect((yield* ConnectDirectory.load(f.scope, id))?.run).toEqual(terminal)
      expect(Exit.isFailure(yield* ConnectDirectory.write(token, pending).pipe(Effect.exit))).toBe(true)
      ConnectDirectory.retire(token)
      expect(Exit.isFailure(yield* ConnectDirectory.write(token, terminal).pipe(Effect.exit))).toBe(true)
      expect((yield* ConnectDirectory.load(f.scope, id))?.run).toEqual(terminal)
    }),
  options,
)

it.instance(
  "private receipt reads refuse nonregular, symlink and FIFO leaves without blocking",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const queued = yield* f.owner.directoryReview({})
      yield* f.approve(queued.id)
      yield* f.ended(queued.id)
      expect((yield* f.background.wait({ id: queued.id, timeout: 5_000 })).timedOut).toBe(false)
      const file = path.join(Global.Path.data, "storage", ...ConnectDirectory.prefix(f.scope), `${queued.id}.json`)
      const saved = `${file}.saved`
      yield* Effect.promise(() => fs.rename(file, saved))
      yield* Effect.promise(() => fs.mkdir(file))
      expect(yield* ConnectDirectory.load(f.scope, queued.id)).toBeUndefined()
      yield* Effect.promise(() => fs.rmdir(file))
      if (process.platform !== "win32") {
        yield* Effect.promise(() => fs.symlink(saved, file))
        expect(yield* ConnectDirectory.load(f.scope, queued.id)).toBeUndefined()
        yield* Effect.promise(() => fs.unlink(file))
      }
      if (process.platform === "linux") {
        const created = Bun.spawnSync(["mkfifo", file])
        expect(created.exitCode).toBe(0)
        expect(yield* ConnectDirectory.load(f.scope, queued.id).pipe(Effect.timeout("1 second"))).toBeUndefined()
        yield* Effect.promise(() => fs.unlink(file))
      }
    }),
  options,
)

it.instance(
  "a schema-valid oversized result is a persisted failure with actual usage, never truncated clean",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      script.oversized = true
      const queued = yield* f.owner.directoryReview({})
      const ask = yield* f.approve(queued.id)
      const done = yield* f.ended(queued.id)
      expect(done.result?.state).toBe("failed")
      expect(done.result?.verdict).toBe("incomplete")
      expect(done.result?.findings).toEqual([])
      expect(done.result?.cost).toEqual({ kind: "priced", usd: 0.12 })
      expect(done.result?.summary).toContain("receipt limits")
      const next = yield* f.reload(queued.id, ask.sessionID)
      expect((yield* f.owner.get(queued.id).pipe(Effect.provideService(InstanceRef, next))).result).toEqual(done.result)
    }),
  options,
)

it.instance(
  "forged writer capabilities and unsupported task requests create no receipt or visible conversation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      expect(
        Exit.isFailure(
          yield* f.owner.directoryReview({ target: { kind: "task", task: SessionID.create() } }).pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(Exit.isFailure(yield* f.owner.directoryReview({ to: "another" }).pipe(Effect.exit))).toBe(true)
      const hub = yield* ConnectHub.Service
      const forged = yield* hub.run({
        request: {
          to: "vectorscope",
          action: "review",
          requester: { kind: "user" },
          directory: f.current.directory,
          target: { kind: "uncommitted" },
          background: true,
        },
        call: { directory: { token: {}, complete: () => Effect.succeed("not-a-receipt") } },
      })
      expect(forged.result?.state).toBe("refused")
      expect(forged.result?.refusal).toBe("not-allowed")
      expect(yield* f.sessions.list({ internal: true })).toEqual([])
      expect(yield* ConnectDirectory.list(f.scope, 50)).toEqual([])
      expect(script.calls).toBe(0)
    }),
  options,
)

off.instance(
  "disabled directory review reads and records no hidden session, job or receipt",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      expect(Exit.isFailure(yield* f.owner.directoryReview({}).pipe(Effect.exit))).toBe(true)
      expect(yield* f.sessions.list({ internal: true })).toEqual([])
      expect(yield* ConnectDirectory.list(f.scope, 50)).toEqual([])
      expect(script.calls).toBe(0)
    }),
  options,
)
