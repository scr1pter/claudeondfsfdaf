import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@vectordevai/sdk/v2/client"
import type { Research } from "@vectordevai/schema/research"
import { ResearchSearch } from "@vectordevai/core/research/search"
import {
  capLabel,
  chipText,
  chipTitle,
  citedNote,
  confidenceOf,
  decodePlanAnswer,
  draftOf,
  encodePlanAnswer,
  formatPreference,
  highlights,
  modesFor,
  hasResearch,
  requireResearch,
  ownerOnly,
  planCard,
  planEdits,
  planPart,
  planProblem,
  planReply,
  reading,
  rememberMode,
  rememberedMode,
  reportMarkdown,
  reportPath,
  runChips,
  searchHelp,
  searchLine,
  segments,
  sendMode,
  sessionRuns,
  site,
  sizeOf,
  statusLabel,
  stickyMode,
  type ModeStorage,
} from "./research-model"

const user = (id: string, agent: string, extra: Partial<Extract<Message, { role: "user" }>> = {}) =>
  ({
    id,
    sessionID: "ses_1",
    role: "user",
    time: { created: 1 },
    agent,
    model: { providerID: "p", modelID: "m" },
    ...extra,
  }) as Message

const reply = (id: string) =>
  ({ id, sessionID: "ses_1", role: "assistant", time: { created: 2 }, agent: "research" }) as unknown as Message

const plan: Research.Plan = {
  question: "How much do heat pumps cut heating bills in cold climates?",
  subquestions: ["What did field studies measure?", "How large were the savings?"],
  scope: "web",
  depth: "focused",
  prefer_domains: ["nature.com"],
}

describe("the composer's mode", () => {
  test("stays Deep research while the latest real request went to the research agent", () => {
    expect(stickyMode([])).toBeUndefined()
    expect(stickyMode([user("m1", "research"), reply("m2")])).toBe("research")
    // A greeting the quick lane answered on its own says nothing about the mode.
    expect(stickyMode([user("m1", "research"), reply("m2"), user("m3", "quick")])).toBe("research")
    // The composer's own Quick pick sends the Chat size, and is a change of mode.
    expect(stickyMode([user("m1", "research"), user("m3", "quick", { size: "chat" })])).toBeUndefined()
    expect(stickyMode([user("m1", "research"), user("m3", "build")])).toBeUndefined()
    expect(stickyMode([user("m1", "build"), reply("m2")])).toBeUndefined()
  })

  test("offers no Fast for a model on a server someone hosts, and sends a Fast picked for another model as Normal", () => {
    expect(modesFor(false, true).map((mode) => mode.id)).toEqual(["normal", "quick", "fast", "research"])
    expect(modesFor(true, true).map((mode) => mode.id)).toEqual(["normal", "quick", "research"])
    expect(sendMode("fast", true)).toBe("normal")
    expect(sendMode("fast", false)).toBe("fast")
    expect(sendMode("research", true)).toBe("research")
    expect(sendMode("quick", true)).toBe("quick")
  })

  test("offers research only when this engine advertises it and never downgrades remembered intent", () => {
    expect(modesFor(false, false).map((mode) => mode.id)).toEqual(["normal", "quick", "fast"])
    expect(modesFor(true, false).map((mode) => mode.id)).toEqual(["normal", "quick"])
    expect(hasResearch(undefined)).toBe(false)
    expect(hasResearch([{ name: "build" }])).toBe(false)
    expect(hasResearch([{ name: "research" }])).toBe(true)
    expect(() => requireResearch(true, undefined)).toThrow("not available on this engine")
    expect(() => requireResearch(true, [{ name: "build" }])).toThrow("not available on this engine")
    expect(() => requireResearch(false, [])).not.toThrow()
    expect(() => requireResearch(true, [{ name: "research" }])).not.toThrow()
    expect(sendMode("research", false)).toBe("research")
  })

  test("maps the Depth chip to the request's size, Auto leaving it to Vector", () => {
    expect(sizeOf("focused")).toBe("standard")
    expect(sizeOf("deep")).toBe("thorough")
    expect(sizeOf("auto")).toBeUndefined()
  })

  test("shows research's default cap for the depth, the user's own when they set one, and steps for a local model", () => {
    expect(capLabel({ depth: "auto", local: false })).toBe("Cap $1.00")
    expect(capLabel({ depth: "focused", local: false })).toBe("Cap $1.00")
    expect(capLabel({ depth: "deep", local: false })).toBe("Cap $3.00")
    expect(capLabel({ depth: "deep", local: false, limits: { deep: { usd: 5 } } })).toBe("Cap $5.00")
    expect(capLabel({ depth: "deep", local: false, own: { usd: 0.5 } })).toBe("Cap $0.50")
    expect(capLabel({ depth: "focused", local: true })).toBe("Local · 80 steps")
    expect(capLabel({ depth: "deep", local: true })).toBe("Local · 240 steps")
    expect(capLabel({ depth: "deep", local: true, own: { usd: 2, steps: 120 } })).toBe("Local · 120 steps")
  })

  test("remembers Deep research per repository, and starts in Normal when the browser's storage fails", () => {
    const values = new Map<string, string>()
    const storage: ModeStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    }
    expect(rememberedMode(storage, "/repo/a")).toBeUndefined()
    rememberMode(storage, "/repo/a", "research")
    expect(rememberedMode(storage, "/repo/a")).toBe("research")
    expect(rememberedMode(storage, "/repo/b")).toBeUndefined()
    // Only Deep research carries over: Fast and Quick start new sessions in Normal, as before.
    rememberMode(storage, "/repo/a", "fast")
    expect(rememberedMode(storage, "/repo/a")).toBeUndefined()

    const broken: ModeStorage = {
      getItem: () => {
        throw new Error("SecurityError")
      },
      setItem: () => {
        throw new Error("QuotaExceededError")
      },
      removeItem: () => {
        throw new Error("SecurityError")
      },
    }
    expect(rememberedMode(broken, "/repo/a")).toBeUndefined()
    expect(() => rememberMode(broken, "/repo/a", "research")).not.toThrow()
    expect(rememberedMode(undefined, "/repo/a")).toBeUndefined()
  })
})

