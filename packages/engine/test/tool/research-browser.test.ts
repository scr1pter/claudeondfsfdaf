import { afterAll, expect } from "bun:test"
import { rm } from "node:fs/promises"
import path from "node:path"
import { Effect, Fiber } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { Global } from "@vectordevai/core/global"
import type { PermissionV1 } from "@vectordevai/core/v1/permission"
import { ResearchProvenance } from "@vectordevai/core/research/provenance"
import { ResearchReader } from "@vectordevai/core/research/reader"
import { ResearchStore } from "@vectordevai/core/research/store"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { Permission } from "../../src/permission"
import { ResearchBrowser } from "../../src/tool/research-browser"
import { RENDER } from "../../src/tool/research-read"
import { ResearchRun } from "../../src/tool/research-run"
import { ResearchSource } from "../../src/tool/research-source"
import { FakeBridge } from "../lib/fake-bridge"
import { reply } from "../lib/llm-server"
import { calls, output, plan, runtime, send, setup } from "../lib/research"
import { lines, pdf } from "../../../core/test/brain/fixture/pdf"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// research_browser (section 5.6a), end to end on the fake LLM server, the fake web and a fake desktop bridge on
// loopback: each research agent's browser opens only addresses from the run's provenance, sends the desktop only the
// provenance it lacks, saves what it reads as sources, joins the links it followed to the run's provenance, checks what
// it types against the run's private context, and closes when its agent's session finishes. The desktop's own side
// (slots, the proxy, the navigation rule) is tested in packages/desktop.

