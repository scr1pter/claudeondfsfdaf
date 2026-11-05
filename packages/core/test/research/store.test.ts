import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@vectordevai/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { getTableConfig, SQLiteColumn, type SQLiteTable } from "drizzle-orm/sqlite-core"
import { Effect, Layer } from "effect"
import type { Research } from "@vectordevai/schema/research"
import type { Brain } from "../../src/brain/brain"
import { BrainDatabase } from "../../src/brain/database"
import { BrainEmbed } from "../../src/brain/embed"
import { BrainErase } from "../../src/brain/erase"
import { BrainKnowledge } from "../../src/brain/knowledge"
import first from "../../src/brain/migration/20261018000000_brain"
import knowledgeMigration from "../../src/brain/migration/20261101000000_knowledge"
import privateMemory from "../../src/brain/migration/20261102000000_private_memory"
import tombstoneTerms from "../../src/brain/migration/20261103000000_tombstone_terms"
import credit from "../../src/brain/migration/20261104000000_credit"
import code from "../../src/brain/migration/20261120000000_code"
import creditedOnce from "../../src/brain/migration/20261121000000_credited_once"
import { BrainDocumentTable, ResearchNoteTable, ResearchRunTable, ResearchSourceTable } from "../../src/brain/sql"
import { DatabaseMigration } from "../../src/database/migration"
import { LayerNode } from "../../src/effect/layer-node"
import { EventV2 } from "../../src/event"
import { ResearchStore } from "../../src/research/store"
import { withKnowledge, type Setup as KnowledgeSetup } from "../brain/fixture/knowledge"
import { tmpdir } from "../fixture/tmpdir"
import { NetworkGuard } from "../lib/network-guard"

// The research run store over a brain in memory: runs, their sources as held private web documents, notes checked
// against the saved text, reports held until kept, retention, the repository cap, Forget with tombstones, export, and
// runs a guest acted in, which keep nothing in the brain.

const guard = NetworkGuard.use()

type Setup = KnowledgeSetup & { readonly store: ResearchStore.Interface }

function withStore<A, E>(
  body: (setup: Setup) => Effect.Effect<A, E>,
  options: { readonly limits?: Partial<ResearchStore.Limits>; readonly embed?: boolean } = {},
) {
  return withKnowledge(
    (setup) =>
      Effect.gen(function* () {
        const store = yield* ResearchStore.Service
        return yield* body({ ...setup, store })
      }).pipe(
        Effect.provide(
          ResearchStore.layerWith(options.limits ? { limits: options.limits } : {}).pipe(
            Layer.provide(
              Layer.succeed(BrainDatabase.Service, BrainDatabase.Service.of({ db: setup.db, file: ":memory:" })),
            ),
            Layer.provide(Layer.succeed(BrainKnowledge.Service, setup.knowledge)),
            Layer.provide(Layer.succeed(BrainEmbed.Service, setup.embed)),
            Layer.provide(LayerNode.compile(EventV2.node)),
          ),
        ),
      ),
    options.embed ? { embed: BrainEmbed.layerHash() } : {},
  )
}

const STUDY = [
  "Heat pump field study. The study followed 412 homes through two winters in northern climates.",
  "Results. Delivered heating energy fell by 61 percent compared with the gas boilers the homes had before.",
  "Method. Smart meters were read every fifteen minutes by the utility for the whole period.",
]

const REVIEW = [
  "Review of trials. Across the published trials, measured savings ranged widely between regions and housing types.",
  "Ventilation matters. Draughty terraced houses saw the smallest savings of every housing type in the review.",
]

function page(
  name: string,
  chunks: readonly string[],
  extra: Partial<ResearchStore.SourceInput> = {},
): ResearchStore.SourceInput {
  return {
    url: `https://${name}.web.test/article`,
    canonical: `https://${name}.web.test/article`,
    site: `${name}.web.test`,
    title: `${name} field study`,
    status: "read",
    chunks: chunks.map((text, index) => ({ text, chunk: index + 1 })),
    ...extra,
  }
}

const RUN = {
  sessionID: "ses_root",
  question: "How much do heat pumps cut heating energy?",
  depth: "focused",
  scope: "web",
} satisfies ResearchStore.StartInput

const REPORT: Research.ReportInput = {
  title: "Heat pump savings",
  answer: "Delivered heating energy fell by 61 percent against gas boilers in the field study [N1].",
  sections: [
    { heading: "Measured savings", body: "Delivered heating energy fell by 61 percent against gas boilers [N1]." },
  ],
  open_questions: ["How do savings hold up in draughty houses?"],
}

const NOTE = {
  subquestion: "How much energy do heat pumps save?",
  claim: "Delivered heating energy fell by 61 percent",
  source: "S1",
  quote: "Delivered heating energy fell by 61 percent compared with the gas boilers",
} satisfies ResearchStore.NoteInput

const ask = (query: string, personal = true) => ({
  query,
  files: [],
  tier: "thorough" as const,
  tight: false,
  personal,
  exclude: new Set<string>(),
})

// A run with one source (S1), a note quoting it (N1) and a report citing the note.
const reported = (setup: Setup, start: Partial<ResearchStore.StartInput> = {}) =>
  Effect.gen(function* () {
    const run = yield* setup.store.start(setup.place, { ...RUN, ...start })
    const added = yield* setup.store.addSource(setup.place, run.id, page("homes", STUDY))
    const noted = yield* setup.store.note(setup.place, run.id, NOTE)
    const report = yield* setup.store.report(setup.place, run.id, REPORT)
    return { run, added, noted, report }
  })

const counts = (setup: Setup) =>
  setup.db.get<{
    runs: number
    sources: number
    notes: number
    documents: number
    passages: number
    postings: number
    vectors: number
  }>(
    sql`SELECT (SELECT count(*) FROM research_run) AS runs, (SELECT count(*) FROM research_source) AS sources,
          (SELECT count(*) FROM research_note) AS notes, (SELECT count(*) FROM brain_document) AS documents,
          (SELECT count(*) FROM brain_passage) AS passages, (SELECT count(*) FROM brain_posting) AS postings,
          (SELECT count(*) FROM brain_vector) AS vectors`,
  )

