import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import { SessionID } from "@vectordevai/schema/session-id"
import { BackgroundJobStore } from "../../src/background-job-store"
import { Brain } from "../../src/brain/brain"
import { BrainDatabase } from "../../src/brain/database"
import { BrainLexical } from "../../src/brain/lexical"
import { ReviewMemory } from "../../src/brain/review-memory"
import { ReviewStore } from "../../src/brain/review-store"
import { ReviewWitness } from "../../src/brain/review-witness"
import {
  BrainEntryTable,
  BrainEvidenceTable,
  BrainEventTable,
  BrainReviewMemorySourceTable,
  BrainReviewMemoryTable,
  BrainTombstoneTable,
  BrainUseTable,
} from "../../src/brain/sql"
import { Database } from "../../src/database/database"
import { Global } from "../../src/global"
import { PINNED_SESSION_PREFIX } from "../../src/review/prompt"
import { ReviewRequestStore } from "../../src/review/request-store"
import { tmpdir } from "../fixture/tmpdir"

const place: ReviewMemory.Place = {
  repository: "witness_repo",
  scope: `vrs1_${"a".repeat(64)}`,
  root: "",
  sources: [],
  held: false,
}
const source: ReviewMemory.Source = {
  parentID: "ses_witness_parent",
  reviewID: "ses_witness_review",
  head: "a".repeat(40),
}
const draft: ReviewMemory.Draft = {
  kind: "outcome",
  text: "Return before the optional lookup.",
  reason: "Confirmed for this finding only.",
  paths: ["src/a.ts"],
  citations: [{ path: "src/a.ts", line: 1, head: source.head, quote: "return []" }],
  visibility: "repository",
}
function value<A>(result: ReviewMemory.Result<A>): A {
  if (!result.ok) throw new Error(result.reason)
  return result.value
}

// These are actual Main reservations, but the physical/authentication port is a
// trusted Core fixture. Production Engine placement/latch/cancellation is a later gate.
async function run<A>(
  body: (setup: {
    brain: Brain.Interface
    memory: ReviewMemory.Interface
    db: BrainDatabase.Database
    selected: { proof?: ReviewWitness.Proof }
    register: () => Effect.Effect<boolean>
    admit: (reviewID?: string) => Effect.Effect<ReviewWitness.Proof, unknown>
    enable: () => Effect.Effect<ReviewMemory.State>
  }) => Effect.Effect<A, unknown>,
) {
  await using tmp = await tmpdir()
  const selected: { proof?: ReviewWitness.Proof } = {}
  const owner = BackgroundJobStore.open()
  const authority: ReviewMemory.Authority = {
    owner: (_request, use) => use("fixture_owner"),
    source: (request, use) => {
      const proof = selected.proof
      return proof &&
        request.repository === proof.repository &&
        request.scope === proof.scope &&
        request.parentID === proof.parentID &&
        request.reviewID === proof.reviewID &&
        request.head === proof.head
        ? use(proof)
        : Effect.succeed({ ok: false, reason: "source-unavailable" })
    },
  }
  const layer = Layer.mergeAll(Brain.layer, ReviewMemory.layerWith(authority), Database.layerFromPath(":memory:")).pipe(
    Layer.provideMerge(BrainDatabase.layerFor(":memory:")),
    Layer.provide(
      Layer.succeed(
        Global.Service,
        Global.make({ config: path.join(tmp.path, "config"), data: path.join(tmp.path, "data") }),
      ),
    ),
  )
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* BrainDatabase.Service).db
        const main = (yield* Database.Service).db
        const requests = ReviewRequestStore.make(main)
        const brain = yield* Brain.Service
        const memory = yield* ReviewMemory.Service
        yield* main.run(
          sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES (${place.repository}, '/witness-fixture', '[]', 1, 1)`,
        )
        yield* main.run(
          sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${source.parentID}, ${place.repository}, 'parent', '/witness-fixture', 'Owner', 'test', 1, 1)`,
        )
        const admit = (reviewID = source.reviewID) =>
          Effect.gen(function* () {
            yield* main.run(
              sql`INSERT INTO session (id, project_id, parent_id, internal, slug, directory, title, version, time_created, time_updated) VALUES (${reviewID}, ${place.repository}, ${source.parentID}, ${`${PINNED_SESSION_PREFIX}run`}, ${reviewID}, '/witness-fixture', 'Review', 'test', 1, 1)`,
            )
            const identity = {
              parentID: SessionID.make(source.parentID),
              runID: SessionID.make(reviewID),
              requestID: `request_${reviewID}`,
              ownerNonce: randomUUID(),
            }
            const first = yield* requests.reserve({
              ...identity,
              owner,
              request: { requestID: identity.requestID, target: { kind: "working-tree", head: source.head } },
              sourceBinding: {
                version: 1,
                scope: place.scope,
                directory: "/witness-fixture",
                worktree: "/witness-fixture",
                gitDirectory: "/witness-fixture/.git",
                commonDirectory: "/witness-fixture/.git",
                commonIdentity: { dev: "1", ino: "2", birth: "3" },
              },
            })
            const witnesses = first.row.sourceBinding?.witnesses
            if (!first.claimed || !witnesses || !(yield* requests.attach(identity)))
              throw new Error("No genuine winning Main source")
            const proof = ReviewWitness.proof({
              repository: place.repository,
              scope: place.scope,
              parentID: source.parentID,
              reviewID,
              head: source.head,
              witnesses,
            })
            if (!proof) throw new Error("No canonical private witness proof")
            selected.proof = proof
            return proof
          })
        yield* admit()
        const enable = () =>
          Effect.gen(function* () {
            const before = value(yield* memory.inspect(place))
            return value(yield* memory.configure(place, { expected: before.generation, enabled: true }))
          })
        return yield* body({
          brain,
          memory,
          db,
          selected,
          admit,
          enable,
          register: () => {
            if (!selected.proof) return Effect.succeed(false)
            return ReviewStore.registerSource(db, selected.proof)
          },
        })
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
  } finally {
    BackgroundJobStore.close(owner)
  }
}

