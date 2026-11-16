import { afterAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { randomUUID } from "node:crypto"
import path from "node:path"
import fs from "node:fs/promises"
import { eq, sql } from "drizzle-orm"
import { Deferred, Effect, Fiber, Function, Layer, Result } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import { BrainRevocation } from "@vectordevai/core/brain/revocation"
import { ReviewMemory } from "@vectordevai/core/brain/review-memory"
import { ReviewStore } from "@vectordevai/core/brain/review-store"
import {
  BrainEntryTable,
  BrainEventTable,
  BrainReviewMemoryStateTable,
  BrainReviewMemoryScopeStateTable,
  BrainReviewMemoryTable,
  BrainTombstoneTable,
} from "@vectordevai/core/brain/sql"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { GUEST_REQUEST_HEADER } from "@vectordevai/core/free-model-guests"
import { Project } from "@vectordevai/core/project"
import { ReadOnlyGit } from "@vectordevai/core/read-only-git"
import { ReviewRequestStore } from "@vectordevai/core/review/request-store"
import { ReviewSessionFenceTable } from "@vectordevai/core/review/request.sql"
import { ReviewRequestTable } from "@vectordevai/core/review/request.sql"
import { reviewVerdict } from "@vectordevai/core/review/verdict"
import { SessionTable } from "@vectordevai/core/session/sql"
import { EffectFlock } from "@vectordevai/core/util/effect-flock"
import { RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
import { SessionID } from "@vectordevai/schema/session-id"
import type { ReviewRun } from "@vectordevai/schema/review-run"
import { InstanceRef } from "@/effect/instance-ref"
import { ReviewLifecycle } from "@/review/lifecycle"
import { ReviewLocalRun } from "@/review/local-run"
import { ReviewMemoryAuthority } from "@/review/memory-authority"
import { ReviewMemoryErasure } from "@/review/memory-erasure"
import { ReviewMemoryScope } from "@/review/memory-scope"
import type { InstanceContext } from "@/project/instance-context"
import { tmpdir } from "../fixture/fixture"
import { awaitWithTimeout } from "../lib/effect"

const parentID = SessionID.make("ses_memory_boundary_parent")
const reviewID = SessionID.make("ses_memory_boundary_review")
const repository = Project.ID.make("memory-boundary")
const request: ReviewRun.Start = {
  requestID: "memory_boundary_1",
  target: { kind: "working-tree", head: "a".repeat(40) },
}
const source = { repository, parentID, reviewID, head: request.target.head }
const owner = BackgroundJobStore.open()
afterAll(() => BackgroundJobStore.close(owner))
const success = () => Effect.succeed({ ok: true as const, value: "authorized" })
const inspection = (setup: Setup): ReviewMemory.OwnerRequest => ({
  repository,
  scope: setup.scope,
  operation: "inspect",
  digest: "a".repeat(64),
  payload: {},
})
type Setup = {
  db: Database.Interface["db"]
  brain: BrainDatabase.Database
  requests: ReviewRequestStore.Interface
  lifecycle: ReviewLifecycle.Interface
  flock: EffectFlock.Interface
  eraser: ReviewMemoryErasure.Interface
  authority: ReviewMemory.Authority
  directory: string
  held: { value: boolean }
  ownerNonce: string
  scope: string
  source: ReviewMemory.Source & { repository: string; scope: string }
  instance: InstanceContext
  settle: Effect.Effect<void>
}

async function run(body: (setup: Setup) => Effect.Effect<void, unknown>) {
  await using directory = await tmpdir({ git: true })
  const instance: InstanceContext = {
    directory: directory.path,
    worktree: directory.path,
    project: { id: repository, worktree: directory.path, time: { created: 1, updated: 1 }, sandboxes: [] },
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const brain = (yield* BrainDatabase.Service).db
      const requests = ReviewRequestStore.make(db)
      const eraser = ReviewMemoryErasure.make(requests, brain)
      const physical = yield* ReviewMemoryScope.git(directory.path)
      yield* db.run(
        sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES (${repository}, ${directory.path}, '[]', 1, 1)`,
      )
      yield* db.run(
        sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${parentID}, ${repository}, 'parent', ${directory.path}, 'Owner', 'test', 1, 1)`,
      )
      const record = {
        version: 1 as const,
        parentID,
        request,
        directory: directory.path,
        status: "running" as const,
        startedAt: 1,
      }
      yield* db
        .insert(SessionTable)
        .values({
          id: reviewID,
          project_id: repository,
          parent_id: parentID,
          internal: ReviewLocalRun.MARKER,
          slug: "review",
          directory: directory.path,
          title: "Review",
          version: "test",
          time_created: 1,
          time_updated: 1,
          metadata: { [ReviewLocalRun.FIELD]: record },
        })
        .run()
      const identity = { parentID, runID: reviewID, requestID: request.requestID, ownerNonce: randomUUID() }
      yield* requests.reserve({ ...identity, request, owner, sourceBinding: physical.binding })
      yield* requests.attach(identity)
      yield* requests.begin(identity)
      const held = { value: false }
      return yield* Effect.gen(function* () {
        const lifecycle = yield* ReviewLifecycle.Service
        const flock = yield* EffectFlock.Service
        // The fixed trusted setting is a test policy input. The real adapter still
        // proves source lineage/fences in SQLite and owner identity in HTTP context.
        const authority = ReviewMemoryAuthority.make({
          database: db,
          requests,
          lifecycle,
          settings: {
            trust: () =>
              Effect.succeed({
                workspace: directory.path,
                fingerprint: "fixture",
                trusted: !held.value,
                settings: held.value,
                ignored: held.value,
              }),
          },
        })
        const artifact = ReviewLocalRun.encodeArtifact({
          exitCode: 2,
          error: "Fixture stopped",
          verdict: reviewVerdict({ kind: "failure", stage: "review" }),
        })
        if (!artifact) throw new Error("Missing fixture artifact")
        const settle = Effect.gen(function* () {
          yield* db
            .update(SessionTable)
            .set({ metadata: { [ReviewLocalRun.FIELD]: { ...record, status: "failed", completedAt: 2, artifact } } })
            .where(eq(SessionTable.id, reviewID))
            .run()
            .pipe(Effect.orDie)
          yield* requests.finish(identity)
        })
        yield* body({
          db,
          brain,
          requests,
          lifecycle,
          flock,
          eraser,
          authority,
          directory: directory.path,
          held,
          ownerNonce: identity.ownerNonce,
          scope: physical.binding.scope,
          source: { ...source, scope: physical.binding.scope },
          instance,
          settle,
        })
      }).pipe(
        Effect.provide(
          ReviewLifecycle.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                Layer.succeed(ReviewRequestStore.Service, requests),
                Layer.succeed(ReviewMemoryErasure.Service, eraser),
                LayerNode.compile(EffectFlock.node),
              ),
            ),
          ),
        ),
        Effect.provideService(InstanceRef, instance),
      )
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Database.layerFromPath(path.join(directory.path, "main.sqlite")),
          BrainDatabase.layerFor(path.join(directory.path, "brain.sqlite")),
        ),
      ),
      Effect.scoped,
    ),
  )
}