describe("ResearchStore sources", () => {
  test("a page read is a held private web document, indexed by keyword at once, and its passages are held too", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const run = yield* setup.store.start(setup.place, RUN)
        const added = yield* setup.store.addSource(setup.place, run.id, page("homes", STUDY))
        const document = yield* setup.db.get<{
          id: string
          origin: string
          visibility: string
          status: string
          hold: string
          run: string
          url: string
          bytes: number
        }>(
          sql`SELECT id, origin, visibility, status, hold_reason AS hold, run_id AS run, source_url AS url, bytes FROM brain_document`,
        )
        const items = yield* setup.db.all<{ status: string; hold: string; postings: number }>(
          sql`SELECT i.status, i.hold_reason AS hold, (SELECT count(*) FROM brain_posting p WHERE p.item = i.id) AS postings
              FROM brain_item i ORDER BY i.id`,
        )
        const saved = yield* setup.store.source(setup.place, run.id, "S1")
        return { run, added, document, items, saved, detail: yield* setup.store.get(setup.place, run.id) }
      }),
    )
    expect(result.added).toMatchObject({ type: "added", source: { id: "S1", status: "read", site: "homes.web.test" } })
    expect(result.document).toMatchObject({
      origin: "web",
      visibility: "private",
      status: "held",
      hold: "web",
      run: result.run.id,
      url: "https://homes.web.test/article",
      bytes: Buffer.byteLength(STUDY.join("\n\n")),
    })
    expect(result.items).toHaveLength(3)
    for (const item of result.items) {
      expect(item).toMatchObject({ status: "quarantined", hold: "web" })
      expect(item.postings).toBeGreaterThan(0)
    }
    expect(result.saved?.chunks.map((chunk) => chunk.text)).toEqual(STUDY)
    expect(result.detail?.run).toMatchObject({ status: "running", pages: 1, kept: false })
    expect(guard.outside()).toEqual([])
  })

  test("a held source is never recalled, searched, cited or read into a request, before Keep or after it", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const { run } = yield* reported(setup)
        const detail = yield* setup.db.get<{ document: string; passage: string }>(
          sql`SELECT d.id AS document, p.id AS passage FROM brain_document d JOIN brain_passage p ON p.document_id = d.id
              WHERE d.origin = 'web' AND p.body LIKE ${"%Smart meters%"}`,
        )
        const look = () =>
          Effect.gen(function* () {
            return {
              recall: yield* setup.knowledge.recall(
                setup.place,
                ask("smart meters read every fifteen minutes by the utility"),
              ),
              search: yield* setup.knowledge.search(setup.place, {
                query: "smart meters fifteen minutes utility",
                personal: true,
              }),
              cards: yield* setup.knowledge.cards(setup.place, [detail!.passage], { personal: true }),
              get: yield* setup.knowledge.get(setup.place, { id: detail!.passage, budget: 600, personal: true }),
              documents: yield* setup.knowledge.documents(setup.place, { personal: true }),
              review: yield* setup.knowledge.review(setup.place),
            }
          })
        const before = yield* look()
        yield* setup.store.keep(setup.place, run.id)
        // Approving the page itself, as the documents route could, still serves none of its held passages.
        yield* setup.knowledge.update(setup.place, detail!.document, { action: "approve" })
        return { before, after: yield* look() }
      }),
    )
    for (const look of [result.before, result.after]) {
      expect(look.recall.text ?? "").not.toContain("Smart meters")
      expect(look.search.map((card) => card.text).join(" ")).not.toContain("Smart meters")
      expect(look.cards).toEqual([])
      expect(look.get?.type).not.toBe("text")
      // Pages are listed under their run, not one by one with documents or in Needs a look.
      expect(look.documents.map((document) => document.origin)).not.toContain("web")
    }
    expect(result.before.review.map((item) => item.detail.title)).toEqual(["Heat pump savings"])
  })

  test("the same address is read once, and a copy of a page is saved as a copy with no text of its own", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const run = yield* setup.store.start(setup.place, RUN)
        const long = Array.from({ length: 12 }, (_, index) => `${STUDY[index % 3]} Paragraph ${index} of the article.`)
        yield* setup.store.addSource(setup.place, run.id, page("homes", long))
        const again = yield* setup.store.addSource(setup.place, run.id, page("homes", long))
        const copy = yield* setup.store.addSource(
          setup.place,
          run.id,
          page("syndicated", [...long, "Republished with permission."], { title: "A copy" }),
        )
        return { again, copy, documents: yield* counts(setup), detail: yield* setup.store.get(setup.place, run.id) }
      }),
    )
    expect(result.again).toMatchObject({ type: "known", source: { id: "S1" } })
    expect(result.copy).toMatchObject({ type: "duplicate", of: "S1", source: { id: "S2", status: "duplicate" } })
    expect(result.documents?.documents).toBe(1)
    expect(result.detail?.run.pages).toBe(1)
  })

  test("a page read signed in after a handoff is a private source of its own, beside the run's public excerpt", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const run = yield* setup.store.start(setup.place, RUN)
        const long = Array.from({ length: 12 }, (_, index) => `${STUDY[index % 3]} Paragraph ${index} of the article.`)
        // research_read's public read: the paywall's excerpt.
        const excerpt = yield* setup.store.addSource(
          setup.place,
          run.id,
          page("journal", long.slice(0, 2), { status: "paywalled", reason: "Paywalled" }),
        )
        // The user's own browser, signed in, after a handoff: the whole article.
        const signals: Research.Signal = {
          kind: "other",
          primary: false,
          data: false,
          references: false,
          paywalled: false,
          addressed_to_ai: false,
          corroborated: 0,
          signed_in: true,
        }
        const signedIn = { private: true, signals } satisfies Partial<ResearchStore.SourceInput>
        const full = yield* setup.store.addSource(setup.place, run.id, page("journal", long, signedIn))
        const again = yield* setup.store.addSource(setup.place, run.id, page("journal", long, signedIn))
        const publicAgain = yield* setup.store.addSource(setup.place, run.id, page("journal", long.slice(0, 2)))
        return {
          excerpt,
          full,
          again,
          publicAgain,
          saved: yield* setup.store.source(setup.place, run.id, "S2"),
          detail: yield* setup.store.get(setup.place, run.id),
        }
      }),
    )
    expect(result.excerpt).toMatchObject({ type: "added", source: { id: "S1", status: "paywalled" } })
    expect(result.full).toMatchObject({ type: "added", source: { id: "S2", status: "read" } })
    expect(result.saved?.private).toBe(true)
    expect(result.saved?.source.signals?.signed_in).toBe(true)
    expect(result.saved?.chunks.map((chunk) => chunk.text)).toHaveLength(12)
    // Reading either again is free and gives the same source.
    expect(result.again).toMatchObject({ type: "known", source: { id: "S2" } })
    expect(result.publicAgain).toMatchObject({ type: "known", source: { id: "S1" } })
    expect(result.detail?.run.pages).toBe(2)
  })

  test("a public read after a signed-in one is a source of its own, never answered with the signed-in copy", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const run = yield* setup.store.start(setup.place, RUN)
        const long = Array.from({ length: 12 }, (_, index) => `${STUDY[index % 3]} Paragraph ${index} of the article.`)
        const signals: Research.Signal = {
          kind: "other",
          primary: false,
          data: false,
          references: false,
          paywalled: false,
          addressed_to_ai: false,
          corroborated: 0,
          signed_in: true,
        }
        // The lead handed the article off and read it signed in first.
        const full = yield* setup.store.addSource(
          setup.place,
          run.id,
          page("journal", long, { private: true, signals }),
        )
        // Then a researcher reads the same address, publicly, and the page shows the same text.
        const open = yield* setup.store.addSource(setup.place, run.id, page("journal", long))
        return {
          full,
          open,
          signed: yield* setup.store.source(setup.place, run.id, "S1"),
          saved: yield* setup.store.source(setup.place, run.id, "S2"),
        }
      }),
    )
    expect(result.full).toMatchObject({ type: "added", source: { id: "S1" } })
    // Not "known" as S1, and no copy of it either: public text of its own, which a researcher may read and cite.
    expect(result.open).toMatchObject({ type: "added", source: { id: "S2", status: "read" } })
    expect(result.saved?.private).toBe(false)
    expect(result.saved?.source.signals?.signed_in).toBeUndefined()
    expect(result.signed?.private).toBe(true)
    expect(result.signed?.source.signals?.signed_in).toBe(true)
  })

  test("a copy is still found once later runs have pushed the run's pages out of memory", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const long = Array.from({ length: 12 }, (_, index) => `${STUDY[index % 3]} Paragraph ${index} of the article.`)
        const run = yield* setup.store.start(setup.place, RUN)
        yield* setup.store.addSource(setup.place, run.id, page("homes", long))
        // More runs than dedupe keeps in memory, each reading a page of its own.
        yield* Effect.forEach(
          Array.from({ length: 10 }, (_, index) => index),
          (index) =>
            Effect.gen(function* () {
              const other = yield* setup.store.start(setup.place, { ...RUN, sessionID: `ses_${index}` })
              yield* setup.store.addSource(
                setup.place,
                other.id,
                page(`other${index}`, [`${REVIEW[index % 2]} Page ${index}.`]),
              )
            }),
        )
        return yield* setup.store.addSource(
          setup.place,
          run.id,
          page("syndicated", [...long, "Republished with permission."], { title: "A copy" }),
        )
      }),
    )
    expect(result).toMatchObject({ type: "duplicate", of: "S1", source: { id: "S2", status: "duplicate" } })
  })

  test("a page first skipped as built by script is filled in, as the same source, by a read that has its text", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const run = yield* setup.store.start(setup.place, RUN)
        const skipped = yield* setup.store.addSource(setup.place, run.id, {
          ...page("app", []),
          status: "needs-render",
          reason: "This page is built by script.",
        })
        const rendered = yield* setup.store.addSource(setup.place, run.id, page("app", STUDY))
        const again = yield* setup.store.addSource(setup.place, run.id, page("app", REVIEW))
        return {
          skipped,
          rendered,
          again,
          saved: yield* setup.store.source(setup.place, run.id, "S1"),
          detail: yield* setup.store.get(setup.place, run.id),
        }
      }),
    )
    expect(result.skipped).toMatchObject({ type: "added", source: { id: "S1", status: "needs-render" } })
    expect(result.rendered).toMatchObject({ type: "added", source: { id: "S1", status: "read" } })
    expect(result.rendered.type === "added" && result.rendered.source.reason).toBeUndefined()
    expect(result.again).toMatchObject({ type: "known", source: { id: "S1" } })
    expect(result.saved?.chunks.map((chunk) => chunk.text)).toEqual(STUDY)
    expect(result.detail?.sources.map((source) => source.id)).toEqual(["S1"])
    expect(result.detail?.run.pages).toBe(1)
  })

  test("a run keeps at most its sources, its page text and its page budget, and says so", async () => {
    const result = await withStore(
      (setup) =>
        Effect.gen(function* () {
          const run = yield* setup.store.start(setup.place, { ...RUN, budget: { pages: 2, searches: 1 } })
          const one = yield* setup.store.addSource(
            setup.place,
            run.id,
            page("one", ["A first page with enough words in it to matter."]),
          )
          const big = yield* setup.store.addSource(setup.place, run.id, page("big", ["x".repeat(400)]))
          const two = yield* setup.store.addSource(
            setup.place,
            run.id,
            page("two", ["A second page with other words in it entirely."]),
          )
          const three = yield* setup.store.addSource(
            setup.place,
            run.id,
            page("three", ["A third page that the budget leaves out."]),
          )
          const skipped = yield* setup.store.addSource(setup.place, run.id, {
            ...page("script", []),
            status: "needs-render",
            reason: "This page is built by script.",
          })
          const searched = [
            yield* setup.store.searched(setup.place, run.id, "heat pump field study"),
            yield* setup.store.searched(setup.place, run.id, "heat pump savings"),
          ]
          return { one, big, two, three, skipped, searched, detail: yield* setup.store.get(setup.place, run.id) }
        }),
      { limits: { bytes: 200, sources: 5 } },
    )
    expect(result.one.type).toBe("added")
    expect(result.big).toMatchObject({ type: "refused" })
    expect(result.two.type).toBe("added")
    expect(result.three).toEqual({ type: "refused", message: ResearchStore.PAGES })
    // A skipped page costs no page: it is a line in Sources and the Method.
    expect(result.skipped).toMatchObject({ type: "added", source: { status: "needs-render" } })
    expect(result.searched).toEqual([
      { type: "counted", searches: 1 },
      { type: "refused", message: ResearchStore.SEARCHES },
    ])
    expect(result.detail?.queries).toEqual(["heat pump field study"])
    expect(result.detail?.run).toMatchObject({ pages: 2, searches: 1 })
  })
})

