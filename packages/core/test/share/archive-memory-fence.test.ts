import { describe, expect, test } from "bun:test"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Layer, ManagedRuntime, Result, Schema } from "effect"
import { PublicSession } from "@vectordevai/schema/public-session"
import { Database } from "../../src/database/database"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { LayerNode } from "../../src/effect/layer-node"
import { EventV2 } from "../../src/event"
import { ProjectV2 } from "../../src/project"
import { ReviewMemoryFence } from "../../src/review/memory-fence"
import { AbsolutePath } from "../../src/schema"
import { SessionAudience } from "../../src/session/audience"
import { SessionSchema } from "../../src/session/schema"
import { SessionArchive } from "../../src/share/archive"
import { SessionV1 } from "../../src/v1/session"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const VISIBLE = "ORDINARY_VISIBLE_ARCHIVE_FIXTURE"
const MEMORY = "MEMORY_WRITTEN_AFTER_COMMITTED_FENCE"
const location = { directory: AbsolutePath.make("/memory-fence-archive-fixture") }

// Only filesystem/project discovery is replaced. Archive, Event/Projector,
// permanent audience/lineage and both SQLite connections remain actual ports.
function graph(filename = ":memory:", resolve: () => Effect.Effect<void> = () => Effect.void) {
  return AppNodeBuilder.build(LayerNode.group([SessionArchive.node, Database.node, EventV2.node]), [
    [Database.node, Database.layerFromPath(filename)],
    [
      ProjectV2.node,
      Layer.succeed(ProjectV2.Service, {
        resolve: (directory) => resolve().pipe(Effect.as({ id: ProjectV2.ID.global, directory })),
        directories: () => Effect.succeed([]),
        commit: () => Effect.void,
      }),
    ],
  ])
}

const it = testEffect(graph())
const portable = (engine: "v1" | "v2"): PublicSession.Archive => ({
  version: 1,
  engine,
  title: "Memory-fence archive fixture",
  messages: [{ id: "fixture-user", role: "user", createdAt: 1, parts: [{ type: "text", text: VISIBLE }] }],
})
const encoded = (local: SessionArchive.Local) =>
  "engine" in local ? Schema.encodeSync(SessionArchive.Native)(local) : Schema.encodeSync(SessionArchive.Legacy)(local)

function failure<A>(effect: Effect.Effect<A, PublicSession.Error>) {
  return Effect.gen(function* () {
    const result = yield* effect.pipe(Effect.result)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.code).toBe("INVALID")
      expect(result.failure.message).toBe("The review-memory history is unavailable for archive transfer.")
    }
  })
}

