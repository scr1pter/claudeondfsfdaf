import { describe, expect, test } from "bun:test"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Result } from "effect"
import { Database } from "../../src/database/database"
import { ReviewMemoryFence } from "../../src/review/memory-fence"
import { SessionSchema } from "../../src/session/schema"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))
const id = (name: string) => SessionSchema.ID.make(`ses_${name}`)

// Actual persistent lineage/audience rows, not a replacement store or a fake
// Session.fork. Enforcement through Session/LLM/archive is a later package.
function node(
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  parentID?: SessionSchema.ID,
  forkOf?: SessionSchema.ID,
) {
  return Effect.gen(function* () {
    yield* db.run(
      sql`INSERT OR IGNORE INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('memory-fence-project', '/memory-fence-fixture', '[]', 1, 1)`,
    )
    yield* db.run(
      sql`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (${sessionID}, 'memory-fence-project', ${parentID ?? null}, 'memory-fence-fixture', '/memory-fence-fixture', 'Memory fence fixture', 'test', 1, 1)`,
    )
    yield* db.run(sql`INSERT INTO session_audience (session_id) VALUES (${sessionID})`)
    if (parentID)
      yield* db.run(
        sql`INSERT INTO session_lineage (session_id, parent_id, fork) VALUES (${sessionID}, ${parentID}, 0)`,
      )
    if (forkOf && forkOf !== parentID)
      yield* db.run(sql`INSERT INTO session_lineage (session_id, parent_id, fork) VALUES (${sessionID}, ${forkOf}, 1)`)
  })
}

function failure<A>(effect: Effect.Effect<A, ReviewMemoryFence.Refused>) {
  return Effect.gen(function* () {
    const result = yield* effect.pipe(Effect.result)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("ReviewMemoryFence.Refused")
      expect(result.failure.message).toBe("The review memory history boundary is unavailable.")
    }
  })
}

