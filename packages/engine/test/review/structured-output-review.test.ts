import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { FSUtil } from "@vectordevai/core/fs-util"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { reviewPermissionRules } from "@vectordevai/core/review/permission"
import { PINNED_SESSION_PREFIX, SCOPE, VECTORSCOPE_AGENT } from "@vectordevai/core/review/prompt"
import { REVIEW_REPORT_JSON_SCHEMA } from "@vectordevai/core/review/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Format } from "../../src/format"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { TestInstance, trustWorkspace } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

// The engine contract a review session relies on: the session permission rules re-allow StructuredOutput after the
// review agent's own "*" deny, and nothing else but the four read-only tools reaches the model.

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed([]),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    snapshot: () => Effect.succeed({}),
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    cloudTools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    remove: () => Effect.void,
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in review tests"),
    authenticate: () => Effect.die("unexpected MCP auth in review tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in review tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  Agent.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  Provider.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

const ref = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("test-model") }
const format = new SessionV1.OutputFormatJsonSchema({
  type: "json_schema",
  schema: REVIEW_REPORT_JSON_SCHEMA,
  retryCount: 0,
})
const REPORT = {
  summary: "Changes last() to index past the end.",
  risk: "medium",
  files: [{ path: "src/list.ts", note: "last() rewritten" }],
  findings: [
    {
      path: "src/list.ts",
      line: 3,
      severity: "blocking",
      category: "bug",
      title: "Returns undefined for the last item",
      body: "items[items.length] is one past the end.",
      confidence: 0.9,
    },
  ],
}

const useServer = Effect.gen(function* () {
  const test = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    path.join(test.directory, "vector.json"),
    JSON.stringify({ $schema: "https://vectordev.ai/config.json", ...testProviderConfig(llm.url) }),
  )
  yield* Effect.promise(() => trustWorkspace(test.directory))
  return llm
})

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

function toolNames(body: Record<string, unknown>): string[] {
  const tools: unknown[] = Array.isArray(body.tools) ? body.tools : []
  return tools.flatMap((tool) => {
    const fn = isRecord(tool) && isRecord(tool.function) ? tool.function : undefined
    return typeof fn?.name === "string" ? [fn.name] : []
  })
}

const modelRequests = (llm: TestLLMServer["Service"]) =>
  llm.inputs.pipe(
    Effect.map((bodies) =>
      bodies.filter((body) => !JSON.stringify(body).includes("Generate a title for this conversation")),
    ),
  )

describe("structured output in a review session", () => {
  for (const valid of [true, false])
    it.instance(
      `the VectorScope factory ${valid ? "accepts valid" : "refuses invalid"} checked structured output`,
      () =>
        Effect.gen(function* () {
          const llm = yield* useServer
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const session = yield* sessions.create({
            title: "VectorScope checked output",
            internal: `${PINNED_SESSION_PREFIX}review`,
            permission: reviewPermissionRules({}),
          })
          yield* llm.tool("StructuredOutput", valid ? REPORT : { ...REPORT, findings: "invalid-array" })
          const result = yield* prompt.prompt({
            sessionID: session.id,
            agent: VECTORSCOPE_AGENT,
            model: ref,
            format,
            parts: [
              {
                type: "text",
                text: "Review the admitted diff. PINNED_BASE_INSTRUCTIONS_MARKER",
                metadata: { [SCOPE]: { paths: [], trust: "trusted", instructions: "provided" } },
              },
            ],
          })
          expect(result.info.role).toBe("assistant")
          if (result.info.role !== "assistant") return
          expect(result.info.agent).toBe(VECTORSCOPE_AGENT)
          expect(result.info.structured).toEqual(valid ? REPORT : undefined)
          expect(result.info.error?.name).toBe(valid ? undefined : "StructuredOutputError")
          const requests = yield* modelRequests(llm)
          expect(requests).toHaveLength(1)
          expect(toolNames(requests[0]!)).toEqual(expect.arrayContaining(["StructuredOutput", "read", "glob", "grep"]))
          expect(
            toolNames(requests[0]!).filter(
              (name) => !["StructuredOutput", "read", "glob", "grep", "list"].includes(name),
            ),
          ).toEqual([])
        }),
    )

  it.instance("a StructuredOutput reply sets info.structured under the review rules", () =>
    Effect.gen(function* () {
      const llm = yield* useServer
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const session = yield* sessions.create({
        title: "Vectorscope review",
        permission: reviewPermissionRules({ truncateGlob: Truncate.GLOB }),
      })
      yield* llm.tool("StructuredOutput", REPORT)

      const result = yield* prompt.prompt({
        sessionID: session.id,
        agent: "review",
        model: ref,
        format,
        parts: [{ type: "text", text: "Review this change." }],
      })

      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      expect(result.info.error).toBeUndefined()
      expect(result.info.structured).toEqual(REPORT)
    }),
  )

  it.instance("without the session rules the review agent's request has no StructuredOutput tool", () =>
    Effect.gen(function* () {
      const llm = yield* useServer
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const session = yield* sessions.create({ title: "Vectorscope review" })

      const result = yield* prompt.prompt({
        sessionID: session.id,
        agent: "review",
        model: ref,
        format,
        parts: [{ type: "text", text: "Review this change." }],
      })

      const [body] = yield* modelRequests(llm)
      expect(body).toBeDefined()
      expect(toolNames(body!)).not.toContain("StructuredOutput")
      expect(result.info.role === "assistant" ? result.info.error?.name : undefined).toBe("StructuredOutputError")
    }),
  )

  it.instance("with the session rules the request offers only read, grep, glob, list and StructuredOutput", () =>
    Effect.gen(function* () {
      const llm = yield* useServer
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const session = yield* sessions.create({
        title: "Vectorscope review",
        permission: reviewPermissionRules({ truncateGlob: Truncate.GLOB }),
      })
      yield* llm.tool("StructuredOutput", REPORT)

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "security",
        model: ref,
        format,
        parts: [{ type: "text", text: "Review this change for security." }],
      })

      const [body] = yield* modelRequests(llm)
      const offered = toolNames(body!)
      // The engine has no `list` tool today; the rules allow it for when it exists.
      expect(offered.filter((name) => !["StructuredOutput", "glob", "grep", "list", "read"].includes(name))).toEqual([])
      expect(offered).toEqual(expect.arrayContaining(["StructuredOutput", "glob", "grep", "read"]))
    }),
  )
})
