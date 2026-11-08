import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { TestConfig } from "../fixture/config"
import { taskDirectory } from "../fixture/task-directory"
import { testEffect } from "../lib/effect"

// A real Node stdio server writes its marker before doing the MCP handshake.
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

const command = (directory: string) => ["node", "-e", server, path.join(directory, "mcp-started")]
const layer = (optIn = false) =>
  LayerNode.compile(MCP.node, [
    [
      Config.node,
      TestConfig.layer({
        get: () =>
          Effect.gen(function* () {
            const directory = yield* InstanceState.directory
            return {
              mcp: { fixture: { type: "local" as const, command: command(directory), timeout: 5_000 } },
              ...(optIn ? { sizing: { subagents: { isolation: { mcp: true } } } } : {}),
            }
          }),
        trust: () =>
          Effect.succeed({ workspace: "", fingerprint: "fixture", trusted: true, ignored: false, settings: true }),
      }),
    ],
    [
      McpAuth.node,
      Layer.mock(McpAuth.Service)({ get: () => Effect.succeed(undefined), updateSecrets: () => Effect.void }),
    ],
  ])

const disabled = testEffect(layer())
const enabled = testEffect(layer(true))

for (const mode of ["worktree", "copy"] as const) {
  disabled.instance(
    `registered ${mode} task directories spawn no MCP child process by default`,
    () =>
      Effect.gen(function* () {
        const task = yield* taskDirectory(mode)
        const mcp = yield* MCP.Service
        yield* Effect.gen(function* () {
          expect(yield* mcp.status()).toEqual({ fixture: { status: "disabled" } })
          expect(yield* mcp.clients()).toEqual({})
          expect(yield* mcp.tools()).toEqual({})
          expect(yield* mcp.cloudTools()).toEqual({})
          expect(yield* mcp.instructions()).toEqual([])
          const connect = yield* mcp.connect("fixture").pipe(Effect.exit)
          expect(Exit.isFailure(connect)).toBe(true)
          yield* mcp.add("added", { type: "local", command: command(task.directory) })
          expect(yield* mcp.clients()).toEqual({})
          expect(
            yield* Effect.promise(() =>
              fs.access(path.join(task.directory, "mcp-started")).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false)
        }).pipe(Effect.provideService(InstanceRef, task.context))
      }),
    { git: true },
  )
}

enabled.instance(
  "an explicit user isolation.mcp opt-in starts the real configured child",
  () =>
    Effect.gen(function* () {
      const task = yield* taskDirectory()
      const mcp = yield* MCP.Service
      yield* Effect.gen(function* () {
        expect(yield* mcp.status()).toEqual({ fixture: { status: "connected" } })
        expect(Object.keys(yield* mcp.clients())).toEqual(["fixture"])
        expect(yield* Effect.promise(() => fs.readFile(path.join(task.directory, "mcp-started"), "utf8"))).toBe(
          "started",
        )
      }).pipe(Effect.provideService(InstanceRef, task.context))
    }),
  { git: true },
)

disabled.instance(
  "a reserved-looking directory without a registry keeps ordinary MCP behavior",
  () =>
    Effect.gen(function* () {
      const task = yield* taskDirectory("worktree", false)
      const mcp = yield* MCP.Service
      yield* Effect.gen(function* () {
        expect(yield* mcp.status()).toEqual({ fixture: { status: "connected" } })
        expect(yield* Effect.promise(() => fs.readFile(path.join(task.directory, "mcp-started"), "utf8"))).toBe(
          "started",
        )
      }).pipe(Effect.provideService(InstanceRef, task.context))
    }),
  { git: true },
)
