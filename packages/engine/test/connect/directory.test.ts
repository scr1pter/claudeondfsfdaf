import { afterEach, beforeEach, expect, spyOn } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { Deferred, Effect, Exit, Fiber, Layer, Logger, Option, References, Schema } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { Database } from "@vectordevai/core/database/database"
import { BackgroundJobTable } from "@vectordevai/core/background-job.sql"
import { eq } from "drizzle-orm"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { Global } from "@vectordevai/core/global"
import { EffectFlock } from "@vectordevai/core/util/effect-flock"
import { Npm } from "@vectordevai/core/npm"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { Connect } from "@vectordevai/schema/connect"
import { BackgroundJob } from "@/background/job"
import type { ConnectAdapter } from "@/connect/adapter"
import { ConnectDirectory } from "@/connect/directory"
import { ConnectDirectoryRequest } from "@/connect/directory-request"
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
import { FileLock } from "@/tool/file-lock"
import { NpmTest } from "../fake/npm"
import { noSweep } from "../fixture/connect-sweep"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { pollWithTimeout, testEffect } from "../lib/effect"

const script: {
  calls: number
  gate?: Deferred.Deferred<void>
  oversized: boolean
  verdict: "clean" | "incomplete"
  state: Connect.State
} = {
  calls: 0,
  oversized: false,
  verdict: "clean",
  state: "ready",
}
beforeEach(() => {
  script.calls = 0
  script.oversized = false
  script.verdict = "clean"
  script.state = "ready"
  delete settled.wait
  delete script.gate
  delete hold.written
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
      state: script.state,
      ...(script.state === "ready" ? {} : { reason: "the fixture member is offline" }),
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

// The real ledger, except that a test can keep a bind inside an uninterruptible region after its binding write, as an
// interrupt landing during the ledger's own locked write does: the write finished, and the interrupt surfaces after.
const hold: { written?: Deferred.Deferred<void> } = {}
const holdingLedger = LayerNode.make({
  service: ConnectDirectoryRequest.Service,
  layer: Layer.effect(
    ConnectDirectoryRequest.Service,
    Effect.map(ConnectDirectoryRequest.Service, (real) =>
      ConnectDirectoryRequest.Service.of({
        ...real,
        bind: (token, value, onBound) => {
          const written = hold.written
          if (!written) return real.bind(token, value, onBound)
          return Effect.uninterruptible(
            real
              .bind(token, value, onBound)
              .pipe(Effect.andThen(Deferred.succeed(written, undefined)), Effect.andThen(Effect.sleep("200 millis"))),
          )
        },
      }),
    ),
  ).pipe(
    Layer.provide(
      ConnectDirectoryRequest.node.implementation as Layer.Layer<
        ConnectDirectoryRequest.Service,
        never,
        Global.Service | EffectFlock.Service
      >,
    ),
  ),
  deps: [Global.node, EffectFlock.node],
})

// The real hub, except that a test can have its run answer only once the run ended, as the hub does when a run is done
// by the time it reads it back: the owner then gets a terminal run for a key the binding gate already bound.
const settled: { wait?: boolean } = {}
const settlingHub = LayerNode.make({
  service: ConnectHub.Service,
  layer: Layer.effect(
    ConnectHub.Service,
    Effect.map(ConnectHub.Service, (real) =>
      ConnectHub.Service.of({
        ...real,
        run: (input) =>
          real
            .run(input)
            .pipe(
              Effect.flatMap((run) =>
                !settled.wait || run.status === "done"
                  ? Effect.succeed(run)
                  : pollWithTimeout(
                      real
                        .runs()
                        .pipe(Effect.map((runs) => runs.find((row) => row.id === run.id && row.status === "done"))),
                      "The directory run never ended",
                    ).pipe(Effect.orDie),
              ),
            ),
      }),
    ),
  ).pipe(Layer.provide(ConnectHub.nodeWith([adapter]).implementation as Layer.Layer<ConnectHub.Service>)),
  deps: ConnectHub.DEPS,
})

const graph = (enabled: boolean) =>
  AppNodeBuilder.build(
    LayerNode.group([
      ConnectOwner.node,
      ConnectDirectoryRequest.node,
      Global.node,
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
      [ConnectHub.node, settlingHub],
      [ConnectDirectoryRequest.node, holdingLedger],
      [SessionPrompt.node, Layer.mock(SessionPrompt.Service)({})],
      [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
      [Npm.node, NpmTest.noop],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalConnect: enabled, experimentalEventSystem: true })],
    ],
  ).pipe(Layer.provide(noSweep))
const it = testEffect(graph(true))
const off = testEffect(graph(false))
const reviewInput = (input: Connect.ReviewInput = {}): Connect.DirectoryReviewInput => ({
  requestKey: randomUUID(),
  ...input,
})
const options = { config: { permission: { connect: "allow" as const, connect_model: "ask" as const } } }

const fixture = Effect.gen(function* () {
  const owner = yield* ConnectOwner.Service
  const requests = yield* ConnectDirectoryRequest.Service
  const global = yield* Global.Service
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
  return {
    owner,
    requests,
    global,
    sessions,
    permission,
    current,
    scope,
    jobs,
    background,
    store,
    pending,
    ended,
    approve,
    reload,
  }
})

it.instance(
  "concurrent exact retries and UUID case variants keep one actual owner job, ask and paid execution",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const input = reviewInput({ background: true })
      const attempts = yield* Effect.all(
        [
          f.owner.directoryReview(input).pipe(Effect.exit),
          f.owner.directoryReview({ ...input, requestKey: input.requestKey.toUpperCase() }).pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      )
      const accepted = attempts.filter(Exit.isSuccess).map((result) => result.value)
      expect(accepted.length).toBeGreaterThan(0)
      expect(new Set(accepted.map((run) => run.id)).size).toBe(1)
      const first = accepted[0]
      if (!first) throw new Error("The genuine first writer did not return a run")
      const ask = yield* f.pending(first.id)
      const retry = yield* f.owner.directoryReview({ ...input, requestKey: input.requestKey.toUpperCase() })
      expect(retry.id).toBe(first.id)
      expect(script.calls).toBe(0)
      expect((yield* f.permission.list()).filter((row) => row.metadata.runID === first.id)).toHaveLength(1)
      expect(
        (yield* f.sessions.list({ internal: true, roots: true })).filter(
          (row) => row.internal === ConnectDirectory.INTERNAL,
        ),
      ).toHaveLength(1)
      expect(yield* f.jobs.forParent(ask.sessionID)).toHaveLength(1)
      const changed = yield* f.owner.directoryReview({ ...input, target: { kind: "staged" } }).pipe(Effect.exit)
      expect(Exit.isFailure(changed)).toBe(true)
      yield* f.permission.reply({ requestID: ask.id, reply: "once" })
      const done = yield* f.ended(first.id)
      expect(yield* f.owner.directoryReview(input)).toEqual(done)
      expect(script.calls).toBe(1)
      expect(yield* f.permission.list()).toEqual([])
      expect(yield* f.jobs.forParent(ask.sessionID)).toHaveLength(1)
    }),
  options,
)

