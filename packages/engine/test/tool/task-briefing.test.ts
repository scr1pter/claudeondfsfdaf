import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "path"
import { afterAll, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
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
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
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
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { MessageID, type SessionID } from "../../src/session/schema"
import { Token } from "@vectordevai/core/util/token"
import { SessionMemory } from "../../src/session/memory"

// Subagent briefs by id, against the fake LLM server with no paid model call: a subagent a Thorough request launches
// starts with at most 200 tokens of the cards that bear on its task, saved on its first message as ids and rendered
// for its request; one a Standard request launches starts with none, and a request briefs at most four.

// Memory lives in the user's config folder, so this test gets one of its own rather than the shared one.
const config = mkdtempSync(path.join(os.tmpdir(), "vector-task-briefing-"))
afterAll(() => rmSync(config, { recursive: true, force: true }))

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
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
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
  FreeModelGuests.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    [Global.node, Global.layerWith({ config })],
  ]),
)

const ref = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("test-model") }

const providerConfig = (url: string): Partial<ConfigV1.Info> => ({
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
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

const SPEC = `# Client spec

## 2 Limits

Clients MUST retry at most 3 times after a 429 response.
Uploads are limited to 50 MB per file.
`

const setup = Effect.fn("test.setup")(function* () {
  const dir = (yield* TestInstance).directory
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(path.join(dir, "vector.json"), JSON.stringify(providerConfig(llm.url)))
  const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(dir, [path.join(dir, "vector.json")]))
  yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
  const knowledge = yield* BrainKnowledge.Service
  const place = yield* (yield* Instruction.Service).place()
  const added = yield* knowledge.add(place, {
    type: "bytes",
    name: "Client spec.md",
    bytes: new TextEncoder().encode(SPEC),
    origin: "upload",
  })
  if (added.type === "refused") throw new Error(added.message)
  yield* knowledge.wait(place, added.document.id, "searchable", 20_000)
  const [record] = (yield* knowledge.records(place, { query: "retry 429", personal: true })).records
  return { llm, knowledge, place, record: record! }
})

const blocks = (body: string, tag: string) =>
  [...body.replaceAll("\\n", "\n").matchAll(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"))].map((match) => match[0])

const delegate = Effect.fn("test.delegate")(function* (size: "thorough") {
  const llm = yield* TestLLMServer
  const sessions = yield* Session.Service
  const prompt = yield* SessionPrompt.Service
  const chat = yield* sessions.create({ title: "Pinned", permission: [{ permission: "*", pattern: "*", action: "allow" }] })
  yield* llm.tool("task", {
    background: false,
    description: "Map retry handling",
    prompt: "Find where the client retries after a 429 response and report how many times it retries.",
    subagent_type: "general",
  })
  yield* llm.text("The client retries three times.")
  yield* llm.text("Done.")
  const before = (yield* llm.hits).length
  yield* prompt.prompt({
    sessionID: chat.id,
    agent: "build",
    model: ref,
    size,
    parts: [{ type: "text", text: "audit how the uploader handles rate limits across the client" }],
  })
  const hits = (yield* llm.hits).slice(before).map((hit) => JSON.stringify(hit.body))
  const children = (yield* sessions.children(chat.id)) ?? []
  return { hits, chat, children }
})

it.instance(
  "a Thorough request's subagent starts with a brief of cards by id, within 200 tokens",
  () =>
    Effect.gen(function* () {
      const { record } = yield* setup()
      const { hits, children } = yield* delegate("thorough")
      expect(hits).toHaveLength(3)
      // The second request is the subagent's own.
      const child = hits[1]!
      expect(child).toContain("Find where the client retries")
      const brief = blocks(child, "vector_memory_recall")
      expect(brief).toHaveLength(1)
      expect(brief[0]).toContain(`[${record.id}]`)
      expect(brief[0]).toContain("at most 3 times after a 429")
      expect(Token.estimate(brief[0]!)).toBeLessThanOrEqual(BrainKnowledge.BRIEF.tokens)
      // Saved as ids: the subagent's transcript never holds the card's words.
      const sessions = yield* Session.Service
      expect(children).toHaveLength(1)
      const saved = yield* sessions.messages({ sessionID: children[0]!.id })
      const part = saved.flatMap((message) => message.parts).find((item) => SessionMemory.recall(item) !== undefined)
      expect(SessionMemory.recall(part!)?.cards).toContain(record.id)
      expect(JSON.stringify(saved)).not.toContain("at most 3 times after a 429")
    }),
  { git: true },
  90_000,
)

it.instance(
  "a subagent the user names in a Standard request starts with no brief",
  () =>
    Effect.gen(function* () {
      yield* setup()
      const llm = yield* TestLLMServer
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create({ title: "Pinned", permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      yield* llm.text("The client retries three times.")
      yield* llm.text("Done.")
      const before = (yield* llm.hits).length
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        size: "standard",
        parts: [
          { type: "text", text: "audit how the uploader handles rate limits across the client" },
          {
            type: "subtask",
            agent: "general",
            description: "Map retry handling",
            prompt: "Find where the client retries after a 429 response and report how many times it retries.",
          },
        ],
      })
      const hits = (yield* llm.hits).slice(before).map((hit) => JSON.stringify(hit.body))
      const child = hits.find((hit) => hit.includes("Find where the client retries"))
      expect(child).toBeDefined()
      expect(blocks(child!, "vector_memory_recall")).toEqual([])
    }),
  { git: true },
  90_000,
)

it.instance(
  "one request briefs at most four subagents",
  () =>
    Effect.gen(function* () {
      const { knowledge, place, record } = yield* setup()
      const given = yield* Effect.forEach([1, 2, 3, 4, 5], (index) =>
        knowledge.brief(place, {
          query: "how many times may the client retry after a 429 response?",
          personal: true,
          exclude: new Set(),
          sessionID: `ses_child_${index}`,
          requestID: "msg_parent",
        }),
      )
      expect(given.slice(0, 4).every((brief) => brief.cards.includes(record.id))).toBe(true)
      expect(given[4]!.ids).toEqual([])
      // The same subagent asking again is not a fifth.
      const again = yield* knowledge.brief(place, {
        query: "how many times may the client retry after a 429 response?",
        personal: true,
        exclude: new Set(),
        sessionID: "ses_child_1",
        requestID: "msg_parent",
      })
      expect(again.cards).toContain(record.id)
    }),
  { git: true },
  90_000,
)
