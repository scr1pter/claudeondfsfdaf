import { afterAll, beforeAll, beforeEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer, Stream } from "effect"
import { jsonSchema, tool } from "ai"
import type { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { Database } from "@vectordevai/core/database/database"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import type { ModelCatalog } from "@vectordevai/core/model-catalog"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent as AgentSvc } from "../../src/agent/agent"
import type { Agent } from "../../src/agent/agent"
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
import { MessageID, SessionID } from "../../src/session/schema"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Format } from "../../src/format"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Auth } from "@/auth"
import { testEffect } from "../lib/effect"

// Anthropic refuses forced tool use while extended thinking is on, so a json_schema request on such a step asks for
// the StructuredOutput call with "auto", and a step that answers in text gets one closing step with thinking off and
// the call required (5.E.2). Every other model is asked with "required" from the start.

type Body = Record<string, any>
type Hit = { path: string; body: Body }

const server = {
  current: null as ReturnType<typeof Bun.serve> | null,
  hits: [] as Hit[],
  // What the requests offering StructuredOutput are answered with, in order.
  script: [] as Response[],
}

const sse = (events: unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n") + "\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  })

let calls = 0
const usage = { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: null, cache_read_input_tokens: null }

function anthropic(content: { text: string } | { tool: string; input: unknown }) {
  const start = { type: "message_start", message: { id: "msg-fake", model: "claude-opus-4-6", usage } }
  const block =
    "text" in content
      ? [
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content.text } },
        ]
      : [
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: `toolu_${++calls}`, name: content.tool, input: {} },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(content.input) },
          },
        ]
  return sse([
    start,
    ...block,
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "text" in content ? "end_turn" : "tool_use", stop_sequence: null },
      usage,
    },
    { type: "message_stop" },
  ])
}

const offersStructured = (body: Body) =>
  Array.isArray(body.tools) && body.tools.some((item: Body) => item.name === "StructuredOutput")

beforeAll(() => {
  server.current = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = (await request.json().catch(() => ({}))) as Body
      server.hits.push({ path: url.pathname, body })
      if (!url.pathname.endsWith("/messages"))
        return Response.json({ error: { message: "not served by this fake" } }, { status: 400 })
      // Titles and other helper requests get a plain answer; only the run's own steps follow the script.
      if (!offersStructured(body)) return anthropic({ text: "Title" })
      return server.script.shift() ?? anthropic({ text: "unscripted" })
    },
  })
})

beforeEach(() => {
  server.hits = []
  server.script = []
})

afterAll(() => {
  void server.current?.stop()
})

const origin = () => server.current!.url.origin
const steps = () => server.hits.filter((hit) => hit.path.endsWith("/messages") && offersStructured(hit.body))

const MODELS = JSON.parse(
  await Bun.file(path.join(import.meta.dir, "../tool/fixtures/models-api.json")).text(),
) as Record<string, ModelCatalog.Provider>

function fixture(providerID: string, modelID: string) {
  const model = MODELS[providerID]?.models[modelID]
  if (!model) throw new Error(`Missing model in fixture: ${providerID}/${modelID}`)
  return model
}

function configModel(model: ModelCatalog.Model) {
  return {
    id: model.id,
    name: model.name,
    family: model.family,
    release_date: model.release_date,
    attachment: model.attachment,
    reasoning: model.reasoning,
    temperature: model.temperature,
    tool_call: model.tool_call,
    interleaved: model.interleaved,
    cost: model.cost ? { ...model.cost, tiers: undefined } : undefined,
    limit: model.limit,
    modalities: model.modalities,
    status: model.status,
    provider: model.provider,
  }
}

type ConfigModel = NonNullable<NonNullable<ConfigV1.Info["provider"]>[string]["models"]>[string]

const OPUS = "claude-opus-4-6"

const anthropicConfig = (): Partial<ConfigV1.Info> => ({
  enabled_providers: ["anthropic"],
  provider: {
    anthropic: {
      name: "Anthropic",
      env: ["ANTHROPIC_API_KEY"],
      npm: "@ai-sdk/anthropic",
      api: "https://api.anthropic.com/v1",
      models: { [OPUS]: configModel(fixture("anthropic", OPUS)) as ConfigModel },
      options: { apiKey: "test-anthropic-key", baseURL: `${origin()}/v1` },
    },
  },
})

