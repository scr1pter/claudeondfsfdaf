import { afterAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { Effect, Option, Result, Schema } from "effect"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { SessionID } from "@vectordevai/schema/session-id"
import { BackgroundJobStore } from "../../src/background-job-store"
import { Database } from "../../src/database/database"
import { ReviewRequestStore } from "../../src/review/request-store"
import { ReviewRequestTable } from "../../src/review/request.sql"
import { ReviewSourceBinding } from "../../src/review/source-binding"

const parentID = SessionID.make("ses_scope_binding_parent")
const runID = SessionID.make("ses_scope_binding_run")
const owner = BackgroundJobStore.open()
afterAll(() => BackgroundJobStore.close(owner))
const request: ReviewRun.Start = {
  requestID: "source_binding_1",
  target: { kind: "working-tree", head: "a".repeat(40) },
}
// Trusted storage fixtures only: Engine tests separately prove physical derivation.
const binding = () =>
  ({
    version: 1,
    scope: `vrs1_${"a".repeat(64)}`,
    directory: "/scope-binding",
    worktree: "/scope-binding",
    gitDirectory: "/scope-binding/.git",
    commonDirectory: "/scope-binding/.git",
    commonIdentity: { dev: "1", ino: "2", birth: "3" },
  }) satisfies ReviewSourceBinding.Info
const fixture = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  yield* db.run(
    sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('scope-binding', '/scope-binding', '[]', 1, 1)`,
  )
  yield* db.run(
    sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${parentID}, 'scope-binding', 'parent', '/scope-binding', 'Owner', 'test', 1, 1)`,
  )
  yield* db.run(
    sql`INSERT INTO session (id, project_id, parent_id, internal, slug, directory, title, version, time_created, time_updated) VALUES (${runID}, 'scope-binding', ${parentID}, 'vectorscope.bound.run', 'review', '/scope-binding', 'Review', 'test', 1, 1)`,
  )
  return {
    db,
    store: ReviewRequestStore.make(db),
    identity: { parentID, runID, requestID: request.requestID, ownerNonce: randomUUID() },
  }
})
const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped))

describe("private immutable winning review source binding", () => {
  test("a public Start cannot supply physical scope authority, and malformed private bindings refuse", () => {
    expect(Option.isSome(Schema.decodeUnknownOption(ReviewSourceBinding.Info)(binding()))).toBe(true)
    for (const field of ["scope", "source_binding", "sourceBinding"]) {
      expect(Option.isNone(Schema.decodeUnknownOption(ReviewRun.Start)({ ...request, [field]: binding() }))).toBe(true)
    }
    for (const malformed of [
      undefined,
      null,
      {},
      { ...binding(), scope: "remote-or-root-claim" },
      { ...binding(), commonIdentity: { dev: "1", ino: "0", birth: "0" } },
      { ...binding(), owner: true },
    ])
      expect(Option.isNone(Schema.decodeUnknownOption(ReviewSourceBinding.Info)(malformed))).toBe(true)
  })

  test("only the winning admission captures a copied binding; retry and attachment never relabel it", async () => {
    await run(
      Effect.gen(function* () {
        const { db, store, identity } = yield* fixture
        const original = binding()
        const first = yield* store.reserve({ ...identity, request, owner, sourceBinding: original })
        expect(first.claimed).toBe(true)
        const pair = first.row.sourceBinding?.witnesses
        if (!pair) throw new Error("The winning private reservation has no witnesses")
        expect(Schema.is(ReviewSourceBinding.Witnesses)(pair)).toBe(true)
        expect(pair.parent).not.toBe(pair.review)
        const expected = { ...structuredClone(original), witnesses: pair }
        expect(first.row.sourceBinding).toEqual(expected)
        original.commonIdentity.ino = "999"
        original.scope = `vrs1_${"b".repeat(64)}`
        expect(yield* store.attach(identity)).toBe(true)
        expect(yield* store.begin(identity)).toBe(true)
        const before = yield* db.select().from(ReviewRequestTable).all()
        const retry = yield* store.reserve({
          parentID,
          request,
          owner,
          ownerNonce: randomUUID(),
          sourceBinding: original,
        })
        expect(retry.claimed).toBe(false)
        expect(retry.row.sourceBinding).toEqual(expected)
        expect((yield* store.sourceSnapshot(parentID, runID))?.sourceBinding).toEqual(expected)
        expect(yield* db.select().from(ReviewRequestTable).all()).toEqual(before)
      }),
    )
  })

  test("public requests cannot choose witness IDs and private admission cannot reuse supplied pairs", async () => {
    await run(
      Effect.gen(function* () {
        const { db, store, identity } = yield* fixture
        const pair: ReviewSourceBinding.Witnesses = {
          version: 1,
          parent: `vrw1_${"1".repeat(32)}`,
          review: `vrw1_${"2".repeat(32)}`,
        }
        expect(Option.isNone(Schema.decodeUnknownOption(ReviewRun.Start)({ ...request, witnesses: pair }))).toBe(true)
        for (const invalid of [
          { ...pair, review: pair.parent },
          { ...pair, parent: pair.parent.toUpperCase() },
          { ...pair, approved: true },
        ])
          expect(Option.isNone(Schema.decodeUnknownOption(ReviewSourceBinding.Witnesses)(invalid))).toBe(true)
        const before = yield* db.select().from(ReviewRequestTable)
        const refused = yield* store
          .reserve({ ...identity, request, owner, sourceBinding: { ...binding(), witnesses: pair } })
          .pipe(Effect.result)
        expect(Result.isFailure(refused) && refused.failure.code).toBe("invalid")
        expect(yield* db.select().from(ReviewRequestTable)).toEqual(before)
      }),
    )
  })

  test("a legacy reservation remains unbound despite a new-engine retry, while corrupt persisted bindings fail without mutation", async () => {
    await run(
      Effect.gen(function* () {
        const { db, store, identity } = yield* fixture
        expect((yield* store.reserve({ ...identity, request, owner })).claimed).toBe(true)
        yield* store.attach(identity)
        yield* store.begin(identity)
        const before = yield* db.select().from(ReviewRequestTable).all()
        const retry = yield* store.reserve({
          parentID,
          request,
          owner,
          ownerNonce: randomUUID(),
          sourceBinding: binding(),
        })
        expect(retry.row.sourceBinding).toBeUndefined()
        expect((yield* store.sourceSnapshot(parentID, runID))?.sourceBinding).toBeUndefined()
        expect(yield* db.select().from(ReviewRequestTable).all()).toEqual(before)
        yield* db.run(sql`UPDATE review_request SET source_binding = '{"version":1,"scope":"untrusted"}'`)
        const corrupt = yield* db.select().from(ReviewRequestTable).all()
        const source = yield* store.sourceSnapshot(parentID, runID).pipe(Effect.result)
        expect(Result.isFailure(source) && source.failure.code).toBe("corrupt")
        expect(yield* db.select().from(ReviewRequestTable).all()).toEqual(corrupt)
      }),
    )
  })
})
