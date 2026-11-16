import { afterAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { Effect, Result } from "effect"
import { SessionID } from "@vectordevai/schema/session-id"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { BackgroundJobStore } from "../../src/background-job-store"
import { Database } from "../../src/database/database"
import { Project } from "../../src/project"
import { ReviewRequestStore } from "../../src/review/request-store"
import { ReviewRequestTable, ReviewSessionFenceTable } from "../../src/review/request.sql"
import { SessionTable } from "../../src/session/sql"

const parentID = SessionID.make("ses_memory_source_parent")
const runID = SessionID.make("ses_memory_source_review")
const request: ReviewRun.Start = {
  requestID: "memory_source_1",
  target: { kind: "working-tree", head: "a".repeat(40) },
}
const owner = BackgroundJobStore.open()
afterAll(() => BackgroundJobStore.close(owner))
const fixture = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  yield* db.run(
    sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('memory-source', '/memory-source', '[]', 1, 1)`,
  )
  yield* db.run(
    sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${parentID}, 'memory-source', 'parent', '/memory-source', 'Owner', 'test', 1, 1)`,
  )
  yield* db.run(
    sql`INSERT INTO session (id, project_id, parent_id, internal, slug, directory, title, version, time_created, time_updated) VALUES (${runID}, 'memory-source', ${parentID}, 'vectorscope.bound.run', 'run', '/memory-source', 'Review', 'test', 1, 1)`,
  )
  const store = ReviewRequestStore.make(db)
  const identity = { parentID, runID, requestID: request.requestID, ownerNonce: randomUUID() }
  yield* store.reserve({ ...identity, request, owner })
  expect(yield* store.attach(identity)).toBe(true)
  return { db, store, identity }
})
const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped))

describe("review source metadata and durable deletion fence", () => {
  test("only actual running/settled reservations expose immutable source metadata, without changing any rows", async () => {
    await run(
      Effect.gen(function* () {
        const { db, store, identity } = yield* fixture
        expect(yield* store.sourceSnapshot(parentID, runID)).toBeUndefined()
        expect(yield* store.ready(identity)).toBe(true)
        expect(yield* store.begin(identity)).toBe(true)
        const before = yield* db.select().from(ReviewRequestTable).all()
        expect(yield* store.sourceSnapshot(parentID, runID)).toEqual({ request, phase: "running" })
        expect(yield* db.select().from(ReviewRequestTable).all()).toEqual(before)
        expect(yield* db.select().from(ReviewSessionFenceTable).all()).toEqual([])
        yield* store.finish(identity)
        expect(yield* store.sourceSnapshot(parentID, runID)).toEqual({ request, phase: "settled" })
      }),
    )
  })

  test("both parent and review closing fences retire source authority and only the exact closer sees deletion metadata", async () => {
    await run(
      Effect.gen(function* () {
        const { db, store, identity } = yield* fixture
        yield* store.ready(identity)
        yield* store.begin(identity)
        yield* store.finish(identity)
        for (const sessionID of [parentID, runID]) {
          const ownerNonce = randomUUID()
          expect(yield* store.closingSnapshot(sessionID, ownerNonce)).toBeUndefined()
          yield* store.beginDelete({ sessionID, ownerNonce, owner, localNonces: new Set(), insideReview: false })
          expect(yield* store.sourceSnapshot(parentID, runID)).toBeUndefined()
          const before = yield* db.select().from(ReviewSessionFenceTable).all()
          expect(yield* store.closingSnapshot(sessionID, randomUUID())).toBeUndefined()
          expect(yield* store.closingSnapshot(sessionID, ownerNonce)).toEqual({
            repository: Project.ID.make("memory-source"),
            directory: "/memory-source",
          })
          expect(yield* db.select().from(ReviewSessionFenceTable).all()).toEqual(before)
          yield* store.endDelete(sessionID, ownerNonce)
        }
        yield* db.delete(SessionTable).where(eq(SessionTable.id, parentID)).run()
        expect(yield* store.sourceSnapshot(parentID, runID)).toBeUndefined()
      }),
    )
  })

  test("forged lineage, hidden markers and malformed retained requests cannot become source authority", async () => {
    await run(
      Effect.gen(function* () {
        const { db, store, identity } = yield* fixture
        yield* store.ready(identity)
        yield* store.begin(identity)
        yield* db.update(SessionTable).set({ internal: "other-helper" }).where(eq(SessionTable.id, runID)).run()
        expect(yield* store.sourceSnapshot(parentID, runID)).toBeUndefined()
        yield* db
          .update(SessionTable)
          .set({ internal: "vectorscope.bound.run", parent_id: null })
          .where(eq(SessionTable.id, runID))
          .run()
        expect(yield* store.sourceSnapshot(parentID, runID)).toBeUndefined()
        yield* db.update(SessionTable).set({ parent_id: parentID }).where(eq(SessionTable.id, runID)).run()
        yield* db.run(
          sql`UPDATE review_request SET request = '{"requestID":"memory_source_1","target":{"kind":"working-tree","head":"bad"}}'`,
        )
        const before = yield* db.select().from(ReviewRequestTable).all()
        const result = yield* store.sourceSnapshot(parentID, runID).pipe(Effect.result)
        expect(Result.isFailure(result) && result.failure.code).toBe("corrupt")
        expect(yield* db.select().from(ReviewRequestTable).all()).toEqual(before)
      }),
    )
  })

  test("actual query failures refuse metadata without granting authority or changing session rows", async () => {
    await run(
      Effect.gen(function* () {
        const { db, store, identity } = yield* fixture
        yield* store.begin(identity)
        const before = yield* db.select().from(SessionTable).all()
        yield* db.run(sql`DROP TABLE review_request`)
        const source = yield* store.sourceSnapshot(parentID, runID).pipe(Effect.result)
        expect(Result.isFailure(source) && source.failure.code).toBe("unavailable")
        yield* db.run(sql`DROP TABLE review_session_fence`)
        const closing = yield* store.closingSnapshot(parentID, randomUUID()).pipe(Effect.result)
        expect(Result.isFailure(closing) && closing.failure.code).toBe("unavailable")
        expect(yield* db.select().from(SessionTable).all()).toEqual(before)
      }),
    )
  })
})