it.instance(
  "an exited process's pending request refuses before another owner anchor or job is created",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const input = reviewInput({ background: true })
      const outcome = yield* Effect.promise(
        () =>
          new Promise<{ code: number; errors: string }>((resolve) => {
            const proc = spawn(
              process.execPath,
              [
                path.join(import.meta.dir, "../fixture/directory-request-worker.ts"),
                JSON.stringify({ data: f.global.data, scope: f.scope, input }),
              ],
              { cwd: path.join(import.meta.dir, "../..") },
            )
            const errors: Buffer[] = []
            proc.stderr.on("data", (value) => errors.push(Buffer.from(value)))
            proc.on("close", (code) => resolve({ code: code ?? 1, errors: Buffer.concat(errors).toString() }))
          }),
      )
      expect(outcome.code, outcome.errors).toBe(0)
      expect(Exit.isFailure(yield* f.owner.directoryReview(input).pipe(Effect.exit))).toBe(true)
      expect(yield* f.sessions.list({ internal: true })).toEqual([])
      expect(yield* f.permission.list()).toEqual([])
      expect(script.calls).toBe(0)
    }),
  options,
  30_000,
)

it.instance(
  "a key bound before the member gate refused keeps the refused run, as its replay answers it",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      script.state = "unavailable"
      // The hub as it runs: the gate refuses inside the released job, so the start answers the queued run.
      const queued = yield* f.owner.directoryReview(reviewInput())
      expect(queued.status).toBe("queued")
      expect((yield* f.ended(queued.id)).result).toMatchObject({ state: "refused", refusal: "unavailable" })
      // C6: a run that is already done when the hub answers. The binding gate bound the key before the gate refused,
      // so the start answers that refused run, as every retry's replay does; it is not an invalid start.
      settled.wait = true
      const input = reviewInput()
      const first = yield* f.owner.directoryReview(input)
      expect(first.status).toBe("done")
      expect(first.result).toMatchObject({
        state: "refused",
        refusal: "unavailable",
        summary: "VectorScope is not ready: the fixture member is offline",
      })
      delete settled.wait
      expect(yield* f.owner.directoryReview({ ...input, requestKey: input.requestKey.toUpperCase() })).toEqual(first)
      const anchors = (yield* f.sessions.list({ internal: true, roots: true })).filter(
        (row) => row.internal === ConnectDirectory.INTERNAL,
      )
      expect(anchors).toHaveLength(2)
      for (const anchor of anchors) expect(yield* f.jobs.forParent(anchor.id)).toHaveLength(1)
      expect(script.calls).toBe(0)
      expect(yield* f.permission.list()).toEqual([])
    }),
  options,
)

