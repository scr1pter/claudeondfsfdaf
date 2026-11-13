import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { and, eq, sql } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import { Brain } from "../../src/brain/brain"
import { BrainDatabase } from "../../src/brain/database"
import { BrainRevocation } from "../../src/brain/revocation"
import { ReviewMemory } from "../../src/brain/review-memory"
import { ReviewWitness } from "../../src/brain/review-witness"
import { ReviewStore } from "../../src/brain/review-store"
import {
  BrainReviewMemoryStateTable,
  BrainReviewMemoryScopeStateTable,
  BrainReviewMemoryTable,
  BrainTombstoneTable,
  BrainEventTable,
  BrainStateTable,
  BrainEntryTable,
  BrainEvidenceTable,
  BrainUseTable,
} from "../../src/brain/sql"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/tmpdir"

const source: ReviewMemory.Source = { parentID: "ses_parent", reviewID: "ses_review", head: "a".repeat(40) }
const draft: ReviewMemory.Draft = {
  kind: "outcome",
  text: "An early return avoids an invalid lookup.",
  reason: "Confirmed for this finding only.",
  paths: ["src/a.ts"],
  citations: [{ path: "src/a.ts", line: 1, head: source.head, quote: "return []" }],
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
type Setup = {
  brain: Brain.Interface
  memory: ReviewMemory.Interface
  db: BrainDatabase.Database
  place: ReviewMemory.Place
}
const authority: ReviewMemory.Authority = {
  owner: (_request, use) => use("owner_1"),
  source: (request, use) =>
    request.parentID === source.parentID && request.reviewID === source.reviewID && request.head === source.head
      ? use(witness(request))
      : Effect.succeed({ ok: false, reason: "source-unavailable" }),
}
async function open<A>(
  directory: string,
  file: string,
  body: (setup: Setup) => Effect.Effect<A, unknown>,
  ports = authority,
) {
  const layer = Layer.mergeAll(Brain.layer, ReviewMemory.layerWith(ports)).pipe(
    Layer.provideMerge(BrainDatabase.layerFor(file).pipe(Layer.fresh)),
    Layer.provide(
      Layer.succeed(
        Global.Service,
        Global.make({ config: path.join(directory, "config"), data: path.join(directory, "data") }),
      ),
    ),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* body({
        brain: yield* Brain.Service,
        memory: yield* ReviewMemory.Service,
        db: (yield* BrainDatabase.Service).db,
        place: { repository: "repo-a", scope: "physical-a", root: directory, sources: [], held: false },
      })
    }).pipe(Effect.provide(layer)),
  )
}
const learn = (setup: Setup) =>
  Effect.gen(function* () {
    const before = value(yield* setup.memory.inspect(setup.place))
    const state = value(yield* setup.memory.configure(setup.place, { expected: before.generation, enabled: true }))
    expect(
      yield* ReviewStore.registerSource(
        setup.db,
        witness({ repository: setup.place.repository, scope: setup.place.scope, ...source }),
      ),
    ).toBe(true)
    const pending = value(yield* setup.memory.propose(setup.place, { ...draft, source, expected: state.generation }))
    const recorded = value(yield* setup.memory.inspect(setup.place))
    value(yield* setup.memory.approve(setup.place, { expected: recorded.generation, id: pending.id }))
    return value(yield* setup.memory.context(setup.place, { source, files: ["src/a.ts"] }))
  })

const genericEntry = (setup: Setup, text: string, origin: "agent" | "user" = "agent", sessionID = source.reviewID) =>
  Effect.gen(function* () {
    const evidence: Brain.Evidence =
      origin === "agent" ? { type: "message", quote: text, verified: true } : { type: "user" }
    const saved = yield* setup.brain.propose(setup.place, {
      kind: "decision",
      origin,
      text,
      scope: "repository",
      sessionID,
      evidence,
    })
    if (saved.type === "refused") return yield* Effect.die(saved.message)
    return saved.entry
  })

