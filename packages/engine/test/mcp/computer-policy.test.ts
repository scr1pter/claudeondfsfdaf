import { afterAll, beforeEach, expect, mock, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ConfigComputerV1 } from "@vectordevai/core/v1/config/computer"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { Hands } from "@vectordevai/schema/hands"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { Config } from "@/config/config"
import { McpAuth } from "@/mcp/auth"
import { McpCatalog } from "@/mcp/catalog"
import { McpComputerPolicy } from "@/mcp/computer-policy"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const transportCalls: string[][] = []
const started: string[][] = []
const fixture: { config: ConfigV1.Info; credentials: Map<string, Record<string, string>>; tools: string[] } = {
  config: {},
  credentials: new Map(),
  // Tool names every fake server lists; none unless a test sets them.
  tools: [],
}

// The launcher runs normally up to its SDK boundary. No child process or desktop permission is touched.
class FakeStdioTransport {
  readonly stderr = null
  readonly pid = null
  readonly command: string[]

  constructor(input: { command: string; args?: string[] }) {
    this.command = [input.command, ...(input.args ?? [])]
    transportCalls.push(this.command)
  }

  async start() {
    started.push(this.command)
  }

  async close() {}
}

class FakeClient {
  transport?: FakeStdioTransport

  setRequestHandler() {}
  setNotificationHandler() {}
  getServerCapabilities() {
    return fixture.tools.length ? { tools: {} } : {}
  }
  getInstructions() {}

  async listTools() {
    return { tools: fixture.tools.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) }
  }

  async connect(transport: FakeStdioTransport) {
    this.transport = transport
    await transport.start()
  }

  async close() {
    await this.transport?.close()
  }
}

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js")
void mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: FakeClient }))
void mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: FakeStdioTransport }))
afterAll(() => {
  void mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({ Client }))
  void mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport }))
})

const { MCP } = await import("@/mcp")
const it = testEffect(
  LayerNode.compile(MCP.node, [
    [
      Config.node,
      TestConfig.layer({
        // Config's computer field contains only resolved company policy; E4 tests its source authority.
        get: () => Effect.sync(() => fixture.config),
        trust: () => Effect.succeed({ workspace: "", fingerprint: "", trusted: true, ignored: false, settings: false }),
      }),
    ],
    [
      McpAuth.node,
      Layer.mock(McpAuth.Service, {
        get: (name) => Effect.sync(() => ({ secrets: fixture.credentials.get(name) })),
        updateSecrets: (name, secrets) => Effect.sync(() => void fixture.credentials.set(name, secrets)),
      }),
    ],
    [
      CrossSpawnSpawner.node,
      Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
        spawn: () => Effect.die(new Error("Computer MCP policy tests must not spawn processes")),
      }),
    ],
  ]),
)

beforeEach(() => {
  fixture.config = {}
  fixture.credentials.clear()
  fixture.tools = []
  transportCalls.length = 0
  started.length = 0
})

