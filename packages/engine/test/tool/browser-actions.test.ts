import { afterAll, expect } from "bun:test"
import { Effect } from "effect"
import type { PermissionV1 } from "@vectordevai/core/v1/permission"
import { ResearchOutbound } from "@vectordevai/core/research/outbound"
import { ResearchProvenance } from "@vectordevai/core/research/provenance"
import { ResearchStore } from "@vectordevai/core/research/store"
import { Permission } from "../../src/permission"
import { Question } from "../../src/question"
import { Session } from "@/session/session"
import { AFTER_HANDOFF, CONTINUE, HANDOFF_QUESTION, INSIDE, NO_IMAGES, RESEARCH_ONLY } from "../../src/tool/browser"
import { ResearchRun } from "../../src/tool/research-run"
import { ResearchSource } from "../../src/tool/research-source"
import { FakeBridge } from "../lib/fake-bridge"
import { calls, output, plan, runtime, send, setup } from "../lib/research"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// The user's visible agent browser's new actions (section 5.6): read, links, find, observe with ref_N handles, a click
// by ref, and handoff, which shows the page in Preview and waits on a question until the user presses Continue. In
// Deep research the lead may only hand a page over and then read the page the user reached; that page is a private
// source of the run, read signed in. The desktop is a fake bridge on loopback.