it.instance(
  "a consumed key whose receipt was retired cannot create a replacement review",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const input = reviewInput()
      const first = yield* f.owner.directoryReview(input)
      const ask = yield* f.approve(first.id)
      yield* f.ended(first.id)
      expect((yield* f.background.wait({ id: first.id, timeout: 5_000 })).timedOut).toBe(false)
      yield* Effect.promise(() =>
        fs.rm(path.join(Global.Path.data, "storage", ...ConnectDirectory.prefix(f.scope), `${first.id}.json`)),
      )
      const retry = yield* f.owner.directoryReview(input).pipe(Effect.flip)
      // C6: the key is bound, so its retry answers consumed (which the app turns into "Start a new review"), not invalid.
      expect(retry.code).toBe("consumed")
      expect(retry.message).toBe(
        "This request key is consumed, but its original owned run is unavailable. No new review was started.",
      )
      expect(yield* f.jobs.forParent(ask.sessionID)).toHaveLength(1)
      expect(
        (yield* f.sessions.list({ internal: true, roots: true })).filter(
          (row) => row.internal === ConnectDirectory.INTERNAL,
        ),
      ).toHaveLength(1)
      expect(script.calls).toBe(1)
    }),
  options,
)

it.instance(
  "a failed genuine queued-job binding cannot release execution or create a replacement on retry",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const input = reviewInput({ background: true })
      const admission = yield* f.requests.reserve(f.scope, input)
      if (admission.kind !== "reserved") throw new Error("No genuine first reservation")
      const folder = path.join(f.global.data, "storage", ...ConnectDirectoryRequest.prefix(admission.claim.scope))
      yield* Effect.promise(() => fs.writeFile(path.join(folder, "bindings", `${input.requestKey}.json`), "{"))
      const audience = yield* SessionAudience.Service
      const hub = yield* ConnectHub.Service
      const anchor = yield* f.sessions.create({ internal: ConnectDirectory.INTERNAL })
      yield* audience.fenceIsolation({ sessionID: anchor.id, actor: "owner" })
      const token = yield* ConnectDirectory.issue({ sessionID: anchor.id, ...f.scope }, admission.claim.scope)
      const failed = yield* hub.run({
        request: {
          to: "vectorscope",
          action: "review",
          requester: { kind: "user", agent: "build" },
          directory: f.scope.directory,
          target: { kind: "uncommitted" },
          background: true,
        },
        call: {
          directory: {
            token,
            request: admission.claim.proof,
            bind: (run) => f.requests.bind(admission.token, { anchorID: anchor.id, runID: run.id }),
            complete: (run) => ConnectDirectory.write(token, run),
          },
          promptOps: {
            cancel: () => Effect.void,
            resolvePromptParts: () => Effect.succeed([]),
            prompt: () => Effect.die("The failed binder must not prompt"),
          },
        },
      })
      expect(failed.status).toBe("done")
      expect(failed.result?.verdict).not.toBe("clean")
      expect(script.calls).toBe(0)
      expect(yield* f.permission.list()).toEqual([])
      expect(Exit.isFailure(yield* f.owner.directoryReview(input).pipe(Effect.exit))).toBe(true)
      expect(
        (yield* f.sessions.list({ internal: true, roots: true })).filter(
          (row) => row.internal === ConnectDirectory.INTERNAL,
        ),
      ).toHaveLength(1)
      expect(yield* f.jobs.forParent(anchor.id)).toHaveLength(1)
    }),
  options,
)

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
      const queued = yield* f.owner.directoryReview(reviewInput({ background: true }))
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
      const requests = yield* ConnectDirectoryRequest.Service
      const admission = yield* requests.reserve(f.scope, reviewInput({ background: true }))
      if (admission.kind !== "reserved") throw new Error("The writer fixture did not reserve a genuine request")
      const audience = yield* SessionAudience.Service
      const anchor = yield* f.sessions.create({ internal: ConnectDirectory.INTERNAL })
      yield* audience.fenceIsolation({ sessionID: anchor.id, actor: "owner" })
      const token = yield* ConnectDirectory.issue({ sessionID: anchor.id, ...f.scope }, admission.claim.scope)
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
            request: admission.claim.proof,
            bind: (run) => requests.bind(admission.token, { anchorID: anchor.id, runID: run.id }),
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
  "an owner interrupted while its queued job awaits the binding gate never leaves that job running",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const input = reviewInput({ background: true })
      const admission = yield* f.requests.reserve(f.scope, input)
      if (admission.kind !== "reserved") throw new Error("No genuine first reservation")
      const audience = yield* SessionAudience.Service
      const hub = yield* ConnectHub.Service
      const anchor = yield* f.sessions.create({ internal: ConnectDirectory.INTERNAL })
      yield* audience.fenceIsolation({ sessionID: anchor.id, actor: "owner" })
      const token = yield* ConnectDirectory.issue({ sessionID: anchor.id, ...f.scope }, admission.claim.scope)
      const fiber = yield* hub
        .run({
          request: {
            to: "vectorscope",
            action: "review",
            requester: { kind: "user", agent: "build" },
            directory: f.scope.directory,
            target: { kind: "uncommitted" },
            background: true,
          },
          call: {
            directory: {
              token,
              request: admission.claim.proof,
              bind: () => Effect.never,
              complete: (run) => ConnectDirectory.write(token, run),
            },
            promptOps: {
              cancel: () => Effect.void,
              resolvePromptParts: () => Effect.succeed([]),
              prompt: () => Effect.die("An unbound job must not prompt"),
            },
          },
        })
        .pipe(Effect.forkChild)
      const job = yield* pollWithTimeout(
        f.jobs.forParent(anchor.id).pipe(Effect.map((rows) => rows[0])),
        "The queued directory job was not recorded",
      )
      yield* Fiber.interrupt(fiber)
      const settled = yield* pollWithTimeout(
        f.jobs
          .forParent(anchor.id)
          .pipe(Effect.map((rows) => rows.find((row) => row.id === job.id && row.status !== "running"))),
        "The interrupted owner left its queued job waiting on the binding gate",
      )
      expect(settled.status).not.toBe("completed")
      expect(script.calls).toBe(0)
      expect(yield* f.permission.list()).toEqual([])
    }),
  options,
)

