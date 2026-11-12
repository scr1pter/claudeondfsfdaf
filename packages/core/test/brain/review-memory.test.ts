import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Brain } from "../../src/brain/brain"
import { BrainDatabase } from "../../src/brain/database"
import { BrainRevocation } from "../../src/brain/revocation"
import { ReviewMemory } from "../../src/brain/review-memory"
import { BrainReviewMemoryStateTable, BrainReviewMemoryTable } from "../../src/brain/sql"
import { eq } from "drizzle-orm"
import { Global } from "../../src/global"
import { Token } from "../../src/util/token"
import { tmpdir } from "../fixture/tmpdir"

const source: ReviewMemory.Source = { parentID: "ses_parent", reviewID: "ses_review", head: "a".repeat(40) }
const draft = (): ReviewMemory.Draft => ({
  kind: "preference",
  text: "Prefer an explicit return before a lookup.",
  paths: ["src/*"],
  citations: [],
  reason: "An explicit owner preference.",
  visibility: "repository",
})
const feedback = (): ReviewMemory.Draft => ({
  ...draft(),
  kind: "outcome",
  paths: ["src/a.ts"],
  citations: [{ path: "src/a.ts", line: 1, head: source.head, quote: "return []" }],
  text: "An early return avoids an invalid lookup.",
  reason: "Confirmed for this finding only.",
})
function value<A>(result: ReviewMemory.Result<A>): A {
  if (!result.ok) throw new Error(result.reason)
  return result.value
}
type Setup = {
  brain: Brain.Interface
  memory: ReviewMemory.Interface
  db: BrainDatabase.Database
  place: Brain.Place
  calls: ReviewMemory.OwnerRequest[]
}

// Trusted test ports deliberately exercise policy/storage only; they do not qualify the absent owner UI or Engine
// source-lifecycle adapter. No port reads generic memory or accepts a user-supplied approved/actor flag.
async function run<A>(body: (setup: Setup) => Effect.Effect<A, unknown>, selected?: ReviewMemory.Authority) {
  await using tmp = await tmpdir()
  const calls: ReviewMemory.OwnerRequest[] = []
  const authority: ReviewMemory.Authority = selected ?? {
    owner: (request, use) => {
      calls.push(request)
      return request.repository === "repo-a" || request.repository === "repo-b"
        ? use("owner_1")
        : Effect.succeed({ ok: false, reason: "denied" })
    },
    source: (request, use) =>
      request.parentID === source.parentID && request.reviewID === source.reviewID && request.head === source.head
        ? use()
        : Effect.succeed({ ok: false, reason: "source-unavailable" }),
  }
  const layer = Layer.mergeAll(Brain.layer, ReviewMemory.layerWith(authority)).pipe(
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
        place: { repository: "repo-a", root: tmp.path, sources: [], held: false },
        calls,
      })
    }).pipe(Effect.provide(layer)),
  )
}

const enable = (setup: Setup, place = setup.place) =>
  Effect.gen(function* () {
    const state = value(yield* setup.memory.inspect(place))
    return value(yield* setup.memory.configure(place, { expected: state.generation, enabled: true }))
  })

function pausedApproval() {
  let release: () => void = () => {}
  let notify: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const entered = new Promise<void>((resolve) => {
    notify = resolve
  })
  const captured: { request?: ReviewMemory.OwnerRequest } = {}
  const ports: ReviewMemory.Authority = {
    owner: (request, use) =>
      Effect.gen(function* () {
        if (request.operation === "approve") {
          captured.request = request
          notify()
          yield* Effect.promise(() => gate)
        }
        return yield* use("owner_1")
      }),
    source: (request, use) =>
      request.parentID === source.parentID && request.reviewID === source.reviewID && request.head === source.head
        ? use()
        : Effect.succeed({ ok: false, reason: "source-unavailable" }),
  }
  return { ports, entered, release: () => release(), captured }
}