// Links a page offers that reach this computer and the user's network.
const INWARD = ["http://localhost:3000/admin/reset?all=1", "http://10.0.0.5/admin"] as const
const guard = NetworkGuard.use()
const web = FakeWeb.start({
  sites: {
    ...FakeWeb.sites(),
    // A public page that links to the user's own computer and network, as a hostile page can: an admin action on a
    // local server, and a router.
    inward: {
      "/": {
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html><head><title>Heat pump installers</title></head><body><main><h1>Heat pump installers</h1><p>Installers in three countries supply most of the market, and each of them keeps a price list for the season.</p><p>Compare the lists before you choose an installer for a cold climate.</p><p><a href="${INWARD[0]}">Reset the price list</a> or <a href="${INWARD[1]}">open the router</a>.</p></main></body></html>`,
      },
    },
  },
})
const bridge = FakeBridge.start()
const pointed = FakeBridge.use(bridge)
const it = runtime(web, { client: "app" })
afterAll(async () => {
  pointed.off()
  await bridge.close()
  await web.close()
})

const LOGIN = "http://localhost:4000/login"
const SIGNED_IN = `<!doctype html><html><head><title>Inside the heat pump supply chain</title></head><body><main><h1>Inside the heat pump supply chain</h1><p>Members only: the compressor makers plan to raise prices by nine percent next spring for every installer.</p><p>Three countries supply most of the market.</p></main></body></html>`

// The same article for a subscriber who signed in: the publisher keeps isAccessibleForFree: false and its locked class.
const MEMBERS = `<!doctype html><html><head><title>Inside the heat pump supply chain</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"Inside the heat pump supply chain","isAccessibleForFree":false}</script></head><body><main><h1>Inside the heat pump supply chain</h1><p>Compressor makers in three countries supply most of the market, according to industry filings.</p>${Array.from(
  { length: 30 },
  (_, index) =>
    `<p class="locked">Section ${index} for subscribers: the makers plan to raise compressor prices for installers.</p>`,
).join("")}<p class="locked">Members only: prices rise by nine percent next spring.</p></main></body></html>`

// A visible browser that shows `current` and moves only when told to.
const visible = (start = "", html = SIGNED_IN) => {
  const state = { current: start }
  return {
    state,
    handler: (call: FakeBridge.Call) => {
      const body = call.body
      if (body.command === "openUrl") state.current = String(body.url)
      if (body.command === "readPage")
        return FakeBridge.visible({
          url: state.current,
          title: "Inside the heat pump supply chain",
          page: {
            html,
            title: "Inside the heat pump supply chain",
            url: state.current,
            links: [{ url: "https://journal.example/next", text: "Next", main: true }],
            forms: [],
            truncated: false,
          },
        })
      if (body.command === "observePage")
        return FakeBridge.visible({
          url: state.current,
          domSummary: {
            textSample: "",
            interactives: [],
            inputs: [{ tag: "input", selector: "#search", type: "search" }],
          },
          observed: {
            title: "Docs",
            url: state.current,
            text: "Welcome to the docs",
            elements: [{ ref: "ref_1", role: "link", name: "Guides", tag: "a", href: "http://localhost:4000/guides" }],
          },
        })
      return FakeBridge.visible({ url: state.current, title: "Page", target: { found: true, label: "Guides" } })
    },
  }
}

// A model request from a researcher: its brief is the research assignment.
const researcher = (hit: { body: Record<string, unknown> }) => JSON.stringify(hit.body).includes("research_assignment")

// Answers each handoff with `reply`, a research plan card with Start, and each permission once, keeping what was asked.
const answer = (reply: string) =>
  Effect.gen(function* () {
    const question = yield* Question.Service
    const permission = yield* Permission.Service
    const asked = { questions: [] as Question.Request[], permissions: [] as PermissionV1.Request[] }
    yield* Effect.gen(function* () {
      while (true) {
        for (const request of yield* question.list()) {
          const plan = request.questions[0]?.header === "Research plan"
          if (!plan) asked.questions.push(request)
          yield* question.reply({ requestID: request.id, answers: [[plan ? "Start" : reply]] }).pipe(Effect.ignore)
        }
        for (const request of yield* permission.list()) {
          asked.permissions.push(request)
          yield* permission.reply({ requestID: request.id, reply: "once" }).pipe(Effect.ignore)
        }
        yield* Effect.sleep(10)
      }
    }).pipe(Effect.forkScoped)
    return asked
  })

const commands = (from: number) =>
  bridge
    .calls()
    .slice(from)
    .filter((call) => call.path === "/command")
    .map((call) => String(call.body.command))

it.instance(
  "handoff opens the page, asks the user, and resumes on Continue; read then reads the page they reached",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Dashboard" })
      bridge.answer(visible().handler)
      const asked = yield* answer(CONTINUE)
      const before = bridge.calls().length
      yield* test.llm.tool("browser", { action: "handoff", url: LOGIN, reason: "Sign in to the staging dashboard." })
      yield* test.llm.tool("browser", { action: "read" })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "build", text: "Check the staging dashboard's numbers." })
      const [handoff, read] = yield* calls(session.id, "browser")
      expect(asked.questions).toHaveLength(1)
      expect(asked.questions[0]!.questions[0]).toMatchObject({
        header: "Browser handoff",
        question: `Sign in to the staging dashboard.\n\n${HANDOFF_QUESTION}`,
      })
      expect(asked.questions[0]!.tool?.callID).toBeTruthy()
      expect(output(handoff)).toContain("The user finished in the browser.")
      expect(handoff?.state.status === "completed" ? handoff.state.metadata : {}).toMatchObject({
        action: "handoff",
        handoff: "continued",
        url: LOGIN,
      })
      expect(output(read)).toContain("chunk 1 of 1")
      expect(output(read)).toContain("the compressor makers plan to raise prices")
      expect(output(read)).toContain("untrusted_web_page")
      expect(commands(before)).toEqual(["openUrl", "inspectDom", "inspectDom", "readPage"])
    }),
  90_000,
)

it.instance(
  "the page reached after a sign-in is kept and shown with its code and tokens redacted (B18)",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Dashboard" })
      const callback =
        "http://localhost:4000/callback?code=c0de42#access_token=eyJsecret&refresh_token=r3fr3sh&type=magiclink"
      bridge.answer(visible(callback).handler)
      yield* answer(CONTINUE)
      yield* test.llm.tool("browser", { action: "handoff", reason: "Sign in to the staging dashboard." })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "build", text: "Check the staging dashboard's numbers." })
      const [handoff] = yield* calls(session.id, "browser")
      expect(handoff?.state.status === "completed" ? handoff.state.metadata.url : undefined).toBe(
        "http://localhost:4000/callback?code=%5BREDACTED%5D#access_token=%5BREDACTED%5D&refresh_token=%5BREDACTED%5D&type=magiclink",
      )
      for (const secret of ["c0de42", "eyJsecret", "r3fr3sh"]) expect(JSON.stringify(handoff)).not.toContain(secret)
    }),
  90_000,
)

it.instance(
  "in Deep research the lead reads the page the user reached after a sign-in that left tokens in its address",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Research",
        permission: [{ permission: "research_read", pattern: "*", action: "allow" }],
      })
      const paywall = web.url("paywall", "/")
      const browser = visible("about:blank")
      // Signing in lands the user back on the article, with the site's code and tokens in the address.
      bridge.answer((call) => {
        const answered = browser.handler(call)
        if (call.body.command === "openUrl")
          browser.state.current = `${String(call.body.url)}?code=c0de42#access_token=eyJsecret`
        return answered
      })
      yield* answer(CONTINUE)
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("browser", { action: "handoff", url: paywall, reason: "The article is for subscribers." })
      yield* test.llm.tool("browser", { action: "read" })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: `Research heat pump supply prices: ${paywall}` })

      const [handoff, read] = yield* calls(session.id, "browser")
      expect(output(handoff)).toContain("The user finished in the browser.")
      // The handed page is compared by its redacted address, so the lead reads it, and nothing it keeps holds a token.
      expect(output(read)).toContain("S1 · ")
      expect(output(read)).toContain("the compressor makers plan to raise prices")
      for (const secret of ["c0de42", "eyJsecret"]) {
        expect(JSON.stringify(handoff)).not.toContain(secret)
        expect(JSON.stringify(read)).not.toContain(secret)
      }
      const research = yield* ResearchRun.Service
      const store = yield* ResearchStore.Service
      const runID = read?.state.status === "completed" ? String(read.state.metadata.runID) : ""
      const saved = yield* store.source(yield* research.place(), runID, "S1")
      expect(saved?.private).toBe(true)
      expect(JSON.stringify(saved?.source)).not.toContain("c0de42")
      expect(guard.outside()).toEqual([])
    }),
  120_000,
)

