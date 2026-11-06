import { afterAll, expect } from "bun:test"
import { rmSync } from "node:fs"
import path from "path"
import { Deferred, Effect, Fiber } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Global } from "@vectordevai/core/global"
import { ResearchOutbound } from "@vectordevai/core/research/outbound"
import { Instruction } from "../../src/session/instruction"
import { Session } from "@/session/session"
import { SessionMemory } from "../../src/session/memory"
import { MessageID, type SessionID } from "../../src/session/schema"
import { ResearchRun } from "../../src/tool/research-run"
import { SubagentLifecycle } from "../../src/tool/subagent-lifecycle"
import { TaskLimits } from "../../src/task/limits"
import { pollWithTimeout } from "../lib/effect"
import { reply } from "../lib/llm-server"
import { FakeBridge } from "../lib/fake-bridge"
import { calls, output, plan, ref, runtime, send, setup } from "../lib/research"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// The build agent's research tool (on Work and Thorough requests, besides the Deep research mode): its question passes
// the outbound check before the research lead starts, the lead runs with the research agents' permissions and holds,
// research's default caps apply when the user has none, and the lead stays at the request's size, so its plan cannot
// raise a Work request to deep. The tool is offered to build alone, and not when the user turned it off. Everything in
// build's session tree counts against what it hands research: a page it fetched from the user's own network, and what
// a subagent took in, and the same check covers a message build sends a running research agent.

const guard = NetworkGuard.use()
const INTRANET =
  "Our Falcon merger with Initech closes on 4417203 at the reconcileLedgerEntries desk. Call the desk on 415-555-0177."
const web = FakeWeb.start({
  sites: {
    ...FakeWeb.sites(),
    intranet: {
      "/": () =>
        new Response(`<html><body><p>${INTRANET}</p></body></html>`, { headers: { "content-type": "text/html" } }),
    },
  },
})
const it = runtime(web)
// A desktop whose research browsers answer each search with the fake web's pages, for the tests that search.
const bridge = FakeBridge.start(FakeBridge.searching(web))
afterAll(async () => {
  await bridge.close()
  await web.close()
})

const NOTES = "The Falcon migration moves the ledger to the reconcileLedgerEntries service before the March freeze."
const HABIT = "Prefer migration guides that show a rollback plan"
const FACT = "My badge number at Hooli is 44172 and my manager is Dana Whitfield"
const lead = (hit: { body: Record<string, unknown> }) =>
  JSON.stringify(hit.body).includes("Plan the run with research_plan")
const names = (body: string) =>
  ((JSON.parse(body) as { tools?: { function?: { name?: string } }[] }).tools ?? []).map((tool) => tool.function?.name)

it.instance(
  "a Work request researches through the lead, at Focused, under research's caps, and is held as web",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(test.dir, "notes", "plan.md"), `# Plan\n\n${NOTES}\n`)
      const brain = yield* Brain.Service
      const instruction = yield* Instruction.Service
      const place = yield* instruction.place()
      for (const [kind, text] of [
        ["preference", HABIT],
        ["fact", FACT],
      ] as const)
        yield* brain.propose(place, { kind, text, scope: "personal", origin: "user", evidence: { type: "user" } })
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      yield* test.llm.tool("read", { filePath: path.join(test.dir, "notes", "plan.md") })
      // A question that copies what build read is refused before any lead starts.
      yield* test.llm.tool("research", { question: `How risky is this? ${NOTES}`, background: false })
      yield* test.llm.tool("research", {
        question: "How do teams migrate a ledger service without downtime?",
        depth: "deep",
        background: false,
      })
      // The lead plans deep; its launcher is a Work request, so the run is Focused.
      yield* test.llm.toolMatch(
        lead,
        "research_plan",
        plan({ question: "How do teams migrate a ledger service without downtime?", depth: "deep" }),
      )
      yield* test.llm.textMatch(lead, "Teams run both ledgers side by side, then switch reads.")
      yield* test.llm.text("Done.")
      const bodies = yield* send({
        sessionID: build.id,
        agent: "build",
        text: "Plan the ledger migration and look up how others do it.",
        size: "standard",
      })
      expect(names(bodies[0]!)).toContain("research")
      expect(names(bodies[0]!)).not.toContain("research_plan")

      const [refused, started] = yield* calls(build.id, "research")
      expect(refused?.state.status).toBe("error")
      expect(output(refused)).toContain(ResearchRun.REQUEST_REFUSAL)
      expect(started?.state.status).toBe("completed")
      expect(output(started)).toContain("Teams run both ledgers side by side")
      expect(started?.state.status === "completed" ? started.state.metadata[SessionMemory.HOLD] : undefined).toBe("web")

      const children = yield* sessions.children(build.id)
      expect(children).toHaveLength(1)
      const record = SubagentLifecycle.read(children[0]!)
      expect(record?.agent).toBe("research")
      expect(record?.budget).toEqual({ usd: ResearchRun.LIMITS.focused.usd, steps: ResearchRun.LIMITS.focused.steps })
      const [planned] = yield* calls(children[0]!.id, "research_plan")
      const metadata = planned?.state.status === "completed" ? planned.state.metadata : {}
      expect(metadata.answer).toBe("automatic")
      expect(metadata.plan.depth).toBe("focused")
      expect(metadata.to).toBeUndefined()
      // The lead got the question alone, never the file build read.
      const leadBodies = bodies.filter((body) => body.includes("Plan the run with research_plan"))
      expect(leadBodies.length).toBeGreaterThan(0)
      // Of the owner's memory it hears how they work, screened, and nothing about them: no fact, no MEMORY.md.
      expect(leadBodies[0]).toContain(HABIT)
      expect(leadBodies[0]).toContain("Never force-push to main")
      for (const body of leadBodies) {
        expect(body).not.toContain("reconcileLedgerEntries")
        expect(body).not.toContain("badge number")
        expect(body).not.toContain("Hooli")
      }
      expect(guard.outside()).toEqual([])
    }),
  120_000,
)