const CONSUMED = "This review start did not complete and no review ran. Start a new review."
const writer = { pid: process.pid, start: Math.floor(performance.timeOrigin) }
const noGrace = Effect.provideService(ConnectDirectoryRequest.Options, { graceMs: 0, writer })

it.instance(
  "an interrupted queued start is consumed on retry: its unreleased job stops and nothing new runs",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const input = reviewInput({ background: true })
      const admission = yield* f.requests.reserve(f.scope, input)
      if (admission.kind !== "reserved") throw new Error("No genuine first reservation")
      const audience = yield* SessionAudience.Service
      const hub = yield* ConnectHub.Service
      const anchor = yield* f.sessions.create({ internal: ConnectDirectory.INTERNAL })
      yield* f.requests.prepare(admission.token, anchor.id)
      yield* audience.fenceIsolation({ sessionID: anchor.id, actor: "owner" })
      const token = yield* ConnectDirectory.issue({ sessionID: anchor.id, ...f.scope }, admission.claim.scope)
      const fiber = yield* hub
        .run({
          request: {
            to: "vectorscope",
            action: "review",
            requester: { kind: "user", agent: "build" },
            directory: f.scope.directory,
            target: { kind: "uncommitted" },
            background: true,
          },
          call: {
            directory: {
              token,
              request: admission.claim.proof,
              bind: () => Effect.never,
              complete: (run) => ConnectDirectory.write(token, run),
            },
            promptOps: {
              cancel: () => Effect.void,
              resolvePromptParts: () => Effect.succeed([]),
              prompt: () => Effect.die("An unbound job must not prompt"),
            },
          },
        })
        .pipe(Effect.forkChild)
      const job = yield* pollWithTimeout(
        f.jobs.forParent(anchor.id).pipe(Effect.map((rows) => rows[0])),
        "The queued directory job was not recorded",
      )
      yield* Fiber.interrupt(fiber)
      yield* f.requests.release(admission.token)
      const retry = yield* f.owner.directoryReview(input).pipe(Effect.flip)
      expect(retry).toMatchObject({ code: "consumed", message: CONSUMED })
      const folder = path.join(f.global.data, "storage", ...ConnectDirectoryRequest.prefix(admission.claim.scope))
      const tombstone: unknown = JSON.parse(
        yield* Effect.promise(() => fs.readFile(path.join(folder, "refused", `${input.requestKey}.json`), "utf8")),
      )
      expect(tombstone).toMatchObject({ reason: "abandoned", anchorID: anchor.id })
      yield* pollWithTimeout(
        f.jobs
          .forParent(anchor.id)
          .pipe(Effect.map((rows) => rows.find((row) => row.id === job.id && row.status !== "running"))),
        "The unreleased job kept running after its key was consumed",
      )
      expect(script.calls).toBe(0)
      expect(yield* f.permission.list()).toEqual([])
      expect(
        (yield* f.sessions.list({ internal: true, roots: true })).filter(
          (row) => row.internal === ConnectDirectory.INTERNAL,
        ),
      ).toHaveLength(1)
    }),
  options,
)

