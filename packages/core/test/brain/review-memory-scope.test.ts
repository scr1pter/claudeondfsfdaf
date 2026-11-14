import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { createHash } from "node:crypto"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@vectordevai/effect-drizzle-sqlite"
import { mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { and, eq, sql } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import { Brain } from "../../src/brain/brain"
import { BrainDatabase } from "../../src/brain/database"
import reviewMemory from "../../src/brain/migration/20261213000000_review_memory"
import reviewMemoryScope from "../../src/brain/migration/20261214000000_review_memory_scope"
import { DatabaseMigration } from "../../src/database/migration"
import { ReviewMemory } from "../../src/brain/review-memory"
import { ReviewWitness } from "../../src/brain/review-witness"
import { ReviewStore } from "../../src/brain/review-store"
import {
  BrainEntryTable,
  BrainEventTable,
  BrainReviewMemoryScopeStateTable,
  BrainReviewMemoryStateTable,
  BrainReviewMemoryTable,
  BrainTombstoneTable,
} from "../../src/brain/sql"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { Global } from "../../src/global"
import { Project } from "../../src/project"
import { ReadOnlyGit } from "../../src/read-only-git"
import { AbsolutePath } from "../../src/schema"
import { tmpdir } from "../fixture/tmpdir"

// Safe Git metadata has no qualified pinned-directory adapter on other hosts; portable storage cases also run in review-memory.test.ts.
const gitTest = test.skipIf(process.platform !== "linux")

const draft: ReviewMemory.Draft = {
  kind: "preference",
  text: "Prefer an explicit return before a lookup.",
  paths: ["src/*"],
  citations: [],
  reason: "An explicit owner preference.",
  visibility: "repository",
}
// Fixed private test authority only; production IDs come from the winning Main INSERT, not request JSON.
const witness = (request: ReviewMemory.Source & { repository: string; scope: string }): ReviewWitness.Proof => ({
  ...request,
  witnesses: {
    version: 1,
    parent: `vrw1_${createHash("sha256")
      .update(
        JSON.stringify([request.repository, request.scope, request.parentID, request.reviewID, request.head, "parent"]),
      )
      .digest("hex")
      .slice(0, 32)}`,
    review: `vrw1_${createHash("sha256")
      .update(
        JSON.stringify([request.repository, request.scope, request.parentID, request.reviewID, request.head, "review"]),
      )
      .digest("hex")
      .slice(0, 32)}`,
  },
})
function value<A>(result: ReviewMemory.Result<A>): A {
  if (!result.ok) throw new Error(result.reason)
  return result.value
}
async function initialize(directory: string) {
  await $`git init`.cwd(directory).quiet()
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email fixture@vector.test`.cwd(directory).quiet()
  await $`git config user.name Fixture`.cwd(directory).quiet()
  await $`git commit --allow-empty -m root`.cwd(directory).quiet()
}
// This fixture supplies a trusted policy port to exercise real Core storage. The production Engine's safe Git
// derivation, current source/lifecycle checks and human authentication/consent require their separate tests.
async function physical(directory: string) {
  const project = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* Project.Service
      return yield* service.resolve(AbsolutePath.make(directory))
    }).pipe(Effect.provide(AppNodeBuilder.build(Project.node))),
  )
  const metadata = await ReadOnlyGit.metadataHead(project.directory)
  const identity = await stat(metadata.commonDirectory, { bigint: true })
  const scope = createHash("sha256")
    .update(JSON.stringify([metadata.commonDirectory, identity.dev.toString(), identity.ino.toString()]))
    .digest("hex")
  return {
    place: {
      repository: project.id,
      scope,
      root: project.directory,
      sources: [],
      held: false,
    } satisfies ReviewMemory.Place,
    source: { parentID: `parent_${scope}`, reviewID: `review_${scope}`, head: metadata.head },
    common: metadata.commonDirectory,
  }
}
type Physical = Awaited<ReturnType<typeof physical>>
type Setup = {
  brain: Brain.Interface
  memory: ReviewMemory.Interface
  db: BrainDatabase.Database
  selected: { value: Physical }
  calls: ReviewMemory.OwnerRequest[]
  registrations: Set<string>
}
async function open<A>(selected: Physical, body: (setup: Setup) => Effect.Effect<A, unknown>) {
  await using directory = await tmpdir()
  const current = { value: selected }
  const calls: ReviewMemory.OwnerRequest[] = []
  const authority: ReviewMemory.Authority = {
    owner: (request, use) => {
      calls.push(request)
      return request.repository === current.value.place.repository && request.scope === current.value.place.scope
        ? use("fixture_owner")
        : Effect.succeed({ ok: false, reason: "authority-unavailable" })
    },
    source: (request, use) =>
      request.repository === current.value.place.repository &&
      request.scope === current.value.place.scope &&
      request.parentID === current.value.source.parentID &&
      request.reviewID === current.value.source.reviewID &&
      request.head === current.value.source.head
        ? use(witness(request))
        : Effect.succeed({ ok: false, reason: "source-unavailable" }),
  }
  const layer = Layer.mergeAll(Brain.layer, ReviewMemory.layerWith(authority)).pipe(
    Layer.provideMerge(BrainDatabase.layerFor(":memory:")),
    Layer.provide(
      Layer.succeed(
        Global.Service,
        Global.make({ config: path.join(directory.path, "config"), data: path.join(directory.path, "data") }),
      ),
    ),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* body({
        brain: yield* Brain.Service,
        memory: yield* ReviewMemory.Service,
        db: (yield* BrainDatabase.Service).db,
        selected: current,
        calls,
        registrations: new Set(),
      })
    }).pipe(Effect.provide(layer)),
  )
}
const enable = (setup: Setup, target: Physical) =>
  Effect.gen(function* () {
    setup.selected.value = target
    const state = value(yield* setup.memory.inspect(target.place))
    const enabled = value(yield* setup.memory.configure(target.place, { expected: state.generation, enabled: true }))
    const proof = witness({ repository: target.place.repository, scope: target.place.scope, ...target.source })
    const key = JSON.stringify(proof)
    if (!setup.registrations.has(key)) {
      setup.registrations.add(key)
      expect(yield* ReviewStore.registerSource(setup.db, proof)).toBe(true)
    }
    return enabled
  })
const snapshot = (setup: Setup) =>
  Effect.gen(function* () {
    return {
      entries: yield* setup.db.select().from(BrainReviewMemoryTable).orderBy(BrainReviewMemoryTable.id),
      scopes: yield* setup.db
        .select()
        .from(BrainReviewMemoryScopeStateTable)
        .orderBy(BrainReviewMemoryScopeStateTable.scope_id),
      epochs: yield* setup.db
        .select()
        .from(BrainReviewMemoryStateTable)
        .orderBy(BrainReviewMemoryStateTable.repository_id),
      witnesses: yield* setup.db.select().from(BrainTombstoneTable).orderBy(BrainTombstoneTable.norm_hash),
      ordinary: yield* setup.db.select().from(BrainEntryTable),
      audit: yield* setup.db.select().from(BrainEventTable),
    }
  })

async function repositories(kind: "remote" | "root") {
  const directory = await tmpdir()
  const a = path.join(directory.path, "a")
  const b = path.join(directory.path, "b")
  await mkdir(a)
  await initialize(a)
  if (kind === "root") await $`git clone --no-local ${a} ${b}`.quiet()
  if (kind === "remote") {
    await mkdir(b)
    await initialize(b)
    await $`git remote add origin https://example.invalid/team/shared.git`.cwd(a).quiet()
    await $`git remote add origin git@example.invalid:team/shared.git`.cwd(b).quiet()
  }
  const first = await physical(a)
  const second = await physical(b)
  expect(first.place.repository).toBe(second.place.repository)
  expect(first.common).not.toBe(second.common)
  expect(first.place.scope).not.toBe(second.place.scope)
  return {
    directory,
    a: first,
    b: second,
    async [Symbol.asyncDispose]() {
      await directory[Symbol.asyncDispose]()
    },
  }
}