it.instance(
  "research as a tool is not offered when the user turned it off",
  () =>
    Effect.gen(function* () {
      const test = yield* setup({ research: { tool: "off" } })
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      yield* test.llm.text("Done.")
      const [body] = yield* send({
        sessionID: build.id,
        agent: "build",
        text: "Plan the ledger migration.",
        size: "standard",
      })
      expect(names(body!)).not.toContain("research")
    }),
  60_000,
)

it.instance(
  "what build ran with a shell, or heard from an explore subagent, stays out of its research requests",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(test.dir, "notes", "plan.md"), `# Plan\n\n${NOTES}\n`)
      const sessions = yield* Session.Service
      const explorer = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("orchestration_assignment")

      const shell = yield* sessions.create({ title: "Build" })
      yield* test.llm.tool("bash", { command: "cat notes/plan.md", description: "Read the plan" })
      yield* test.llm.tool("research", { question: `How risky is this? ${NOTES}`, background: false })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: shell.id, agent: "build", text: "Plan the ledger migration.", size: "standard" })
      const [bash] = yield* calls(shell.id, "bash")
      expect(output(bash)).toContain("reconcileLedgerEntries")
      const [fromShell] = yield* calls(shell.id, "research")
      expect(fromShell?.state.status).toBe("error")
      expect(output(fromShell)).toContain(ResearchRun.REQUEST_REFUSAL)

      const reported = yield* sessions.create({ title: "Build" })
      yield* test.llm.tool("task", {
        description: "Read the plan",
        prompt: "Read notes/plan.md and report its first sentence.",
        subagent_type: "explore",
        success_criteria: ["Quote the plan's first sentence"],
        background: false,
      })
      yield* test.llm.textMatch(explorer, `The plan says: ${NOTES}`)
      yield* test.llm.tool("research", { question: `How do teams do this? ${NOTES}`, background: false })
      yield* test.llm.text("Done.")
      // Subagents run on Thorough requests.
      yield* send({ sessionID: reported.id, agent: "build", text: "Plan the ledger migration.", size: "thorough" })
      const [task] = yield* calls(reported.id, "task")
      expect(output(task)).toContain("reconcileLedgerEntries")
      const [fromReport] = yield* calls(reported.id, "research")
      expect(fromReport?.state.status).toBe("error")
      expect(output(fromReport)).toContain(ResearchRun.REQUEST_REFUSAL)

      // No research lead started for either.
      const children = [...(yield* sessions.children(shell.id)), ...(yield* sessions.children(reported.id))]
      expect(children.map((child) => SubagentLifecycle.read(child)?.agent)).toEqual(["explore"])
      expect(guard.outside()).toEqual([])
    }),
  120_000,
)