it.instance(
  "an owner interrupted inside the ledger's binding write keeps its bound job, and a retry replays that run",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const input = reviewInput({ background: true })
      const written = yield* Deferred.make<void>()
      hold.written = written
      const fiber = yield* f.owner.directoryReview(input).pipe(Effect.forkChild)
      yield* Deferred.await(written)
      yield* Fiber.interrupt(fiber)
      delete hold.written
      const identity = yield* ConnectDirectory.capture(f.scope.directory)
      const folder = path.join(
        f.global.data,
        "storage",
        ...ConnectDirectoryRequest.prefix({ projectID: f.scope.projectID, canonical: identity.canonical }),
      )
      const exists = (kind: string) =>
        Effect.promise(() =>
          fs.lstat(path.join(folder, kind, `${input.requestKey}.json`)).then(
            () => true,
            () => false,
          ),
        )
      expect(yield* exists("refused")).toBe(false)
      const binding: unknown = JSON.parse(
        yield* Effect.promise(() => fs.readFile(path.join(folder, "bindings", `${input.requestKey}.json`), "utf8")),
      )
      if (!Schema.is(Schema.Struct({ runID: Connect.RunID }))(binding)) throw new Error("The binding names no run")
      // The bound job was released, not cancelled: it reaches its consent question.
      const ask = yield* f.pending(binding.runID)
      const retry = yield* f.owner.directoryReview({ ...input, requestKey: input.requestKey.toUpperCase() })
      expect(retry.id).toBe(binding.runID)
      expect(retry.status).not.toBe("done")
      yield* f.permission.reply({ requestID: ask.id, reply: "once" })
      const done = yield* f.ended(binding.runID)
      expect(done.result?.state).toBe("completed")
      expect(script.calls).toBe(1)
      expect(yield* f.jobs.forParent(ask.sessionID)).toHaveLength(1)
      expect(yield* exists("refused")).toBe(false)
    }),
  options,
)