const commands = [
  { name: "direct command", command: ["computer-control-mcp"] },
  { name: "catalog uvx command", command: ["uvx", "--python", "3.12", "computer-control-mcp@0.3.14"] },
]
const restricted: { name: string; policy: ConfigComputerV1.Info }[] = [
  { name: "disabled", policy: { enabled: false } },
  { name: "default app denial", policy: { default_app_access: "deny" } },
  { name: "macOS allow rule", policy: { apps: { macos: { "com.apple.TextEdit": "allow" } } } },
  {
    name: "Windows deny rule",
    policy: { apps: { windows: [{ aumid: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", access: "deny" }] } },
  },
]

test("known desktop-control executable paths and launch wrappers honor a restricting policy", () => {
  for (const command of [
    ["/opt/tools/computer-control-mcp"],
    [String.raw`C:\Tools\COMPUTER-CONTROL-MCP.EXE`],
    ["env", "UV_PYTHON=3.12", "uvx", "--python", "3.12", "computer-control-mcp@0.3.14"],
    ["uv", "tool", "run", "--from", "computer-control-mcp==0.3.14", "desktop-entrypoint"],
    ["npx", "--yes", "computer-control-mcp@0.3.14"],
    ["npm", "exec", "--package=computer-control-mcp@0.3.14", "--", "desktop-entrypoint"],
    ["bunx", "computer-control-mcp"],
    ["python3", "-m", "computer_control_mcp"],
    ["python", "-u", "/opt/tools/computer_control_mcp.py"],
  ]) {
    expect(McpComputerPolicy.refusal(command, { enabled: false }), command.join(" ")).toContain(
      `${Hands.NAME} is the supported path`,
    )
  }
})

test("an unrelated executable's ordinary arguments do not trigger the desktop-control guard", () => {
  for (const command of [
    ["echo", "computer-control-mcp"],
    ["node", "other-server.js", "computer-control-mcp"],
    ["npx", "other-server", "--label", "computer-control-mcp"],
    ["python", "other.py", "-m", "computer_control_mcp"],
    ["computer-control-mcp-helper"],
  ]) {
    expect(McpComputerPolicy.refusal(command, { enabled: false }), command.join(" ")).toBeUndefined()
  }
})

for (const restriction of restricted) {
  for (const command of commands) {
    it.instance(
      `a computer-control MCP is refused under a restricting policy: ${restriction.name}, ${command.name}`,
      () =>
        Effect.gen(function* () {
          fixture.config = {
            computer: restriction.policy,
            mcp: { custom_desktop: { type: "local", command: command.command } },
          }
          const mcp = yield* MCP.Service
          const status = (yield* mcp.status()).custom_desktop
          expect(status.status).toBe("failed")
          if (status.status !== "failed") throw new Error("Expected a policy refusal")
          expect(status.error).toContain(`${Hands.NAME} is the supported path`)
          expect(yield* mcp.clients()).toEqual({})
          expect(transportCalls).toEqual([])
          expect(started).toEqual([])
        }),
    )
  }

  it.instance(`unrelated local MCP commands still start under ${restriction.name}`, () =>
    Effect.gen(function* () {
      const command = ["node", "filesystem-server.js", "computer-control-mcp"]
      fixture.config = {
        computer: restriction.policy,
        // A catalog-like name or an ordinary argument does not make another server a desktop controller.
        mcp: { "computer-use": { type: "local", command } },
      }
      const mcp = yield* MCP.Service
      expect((yield* mcp.status())["computer-use"]).toEqual({ status: "connected" })
      expect(transportCalls).toEqual([command])
      expect(started).toEqual([command])
    }),
  )
}

for (const allowed of [
  { name: "absent policy", policy: undefined },
  { name: "empty policy", policy: {} },
  { name: "empty macOS and Windows app rules", policy: { enabled: true, apps: { macos: {}, windows: [] } } },
]) {
  for (const command of commands) {
    it.instance(`a computer-control MCP starts with ${allowed.name}: ${command.name}`, () =>
      Effect.gen(function* () {
        fixture.config = {
          computer: allowed.policy,
          mcp: { custom_desktop: { type: "local", command: command.command } },
        }
        const mcp = yield* MCP.Service
        expect((yield* mcp.status()).custom_desktop).toEqual({ status: "connected" })
        expect(Object.keys(yield* mcp.clients())).toEqual(["custom_desktop"])
        expect(transportCalls).toEqual([command.command])
        expect(started).toEqual([command.command])
      }),
    )
  }
}

it.instance("adding a server checks its resolved command before constructing a transport", () =>
  Effect.gen(function* () {
    fixture.config = { computer: { enabled: false } }
    const mcp = yield* MCP.Service
    yield* mcp.add(
      "custom_desktop",
      { type: "local", command: ["uvx", "--python", "3.12", "{vault:server}"] },
      { server: "computer-control-mcp@0.3.14" },
    )
    const status = (yield* mcp.status()).custom_desktop
    expect(status.status).toBe("failed")
    if (status.status !== "failed") throw new Error("Expected a policy refusal")
    expect(status.error).toContain(`${Hands.NAME} is the supported path`)
    expect(transportCalls).toEqual([])
    expect(started).toEqual([])
  }),
)

it.instance("reconnecting reads the current company policy before starting a replacement process", () =>
  Effect.gen(function* () {
    const command = commands[1].command
    fixture.config = { mcp: { custom_desktop: { type: "local", command } } }
    const mcp = yield* MCP.Service
    expect((yield* mcp.status()).custom_desktop).toEqual({ status: "connected" })
    expect(started).toEqual([command])
    yield* mcp.disconnect("custom_desktop")
    fixture.config = { ...fixture.config, computer: { enabled: false } }
    yield* mcp.connect("custom_desktop")
    expect((yield* mcp.status()).custom_desktop.status).toBe("failed")
    expect(yield* mcp.clients()).toEqual({})
    expect(transportCalls).toEqual([command])
    expect(started).toEqual([command])
    fixture.config = { ...fixture.config, computer: { apps: { macos: {}, windows: [] } } }
    yield* mcp.connect("custom_desktop")
    expect((yield* mcp.status()).custom_desktop).toEqual({ status: "connected" })
    expect(started).toEqual([command, command])
  }),
)

test("only a server name that sanitizes to Hands' tool id is reserved, in any letter case", () => {
  // The real tool namer gives a server named `computer` exactly Hands' two ask ids.
  expect(McpCatalog.toolName("computer", "app")).toBe(PermissionPolicy.COMPUTER_APP)
  expect(McpCatalog.toolName("computer", "sensitive")).toBe(PermissionPolicy.COMPUTER_SENSITIVE)
  for (const name of ["computer", "Computer", "COMPUTER", "cOmPuTeR"]) {
    expect(McpComputerPolicy.reservedName(name)).toBe(
      `MCP server "${name}" cannot be used: the name "${Hands.ID}", in any letter case, is reserved for ${Hands.NAME}. Rename the server to use it.`,
    )
  }
  // A separator, an extra character or a look-alike letter changes the sanitized name, so these keep working and their
  // tools can never take a Hands id, even compared without case.
  for (const name of [
    "computer-use",
    "computer_use",
    "computer use",
    "computer_",
    "_computer",
    "computers",
    "my computer",
    "comp",
    "c\u043emputer",
    "computer\u200b",
  ]) {
    expect(McpComputerPolicy.reservedName(name), name).toBeUndefined()
    for (const tool of ["app", "sensitive", "App"]) {
      const id = McpCatalog.toolName(name, tool).toLowerCase()
      expect(PermissionPolicy.handsAsk(id), `${name} ${tool}`).toBe(false)
    }
  }
})

it.instance(
  "a configured server named computer in any case never starts, and its neighbours' tools keep their ids",
  () =>
    Effect.gen(function* () {
      fixture.tools = ["app", "sensitive"]
      fixture.config = {
        mcp: {
          computer: { type: "local", command: ["node", "lower.js"] },
          Computer: { type: "local", command: ["node", "title.js"] },
          "computer-use": { type: "local", command: ["node", "community.js"] },
        },
      }
      const mcp = yield* MCP.Service
      const status = yield* mcp.status()
      expect(status.computer).toEqual(refused("computer"))
      expect(status.Computer).toEqual(refused("Computer"))
      expect(status["computer-use"]).toEqual({ status: "connected" })
      expect(transportCalls).toEqual([["node", "community.js"]])
      expect(started).toEqual([["node", "community.js"]])
      expect(Object.keys(yield* mcp.clients())).toEqual(["computer-use"])
      const tools = Object.keys(yield* mcp.tools()).sort()
      expect(tools).toEqual(["computer-use_app", "computer-use_sensitive"])
    }),
)

it.instance("adding or reconnecting a server named computer constructs nothing", () =>
  Effect.gen(function* () {
    fixture.tools = ["app", "sensitive"]
    const mcp = yield* MCP.Service
    yield* mcp.add("computer", { type: "local", command: ["node", "server.js"] }, { TOKEN: "secret" })
    expect((yield* mcp.status()).computer).toEqual(refused("computer"))
    yield* mcp.connect("computer")
    expect((yield* mcp.status()).computer).toEqual(refused("computer"))
    expect(yield* mcp.clients()).toEqual({})
    expect(yield* mcp.tools()).toEqual({})
    expect(transportCalls).toEqual([])
    expect(started).toEqual([])
  }),
)

function refused(name: string) {
  const error = McpComputerPolicy.reservedName(name)
  if (!error) throw new Error(`Expected "${name}" to be reserved`)
  return { status: "failed" as const, error }
}