describe("the plan card", () => {
  test("reads the plan, its estimate and the card from the running research_plan part", () => {
    const card = {
      deep: true,
      deepEstimate: "About 40 pages and 24 searches.",
      search: { provider: "browser" },
      preferences: { prefer: ["nature.com"], avoid: [] },
      offline: false,
    }
    expect(planCard({ plan, estimate: "About 15 pages and 8 searches.", card })).toEqual({
      plan,
      estimate: "About 15 pages and 8 searches.",
      card,
    })
    // An older engine's part has no card, and a part without a plan is no plan card.
    expect(planCard({ plan })).toEqual({ plan })
    expect(planCard({ plan: { question: "No sub-questions" } })).toBeUndefined()
    expect(planCard(undefined)).toBeUndefined()
  })

  test("finds the research_plan part a question belongs to", () => {
    const parts = [
      { id: "p1", type: "tool", tool: "question", callID: "call_1", state: { status: "running" } },
      { id: "p2", type: "tool", tool: "research_plan", callID: "call_2", state: { status: "running" } },
    ] as unknown as Part[]
    expect(planPart(parts, { callID: "call_2" })?.id).toBe("p2")
    expect(planPart(parts, { callID: "call_1" })).toBeUndefined()
    expect(planPart(parts, undefined)).toBeUndefined()
  })

  test("answers with the button's label when nothing was edited", () => {
    const draft = draftOf(plan)
    expect(planReply({ action: "start", proposed: plan, draft, always: [] })).toBe("Start")
    expect(planReply({ action: "start-deep", proposed: plan, draft, always: ["format"] })).toBe("Start deep")
    expect(planReply({ action: "cancel", proposed: plan, draft: { ...draft, question: "Changed" }, always: [] })).toBe(
      "Cancel",
    )
  })

  test("sends only the fields the user edited, and what to remember only for those, and the engine reads it back", () => {
    const draft = {
      ...draftOf(plan),
      subquestions: ["What did field studies measure?", "  ", "Which homes did the studies follow?"],
      avoid_domains: ["Example.com "],
      format: "table" as const,
    }
    const text = planReply({ action: "start", proposed: plan, draft, always: ["avoid_domains", "prefer_domains"] })
    expect(text.startsWith("vector-plan:")).toBe(true)
    expect(decodePlanAnswer(text)).toEqual({
      action: "start",
      plan: {
        subquestions: ["What did field studies measure?", "Which homes did the studies follow?"],
        avoid_domains: ["example.com"],
        format: "table",
      },
      // Sites to prefer were not edited, so they are not remembered.
      always: ["avoid_domains"],
    })
    expect(planEdits(plan, draftOf(plan))).toEqual({})
  })

  test("round-trips the card's answer through the same schema research_plan decodes it with", () => {
    const answer: Research.PlanAnswer = {
      action: "start-deep",
      plan: { question: "Do heat pumps pay off in Oslo?", scope: "web+brain", time_window: "since 2020" },
      always: ["format"],
    }
    expect(decodePlanAnswer(encodePlanAnswer(answer))).toEqual(answer)
    // Any other text is a steer, and so is an answer research_plan would refuse.
    expect(decodePlanAnswer("Look at Nordic studies first")).toBeUndefined()
    expect(decodePlanAnswer(`vector-plan:${JSON.stringify({ action: "go" })}`)).toBeUndefined()
    expect(
      decodePlanAnswer(
        encodePlanAnswer({ action: "start", plan: { subquestions: Array.from({ length: 9 }, (_, i) => `Q${i}`) } }),
      ),
    ).toBeUndefined()
  })

  test("says research searches in its own browser, and what it uses without one", () => {
    const card = { deep: false, preferences: { prefer: [], avoid: [] }, offline: false }
    expect(searchLine({ ...card, search: { provider: "browser" } })).toBe(
      "Search: Google, in each research agent's own browser (DuckDuckGo when Google asks for a check). No search service or key.",
    )
    expect(
      searchLine({ ...card, search: { provider: "none", reason: "Searching the web needs Vector's browser." } }),
    ).toBe(
      "Nothing is searched on the web here. Research will use this repository's brain, its files and links you paste.",
    )
    // An older engine named the search service it used.
    expect(searchLine({ ...card, search: { provider: "service" } })).toBe("Search: the web")
    expect(searchLine(undefined)).toBeUndefined()
  })

  test("offers the engine's reason alone when nothing is searched, and Set up only without one", () => {
    const card = { deep: false, preferences: { prefer: [], avoid: [] }, offline: false }
    // `vector run --research --search none`: nothing to set up, so no "open this repository there to search".
    for (const reason of [ResearchSearch.NONE, ResearchSearch.NEEDS_DESKTOP])
      expect(searchHelp({ ...card, search: { provider: "none", reason } })).toEqual({ label: "Why", text: reason })
    expect(searchHelp({ ...card, search: { provider: "none" } })).toMatchObject({ label: "Set up" })
    expect(searchHelp({ ...card, search: { provider: "browser" } })).toBeUndefined()
    expect(searchHelp(undefined)).toBeUndefined()
  })

  test("says why a plan cannot start", () => {
    const draft = draftOf(plan)
    expect(planProblem(draft)).toBeUndefined()
    expect(planProblem({ ...draft, question: " " })).toBe("Write the question to research.")
    expect(planProblem({ ...draft, subquestions: [" "] })).toBe("Add at least one sub-question.")
    expect(planProblem({ ...draft, subquestions: Array.from({ length: 9 }, (_, i) => `Q${i}`) })).toBe(
      "Research takes 8 sub-questions at most.",
    )
  })

  test("keeps the site of an address the user adds", () => {
    expect(site("https://www.Nature.com/articles/x?y=1")).toBe("nature.com")
    expect(site(" arxiv.org ")).toBe("arxiv.org")
  })
})

