import { afterAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { eq, sql } from "drizzle-orm"
import { Effect, Layer, Result, Schema } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import { ReviewMemory } from "@vectordevai/core/brain/review-memory"
import { ReviewStore } from "@vectordevai/core/brain/review-store"
import { ReviewWitness } from "@vectordevai/core/brain/review-witness"
import { BrainEntryTable, BrainReviewMemorySourceTable, BrainReviewMemoryTable } from "@vectordevai/core/brain/sql"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { GUEST_REQUEST_HEADER } from "@vectordevai/core/free-model-guests"
import { Project } from "@vectordevai/core/project"
import { ReviewRequestStore } from "@vectordevai/core/review/request-store"
import { reviewVerdict } from "@vectordevai/core/review/verdict"
import { SessionTable } from "@vectordevai/core/session/sql"
import { EffectFlock } from "@vectordevai/core/util/effect-flock"
import { RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
import { SessionID } from "@vectordevai/schema/session-id"
import { ReviewMemoryControl } from "@vectordevai/schema/review-memory"
import type { ReviewRun } from "@vectordevai/schema/review-run"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { ReviewLifecycle } from "@/review/lifecycle"
import { ReviewLocalRun } from "@/review/local-run"
import { ReviewMemoryAuthority } from "@/review/memory-authority"
import { ReviewMemoryErasure } from "@/review/memory-erasure"
import { ReviewMemoryOwner } from "@/review/memory-owner"
import { ReviewMemoryScope } from "@/review/memory-scope"
import { tmpdir } from "../fixture/fixture"

const repository = Project.ID.make("prepared-memory")
const parentID = SessionID.make("ses_prepared_memory_parent")
const reviewID = SessionID.make("ses_prepared_memory_run")
const request: ReviewRun.Start = {
  requestID: "prepared_memory_1",
  target: { kind: "working-tree", head: "a".repeat(40) },
}
const source = { parentID, reviewID, head: request.target.head }
const owner = BackgroundJobStore.open()
afterAll(() => BackgroundJobStore.close(owner))
const owned = <A, E>(effect: Effect.Effect<A, E>, username = "fixture-owner", headers?: HeadersInit) =>
  effect.pipe(
    Effect.provideService(RequestPrincipal, { kind: "owner", username }),
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request("http://localhost/experimental/review-memory", { headers })),
    ),
  )
const confirmation = (preview: ReviewMemoryOwner.Preview) => ({
  previewId: preview.previewId,
  approvedSha256: preview.sha256,
})
const value = <A>(result: ReviewMemory.Result<A>): A => {
  if (!result.ok) throw new Error(result.reason)
  return result.value
}
type Setup = {
  controls: ReviewMemoryOwner.Interface
  memory: ReviewMemory.Interface
  brain: BrainDatabase.Database
  db: Database.Interface["db"]
  lifecycle: ReviewLifecycle.Interface
  place: ReviewMemory.Place
  instance: InstanceContext
  clock: { value: number }
  trust: { fingerprint: string; held: boolean; before?: () => Effect.Effect<void> }
  restart: () => ReviewMemoryOwner.Interface
  timers: { run: () => void; size: () => number }
  admitSource: () => Effect.Effect<void, unknown>
}
const prepare = (setup: Setup, command: unknown) =>
  setup.controls.prepare({ expectedScope: setup.place.scope, command })