describe("permanent refusal-only review memory history fences", () => {
  it.effect("mark is idempotent, stores no content or authority, and has no session foreign key", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const fence = ReviewMemoryFence.make(database.db)
      yield* node(database.db, id("fresh"))
      expect(Object.isFrozen(fence)).toBe(true)
      expect(Object.keys(fence).sort()).toEqual(["mark", "requiresLease"])
      expect(yield* fence.requiresLease(id("fresh"))).toBe(false)
      yield* fence.mark(id("fresh"))
      yield* fence.mark(id("fresh"))
      expect(yield* fence.requiresLease(id("fresh"))).toBe(true)
      expect(yield* database.db.all(sql`SELECT * FROM review_memory_fence`)).toEqual([
        { session_id: id("fresh"), version: 1 },
      ])
      expect(
        (yield* database.db.all<{ name: string }>(sql`PRAGMA table_info(review_memory_fence)`)).map((row) => row.name),
      ).toEqual(["session_id", "version"])
      expect(yield* database.db.all(sql`PRAGMA foreign_key_list(review_memory_fence)`)).toEqual([])
    }),
  )

  it.effect("walks only upward history sources, preserving ordinary ancestors, siblings and unrelated sessions", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const fence = ReviewMemoryFence.make(database.db)
      yield* node(database.db, id("owner"))
      yield* node(database.db, id("memory"), id("owner"))
      yield* node(database.db, id("sibling"), id("owner"))
      yield* node(database.db, id("other"))
      yield* fence.mark(id("memory"))
      yield* node(database.db, id("fork"), undefined, id("memory"))
      yield* node(database.db, id("future_child"), id("fork"))
      for (const name of ["memory", "fork", "future_child"]) expect(yield* fence.requiresLease(id(name))).toBe(true)
      for (const name of ["owner", "sibling", "other"]) expect(yield* fence.requiresLease(id(name))).toBe(false)
    }),
  )

  it.effect("accepts a diamond and counts a shared history source once without treating it as a cycle", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const fence = ReviewMemoryFence.make(database.db)
      yield* node(database.db, id("ancestor"))
      yield* node(database.db, id("left"), id("ancestor"))
      yield* node(database.db, id("right"), undefined, id("ancestor"))
      yield* node(database.db, id("diamond"), id("left"), id("right"))
      expect(yield* fence.requiresLease(id("diamond"))).toBe(false)
      yield* fence.mark(id("ancestor"))
      expect(yield* fence.requiresLease(id("diamond"))).toBe(true)
    }),
  )

  it.effect("retains fences and lineage through real Session and Project deletion", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const fence = ReviewMemoryFence.make(database.db)
      yield* node(database.db, id("source"))
      yield* node(database.db, id("middle"), undefined, id("source"))
      yield* node(database.db, id("copy"), undefined, id("middle"))
      yield* fence.mark(id("source"))
      yield* database.db.run(sql`DELETE FROM session WHERE id IN (${id("source")}, ${id("middle")})`)
      expect(yield* fence.requiresLease(id("copy"))).toBe(true)
      expect(yield* fence.requiresLease(id("source"))).toBe(true)
      yield* database.db.run(sql`DELETE FROM project WHERE id = 'memory-fence-project'`)
      expect(yield* database.db.all(sql`SELECT id FROM session`)).toEqual([])
      expect(yield* fence.requiresLease(id("copy"))).toBe(true)
      expect(yield* database.db.all(sql`SELECT session_id, version FROM review_memory_fence`)).toEqual([
        { session_id: id("source"), version: 1 },
      ])
      yield* failure(fence.mark(id("copy")))
    }),
  )

  test("reopening the actual SQLite file keeps refusal without a process registry", async () => {
    await using directory = await tmpdir()
    const filename = path.join(directory.path, "memory-fence.sqlite")
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const fence = ReviewMemoryFence.make(database.db)
        yield* node(database.db, id("saved_source"))
        yield* node(database.db, id("saved_copy"), undefined, id("saved_source"))
        yield* fence.mark(id("saved_source"))
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const fence = ReviewMemoryFence.make(database.db)
        expect(yield* fence.requiresLease(id("saved_copy"))).toBe(true)
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })

  it.effect("unknown, unregistered and unsupported identifiers never produce a clear result or a new fence", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const fence = ReviewMemoryFence.make(database.db)
      for (const sessionID of [id("missing"), id("bad\u0000id"), id("bad id"), id("x".repeat(300))]) {
        yield* failure(fence.requiresLease(sessionID))
        yield* failure(fence.mark(sessionID))
      }
      yield* node(database.db, id("unregistered"))
      yield* database.db.run(sql`DELETE FROM session_audience WHERE session_id = ${id("unregistered")}`)
      yield* failure(fence.requiresLease(id("unregistered")))
      yield* failure(fence.mark(id("unregistered")))
      yield* database.db.run(sql`INSERT INTO session_audience (session_id) VALUES (${id("known_tombstone")})`)
      expect(yield* fence.requiresLease(id("known_tombstone"))).toBe(false)
      yield* failure(fence.mark(id("known_tombstone")))
      expect(yield* database.db.all(sql`SELECT * FROM review_memory_fence`)).toEqual([])
    }),
  )

  it.effect("an unknown history parent refuses, while unrelated malformed descendants stay outside the walk", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const fence = ReviewMemoryFence.make(database.db)
      yield* node(database.db, id("ordinary"))
      yield* node(database.db, id("bad_child"), id("ordinary"))
      yield* database.db.run(
        sql`INSERT INTO session_lineage (session_id, parent_id, fork) VALUES (${id("bad_child")}, ${id("missing_parent")}, 1)`,
      )
      expect(yield* fence.requiresLease(id("ordinary"))).toBe(false)
      yield* failure(fence.requiresLease(id("bad_child")))
      yield* failure(fence.mark(id("bad_child")))
      expect(yield* database.db.all(sql`SELECT * FROM review_memory_fence`)).toEqual([])
    }),
  )

  it.effect("raw corrupt edge flags are not decoded as booleans, and failed marking does not mutate evidence", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const fence = ReviewMemoryFence.make(database.db)
      yield* node(database.db, id("flag_source"))
      yield* node(database.db, id("flag_copy"), undefined, id("flag_source"))
      yield* database.db.run(sql`UPDATE session_lineage SET fork = 2 WHERE session_id = ${id("flag_copy")}`)
      yield* failure(fence.requiresLease(id("flag_copy")))
      yield* failure(fence.mark(id("flag_copy")))
      expect(yield* database.db.all(sql`SELECT * FROM review_memory_fence`)).toEqual([])
      expect(
        yield* database.db.get(sql`SELECT fork FROM session_lineage WHERE session_id = ${id("flag_copy")}`),
      ).toEqual({
        fork: 2,
      })
    }),
  )

  it.effect("malformed stored history identifiers refuse without trusting the schema's string type", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const fence = ReviewMemoryFence.make(database.db)
      yield* node(database.db, id("id_source"))
      yield* node(database.db, id("id_copy"), undefined, id("id_source"))
      yield* database.db.run(sql`UPDATE session_lineage SET parent_id = 'foreign-id'`)
      yield* failure(fence.requiresLease(id("id_copy")))
      yield* failure(fence.mark(id("id_copy")))
      expect(yield* database.db.all(sql`SELECT * FROM review_memory_fence`)).toEqual([])
    }),
  )

  it.effect("bad fence versions refuse even on a directly fenced session", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const fence = ReviewMemoryFence.make(database.db)
      yield* node(database.db, id("version_source"))
      yield* node(database.db, id("version_copy"), undefined, id("version_source"))
      yield* fence.mark(id("version_source"))
      for (const version of [0, -1, 2, 1.5, "unknown"]) {
        yield* database.db.run(sql`UPDATE review_memory_fence SET version = ${version}`)
        yield* failure(fence.requiresLease(id("version_source")))
        yield* failure(fence.requiresLease(id("version_copy")))
        yield* failure(fence.mark(id("version_source")))
        expect(yield* database.db.get(sql`SELECT version FROM review_memory_fence`)).toEqual({ version })
      }
    }),
  )

  it.effect("self and multi-node cycles refuse even when an early node already has a fence", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const fence = ReviewMemoryFence.make(database.db)
      yield* node(database.db, id("cycle_a"))
      yield* node(database.db, id("cycle_b"))
      yield* fence.mark(id("cycle_a"))
      yield* database.db.run(
        sql`INSERT INTO session_lineage (session_id, parent_id, fork) VALUES (${id("cycle_a")}, ${id("cycle_a")}, 1)`,
      )
      yield* failure(fence.requiresLease(id("cycle_a")))
      yield* database.db.run(sql`DELETE FROM session_lineage`)
      yield* database.db.run(
        sql`INSERT INTO session_lineage (session_id, parent_id, fork) VALUES (${id("cycle_a")}, ${id("cycle_b")}, 0), (${id("cycle_b")}, ${id("cycle_a")}, 1)`,
      )
      yield* failure(fence.requiresLease(id("cycle_a")))
      yield* failure(fence.mark(id("cycle_b")))
      expect(yield* database.db.all(sql`SELECT session_id FROM review_memory_fence`)).toEqual([
        { session_id: id("cycle_a") },
      ])
    }),
  )

  it.effect("accepts the exact depth boundary but refuses a longer path hidden behind short cuts", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const fence = ReviewMemoryFence.make(database.db)
      for (let index = 0; index < ReviewMemoryFence.LIMIT.depth + 1; index++) {
        yield* node(database.db, id(`depth_${index}`), index ? id(`depth_${index - 1}`) : undefined)
      }
      expect(yield* fence.requiresLease(id(`depth_${ReviewMemoryFence.LIMIT.depth - 1}`))).toBe(false)
      yield* fence.mark(id("depth_0"))
      expect(yield* fence.requiresLease(id(`depth_${ReviewMemoryFence.LIMIT.depth - 1}`))).toBe(true)
      // Every ancestor is now only one edge away from the query. The longest
      // valid-history path still exceeds the cap, so a shortest-path check fails.
      for (let index = 0; index < ReviewMemoryFence.LIMIT.depth - 1; index++)
        yield* database.db.run(
          sql`INSERT INTO session_lineage (session_id, parent_id, fork) VALUES (${id(`depth_${ReviewMemoryFence.LIMIT.depth}`)}, ${id(`depth_${index}`)}, 1)`,
        )
      yield* failure(fence.requiresLease(id(`depth_${ReviewMemoryFence.LIMIT.depth}`)))
    }),
  )

  it.effect("refuses too many distinct history nodes", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const fence = ReviewMemoryFence.make(database.db)
      yield* node(database.db, id("wide"))
      for (let index = 0; index < ReviewMemoryFence.LIMIT.nodes; index++) {
        yield* node(database.db, id(`wide_${index}`))
        yield* database.db.run(
          sql`INSERT INTO session_lineage (session_id, parent_id, fork) VALUES (${id("wide")}, ${id(`wide_${index}`)}, 1)`,
        )
      }
      yield* failure(fence.requiresLease(id("wide")))
      yield* failure(fence.mark(id("wide")))
      expect(yield* database.db.all(sql`SELECT * FROM review_memory_fence`)).toEqual([])
    }),
  )

  it.effect("refuses excessive edges in a small acyclic graph", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const fence = ReviewMemoryFence.make(database.db)
      yield* node(database.db, id("dense"))
      for (let index = 0; index < 16; index++) yield* node(database.db, id(`dense_source_${index}`))
      for (let index = 0; index < 32; index++) {
        yield* node(database.db, id(`dense_parent_${index}`))
        yield* database.db.run(
          sql`INSERT INTO session_lineage (session_id, parent_id, fork) VALUES (${id("dense")}, ${id(`dense_parent_${index}`)}, 1)`,
        )
        for (let source = 0; source < 16; source++)
          yield* database.db.run(
            sql`INSERT INTO session_lineage (session_id, parent_id, fork) VALUES (${id(`dense_parent_${index}`)}, ${id(`dense_source_${source}`)}, 0)`,
          )
      }
      yield* failure(fence.requiresLease(id("dense")))
      yield* failure(fence.mark(id("dense")))
      expect(yield* database.db.all(sql`SELECT * FROM review_memory_fence`)).toEqual([])
    }),
  )

  for (const table of ["review_memory_fence", "session_lineage", "session_audience"])
    it.effect(`missing ${table} is an explicit refusal rather than an empty clean history`, () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const fence = ReviewMemoryFence.make(database.db)
        yield* node(database.db, id("missing_schema"))
        yield* database.db.run(sql`DROP TABLE ${sql.identifier(table)}`)
        yield* failure(fence.requiresLease(id("missing_schema")))
        yield* failure(fence.mark(id("missing_schema")))
      }),
    )
})