describe("ResearchStore notes", () => {
  test("persists optional quantitative metadata and refuses an annotation its quote does not state", async () => {
    const measurement: Research.Measurement = {
      metric: "revenue",
      value: 1.2,
      unit: "USD",
      scale: "billion",
      period: "2025",
      geography: "Europe",
    }
    const quote = "Europe revenue in 2025 was USD 1.2 billion."
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const run = yield* setup.store.start(setup.place, RUN)
        yield* setup.store.addSource(setup.place, run.id, page("market", [quote]))
      const annotated = { ...measurement, unexpected: "not part of the measurement contract" }
      const saved = yield* setup.store.note(setup.place, run.id, { ...NOTE, claim: quote, quote, measurement: annotated })
        const refused = yield* setup.store.note(setup.place, run.id, {
          ...NOTE,
          claim: quote,
          quote,
          measurement: { ...measurement, value: 9 },
        })
        return { saved, refused, detail: yield* setup.store.get(setup.place, run.id) }
      }),
    )
    expect(result.saved).toMatchObject({ type: "saved", note: { measurement } })
    expect(result.detail?.notes[0]?.measurement).toEqual(measurement)
    expect(result.refused).toMatchObject({ type: "refused" })
    expect(result.detail?.notes).toHaveLength(1)
  })

  test("refuses a forged PDF page instead of overwriting the source page", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const run = yield* setup.store.start(setup.place, RUN)
        yield* setup.store.addSource(
          setup.place,
          run.id,
          page("pdf", STUDY, {
            chunks: STUDY.map((text, index) => ({ text, chunk: index + 1, page: index + 10 })),
          }),
        )
        return {
          wrong: yield* setup.store.note(setup.place, run.id, { ...NOTE, page: 99 }),
          correct: yield* setup.store.note(setup.place, run.id, { ...NOTE, page: 11 }),
          inferred: yield* setup.store.note(setup.place, run.id, NOTE),
        }
      }),
    )
    expect(result.wrong).toMatchObject({ type: "refused", message: expect.stringContaining("page") })
    expect(result.correct).toMatchObject({ type: "saved", note: { page: 11 } })
    expect(result.inferred).toMatchObject({ type: "saved", note: { page: 11 } })
  })

  test("a public researcher receives no comparison derived from a private source", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const run = yield* setup.store.start(setup.place, RUN)
        const measurement: Research.Measurement = {
          metric: "revenue",
          value: 1.2,
          unit: "USD",
          scale: "billion",
          period: "2025",
          geography: "Europe",
        }
        const privateQuote = "Private ledger: Europe revenue in 2025 was USD 1.2 billion."
        const publicQuote = "Published annual survey: Europe revenue in 2025 was USD 1.8 billion."
        yield* setup.store.addSource(setup.place, run.id, page("private", [privateQuote], { private: true }))
        yield* setup.store.note(setup.place, run.id, { ...NOTE, claim: privateQuote, quote: privateQuote, measurement })
        yield* setup.store.addSource(setup.place, run.id, page("public", [publicQuote]))
        const params = {
          ...NOTE,
          source: "S2",
          claim: publicQuote,
          quote: publicQuote,
          measurement: { ...measurement, value: 1.8 },
        }
        return {
          public: yield* setup.store.note(setup.place, run.id, { ...params, publicOnly: true }),
          lead: yield* setup.store.note(setup.place, run.id, params),
        }
      }),
    )
    expect(result.public).toMatchObject({ type: "saved" })
    if (result.public.type === "saved") expect(result.public.comparisons).toBeUndefined()
    expect(result.lead).toMatchObject({
      type: "saved",
      comparisons: expect.arrayContaining([expect.objectContaining({ kind: "conflict" })]),
    })
  })

  test("a repeated PDF quote can cite a later page where it genuinely occurs", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const run = yield* setup.store.start(setup.place, RUN)
        yield* setup.store.addSource(
          setup.place,
          run.id,
          page("repeated", [NOTE.quote], {
            chunks: [
              { text: NOTE.quote, chunk: 1, page: 1 },
              { text: NOTE.quote, chunk: 2, page: 7 },
            ],
          }),
        )
        return yield* setup.store.note(setup.place, run.id, { ...NOTE, page: 7 })
      }),
    )
    expect(result).toMatchObject({ type: "saved", note: { page: 7 } })
  })

  test("a quote must be in its source; one that does not state the claim is saved as a paraphrase", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const run = yield* setup.store.start(setup.place, RUN)
        yield* setup.store.addSource(setup.place, run.id, page("homes", STUDY))
        return {
          missing: yield* setup.store.note(setup.place, run.id, {
            ...NOTE,
            quote: "Delivered heating energy fell by 75 percent",
          }),
          short: yield* setup.store.note(setup.place, run.id, { ...NOTE, quote: "61 percent" }),
          nowhere: yield* setup.store.note(setup.place, run.id, { ...NOTE, source: "S9" }),
          stated: yield* setup.store.note(setup.place, run.id, NOTE),
          paraphrase: yield* setup.store.note(setup.place, run.id, {
            ...NOTE,
            claim: "Heat pumps halve household bills",
            quote: "The study followed 412 homes through two winters",
          }),
          focus: yield* setup.store.focus(setup.place, run.id, "S1", "smart meters utility", 1),
        }
      }),
    )
    expect(result.missing).toEqual({
      type: "refused",
      message: "That quote is not in S1. Copy the words from S1 chunk 2.",
    })
    expect(result.short).toMatchObject({ type: "refused" })
    expect(result.nowhere).toEqual({ type: "refused", message: "There is no S9 in this run." })
    expect(result.stated).toMatchObject({
      type: "saved",
      note: { id: "N1", source: "S1", support: true, stance: "supports" },
    })
    expect(result.paraphrase).toMatchObject({ type: "saved", note: { id: "N2", support: false } })
    expect(result.focus.map((part) => part.chunk)).toEqual([3])
  })

  test("a note keeps the source's own words for its quote, and a different number is not one", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const run = yield* setup.store.start(setup.place, RUN)
        yield* setup.store.addSource(
          setup.place,
          run.id,
          page("trial", [
            "Results. Delivered heating energy fell by 61\u00a0percent \u2014 the \u201cmeasured\u201d figure at the meter.",
            "Scale. The trial enrolled 10\u2074 homes in three countries.",
          ]),
        )
        return {
          typed: yield* setup.store.note(setup.place, run.id, {
            ...NOTE,
            quote: 'Delivered heating energy fell by 61 percent - the "measured" figure',
          }),
          different: yield* setup.store.note(setup.place, run.id, {
            ...NOTE,
            claim: "The trial enrolled 104 homes",
            quote: "The trial enrolled 104 homes",
          }),
        }
      }),
    )
    expect(result.typed).toMatchObject({
      type: "saved",
      note: {
        quote: "Delivered heating energy fell by 61 percent \u2014 the \u201cmeasured\u201d figure",
        support: true,
      },
    })
    expect(result.different).toEqual({
      type: "refused",
      message: "That quote is not in S1. Copy the words from S1 chunk 2.",
    })
  })

  test("only noted passages and the report get vectors, when idle, and they go with their document", async () => {
    const result = await withStore(
      (setup) =>
        Effect.gen(function* () {
          const { run } = yield* reported(setup)
          yield* setup.store.addSource(setup.place, run.id, page("review", REVIEW))
          yield* setup.store.embed()
          const vectors = yield* setup.db.all<{ origin: string; body: string }>(
            sql`SELECT d.origin, p.body FROM brain_vector v JOIN brain_passage p ON p.item = v.item
                JOIN brain_document d ON d.id = p.document_id ORDER BY d.origin, p.ordinal`,
          )
          yield* setup.store.forget(setup.place, run.id)
          return { vectors, after: yield* counts(setup) }
        }),
      { embed: true },
    )
    const web = result.vectors.filter((row) => row.origin === "web").map((row) => row.body)
    expect(web).toEqual([STUDY[1]])
    expect(result.vectors.filter((row) => row.origin === "research").length).toBeGreaterThan(0)
    expect(result.after).toMatchObject({ runs: 0, documents: 0, passages: 0, postings: 0, vectors: 0 })
  })
})

