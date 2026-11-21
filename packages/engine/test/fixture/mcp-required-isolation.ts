import { beforeEach, expect } from "bun:test"
import path from "node:path"
import { Effect, Layer, Result } from "effect"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ProcessIsolation } from "@vectordevai/core/process-isolation"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { McpComputerPolicy } from "@/mcp/computer-policy"
import { TestConfig } from "./config"
import { TestInstance } from "./fixture"
import { testEffect } from "../lib/effect"

// requireIsolation() is process-global and one-way, so these cases run only in their own Bun process, started by
// test/mcp/computer-policy-isolation.test.ts. Without a .test. name, ordinary test discovery never loads this file.
ProcessIsolation.requireIsolation()

// Once isolation is required, the launch floor refuses a native loader variable on every host, ahead of its platform
// check. Off Linux it refuses every other command with ProcessIsolation.REFUSAL.
const LOADER = { LD_PRELOAD: "refused-test-loader" }
const POLICY = { enabled: false }
// A real Node stdio server writes its marker before doing the MCP handshake, so a started server always shows.
const server = `
require("node:fs").writeFileSync(process.argv[1], "started")
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  const result = request.method === "initialize"
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : request.method === "tools/list" ? { tools: [] } : {}
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n")
})
`
const fixture: { config: ConfigV1.Info } = { config: {} }

beforeEach(() => {
  fixture.config = {}
})

// The real MCP layer with its real spawner: no fake transport and no module mocks.
const it = testEffect(
  LayerNode.compile(MCP.node, [
    [
      Config.node,
      TestConfig.layer({
        get: () => Effect.sync(() => fixture.config),
        trust: () =>
          Effect.succeed({ workspace: "", fingerprint: "fixture", trusted: true, ignored: false, settings: true }),
      }),
    ],
    [
      McpAuth.node,
      Layer.mock(McpAuth.Service)({ get: () => Effect.succeed(undefined), updateSecrets: () => Effect.void }),
    ],
  ]),
)

for (const variant of [
  { name: "inherited environment", environment: undefined },
  { name: "loader environment", environment: LOADER },
]) {
  it.instance(
    `S6-7: the computer policy refuses a desktop-control command before the launch floor (${variant.name})`,
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const marker = path.join(instance.directory, "mcp-started")
        // The policy recognizes this script by its name. It would write the marker if anything ever ran it.
        const script = path.join(instance.directory, "computer_control_mcp.py")
        yield* Effect.promise(() => Bun.write(script, 'import sys\nopen(sys.argv[1], "w").write("started")\n'))
        const command = ["python3", script, marker]
        const refusal = McpComputerPolicy.refusal(command, POLICY)
        if (!refusal) throw new Error("The computer policy must refuse the desktop-control script.")
        const floor = launchFloor(command, instance.directory, variant.environment)
        // With the loader environment the floor refuses on every host, so only the earlier policy check can explain
        // the policy's text. Off Linux the floor refuses the inherited environment too.
        if (variant.environment) expect(Result.isFailure(floor)).toBe(true)
        fixture.config = {
          computer: POLICY,
          mcp: {
            custom_desktop: { type: "local", command, environment: variant.environment, timeout: 5_000 },
          },
        }
        const mcp = yield* MCP.Service
        expect((yield* mcp.status()).custom_desktop).toEqual({ status: "failed", error: refusal })
        for (const text of [
          ProcessIsolation.REFUSAL,
          ProcessIsolation.BINARY,
          "--die-with-parent",
          ...(Result.isFailure(floor) ? [floor.failure] : []),
        ])
          expect(refusal).not.toContain(text)
        expect(yield* mcp.clients()).toEqual({})
        expect(yield* started(marker)).toBe(false)
      }),
  )
}

it.instance("an allowed command follows ProcessIsolation's own launch decision under required isolation", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const marker = path.join(instance.directory, "mcp-started")
    const command = ["node", "-e", server, marker]
    const floor = launchFloor(command, instance.directory)
    // The held bubblewrap floor (ProcessIsolation.FLOOR) plans a Linux command plainly, so starting it here would
    // prove nothing about isolation. On such a host only the policy cases above are asserted.
    if (Result.isSuccess(floor)) {
      console.log("MCP_REQUIRED_ISOLATION_LAUNCH=planned")
      return
    }
    fixture.config = { computer: POLICY, mcp: { fixture: { type: "local", command, timeout: 5_000 } } }
    const mcp = yield* MCP.Service
    expect((yield* mcp.status()).fixture).toEqual({ status: "failed", error: floor.failure })
    expect(yield* mcp.clients()).toEqual({})
    expect(yield* started(marker)).toBe(false)
    console.log("MCP_REQUIRED_ISOLATION_LAUNCH=refused")
  }),
)

it.instance("a launch-floor refusal inside localTransport ends as a failed status, not a defect", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const marker = path.join(instance.directory, "mcp-started")
    const command = ["node", "-e", server, marker]
    const floor = launchFloor(command, instance.directory, LOADER)
    if (Result.isSuccess(floor)) throw new Error("The launch floor must refuse a native loader environment.")
    fixture.config = { mcp: { fixture: { type: "local", command, environment: LOADER, timeout: 5_000 } } }
    const mcp = yield* MCP.Service
    // localTransport throws inside Effect.promise, a defect in connectLocal; MCP.create's catchCause turns it into
    // this status. Startup and connect both reach create.
    const refused = { status: "failed" as const, error: floor.failure }
    expect((yield* mcp.status()).fixture).toEqual(refused)
    yield* mcp.connect("fixture")
    expect((yield* mcp.status()).fixture).toEqual(refused)
    expect(yield* mcp.clients()).toEqual({})
    expect(yield* mcp.tools()).toEqual({})
    expect(yield* started(marker)).toBe(false)
  }),
)

// The launch floor's own decision for this argv and environment in this process. Result.try keeps its synchronous
// refusal a value without a try/catch.
function launchFloor(command: string[], cwd: string, environment?: Record<string, string>) {
  return Result.try({
    try: () =>
      ProcessIsolation.launch(command[0], command.slice(1), {
        cwd,
        env: untrustedChildEnvironment(process.env, environment),
      }),
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  })
}

function started(marker: string) {
  return Effect.promise(() => Bun.file(marker).exists())
}
