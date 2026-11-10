import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Permission } from "../../src/permission"
import { Session } from "@/session/session"
import { SessionMemory } from "../../src/session/memory"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { calls, output, runtime, send, setup } from "../lib/research"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// Memory holds for research (section 5.4, RC8): every research tool reads the web for memory's purposes, a research
// session is held as web from its first step, and a subagent that read the web passes that up through its task call,
// so its parent is held as web, not subagent.

const model = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("test-model") }
let counter = 0
const id = (prefix: string) => `${prefix}_taint-${++counter}`

function history(input: {
  readonly agent?: string
  readonly tools?: ReadonlyArray<{ readonly tool: string; readonly metadata?: Record<string, unknown> }>
}): SessionV1.WithParts[] {
  const sessionID = SessionID.make("ses_research_taint")
  const user = MessageID.make(id("msg"))
  const assistant = MessageID.make(id("msg"))
  const agent = input.agent ?? "build"
  return [
    {
      info: { id: user, sessionID, role: "user", time: { created: 1 }, agent, model },
      parts: [{ id: PartID.make(id("prt")), messageID: user, sessionID, type: "text", text: "look into it" }],
    },
    {
      info: {
        id: assistant,
        sessionID,
        role: "assistant",
        parentID: user,
        mode: agent,
        agent,
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: model.modelID,
        providerID: model.providerID,
        time: { created: 2 },
      },
      parts: (input.tools ?? []).map((call) => ({
        id: PartID.make(id("prt")),
        messageID: assistant,
        sessionID,
        type: "tool" as const,
        callID: id("call"),
        tool: call.tool,
        state: {
          status: "completed" as const,
          input: {},
          output: "",
          title: call.tool,
          metadata: call.metadata ?? {},
          time: { start: 0, end: 1 },
        },
      })),
    },
  ]
}

describe("SessionMemory.taint for research", () => {
  test("every research tool, the research browser and build's research tool read the web", () => {
    for (const tool of [
      "research",
      "research_plan",
      "research_search",
      "research_read",
      "research_browser",
      "research_note",
      "research_report",
    ])
      expect(SessionMemory.taint(history({ tools: [{ tool }] }))).toBe("web")
  })

  test("a research or researcher session is held as web before any tool has run", () => {
    expect(SessionMemory.taint(history({ agent: "research" }))).toBe("web")
    expect(SessionMemory.taint(history({ agent: "researcher" }))).toBe("web")
    expect(SessionMemory.taint(history({ agent: "build" }))).toBeUndefined()
  })

  // An MCP hold passes up as mcp, not reduced to subagent (5.D.6).
  test("a task call whose subagent read the web holds its parent as web, one that ran an MCP tool as mcp; otherwise as subagent", () => {
    expect(SessionMemory.taint(history({ tools: [{ tool: "task", metadata: { [SessionMemory.HOLD]: "web" } }] }))).toBe(
      "web",
    )
    expect(SessionMemory.taint(history({ tools: [{ tool: "task", metadata: { [SessionMemory.HOLD]: "mcp" } }] }))).toBe(
      "mcp",
    )
    expect(SessionMemory.taint(history({ tools: [{ tool: "task" }] }))).toBe("subagent")
  })
})

const guard = NetworkGuard.use()
const web = FakeWeb.start({ sites: FakeWeb.sites() })
const it = runtime(web)
afterAll(() => web.close())

it.instance(
  "what the research lead writes to memory waits for the user, from its first step",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research" })
      yield* test.llm.tool("memory", {
        action: "add",
        kind: "preference",
        text: "Prefer studies from Nordic utilities",
        scope: "personal",
      })
      yield* test.llm.text("Done.")
      yield* send({
        sessionID: session.id,
        agent: "research",
        text: "Remember that I prefer studies from Nordic utilities.",
      })
      const [memory] = yield* calls(session.id, "memory")
      const metadata = memory?.state.status === "completed" ? memory.state.metadata : {}
      expect(metadata.result).toBe("held")
      expect(metadata.hold).toBe("web")
      expect(guard.outside()).toEqual([])
    }),
  60_000,
)

it.instance(
  "a build request whose research child read the web is held as web",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      const lead = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("Plan the run with research_plan")
      yield* test.llm.tool("research", { question: "How do heat pumps perform in cold climates?", background: false })
      yield* test.llm.textMatch(lead, "They keep most of their efficiency down to minus 15 degrees.")
      yield* test.llm.tool("memory", {
        action: "add",
        kind: "preference",
        text: "Use heat pump data from field studies",
        scope: "personal",
      })
      yield* test.llm.text("Done.")
      yield* send({
        sessionID: build.id,
        agent: "build",
        text: "Look up how heat pumps do in the cold.",
        size: "standard",
      })
      const messages = yield* sessions.messages({ sessionID: build.id })
      expect(SessionMemory.taint(messages)).toBe("web")
      const [memory] = yield* calls(build.id, "memory")
      const metadata = memory?.state.status === "completed" ? memory.state.metadata : {}
      expect(metadata.hold).toBe("web")
    }),
  90_000,
)

it.instance(
  "a build request whose general subagent fetched a page is held as web through the task call alone",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const permission = yield* Permission.Service
      // The user lets the subagent fetch the page, which the fake web serves on this computer.
      yield* Effect.gen(function* () {
        while (true) {
          for (const request of yield* permission.list())
            yield* permission.reply({ requestID: request.id, reply: "once" }).pipe(Effect.ignore)
          yield* Effect.sleep(10)
        }
      }).pipe(Effect.forkScoped)
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      const general = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("orchestration_assignment")
      yield* test.llm.tool("task", {
        description: "Fetch the study",
        prompt: "Fetch the heat pump study and say what it found.",
        subagent_type: "general",
        success_criteria: ["Say what the study measured"],
        background: false,
      })
      yield* test.llm.toolMatch(general, "webfetch", { url: web.direct("article", "/"), format: "text" })
      yield* test.llm.textMatch(general, "The study followed 412 homes.")
      yield* test.llm.tool("memory", {
        action: "add",
        kind: "preference",
        text: "Use heat pump data from field studies",
        scope: "personal",
      })
      yield* test.llm.text("Done.")
      yield* send({
        sessionID: build.id,
        agent: "build",
        text: "Find out what the heat pump study found.",
        size: "thorough",
      })

      const [child] = yield* sessions.children(build.id)
      const [fetched] = yield* calls(child!.id, "webfetch")
      expect(fetched?.state.status).toBe("completed")
      expect(output(fetched)).toContain("412 homes")
      // Build itself read nothing from the web: its own calls are the task and the memory write.
      const messages = yield* sessions.messages({ sessionID: build.id })
      const tools = messages.flatMap((message) =>
        message.parts.flatMap((part) => (part.type === "tool" ? [part.tool] : [])),
      )
      expect(tools).toEqual(["task", "memory"])
      const [task] = yield* calls(build.id, "task")
      expect(task?.state.status === "completed" ? task.state.metadata[SessionMemory.HOLD] : undefined).toBe("web")
      expect(SessionMemory.taint(messages)).toBe("web")
      const [memory] = yield* calls(build.id, "memory")
      const metadata = memory?.state.status === "completed" ? memory.state.metadata : {}
      expect(metadata.hold).toBe("web")
      expect(guard.outside()).toEqual([])
    }),
  120_000,
)