describe("ResearchStore reports", () => {
  test("the report is held; Keep makes it recallable for the owner, never where personal memory is withheld", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const { run, report } = yield* reported(setup)
        const passages = (yield* setup.db.all<{ id: string }>(
          sql`SELECT p.id FROM brain_passage p JOIN brain_document d ON d.id = p.document_id WHERE d.origin = 'research'`,
        )).map((row) => row.id)
        const query = "delivered heating energy fell gas boilers measured savings"
        const before = yield* setup.knowledge.recall(setup.place, ask(query))
        const kept = yield* setup.store.keep(setup.place, run.id)
        return {
          report,
          passages,
          kept,
          before,
          owner: yield* setup.knowledge.recall(setup.place, ask(query)),
          withheld: yield* setup.knowledge.recall(setup.place, ask(query, false)),
          detail: yield* setup.store.get(setup.place, run.id),
        }
      }),
    )
    const report = (ids: readonly string[]) => ids.filter((id) => result.passages.includes(id))
    expect(result.report).toMatchObject({ type: "saved", version: 1 })
    expect(result.report.type === "saved" && result.report.rendered.markdown).toContain("# Heat pump savings")
    expect(result.passages.length).toBeGreaterThan(0)
    expect(report(result.before.ids)).toEqual([])
    expect(result.kept).toMatchObject({ type: "kept", run: { kept: true } })
    expect(report(result.owner.ids).length).toBeGreaterThan(0)
    // personal is false for a session a guest is in and for a model that may train on prompts.
    expect(report(result.withheld.ids)).toEqual([])
    expect(result.detail?.report).toContain("Delivered heating energy fell by 61 percent")
  })

  test("a report citing a note that is not saved is refused, and a new version is held again", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const { run } = yield* reported(setup)
        const refused = yield* setup.store.report(setup.place, run.id, {
          ...REPORT,
          answer: "It fell by 61 percent [N4].",
        })
        yield* setup.store.keep(setup.place, run.id)
        const next = yield* setup.store.report(setup.place, run.id, { ...REPORT, title: "Heat pump savings, revised" })
        const documents = yield* setup.db.all<{ title: string; status: string; version: number }>(
          sql`SELECT title, status, version FROM brain_document WHERE origin = 'research'`,
        )
        return { refused, next, documents, detail: yield* setup.store.get(setup.place, run.id) }
      }),
    )
    expect(result.refused).toMatchObject({ type: "refused" })
    expect(result.refused.type === "refused" && result.refused.errors[0]).toContain("[N4] is not a saved note")
    expect(result.next).toMatchObject({ type: "saved", version: 2 })
    expect(result.documents).toEqual([{ title: "Heat pump savings, revised", status: "held", version: 2 }])
    expect(result.detail?.run.kept).toBe(false)
  })

  test("export gives the report with a bibliography as Markdown, and the run as JSON", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const { run } = yield* reported(setup)
        return {
          markdown: yield* setup.store.export(setup.place, run.id, "markdown"),
          json: yield* setup.store.export(setup.place, run.id, "json"),
          none: yield* setup.store.export(setup.place, "run_missing", "json"),
        }
      }),
    )
    expect(result.markdown).toMatchObject({
      name: "research-how-much-do-heat-pumps-cut-heating-energy.md",
      type: "text/markdown",
    })
    expect(result.markdown?.body).toContain("# Heat pump savings")
    expect(result.markdown?.body).toContain("## Bibliography")
    expect(result.markdown?.body).toContain(
      "- S1. homes field study. homes.web.test. <https://homes.web.test/article>.",
    )
    const json = JSON.parse(result.json!.body)
    expect(result.json?.type).toBe("application/json")
    expect(json.run.question).toBe(RUN.question)
    expect(json.sources.map((source: { id: string }) => source.id)).toEqual(["S1"])
    expect(json.notes.map((note: { id: string; quote: string }) => [note.id, note.quote])).toEqual([["N1", NOTE.quote]])
    expect(json.report).toContain("## Sources")
    expect(result.none).toBeUndefined()
  })

  test("the Markdown export leaves a page's title inert, backslashes and brackets included", async () => {
    const exported = await withStore((setup) =>
      Effect.gen(function* () {
        const run = yield* setup.store.start(setup.place, RUN)
        yield* setup.store.addSource(
          setup.place,
          run.id,
          page("homes", STUDY, {
            title: "\\<img src=x onerror=alert(1)> ![x](https://evil.web.test/p.png) [click](https://evil.web.test)",
          }),
        )
        return yield* setup.store.export(setup.place, run.id, "markdown")
      }),
    )
    const line = exported?.body.split("\n").find((text) => text.startsWith("- S1."))
    expect(line).toMatch(/ Read \d{4}-\d{2}-\d{2}\.$/)
    expect(line?.replace(/ Read \d{4}-\d{2}-\d{2}\.$/, "")).toBe(
      "- S1. \\\\\\<img src=x onerror=alert(1)> !\\[x\\](https://evil.web.test/p.png) \\[click\\](https://evil.web.test). homes.web.test. <https://homes.web.test/article>.",
    )
  })
})