// Exact older primitive's selection/sole-session/tombstone steps, pinned at
// 50d9dac7b /8b5975be4. It deliberately has NO new ReviewStore erasure hook.
// This qualifies SQLite compatibility with that primitive, not an old executable.
const oldErase = Effect.fnUntraced(function* (db: BrainDatabase.Database, sessionID: string) {
  const rows = yield* db
    .select()
    .from(BrainEntryTable)
    .where(
      and(
        inArray(BrainEntryTable.repository_id, [place.repository, ""]),
        eq(BrainEntryTable.origin, "agent"),
        inArray(
          BrainEntryTable.id,
          db
            .select({ id: BrainEvidenceTable.entry_id })
            .from(BrainEvidenceTable)
            .where(eq(BrainEvidenceTable.session_id, sessionID)),
        ),
      ),
    )
    .all()
  const others = rows.length
    ? new Set(
        (yield* db
          .selectDistinct({ id: BrainEvidenceTable.entry_id })
          .from(BrainEvidenceTable)
          .where(
            and(
              inArray(
                BrainEvidenceTable.entry_id,
                rows.map((row) => row.id),
              ),
              or(isNull(BrainEvidenceTable.session_id), ne(BrainEvidenceTable.session_id, sessionID)),
            ),
          )
          .all()).map((row) => row.id),
      )
    : new Set<string>()
  const only = rows.filter((row) => !others.has(row.id))
  for (const row of only)
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.delete(BrainEntryTable).where(eq(BrainEntryTable.id, row.id)).run()
        yield* tx
          .insert(BrainTombstoneTable)
          .values({
            repository_id: row.repository_id,
            norm_hash: row.norm_hash,
            terms: row.terms,
            polarity: BrainLexical.polarity(row.body),
            until: Date.now() + 180 * 86_400_000,
          })
          .onConflictDoUpdate({
            target: [BrainTombstoneTable.repository_id, BrainTombstoneTable.norm_hash],
            set: { until: Date.now() + 180 * 86_400_000 },
          })
          .run()
        yield* tx.delete(BrainUseTable).where(eq(BrainUseTable.entry_id, row.id)).run()
        yield* tx.delete(BrainEventTable).where(eq(BrainEventTable.entry_id, row.id)).run()
        yield* tx
          .insert(BrainEventTable)
          .values({
            entry_id: row.id,
            repository_id: row.repository_id,
            at: Date.now(),
            action: "forgotten",
            actor: "user",
          })
          .run()
      }),
    )
  return only.length
})