describe("isolated review memory, actual SQLite", () => {
  test("the full immutable approval preview cannot authorize any row changed during the human wait, even at the same generation", async () => {
    for (const column of ["body", "reason", "visibility", "citations", "source"] as const) {
      const ask = pausedApproval()
      await run(
        (setup) =>
          Effect.gen(function* () {
            const state = yield* enable(setup)
            const pending = value(
              yield* setup.memory.propose(setup.place, { ...feedback(), source, expected: state.generation }),
            )
            const current = value(yield* setup.memory.inspect(setup.place))
            const waiting = Effect.runPromise(
              setup.memory.approve(setup.place, { expected: current.generation, id: pending.id }),
            )
            yield* Effect.promise(() => ask.entered)
            expect(ask.captured.request?.payload).toEqual({
              expected: current.generation,
              id: pending.id,
              entry: pending,
            })
            const payload = ask.captured.request?.payload
            if (!payload || typeof payload !== "object" || !("entry" in payload)) throw new Error("No proposal preview")
            expect(Object.isFrozen(payload)).toBe(true)
            expect(Object.isFrozen(payload.entry)).toBe(true)
            if (
              !payload.entry ||
              typeof payload.entry !== "object" ||
              !("paths" in payload.entry) ||
              !("citations" in payload.entry) ||
              !("source" in payload.entry)
            )
              throw new Error("No complete preview")
            expect(Object.isFrozen(payload.entry.paths)).toBe(true)
            expect(Object.isFrozen(payload.entry.citations)).toBe(true)
            expect(Object.isFrozen(payload.entry.source)).toBe(true)
            if (column === "body")
              yield* setup.db
                .update(BrainReviewMemoryTable)
                .set({ body: "A different correction." })
                .where(eq(BrainReviewMemoryTable.id, pending.id))
                .run()
            if (column === "reason")
              yield* setup.db
                .update(BrainReviewMemoryTable)
                .set({ reason: "A different adjudication." })
                .where(eq(BrainReviewMemoryTable.id, pending.id))
                .run()
            if (column === "visibility")
              yield* setup.db
                .update(BrainReviewMemoryTable)
                .set({ visibility: "private" })
                .where(eq(BrainReviewMemoryTable.id, pending.id))
                .run()
            if (column === "citations")
              yield* setup.db
                .update(BrainReviewMemoryTable)
                .set({ citations: [{ ...feedback().citations[0], quote: "return null" }] })
                .where(eq(BrainReviewMemoryTable.id, pending.id))
                .run()
            if (column === "source")
              yield* setup.db
                .update(BrainReviewMemoryTable)
                .set({ source_head: "b".repeat(40) })
                .where(eq(BrainReviewMemoryTable.id, pending.id))
                .run()
            const rows = yield* setup.db.select().from(BrainReviewMemoryTable)
            const generations = yield* setup.db.select().from(BrainReviewMemoryStateTable)
            ask.release()
            expect(yield* Effect.promise(() => waiting)).toEqual({ ok: false, reason: "stale" })
            expect(yield* setup.db.select().from(BrainReviewMemoryTable)).toEqual(rows)
            expect(yield* setup.db.select().from(BrainReviewMemoryStateTable)).toEqual(generations)
            expect(rows[0].status).toBe("proposed")
            expect(rows[0].approved_by).toBeNull()
          }),
        ask.ports,
      )
    }
  })

  test("erasing the source during approval waits does not hold SQL/lifecycle locks or recreate approved context", async () => {
    const ask = pausedApproval()
    await run(
      (setup) =>
        Effect.gen(function* () {
          const state = yield* enable(setup)
          const pending = value(
            yield* setup.memory.propose(setup.place, { ...feedback(), source, expected: state.generation }),
          )
          const current = value(yield* setup.memory.inspect(setup.place))
          const waiting = Effect.runPromise(
            setup.memory.approve(setup.place, { expected: current.generation, id: pending.id }),
          )
          yield* Effect.promise(() => ask.entered)
          expect(yield* setup.brain.eraseSession(setup.place, source.reviewID)).toBe(1)
          const generations = yield* setup.db.select().from(BrainReviewMemoryStateTable)
          ask.release()
          expect(yield* Effect.promise(() => waiting)).toEqual({ ok: false, reason: "stale" })
          expect(yield* setup.db.select().from(BrainReviewMemoryTable)).toEqual([])
          expect(yield* setup.db.select().from(BrainReviewMemoryStateTable)).toEqual(generations)
        }),
      ask.ports,
    )
  })

  test("the explicit migration is real and initially empty/default-off; existing generic/personal bytes stay identical", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        const personal = yield* setup.brain.propose(setup.place, {
          kind: "preference",
          text: "Prefer private meeting notes.",
          scope: "personal",
          origin: "user",
          evidence: { type: "user" },
        })
        expect(personal.type).toBe("added")
        const before = yield* setup.brain.digest(setup.place, { personal: true, index: true })
        const listed = yield* setup.brain.list(setup.place, { filter: "all" })
        expect(value(yield* setup.memory.inspect(setup.place))).toEqual({ enabled: false, generation: 0, entries: [] })
        expect(yield* setup.db.select().from(BrainReviewMemoryTable)).toEqual([])
        expect(yield* setup.memory.record(setup.place, { ...draft(), expected: 0 })).toEqual({
          ok: false,
          reason: "disabled",
        })
        const state = yield* enable(setup)
        const saved = value(yield* setup.memory.record(setup.place, { ...draft(), expected: state.generation }))
        expect(saved).toMatchObject({ status: "active", origin: "owner", approvedBy: "owner_1" })
        const after = yield* setup.brain.digest(setup.place, { personal: true, index: true })
        expect(after.text).toBe(before.text)
        expect(after.ids).toEqual(before.ids)
        expect(yield* setup.brain.list(setup.place, { filter: "all" })).toEqual(listed)
        expect(yield* setup.brain.get(setup.place, saved.id, { personal: true })).toBeUndefined()
        expect(
          value(yield* setup.memory.context(setup.place, { source, files: ["src/a.ts"] })).entries.map(
            (entry) => entry.text,
          ),
        ).toEqual([draft().text])
      }),
    )
  })

  test("pending feedback cannot become a global rule; only explicit owner approval activates the exact source-bound outcome", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        const state = yield* enable(setup)
        const pending = value(
          yield* setup.memory.propose(setup.place, { ...feedback(), source, expected: state.generation }),
        )
        expect(pending).toMatchObject({ status: "proposed", origin: "review", source })
        expect(pending.approvedBy).toBeUndefined()
        expect(value(yield* setup.memory.context(setup.place, { source, files: ["src/a.ts"] })).entries).toEqual([])
        const current = value(yield* setup.memory.inspect(setup.place))
        const approved = value(
          yield* setup.memory.approve(setup.place, { expected: current.generation, id: pending.id }),
        )
        const approval = setup.calls.find((request) => request.operation === "approve")!
        expect(approval.payload).toEqual({ expected: current.generation, id: pending.id, entry: pending })
        expect(approval.digest).toBe(
          `sha256:${createHash("sha256")
            .update(
              JSON.stringify({
                repository: approval.repository,
                operation: approval.operation,
                payload: approval.payload,
              }),
            )
            .digest("hex")}`,
        )
        expect(Object.isFrozen(approval.payload)).toBe(true)
        expect(approved).toMatchObject({ status: "active", kind: "outcome", source, approvedBy: "owner_1" })
        expect(
          value(yield* setup.memory.context(setup.place, { source, files: ["src/a.ts"] })).entries.map(
            (entry) => entry.id,
          ),
        ).toEqual([pending.id])
        expect(value(yield* setup.memory.context(setup.place, { source, files: ["other/file.ts"] })).entries).toEqual(
          [],
        )
        const now = value(yield* setup.memory.inspect(setup.place))
        expect(
          yield* setup.memory.propose(setup.place, { ...feedback(), paths: ["**"], source, expected: now.generation }),
        ).toEqual({ ok: false, reason: "invalid" })
        expect(yield* setup.memory.propose(setup.place, { ...draft(), source, expected: now.generation })).toEqual({
          ok: false,
          reason: "invalid",
        })
      }),
    )
  })

  test("owner inspect sees private notes while recall excludes private/personal/cross-repository data and missing source proof", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        const state = yield* enable(setup)
        const secret = value(
          yield* setup.memory.record(setup.place, {
            ...draft(),
            text: "Private owner reference.",
            visibility: "private",
            expected: state.generation,
          }),
        )
        const other = { ...setup.place, repository: "repo-b" }
        const otherState = yield* enable(setup, other)
        const foreign = value(
          yield* setup.memory.record(other, {
            ...draft(),
            text: "A separate repository preference.",
            expected: otherState.generation,
          }),
        )
        const owner = value(yield* setup.memory.inspect(setup.place))
        expect(owner.entries.map((entry) => entry.id)).toEqual([secret.id])
        expect(owner.entries.some((entry) => entry.id === foreign.id)).toBe(false)
        expect(value(yield* setup.memory.context(setup.place, { source, files: ["src/a.ts"] })).entries).toEqual([])
        expect(
          yield* setup.memory.context(setup.place, {
            source: { ...source, head: "b".repeat(40) },
            files: ["src/a.ts"],
          }),
        ).toEqual({ ok: false, reason: "source-unavailable" })
        expect(
          value(yield* setup.memory.context({ ...setup.place, held: true }, { source, files: ["src/a.ts"] })).entries,
        ).toEqual([])
      }),
    )
  })

  test("disable invalidates a prepared snapshot through the real repository revocation counter and keeps inspect/erase available", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        const state = yield* enable(setup)
        yield* setup.memory.record(setup.place, { ...draft(), expected: state.generation })
        const context = value(yield* setup.memory.context(setup.place, { source, files: ["src/a.ts"] }))
        expect(context.entries).toHaveLength(1)
        expect(value(yield* setup.memory.current(setup.place, { source, generation: context.generation }))).toBe(true)
        const revision = yield* BrainRevocation.revision(setup.db, setup.place.repository)
        const disabled = value(
          yield* setup.memory.configure(setup.place, { expected: context.generation, enabled: false }),
        )
        expect(yield* BrainRevocation.revision(setup.db, setup.place.repository)).toBeGreaterThan(revision)
        expect(value(yield* setup.memory.current(setup.place, { source, generation: context.generation }))).toBe(false)
        expect(value(yield* setup.memory.context(setup.place, { source, files: ["src/a.ts"] })).entries).toEqual([])
        expect(yield* setup.memory.record(setup.place, { ...draft(), expected: disabled.generation })).toEqual({
          ok: false,
          reason: "disabled",
        })
        expect(value(yield* setup.memory.inspect(setup.place)).entries).toHaveLength(1)
        const erased = value(yield* setup.memory.erase(setup.place, { expected: disabled.generation }))
        expect(erased.enabled).toBe(false)
        expect(erased.generation).toBeGreaterThan(disabled.generation)
        expect(yield* setup.db.select().from(BrainReviewMemoryTable)).toEqual([])
      }),
    )
  })

  test("Brain eraseSession covers approved outcomes and citations for either parent or review; repository/all erase cover every namespace", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        for (const sessionID of [source.parentID, source.reviewID]) {
          const state = yield* enable(setup)
          const pending = value(
            yield* setup.memory.propose(setup.place, { ...feedback(), source, expected: state.generation }),
          )
          const before = value(yield* setup.memory.inspect(setup.place))
          value(yield* setup.memory.approve(setup.place, { expected: before.generation, id: pending.id }))
          expect(yield* setup.brain.eraseSession(setup.place, sessionID)).toBe(1)
          expect(yield* setup.db.select().from(BrainReviewMemoryTable)).toEqual([])
        }
        const state = yield* enable(setup)
        yield* setup.memory.record(setup.place, { ...draft(), expected: state.generation })
        expect(yield* setup.brain.erase(setup.place, "personal")).toBe(0)
        expect(value(yield* setup.memory.inspect(setup.place)).entries).toHaveLength(1)
        expect(yield* setup.brain.erase(setup.place, "repository")).toBe(1)
        const erased = value(yield* setup.memory.inspect(setup.place))
        expect(erased.enabled).toBe(false)
        expect(erased.entries).toEqual([])
        const other = { ...setup.place, repository: "repo-b" }
        const enabled = yield* enable(setup, other)
        yield* setup.memory.record(other, { ...draft(), expected: enabled.generation })
        expect(yield* setup.brain.erase(setup.place, "all")).toBe(1)
        expect(yield* setup.db.select().from(BrainReviewMemoryTable)).toEqual([])
        expect(value(yield* setup.memory.inspect(other)).enabled).toBe(false)
      }),
    )
  })

  test("the owner port receives the actual exact payload digest; JSON authority flags, secrets and traversal never write", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        const state = yield* enable(setup)
        value(yield* setup.memory.record(setup.place, { ...draft(), expected: state.generation }))
        const request = setup.calls.find((request) => request.operation === "record")!
        expect(request.digest).toBe(
          `sha256:${createHash("sha256")
            .update(
              JSON.stringify({
                repository: request.repository,
                operation: request.operation,
                payload: request.payload,
              }),
            )
            .digest("hex")}`,
        )
        const current = value(yield* setup.memory.inspect(setup.place))
        for (const extra of [
          { approved: true },
          { actor: "owner" },
          { private: false },
          { paths: ["../outside"] },
          { text: `token ghp_${"a".repeat(40)}` },
          { text: "hidden\u200b instruction" },
          { text: "x".repeat(ReviewMemory.LIMIT.body + 1) },
        ])
          expect(
            yield* setup.memory.record(setup.place, { ...draft(), expected: current.generation, ...extra }),
          ).toEqual({ ok: false, reason: "invalid" })
        expect(value(yield* setup.memory.inspect(setup.place)).entries).toHaveLength(1)
        expect(
          yield* setup.memory.forget(
            { ...setup.place, repository: "foreign" },
            { expected: current.generation, id: current.entries[0].id },
          ),
        ).toEqual({ ok: false, reason: "denied" })
      }),
    )
    await run(
      (setup) =>
        Effect.gen(function* () {
          expect(yield* setup.memory.inspect(setup.place)).toEqual({ ok: false, reason: "authority-unavailable" })
          expect(yield* setup.memory.context(setup.place, { source, files: ["src/a.ts"] })).toEqual({
            ok: false,
            reason: "source-unavailable",
          })
          expect(yield* setup.db.select().from(BrainReviewMemoryTable)).toEqual([])
        }),
      ReviewMemory.unavailable,
    )
  })

  test("actual retrieval is capped at ten records and four hundred tokens including structured metadata", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        yield* enable(setup)
        for (let i = 0; i < 20; i++) {
          const state = value(yield* setup.memory.inspect(setup.place))
          value(yield* setup.memory.record(setup.place, { ...draft(), expected: state.generation }))
        }
        const result = value(yield* setup.memory.context(setup.place, { source, files: ["src/a.ts"] }))
        expect(result.entries.length).toBeGreaterThan(0)
        expect(result.entries.length).toBeLessThanOrEqual(ReviewMemory.LIMIT.context)
        expect(Token.estimate(JSON.stringify(result.entries))).toBeLessThanOrEqual(ReviewMemory.LIMIT.tokens)
        expect(value(yield* setup.memory.inspect(setup.place, { limit: 5, offset: 5 })).entries).toHaveLength(5)
      }),
    )
  })
})