// These are internal service tests with explicit HTTP middleware context and
// real SQL/lifecycle authority, not public route or physical-common-store proof.
// No routes, context consumer or automatic proposal producer are activated.
async function run(body: (setup: Setup) => Effect.Effect<void, unknown>) {
  await using directory = await tmpdir({ git: true })
  const instance: InstanceContext = {
    directory: directory.path,
    worktree: directory.path,
    project: { id: repository, worktree: directory.path, time: { created: 1, updated: 1 }, sandboxes: [] },
  }
  const clock = { value: 0 }
  const trust: Setup["trust"] = { fingerprint: "fixture", held: false }
  const settings = {
    trust: () =>
      Effect.gen(function* () {
        const before = trust.before
        trust.before = undefined
        if (before) yield* before()
        return {
          workspace: directory.path,
          fingerprint: trust.fingerprint,
          trusted: !trust.held,
          settings: trust.held,
          ignored: trust.held,
        }
      }),
  }
  let nextTimer = 0
  const tasks = new Map<number, { at: number; callback: () => void }>()
  const schedule = (delay: number, callback: () => void) => {
    const id = ++nextTimer
    tasks.set(id, { at: clock.value + delay, callback })
    return () => {
      tasks.delete(id)
    }
  }
  const timers = {
    size: () => tasks.size,
    run: () => {
      for (const [id, task] of [...tasks])
        if (task.at <= clock.value) {
          tasks.delete(id)
          task.callback()
        }
    },
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const database = yield* BrainDatabase.Service
      const requests = ReviewRequestStore.make(db)
      const physical = yield* ReviewMemoryScope.git(directory.path)
      const eraser = ReviewMemoryErasure.make(requests, database.db)
      yield* db.run(
        sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES (${repository}, ${directory.path}, '[]', 1, 1)`,
      )
      yield* db.run(
        sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${parentID}, ${repository}, 'parent', ${directory.path}, 'Owner', 'test', 1, 1)`,
      )
      const artifact = ReviewLocalRun.encodeArtifact({
        exitCode: 2,
        error: "Fixture result",
        verdict: reviewVerdict({ kind: "failure", stage: "review" }),
      })
      if (!artifact) throw new Error("Missing fixture artifact")
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
          metadata: {
            [ReviewLocalRun.FIELD]: {
              version: 1,
              parentID,
              request,
              directory: directory.path,
              status: "failed",
              startedAt: 1,
              completedAt: 2,
              artifact,
            },
          },
        })
        .run()
      let sourceAttempted = false
      const admitSource = () =>
        Effect.gen(function* () {
          if (sourceAttempted) throw new Error("The fixture source cannot be registered again")
          sourceAttempted = true
          const identity = { parentID, runID: reviewID, requestID: request.requestID, ownerNonce: randomUUID() }
          const reservation = yield* requests.reserve({ ...identity, request, owner, sourceBinding: physical.binding })
          const witnesses = reservation.row.sourceBinding?.witnesses
          const proof = witnesses
            ? ReviewWitness.proof({
                repository,
                scope: physical.binding.scope,
                parentID,
                reviewID,
                head: source.head,
                witnesses,
              })
            : undefined
          if (!reservation.claimed || !proof || !(yield* requests.attach(identity)))
            throw new Error("Missing fresh fixture source")
          // Explicit fixture admission AFTER owner enable, never a lazy source/read callback.
          if (!(yield* ReviewStore.registerSource(database.db, proof)))
            throw new Error("Fixture source was not enabled")
          if (!(yield* requests.begin(identity))) throw new Error("Fixture source did not begin")
          yield* requests.finish(identity)
        })
      yield* Effect.gen(function* () {
        const lifecycle = yield* ReviewLifecycle.Service
        const authority = ReviewMemoryAuthority.make({ database: db, requests, lifecycle, settings })
        const memory = yield* ReviewMemory.Service.pipe(
          Effect.provide(
            ReviewMemory.layerWith(authority).pipe(Layer.provide(Layer.succeed(BrainDatabase.Service, database))),
          ),
        )
        const instances: ReturnType<typeof ReviewMemoryOwner.make>[] = []
        const create = () => {
          const controls = ReviewMemoryOwner.make({
            memory,
            settings,
            clock: { now: () => clock.value, date: () => 1_000_000 + clock.value, schedule },
          })
          instances.push(controls)
          return controls
        }
        const controls = create()
        yield* body({
          controls,
          memory,
          brain: database.db,
          db,
          lifecycle,
          place: { repository, scope: physical.binding.scope, root: directory.path, sources: [], held: false },
          instance,
          clock,
          trust,
          timers,
          admitSource,
          restart: () => {
            instances.forEach((item) => item.dispose())
            return create()
          },
        }).pipe(Effect.ensuring(Effect.sync(() => instances.forEach((item) => item.dispose()))))
      }).pipe(
        Effect.provide(
          ReviewLifecycle.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ReviewRequestStore.Service, requests),
                Layer.succeed(ReviewMemoryErasure.Service, eraser),
                LayerNode.compile(EffectFlock.node),
              ),
            ),
          ),
        ),
      )
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Database.layerFromPath(path.join(directory.path, "main.sqlite")),
          BrainDatabase.layerFor(path.join(directory.path, "brain.sqlite")),
        ),
      ),
      Effect.provideService(InstanceRef, instance),
      Effect.scoped,
    ),
  )
}
const enable = (setup: Setup) =>
  Effect.gen(function* () {
    const read = yield* setup.controls.inspect()
    const preview = yield* prepare(setup, {
      action: "configure",
      expected: read.state.generation,
      enabled: true,
    })
    yield* setup.controls.confirm(confirmation(preview))
  })