it.instance(
  "a file build read before a compaction still counts against its research request",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(test.dir, "notes", "plan.md"), `# Plan\n\n${NOTES}\n`)
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      yield* test.llm.tool("read", { filePath: path.join(test.dir, "notes", "plan.md") })
      yield* test.llm.text("Read it.")
      yield* send({ sessionID: build.id, agent: "build", text: "Read the ledger plan.", size: "standard" })
      const research = yield* ResearchRun.Service
      // What a step after a compaction gets: none of the messages before the summary.
      const brief = (prompt: string) =>
        research
          .brief({
            agent: ResearchRun.LEAD,
            ctx: {
              sessionID: build.id,
              messageID: MessageID.make("msg_after_compaction"),
              agent: "build",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
            prompt,
            extra: [],
          })
          .pipe(Effect.scoped)
      const refused = yield* brief(`How risky is this? ${NOTES}`)
      expect(refused.type).toBe("refused")
      expect(refused.type === "refused" ? refused.message : "").toContain(ResearchRun.REQUEST_REFUSAL)
      expect((yield* brief("How do teams migrate a ledger service without downtime?")).type).toBe("ok")
    }),
  90_000,
)

it.instance(
  "a budget the model writes for a research lead only lowers research's default caps",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      const lead = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("How do heat pumps age")
      yield* test.llm.tool("task", {
        description: "Research ageing",
        prompt: "How do heat pumps age in cold climates?",
        subagent_type: "research",
        budget: { usd: 100, steps: 5_000 },
        background: false,
      })
      yield* test.llm.textMatch(lead, "They lose a little efficiency each year.")
      yield* test.llm.tool("task", {
        description: "Research costs",
        prompt: "What do heat pumps cost to run in cold climates?",
        subagent_type: "research",
        budget: { usd: 0.5 },
        background: false,
      })
      yield* test.llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("What do heat pumps cost to run"),
        "About the same as gas.",
      )
      yield* test.llm.text("Done.")
      yield* send({ sessionID: build.id, agent: "build", text: "Research heat pumps, thoroughly.", size: "thorough" })
      const budgets = (yield* sessions.children(build.id))
        .map((child) => SubagentLifecycle.read(child))
        .toSorted((left, right) => (left?.startedAt ?? 0) - (right?.startedAt ?? 0))
        .map((record) => record?.budget)
      expect(budgets).toEqual([
        { usd: ResearchRun.LIMITS.deep.usd, steps: ResearchRun.LIMITS.deep.steps },
        { usd: 0.5, steps: ResearchRun.LIMITS.deep.steps },
      ])
    }),
  120_000,
)

it.instance(
  "the user's task rules apply to research started through the tool",
  () =>
    Effect.gen(function* () {
      const test = yield* setup({ permission: { task: { research: "deny" } } })
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      yield* test.llm.tool("research", { question: "How do heat pumps perform in cold climates?", background: false })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: build.id, agent: "build", text: "Look up heat pumps.", size: "standard" })
      const [research] = yield* calls(build.id, "research")
      expect(research?.state.status).toBe("error")
      expect(yield* sessions.children(build.id)).toEqual([])
    }),
  60_000,
)

it.instance(
  "a research lead cannot take another task's report with its brief",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(test.dir, "notes", "plan.md"), `# Plan\n\n${NOTES}\n`)
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      const explorer = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("orchestration_assignment")
      yield* test.llm.tool("task", {
        description: "Read the plan",
        prompt: "Read notes/plan.md and report its first sentence.",
        subagent_type: "explore",
        success_criteria: ["Quote the plan's first sentence"],
        background: false,
      })
      yield* test.llm.textMatch(explorer, `The plan says: ${NOTES}`)
      yield* test.llm.text("Read it.")
      yield* send({ sessionID: build.id, agent: "build", text: "Read the ledger plan.", size: "thorough" })
      const [explore] = yield* sessions.children(build.id)
      // The report would reach the lead with a brief that says nothing private.
      yield* test.llm.tool("task", {
        description: "Research it",
        prompt: "How do teams migrate a ledger service without downtime?",
        subagent_type: "research",
        depends_on: [explore!.id],
        background: false,
      })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: build.id, agent: "build", text: "Now look up how others do it.", size: "thorough" })
      const [, research] = yield* calls(build.id, "task")
      expect(research?.state.status).toBe("error")
      expect(output(research)).toContain("cannot depend on another task")
      expect(yield* sessions.children(build.id)).toHaveLength(1)
    }),
  120_000,
)

