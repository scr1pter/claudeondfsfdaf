import { beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { TestConfig } from "../fixture/config"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const probes = { auth: 0 }
beforeEach(() => {
  probes.auth = 0
})

// A real stdio child increments a durable counter before answering the MCP handshake.
const server = String.raw`
require("node:fs").appendFileSync(process.argv[1], "start\n")
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  const result = request.method === "initialize"
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "snapshot-fixture", version: "1" } }
    : request.method === "tools/list" ? { tools: [] } : {}
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n")
})
`

const graph = (remote = false) =>
  LayerNode.compile(MCP.node, [
    [
      Config.node,
      TestConfig.layer({
        get: () =>
          Effect.gen(function* () {
            const directory = yield* InstanceState.directory
            return {
              mcp: {
                fixture: {
                  type: "local" as const,
                  command: ["node", "-e", server, path.join(directory, "mcp-starts")],
                  timeout: 5_000,
                },
                disabled: {
                  type: "local" as const,
                  command: ["node", "-e", server, path.join(directory, "mcp-starts")],
                  enabled: false,
                },
                ...(remote
                  ? {
                      remote: {
                        type: "remote" as const,
                        url: "http://127.0.0.1:1/mcp",
                        headers: { Authorization: "Bearer {vault:fixture}" },
                        timeout: 100,
                      },
                    }
                  : {}),
              },
            }
          }),
        trust: () =>
          Effect.succeed({ workspace: "", fingerprint: "fixture", trusted: true, ignored: false, settings: true }),
      }),
    ],
    [
      McpAuth.node,
      Layer.mock(McpAuth.Service)({
        get: () =>
          Effect.sync(() => {
            probes.auth += 1
            return undefined
          }),
      }),
    ],
  ])

const cold = testEffect(graph(true))
const live = testEffect(graph())
const count = (directory: string) =>
  Effect.promise(async () => {
    const text = await fs.readFile(path.join(directory, "mcp-starts"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    })
    return text.split("\n").filter(Boolean).length
  })

cold.instance("cold inventory snapshots spawn zero real MCP children and read no credentials", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const instance = yield* TestInstance
    const snapshot = mcp.snapshot
    if (!snapshot) throw new Error("The production MCP service is missing its nonstarting inventory capability")
    for (let read = 0; read < 3; read += 1)
      expect(yield* snapshot()).toEqual({
        fixture: { status: "uninitialized" },
        disabled: { status: "disabled" },
        remote: { status: "uninitialized" },
      })
    expect(yield* count(instance.directory)).toBe(0)
    expect(probes.auth).toBe(0)
  }),
)

const WARM = "snapshots report an existing live cached connection without another child or auth probe"
const ISOLATED_WARM = process.env.VECTOR_TEST_MCP_SNAPSHOT_CHILD === "1"
const warm = () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const instance = yield* TestInstance
    const snapshot = mcp.snapshot
    if (!snapshot) throw new Error("The production MCP service is missing its nonstarting inventory capability")
    expect(yield* mcp.status()).toEqual({ fixture: { status: "connected" }, disabled: { status: "disabled" } })
    expect(yield* count(instance.directory)).toBe(1)
    const auth = probes.auth
    for (let read = 0; read < 3; read += 1)
      expect(yield* snapshot()).toEqual({ fixture: { status: "connected" }, disabled: { status: "disabled" } })
    expect(yield* count(instance.directory)).toBe(1)
    expect(probes.auth).toBe(auth)
    yield* mcp.disconnect("fixture")
    expect(yield* snapshot()).toEqual({ fixture: { status: "disabled" }, disabled: { status: "disabled" } })
    expect(yield* count(instance.directory)).toBe(1)
    expect(probes.auth).toBe(auth)
    process.stdout.write("MCP_SNAPSHOT_WARM_PROVED\n")
  })

if (ISOLATED_WARM) live.instance(WARM, warm)
else
  test(WARM, async () => {
    // Other MCP tests intentionally replace the SDK Client module. A real stdio lifecycle must load the real SDK
    // in a fresh process, with the ordinary test preload's per-process storage and strict network guard.
    const child = Bun.spawn([process.execPath, "test", "--timeout", "30000", import.meta.path, "-t", WARM], {
      cwd: path.join(import.meta.dir, "../.."),
      env: { ...process.env, VECTOR_TEST_MCP_SNAPSHOT_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 25_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        Bun.readableStreamToText(child.stdout),
        Bun.readableStreamToText(child.stderr),
      ])
      expect(code, `${stderr}\n${stdout}`).toBe(0)
      expect(stdout).toContain("MCP_SNAPSHOT_WARM_PROVED")
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill()
    }
  })
