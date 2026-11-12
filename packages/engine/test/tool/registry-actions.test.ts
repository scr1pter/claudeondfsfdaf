// INV-S13: with GITHUB_ACTIONS=true no tool reaches the user's browser, the Vector Cloud bridge or a computer, even with
// their bridge variables set: not the registry's own tools, not a plugin's `computer` (a stand-in for Vector Hands' tool,
// so the guard is proven before Hands merges), not the tools, resources or instructions of an MCP server named for
// computer use or listing a `computer` tool, and not the research tools that drive the desktop's research browser. An MCP
// server that only shares a bridged tool's name (`browser`) is offered whole. The desktop is a fake one on loopback, whose
// calls are recorded.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import path from "path"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { dynamicTool, jsonSchema } from "ai"
import { Effect, Layer } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ResearchSearch } from "@vectordevai/core/research/search"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import { ToolRegistry } from "@/tool/registry"
import { RENDER } from "../../src/tool/research-read"
import { ResearchRun } from "../../src/tool/research-run"
import { disposeAllInstances } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { FakeBridge } from "../lib/fake-bridge"
import { calls, output, plan, runtime, send, setup } from "../lib/research"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// Tool ids that must never be offered on Actions, and look-alikes that must stay.
const WITHHELD = ["browser", "vector_cloud", "research_browser", "computer", "computer-x", "Computer_use"]
const KEPT = ["read", "bash", "research_search", "computers", "computerize", "my_computer"]
// What a plugin registers: the computer-use stand-ins and the look-alikes.
const PLUGIN_TOOLS = ["computer", "computer-x", "Computer_use", "computers", "computerize", "my_computer"]
// The MCP servers' tool keys: a `computer-x` server's (whose client is gone, so only its key names it) and a `computer`
// server's; a `desktop` server's, whose `computer` tool is computer use by its own name; a browser-automation server named
// `browser`, which is not computer use; and a docs server's.
const MCP_TOOLS = [
  "computer-x_click",
  "computer_screenshot",
  "desktop_computer",
  "desktop_type",
  "browser_navigate",
  "docs_search",
]
// Each connected server's resource and instructions.
const RESOURCES = {
  computer: { uri: "screen://current", text: "What is on the user's screen" },
  desktop: { uri: "desktop://screen", text: "What the desktop shows" },
  browser: { uri: "browser://tabs", text: "The browser's open tabs" },
  docs: { uri: "docs://guide", text: "The docs guide" },
}
const INSTRUCTIONS = {
  computer: "Take a screenshot before every click.",
  desktop: "Call computer with a screenshot action first.",
  browser: "Open a tab before you navigate.",
  docs: "Search the docs before answering.",
}
// The computer-use servers' tool keys, which never reach the model on Actions.
const COMPUTER_TOOLS = ["computer-x_click", "computer_screenshot", "desktop_computer", "desktop_type"]
// The servers whose resource the model reads.
const READ = ["computer", "desktop", "browser"] as const
const CLOUD_BRIDGE = { VECTOR_CLOUD_BRIDGE_URL: "http://127.0.0.1:9", VECTOR_CLOUD_BRIDGE_TOKEN: "test-cloud-bridge" }

const guard = NetworkGuard.use()
const web = FakeWeb.start({ sites: FakeWeb.sites() })
const bridge = FakeBridge.start()
const pointed = FakeBridge.use(bridge)
afterAll(async () => {
  pointed.off()
  await bridge.close()
  await web.close()
})

/**
 * Sets these variables until the calling scope closes, then puts back what was there. Every engine file of the lane runs
 * in one Bun process, so a variable left behind would put the next file on GitHub Actions.
 */
const environment = (values: Record<string, string>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const before = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]))
      assign(values)
      return before
    }),
    (before) => Effect.sync(() => assign(before)),
  )

function assign(values: Record<string, string | undefined>) {
  Object.entries(values).forEach(([name, value]) => {
    if (value !== undefined) {
      process.env[name] = value
      return
    }
    delete process.env[name]
  })
}

const model = { providerID: ProviderV2.ID.make("anthropic"), modelID: ModelV2.ID.make("claude-sonnet-4-5") }

const pluginLayer = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    trigger: ((_name: unknown, _input: unknown, output: unknown) =>
      Effect.succeed(output)) as Plugin.Interface["trigger"],
    list: () =>
      Effect.succeed([
        {
          tool: Object.fromEntries(
            PLUGIN_TOOLS.map((id) => [id, { description: `${id} stand-in`, args: {}, execute: async () => "ok" }]),
          ),
        },
      ]),
  }),
)