it.instance(
  "a lost binding rebinds to its released job, and stays unavailable once the job's receipt is gone",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const input = reviewInput()
      const queued = yield* f.owner.directoryReview(input)
      const ask = yield* f.pending(queued.id)
      const anchorID = ask.sessionID
      const anchor = yield* f.sessions.get(anchorID)
      const identity = yield* ConnectDirectory.capture(f.scope.directory)
      const folder = path.join(
        f.global.data,
        "storage",
        ...ConnectDirectoryRequest.prefix({ projectID: f.scope.projectID, canonical: identity.canonical }),
      )
      const binding = path.join(folder, "bindings", `${input.requestKey}.json`)
      const original = yield* Effect.promise(() => fs.readFile(binding, "utf8"))
      expect(anchor.internal).toBe(ConnectDirectory.INTERNAL)
      // Within the grace this process's own prepared anchor is never guessed at.
      yield* Effect.promise(() => fs.rm(binding))
      expect((yield* f.owner.directoryReview(input).pipe(Effect.flip)).code).toBe("pending")
      // The in-memory job was released by its binding gate, so the key binds to it again.
      expect((yield* f.owner.directoryReview(input).pipe(noGrace)).id).toBe(queued.id)
      expect(yield* Effect.promise(() => fs.readFile(binding, "utf8"))).toBe(original)
      yield* f.permission.reply({ requestID: ask.id, reply: "once" })
      yield* f.ended(queued.id)
      const next = yield* f.reload(queued.id, anchorID)
      // After a reload only the durable job and its receipt speak: a started receipt is released work.
      yield* Effect.promise(() => fs.rm(binding))
      const replayed = yield* f.owner.directoryReview(input).pipe(noGrace, Effect.provideService(InstanceRef, next))
      expect(replayed.id).toBe(queued.id)
      expect(replayed.status).toBe("done")
      // A pruned or unreadable receipt cannot show what the job did: no write, no new run.
      yield* Effect.promise(async () => {
        await fs.rm(binding)
        await fs.rm(path.join(Global.Path.data, "storage", ...ConnectDirectory.prefix(f.scope), `${queued.id}.json`))
      })
      const unknown = yield* f.owner
        .directoryReview(input)
        .pipe(noGrace, Effect.provideService(InstanceRef, next), Effect.flip)
      expect(unknown.code).toBe("invalid")
      for (const kind of ["bindings", "refused"])
        expect(
          yield* Effect.promise(() =>
            fs.lstat(path.join(folder, kind, `${input.requestKey}.json`)).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
      expect(script.calls).toBe(1)
      expect(yield* f.jobs.forParent(anchorID)).toHaveLength(1)
    }),
  options,
)