it.instance(
  "a cancelled handoff carries on without the page",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Dashboard" })
      bridge.answer(visible().handler)
      yield* answer("Cancel")
      yield* test.llm.tool("browser", { action: "handoff", url: LOGIN, reason: "Sign in." })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "build", text: "Check the staging dashboard." })
      const [handoff] = yield* calls(session.id, "browser")
      expect(output(handoff)).toContain("did not continue")
      expect(handoff?.state.status === "completed" ? handoff.state.metadata.handoff : undefined).toBe("cancelled")
    }),
  90_000,
)

it.instance(
  "observe gives ref handles, a click by ref uses trusted input, and screenshots wait for a model that reads images",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Docs" })
      bridge.answer(visible("http://localhost:4000/").handler)
      const before = bridge.calls().length
      yield* test.llm.tool("browser", { action: "observe" })
      yield* test.llm.tool("browser", { action: "click", ref: "ref_1" })
      yield* test.llm.tool("browser", { action: "screenshot" })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "build", text: "Look at the local docs." })
      const [observe, click, shot] = yield* calls(session.id, "browser")
      expect(output(observe)).toContain('ref_1 link "Guides" → http://localhost:4000/guides')
      // type still takes a selector, so observe names the fields by theirs.
      expect(output(observe)).toContain("- #search — search")
      expect(click?.state.status).toBe("completed")
      expect(output(shot)).toBe(NO_IMAGES)
      expect(commands(before)).toEqual(["inspectDom", "observePage", "inspectDom", "clickRef"])
      // The click asked the desktop for the name of what the ref would press, by the ref.
      const named = bridge
        .calls()
        .slice(before)
        .filter((call) => call.body.command === "inspectDom")
        .at(-1)
      expect(named?.body.ref).toBe("ref_1")
    }),
  90_000,
)