const registryIt = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node]), [
    [
      Config.node,
      TestConfig.layer({
        directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".vector")])),
        waitForDependencies: () => Effect.die("Local tools must not wait for SDK downloads"),
      }),
    ],
    [RuntimeFlags.node, RuntimeFlags.layer()],
    [Plugin.node, pluginLayer],
  ]),
)

// What the registry offers: its ids, and the tools the build agent and the research lead are given.
const offered = Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  const agents = yield* Agent.Service
  const tools = (agent: Agent.Info) =>
    registry.tools({ ...model, agent }).pipe(Effect.map((list) => list.map((tool) => tool.id)))
  return {
    ids: yield* registry.ids(),
    all: (yield* registry.all()).map((tool) => tool.id),
    build: yield* tools(yield* agents.get("build")),
    lead: yield* tools(yield* agents.get(ResearchRun.LEAD)),
  }
})

const withheld = (ids: readonly string[]) => ids.filter((id) => WITHHELD.includes(id))

describe("the registry on GitHub Actions", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  registryIt.instance("bridged and computer tools never register in Actions", () =>
    Effect.gen(function* () {
      yield* environment({ ...CLOUD_BRIDGE, GITHUB_ACTIONS: "true" })
      const tools = yield* offered
      expect(withheld(tools.ids)).toEqual([])
      expect(tools.ids).toEqual(expect.arrayContaining(KEPT))
      expect(tools.all).toEqual(tools.ids)
      expect(withheld(tools.build)).toEqual([])
      expect(tools.build).toEqual(expect.arrayContaining(["read", "bash", "computers", "computerize", "my_computer"]))
      expect(tools.lead).toContain("research_search")
      expect(tools.lead).not.toContain("research_browser")
    }),
  )

  registryIt.instance("outside Actions the same tools are offered", () =>
    Effect.gen(function* () {
      yield* environment({ ...CLOUD_BRIDGE, GITHUB_ACTIONS: "false" })
      const tools = yield* offered
      expect(tools.ids).toEqual(expect.arrayContaining([...WITHHELD, ...KEPT]))
      expect(tools.build).toEqual(expect.arrayContaining(["browser", "vector_cloud", "computer", "computer-x"]))
      expect(tools.lead).toContain("research_browser")
    }),
  )

  registryIt.instance("a registry built outside Actions withholds them once on Actions, and offers them after", () =>
    Effect.gen(function* () {
      yield* environment({ ...CLOUD_BRIDGE, GITHUB_ACTIONS: "false" })
      expect((yield* offered).ids).toEqual(expect.arrayContaining(WITHHELD))
      // The same instance, whose registry state is already built and cached.
      const actions = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* environment({ GITHUB_ACTIONS: "true" })
          return yield* offered
        }),
      )
      expect(withheld(actions.ids)).toEqual([])
      expect(withheld(actions.all)).toEqual([])
      expect(withheld(actions.build)).toEqual([])
      expect(actions.lead).not.toContain("research_browser")
      const after = yield* offered
      expect(after.ids).toEqual(expect.arrayContaining(WITHHELD))
      expect(after.lead).toContain("research_browser")
    }),
  )
})

describe("MCP servers on GitHub Actions", () => {
  // A server is withheld whole when its own name or a tool's own name is computer use, and a tool when its server is or
  // its key is an id the registry withholds. A bridged tool's name is Vector's own tool, not computer use.
  test("a server is withheld by its name or a tool's name, and its tools with it", () =>
    Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          const connected = [
            "computer",
            "Computer-Use",
            "desktop",
            "browser",
            "vector_cloud",
            "docs",
            "a",
            "a_computer",
          ]
          const keys = [
            "computer_screenshot",
            "desktop_computer",
            "desktop_type",
            "browser_navigate",
            "vector_cloud_deploy",
            "docs_search",
            "docs_computers",
            "a_read",
            "a_computer_click",
          ]
          yield* environment({ GITHUB_ACTIONS: "true" })
          const servers = ToolRegistry.actionsWithheldServers(connected, keys)
          // A key does not say where its server's name ends: `a_computer_click` may be `a`'s `computer_click`, so `a` is
          // withheld, and the key with it. `a_computer` itself, whose name and `click` are not computer use, is not.
          expect(servers).toEqual(["computer", "Computer-Use", "desktop", "a"])
          expect(keys.filter((key) => ToolRegistry.actionsWithheldMcpTool(key, servers))).toEqual([
            "computer_screenshot",
            "desktop_computer",
            "desktop_type",
            "a_read",
            "a_computer_click",
          ])
          // A tool whose key alone is computer use is withheld even when no connected server claims it.
          expect(ToolRegistry.actionsWithheldMcpTool("computer-x_click", [])).toBe(true)
          yield* environment({ GITHUB_ACTIONS: "false" })
          expect(ToolRegistry.actionsWithheldServers(connected, keys)).toEqual([])
          expect(keys.filter((key) => ToolRegistry.actionsWithheldMcpTool(key, servers))).toEqual([])
        }),
      ),
    ))
})