it.instance(
  "a page build fetched from the user's own network counts against its research request",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const build = yield* sessions.create({
        title: "Build",
        permission: [
          { permission: "webfetch", pattern: "*", action: "allow" },
          { permission: "private_network", pattern: "*", action: "allow" },
        ],
      })
      yield* test.llm.tool("webfetch", { url: web.direct("intranet", "/"), format: "text" })
      yield* test.llm.tool("research", {
        question:
          "How do mergers close? Our Falcon merger with Initech closes on 4417203 at the reconcileLedgerEntries desk.",
        background: false,
      })
      yield* test.llm.tool("research", {
        question: "Who answers 415-555-0177 for mergers like Falcon?",
        background: false,
      })
      yield* test.llm.text("Done.")
      yield* send({
        sessionID: build.id,
        agent: "build",
        text: "Look at our intranet page and research it.",
        size: "standard",
      })
      const [fetched] = yield* calls(build.id, "webfetch")
      expect(output(fetched)).toContain("Initech")
      expect(fetched?.state.status === "completed" ? fetched.state.metadata.private : undefined).toBe(true)
      // A sentence and a phone number copied from the page are refused: the page is the user's, not public text.
      for (const research of yield* calls(build.id, "research")) {
        expect(research.state.status).toBe("error")
        expect(output(research)).toContain(ResearchRun.REQUEST_REFUSAL)
      }
      expect(yield* sessions.children(build.id)).toEqual([])
      expect(guard.outside()).toEqual([])
    }),
  90_000,
)

it.instance(
  "a private fact a subagent was briefed with and reported counts against build's research request",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const brain = yield* Brain.Service
      const instruction = yield* Instruction.Service
      const place = yield* instruction.place()
      yield* brain.propose(place, {
        kind: "fact",
        text: FACT,
        scope: "personal",
        origin: "user",
        evidence: { type: "user" },
      })
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      const general = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("orchestration_assignment")
      // A Thorough request's subagent starts with a brief recalled with its task as the query: here, the fact.
      yield* test.llm.tool("task", {
        description: "Find the manager",
        prompt: "Find which manager signs off badge numbers and report the name.",
        subagent_type: "general",
        success_criteria: ["Name the manager"],
        background: false,
      })
      yield* test.llm.textMatch(general, `The note says: ${FACT}.`)
      yield* test.llm.tool("research", {
        question: `How do payments teams work when ${FACT}?`,
        background: false,
      })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: build.id, agent: "build", text: "Look into how our team is run.", size: "thorough" })
      const [task] = yield* calls(build.id, "task")
      expect(output(task)).toContain("Dana Whitfield")
      const [research] = yield* calls(build.id, "research")
      expect(research?.state.status).toBe("error")
      expect(output(research)).toContain(ResearchRun.REQUEST_REFUSAL)
      expect((yield* sessions.children(build.id)).map((child) => SubagentLifecycle.read(child)?.agent)).toEqual([
        "general",
      ])
    }),
  120_000,
)

it.instance(
  "build's message to a running research lead passes the check its request did, and a researcher hears from its lead alone",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(test.dir, "notes", "plan.md"), `# Plan\n\n${NOTES}\n`)
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      // A research lead build started, and a researcher that lead started, both still running.
      const delegated = (parentID: SessionID, agent: string) =>
        sessions.create({
          parentID,
          title: agent,
          metadata: {
            subagent: {
              kind: "subagent",
              custom: false,
              agent,
              title: agent,
              parentSessionID: parentID,
              parentMessageID: MessageID.ascending(),
              model: { providerID: ref.providerID, modelID: ref.modelID },
              background: true,
              status: "running",
              startedAt: Date.now(),
              runtimeID: SubagentLifecycle.RUNTIME_ID,
              attempt: 1,
            },
          },
        })
      const leader = yield* delegated(build.id, "research")
      const worker = yield* delegated(leader.id, "researcher")
      yield* test.llm.tool("read", { filePath: path.join(test.dir, "notes", "plan.md") })
      yield* test.llm.tool("task_manage", {
        action: "message",
        task_id: leader.id,
        text: `Also look at this: ${NOTES}`,
      })
      yield* test.llm.tool("task_manage", {
        action: "message",
        task_id: worker.id,
        text: "Search for ledger migrations without downtime.",
      })
      yield* test.llm.tool("task_manage", {
        action: "message",
        task_id: leader.id,
        text: "Also look at ledger migrations without downtime.",
      })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: build.id, agent: "build", text: "Plan the ledger migration.", size: "thorough" })
      const [copied, toWorker, fair] = yield* calls(build.id, "task_manage")
      expect(copied?.state.status).toBe("error")
      expect(output(copied)).toContain(ResearchRun.REQUEST_REFUSAL)
      expect(toWorker?.state.status).toBe("error")
      expect(output(toWorker)).toContain(ResearchRun.LEAD_ONLY)
      // A message in public terms passes the check and goes on to the task, which here has no run to join.
      expect(output(fair)).not.toContain(ResearchRun.REQUEST_REFUSAL)
      expect(output(fair)).toContain("finished")
      // Nothing reached either mailbox.
      expect(SubagentLifecycle.read(yield* sessions.get(leader.id))?.mailbox ?? []).toEqual([])
      expect(SubagentLifecycle.read(yield* sessions.get(worker.id))?.mailbox ?? []).toEqual([])
    }),
  90_000,
)