it.instance(
  "in Deep research the lead hands a page over and reads only the page the user reached, as a private source",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Research",
        permission: [{ permission: "research_read", pattern: "*", action: "allow" }],
      })
      const paywall = web.url("paywall", "/")
      const browser = visible("about:blank")
      bridge.answer(browser.handler)
      const asked = yield* answer(CONTINUE)
      const before = bridge.calls().length
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("browser", { action: "open_url", url: paywall })
      yield* test.llm.tool("browser", { action: "read" })
      yield* test.llm.tool("browser", { action: "handoff", url: "https://elsewhere.example/members" })
      yield* test.llm.tool("browser", { action: "handoff", url: paywall, reason: "The article is for subscribers." })
      yield* test.llm.tool("browser", { action: "read" })
      // Words of the signed-in page are private: they do not go into a search.
      yield* test.llm.tool("research_search", { query: "compressor makers plan to raise prices by nine percent" })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: `Research heat pump supply prices: ${paywall}` })

      const browsed = yield* calls(session.id, "browser")
      expect(output(browsed[0])).toBe(RESEARCH_ONLY)
      expect(output(browsed[1])).toBe(AFTER_HANDOFF)
      expect(output(browsed[2])).toContain(ResearchProvenance.REFUSAL)
      expect(output(browsed[3])).toContain("The user finished in the browser.")
      // Opening the page in the user's browser asked first, by its origin.
      expect(asked.permissions.map((request) => request.permission)).toContain("browser_external")
      expect(output(browsed[4])).toContain("S1 · ")
      expect(output(browsed[4])).toContain("read in your own signed-in browser")
      expect(browsed[4]?.state.status === "completed" ? browsed[4].state.metadata : {}).toMatchObject({
        private: true,
        source: "S1",
      })
      const [search] = yield* calls(session.id, "research_search")
      expect(output(search)).toContain(ResearchOutbound.REFUSAL.slice(0, 30))
      // The source is the run's, private and read signed in.
      const research = yield* ResearchRun.Service
      const store = yield* ResearchStore.Service
      const place = yield* research.place()
      const runID = browsed[4]?.state.status === "completed" ? String(browsed[4].state.metadata.runID) : ""
      const saved = yield* store.source(place, runID, "S1")
      expect(saved?.private).toBe(true)
      expect(saved?.source.signals?.signed_in).toBe(true)
      // No open_url, click, type or press reached the user's browser.
      expect(commands(before)).toEqual(["openUrl", "inspectDom", "inspectDom", "readPage"])
      expect(guard.outside()).toEqual([])

      // Once the user's browser shows another page, the lead reads nothing more there.
      browser.state.current = "https://bank.example/accounts"
      yield* test.llm.tool("browser", { action: "read" })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: "Carry on." })
      expect(output((yield* calls(session.id, "browser")).at(-1))).toBe(AFTER_HANDOFF)
    }),
  120_000,
)

it.instance(
  "a page read after a handoff is the user's signed-in text in full, beside the public excerpt research_read kept",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Research",
        permission: [{ permission: "research_read", pattern: "*", action: "allow" }],
      })
      const paywall = web.url("paywall", "/")
      bridge.answer(visible("about:blank", MEMBERS).handler)
      yield* answer(CONTINUE)
      yield* test.llm.tool("research_plan", plan())
      // The public read first: the paywall keeps its excerpt only.
      yield* test.llm.tool("research_read", { url: paywall })
      yield* test.llm.tool("browser", { action: "handoff", url: paywall, reason: "The article is for subscribers." })
      yield* test.llm.tool("browser", { action: "read" })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: `Research heat pump supply prices: ${paywall}` })

      const [read] = yield* calls(session.id, "research_read")
      expect(output(read)).toContain("S1 · ")
      expect(read?.state.status === "completed" ? read.state.metadata.status : undefined).toBe("paywalled")
      const browsed = yield* calls(session.id, "browser")
      // A source of its own, read in full although the page still says it is not free.
      expect(output(browsed[1])).toContain("S2 · ")
      expect(output(browsed[1])).not.toContain("Paywalled")
      expect(browsed[1]?.state.status === "completed" ? browsed[1].state.metadata : {}).toMatchObject({
        private: true,
        source: "S2",
      })
      const research = yield* ResearchRun.Service
      const store = yield* ResearchStore.Service
      const runID = browsed[1]?.state.status === "completed" ? String(browsed[1].state.metadata.runID) : ""
      const saved = yield* store.source(yield* research.place(), runID, "S2")
      expect(saved?.private).toBe(true)
      expect(saved?.source.status).toBe("read")
      expect(saved?.source.signals?.signed_in).toBe(true)
      expect(saved?.chunks.map((chunk) => chunk.text).join("\n")).toContain(
        "Members only: prices rise by nine percent next spring.",
      )
      // The public excerpt stays as it was.
      const excerpt = yield* store.source(yield* research.place(), runID, "S1")
      expect(excerpt?.source.status).toBe("paywalled")
      expect(excerpt?.private).toBe(false)
      expect(guard.outside()).toEqual([])
    }),
  120_000,
)

