import { afterAll, expect } from "bun:test"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { dynamicTool, jsonSchema } from "ai"
import { Effect, Layer } from "effect"
import { MCP } from "../../src/mcp"
import { Session } from "@/session/session"
import { ResearchRun } from "../../src/tool/research-run"
import { calls, output, plan, runtime, send, setup } from "../lib/research"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// MCP and Deep research (sections 5.3 and 5.4). With a server connected that has a tool and resources, build is
// offered them, and what the tool returned is private context its research requests are checked against. No research
// agent is offered an MCP tool or resource, whatever the session's rules allow: what they return is not counted for
// the run's outbound check, and a resource's address is the model's to write.

const PRIVATE = "Globex renews its contract with us on 14 March for 412,000 euros through the zephyrRenewals desk"
const MCP_TOOLS = ["notes_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]

const server = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    snapshot: () => Effect.succeed({}),
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({ notes: { getServerCapabilities: () => ({ resources: {} }) } as unknown as Client }),
    instructions: () => Effect.succeed([]),
    // Fresh tools per call: the session overwrites each tool's execute with its permission wrapper.
    tools: () =>
      Effect.sync(() => ({
        notes_search: dynamicTool({
          description: "Search the team's notes",
          inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string" } } }),
          execute: async () => ({ content: [{ type: "text", text: PRIVATE }] }),
        }),
      })),
    cloudTools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () =>
      Effect.succeed({ "notes://renewals": { name: "renewals", uri: "notes://renewals", client: "notes" } }),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    remove: () => Effect.void,
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed({ contents: [{ uri: "notes://renewals", text: PRIVATE }] }),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const guard = NetworkGuard.use()
const web = FakeWeb.start({ sites: FakeWeb.sites() })
const it = runtime(web, { mcp: server })
afterAll(() => web.close())

const names = (body: string) =>
  ((JSON.parse(body) as { tools?: { function?: { name?: string } }[] }).tools ?? []).map((tool) => tool.function?.name)

it.instance(
  "no research agent is offered an MCP tool or resource, even where the session's rules allow them",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      // A client's tools list sets session rules, which come after the agent's.
      const open = [
        { permission: "notes_search", pattern: "*", action: "allow" as const },
        { permission: "read", pattern: "*", action: "allow" as const },
        { permission: "research_read", pattern: "*", action: "allow" as const },
      ]
      const lead = yield* sessions.create({ title: "Research", permission: open })
      const researcher = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("research_assignment")
      yield* test.llm.tool("research_plan", plan({ depth: "deep" }))
      yield* test.llm.tool("task", {
        description: "CI practice",
        prompt: "How do other teams run payments tests in continuous integration?",
        subagent_type: "researcher",
        background: false,
      })
      yield* test.llm.textMatch(researcher, "Found it.")
      yield* test.llm.text("Done.")
      const bodies = yield* send({ sessionID: lead.id, agent: "research", text: "Research payments testing." })
      const [researched] = bodies.filter((body) => body.includes("research_assignment"))
      expect(researched).toBeDefined()
      for (const body of bodies) for (const tool of MCP_TOOLS) expect(names(body)).not.toContain(tool)

      // Build is offered them, so the server is connected.
      const build = yield* sessions.create({ title: "Build" })
      yield* test.llm.text("Done.")
      const [offered] = yield* send({ sessionID: build.id, agent: "build", text: "What is in our notes?" })
      expect(names(offered!)).toEqual(expect.arrayContaining(MCP_TOOLS))
      expect(guard.outside()).toEqual([])
    }),
  120_000,
)

it.instance(
  "what an MCP tool returned to build stays out of its research requests",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      yield* test.llm.tool("notes_search", { query: "renewals" })
      yield* test.llm.tool("research", { question: `How do others handle this? ${PRIVATE}`, background: false })
      yield* test.llm.tool("research", {
        question: "When Globex renews its contract with us on 14 March, what changes?",
        background: false,
      })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: build.id, agent: "build", text: "Look into our renewals.", size: "standard" })
      const [searched] = yield* calls(build.id, "notes_search")
      expect(output(searched)).toContain("Globex")
      const research = yield* calls(build.id, "research")
      expect(research.map((call) => call.state.status)).toEqual(["error", "error"])
      for (const call of research) expect(output(call)).toContain(ResearchRun.REQUEST_REFUSAL)
      expect(yield* sessions.children(build.id)).toEqual([])
    }),
  90_000,
)