const openaiConfig = (): Partial<ConfigV1.Info> => ({
  enabled_providers: ["openai"],
  provider: {
    openai: {
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      npm: "@ai-sdk/openai",
      api: "https://api.openai.com/v1",
      models: { "gpt-5.2": configModel(fixture("openai", "gpt-5.2")) as ConfigModel },
      options: { apiKey: "test-openai-key", baseURL: `${origin()}/v1` },
    },
  },
})

const googleConfig = (): Partial<ConfigV1.Info> => ({
  enabled_providers: ["google"],
  provider: { google: { options: { apiKey: "test-google-key", baseURL: `${origin()}/v1beta` } } },
})

const schema = {
  type: "object",
  properties: { answer: { type: "number" } },
  required: ["answer"],
  additionalProperties: false,
}

describe("structured output: the tool choice each provider is sent", () => {
  const it = testEffect(AppNodeBuilder.build(LayerNode.group([LLM.node, Provider.node])))

  // One step of a json_schema request, as the run loop sends it: the call required, and what was sent reported back.
  const send = Effect.fn("test.send")(function* (input: {
    providerID: string
    modelID: string
    variant?: string
    thinking?: false
  }) {
    const model = yield* Provider.use.getModel(ProviderV2.ID.make(input.providerID), ModelV2.ID.make(input.modelID))
    const sessionID = SessionID.make("session-structured-choice")
    const agent = {
      name: "build",
      mode: "primary",
      options: {},
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    } satisfies Agent.Info
    const chose: unknown[] = []
    yield* LLM.Service.use((llm) =>
      llm
        .stream({
          user: {
            id: MessageID.make("msg_structured-choice"),
            sessionID,
            role: "user",
            time: { created: 1 },
            agent: agent.name,
            model: { providerID: model.providerID, modelID: model.id, variant: input.variant },
          },
          sessionID,
          model,
          agent,
          system: ["Answer in the schema."],
          messages: [{ role: "user", content: "What is 2 + 2?" }],
          tools: {
            StructuredOutput: tool({
              description: "Return the answer.",
              inputSchema: jsonSchema(schema as any),
              execute: async () => ({ output: "ok" }),
            }),
          },
          toolChoice: "required",
          chose: (choice) => chose.push(choice),
          ...(input.thinking === false ? { thinking: false as const } : {}),
        })
        .pipe(Stream.runDrain, Effect.exit),
    )
    return { body: server.hits.at(-1)!.body, chose }
  })

  it.instance(
    "anthropic with variant high is sent auto, and required once thinking is off",
    () =>
      Effect.gen(function* () {
        server.script.push(anthropic({ text: "4" }), anthropic({ tool: "StructuredOutput", input: { answer: 4 } }))
        const thinking = yield* send({ providerID: "anthropic", modelID: OPUS, variant: "high" })
        expect(thinking.chose).toEqual(["auto"])
        expect(thinking.body.tool_choice).toEqual({ type: "auto" })
        expect(thinking.body.thinking).toMatchObject({ type: "adaptive" })

        const closing = yield* send({ providerID: "anthropic", modelID: OPUS, variant: "high", thinking: false })
        expect(closing.chose).toEqual(["required"])
        expect(closing.body.tool_choice).toEqual({ type: "any" })
        expect(closing.body.thinking).toBeUndefined()
      }),
    { trusted: true, config: anthropicConfig },
  )

  it.instance(
    "anthropic without a variant is sent required",
    () =>
      Effect.gen(function* () {
        server.script.push(anthropic({ tool: "StructuredOutput", input: { answer: 4 } }))
        const plain = yield* send({ providerID: "anthropic", modelID: OPUS })
        expect(plain.chose).toEqual(["required"])
        expect(plain.body.tool_choice).toEqual({ type: "any" })
        expect(plain.body.thinking).toBeUndefined()
      }),
    { trusted: true, config: anthropicConfig },
  )

  it.instance(
    "openai is sent required",
    () =>
      Effect.gen(function* () {
        const sent = yield* send({ providerID: "openai", modelID: "gpt-5.2", variant: "high" })
        expect(sent.chose).toEqual(["required"])
        expect(sent.body.tool_choice).toBe("required")
      }),
    { trusted: true, config: openaiConfig },
  )

  it.instance(
    "gemini is sent required",
    () =>
      Effect.gen(function* () {
        const sent = yield* send({ providerID: "google", modelID: "gemini-2.5-flash", variant: "high" })
        expect(sent.chose).toEqual(["required"])
        expect(sent.body.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } })
      }),
    { trusted: true, config: googleConfig },
  )
})