it.instance(
  "the instruction files in build's system prompt count against its research requests",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(
        path.join(test.dir, "AGENTS.md"),
        "# Rules\n\nDeploy through ci07.quarry-ops.internal with the reconcileLedgerEntries job.\n",
      )
      const personal = path.join((yield* Global.Service).config, "AGENTS.md")
      yield* fs.writeWithDirs(personal, "# Mine\n\nMy manager Dana Whitfield signs off every Falcon release.\n")
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(personal, { force: true })))
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      yield* test.llm.tool("research", {
        question: "How do other teams deploy through ci07.quarry-ops.internal?",
        background: false,
      })
      yield* test.llm.tool("research", {
        question: "Is it usual that my manager Dana Whitfield signs off every Falcon release?",
        background: false,
      })
      yield* test.llm.text("Done.")
      const bodies = yield* send({
        sessionID: build.id,
        agent: "build",
        text: "Plan the ledger migration.",
        size: "standard",
      })
      expect(bodies[0]).toContain("reconcileLedgerEntries")
      expect(bodies[0]).toContain("Dana Whitfield")
      const tried = yield* calls(build.id, "research")
      expect(tried).toHaveLength(2)
      for (const call of tried) {
        expect(call.state.status).toBe("error")
        expect(output(call)).toContain(ResearchRun.REQUEST_REFUSAL)
      }
      expect(yield* sessions.children(build.id)).toEqual([])
    }),
  { git: true },
  90_000,
)

it.instance(
  "after a switch to Deep research, what build's subagents took in earlier in the session counts against its searches",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const brain = yield* Brain.Service
      const instruction = yield* Instruction.Service
      const place = yield* instruction.place()
      yield* brain.propose(place, {
        kind: "fact",
        text: FACT,
        scope: "personal",
        origin: "user",
        evidence: { type: "user" },
      })
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Mixed",
        permission: [
          { permission: "research_read", pattern: "*", action: "allow" },
          { permission: "private_network", pattern: "*", action: "allow" },
        ],
      })
      const general = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("orchestration_assignment")
      // A Thorough request's subagent is recalled the fact with its task, and reports it.
      yield* test.llm.tool("task", {
        description: "Find the manager",
        prompt: "Find which manager signs off badge numbers and report the name.",
        subagent_type: "general",
        success_criteria: ["Name the manager"],
        background: false,
      })
      yield* test.llm.textMatch(general, `The note says: ${FACT}.`)
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "build", text: "Look into how our team is run.", size: "thorough" })
      const [task] = yield* calls(session.id, "task")
      expect(output(task)).toContain("Dana Whitfield")

      // The same session, now in Deep research, in the desktop app.
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_search", {
        query: "badge number at Hooli is 44172 and my manager is Dana Whitfield",
      })
      yield* test.llm.tool("research_search", { query: "heat pump savings in cold climates" })
      yield* test.llm.text("Done.")
      const before = FakeBridge.searches(bridge).length
      yield* FakeBridge.within(
        bridge,
        send({ sessionID: session.id, agent: "research", text: "Research how heat pumps cut heating bills." }),
      )
      const [copied, fair] = yield* calls(session.id, "research_search")
      expect(output(copied)).toBe(ResearchOutbound.REFUSAL)
      expect(output(fair)).not.toBe(ResearchOutbound.REFUSAL)
      expect(FakeBridge.searches(bridge).length - before).toBe(1)
      expect(guard.outside()).toEqual([])
    }),
  120_000,
)

