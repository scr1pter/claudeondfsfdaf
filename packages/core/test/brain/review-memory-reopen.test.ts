import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import { Brain } from "../../src/brain/brain"
import { BrainDatabase } from "../../src/brain/database"
import { BrainLexical } from "../../src/brain/lexical"
import { BrainRevocation } from "../../src/brain/revocation"
import { ReviewMemory } from "../../src/brain/review-memory"
import { ReviewStore } from "../../src/brain/review-store"
import { ReviewWitness } from "../../src/brain/review-witness"
import {
  BrainEntryTable,
  BrainEventTable,
  BrainEvidenceTable,
  BrainReviewMemoryScopeStateTable,
  BrainReviewMemorySourceTable,
  BrainReviewMemoryStateTable,
  BrainReviewMemoryTable,
  BrainStateTable,
  BrainTombstoneTable,
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
const reason = "Reassess this outcome: the owner found a missing input case."

// Private Core-policy fixture only. Production pairs must come from the immutable winning Main reservation.
const witness = (request: ReviewMemory.Source & { repository: string; scope: string }): ReviewWitness.Proof => ({
  ...request,
  witnesses: {
    version: 1,
    parent: `vrw1_${createHash("sha256")
      .update(JSON.stringify([request, "parent"]))
      .digest("hex")
      .slice(0, 32)}`,
    review: `vrw1_${createHash("sha256")
      .update(JSON.stringify([request, "review"]))
      .digest("hex")
      .slice(0, 32)}`,
  },
})
function value<A>(result: ReviewMemory.Result<A>): A {
  if (!result.ok) throw new Error(result.reason)
  return result.value
}
const refused = (reason: ReviewMemory.Failure): ReviewMemory.Result<never> => ({ ok: false, reason })
function control(count = 0) {
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const state = { owner: true, source: true, principal: "owner_1" }
  const requests: ReviewMemory.OwnerRequest[] = []
  const ports: ReviewMemory.Authority = {
    owner: (request, use) =>
      Effect.gen(function* () {
        if (!state.owner) return refused("denied")
        if (request.operation === "reopen") {
          requests.push(request)
          if (requests.length >= count) entered.resolve()
          if (count) yield* Effect.promise(() => gate.promise)
        }
        return state.owner ? yield* use(state.principal) : refused("denied")
      }),
    source: (request, use) =>
      state.source &&
      request.parentID === source.parentID &&
      request.reviewID === source.reviewID &&
      request.head === source.head
        ? use(witness(request))
        : Effect.succeed(refused("source-unavailable")),
  }
  return { state, requests, ports, entered: entered.promise, release: () => gate.resolve() }
}
type Setup = {
  brain: Brain.Interface
  memory: ReviewMemory.Interface
  db: BrainDatabase.Database
  place: ReviewMemory.Place
}
async function run<A>(body: (setup: Setup) => Effect.Effect<A, unknown>, selected = control()) {
  await using tmp = await tmpdir()
  const layer = Layer.mergeAll(Brain.layer, ReviewMemory.layerWith(selected.ports)).pipe(
    Layer.provideMerge(BrainDatabase.layerFor(":memory:")),
    Layer.provide(
      Layer.succeed(
        Global.Service,
        Global.make({ config: path.join(tmp.path, "config"), data: path.join(tmp.path, "data") }),
      ),
    ),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* body({
        brain: yield* Brain.Service,
        memory: yield* ReviewMemory.Service,
        db: (yield* BrainDatabase.Service).db,
        place: { repository: "repo-a", scope: "physical-a", root: tmp.path, sources: [], held: false },
      })
    }).pipe(Effect.provide(layer)),
  )
}
const seed = (setup: Setup) =>
  Effect.gen(function* () {
    const before = value(yield* setup.memory.inspect(setup.place))
    const enabled = value(yield* setup.memory.configure(setup.place, { expected: before.generation, enabled: true }))
    expect(
      yield* ReviewStore.registerSource(
        setup.db,
        witness({ repository: setup.place.repository, scope: setup.place.scope, ...source }),
      ),
    ).toBe(true)
    const pending = value(yield* setup.memory.propose(setup.place, { ...draft, source, expected: enabled.generation }))
    const proposed = value(yield* setup.memory.inspect(setup.place))
    const entry = value(yield* setup.memory.approve(setup.place, { expected: proposed.generation, id: pending.id }))
    return { entry, state: value(yield* setup.memory.inspect(setup.place)) }
  })
