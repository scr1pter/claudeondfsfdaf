import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Global } from "@vectordevai/core/global"
import { tmpdir } from "../fixture/tmpdir"

const open = <A, E>(file: string, body: (database: BrainDatabase.Interface) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(yield* BrainDatabase.Service)
    }).pipe(Effect.provide(BrainDatabase.layerFor(file).pipe(Layer.fresh))),
  )

describe("BrainDatabase", () => {
  test("the brain and everything beside it share one connection to brain.db", async () => {
    await using tmp = await tmpdir()
    const layer = AppNodeBuilder.build(LayerNode.group([Brain.node, BrainDatabase.node]), [
      [Global.node, Global.layerWith({ config: path.join(tmp.path, "config"), data: path.join(tmp.path, "data") })],
    ])
    const learning = await Effect.runPromise(
      Effect.gen(function* () {
        const brain = yield* Brain.Service
        const database = yield* BrainDatabase.Service
        yield* brain.setLearning(false)
        // A database in memory is private to its connection, so this reads what the brain wrote only if it is the same one.
        return {
          file: database.file,
          rows: yield* database.db.all<{ learning: number }>(
            sql`SELECT learning FROM brain_state WHERE repository_id = ''`,
          ),
        }
      }).pipe(Effect.provide(layer)),
    )
    // The test preload keeps the session database in memory, and the brain follows it.
    expect(learning).toEqual({ file: ":memory:", rows: [{ learning: 0 }] })
  })

  test("a file is private to the user, set up for two processes, and migrated once", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "data", "brain", "brain.db")
    const opened = await open(file, (database) =>
      Effect.gen(function* () {
        yield* database.db.run(sql`INSERT INTO brain_state (repository_id) VALUES ('repo-1')`)
        return {
          journal: yield* database.db.get<{ journal_mode: string }>(sql`PRAGMA journal_mode`),
          foreign: yield* database.db.get<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`),
          secure: yield* database.db.get<{ secure_delete: number }>(sql`PRAGMA secure_delete`),
          busy: yield* database.db.get<{ timeout: number }>(sql`PRAGMA busy_timeout`),
          // While the connection is open, its write-ahead log is on disk beside it.
          modes: yield* Effect.promise(() =>
            Promise.all(
              [path.dirname(file), file, `${file}-wal`].map(async (target) => (await fs.stat(target)).mode & 0o777),
            ),
          ),
        }
      }),
    )
    expect(opened.journal?.journal_mode).toBe("wal")
    expect(opened.foreign?.foreign_keys).toBe(1)
    expect(opened.secure?.secure_delete).toBe(1)
    expect(opened.busy?.timeout).toBe(5000)
    if (process.platform !== "win32") expect(opened.modes).toEqual([0o700, 0o600, 0o600])

    const reopened = await open(file, (database) =>
      Effect.gen(function* () {
        return {
          migrations: yield* database.db.all<{ id: string }>(sql`SELECT id FROM migration ORDER BY id`),
          state: yield* database.db.all<{ repository_id: string }>(sql`SELECT repository_id FROM brain_state`),
        }
      }),
    )
    expect(reopened).toEqual({
      migrations: [
        { id: "20261018000000_brain" },
        { id: "20261101000000_knowledge" },
        { id: "20261102000000_private_memory" },
        { id: "20261103000000_tombstone_terms" },
        { id: "20261104000000_credit" },
        { id: "20261120000000_code" },
        { id: "20261121000000_credited_once" },
        { id: "20261201000000_research" },
        { id: "20261202000000_facets" },
        { id: "20261212000000_research_claims" },
      ],
      state: [{ repository_id: "repo-1" }],
    })
  }, 30_000)

  test("Brain.layerFor still opens a brain over its own file", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "config")
    const data = path.join(tmp.path, "data")
    const file = path.join(data, "brain", "brain.db")
    const layer = Brain.layerFor({ file, data, config }).pipe(
      Layer.provide(Layer.succeed(Global.Service, Global.make({ config, data }))),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const brain = yield* Brain.Service
        yield* brain.setLearning(false)
      }).pipe(Effect.provide(layer)),
    )
    const learning = await open(file, (database) =>
      database.db.all<{ learning: number }>(sql`SELECT learning FROM brain_state WHERE repository_id = ''`),
    )
    expect(learning).toEqual([{ learning: 0 }])
  })
})
