import { $ } from "bun"
import { randomUUID } from "node:crypto"
import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { eq, sql } from "drizzle-orm"
import { Deferred, Effect, Exit, Option, Result, Schema, Scope } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { Database } from "@vectordevai/core/database/database"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import { ReviewStore } from "@vectordevai/core/brain/review-store"
import { BrainEntryTable, BrainReviewMemoryStateTable, BrainReviewMemoryTable } from "@vectordevai/core/brain/sql"
import { SessionTable } from "@vectordevai/core/session/sql"
import { BackgroundJob as CoreBackgroundJob } from "@vectordevai/core/background-job"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { selectFindings } from "@vectordevai/core/review/select"
import type { Finding, ReviewOutcome } from "@vectordevai/core/review/types"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { ReviewRequestStore } from "@vectordevai/core/review/request-store"
import { ReviewLifecycle } from "@/review/lifecycle"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { ReviewLocalRun } from "@/review/local-run"
import type { ReviewLocalAdmission } from "@/review/local-admission"
import type { RunInput } from "@/review/run"
import { Session } from "@/session/session"
import { SessionCleanup } from "@/session/cleanup"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      EventV2Bridge.node,
      BackgroundJob.node,
      BackgroundJobStore.node,
      Database.node,
      BrainDatabase.node,
      ReviewRequestStore.node,
      ReviewLifecycle.node,
      Git.node,
      CrossSpawnSpawner.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })]],
  ),
)
const options = { git: true, config: { lsp: false as const, formatter: false as const } }
const git = (cwd: string, ...args: string[]) =>
  Effect.promise(() => $`git ${args}`.cwd(cwd).quiet().text()).pipe(Effect.map((value) => value.trim()))

const fixture = Effect.gen(function* () {
  const test = yield* TestInstance
  const sessions = yield* Session.Service
  yield* git(test.directory, "config", "core.autocrlf", "false")
  yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "visible.ts"), "export const count = 1\n"))
  yield* git(test.directory, "add", ".")
  yield* git(test.directory, "commit", "-qm", "base")
  const head = yield* git(test.directory, "rev-parse", "HEAD")
  yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "visible.ts"), "export const count = 2\n"))
  const parent = yield* sessions.create({ title: "Review owner" }, "owner")
  const source: ReviewLocalAdmission.Source = {
    sessionID: parent.id,
    directory: test.directory,
    worktree: test.directory,
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
  const request: ReviewRun.Start = { requestID: "request_local_1", target: { kind: "working-tree", head } }
  return { directory: test.directory, parent, source, request }
})

const resolveModel = () =>
  Effect.succeed({
    providerID: ProviderV2.ID.make("local"),
    modelID: ModelV2.ID.make("review"),
    context: 100_000,
    costKind: "local" as const,
  })

function outcome(input: RunInput, partial = false): ReviewOutcome {
  const finding: Finding = {
    id: "finding_fixture",
    path: "visible.ts",
    line: 1,
    side: "RIGHT",
    source: "review",
    severity: "blocking",
    category: "bug",
    title: "Fixture defect",
    body: "The fixture demonstrates saved findings.",
    confidence: 1,
    verified: true,
  }
  return {
    report: { summary: "Fixture result", risk: "high", files: [], findings: [finding] },
    selection: selectFindings({
      findings: [finding],
      anchors: input.anchors,
      head: input.head,
      trust: input.trust,
      mode: input.mode,
      config: input.config,
      prior: [],
      knownPath: () => true,
    }),
    skipped: input.skipped,
    durationMs: 1,
    base: input.base,
    head: input.head,
    mode: input.mode,
    ...(partial ? { partial: "timeout" as const } : {}),
    unreviewed: partial ? ["visible.ts"] : [],
    specialists: [
      { name: "review", status: "ok", steps: 1 },
      ...(partial ? [{ name: "security" as const, status: "timeout" as const, steps: 1 }] : []),
    ],
    sessions: [],
    stats: { files: input.files.length, additions: 1, deletions: 1 },
    notes: [],
    cost: {
      costUsd: 0,
      input: 12,
      output: 3,
      reasoning: 1,
      cacheRead: 2,
      cacheWrite: 0,
      kind: "local",
      model: "local/review",
    },
    passes: [{ name: "review", model: "local/review", input: 12, output: 3, cacheRead: 2, costKind: "local" }],
  }
}