describe("review memory physical repository namespaces", () => {
  test("the actual additive migration preserves old bytes and epochs without assigning any physical scope", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* DatabaseMigration.applyOnly(db, [reviewMemory])
        yield* db.run(sql`INSERT INTO brain_review_memory
          (id, repository_id, kind, status, visibility, body, paths, citations, reason, origin, approved_by, approved_at, created_at, updated_at)
          VALUES ('legacy', 'same-project', 'preference', 'active', 'repository', 'Legacy owner preference', '[]', '[]', 'Legacy approval', 'owner', 'owner_1', 1, 1, 1)`)
        yield* db.run(sql`INSERT INTO brain_review_memory_state VALUES ('', 0, 4), ('same-project', 1, 9)`)
        const before = yield* db.all(sql`SELECT * FROM brain_review_memory`)
        const epochs = yield* db.all(sql`SELECT * FROM brain_review_memory_state ORDER BY repository_id`)
        yield* DatabaseMigration.applyOnly(db, [reviewMemory, reviewMemoryScope])
        expect(yield* db.all(sql`SELECT * FROM brain_review_memory_state ORDER BY repository_id`)).toEqual(epochs)
        expect(yield* db.all(sql`SELECT * FROM brain_review_memory_scope_state`)).toEqual([])
        expect(yield* db.all(sql`SELECT * FROM brain_review_memory`)).toEqual(
          before.map((row) => {
            if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Invalid legacy SQL row")
            return { ...row, scope_id: null }
          }),
        )
        yield* DatabaseMigration.applyOnly(db, [reviewMemory, reviewMemoryScope])
        expect(yield* db.all(sql`SELECT * FROM brain_review_memory_scope_state`)).toEqual([])
        expect(yield* db.all(sql`SELECT * FROM brain_review_memory_state ORDER BY repository_id`)).toEqual(epochs)
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped),
    )
  })
  for (const kind of ["remote", "root"] as const)
    gitTest(
      `independent actual repositories sharing ${kind} identity never inherit consent or owner content`,
      async () => {
        await using repos = await repositories(kind)
        await open(repos.a, (setup) =>
          Effect.gen(function* () {
            const state = yield* enable(setup, repos.a)
            const shared = value(yield* setup.memory.record(repos.a.place, { ...draft, expected: state.generation }))
            const next = value(yield* setup.memory.inspect(repos.a.place))
            const privateEntry = value(
              yield* setup.memory.record(repos.a.place, { ...draft, visibility: "private", expected: next.generation }),
            )
            const a = value(yield* setup.memory.context(repos.a.place, { source: repos.a.source, files: ["src/a.ts"] }))
            expect(a.entries.map((entry) => entry.id)).toEqual([shared.id])
            const before = yield* snapshot(setup)
            setup.selected.value = repos.b
            expect(value(yield* setup.memory.inspect(repos.b.place))).toEqual({
              enabled: false,
              generation: 0,
              entries: [],
            })
            expect(yield* setup.memory.context(repos.b.place, { source: repos.b.source, files: ["src/a.ts"] })).toEqual(
              { ok: false, reason: "source-unavailable" },
            )
            expect(
              yield* setup.memory.current(repos.b.place, { source: repos.b.source, generation: a.generation }),
            ).toEqual({ ok: false, reason: "source-unavailable" })
            const after = yield* snapshot(setup)
            expect(after.entries).toEqual(before.entries)
            expect(after.epochs).toEqual(before.epochs)
            expect(after.audit).toEqual(before.audit)
            expect(after.ordinary).toEqual(before.ordinary)
            for (const witness of before.witnesses) expect(after.witnesses).toContainEqual(witness)
            expect(after.scopes.find((row) => row.scope_id === repos.a.place.scope)).toEqual(before.scopes[0])
            expect(after.entries.map((row) => row.id).toSorted()).toEqual([shared.id, privateEntry.id].toSorted())
            expect(setup.calls.every((call) => call.repository === repos.a.place.repository)).toBe(true)
            expect(new Set(setup.calls.map((call) => call.scope))).toEqual(
              new Set([repos.a.place.scope, repos.b.place.scope]),
            )
            const inspected = setup.calls.filter((call) => call.operation === "inspect")
            expect(inspected.find((call) => call.scope === repos.a.place.scope)?.digest).not.toBe(
              inspected.find((call) => call.scope === repos.b.place.scope)?.digest,
            )
          }),
        )
      },
    )

  gitTest(
    "registered worktrees and subdirectories of the same actual Git common store share the accepted namespace",
    async () => {
      await using repos = await repositories("remote")
      const linked = path.join(repos.directory.path, "linked")
      await $`git worktree add -b memory-linked ${linked}`.cwd(repos.a.place.root).quiet()
      await mkdir(path.join(linked, "src"))
      const worktree = await physical(linked)
      const subdirectory = await physical(path.join(linked, "src"))
      expect(worktree.place.scope).toBe(repos.a.place.scope)
      expect(subdirectory.place.scope).toBe(repos.a.place.scope)
      expect(worktree.place.root).not.toBe(repos.a.place.root)
      await open(repos.a, (setup) =>
        Effect.gen(function* () {
          const state = yield* enable(setup, repos.a)
          const entry = value(yield* setup.memory.record(repos.a.place, { ...draft, expected: state.generation }))
          for (const selected of [worktree, subdirectory]) {
            setup.selected.value = selected
            expect(value(yield* setup.memory.inspect(selected.place)).enabled).toBe(true)
            expect(
              value(
                yield* setup.memory.context(selected.place, { source: selected.source, files: ["src/a.ts"] }),
              ).entries.map((item) => item.id),
            ).toEqual([entry.id])
          }
        }),
      )
    },
  )

  gitTest(
    "missing or malformed scope refuses before authority; forged valid scope cannot select a foreign physical namespace",
    async () => {
      await using repos = await repositories("remote")
      await open(repos.a, (setup) =>
        Effect.gen(function* () {
          yield* enable(setup, repos.a)
          const before = yield* snapshot(setup)
          const missing = { ...repos.a.place }
          Reflect.deleteProperty(missing, "scope")
          const calls = setup.calls.length
          for (const place of [missing, { ...repos.a.place, scope: "../a" }, { ...repos.a.place, scope: "" }])
            expect(yield* setup.memory.inspect(place)).toEqual({ ok: false, reason: "invalid" })
          expect(setup.calls).toHaveLength(calls)
          setup.selected.value = repos.b
          const forged = { ...repos.b.place, scope: repos.a.place.scope }
          expect(yield* setup.memory.inspect(forged)).toEqual({ ok: false, reason: "authority-unavailable" })
          expect(yield* setup.memory.context(forged, { source: repos.b.source, files: ["src/a.ts"] })).toEqual({
            ok: false,
            reason: "source-unavailable",
          })
          expect(yield* snapshot(setup)).toEqual(before)
        }),
      )
    },
  )

  gitTest("legacy unbound rows stay invisible and are never adopted by the first clone to inspect", async () => {
    await using repos = await repositories("remote")
    await open(repos.a, (setup) =>
      Effect.gen(function* () {
        const state = yield* enable(setup, repos.a)
        value(yield* setup.memory.record(repos.a.place, { ...draft, expected: state.generation }))
        const original = (yield* setup.db.select().from(BrainReviewMemoryTable))[0]
        yield* setup.db
          .insert(BrainReviewMemoryTable)
          .values({ ...original, id: "legacy_unbound", scope_id: null })
          .run()
        setup.selected.value = repos.b
        expect(value(yield* setup.memory.inspect(repos.b.place)).entries).toEqual([])
        setup.selected.value = repos.a
        expect(value(yield* setup.memory.inspect(repos.a.place)).entries.map((entry) => entry.id)).toEqual([
          original.id,
        ])
        expect(
          (yield* setup.db
            .select()
            .from(BrainReviewMemoryTable)
            .where(eq(BrainReviewMemoryTable.id, "legacy_unbound")))[0].scope_id,
        ).toBeNull()
        expect(yield* setup.brain.erase(repos.a.place, "repository")).toBe(4)
        expect(yield* setup.db.select().from(BrainReviewMemoryTable)).toEqual([])
        expect((yield* setup.db.select().from(BrainReviewMemoryScopeStateTable)).every((row) => !row.enabled)).toBe(
          true,
        )
      }),
    )
  })

  for (const mode of ["namespace", "repository", "all", "older-repository", "older-all", "scope-witness"] as const)
    gitTest(`${mode} erasure has the intended physical boundary and retains monotonic private epochs`, async () => {
      await using repos = await repositories("remote")
      await open(repos.a, (setup) =>
        Effect.gen(function* () {
          const a = yield* enable(setup, repos.a)
          value(yield* setup.memory.record(repos.a.place, { ...draft, expected: a.generation }))
          const b = yield* enable(setup, repos.b)
          const second = value(yield* setup.memory.record(repos.b.place, { ...draft, expected: b.generation }))
          const before = yield* snapshot(setup)
          setup.selected.value = repos.a
          const first = value(yield* setup.memory.inspect(repos.a.place))
          if (mode === "namespace") value(yield* setup.memory.erase(repos.a.place, { expected: first.generation }))
          if (mode === "repository" || mode === "all") expect(yield* setup.brain.erase(repos.a.place, mode)).toBe(6)
          if (mode === "older-repository")
            yield* setup.db
              .delete(BrainTombstoneTable)
              .where(eq(BrainTombstoneTable.repository_id, repos.a.place.repository))
              .run()
          if (mode === "older-all") yield* setup.db.delete(BrainTombstoneTable).run()
          if (mode === "scope-witness")
            yield* setup.db
              .delete(BrainTombstoneTable)
              .where(
                and(
                  eq(BrainTombstoneTable.repository_id, repos.a.place.repository),
                  eq(BrainTombstoneTable.norm_hash, `${ReviewStore.SCOPE_MARKER}${repos.a.place.scope}`),
                ),
              )
              .run()
          expect(yield* setup.memory.context(repos.a.place, { source: repos.a.source, files: ["src/a.ts"] })).toEqual({
            ok: false,
            reason: "source-unavailable",
          })
          setup.selected.value = repos.b
          const other = value(yield* setup.memory.inspect(repos.b.place))
          if (mode === "namespace" || mode === "scope-witness") {
            expect(other.enabled).toBe(true)
            expect(other.entries.map((entry) => entry.id)).toEqual([second.id])
            expect((yield* snapshot(setup)).scopes.find((row) => row.scope_id === repos.b.place.scope)).toEqual(
              before.scopes.find((row) => row.scope_id === repos.b.place.scope),
            )
          } else {
            expect(other.enabled).toBe(false)
            expect(other.entries).toEqual([])
            expect(yield* setup.db.select().from(BrainReviewMemoryTable)).toEqual([])
          }
          expect(
            (yield* setup.db.select().from(BrainReviewMemoryScopeStateTable)).every(
              (row) => row.repository_id === repos.a.place.repository,
            ),
          ).toBe(true)
        }),
      )
    })

  gitTest(
    "session erasure removes all matching scoped provenance before generic deletion, retaining owner and unrelated clone entries",
    async () => {
      await using repos = await repositories("root")
      await open(repos.a, (setup) =>
        Effect.gen(function* () {
          const a = yield* enable(setup, repos.a)
          const owner = value(yield* setup.memory.record(repos.a.place, { ...draft, expected: a.generation }))
          const current = value(yield* setup.memory.inspect(repos.a.place))
          const feedback = {
            ...draft,
            kind: "outcome" as const,
            paths: ["src/a.ts"],
            citations: [{ path: "src/a.ts", line: 1, head: repos.a.source.head, quote: "return []" }],
          }
          value(
            yield* setup.memory.propose(repos.a.place, {
              ...feedback,
              source: repos.a.source,
              expected: current.generation,
            }),
          )
          const b = yield* enable(setup, repos.b)
          const foreign = value(yield* setup.memory.record(repos.b.place, { ...draft, expected: b.generation }))
          expect(yield* setup.brain.eraseSession(repos.a.place, repos.a.source.reviewID)).toBe(1)
          expect((yield* setup.db.select().from(BrainReviewMemoryTable)).map((row) => row.id).toSorted()).toEqual(
            [owner.id, foreign.id].toSorted(),
          )
        }),
      )
    },
  )

  gitTest(
    "invalid, missing or expired physical-scope components cannot mutate any scope during repository/session erase",
    async () => {
      await using repos = await repositories("remote")
      for (const mode of ["negative", "fractional", "missing", "witness"] as const)
        await open(repos.a, (setup) =>
          Effect.gen(function* () {
            const a = yield* enable(setup, repos.a)
            value(yield* setup.memory.record(repos.a.place, { ...draft, expected: a.generation }))
            const b = yield* enable(setup, repos.b)
            value(yield* setup.memory.record(repos.b.place, { ...draft, expected: b.generation }))
            const target = and(
              eq(BrainReviewMemoryScopeStateTable.repository_id, repos.b.place.repository),
              eq(BrainReviewMemoryScopeStateTable.scope_id, repos.b.place.scope),
            )
            if (mode === "negative" || mode === "fractional")
              yield* setup.db
                .update(BrainReviewMemoryScopeStateTable)
                .set({ generation: mode === "negative" ? -1 : 0.5 })
                .where(target)
                .run()
            if (mode === "missing") yield* setup.db.delete(BrainReviewMemoryScopeStateTable).where(target).run()
            if (mode === "witness")
              yield* setup.db.run(
                sql`UPDATE brain_tombstone SET until = 0 WHERE norm_hash = ${`${ReviewStore.SCOPE_MARKER}${repos.b.place.scope}`}`,
              )
            const before = yield* snapshot(setup)
            expect(
              Exit.isFailure(yield* Effect.exit(setup.brain.eraseSession(repos.a.place, repos.a.source.reviewID))),
            ).toBe(true)
            expect(yield* snapshot(setup)).toEqual(before)
            expect(Exit.isFailure(yield* Effect.exit(setup.brain.erase(repos.a.place, "repository")))).toBe(true)
            expect(yield* snapshot(setup)).toEqual(before)
          }),
        )
    },
  )
})