it.instance(
  "a completed directory receipt survives instance reload with its actual cost and sessionless identity",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const queued = yield* f.owner.directoryReview(reviewInput())
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
      const queued = yield* f.owner.directoryReview(reviewInput())
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
      const queued = yield* f.owner.directoryReview(reviewInput())
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
      const queued = yield* f.owner.directoryReview(reviewInput())
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
      const queued = yield* f.owner.directoryReview(reviewInput())
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
      const first = yield* f.owner.directoryReview(reviewInput())
      const ask = yield* f.approve(first.id)
      yield* f.ended(first.id)
      expect((yield* f.background.wait({ id: first.id, timeout: 5_000 })).timedOut).toBe(false)
      const database = yield* Database.Service
      yield* database.db.delete(BackgroundJobTable).where(eq(BackgroundJobTable.id, first.id)).run().pipe(Effect.orDie)
      expect(Exit.isFailure(yield* f.owner.get(first.id).pipe(Effect.exit))).toBe(true)
      expect((yield* f.owner.runs()).map((run) => run.id)).not.toContain(first.id)
      const second = yield* f.owner.directoryReview(reviewInput())
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
      const queued = yield* f.owner.directoryReview(reviewInput())
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
      const queued = yield* f.owner.directoryReview(reviewInput())
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
      const queued = yield* f.owner.directoryReview(reviewInput())
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
      expect(yield* ConnectDirectory.write(token, terminal).pipe(Effect.flip)).toMatchObject({ phase: "authority" })
      expect((yield* ConnectDirectory.load(f.scope, id))?.run).toEqual(terminal)
    }),
  options,
)

it.instance(
  "receipt replacement waits for an interrupted reader to close its handle",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      script.state = "unavailable"
      const queued = yield* f.owner.directoryReview(reviewInput())
      const done = yield* f.ended(queued.id)
      const receipt = yield* ConnectDirectory.load(f.scope, queued.id)
      if (!receipt) throw new Error("The actual directory receipt is missing")
      const token = yield* ConnectDirectory.issue({ sessionID: receipt.anchor, ...f.scope })
      const id = Connect.RunID.create()
      const pending: Connect.Run = { ...queued, id, request: { ...queued.request, id, requestID: id } }
      const terminal: Connect.Run = { ...done, id, request: pending.request }
      yield* ConnectDirectory.write(token, pending)
      const target = path.join(Global.Path.data, "storage", ...ConnectDirectory.prefix(f.scope), `${id}.json`)
      const io = yield* Effect.promise(() => import("node:fs/promises"))
      const open = io.open
      const rename = io.rename
      const lock = FileLock.withFiles
      const opened = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const writerReached = Promise.withResolvers<"lock" | "rename">()
      let held = false
      const readSpy = spyOn(io, "open").mockImplementation(async (...args) => {
        const file = await open(...args)
        if (args[0] !== target) return file
        const close = file.close.bind(file)
        file.close = async () => {
          await close()
          held = false
        }
        held = true
        opened.resolve()
        await release.promise
        return file
      })
      const renameSpy = spyOn(io, "rename").mockImplementation(async (...args) => {
        if (args[1] === target) {
          writerReached.resolve("rename")
          // Model Windows replacement semantics with the real read handle still open.
          if (held) throw Object.assign(new Error("File held open"), { code: "EPERM" })
        }
        return rename(...args)
      })
      try {
        const reader = yield* ConnectDirectory.load(f.scope, id).pipe(Effect.forkChild)
        yield* Effect.promise(() => opened.promise)
        const stop = yield* Fiber.interrupt(reader).pipe(Effect.forkChild({ startImmediately: true }))
        const observer = yield* lock([target])(Effect.sync(() => held)).pipe(
          Effect.forkChild({ startImmediately: true }),
        )
        // Either the writer reaches the shared lock or it calls rename while the read is still open.
        const lockSpy = spyOn(FileLock, "withFiles").mockImplementation((paths) => {
          if (paths.includes(target)) writerReached.resolve("lock")
          return lock(paths)
        })
        try {
          const writer = yield* ConnectDirectory.write(token, terminal).pipe(Effect.exit, Effect.forkChild)
          const reached = yield* Effect.promise(() => writerReached.promise)
          release.resolve()
          yield* Fiber.join(stop)
          const overlapped = yield* Fiber.join(observer)
          const result = yield* Fiber.join(writer)
          expect([reached, overlapped, Exit.isSuccess(result)]).toEqual(["lock", false, true])
          expect((yield* ConnectDirectory.load(f.scope, id))?.run).toEqual(terminal)
        } finally {
          lockSpy.mockRestore()
        }
      } finally {
        release.resolve()
        renameSpy.mockRestore()
        readSpy.mockRestore()
      }
    }),
  options,
)