// The servers a resource was read from, in order.
const reads: string[] = []

const mcpLayer = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () =>
      Effect.succeed(
        Object.fromEntries(
          Object.keys(INSTRUCTIONS).map((name) => [
            name,
            { getServerCapabilities: () => ({ tools: {}, resources: {} }) } as unknown as Client,
          ]),
        ),
      ),
    instructions: () =>
      Effect.succeed(
        Object.entries(INSTRUCTIONS).map(([name, instructions]) => ({
          name,
          instructions,
          tools: MCP_TOOLS.filter((tool) => tool.startsWith(`${name}_`)),
        })),
      ),
    // Fresh tools per call: the session overwrites each tool's schema and execute.
    tools: () =>
      Effect.sync(() =>
        Object.fromEntries(
          MCP_TOOLS.map((name) => [
            name,
            dynamicTool({
              description: `${name} from a fake MCP server`,
              inputSchema: jsonSchema({ type: "object", properties: {} }),
              execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
            }),
          ]),
        ),
      ),
    cloudTools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: (server) =>
      Effect.succeed(
        Object.fromEntries(
          Object.entries(RESOURCES)
            .filter(([name]) => !server || name === server)
            .map(([name, resource]) => [resource.uri, { name: resource.uri, uri: resource.uri, client: name }]),
        ),
      ),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    remove: () => Effect.void,
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: (server, uri) =>
      Effect.sync(() => {
        reads.push(server)
        const found = Object.entries(RESOURCES).find(([name, resource]) => name === server && resource.uri === uri)
        return found ? { contents: [{ uri, text: found[1].text }] } : undefined
      }),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const it = runtime(web, { mcp: mcpLayer })

const isTitle = (body: Record<string, unknown>) =>
  JSON.stringify(body).includes("Generate a title for this conversation")

// The tool names a provider request offered the model.
function toolNames(body: Record<string, unknown> | undefined) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  return tools.map((item) =>
    item && typeof item === "object" && "function" in item ? (item.function as { name: string }).name : "",
  )
}

// A provider request's system messages.
function systemText(body: Record<string, unknown> | undefined) {
  const messages = Array.isArray(body?.messages) ? (body.messages as { role: string; content: unknown }[]) : []
  return messages
    .filter((message) => message.role === "system")
    .map((message) => JSON.stringify(message.content))
    .join("\n")
}

// A build run in which the model lists the MCP resources, then reads the `computer`, `desktop` and `browser` servers'
// resources: the tools and the system text its first request offered, what the calls returned, and the servers a
// resource was read from.
const buildRun = Effect.gen(function* () {
  const test = yield* setup()
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ title: "Build" })
  yield* test.llm.tool("list_mcp_resources", {})
  yield* Effect.forEach(READ, (server) => test.llm.tool("read_mcp_resource", { server, uri: RESOURCES[server].uri }))
  yield* test.llm.text("Done.")
  const before = (yield* test.llm.inputs).length
  const read = reads.length
  yield* send({ sessionID: session.id, agent: "build", text: "Fix the flaky auth test in src/auth.", size: "standard" })
  const first = (yield* test.llm.inputs).slice(before).find((body) => !isTitle(body))
  const [listed] = yield* calls(session.id, "list_mcp_resources")
  const resources = yield* calls(session.id, "read_mcp_resource")
  return {
    names: toolNames(first),
    system: systemText(first),
    listed: output(listed),
    read: Object.fromEntries(READ.map((server, index) => [server, output(resources[index])])),
    reads: reads.slice(read),
  }
})

