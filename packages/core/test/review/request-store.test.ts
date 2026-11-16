import { afterAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { eq, sql } from "drizzle-orm"
import { Effect, Result, Schema } from "effect"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { SessionID } from "@vectordevai/schema/session-id"
import { Database } from "../../src/database/database"
import { BackgroundJobStore } from "../../src/background-job-store"
import { ReviewRequestStore } from "../../src/review/request-store"
import { ReviewRequestTable } from "../../src/review/request.sql"
import { tmpdir } from "../fixture/tmpdir"
import { foreignReview } from "../fixture/review-deletion"

const parentID = SessionID.make("ses_request_store_parent")
const owner = BackgroundJobStore.open()
afterAll(() => BackgroundJobStore.close(owner))
const request: ReviewRun.Start = {
  requestID: "request_store_1",
  target: { kind: "working-tree", head: "a".repeat(40) },
}
const reply = Schema.Struct({
  claimed: Schema.Boolean,
  row: Schema.Struct({
    parentID: SessionID,
    ownerNonce: Schema.String,
    request: ReviewRun.Start,
    runID: Schema.optional(SessionID),
  }),
})
const seed = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  // Real project/session parents enforce the reservation's deletion boundary.
  yield* db.run(
    sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('request-store-project', '/review-request-fixture', '[]', 1, 1)`,
  )
  yield* db.run(
    sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${parentID}, 'request-store-project', 'request-fixture', '/review-request-fixture', 'Review owner', 'test', 1, 1)`,
  )
})

function processProbe(filename: string) {
  const probe = path.resolve(import.meta.dir, "../fixture/review-request-probe.ts")
  const child = spawn(process.execPath, [probe, filename, parentID, JSON.stringify(request)], {
    stdio: ["pipe", "pipe", "pipe"],
  })
  let output = ""
  let errors = ""
  let announced = false
  let announce: () => void = () => {}
  let refuse: (error: Error) => void = () => {}
  const ready = new Promise<void>((resolve, reject) => {
    announce = resolve
    refuse = reject
  })
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString()
    if (!announced && output.includes("READY\n")) {
      announced = true
      announce()
    }
  })
  child.stderr.on("data", (chunk: Buffer) => {
    errors = (errors + chunk.toString()).slice(-4000)
  })
  const done = new Promise<typeof reply.Type>((resolve, reject) => {
    child.once("error", (error) => {
      refuse(error)
      reject(error)
    })
    child.once("close", (code) => {
      if (code !== 0 || !announced) {
        const error = new Error(`Reservation probe exited ${code}: ${errors}`)
        refuse(error)
        reject(error)
        return
      }
      try {
        const line = output.split("\n").find((line) => line.startsWith("RESULT "))
        if (!line) throw new Error("Reservation probe did not return its result")
        resolve(Schema.decodeUnknownSync(reply)(JSON.parse(line.slice(7))))
      } catch (error) {
        reject(error)
      }
    })
  })
  // Install rejection handlers while the parent waits on both ready signals.
  void done.catch(() => {})
  return { ready, done, release: () => child.stdin.end("go\n"), stop: () => child.kill() }
}