const preference = (expected: number) => ({
  action: "record",
  expected,
  kind: "preference",
  text: "Prefer explicit early returns.",
  paths: ["src/*"],
  citations: [],
  reason: "Owner preference",
  visibility: "repository",
})

describe("prepared owner controls for isolated review memory (inactive internal ports)", () => {
  test("prepare checks the displayed physical scope inside the service before reading or preparing another namespace", async () => {
    await run((setup) =>
      owned(
        Effect.gen(function* () {
          const before = yield* setup.controls.inspect()
          const other = `vrs1_${(before.scope.endsWith("0") ? "1" : "0").repeat(64)}`
          const result = yield* setup.controls
            .prepare({
              expectedScope: other,
              command: { action: "configure", expected: before.state.generation, enabled: true },
            })
            .pipe(Effect.result)
          expect(Result.isFailure(result) && result.failure.code).toBe("stale")
          expect((yield* setup.controls.inspect()).state).toEqual(before.state)
          const oldShape = yield* setup.controls
            .prepare({ action: "configure", expected: before.state.generation, enabled: true })
            .pipe(Effect.result)
          expect(Result.isFailure(oldShape) && oldShape.failure.code).toBe("invalid")
        }),
      ),
    )
  })

  test("a fresh service boot cannot consume the previous service's preview, even with unchanged owner and database", async () => {
    await run((setup) =>
      owned(
        Effect.gen(function* () {
          const before = yield* setup.controls.inspect()
          const preview = yield* prepare(setup, {
            action: "configure",
            expected: before.state.generation,
            enabled: true,
          })
          expect(setup.timers.size()).toBe(1)
          const restarted = setup.restart()
          expect(setup.timers.size()).toBe(0)
          const stale = yield* restarted.confirm(confirmation(preview)).pipe(Effect.result)
          expect(Result.isFailure(stale) && stale.failure.code).toBe("unavailable")
          expect((yield* restarted.inspect()).state).toEqual(before.state)
          const closed = yield* setup.controls.confirm(confirmation(preview)).pipe(Effect.result)
          expect(Result.isFailure(closed) && closed.failure.code).toBe("unavailable")
        }),
      ),
    )
  })

  test("same-path common-store replacement refuses and retires an old approval instead of reviving it after restoration", async () => {
    await run((setup) =>
      owned(
        Effect.gen(function* () {
          const before = yield* setup.controls.inspect()
          const preview = yield* prepare(setup, {
            action: "configure",
            expected: before.state.generation,
            enabled: true,
          })
          const marker = path.join(setup.instance.directory, ".git")
          const saved = path.join(setup.instance.directory, "original-store")
          yield* Effect.promise(() => fs.rename(marker, saved))
          yield* Effect.gen(function* () {
            yield* Effect.promise(() => fs.cp(saved, marker, { recursive: true }))
            yield* Effect.promise(() =>
              $`git config --local fixture.ownerScope replacement`.cwd(setup.instance.directory).quiet(),
            )
            const replacement = yield* ReviewMemoryScope.git(setup.instance.directory)
            expect(replacement.binding.scope).not.toBe(before.scope)
            const result = yield* setup.controls.confirm(confirmation(preview)).pipe(Effect.result)
            expect(Result.isFailure(result) && result.failure.code).toBe("stale")
          }).pipe(
            Effect.ensuring(
              Effect.promise(async () => {
                await fs.rm(marker, { recursive: true, force: true })
                await fs.rename(saved, marker)
              }),
            ),
          )
          const restored = yield* setup.controls.confirm(confirmation(preview)).pipe(Effect.result)
          expect(Result.isFailure(restored) && restored.failure.code).toBe("used")
          expect((yield* setup.controls.inspect()).state).toEqual(before.state)
        }),
      ),
    )
  })

  test("physical scope changes during awaited preparation or confirmation refuse and cannot retarget the sealed action", async () => {
    await run((setup) =>
      owned(
        Effect.gen(function* () {
          const before = yield* setup.controls.inspect()
          const command = { action: "configure", expected: before.state.generation, enabled: true }
          const marker = path.join(setup.instance.directory, ".git")
          const saved = path.join(setup.instance.directory, "during-await-store")
          const moved = { value: false }
          const replace = () =>
            Effect.gen(function* () {
              yield* Effect.promise(() => fs.rename(marker, saved))
              moved.value = true
              yield* Effect.promise(() => fs.cp(saved, marker, { recursive: true }))
              yield* Effect.promise(() =>
                $`git config --local fixture.ownerScope during-await`.cwd(setup.instance.directory).quiet(),
              )
            })
          const restore = Effect.promise(async () => {
            if (!moved.value) return
            await fs.rm(marker, { recursive: true, force: true })
            await fs.rename(saved, marker)
            moved.value = false
          })
          // The real settings port is awaited after the first physical capture.
          // Change real metadata there; Core's next owner check must independently
          // reject it. No Core/SQLite/owner callback is mocked.
          setup.trust.before = replace
          const prepared = yield* prepare(setup, command).pipe(Effect.result, Effect.ensuring(restore))
          expect(Result.isFailure(prepared)).toBe(true)
          expect((yield* setup.controls.inspect()).state).toEqual(before.state)
          const preview = yield* prepare(setup, command)
          setup.trust.before = replace
          const confirmed = yield* setup.controls
            .confirm(confirmation(preview))
            .pipe(Effect.result, Effect.ensuring(restore))
          expect(Result.isFailure(confirmed)).toBe(true)
          const repeated = yield* setup.controls.confirm(confirmation(preview)).pipe(Effect.result)
          expect(Result.isFailure(repeated) && repeated.failure.code).toBe("used")
          expect((yield* setup.controls.inspect()).state).toEqual(before.state)
        }),
      ),
    )
  })

  test("discard keeps owner authority and idle expiry erases previews without a request or Core mutation", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        yield* owned(enable(setup))
        const before = yield* owned(setup.controls.inspect())
        const discarded = yield* owned(prepare(setup, preference(before.state.generation)))
        expect(Result.isFailure(yield* setup.controls.discard(discarded.previewId).pipe(Effect.result))).toBe(true)
        expect(
          Result.isFailure(
            yield* owned(setup.controls.discard(discarded.previewId), "other-owner").pipe(Effect.result),
          ),
        ).toBe(true)
        yield* owned(setup.controls.discard(discarded.previewId))
        const cancelled = yield* owned(setup.controls.confirm(confirmation(discarded))).pipe(Effect.result)
        expect(Result.isFailure(cancelled) && cancelled.failure.code).toBe("used")
        const expires = yield* owned(prepare(setup, preference(before.state.generation)))
        expect(setup.timers.size()).toBe(1)
        setup.clock.value += ReviewMemoryOwner.LIMIT.ttl + 1
        setup.timers.run()
        expect(setup.timers.size()).toBe(0)
        // A deliberate test-clock fault distinguishes destructive idle erasure
        // from a confirm-time deadline check: an expired handle cannot revive.
        setup.clock.value = 0
        const expired = yield* owned(setup.controls.confirm(confirmation(expires))).pipe(Effect.result)
        expect(Result.isFailure(expired) && expired.failure.code).toBe("unavailable")
        expect((yield* owned(setup.controls.inspect())).state).toEqual(before.state)
      }),
    )
  })

  test("preferences/enabled state share across actual same-store subdirectories and worktrees, never a colliding-ProjectID clone", async () => {
    await run((setup) =>
      owned(
        Effect.gen(function* () {
          yield* enable(setup)
          const current = yield* setup.controls.inspect()
          const preview = yield* prepare(setup, {
            ...preference(current.state.generation),
            visibility: "private",
          })
          yield* setup.controls.confirm(confirmation(preview))
          const before = yield* setup.controls.inspect()
          expect(before.state.entries).toHaveLength(1)
          const nested = path.join(setup.instance.directory, "nested")
          yield* Effect.promise(() => fs.mkdir(nested))
          const child = { ...setup.instance, directory: nested }
          expect((yield* setup.controls.inspect().pipe(Effect.provideService(InstanceRef, child))).state).toEqual(
            before.state,
          )
          const linked = path.join(setup.instance.directory, "linked")
          yield* Effect.promise(() =>
            $`git worktree add --quiet -b owner-linked ${linked}`.cwd(setup.instance.directory).quiet(),
          )
          const sibling = { ...setup.instance, directory: linked, worktree: linked }
          expect((yield* setup.controls.inspect().pipe(Effect.provideService(InstanceRef, sibling))).state).toEqual(
            before.state,
          )
          const clone = path.join(setup.instance.directory, "clone")
          yield* Effect.promise(() =>
            $`git clone --quiet --no-hardlinks ${setup.instance.directory} ${clone}`
              .cwd(setup.instance.directory)
              .quiet(),
          )
          const copied = { ...setup.instance, directory: clone, worktree: clone }
          const separate = yield* setup.controls.inspect().pipe(Effect.provideService(InstanceRef, copied))
          expect(separate.repository).toBe(before.repository)
          expect(separate.scope).not.toBe(before.scope)
          expect(separate.state.enabled).toBe(false)
          expect(separate.state.entries).toEqual([])
          expect((yield* setup.controls.inspect()).state).toEqual(before.state)
        }),
      ),
    )
  })

  test("fresh authenticated HTTP owner context is required for reads, preparation and confirmation; JSON flags grant nothing", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        expect(Result.isFailure(yield* setup.controls.inspect().pipe(Effect.result))).toBe(true)
        expect(
          Result.isFailure(
            yield* prepare(setup, { action: "configure", expected: 0, enabled: true }).pipe(Effect.result),
          ),
        ).toBe(true)
        expect(
          Result.isFailure(
            yield* owned(setup.controls.inspect(), "fixture-owner", { [GUEST_REQUEST_HEADER]: "1" }).pipe(
              Effect.result,
            ),
          ),
        ).toBe(true)
        const read = yield* owned(setup.controls.inspect())
        const direct = yield* owned(
          setup.memory.configure(setup.place, { expected: read.state.generation, enabled: true }),
        )
        expect(direct).toEqual({ ok: false, reason: "authority-unavailable" })
        const forged = yield* owned(
          prepare(setup, { action: "configure", expected: read.state.generation, enabled: true, owner: true }),
        ).pipe(Effect.result)
        expect(Result.isFailure(forged) && forged.failure.code).toBe("invalid")
        const preview = yield* owned(
          prepare(setup, { action: "configure", expected: read.state.generation, enabled: true }),
        )
        const denied = yield* owned(setup.controls.confirm(confirmation(preview)), "another-owner").pipe(Effect.result)
        expect(Result.isFailure(denied) && denied.failure.code).toBe("unavailable")
        expect((yield* owned(setup.controls.inspect())).state.enabled).toBe(false)
        yield* owned(setup.controls.confirm(confirmation(preview)))
        expect((yield* owned(setup.controls.inspect())).state.enabled).toBe(true)
      }),
    )
  })

  test("preparation makes no mutation; concurrent exact confirmations consume one preview once", async () => {
    await run((setup) =>
      owned(
        Effect.gen(function* () {
          const before = yield* setup.controls.inspect()
          const preview = yield* prepare(setup, {
            action: "configure",
            expected: before.state.generation,
            enabled: true,
          })
          expect(preview.payload).toEqual({ expected: before.state.generation, enabled: true })
          expect(Object.isFrozen(preview)).toBe(true)
          expect(Object.isFrozen(preview.payload)).toBe(true)
          expect((yield* setup.controls.inspect()).state).toEqual(before.state)
          const confirmations = yield* Effect.all(
            [
              setup.controls.confirm(confirmation(preview)).pipe(Effect.result),
              setup.controls.confirm(confirmation(preview)).pipe(Effect.result),
            ],
            { concurrency: "unbounded" },
          )
          expect(confirmations.filter(Result.isSuccess)).toHaveLength(1)
          expect(confirmations.filter(Result.isFailure)).toHaveLength(1)
          const after = yield* setup.controls.inspect()
          expect(after.state.enabled).toBe(true)
          expect(after.state.generation).toBe(before.state.generation + 1)
          const replay = yield* setup.controls.confirm(confirmation(preview)).pipe(Effect.result)
          expect(Result.isFailure(replay) && replay.failure.code).toBe("used")
          expect((yield* setup.controls.inspect()).state.generation).toBe(after.state.generation)
        }),
      ),
    )
  })

  test("explicit preference, forget, disable and erase controls retain exact generations and never accept owner-created outcomes", async () => {
    await run((setup) =>
      owned(
        Effect.gen(function* () {
          yield* enable(setup)
          let read = yield* setup.controls.inspect()
          const preview = yield* prepare(setup, preference(read.state.generation))
          const entry = yield* setup.controls.confirm(confirmation(preview))
          expect(entry).toMatchObject({ kind: "preference", status: "active", origin: "owner" })
          read = yield* setup.controls.inspect()
          expect(read.state.entries).toHaveLength(1)
          const invalid = yield* prepare(setup, { ...preference(read.state.generation), kind: "outcome" }).pipe(
            Effect.result,
          )
          expect(Result.isFailure(invalid) && invalid.failure.code).toBe("invalid")
          const forget = yield* prepare(setup, {
            action: "forget",
            expected: read.state.generation,
            id: read.state.entries[0]!.id,
          })
          yield* setup.controls.confirm(confirmation(forget))
          read = yield* setup.controls.inspect()
          expect(read.state.entries).toEqual([])
          const disable = yield* prepare(setup, {
            action: "configure",
            expected: read.state.generation,
            enabled: false,
          })
          yield* setup.controls.confirm(confirmation(disable))
          read = yield* setup.controls.inspect()
          expect(read.state.enabled).toBe(false)
          const erase = yield* prepare(setup, { action: "erase", expected: read.state.generation })
          yield* setup.controls.confirm(confirmation(erase))
          expect((yield* setup.controls.inspect()).state.enabled).toBe(false)
        }),
      ),
    )
  })

  test("proposal confirmation binds the full immutable preview and retires an observed payload mismatch", async () => {
    await run((setup) =>
      owned(
        Effect.gen(function* () {
          yield* enable(setup)
          yield* setup.admitSource()
          let read = yield* setup.controls.inspect()
          const proposal = value(
            yield* setup.memory.propose(setup.place, {
              expected: read.state.generation,
              source,
              kind: "outcome",
              text: "A guarded lookup avoided an invalid read.",
              paths: ["src/a.ts"],
              citations: [{ path: "src/a.ts", line: 1, head: source.head, quote: "return []" }],
              reason: "Pending feedback only",
              visibility: "repository",
            }),
          )
          read = yield* setup.controls.inspect()
          const preview = yield* prepare(setup, {
            action: "approve",
            expected: read.state.generation,
            id: proposal.id,
          })
          if (preview.operation !== "approve") throw new Error("Expected a full proposal approval preview")
          expect(preview.payload).toEqual({
            expected: read.state.generation,
            id: proposal.id,
            entry: Schema.decodeUnknownSync(ReviewMemoryControl.ProposedEntry)(proposal),
          })
          expect(Object.isFrozen(preview.payload)).toBe(true)
          yield* setup.brain
            .update(BrainReviewMemoryTable)
            .set({ body: "Changed while the human read the preview" })
            .where(eq(BrainReviewMemoryTable.id, proposal.id))
            .run()
          const stale = yield* setup.controls.confirm(confirmation(preview)).pipe(Effect.result)
          expect(Result.isFailure(stale) && stale.failure.code).toBe("stale")
          expect((yield* setup.controls.inspect()).state.entries[0]!.status).toBe("proposed")
          yield* setup.brain
            .update(BrainReviewMemoryTable)
            .set({ body: proposal.text })
            .where(eq(BrainReviewMemoryTable.id, proposal.id))
            .run()
          const retired = yield* setup.controls.confirm(confirmation(preview)).pipe(Effect.result)
          expect(Result.isFailure(retired) && retired.failure.code).toBe("used")
          const fresh = yield* prepare(setup, {
            action: "approve",
            expected: read.state.generation,
            id: proposal.id,
          })
          yield* setup.controls.confirm(confirmation(fresh))
          expect((yield* setup.controls.inspect()).state.entries[0]!).toMatchObject({ status: "active", source })
        }),
      ),
    )
  })

  test("human previews hold no lifecycle/SQL lock and a source deleted before confirmation cannot activate its proposal", async () => {
    await run((setup) =>
      owned(
        Effect.gen(function* () {
          yield* enable(setup)
          yield* setup.admitSource()
          let read = yield* setup.controls.inspect()
          const proposal = value(
            yield* setup.memory.propose(setup.place, {
              expected: read.state.generation,
              source,
              kind: "outcome",
              text: "Pending review feedback",
              paths: ["src/a.ts"],
              citations: [{ path: "src/a.ts", line: 1, head: source.head, quote: "return []" }],
              reason: "Requires human approval",
              visibility: "repository",
            }),
          )
          read = yield* setup.controls.inspect()
          const preview = yield* prepare(setup, {
            action: "approve",
            expected: read.state.generation,
            id: proposal.id,
          })
          yield* setup.lifecycle.deleting(
            parentID,
            setup.db.delete(SessionTable).where(eq(SessionTable.id, parentID)).run(),
          )
          const result = yield* setup.controls.confirm(confirmation(preview)).pipe(Effect.result)
          expect(Result.isFailure(result)).toBe(true)
          expect(
            (yield* setup.brain.select().from(BrainReviewMemoryTable).all()).some((row) => row.id === proposal.id),
          ).toBe(false)
        }),
      ),
    )
  })

  test("a legacy marker deletion reaches the actual saved Main proof without lazy registration or generation churn", async () => {
    await run((setup) =>
      owned(
        Effect.gen(function* () {
          yield* enable(setup)
          yield* setup.admitSource()
          const before = value(yield* setup.memory.context(setup.place, { source, files: ["src/a.ts"] }))
          expect(value(yield* setup.memory.current(setup.place, { source, generation: before.generation }))).toBe(true)
          const snapshot = yield* ReviewRequestStore.make(setup.db).sourceSnapshot(parentID, reviewID)
          const pair = snapshot?.sourceBinding?.witnesses
          if (!pair) throw new Error("Missing genuine saved Main witnesses")
          // The relevant old ordinary erase operation, with no new review erasure hook.
          yield* setup.brain.delete(BrainEntryTable).where(eq(BrainEntryTable.id, pair.parent)).run()
          expect(yield* setup.memory.current(setup.place, { source, generation: before.generation })).toEqual({
            ok: false,
            reason: "source-unavailable",
          })
          const after = yield* setup.controls.inspect()
          expect(after.state.generation).toBeGreaterThan(before.generation)
          expect((yield* setup.brain.select().from(BrainReviewMemorySourceTable))[0].state).toBe("retired")
          expect(yield* setup.memory.context(setup.place, { source, files: ["src/a.ts"] })).toEqual({
            ok: false,
            reason: "source-unavailable",
          })
          expect((yield* setup.controls.inspect()).state.generation).toBe(after.state.generation)
          expect(
            (yield* ReviewRequestStore.make(setup.db).sourceSnapshot(parentID, reviewID))?.sourceBinding?.witnesses,
          ).toEqual(pair)
          expect(yield* setup.brain.select().from(BrainEntryTable).where(eq(BrainEntryTable.id, pair.parent))).toEqual(
            [],
          )
        }),
      ),
    )
  })

  test("zero-row source deletion discovers the old registered repository after the Main project metadata moves", async () => {
    await run((setup) =>
      owned(
        Effect.gen(function* () {
          yield* enable(setup)
          yield* setup.admitSource()
          expect(yield* setup.brain.select().from(BrainReviewMemoryTable)).toEqual([])
          expect(yield* setup.brain.select().from(BrainEntryTable)).toHaveLength(2)
          // Persisted legacy placement changed; the genuine closing session is in
          // the new project, while its zero-content source ledger retains the old one.
          const moved = Project.ID.make("moved-memory-fixture")
          yield* setup.db.run(
            sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES (${moved}, ${setup.instance.directory}, '[]', 1, 1)`,
          )
          yield* setup.db.update(SessionTable).set({ project_id: moved }).where(eq(SessionTable.id, parentID)).run()
          yield* setup.lifecycle.deleting(
            parentID,
            setup.db.delete(SessionTable).where(eq(SessionTable.id, parentID)).run(),
          )
          expect(yield* setup.brain.select().from(BrainEntryTable)).toEqual([])
          expect((yield* setup.brain.select().from(BrainReviewMemorySourceTable))[0]).toMatchObject({
            repository_id: repository,
            state: "retired",
          })
          expect(yield* setup.db.select().from(SessionTable).where(eq(SessionTable.id, parentID)).get()).toBeUndefined()
        }),
      ),
    )
  })

  test("the combined content and zero-row source repository cap refuses before any Brain mutation", async () => {
    await run((setup) =>
      owned(
        Effect.gen(function* () {
          yield* enable(setup)
          yield* setup.admitSource()
          // Coherent empty namespaces avoid a false pass from unrelated corrupt
          // scope validation. Each query remains<=200; their union with the genuine
          // source is201, so only the combined authority bound should refuse.
          yield* setup.brain.transaction((tx) =>
            Effect.gen(function* () {
              for (let index = 0; index < 200; index++) {
                const selected = `overflow_repo_${index}`
                const scope = `overflow_scope_${index}`
                yield* ReviewStore.register(tx, selected, scope)
                if (index < 100)
                  yield* tx
                    .insert(BrainReviewMemoryTable)
                    .values({
                      id: `overflow_content_${index}`,
                      repository_id: selected,
                      scope_id: scope,
                      kind: "outcome",
                      status: "proposed",
                      visibility: "repository",
                      body: "Retained fixture excerpt",
                      paths: ["src/a.ts"],
                      citations: [],
                      reason: "Legacy provenance fixture",
                      parent_session_id: parentID,
                      review_session_id: `ses_overflow_content_${index}`,
                      source_head: source.head,
                      origin: "review",
                      created_at: 1,
                      updated_at: 1,
                    })
                    .run()
                if (index >= 100)
                  yield* tx
                    .insert(BrainReviewMemorySourceTable)
                    .values({
                      repository_id: selected,
                      scope_id: scope,
                      parent_session_id: parentID,
                      review_session_id: `ses_overflow_source_${index}`,
                      source_head: source.head,
                      parent_marker_id: `vrw1_${(index * 2).toString(16).padStart(32, "0")}`,
                      review_marker_id: `vrw1_${(index * 2 + 1).toString(16).padStart(32, "0")}`,
                      state: "retired",
                    })
                    .run()
              }
            }),
          )
          const snapshot = () =>
            Effect.gen(function* () {
              const tables = yield* setup.brain.all<{ name: string }>(
                sql`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
              )
              return yield* Effect.forEach(tables, (table) =>
                setup.brain
                  .all(sql`SELECT * FROM ${sql.identifier(table.name)}`)
                  .pipe(
                    Effect.map((rows) => ({ table: table.name, rows: rows.map((row) => JSON.stringify(row)).sort() })),
                  ),
              )
            })
          const before = yield* snapshot()
          const result = yield* setup.lifecycle
            .deleting(parentID, setup.db.delete(SessionTable).where(eq(SessionTable.id, parentID)).run())
            .pipe(Effect.result)
          expect(Result.isFailure(result)).toBe(true)
          expect(yield* snapshot()).toEqual(before)
          expect((yield* setup.db.select().from(SessionTable).where(eq(SessionTable.id, parentID)).get())?.id).toBe(
            parentID,
          )
        }),
      ),
    )
  })

  test("expiry, digest mismatch and observed directory/trust changes retire confirmation without writing", async () => {
    await run((setup) =>
      owned(
        Effect.gen(function* () {
          const read = yield* setup.controls.inspect()
          const command = { action: "configure", expected: read.state.generation, enabled: true }
          const expired = yield* prepare(setup, command)
          setup.clock.value += ReviewMemoryOwner.LIMIT.ttl + 1
          const timeout = yield* setup.controls.confirm(confirmation(expired)).pipe(Effect.result)
          expect(Result.isFailure(timeout) && timeout.failure.code).toBe("expired")
          const wrong = yield* prepare(setup, command)
          const mismatch = yield* setup.controls
            .confirm({ ...confirmation(wrong), approvedSha256: "0".repeat(64) })
            .pipe(Effect.result)
          expect(Result.isFailure(mismatch) && mismatch.failure.code).toBe("stale")
          expect(Result.isFailure(yield* setup.controls.confirm(confirmation(wrong)).pipe(Effect.result))).toBe(true)
          const changed = yield* prepare(setup, command)
          setup.trust.fingerprint = "changed"
          const stale = yield* setup.controls.confirm(confirmation(changed)).pipe(Effect.result)
          expect(Result.isFailure(stale) && stale.failure.code).toBe("stale")
          setup.trust.fingerprint = "fixture"
          expect(Result.isFailure(yield* setup.controls.confirm(confirmation(changed)).pipe(Effect.result))).toBe(true)
          const moved = yield* prepare(setup, command)
          const nested = path.join(setup.instance.directory, "nested")
          yield* Effect.promise(() => fs.mkdir(nested))
          const other = { ...setup.instance, directory: nested }
          const movedResult = yield* setup.controls
            .confirm(confirmation(moved))
            .pipe(Effect.provideService(InstanceRef, other), Effect.result)
          expect(Result.isFailure(movedResult) && movedResult.failure.code).toBe("stale")
          expect(Result.isFailure(yield* setup.controls.confirm(confirmation(moved)).pipe(Effect.result))).toBe(true)
          expect((yield* setup.controls.inspect()).state.enabled).toBe(false)
        }),
      ),
    )
  })

  test("parallel preparations respect the bounded capacity and expired previews release it without a mutation", async () => {
    await run((setup) =>
      owned(
        Effect.gen(function* () {
          const read = yield* setup.controls.inspect()
          const results = yield* Effect.all(
            Array.from({ length: ReviewMemoryOwner.LIMIT.scope + 4 }, () =>
              prepare(setup, { action: "configure", expected: read.state.generation, enabled: true }).pipe(
                Effect.result,
              ),
            ),
            { concurrency: "unbounded" },
          )
          expect(results.filter(Result.isSuccess)).toHaveLength(ReviewMemoryOwner.LIMIT.scope)
          expect(results.filter(Result.isFailure)).toHaveLength(4)
          expect((yield* setup.controls.inspect()).state.enabled).toBe(false)
          setup.clock.value += ReviewMemoryOwner.LIMIT.ttl + 1
          expect(
            yield* prepare(setup, { action: "configure", expected: read.state.generation, enabled: true }),
          ).toMatchObject({ operation: "configure" })
          expect((yield* setup.controls.inspect()).state.enabled).toBe(false)
        }),
      ),
    )
  })
})