describe("runs and sources", () => {
  test("finds the runs a session's research parts name, and the pages being read", () => {
    const parts = [
      { type: "tool", tool: "research_plan", state: { status: "completed", metadata: { runID: "run_a" } } },
      { type: "tool", tool: "research_read", state: { status: "completed", metadata: { runID: "run_a" } } },
      { type: "tool", tool: "research_read", state: { status: "running", input: { url: "https://a.web.test/x" } } },
      {
        type: "tool",
        tool: "research_browser",
        state: { status: "running", input: {}, metadata: { runID: "run_b", url: "https://b.web.test/" } },
      },
      { type: "tool", tool: "webfetch", state: { status: "completed", metadata: { runID: "run_c" } } },
      { type: "text", text: "run_d" },
    ] as unknown as Part[]
    expect(sessionRuns(parts)).toEqual(["run_a", "run_b"])
    expect(reading(parts)).toEqual(["https://a.web.test/x", "https://b.web.test/"])
  })

  test("words each source's status", () => {
    expect(statusLabel({ status: "read" })).toBe("read")
    expect(statusLabel({ status: "robots" })).toBe("blocked by robots.txt")
    expect(statusLabel({ status: "paywalled" })).toBe("paywalled (excerpt only)")
    expect(statusLabel({ status: "needs-render" })).toBe("needs the desktop browser")
    expect(statusLabel({ status: "failed", reason: "blocked by the site" })).toBe("failed: blocked by the site")
    expect(
      statusLabel({
        status: "duplicate",
        signals: {
          kind: "other",
          primary: false,
          data: false,
          references: false,
          paywalled: false,
          addressed_to_ai: false,
          corroborated: 0,
          duplicate_of: "S2",
        },
      }),
    ).toBe("duplicate of S2")
  })

  test("shows one chip per research browser of this session's runs", () => {
    const chips = [
      {
        id: "run_a:ses_2",
        runID: "run_a",
        sessionID: "ses_2",
        label: "Researcher 2",
        host: "nature.com",
        state: "reading",
      },
      { id: "run_a:ses_1", runID: "run_a", sessionID: "ses_1", label: "Research lead", host: "", state: "opening" },
      { id: "run_z:ses_9", runID: "run_z", sessionID: "ses_9", label: "Researcher 1", host: "x.org", state: "idle" },
    ]
    expect(runChips(chips, ["run_a"]).map(chipText)).toEqual([
      "Researcher 2 · nature.com · reading",
      "Research lead · opening",
    ])
  })

  test("highlights each quote in the saved text, across line breaks and curly quote marks", () => {
    const text = "Field trials found that heat pumps\ncut bills by 31% in “cold” homes. Other studies differ."
    const spans = highlights(text, ['heat pumps cut bills by 31% in "cold" homes', "not in the text"])
    expect(spans).toHaveLength(1)
    expect(segments(text, spans)).toEqual([
      { text: "Field trials found that ", mark: false },
      { text: "heat pumps\ncut bills by 31% in “cold” homes", mark: true },
      { text: ". Other studies differ.", mark: false },
    ])
    expect(segments("plain", [])).toEqual([{ text: "plain", mark: false }])
  })

  test("a guest is refused the owner's research routes", () => {
    expect(ownerOnly(403)).toBe(true)
    expect(ownerOnly(401)).toBe(true)
    expect(ownerOnly(200)).toBe(false)
    expect(ownerOnly(undefined)).toBe(false)
  })
})