const snapshot = (db: BrainDatabase.Database) =>
  Effect.gen(function* () {
    return {
      rows: yield* db.select().from(BrainReviewMemoryTable),
      scopes: yield* db.select().from(BrainReviewMemoryScopeStateTable),
      namespaces: yield* db.select().from(BrainReviewMemoryStateTable),
      sources: yield* db.select().from(BrainReviewMemorySourceTable),
      markers: yield* db.select().from(BrainEntryTable),
      evidence: yield* db.select().from(BrainEvidenceTable),
      tombstones: yield* db.select().from(BrainTombstoneTable),
      audit: yield* db.select().from(BrainEventTable),
      state: yield* db.select().from(BrainStateTable),
      uses: yield* db.select().from(BrainUseTable),
    }
  })

// Exact old sole-session selection and tombstone primitive (50d9dac7b /8b5975be4), with no new erasure hook.
// This tests real SQLite compatibility with that primitive, not execution of an older binary.
const oldErase = Effect.fnUntraced(function* (db: BrainDatabase.Database, repository: string, sessionID: string) {
  const rows = yield* db
    .select()
    .from(BrainEntryTable)
    .where(
      and(
        inArray(BrainEntryTable.repository_id, [repository, ""]),
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

describe("explicit owner outcome reopening, actual SQLite", () => {
  test("withdraws the same approved row atomically, preserves its original source and content, and requires separate reapproval", async () => {
    const selected = control()
    await run(
      (setup) =>
        Effect.gen(function* () {
          const active = yield* seed(setup)
          expect(value(yield* setup.memory.context(setup.place, { source, files: ["src/a.ts"] })).entries).toHaveLength(
            1,
          )
          const before = yield* snapshot(setup.db)
          const revision = yield* BrainRevocation.revision(setup.db, setup.place.repository)
          const reopened = value(
            yield* setup.memory.reopen(setup.place, { expected: active.state.generation, id: active.entry.id, reason }),
          )
          expect(reopened).toEqual({
            ...active.entry,
            status: "proposed",
            reason,
            approvedBy: undefined,
            approvedAt: undefined,
            updatedAt: reopened.updatedAt,
          })
          expect(reopened.updatedAt).toBeGreaterThanOrEqual(active.entry.updatedAt)
          expect(selected.requests).toHaveLength(1)
          expect(selected.requests[0].payload).toEqual({
            expected: active.state.generation,
            id: active.entry.id,
            reason,
            entry: active.entry,
          })
          const after = yield* snapshot(setup.db)
          expect(after.rows).toEqual([
            {
              ...before.rows[0],
              status: "proposed",
              reason,
              approved_by: null,
              approved_at: null,
              updated_at: reopened.updatedAt,
            },
          ])
          expect(after.sources).toEqual(before.sources)
          expect(after.markers).toEqual(before.markers)
          expect(after.evidence).toEqual(before.evidence)
          expect(after.tombstones).toEqual(before.tombstones)
          expect(after.uses).toEqual(before.uses)
          expect(after.audit).toHaveLength(before.audit.length + 1)
          expect(after.audit.at(-1)).toMatchObject({
            entry_id: "",
            repository_id: setup.place.repository,
            action: "forgotten",
            actor: "user",
          })
          expect(yield* BrainRevocation.revision(setup.db, setup.place.repository)).toBe(revision + 1)
          const current = value(yield* setup.memory.inspect(setup.place))
          expect(current.generation).toBe(active.state.generation + 1)
          expect(current.enabled).toBe(true)
          expect(value(yield* setup.memory.current(setup.place, { source, generation: active.state.generation }))).toBe(
            false,
          )
          expect(value(yield* setup.memory.context(setup.place, { source, files: ["src/a.ts"] })).entries).toEqual([])
          selected.state.principal = "owner_2"
          const approved = value(
            yield* setup.memory.approve(setup.place, { expected: current.generation, id: reopened.id }),
          )
          expect(approved).toMatchObject({
            id: active.entry.id,
            source,
            citations: draft.citations,
            text: draft.text,
            reason,
            status: "active",
            approvedBy: "owner_2",
          })
          expect(yield* setup.db.select().from(BrainReviewMemoryTable)).toHaveLength(1)
          expect(yield* setup.db.select().from(BrainReviewMemorySourceTable)).toEqual(before.sources)
          expect(value(yield* setup.memory.context(setup.place, { source, files: ["src/a.ts"] })).entries[0].id).toBe(
            active.entry.id,
          )
        }),
      selected,
    )
  })

  test("seals the complete original preview and captures the requested reason and target before the human wait", async () => {
    const selected = control(1)
    await run(
      (setup) =>
        Effect.gen(function* () {
          const active = yield* seed(setup)
          const input = { expected: active.state.generation, id: active.entry.id, reason }
          const waiting = Effect.runPromise(setup.memory.reopen(setup.place, input))
          yield* Effect.promise(() => selected.entered)
          const payload = selected.requests[0]?.payload
          expect(payload).toEqual({ ...input, entry: active.entry })
          if (!payload || typeof payload !== "object" || !("entry" in payload))
            throw new Error("Missing original preview")
          const entry = payload.entry
          if (
            !entry ||
            typeof entry !== "object" ||
            !("paths" in entry) ||
            !("citations" in entry) ||
            !("source" in entry)
          )
            throw new Error("Incomplete original preview")
          expect(Object.isFrozen(payload)).toBe(true)
          expect(Object.isFrozen(entry)).toBe(true)
          expect(Object.isFrozen(entry.paths)).toBe(true)
          expect(Object.isFrozen(entry.source)).toBe(true)
          expect(Object.isFrozen(entry.citations)).toBe(true)
          if (!Array.isArray(entry.citations) || !entry.citations[0] || typeof entry.citations[0] !== "object")
            throw new Error("Missing original citation")
          expect(Object.isFrozen(entry.citations[0])).toBe(true)
          expect(Reflect.set(entry.citations[0], "quote", "replace the original")).toBe(false)
          expect(Reflect.set(entry, "reason", reason)).toBe(false)
          input.id = "vr_other"
          input.reason = "A later unrelated reason."
          input.expected += 1
          selected.release()
          const reopened = value(yield* Effect.promise(() => waiting))
          expect(reopened).toMatchObject({
            id: active.entry.id,
            source,
            reason,
            text: draft.text,
            citations: draft.citations,
            status: "proposed",
          })
          expect(selected.requests[0].payload).toEqual({
            expected: active.state.generation,
            id: active.entry.id,
            reason,
            entry: active.entry,
          })
        }),
      selected,
    )
  })

  test("rejects malformed reasons, non-outcomes, proposed entries, foreign targets, held callers and absent owner authority without writes", async () => {
    const selected = control()
    await run(
      (setup) =>
        Effect.gen(function* () {
          const active = yield* seed(setup)
          const owner = value(
            yield* setup.memory.record(setup.place, {
              ...draft,
              kind: "preference",
              citations: [],
              expected: active.state.generation,
            }),
          )
          const checked = value(yield* setup.memory.inspect(setup.place))
          const ownerCheck = value(
            yield* setup.memory.record(setup.place, {
              ...draft,
              kind: "check",
              citations: [],
              expected: checked.generation,
            }),
          )
          const ownerState = value(yield* setup.memory.inspect(setup.place))
          const pending = value(
            yield* setup.memory.propose(setup.place, { ...draft, source, expected: ownerState.generation }),
          )
          const state = value(yield* setup.memory.inspect(setup.place))
          const before = yield* snapshot(setup.db)
          for (const invalid of [
            "",
            " ",
            "x".repeat(ReviewMemory.LIMIT.reason + 1),
            "hidden\u202etext",
            "bad\u0000text",
            "bad\ud800text",
          ])
            expect(
              yield* setup.memory.reopen(setup.place, {
                expected: state.generation,
                id: active.entry.id,
                reason: invalid,
              }),
            ).toEqual({ ok: false, reason: "invalid" })
          const extra = { expected: state.generation, id: active.entry.id, reason, approved: true }
          expect(yield* setup.memory.reopen(setup.place, extra)).toEqual({ ok: false, reason: "invalid" })
          for (const id of [owner.id, ownerCheck.id, pending.id, "vr_missing"])
            expect(yield* setup.memory.reopen(setup.place, { expected: state.generation, id, reason })).toEqual({
              ok: false,
              reason: "not-found",
            })
          expect(
            yield* setup.memory.reopen(
              { ...setup.place, scope: "physical-other" },
              { expected: state.generation, id: active.entry.id, reason },
            ),
          ).toEqual({ ok: false, reason: "stale" })
          expect(
            yield* setup.memory.reopen(
              { ...setup.place, repository: "repo-other" },
              { expected: state.generation, id: active.entry.id, reason },
            ),
          ).toEqual({ ok: false, reason: "stale" })
          expect(
            yield* setup.memory.reopen(
              { ...setup.place, held: true },
              { expected: state.generation, id: active.entry.id, reason },
            ),
          ).toEqual({ ok: false, reason: "denied" })
          selected.state.owner = false
          expect(
            yield* setup.memory.reopen(setup.place, { expected: state.generation, id: active.entry.id, reason }),
          ).toEqual({ ok: false, reason: "denied" })
          expect(yield* snapshot(setup.db)).toEqual(before)
        }),
      selected,
    )
  })

  test("permits explicit restrictive withdrawal while disabled, without enabling or making the row recallable", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        const active = yield* seed(setup)
        const disabled = value(
          yield* setup.memory.configure(setup.place, { expected: active.state.generation, enabled: false }),
        )
        const reopened = value(
          yield* setup.memory.reopen(setup.place, { expected: disabled.generation, id: active.entry.id, reason }),
        )
        expect(reopened.status).toBe("proposed")
        const current = value(yield* setup.memory.inspect(setup.place))
        expect(current).toMatchObject({ enabled: false, generation: disabled.generation + 1 })
        expect(value(yield* setup.memory.context(setup.place, { source, files: ["src/a.ts"] })).entries).toEqual([])
        expect(yield* setup.memory.approve(setup.place, { expected: current.generation, id: active.entry.id })).toEqual(
          { ok: false, reason: "disabled" },
        )
      }),
    )
  })

  test("refuses every same-generation original-row change instead of overwriting an unapproved revision", async () => {
    const changes: Partial<typeof BrainReviewMemoryTable.$inferInsert>[] = [
      { body: "A changed correction." },
      { reason: "A changed rationale." },
      { paths: ["src/b.ts"] },
      { citations: [{ path: "src/a.ts", line: 2, head: source.head, quote: "return null" }] },
      { visibility: "private" },
      { approved_by: "owner_other" },
      { approved_at: 1 },
      { approved_by: null },
      { approved_at: null },
      { source_head: "b".repeat(40) },
    ]
    for (const change of changes) {
      const selected = control(1)
      await run(
        (setup) =>
          Effect.gen(function* () {
            const active = yield* seed(setup)
            const waiting = Effect.runPromise(
              setup.memory.reopen(setup.place, { expected: active.state.generation, id: active.entry.id, reason }),
            )
            yield* Effect.promise(() => selected.entered)
            yield* setup.db
              .update(BrainReviewMemoryTable)
              .set(change)
              .where(eq(BrainReviewMemoryTable.id, active.entry.id))
              .run()
            const before = yield* snapshot(setup.db)
            selected.release()
            expect(yield* Effect.promise(() => waiting)).toEqual({ ok: false, reason: "stale" })
            const after = yield* snapshot(setup.db)
            expect(after.rows).toEqual(change.source_head ? [] : before.rows)
            expect(after.rows.some((row) => row.status === "proposed" || row.reason === reason)).toBe(false)
            expect(after.sources).toEqual(before.sources)
            expect(after.markers).toEqual(before.markers)
            expect(after.evidence).toEqual(before.evidence)
          }),
        selected,
      )
    }
  })

  test("rolls the row and all epoch/revocation changes back when SQLite rejects generation advancement after UPDATE", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        const active = yield* seed(setup)
        const before = yield* snapshot(setup.db)
        yield* setup.db.run(
          "CREATE TEMP TRIGGER reopen_reject_generation BEFORE UPDATE ON brain_review_memory_scope_state BEGIN SELECT RAISE(ABORT, 'reopen fixture generation failure'); END",
        )
        const result = yield* Effect.exit(
          setup.memory.reopen(setup.place, { expected: active.state.generation, id: active.entry.id, reason }),
        ).pipe(Effect.ensuring(setup.db.run("DROP TRIGGER reopen_reject_generation").pipe(Effect.orDie)))
        expect(Exit.isFailure(result)).toBe(true)
        expect(yield* snapshot(setup.db)).toEqual(before)
        expect(
          value(
            yield* setup.memory.reopen(setup.place, { expected: active.state.generation, id: active.entry.id, reason }),
          ).status,
        ).toBe("proposed")
      }),
    )
  })

  test("old sole-session forgetting during the human wait retires the original witness without recreating any review data", async () => {
    for (const sessionID of [source.parentID, source.reviewID]) {
      const selected = control(1)
      await run(
        (setup) =>
          Effect.gen(function* () {
            const active = yield* seed(setup)
            const owner = value(
              yield* setup.memory.record(setup.place, {
                ...draft,
                kind: "check",
                citations: [],
                expected: active.state.generation,
              }),
            )
            const current = value(yield* setup.memory.inspect(setup.place))
            const waiting = Effect.runPromise(
              setup.memory.reopen(setup.place, { expected: current.generation, id: active.entry.id, reason }),
            )
            yield* Effect.promise(() => selected.entered)
            expect(yield* oldErase(setup.db, setup.place.repository, sessionID)).toBe(1)
            expect(yield* setup.db.select().from(BrainReviewMemoryTable)).toHaveLength(2)
            const forgotten = yield* snapshot(setup.db)
            expect(forgotten.markers).toHaveLength(1)
            expect(forgotten.evidence).toHaveLength(1)
            expect(forgotten.evidence[0].session_id).toBe(
              sessionID === source.parentID ? source.reviewID : source.parentID,
            )
            selected.release()
            expect(yield* Effect.promise(() => waiting)).toEqual({ ok: false, reason: "source-unavailable" })
            const rows = yield* setup.db.select().from(BrainReviewMemoryTable)
            expect(rows.map((row) => row.id)).toEqual([owner.id])
            const ledger = yield* setup.db.select().from(BrainReviewMemorySourceTable)
            expect(ledger).toHaveLength(1)
            expect(ledger[0].state).toBe("retired")
            expect(yield* setup.db.select().from(BrainEntryTable)).toEqual(forgotten.markers)
            expect(yield* setup.db.select().from(BrainEvidenceTable)).toEqual(forgotten.evidence)
            expect(yield* setup.memory.context(setup.place, { source, files: ["src/a.ts"] })).toEqual({
              ok: false,
              reason: "source-unavailable",
            })
            expect(
              yield* ReviewStore.registerSource(
                setup.db,
                witness({ repository: setup.place.repository, scope: setup.place.scope, ...source }),
              ),
            ).toBe(false)
            expect(yield* setup.db.select().from(BrainReviewMemoryTable)).toEqual(rows)
            expect(value(yield* setup.memory.inspect(setup.place)).entries).toEqual([owner])
          }),
        selected,
      )
    }
  })

  test("current session/row/namespace deletion and consent epoch changes win over a suspended reopen", async () => {
    for (const mode of ["parent", "review", "row", "namespace", "consent"] as const) {
      const selected = control(1)
      await run(
        (setup) =>
          Effect.gen(function* () {
            const active = yield* seed(setup)
            const waiting = Effect.runPromise(
              setup.memory.reopen(setup.place, { expected: active.state.generation, id: active.entry.id, reason }),
            )
            yield* Effect.promise(() => selected.entered)
            if (mode === "parent" || mode === "review")
              expect(
                yield* setup.brain.eraseSession(setup.place, mode === "parent" ? source.parentID : source.reviewID),
              ).toBe(1)
            if (mode === "row")
              value(yield* setup.memory.forget(setup.place, { expected: active.state.generation, id: active.entry.id }))
            if (mode === "namespace")
              value(yield* setup.memory.erase(setup.place, { expected: active.state.generation }))
            if (mode === "consent") {
              const disabled = value(
                yield* setup.memory.configure(setup.place, { expected: active.state.generation, enabled: false }),
              )
              value(yield* setup.memory.configure(setup.place, { expected: disabled.generation, enabled: true }))
            }
            const before = yield* snapshot(setup.db)
            selected.release()
            const result = yield* Effect.promise(() => waiting)
            expect(result).toEqual({
              ok: false,
              reason: mode === "parent" || mode === "review" || mode === "namespace" ? "source-unavailable" : "stale",
            })
            expect(yield* snapshot(setup.db)).toEqual(before)
          }),
        selected,
      )
    }
  })

  test("revalidates current private owner and original source authority after the human wait", async () => {
    for (const mode of ["owner", "source"] as const) {
      const selected = control(1)
      await run(
        (setup) =>
          Effect.gen(function* () {
            const active = yield* seed(setup)
            const waiting = Effect.runPromise(
              setup.memory.reopen(setup.place, { expected: active.state.generation, id: active.entry.id, reason }),
            )
            yield* Effect.promise(() => selected.entered)
            selected.state[mode] = false
            const before = yield* snapshot(setup.db)
            selected.release()
            expect(yield* Effect.promise(() => waiting)).toEqual({
              ok: false,
              reason: mode === "owner" ? "denied" : "source-unavailable",
            })
            expect(yield* snapshot(setup.db)).toEqual(before)
          }),
        selected,
      )
    }
  })

  test("two approved previews for one generation permit only one atomic reopen and one generation advance", async () => {
    const selected = control(2)
    await run(
      (setup) =>
        Effect.gen(function* () {
          const active = yield* seed(setup)
          const before = yield* snapshot(setup.db)
          const waiting = [reason, "A second explicit human reassessment."].map((humanReason) =>
            Effect.runPromise(
              setup.memory.reopen(setup.place, {
                expected: active.state.generation,
                id: active.entry.id,
                reason: humanReason,
              }),
            ),
          )
          yield* Effect.promise(() => selected.entered)
          expect(selected.requests).toHaveLength(2)
          selected.release()
          const results = yield* Effect.promise(() => Promise.all(waiting))
          expect(results.filter((result) => result.ok)).toHaveLength(1)
          expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "stale" }])
          const current = value(yield* setup.memory.inspect(setup.place))
          expect(current.generation).toBe(active.state.generation + 1)
          expect(current.entries).toHaveLength(1)
          expect(current.entries[0]).toMatchObject({
            id: active.entry.id,
            status: "proposed",
            source,
            text: draft.text,
            citations: draft.citations,
          })
          expect([reason, "A second explicit human reassessment."]).toContain(current.entries[0].reason)
          const after = yield* snapshot(setup.db)
          expect(after.sources).toEqual(before.sources)
          expect(after.markers).toEqual(before.markers)
          expect(after.evidence).toEqual(before.evidence)
          expect(after.audit).toHaveLength(before.audit.length + 1)
        }),
      selected,
    )
  })
})