it.instance(
  "a receipt replacement failure retains only its phase and a bounded filesystem code",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      script.state = "unavailable"
      const queued = yield* f.owner.directoryReview(reviewInput())
      const done = yield* f.ended(queued.id)
      const receipt = yield* ConnectDirectory.load(f.scope, queued.id)
      if (!receipt) throw new Error("The actual directory receipt is missing")
      const token = yield* ConnectDirectory.issue({ sessionID: receipt.anchor, ...f.scope })
      const id = Connect.RunID.create()
      const folder = path.join(Global.Path.data, "storage", ...ConnectDirectory.prefix(f.scope))
      const blocked = path.join(folder, `${id}.json`)
      yield* Effect.promise(async () => {
        await fs.mkdir(blocked)
        await fs.writeFile(path.join(blocked, "keep"), "fixture")
      })
      const messages: unknown[] = []
      const logger = Logger.make(({ message }) => void messages.push(message))
      const error = yield* ConnectDirectory.write(token, { ...done, id, request: { ...done.request, id } }).pipe(
        Effect.flip,
        Effect.provide(Logger.layer([logger])),
        Effect.provideService(References.MinimumLogLevel, "Warn"),
      )
      expect(messages).toEqual([["Could not save directory review receipt", { phase: "rename", code: error.code }]])
      expect(error).toMatchObject({ phase: "rename", message: "The directory review receipt could not be saved." })
      expect(["EACCES", "EEXIST", "EISDIR", "ENOTEMPTY", "EPERM"]).toContain(error.code)
      expect(JSON.stringify(error)).not.toContain(blocked)
      expect((yield* Effect.promise(() => fs.readdir(folder))).filter((name) => name.endsWith(".tmp"))).toEqual([])
    }),
  options,
)

it.instance(
  "private receipt reads refuse nonregular, symlink and FIFO leaves without blocking",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const queued = yield* f.owner.directoryReview(reviewInput())
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
      const queued = yield* f.owner.directoryReview(reviewInput())
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
          yield* f.owner
            .directoryReview(reviewInput({ target: { kind: "task", task: SessionID.create() } }))
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(Exit.isFailure(yield* f.owner.directoryReview(reviewInput({ to: "another" })).pipe(Effect.exit))).toBe(
        true,
      )
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
        call: {
          directory: {
            token: {},
            request: { key: randomUUID(), inputDigest: "0".repeat(64), scopeDigest: "0".repeat(64) },
            bind: () => Effect.void,
            complete: () => Effect.succeed("not-a-receipt"),
          },
        },
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
      expect(Exit.isFailure(yield* f.owner.directoryReview(reviewInput()).pipe(Effect.exit))).toBe(true)
      expect(yield* f.sessions.list({ internal: true })).toEqual([])
      expect(yield* ConnectDirectory.list(f.scope, 50)).toEqual([])
      expect(script.calls).toBe(0)
    }),
  options,
)
