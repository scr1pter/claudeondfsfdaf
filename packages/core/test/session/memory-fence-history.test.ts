import { describe, expect, test } from "bun:test"
import path from "node:path"
import { sql } from "drizzle-orm"
import { DateTime, Effect, Layer, ManagedRuntime, Result, Schema } from "effect"
import { Database } from "../../src/database/database"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { LayerNode } from "../../src/effect/layer-node"
import { EventV2 } from "../../src/event"
import { Location } from "../../src/location"
import { ProjectV2 } from "../../src/project"
import { ReviewMemoryFence } from "../../src/review/memory-fence"
import { AbsolutePath } from "../../src/schema"
import { SessionV2 } from "../../src/session"
import { SessionExecution } from "../../src/session/execution"
import { SessionEvent } from "../../src/session/event"
import { SessionHistory } from "../../src/session/history"
import { SessionMessage } from "../../src/session/message"
import { SessionProjector } from "../../src/session/projector"
import { SessionSchema } from "../../src/session/schema"
import { SessionStore } from "../../src/session/store"
import { SessionArchive } from "../../src/share/archive"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const VISIBLE = "ORDINARY_RUNNER_HISTORY_FIXTURE"
const MEMORY = "MEMORY_COMMITTED_AFTER_FENCE"
const location = Location.Ref.make({ directory: AbsolutePath.make("/memory-fence-history-fixture") })

function graph(filename = ":memory:") {
  return AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
      SessionArchive.node,
    ]),
    [
      [Database.node, Database.layerFromPath(filename)],
      [SessionExecution.node, SessionExecution.noopLayer],
      [
        ProjectV2.node,
        Layer.succeed(ProjectV2.Service, {
          resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
          directories: () => Effect.succeed([]),
          commit: () => Effect.void,
        }),
      ],
    ],
  )
}
const it = testEffect(graph())

const seed = Effect.gen(function* () {
  const sessions = yield* SessionV2.Service
  const events = yield* EventV2.Service
  const created = yield* sessions.create({ location })
  yield* events.publish(SessionEvent.MessageImported, {
    sessionID: created.id,
    timestamp: DateTime.makeUnsafe(1),
    message: SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: VISIBLE,
      time: { created: DateTime.makeUnsafe(1) },
    }),
  })
  return created
})

function failure<A, E>(effect: Effect.Effect<A, E>) {
  return Effect.gen(function* () {
    const result = yield* effect.pipe(Effect.result)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ReviewMemoryFence.Refused)
      if (result.failure instanceof ReviewMemoryFence.Refused)
        expect(result.failure.message).toBe("The review memory history boundary is unavailable.")
    }
  })
}

