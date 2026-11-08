import { afterAll } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "path"
import { Effect, Layer } from "effect"
import type { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import type { HttpClient } from "effect/unstable/http"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { BrainSchema } from "@vectordevai/core/brain/schema"
import { Global } from "@vectordevai/core/global"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { FSUtil } from "@vectordevai/core/fs-util"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { ResearchStore } from "@vectordevai/core/research/store"
import type { SessionV1 } from "@vectordevai/core/v1/session"
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
import { Auth } from "@/auth"
import { ResearchRun } from "../../src/tool/research-run"
import { TaskLimits } from "../../src/task/limits"
import type { SessionID } from "../../src/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "./effect"
import { TestLLMServer } from "./llm-server"
import { FakeWeb } from "../../../core/test/lib/fake-web"

// The whole session runtime for Deep research tests, against the fake LLM server and the fake web: no paid model call
// and, with the strict network guard each test file installs, no connection off this computer. The research tools read
// the fake web through its own resolver, with its names counted as public, as the reader's own tests do.

export const ref = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("test-model") }

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
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
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
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
  SpendGuard.node,
  Auth.node,
  BrainKnowledge.node,
  Brain.node,
  FreeModelGuests.node,
  ResearchStore.node,
  ResearchRun.node,
  // The conversation's subagent slots, which tests of a research lead's reservation read.
  TaskLimits.node,
  // Where the user's own files live (their RULES.md, MEMORY.md and global AGENTS.md), for tests that write one.
  Global.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

/**
 * The test runtime for a file. `client` decides whether a root plan card asks (the app does) or the plan is approved
 * on its own (a client that cannot answer). Background subagents are off, so a task's report comes back in its call.
 * The user's personal memory files live in a folder of the file's own, removed when the file's tests end. MCP has no
 * server unless `mcp` gives one.
 */
export function runtime(
  web: FakeWeb.Web,
  options: {
    readonly client?: string
    readonly mcp?: Layer.Layer<MCP.Service>
    /** The HTTP client every request goes through, such as one that sends a search service's to the fake web. */
    readonly http?: Layer.Layer<HttpClient.HttpClient>
  } = {},
) {
  const config = mkdtempSync(path.join(os.tmpdir(), "vector-research-"))
  writeFileSync(path.join(config, "RULES.md"), "- Never force-push to main\n")
  writeFileSync(path.join(config, "MEMORY.md"), "- I work at Hooli on the payments team in Lisbon\n")
  const it = testEffect(
    LayerNode.compile(root, [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, options.mcp ?? mcp],
      [
        RuntimeFlags.node,
        RuntimeFlags.layer({
          experimentalEventSystem: true,
          backgroundSubagents: false,
          client: options.client ?? "sdk",
        }),
      ],
      [Global.node, Global.layerWith({ config })],
      [
        ResearchRun.networkNode,
        Layer.succeed(ResearchRun.NetworkService, { resolver: web.resolver, publicNames: [FakeWeb.DOMAIN] }),
      ],
      ...(options.http ? [[httpClient, options.http] as const] : []),
    ]),
  )
  afterAll(() => {
    rmSync(config, { recursive: true, force: true })
    rmSync(userConfig, { force: true })
  })
  return it
}

/** The repository's config: the fake LLM server as the model. */
export function repositoryConfig(llm: string, extra: Partial<ConfigV1.Info> = {}): Partial<ConfigV1.Info> {
  return {
    provider: {
      lmstudio: {
        name: "Test",
        id: "lmstudio",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: llm },
      },
    },
    ...extra,
  }
}

// The user's own config file, where research's settings live: a repository's config may not set them.
const userConfig = path.join(Global.Path.config, "vector.json")

/**
 * Writes the repository's config and trusts it, as the user would, and `research`, research's settings, to the user's
 * own config. Research searches in the desktop's research browsers: a test that searches points the engine at a fake
 * desktop (FakeBridge.searching).
 */
export const setup = Effect.fn("ResearchTest.setup")(function* (extra: Partial<ConfigV1.Info> = {}) {
  const dir = (yield* TestInstance).directory
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  const config = yield* Config.Service
  const { research, ...repository } = extra
  yield* fs.writeWithDirs(userConfig, JSON.stringify({ research: { ...research } }))
  yield* config.invalidate()
  yield* fs.writeWithDirs(path.join(dir, "vector.json"), JSON.stringify(repositoryConfig(llm.url, repository)))
  const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(dir, [path.join(dir, "vector.json")]))
  yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
  return { dir, llm }
})

/** Sends a user message and runs the session; the request bodies the fake LLM server got for it. */
export const send = Effect.fn("ResearchTest.send")(function* (input: {
  readonly sessionID: SessionID
  readonly agent: string
  readonly text: string
  readonly size?: "light" | "standard" | "thorough"
  /** Where the text holds what the user pasted, as a composer marks it (BrainSchema.PASTED). */
  readonly pasted?: readonly (readonly [number, number])[]
}) {
  const llm = yield* TestLLMServer
  const prompt = yield* SessionPrompt.Service
  const before = (yield* llm.hits).length
  yield* prompt.prompt({
    sessionID: input.sessionID,
    agent: input.agent,
    model: ref,
    ...(input.size ? { size: input.size } : {}),
    parts: [
      {
        type: "text",
        text: input.text,
        ...(input.pasted ? { metadata: { [BrainSchema.PASTED]: input.pasted.map((span) => [...span]) } } : {}),
      },
    ],
  })
  return (yield* llm.hits).slice(before).map((hit) => JSON.stringify(hit.body))
})

/** Every completed tool call of a session, in order. */
export const calls = Effect.fn("ResearchTest.calls")(function* (sessionID: SessionID, tool?: string) {
  const sessions = yield* Session.Service
  return (yield* sessions.messages({ sessionID }))
    .flatMap((message) => message.parts)
    .flatMap((part) =>
      part.type === "tool" && (tool === undefined || part.tool === tool) && part.state.status !== "pending"
        ? [part as SessionV1.ToolPart]
        : [],
    )
})

/** A completed call's output, or the error it ended with. */
export function output(part: SessionV1.ToolPart | undefined) {
  if (!part) return ""
  if (part.state.status === "completed") return part.state.output
  if (part.state.status === "error") return part.state.error
  return ""
}

/** A plan for the fake web's heat pump pages. */
export const plan = (
  input: Partial<{ question: string; depth: "focused" | "deep"; scope: "web" | "web+brain" | "brain" }> = {},
) => ({
  question: input.question ?? "How much do heat pumps cut heating bills in cold climates?",
  subquestions: ["What did field studies measure?", "How large were the savings?"],
  scope: input.scope ?? "web",
  depth: input.depth ?? "focused",
})