const seedMemory = (setup: Setup) =>
  setup.brain.transaction((tx) =>
    Effect.gen(function* () {
      yield* ReviewStore.register(tx, repository, setup.scope)
      yield* ReviewStore.advance(tx, repository, setup.scope, true)
      yield* tx
        .insert(BrainReviewMemoryTable)
        .values([
          {
            id: "review-origin",
            repository_id: repository,
            scope_id: setup.scope,
            kind: "outcome",
            status: "active",
            visibility: "repository",
            body: "Approved review excerpt",
            paths: ["src/a.ts"],
            citations: [{ path: "src/a.ts", line: 1, head: source.head, quote: "return []" }],
            reason: "Explicitly approved",
            parent_session_id: parentID,
            review_session_id: reviewID,
            source_head: source.head,
            origin: "review",
            approved_by: "owner",
            approved_at: 2,
            created_at: 1,
            updated_at: 2,
          },
          {
            id: "owner-only",
            repository_id: repository,
            scope_id: setup.scope,
            kind: "preference",
            status: "active",
            visibility: "repository",
            body: "Keep the owner preference",
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
        sql`INSERT INTO brain_entry (id, scope, repository_id, kind, origin, status, body, paths, terms, norm_hash, confidence, related, created_at, updated_at) VALUES ('ordinary', 'repository', ${repository}, 'fact', 'user', 'active', 'Ordinary memory remains', '[]', '', 'ordinary-hash', 1, '[]', 1, 1)`,
      )
    }),
  )
const snapshot = (db: BrainDatabase.Database) =>
  Effect.gen(function* () {
    return {
      review: yield* db.select().from(BrainReviewMemoryTable).all(),
      state: yield* db.select().from(BrainReviewMemoryStateTable).all(),
      scoped: yield* db.select().from(BrainReviewMemoryScopeStateTable).all(),
      witness: yield* db.select().from(BrainTombstoneTable).all(),
      ordinary: yield* db.select().from(BrainEntryTable).all(),
      events: yield* db.select().from(BrainEventTable).all(),
      revocation: yield* BrainRevocation.revision(db, repository),
    }
  })
const authenticated = <A>(effect: Effect.Effect<A>, headers?: HeadersInit) =>
  effect.pipe(
    Effect.provideService(RequestPrincipal, { kind: "owner", username: "fixture-owner" }),
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request("http://localhost/review/memory", { headers })),
    ),
  )