describe("the report card", () => {
  const markdown = [
    "# Heat pumps",
    "Heat pumps cut bills by about a third \\[S3 p.12\\][^N1] \\[S4\\][^N2].",
    "## Savings",
    "Confidence: High (Vector's estimate)",
    "Savings held in cold homes \\[S3 p.12\\][^N1].",
    "## Sources",
    "| | Source | Site | Status | Signals |",
    '[^N1]: "cut bills by 31%" Field trials, nature.com (S3 p.12)',
    '[^N2]: "a third" Survey, example.org (S4)',
  ].join("\n\n")

  test("renders each citation as a source chip that names its note, and drops the footnote lines", () => {
    const rendered = reportMarkdown(markdown)
    expect(rendered).toContain("[S3 p.12](#vector-cite-N1) [S4](#vector-cite-N2).")
    expect(rendered).toContain("Savings held in cold homes [S3 p.12](#vector-cite-N1).")
    expect(rendered).not.toContain("[^N1]")
    expect(rendered).not.toContain("cut bills by 31%")
    // A note the model wrote as text, escaped by the report, is no chip.
    expect(reportMarkdown("A \\[^N9\\]: fake line")).toBe("A \\[^N9\\]: fake line")
    expect(citedNote("#vector-cite-N12")).toBe("N12")
    expect(citedNote("#vector-cite-S3")).toBeUndefined()
    expect(citedNote("https://nature.com/#vector-cite-N1")).toBeUndefined()
    expect(citedNote(null)).toBeUndefined()
  })

  test("shows the cited quote on hover, and each section's confidence as Vector's estimate", () => {
    const note: Research.Note = {
      id: "N1",
      subquestion: "1",
      claim: "Heat pumps cut bills",
      source: "S3",
      quote: "cut bills by 31%",
      page: 12,
      stance: "supports",
      support: true,
      created_at: 1,
    }
    const source = {
      id: "S3",
      url: "https://nature.com/a",
      canonical_url: "https://nature.com/a",
      title: "Field trials",
      site: "nature.com",
      status: "read",
    } satisfies Research.Source
    expect(chipTitle(note, source)).toBe('"cut bills by 31%" (S3: Field trials, p.12)')
    expect(chipTitle(note, undefined)).toBe('"cut bills by 31%" (S3: p.12)')
    expect(chipTitle(undefined, undefined)).toBe("This note is no longer in the run.")
    expect(confidenceOf("Confidence: High (Vector's estimate)")).toMatchObject({ level: "high", disagree: false })
    expect(confidenceOf("Confidence: Low (Vector's estimate) · Sources disagree")).toMatchObject({
      level: "low",
      disagree: true,
    })
    expect(confidenceOf("Confidence: High")).toBeUndefined()
    expect(confidenceOf("Confidence: High (Vector's estimate)")?.title).toStartWith("Vector's estimate.")
  })

  test("saves a report under .vector/research by date and question, and keeps the format the user liked", () => {
    expect(reportPath("How much do heat pumps cut bills?", Date.UTC(2026, 9, 22))).toBe(
      ".vector/research/2026-10-22-how-much-do-heat-pumps-cut-bills.md",
    )
    expect(reportPath("???", Date.UTC(2026, 9, 22))).toBe(".vector/research/2026-10-22-research.md")
    expect(formatPreference("table")).toBe("Write Deep research results as a table.")
    expect(formatPreference(undefined)).toBe("Write Deep research results as a report.")
  })
})

test("Codium research labels preserve operational step limits without dollar caps", () => {
  expect(capLabel({ depth: "focused", local: false, codium: true })).toBe("Codium · 80 steps")
  expect(capLabel({ depth: "deep", local: false, codium: true, own: { usd: 5, steps: 120 } })).toBe(
    "Codium · 120 steps",
  )
})