it.instance(
  "a research lead owns no paths, so owned_paths cannot carry text past the brief check",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(test.dir, "notes", "plan.md"), `# Plan\n\n${NOTES}\n`)
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      yield* test.llm.tool("read", { filePath: path.join(test.dir, "notes", "plan.md") })
      yield* test.llm.tool("task", {
        description: "Research",
        prompt: "How do teams migrate a ledger service without downtime?",
        subagent_type: "research",
        owned_paths: ["reconcileLedgerEntries Falcon March freeze"],
        background: false,
      })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: build.id, agent: "build", text: "Plan the migration.", size: "thorough" })
      const [task] = yield* calls(build.id, "task")
      expect(task?.state.status).toBe("error")
      expect(output(task)).toContain("owns no paths")
      expect(yield* sessions.children(build.id)).toEqual([])
    }),
  90_000,
)

it.instance(
  "a research lead does not take paths its launcher's own assignment owns",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      // A general Subagent whose assignment owns a path named like the work, as a launcher's record keeps it.
      const worker = yield* sessions.create({
        parentID: build.id,
        title: "Ledger work",
        metadata: {
          subagent: {
            kind: "subagent",
            custom: false,
            agent: "general",
            title: "Ledger work",
            parentSessionID: build.id,
            parentMessageID: MessageID.ascending(),
            model: { providerID: ref.providerID, modelID: ref.modelID },
            background: false,
            status: "running",
            startedAt: Date.now(),
            runtimeID: SubagentLifecycle.RUNTIME_ID,
            attempt: 1,
            ownedPaths: ["services/reconcileLedgerEntries"],
          },
        },
      })
      const question = "How do teams migrate a ledger service without downtime?"
      yield* test.llm.tool("task", {
        description: "Research",
        prompt: question,
        subagent_type: "research",
        background: false,
      })
      yield* test.llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes(question),
        "Teams run both ledgers side by side.",
      )
      yield* test.llm.text("Done.")
      const bodies = yield* send({ sessionID: worker.id, agent: "general", text: "Look up how others migrate." })
      const [task] = yield* calls(worker.id, "task")
      expect(task?.state.status).toBe("completed")
      const [child] = yield* sessions.children(worker.id)
      expect(SubagentLifecycle.read(child!)?.agent).toBe("research")
      expect(SubagentLifecycle.read(child!)?.ownedPaths ?? []).toEqual([])
      const leadBodies = bodies.filter((body) => names(body).includes("research_plan"))
      expect(leadBodies.length).toBeGreaterThan(0)
      for (const body of leadBodies) expect(body).not.toContain("reconcileLedgerEntries")
    }),
  90_000,
)

it.instance(
  "a research task resumes only as the agent it ran",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      const general = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("Summarise the ledger notes")
      const question = "How do heat pumps age in cold climates?"
      yield* test.llm.tool("task", {
        description: "Research ageing",
        prompt: question,
        subagent_type: "research",
        background: false,
      })
      yield* test.llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes(question),
        "They lose a little efficiency each year.",
      )
      yield* test.llm.tool("task", {
        description: "Summarise",
        prompt: "Summarise the ledger notes.",
        subagent_type: "general",
        background: false,
      })
      yield* test.llm.textMatch(general, "Summarised.")
      yield* test.llm.text("Done.")
      yield* send({ sessionID: build.id, agent: "build", text: "Research heat pumps, thoroughly.", size: "thorough" })
      const children = yield* sessions.children(build.id)
      const agentOf = (agent: string) => children.find((child) => SubagentLifecycle.read(child)?.agent === agent)!
      const researching = agentOf("research")
      const summarising = agentOf("general")
      // The lead's history of web pages would reach a shell and edits; another agent's history would reach research.
      yield* test.llm.tool("task", {
        description: "Continue",
        prompt: "Now continue as a general agent.",
        subagent_type: "general",
        task_id: researching.id,
        background: false,
      })
      yield* test.llm.tool("task", {
        description: "Continue",
        prompt: "Now research what you summarised.",
        subagent_type: "research",
        task_id: summarising.id,
        background: false,
      })
      yield* test.llm.text("Done again.")
      yield* send({ sessionID: build.id, agent: "build", text: "Continue it.", size: "thorough" })
      const [, , asGeneral, asResearch] = yield* calls(build.id, "task")
      expect(asGeneral?.state.status).toBe("error")
      expect(output(asGeneral)).toContain("resumes only as research")
      expect(asResearch?.state.status).toBe("error")
      expect(output(asResearch)).toContain("resumes only as general")
      const agents = (yield* sessions.messages({ sessionID: researching.id })).map((message) => message.info.agent)
      expect(new Set(agents)).toEqual(new Set(["research"]))
    }),
  120_000,
)

