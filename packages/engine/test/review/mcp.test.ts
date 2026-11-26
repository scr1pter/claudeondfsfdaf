import { describe, expect, test } from "bun:test"
import { reviewPermissionRules } from "@vectordevai/core/review/permission"
import { Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { McpCatalog } from "@/mcp/catalog"
import { Config } from "@/config/config"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { ReviewMcp } from "@/review/mcp"

// In-process descriptors only. No SDK transport, subprocess, model or remote server is started.
const fake = {
  endpoint: "https://fake.invalid/mcp?token=owner-secret",
  instructions: "Untrusted server instructions",
  capability: { kind: "tool", id: "read_invoice", schemaHash: ReviewMcp.digest(['{"type":"object"}']) },
  annotations: { readOnlyHint: true },
} as const
const context = { owner: "owner-one", repository: "project-one", server: "billing" }
const identity = {
  serverIdentity: "fake-server-01",
  endpointHash: ReviewMcp.digest(["https", fake.endpoint]),
  capabilitiesHash: ReviewMcp.digest([fake.capability.id, fake.capability.schemaHash]),
}
const input = { context, identity, capability: fake.capability, trust: "untrusted", use: "snapshot" } as const
const grant: ReviewMcp.Grant = { ...context, ...identity, selected: [{ ...fake.capability, access: "read" }] }
const source = () => [grant]

describe("VectorScope MCP consent", () => {
  test("only one matching owner/repository/server grant admits an explicitly selected read", () => {
    expect(ReviewMcp.decide(input).status).toBe("missing-grant")
    for (const key of ["owner", "repository", "server"] as const)
      expect(ReviewMcp.decide({ ...input, context: { ...context, [key]: "other" } }, source).status).toBe(
        "missing-grant",
      )
    expect(ReviewMcp.decide(input, () => [grant, grant]).status).toBe("ambiguous-grant")
    expect(ReviewMcp.decide(input, source).status).toBe("granted-read")
    expect(ReviewMcp.decide({ ...input, capability: { ...fake.capability, kind: "resource" } }, source).status).toBe(
      "capability-denied",
    )
    expect(ReviewMcp.decide(input, () => [{ ...grant, selected: [...grant.selected, ...grant.selected] }]).status).toBe(
      "capability-denied",
    )
  })
  test("tool names and server readOnlyHint cannot authorize unknown or possibly-writing operations", () => {
    const spoof = { ...fake.capability, id: "get_or_delete", annotations: fake.annotations }
    expect(ReviewMcp.decide({ ...input, capability: spoof }, source).status).toBe("capability-denied")
    for (const access of ["unknown", "possibly-writing"] as const) {
      const unsafe = { ...grant, selected: [{ ...spoof, access }] }
      expect(ReviewMcp.decide({ ...input, capability: spoof }, () => [unsafe]).status).toBe("capability-denied")
    }
  })
  test("changes to the endpoint, server, whole inventory or individual schema invalidate approval", () => {
    for (const key of ["serverIdentity", "endpointHash", "capabilitiesHash"] as const)
      expect(
        ReviewMcp.decide({ ...input, identity: { ...identity, [key]: ReviewMcp.digest(["updated"]) } }, source).status,
      ).toBe("identity-changed")
    const changed = { ...fake.capability, schemaHash: ReviewMcp.digest(["other schema"]) }
    expect(ReviewMcp.decide({ ...input, capability: changed }, source).status).toBe("capability-denied")
    const bad = { ...input, identity: { ...identity, endpointHash: "" } }
    expect(ReviewMcp.decide(bad, () => [{ ...grant, endpointHash: "" }]).status).toBe("identity-changed")
  })
  test("no live route or alternate MCP read, and no raw capability, arguments or credentials in the audit", () => {
    expect(ReviewMcp.LIVE_REVIEW_MCP).toBe(false)
    let reads = 0
    const count = () => {
      reads++
      return [grant]
    }
    for (const trust of ["trusted", "untrusted"] as const) {
      const decision = ReviewMcp.decide({ ...input, use: "live", trust }, count)
      expect(decision.status).toBe(trust === "trusted" ? "live-disabled" : "untrusted-live")
    }
    expect(reads).toBe(0)
    expect(
      Permission.evaluate("read", "mcp:billing:file:///private.env.example", reviewPermissionRules({})).action,
    ).toBe("deny")
    const canary = "secret-query-data"
    const request = { ...input, arguments: { query: canary } }
    const audit = ReviewMcp.decide(request, () => {
      throw new Error(fake.endpoint + canary)
    })
    expect(audit.status).toBe("unavailable")
    expect(Object.keys(audit.audit).sort()).toEqual(["capabilityHash", "contextHash", "identityHash", "status"])
    for (const value of [context.server, canary, "owner-secret", fake.instructions, fake.capability.id])
      expect(JSON.stringify(audit)).not.toContain(value)
  })
})

// The ordinary lifecycle can touch its transport merely by listing. A restricted view must settle before
// that call rather than asking the server and removing the response afterwards.
test("filters the entire model catalog before listing or connecting, preserving the ordinary view", () => {
  let calls = 0
  const empty = () => {
    calls++
    return Effect.succeed({})
  }
  const ordinary: MCP.ModelCatalog = {
    clients: empty,
    tools: empty,
    cloudTools: empty,
    resources: empty,
    resourceTemplates: empty,
    prompts: empty,
    instructions: () => {
      calls++
      return Effect.succeed([{ name: "zero-tools", instructions: "hostile text", tools: [] }])
    },
  }
  for (const internal of ["vectorscope.review", "vectorscope.bound.judge", "vectorscope.fix"]) {
    const view = MCP.modelCatalog(ordinary, ReviewMcp.restrictsModel(internal))
    for (const method of ["clients", "tools", "cloudTools", "resources", "resourceTemplates", "prompts"] as const) {
      const listing: Effect.Effect<unknown> = view[method]()
      expect(Effect.runSync(listing)).toEqual({})
    }
    expect(Effect.runSync(view.instructions())).toEqual([])
  }
  expect(calls).toBe(0)
  const plain = MCP.modelCatalog(ordinary, ReviewMcp.restrictsModel(undefined))
  expect(plain).toBe(ordinary)
  expect(Effect.runSync(plain.instructions())).toEqual([
    { name: "zero-tools", instructions: "hostile text", tools: [] },
  ])
  expect(calls).toBe(1)
})

test("inherits persisted review ancestry and denies missing or cyclic ancestry", () => {
  const tree = new Map<string, { id: string; internal?: string; parentID?: string }>([
    ["root", { id: "root", internal: "vectorscope.review" }],
    ["one", { id: "one", parentID: "root" }],
    ["child", { id: "child", parentID: "one" }],
    ["loop", { id: "loop", parentID: "loop" }],
    ["ordinary", { id: "ordinary" }],
  ])
  const get = (id: string) => {
    const session = tree.get(id)
    return session ? Effect.succeed(session) : Effect.fail("missing")
  }
  for (const session of [tree.get("child")!, tree.get("loop")!, { id: "lost", parentID: "unknown" }])
    expect(Effect.runSync(ReviewMcp.restrictedFamily(session, get))).toBe(true)
  expect(Effect.runSync(ReviewMcp.restrictedFamily({ id: "other", parentID: "ordinary" }, get))).toBe(false)
})

test("a cached SDK tool rechecks live authority at execution and propagates cancellation without retry", async () => {
  let calls = 0
  let settled = 0
  const started = Promise.withResolvers<void>()
  const client = {
    callTool: async (_args: unknown, _schema: unknown, opts: { signal?: AbortSignal }) => {
      calls++
      started.resolve()
      if (!opts.signal) return { content: [{ type: "text", text: "ordinary result" }] }
      await new Promise<void>((_, reject) =>
        opts.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
      )
    },
  }
  const tool = McpCatalog.convertTool(
    { name: "look_up", inputSchema: { type: "object" } },
    client as unknown as Parameters<typeof McpCatalog.convertTool>[1],
    undefined,
    {
      onSettled: async () => {
        settled++
      },
    },
  )
  const call = (signal?: AbortSignal) =>
    Promise.resolve(tool.execute!({ query: "untrusted-data" }, { toolCallId: "c", messages: [], abortSignal: signal }))
  await expect(ReviewMcp.withinCall(true, () => call())).rejects.toThrow(ReviewMcp.unavailable)
  await expect(call(AbortSignal.abort())).rejects.toThrow()
  expect([calls, settled]).toEqual([0, 0])
  const control = new AbortController()
  const pending = call(control.signal)
  await started.promise
  control.abort()
  await expect(pending).rejects.toThrow("cancelled")
  expect([calls, settled]).toEqual([1, 1])
  expect(await call()).toMatchObject({ content: [{ type: "text", text: "ordinary result" }] })
})

const cold = testEffect(
  LayerNode.compile(MCP.node, [[Config.node, TestConfig.layer({ get: () => Effect.die("review initialized MCP") })]]),
)
cold.effect(
  "stock lifecycle blocks direct reads, redirects, commands and reconnects before loading any connector",
  () =>
    Effect.gen(function* () {
      const service = yield* MCP.Service
      expect(yield* service.resources("injected")).toEqual({})
      expect(yield* service.prompts()).toEqual({})
      expect(yield* service.tools()).toEqual({})
      expect(yield* service.readResource("injected", "other://redirect?query=raw")).toBeUndefined()
      expect(yield* service.getPrompt("injected", "ask", { cursor: "raw" })).toBeUndefined()
      expect((yield* Effect.exit(service.connect("injected")))._tag).toBe("Failure")
    }).pipe(Effect.provideService(ReviewMcp.Restricted, true)),
)