it.instance(
  "in Deep research the lead hands over no page a page offered on this computer or the user's network, and asks first",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Research",
        permission: [{ permission: "research_read", pattern: "*", action: "allow" }],
      })
      const inward = web.url("inward", "/")
      bridge.answer(visible("about:blank").handler)
      const asked = yield* answer(CONTINUE)
      const before = bridge.calls().length
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_read", { url: inward, links: true })
      yield* test.llm.tool("browser", { action: "handoff", url: INWARD[0], reason: "Reset the list." })
      yield* test.llm.tool("browser", { action: "handoff", url: INWARD[1], reason: "Open the router." })
      // The user typed this one: it is handed over, though it is on this computer, and asked about first.
      yield* test.llm.tool("browser", { action: "handoff", url: LOGIN, reason: "Sign in to your dashboard." })
      yield* test.llm.text("Done.")
      yield* send({
        sessionID: session.id,
        agent: "research",
        text: `Research heat pump installers from ${inward}, and my own dashboard at ${LOGIN}`,
      })

      // The page offered both links, so they are addresses this research may read.
      const [read] = yield* calls(session.id, "research_read")
      expect(read?.state.status === "completed" ? read.state.metadata.links : []).toEqual(
        expect.arrayContaining(INWARD),
      )
      const browsed = yield* calls(session.id, "browser")
      expect(output(browsed[0])).toBe(INSIDE)
      expect(output(browsed[1])).toBe(INSIDE)
      expect(output(browsed[2])).toContain("The user finished in the browser.")
      // Neither reached the user's browser: only the address the user typed did, once they were asked about it.
      const opened = bridge
        .calls()
        .slice(before)
        .filter((call) => call.path === "/command" && call.body.command === "openUrl")
        .map((call) => call.body.url)
      expect(opened).toEqual([LOGIN])
      expect(
        asked.permissions
          .filter((request) => request.permission === "browser_external")
          .map((request) => request.metadata.url),
      ).toEqual([LOGIN])
      expect(guard.outside()).toEqual([])
    }),
  120_000,
)

it.instance(
  "a researcher is shown nothing the lead read signed in, by its address or by its S#",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Research",
        permission: [{ permission: "research_read", pattern: "*", action: "allow" }],
      })
      const paywall = web.url("paywall", "/")
      bridge.answer(visible("about:blank", MEMBERS).handler)
      yield* answer(CONTINUE)
      yield* test.llm.tool("research_plan", plan({ depth: "deep" }))
      // The lead hands the article off and reads it signed in: S1, private.
      yield* test.llm.tool("browser", { action: "handoff", url: paywall, reason: "The article is for subscribers." })
      yield* test.llm.tool("browser", { action: "read" })
      yield* test.llm.tool("task", {
        description: "Supply",
        prompt: "Which countries supply most heat pump compressors?",
        subagent_type: "researcher",
        background: false,
      })
      yield* test.llm.toolMatch(researcher, "research_read", { url: paywall })
      yield* test.llm.toolMatch(researcher, "research_read", { source: "S1" })
      // Nor can it test a guess at the signed-in words with a note.
      yield* test.llm.toolMatch(researcher, "research_note", {
        subquestion: "Which countries supply most heat pump compressors?",
        claim: "Prices rise next spring.",
        source: "S1",
        quote: "Members only: prices rise by nine percent next spring.",
      })
      yield* test.llm.textMatch(researcher, "Found it.")
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: `Research heat pump supply prices: ${paywall}` })

      const browsed = yield* calls(session.id, "browser")
      expect(browsed[1]?.state.status === "completed" ? browsed[1].state.metadata : {}).toMatchObject({
        private: true,
        source: "S1",
      })
      const [child] = yield* sessions.children(session.id)
      const [byAddress, bySource] = yield* calls(child!.id, "research_read")
      // Its own public read of the address: the paywall's excerpt, as a source of its own, with none of the text the
      // user unlocked.
      expect(output(byAddress)).toContain("S2 · ")
      expect(byAddress?.state.status === "completed" ? byAddress.state.metadata : {}).toMatchObject({
        source: "S2",
        status: "paywalled",
      })
      expect(output(byAddress)).not.toContain("for subscribers: the makers plan")
      expect(output(byAddress)).not.toContain("nine percent next spring")
      // Nor by the signed-in source's number.
      expect(output(bySource)).toBe(ResearchSource.HIDDEN)
      const [noted] = yield* calls(child!.id, "research_note")
      expect(output(noted)).toBe(ResearchSource.HIDDEN)
      expect(guard.outside()).toEqual([])
    }),
  120_000,
)