describe("ResearchStore forgetting", () => {
  test("forgetting a source deletes its page and leaves tombstones; its notes say their quote is gone", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const { run } = yield* reported(setup)
        const before = yield* counts(setup)
        const forgot = yield* setup.store.forgetSource(setup.place, run.id, "S1")
        const report = yield* setup.store.report(setup.place, run.id, REPORT)
        const detail = yield* setup.store.get(setup.place, run.id)
        // A later run does not keep the page again on its own, at its address or under another.
        const later = yield* setup.store.start(setup.place, { ...RUN, sessionID: "ses_later" })
        const again = yield* setup.store.addSource(setup.place, later.id, page("homes", STUDY))
        const elsewhere = yield* setup.store.addSource(setup.place, later.id, page("mirror", STUDY))
        const fresh = yield* setup.store.addSource(setup.place, later.id, page("review", REVIEW))
        return { before, forgot, report, detail, again, elsewhere, fresh, after: yield* counts(setup) }
      }),
    )
    expect(result.forgot).toBe(true)
    expect(result.detail?.sources[0]).toMatchObject({ id: "S1", forgotten: true })
    expect(result.detail?.notes.map((note) => note.id)).toEqual(["N1"])
    expect(result.report.type === "saved" && result.report.rendered.removed).toEqual(["N1"])
    expect(result.report.type === "saved" && result.report.rendered.markdown).toContain(
      "Its quote is no longer in its source.",
    )
    expect(result.again).toMatchObject({ type: "added", source: { status: "failed", reason: ResearchStore.FORGOTTEN } })
    expect(result.elsewhere).toMatchObject({
      type: "added",
      source: { status: "failed", reason: ResearchStore.FORGOTTEN },
    })
    expect(result.fresh).toMatchObject({ type: "added", source: { status: "read" } })
    // The study's page is gone: the review's page and the report are what is left.
    expect(result.after?.documents).toBe(2)
  })

  test("forgetting a run, and all of a repository's research, deletes every row and page", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const { run } = yield* reported(setup)
        const other = yield* reported(setup, { sessionID: "ses_other" })
        const third = yield* setup.store.start(setup.place, { ...RUN, sessionID: "ses_third" })
        yield* setup.store.addSource(setup.place, third.id, page("review", REVIEW))
        const forgot = yield* setup.store.forget(setup.place, run.id)
        const one = yield* counts(setup)
        const all = yield* setup.store.forgetAll(setup.place)
        const tombstones = yield* setup.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM brain_tombstone`)
        // The keyword index is counted again: no term is left with no passage, and BM25's totals are back to none.
        const index = yield* setup.db.get<{ terms: number; items: number; length: number }>(
          sql`SELECT (SELECT count(*) FROM brain_term) AS terms, items, item_length_sum AS length FROM brain_state
              WHERE repository_id = ${setup.place.repository}`,
        )
        return {
          forgot,
          one,
          all,
          tombstones,
          index,
          other: other.run.id,
          after: yield* counts(setup),
          list: yield* setup.store.list(setup.place),
        }
      }),
    )
    expect(result.forgot).toBe(true)
    expect(result.one).toMatchObject({ runs: 2, sources: 2, notes: 1 })
    expect(result.all).toBe(2)
    expect(result.after).toMatchObject({ runs: 0, sources: 0, notes: 0, documents: 0, passages: 0, postings: 0 })
    expect(result.tombstones?.n).toBeGreaterThan(0)
    expect(result.index).toEqual({ terms: 0, items: 0, length: 0 })
    expect(result.list).toEqual([])
  })

  test("runs nobody kept go after 30 days; kept ones, and ones whose report was approved, stay", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const old = yield* reported(setup)
        const kept = yield* reported(setup, { sessionID: "ses_kept" })
        const approved = yield* reported(setup, { sessionID: "ses_approved" })
        const recent = yield* reported(setup, { sessionID: "ses_recent" })
        yield* setup.store.keep(setup.place, kept.run.id)
        // Approved where held content waits, rather than with Keep.
        const report = (yield* setup.store.get(setup.place, approved.run.id))!.run.report_document_id!
        yield* setup.knowledge.resolve(setup.place, report, { action: "approve" })
        const month = Date.now() - 31 * 24 * 60 * 60 * 1000
        yield* setup.db.run(sql`UPDATE research_run SET updated_at = ${month} WHERE id != ${recent.run.id}`)
        const swept = yield* setup.store.sweep()
        // The sweep is not the user's Forget: a later run may read those pages again.
        const later = yield* setup.store.start(setup.place, { ...RUN, sessionID: "ses_later" })
        const again = yield* setup.store.addSource(setup.place, later.id, page("homes", STUDY))
        const runs = (yield* setup.store.list(setup.place)).map((summary) => summary.run.id)
        return {
          swept,
          runs,
          again,
          ids: {
            old: old.run.id,
            kept: kept.run.id,
            approved: approved.run.id,
            recent: recent.run.id,
            later: later.id,
          },
        }
      }),
    )
    expect(result.swept).toBe(1)
    expect(result.runs.toSorted()).toEqual(
      [result.ids.kept, result.ids.approved, result.ids.recent, result.ids.later].toSorted(),
    )
    expect(result.runs).not.toContain(result.ids.old)
    expect(result.again).toMatchObject({ type: "added", source: { status: "read" } })
  })

  test("past the repository cap, the oldest runs nobody kept go first, and the add says so", async () => {
    const text = (word: string) => [`${word} `.repeat(40).trim()]
    const result = await withStore(
      (setup) =>
        Effect.gen(function* () {
          const oldest = yield* setup.store.start(setup.place, { ...RUN, sessionID: "ses_1" })
          yield* setup.store.addSource(setup.place, oldest.id, page("alpha", text("alpha")))
          const kept = yield* setup.store.start(setup.place, { ...RUN, sessionID: "ses_2" })
          yield* setup.store.addSource(setup.place, kept.id, page("bravo", text("bravo")))
          yield* setup.store.keep(setup.place, kept.id)
          const newer = yield* setup.store.start(setup.place, { ...RUN, sessionID: "ses_3" })
          yield* setup.store.addSource(setup.place, newer.id, page("charlie", text("charlie")))
          const current = yield* setup.store.start(setup.place, { ...RUN, sessionID: "ses_4" })
          const first = yield* setup.store.addSource(setup.place, current.id, page("delta", text("delta")))
          const second = yield* setup.store.addSource(setup.place, current.id, page("echo", text("echo")))
          const full = yield* setup.store.addSource(setup.place, current.id, page("foxtrot", text("foxtrot")))
          const left = (yield* setup.store.list(setup.place)).map((summary) => summary.run.id)
          return {
            first,
            second,
            full,
            left,
            ids: { oldest: oldest.id, kept: kept.id, newer: newer.id, current: current.id },
          }
        }),
      // Each page is about 240 bytes: three fit, a fourth needs room.
      { limits: { repository: 800 } },
    )
    expect(result.first).toMatchObject({ type: "added", evicted: [result.ids.oldest] })
    expect(result.second).toMatchObject({ type: "added", evicted: [result.ids.newer] })
    expect(result.full).toMatchObject({ type: "refused" })
    expect(result.full.type === "refused" && result.full.message).toContain("Forget some runs to read more.")
    expect(result.left.toSorted()).toEqual([result.ids.kept, result.ids.current].toSorted())
  })
})

describe("ResearchStore guests", () => {
  test("a run started in a session a guest acted in keeps nothing in the brain", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const { run, added, noted, report } = yield* reported(setup, { guest: true })
        return {
          added,
          noted,
          report,
          stored: yield* counts(setup),
          detail: yield* setup.store.get(setup.place, run.id),
          list: yield* setup.store.list(setup.place),
          keep: yield* setup.store.keep(setup.place, run.id),
        }
      }),
    )
    expect(result.added.type).toBe("added")
    expect(result.noted.type).toBe("saved")
    expect(result.report).toMatchObject({ type: "saved", version: 1 })
    expect(result.report.type === "saved" && result.report.document).toBeUndefined()
    expect(result.stored).toEqual({ runs: 0, sources: 0, notes: 0, documents: 0, passages: 0, postings: 0, vectors: 0 })
    expect(result.detail).toMatchObject({ guest: true, run: { status: "done" } })
    expect(result.detail?.report).toContain("# Heat pump savings")
    expect(result.list).toEqual([])
    expect(result.keep).toEqual({ type: "refused", message: ResearchStore.GUEST })
  })

  test("a run a guest joins leaves the brain, and goes on in memory with what it had", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const run = yield* setup.store.start(setup.place, RUN)
        yield* setup.store.addSource(setup.place, run.id, page("homes", STUDY))
        yield* setup.store.note(setup.place, run.id, NOTE)
        const before = yield* counts(setup)
        yield* setup.store.guest(setup.place, run.id)
        const moved = yield* counts(setup)
        const quoted = yield* setup.store.quoted(setup.place, run.id, "S1", NOTE.quote)
        const added = yield* setup.store.addSource(setup.place, run.id, page("review", REVIEW))
        const report = yield* setup.store.report(setup.place, run.id, REPORT)
        return {
          before,
          moved,
          quoted,
          added,
          report,
          after: yield* counts(setup),
          detail: yield* setup.store.get(setup.place, run.id),
        }
      }),
    )
    expect(result.before).toMatchObject({ runs: 1, sources: 1, notes: 1, documents: 1 })
    expect(result.moved).toMatchObject({ runs: 0, sources: 0, notes: 0, documents: 0, passages: 0, postings: 0 })
    expect(result.quoted).toMatchObject({ ok: true, chunk: 2 })
    expect(result.added).toMatchObject({ type: "added", source: { id: "S2" } })
    expect(result.report).toMatchObject({ type: "saved" })
    expect(result.after).toEqual(result.moved)
    expect(result.detail?.sources.map((source) => source.id)).toEqual(["S1", "S2"])
    expect(result.detail?.notes.map((note) => note.id)).toEqual(["N1"])
  })

  test("forgetting all research, or the retention, also clears runs a guest acted in from memory", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const guest = (yield* reported(setup, { guest: true, sessionID: "ses_guest_one" })).run
        const owner = (yield* reported(setup)).run
        const all = yield* setup.store.forgetAll(setup.place)
        // Still reading when the process has run past the retention.
        const old = yield* setup.store.start(setup.place, { ...RUN, guest: true, sessionID: "ses_guest_two" })
        yield* setup.store.addSource(setup.place, old.id, page("homes", STUDY))
        const fresh = yield* setup.store.sweep()
        const before = yield* setup.store.active(setup.place, "ses_guest_two")
        const swept = yield* setup.store.sweep(Date.now() + 31 * 24 * 60 * 60 * 1000)
        return {
          all,
          fresh,
          before,
          swept,
          guest: yield* setup.store.get(setup.place, guest.id),
          owner: yield* setup.store.get(setup.place, owner.id),
          old: yield* setup.store.get(setup.place, old.id),
          after: yield* setup.store.active(setup.place, "ses_guest_two"),
        }
      }),
    )
    expect(result.all).toBe(2)
    expect(result.guest).toBeUndefined()
    expect(result.owner).toBeUndefined()
    expect(result.fresh).toBe(0)
    expect(result.before).toMatchObject({ id: expect.any(String), status: "running" })
    expect(result.swept).toBe(1)
    expect(result.old).toBeUndefined()
    expect(result.after).toBeUndefined()
  })
})

// Erasing memory takes the research of what it erases (BrainErase), as Settings > Memory, the learned chip and
// `vector memory erase` ask for it.
describe("ResearchStore and erasing memory", () => {
  // What Vector learned in a repository, from one session.
  const learned = (setup: Setup, sessionID: string) =>
    setup.brain.propose(setup.place, {
      kind: "preference",
      text: "Run the payments tests with bun before committing",
      scope: "repository",
      origin: "agent",
      evidence: {
        type: "message",
        quote: "I always run the payments tests with bun before committing",
        verified: true,
      },
      sessionID,
      pending: "review",
    })
  const elsewhere = (setup: Setup): Brain.Place => ({ ...setup.place, repository: "repo-2" })

  test("forgetting a session's runs takes the ones it started, kept or in memory, and leaves every other", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const mine = (yield* reported(setup, { sessionID: "ses_erase" })).run
        const kept = yield* setup.store.keep(setup.place, mine.id)
        const guest = yield* setup.store.start(setup.place, { ...RUN, sessionID: "ses_erase", guest: true })
        const other = (yield* reported(setup, { sessionID: "ses_other" })).run
        const away = yield* setup.store.start(elsewhere(setup), { ...RUN, sessionID: "ses_erase" })
        const forgot = yield* setup.store.forgetAll(setup.place, { session: "ses_erase" })
        // As Forget does, it leaves tombstones: a later run does not keep the page again on its own.
        const later = yield* setup.store.start(setup.place, { ...RUN, sessionID: "ses_later" })
        const again = yield* setup.store.addSource(setup.place, later.id, page("homes", STUDY))
        return {
          kept,
          forgot,
          again,
          mine: yield* setup.store.get(setup.place, mine.id),
          guest: yield* setup.store.get(setup.place, guest.id),
          other: yield* setup.store.get(setup.place, other.id),
          away: yield* setup.store.get(elsewhere(setup), away.id),
        }
      }),
    )
    expect(result.kept).toMatchObject({ type: "kept" })
    expect(result.forgot).toBe(2)
    expect(result.mine).toBeUndefined()
    expect(result.guest).toBeUndefined()
    expect(result.other).toMatchObject({ run: { session_id: "ses_other" }, sources: [{ id: "S1" }] })
    // A session belongs to one repository: only the repository it is erased in is searched.
    expect(result.away).toMatchObject({ run: { session_id: "ses_erase" } })
    expect(result.again).toMatchObject({ type: "added", source: { status: "failed", reason: ResearchStore.FORGOTTEN } })
  })

  test("erasing a repository's memory, or all of it, forgets its research; erasing what Vector learned about you keeps it", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const stores = { brain: setup.brain, research: setup.store, place: setup.place }
        const ids = (place: Brain.Place) =>
          setup.store.list(place).pipe(Effect.map((runs) => runs.map((item) => item.run.id)))
        const run = (yield* reported(setup)).run
        const away = yield* setup.store.start(elsewhere(setup), RUN)
        const personal = yield* BrainErase.erase({ ...stores, scope: "personal" })
        const afterPersonal = yield* ids(setup.place)
        yield* learned(setup, "ses_root")
        const repository = yield* BrainErase.erase({ ...stores, scope: "repository" })
        const afterRepository = { here: yield* ids(setup.place), away: yield* ids(elsewhere(setup)) }
        // The brain's erase clears the tombstones Forget left, so the same page can be read again.
        const fresh = (yield* reported(setup, { sessionID: "ses_fresh" })).added
        const all = yield* BrainErase.erase({ ...stores, scope: "all" })
        return {
          run: run.id,
          away: away.id,
          personal,
          afterPersonal,
          repository,
          afterRepository,
          fresh,
          all,
          afterAll: { here: yield* ids(setup.place), away: yield* ids(elsewhere(setup)) },
          stored: yield* counts(setup),
        }
      }),
    )
    expect(result.personal).toEqual({ entries: 0, runs: 0 })
    expect(result.afterPersonal).toEqual([result.run])
    expect(result.repository).toEqual({ entries: 1, runs: 1 })
    expect(result.afterRepository).toEqual({ here: [], away: [result.away] })
    expect(result.fresh).toMatchObject({ type: "added", source: { status: "read" } })
    expect(result.all).toEqual({ entries: 0, runs: 2 })
    expect(result.afterAll).toEqual({ here: [], away: [] })
    expect(result.stored).toMatchObject({ runs: 0, sources: 0, notes: 0, documents: 0, passages: 0, postings: 0 })
  })

  test("erasing what Vector learned in a session forgets the runs that session started", async () => {
    const result = await withStore((setup) =>
      Effect.gen(function* () {
        const stores = { brain: setup.brain, research: setup.store, place: setup.place }
        const mine = (yield* reported(setup, { sessionID: "ses_erase" })).run
        const other = (yield* reported(setup, { sessionID: "ses_other" })).run
        const taught = yield* learned(setup, "ses_erase")
        const erased = yield* BrainErase.session({ ...stores, sessionID: "ses_erase" })
        const none = yield* BrainErase.session({ ...stores, sessionID: "ses_none" })
        return {
          taught,
          erased,
          none,
          mine: yield* setup.store.get(setup.place, mine.id),
          other: yield* setup.store.get(setup.place, other.id),
          entries: yield* setup.brain.list(setup.place, { filter: "all", scope: "repository" }),
        }
      }),
    )
    expect(result.taught).toMatchObject({ type: "added" })
    expect(result.erased).toEqual({ entries: 1, runs: 1 })
    expect(result.none).toEqual({ entries: 0, runs: 0 })
    expect(result.mine).toBeUndefined()
    expect(result.other).toMatchObject({ run: { session_id: "ses_other" } })
    expect(result.entries).toEqual([])
  })
})

describe("research migration", () => {
  test("applies on a copy of a brain.db from before it, and keeps what that held", async () => {
    await using tmp = await tmpdir()
    const fixture = path.join(tmp.path, "fixture", "brain.db")
    const copy = path.join(tmp.path, "data", "brain", "brain.db")
    await fs.mkdir(path.dirname(fixture), { recursive: true })
    await fs.mkdir(path.dirname(copy), { recursive: true })
    // A brain as the release before research leaves it: an entry, and a document with a passage indexed by keyword.
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* DatabaseMigration.applyOnly(db, [
          first,
          knowledgeMigration,
          privateMemory,
          tombstoneTerms,
          credit,
          code,
          creditedOnce,
        ])
        yield* db.run(sql`
          INSERT INTO brain_entry (id, scope, repository_id, kind, origin, status, body, paths, terms, norm_hash,
            confidence, created_at, updated_at, related)
          VALUES ('m1a2b3', 'repository', 'repo-1', 'lesson', 'user', 'active', 'Deploy staging from the release branch.',
            '[]', '{}', 'hash', 1, 1, 1, '[]')
        `)
        yield* db.run(sql`
          INSERT INTO brain_document (id, repository_id, lineage, ordinal, name, title, format, origin, visibility,
            content_hash, bytes, unread, status, stats, warnings, extractor, created_at, updated_at)
          VALUES ('d1', 'repo-1', 'spec.md', 1, 'spec.md', 'Spec', 'markdown', 'upload', 'private', 'h1', 10, '[]',
            'searchable', '{}', '[]', 1, 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO brain_item (repository_id, type, ref, document_id, visibility, status, length, confidence)
          VALUES ('repo-1', 'passage', 'p1', 'd1', 'private', 'active', 3, 1)
        `)
        yield* db.run(sql`INSERT INTO brain_term (repository_id, term, df) VALUES ('repo-1', 'deploy', 1)`)
        yield* db.run(sql`INSERT INTO brain_posting (term, item, count) VALUES (1, 1, 2)`)
        // Everything into the file itself, so a copy of the file is the whole brain.
        yield* db.run(sql`PRAGMA journal_mode = DELETE`)
      }).pipe(Effect.provide(SqliteClient.layer({ filename: fixture })), Effect.scoped),
    )
    await fs.copyFile(fixture, copy)
    await Effect.runPromise(Effect.scoped(Layer.build(BrainDatabase.layerFor(copy))))

    const db = new Database(copy, { readonly: true })
    const migrations = (db.query("SELECT id FROM migration ORDER BY id").all() as { id: string }[]).map((row) => row.id)
    const document = db.query("SELECT id, origin, source_url, fetched_at, run_id FROM brain_document").all()
    const kept = {
      entries: db.query("SELECT id FROM brain_entry").all(),
      postings: db.query("SELECT term, item, count FROM brain_posting").all(),
    }
    const shapes = [ResearchRunTable, ResearchSourceTable, ResearchNoteTable, BrainDocumentTable].map((table) => ({
      declared: declared(table),
      stored: stored(db, getTableConfig(table).name),
    }))
    const triggers = db.query("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()
    db.close()
    const untouched = new Database(fixture, { readonly: true })
    const before = (untouched.query("SELECT id FROM migration").all() as { id: string }[]).length
    untouched.close()

    expect(migrations).toContain("20261201000000_research")
    expect(before).toBe(7)
    expect(document).toEqual([{ id: "d1", origin: "upload", source_url: null, fetched_at: null, run_id: null }])
    expect(kept).toEqual({ entries: [{ id: "m1a2b3" }], postings: [{ term: 1, item: 1, count: 2 }] })
    for (const shape of shapes) expect(shape.stored).toEqual(shape.declared)
    expect(triggers).toEqual([{ name: "research_report_forgotten" }])
  })
})

// A table as sql.ts declares it, and as the migrations built it: columns, keys, indexes and foreign keys.
function declared(table: SQLiteTable) {
  const config = getTableConfig(table)
  const names = (columns: readonly unknown[]) =>
    columns.filter((column): column is SQLiteColumn => column instanceof SQLiteColumn).map((column) => column.name)
  return {
    columns: config.columns
      .map((column) => ({
        name: column.name,
        type: column.getSQLType(),
        notNull: column.notNull,
        default: column.hasDefault && !column.primary,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
    indexes: config.indexes
      .map((index) => ({ unique: index.config.unique, columns: names(index.config.columns) }))
      .toSorted((a, b) => a.columns.join().localeCompare(b.columns.join())),
    foreign: config.foreignKeys
      .map((key) => {
        const reference = key.reference()
        return {
          from: names(reference.columns),
          table: getTableConfig(reference.foreignTable).name,
          delete: key.onDelete ?? "no action",
        }
      })
      .toSorted((a, b) => a.from.join().localeCompare(b.from.join())),
  }
}

function stored(db: Database, name: string) {
  type Column = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
  type Index = { name: string; unique: number; origin: string }
  type Key = { id: number; table: string; from: string; on_delete: string }
  const columns = db.query(`PRAGMA table_info('${name}')`).all() as Column[]
  const single =
    columns.filter((column) => column.pk > 0).length === 1 ? columns.find((column) => column.pk > 0)?.name : undefined
  const indexes = (db.query(`PRAGMA index_list('${name}')`).all() as Index[]).filter((index) => index.origin === "c")
  const keys = db.query(`PRAGMA foreign_key_list('${name}')`).all() as Key[]
  return {
    columns: columns
      .map((column) => ({
        name: column.name,
        type: column.type.toLowerCase(),
        notNull: column.notnull === 1 || column.name === single,
        default: column.dflt_value !== null,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
    indexes: indexes
      .map((index) => ({
        unique: index.unique === 1,
        columns: (db.query(`PRAGMA index_info('${index.name}')`).all() as { name: string }[]).map(
          (column) => column.name,
        ),
      }))
      .toSorted((a, b) => a.columns.join().localeCompare(b.columns.join())),
    foreign: keys
      .map((key) => ({ from: [key.from], table: key.table, delete: key.on_delete.toLowerCase() }))
      .toSorted((a, b) => a.from.join().localeCompare(b.from.join())),
  }
}
