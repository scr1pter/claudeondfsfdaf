import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainCard } from "@vectordevai/core/brain/card"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { Token } from "@vectordevai/core/util/token"
import { SPEC_V1 } from "./fixture/documents"
import { added, text, withKnowledge } from "./fixture/knowledge"
import { lines, pdf } from "./fixture/pdf"

const ask = (query: string, overrides: Partial<Parameters<BrainKnowledge.Interface["recall"]>[1]> = {}) => ({
  query,
  files: [],
  tier: "standard" as const,
  tight: false,
  personal: true,
  exclude: new Set<string>(),
  sessionID: "ses_1",
  ...overrides,
})

const LESSON = "Refresh token rotation lives in src/auth/session.ts; the refresh token is single use."

describe("BrainKnowledge.recall", () => {
  test("outward recall ranks approved lessons and withholds repository and private cards", async () => {
    await withKnowledge((setup) =>
      Effect.gen(function* () {
        const lesson = "Check refresh token expiry with a deterministic fixture."
        yield* setup.brain.propose(setup.place, { kind: "lesson", text: lesson, scope: "repository", origin: "user" })
        yield* added(setup, { ...text("Repository auth spec.md", SPEC_V1), origin: "repository" })
        yield* added(setup, text("Local notes.md", "# Refresh token expiry\n\nOnly the owner should see this detail."))
        const query = "what is the refresh token expiry and TTL?"
        const ordinary = yield* setup.knowledge.recall(setup.place, ask(query, { personal: false }))
        expect(ordinary.text).toContain("Refresh tokens expire after 14 days.")
        const outward = yield* setup.knowledge.recall(setup.place, ask(query, { audience: "outward" }))
        expect(outward.text).toContain(lesson)
        expect(outward.cards).toEqual([])
        expect(outward.documents).toBe(false)
        expect(outward.text).not.toContain("14 days")
        expect(outward.text).not.toContain("Only the owner")
      }),
    )
  })

  test("a repository without documents recalls exactly what memory alone does", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* setup.brain.propose(setup.place, { kind: "lesson", text: LESSON, scope: "repository", origin: "user" })
        const request = ask("how does refresh token rotation work?")
        const fromKnowledge = yield* setup.knowledge.recall(setup.place, request)
        const fromMemory = yield* setup.brain.recall(setup.place, {
          query: request.query,
          files: [],
          budget: Brain.recallBudget("standard"),
          personal: true,
          exclude: new Set(),
        })
        return { fromKnowledge, fromMemory }
      }),
    )
    expect(result.fromKnowledge.text).toBe(result.fromMemory.text!)
    expect(result.fromKnowledge.documents).toBe(false)
    expect(result.fromKnowledge.cards).toEqual([])
  })

  test("a related request gets the spec's card, within the budget; an unrelated one gets nothing", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        return {
          ttl: yield* setup.knowledge.recall(setup.place, ask("what is the refresh token TTL?")),
          hi: yield* setup.knowledge.recall(setup.place, ask("hi")),
          thanks: yield* setup.knowledge.recall(setup.place, ask("thanks, that looks good to me")),
          chat: yield* setup.knowledge.recall(setup.place, ask("what is the refresh token TTL?", { tier: "chat" })),
        }
      }),
    )
    expect(result.ttl.text).toContain("Refresh tokens expire after 14 days.")
    expect(result.ttl.text).toContain(BrainCard.DOCUMENTS)
    expect(result.ttl.text).toMatch(/- \[r[0-9a-z]{12}\] constraint · Auth spec §1: Refresh tokens expire after 14 days\./)
    expect(result.ttl.cards.length).toBeGreaterThan(0)
    expect(result.ttl.cards.every((id) => result.ttl.ids.includes(id))).toBe(true)
    expect(result.ttl.tokens).toBe(Token.estimate(result.ttl.text!))
    expect(result.ttl.tokens).toBeLessThanOrEqual(BrainKnowledge.budget("standard", { documents: true, tight: false }))
    // What a transcript may keep holds no card.
    expect(result.ttl.shared ?? "").not.toContain("14 days")
    expect(result.ttl.why[result.ttl.cards[0]!]).toStartWith("terms:")
    for (const empty of [result.hi, result.thanks, result.chat]) {
      expect(empty.text ?? "").toBe("")
      expect(empty.tokens).toBe(0)
    }
  })

  test("memory and documents share one budget, memory first", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* setup.brain.propose(setup.place, { kind: "lesson", text: LESSON, scope: "repository", origin: "user" })
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        return yield* setup.knowledge.recall(setup.place, ask("change how the refresh token expires and rotates"))
      }),
    )
    const sent = result.text ?? ""
    expect(sent).toContain(LESSON)
    expect(sent).toContain("Refresh tokens expire after 14 days.")
    expect(sent.indexOf(LESSON)).toBeLessThan(sent.indexOf("Refresh tokens expire"))
    expect(result.shared).toContain(LESSON)
  })

  test("a tight run halves the budget, and Light gets less than Thorough", async () => {
    expect(BrainKnowledge.budget("standard", { documents: true, tight: true })).toBe(250)
    expect(BrainKnowledge.budget("light", { documents: true, tight: false })).toBe(300)
    expect(BrainKnowledge.budget("thorough", { documents: true, tight: false })).toBe(900)
    expect(BrainKnowledge.budget("thorough", { documents: false, tight: true })).toBe(Brain.recallBudget("thorough"))
    const long = Array.from(
      { length: 40 },
      (_, index) => `## ${index + 1} Limit ${index}\n\nThe upload service MUST reject uploads over ${index + 10} MB for tenant ${index}.`,
    ).join("\n\n")
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Upload limits.md", `# Upload limits\n\n${long}`))
        const request = ask("upload service limits for tenants that reject uploads")
        return {
          tight: yield* setup.knowledge.recall(setup.place, { ...request, tight: true }),
          light: yield* setup.knowledge.recall(setup.place, { ...request, tier: "light" }),
          thorough: yield* setup.knowledge.recall(setup.place, { ...request, tier: "thorough" }),
        }
      }),
    )
    expect(result.tight.tokens).toBeGreaterThan(0)
    expect(result.tight.tokens).toBeLessThanOrEqual(250)
    expect(result.light.tokens).toBeLessThanOrEqual(300)
    expect(result.thorough.tokens).toBeLessThanOrEqual(900)
    // At most four cards from one document.
    expect(result.thorough.cards.length).toBeLessThanOrEqual(4)
  })

  test("private documents are withheld where personal memory is; the repository's own docs are not", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          const { document } = yield* added(setup, text("Auth spec.md", SPEC_V1))
          yield* added(setup, { type: "path", path: "docs/uploads.md", origin: "repository" })
          const withheld = yield* setup.knowledge.recall(
            setup.place,
            ask("what is the refresh token TTL and the upload limit per file?", { personal: false }),
          )
          const card = (yield* setup.knowledge.recall(setup.place, ask("what is the refresh token TTL?"))).cards[0]!
          return {
            withheld,
            lines: yield* setup.knowledge.lines(setup.place, [card], { personal: false }),
            get: yield* setup.knowledge.get(setup.place, { id: card, budget: 600, personal: false }),
            outline: yield* setup.knowledge.get(setup.place, { id: document!.id, budget: 600, personal: false }),
            search: yield* setup.knowledge.search(setup.place, { query: "refresh token", personal: false }),
            count: yield* setup.knowledge.count(setup.place, { personal: false }),
            digest: yield* setup.knowledge.digest(setup.place, { personal: false }),
          }
        }),
      { files: { "docs/uploads.md": "# Uploads\n\nUploads are limited to 64 MB per file for every tenant." } },
    )
    expect(result.withheld.text).toContain("64 MB per file")
    expect(result.withheld.text).not.toContain("14 days")
    expect(result.lines.size).toBe(0)
    expect(result.get).toMatchObject({ type: "withheld" })
    expect(result.get?.text).toContain("withheld from models that may train on prompts")
    expect(result.outline).toMatchObject({ type: "withheld" })
    expect(result.search.map((card) => card.text).join(" ")).not.toContain("14 days")
    expect(result.count).toBe(1)
    expect(result.digest).toBe("Vector also holds 1 document for this repository (Uploads); memory search finds their cards.")
  })

  test("get opens a card's passage as data, a document's outline, and a page", async () => {
    const bytes = pdf({
      pages: [
        { runs: [{ text: "Auth spec", x: 72, y: 740, size: 20, font: "bold" }, ...lines(["Refresh tokens expire after 14 days."], { top: 700 })] },
        { runs: lines(["Clients MUST retry at most 3 times after a 429 response."]) },
      ],
      outline: [
        { title: "Sessions", page: 1 },
        { title: "Limits", page: 2 },
      ],
      title: "Auth spec",
    })
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const { document } = yield* added(setup, { type: "bytes", name: "auth.pdf", bytes, origin: "upload" })
        const card = (yield* setup.knowledge.recall(setup.place, ask("how many times do clients retry after a 429?"))).cards.find(
          (id) => id.startsWith("r"),
        )!
        return {
          card,
          record: yield* setup.knowledge.get(setup.place, { id: card, budget: 600, personal: true }),
          outline: yield* setup.knowledge.get(setup.place, { id: document!.id, budget: 600, personal: true }),
          page: yield* setup.knowledge.get(setup.place, { id: document!.id, part: "p2", budget: 1_500, personal: true }),
          missing: yield* setup.knowledge.get(setup.place, { id: "rnothing", budget: 600, personal: true }),
          search: yield* setup.knowledge.search(setup.place, { query: "retry 429", personal: true }),
        }
      }),
    )
    expect(result.record?.type).toBe("text")
    expect(result.record?.text).toContain("Clients MUST retry at most 3 times after a 429 response.")
    expect(result.record?.text).toContain('trust="data"')
    expect(result.record?.text).toContain("<document_passage")
    expect(result.record?.text).toContain("p.2")
    expect(result.outline?.text).toContain("Limits p.2")
    expect(result.page?.text).toContain("429")
    expect(result.page?.text).not.toContain("14 days")
    expect(result.missing).toBeUndefined()
    expect(result.search[0]).toMatchObject({ title: "Auth spec", page: 2, section: "Limits" })
  })

  test("a session keeps the card bytes it was first shown while the document is read again", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          const first = yield* added(setup, { type: "path", path: "docs/auth.md", origin: "upload" })
          const card = (yield* setup.knowledge.recall(setup.place, ask("what is the refresh token TTL?"))).cards[0]!
          const before = yield* setup.knowledge.lines(setup.place, [card], { personal: true, sessionID: "ses_1" })
          yield* setup.knowledge.update(setup.place, first.document!.id, { title: "Session spec" })
          yield* setup.knowledge.reindex(setup.place, first.document!.id)
          yield* setup.knowledge.wait(setup.place, first.document!.id, "searchable", 10_000)
          return {
            before: before.get(card),
            same: (yield* setup.knowledge.lines(setup.place, [card], { personal: true, sessionID: "ses_1" })).get(card),
            other: (yield* setup.knowledge.lines(setup.place, [card], { personal: true, sessionID: "ses_2" })).get(card),
          }
        }),
      { files: { "docs/auth.md": SPEC_V1 } },
    )
    expect(result.before).toContain("Auth spec")
    expect(result.same).toBe(result.before!)
    expect(result.other).toContain("Session spec")
  })

  test("a record's card stands for its passage, which the agent opens with get", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Billing spec.md", "# Billing spec\n\n## 1 Money\n\nInvoices MUST be issued in integer cents.\n"))
        return yield* setup.knowledge.recall(setup.place, ask("use the billing spec for invoices"))
      }),
    )
    expect(result.text).toContain("requirement · Billing spec §1: Invoices MUST be issued in integer cents.")
    expect(result.cards.every((id) => id.startsWith("r"))).toBe(true)
  })

  test("an attached document's outline is wrapped as Vector's, with the headings under its title", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const { document } = yield* added(setup, text("Auth spec.md", SPEC_V1))
        return {
          id: document!.id,
          shown: yield* setup.knowledge.outline(setup.place, document!.id, { personal: true }),
          withheld: yield* setup.knowledge.outline(setup.place, document!.id, { personal: false }),
        }
      }),
    )
    expect(result.shown).toStartWith(`<vector_document id="${result.id}">\n`)
    expect(result.shown).toEndWith("\n</vector_document>")
    expect(result.shown).toContain("Outline: 1 Sessions · 2 Limits · 3 Endpoints · Glossary")
    expect(Token.estimate(result.shown!)).toBeLessThanOrEqual(130)
    expect(result.withheld).toBeUndefined()
  })

  test("a passage the agent opens counts once, however often a request renders it again", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        const card = (yield* setup.knowledge.search(setup.place, { query: "refresh tokens expire", personal: true }))[0]!
        const uses = () =>
          setup.db.get<{ uses: number; rows: number }>(
            sql`SELECT uses, (SELECT count(*) FROM brain_use WHERE entry_id = ${card.id} AND tier = 'get') AS rows FROM brain_item WHERE ref = ${card.id}`,
          )
        const before = yield* uses()
        yield* setup.knowledge.get(setup.place, { id: card.id, budget: 600, personal: true, sessionID: "ses_1", requestID: "msg_1" })
        const opened = yield* uses()
        yield* setup.knowledge.get(setup.place, { id: card.id, budget: 600, personal: true, sessionID: "ses_1" })
        yield* setup.knowledge.get(setup.place, { id: card.id, budget: 600, personal: true, sessionID: "ses_1" })
        return { before, opened, rendered: yield* uses() }
      }),
    )
    expect(result.opened!.uses).toBe(result.before!.uses + 1)
    expect(result.opened!.rows).toBe(1)
    expect(result.rendered).toEqual(result.opened)
  })

})
