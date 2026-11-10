import { expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import { BrainRevocation } from "@vectordevai/core/brain/revocation"
import { BrainEventTable } from "@vectordevai/core/brain/sql"
import { eq } from "drizzle-orm"
import { Global } from "@vectordevai/core/global"
import { tmpdir } from "../fixture/tmpdir"

test("explicit revocations cross connections, stay scoped, and remain monotonic after bulk erasure", async () => {
  await using tmp = await tmpdir()
  const config = path.join(tmp.path, "config")
  const data = path.join(tmp.path, "data")
  const file = path.join(tmp.path, "brain.db")
  const place: Brain.Place = { repository: "repo-a", root: tmp.path, sources: [], held: false }
  const layer = Brain.layer.pipe(
    Layer.provideMerge(BrainDatabase.layerFor(file)),
    Layer.provide(Layer.succeed(Global.Service, Global.make({ config, data }))),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const reader = yield* BrainDatabase.Service
      expect(yield* BrainRevocation.revision(reader.db, "repo-a")).toBe(0)
      yield* Effect.gen(function* () {
        const writer = yield* BrainDatabase.Service
        const brain = yield* Brain.Service
        expect(writer.db).not.toBe(reader.db)
        const saved = yield* brain.propose(place, {
          origin: "user",
          scope: "repository",
          kind: "decision",
          text: "Reports use the sapphire forecast window.",
        })
        if (saved.type === "refused") return yield* Effect.die(saved.message)
        yield* brain.update(place, saved.entry.id, { pinned: true }, "user")
        expect(yield* BrainRevocation.revision(reader.db, "repo-a")).toBe(0)
        yield* writer.db
          .transaction(() =>
            Effect.gen(function* () {
              yield* brain.update(place, saved.entry.id, { text: "Reports use a temporary window." }, "user")
              return yield* Effect.fail("withdraw this transaction")
            }),
          )
          .pipe(Effect.catch(() => Effect.void))
        expect(yield* BrainRevocation.revision(reader.db, "repo-a")).toBe(0)
        expect((yield* brain.get(place, saved.entry.id, { personal: true }))?.entry.text).toBe(
          "Reports use the sapphire forecast window.",
        )
        yield* brain.update(place, saved.entry.id, { text: "Reports use the indigo forecast window." }, "user")
        const edited = yield* BrainRevocation.revision(reader.db, "repo-a")
        expect(edited).toBeGreaterThan(0)
        yield* brain.update(place, saved.entry.id, { pinned: false }, "user")
        const unpinned = yield* BrainRevocation.revision(reader.db, "repo-a")
        expect(unpinned).toBeGreaterThan(edited)
        yield* brain.update(place, saved.entry.id, { action: "archive" }, "user")
        const archived = yield* BrainRevocation.revision(reader.db, "repo-a")
        expect(archived).toBeGreaterThan(unpinned)
        expect(yield* brain.forget(place, saved.entry.id)).toBe("forgotten")
        const forgotten = yield* BrainRevocation.revision(reader.db, "repo-a")
        expect(forgotten).toBeGreaterThan(archived)
        expect(yield* BrainRevocation.revision(reader.db, "repo-b")).toBe(0)

        const personal = yield* brain.propose(place, {
          origin: "user",
          scope: "personal",
          kind: "preference",
          text: "I prefer concise explanations.",
        })
        if (personal.type === "refused") return yield* Effect.die(personal.message)
        expect(yield* brain.forget(place, personal.entry.id)).toBe("forgotten")
        const shared = yield* BrainRevocation.revision(reader.db, "repo-a")
        expect(shared).toBeGreaterThan(forgotten)
        const other = yield* BrainRevocation.revision(reader.db, "repo-b")
        expect(other).toBeGreaterThan(0)

        // Erasing an already empty scope still revokes its old digest; the marker must outlive deleted event ids.
        yield* brain.erase(place, "repository")
        const erased = yield* BrainRevocation.revision(reader.db, "repo-a")
        expect(erased).toBeGreaterThan(shared)
        expect(yield* BrainRevocation.revision(reader.db, "repo-b")).toBe(other)
        yield* brain.erase(place, "all")
        const all = yield* BrainRevocation.revision(reader.db, "repo-a")
        expect(all).toBeGreaterThan(erased)
        expect(yield* BrainRevocation.revision(reader.db, "repo-b")).toBeGreaterThan(other)
        expect(yield* reader.db.select().from(BrainEventTable).all()).toEqual([
          {
            id: expect.any(Number),
            entry_id: "",
            repository_id: "",
            at: expect.any(Number),
            action: "forgotten",
            actor: "user",
            detail: null,
          },
        ])
      }).pipe(Effect.provide(layer.pipe(Layer.fresh)))
    }).pipe(Effect.provide(layer)),
  )
}, 30_000)

for (const pruning of ["180-day retention", "another repository's anonymous markers"])
  test(`consolidation cannot reset a revocation through ${pruning}`, async () => {
    await using tmp = await tmpdir()
    const place: Brain.Place = { repository: "repo-a", root: tmp.path, sources: [], held: false }
    const layer = Brain.layer.pipe(
      Layer.provideMerge(BrainDatabase.layerFor(path.join(tmp.path, "brain.db"))),
      Layer.provide(
        Layer.succeed(
          Global.Service,
          Global.make({ config: path.join(tmp.path, "config"), data: path.join(tmp.path, "data") }),
        ),
      ),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const reader = yield* BrainDatabase.Service
        yield* Effect.gen(function* () {
          const brain = yield* Brain.Service
          const writer = yield* BrainDatabase.Service
          expect(writer.db).not.toBe(reader.db)
          yield* brain.erase(place, "repository")
          const erased = yield* BrainRevocation.revision(reader.db, place.repository)
          if (pruning === "180-day retention")
            yield* writer.db
              .update(BrainEventTable)
              .set({ at: Date.now() - 181 * 86_400_000 })
              .run()
          if (pruning !== "180-day retention")
            for (const repository of Array.from({ length: 31 }, (_, index) => `repo-b-${index}`))
              yield* brain.erase({ ...place, repository }, "repository")
          yield* brain.consolidate(place, { force: true })
          expect(
            yield* reader.db
              .select()
              .from(BrainEventTable)
              .where(eq(BrainEventTable.repository_id, place.repository))
              .all(),
          ).toEqual([])
          expect(yield* BrainRevocation.revision(reader.db, place.repository)).toBe(erased)
          yield* brain.erase(place, "repository")
          expect(yield* BrainRevocation.revision(reader.db, place.repository)).toBeGreaterThan(erased)
        }).pipe(Effect.provide(layer.pipe(Layer.fresh)))
      }).pipe(Effect.provide(layer)),
    )
  }, 30_000)