describe("durable local review request admission", () => {
  test("a live foreign process prevents deletion, and its late launch remains denied after settlement and completed deletion", async () => {
    await using directory = await tmpdir()
    const filename = path.join(directory.path, "requests.sqlite")
    const runID = SessionID.make("ses_foreign_prepared_run")
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed
        yield* (yield* Database.Service).db.run(
          sql`INSERT INTO session (id, project_id, parent_id, internal, slug, directory, title, version, time_created, time_updated) VALUES (${runID}, 'request-store-project', ${parentID}, 'vectorscope.bound.run', 'foreign-run', '/review-request-fixture', 'Foreign review', 'test', 1, 1)`,
        )
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
    const foreign = foreignReview({ filename, parentID, request, runID })
    try {
      await foreign.ready
      const deletion = {
        sessionID: parentID,
        ownerNonce: randomUUID(),
        owner,
        localNonces: new Set<string>(),
        insideReview: false,
      }
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = ReviewRequestStore.make((yield* Database.Service).db)
          const denied = yield* store.beginDelete(deletion).pipe(Effect.result)
          expect(Result.isFailure(denied) && denied.failure.code).toBe("busy")
        }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
      )
      foreign.settle()
      await foreign.settled
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          expect(yield* ReviewRequestStore.make(db).beginDelete(deletion)).toEqual([])
          yield* db.run(sql`DELETE FROM session WHERE id = ${parentID}`)
        }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
      )
      foreign.late()
      expect(await foreign.done).toEqual({ lateAdmitted: false })
    } finally {
      foreign.stop()
    }
  }, 20_000)

  test("two processes on the same SQLite file grant only one immutable pending reservation", async () => {
    await using directory = await tmpdir()
    const filename = path.join(directory.path, "requests.sqlite")
    await Effect.runPromise(seed.pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped))
    const first = processProbe(filename)
    const second = processProbe(filename)
    try {
      await Promise.all([first.ready, second.ready])
      first.release()
      second.release()
      const results = await Promise.all([first.done, second.done])
      expect(results.filter((result) => result.claimed)).toHaveLength(1)
      expect(results[0].row).toEqual(results[1].row)
      expect(results[0].row.runID).toBeUndefined()
      expect(results[0].row.request).toEqual(request)
    } finally {
      first.stop()
      second.stop()
    }
  }, 20_000)

  test("pending crashes, mismatched requests and foreign attachment cannot replace or consume the winner", async () => {
    await using directory = await tmpdir()
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed
        const db = (yield* Database.Service).db
        const store = ReviewRequestStore.make(db)
        const ownerNonce = randomUUID()
        expect((yield* store.reserve({ owner, parentID, request, ownerNonce })).claimed).toBe(true)
        const before = yield* db.select().from(ReviewRequestTable).all().pipe(Effect.orDie)
        expect((yield* store.reserve({ owner, parentID, request, ownerNonce: randomUUID() })).claimed).toBe(false)
        const mismatched = yield* store
          .reserve({ owner, parentID, request: { ...request, maxCost: 0.1 }, ownerNonce: randomUUID() })
          .pipe(Effect.result)
        expect(Result.isFailure(mismatched) && mismatched.failure.code).toBe("conflict")
        expect(
          yield* store.attach({
            parentID,
            requestID: request.requestID,
            ownerNonce: randomUUID(),
            runID: SessionID.make("ses_foreign_attach"),
          }),
        ).toBe(false)
        expect(yield* db.select().from(ReviewRequestTable).all().pipe(Effect.orDie)).toEqual(before)
        const runID = SessionID.make("ses_reserved_run")
        yield* db.run(
          sql`INSERT INTO session (id, project_id, parent_id, internal, slug, directory, title, version, time_created, time_updated) VALUES (${runID}, 'request-store-project', ${parentID}, 'vectorscope.bound.run', 'run-fixture', '/review-request-fixture', 'Review run', 'test', 1, 1)`,
        )
        expect(yield* store.attach({ parentID, requestID: request.requestID, ownerNonce, runID })).toBe(true)
        expect(
          yield* store.attach({
            parentID,
            requestID: request.requestID,
            ownerNonce,
            runID: SessionID.make("ses_replacement_run"),
          }),
        ).toBe(false)
        expect((yield* store.reserve({ owner, parentID, request, ownerNonce: randomUUID() })).row.runID).toBe(runID)
        // Removing a result is not authority to reuse its paid retry key. Only
        // deleting the parent erases its request namespace via the foreign key.
        yield* db.run(sql`DELETE FROM session WHERE id = ${parentID}`)
        expect(yield* db.select().from(ReviewRequestTable).all().pipe(Effect.orDie)).toEqual([])
      }).pipe(Effect.provide(Database.layerFromPath(path.join(directory.path, "requests.sqlite"))), Effect.scoped),
    )
  })

  test("the request cap counts crashed pending claims while exact retries remain readable", async () => {
    await using directory = await tmpdir()
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed
        const db = (yield* Database.Service).db
        const store = ReviewRequestStore.make(db)
        yield* db
          .insert(ReviewRequestTable)
          .values(
            Array.from({ length: 1000 }, (_, n) => ({
              parent_session_id: parentID,
              request_id: `request_cap_${n}`,
              owner_nonce: randomUUID(),
              owner,
              phase: "reserved" as const,
              request: { ...request, requestID: `request_cap_${n}` },
              time_created: 1,
            })),
          )
          .run()
          .pipe(Effect.orDie)
        const refused = yield* store.reserve({ owner, parentID, request, ownerNonce: randomUUID() }).pipe(Effect.result)
        expect(Result.isFailure(refused) && refused.failure.code).toBe("unavailable")
        expect(
          (yield* store.reserve({
            owner,
            parentID,
            request: { ...request, requestID: "request_cap_0" },
            ownerNonce: randomUUID(),
          })).claimed,
        ).toBe(false)
        expect(
          yield* db
            .select({ count: sql<number>`count(*)` })
            .from(ReviewRequestTable)
            .where(eq(ReviewRequestTable.parent_session_id, parentID))
            .get()
            .pipe(Effect.orDie),
        ).toEqual({ count: 1000 })
      }).pipe(Effect.provide(Database.layerFromPath(path.join(directory.path, "requests.sqlite"))), Effect.scoped),
    )
  })

  test("a durable closing fence denies late attach and launch, and foreign or reentrant deletion cannot alter live work", async () => {
    await using directory = await tmpdir()
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed
        const db = (yield* Database.Service).db
        const store = ReviewRequestStore.make(db)
        const ownerNonce = randomUUID()
        const runID = SessionID.make("ses_closing_fence_run")
        const identity = { parentID, requestID: request.requestID, ownerNonce, runID }
        yield* store.reserve({ owner, parentID, request, ownerNonce })
        yield* db.run(
          sql`INSERT INTO session (id, project_id, parent_id, internal, slug, directory, title, version, time_created, time_updated) VALUES (${runID}, 'request-store-project', ${parentID}, 'vectorscope.bound.run', 'closing-run', '/review-request-fixture', 'Review run', 'test', 1, 1)`,
        )
        const deletion = {
          sessionID: parentID,
          ownerNonce: randomUUID(),
          owner,
          localNonces: new Set([ownerNonce]),
          insideReview: false,
        }
        expect(yield* store.beginDelete(deletion)).toEqual([ownerNonce])
        expect(yield* store.attach(identity)).toBe(false)
        expect(yield* store.ready(identity)).toBe(false)
        expect(yield* store.begin(identity)).toBe(false)
        const denied = yield* store
          .reserve({
            owner,
            parentID,
            request: { ...request, requestID: "request_during_close" },
            ownerNonce: randomUUID(),
          })
          .pipe(Effect.result)
        expect(Result.isFailure(denied) && denied.failure.code).toBe("unavailable")
        yield* store.endDelete(parentID, randomUUID())
        expect(yield* store.attach(identity)).toBe(false)
        yield* store.endDelete(parentID, deletion.ownerNonce)
        expect(yield* store.attach(identity)).toBe(true)
        expect(yield* store.ready(identity)).toBe(true)
        expect(yield* store.begin(identity)).toBe(true)
        for (const input of [
          { ...deletion, localNonces: new Set<string>() },
          { ...deletion, insideReview: true },
        ]) {
          const refused = yield* store.beginDelete(input).pipe(Effect.result)
          expect(Result.isFailure(refused) && refused.failure.code).toBe("busy")
        }
        expect((yield* db.select().from(ReviewRequestTable).get().pipe(Effect.orDie))?.phase).toBe("running")
        const unknown = { ...owner, runtime: `${randomUUID()}:${randomUUID()}`, machine: randomUUID() }
        expect(BackgroundJobStore.alive(unknown)).toBe("unknown")
        yield* db.update(ReviewRequestTable).set({ owner: unknown }).run().pipe(Effect.orDie)
        const refusedUnknown = yield* store.beginDelete({ ...deletion, localNonces: new Set() }).pipe(Effect.result)
        expect(Result.isFailure(refusedUnknown) && refusedUnknown.failure.code).toBe("busy")
        yield* store.finish(identity)
        expect(yield* store.beginDelete({ ...deletion, localNonces: new Set() })).toEqual([])
        yield* db.run(sql`DELETE FROM session WHERE id = ${parentID}`)
        expect(yield* store.begin(identity)).toBe(false)
      }).pipe(Effect.provide(Database.layerFromPath(path.join(directory.path, "requests.sqlite"))), Effect.scoped),
    )
  })
})
