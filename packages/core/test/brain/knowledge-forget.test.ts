import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { BrainRevocation } from "@vectordevai/core/brain/revocation"
import { BrainWorker } from "@vectordevai/core/brain/worker/host"
import { tmpdir } from "../fixture/tmpdir"
import { SPEC_V1, SPEC_V2 } from "./fixture/documents"
import { added, countingWorker, placeFor, services, text, withKnowledge, type Setup } from "./fixture/knowledge"

const TABLES = [
  "brain_document",
  "brain_section",
  "brain_item",
  "brain_passage",
  "brain_record",
  "brain_term",
  "brain_posting",
  "brain_job",
  "brain_use",
  "brain_event",
] as const

const counts = (setup: Setup) =>
  Effect.gen(function* () {
    const rows = yield* setup.db.all<{ name: string; count: number }>(
      sql.raw(TABLES.map((table) => `SELECT '${table}' AS name, count(*) AS count FROM ${table}`).join(" UNION ALL ")),
    )
    return Object.fromEntries(rows.map((row) => [row.name, row.count]))
  })

const ask = (query: string) => ({
  query,
  files: [],
  tier: "standard" as const,
  tight: false,
  personal: true,
  exclude: new Set<string>(),
  sessionID: "ses_1",
})

describe("BrainKnowledge.remove", () => {
  test("forgetting a document removes every row of it and of its earlier versions", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const empty = yield* counts(setup)
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        const second = yield* added(setup, text("Auth spec.md", SPEC_V2))
        const recalled = yield* setup.knowledge.recall(setup.place, ask("what is the refresh token TTL?"))
        // A card the session was shown, and a get, leave use rows; the version left change history.
        const lines = yield* setup.knowledge.lines(setup.place, recalled.cards, { personal: true, sessionID: "ses_1" })
        yield* setup.knowledge.get(setup.place, {
          id: recalled.cards[0]!,
          budget: 600,
          personal: true,
          sessionID: "ses_1",
        })
        const before = yield* counts(setup)
        const revocationBefore = yield* BrainRevocation.revision(setup.db, setup.place.repository)
        const removed = yield* setup.knowledge.remove(setup.place, second.document!.id)
        const after = yield* counts(setup)
        const state = yield* setup.db.get<{ items: number; length: number }>(
          sql`SELECT items, item_length_sum AS length FROM brain_state WHERE repository_id = 'repo-1'`,
        )
        return {
          empty,
          before,
          removed,
          after,
          revocationBefore,
          revocationAfter: yield* BrainRevocation.revision(setup.db, setup.place.repository),
          markers: yield* setup.db.all(sql`SELECT * FROM brain_event`),
          state,
          shown: lines.size,
          lines: yield* setup.knowledge.lines(setup.place, recalled.cards, { personal: true, sessionID: "ses_1" }),
          recall: yield* setup.knowledge.recall(setup.place, ask("what is the refresh token TTL?")),
          again: yield* setup.knowledge.remove(setup.place, second.document!.id),
        }
      }),
    )
    expect(result.before.brain_document).toBe(2)
    expect(result.before.brain_posting).toBeGreaterThan(0)
    expect(result.before.brain_use).toBeGreaterThan(0)
    expect(result.before.brain_event).toBeGreaterThan(0)
    expect(result.shown).toBeGreaterThan(0)
    expect(result.removed).toBe("removed")
    expect(result.after).toEqual({ ...result.empty, brain_event: result.empty.brain_event + 1 })
    expect(result.revocationAfter).toBeGreaterThan(result.revocationBefore)
    expect(result.markers).toEqual([
      {
        id: expect.any(Number),
        entry_id: "",
        repository_id: "repo-1",
        at: expect.any(Number),
        action: "forgotten",
        actor: "user",
        detail: null,
      },
    ])
    expect(result.state).toEqual({ items: 0, length: 0 })
    // Not even a session that was shown its cards gets them again.
    expect(result.lines.size).toBe(0)
    expect(result.recall.text ?? "").toBe("")
    expect(result.again).toBe("not-found")
  })

  test("turning repository documents off revokes their cached titles even without tombstones", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const document = yield* added(setup, { ...text("Auth spec.md", SPEC_V1), origin: "repository" })
        expect(document.document?.status).toBe("searchable")
        const before = yield* BrainRevocation.revision(setup.db, setup.place.repository)
        yield* setup.knowledge.configure(setup.place, { repositoryDocs: false })
        return {
          before,
          after: yield* BrainRevocation.revision(setup.db, setup.place.repository),
          documents: yield* setup.knowledge.documents(setup.place, { personal: true }),
        }
      }),
    )
    expect(result.documents).toEqual([])
    // A prompt can read between the setting and document deletion: both writes must advance its generation.
    expect(result.after).toBeGreaterThan(result.before + 1)
  })

  test("making a document private revokes its shared title while preserving owner access", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const document = yield* added(setup, { ...text("SapphireMemo.md", SPEC_V1), origin: "repository" })
        expect(document.document?.status).toBe("searchable")
        const before = yield* BrainRevocation.revision(setup.db, setup.place.repository)
        const sharedBefore = yield* setup.knowledge.digest(setup.place, { personal: false })
        yield* setup.knowledge.update(setup.place, document.document!.id, { visibility: "private" })
        return {
          before,
          sharedBefore,
          after: yield* BrainRevocation.revision(setup.db, setup.place.repository),
          sharedAfter: yield* setup.knowledge.digest(setup.place, { personal: false }),
          owner: yield* setup.knowledge.digest(setup.place, { personal: true }),
        }
      }),
    )
    expect(result.sharedBefore).toBeDefined()
    expect(result.after).toBeGreaterThan(result.before)
    expect(result.sharedAfter).toBeUndefined()
    expect(result.owner).toBeDefined()
  })

  test("ordinary repository scan cleanup preserves the cached prefix generation", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, { ...text("Auth spec.md", SPEC_V1), origin: "repository" })
        const before = yield* BrainRevocation.revision(setup.db, setup.place.repository)
        // This folder has no tracked file for the old index entry, so a normal scan removes it.
        yield* setup.knowledge.scan(setup.place, { force: true })
        return {
          before,
          after: yield* BrainRevocation.revision(setup.db, setup.place.repository),
          documents: yield* setup.knowledge.documents(setup.place, { personal: true }),
        }
      }),
    )
    expect(result.documents).toEqual([])
    expect(result.after).toBe(result.before)
  })

  test("a failed private visibility change rolls back shared documents, items and revocation across connections", async () => {
    await using tmp = await tmpdir()
    const place = placeFor(tmp.path)
    const options = { file: path.join(tmp.path, "brain.db"), dir: tmp.path, worker: BrainWorker.layerInline }
    await Effect.runPromise(
      services(
        place,
        (reader) =>
          services(
            place,
            (writer) =>
              Effect.gen(function* () {
                expect(reader.db).not.toBe(writer.db)
                const document = yield* added(writer, { ...text("Auth spec.md", SPEC_V1), origin: "repository" })
                if (!document.document) return yield* Effect.die("document was refused")
                const before = yield* BrainRevocation.revision(reader.db, place.repository)
                const shared = { query: "retry 429", personal: false }
                expect((yield* reader.knowledge.records(place, shared)).records.length).toBeGreaterThan(0)
                yield* writer.db.run(sql`CREATE TRIGGER test_visibility_abort BEFORE UPDATE OF visibility ON brain_item
        WHEN NEW.visibility = 'private' BEGIN SELECT RAISE(ABORT, 'fixture denied visibility update'); END`)
                const failed = yield* writer.knowledge
                  .update(place, document.document.id, { visibility: "private" })
                  .pipe(Effect.exit)
                expect(Exit.isFailure(failed)).toBe(true)
                expect(yield* reader.knowledge.digest(place, { personal: false })).toBeDefined()
                expect(
                  yield* reader.db.all(
                    sql`SELECT DISTINCT visibility FROM brain_item WHERE document_id = ${document.document.id}`,
                  ),
                ).toEqual([{ visibility: "repository" }])
                expect((yield* reader.knowledge.records(place, shared)).records.length).toBeGreaterThan(0)
                expect(yield* BrainRevocation.revision(reader.db, place.repository)).toBe(before)
                yield* writer.db.run("DROP TRIGGER test_visibility_abort")
                expect(yield* writer.knowledge.update(place, document.document.id, { visibility: "private" })).toBe(
                  "updated",
                )
                expect(yield* reader.knowledge.digest(place, { personal: false })).toBeUndefined()
                expect((yield* reader.knowledge.records(place, shared)).records).toEqual([])
                expect(yield* reader.knowledge.digest(place, { personal: true })).toBeDefined()
                expect(yield* BrainRevocation.revision(reader.db, place.repository)).toBeGreaterThan(before)
              }),
            options,
          ),
        options,
      ),
    )
  })

  test("extraction finishing after a document becomes private keeps new items private", async () => {
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const worker = Layer.effect(
      BrainWorker.Service,
      Effect.gen(function* () {
        const actual = yield* BrainWorker.Service
        return BrainWorker.Service.of({
          ...actual,
          extract: (input) => Effect.sync(() => ready.resolve()).pipe(Effect.andThen(actual.extract(input))),
        })
      }),
    ).pipe(Layer.provide(countingWorker([], release.promise)))
    await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          const queued = yield* setup.knowledge.add(setup.place, {
            ...text("Auth spec.md", SPEC_V1),
            origin: "repository",
          })
          if (queued.type === "refused") return yield* Effect.die(queued.message)
          yield* Effect.promise(() => ready.promise).pipe(Effect.timeout("5 seconds"))
          expect(yield* setup.knowledge.update(setup.place, queued.document.id, { visibility: "private" })).toBe(
            "updated",
          )
          release.resolve()
          const done = yield* setup.knowledge.wait(setup.place, queued.document.id, "searchable", 20_000)
          expect(done?.status).toBe("searchable")
          expect(done?.visibility).toBe("private")
          expect(
            yield* setup.db.all(
              sql`SELECT DISTINCT visibility FROM brain_item WHERE document_id = ${queued.document.id}`,
            ),
          ).toEqual([{ visibility: "private" }])
          expect(
            (yield* setup.knowledge.records(setup.place, { query: "retry 429", personal: false })).records,
          ).toEqual([])
          expect(
            (yield* setup.knowledge.records(setup.place, { query: "retry 429", personal: true })).records.length,
          ).toBeGreaterThan(0)
        }).pipe(Effect.ensuring(Effect.sync(() => release.resolve()))),
      { worker },
    )
  })

  test("memory learned from a forgotten document keeps its words, loses the quote, and says so in its history", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const { document } = yield* added(setup, text("Auth spec.md", SPEC_V1))
        const record = (yield* setup.knowledge.records(setup.place, { query: "retry 429", personal: true })).records[0]!
        const learned = yield* setup.brain.propose(setup.place, {
          kind: "lesson",
          text: "Client retry changes need the retry tests run after a 429 change.",
          scope: "repository",
          origin: "agent",
          evidence: { type: "document", path: record.id, quote: record.quote, verified: true },
        })
        if (learned.type === "refused") throw new Error(learned.message)
        yield* setup.knowledge.derive(setup.place, { entry: learned.entry, from: record.id })
        const before = yield* setup.brain.get(setup.place, learned.entry.id, { personal: true })
        yield* setup.knowledge.remove(setup.place, document!.id)
        return {
          record,
          before,
          after: yield* setup.brain.get(setup.place, learned.entry.id, { personal: true }),
          history: yield* setup.db.all<{ action: string }>(
            sql`SELECT action FROM brain_event WHERE entry_id = ${learned.entry.id} ORDER BY id`,
          ),
          quotes: yield* setup.db.all(sql`SELECT quote FROM brain_evidence WHERE quote = ${record.quote}`),
          edges: yield* setup.db.all(sql`SELECT source FROM brain_edge WHERE source = ${learned.entry.id}`),
        }
      }),
    )
    expect(result.before?.evidence).toContainEqual(
      expect.objectContaining({ type: "document", path: result.record.id }),
    )
    expect(result.after?.entry).toMatchObject({
      status: "active",
      text: "Client retry changes need the retry tests run after a 429 change.",
    })
    expect(result.after?.evidence.filter((item) => item.type === "document")).toEqual([])
    expect(result.quotes).toEqual([])
    expect(result.edges).toEqual([])
    expect(result.history.map((event) => event.action)).toContain("evidence-forgotten")
  })

  test("a forgotten document is not added back by a chat or the agent, but the user can add it again", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const first = yield* added(setup, text("Auth spec.md", SPEC_V1))
        yield* setup.knowledge.remove(setup.place, first.document!.id)
        return {
          chat: yield* setup.knowledge.add(setup.place, { ...text("Auth spec.md", SPEC_V1), origin: "chat" }),
          agent: yield* setup.knowledge.add(setup.place, { ...text("Auth spec.md", SPEC_V1), origin: "agent" }),
          upload: (yield* added(setup, text("Auth spec.md", SPEC_V1))).document?.status,
          later: yield* setup.knowledge.add(setup.place, { ...text("Auth copy.md", SPEC_V1), origin: "chat" }),
        }
      }),
    )
    expect(result.chat).toMatchObject({ type: "refused", reason: "forgotten" })
    expect(result.agent).toMatchObject({ type: "refused", reason: "forgotten" })
    expect(result.upload).toBe("searchable")
    // Added again by the user, it is simply here.
    expect(result.later.type).toBe("unchanged")
  })
})