it.instance(
  "a Light request does not research as a tool",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      yield* test.llm.tool("research", {
        question: "How do teams migrate a ledger service without downtime?",
        background: false,
      })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: build.id, agent: "build", text: "Rename the ledger variable.", size: "light" })
      const [call] = yield* calls(build.id, "research")
      expect(output(call)).toContain("not on a Light one")
      expect(yield* sessions.children(build.id)).toEqual([])
    }),
  60_000,
)

it.instance(
  "a context pack is checked as the text it carries, so a line break cannot split a private run of words",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(test.dir, "notes", "plan.md"), `# Plan\n\n${NOTES}\n`)
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      yield* test.llm.tool("read", { filePath: path.join(test.dir, "notes", "plan.md") })
      yield* test.llm.tool("task", {
        description: "Research",
        prompt: "How do teams migrate a ledger service without downtime?",
        subagent_type: "research",
        // A file read is the work, so the copy is 12 words in a row.
        context_pack: {
          findings: [
            "The Falcon migration moves the ledger\nto the reconcileLedgerEntries service before the March cutover",
          ],
        },
        background: false,
      })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: build.id, agent: "build", text: "Plan the migration.", size: "thorough" })
      const [task] = yield* calls(build.id, "task")
      expect(task?.state.status).toBe("error")
      expect(output(task)).toContain(ResearchRun.REQUEST_REFUSAL)
      expect(yield* sessions.children(build.id)).toEqual([])
    }),
  90_000,
)

it.instance(
  "a research lead's brief holds a slot for each researcher its run may have",
  () =>
    Effect.gen(function* () {
      yield* setup()
      const sessions = yield* Session.Service
      const research = yield* ResearchRun.Service
      const build = yield* sessions.create({ title: "Build" })
      const reserve = (taskSize: { tier: "standard" | "thorough"; capped?: boolean }) =>
        research
          .brief({
            agent: ResearchRun.LEAD,
            ctx: {
              sessionID: build.id,
              messageID: MessageID.make("msg_research_reserve"),
              agent: "build",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
              extra: { taskSize },
            },
            prompt: "How do heat pumps age in cold climates?",
            extra: [],
          })
          .pipe(
            Effect.scoped,
            Effect.map((brief) => (brief.type === "ok" ? brief.reserve : brief.message)),
          )
      // Focused runs have up to 2 researchers and Deep ones 4, so a Deep lead takes 5 slots in all.
      expect(yield* reserve({ tier: "standard" })).toBe(ResearchRun.LIMITS.focused.researchers)
      expect(yield* reserve({ tier: "thorough" })).toBe(ResearchRun.LIMITS.deep.researchers)
      // "No subagents": the lead launches no researcher, so it holds no slot for one.
      expect(yield* reserve({ tier: "standard", capped: true })).toBeUndefined()
    }),
  60_000,
)

