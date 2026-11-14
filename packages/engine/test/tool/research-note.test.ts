import { afterAll, expect } from "bun:test"
import { Effect } from "effect"
import { ResearchStore } from "@vectordevai/core/research/store"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { Session } from "@/session/session"
import { Instruction } from "../../src/session/instruction"
import { calls, output, plan, runtime, send, setup } from "../lib/research"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// research_note's two checks (section 5.4, RC4): a quote must be in its source's saved text, or the note is refused
// and the agent is pointed at the chunk to copy from; a quote that is in the source but does not state the claim is
// saved as a paraphrase. research_report then cites saved notes only.

const guard = NetworkGuard.use()
const web = FakeWeb.start({ sites: FakeWeb.sites() })
const it = runtime(web)
afterAll(() => web.close())

const allow = [{ permission: "research_read", pattern: "*", action: "allow" as const }]

it.instance(
  "a quote not in the source is refused, a paraphrase is marked, and the report cites saved notes only",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      const article = web.url("article", "/")
      const question = "How much do heat pumps cut heating bills in cold climates?"
      yield* test.llm.tool("research_plan", plan({ question }))
      yield* test.llm.tool("research_read", { url: article })
      // Words the page does not have.
      yield* test.llm.tool("research_note", {
        subquestion: "What did field studies measure?",
        claim: "The study followed 500 homes.",
        source: "S1",
        quote: "The study followed 500 homes through three winters.",
      })
      // The page's words, for a claim with a value they do not state.
      yield* test.llm.tool("research_note", {
        subquestion: "How large were the savings?",
        claim: "Heating bills fell by 61 percent in every home.",
        source: "S1",
        quote: "The study followed 412 homes through two winters.",
      })
      // The page's words, for the claim they state.
      yield* test.llm.tool("research_note", {
        subquestion: "What did field studies measure?",
        claim: "The study followed 412 homes through two winters.",
        source: "S1",
        quote: "The study followed 412 homes through two winters.",
      })
      yield* test.llm.tool("research_report", {
        title: "Heat pumps in cold climates",
        answer:
          "A field study followed 412 homes through two winters [N2]. Another claim cites a note that was never saved [N9].",
        sections: [{ heading: "What was measured", body: "The study followed 412 homes [N2]." }],
        open_questions: [],
      })
      yield* test.llm.tool("research_report", {
        title: "Heat pumps in cold climates",
        answer: "A field study followed 412 homes through two winters [N2].",
        sections: [{ heading: "What was measured", body: "The study followed 412 homes [N2]. Savings varied [N1]." }],
        open_questions: ["How do savings change below minus 20 degrees?"],
      })
      yield* test.llm.text("Done.")
      yield* send({
        sessionID: session.id,
        agent: "research",
        text: `Research heat pump savings, starting with ${article}`,
      })

      const notes = yield* calls(session.id, "research_note")
      expect(output(notes[0])).toContain("That quote is not in S1")
      expect(output(notes[1])).toContain("Saved N1")
      expect(output(notes[1])).toContain("as a paraphrase")
      expect(output(notes[2])).toContain("Saved N2")
      expect(output(notes[2])).not.toContain("paraphrase")

      const reports = yield* calls(session.id, "research_report")
      expect(output(reports[0])).toContain("[N9] is not a saved note")
      expect(output(reports[1])).toContain("Saved the report (version 1)")
      expect(output(reports[1])).toContain("stay private and out of later sessions until you keep them")

      const runID = notes[1]!.state.status === "completed" ? (notes[1]!.state.metadata.runID as string) : ""
      const store = yield* ResearchStore.Service
      const instruction = yield* Instruction.Service
      const detail = yield* store.get(yield* instruction.place(), runID)
      expect(detail?.notes.map((note) => [note.id, note.support])).toEqual([
        ["N1", false],
        ["N2", true],
      ])
      expect(detail?.run.status).toBe("done")
      expect(detail?.report).toContain("Heat pumps in cold climates")
      expect(guard.outside()).toEqual([])
    }),
  90_000,
)

// Label plan §3.2: a report whose run spent no dollars has no Spend line, also when every counted step ran on Vector
// Codium. Codium's destination is fixed, so this server cannot stand in for it: the run begins here with a Codium step
// the guard counted, and the lead's own steps on the free local test model add no dollars.
it.instance(
  "a run that spent no dollars beside its Codium steps saves a report with no Spend line",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const spend = yield* SpendGuard.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      const article = web.url("article", "/")
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_read", { url: article })
      yield* test.llm.tool("research_note", {
        subquestion: "What did field studies measure?",
        claim: "The study followed 412 homes through two winters.",
        source: "S1",
        quote: "The study followed 412 homes through two winters.",
      })
      yield* test.llm.tool("research_report", {
        title: "Heat pumps in cold climates",
        answer: "A field study followed 412 homes through two winters [N1].",
        sections: [{ heading: "What was measured", body: "The study followed 412 homes [N1]." }],
        open_questions: [],
      })
      yield* test.llm.text("Done.")
      yield* spend.begin(session.id)
      yield* spend.record(session.id, {
        costKind: "codium",
        contextTokens: 1_000,
        cachedTokens: 0,
        continues: true,
        tools: [],
        patched: false,
      })
      yield* send({ sessionID: session.id, agent: "research", text: `Research heat pump savings: ${article}` })

      const run = yield* spend.snapshot(session.id)
      expect(run?.spentUsd).toBe(0)
      expect(run?.codiumSteps).toBe(1)
      const notes = yield* calls(session.id, "research_note")
      const runID = notes[0]?.state.status === "completed" ? (notes[0].state.metadata.runID as string) : ""
      const store = yield* ResearchStore.Service
      const instruction = yield* Instruction.Service
      const report = (yield* store.get(yield* instruction.place(), runID))?.report ?? ""
      const method = report.slice(report.indexOf("## Method"))
      expect(method).toStartWith("## Method")
      expect(method).not.toContain("- Spend:")
      expect(report).not.toContain("Codium")
      expect(guard.outside()).toEqual([])
    }),
  90_000,
)