test.skipIf(process.platform !== "win32")(
  "Windows refuses a valid review-memory repository before pinned helper or model admission",
  async () => {
    await using directory = await tmpdir({ git: true })
    expect((await fs.stat(path.join(directory.path, ".git"))).isDirectory()).toBe(true)
    expect(await fs.realpath(directory.path)).toBe(directory.path)
    // Check the actual platform refusal before the adapter can open a pinned
    // directory or start its metadata helper. No substitute identity is supplied.
    await expect(ReadOnlyGit.metadataHead(directory.path)).rejects.toMatchObject({
      code: "READ_ONLY_GIT_UNAVAILABLE",
      reason: "this host has no pinned-directory adapter",
    })
    let admitted = false
    const result = await Effect.runPromise(
      ReviewMemoryScope.git(directory.path).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            admitted = true
          }),
        ),
        Effect.result,
      ),
    )
    expect(Result.isFailure(result) ? result.failure : undefined).toBeInstanceOf(ReviewMemoryScope.Refused)
    expect(admitted).toBe(false)
  },
)

// These eight cases require the real Linux pinned-directory identity adapter.
const linux = describe.skipIf(process.platform !== "linux")
linux("Engine review memory authority and erase-before-delete boundary (Linux)", () => {
  test("same-store directories/worktrees preserve exact source provenance while a same-ProjectID clone cannot inherit it", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        const nested = path.join(setup.directory, "nested")
        yield* Effect.promise(() => fs.mkdir(nested))
        const child = { ...setup.instance, directory: nested }
        expect(
          yield* setup.authority.source(setup.source, success).pipe(Effect.provideService(InstanceRef, child)),
        ).toEqual({ ok: true, value: "authorized" })
        const linked = path.join(setup.directory, "linked")
        yield* Effect.promise(() => $`git worktree add --quiet -b scope-linked ${linked}`.cwd(setup.directory).quiet())
        const sibling = { ...setup.instance, directory: linked, worktree: linked }
        expect(
          yield* setup.authority.source(setup.source, success).pipe(Effect.provideService(InstanceRef, sibling)),
        ).toEqual({ ok: true, value: "authorized" })
        const clone = path.join(setup.directory, "clone")
        yield* Effect.promise(() =>
          $`git clone --quiet --no-hardlinks ${setup.directory} ${clone}`.cwd(setup.directory).quiet(),
        )
        const copied = yield* ReviewMemoryScope.git(clone)
        const foreign = { ...setup.instance, directory: clone, worktree: clone }
        expect(copied.binding.scope).not.toBe(setup.scope)
        expect(
          yield* authenticated(setup.authority.owner(inspection(setup), success)).pipe(
            Effect.provideService(InstanceRef, foreign),
          ),
        ).toEqual({ ok: false, reason: "authority-unavailable" })
        expect(
          yield* setup.authority
            .source({ ...setup.source, scope: copied.binding.scope }, success)
            .pipe(Effect.provideService(InstanceRef, foreign)),
        ).toEqual({ ok: false, reason: "source-unavailable" })
      }),
    )
  })

  test("a replaced store cannot relabel an old artifact, and a missing legacy reservation binding is never adopted", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        const original = path.join(setup.directory, "saved-original-store")
        const marker = path.join(setup.directory, ".git")
        yield* Effect.promise(() => fs.rename(marker, original))
        yield* Effect.promise(() => fs.cp(original, marker, { recursive: true }))
        yield* Effect.promise(() =>
          $`git config --local fixture.scopeIdentity replacement`.cwd(setup.directory).quiet(),
        )
        const replacement = yield* ReviewMemoryScope.git(setup.directory)
        expect(replacement.binding.scope).not.toBe(setup.scope)
        expect(yield* setup.authority.source(setup.source, success)).toEqual({
          ok: false,
          reason: "source-unavailable",
        })
        expect(yield* setup.authority.source({ ...setup.source, scope: replacement.binding.scope }, success)).toEqual({
          ok: false,
          reason: "source-unavailable",
        })
        yield* Effect.promise(() => fs.rename(marker, path.join(setup.directory, "saved-replacement-store")))
        yield* Effect.promise(() => fs.rename(original, marker))
        expect(yield* setup.authority.source(setup.source, success)).toEqual({ ok: true, value: "authorized" })
        yield* setup.db.update(ReviewRequestTable).set({ source_binding: null }).run()
        expect(yield* setup.authority.source(setup.source, success)).toEqual({
          ok: false,
          reason: "source-unavailable",
        })
      }),
    )
  })

  test("ambient owner defaults, absent HTTP requests, guests and forwarded requests never grant read-owner authority", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        const read = setup.authority.owner(inspection(setup), success)
        expect(yield* read).toEqual({ ok: false, reason: "denied" })
        expect(
          yield* read.pipe(Effect.provideService(RequestPrincipal, { kind: "owner", username: "fixture-owner" })),
        ).toEqual({ ok: false, reason: "denied" })
        const http = HttpServerRequest.fromWeb(new Request("http://localhost/review/memory"))
        expect(yield* read.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, http))).toEqual({
          ok: false,
          reason: "denied",
        })
        expect(
          yield* read.pipe(
            Effect.provideService(RequestPrincipal, {
              kind: "guest",
              username: "guest",
              workspaceIDs: new Set<string>(),
              workspaceDirectories: new Map<string, string>(),
              sessionIDs: new Set<string>(),
            }),
            Effect.provideService(HttpServerRequest.HttpServerRequest, http),
          ),
        ).toEqual({ ok: false, reason: "denied" })
        expect(yield* authenticated(read, { [GUEST_REQUEST_HEADER]: "1" })).toEqual({ ok: false, reason: "denied" })
        expect(yield* authenticated(read)).toEqual({ ok: true, value: "authorized" })
        expect(
          yield* authenticated(setup.authority.owner({ ...inspection(setup), repository: "foreign" }, success)),
        ).toEqual({
          ok: false,
          reason: "authority-unavailable",
        })
        expect(
          yield* authenticated(setup.authority.owner({ ...inspection(setup), operation: "approve" }, success)),
        ).toEqual({
          ok: false,
          reason: "authority-unavailable",
        })
      }),
    )
  })

  test("actual instance, durable reservation, hidden lineage, trust and retained artifact all constrain source authority", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        expect(yield* setup.authority.source(setup.source, success)).toEqual({ ok: true, value: "authorized" })
        for (const invalid of [
          { ...setup.source, repository: "foreign" },
          { ...setup.source, head: "b".repeat(40) },
          { ...setup.source, reviewID: "ses_missing" },
        ])
          expect(yield* setup.authority.source(invalid, success)).toEqual({ ok: false, reason: "source-unavailable" })
        setup.held.value = true
        expect(yield* setup.authority.source(setup.source, success)).toEqual({
          ok: false,
          reason: "source-unavailable",
        })
        setup.held.value = false
        yield* setup.settle
        expect(yield* setup.authority.source(setup.source, success)).toEqual({ ok: true, value: "authorized" })
        yield* setup.db
          .update(SessionTable)
          .set({ directory: path.join(setup.directory, "missing") })
          .where(eq(SessionTable.id, reviewID))
          .run()
        expect(yield* setup.authority.source(setup.source, success)).toEqual({
          ok: false,
          reason: "source-unavailable",
        })
        yield* setup.db
          .update(SessionTable)
          .set({ directory: setup.directory, internal: "other-helper" })
          .where(eq(SessionTable.id, reviewID))
          .run()
        expect(yield* setup.authority.source(setup.source, success)).toEqual({
          ok: false,
          reason: "source-unavailable",
        })
        yield* setup.db
          .update(SessionTable)
          .set({
            internal: ReviewLocalRun.MARKER,
            metadata: {
              [ReviewLocalRun.FIELD]: {
                version: 1,
                parentID,
                request,
                directory: setup.directory,
                status: "failed",
                startedAt: 1,
                completedAt: 2,
                artifact: { version: 1, json: "{}", bytes: 2, sha256: "a".repeat(64) },
              },
            },
          })
          .where(eq(SessionTable.id, reviewID))
          .run()
        expect(yield* setup.authority.source(setup.source, success)).toEqual({
          ok: false,
          reason: "source-unavailable",
        })
      }),
    )
  })

  test("only the exact persistent closer can erase approved review provenance; ordinary and owner memory remain", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        yield* setup.settle
        yield* seedMemory(setup)
        const before = yield* snapshot(setup.brain)
        expect(Result.isFailure(yield* setup.eraser.remove(parentID, randomUUID()).pipe(Effect.result))).toBe(true)
        expect(yield* snapshot(setup.brain)).toEqual(before)
        yield* setup.lifecycle.deleting(
          parentID,
          Effect.gen(function* () {
            expect((yield* setup.brain.select().from(BrainReviewMemoryTable).all()).map((row) => row.id)).toEqual([
              "owner-only",
            ])
            expect(yield* setup.brain.select().from(BrainEntryTable).all()).toEqual(before.ordinary)
            expect(yield* BrainRevocation.revision(setup.brain, repository)).toBeGreaterThan(before.revocation)
            expect(yield* setup.authority.source(setup.source, success)).toEqual({
              ok: false,
              reason: "source-unavailable",
            })
            yield* setup.db.delete(SessionTable).where(eq(SessionTable.id, parentID)).run()
          }),
        )
        expect(yield* setup.requests.sourceSnapshot(parentID, reviewID)).toBeUndefined()
      }),
    )
  })

  test("corrupt review generation aborts session deletion with the complete Brain poststate unchanged", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        yield* setup.settle
        yield* seedMemory(setup)
        yield* setup.brain.run(sql`UPDATE brain_review_memory_state SET generation = -1 WHERE repository_id = ''`)
        const before = yield* snapshot(setup.brain)
        let removed = false
        const result = yield* setup.lifecycle
          .deleting(
            parentID,
            Effect.sync(() => {
              removed = true
            }),
          )
          .pipe(Effect.result)
        expect(Result.isFailure(result) && result.failure.code).toBe("unavailable")
        expect(removed).toBe(false)
        expect(yield* snapshot(setup.brain)).toEqual(before)
        expect(yield* setup.db.select().from(SessionTable).where(eq(SessionTable.id, parentID)).get()).toBeDefined()
        expect(yield* setup.db.select().from(ReviewSessionFenceTable).all()).toEqual([])
      }),
    )
  })

  test("an active local worker is cancelled before review erasure and before the session deletion body", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        yield* seedMemory(setup)
        let cancelled = false
        const unregister = ReviewLifecycle.register(setup.ownerNonce, () =>
          Effect.gen(function* () {
            expect((yield* setup.brain.select().from(BrainReviewMemoryTable).all()).map((row) => row.id)).toContain(
              "review-origin",
            )
            expect(yield* setup.requests.sourceSnapshot(parentID, reviewID)).toBeUndefined()
            cancelled = true
          }).pipe(Effect.orDie),
        )
        yield* setup.lifecycle
          .deleting(
            parentID,
            Effect.gen(function* () {
              expect(cancelled).toBe(true)
              expect((yield* setup.brain.select().from(BrainReviewMemoryTable).all()).map((row) => row.id)).toEqual([
                "owner-only",
              ])
            }),
          )
          .pipe(Effect.ensuring(Effect.sync(unregister)))
      }),
    )
  })

  test("deletion waits for an active source callback, then the durable fence refuses late callbacks during its body", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        yield* setup.settle
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const leaving = yield* Deferred.make<void>()
        const attempted = yield* Deferred.make<void>()
        const deleting = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        // Instrument the actual deletion lock, not a fake lifecycle or DB.
        // The attempt acknowledgement proves the contender reached withLock
        // while the source callback is held. Its acquired body independently
        // checks that the source finished its protected work first.
        const withLock: EffectFlock.Interface["withLock"] = Function.dual(
          (args) => Effect.isEffect(args[0]),
          <A, E, R>(body: Effect.Effect<A, E, R>, key: string, directory?: string) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(attempted, undefined)
              return yield* setup.flock.withLock(
                key,
                directory,
              )(
                Effect.gen(function* () {
                  expect(yield* Deferred.isDone(leaving)).toBe(true)
                  return yield* body
                }),
              )
            }),
        )
        const contender = yield* ReviewLifecycle.Service.pipe(
          Effect.provide(
            Layer.fresh(ReviewLifecycle.layer).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(ReviewRequestStore.Service, setup.requests),
                  Layer.succeed(ReviewMemoryErasure.Service, setup.eraser),
                  Layer.succeed(EffectFlock.Service, { acquire: setup.flock.acquire, withLock }),
                ),
              ),
            ),
          ),
        )
        const reader = yield* setup.authority
          .source(setup.source, () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* awaitWithTimeout(Deferred.await(release), "Source callback release was not signalled").pipe(
                Effect.orDie,
              )
              yield* Deferred.succeed(leaving, undefined)
              return { ok: true as const, value: "authorized" }
            }),
          )
          .pipe(Effect.forkScoped)
        yield* awaitWithTimeout(Deferred.await(entered), "Source callback did not enter its actual lifecycle lock")
        const removal = yield* contender
          .deleting(
            parentID,
            Effect.gen(function* () {
              yield* Deferred.succeed(deleting, undefined)
              yield* awaitWithTimeout(Deferred.await(finish), "Deletion body finish was not signalled")
            }),
          )
          .pipe(Effect.forkScoped)
        yield* awaitWithTimeout(
          Deferred.await(attempted),
          "Deletion contender did not attempt the instrumented actual flock",
        )
        expect(yield* Deferred.isDone(deleting)).toBe(false)
        yield* Deferred.succeed(release, undefined)
        expect(
          yield* awaitWithTimeout(Fiber.join(reader), "Source callback did not leave its actual lifecycle lock"),
        ).toEqual({ ok: true, value: "authorized" })
        yield* awaitWithTimeout(
          Deferred.await(deleting),
          "Deletion did not acquire its actual flock after the source left",
        )
        expect(yield* setup.authority.source(setup.source, success)).toEqual({
          ok: false,
          reason: "source-unavailable",
        })
        yield* Deferred.succeed(finish, undefined)
        yield* awaitWithTimeout(Fiber.join(removal), "Deletion did not finish after the body was released")
      }).pipe(Effect.scoped),
    )
  })
})