describe("a session on GitHub Actions", () => {
  it.instance(
    "a computer MCP server's tools, resources and instructions and the bridged tools never reach the model in Actions",
    () =>
      Effect.gen(function* () {
        yield* environment({ ...CLOUD_BRIDGE, GITHUB_ACTIONS: "true" })
        const run = yield* buildRun
        expect(run.names).toEqual(
          expect.arrayContaining([
            "docs_search",
            "browser_navigate",
            "read",
            "list_mcp_resources",
            "read_mcp_resource",
          ]),
        )
        expect(run.names.filter((name) => [...WITHHELD, ...COMPUTER_TOOLS].includes(name))).toEqual([])
        // The docs and browser servers are still offered whole, their resources and instructions with their tools. The
        // computer server, named for computer use, and the desktop server, whose `computer` tool is, are withheld whole.
        expect(run.system).toContain(INSTRUCTIONS.docs)
        expect(run.system).toContain(INSTRUCTIONS.browser)
        expect(run.system).not.toContain(INSTRUCTIONS.computer)
        expect(run.system).not.toContain(INSTRUCTIONS.desktop)
        expect(run.listed).toContain(RESOURCES.docs.uri)
        expect(run.listed).toContain(RESOURCES.browser.uri)
        expect(run.listed).not.toContain(RESOURCES.computer.uri)
        expect(run.listed).not.toContain(RESOURCES.desktop.uri)
        expect(run.read.computer).toContain('MCP server "computer" is not connected')
        expect(run.read.desktop).toContain('MCP server "desktop" is not connected')
        expect(run.read.browser).toContain(RESOURCES.browser.text)
        expect(run.reads).toEqual(["browser"])
        expect(guard.outside()).toEqual([])
      }),
    90_000,
  )

  it.instance(
    "outside Actions the same session offers them",
    () =>
      Effect.gen(function* () {
        yield* environment({ ...CLOUD_BRIDGE, GITHUB_ACTIONS: "false" })
        const run = yield* buildRun
        expect(run.names).toEqual(
          expect.arrayContaining([...MCP_TOOLS, "browser", "vector_cloud", "read_mcp_resource"]),
        )
        expect(run.system).toContain(INSTRUCTIONS.computer)
        expect(run.system).toContain(INSTRUCTIONS.desktop)
        expect(run.listed).toContain(RESOURCES.computer.uri)
        expect(run.listed).toContain(RESOURCES.desktop.uri)
        expect(run.read.computer).toContain(RESOURCES.computer.text)
        expect(run.read.desktop).toContain(RESOURCES.desktop.text)
        expect(run.reads).toEqual([...READ])
      }),
    90_000,
  )

  it.instance(
    "research_search and research_read's rendering send nothing to the desktop browser in Actions",
    () =>
      Effect.gen(function* () {
        yield* environment({ GITHUB_ACTIONS: "true" })
        const test = yield* setup()
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Research",
          permission: [{ permission: "research_read", pattern: "*", action: "allow" }],
        })
        const spa = web.url("spa", "/")
        const before = bridge.calls().length
        const asked = (yield* test.llm.inputs).length
        yield* test.llm.tool("research_plan", plan())
        yield* test.llm.tool("research_search", { query: "heat pump sizing in cold climates" })
        yield* test.llm.tool("research_read", { url: spa })
        yield* test.llm.tool("research_read", { url: spa, mode: "render" })
        yield* test.llm.text("Done.")
        yield* send({ sessionID: session.id, agent: "research", text: `Research heat pump sizing at ${spa}` })

        const [searched] = yield* calls(session.id, "research_search")
        expect(output(searched)).toBe(ResearchSearch.NEEDS_DESKTOP)
        const reads = yield* calls(session.id, "research_read")
        // A script-built page is kept as skipped, as without a desktop, rather than rendered in its browser.
        expect(reads[0]?.state.status === "completed" ? reads[0].state.metadata.status : undefined).toBe("needs-render")
        expect(output(reads[1])).toBe(RENDER)
        expect(bridge.calls().length).toBe(before)
        const lead = toolNames((yield* test.llm.inputs).slice(asked).find((body) => !isTitle(body)))
        expect(lead).toContain("research_search")
        expect(lead).not.toContain("research_browser")
        expect(guard.outside()).toEqual([])
      }),
    90_000,
  )

  it.instance(
    "outside Actions research_search asks the desktop's research browser",
    () =>
      Effect.gen(function* () {
        yield* environment({ GITHUB_ACTIONS: "false" })
        const test = yield* setup()
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Research" })
        const before = bridge.calls().length
        yield* test.llm.tool("research_plan", plan())
        yield* test.llm.tool("research_search", { query: "heat pump sizing in cold climates" })
        yield* test.llm.text("Done.")
        yield* send({ sessionID: session.id, agent: "research", text: "Research heat pump sizing." })
        expect(
          bridge
            .calls()
            .slice(before)
            .map((call) => call.body.command),
        ).toContain("research.search")
      }),
    90_000,
  )
})