describe("private early review source witnesses, actual Main and Brain SQLite", () => {
  test("two sole-session markers are hidden and quota-neutral, with tombstones harmless to ordinary learning", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        yield* setup.enable()
        const before = yield* setup.brain.digest(place, { personal: true, index: true })
        expect(yield* setup.register()).toBe(true)
        const proof = setup.selected.proof
        if (!proof) throw new Error("Missing private proof")
        const entries = yield* setup.db.select().from(BrainEntryTable)
        expect(entries).toHaveLength(2)
        expect(ReviewWitness.BODY.length).toBe(319)
        expect(BrainLexical.polarity(ReviewWitness.BODY).split(" ")).toHaveLength(64)
        const evidence = yield* setup.db.select().from(BrainEvidenceTable)
        expect(evidence.map((row) => [row.session_id, row.created_at]).toSorted()).toEqual(
          [
            [source.parentID, -1],
            [source.reviewID, -1],
          ].toSorted(),
        )
        expect(yield* setup.brain.written(source.parentID, 0)).toBe(0)
        expect(yield* setup.brain.written(source.reviewID, Date.now())).toBe(0)
        expect(yield* setup.brain.list(place, { filter: "all" })).toEqual([])
        for (const id of [proof.witnesses.parent, proof.witnesses.review])
          expect(yield* setup.brain.get(place, id, { personal: true })).toBeUndefined()
        expect((yield* setup.brain.digest(place, { personal: true, index: true })).text).toBe(before.text)
        expect(yield* oldErase(setup.db, source.reviewID)).toBe(1)
        for (const text of ["OK!", "the and or", "only", "Prefer a narrow return guard."]) {
          const result = yield* setup.brain.propose(place, {
            kind: "fact",
            origin: "agent",
            scope: "repository",
            text,
            sessionID: "ses_other",
          })
          expect(result.type).toBe("added")
        }
      }),
    )
  })

  for (const sessionID of [source.parentID, source.reviewID])
    test(`legacy forget ${sessionID} retires a zero-row source once and cannot be healed by reads or later enable`, async () => {
      await run((setup) =>
        Effect.gen(function* () {
          yield* setup.enable()
          expect(yield* setup.register()).toBe(true)
          const before = value(yield* setup.memory.context(place, { source, files: ["src/a.ts"] }))
          expect(value(yield* setup.memory.current(place, { source, generation: before.generation }))).toBe(true)
          expect(yield* oldErase(setup.db, sessionID)).toBe(1)
          expect(yield* setup.memory.current(place, { source, generation: before.generation })).toEqual({
            ok: false,
            reason: "source-unavailable",
          })
          const after = value(yield* setup.memory.inspect(place))
          expect(after.enabled).toBe(true)
          expect(after.generation).toBeGreaterThan(before.generation)
          expect((yield* setup.db.select().from(BrainReviewMemorySourceTable))[0].state).toBe("retired")
          expect(yield* setup.memory.context(place, { source, files: ["src/a.ts"] })).toEqual({
            ok: false,
            reason: "source-unavailable",
          })
          expect(value(yield* setup.memory.inspect(place)).generation).toBe(after.generation)
          yield* setup.enable()
          expect(yield* setup.register()).toBe(false)
          expect(yield* setup.memory.propose(place, { ...draft, source, expected: after.generation })).toEqual({
            ok: false,
            reason: "source-unavailable",
          })
        }),
      )
    })

  test("a fresh review cannot expose forgotten producing rows; independent owner notes remain", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        const state = yield* setup.enable()
        expect(yield* setup.register()).toBe(true)
        const owner = value(yield* setup.memory.record(place, { ...draft, kind: "check", expected: state.generation }))
        const next = value(yield* setup.memory.inspect(place))
        const pending = value(yield* setup.memory.propose(place, { ...draft, source, expected: next.generation }))
        const approved = value(yield* setup.memory.inspect(place))
        value(yield* setup.memory.approve(place, { expected: approved.generation, id: pending.id }))
        expect(value(yield* setup.memory.context(place, { source, files: ["src/a.ts"] })).entries).toHaveLength(2)
        expect(yield* oldErase(setup.db, source.parentID)).toBe(1)
        const fresh = yield* setup.admit("ses_witness_fresh")
        expect(yield* setup.register()).toBe(true)
        const visible = value(
          yield* setup.memory.context(place, {
            source: { parentID: fresh.parentID, reviewID: fresh.reviewID, head: fresh.head },
            files: ["src/a.ts"],
          }),
        )
        expect(visible.entries.map((entry) => entry.id)).toEqual([owner.id])
        expect((yield* setup.db.select().from(BrainReviewMemoryTable)).map((row) => row.id)).toEqual([owner.id])
      }),
    )
  })

  test("default-off and unwitnessed old rows never gain source authority from owner enabling", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        expect(yield* setup.register()).toBe(false)
        const state = yield* setup.enable()
        expect(yield* setup.memory.context(place, { source, files: ["src/a.ts"] })).toEqual({
          ok: false,
          reason: "source-unavailable",
        })
        const own = value(yield* setup.memory.record(place, { ...draft, kind: "check", expected: state.generation }))
        const row = (yield* setup.db.select().from(BrainReviewMemoryTable))[0]
        if (!row) throw new Error("Missing owner row")
        yield* setup.db
          .insert(BrainReviewMemoryTable)
          .values({
            ...row,
            id: "legacy_review_row",
            origin: "review",
            parent_session_id: source.parentID,
            review_session_id: source.reviewID,
            source_head: source.head,
          })
          .run()
        const visible = value(yield* setup.memory.inspect(place))
        expect(visible.entries.map((entry) => entry.id)).toEqual([own.id])
        expect(visible.generation).toBeGreaterThan(state.generation)
        // Actual production only the new first winner may call registration: this old run is deliberately not retried.
        expect(yield* setup.db.select().from(BrainReviewMemorySourceTable)).toEqual([])
      }),
    )
  })

  for (const mode of ["missing", "extra-session", "null-session", "retarget", "metadata"] as const)
    test(`${mode} marker mutation refuses without a clean context`, async () => {
      await run((setup) =>
        Effect.gen(function* () {
          yield* setup.enable()
          expect(yield* setup.register()).toBe(true)
          const proof = setup.selected.proof
          if (!proof) throw new Error("Missing proof")
          if (mode === "missing")
            yield* setup.db.delete(BrainEntryTable).where(eq(BrainEntryTable.id, proof.witnesses.parent)).run()
          if (mode === "extra-session" || mode === "null-session")
            yield* setup.db
              .insert(BrainEvidenceTable)
              .values({
                entry_id: proof.witnesses.parent,
                type: "message",
                session_id: mode === "null-session" ? null : "ses_other",
                created_at: -1,
              })
              .run()
          if (mode === "retarget")
            yield* setup.db
              .update(BrainReviewMemorySourceTable)
              .set({ source_head: "b".repeat(40) })
              .run()
          if (mode === "metadata")
            yield* setup.db
              .update(BrainEntryTable)
              .set({ body: "only" })
              .where(eq(BrainEntryTable.id, proof.witnesses.parent))
              .run()
          expect(yield* setup.memory.context(place, { source, files: ["src/a.ts"] })).toEqual({
            ok: false,
            reason: "source-unavailable",
          })
          expect((yield* setup.db.select().from(BrainReviewMemorySourceTable))[0].state).toBe("retired")
          expect(yield* setup.memory.propose(place, { ...draft, source, expected: 0 })).toEqual({
            ok: false,
            reason: "source-unavailable",
          })
        }),
      )
    })

  test("registration rolls back as a pair and never overwrites an existing or cross-role source", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        yield* setup.enable()
        const proof = setup.selected.proof
        if (!proof) throw new Error("Missing proof")
        const failed = yield* setup.db
          .transaction((tx) =>
            Effect.gen(function* () {
              expect(yield* ReviewWitness.register(tx, proof)).toBe(true)
              return yield* Effect.fail("fixture_abort")
            }),
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(failed)).toBe(true)
        expect(yield* setup.db.select().from(BrainEntryTable)).toEqual([])
        expect(yield* setup.db.select().from(BrainEvidenceTable)).toEqual([])
        expect(yield* setup.db.select().from(BrainReviewMemorySourceTable)).toEqual([])
        // Storage rollback is exercised independently; Engine retry non-takeover is qualified separately.
        expect(yield* setup.register()).toBe(true)
        expect(yield* setup.register()).toBe(false)
        const changed = {
          ...proof,
          reviewID: "ses_cross_role",
          witnesses: { ...proof.witnesses, parent: proof.witnesses.review, review: `vrw1_${"f".repeat(32)}` },
        }
        expect(yield* ReviewStore.registerSource(setup.db, changed)).toBe(false)
        expect(yield* setup.db.select().from(BrainEntryTable)).toHaveLength(2)
      }),
    )
  })

  test("noncanonical stored Boolean2 refuses each fixed marker flag even though Drizzle decodes it as false", async () => {
    for (const field of ["pinned", "tier0", "private", "stale"] as const)
      await run((setup) =>
        Effect.gen(function* () {
          yield* setup.enable()
          expect(yield* setup.register()).toBe(true)
          const proof = setup.selected.proof
          if (!proof) throw new Error("Missing proof")
          yield* setup.db.run(
            sql`UPDATE brain_entry SET ${sql.identifier(field)} = 2 WHERE id = ${proof.witnesses.parent}`,
          )
          const decoded = yield* setup.db
            .select()
            .from(BrainEntryTable)
            .where(eq(BrainEntryTable.id, proof.witnesses.parent))
            .get()
          if (!decoded) throw new Error("Missing marker")
          expect(decoded[field]).toBe(false)
          expect(yield* setup.memory.context(place, { source, files: ["src/a.ts"] })).toEqual({
            ok: false,
            reason: "source-unavailable",
          })
          expect((yield* setup.db.select().from(BrainReviewMemorySourceTable))[0].state).toBe("retired")
        }),
      )
  })

  test("session deletion covers zero-row sources; explicit namespace erase removes only its owned private pair", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        yield* setup.enable()
        expect(yield* setup.register()).toBe(true)
        expect(yield* setup.brain.eraseSession(place, source.reviewID)).toBe(0)
        expect(yield* setup.db.select().from(BrainEntryTable)).toEqual([])
        expect((yield* setup.db.select().from(BrainReviewMemorySourceTable))[0].state).toBe("retired")
        yield* setup.admit("ses_namespace_fresh")
        expect(yield* setup.register()).toBe(true)
        const state = value(yield* setup.memory.inspect(place))
        value(yield* setup.memory.erase(place, { expected: state.generation }))
        expect(yield* setup.db.select().from(BrainEntryTable)).toEqual([])
        expect(yield* setup.db.select().from(BrainReviewMemorySourceTable)).toEqual([])
      }),
    )
  })

  test("ordinary active/archive caps and forced aging do not count or prune private source metadata", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        yield* setup.enable()
        expect(yield* setup.register()).toBe(true)
        const proof = setup.selected.proof
        if (!proof) throw new Error("Missing proof")
        const saved = yield* setup.brain.propose(place, {
          kind: "fact",
          origin: "user",
          scope: "repository",
          text: "Keep the fixture guards explicit.",
          evidence: { type: "user" },
        })
        if (saved.type !== "added") throw new Error("Missing ordinary control")
        const ordinary = yield* setup.db
          .select()
          .from(BrainEntryTable)
          .where(eq(BrainEntryTable.id, saved.entry.id))
          .get()
        if (!ordinary) throw new Error("Missing ordinary row")
        for (let start = 0; start < 299; start += 20)
          yield* setup.db
            .insert(BrainEntryTable)
            .values(
              Array.from({ length: Math.min(20, 299 - start) }, (_, offset) => ({
                ...ordinary,
                id: `active_control_${start + offset}`,
              })),
            )
            .run()
        const added = yield* setup.brain.propose(place, {
          kind: "fact",
          origin: "user",
          scope: "repository",
          text: "Keep a new independent fixture fact.",
          evidence: { type: "user" },
        })
        expect(added.type).toBe("added")
        expect(yield* setup.db.select().from(BrainEntryTable).where(eq(BrainEntryTable.status, "active"))).toHaveLength(
          300,
        )
        const archived = yield* setup.db.select().from(BrainEntryTable).where(eq(BrainEntryTable.status, "archived"))
        expect(archived).toHaveLength(1)
        const sample = archived[0]
        if (!sample) throw new Error("Missing archive control")
        for (let start = 0; start < 500; start += 20)
          yield* setup.db
            .insert(BrainEntryTable)
            .values(
              Array.from({ length: Math.min(20, 500 - start) }, (_, offset) => ({
                ...sample,
                id: `archive_control_${start + offset}`,
                updated_at: start + offset + 1,
              })),
            )
            .run()
        const consolidated = yield* setup.brain.consolidate(place, { force: true })
        expect(consolidated.merged).toBeGreaterThan(0)
        // This cohort intentionally has duplicate active controls. Tidying
        // supersedes those copies, and the existing500 cap includes BOTH
        // archived and superseded rows rather than500 archived rows alone.
        const putAway = yield* setup.db
          .select()
          .from(BrainEntryTable)
          .where(inArray(BrainEntryTable.status, ["archived", "superseded"]))
        expect(putAway).toHaveLength(500)
        expect(putAway.filter((row) => row.status === "superseded")).toHaveLength(consolidated.merged)
        expect(yield* ReviewWitness.current(setup.db, proof)).toBe(true)
        expect(
          yield* setup.db
            .select()
            .from(BrainEvidenceTable)
            .where(inArray(BrainEvidenceTable.entry_id, [proof.witnesses.parent, proof.witnesses.review])),
        ).toHaveLength(2)
      }),
    )
  })

  test("the coherent private source cap refuses fresh registration while the original pair still works", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        yield* setup.enable()
        expect(yield* setup.register()).toBe(true)
        const original = setup.selected.proof
        if (!original) throw new Error("Missing proof")
        for (let start = 1; start < ReviewWitness.LIMIT; start += 100) {
          const rows = Array.from({ length: Math.min(100, ReviewWitness.LIMIT - start) }, (_, offset) => {
            const index = start + offset
            return {
              repository_id: place.repository,
              scope_id: place.scope,
              parent_session_id: `retired_parent_${index}`,
              review_session_id: `retired_review_${index}`,
              source_head: source.head,
              parent_marker_id: `vrw1_${(index * 2).toString(16).padStart(32, "0")}`,
              review_marker_id: `vrw1_${(index * 2 + 1).toString(16).padStart(32, "0")}`,
              state: "retired" as const,
            }
          })
          yield* setup.db.insert(BrainReviewMemorySourceTable).values(rows).run()
        }
        expect(yield* ReviewWitness.current(setup.db, original)).toBe(true)
        yield* setup.admit("ses_capped_fresh")
        expect(yield* setup.register()).toBe(false)
        expect(yield* setup.db.select().from(BrainEntryTable)).toHaveLength(2)
        expect(yield* ReviewWitness.current(setup.db, original)).toBe(true)
      }),
    )
  })
})