describe("Core runner history snapshots refuse memory fences", () => {
  it.effect("genuine ordinary history still reaches runner readers and owner inspection", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const created = yield* seed
      const entries = yield* SessionHistory.entriesForRunner(database.db, created.id, -1)
      expect(JSON.stringify(entries)).toContain(VISIBLE)
      expect(entries.map((entry) => entry.seq)).toEqual([...entries.map((entry) => entry.seq)].sort((a, b) => a - b))
      expect(JSON.stringify(yield* store.runnerContext(created.id, -1))).toContain(VISIBLE)
      expect(JSON.stringify(yield* store.context(created.id))).toContain(VISIBLE)
      expect(JSON.stringify(yield* store.all(created.id))).toContain(VISIBLE)
    }),
  )

  it.effect("a fenced history and its retained summary refuse runner reads while inspection stays available", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const store = yield* SessionStore.Service
      const created = yield* seed
      yield* ReviewMemoryFence.make(database.db).mark(created.id)
      yield* events.publish(SessionEvent.MessageImported, {
        sessionID: created.id,
        timestamp: DateTime.makeUnsafe(2),
        message: SessionMessage.Compaction.make({
          id: SessionMessage.ID.create(),
          type: "compaction",
          reason: "auto",
          summary: MEMORY,
          recent: "Retained history",
          time: { created: DateTime.makeUnsafe(2) },
        }),
      })
      yield* failure(SessionHistory.entriesForRunner(database.db, created.id, -1))
      yield* failure(SessionHistory.loadForRunner(database.db, created.id, -1))
      yield* failure(store.runnerContext(created.id, -1))
      expect(JSON.stringify(yield* store.context(created.id))).toContain(MEMORY)
      expect(JSON.stringify(yield* store.all(created.id))).toContain(VISIBLE)
      expect((yield* store.get(created.id))?.id).toBe(created.id)
    }),
  )

  it.effect("an actual restored copy retains refusal after source deletion and metadata replacement", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const archives = yield* SessionArchive.Service
      const original = yield* seed
      const local = yield* archives.export({ sessionID: original.id })
      if (!("engine" in local)) return yield* Effect.die("Expected actual native history fixture")
      const copy = yield* archives.import({ archive: Schema.encodeSync(SessionArchive.Native)(local), location })
      yield* ReviewMemoryFence.make(database.db).mark(original.id)
      yield* database.db.run(sql`UPDATE session SET metadata = '{}', internal = NULL WHERE id = ${copy.sessionID}`)
      yield* database.db.run(sql`DELETE FROM session WHERE id = ${original.id}`)
      yield* failure(SessionHistory.entriesForRunner(database.db, copy.sessionID, -1))
      yield* failure(store.runnerContext(copy.sessionID, -1))
      expect(JSON.stringify(yield* store.context(copy.sessionID))).toContain(VISIBLE)
      expect(
        yield* database.db.get(sql`SELECT parent_id, fork FROM session_lineage WHERE session_id = ${copy.sessionID}`),
      ).toEqual({ parent_id: original.id, fork: 1 })
    }),
  )

  it.effect("unknown and corrupt history evidence never becomes an empty successful runner context", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const created = yield* seed
      yield* failure(
        SessionHistory.entriesForRunner(database.db, SessionSchema.ID.make("ses_unknown_runner_history"), -1),
      )
      yield* ReviewMemoryFence.make(database.db).mark(created.id)
      yield* database.db.run(sql`UPDATE review_memory_fence SET version = 0`)
      yield* failure(SessionHistory.entriesForRunner(database.db, created.id, -1))
      expect(JSON.stringify(yield* SessionHistory.loadAll(database.db, created.id))).toContain(VISIBLE)
    }),
  )

  test("a real old SQLite snapshot excludes later memory bytes and a fresh runner read refuses", async () => {
    await using directory = await tmpdir()
    const filename = path.join(directory.path, "history.sqlite")
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const store = yield* SessionStore.Service
        const created = yield* seed
        const writer = yield* Effect.acquireRelease(
          Effect.sync(() => ManagedRuntime.make(Database.layerFromPath(filename))),
          (runtime) => Effect.promise(() => runtime.dispose()),
        )
        yield* Effect.promise(() => writer.runPromise(Database.Service.pipe(Effect.asVoid)))
        yield* database.db.transaction((tx) =>
          Effect.gen(function* () {
            expect(yield* ReviewMemoryFence.read(tx, created.id)).toBe(false)
            yield* Effect.promise(() =>
              writer.runPromise(
                Effect.gen(function* () {
                  const other = yield* Database.Service
                  yield* ReviewMemoryFence.make(other.db).mark(created.id)
                  yield* other.db.run(
                    sql`UPDATE session_message SET data = replace(data, ${VISIBLE}, ${MEMORY}) WHERE session_id = ${created.id}`,
                  )
                  expect(
                    JSON.stringify(
                      yield* other.db.all(sql`SELECT data FROM session_message WHERE session_id = ${created.id}`),
                    ),
                  ).toContain(MEMORY)
                }),
              ),
            )
            const entries = yield* SessionHistory.entriesForRunner(database.db, created.id, -1)
            expect(JSON.stringify(entries)).toContain(VISIBLE)
            expect(JSON.stringify(entries)).not.toContain(MEMORY)
          }),
        )
        yield* failure(SessionHistory.entriesForRunner(database.db, created.id, -1))
        yield* failure(store.runnerContext(created.id, -1))
        expect(JSON.stringify(yield* store.context(created.id))).toContain(MEMORY)
      }).pipe(Effect.provide(graph(filename)), Effect.scoped),
    )
  })

  test("reopening actual storage retains runner denial without disabling owner inspection", async () => {
    await using directory = await tmpdir()
    const filename = path.join(directory.path, "reopened.sqlite")
    const sessionID = await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const created = yield* seed
        yield* ReviewMemoryFence.make(database.db).mark(created.id)
        return created.id
      }).pipe(Effect.provide(graph(filename)), Effect.scoped),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const store = yield* SessionStore.Service
        yield* failure(SessionHistory.entriesForRunner(database.db, sessionID, -1))
        expect(JSON.stringify(yield* store.context(sessionID))).toContain(VISIBLE)
      }).pipe(Effect.provide(graph(filename)), Effect.scoped),
    )
  })
})