it.instance(
  "a Deep lead's researchers start on the slots it holds while seven other subagents fill the conversation",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const limits = yield* TaskLimits.Service
      const build = yield* sessions.create({ title: "Build" })
      const researcher = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("research_assignment")
      const question = "How do heat pumps age in cold climates?"
      // The lead's step that launches its researchers waits until the other subagents hold the conversation's slots.
      const gate = Promise.withResolvers<void>()
      yield* test.llm.tool("research", { question, depth: "deep", background: false })
      yield* test.llm.toolMatch(lead, "research_plan", plan({ question, depth: "deep" }))
      yield* test.llm.pushMatch(
        lead,
        reply()
          .wait(gate.promise)
          .tool("task", {
            tasks: [
              { description: "Field studies", prompt: "What did field studies measure?", subagent_type: "researcher" },
              { description: "Lifetimes", prompt: "How long do heat pumps last in the cold?", subagent_type: "researcher" },
            ],
          }),
      )
      yield* test.llm.textMatch(researcher, "Found A.")
      yield* test.llm.textMatch(researcher, "Found B.")
      yield* test.llm.textMatch(lead, "They lose a little efficiency each year.")
      yield* test.llm.text("Done.")
      const sending = yield* send({
        sessionID: build.id,
        agent: "build",
        text: "Research how heat pumps age, thoroughly.",
        size: "thorough",
      }).pipe(Effect.forkChild)
      // The lead's launching step has been asked for: it runs, holding its slot and four for its researchers.
      yield* pollWithTimeout(
        test.llm.pending.pipe(Effect.map((left) => (left === 4 ? true : undefined))),
        "the lead must reach the step that launches its researchers",
        "60 seconds",
      )
      expect(yield* limits.status(build.id)).toMatchObject({ running: 1, queued: 0, limit: 8 })
      // Seven other subagents of the conversation: three take the slots left and four wait.
      const release = yield* Deferred.make<void>()
      const others = yield* Effect.forEach(Array.from({ length: 7 }, (_, index) => `ses_other_${index}`), (childID) =>
        limits.run({ conversationID: build.id, childID, origin: "root" }, Deferred.await(release)).pipe(Effect.forkChild),
      )
      yield* pollWithTimeout(
        limits.status(build.id).pipe(
          Effect.map((status) => (status.running === 4 && status.queued === 4 ? true : undefined)),
        ),
        "three other subagents must run and four wait",
      )
      gate.resolve()
      yield* Fiber.join(sending)

      const [leadSession] = yield* sessions.children(build.id)
      expect(SubagentLifecycle.read(leadSession!)?.agent).toBe(ResearchRun.LEAD)
      const [launch] = yield* calls(leadSession!.id, "task")
      expect(launch?.state.status).toBe("completed")
      expect(output(launch)).toContain("Found A.")
      expect(output(launch)).toContain("Found B.")
      const researchers = yield* sessions.children(leadSession!.id)
      expect(researchers.map((child) => SubagentLifecycle.read(child)?.agent)).toEqual([
        ResearchRun.RESEARCHER,
        ResearchRun.RESEARCHER,
      ])
      yield* Deferred.succeed(release, undefined)
      yield* Effect.forEach(others, Fiber.join, { discard: true })
      expect(yield* limits.status(build.id)).toMatchObject({ running: 0, queued: 0 })
      expect(guard.outside()).toEqual([])
    }),
  120_000,
)

it.instance(
  "a Deep lead in a conversation that runs four subagents has three researchers, each on a slot it holds",
  () =>
    Effect.gen(function* () {
      // Four at once: the lead holds its own slot and three for its researchers, so its run may have three.
      const test = yield* setup({ budget: { subagents: { running: 4 } } })
      const sessions = yield* Session.Service
      const limits = yield* TaskLimits.Service
      const build = yield* sessions.create({ title: "Build" })
      const researcher = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("research_assignment")
      const question = "How do heat pumps age in cold climates?"
      const entry = (area: string) => ({
        description: area,
        prompt: `What do studies say about ${area.toLowerCase()}?`,
        subagent_type: "researcher",
      })
      yield* test.llm.tool("research", { question, depth: "deep", background: false })
      yield* test.llm.toolMatch(lead, "research_plan", plan({ question, depth: "deep" }))
      // Four researchers in one call: the run's fourth is refused with its own count, not for want of a slot.
      yield* test.llm.toolMatch(lead, "task", {
        tasks: ["Field studies", "Lifetimes", "Defrost cycles", "Refrigerants"].map(entry),
      })
      yield* test.llm.toolMatch(lead, "task", { tasks: ["Field studies", "Lifetimes", "Defrost cycles"].map(entry) })
      yield* test.llm.textMatch(researcher, "Found A.")
      yield* test.llm.textMatch(researcher, "Found B.")
      yield* test.llm.textMatch(researcher, "Found C.")
      yield* test.llm.textMatch(lead, "They lose a little efficiency each year.")
      yield* test.llm.text("Done.")
      yield* send({
        sessionID: build.id,
        agent: "build",
        text: "Research how heat pumps age, thoroughly.",
        size: "thorough",
      })

      const [leadSession] = yield* sessions.children(build.id)
      expect(SubagentLifecycle.read(leadSession!)?.agent).toBe(ResearchRun.LEAD)
      const [four, three] = yield* calls(leadSession!.id, "task")
      expect(four?.state.status).toBe("error")
      expect(output(four)).toContain("has its 3 researchers")
      expect(output(four)).not.toContain("subagent slots")
      expect(three?.state.status).toBe("completed")
      for (const found of ["Found A.", "Found B.", "Found C."]) expect(output(three)).toContain(found)
      const researchers = yield* sessions.children(leadSession!.id)
      expect(researchers.map((child) => SubagentLifecycle.read(child)?.agent)).toEqual([
        ResearchRun.RESEARCHER,
        ResearchRun.RESEARCHER,
        ResearchRun.RESEARCHER,
      ])
      expect(yield* limits.status(build.id)).toMatchObject({ running: 0, queued: 0, limit: 4 })
      expect(guard.outside()).toEqual([])
    }),
  120_000,
)