describe("structured output in the run loop", () => {
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
  ])
  const it = testEffect(
    LayerNode.compile(root, [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    ]),
  )

  const run = Effect.fn("test.run")(function* (input: { variant?: string; retryCount?: number }) {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Structured",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const result = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("anthropic"), modelID: ModelV2.ID.make(OPUS) },
      ...(input.variant ? { variant: input.variant } : {}),
      size: "standard",
      parts: [{ type: "text", text: "What is 2 + 2?" }],
      format: new SessionV1.OutputFormatJsonSchema({
        type: "json_schema",
        schema,
        retryCount: input.retryCount ?? 2,
      }),
    })
    const messages = yield* MessageV2.filterCompactedEffect(chat.id)
    const parts = messages.flatMap((message) =>
      message.parts.filter(
        (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "StructuredOutput",
      ),
    )
    return { result: result.info, parts }
  })

  it.instance(
    "anthropic with variant high: a text answer gets one closing step with thinking off and the call required",
    () =>
      Effect.gen(function* () {
        server.script.push(
          anthropic({ text: "The answer is 4." }),
          anthropic({ tool: "StructuredOutput", input: { answer: 4 } }),
        )
        const { result } = yield* run({ variant: "high" })

        expect(result.role).toBe("assistant")
        if (result.role !== "assistant") return
        expect(result.error).toBeUndefined()
        expect(result.structured).toEqual({ answer: 4 })
        const sent = steps()
        expect(sent).toHaveLength(2)
        expect(sent[0].body.tool_choice).toEqual({ type: "auto" })
        expect(sent[0].body.thinking).toMatchObject({ type: "adaptive" })
        expect(sent[1].body.tool_choice).toEqual({ type: "any" })
        expect(sent[1].body.thinking).toBeUndefined()
        expect(JSON.stringify(sent[1].body.messages.at(-1))).toContain("Call StructuredOutput now")
      }),
    { trusted: true, config: anthropicConfig },
  )

  it.instance(
    "anthropic without a variant is required from the start, and a text answer gets no closing step",
    () =>
      Effect.gen(function* () {
        server.script.push(anthropic({ text: "The answer is 4." }))
        const { result } = yield* run({})

        expect(result.role).toBe("assistant")
        if (result.role !== "assistant") return
        expect(result.structured).toBeUndefined()
        expect(result.error?.name).toBe("StructuredOutputError")
        const sent = steps()
        expect(sent).toHaveLength(1)
        expect(sent[0].body.tool_choice).toEqual({ type: "any" })
      }),
    { trusted: true, config: anthropicConfig },
  )

  it.instance(
    "invalid calls on separate steps get errors up to retryCount, then the value is kept as invalid",
    () =>
      Effect.gen(function* () {
        for (const _ of [1, 2, 3])
          server.script.push(anthropic({ tool: "StructuredOutput", input: { answer: "four" } }))
        const { result, parts } = yield* run({ retryCount: 2 })

        expect(result.role).toBe("assistant")
        if (result.role !== "assistant") return
        expect(result.error).toBeUndefined()
        expect(result.structured).toEqual({ answer: "four" })
        expect(steps()).toHaveLength(3)
        expect(parts.map((part) => (part.state.status === "completed" ? part.state.metadata : undefined))).toEqual([
          { valid: false },
          { valid: false },
          { valid: false, captured: true },
        ])
        const answered = JSON.stringify(steps()[1].body.messages.at(-1))
        expect(answered).toContain("Invalid structured output: /answer must be number, not string.")
      }),
    { trusted: true, config: anthropicConfig },
  )

  it.instance(
    "retryCount 0 keeps an invalid value at once",
    () =>
      Effect.gen(function* () {
        server.script.push(anthropic({ tool: "StructuredOutput", input: { answer: "four" } }))
        const { result } = yield* run({ retryCount: 0 })

        expect(result.role).toBe("assistant")
        if (result.role !== "assistant") return
        expect(result.structured).toEqual({ answer: "four" })
        expect(steps()).toHaveLength(1)
      }),
    { trusted: true, config: anthropicConfig },
  )
})