const guard = NetworkGuard.use()
const ARTICLE_HTML = await Bun.file(path.join(FakeWeb.FIXTURES, "article.html")).text()
const PLANNER_HTML = `<html><head><title>Sizing notes</title></head><body><main><h1>Sizing notes</h1><p>Our internal tool, the Zephyr planner, sizes every heat pump from the floor area and the coldest design day.</p><p>It is only for the installers on our team. Call the planner desk on 480 200 017.</p></main></body></html>`
const web = FakeWeb.start({
  sites: {
    ...FakeWeb.sites(),
    // A page on the user's own network, read from the address the user typed: its text is private.
    planner: {
      "/": {
        headers: { "content-type": "text/html; charset=utf-8" },
        body: PLANNER_HTML,
      },
    },
    // A public page that lists numbers, the planner desk's among them, as a hostile page listing many would.
    numbers: {
      "/": {
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<html><head><title>Part numbers</title></head><body><main><h1>Heat pump part numbers</h1><p>Compressor parts: ${Array.from({ length: 40 }, (_, index) => 480_200_000 + index).join(", ")}.</p><p>Each part ships with a manual and a warranty card for the installer.</p></main></body></html>`,
      },
    },
  },
})
const bridge = FakeBridge.start()
const pointed = FakeBridge.use(bridge)
const it = runtime(web)
afterAll(async () => {
  pointed.off()
  await bridge.close()
  await web.close()
})

// The user approved reading pages for these runs, and pages on their own network (the fake web resolves to this
// computer).
const allow = [
  { permission: "research_read", pattern: "*", action: "allow" as const },
  { permission: "private_network", pattern: "*", action: "allow" as const },
]
const ARTICLE = web.url("article", "/")
const COPY = web.url("copy", "/heat-pumps")

// A desktop that keeps one copy of the run's provenance and answers each command as the research browser would; `html`
// is the page a read shows at an address (the article by default).
const desktop = (pages: Record<string, unknown> = {}, html: (url: string) => string = () => ARTICLE_HTML) => {
  const state = { generation: "desktop-copy-1", url: "" }
  return (call: FakeBridge.Call) => {
    if (call.path !== "/research") return FakeBridge.visible()
    const body = call.body
    if (body.generation !== undefined && body.generation !== state.generation)
      return FakeBridge.research({ ok: false, resync: true })
    if (body.command === "research.open") state.url = String(body.url)
    if (body.command === "research.search") return FakeBridge.searched(web)
    const shown = {
      generation: state.generation,
      url: state.url,
      address: state.url,
      title: "How heat pumps cut heating bills",
    }
    if (body.command === "research.read" || body.command === "research.find" || body.command === "research.links")
      return FakeBridge.research({
        ...shown,
        read: {
          html: html(state.url),
          title: shown.title,
          url: state.url,
          links: [{ url: COPY, text: "A copy", main: true }],
          forms: [],
          truncated: false,
        },
      })
    if (body.command === "research.observe")
      return FakeBridge.research({
        ...shown,
        observed: {
          title: shown.title,
          url: state.url,
          text: "Search the study",
          elements: [{ ref: "ref_1", role: "searchbox", name: "Search", tag: "input", type: "search" }],
        },
      })
    return FakeBridge.research({ ...shown, ...(pages[String(body.command)] as object | undefined) })
  }
}

const researchCalls = () => bridge.calls().filter((call) => call.path === "/research")
const researcher = (hit: { body: Record<string, unknown> }) => JSON.stringify(hit.body).includes("research_assignment")
// Answers every permission once, as the user would.
const approve = Effect.gen(function* () {
  const permission = yield* Permission.Service
  const asked: PermissionV1.Request[] = []
  yield* Effect.gen(function* () {
    while (true) {
      for (const request of yield* permission.list()) {
        asked.push(request)
        yield* permission.reply({ requestID: request.id, reply: "once" }).pipe(Effect.ignore)
      }
      yield* Effect.sleep(10)
    }
  }).pipe(Effect.forkScoped)
  return asked
})
// The commands sent from `from` on, once the closing that follows the session's end has been sent.
const settled = (from: number) =>
  Effect.gen(function* () {
    for (const _ of Array.from({ length: 50 })) {
      if (
        researchCalls()
          .slice(from)
          .some((call) => call.body.command === "research.close")
      )
        break
      yield* Effect.sleep(20)
    }
    return researchCalls().slice(from)
  })

it.instance(
  "opens only an address in the run's provenance, sends the desktop only what it lacks, and saves what it reads",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      bridge.answer(desktop())
      const before = researchCalls().length
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_search", { query: "heat pump savings in cold climates" })
      yield* test.llm.tool("research_browser", { action: "open", url: "https://elsewhere.example/notes" })
      yield* test.llm.tool("research_browser", { action: "open", url: ARTICLE })
      yield* test.llm.tool("research_browser", { action: "read" })
      yield* test.llm.tool("research_note", {
        subquestion: "How large were the savings?",
        claim: "Heat pumps cut delivered heating energy by 61 percent.",
        source: "S1",
        quote: "used 61 percent less delivered energy for heating",
      })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: "Research how much heat pumps save." })

      const browsed = yield* calls(session.id, "research_browser")
      expect(output(browsed[0])).toContain(ResearchProvenance.REFUSAL)
      expect(output(browsed[1])).toContain("The page is open.")
      expect(output(browsed[2])).toContain("S1 · ")
      expect(output(browsed[2])).toContain("The study followed 412 homes through two winters.")
      expect(output(browsed[2])).toContain("untrusted_web_page")
      const [note] = yield* calls(session.id, "research_note")
      expect(note?.state.status === "completed" ? note.state.metadata.note : undefined).toBeTruthy()

      // The desktop was asked to search in the lead's browser, to open the article only, and to close the browser once
      // the lead's turn ended.
      const sent = yield* settled(before)
      expect(sent.map((call) => call.body.command)).toEqual([
        "research.search",
        "research.open",
        "research.read",
        "research.close",
      ])
      const [search, open, read] = sent
      const runID = browsed[1]!.state.status === "completed" ? browsed[1]!.state.metadata.runID : undefined
      const own = {
        runID,
        sessionID: session.id,
        rootID: session.id,
        agent: "research",
        max: 1 + ResearchRun.LIMITS.focused.researchers,
        images: false,
      }
      // The search starts the desktop's copy of the run's provenance, which then holds nothing yet.
      expect(search!.body).toMatchObject({ ...own, query: "heat pump savings in cold climates", provenance: [] })
      expect(search!.body.generation).toBeUndefined()
      expect(open!.body).toMatchObject({ ...own, url: ARTICLE, generation: "desktop-copy-1" })
      // The search's results, which the desktop's copy lacks.
      expect(open!.body.provenance).toEqual(expect.arrayContaining([ARTICLE, COPY, web.url("docs", "/report.pdf")]))
      // The next command names that copy and sends nothing it already has.
      expect(read!.body).toMatchObject({ generation: "desktop-copy-1", provenance: [], typed: [] })
      expect(guard.outside()).toEqual([])
    }),
  90_000,
)

it.instance(
  "sends the whole provenance again when the desktop holds another copy of it",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      const handler = desktop()
      const state = { forgot: false }
      bridge.answer((call) => {
        // The desktop's browsers all closed after the first command, so its copy is gone.
        if (call.body.command === "research.observe" && call.body.generation !== undefined && !state.forgot) {
          state.forgot = true
          return FakeBridge.research({ ok: false, resync: true })
        }
        return handler(call)
      })
      const before = researchCalls().length
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_browser", { action: "open", url: ARTICLE })
      yield* test.llm.tool("research_browser", { action: "observe" })
      yield* test.llm.text("Done.")
      yield* send({
        sessionID: session.id,
        agent: "research",
        text: `Research heat pump savings, starting at ${ARTICLE}`,
      })
      const sent = researchCalls().slice(before, before + 3)
      expect(sent.map((call) => [call.body.command, call.body.generation])).toEqual([
        ["research.open", undefined],
        ["research.observe", "desktop-copy-1"],
        ["research.observe", undefined],
      ])
      // An address the user typed goes as typed, so robots.txt does not apply to it.
      expect(sent[2]!.body.typed).toEqual([ARTICLE])
      const [, observed] = yield* calls(session.id, "research_browser")
      expect(output(observed)).toContain('ref_1 searchbox (search) "Search"')
    }),
  90_000,
)

it.instance(
  "a link the browser followed joins the run's provenance, so research may read it",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      bridge.answer(desktop({ "research.click": { url: COPY, address: COPY, joined: [COPY] } }))
      yield* test.llm.tool("research_plan", plan())
      // Not yet: nothing gave this address.
      yield* test.llm.tool("research_read", { url: COPY })
      yield* test.llm.tool("research_browser", { action: "open", url: ARTICLE })
      yield* test.llm.tool("research_browser", { action: "click", ref: "ref_1" })
      yield* test.llm.tool("research_read", { url: COPY })
      yield* test.llm.text("Done.")
      yield* send({
        sessionID: session.id,
        agent: "research",
        text: `Research heat pump savings, starting at ${ARTICLE}`,
      })
      const reads = yield* calls(session.id, "research_read")
      expect(output(reads[0])).toContain(ResearchProvenance.REFUSAL)
      const [, click] = yield* calls(session.id, "research_browser")
      expect(click?.state.status === "completed" ? click.state.metadata.links : undefined).toEqual([COPY])
      expect(output(click)).toContain("Followed a link")
      expect(output(reads[1])).not.toContain(ResearchProvenance.REFUSAL)
      expect(output(reads[1])).toContain("S1 · ")
    }),
  90_000,
)

it.instance(
  "typed text passes the outbound check with the run's private context, and a page listing a number does not clear it",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      bridge.answer(desktop())
      const before = researchCalls().length
      const notes = web.direct("planner", "/")
      const numbers = web.url("numbers", "/")
      yield* test.llm.tool("research_plan", plan())
      // The page on the user's own network makes the desk number private; the public page then lists it.
      yield* test.llm.tool("research_read", { url: notes })
      yield* test.llm.tool("research_read", { url: numbers })
      yield* test.llm.tool("research_browser", { action: "open", url: ARTICLE })
      yield* test.llm.tool("research_browser", { action: "type", ref: "ref_1", text: "desk 480 200 017 heat pump" })
      // A sentence of the user's memory, which the user did not type.
      yield* test.llm.tool("research_browser", {
        action: "type",
        ref: "ref_1",
        text: "I work at Hooli on the payments team in Lisbon",
      })
      // A name on its own is not copying.
      yield* test.llm.tool("research_browser", { action: "type", ref: "ref_1", text: "Hooli heat pumps" })
      yield* test.llm.text("Done.")
      yield* send({
        sessionID: session.id,
        agent: "research",
        text: `Research the heat pumps Hooli installs. Start with ${ARTICLE}, ${notes} and ${numbers}.`,
      })
      const browsed = yield* calls(session.id, "research_browser")
      const [, read] = yield* calls(session.id, "research_read")
      expect(output(read)).toContain("480200017")
      expect(output(browsed[1])).toBe(ResearchBrowser.TYPED)
      expect(output(browsed[2])).toBe(ResearchBrowser.TYPED)
      expect(output(browsed[3])).toContain("Typed into ref_1.")
      const typed = researchCalls()
        .slice(before)
        .filter((call) => call.body.command === "research.type")
      expect(typed.map((call) => call.body.text)).toEqual(["Hooli heat pumps"])
    }),
  90_000,
)

it.instance(
  "a researcher's typing is checked against the lead's private context too: the whole run's",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const lead = yield* sessions.create({ title: "Research", permission: allow })
      bridge.answer(desktop())
      yield* approve
      // The lead reads a page on the user's own network: what it says is private context of the run.
      const notes = web.direct("planner", "/")
      yield* test.llm.tool("research_plan", plan({ depth: "deep" }))
      yield* test.llm.tool("research_read", { url: notes })
      // The sub-question names nothing private, so it passes its check.
      yield* test.llm.tool("task", {
        description: "Sizing",
        prompt: "How are heat pumps sized for a home?",
        subagent_type: "researcher",
        background: false,
      })
      yield* test.llm.toolMatch(researcher, "research_browser", { action: "open", url: ARTICLE })
      // The researcher never read the notes; the lead did, and they are the run's.
      yield* test.llm.toolMatch(researcher, "research_browser", {
        action: "type",
        ref: "ref_1",
        text: "the Zephyr planner sizes every heat pump from the floor area",
      })
      yield* test.llm.toolMatch(researcher, "research_browser", {
        action: "type",
        ref: "ref_1",
        text: "heat pump sizing",
      })
      yield* test.llm.textMatch(researcher, "Found it.")
      yield* test.llm.text("Done.")
      yield* send({
        sessionID: lead.id,
        agent: "research",
        text: `Research how heat pumps are sized, from ${notes} and ${ARTICLE}.`,
      })
      const [read] = yield* calls(lead.id, "research_read")
      expect(read?.state.status === "completed" ? read.state.metadata.private : undefined).toBe(true)
      const [child] = yield* sessions.children(lead.id)
      expect(yield* calls(child!.id, "research_read")).toEqual([])
      const typed = yield* calls(child!.id, "research_browser")
      expect(output(typed[1])).toBe(ResearchBrowser.TYPED)
      expect(output(typed[2])).toContain("Typed into ref_1.")
      const sent = researchCalls().filter(
        (call) => call.body.sessionID === child!.id && call.body.command === "research.type",
      )
      expect(sent.map((call) => call.body.text)).toEqual(["heat pump sizing"])
    }),
  90_000,
)

it.instance(
  "a researcher is shown no private source of the run, by its address in its own browser or by its S#",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const lead = yield* sessions.create({ title: "Research", permission: allow })
      const notes = web.direct("planner", "/")
      bridge.answer(desktop({}, (url) => (url === notes ? PLANNER_HTML : ARTICLE_HTML)))
      yield* approve
      // The lead reads a page on the user's own network: S1, private.
      yield* test.llm.tool("research_plan", plan({ depth: "deep" }))
      yield* test.llm.tool("research_read", { url: notes })
      yield* test.llm.tool("task", {
        description: "Sizing",
        prompt: "How are heat pumps sized for a home?",
        subagent_type: "researcher",
        background: false,
      })
      // The researcher's browser reaches the same address, and the store already holds it.
      yield* test.llm.toolMatch(researcher, "research_browser", { action: "open", url: notes })
      yield* test.llm.toolMatch(researcher, "research_browser", { action: "read" })
      yield* test.llm.toolMatch(researcher, "research_read", { source: "S1" })
      yield* test.llm.toolMatch(researcher, "research_read", { url: notes })
      yield* test.llm.textMatch(researcher, "Found it.")
      yield* test.llm.text("Done.")
      const fetched = web.count("planner", "/")
      yield* send({
        sessionID: lead.id,
        agent: "research",
        text: `Research how heat pumps are sized, from ${notes} and ${ARTICLE}.`,
      })
      const [read] = yield* calls(lead.id, "research_read")
      expect(read?.state.status === "completed" ? read.state.metadata : {}).toMatchObject({
        source: "S1",
        private: true,
      })
      const [child] = yield* sessions.children(lead.id)
      const browsed = yield* calls(child!.id, "research_browser")
      expect(output(browsed[1])).toBe(ResearchSource.HIDDEN)
      expect(output(browsed[1])).not.toContain("Zephyr")
      const [bySource, byAddress] = yield* calls(child!.id, "research_read")
      expect(output(bySource)).toBe(ResearchSource.HIDDEN)
      // Nor by its address: the page stays the lead's, and it is not fetched again for the researcher.
      expect(output(byAddress)).toBe(ResearchSource.HIDDEN)
      expect(web.count("planner", "/") - fetched).toBe(1)
      // The lead may read its own source again.
      expect(output(read)).toContain("Zephyr planner")
    }),
  90_000,
)

it.instance(
  "a researcher reads no private address the user typed, its typing is checked against the run's private context, and its sub-question exempts nothing",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const brain = yield* Brain.Service
      const memory = brain.files().memory
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(memory, { force: true })))
      const lead = yield* sessions.create({ title: "Research", permission: allow })
      bridge.answer(desktop())
      yield* approve
      // On this computer, so on the user's own network. The user typed it, but only the lead reads it: a researcher
      // carries no private context.
      const notes = web.direct("planner", "/")
      yield* test.llm.tool("research_plan", plan({ depth: "deep" }))
      // Nothing private holds these words yet, so the lead's sub-question passes its check.
      yield* test.llm.tool("task", {
        description: "Sizing",
        prompt: "Is it true that the Zephyr planner sizes every heat pump from the floor area?",
        subagent_type: "researcher",
        background: false,
      })
      // The researcher's first step waits until the user has written to their MEMORY.md (below).
      const written = Promise.withResolvers<void>()
      yield* test.llm.pushMatch(researcher, reply().wait(written.promise).tool("research_read", { url: notes }))
      yield* test.llm.toolMatch(researcher, "research_browser", { action: "open", url: ARTICLE })
      // The words are in the researcher's own sub-question, which the lead wrote and the user did not type.
      yield* test.llm.toolMatch(researcher, "research_browser", {
        action: "type",
        ref: "ref_1",
        text: "the Zephyr planner sizes every heat pump from the floor area",
      })
      // A name on its own goes out.
      yield* test.llm.toolMatch(researcher, "research_browser", {
        action: "type",
        ref: "ref_1",
        text: "Hooli heat pump sizing",
      })
      yield* test.llm.textMatch(researcher, "Found it.")
      yield* test.llm.text("Done.")
      const fetched = web.count("planner", "/")
      const running = yield* send({
        sessionID: lead.id,
        agent: "research",
        text: `Research how heat pumps are sized for Hooli, from ${notes} and ${ARTICLE}.`,
      }).pipe(Effect.forkScoped)
      // Once the researcher works, the lead's check of its sub-question is done. The user then writes the planner's
      // sentence into their MEMORY.md, which makes its words private context of the run from here on.
      while (!(yield* test.llm.hits).some(researcher)) yield* Effect.sleep(10)
      yield* Effect.promise(() =>
        Bun.write(memory, "The Zephyr planner sizes every heat pump from the floor area and the coldest design day.\n"),
      )
      written.resolve()
      yield* Fiber.join(running)
      const [child] = yield* sessions.children(lead.id)
      const [read] = yield* calls(child!.id, "research_read")
      expect(output(read)).toBe(ResearchSource.LEAD_ONLY)
      expect(read?.state.status === "completed" ? read.state.metadata.private : undefined).toBeUndefined()
      // Refused before anything was sent to it.
      expect(web.count("planner", "/")).toBe(fetched)
      const typed = yield* calls(child!.id, "research_browser")
      expect(output(typed[1])).toBe(ResearchBrowser.TYPED)
      expect(output(typed[2])).toContain("Typed into ref_1.")
      // The researcher's browser is its own, attributed to the lead's run, and counted in the run's browsers (a plan
      // no one could answer stays Focused here).
      const opened = researchCalls().find(
        (call) => call.body.sessionID === child!.id && call.body.command === "research.open",
      )
      expect(opened?.body).toMatchObject({
        agent: "researcher",
        rootID: lead.id,
        max: 1 + ResearchRun.LIMITS.focused.researchers,
      })
    }),
  90_000,
)

it.instance(
  "a PDF that a click reaches is read into memory and saved as a source, as an opened one is",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      const report = web.url("docs", "/report.pdf")
      const bytes = pdf({
        title: "Heat pump field study",
        pages: [{ runs: lines(["Heat pump field study.", "Delivered heating energy fell by 61 percent."]) }],
      })
      bridge.answer(
        desktop({
          "research.click": {
            url: report,
            address: report,
            joined: [report],
            pdf: { url: report, base64: Buffer.from(bytes).toString("base64"), contentType: "application/pdf" },
          },
        }),
      )
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_browser", { action: "open", url: ARTICLE })
      yield* test.llm.tool("research_browser", { action: "click", ref: "ref_1" })
      yield* test.llm.text("Done.")
      yield* send({
        sessionID: session.id,
        agent: "research",
        text: `Research heat pump savings, starting at ${ARTICLE}`,
      })
      const [, click] = yield* calls(session.id, "research_browser")
      expect(output(click)).toContain("S1 · ")
      expect(output(click)).toContain("Delivered heating energy fell by 61 percent.")
      expect(click?.state.status === "completed" ? click.state.metadata : {}).toMatchObject({
        source: "S1",
        action: "click",
      })
    }),
  90_000,
)

it.instance(
  "with Vector Local's Web access set to Your network, a research browser opens no site on the internet, whatever the desktop's proxy holds",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      bridge.answer(desktop())
      const before = researchCalls().length
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_browser", { action: "open", url: ARTICLE })
      yield* test.llm.text("Done.")
      // Vector Local on, in the user's own config, as Settings writes it.
      const file = path.join(Global.Path.config, "vector.json")
      const config = yield* Effect.promise(() => Bun.file(file).json())
      const local = (block?: object) =>
        Effect.promise(async () => {
          await Bun.write(file, JSON.stringify(block ? { ...config, local: block } : config))
          Config.refreshLocal()
          Config.confirmLocal()
        })
      // The fake model server is on the list of model servers, as a company's own would be. Web access None would not
      // offer research_browser at all (research-offline.test.ts); Your network still offers it, and refuses this site.
      yield* local({ enabled: true, web: "network", endpoints: [new URL(test.llm.url).origin] })
      yield* send({
        sessionID: session.id,
        agent: "research",
        text: `Research heat pump savings, starting at ${ARTICLE}`,
      }).pipe(Effect.ensuring(local().pipe(Effect.orDie)))
      const [opened] = yield* calls(session.id, "research_browser")
      expect(opened?.state.status).toBe("error")
      expect(output(opened)).toContain("Web access")
      expect(
        researchCalls()
          .slice(before)
          .filter((call) => call.body.command === "research.open"),
      ).toEqual([])
      expect(Egress.policy().enabled).toBe(false)
    }),
  90_000,
)

it.instance(
  "takes screenshots only for a model that reads images",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      bridge.answer(desktop())
      const before = researchCalls().length
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_browser", { action: "screenshot" })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: "Research heat pump savings." })
      const [shot] = yield* calls(session.id, "research_browser")
      expect(output(shot)).toBe(ResearchBrowser.NO_IMAGES)
      expect(researchCalls().slice(before)).toEqual([])
    }),
  90_000,
)

it.instance(
  "a script-built page is read in the agent's research browser when the desktop has one",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      const spa = web.url("spa", "/")
      const rendered = `<!doctype html><html><head><title>Heat pump planner</title></head><body><main><h1>Heat pump planner</h1><p>Rendered by script: the planner sizes a heat pump from the floor area and the coldest design temperature of the home.</p><p>It lists installers that fit the size it chose.</p></main></body></html>`
      bridge.answer((call) =>
        call.body.command === "research.read"
          ? FakeBridge.research({
              url: spa,
              address: spa,
              read: { html: rendered, title: "Heat pump planner", url: spa, links: [], forms: [], truncated: false },
            })
          : FakeBridge.research({ url: spa, address: spa }),
      )
      const before = researchCalls().length
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_read", { url: spa })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: `Research heat pump sizing at ${spa}` })
      const [read] = yield* calls(session.id, "research_read")
      expect(output(read)).toContain("S1 · ")
      expect(output(read)).toContain("Rendered by script: the planner sizes a heat pump")
      expect(read?.state.status === "completed" ? read.state.metadata.status : undefined).toBe("read")
      // The fetch came first; the browser rendered the page only because script builds it.
      expect(web.count("spa", "/")).toBeGreaterThan(0)
      expect((yield* settled(before)).map((call) => call.body.command)).toEqual([
        "research.open",
        "research.read",
        "research.close",
      ])
    }),
  90_000,
)

it.instance(
  "when the desktop browser fails to render a script-built page, research_read keeps it as skipped and says why",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      const spa = web.url("spa", "/")
      const error = "The research browser could not open the page."
      bridge.answer((call) =>
        call.body.command === "research.open"
          ? FakeBridge.research({ ok: false, error })
          : FakeBridge.research({ url: spa, address: spa }),
      )
      const before = researchCalls().length
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_read", { url: spa })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: `Research heat pump sizing at ${spa}` })
      const [read] = yield* calls(session.id, "research_read")
      const reason = `${ResearchReader.NEEDS_RENDER.replace(/\.+$/, "")}. The desktop browser could not render it: ${error}`
      expect(output(read)).toContain(ResearchReader.NEEDS_RENDER.replace(/\.$/, ""))
      expect(output(read)).toContain(error)
      expect(output(read)).not.toContain("..")
      expect(read?.state.status === "completed" ? read.state.metadata.status : undefined).toBe("needs-render")
      const commands = researchCalls()
        .slice(before)
        .map((call) => call.body.command)
      expect(commands).toContain("research.open")
      expect(commands).not.toContain("research.read")
      const research = yield* ResearchRun.Service
      const store = yield* ResearchStore.Service
      const runID = read?.state.status === "completed" ? String(read.state.metadata.runID) : ""
      const skipped = yield* store.source(yield* research.place(), runID, "S1")
      expect(skipped?.source).toMatchObject({ id: "S1", url: spa, status: "needs-render", reason })
      expect(skipped?.chunks).toEqual([])
    }),
  90_000,
)

it.instance(
  "without the desktop browser it says so, and research_read keeps a script-built page as skipped",
  () =>
    Effect.gen(function* () {
      pointed.off()
      try {
        const test = yield* setup()
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Research", permission: allow })
        const spa = web.url("spa", "/")
        const before = bridge.calls().length
        yield* test.llm.tool("research_plan", plan())
        yield* test.llm.tool("research_browser", { action: "open", url: spa })
        yield* test.llm.tool("research_read", { url: spa })
        yield* test.llm.tool("research_read", { url: spa, mode: "render" })
        yield* test.llm.text("Done.")
        yield* send({ sessionID: session.id, agent: "research", text: `Research heat pump sizing at ${spa}` })
        const [browsed] = yield* calls(session.id, "research_browser")
        expect(output(browsed)).toBe(ResearchBrowser.NEEDS_DESKTOP)
        const reads = yield* calls(session.id, "research_read")
        expect(output(reads[0])).toContain(ResearchReader.NEEDS_RENDER.replace(/\.$/, ""))
        expect(reads[0]?.state.status === "completed" ? reads[0].state.metadata.status : undefined).toBe("needs-render")
        expect(output(reads[1])).toBe(RENDER)
        expect(bridge.calls().length).toBe(before)
        // The skipped page is in the run, with why, and no text.
        const research = yield* ResearchRun.Service
        const store = yield* ResearchStore.Service
        const runID = reads[0]?.state.status === "completed" ? String(reads[0].state.metadata.runID) : ""
        const skipped = yield* store.source(yield* research.place(), runID, "S1")
        expect(skipped?.source).toMatchObject({
          id: "S1",
          url: spa,
          status: "needs-render",
          reason: ResearchReader.NEEDS_RENDER,
        })
        expect(skipped?.chunks).toEqual([])
      } finally {
        FakeBridge.use(bridge)
      }
    }),
  90_000,
)