describe("durable server-owned local review runs", () => {
  it.instance(
    "survives request disconnect, joins exact retries, and reloads the placed result without another review",
    () =>
      Effect.gen(function* () {
        const repo = yield* fixture
        const sessions = yield* Session.Service
        const jobs = yield* BackgroundJob.Service
        const entered = yield* Deferred.make<RunInput>()
        const release = yield* Deferred.make<void>()
        let calls = 0
        const pipeline = {
          resolveModel,
          runReview: (input: RunInput) =>
            Effect.gen(function* () {
              calls++
              yield* Deferred.succeed(entered, input)
              yield* Deferred.await(release)
              return outcome(input)
            }),
        }
        const runs = yield* ReviewLocalRun.make(pipeline)
        const requestScope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
        const started = yield* runs.start(repo.request, repo.source).pipe(Scope.provide(requestScope))
        const input = yield* awaitWithTimeout(Deferred.await(entered), "The shared review did not start")
        yield* Scope.close(requestScope, Exit.void)
        expect((yield* runs.get(repo.parent.id, started.runID)).status).toBe("running")
        expect((yield* runs.start(repo.request, repo.source)).runID).toBe(started.runID)
        expect(calls).toBe(1)
        expect(input.parentID).toBe(started.runID)
        const other = yield* sessions.create({ title: "Another owner conversation" }, "owner")
        expect(Exit.isFailure(yield* runs.get(other.id, started.runID).pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* runs.stop(other.id, started.runID).pipe(Effect.exit))).toBe(true)
        expect(
          Exit.isFailure(yield* runs.start({ ...repo.request, maxCost: 0.1 }, repo.source).pipe(Effect.exit)),
        ).toBe(true)
        yield* Deferred.succeed(release, undefined)
        yield* jobs.wait({ id: started.runID })
        const finished = yield* runs.get(repo.parent.id, started.runID)
        expect(finished.status).toBe("completed")
        expect(finished.canStop).toBe(false)
        expect(finished.artifact && ReviewLocalRun.validArtifact(finished.artifact)).toBe(true)
        const artifact = JSON.parse(finished.artifact!.json)
        expect(artifact.outcome).toEqual(outcome(input))
        expect(artifact.outcome.selection.inline).toHaveLength(1)
        expect(artifact.outcome.cost.input).toBe(12)
        const emptyRegistry = yield* CoreBackgroundJob.make
        const reconnected = yield* ReviewLocalRun.make(pipeline).pipe(
          Effect.provideService(BackgroundJob.Service, emptyRegistry),
        )
        expect((yield* reconnected.get(repo.parent.id, started.runID)).artifact).toEqual(finished.artifact)
        yield* git(repo.directory, "add", ".")
        yield* git(repo.directory, "commit", "-qm", "advance head")
        expect((yield* runs.start(repo.request, repo.source)).runID).toBe(started.runID)
        expect(calls).toBe(1)
      }),
    options,
  )

  it.instance(
    "serializes duplicate starts and stops only the addressed run while retaining its completed partial findings",
    () =>
      Effect.gen(function* () {
        const repo = yield* fixture
        const jobs = yield* BackgroundJob.Service
        const entered = yield* Deferred.make<void>()
        const both = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let calls = 0
        let aborted = 0
        const runs = yield* ReviewLocalRun.make({
          resolveModel,
          runReview: (input: RunInput) =>
            Effect.gen(function* () {
              calls++
              yield* Deferred.succeed(entered, undefined)
              if (calls === 2) yield* Deferred.succeed(both, undefined)
              return yield* Effect.race(
                Deferred.await(release).pipe(Effect.as(outcome(input))),
                Effect.callback<ReviewOutcome>((resume) => {
                  const stop = () => {
                    aborted++
                    resume(Effect.succeed(outcome(input, true)))
                  }
                  if (input.stopSignal?.aborted) stop()
                  else input.stopSignal?.addEventListener("abort", stop, { once: true })
                  return Effect.sync(() => input.stopSignal?.removeEventListener("abort", stop))
                }),
              )
            }),
        })
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
        const duplicate = yield* Effect.all(
          [runs.start(repo.request, repo.source), runs.start(repo.request, repo.source)],
          { concurrency: "unbounded" },
        )
        expect(duplicate[0].runID).toBe(duplicate[1].runID)
        yield* awaitWithTimeout(Deferred.await(entered), "First review did not start")
        const second = yield* runs.start({ ...repo.request, requestID: "request_local_2" }, repo.source)
        yield* awaitWithTimeout(Deferred.await(both), "Second review did not start")
        const stopped = yield* runs.stop(repo.parent.id, duplicate[0].runID)
        expect(stopped.status).toBe("cancelled")
        expect(stopped.canStop).toBe(false)
        const artifact = JSON.parse(stopped.artifact!.json)
        expect(artifact.verdict.verdict).toBe("incomplete")
        expect(artifact.outcome.selection.inline).toHaveLength(1)
        expect(artifact.outcome.cost.input).toBe(12)
        expect(artifact.outcome.partial).toBe("timeout")
        expect((yield* runs.get(repo.parent.id, second.runID)).status).toBe("running")
        expect(aborted).toBe(1)
        expect(calls).toBe(2)
        expect((yield* runs.stop(repo.parent.id, stopped.runID)).status).toBe("cancelled")
        expect(aborted).toBe(1)
        yield* Deferred.succeed(release, undefined)
        yield* jobs.wait({ id: second.runID })
        expect((yield* runs.get(repo.parent.id, second.runID)).status).toBe("completed")
      }),
    options,
  )

  it.instance(
    "two coordinators arbitrate one request durably and a crashed pending reservation never starts paid work",
    () =>
      Effect.gen(function* () {
        const repo = yield* fixture
        const store = yield* ReviewRequestStore.Service
        const jobs = yield* BackgroundJob.Service
        const lifecycle = yield* ReviewLifecycle.Service
        const both = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let arrivals = 0
        let calls = 0
        const coordinated: ReviewLifecycle.Interface = {
          ...lifecycle,
          within: (parentID, runID) => (effect) =>
            Effect.gen(function* () {
              if (!runID) {
                if (++arrivals === 2) yield* Deferred.succeed(both, undefined)
                yield* Deferred.await(both)
              }
              return yield* lifecycle.within(parentID, runID)(effect)
            }),
        }
        const pipeline = {
          resolveModel,
          runReview: (input: RunInput) =>
            Effect.gen(function* () {
              calls++
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return outcome(input)
            }),
        }
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
        const first = yield* ReviewLocalRun.make(pipeline).pipe(
          Effect.provideService(ReviewLifecycle.Service, coordinated),
        )
        const second = yield* ReviewLocalRun.make(pipeline).pipe(
          Effect.provideService(ReviewLifecycle.Service, coordinated),
        )
        const starts = yield* Effect.all(
          [
            first.start(repo.request, repo.source).pipe(Effect.result),
            second.start(repo.request, repo.source).pipe(Effect.result),
          ],
          { concurrency: "unbounded" },
        )
        const accepted = starts.flatMap((result) => (Result.isSuccess(result) ? [result.success] : []))
        expect(accepted.length).toBeGreaterThanOrEqual(1)
        expect(new Set(accepted.map((run) => run.runID)).size).toBe(1)
        for (const result of starts) if (Result.isFailure(result)) expect(result.failure.code).toBe("unavailable")
        yield* awaitWithTimeout(Deferred.await(entered), "The single admitted review did not start")
        expect(calls).toBe(1)
        const joined = yield* second.start(repo.request, repo.source)
        expect(joined.runID).toBe(accepted[0]!.runID)
        const crashed = { ...repo.request, requestID: "request_crashed_reservation" }
        expect(
          (yield* store.reserve({
            parentID: repo.parent.id,
            request: crashed,
            ownerNonce: randomUUID(),
            owner: (yield* jobs.lease())!,
          })).claimed,
        ).toBe(true)
        const refused = yield* first.start(crashed, repo.source).pipe(Effect.result)
        expect(Result.isFailure(refused) && refused.failure.code).toBe("unavailable")
        const conflict = yield* second.start({ ...crashed, maxCost: 0.5 }, repo.source).pipe(Effect.result)
        expect(Result.isFailure(conflict) && conflict.failure.code).toBe("conflict")
        expect(calls).toBe(1)
        expect(
          (yield* (yield* Session.Service).children(repo.parent.id)).filter(
            (child) => child.internal === ReviewLocalRun.MARKER,
          ),
        ).toHaveLength(1)
        yield* Deferred.succeed(release, undefined)
        yield* jobs.wait({ id: joined.runID })
        expect((yield* first.get(repo.parent.id, joined.runID)).status).toBe("completed")
      }),
    options,
  )

  it.instance(
    "joins a force-stop when a reviewer does not return partial output after abort",
    () =>
      Effect.gen(function* () {
        const repo = yield* fixture
        const entered = yield* Deferred.make<void>()
        let finalizers = 0
        let calls = 0
        const runs = yield* ReviewLocalRun.make({
          resolveModel,
          runReview: () =>
            Effect.gen(function* () {
              calls++
              yield* Deferred.succeed(entered, undefined)
              return yield* Effect.never.pipe(Effect.ensuring(Effect.sync(() => finalizers++)))
            }),
        })
        const started = yield* runs.start(repo.request, repo.source)
        yield* awaitWithTimeout(Deferred.await(entered), "Review did not start")
        const stopped = yield* runs.stop(repo.parent.id, started.runID)
        expect(stopped.status).toBe("cancelled")
        expect(stopped.artifact).toBeUndefined()
        expect(finalizers).toBe(1)
        expect(calls).toBe(1)
      }),
    options,
    15_000,
  )

  it.instance(
    "reconciles only a dead durable lease and never restarts or stops live, unknown, or missing owners",
    () =>
      Effect.gen(function* () {
        const repo = yield* fixture
        const sessions = yield* Session.Service
        const store = yield* BackgroundJobStore.Service
        let calls = 0
        const runs = yield* ReviewLocalRun.make({
          resolveModel,
          runReview: (input: RunInput) =>
            Effect.sync(() => {
              calls++
              return outcome(input)
            }),
        })
        const saved = (requestID: string) =>
          Effect.gen(function* () {
            const request = { ...repo.request, requestID }
            const run = yield* sessions.create(
              {
                parentID: repo.parent.id,
                internal: ReviewLocalRun.MARKER,
                permission: [{ permission: "*", pattern: "*", action: "deny" }],
                metadata: {
                  [ReviewLocalRun.FIELD]: {
                    version: 1,
                    parentID: repo.parent.id,
                    request,
                    directory: repo.directory,
                    status: "running",
                    startedAt: Date.now(),
                  },
                },
              },
              "owner",
            )
            return { run, request }
          })
        const cases = [
          {
            key: "request_dead_1",
            owner: { ...BackgroundJobStore.current(), runtime: "foreign-dead-engine:instance", pid: 2147483647 },
            status: "interrupted",
          },
          {
            key: "request_live_1",
            owner: { ...BackgroundJobStore.current(), runtime: "foreign-live-engine:instance" },
            status: "running",
          },
          {
            key: "request_unknown_1",
            owner: { runtime: "foreign-unknown-engine:instance", pid: 0, boot: 0, machine: "another-machine" },
            status: "unknown",
          },
          {
            key: "request_shutdown_1",
            owner: { ...BackgroundJobStore.current(), runtime: "shutdown-engine:instance" },
            status: "interrupted",
            interrupted: true,
          },
        ] as const
        for (const test of cases) {
          const stored = yield* saved(test.key)
          yield* store.started({
            id: stored.run.id,
            type: ReviewLocalRun.JOB,
            parentSessionID: repo.parent.id,
            sessionID: stored.run.id,
            directory: repo.directory,
            background: true,
            startedAt: Date.now(),
            owner: test.owner,
          })
          if ("interrupted" in test)
            yield* store.settled(stored.run.id, {
              owner: test.owner.runtime,
              status: "interrupted",
              completedAt: Date.now(),
            })
          const state = yield* runs.get(repo.parent.id, stored.run.id)
          expect(state.status).toBe(test.status)
          expect(state.canStop).toBe(false)
          expect((yield* runs.start(stored.request, repo.source)).runID).toBe(stored.run.id)
          if (test.status !== "interrupted") {
            expect(Exit.isFailure(yield* runs.stop(repo.parent.id, stored.run.id).pipe(Effect.exit))).toBe(true)
            expect((yield* store.forParent(repo.parent.id)).find((row) => row.id === stored.run.id)?.status).toBe(
              "running",
            )
          } else {
            const row = (yield* store.forParent(repo.parent.id)).find((row) => row.id === stored.run.id)
            expect(row?.status).toBe("interrupted")
            expect(row?.reportedAt).toBeGreaterThan(0)
          }
        }
        const missing = yield* saved("request_missing_1")
        expect((yield* runs.get(repo.parent.id, missing.run.id)).status).toBe("unknown")
        expect((yield* runs.start(missing.request, repo.source)).runID).toBe(missing.run.id)
        expect(calls).toBe(0)
      }),
    options,
  )

  it.instance(
    "refuses corrupted or oversized saved output without recomputing a review",
    () =>
      Effect.gen(function* () {
        const repo = yield* fixture
        const sessions = yield* Session.Service
        const jobs = yield* BackgroundJob.Service
        let calls = 0
        const runs = yield* ReviewLocalRun.make({
          resolveModel,
          runReview: (input: RunInput) =>
            Effect.sync(() => {
              calls++
              return outcome(input)
            }),
        })
        const started = yield* runs.start(repo.request, repo.source)
        yield* jobs.wait({ id: started.runID })
        const finished = yield* runs.get(repo.parent.id, started.runID)
        const artifact = finished.artifact!
        expect(ReviewLocalRun.validArtifact({ ...artifact, json: `${artifact.json} ` })).toBe(false)
        expect(ReviewLocalRun.validArtifact({ ...artifact, bytes: artifact.bytes - 1 })).toBe(false)
        expect(Option.isNone(Schema.decodeUnknownOption(ReviewRun.Artifact)({ ...artifact, version: 2 }))).toBe(true)
        const saved = yield* sessions.get(started.runID)
        const record = saved.metadata![ReviewLocalRun.FIELD]
        yield* sessions.setMetadata({
          sessionID: saved.id,
          metadata: {
            ...saved.metadata,
            [ReviewLocalRun.FIELD]: { ...record, artifact: { ...artifact, sha256: "0".repeat(64) } },
          },
        })
        expect(Exit.isFailure(yield* runs.get(repo.parent.id, saved.id).pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* runs.start(repo.request, repo.source).pipe(Effect.exit))).toBe(true)
        expect(calls).toBe(1)
        expect(
          ReviewLocalRun.encodeArtifact({
            exitCode: 2,
            error: "x".repeat(ReviewRun.RESULT_BYTES),
            verdict: { verdict: "not-reviewed", causes: ["review-error"], notes: [] },
          }),
        ).toBeUndefined()
      }),
    options,
  )

  it.instance(
    "actual Session.remove erases approved review provenance before removal and refuses corrupt review state without changing any Brain table",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const database = yield* Database.Service
        const brain = yield* BrainDatabase.Service
        const jobs = yield* BackgroundJob.Service
        const requests = yield* ReviewRequestStore.Service
        const original = yield* fixture
        const snapshot = () =>
          Effect.gen(function* () {
            const tables = yield* brain.db.all<{ name: string }>(
              sql`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
            )
            return yield* Effect.forEach(tables, (table) =>
              Effect.gen(function* () {
                const rows = yield* brain.db.all(sql`SELECT * FROM ${sql.identifier(table.name)}`)
                return { table: table.name, rows: rows.map((row) => JSON.stringify(row)).sort() }
              }),
            )
          })
        for (const corrupt of [false, true]) {
          const parent = corrupt
            ? yield* sessions.create({ title: "Corrupt review-memory deletion fixture" }, "owner")
            : original.parent
          const repo = { ...original, parent, source: { ...original.source, sessionID: parent.id } }
          const runs = yield* ReviewLocalRun.make({
            resolveModel,
            runReview: (input: RunInput) => Effect.succeed(outcome(input)),
          })
          const started = yield* runs.start(repo.request, repo.source)
          yield* jobs.wait({ id: started.runID })
          expect((yield* runs.get(repo.parent.id, started.runID)).status).toBe("completed")
          const retained = yield* requests.sourceSnapshot(repo.parent.id, started.runID)
          const physical = retained?.sourceBinding?.scope
          if (!physical) throw new Error("The real review did not retain its physical admission binding")
          const repository = repo.parent.projectID
          const reviewEntry = `source-${started.runID}`
          const ownerEntry = `owner-${started.runID}`
          const ordinaryEntry = `ordinary-${started.runID}`
          yield* brain.db.transaction((tx) =>
            Effect.gen(function* () {
              yield* ReviewStore.register(tx, repository, physical)
              yield* ReviewStore.advance(tx, repository, physical, true)
              yield* tx
                .insert(BrainReviewMemoryTable)
                .values([
                  {
                    id: reviewEntry,
                    repository_id: repository,
                    scope_id: physical,
                    kind: "outcome",
                    status: "active",
                    visibility: "repository",
                    body: "Explicitly approved review excerpt",
                    paths: ["visible.ts"],
                    citations: [
                      { path: "visible.ts", line: 1, head: repo.request.target.head, quote: "export const count = 2" },
                    ],
                    reason: "Approved fixture finding",
                    parent_session_id: repo.parent.id,
                    review_session_id: started.runID,
                    source_head: repo.request.target.head,
                    origin: "review",
                    approved_by: "fixture-owner",
                    approved_at: 2,
                    created_at: 1,
                    updated_at: 2,
                  },
                  {
                    id: ownerEntry,
                    repository_id: repository,
                    scope_id: physical,
                    kind: "preference",
                    status: "active",
                    visibility: "repository",
                    body: "Owner preference remains",
                    paths: [],
                    citations: [],
                    reason: "Owner entry",
                    origin: "owner",
                    created_at: 1,
                    updated_at: 1,
                  },
                ])
                .run()
              yield* tx.run(
                sql`INSERT INTO brain_entry (id, scope, repository_id, kind, origin, status, body, paths, terms, norm_hash, confidence, related, created_at, updated_at) VALUES (${ordinaryEntry}, 'repository', ${repository}, 'fact', 'user', 'active', 'Ordinary memory remains', '[]', '', ${ordinaryEntry}, 1, '[]', 1, 1)`,
              )
            }),
          )
          const ordinary = yield* brain.db
            .select()
            .from(BrainEntryTable)
            .where(eq(BrainEntryTable.id, ordinaryEntry))
            .get()
          const owned = yield* brain.db
            .select()
            .from(BrainReviewMemoryTable)
            .where(eq(BrainReviewMemoryTable.id, ownerEntry))
            .get()
          const atCleanup = Effect.gen(function* () {
            return {
              parent: yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, repo.parent.id)).get(),
              review: yield* brain.db
                .select()
                .from(BrainReviewMemoryTable)
                .where(eq(BrainReviewMemoryTable.id, reviewEntry))
                .get(),
              owner: yield* brain.db
                .select()
                .from(BrainReviewMemoryTable)
                .where(eq(BrainReviewMemoryTable.id, ownerEntry))
                .get(),
              ordinary: yield* brain.db
                .select()
                .from(BrainEntryTable)
                .where(eq(BrainEntryTable.id, ordinaryEntry))
                .get(),
            }
          })
          const observed: { calls: number; value?: Effect.Success<typeof atCleanup> } = { calls: 0 }
          // This hook only observes ordering. All assertions occur outside the
          // best-effort hook; the actual lifecycle eraser is the enforced boundary.
          const unregister = SessionCleanup.register((info) =>
            info.id !== repo.parent.id
              ? Effect.void
              : Effect.gen(function* () {
                  observed.calls++
                  observed.value = yield* atCleanup
                }),
          )
          const global = yield* brain.db
            .select()
            .from(BrainReviewMemoryStateTable)
            .where(eq(BrainReviewMemoryStateTable.repository_id, ReviewStore.GLOBAL))
            .get()
          if (!global || !ordinary || !owned) throw new Error("Incomplete session erasure fixture")
          yield* Effect.gen(function* () {
            if (corrupt)
              yield* brain.db
                .update(BrainReviewMemoryStateTable)
                .set({ generation: -1 })
                .where(eq(BrainReviewMemoryStateTable.repository_id, ReviewStore.GLOBAL))
                .run()
            const before = yield* snapshot()
            const result = yield* sessions.remove(repo.parent.id).pipe(Effect.result)
            if (corrupt) {
              expect(Result.isFailure(result) && result.failure._tag).toBe("SessionBusyError")
              expect(yield* snapshot()).toEqual(before)
              expect(yield* sessions.get(repo.parent.id)).toMatchObject({ id: repo.parent.id })
              expect(yield* sessions.get(started.runID)).toMatchObject({ id: started.runID })
              expect(observed.calls).toBe(0)
            } else {
              expect(Result.isSuccess(result)).toBe(true)
              expect(observed.calls).toBe(1)
              expect(observed.value?.parent?.id).toBe(repo.parent.id)
              expect(observed.value?.review).toBeUndefined()
              expect(observed.value?.ordinary).toEqual(ordinary)
              expect(observed.value?.owner).toEqual(owned)
              expect(
                yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, repo.parent.id)).get(),
              ).toBeUndefined()
              expect(
                yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, started.runID)).get(),
              ).toBeUndefined()
              expect(
                yield* brain.db.select().from(BrainEntryTable).where(eq(BrainEntryTable.id, ordinaryEntry)).get(),
              ).toEqual(ordinary)
              expect(
                yield* brain.db
                  .select()
                  .from(BrainReviewMemoryTable)
                  .where(eq(BrainReviewMemoryTable.id, ownerEntry))
                  .get(),
              ).toEqual(owned)
            }
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                unregister()
                if (corrupt)
                  yield* brain.db
                    .update(BrainReviewMemoryStateTable)
                    .set({ generation: global.generation })
                    .where(eq(BrainReviewMemoryStateTable.repository_id, ReviewStore.GLOBAL))
                    .run()
                    .pipe(Effect.orDie)
              }),
            ),
          )
        }
      }),
    options,
  )
})