describe("review memory erase compatibility and suspended writers, actual SQLite", () => {
  test("session erase validates review epochs and witnesses before any generic entry, evidence, use or audit mutation", async () => {
    for (const mode of ["epoch", "witness"] as const) {
      await using tmp = await tmpdir()
      await open(tmp.path, ":memory:", (setup) =>
        Effect.gen(function* () {
          yield* learn(setup)
          const ordinary = yield* genericEntry(setup, "Prefer early returns before optional lookups.")
          yield* setup.brain.used([ordinary.id], { sessionID: source.reviewID, tier: "review", tokens: 8 })
          expect(
            (yield* setup.db.select().from(BrainEvidenceTable)).some(
              (row) => row.entry_id === ordinary.id && row.session_id === source.reviewID,
            ),
          ).toBe(true)
          expect((yield* setup.db.select().from(BrainUseTable)).some((row) => row.entry_id === ordinary.id)).toBe(true)
          if (mode === "epoch")
            yield* setup.db
              .update(BrainReviewMemoryStateTable)
              .set({ generation: -1 })
              .where(eq(BrainReviewMemoryStateTable.repository_id, ReviewStore.GLOBAL))
              .run()
          if (mode === "witness")
            yield* setup.db
              .update(BrainTombstoneTable)
              .set({ until: 0 })
              .where(eq(BrainTombstoneTable.norm_hash, ReviewStore.MARKER))
              .run()
          const snapshot = () =>
            Effect.gen(function* () {
              return {
                entries: yield* setup.db.select().from(BrainEntryTable),
                evidence: yield* setup.db.select().from(BrainEvidenceTable),
                uses: yield* setup.db.select().from(BrainUseTable),
                audit: yield* setup.db.select().from(BrainEventTable),
                tombstones: yield* setup.db.select().from(BrainTombstoneTable),
                state: yield* setup.db.select().from(BrainStateTable),
                reviews: yield* setup.db.select().from(BrainReviewMemoryTable),
                reviewState: yield* setup.db.select().from(BrainReviewMemoryStateTable),
                reviewScopes: yield* setup.db.select().from(BrainReviewMemoryScopeStateTable),
              }
            })
          const before = yield* snapshot()
          expect(before.entries).toHaveLength(3)
          expect(before.reviews).toHaveLength(1)
          expect(Exit.isFailure(yield* Effect.exit(setup.brain.eraseSession(setup.place, source.reviewID)))).toBe(true)
          expect(yield* snapshot()).toEqual(before)
        }),
      )
    }
  })

  test("successful atomic session forgetting preserves owner-authored and other-session-supported ordinary memory", async () => {
    await using tmp = await tmpdir()
    await open(tmp.path, ":memory:", (setup) =>
      Effect.gen(function* () {
        yield* learn(setup)
        const only = yield* genericEntry(setup, "Prefer early returns before optional lookups.")
        const shared = yield* genericEntry(setup, "Use narrow helper names beside the parsing boundary.")
        const again = yield* genericEntry(setup, shared.text, "agent", "ses_other")
        expect(again.id).toBe(shared.id)
        const owner = yield* genericEntry(setup, "Keep repository review notes local to this workspace.", "user")
        expect(yield* setup.brain.eraseSession(setup.place, source.reviewID)).toBe(2)
        expect((yield* setup.brain.list(setup.place, { filter: "all" })).map((entry) => entry.id).toSorted()).toEqual(
          [shared.id, owner.id].toSorted(),
        )
        expect(yield* setup.db.select().from(BrainReviewMemoryTable)).toEqual([])
        expect((yield* setup.db.select().from(BrainEvidenceTable)).some((row) => row.entry_id === only.id)).toBe(false)
        expect(
          (yield* setup.db.select().from(BrainTombstoneTable)).some(
            (row) => row.norm_hash !== ReviewStore.MARKER && !row.norm_hash.startsWith(ReviewStore.SCOPE_MARKER),
          ),
        ).toBe(true)
      }),
    )
  })

  test("invalid individual epoch components, missing components and malformed witnesses cannot mutate or cancel into valid authority", async () => {
    for (const mode of [
      "negative-global",
      "negative-local",
      "fractional",
      "missing-global",
      "missing-local",
      "bad-enabled",
      "bad-witness",
    ] as const) {
      await using tmp = await tmpdir()
      await open(tmp.path, ":memory:", (setup) =>
        Effect.gen(function* () {
          const before = yield* learn(setup)
          if (mode === "negative-global") {
            yield* setup.db
              .update(BrainReviewMemoryStateTable)
              .set({ generation: 5 })
              .where(eq(BrainReviewMemoryStateTable.repository_id, setup.place.repository))
              .run()
            yield* setup.db
              .update(BrainReviewMemoryStateTable)
              .set({ generation: -1 })
              .where(eq(BrainReviewMemoryStateTable.repository_id, ReviewStore.GLOBAL))
              .run()
          }
          if (mode === "negative-local") {
            yield* setup.db
              .update(BrainReviewMemoryStateTable)
              .set({ generation: -1 })
              .where(eq(BrainReviewMemoryStateTable.repository_id, setup.place.repository))
              .run()
            yield* setup.db
              .update(BrainReviewMemoryStateTable)
              .set({ generation: 5 })
              .where(eq(BrainReviewMemoryStateTable.repository_id, ReviewStore.GLOBAL))
              .run()
          }
          if (mode === "fractional") yield* setup.db.update(BrainReviewMemoryStateTable).set({ generation: 0.5 }).run()
          if (mode === "missing-global")
            yield* setup.db
              .delete(BrainReviewMemoryStateTable)
              .where(eq(BrainReviewMemoryStateTable.repository_id, ReviewStore.GLOBAL))
              .run()
          if (mode === "missing-local")
            yield* setup.db
              .delete(BrainReviewMemoryStateTable)
              .where(eq(BrainReviewMemoryStateTable.repository_id, setup.place.repository))
              .run()
          if (mode === "bad-enabled")
            yield* setup.db.run(
              sql`UPDATE brain_review_memory_state SET enabled = 2 WHERE repository_id = ${setup.place.repository}`,
            )
          if (mode === "bad-witness")
            yield* setup.db
              .update(BrainTombstoneTable)
              .set({ until: 0 })
              .where(eq(BrainTombstoneTable.norm_hash, ReviewStore.MARKER))
              .run()
          const snapshot = () =>
            Effect.gen(function* () {
              return {
                state: yield* setup.db
                  .select({
                    repository: BrainReviewMemoryStateTable.repository_id,
                    generation: sql<unknown>`${BrainReviewMemoryStateTable.generation}`,
                    enabled: sql<unknown>`${BrainReviewMemoryStateTable.enabled}`,
                  })
                  .from(BrainReviewMemoryStateTable)
                  .orderBy(BrainReviewMemoryStateTable.repository_id),
                records: yield* setup.db.select().from(BrainReviewMemoryTable),
                markers: yield* setup.db.select().from(BrainTombstoneTable),
                revocation: yield* setup.db.select().from(BrainStateTable),
                audit: yield* setup.db.select().from(BrainEventTable),
              }
            })
          const corrupted = yield* snapshot()
          const apparentGeneration =
            mode === "negative-global" || mode === "negative-local" ? 4 : mode === "fractional" ? 1 : before.generation
          expect(yield* setup.memory.inspect(setup.place)).toEqual({ ok: false, reason: "stale" })
          expect(yield* setup.memory.context(setup.place, { source, files: ["src/a.ts"] })).toEqual({
            ok: false,
            reason: "stale",
          })
          expect(yield* setup.memory.propose(setup.place, { ...draft, source, expected: apparentGeneration })).toEqual({
            ok: false,
            reason: "stale",
          })
          expect(yield* setup.memory.configure(setup.place, { expected: apparentGeneration, enabled: true })).toEqual({
            ok: false,
            reason: "stale",
          })
          expect(Exit.isFailure(yield* Effect.exit(setup.brain.erase(setup.place, "repository")))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(setup.brain.erase(setup.place, "all")))).toBe(true)
          expect(yield* snapshot()).toEqual(corrupted)
        }),
      )
    }
  })

  test("an empty all-memory erase advances a global review epoch; unsafe counter state refuses without writing", async () => {
    await using tmp = await tmpdir()
    await open(tmp.path, ":memory:", (setup) =>
      Effect.gen(function* () {
        expect(yield* setup.memory.configure(setup.place, { expected: 0, enabled: true })).toEqual({
          ok: false,
          reason: "stale",
        })
        expect(yield* setup.db.select().from(BrainReviewMemoryStateTable)).toEqual([])
        expect(yield* setup.brain.erase(setup.place, "all")).toBe(0)
        expect(yield* setup.db.select().from(BrainReviewMemoryStateTable)).toEqual([
          { repository_id: ReviewStore.GLOBAL, enabled: false, generation: 1 },
        ])
        const initial = value(yield* setup.memory.inspect(setup.place))
        expect(initial).toEqual({ enabled: false, generation: 1, entries: [] })
        expect(yield* setup.memory.configure(setup.place, { expected: 0, enabled: true })).toEqual({
          ok: false,
          reason: "stale",
        })
        expect(
          value(yield* setup.memory.configure(setup.place, { expected: initial.generation, enabled: true })).generation,
        ).toBe(2)
        yield* setup.db
          .update(BrainReviewMemoryStateTable)
          .set({ generation: Number.MAX_SAFE_INTEGER })
          .where(eq(BrainReviewMemoryStateTable.repository_id, ReviewStore.GLOBAL))
          .run()
        const before = yield* setup.db.select().from(BrainReviewMemoryStateTable)
        expect(yield* setup.memory.inspect(setup.place)).toEqual({ ok: false, reason: "stale" })
        expect(yield* setup.memory.propose(setup.place, { ...draft, source, expected: 2 })).toEqual({
          ok: false,
          reason: "stale",
        })
        expect(yield* setup.db.select().from(BrainReviewMemoryStateTable)).toEqual(before)
        expect(yield* setup.db.select().from(BrainReviewMemoryTable)).toEqual([])
      }),
    )
  })

  test("an older repository erase's tombstone deletion is reconciled by a warm reader before any raw record is returned", async () => {
    await using tmp = await tmpdir()
    await open(tmp.path, ":memory:", (setup) =>
      Effect.gen(function* () {
        const before = yield* learn(setup)
        expect(before.entries).toHaveLength(1)
        const marker = yield* setup.db
          .select()
          .from(BrainTombstoneTable)
          .where(
            and(
              eq(BrainTombstoneTable.repository_id, setup.place.repository),
              eq(BrainTombstoneTable.norm_hash, ReviewStore.MARKER),
            ),
          )
        expect(marker[0].until).toBe(ReviewStore.FOREVER)
        const revision = yield* BrainRevocation.revision(setup.db, setup.place.repository)
        // This is the exact relevant SQL operation of an older Brain.erase(repository), not an older binary run.
        yield* setup.db
          .delete(BrainTombstoneTable)
          .where(eq(BrainTombstoneTable.repository_id, setup.place.repository))
          .run()
        expect(yield* setup.db.select().from(BrainReviewMemoryTable)).toHaveLength(1)
        expect(yield* setup.memory.current(setup.place, { source, generation: before.generation })).toEqual({
          ok: false,
          reason: "source-unavailable",
        })
        expect(yield* setup.db.select().from(BrainReviewMemoryTable)).toEqual([])
        const after = value(yield* setup.memory.inspect(setup.place))
        expect(after).toMatchObject({ enabled: false, entries: [] })
        expect(after.generation).toBeGreaterThan(before.generation)
        expect(yield* BrainRevocation.revision(setup.db, setup.place.repository)).toBeGreaterThan(revision)
        expect(yield* setup.memory.propose(setup.place, { ...draft, source, expected: before.generation })).toEqual({
          ok: false,
          reason: "source-unavailable",
        })
        const again = value(yield* setup.memory.inspect(setup.place))
        expect(again.generation).toBe(after.generation)
      }),
    )
  })

  test("persistent disable and an older all-memory erase survive reopening without reactivation or generation ABA", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "brain.db")
    const generation = await open(tmp.path, file, (setup) =>
      Effect.gen(function* () {
        const before = yield* learn(setup)
        value(yield* setup.memory.configure(setup.place, { expected: before.generation, enabled: false }))
        const disabled = value(yield* setup.memory.inspect(setup.place))
        // Older erase(all) removes every tombstone; it cannot see this build's new tables.
        yield* setup.db.delete(BrainTombstoneTable).run()
        return disabled.generation
      }),
    )
    await open(tmp.path, file, (setup) =>
      Effect.gen(function* () {
        const state = value(yield* setup.memory.inspect(setup.place))
        expect(state.enabled).toBe(false)
        expect(state.entries).toEqual([])
        expect(state.generation).toBeGreaterThan(generation)
        expect(yield* setup.db.select().from(BrainReviewMemoryTable)).toEqual([])
        const enabled = value(yield* setup.memory.configure(setup.place, { expected: state.generation, enabled: true }))
        expect(enabled.generation).toBeGreaterThan(state.generation)
        expect(yield* setup.memory.propose(setup.place, { ...draft, source, expected: generation })).toEqual({
          ok: false,
          reason: "source-unavailable",
        })
      }),
    )
  })

  test("current-build eraseSession fences a suspended source callback before its FIRST proposal commits", async () => {
    await using tmp = await tmpdir()
    let release: () => void = () => {}
    let notify: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      notify = resolve
    })
    const ports: ReviewMemory.Authority = {
      ...authority,
      source: (request, use) =>
        Effect.gen(function* () {
          notify()
          yield* Effect.promise(() => gate)
          return yield* use(witness(request))
        }),
    }
    await open(
      tmp.path,
      ":memory:",
      (setup) =>
        Effect.gen(function* () {
          const initial = value(yield* setup.memory.inspect(setup.place))
          const state = value(
            yield* setup.memory.configure(setup.place, { expected: initial.generation, enabled: true }),
          )
          expect(
            yield* ReviewStore.registerSource(
              setup.db,
              witness({ repository: setup.place.repository, scope: setup.place.scope, ...source }),
            ),
          ).toBe(true)
          const pending = Effect.runPromise(
            setup.memory.propose(setup.place, { ...draft, source, expected: state.generation }),
          )
          yield* Effect.promise(() => entered)
          expect(yield* setup.brain.eraseSession(setup.place, source.parentID)).toBe(0)
          release()
          expect(yield* Effect.promise(() => pending)).toEqual({ ok: false, reason: "source-unavailable" })
          expect(yield* setup.db.select().from(BrainReviewMemoryTable)).toEqual([])
          const after = value(yield* setup.memory.inspect(setup.place))
          expect(after.generation).toBeGreaterThan(state.generation)
        }),
      ports,
    )
  })

  test("an older erase during source authorization cannot resurrect content, and caller mutation cannot retarget an owner action", async () => {
    await using tmp = await tmpdir()
    let pause = false
    let release: () => void = () => {}
    let notify: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      notify = resolve
    })
    const ports: ReviewMemory.Authority = {
      ...authority,
      source: (request, use) =>
        Effect.gen(function* () {
          if (pause) {
            notify()
            yield* Effect.promise(() => gate)
          }
          return yield* authority.source(request, use)
        }),
    }
    await open(
      tmp.path,
      ":memory:",
      (setup) =>
        Effect.gen(function* () {
          const before = yield* learn(setup)
          pause = true
          const pending = Effect.runPromise(
            setup.memory.propose(setup.place, { ...draft, source, expected: before.generation }),
          )
          yield* Effect.promise(() => entered)
          yield* setup.db
            .delete(BrainTombstoneTable)
            .where(eq(BrainTombstoneTable.repository_id, setup.place.repository))
            .run()
          release()
          expect(yield* Effect.promise(() => pending)).toEqual({ ok: false, reason: "source-unavailable" })
          expect(yield* setup.db.select().from(BrainReviewMemoryTable)).toEqual([])
          expect((yield* setup.db.select().from(BrainReviewMemoryStateTable))[0].enabled).toBe(false)
        }),
      ports,
    )
    let finish: () => void = () => {}
    let arrived: () => void = () => {}
    const wait = new Promise<void>((resolve) => {
      finish = resolve
    })
    const start = new Promise<void>((resolve) => {
      arrived = resolve
    })
    await open(
      tmp.path,
      ":memory:",
      (setup) =>
        Effect.gen(function* () {
          const mutable = { ...setup.place }
          const initial = value(yield* setup.memory.inspect(setup.place))
          const effect = setup.memory.configure(mutable, { expected: initial.generation, enabled: true })
          const pending = Effect.runPromise(effect)
          yield* Effect.promise(() => start)
          mutable.repository = "repo-b"
          mutable.scope = "physical-b"
          finish()
          expect(value(yield* Effect.promise(() => pending)).enabled).toBe(true)
          const rows = yield* setup.db.select().from(BrainReviewMemoryStateTable)
          expect(rows.toSorted((a, b) => a.repository_id.localeCompare(b.repository_id))).toEqual([
            { repository_id: ReviewStore.GLOBAL, enabled: false, generation: 0 },
            { repository_id: "repo-a", enabled: false, generation: 0 },
          ])
          expect(yield* setup.db.select().from(BrainReviewMemoryScopeStateTable)).toEqual([
            { repository_id: "repo-a", scope_id: "physical-a", enabled: true, generation: 1 },
          ])
        }),
      {
        ...authority,
        owner: (request, use) =>
          Effect.gen(function* () {
            expect(request.repository).toBe("repo-a")
            expect(request.scope).toBe("physical-a")
            if (request.operation === "configure") {
              arrived()
              yield* Effect.promise(() => wait)
            }
            return yield* use("owner_1")
          }),
      },
    )
  })

  test("first enable approvals cannot cross empty repository/all erasure, including older marker deletion and reinspection", async () => {
    for (const mode of ["repository", "all", "older-repository", "older-all"] as const) {
      await using tmp = await tmpdir()
      let release: () => void = () => {}
      let notify: () => void = () => {}
      const wait = new Promise<void>((resolve) => {
        release = resolve
      })
      const entered = new Promise<void>((resolve) => {
        notify = resolve
      })
      const ports: ReviewMemory.Authority = {
        ...authority,
        owner: (_request, use) =>
          Effect.gen(function* () {
            if (_request.operation === "configure") {
              notify()
              yield* Effect.promise(() => wait)
            }
            return yield* use("owner_1")
          }),
      }
      await open(
        tmp.path,
        ":memory:",
        (setup) =>
          Effect.gen(function* () {
            // Authenticated inspection installs an empty disabled witness before any enable approval can be issued.
            const initial = value(yield* setup.memory.inspect(setup.place))
            expect(initial).toEqual({ enabled: false, generation: 0, entries: [] })
            const pending = Effect.runPromise(
              setup.memory.configure(setup.place, { expected: initial.generation, enabled: true }),
            )
            yield* Effect.promise(() => entered)
            if (mode === "repository" || mode === "all") expect(yield* setup.brain.erase(setup.place, mode)).toBe(0)
            if (mode === "older-repository")
              yield* setup.db
                .delete(BrainTombstoneTable)
                .where(eq(BrainTombstoneTable.repository_id, setup.place.repository))
                .run()
            if (mode === "older-all") yield* setup.db.delete(BrainTombstoneTable).run()
            const renewed = value(yield* setup.memory.inspect(setup.place))
            expect(renewed.generation).toBeGreaterThan(initial.generation)
            release()
            expect(yield* Effect.promise(() => pending)).toEqual({ ok: false, reason: "stale" })
            expect(value(yield* setup.memory.inspect(setup.place))).toEqual(renewed)
            expect(yield* setup.db.select().from(BrainReviewMemoryTable)).toEqual([])
            expect(renewed.enabled).toBe(false)
          }),
        ports,
      )
    }
  })
})