describe("archive refusal for permanent review-memory history fences", () => {
  it.effect("mutating the retained selection at its format read cannot switch clean history to a fenced Session", () =>
    Effect.gen(function* () {
      const archives = yield* SessionArchive.Service
      const database = yield* Database.Service
      const clean = yield* archives.import({ archive: portable("v1"), location })
      const blocked = yield* archives.import({ archive: portable("v1"), location })
      yield* ReviewMemoryFence.make(database.db).mark(blocked.sessionID)
      yield* database.db.run(
        sql`UPDATE part SET data = replace(data, ${VISIBLE}, ${MEMORY}) WHERE session_id = ${blocked.sessionID}`,
      )
      expect(
        JSON.stringify(yield* database.db.all(sql`SELECT data FROM part WHERE session_id = ${blocked.sessionID}`)),
      ).toContain(MEMORY)
      const retained: SessionArchive.Selection = { sessionID: clean.sessionID, engine: "v1" }
      const reads = { session: 0, engine: 0, changed: false }
      const selection: SessionArchive.Selection = {
        get sessionID() {
          reads.session++
          return retained.sessionID
        },
        get engine() {
          reads.engine++
          const requested = retained.engine
          // This is the old export's deterministic read barrier: its format
          // was first read after awaited row/fence reads, before legacy body
          // queries. Both Sessions and the private body are actual SQLite data.
          retained.sessionID = blocked.sessionID
          reads.changed = true
          return requested
        },
      }
      const local = yield* archives.export(selection)
      expect(reads).toEqual({ session: 1, engine: 1, changed: true })
      expect(local.info.id).toBe(clean.sessionID)
      expect("engine" in local).toBe(false)
      expect(JSON.stringify(local)).toContain(VISIBLE)
      expect(JSON.stringify(local)).not.toContain(MEMORY)
      yield* failure(archives.export(blocked))
    }),
  )

  it.effect("mutating the retained format cannot replace a requested legacy export after its read snapshot", () =>
    Effect.gen(function* () {
      const archives = yield* SessionArchive.Service
      const clean = yield* archives.import({ archive: portable("v1"), location })
      const retained: SessionArchive.Selection = { sessionID: clean.sessionID, engine: "v1" }
      const reads = { engine: 0 }
      const selection: SessionArchive.Selection = {
        sessionID: clean.sessionID,
        get engine() {
          reads.engine++
          const requested = retained.engine
          retained.engine = "v2"
          return requested
        },
      }
      const local = yield* archives.export(selection)
      expect(reads.engine).toBe(1)
      expect("engine" in local).toBe(false)
      expect(local.info.id).toBe(clean.sessionID)
      expect(JSON.stringify(local)).toContain(VISIBLE)
    }),
  )

  for (const engine of ["v1", "v2"] as const) {
    it.effect(`${engine} ordinary exports, previews and same-database imports remain usable`, () =>
      Effect.gen(function* () {
        const archives = yield* SessionArchive.Service
        const database = yield* Database.Service
        const original = yield* archives.import({ archive: portable(engine), location })
        const local = yield* archives.export(original)
        expect(JSON.stringify(local)).toContain(VISIBLE)
        expect(JSON.stringify(yield* archives.preview(original))).toContain(VISIBLE)
        const imported = yield* archives.import({ archive: encoded(local), location })
        expect(JSON.stringify(yield* archives.export(imported))).toContain(VISIBLE)
        expect(yield* ReviewMemoryFence.make(database.db).requiresLease(imported.sessionID)).toBe(false)
        expect(
          yield* database.db.get(
            sql`SELECT parent_id, fork FROM session_lineage WHERE session_id = ${imported.sessionID}`,
          ),
        ).toEqual({ parent_id: original.sessionID, fork: 1 })
        const foreign = encoded(local)
        const foreignInfo: Record<string, unknown> = foreign.info
        foreignInfo.id = SessionSchema.ID.create()
        delete foreignInfo.parentID
        delete foreignInfo.internal
        delete foreignInfo.metadata
        const external = yield* archives.import({ archive: foreign, location })
        expect(JSON.stringify(yield* archives.export(external))).toContain(VISIBLE)
        expect(yield* ReviewMemoryFence.make(database.db).requiresLease(external.sessionID)).toBe(false)
      }),
    )

    it.effect(`${engine} a fenced local source refuses before any imported history event despite stripped hints`, () =>
      Effect.gen(function* () {
        const archives = yield* SessionArchive.Service
        const database = yield* Database.Service
        const events = yield* EventV2.Service
        const original = yield* archives.import({ archive: portable(engine), location })
        const wire = encoded(yield* archives.export(original))
        const info: Record<string, unknown> = wire.info
        delete info.internal
        info.metadata = { reviewMemory: false }
        yield* ReviewMemoryFence.make(database.db).mark(original.sessionID)
        const observed: string[] = []
        const off = yield* events.listen((event) =>
          Effect.sync(() => {
            observed.push(event.type)
          }),
        )
        yield* Effect.addFinalizer(() => off)
        const before = yield* database.db.all(sql`SELECT id FROM session ORDER BY id`)
        yield* failure(archives.export(original))
        yield* failure(archives.preview(original))
        yield* failure(archives.import({ archive: wire, location }))
        expect(observed).toEqual([])
        expect(yield* database.db.all(sql`SELECT id FROM session ORDER BY id`)).toEqual(before)
      }),
    )

    it.effect(`${engine} restored copies retain refusal after metadata/body changes and source deletion`, () =>
      Effect.gen(function* () {
        const archives = yield* SessionArchive.Service
        const database = yield* Database.Service
        const original = yield* archives.import({ archive: portable(engine), location })
        const wire = encoded(yield* archives.export(original))
        const copy = yield* archives.import({ archive: wire, location })
        const ordinary = yield* archives.import({ archive: portable(engine), location })
        yield* ReviewMemoryFence.make(database.db).mark(original.sessionID)
        yield* database.db.run(sql`UPDATE session SET metadata = '{}', internal = NULL WHERE id = ${copy.sessionID}`)
        yield* database.db.run(sql`DELETE FROM part WHERE session_id = ${copy.sessionID}`)
        yield* database.db.run(sql`DELETE FROM session_message WHERE session_id = ${copy.sessionID}`)
        yield* database.db.run(sql`DELETE FROM session WHERE id = ${original.sessionID}`)
        yield* failure(archives.export(copy))
        yield* failure(archives.preview(copy))
        yield* failure(archives.import({ archive: wire, location }))
        expect(JSON.stringify(yield* archives.export(ordinary))).toContain(VISIBLE)
      }),
    )

    test(`${engine} an old actual SQLite read snapshot excludes later memory writes and a fresh export refuses`, async () => {
      await using directory = await tmpdir()
      const filename = path.join(directory.path, `archive-${engine}.sqlite`)
      await Effect.runPromise(
        Effect.gen(function* () {
          const archives = yield* SessionArchive.Service
          const database = yield* Database.Service
          const original = yield* archives.import({ archive: portable(engine), location })
          const writer = yield* Effect.acquireRelease(
            Effect.sync(() => ManagedRuntime.make(Database.layerFromPath(filename))),
            (runtime) => Effect.promise(() => runtime.dispose()),
          )
          // Initialize the independent connection before holding the read snapshot.
          yield* Effect.promise(() => writer.runPromise(Database.Service.pipe(Effect.asVoid)))
          yield* database.db.transaction((tx) =>
            Effect.gen(function* () {
              expect(yield* ReviewMemoryFence.read(tx, original.sessionID)).toBe(false)
              yield* Effect.promise(() =>
                writer.runPromise(
                  Effect.gen(function* () {
                    const other = yield* Database.Service
                    yield* ReviewMemoryFence.make(other.db).mark(original.sessionID)
                    // Qualified mark commits before any synthetic memory body.
                    if (engine === "v1")
                      yield* other.db.run(
                        sql`UPDATE part SET data = replace(data, ${VISIBLE}, ${MEMORY}) WHERE session_id = ${original.sessionID}`,
                      )
                    if (engine === "v2")
                      yield* other.db.run(
                        sql`UPDATE session_message SET data = replace(data, ${VISIBLE}, ${MEMORY}) WHERE session_id = ${original.sessionID}`,
                      )
                    const stored =
                      engine === "v1"
                        ? yield* other.db.all(sql`SELECT data FROM part WHERE session_id = ${original.sessionID}`)
                        : yield* other.db.all(
                            sql`SELECT data FROM session_message WHERE session_id = ${original.sessionID}`,
                          )
                    expect(JSON.stringify(stored)).toContain(MEMORY)
                  }),
                ),
              )
              const old = yield* archives.export(original)
              expect(JSON.stringify(old)).toContain(VISIBLE)
              expect(JSON.stringify(old)).not.toContain(MEMORY)
              expect(yield* ReviewMemoryFence.read(tx, original.sessionID)).toBe(false)
            }),
          )
          expect(yield* ReviewMemoryFence.make(database.db).requiresLease(original.sessionID)).toBe(true)
          yield* failure(archives.export(original))
          yield* failure(archives.preview(original))
        }).pipe(Effect.provide(graph(filename)), Effect.scoped),
      )
    })
  }

  test("a source mark during setup cannot be evaded by changing the caller's archive identity", async () => {
    const setup: { resolve: () => Effect.Effect<void> } = { resolve: () => Effect.void }
    await Effect.runPromise(
      Effect.gen(function* () {
        const archives = yield* SessionArchive.Service
        const database = yield* Database.Service
        const events = yield* EventV2.Service
        const original = yield* archives.import({ archive: portable("v1"), location })
        const unrelated = yield* archives.import({ archive: portable("v1"), location })
        const wire = encoded(yield* archives.export(original))
        const info: Record<string, unknown> = wire.info
        const fence = ReviewMemoryFence.make(database.db)
        setup.resolve = () =>
          fence.mark(original.sessionID).pipe(
            Effect.andThen(
              Effect.sync(() => {
                info.id = unrelated.sessionID
                info.metadata = {}
              }),
            ),
            Effect.orDie,
          )
        const created: SessionSchema.ID[] = []
        const off = yield* events.listen((event) => {
          if (event.type !== SessionV1.Event.Created.type) return Effect.void
          return Effect.sync(() => {
            created.push(Schema.decodeUnknownSync(SessionV1.Event.Created.data)(event.data).sessionID)
          })
        })
        yield* Effect.addFinalizer(() => off)
        const before = yield* database.db.all(sql`SELECT id FROM session ORDER BY id`)
        yield* failure(archives.import({ archive: wire, location }))
        expect(created).toEqual([])
        expect(yield* database.db.all(sql`SELECT id FROM session ORDER BY id`)).toEqual(before)
        const linked = yield* database.db.all<{ session_id: SessionSchema.ID }>(
          sql`SELECT session_id FROM session_lineage WHERE parent_id = ${original.sessionID}`,
        )
        expect(linked).toHaveLength(1)
        for (const row of linked) expect(yield* fence.requiresLease(row.session_id)).toBe(true)
        expect(yield* fence.requiresLease(unrelated.sessionID)).toBe(false)
      }).pipe(Effect.provide(graph(":memory:", () => setup.resolve())), Effect.scoped),
    )
  })

  it.effect("a mark during committed import notifications leaves a refusing partial result", () =>
    Effect.gen(function* () {
      const archives = yield* SessionArchive.Service
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const original = yield* archives.import({ archive: portable("v1"), location })
      const wire = encoded(yield* archives.export(original))
      const fence = ReviewMemoryFence.make(database.db)
      const created: SessionSchema.ID[] = []
      const off = yield* events.listen((event) => {
        if (event.type !== SessionV1.Event.Created.type) return Effect.void
        return Effect.gen(function* () {
          // importAll commits its aggregate before delivering notifications.
          // This exercises the final check, after body copying already finished.
          created.push(Schema.decodeUnknownSync(SessionV1.Event.Created.data)(event.data).sessionID)
          yield* fence.mark(original.sessionID)
        }).pipe(Effect.orDie)
      })
      yield* Effect.addFinalizer(() => off)
      yield* failure(archives.import({ archive: wire, location }))
      expect(created).toHaveLength(1)
      for (const sessionID of created) {
        expect(yield* fence.requiresLease(sessionID)).toBe(true)
        expect(yield* database.db.all(sql`SELECT data FROM part WHERE session_id = ${sessionID}`)).not.toEqual([])
        expect(
          yield* database.db.get(sql`SELECT parent_id, fork FROM session_lineage WHERE session_id = ${sessionID}`),
        ).toEqual({ parent_id: original.sessionID, fork: 1 })
        yield* failure(archives.export({ sessionID }))
      }
    }),
  )

  it.effect("corrupt fence evidence refuses transfer through the actual archive port", () =>
    Effect.gen(function* () {
      const archives = yield* SessionArchive.Service
      const database = yield* Database.Service
      const original = yield* archives.import({ archive: portable("v2"), location })
      const wire = encoded(yield* archives.export(original))
      yield* ReviewMemoryFence.make(database.db).mark(original.sessionID)
      yield* database.db.run(sql`UPDATE review_memory_fence SET version = 0`)
      yield* failure(archives.export(original))
      yield* failure(archives.preview(original))
      yield* failure(archives.import({ archive: wire, location }))
      expect(yield* SessionAudience.make(database).knows(original.sessionID)).toBe(true)
    }),
  )
})
